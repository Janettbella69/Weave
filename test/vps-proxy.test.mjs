// Weave behind a reverse proxy (nginx → wrangler dev on 4317): ported from the production
// checkout's local patches so the repository matches what actually runs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {NotionClient, exchangeNotionOAuth, notionOAuthConfig} from '../hosted/lib/weave/notion.mjs';

const secret = 'ab'.repeat(32), identity = {userId: 'Alice', displayName: 'Alice', email: 'alice@example.test'};
const behindProxy = (path, headers = {}, body = '{}') => new Request('http://127.0.0.1:4317/api/' + path, {
  method: 'POST', body,
  headers: {'Content-Type': 'application/json', host: 'weave.azorashopping.site', 'x-forwarded-proto': 'https', ...headers},
});

test('nginx 后面的 POST：Origin 的 host 等于 Host 头就放行', async () => {
  const db = new D1();
  const r = await handleAPI(behindProxy('notifications/read', {origin: 'https://weave.azorashopping.site'}), {db, identity, secret});
  assert.equal(r.status, 200, JSON.stringify(await r.json()));
});

test('Origin 和 Host 不一致、缺 Origin、Origin 不是网址，都是 403', async () => {
  const db = new D1();
  for (const headers of [{origin: 'https://evil.example'}, {}, {origin: 'null'}]) {
    const r = await handleAPI(behindProxy('notifications/read', headers), {db, identity, secret});
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
});

test('没有 Host 头时按请求地址比较（和原来的行为一样）', async () => {
  const db = new D1();
  const same = new Request('https://weave.test/api/notifications/read', {method: 'POST', body: '{}', headers: {'Content-Type': 'application/json', Origin: 'https://weave.test'}});
  assert.equal((await handleAPI(same, {db, identity, secret})).status, 200);
});

test('Notion 回调在代理后面跳回 https 的同一个域名，并带上出错原因', async () => {
  const request = new Request('http://127.0.0.1:4317/api/connections/notion/callback?code=x&state=y', {headers: {host: 'weave.azorashopping.site', 'x-forwarded-proto': 'https'}});
  const r = await handleAPI(request, {db: new D1(), identity: null, secret, notionOAuth: {}});
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://weave.azorashopping.site/?connection=notion&status=error&detail=missing_config');
});

test('Notion：不设代理时直连 api.notion.com，设了 NOTION_API_PROXY_URL 就交给本地代理', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({url, options}); return Response.json({ok: true}); };
  await new NotionClient({token: 'secret_t', pageId: 'p', fetcher}).request('pages/abc');
  assert.equal(calls[0].url, 'https://api.notion.com/v1/pages/abc');
  assert.equal(calls[0].options.headers['Notion-Version'], '2022-06-28');
  await new NotionClient({token: 'secret_t', pageId: 'p', fetcher, apiProxy: 'http://127.0.0.1:4319/api'}).request('pages/abc', 'PATCH', {a: 1});
  assert.equal(calls[1].url, 'http://127.0.0.1:4319/api');
  assert.deepEqual(JSON.parse(calls[1].options.body), {method: 'PATCH', path: 'pages/abc', token: 'secret_t', body: {a: 1}, notionVersion: '2022-06-28'});
  const config = notionOAuthConfig({NOTION_API_PROXY_URL: 'http://127.0.0.1:4319/api', NOTION_OAUTH_EXCHANGE_URL: 'http://127.0.0.1:4319/exchange'});
  assert.equal(config.apiProxyUrl, 'http://127.0.0.1:4319/api');
  assert.equal(config.exchangeUrl, 'http://127.0.0.1:4319/exchange');
});

test('Notion 换 token：设了 exchangeUrl 交给本地代理，没设就直连', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({url, options}); return Response.json({access_token: 'tok'}); };
  const base = {clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://weave.azorashopping.site/api/connections/notion/callback'};
  await exchangeNotionOAuth({...base, exchangeUrl: 'http://127.0.0.1:4319/exchange'}, 'code-1', fetcher);
  assert.equal(calls[0].url, 'http://127.0.0.1:4319/exchange');
  assert.deepEqual(JSON.parse(calls[0].options.body), {clientId: 'cid', clientSecret: 'csecret', code: 'code-1', redirectUri: base.redirectUri});
  await exchangeNotionOAuth(base, 'code-2', fetcher);
  assert.equal(calls[1].url, 'https://api.notion.com/v1/oauth/token');
});
