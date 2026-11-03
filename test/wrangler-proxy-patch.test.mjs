import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ORIGINAL_SHA256, isPatched, patchSource} from '../hosted/scripts/patch-wrangler-proxy.mjs';

// wrangler 4.92.0 的开发代理（ProxyWorker.js）原文。网站在服务器上用 `wrangler dev` 当正式服务，
// 浏览器每 5 秒轮询一次 /api/status，正好撞上代理和网站程序之间那条闲了约 5 秒的连接被关掉的瞬间时，
// 转发立刻失败（"Network connection lost."）。原文件把这种 GET 挂进重试队列，要等下一个请求到达才重试；
// Chrome 又把同一地址的后续轮询在浏览器里扣 20 秒，于是日志里是 5 + 20 = 25,0xx ms。
const original = readFileSync(new URL('./fixtures/wrangler-4.92.0-ProxyWorker.js', import.meta.url), 'utf8');

// workerd 的 Headers 有 getAll，Node 的没有；代理改写 Set-Cookie 时会用到。
if (!Headers.prototype.getAll) Headers.prototype.getAll = function (name) { return name.toLowerCase() === 'set-cookie' ? this.getSetCookie() : [this.get(name)].filter(Boolean); };

let loaded = 0;
async function load(source) {
  const dir = mkdtempSync(join(tmpdir(), 'proxyworker-'));
  const file = join(dir, `ProxyWorker-${++loaded}.mjs`);
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)).ProxyWorker;
}

const dropped = () => { throw new Error('Network connection lost.'); };
const answered = () => new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}});
const never = (ms) => new Promise(resolve => setTimeout(() => resolve('pending'), ms));

// steps：转发给网站程序的第 1、2、3… 次调用各自怎么表现（最后一个步骤一直重复）。
async function proxyWith(t, ProxyWorker, steps) {
  const realFetch = globalThis.fetch, realWarn = console.warn;
  const forwarded = [], warnings = [], reported = [];
  const proxy = new ProxyWorker({}, {
    PROXY_CONTROLLER_AUTH_SECRET: 'secret',
    PROXY_CONTROLLER: {fetch: async (_url, init) => { reported.push(JSON.parse(init.body)); return new Response(null, {status: 204}); }},
  });
  proxy.proxyData = {userWorkerUrl: {protocol: 'http:', hostname: '127.0.0.1', port: '5001'}, headers: {}};
  globalThis.fetch = async (url) => { forwarded.push(String(url)); return steps[Math.min(forwarded.length - 1, steps.length - 1)](proxy); };
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { globalThis.fetch = realFetch; console.warn = realWarn; });
  return {proxy, forwarded, warnings, reported};
}
const get = (path, init) => new Request('http://127.0.0.1:4317' + path, init);

test('夹具就是 wrangler 4.92.0 的原文件', () => {
  assert.equal(createHash('sha256').update(original).digest('hex'), ORIGINAL_SHA256);
  assert.equal(isPatched(original), false);
});

test('补丁只在原文件上打，位置对不上就报错，不会打出半截', () => {
  const patched = patchSource(original);
  assert.equal(isPatched(patched), true);
  assert.throws(() => patchSource(patched), /补丁位置对不上/);
  assert.throws(() => patchSource(original.replace('urlFromParts(this.proxyData.userWorkerUrl)', 'x')), /补丁位置对不上/);
});

test('没打补丁（原文件）：轮询撞上被关的连接，GET 被挂进重试队列，一直等到下一个请求到达', async (t) => {
  const ProxyWorker = await load(original);
  const {proxy, forwarded} = await proxyWith(t, ProxyWorker, [dropped, answered]);
  const first = proxy.fetch(get('/api/status'));
  assert.equal(await Promise.race([first, never(300)]), 'pending', '失败的 GET 没有马上重试');
  assert.equal(proxy.requestRetryQueue.size, 1);
  assert.equal(forwarded.length, 1);
  // 下一个请求到达（processQueue）才会把它放出去：这就是日志里的 25,0xx ms。
  const second = proxy.fetch(get('/api/status'));
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('没打补丁（原文件）：路径是 / 的请求失败，会把错误报给 wrangler 主进程（它会因此整个退出）', async (t) => {
  const ProxyWorker = await load(original);
  const {proxy, reported} = await proxyWith(t, ProxyWorker, [dropped]);
  await assert.rejects(proxy.fetch(get('/')), /Network connection lost/);
  assert.equal(reported.filter(m => m.type === 'error').length, 1);
});

test('打了补丁：GET 被掐断后马上重试，不用等下一个请求', async (t) => {
  const ProxyWorker = await load(patchSource(original));
  const {proxy, forwarded, warnings, reported} = await proxyWith(t, ProxyWorker, [dropped, answered]);
  const started = Date.now();
  const response = await Promise.race([proxy.fetch(get('/api/status')), never(1000)]);
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 500, '重试是立刻的，不是等 5 秒或 25 秒');
  assert.equal(forwarded.length, 2);
  assert.equal(proxy.requestRetryQueue.size, 0);
  assert.equal(reported.length, 0);
  assert.match(warnings.join('\n'), /\[weave patch\] GET \/api\/status recovered on attempt 2/);
});

test('打了补丁：HEAD 一样重试；路径是 / 的 GET 也一样，不再把错误报给 wrangler 主进程', async (t) => {
  const ProxyWorker = await load(patchSource(original));
  const {proxy, forwarded, reported} = await proxyWith(t, ProxyWorker, [dropped, answered]);
  assert.equal((await proxy.fetch(get('/', {method: 'HEAD'}))).status, 200);
  assert.equal((await proxy.fetch(get('/'))).status, 200);
  assert.equal(forwarded.length, 3, '第一个 HEAD 试了 2 次；之后的 GET 第一次就成功');
  assert.equal(reported.length, 0);
});

test('打了补丁：连续被掐断最多共试 3 次，之后只让这一个请求收到 503，不通知主进程，也不挂起', async (t) => {
  const ProxyWorker = await load(patchSource(original));
  const {proxy, forwarded, warnings, reported} = await proxyWith(t, ProxyWorker, [dropped]);
  const response = await Promise.race([proxy.fetch(get('/api/status')), never(2000)]);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '0');
  assert.match(await response.text(), /Lost the connection to the worker/);
  assert.equal(forwarded.length, 3);
  assert.equal(proxy.requestRetryQueue.size, 0);
  assert.equal(reported.length, 0);
  assert.match(warnings.join('\n'), /\[weave patch\] GET \/api\/status failed: Network connection lost/);
  // 之后的请求照常转发。
  assert.equal(proxy.requestQueue.size, 0);
});

test('打了补丁：POST 被掐断不重试（可能已经执行过），直接回 503', async (t) => {
  const ProxyWorker = await load(patchSource(original));
  const {proxy, forwarded, reported} = await proxyWith(t, ProxyWorker, [dropped]);
  const response = await proxy.fetch(get('/api/chat', {method: 'POST'}));
  assert.equal(response.status, 503);
  assert.equal(forwarded.length, 1, '只试一次：后面就算有成功的步骤也不会重试');
  assert.equal(reported.length, 0);
  // 路径是 / 的 POST 以前会让 wrangler 整个退出，现在同样只是 503。
  assert.equal((await proxy.fetch(get('/', {method: 'POST'}))).status, 503);
  assert.equal(forwarded.length, 2);
  assert.equal(reported.length, 0);
});

test('打了补丁：网站程序真的换了（重新加载）时，GET 照旧留着，重新就绪后再放出去', async (t) => {
  const ProxyWorker = await load(patchSource(original));
  const {proxy, forwarded} = await proxyWith(t, ProxyWorker, [
    (p) => { p.proxyData = {userWorkerUrl: {protocol: 'http:', hostname: '127.0.0.1', port: '5002'}, headers: {}}; return dropped(); },
    answered,
  ]);
  const pending = proxy.fetch(get('/api/status'));
  assert.equal(await Promise.race([pending, never(300)]), 'pending');
  assert.equal(proxy.requestRetryQueue.size, 1);
  proxy.processQueue(); // wrangler 的 "play" 消息就是这么做的
  assert.equal((await pending).status, 200);
  assert.deepEqual(forwarded.map(u => new URL(u).port), ['5001', '5002']);
});
