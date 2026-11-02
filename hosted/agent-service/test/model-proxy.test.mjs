import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLedger} from '../ledger.mjs';
import {createModelProxy} from '../model-proxy.mjs';
import {startFakeModel} from './helpers/fake-model.mjs';

async function setup({limits = {perAccount: 1_000_000, total: 10_000_000}, upstream} = {}) {
  const fake = await startFakeModel();
  const ledger = createLedger({file: join(mkdtempSync(join(tmpdir(), 'weave-proxy-')), 'usage.json')});
  const base = upstream ?? fake.baseUrl;
  const proxy = createModelProxy({
    keys: {deepseek: 'real-key', kimi: 'kimi-real-key'},
    upstreams: {deepseek: base, kimi: base},
    ledger, limits,
  });
  const server = http.createServer(proxy.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, {token, body = {model: 'deepseek-flash', max_tokens: 10, messages: [{role: 'user', content: 'hi'}]}, headers = {}, method = 'POST'} = {}) =>
    fetch(url + path, {method, headers: {'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(token ? {authorization: 'Bearer ' + token} : {}), ...headers}, body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fake.close(); };
  return {fake, ledger, proxy, call, close};
}
const modelCalls = fake => fake.captured.filter(c => c.path.startsWith('/v1/messages'));

test('没有令牌、乱写的令牌、已经 close 的令牌都返回 401，上游一次没被请求', async t => {
  const s = await setup(); t.after(s.close);
  const run = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  run.close();
  for (const token of [undefined, 'nope', run.token]) {
    const r = await s.call('/v1/messages', {token});
    assert.equal(r.status, 401, String(token));
    assert.equal((await r.json()).error.type, 'authentication_error');
  }
  assert.equal(s.fake.captured.length, 0);
});

test('只转发 /v1/messages 和 count_tokens，其他路径 404', async t => {
  const s = await setup(); t.after(s.close);
  const {token} = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  for (const [path, method] of [['/v1/models', 'POST'], ['/v1/messages', 'GET'], ['/v1/messages/../complete', 'POST'], ['/v1/messages/batches', 'POST']]) {
    const r = await s.call(path, {token, method});
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal(s.fake.captured.length, 0);
  const counted = await s.call('/v1/messages/count_tokens?beta=true', {token});
  assert.equal(counted.status, 200);
  assert.equal(s.fake.captured[0].path, '/v1/messages/count_tokens?beta=true');
});

test('上游看到真 Key，看不到运行令牌和别的请求头', async t => {
  const s = await setup(); t.after(s.close);
  const {token} = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  const r = await s.call('/v1/messages?beta=true', {token, headers: {'x-api-key': token, 'x-evil': '1', 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14'}});
  assert.equal(r.status, 200);
  await r.text();
  const seen = s.fake.captured[0];
  assert.equal(seen.path, '/v1/messages?beta=true');
  assert.equal(seen.headers.authorization, 'Bearer real-key');
  assert.equal(seen.headers['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14');
  assert.equal(seen.headers['x-api-key'], undefined);
  assert.equal(seen.headers['x-evil'], undefined);
  assert.ok(!JSON.stringify(seen.headers).includes(token));
});

test('表外模型 400；带 [1m] 的表内模型放行', async t => {
  const s = await setup(); t.after(s.close);
  const {token} = s.proxy.openRun({account: 'u:a', provider: 'kimi', model: 'kimi-k3[1m]'});
  const denied = await s.call('/v1/messages', {token, body: {model: 'claude-opus-4', messages: []}});
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.type, 'invalid_request_error');
  assert.equal(s.fake.captured.length, 0);
  const allowed = await s.call('/v1/messages', {token, body: {model: 'kimi-k3', messages: []}});
  assert.equal(allowed.status, 200);
  await allowed.text();
  assert.equal(s.fake.captured[0].headers.authorization, 'Bearer kimi-real-key');
});

test('SSE 原样流回，token 记进这个账号的账本', async t => {
  const s = await setup(); t.after(s.close);
  s.fake.script(() => ({text: '你好'}), {input: 120, output: 30});
  const {token} = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  const r = await s.call('/v1/messages', {token});
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /"text":"你好"/);
  assert.match(text, /event: message_stop/);
  assert.equal(s.ledger.used('u:a'), 150);
  assert.equal(s.ledger.used('u:b'), 0);
});

test('本账号或全站到额度返回 429，带 x-should-retry: false，上游一次没被请求', async t => {
  const s = await setup({limits: {perAccount: 1000, total: 1500}}); t.after(s.close);
  s.ledger.add('u:a', 1000);
  const a = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  const own = await s.call('/v1/messages', {token: a.token});
  assert.equal(own.status, 429);
  assert.equal(own.headers.get('x-should-retry'), 'false');
  assert.equal((await own.json()).error.type, 'rate_limit_error');
  s.ledger.add('u:b', 500);
  const c = s.proxy.openRun({account: 'u:c', provider: 'deepseek', model: 'deepseek-flash'});
  const site = await s.call('/v1/messages', {token: c.token});
  assert.equal(site.status, 429);
  assert.equal(s.fake.captured.length, 0);
});

test('用户自己的 Key：转发用这把 Key，不记账，也不受托管额度限制', async t => {
  const s = await setup({limits: {perAccount: 10, total: 10}}); t.after(s.close);
  s.ledger.add('u:c', 999);
  const {token} = s.proxy.openRun({account: 'u:c', provider: 'deepseek', model: 'deepseek-flash', userKey: 'user-own-key'});
  const r = await s.call('/v1/messages', {token});
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(s.fake.captured[0].headers.authorization, 'Bearer user-own-key');
  assert.equal(s.ledger.used('u:c'), 999);
});

test('请求体超过 8 MB 返回 413，不转发', async t => {
  const s = await setup(); t.after(s.close);
  const {token} = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  const r = await s.call('/v1/messages', {token, body: JSON.stringify({model: 'deepseek-flash', pad: 'x'.repeat(9 * 1024 * 1024)})});
  assert.equal(r.status, 413);
  assert.equal(s.fake.captured.length, 0);
});

test('上游连不上返回 502 api_error', async t => {
  const s = await setup({upstream: 'http://127.0.0.1:9'}); t.after(s.close);
  const {token} = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  const r = await s.call('/v1/messages', {token});
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.type, 'api_error');
});

test('openRun：表外模型直接报错；没有托管 Key 也没有 userKey 时报 503', async t => {
  const s = await setup(); t.after(s.close);
  assert.throws(() => s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'gpt-5'}));
  assert.throws(() => s.proxy.openRun({account: 'u:a', provider: 'glm', model: 'glm-4.7'}), e => e.status === 503);
  assert.ok(s.proxy.openRun({account: 'u:a', provider: 'glm', model: 'glm-4.7', userKey: 'mine'}).token);
});

test('不同的一轮拿到不同的令牌，关掉一个不影响另一个', async t => {
  const s = await setup(); t.after(s.close);
  const a = s.proxy.openRun({account: 'u:a', provider: 'deepseek', model: 'deepseek-flash'});
  const b = s.proxy.openRun({account: 'u:b', provider: 'deepseek', model: 'deepseek-flash'});
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[a-f0-9]{48}$/);
  a.close();
  assert.equal((await s.call('/v1/messages', {token: a.token})).status, 401);
  const ok = await s.call('/v1/messages', {token: b.token});
  assert.equal(ok.status, 200);
  await ok.text();
});
