// hosted/scripts/notion-oauth-proxy.mjs：网站容器里的 Notion 本地代理。
// 要保证的：对上游有超时、错误回给调用方时不带密钥和 token、只往 Notion 的 /v1/ 下面发。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNotionProxy, upstreamOrigin} from '../hosted/scripts/notion-oauth-proxy.mjs';
import {createFakeNotion, notionPage} from '../scripts/notion-oauth-e2e/fake-notion.mjs';

const SCRIPT = new URL('../hosted/scripts/notion-oauth-proxy.mjs', import.meta.url).pathname;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

// 一个什么都能扮演的上游：记录收到的请求，按 respond 回答。
async function upstream(t, respond) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = {method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8')};
    seen.push(entry);
    await respond(entry, res);
  });
  const port = await listen(server);
  t.after(() => close(server));
  return {seen, base: `http://127.0.0.1:${port}`};
}

async function proxyFor(t, options) {
  const server = createNotionProxy(options);
  const port = await listen(server);
  t.after(() => close(server));
  const call = (path, body, method = 'POST') => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({host: '127.0.0.1', port, path, method, headers: payload === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers}));
    });
    req.once('error', reject);
    req.end(payload);
  });
  return {call, port};
}

const quiet = t => {
  const lines = [], original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  t.after(() => { console.error = original; });
  return lines;
};

const SECRET = 'client-secret-DO-NOT-LEAK', CODE = 'one-time-code-123', TOKEN = 'ntn_private_token_abcdef';
const exchangeBody = {clientId: 'cid', clientSecret: SECRET, code: CODE, redirectUri: 'https://weave.test/api/connections/notion/callback'};

test('上游地址：线上不设就是 https://api.notion.com；设了只接受 https 或本机回环的 http', () => {
  assert.equal(upstreamOrigin(), 'https://api.notion.com');
  assert.equal(upstreamOrigin('https://api.notion.com/'), 'https://api.notion.com');
  assert.equal(upstreamOrigin('http://127.0.0.1:4512'), 'http://127.0.0.1:4512');
  assert.equal(upstreamOrigin('http://localhost:4512/ignored/path'), 'http://localhost:4512');
  for (const bad of ['http://api.notion.com', 'http://evil.example:80', 'ftp://127.0.0.1', 'not a url', '']) {
    if (bad === '') { assert.equal(upstreamOrigin(bad || undefined), 'https://api.notion.com'); continue; }
    assert.throws(() => upstreamOrigin(bad), bad);
  }
  assert.throws(() => createNotionProxy({upstream: 'http://evil.example'}));
});

test('换 token：发给 Notion 的请求和以前一模一样（地址、Basic 认证、JSON 正文），成功的回应原样转回', async t => {
  const up = await upstream(t, (req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({access_token: TOKEN, workspace_name: 'W'})); });
  const proxy = await proxyFor(t, {upstream: up.base});
  const r = await proxy.call('/exchange', exchangeBody);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), {access_token: TOKEN, workspace_name: 'W'});
  assert.equal(r.headers['content-type'], 'application/json');
  const [seen] = up.seen;
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/v1/oauth/token');
  assert.equal(seen.headers.authorization, 'Basic ' + Buffer.from(`cid:${SECRET}`).toString('base64'));
  assert.deepEqual(JSON.parse(seen.body), {grant_type: 'authorization_code', code: CODE, redirect_uri: exchangeBody.redirectUri});
});

test('通用转发：地址落在 /v1/ 下，带 Bearer 和 Notion-Version，方法转成大写；正文原样', async t => {
  const up = await upstream(t, (req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end('{"object":"list","results":[]}'); });
  const proxy = await proxyFor(t, {upstream: up.base});
  const r = await proxy.call('/api', {method: 'post', path: '/search', token: TOKEN, body: {page_size: 100}});
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"object":"list","results":[]}');
  assert.equal(up.seen[0].url, '/v1/search');
  assert.equal(up.seen[0].method, 'POST');
  assert.equal(up.seen[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(up.seen[0].headers['notion-version'], '2022-06-28');
  assert.deepEqual(JSON.parse(up.seen[0].body), {page_size: 100});
  await proxy.call('/api', {method: 'GET', path: 'blocks/abc/children?page_size=100&start_cursor=x', token: TOKEN, notionVersion: '2025-09-03'});
  assert.equal(up.seen[1].url, '/v1/blocks/abc/children?page_size=100&start_cursor=x');
  assert.equal(up.seen[1].headers['notion-version'], '2025-09-03');
  assert.equal(up.seen[1].body, '');
  await proxy.call('/api', {path: 'users/me', token: TOKEN});
  assert.equal(up.seen[2].method, 'GET', '不写方法就是 GET，和以前一样');
});

test('上游不回话：到时间就回 504 upstream_timeout，回应和日志里都没有密钥', async t => {
  const logs = quiet(t);
  const up = await upstream(t, () => { /* 永远不回 */ });
  const proxy = await proxyFor(t, {upstream: up.base, timeoutMs: 200});
  const started = Date.now();
  const exchange = await proxy.call('/exchange', exchangeBody);
  assert.equal(exchange.status, 504);
  assert.deepEqual(JSON.parse(exchange.text), {error: 'upstream_timeout'});
  assert.ok(Date.now() - started < 3000);
  const api = await proxy.call('/api', {method: 'POST', path: 'search', token: TOKEN, body: {}});
  assert.equal(api.status, 504);
  for (const text of [exchange.text, api.text, ...logs]) for (const secret of [SECRET, CODE, TOKEN]) assert.ok(!text.includes(secret), secret);
  assert.ok(logs.some(line => line.includes('timed out')), 'the timeout is logged');
});

test('上游中途断开，或连不上：502 upstream_unreachable，不带系统报错', async t => {
  const logs = quiet(t);
  const broken = await upstream(t, (req, res) => { res.destroy(); });
  const proxy = await proxyFor(t, {upstream: broken.base});
  const cut = await proxy.call('/api', {method: 'POST', path: 'search', token: TOKEN, body: {}});
  assert.equal(cut.status, 502);
  assert.deepEqual(JSON.parse(cut.text), {error: 'upstream_unreachable'});
  const dead = await proxyFor(t, {upstream: 'http://127.0.0.1:9'});
  const refused = await dead.call('/exchange', exchangeBody);
  assert.equal(refused.status, 502);
  assert.deepEqual(JSON.parse(refused.text), {error: 'upstream_unreachable'});
  for (const text of [cut.text, refused.text, ...logs]) for (const secret of [SECRET, CODE, TOKEN]) assert.ok(!text.includes(secret));
});

test('上游拒绝时状态码原样转回；如果正文里回显了我们发出去的密钥，替换掉', async t => {
  const echo = await upstream(t, (req, res) => { res.writeHead(400, {'content-type': 'application/json'}); res.end(JSON.stringify({error: 'invalid_grant', echoed: [req.headers.authorization, req.body, SECRET, CODE, TOKEN]})); });
  const proxy = await proxyFor(t, {upstream: echo.base});
  const exchange = await proxy.call('/exchange', exchangeBody);
  assert.equal(exchange.status, 400);
  assert.equal(JSON.parse(exchange.text).error, 'invalid_grant');
  for (const secret of [SECRET, CODE, Buffer.from(`cid:${SECRET}`).toString('base64')]) assert.ok(!exchange.text.includes(secret), secret);
  assert.ok(exchange.text.includes('[已隐藏]'));
  const api = await proxy.call('/api', {method: 'POST', path: 'search', token: TOKEN, body: {}});
  assert.equal(api.status, 400);
  assert.ok(!api.text.includes(TOKEN));
  // 成功的回应不动（access_token 本来就是要交给 Worker 的）
  const ok = await upstream(t, (req, res) => { res.writeHead(200); res.end(JSON.stringify({access_token: TOKEN})); });
  const okProxy = await proxyFor(t, {upstream: ok.base});
  assert.equal(JSON.parse((await okProxy.call('/exchange', exchangeBody)).text).access_token, TOKEN);
});

test('坏请求：JSON 解析不过、不是对象、缺字段、太大——都只回错误代码，不回显请求里的任何字', async t => {
  const logs = quiet(t);
  const up = await upstream(t, (req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await proxyFor(t, {upstream: up.base});
  const broken = await proxy.call('/exchange', `{"clientSecret":"${SECRET}", "token": "${TOKEN}", oops`);
  assert.equal(broken.status, 400);
  assert.deepEqual(JSON.parse(broken.text), {error: 'bad_json'});
  for (const body of ['[1,2]', '"text"', 'null', '42']) assert.deepEqual(JSON.parse((await proxy.call('/api', body)).text), {error: 'bad_json'}, body);
  assert.deepEqual(JSON.parse((await proxy.call('/exchange', {clientId: 'a', clientSecret: SECRET})).text), {error: 'missing_fields'});
  assert.deepEqual(JSON.parse((await proxy.call('/api', {method: 'POST', path: 'search'})).text), {error: 'missing_path_or_token'});
  assert.deepEqual(JSON.parse((await proxy.call('/api', {method: 'POST', path: 'search', token: 42})).text), {error: 'missing_path_or_token'});
  const huge = await proxy.call('/api', JSON.stringify({method: 'POST', path: 'search', token: TOKEN, body: {filler: 'x'.repeat(300 * 1024)}}));
  assert.equal(huge.status, 413);
  assert.deepEqual(JSON.parse(huge.text), {error: 'too_large'});
  assert.equal(up.seen.length, 0, 'none of these reached Notion');
  for (const text of [broken.text, huge.text, ...logs]) for (const secret of [SECRET, TOKEN]) assert.ok(!text.includes(secret));
});

test('只往 Notion 的 /v1/ 下面发：想跳出去的路径、不认识的方法都拒绝', async t => {
  const up = await upstream(t, (req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = await proxyFor(t, {upstream: up.base});
  for (const path of ['../oauth/token', 'a/../../oauth/token', '%2e%2e/oauth/token', '..%2foauth', 'a/%2e%2e/%2e%2e/b']) {
    const r = await proxy.call('/api', {method: 'GET', path, token: TOKEN});
    assert.equal(r.status, 400, path);
    assert.deepEqual(JSON.parse(r.text), {error: 'bad_path'}, path);
  }
  for (const method of ['TRACE', 'CONNECT', 'PUT', 'OPTIONS', 'x y']) assert.deepEqual(JSON.parse((await proxy.call('/api', {method, path: 'search', token: TOKEN})).text), {error: 'bad_method'}, method);
  assert.equal(up.seen.length, 0);
  // 看起来像网址的路径也只会落在 /v1/ 下面，主机不会变
  await proxy.call('/api', {method: 'GET', path: '//evil.example/x', token: TOKEN});
  await proxy.call('/api', {method: 'GET', path: 'https://evil.example/x', token: TOKEN});
  assert.ok(up.seen.every(entry => entry.url.startsWith('/v1/')), JSON.stringify(up.seen.map(e => e.url)));
});

test('/health 回 ok，不认识的地址或方法回 404（和以前一样）', async t => {
  const proxy = await proxyFor(t, {});
  const health = await proxy.call('/health', undefined, 'GET');
  assert.equal(health.status, 200);
  assert.equal(health.text, 'ok');
  assert.equal((await proxy.call('/nope', {})).status, 404);
  assert.equal((await proxy.call('/exchange', undefined, 'GET')).status, 404);
  assert.equal((await proxy.call('/api', undefined, 'GET')).status, 404);
});

test('和假 Notion 连起来：分页的搜索、建页面、读内容都经过代理走通', async t => {
  const fake = createFakeNotion({clientId: 'cid', clientSecret: SECRET, redirectUri: exchangeBody.redirectUri});
  await fake.listen(0);
  t.after(() => fake.close());
  const proxy = await proxyFor(t, {upstream: `http://127.0.0.1:${fake.port()}`});
  const pages = Array.from({length: 130}, (_, i) => notionPage({title: `页面 ${i}`, edited: new Date(Date.UTC(2026, 10, 1) + i * 60000).toISOString()}));
  const {token} = fake.grant('c1', {pages});
  const exchange = await proxy.call('/exchange', {...exchangeBody, code: 'c1'});
  assert.equal(exchange.status, 200);
  assert.equal(JSON.parse(exchange.text).access_token, token);
  const first = JSON.parse((await proxy.call('/api', {method: 'POST', path: 'search', token, body: {page_size: 100}})).text);
  assert.equal(first.results.length, 100);
  assert.equal(first.has_more, true);
  const second = JSON.parse((await proxy.call('/api', {method: 'POST', path: 'search', token, body: {page_size: 100, start_cursor: first.next_cursor}})).text);
  assert.equal(second.results.length, 30);
  const wrong = await proxy.call('/api', {method: 'POST', path: 'search', token: 'ntn_not_a_token', body: {}});
  assert.equal(wrong.status, 401);
});

test('当脚本直接运行：监听指定端口，从符号链接路径启动也能起来；上游设成不安全的地址就拒绝启动', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'notion-proxy-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const link = join(dir, 'proxy-link.mjs');
  symlinkSync(SCRIPT, link);
  const probe = http.createServer();
  const free = await listen(probe);
  await close(probe);
  const run = (script, env) => {
    const child = spawn(process.execPath, [script], {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    return {child, output: () => output, exited: new Promise(resolve => child.once('exit', code => resolve(code)))};
  };
  const ok = run(link, {NOTION_OAUTH_PROXY_PORT: String(free), NOTION_UPSTREAM_BASE: 'http://127.0.0.1:9', NOTION_PROXY_TIMEOUT_MS: '500'});
  t.after(() => ok.child.kill());
  let health = null;
  for (let i = 0; i < 50 && !health; i++) {
    try { health = await new Promise((resolve, reject) => http.get({host: '127.0.0.1', port: free, path: '/health'}, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).once('error', reject)); }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.equal(health, 200, ok.output());
  assert.match(ok.output(), new RegExp(`listening on 127.0.0.1:${free}`));
  const bad = run(SCRIPT, {NOTION_OAUTH_PROXY_PORT: String(free + 1), NOTION_UPSTREAM_BASE: 'http://evil.example'});
  assert.notEqual(await bad.exited, 0);
  assert.match(bad.output(), /只能是 https/);
});
