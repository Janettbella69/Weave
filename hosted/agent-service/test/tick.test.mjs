// The server's own clock (docs/superpowers/specs/2026-11-03-proactive-wake-design.md 4.7): the Agent service POSTs
// the website's /api/internal/tick on a timer. No model and no key: the website is a fake fetcher or a local stub.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {execFile, spawn} from 'node:child_process';
import {mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createAgentService, createTicker} from '../server.mjs';

const TOKEN = 'k'.repeat(40);
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'weave-tick-')));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error('timed out');
    await sleep(10);
  }
}
const tickAnswer = (proactive = {started: 0}) => Response.json({delivered: 0, routines: 0, queued: 0, proactive});
const start = extra => createAgentService({token: TOKEN, dataDir: dataDir(), isolation: 'local', sandbox: false, weaveUrl: 'http://weave.test:4317', ...extra});

test('tickEveryMs > 0：每隔一段时间 POST 网站的 /api/internal/tick，带 Agent 服务自己的令牌，请求体是 {}；close() 之后不再敲', async () => {
  const calls = [];
  const service = await start({weaveUrl: 'http://weave.test:4317/', tickEveryMs: 20, fetcher: async (url, options) => { calls.push({url, options}); return tickAnswer(); }});
  await until(() => calls.length >= 3);
  await service.close();
  const count = calls.length;
  for (const {url, options} of calls) {
    assert.equal(url, 'http://weave.test:4317/api/internal/tick');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN});
    assert.equal(options.body, '{}');
    assert.ok(options.signal instanceof AbortSignal);
  }
  await sleep(100);
  assert.equal(calls.length, count);
});

test('上一次没回来就跳过这一拍；close() 断掉还在等的那一次', async () => {
  const signals = [];
  const service = await start({tickEveryMs: 10, fetcher: (url, options) => { signals.push(options.signal); return new Promise(() => {}); }});
  await until(() => signals.length === 1);
  await sleep(150);
  assert.equal(signals.length, 1, '一次没回来，后面十几拍都跳过');
  assert.equal(signals[0].aborted, false);
  await service.close();
  assert.equal(signals[0].aborted, true);
  await sleep(50);
  assert.equal(signals.length, 1);
});

test('tickEveryMs 是 0（默认）或者没有 weaveUrl：不敲', async () => {
  const calls = [];
  const fetcher = async (...args) => { calls.push(args); return tickAnswer(); };
  const services = await Promise.all([start({fetcher}), start({fetcher, tickEveryMs: 0}), start({fetcher, tickEveryMs: 10, weaveUrl: undefined})]);
  await sleep(120);
  await Promise.all(services.map(service => service.close()));
  assert.equal(calls.length, 0);
});

test('tickEveryMs 不是 0 到 2^31-1 之间的整数就不启动（setInterval 超过上限会变成 1 毫秒一次）', async () => {
  for (const tickEveryMs of [-1, 1.5, NaN, '60', 2 ** 31]) await assert.rejects(start({tickEveryMs}), /AGENT_TICK_SECONDS/, String(tickEveryMs));
});

test('createTicker：一次没回来，再敲也不发；回来了下一拍照常；stop() 断掉还在等的那一次，之后不再发', async () => {
  const pending = [];
  const ticker = createTicker({weaveUrl: 'http://weave.test', token: TOKEN, fetcher: (url, options) => new Promise(resolve => pending.push({resolve, signal: options.signal}))});
  const first = ticker.beat();
  await ticker.beat();
  await ticker.beat();
  assert.equal(pending.length, 1);
  pending[0].resolve(tickAnswer());
  await first;
  const second = ticker.beat();
  assert.equal(pending.length, 2);
  ticker.stop();
  assert.equal(pending[1].signal.aborted, true);
  assert.equal(pending[0].signal.aborted, false, '已经回来的那次不受影响');
  pending[1].resolve(tickAnswer());
  await second;
  await ticker.beat();
  assert.equal(pending.length, 2);
});

test('createTicker：失败只记第一次，之后 10 分钟最多一行，只写状态码或错误名，不写正文和令牌；叫醒了几轮记一行', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const logs = t.mock.method(console, 'log', () => {});
  let clock = 0, reply;
  const ticker = createTicker({weaveUrl: 'http://weave.test', token: TOKEN, now: () => clock, fetcher: async () => reply()});
  const beatAt = async minutes => { clock = minutes * 60_000; await ticker.beat(); };
  reply = () => new Response(`{"error":"secret ${TOKEN}"}`, {status: 502});
  await beatAt(0);
  await beatAt(1);
  reply = () => { throw Object.assign(Error('connect ECONNREFUSED ' + TOKEN), {name: 'TypeError'}); };
  await beatAt(5);
  await beatAt(9.99);
  assert.equal(errors.mock.callCount(), 1, '10 分钟内只记一次');
  await beatAt(10);
  reply = () => new Response('not json', {status: 200});
  await beatAt(15);
  await beatAt(20);
  const lines = errors.mock.calls.map(call => call.arguments.join(' '));
  assert.deepEqual(lines, ['Agent service: tick failed: HTTP 502', 'Agent service: tick failed: TypeError', 'Agent service: tick failed: SyntaxError']);
  assert.ok(lines.every(line => !line.includes(TOKEN) && !line.includes('secret') && !line.includes('ECONNREFUSED')), lines.join(' | '));
  reply = () => tickAnswer({started: 0});
  await beatAt(21);
  assert.equal(logs.mock.callCount(), 0, '没开始后台叫醒就不记');
  reply = () => tickAnswer({started: 2});
  await beatAt(22);
  assert.deepEqual(logs.mock.calls.map(call => call.arguments.join(' ')), ['Agent service: tick started 2 background wake(s)']);
});

test('close() 之后进程自己退出：还在等的那一次（真的 fetch）被断掉，闹钟也不拖住进程', async t => {
  const seen = [];
  const hang = http.createServer(req => { seen.push([req.method, req.url]); });
  await new Promise(resolve => hang.listen(0, '127.0.0.1', resolve));
  t.after(() => { hang.closeAllConnections(); return new Promise(resolve => hang.close(resolve)); });
  const script = `
    import {createAgentService} from ${JSON.stringify(pathToFileURL(SERVER).href)};
    const service = await createAgentService({token: ${JSON.stringify(TOKEN)}, dataDir: ${JSON.stringify(dataDir())}, isolation: 'local', sandbox: false, weaveUrl: 'http://127.0.0.1:${hang.address().port}', tickEveryMs: 20});
    await new Promise(resolve => setTimeout(resolve, 300));
    await service.close();
    console.log('closed');
  `;
  const out = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], {timeout: 10000, killSignal: 'SIGKILL'},
    (error, stdout) => (error ? reject(error) : resolve(stdout))));
  assert.equal(out.trim(), 'closed');
  assert.deepEqual(seen, [['POST', '/api/internal/tick']], '没回来之前只敲了一次');
});

const freePort = () => new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(() => resolve(port)); });
});

// 用 node server.mjs 起一个真的服务（本机隔离），看入口怎么读 AGENT_TICK_SECONDS。
async function runMain(t, env) {
  const ticks = [];
  const web = http.createServer((req, res) => {
    ticks.push({method: req.method, url: req.url, auth: req.headers.authorization});
    req.resume();
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end('{"delivered":0,"routines":0,"queued":0,"proactive":{"started":0}}');
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, AGENT_SERVICE_TOKEN: TOKEN, AGENT_DATA_DIR: dataDir(), AGENT_ISOLATION: 'local',
      WEAVE_API_URL: `http://127.0.0.1:${web.address().port}`, HOST: '127.0.0.1', PORT: String(await freePort()), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    web.closeAllConnections();
    await new Promise(resolve => web.close(resolve));
  });
  await until(() => output.includes('started on') || child.exitCode !== null, 15000);
  return {ticks, output: () => output};
}

test('入口：AGENT_TICK_SECONDS=1 每秒敲一次，用的是 AGENT_SERVICE_TOKEN；不设是每 60 秒；0 是关掉', {timeout: 60000}, async t => {
  const every = await runMain(t, {AGENT_TICK_SECONDS: '1'});
  assert.match(every.output(), /tick: every 1s/, every.output());
  await until(() => every.ticks.length >= 1, 5000);
  assert.deepEqual(every.ticks[0], {method: 'POST', url: '/api/internal/tick', auth: 'Bearer ' + TOKEN});
  const fallback = await runMain(t, {});
  assert.match(fallback.output(), /tick: every 60s/, fallback.output());
  const off = await runMain(t, {AGENT_TICK_SECONDS: '0'});
  assert.match(off.output(), /tick: off/, off.output());
  await sleep(1500);
  assert.equal(off.ticks.length, 0);
  assert.equal(fallback.ticks.length, 0, '60 秒还没到');
});
