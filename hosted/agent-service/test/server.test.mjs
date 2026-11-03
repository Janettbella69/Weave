import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../server.mjs';
import {scopeDirs, sessionFor, saveSession} from '../workspace.mjs';
import {isMain, lastToolResults, steps} from './helpers/fake-model.mjs';
import {startFakeModel} from './helpers/fake-model.mjs';

const TOKEN = 's'.repeat(40);
let fake, weave, service, dataDir;

const SNAPSHOT = {
  version: 1, today: '2026-11-02', timezone: 'Asia/Shanghai',
  tables: {habits: [{habit_id: 'walk', name: '走路', identity: '', trigger: '起床后', minimum_action: '穿上鞋', created_at: null, updated_at: null}], completions: []},
  files: {'notion/目标.md': '每天走路'},
};

before(async () => {
  fake = await startFakeModel();
  const seen = [], snapshots = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'GET' && req.url === '/api/internal/agent/snapshot') {
      snapshots.push({headers: req.headers});
      const broken = req.headers.authorization === 'Bearer cap-broken';
      res.writeHead(broken ? 500 : 200, {'Content-Type': 'application/json'});
      return res.end(broken ? '{"error":"快照暂时取不到"}' : JSON.stringify(SNAPSHOT));
    }
    seen.push({path: req.url, headers: req.headers, body: JSON.parse(raw)});
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end('{"ok":true,"text":"已记录"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  weave = {url: `http://127.0.0.1:${server.address().port}`, seen, snapshots, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-service-')));
  service = await createAgentService({
    token: TOKEN, dataDir, isolation: 'local', sandbox: false, weaveUrl: weave.url,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
});
after(async () => { await service.close(); await weave.close(); await fake.close(); });

const wakeBody = (extra = {}) => ({
  scope: 'owner', id: 'u:alice', capability: 'cap-abc', localDate: '2026-11-02',
  trigger: {kind: 'message', channel: 'web', direct: true, at: '2026-11-02T08:00:00+08:00', text: '今天走了 20 分钟'},
  provider: 'deepseek', model: 'deepseek-flash', ...extra,
});
const post = (path, body, token = TOKEN) => fetch(service.url + path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: JSON.stringify(body)});
const modelCalls = () => fake.captured.filter(c => c.path.startsWith('/v1/messages') && isMain(c.body));
const fresh = (route, usage) => { fake.captured.length = 0; weave.seen.length = 0; fake.script(route, usage); };

test('/health 不需要令牌；/wake、/forget 没有令牌或令牌错误时 401', async () => {
  assert.deepEqual(await (await fetch(service.url + '/health')).json(), {ok: true});
  fresh(steps([{text: 'x'}]));
  for (const token of [null, 'wrong'.repeat(10)]) {
    assert.equal((await post('/wake', wakeBody(), token)).status, 401);
    assert.equal((await post('/forget', {scope: 'owner', id: 'u:alice'}, token)).status, 401);
  }
  assert.equal(fake.captured.length, 0);
});

test('未知范围、日期格式不对、trigger 缺字段、模型不在表里都是 400，CLI 没有启动', async () => {
  fresh(steps([{text: 'x'}]));
  const bad = [
    {scope: 'research'}, {scope: '__proto__'}, {id: ''}, {capability: ''}, {localDate: '2026/11/02'},
    {trigger: {kind: 'message', channel: 'web', direct: true, text: 'no at'}},
    {trigger: {kind: 'message', channel: 'sms', direct: true, at: '2026-11-02T08:00:00+08:00', text: 'x'}},
    {provider: 'openai'}, {model: 'claude-opus-4'}, {userKey: 'short'},
    {background: 'true'}, {background: 1}, {background: null}, {background: {}},
  ];
  for (const extra of bad) assert.equal((await post('/wake', wakeBody(extra))).status, 400, JSON.stringify(extra));
  assert.equal(fake.captured.length, 0);
});

test('/wake 跑通：模型调 log_completion，Weave 后端收到带通行证的请求，返回 reply 和 sessionId', async () => {
  fresh(steps([{tool: 'mcp__weave__log_completion', input: {habit_id: 'walk', date: '2026-11-02'}}, {text: '记好了'}]));
  const r = await post('/wake', wakeBody({id: 'u:carol'}));
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.outcome, 'success');
  assert.equal(out.reply, '记好了');
  assert.equal(typeof out.sessionId, 'string');
  assert.deepEqual(out.tools, ['mcp__weave__log_completion']);
  assert.equal(weave.seen.length, 1);
  assert.equal(weave.seen[0].path, '/api/internal/agent/tools/log_completion');
  assert.equal(weave.seen[0].headers.authorization, 'Bearer cap-abc');
  assert.deepEqual(weave.seen[0].body.args, {habit_id: 'walk', date: '2026-11-02'});
  assert.match(weave.seen[0].body.toolUseId, /^toolu_/);
});

test('同一个人同一天第二次 /wake 接上会话；换一天开新会话', async () => {
  fresh(steps([{text: '第一次'}, {text: '第二次'}, {text: '第三次'}]));
  const one = await (await post('/wake', wakeBody({id: 'u:dave'}))).json();
  const two = await (await post('/wake', wakeBody({id: 'u:dave', trigger: {...wakeBody().trigger, text: '我刚才说了什么'}}))).json();
  assert.equal(two.sessionId, one.sessionId);
  assert.ok(JSON.stringify(modelCalls().at(-1).body.messages).includes('今天走了 20 分钟'));
  const next = await (await post('/wake', wakeBody({id: 'u:dave', localDate: '2026-11-03'}))).json();
  assert.notEqual(next.sessionId, one.sessionId);
});

test('这一轮出错（熔断）就不接着用这段会话', async () => {
  // owner 的熔断是 $2；这一轮的用量按 SDK 估价远超它（探针：80 万入 + 10 万出 ≈ $6.5）。
  fresh(b => isMain(b) ? {tool: 'Bash', input: {command: 'echo loop', description: 'x'}} : {text: 't'}, {input: 800000, output: 100000});
  const failed = await (await post('/wake', wakeBody({id: 'u:erin'}))).json();
  assert.equal(failed.outcome, 'error_max_budget_usd');
  fresh(steps([{text: '重新开始'}]));
  const next = await (await post('/wake', wakeBody({id: 'u:erin'}))).json();
  assert.notEqual(next.sessionId, failed.sessionId);
  assert.equal(next.reply, '重新开始');
});

test('叫醒前快照已经在工作目录里：Agent 第一步就能用 Bash 查到 weave.db 里的习惯和 Notion 文件', async () => {
  fresh(steps([
    {tool: 'Bash', input: {command: `python3 -c "import sqlite3;print(sqlite3.connect('weave/weave.db').execute('select name, trigger from habits').fetchall())"; cat weave/notion/目标.md`, description: '查习惯'}},
    {text: '查到了'},
  ]));
  const out = await (await post('/wake', wakeBody({id: 'u:gina'}))).json();
  assert.equal(out.outcome, 'success', JSON.stringify(out));
  const results = modelCalls().flatMap(c => lastToolResults(c.body));
  assert.ok(results.some(x => x.includes("('走路', '起床后')") && x.includes('每天走路')), results.join(' | '));
  assert.equal(weave.snapshots.at(-1).headers.authorization, 'Bearer cap-abc');
});

test('快照接口 500 时 /wake 回 503，CLI 没启动', async () => {
  fresh(steps([{text: '不该出现'}]));
  const r = await post('/wake', wakeBody({id: 'u:hank', capability: 'cap-broken'}));
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /快照/);
  assert.equal(fake.captured.length, 0);
});

test('POST /memory 返回 MEMORY.md 原文；没有令牌 401；group 范围、缺 id 是 400；没醒过的人是空字符串', async () => {
  const dirs = scopeDirs(dataDir, 'owner', 'u:ivy');
  mkdirSync(dirs.workspace, {recursive: true});
  writeFileSync(join(dirs.workspace, 'MEMORY.md'), '# 目标\n每天走 20 分钟\n');
  assert.deepEqual(await (await post('/memory', {scope: 'owner', id: 'u:ivy'})).json(), {text: '# 目标\n每天走 20 分钟\n'});
  assert.equal((await post('/memory', {scope: 'owner', id: 'u:ivy'}, null)).status, 401);
  assert.equal((await post('/memory', {scope: 'group', id: 'g:1'})).status, 400);
  assert.equal((await post('/memory', {scope: 'owner'})).status, 400);
  assert.deepEqual(await (await post('/memory', {scope: 'owner', id: 'u:nobody'})).json(), {text: ''});
});

test('MEMORY.md 里的内容进了这一轮的系统提示', async () => {
  const dirs = scopeDirs(dataDir, 'owner', 'u:frank');
  mkdirSync(dirs.workspace, {recursive: true});
  writeFileSync(join(dirs.workspace, 'MEMORY.md'), '周末早上更容易走路');
  fresh(steps([{text: 'ok'}]));
  await post('/wake', wakeBody({id: 'u:frank'}));
  assert.ok(JSON.stringify(modelCalls()[0].body.system).includes('周末早上更容易走路'));
});

test('用户自己的 Key 经过代理时，上游看到的是用户 Key', async () => {
  fresh(steps([{text: 'ok'}]));
  assert.equal((await post('/wake', wakeBody({id: 'u:gina', userKey: 'user-own-key-123456'}))).status, 200);
  const upstream = fake.captured.filter(c => c.path.startsWith('/v1/messages'));
  assert.ok(upstream.length > 0 && upstream.every(c => c.headers.authorization === 'Bearer user-own-key-123456'));
});

test('没有托管 Key 也没有 userKey 时 503，CLI 没有启动', async () => {
  fresh(steps([{text: 'x'}]));
  const r = await post('/wake', wakeBody({id: 'u:hank', provider: 'glm', model: 'glm-4.7'}));
  assert.equal(r.status, 503);
  assert.equal(fake.captured.length, 0);
});

const check = text => ({kind: 'check', channel: 'system', direct: false, at: '2026-11-02T19:30:00+08:00', text});

test('background：有当天的会话就带 resume + forkSession，成功存分叉出来的 id，失败不碰会话文件；不是后台的照旧', async t => {
  // 假的 query()：记下每一轮的 options，按顺序给出结果（Error 表示 CLI 半路崩了、没有结果消息）。
  const seen = [], results = [];
  const queryFn = async function* ({options}) {
    seen.push(options);
    const next = results.shift();
    if (next instanceof Error) throw next;
    yield next;
  };
  const ok = id => ({type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: id, total_cost_usd: 0});
  const failed = id => ({type: 'result', subtype: 'error_during_execution', is_error: true, session_id: id, total_cost_usd: 0});
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-fork-')));
  const svc = await createAgentService({token: TOKEN, dataDir: dir, isolation: 'local', sandbox: false, weaveUrl: weave.url, keys: {deepseek: 'real-key'}, queryFn});
  t.after(() => svc.close());
  const dirs = scopeDirs(dir, 'owner', 'u:mia'), day = '2026-11-02';
  const wakeMia = async (extra, result) => {
    results.push(result);
    const r = await fetch(svc.url + '/wake', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: JSON.stringify(wakeBody({id: 'u:mia', ...extra}))});
    assert.equal(r.status, 200);
    return {out: await r.json(), options: seen.at(-1), session: await sessionFor(dirs, day)};
  };

  // 当天还没有会话：后台那一轮开一段新的，不分叉；成功了存下来，她回话时接得上。
  let w = await wakeMia({background: true, trigger: check('定期看看')}, ok('bg-1'));
  assert.deepEqual([w.options.resume, 'forkSession' in w.options, w.session, w.out.outcome, w.out.reply], [undefined, false, 'bg-1', 'success', '']);

  // 聊天那一轮照旧：resume，不分叉。
  w = await wakeMia({}, ok('bg-1'));
  assert.deepEqual([w.options.resume, 'forkSession' in w.options, w.session], ['bg-1', false, 'bg-1']);

  // 后台那一轮从当天的会话分叉；成功了，分叉出来的那段成了当天的会话。
  w = await wakeMia({background: true, trigger: check('定期看看')}, ok('fork-1'));
  assert.deepEqual([w.options.resume, w.options.forkSession, w.session, w.out.sessionId], ['bg-1', true, 'fork-1', 'fork-1']);

  // 后台那一轮失败（有结果消息，或者半路崩了）：会话文件不动。
  w = await wakeMia({background: true, trigger: check('看看走路记了没有')}, failed('fork-2'));
  assert.deepEqual([w.options.resume, w.options.forkSession, w.out.outcome, w.session], ['fork-1', true, 'error', 'fork-1']);
  w = await wakeMia({background: true, trigger: check('看看走路记了没有')}, Error('CLI exited'));
  assert.deepEqual([w.options.resume, w.options.forkSession, w.out.outcome, w.session], ['fork-1', true, 'error', 'fork-1']);

  // background: false 就是聊天那一轮：接着分叉出来的那段，失败了照旧清掉（下次重新开一段）。
  w = await wakeMia({background: false}, ok('fork-1'));
  assert.deepEqual([w.options.resume, 'forkSession' in w.options, w.session], ['fork-1', false, 'fork-1']);
  w = await wakeMia({}, failed('fork-1'));
  assert.deepEqual([w.options.resume, 'forkSession' in w.options, w.out.outcome, w.session], ['fork-1', false, 'error', null]);

  // 换了一天：昨天的会话不接，也不从它分叉。
  await saveSession(dirs, day, 'yesterday');
  w = await wakeMia({background: true, localDate: '2026-11-03', trigger: check('定期看看')}, failed('bg-2'));
  assert.deepEqual([w.options.resume, 'forkSession' in w.options], [undefined, false]);
  assert.equal(await sessionFor(dirs, day), 'yesterday', '失败的后台那一轮不碰会话文件');
});

test('后台那一轮（实测）：成功了，下一轮接上分叉出来的会话，两轮都看得到', async () => {
  fresh(steps([{text: '好，18:00 去走路'}, {text: '看过了，先不说'}, {text: '记上了'}]));
  const chat = await (await post('/wake', wakeBody({id: 'u:nora', trigger: {...wakeBody().trigger, text: '我 18:00 去走路'}}))).json();
  const background = await (await post('/wake', wakeBody({id: 'u:nora', background: true, trigger: check('看看走路记了没有')}))).json();
  assert.equal(background.outcome, 'success');
  assert.equal(background.reply, '', '没人找它的那一轮，最后一段话不是回复');
  assert.ok(chat.sessionId && background.sessionId && background.sessionId !== chat.sessionId);
  const next = await (await post('/wake', wakeBody({id: 'u:nora', trigger: {...wakeBody().trigger, text: '走了'}}))).json();
  assert.equal(next.sessionId, background.sessionId);
  const seen = JSON.stringify(modelCalls().at(-1).body.messages);
  assert.ok(seen.includes('我 18:00 去走路') && seen.includes('看看走路记了没有'), seen.slice(0, 400));
});

test('后台那一轮（实测）：失败了（熔断），当天的会话还在，下一轮接着原来的那段', async () => {
  fresh(steps([{text: '好'}]));
  const chat = await (await post('/wake', wakeBody({id: 'u:olga'}))).json();
  assert.equal(chat.outcome, 'success');
  fresh(b => isMain(b) ? {tool: 'Bash', input: {command: 'echo loop', description: 'x'}} : {text: 't'}, {input: 800000, output: 100000});
  const failed = await (await post('/wake', wakeBody({id: 'u:olga', background: true, trigger: check('定期看看')}))).json();
  assert.equal(failed.outcome, 'error_max_budget_usd');
  fresh(steps([{text: 'x'}, {text: '你说今天走了 20 分钟'}]));
  const next = await (await post('/wake', wakeBody({id: 'u:olga', trigger: {...wakeBody().trigger, text: '我刚才说了什么'}}))).json();
  assert.equal(next.sessionId, chat.sessionId);
  assert.equal(next.reply, '你说今天走了 20 分钟');
  const seen = JSON.stringify(modelCalls().at(-1).body.messages);
  assert.ok(seen.includes('今天走了 20 分钟') && !seen.includes('定期看看'), seen.slice(0, 400));
});

test('/forget 删除这个人的目录，别人的不动', async () => {
  fresh(steps([{text: 'ok'}, {text: 'ok'}]));
  await post('/wake', wakeBody({id: 'u:ivy'}));
  await post('/wake', wakeBody({id: 'u:jack'}));
  const ivy = scopeDirs(dataDir, 'owner', 'u:ivy'), jack = scopeDirs(dataDir, 'owner', 'u:jack');
  assert.ok(existsSync(ivy.root) && existsSync(jack.root));
  const r = await post('/forget', {scope: 'owner', id: 'u:ivy'});
  assert.deepEqual(await r.json(), {ok: true});
  assert.ok(!existsSync(ivy.root));
  assert.ok(existsSync(jack.root));
});
