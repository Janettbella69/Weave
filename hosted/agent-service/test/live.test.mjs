// 一直在线的 Weave（docs/ARCHITECTURE.md「一直在线」「本子」「一张嘴」「主动性」）：真 CLI + 假模型 + 假网站，本机隔离，不花钱。
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAgentService} from '../server.mjs';
import {scopeDirs, memoryDir} from '../workspace.mjs';
import {notebookPath} from '../notebook.mjs';
import {reminderAlarmText} from '../prompts.mjs';
import {startFakeModel, isMain} from './helpers/fake-model.mjs';

const TOKEN = 't'.repeat(40);
const clock = {t: Date.parse('2026-11-17T12:00:00+08:00')};
let fake, web, agent, dataDir;
const toolCalls = [], outcomes = [];
let legacyCalls = 0;

const LEGACY = {version: 1, today: '2026-11-17', timezone: 'Asia/Shanghai', files: {}, tables: {
  habits: [{habit_id: 'h1', name: '走路', identity: '', trigger: '晚饭后', minimum_action: '走到楼下', created_at: '2026-11-01T00:00:00Z', updated_at: null, goal_id: null}],
  completions: [{habit_id: 'h1', date: '2026-11-16', note: '', source: 'agent', created_at: '2026-11-16T12:00:00Z'}],
}};

// 假网站：工具后端（send_message）、旧数据（第一次建本子）、没人等的那一轮的结果回报。
async function startFakeWeb() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const auth = req.headers.authorization || '';
    res.writeHead(200, {'Content-Type': 'application/json'});
    if (req.url.startsWith('/api/internal/agent/tools/')) { toolCalls.push({name: req.url.split('/').pop(), auth, ...body}); return res.end(JSON.stringify({ok: true, text: '已发出。'})); }
    if (req.url === '/api/internal/agent/snapshot') { legacyCalls++; return res.end(JSON.stringify(LEGACY)); }
    if (req.url === '/api/internal/agent/outcome') { outcomes.push({auth, ...body}); return res.end('{}'); }
    res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
}

// 假模型按这一轮最后一条用户消息回：上一步是工具结果就收尾；否则按消息里的字决定调什么工具。
const lastUser = body => {
  const last = (body.messages || []).filter(m => m.role === 'user').at(-1);
  if (!last) return {text: '', toolResult: false};
  if (typeof last.content === 'string') return {text: last.content, toolResult: false};
  return {text: last.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), toolResult: last.content.some(b => b.type === 'tool_result')};
};
let script = () => ({tool: 'mcp__weave__send_message', input: {text: '收到'}});
const route = body => {
  if (!isMain(body)) return {text: '摘要'};
  const last = lastUser(body);
  if (last.toolResult) return {text: '工作记录：这一轮做完了。'};
  return script(last.text, body);
};

before(async () => {
  fake = await startFakeModel();
  fake.script(route);
  web = await startFakeWeb();
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-live-')));
  agent = await createAgentService({
    token: TOKEN, dataDir, isolation: 'local', sandbox: false, weaveUrl: web.url,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
    now: () => clock.t,
  });
});
after(async () => { await agent.close(); await web.close(); await fake.close(); });

async function post(path, body) {
  const response = await fetch(agent.url + path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: JSON.stringify(body)});
  return {status: response.status, data: await response.json()};
}
const local = () => new Date(clock.t + 8 * 3600_000).toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
const say = (id, text, extra = {}) => post('/message', {scope: 'owner', id, capability: 'cap-' + id, provider: 'deepseek', model: 'deepseek-flash', wait: true, message: {kind: 'message', channel: 'web', at: local(), text}, ...extra});
const until = async (check, ms = 15000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('等不到'); await new Promise(r => setTimeout(r, 50)); } };

test('一直在线：两条消息进同一段会话，CLI 只开一次；第二条消息的请求里看得到第一条', async () => {
  fake.captured.length = 0;
  const first = await say('alice', '我今天想晚饭后走路');
  assert.equal(first.status, 200);
  assert.equal(first.data.outcome, 'success');
  const second = await say('alice', '我刚才说了什么？');
  assert.equal(second.data.sessionId, first.data.sessionId);
  assert.equal(agent.live.size, 1);
  const lastCall = fake.captured.filter(c => isMain(c.body)).at(-1);
  assert.ok(JSON.stringify(lastCall.body.messages).includes('我今天想晚饭后走路'));
});

test('一张嘴：只有 send_message 发得出去，带着这条消息的通行证和 kind；最后那段文字只是工作记录', async () => {
  toolCalls.length = 0;
  const r = await say('alice', '你好');
  assert.equal(r.data.reply, '工作记录：这一轮做完了。');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'send_message');
  assert.equal(toolCalls[0].auth, 'Bearer cap-alice');
  assert.deepEqual(toolCalls[0].args, {text: '收到'});
  assert.deepEqual(toolCalls[0].turn, {kind: 'message'});
});

test('本子：第一次用时从网站导入以前的数据（只一次）；Weave 用 sqlite3 直接写的打卡，网页读得到；网页打勾也写同一个文件', async () => {
  assert.equal(legacyCalls, 1);
  script = text => text.includes('今天走了')
    ? {tool: 'Bash', input: {command: `sqlite3 records.db "insert into completions (habit_id, date, note) values ('h1', '2026-11-17', '25 分钟')"`, description: 'record'}}
    : {tool: 'mcp__weave__send_message', input: {text: '收到'}};
  await say('alice', '今天走了 25 分钟');
  const book = await post('/notebook/read', {id: 'alice', capability: 'cap-alice', since: '2026-11-01'});
  assert.deepEqual(book.data.completions.map(c => [c.date, c.note]), [['2026-11-16', ''], ['2026-11-17', '25 分钟']]);
  const check = await post('/notebook/check', {id: 'alice', capability: 'cap-alice', habitId: 'h1', date: '2026-11-15', done: true});
  assert.equal(check.status, 200);
  assert.equal((await post('/notebook/read', {id: 'alice', capability: 'cap-alice'})).data.completions.length, 3);
  assert.equal((await post('/notebook/check', {id: 'alice', capability: 'cap-alice', habitId: 'nope', date: '2026-11-15', done: true})).status, 404);
  assert.equal(legacyCalls, 1);
});

test('改记录之前先备份（Hook）；每一轮记一行原始日志：用了哪些工具、结果、token、缓存命中', async () => {
  const dirs = scopeDirs(dataDir, 'owner', 'alice');
  assert.ok(readdirSync(join(dirs.root, 'backups')).some(name => name.startsWith('records-')));
  const runs = readFileSync(join(dirs.root, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const last = runs.at(-1);
  assert.equal(last.outcome, 'success');
  assert.equal(last.kind, 'message');
  assert.deepEqual(last.tools, ['Bash']);
  assert.ok(last.usage.input + last.usage.cacheRead > 0);
  assert.ok(!JSON.stringify(runs).includes('今天走了'), '日志不记她说的原话');
});

test('闹钟：schedule 写进本子；到点由 /tick 推进同一段会话，她让设的提醒用她确认过的原句；响过一次不再响', async () => {
  script = text => text.includes('提醒我')
    ? {tool: 'mcp__weave__schedule', input: {at: '2026-11-17T20:00+08:00', note: '给妈妈打电话', kind: 'reminder'}}
    : {tool: 'mcp__weave__send_message', input: {text: '好'}};
  await say('alice', '晚上 8 点提醒我给妈妈打电话');
  const book = await post('/notebook/read', {id: 'alice', capability: 'cap-alice'});
  assert.deepEqual(book.data.alarms.map(a => [a.at, a.note, a.kind]), [['2026-11-17T20:00:00+08:00', '给妈妈打电话', 'reminder']]);
  fake.captured.length = 0; toolCalls.length = 0; outcomes.length = 0;
  clock.t = Date.parse('2026-11-17T20:00:30+08:00');
  const entry = {scope: 'owner', id: 'alice', capability: 'cap-tick', provider: 'deepseek', model: 'deepseek-flash', timezone: 'Asia/Shanghai', heartbeat: false};
  assert.equal((await post('/tick', {entries: [entry]})).status, 202);
  await until(() => outcomes.length === 1);
  assert.equal(outcomes[0].kind, 'alarm');
  assert.equal(outcomes[0].outcome, 'success');
  const asked = lastUser(fake.captured.filter(c => isMain(c.body))[0].body).text;
  assert.ok(asked.includes('kind="alarm"') && asked.includes(reminderAlarmText('给妈妈打电话')), asked);
  assert.deepEqual(toolCalls[0].turn, {kind: 'alarm', alarmKind: 'reminder'});
  outcomes.length = 0;
  await post('/tick', {entries: [entry]});
  await new Promise(r => setTimeout(r, 300));
  assert.equal(outcomes.length, 0, '同一个闹钟只响一次');
});

test('心跳：白天、离上一次满 30 分钟才推一条「现在是……」；群里没有心跳', async () => {
  outcomes.length = 0; fake.captured.length = 0;
  script = () => ({text: '没什么要说的。'});
  const entry = {scope: 'owner', id: 'alice', capability: 'cap-tick', provider: 'deepseek', model: 'deepseek-flash', timezone: 'Asia/Shanghai', heartbeat: true};
  clock.t = Date.parse('2026-11-17T20:10:00+08:00');
  await post('/tick', {entries: [entry]});
  await until(() => outcomes.length === 1);
  assert.equal(outcomes[0].kind, 'heartbeat');
  assert.ok(lastUser(fake.captured.filter(c => isMain(c.body))[0].body).text.includes('现在是11月17日（周二）20:10。'));
  clock.t = Date.parse('2026-11-17T20:30:00+08:00');
  await post('/tick', {entries: [entry]});
  await new Promise(r => setTimeout(r, 300));
  assert.equal(outcomes.length, 1, '不到 30 分钟不再来');
  clock.t = Date.parse('2026-11-17T23:30:00+08:00');
  await post('/tick', {entries: [entry]});
  await new Promise(r => setTimeout(r, 300));
  assert.equal(outcomes.length, 1, '夜里不给心跳');
});

test('记忆用 SDK 自带的：以前的 MEMORY.md 挪进记忆目录，会话开始时 CLI 自己读进第一条消息', async () => {
  const dirs = scopeDirs(dataDir, 'owner', 'bob');
  mkdirSync(dirs.workspace, {recursive: true});
  writeFileSync(join(dirs.workspace, 'MEMORY.md'), '她晚上 11 点以后不想被打扰。\n');
  fake.captured.length = 0;
  script = () => ({text: '好。'});
  await say('bob', '你好');
  assert.equal(existsSync(join(dirs.workspace, 'MEMORY.md')), false);
  assert.equal(readFileSync(join(memoryDir(dirs, dirs.workspace), 'MEMORY.md'), 'utf8'), '她晚上 11 点以后不想被打扰。\n');
  const first = fake.captured.find(c => isMain(c.body));
  assert.ok(JSON.stringify(first.body.messages).includes('她晚上 11 点以后不想被打扰'));
  assert.ok(!JSON.stringify(first.body.system).includes('她晚上 11 点以后不想被打扰'), '记忆不拼进系统提示');
  const memory = await post('/memory', {scope: 'owner', id: 'bob'});
  assert.deepEqual(memory.data.files.map(f => f.name), ['MEMORY.md']);
});

test('会话空闲关掉以后，下一条消息接着同一段会话（对话不丢）', async () => {
  script = () => ({text: '好。'});
  const before = await say('carol', '记住：我叫小卡');
  await agent.live.close('owner:carol');
  assert.equal(agent.live.isLive('owner:carol'), false);
  fake.captured.length = 0;
  const after = await say('carol', '我叫什么？');
  assert.equal(after.data.sessionId, before.data.sessionId);
  assert.ok(JSON.stringify(fake.captured.filter(c => isMain(c.body)).at(-1).body.messages).includes('记住：我叫小卡'));
});

test('没人等的消息（微信）：马上回 202，做完向网站回报结果和 ref', async () => {
  outcomes.length = 0;
  script = () => ({tool: 'mcp__weave__send_message', input: {text: '收到'}});
  const r = await post('/message', {scope: 'owner', id: 'alice', capability: 'cap-w', provider: 'deepseek', model: 'deepseek-flash', ref: 'in:1', message: {kind: 'message', channel: 'wechat', at: local(), text: '在吗'}});
  assert.equal(r.status, 202);
  await until(() => outcomes.length === 1);
  assert.deepEqual({auth: outcomes[0].auth, outcome: outcomes[0].outcome, ref: outcomes[0].ref, kind: outcomes[0].kind}, {auth: 'Bearer cap-w', outcome: 'success', ref: 'in:1', kind: 'message'});
});

test('群：自己的空间、自己的闹钟，看不到任何人的本子；群里也能定闹钟', async () => {
  legacyCalls = 0;
  script = text => text.includes('每晚 9 点')
    ? {tool: 'mcp__weave__schedule', input: {at: '2026-11-18T21:00+08:00', note: '提醒大家打卡', kind: 'reminder', repeat: 'daily'}}
    : {tool: 'mcp__weave__send_message', input: {text: '好的'}};
  const r = await post('/message', {scope: 'group', id: 'g1', capability: 'cap-g', provider: 'deepseek', model: 'deepseek-flash', wait: true, message: {kind: 'message', channel: 'group', at: local(), text: '成员1：每晚 9 点提醒大家打卡'}});
  assert.equal(r.data.outcome, 'success');
  assert.equal(legacyCalls, 0, '群不导入任何人的数据');
  const db = new DatabaseSync(notebookPath(scopeDirs(dataDir, 'group', 'g1')));
  assert.deepEqual(db.prepare('SELECT note, repeat FROM alarms').all().map(a => ({...a})), [{note: '提醒大家打卡', repeat: 'daily'}]);
  db.close();
});
