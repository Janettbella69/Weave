#!/usr/bin/env node
// Weave ↔ Notion 连接的端到端演练。真的网站 + 真的 notion-oauth-proxy.mjs，上游是本机的假 Notion。
// 用法见同目录 README.md。不连任何真实服务，不需要真实钥匙。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFakeNotion, notionPage } from './fake-notion.mjs';
import { BASIC, PUBLIC_HOST, PUBLIC_ORIGIN, assertPortFree, cleanup, http, openDatabase, ownerPersonId, preflight, restartSite, startStack } from './stack.mjs';
import { seal } from '../../hosted/lib/weave/crypto.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
if (flag('--help')) {
  console.log(`用法：node scripts/notion-oauth-e2e/run.mjs [选项]
  --keep            跑完保留临时目录（日志、数据库）
  --serve           不跑场景，只把假 Notion、代理和网站起好留着手动试（Ctrl-C 结束），并打印怎么走一遍
  --only <正则>     只跑名字匹配的场景
  --report <文件>   把观察到的每个请求和回应写成 Markdown
端口环境变量：E2E_SITE_PORT（4502）、E2E_NOTION_PORT（4512）、E2E_PROXY_PORT（4513）`);
  process.exit(0);
}
const ports = { site: Number(process.env.E2E_SITE_PORT || 4502), notion: Number(process.env.E2E_NOTION_PORT || 4512), proxy: Number(process.env.E2E_PROXY_PORT || 4513) };

const CLIENT = { id: 'e2e-client-id', secret: 'e2e-client-secret-DO-NOT-LEAK' };
const REDIRECT_URI = PUBLIC_ORIGIN + '/api/connections/notion/callback';
const state32 = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');

// ---- 记录和断言 ----
const observations = [];
const checks = [];
const seen = []; // 浏览器收到的每个回应，最后扫一遍有没有漏密钥
let currentScenario = '';
function check(name, ok, detail) {
  checks.push({ scenario: currentScenario, name, ok: !!ok, detail });
  const shown = ok || detail === undefined ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${shown}`);
}
function observe(label, res) {
  seen.push(res.text, JSON.stringify(res.headers));
  const body = res.status === 303 ? 'Location: ' + res.headers.location : res.json !== undefined ? JSON.stringify(res.json) : JSON.stringify(res.text.slice(0, 120));
  observations.push({ scenario: currentScenario, label, status: res.status, body });
  console.log(`    ... ${label} -> ${res.status} ${body.length > 200 ? body.slice(0, 200) + '…' : body}`);
  return res;
}

// ---- 浏览器替身：和 nginx 转发过来的请求一模一样（Host、X-Forwarded-Proto），并带上访问密码 ----
const nginx = (extra = {}) => ({ host: PUBLIC_HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7', ...extra });
let site;
// 网站对每个账号每分钟最多接受 40 次 POST。演练一分钟内会发更多，所以每次 POST 前把计数清零（这不是被测的东西）。
const resetRate = () => { const person = db.get(ownerPersonId()); if (person?.rate) { person.rate = { minute: 0, count: 0 }; db.set(ownerPersonId(), 'people', person); } };
const api = (method, path, body, headers = {}) => (method === 'POST' && resetRate(), http(ports.site, { method, path: '/api/' + path, headers: { ...nginx(), ...(method === 'POST' ? { origin: PUBLIC_ORIGIN } : {}), ...headers }, body: method === 'POST' ? (body ?? {}) : undefined }));
const get = (path, label) => api('GET', path).then(res => observe('GET /api/' + path, res));
const post = (path, body) => api('POST', path, body).then(res => observe('POST /api/' + path, res));
const callbackPath = query => '/api/connections/notion/callback?' + new URLSearchParams(query).toString();
const callback = (query, headers = {}, label) => http(ports.site, { path: callbackPath(query), headers: { ...nginx(), ...headers } }).then(res => observe(label || 'GET callback ' + JSON.stringify(query).slice(0, 60), res));
// 浏览器跟随 303：照 Location 里的主机和路径再请求一次网站。
const follow = async res => {
  const target = new URL(res.headers.location);
  return observe('follow ' + target.pathname + target.search, await http(ports.site, { path: target.pathname + target.search, headers: nginx({ host: target.host, 'x-forwarded-proto': target.protocol.replace(':', '') }) }));
};
const landing = res => { const url = new URL(res.headers.location, 'https://x.invalid'); return { origin: res.headers.location?.startsWith('http') ? new URL(res.headers.location).origin : '', status: url.searchParams.get('status'), detail: url.searchParams.get('detail'), connection: url.searchParams.get('connection'), path: url.pathname }; };

let fake, stack, db;
let codeCounter = 0;
const nextCode = () => `code-${++codeCounter}-${state32().slice(0, 8)}`;
const page = (title, options) => notionPage({ title, ...options });

// 走完「点连接 → 到 Notion 同意 → 跳回」。pages 是用户在 Notion 里勾选的页面。
async function authorize({ pages, grantOptions = {}, query = {}, headers }) {
  const code = nextCode();
  const { token } = fake.grant(code, { pages, ...grantOptions });
  const started = await post('connections/notion/start');
  const state = new URL(started.json.url).searchParams.get('state');
  const returned = await callback({ code, state, ...query }, headers, 'GET callback (用户同意后 Notion 跳回来)');
  return { code, token, state, returned, started };
}

const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });

// =====================================================================
scenario('访问密码：没带密码的页面和回调都是 401', async () => {
  const bare = await http(ports.site, { path: '/', auth: false });
  check('首页没带密码是 401', bare.status === 401, bare.status);
  const cb = observe('GET callback 没带密码', await http(ports.site, { path: callbackPath({ code: 'x', state: state32() }), headers: nginx(), auth: false }));
  check('回调没带密码也是 401（浏览器要靠缓存的密码自动带上）', cb.status === 401, cb.status);
  const wrong = await http(ports.site, { path: '/', headers: { authorization: 'Basic ' + Buffer.from('weave:wrong').toString('base64') } });
  check('密码错是 401', wrong.status === 401);
});

scenario('开始连接：授权地址带对 client_id、redirect_uri、owner=user、state', async () => {
  await get('status');
  const noOrigin = observe('POST start 没带 Origin', await http(ports.site, { method: 'POST', path: '/api/connections/notion/start', headers: nginx(), body: {} }));
  check('跨站 POST 被拒（403）', noOrigin.status === 403, noOrigin.status);
  const started = await post('connections/notion/start');
  check('start 返回 200 和 url', started.status === 200 && typeof started.json?.url === 'string', started.json);
  const url = new URL(started.json.url);
  check('授权页是 Notion 官方地址', url.origin + url.pathname === 'https://api.notion.com/v1/oauth/authorize', url.origin + url.pathname);
  check('client_id 对', url.searchParams.get('client_id') === CLIENT.id);
  check('redirect_uri 是公开域名上的回调', url.searchParams.get('redirect_uri') === REDIRECT_URI, url.searchParams.get('redirect_uri'));
  check('response_type=code', url.searchParams.get('response_type') === 'code');
  check('owner=user', url.searchParams.get('owner') === 'user');
  check('state 是 48 位十六进制', /^[a-f0-9]{48}$/.test(url.searchParams.get('state') || ''));
  check('授权地址里没有 client secret', !started.json.url.includes(CLIENT.secret));
  const ended = await get('connections/notion/start');
  check('GET start 不是路由（404）', ended.status === 404, ended.status);
});

scenario('一键连接，只分享了一个页面：同意之后直接连好', async () => {
  const pages = [page('我的长期记忆')];
  const { token, returned } = await authorize({ pages });
  check('回调是 303', returned.status === 303, returned.status);
  const where = landing(returned);
  check('跳回公开域名（https + 域名），不是 127.0.0.1', where.origin === PUBLIC_ORIGIN, returned.headers.location);
  check('status=connected', where.status === 'connected' && where.connection === 'notion' && !where.detail, where);
  const home = await follow(returned);
  check('跟随跳转后首页是 200 HTML，不是空白', home.status === 200 && /<html/i.test(home.text) && home.text.length > 500, { status: home.status, length: home.text.length });
  const state = await get('connections/notion');
  check('GET connections/notion：connected，带页面名', state.json?.state === 'connected' && state.json?.page?.title === '我的长期记忆', state.json);
  const pending = await get('connections/notion/pending');
  check('旧接口 pending：已经没有待选的东西', pending.json?.ready === false && Array.isArray(pending.json?.pages) && pending.json.pages.length === 0, pending.json);
  const status = await get('status');
  check('GET /api/status：settings.notion 为 true', status.json?.settings?.notion === true);
  check('GET /api/status：settings.notionConfigured 为 true（网站配好了 Notion 授权）', status.json?.settings?.notionConfigured === true, status.json?.settings);
  check('status 里没有 token', !JSON.stringify(status.json).includes(token));
  check('库里没有明文 token 和 client secret', !db.raw().includes(token) && !db.raw().includes(CLIENT.secret));

  // 计划同步：网站 → 本地代理 → 假 Notion
  const planId = 'plan-e2e-' + Date.now();
  const person = db.get(ownerPersonId());
  person.plans.push({ id: planId, createdAt: new Date().toISOString(), context: { text: '昨晚睡了 5 小时' }, summary: '今天轻松一点', conflict: '精力与强度冲突，降低强度', actions: ['散步 10 分钟', '正常吃饭', '早点放松'], agents: [], mode: 'demo', approved: false });
  db.set(ownerPersonId(), 'people', person);
  const approved = await post('plans/approve', { id: planId });
  check('确认计划 200', approved.status === 200, approved.json);
  const synced = await post('plans/sync', { id: planId });
  check('同步计划 200 并返回 Notion 页面地址', synced.status === 200 && /^https:\/\/www\.notion\.so\//.test(synced.json?.url || ''), synced.json);
  const written = fake.written.at(-1);
  check('假 Notion 收到了新页面', !!written, fake.written.length);
  check('写在用户那个页面的下面', written?.parentId === pages[0].id, written?.parentId);
  check('用的是这个用户的 token', written?.token === token);
  check('页面内容里有计划文字', JSON.stringify(written?.children || []).includes('精力与强度冲突，降低强度'));
  check('Notion-Version 头是 2022-06-28', written?.version === '2022-06-28');
  const again = await post('plans/sync', { id: planId });
  check('再同步一次不会重复写', again.status === 200 && fake.written.filter(w => w.title.startsWith('Weave ·')).length === 1, fake.written.length);
  const memory = await get('memory');
  check('GET /api/memory 能读到页面文字', memory.status === 200 && memory.json?.text?.includes('我的长期目标'), memory.json);
  const off = await post('connections/notion/disconnect');
  check('断开 200', off.status === 200, off.json);
  const after = await get('connections/notion');
  check('断开后 state=disconnected', after.json?.state === 'disconnected', after.json);
  check('断开后 status.settings.notion 为 false', (await get('status')).json?.settings?.notion === false);
});

scenario('一键连接，分享了好几个页面：自动选默认页，之后可以改', async () => {
  const hour = n => new Date(Date.now() - n * 3600_000).toISOString();
  const weavePage = page('Weave', { edited: hour(48) });
  const journal = page('日记', { edited: hour(1) });
  const child = page('日记里的子页面', { parent: journal.id, edited: hour(0.5) });
  const row = page('数据库里的一行', { parent: { database: 'db-1' }, edited: hour(0.2) });
  let run = await authorize({ pages: [journal, child, row, weavePage] });
  check('连接成功', landing(run.returned).status === 'connected', landing(run.returned));
  let state = await get('connections/notion');
  check('默认页：标题里有 weave 的顶层页面优先（即使不是最近编辑的）', state.json?.page?.title === 'Weave', state.json);
  const pagesList = await get('connections/notion/pages');
  check('pages：200，带 selectedId 和 topLevel 标记', pagesList.status === 200 && pagesList.json?.selectedId === weavePage.id && pagesList.json?.pages?.length === 4, pagesList.json);
  const top = (pagesList.json?.pages || []).filter(p => p.topLevel).map(p => p.title).sort();
  check('顶层页面是用户勾选的两个（子页面和数据库行不算）', JSON.stringify(top) === JSON.stringify(['Weave', '日记'].sort()) || JSON.stringify(top) === JSON.stringify(['Weave', '数据库里的一行', '日记'].sort()), top);
  const selected = await post('connections/notion/select', { pageId: journal.id });
  check('select 改成「日记」：200，state=connected', selected.status === 200 && selected.json?.state === 'connected' && selected.json?.page?.title === '日记', selected.json);
  const stranger = await post('connections/notion/select', { pageId: '00000000-0000-4000-8000-000000000000' });
  check('select 没有分享的页面：404', stranger.status === 404, stranger.json);
  const bad = await post('connections/notion/select', { pageId: 'abc' });
  check('select 格式不对：400', bad.status === 400, bad.json);
  await post('connections/notion/disconnect');

  // 没有 Weave 标题：选最近编辑的顶层页面
  const a = page('读书笔记', { edited: hour(30) }), b = page('菜谱', { edited: hour(3) });
  run = await authorize({ pages: [a, b] });
  state = await get('connections/notion');
  check('没有 Weave 页面时选最近编辑的顶层页面', state.json?.page?.title === '菜谱', state.json);
  await post('connections/notion/disconnect');
});

scenario('授权了，但没有勾选任何页面：给出明确的状态，不留空白', async () => {
  const { token, returned } = await authorize({ pages: [] });
  const where = landing(returned);
  check('303 回到公开域名', returned.status === 303 && where.origin === PUBLIC_ORIGIN, returned.headers.location);
  check('status=error&detail=no_pages', where.status === 'error' && where.detail === 'no_pages', where);
  check('库里的待办没有明文 token', !db.raw().includes(token));
  const state = await get('connections/notion');
  check('GET connections/notion：needs_pages / no_pages', state.json?.state === 'needs_pages' && state.json?.reason === 'no_pages', state.json);
  const legacy = await get('connections/notion/pending');
  check('旧接口 pending：没有页面可选，不是 ready', legacy.json?.ready === false && legacy.json?.pages?.length === 0, legacy.json);
  check('status.settings.notion 仍为 false', (await get('status')).json?.settings?.notion === false);
  const again = await post('connections/notion/finish');
  check('什么都没分享时 finish 还是 needs_pages', again.status === 200 && again.json?.state === 'needs_pages', again.json);
  fake.setPages(token, [page('补选的页面')]);
  const finished = await post('connections/notion/finish');
  check('在 Notion 里补选页面后 finish：connected', finished.json?.state === 'connected' && finished.json?.page?.title === '补选的页面', finished.json);
  const nothing = await post('connections/notion/finish');
  check('已经连好后再 finish：还是 connected，不报错', nothing.status === 200 && nothing.json?.state === 'connected', nothing.json);
  await post('connections/notion/disconnect');
});

scenario('搜索页面这一步出错：不假装成功，可以重试', async () => {
  const pages = [page('可重试的页面')];
  const { token, returned } = await authorize({ pages, grantOptions: { search: 'server_error' } });
  const where = landing(returned);
  check('detail=search_failed', where.status === 'error' && where.detail === 'search_failed', where);
  const state = await get('connections/notion');
  check('needs_pages / search_failed', state.json?.state === 'needs_pages' && state.json?.reason === 'search_failed', state.json);
  const stillBroken = await post('connections/notion/finish');
  check('Notion 还没好：finish 仍是 needs_pages / search_failed', stillBroken.json?.state === 'needs_pages' && stillBroken.json?.reason === 'search_failed', stillBroken.json);
  const grant = fake.grantOf(token);
  grant.search = 'ok';
  const fixed = await post('connections/notion/finish');
  check('Notion 恢复后 finish：connected', fixed.json?.state === 'connected', fixed.json);
  await post('connections/notion/disconnect');
});

scenario('Notion 的搜索索引有延迟：第一次搜不到，回调里自己再试一次', async () => {
  const { returned } = await authorize({ pages: [page('刚分享的页面')], grantOptions: { emptySearches: 1 } });
  check('仍然一步连好', landing(returned).status === 'connected', landing(returned));
  await post('connections/notion/disconnect');
});

scenario('用户在 Notion 里点了取消，或 Notion 带着 error 跳回来', async () => {
  const started = await post('connections/notion/start');
  const state = new URL(started.json.url).searchParams.get('state');
  const denied = await callback({ error: 'access_denied', state }, {}, 'GET callback ?error=access_denied');
  const where = landing(denied);
  check('detail=access_denied', denied.status === 303 && where.status === 'error' && where.detail === 'access_denied', where);
  const other = await callback({ error: 'server_error', state }, {}, 'GET callback ?error=server_error');
  check('其他 error：detail=notion_error', landing(other).detail === 'notion_error', landing(other));
  check('没有连上', (await get('connections/notion')).json?.state === 'disconnected');
});

scenario('回调参数不对：缺 code、state 格式不对、state 不认识、state 过期、重复打开', async () => {
  const noCode = landing(await callback({ state: state32() }, {}, 'GET callback 缺 code'));
  check('缺 code：bad_code_state', noCode.detail === 'bad_code_state', noCode);
  const noState = landing(await callback({ code: 'x' }, {}, 'GET callback 缺 state'));
  check('缺 state：bad_code_state', noState.detail === 'bad_code_state', noState);
  const shortState = landing(await callback({ code: 'x', state: 'abc' }, {}, 'GET callback state 太短'));
  check('state 格式不对：bad_code_state', shortState.detail === 'bad_code_state', shortState);
  const unknown = landing(await callback({ code: 'x', state: state32() }, {}, 'GET callback state 不认识'));
  check('state 格式对但不认识：missing_state', unknown.detail === 'missing_state', unknown);
  const post405 = observe('POST callback', await http(ports.site, { method: 'POST', path: callbackPath({ code: 'x', state: state32() }), headers: { ...nginx(), origin: PUBLIC_ORIGIN }, body: {} }));
  check('POST 回调：303 回到 error（不会空白）', post405.status === 303 && landing(post405).status === 'error', post405.status);

  // 过期：把库里的 state 记录改成已过期
  const started = await post('connections/notion/start');
  const state = new URL(started.json.url).searchParams.get('state');
  const key = 'notion-oauth:' + createHash('sha256').update(state).digest('hex');
  const record = db.runtime()[key];
  check('库里有这次的 state 记录', !!record && record.expiresAt > Date.now());
  db.set(key, 'runtime', { ...record, expiresAt: Date.now() - 1000 });
  const code = nextCode();
  fake.grant(code, { pages: [page('过期用的页面')] });
  const expired = landing(await callback({ code, state }, {}, 'GET callback state 过期'));
  check('state 过期（10 分钟）：missing_state', expired.detail === 'missing_state', expired);

  // 同一个回调地址打开两次
  const first = await authorize({ pages: [page('只能用一次')] });
  check('第一次连好', landing(first.returned).status === 'connected');
  const second = landing(await callback({ code: first.code, state: first.state }, {}, 'GET callback 同一个地址再打开一次'));
  check('第二次：error / missing_state（状态已用掉）', second.status === 'error' && second.detail === 'missing_state', second);
  const state2 = await get('connections/notion');
  check('但 GET connections/notion 说已连接——前端看到 error 时应先问它', state2.json?.state === 'connected', state2.json);
  await post('connections/notion/disconnect');
});

scenario('用授权码换 token 失败：Notion 拒绝、出错、返回乱码、没有 token、不回话', async () => {
  const bogus = landing(await (async () => {
    const started = await post('connections/notion/start');
    const state = new URL(started.json.url).searchParams.get('state');
    return callback({ code: 'never-granted', state }, {}, 'GET callback 授权码 Notion 不认识');
  })());
  check('Notion 回 400 invalid_grant：exchange_failed', bogus.status === 'error' && bogus.detail === 'exchange_failed', bogus);
  for (const [mode, label] of [['server_error', 'Notion 回 500'], ['garbage', 'Notion 回的不是 JSON'], ['no_token', '回应里没有 access_token']]) {
    const { returned } = await authorize({ pages: [page('x')], grantOptions: { exchange: mode } });
    const where = landing(returned);
    check(`${label}：exchange_failed`, where.status === 'error' && where.detail === 'exchange_failed', where);
  }
  const started = Date.now();
  const { returned } = await authorize({ pages: [page('x')], grantOptions: { exchange: 'hang' } });
  const took = Date.now() - started;
  check('Notion 不回话：代理超时之后 exchange_failed（不是一直转圈）', landing(returned).detail === 'exchange_failed' && took < 15000, { detail: landing(returned).detail, ms: took });
  check('失败后没有连上', (await get('connections/notion')).json?.state === 'disconnected');
});

scenario('跳回的地址：配了公开地址就一律回到它（不依赖 nginx 带对 Host 和 X-Forwarded-Proto）', async () => {
  const run = async (headers, label) => {
    const { returned } = await authorize({ pages: [page('地址测试')], headers });
    await post('connections/notion/disconnect');
    return observe(label, returned).headers.location;
  };
  check('经 nginx（https + 公开域名）：回到公开地址', (await run(nginx(), '回调 经 nginx')).startsWith(PUBLIC_ORIGIN + '/?'));
  const noProto = await run({ host: PUBLIC_HOST, 'x-forwarded-proto': undefined }, '回调 nginx 漏了 X-Forwarded-Proto');
  check('nginx 漏了 X-Forwarded-Proto：仍然回到 https 公开地址', noProto.startsWith(PUBLIC_ORIGIN + '/?'), noProto);
  const direct = await run({ host: `127.0.0.1:${ports.site}`, 'x-forwarded-proto': undefined }, '回调 直连本机');
  check('直连本机：也回到公开地址（回调本来就是按公开地址注册的）', direct.startsWith(PUBLIC_ORIGIN + '/?'), direct);
});

scenario('旧接口还照旧：pending / complete', async () => {
  const none = await get('connections/notion/pending');
  check('没有待选时 pending：{ready:false,pages:[]}', none.status === 200 && none.json?.ready === false && none.json?.pages?.length === 0, none.json);
  const chosen = page('旧流程里选的页面');
  const person = ownerPersonId();
  const sealed = await seal('ntn_legacy_pending_token', stack.secret, person);
  const now = Date.now();
  db.set('notion-pending:' + state32(), 'runtime', { ownerId: person, token: sealed, pages: [{ id: chosen.id, title: chosen.properties.title.title[0].plain_text, url: chosen.url }], expiresAt: now + 600_000 });
  const ready = await get('connections/notion/pending');
  check('有待选时 pending：{ready:true,pages:[{id,title,url}]}', ready.json?.ready === true && ready.json?.pages?.[0]?.id === chosen.id && Object.keys(ready.json.pages[0]).sort().join() === 'id,title,url', ready.json);
  const badId = await post('connections/notion/complete', { pageId: 'abc' });
  check('complete 格式不对：400「请选择一个 Notion 页面」', badId.status === 400 && /请选择一个 Notion 页面/.test(badId.json?.error), badId.json);
  const notInList = await post('connections/notion/complete', { pageId: '0123456789abcdef0123456789abcdef' });
  check('complete 不在待选里：428「已过期，请重新连接」', notInList.status === 428 && /已过期/.test(notInList.json?.error), notInList.json);
  const done = await post('connections/notion/complete', { pageId: chosen.id });
  check('complete 选中的页面：200 {ok:true}', done.status === 200 && done.json?.ok === true, done.json);
  check('之后 status.settings.notion 为 true', (await get('status')).json?.settings?.notion === true);
  await post('connections/notion/disconnect');
  // 过期的待选
  db.set('notion-pending:' + state32(), 'runtime', { ownerId: person, token: sealed, pages: [{ id: chosen.id, title: 'x', url: '' }], expiresAt: now - 1000 });
  const expired = await get('connections/notion/pending');
  check('过期的待选：pending 回 ready:false，并且删掉记录', expired.json?.ready === false && !Object.keys(db.runtime()).some(k => k.startsWith('notion-pending:') && db.runtime()[k].expiresAt <= Date.now()), expired.json);
  const stale = await post('connections/notion/complete', { pageId: chosen.id });
  check('过期后 complete：428', stale.status === 428, stale.json);
});

scenario('代理进程挂了：回调马上 exchange_failed，不挂住；重启后恢复', async () => {
  await stack.stopProxy();
  const t0 = Date.now();
  const { returned } = await authorize({ pages: [page('x')] });
  check('代理连不上：exchange_failed', landing(returned).detail === 'exchange_failed', landing(returned));
  check('而且很快（连接被拒，不是等超时）', Date.now() - t0 < 10000, Date.now() - t0);
  await stack.startProxy();
  const { returned: back } = await authorize({ pages: [page('恢复了')] });
  check('代理重启后一键连接恢复', landing(back).status === 'connected', landing(back));
  await post('connections/notion/disconnect');
});

scenario('代理加固：坏请求不回显任何东西，超时有明确状态', async () => {
  const proxy = (path, body, method = 'POST') => http(ports.proxy, { method, path, body, auth: false });
  const badJson = await proxy('/exchange', '{"clientSecret":"LEAK-ME-' + 'x'.repeat(20) + '", oops');
  check('/exchange 收到坏 JSON：400 bad_json，回应里没有请求原文', badJson.status === 400 && badJson.json?.error === 'bad_json' && !badJson.text.includes('LEAK-ME'), badJson.text);
  const missing = await proxy('/exchange', { clientId: 'a' });
  check('/exchange 缺字段：400 missing_fields', missing.status === 400 && missing.json?.error === 'missing_fields', missing.text);
  const noToken = await proxy('/api', { method: 'POST', path: 'search' });
  check('/api 缺 token：400', noToken.status === 400, noToken.text);
  const escape = await proxy('/api', { method: 'GET', path: '../oauth/token', token: 'ntn_x' });
  check('/api 路径想跳出 /v1/：400 bad_path', escape.status === 400 && escape.json?.error === 'bad_path', escape.text);
  const method = await proxy('/api', { method: 'TRACE', path: 'search', token: 'ntn_x' });
  check('/api 不认识的方法：400 bad_method', method.status === 400 && method.json?.error === 'bad_method', method.text);
  const hang = fake.grant(nextCode(), { pages: [page('慢')], search: 'hang' });
  const t0 = Date.now();
  const slow = await proxy('/api', { method: 'POST', path: 'search', token: hang.token, body: {} });
  check('上游不回话：约 1.5 秒后 504 upstream_timeout', slow.status === 504 && slow.json?.error === 'upstream_timeout' && Date.now() - t0 < 8000, { status: slow.status, ms: Date.now() - t0, text: slow.text });
  const exchangeError = await proxy('/exchange', { clientId: CLIENT.id, clientSecret: CLIENT.secret, code: 'not-granted', redirectUri: REDIRECT_URI });
  check('上游拒绝授权码：状态码原样转回，正文里没有 client secret', exchangeError.status === 400 && !exchangeError.text.includes(CLIENT.secret), exchangeError.text);
  const health = await proxy('/health', undefined, 'GET');
  check('/health 照旧回 ok', health.status === 200 && health.text === 'ok');
  const unknown = await proxy('/nope', {});
  check('不认识的地址：404', unknown.status === 404);
});

scenario('没有配置 Notion 的网站：连接不可用，回调回到 error，页面不空白', async () => {
  await restartSite(stack, { NOTION_OAUTH_CLIENT_ID: undefined, NOTION_OAUTH_CLIENT_SECRET: undefined, NOTION_PUBLIC_ORIGIN: undefined });
  const started = await post('connections/notion/start');
  check('start：503「暂不可用」', started.status === 503 && /暂不可用/.test(started.json?.error), started.json);
  const state = await get('connections/notion');
  check('GET connections/notion：unavailable', state.json?.state === 'unavailable', state.json);
  check('GET /api/status：settings.notionConfigured 为 false（前端据此藏起「连接」按钮）', (await get('status')).json?.settings?.notionConfigured === false);
  const cb = landing(await callback({ code: 'x', state: state32() }, {}, 'GET callback 网站没配置'));
  check('回调：error / missing_config', cb.status === 'error' && cb.detail === 'missing_config', cb);
  // 没有公开地址可用时，回到哪里取决于 Host 和 X-Forwarded-Proto
  const via = async headers => (await callback({ code: 'x', state: state32() }, headers, 'GET callback 没配置 ' + JSON.stringify(headers))).headers.location;
  check('没配置、经 nginx：回到 https 公开域名', (await via(nginx())).startsWith(PUBLIC_ORIGIN + '/?'));
  check('没配置、nginx 漏了 X-Forwarded-Proto：落到 http 公开域名（nginx 的 80 端口会 301 回 https）', (await via({ host: PUBLIC_HOST, 'x-forwarded-proto': undefined })).startsWith('http://' + PUBLIC_HOST + '/?'));
  check('没配置、直连本机：http 本机地址', (await via({ host: `127.0.0.1:${ports.site}`, 'x-forwarded-proto': undefined })).startsWith(`http://127.0.0.1:${ports.site}/?`));
  const home = await http(ports.site, { path: '/?connection=notion&status=error&detail=missing_config', headers: nginx() });
  check('落地页 200 HTML', home.status === 200 && home.text.length > 500);
});

// =====================================================================
const SERVE = flag('--serve');
// --serve 时回调要落回本机的网站（不然浏览器会被带到线上域名）。
let origin = PUBLIC_ORIGIN;

async function serve() {
  const pages = n => Array.from({ length: n }, (_, i) => page(i === 0 ? 'Weave 长期记忆' : `我的页面 ${i}`, { edited: new Date(Date.now() - i * 3600_000).toISOString() }));
  fake.grant('demo-one', { pages: [page('我的长期记忆')], reusable: true });
  fake.grant('demo-many', { pages: pages(4), reusable: true });
  fake.grant('demo-none', { pages: [], reusable: true });
  fake.grant('demo-search-fail', { pages: [page('读不出来')], search: 'server_error', reusable: true });
  fake.grant('demo-exchange-fail', { pages: [page('x')], exchange: 'server_error', reusable: true });
  const site = `http://127.0.0.1:${ports.site}`;
  console.log(`服务都起好了：
  网站      ${site}   （浏览器会问密码：${BASIC.user} / ${BASIC.password}）
  假 Notion  http://127.0.0.1:${ports.notion}
  代理      http://127.0.0.1:${ports.proxy}
  日志      ${stack.logs}

走一遍「点连接 → 在 Notion 同意 → 跳回来」。真正的授权页在 Notion 那边，这里用下面两步代替：
  1) 取一个 state（先在浏览器里登录过网站；或者点页面上的「连接」，它会跳到 api.notion.com，把地址里的 state= 后面那串复制下来）：
       curl -s -u ${BASIC.user}:${BASIC.password} -H 'Origin: ${site}' -H 'Content-Type: application/json' -X POST ${site}/api/connections/notion/start -d '{}'
  2) 在登录过网站的浏览器里打开（把 STATE 换成上一步地址里的 state）：
       ${site}/api/connections/notion/callback?code=CODE&state=STATE
     CODE 可以是：
       demo-one          分享了 1 个页面，一步连好
       demo-many         分享了 4 个页面，自动选默认页
       demo-none         一个页面都没分享（no_pages）
       demo-search-fail  搜索页面出错（search_failed）
       demo-exchange-fail 换 token 失败（exchange_failed）
     也可以直接把 ?connection=notion&status=error&detail=access_denied 之类的地址贴进浏览器，看页面怎么显示。

Ctrl-C 结束。`);
  await new Promise(() => {});
}

async function main() {
  preflight();
  if (SERVE) origin = `http://127.0.0.1:${ports.site}`;
  for (const [port, label] of [[ports.site, '网站'], [ports.notion, '假 Notion'], [ports.proxy, '代理']]) await assertPortFree(port, label);
  fake = createFakeNotion({ clientId: CLIENT.id, clientSecret: CLIENT.secret, redirectUri: origin + '/api/connections/notion/callback' });
  await fake.listen(ports.notion);
  console.log(`假 Notion 已在 127.0.0.1:${ports.notion}；启动代理和网站（第一次约半分钟）…`);
  stack = await startStack({
    ports, upstreamPort: ports.notion, proxyTimeoutMs: 1500,
    vars: { NOTION_OAUTH_CLIENT_ID: CLIENT.id, NOTION_OAUTH_CLIENT_SECRET: CLIENT.secret, NOTION_PUBLIC_ORIGIN: origin },
  });
  site = stack.children.site;
  db = openDatabase(stack);
  console.log(`网站已在 127.0.0.1:${ports.site}（单用户模式 + 访问密码 ${BASIC.user}:${BASIC.password}）；日志在 ${stack.logs}\n`);

  if (SERVE) await serve();
  const only = option('--only') ? new RegExp(option('--only')) : null;
  let crashed = null;
  try {
    for (const { name, run } of scenarios) {
      if (only && !only.test(name)) continue;
      currentScenario = name;
      console.log(`\n[${name}]`);
      try { await run(); } catch (error) { check('场景没有中途出错', false, String(error && error.stack || error).split('\n').slice(0, 4).join(' | ')); }
    }
    // 所有回应、两个进程的日志、数据库里都不该出现密钥或 token
    currentScenario = '泄露检查';
    console.log('\n[泄露检查]');
    const secrets = [CLIENT.secret, ...fake.allTokens()];
    const logs = ['site', 'proxy'].map(name => { try { return readFileSync(join(stack.logs, name + '.log'), 'utf8'); } catch { return ''; } });
    const haystacks = { '浏览器收到的所有回应': seen.join('\n'), '网站日志': logs[0], '代理日志': logs[1], '数据库': db.raw() };
    for (const [where, text] of Object.entries(haystacks)) {
      const leaked = secrets.filter(secret => text.includes(secret));
      check(`${where}里没有 client secret 和任何 token`, leaked.length === 0, leaked.map(s => s.slice(0, 12) + '…'));
    }
  } catch (error) {
    crashed = error;
  }

  const failed = checks.filter(c => !c.ok);
  console.log(`\n共 ${checks.length} 项检查，${checks.length - failed.length} 项通过，${failed.length} 项失败。`);
  for (const c of failed) console.log(`  FAIL [${c.scenario}] ${c.name}  ${typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)}`);
  if (option('--report')) writeReport(option('--report'));
  db.close();
  await stack.stop();
  await fake.close();
  cleanup(stack, flag('--keep') || failed.length > 0 || !!crashed);
  if (flag('--keep') || failed.length || crashed) console.log(`临时目录保留在 ${stack.runDir}`);
  if (crashed) throw crashed;
  process.exit(failed.length ? 1 : 0);
}

function writeReport(file) {
  const rows = observations.map(o => `| ${o.scenario} | ${o.label} | ${o.status} | ${'`' + o.body.replaceAll('|', '\\|').slice(0, 300) + '`'} |`);
  const text = `# Notion 连接演练观察记录\n\n| 场景 | 请求 | 状态码 | 回应 |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`;
  import('node:fs').then(fs => fs.writeFileSync(file, text));
}

process.on('SIGINT', async () => { try { await stack?.stop(); await fake?.close(); if (stack) cleanup(stack, flag('--keep')); } catch { /* 退出 */ } process.exit(130); });
main().catch(async error => {
  console.error('\n演练出错：', error.message || error);
  try { await stack?.stop(); await fake?.close(); } catch { /* 退出 */ }
  process.exit(2);
});
