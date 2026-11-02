import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../server.mjs';
import {scopeDirs} from '../workspace.mjs';
import {isMain, steps} from './helpers/fake-model.mjs';
import {startFakeModel} from './helpers/fake-model.mjs';

const TOKEN = 's'.repeat(40);
let fake, weave, service, dataDir;

before(async () => {
  fake = await startFakeModel();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({path: req.url, headers: req.headers, body: JSON.parse(raw)});
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end('{"ok":true,"text":"已记录"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  weave = {url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
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
const fresh = route => { fake.captured.length = 0; weave.seen.length = 0; fake.script(route); };

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

test('这一轮出错（到了 maxTurns）就不接着用这段会话', async () => {
  fresh(b => isMain(b) ? {tool: 'Bash', input: {command: 'echo loop', description: 'x'}} : {text: 't'});
  const failed = await (await post('/wake', wakeBody({id: 'u:erin'}))).json();
  assert.equal(failed.outcome, 'error_max_turns');
  fresh(steps([{text: '重新开始'}]));
  const next = await (await post('/wake', wakeBody({id: 'u:erin'}))).json();
  assert.notEqual(next.sessionId, failed.sessionId);
  assert.equal(next.reply, '重新开始');
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
