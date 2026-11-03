import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {INSPECTOR_ORIGINAL_SHA256, TARGETS, isInspectorUpstreamFixed, isPatched, patchInspectorSource, processTarget} from '../hosted/scripts/patch-wrangler-proxy.mjs';

// wrangler 4.92.0 的调试代理（InspectorProxyWorker.js）原文。它和开发代理住在同一个 workerd 进程里（服务器上监听 4317 的那个），
// 一启动就连上网站程序的调试接口，不管有没有人打开 DevTools，都发 Network.enable。之后网站程序每发一个子请求
// （每一次 D1 查询都是：http://d1/query、http://d1/execute），workerd 就送来 4 条网络事件，Network.loadingFinished 里还带着
// base64 的整个回答（cfResponse.body，也就是读出来的整个 world）。这些消息都进 runtimeMessageBuffer，
// 只有 DevTools 连上时才清空，线上没人连，于是一直涨，到容器 768 MB 上限时被内核杀掉。
// 上游在 wrangler 4.100.0（PR #14243，issue #14191）的修法：没有 DevTools 时不发 Network.enable，DevTools 断开时发 Network.disable。
const original = readFileSync(new URL('./fixtures/wrangler-4.92.0-InspectorProxyWorker.js', import.meta.url), 'utf8');
const proxyOriginal = new URL('./fixtures/wrangler-4.92.0-ProxyWorker.js', import.meta.url);

let loaded = 0;
async function load(source) {
  const dir = mkdtempSync(join(tmpdir(), 'inspectorproxy-'));
  const file = join(dir, `InspectorProxyWorker-${++loaded}.mjs`);
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)).InspectorProxyWorker;
}

// workerd 的 WebSocket 只用到这几个方法；send 收到的都是 JSON 字符串。
function fakeSocket() {
  const listeners = {};
  return {
    sent: [],
    accept() {},
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    send(message) { this.sent.push(JSON.parse(message)); },
    close(code) { this.closedWith = code; },
    emit(type, event = {}) { for (const fn of listeners[type] || []) fn(event); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const methods = (socket) => socket.sent.map(m => m.method);

// 像 wrangler 那样：网站程序（重新）就绪后连上它的调试接口。这里没有 DevTools。
async function connectedWithoutDevTools(t, InspectorProxyWorker) {
  const debugLogs = [];
  const inspector = new InspectorProxyWorker({}, {
    PROXY_CONTROLLER_AUTH_SECRET: 'secret',
    WRANGLER_VERSION: '4.92.0',
    PROXY_CONTROLLER: {fetch: async (_url, init) => { debugLogs.push(JSON.parse(init.body)); return new Response(null, {status: 204}); }},
  });
  const runtime = fakeSocket();
  inspector.websockets.runtime = runtime;
  inspector.handleRuntimeWebSocketOpen(runtime);
  t.after(() => clearInterval(inspector.runtimeKeepAliveInterval));
  await tick();
  return {inspector, runtime, debugLogs};
}

// 像 DevTools 那样连上调试代理（workerd 的 WebSocketPair 和 101 回答在 Node 里没有，换成假的）。
async function attachDevTools(t, inspector) {
  const realPair = globalThis.WebSocketPair, RealResponse = globalThis.Response;
  const devtools = fakeSocket();
  globalThis.WebSocketPair = function WebSocketPair() { return {0: fakeSocket(), 1: devtools}; };
  globalThis.Response = class extends RealResponse { constructor(body, init = {}) { super(body, init.status === 101 ? {...init, status: 200} : init); } };
  t.after(() => { globalThis.WebSocketPair = realPair; globalThis.Response = RealResponse; });
  await inspector.fetch(new Request('http://127.0.0.1:9229/ws', {headers: {Upgrade: 'websocket', Host: '127.0.0.1:9229', Origin: 'http://localhost'}}));
  globalThis.WebSocketPair = realPair; globalThis.Response = RealResponse;
  assert.equal(inspector.websockets.devtools, devtools);
  return devtools;
}

// workerd 对一次 D1 查询送来的 4 条网络事件（形状和线上一样，回答体换成假的）。
function d1QueryEvents(requestId, body) {
  return [
    {method: 'Network.requestWillBeSent', params: {requestId, request: {url: 'http://d1/query?resultsFormat=ROWS_AND_COLUMNS', method: 'POST', headers: {}}, initiator: {type: 'script'}, type: 'Fetch'}},
    {method: 'Network.responseReceived', params: {requestId, type: 'XHR', response: {status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json'}}},
    {method: 'Network.dataReceived', params: {requestId, dataLength: body.length, encodedDataLength: body.length}},
    {method: 'Network.loadingFinished', params: {requestId, encodedDataLength: body.length, cfResponse: {body: Buffer.from(body).toString('base64'), base64Encoded: true}}},
  ];
}

test('夹具就是 wrangler 4.92.0 的 InspectorProxyWorker.js 原文件', () => {
  assert.equal(createHash('sha256').update(original).digest('hex'), INSPECTOR_ORIGINAL_SHA256);
  assert.equal(isPatched(original), false);
  assert.equal(isInspectorUpstreamFixed(original), false);
});

test('调试代理的补丁只在原文件上打，位置对不上就报错，不会打出半截', () => {
  const patched = patchInspectorSource(original);
  assert.equal(isPatched(patched), true);
  assert.throws(() => patchInspectorSource(patched), /补丁位置对不上/);
  assert.throws(() => patchInspectorSource(original.replace('method: "Debugger.disable"\n            });', 'x')), /补丁位置对不上/);
});

test('没打补丁（原文件）：没人打开 DevTools 也发 Network.enable，网站程序的每次 D1 查询连同回答都存进缓冲区，一直不清', async (t) => {
  const InspectorProxyWorker = await load(original);
  const {inspector, runtime} = await connectedWithoutDevTools(t, InspectorProxyWorker);
  assert.deepEqual(methods(runtime), ['Runtime.enable', 'Network.enable']);
  const world = JSON.stringify([{results: [{id: 'u:me', kind: 'people', document: 'x'.repeat(100_000)}]}]);
  for (let i = 0; i < 50; i++) for (const event of d1QueryEvents(String(i), world)) inspector.handleRuntimeIncomingMessage({data: JSON.stringify(event)});
  assert.equal(inspector.runtimeMessageBuffer.length, 200, '50 次查询 × 4 条，一条都没丢');
  const kept = inspector.runtimeMessageBuffer.reduce((sum, m) => sum + (m.params?.cfResponse?.body.length || 0), 0);
  assert.ok(kept > 50 * 100_000, `每次都留下一份 base64 的完整回答（共 ${(kept / 1048576).toFixed(1)} MiB）`);
});

test('打了补丁：没有 DevTools 时不发 Network.enable（网站程序就不会送网络事件），Runtime.enable 照旧', async (t) => {
  const InspectorProxyWorker = await load(patchInspectorSource(original));
  const {inspector, runtime} = await connectedWithoutDevTools(t, InspectorProxyWorker);
  assert.deepEqual(methods(runtime), ['Runtime.enable']);
  assert.notEqual(inspector.runtimeKeepAliveInterval, null, '10 秒一次的保活照旧');
});

test('打了补丁：DevTools 连上时缓冲区照常交给它；断开时补一个 Network.disable，把它打开的网络事件关掉', async (t) => {
  const InspectorProxyWorker = await load(patchInspectorSource(original));
  const {inspector, runtime} = await connectedWithoutDevTools(t, InspectorProxyWorker);
  inspector.handleRuntimeIncomingMessage({data: JSON.stringify({method: 'Runtime.consoleAPICalled', params: {type: 'log', args: []}})});
  const devtools = await attachDevTools(t, inspector);
  assert.deepEqual(methods(devtools), ['Runtime.consoleAPICalled'], '连上前存下的消息交给了 DevTools');
  assert.equal(inspector.runtimeMessageBuffer.length, 0);
  // DevTools 自己会发 Network.enable，调试代理原样转给网站程序。
  devtools.emit('message', {data: JSON.stringify({id: 1, method: 'Network.enable'})});
  await tick();
  assert.ok(methods(runtime).includes('Network.enable'));
  runtime.sent.length = 0;
  devtools.emit('close', {code: 1000, reason: ''});
  await tick();
  assert.deepEqual(methods(runtime), ['Debugger.disable', 'Network.disable']);
  assert.equal(inspector.websockets.devtools, undefined);
});

test('没打补丁（原文件）：DevTools 断开时只关 Debugger，它打开的网络事件留着，接着往缓冲区里存', async (t) => {
  const InspectorProxyWorker = await load(original);
  const {inspector, runtime} = await connectedWithoutDevTools(t, InspectorProxyWorker);
  const devtools = await attachDevTools(t, inspector);
  runtime.sent.length = 0;
  devtools.emit('close', {code: 1000, reason: ''});
  await tick();
  assert.deepEqual(methods(runtime), ['Debugger.disable']);
});

// 构建（Dockerfile.vps）不带参数跑，两个文件都打；容器启动时 start-vps.sh 用 --check，任何一个没打都要说出来。
test('脚本：两个文件都按原文件打补丁；--check 只认打过补丁或上游已修复的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrangler-dist-'));
  const files = {proxy: join(dir, 'ProxyWorker.js'), inspector: join(dir, 'InspectorProxyWorker.js')};
  copyFileSync(proxyOriginal, files.proxy);
  writeFileSync(files.inspector, original);
  const [proxyTarget, inspectorTarget] = TARGETS.map((target, i) => ({...target, file: i === 0 ? files.proxy : files.inspector}));
  assert.equal(TARGETS.length, 2);

  assert.equal(processTarget(inspectorTarget, '--check').ok, false, '原文件没打补丁，--check 不通过');
  assert.equal(processTarget(inspectorTarget, '--print').ok, true);
  assert.equal(readFileSync(files.inspector, 'utf8'), original, '--print 不改文件');
  for (const target of [proxyTarget, inspectorTarget]) assert.equal(processTarget(target, '').ok, true);
  assert.equal(isPatched(readFileSync(files.inspector, 'utf8')), true);
  assert.equal(isPatched(readFileSync(files.proxy, 'utf8')), true);
  for (const target of [proxyTarget, inspectorTarget]) assert.equal(processTarget(target, '--check').ok, true);
  assert.equal(processTarget(inspectorTarget, '').ok, true, '已经打过就不再动');

  // 换了版本（内容既不是原文件、也没有上游修复）：不动文件，让人来看。
  writeFileSync(files.inspector, original.replace('Runtime.getIsolateId', 'Runtime.somethingElse'));
  const changed = processTarget(inspectorTarget, '');
  assert.equal(changed.ok, false);
  assert.match(changed.message, /不是 4\.92\.0 的原文件/);
  // 上游已经修了（4.100.0 起：断开 DevTools 时发 Network.disable）：什么都不做。
  writeFileSync(files.inspector, original.replace('method: "Debugger.disable"\n            });', 'method: "Debugger.disable"\n            });\n            this.sendRuntimeMessage({\n              id: this.nextCounter(),\n              method: "Network.disable"\n            });'));
  const upstream = processTarget(inspectorTarget, '--check');
  assert.equal(upstream.ok, true);
  assert.match(upstream.message, /上游已修复/);
});
