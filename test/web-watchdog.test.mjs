// hosted/scripts/web-watchdog.sh 跑在网站容器里：workerd 被内存杀掉、wrangler 却不退出时（2026-11-03 线上因此一直 502 约一个半小时），
// 它让 wrangler 退出，由 Docker 重启容器。这里真的跑它：本机起一个 HTTP 服务当网站，用 sleep 60 当 wrangler，
// 把间隔调到零点几秒，看它什么时候动手、什么时候不动手。macOS 自带的 bash 3.2 和 CI 上的 bash 5 跑的都是这一份。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const script = join(root, 'hosted/scripts/web-watchdog.sh');
const armLine = '[weave watchdog] 网站开始回答了（HTTP 401），看门狗开始盯着';
const restartLine = /\[weave watchdog\] 网站连续 3 次没有正常回答（最后一次：(.+?)），看门狗正在重启网站容器。\n/;
const options = {timeout: 30000};

async function until(what, check, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`${ms} 毫秒内没有等到：${what}`);
    await delay(20);
  }
}
const within = (promise, ms, what) => Promise.race([promise, delay(ms, null, {ref: false}).then(() => assert.fail(`${ms} 毫秒内没有等到：${what}`))]);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weave-watchdog-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// 当网站用的本机 HTTP 服务。plan 是第 1、2、3… 个请求各自怎么回答：数字是状态码，'hang' 是一直不回答，
// 'reset' 是收到请求就断开连接；最后一项一直重复。
async function site(t, plan) {
  const sockets = new Set();
  const s = {url: '', requests: 0};
  const server = createServer((req, res) => {
    const step = plan[Math.min(s.requests, plan.length - 1)];
    s.requests += 1;
    if (step === 'hang') return;
    if (step === 'reset') { req.socket.destroy(); return; }
    res.writeHead(step, {'content-type': 'text/plain'}).end(String(step));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  s.url = `http://127.0.0.1:${server.address().port}/`;
  // 网站停掉：之后的连接都被拒绝。
  s.stop = () => new Promise(resolve => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); });
  t.after(() => server.listening ? s.stop() : undefined);
  return s;
}

// 看门狗要停的进程（替身 wrangler）。exit 是它怎么结束的：{code, signal}。
async function target(t, command = 'sleep', args = ['60'], ready) {
  const child = spawn(command, args, {stdio: ['ignore', ready ? 'pipe' : 'ignore', 'ignore']});
  const p = {pid: child.pid, exit: null, output: ''};
  p.exited = new Promise(resolve => child.on('exit', (code, signal) => { p.exit = {code, signal}; resolve(p.exit); }));
  t.after(() => { if (!p.exit) child.kill('SIGKILL'); });
  if (ready) {
    child.stdout.setEncoding('utf8').on('data', chunk => { p.output += chunk; });
    await until('替身进程准备好', () => p.output.includes(ready));
  }
  return p;
}

// 间隔调短；内存一小时才记一次、读的是空目录，免得测试受这台机器的 /proc 和 cgroup 影响。
function watchdog(t, pid, env) {
  const empty = tempDir(t);
  const child = spawn('bash', [script, String(pid)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WEAVE_WATCHDOG_INTERVAL: '0.1', WEAVE_WATCHDOG_TIMEOUT: '1', WEAVE_WATCHDOG_KILL_AFTER: '1',
      WEAVE_WATCHDOG_MEMORY_EVERY: '3600', WEAVE_WATCHDOG_CGROUP_FILE: join(empty, 'none'), WEAVE_WATCHDOG_PROC: empty,
      ...env,
    },
  });
  const w = {output: '', exit: null};
  child.stdout.setEncoding('utf8').on('data', chunk => { w.output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { w.output += chunk; });
  w.exited = new Promise(resolve => child.on('exit', (code, signal) => { w.exit = {code, signal}; resolve(w.exit); }));
  t.after(() => { if (!w.exit) child.kill('SIGKILL'); });
  return w;
}

test('网站回答过 401 以后停掉了：连续 3 次连不上就给 wrangler 发 SIGTERM，自己以非零退出，留下一行中文', options, async (t) => {
  const s = await site(t, [401]);
  const wrangler = await target(t);
  const dog = watchdog(t, wrangler.pid, {WEAVE_WATCHDOG_URL: s.url});
  await until('看门狗开始盯着', () => dog.output.includes(armLine));
  await s.stop();
  const stoppedAt = Date.now();
  assert.deepEqual(await within(wrangler.exited, 8000, 'wrangler 被停掉'), {code: null, signal: 'SIGTERM'});
  assert.ok(Date.now() - stoppedAt < 4000, `3 次检查（间隔 0.1 秒）之内就该动手，实际用了 ${Date.now() - stoppedAt} 毫秒`);
  assert.deepEqual(await within(dog.exited, 3000, '看门狗退出'), {code: 1, signal: null});
  assert.equal(dog.output.match(restartLine)?.[1], '连不上', dog.output);
  assert.equal(dog.output.split('看门狗正在重启').length - 1, 1, '重启只说一次');
});

test('盯着以后偶尔一次 503（甚至连着两次）不算：中间回答一次 401 就重新数，不会动手', options, async (t) => {
  const s = await site(t, [401, 503, 401, 503, 503, 401]);
  const wrangler = await target(t);
  const dog = watchdog(t, wrangler.pid, {WEAVE_WATCHDOG_URL: s.url});
  await until('网站被请求了 9 次', () => s.requests >= 9);
  assert.equal(wrangler.exit, null, 'wrangler 还在');
  assert.equal(dog.exit, null, '看门狗还在');
  assert.doesNotMatch(dog.output, restartLine);
  assert.equal(dog.output.split(armLine).length - 1, 1, '开始盯着只说一次');
});

test('盯着以后 503、断开、超时各一次，也算连续 3 次：第 4 个请求之后就动手，不再发第 5 个', options, async (t) => {
  const s = await site(t, [401, 503, 'reset', 'hang']);
  const wrangler = await target(t);
  const dog = watchdog(t, wrangler.pid, {WEAVE_WATCHDOG_URL: s.url, WEAVE_WATCHDOG_TIMEOUT: '0.5'});
  assert.deepEqual(await within(wrangler.exited, 8000, 'wrangler 被停掉'), {code: null, signal: 'SIGTERM'});
  assert.equal(s.requests, 4);
  assert.equal(dog.output.match(restartLine)?.[1], '0.5 秒内没有回答', dog.output);
  assert.deepEqual(await within(dog.exited, 3000, '看门狗退出'), {code: 1, signal: null});
});

test('网站还没有正常回答过：一直卡住、断开、500 都不算，永远不动手（卡住的请求到时间就放弃，接着查下一次）', options, async (t) => {
  const s = await site(t, ['hang', 'reset', 503, 500, 'hang']);
  const wrangler = await target(t);
  const dog = watchdog(t, wrangler.pid, {WEAVE_WATCHDOG_URL: s.url, WEAVE_WATCHDOG_TIMEOUT: '0.3'});
  await until('网站被请求了 7 次', () => s.requests >= 7);
  assert.equal(wrangler.exit, null, 'wrangler 还在');
  assert.equal(dog.exit, null, '看门狗还在');
  assert.ok(!dog.output.includes('[weave watchdog]'), dog.output);
});

test('网站的端口还没开（wrangler 还在启动）：一直连不上也不动手', options, async (t) => {
  const s = await site(t, [401]);
  await s.stop();
  const wrangler = await target(t);
  const dog = watchdog(t, wrangler.pid, {WEAVE_WATCHDOG_URL: s.url});
  await delay(1500);
  assert.equal(wrangler.exit, null, 'wrangler 还在');
  assert.equal(dog.exit, null, '看门狗还在');
  assert.ok(!dog.output.includes('[weave watchdog]'), dog.output);
});

test('wrangler 不理 SIGTERM：等 KILL_AFTER 秒以后改用 SIGKILL', options, async (t) => {
  const s = await site(t, [401]);
  const wrangler = await target(t, process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], 'ready');
  const dog = watchdog(t, wrangler.pid, {WEAVE_WATCHDOG_URL: s.url});
  await until('看门狗开始盯着', () => dog.output.includes(armLine));
  await s.stop();
  assert.deepEqual(await within(wrangler.exited, 8000, 'wrangler 被停掉'), {code: null, signal: 'SIGKILL'});
  assert.match(dog.output, restartLine);
  assert.match(dog.output, new RegExp(`进程 ${wrangler.pid} 收到 SIGTERM 1 秒后还在，改用 SIGKILL。`));
  assert.deepEqual(await within(dog.exited, 3000, '看门狗退出'), {code: 1, signal: null});
});

test('每隔一段时间记一行内存：容器的数字来自 cgroup 文件，workerd 是各进程 VmRSS 之和；读不到 cgroup 就只记 workerd', options, async (t) => {
  const dir = tempDir(t);
  const cgroup = join(dir, 'memory.current');
  writeFileSync(cgroup, `${700 * 1024 * 1024}\n`);
  const fakeProc = (name, processes) => {
    const proc = join(dir, name);
    for (const [pid, comm, rssKiB] of processes) {
      mkdirSync(join(proc, pid), {recursive: true});
      const rss = rssKiB === undefined ? '' : `VmRSS:\t${String(rssKiB).padStart(8)} kB\n`;
      writeFileSync(join(proc, pid, 'status'), `Name:\t${comm}\nUmask:\t0022\nState:\tS (sleeping)\nVmPeak:\t 9999999 kB\n${rss}Threads:\t9\n`);
    }
    mkdirSync(join(proc, 'self'), {recursive: true});
    return proc;
  };
  // 两个 workerd（wrangler 的代理和网站程序各一个），一个 node（不算），一个内核线程（没有 VmRSS）。
  const two = fakeProc('two', [['41', 'workerd', 380 * 1024], ['52', 'workerd', 32 * 1024], ['7', 'node', 200 * 1024], ['2', 'kthreadd']]);
  const one = fakeProc('one', [['41', 'workerd', 380 * 1024 + 300]]);
  const s = await site(t, [401]);
  const wrangler = await target(t);
  const env = {WEAVE_WATCHDOG_URL: s.url, WEAVE_WATCHDOG_MEMORY_EVERY: '1'};
  const dogs = [
    watchdog(t, wrangler.pid, {...env, WEAVE_WATCHDOG_CGROUP_FILE: cgroup, WEAVE_WATCHDOG_PROC: two}),
    watchdog(t, wrangler.pid, {...env, WEAVE_WATCHDOG_CGROUP_FILE: join(dir, 'missing'), WEAVE_WATCHDOG_PROC: two}),
    watchdog(t, wrangler.pid, {...env, WEAVE_WATCHDOG_CGROUP_FILE: cgroup, WEAVE_WATCHDOG_PROC: one}),
  ];
  const line = dog => dog.output.match(/^\[weave memory\][^\n]*(?=\n)/m)?.[0];
  await until('三只看门狗都记了内存', () => dogs.every(line));
  assert.equal(line(dogs[0]), '[weave memory] 容器 700 MiB，workerd 412 MiB（pid 41: 380 MiB，pid 52: 32 MiB）');
  assert.equal(line(dogs[1]), '[weave memory] workerd 412 MiB（pid 41: 380 MiB，pid 52: 32 MiB）');
  assert.equal(line(dogs[2]), '[weave memory] 容器 700 MiB，workerd 380 MiB');
  assert.equal(wrangler.exit, null, '记内存不碰 wrangler');
});

test('要停的进程自己没了，看门狗也安静地退出，不留在后台', options, async (t) => {
  const s = await site(t, [401]);
  const wrangler = await target(t);
  const dog = watchdog(t, wrangler.pid, {WEAVE_WATCHDOG_URL: s.url});
  await until('看门狗开始盯着', () => dog.output.includes(armLine));
  process.kill(wrangler.pid, 'SIGKILL');
  await wrangler.exited;
  assert.deepEqual(await within(dog.exited, 3000, '看门狗退出'), {code: 0, signal: null});
  assert.doesNotMatch(dog.output, restartLine);
});

test('进程号不对就不启动（绝不会 kill 0 或整个进程组）', () => {
  for (const args of [[], [''], ['0'], ['007'], ['-1'], ['abc'], ['12a']]) {
    const r = spawnSync('bash', [script, ...args], {encoding: 'utf8', env: {...process.env, WEAVE_WATCHDOG_URL: 'http://127.0.0.1:9/'}});
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /用法：web-watchdog\.sh <要停的进程号>/);
  }
});

test('start-vps.sh 在 exec wrangler 之前把看门狗放到后台、传 "$$"；镜像里带上它并且可以执行', () => {
  const start = readFileSync(join(root, 'hosted/scripts/start-vps.sh'), 'utf8');
  assert.match(start, /\n\.\/scripts\/web-watchdog\.sh "\$\$" &\n\nexec node \.\/node_modules\/wrangler\/bin\/wrangler\.js \\\n {2}dev /);
  const dockerfile = readFileSync(join(root, 'hosted/Dockerfile.vps'), 'utf8');
  assert.match(dockerfile, /\nCOPY scripts\/start-vps\.sh scripts\/web-watchdog\.sh [^\n]* \.\/scripts\/\n/);
  assert.match(dockerfile, /\nRUN chmod \+x \.\/scripts\/start-vps\.sh \.\/scripts\/web-watchdog\.sh /);
});
