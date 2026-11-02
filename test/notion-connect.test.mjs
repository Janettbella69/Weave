// Notion 一键连接：回调、状态、重试、换页面。上游是 scripts/notion-oauth-e2e 里的假 Notion（本机，没有真实钥匙）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {hash, seal} from '../hosted/lib/weave/crypto.mjs';
import {chooseDefaultPage, topLevelPages} from '../hosted/lib/weave/notion-connect.mjs';
import {exchangeNotionOAuth, scrubNotionError} from '../hosted/lib/weave/notion.mjs';
import {createFakeNotion, notionPage} from '../scripts/notion-oauth-e2e/fake-notion.mjs';

const secret = 'ab'.repeat(32), identity = {userId: 'Alice', displayName: 'Alice', email: 'alice@example.test'};
const CLIENT = {clientId: 'cid', clientSecret: 'client-secret-DO-NOT-LEAK', redirectUri: 'https://weave.test/api/connections/notion/callback'};
const NOW = Date.parse('2026-11-02T12:00:00Z');
const hoursAgo = n => new Date(NOW - n * 3600_000).toISOString();

async function setup(t, oauth = {}) {
  const fake = createFakeNotion(CLIENT), db = new D1();
  await fake.listen(0);
  t.after(() => fake.close());
  const base = `http://127.0.0.1:${fake.port()}`;
  // 代码里的 Notion 地址是写死的 https://api.notion.com，这里把它转到本机的假 Notion。
  const fetcher = (url, init) => fetch(String(url).startsWith('https://api.notion.com') ? base + String(url).slice('https://api.notion.com'.length) : url, init);
  const notionOAuth = {...CLIENT, publicOrigin: 'https://weave.test', searchRetryDelayMs: 0, ...oauth};
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  t.after(() => { console.error = original; });
  let clock = NOW;
  async function call(path, data, {who = identity, headers = {}, method} = {}) {
    const verb = method || (data === undefined ? 'GET' : 'POST');
    const request = new Request('https://weave.test/api/' + path, {method: verb, ...(verb === 'POST' ? {headers: {'Content-Type': 'application/json', Origin: 'https://weave.test', ...headers}, body: JSON.stringify(data ?? {})} : {headers})});
    const response = await handleAPI(request, {db, identity: who, secret, fetcher, notionOAuth, now: clock});
    return {status: response.status, location: response.headers.get('location'), data: response.status === 303 ? null : await response.json()};
  }
  const landing = result => { const url = new URL(result.location); return {origin: url.origin, status: url.searchParams.get('status'), detail: url.searchParams.get('detail')}; };
  // 点连接 → Notion 同意 → 浏览器带着 code 回来
  async function authorize(pages, grant = {}, query = {}) {
    const code = 'code-' + Math.random().toString(16).slice(2);
    const {token} = fake.grant(code, {pages, ...grant});
    const started = await call('connections/notion/start', {});
    assert.equal(started.status, 200);
    const state = new URL(started.data.url).searchParams.get('state');
    const returned = await call('connections/notion/callback?' + new URLSearchParams({code, state, ...query}), undefined, {who: null});
    return {code, token, state, returned, result: landing(returned)};
  }
  return {fake, db, call, landing, authorize, logs, notionOAuth, fetcher, setClock: ms => { clock = ms; }, raw: () => JSON.stringify(db.sql.prepare('SELECT * FROM weave_documents').all())};
}

test('默认页面规则：顶层页面里标题带 weave 的优先，没有就选最近编辑的；子页面和数据库行不当成用户的选择', () => {
  const journal = {id: 'j', title: '日记', parentType: 'workspace', parentId: '', editedAt: hoursAgo(1)};
  const child = {id: 'c', title: '日记子页', parentType: 'page_id', parentId: 'j', editedAt: hoursAgo(0.1)};
  const row = {id: 'r', title: '数据库行', parentType: 'database_id', parentId: 'db', editedAt: hoursAgo(0.01)};
  const weave = {id: 'w', title: 'My Weave notes', parentType: 'workspace', parentId: '', editedAt: hoursAgo(50)};
  const cook = {id: 'k', title: '菜谱', parentType: 'workspace', parentId: '', editedAt: hoursAgo(5)};
  assert.deepEqual(topLevelPages([journal, child, row, cook]).map(p => p.id).sort(), ['j', 'k']);
  assert.equal(chooseDefaultPage([journal, child, row, cook, weave]).id, 'w');
  assert.equal(chooseDefaultPage([cook, journal, child, row]).id, 'j');
  assert.equal(chooseDefaultPage([row]).id, 'r');
  // 勾的页面的父页面没分享：它自己就是顶层
  const orphan = {id: 'o', title: '孤儿', parentType: 'page_id', parentId: 'not-shared', editedAt: hoursAgo(2)};
  assert.equal(chooseDefaultPage([orphan, child, journal]).id, 'j');
  assert.equal(chooseDefaultPage([]), null);
});

test('只分享了一个页面：同意之后回调直接连好，不再让用户选；token 加密保存，不进浏览器和日志', async t => {
  const s = await setup(t), page = notionPage({title: '我的长期记忆'});
  const {token, result, returned} = await s.authorize([page]);
  assert.equal(returned.status, 303);
  assert.deepEqual(result, {origin: 'https://weave.test', status: 'connected', detail: null});
  assert.equal(returned.location, 'https://weave.test/?connection=notion&status=connected');
  assert.equal(returned.data, null);
  const state = await s.call('connections/notion');
  assert.deepEqual(state.data, {state: 'connected', page: {title: '我的长期记忆'}, workspace: '测试工作区'});
  assert.equal((await s.call('status')).data.settings.notion, true);
  assert.deepEqual((await s.call('connections/notion/pending')).data, {ready: false, pages: []});
  assert.ok(!s.raw().includes(token) && !s.raw().includes(CLIENT.clientSecret));
  assert.ok(!JSON.stringify((await s.call('status')).data).includes(token));
  assert.ok(!s.logs.join('\n').includes(token));
  // 没有留下用掉的 state，也没有留下待选记录
  assert.deepEqual(Object.keys((await new Store(s.db).load()).runtime), []);
  assert.equal(s.fake.requests.filter(r => r.path === '/v1/oauth/token').length, 1);
});

test('分享了好几个页面：自动选默认页，pages 列出可选的，select 换页面，没分享的页面不能选', async t => {
  const s = await setup(t);
  const weave = notionPage({title: 'Weave', edited: hoursAgo(48)}), journal = notionPage({title: '日记', edited: hoursAgo(1)});
  const child = notionPage({title: '日记子页', parent: journal.id, edited: hoursAgo(0.5)}), row = notionPage({title: '一行', parent: {database: 'db1'}, edited: hoursAgo(0.2)});
  const {result} = await s.authorize([journal, child, row, weave]);
  assert.equal(result.status, 'connected');
  assert.equal((await s.call('connections/notion')).data.page.title, 'Weave');
  const listed = await s.call('connections/notion/pages');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.selectedId, weave.id);
  assert.deepEqual(listed.data.pages.map(p => p.title).sort(), ['Weave', '一行', '日记', '日记子页'].sort());
  assert.deepEqual(listed.data.pages.filter(p => p.topLevel).map(p => p.title).sort(), ['Weave', '日记']);
  assert.deepEqual(listed.data.pages.find(p => p.title === '日记子页'), {id: child.id, title: '日记子页', topLevel: false});
  assert.ok(listed.data.pages.every(p => Object.keys(p).sort().join() === 'id,title,topLevel'));
  const selected = await s.call('connections/notion/select', {pageId: journal.id});
  assert.deepEqual(selected.data, {state: 'connected', page: {title: '日记'}, workspace: '测试工作区'});
  assert.equal((await s.call('connections/notion/pages')).data.selectedId, journal.id);
  assert.equal((await s.call('connections/notion/select', {pageId: '00000000-0000-4000-8000-000000000000'})).status, 404);
  assert.equal((await s.call('connections/notion/select', {pageId: 'abc'})).status, 400);
  assert.equal((await s.call('connections/notion/select', {})).status, 400);
  // 不带横线的页面编号也认
  assert.equal((await s.call('connections/notion/select', {pageId: weave.id.replaceAll('-', '')})).data.page.title, 'Weave');
});

test('再次授权时，之前选的页面还在分享里就保留，不被默认规则覆盖', async t => {
  const s = await setup(t);
  const a = notionPage({title: '读书笔记', edited: hoursAgo(30)}), b = notionPage({title: '菜谱', edited: hoursAgo(3)});
  await s.authorize([a, b]);
  assert.equal((await s.call('connections/notion')).data.page.title, '菜谱');
  await s.call('connections/notion/select', {pageId: a.id});
  await s.authorize([a, b, notionPage({title: '新页面', edited: hoursAgo(0.1)})]);
  assert.equal((await s.call('connections/notion')).data.page.title, '读书笔记');
});

test('授权了但一个页面都没勾：回调回 no_pages，状态 needs_pages，补选之后 finish 就连好', async t => {
  const s = await setup(t);
  const {token, result} = await s.authorize([]);
  assert.deepEqual(result, {origin: 'https://weave.test', status: 'error', detail: 'no_pages'});
  assert.deepEqual((await s.call('connections/notion')).data, {state: 'needs_pages', reason: 'no_pages'});
  assert.equal((await s.call('status')).data.settings.notion, false);
  assert.ok(!s.raw().includes(token), 'the saved authorization is encrypted');
  assert.deepEqual((await s.call('connections/notion/finish', {})).data, {state: 'needs_pages', reason: 'no_pages'});
  s.fake.setPages(token, [notionPage({title: '补选的页面'})]);
  assert.deepEqual((await s.call('connections/notion/finish', {})).data, {state: 'connected', page: {title: '补选的页面'}, workspace: '测试工作区'});
  assert.equal((await s.call('status')).data.settings.notion, true);
  assert.deepEqual((await s.call('connections/notion/pending')).data, {ready: false, pages: []});
  assert.equal((await s.call('connections/notion/finish', {})).data.state, 'connected');
});

test('搜索页面出错：回调回 search_failed，不假装成功；Notion 恢复后 finish 重试', async t => {
  const s = await setup(t);
  const {token, result} = await s.authorize([notionPage({title: '可重试'})], {search: 'server_error'});
  assert.equal(result.detail, 'search_failed');
  assert.deepEqual((await s.call('connections/notion')).data, {state: 'needs_pages', reason: 'search_failed'});
  assert.deepEqual((await s.call('connections/notion/finish', {})).data, {state: 'needs_pages', reason: 'search_failed'});
  s.fake.grantOf(token).search = 'ok';
  assert.equal((await s.call('connections/notion/finish', {})).data.state, 'connected');
});

test('Notion 的搜索索引有延迟：第一次搜不到，回调里自己再试，仍然一步连好', async t => {
  const s = await setup(t);
  const {result, token} = await s.authorize([notionPage({title: '刚分享的'})], {emptySearches: 1});
  assert.equal(result.status, 'connected');
  assert.equal(s.fake.grantOf(token).searches, 2);
  const failing = await setup(t);
  const second = await failing.authorize([notionPage({title: '总是搜不到'})], {emptySearches: 99});
  assert.equal(second.result.detail, 'no_pages');
  assert.equal(failing.fake.grantOf(second.token).searches, 3, '1 次 + 2 次重试');
});

test('用户在 Notion 点了取消，或 Notion 带着 error 跳回：回到网站并说明原因，不会空白', async t => {
  const s = await setup(t);
  const started = await s.call('connections/notion/start', {});
  const state = new URL(started.data.url).searchParams.get('state');
  const cb = query => s.call('connections/notion/callback?' + new URLSearchParams(query), undefined, {who: null}).then(r => { assert.equal(r.status, 303); return s.landing(r); });
  assert.deepEqual(await cb({error: 'access_denied', state}), {origin: 'https://weave.test', status: 'error', detail: 'access_denied'});
  assert.equal((await cb({error: 'server_error', state})).detail, 'notion_error');
  assert.equal((await cb({state})).detail, 'bad_code_state');
  assert.equal((await cb({code: 'x'})).detail, 'bad_code_state');
  assert.equal((await cb({code: 'x', state: 'short'})).detail, 'bad_code_state');
  assert.equal((await cb({code: 'x', state: 'a'.repeat(48)})).detail, 'missing_state');
  const post = await s.call('connections/notion/callback?code=x&state=' + state, {}, {who: null});
  assert.equal(post.status, 303, 'POST also lands on the site');
  assert.equal(s.landing(post).detail, 'missing_config');
  assert.equal((await s.call('connections/notion')).data.state, 'disconnected');
});

test('state 10 分钟过期；同一个回调地址再打开一次是 missing_state，但连接状态仍是已连接', async t => {
  const s = await setup(t);
  const started = await s.call('connections/notion/start', {});
  const state = new URL(started.data.url).searchParams.get('state');
  s.fake.grant('late', {pages: [notionPage({title: 'x'})]});
  s.setClock(NOW + 11 * 60_000);
  const late = await s.call('connections/notion/callback?code=late&state=' + state, undefined, {who: null});
  assert.equal(s.landing(late).detail, 'missing_state');
  assert.equal(s.fake.requests.filter(r => r.path === '/v1/oauth/token').length, 0, '过期的 state 不会去换授权码');
  s.setClock(NOW);
  const first = await s.authorize([notionPage({title: '只用一次'})]);
  assert.equal(first.result.status, 'connected');
  const again = await s.call('connections/notion/callback?' + new URLSearchParams({code: first.code, state: first.state}), undefined, {who: null});
  assert.deepEqual(s.landing(again), {origin: 'https://weave.test', status: 'error', detail: 'missing_state'});
  assert.equal((await s.call('connections/notion')).data.state, 'connected');
  assert.equal(s.fake.requests.filter(r => r.path === '/v1/oauth/token').length, 1);
});

test('换 token 失败（被拒、500、返回乱码、没有 token）：exchange_failed，日志和跳转里都没有 client secret', async t => {
  const s = await setup(t);
  for (const exchange of ['server_error', 'garbage', 'no_token']) {
    const {result} = await s.authorize([notionPage({title: 'x'})], {exchange});
    assert.deepEqual(result, {origin: 'https://weave.test', status: 'error', detail: 'exchange_failed'}, exchange);
  }
  const started = await s.call('connections/notion/start', {});
  const state = new URL(started.data.url).searchParams.get('state');
  const bogus = await s.call('connections/notion/callback?code=never-granted&state=' + state, undefined, {who: null});
  assert.equal(s.landing(bogus).detail, 'exchange_failed');
  assert.ok(s.logs.some(line => line.startsWith('notion_oauth_exchange_failed')), 'it is logged');
  assert.ok(!s.logs.join('\n').includes(CLIENT.clientSecret));
  assert.ok(!s.logs.join('\n').includes('never-granted'), 'the one-time code is not logged either');
  assert.equal((await s.call('status')).data.settings.notion, false);
});

test('exchangeNotionOAuth 的报错里不带 client secret、授权码和 Basic 凭据', async () => {
  const config = {...CLIENT, exchangeUrl: ''};
  const basic = btoa(`${config.clientId}:${config.clientSecret}`);
  const echo = async () => new Response(JSON.stringify({error: 'invalid_grant', echoed: [config.clientSecret, 'the-code', basic]}), {status: 400});
  await assert.rejects(() => exchangeNotionOAuth(config, 'the-code', echo), error => !/client-secret|the-code/.test(error.message) && !error.message.includes(basic) && error.message.includes('[已隐藏]'));
  const down = async () => { throw Error(`connect failed for ${config.clientSecret}`); };
  await assert.rejects(() => exchangeNotionOAuth(config, 'the-code', down), error => !error.message.includes(config.clientSecret));
  assert.equal(scrubNotionError('abc the-code def', config, 'the-code'), 'abc [已隐藏] def');
});

test('跳回的地址：配了公开地址就用它；没配就看 Host 和 X-Forwarded-Proto', async t => {
  const configured = await setup(t);
  const run = (s, headers) => s.authorize([notionPage({title: 'x'})]).then(() => s);
  const request = (host, proto) => new Request('http://127.0.0.1:4317/api/connections/notion/callback?code=x&state=y', {headers: {...(host ? {host} : {}), ...(proto ? {'x-forwarded-proto': proto} : {})}});
  const handle = (notionOAuth, req) => handleAPI(req, {db: new D1(), identity: null, secret, notionOAuth}).then(r => r.headers.get('location'));
  assert.equal(await handle({}, request('weave.azorashopping.site', 'https')), 'https://weave.azorashopping.site/?connection=notion&status=error&detail=missing_config');
  assert.equal(await handle({}, request('weave.azorashopping.site', 'https,http')), 'https://weave.azorashopping.site/?connection=notion&status=error&detail=missing_config');
  assert.equal(await handle({}, request('weave.azorashopping.site', '')), 'http://weave.azorashopping.site/?connection=notion&status=error&detail=missing_config');
  assert.equal(await handle({}, request('', '')), 'http://127.0.0.1:4317/?connection=notion&status=error&detail=missing_config');
  // 配了 publicOrigin：nginx 漏了 X-Forwarded-Proto 也照样回到 https 公开地址
  assert.equal(await handle({publicOrigin: 'https://weave.azorashopping.site/'}, request('weave.azorashopping.site', '')), 'https://weave.azorashopping.site/?connection=notion&status=error&detail=missing_config');
  assert.equal(await handle({publicOrigin: 'not a url'}, request('weave.azorashopping.site', 'https')), 'https://weave.azorashopping.site/?connection=notion&status=error&detail=missing_config');
  const cached = await configured.call('connections/notion/start', {});
  assert.equal(cached.status, 200);
  assert.equal((await handleAPI(request('weave.azorashopping.site', ''), {db: configured.db, identity: null, secret, notionOAuth: configured.notionOAuth})).headers.get('cache-control'), 'no-store');
});

test('旧接口照旧：pending 返回 {ready, pages:[{id,title,url}]}，complete 选页面；过期后都失效', async t => {
  const s = await setup(t), person = (await s.call('status')).data.personId;
  assert.deepEqual((await s.call('connections/notion/pending')).data, {ready: false, pages: []});
  const chosen = notionPage({title: '旧流程选的页面'});
  const seed = async (expiresAt, key = 'notion-pending:' + 'a'.repeat(64)) => {
    const store = new Store(s.db), world = await store.load();
    world.runtime[key] = {ownerId: person, token: await seal('ntn_legacy_token', secret, person), pages: [{id: chosen.id, title: '旧流程选的页面', url: chosen.url}], expiresAt};
    await store.save(world);
  };
  await seed(NOW + 600_000);
  assert.deepEqual((await s.call('connections/notion/pending')).data, {ready: true, pages: [{id: chosen.id, title: '旧流程选的页面', url: chosen.url}]});
  assert.equal((await s.call('connections/notion')).data.state, 'needs_pages', 'the new state also sees a legacy pending authorization');
  assert.equal((await s.call('connections/notion/complete', {pageId: 'abc'})).status, 400);
  assert.equal((await s.call('connections/notion/complete', {pageId: '0123456789abcdef0123456789abcdef'})).status, 428);
  assert.deepEqual((await s.call('connections/notion/complete', {pageId: chosen.id})).data, {ok: true});
  assert.deepEqual((await s.call('connections/notion')).data, {state: 'connected', page: {title: '旧流程选的页面'}});
  assert.equal((await s.call('status')).data.settings.notion, true);
  await s.call('connections/notion/disconnect', {});
  await seed(NOW - 1000);
  assert.deepEqual((await s.call('connections/notion/pending')).data, {ready: false, pages: []});
  assert.equal((await s.call('connections/notion/complete', {pageId: chosen.id})).status, 428);
});

test('断开连接时，没用完的授权记录一起删掉；开始连接时顺手清掉过期记录', async t => {
  const s = await setup(t);
  const empty = await s.authorize([]);
  assert.equal(empty.result.detail, 'no_pages');
  const keys = async () => Object.keys((await new Store(s.db).load()).runtime);
  assert.equal((await keys()).filter(k => k.startsWith('notion-pending:')).length, 1);
  assert.equal((await s.call('connections/notion/disconnect', {})).status, 200);
  assert.deepEqual(await keys(), []);
  assert.equal((await s.call('connections/notion')).data.state, 'disconnected');
  // 过期的 state 在下一次 start 时被扫掉
  await s.call('connections/notion/start', {});
  await s.call('connections/notion/start', {});
  assert.equal((await keys()).length, 2);
  s.setClock(NOW + 11 * 60_000);
  await s.call('connections/notion/start', {});
  assert.equal((await keys()).length, 1);
  // settings 里断开 Notion 也走同一套清理
  await s.authorize([notionPage({title: 'x'})]);
  await s.call('settings', {disconnectNotion: true});
  assert.equal((await s.call('connections/notion')).data.state, 'disconnected');
});

test('网站没配置 Notion：start 503、状态 unavailable、回调回 missing_config', async t => {
  const s = await setup(t, {clientId: '', clientSecret: '', publicOrigin: '', redirectUri: ''});
  assert.equal((await s.call('connections/notion/start', {})).status, 503);
  assert.deepEqual((await s.call('connections/notion')).data, {state: 'unavailable'});
  assert.equal(s.landing(await s.call('connections/notion/callback?code=x&state=' + 'a'.repeat(48), undefined, {who: null})).detail, 'missing_config');
});

test('Notion 授权失效（用户在 Notion 撤销）：pages 回 428，不是 401，浏览器不会被当成要重新登录', async t => {
  const s = await setup(t), {token} = await s.authorize([notionPage({title: 'x'})]);
  s.fake.revoke(token);
  const pages = await s.call('connections/notion/pages');
  assert.equal(pages.status, 428);
  assert.match(pages.data.error, /授权已失效/);
  const select = await s.call('connections/notion/select', {pageId: '0123456789abcdef0123456789abcdef'});
  assert.equal(select.status, 428);
  const none = await setup(t);
  assert.equal((await none.call('connections/notion/pages')).status, 428);
  assert.equal((await none.call('connections/notion/select', {pageId: '0123456789abcdef0123456789abcdef'})).status, 428);
});

test('每个账号只能看到、改动自己的 Notion 连接', async t => {
  const s = await setup(t), bob = {userId: 'Bob', displayName: 'Bob', email: 'bob@example.test'};
  const page = notionPage({title: 'Alice 的页面'});
  await s.authorize([page]);
  assert.equal((await s.call('connections/notion', undefined, {who: bob})).data.state, 'disconnected');
  assert.equal((await s.call('connections/notion/pages', undefined, {who: bob})).status, 428);
  assert.equal((await s.call('connections/notion/select', {pageId: page.id}, {who: bob})).status, 428);
  assert.equal((await s.call('connections/notion/finish', {}, {who: bob})).data.state, 'disconnected');
});

test('计划同步写到用户的页面下面，用的是这个用户自己的 token', async t => {
  const s = await setup(t), page = notionPage({title: '归档页'});
  const {token} = await s.authorize([page]);
  const store = new Store(s.db), world = await store.load(), person = Object.values(world.people)[0];
  person.plans.push({id: 'p1', createdAt: '2026-11-02T10:00:00Z', context: {text: '睡得少'}, summary: '轻松一点', conflict: '降低强度', actions: ['散步', '吃饭', '早睡'], agents: [], mode: 'demo', approved: true});
  await store.save(world);
  const synced = await s.call('plans/sync', {id: 'p1'});
  assert.equal(synced.status, 200);
  assert.equal(s.fake.written.length, 1);
  assert.equal(s.fake.written[0].parentId, page.id);
  assert.equal(s.fake.written[0].token, token);
  assert.match(JSON.stringify(s.fake.written[0].children), /降低强度/);
  assert.equal((await s.call('plans/sync', {id: 'p1'})).status, 200);
  assert.equal(s.fake.written.length, 1, '同步过的计划不会再写一次');
});
