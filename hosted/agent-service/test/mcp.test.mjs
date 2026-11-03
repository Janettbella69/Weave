import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {z} from 'zod';
import {toolBackend, UNCERTAIN} from '../mcp/rpc.mjs';
import {TOOL_DEFS, makeHandler, weaveServer} from '../mcp/tools.mjs';
// The image of this service has no hosted/lib, so tools.mjs keeps its own copy of the category list; this test keeps the two equal.
import {GOAL_CATEGORIES} from '../../lib/weave/habits.mjs';

// The three model-facing texts, copied from the spec's Appendix A (A-1, A-2, A-3), drafts pending confirmation.
const SAVE_GOAL_TEXT = '保存或修改对方的一个目标，比如「每天动一动」。新建时不带 goal_id；修改时带上 goal_id，只改给了的字段；archived 设为 true 表示对方不再追踪这个目标。先在聊天里把目标和每天要做的小事说给对方听，对方同意了再调用。category 从这七个里选：health、relationships、finance、career、interests、productivity、other。';
const GOAL_ID_TEXT = '这个习惯属于哪个目标。填 weave/weave.db 里 goals 表的 goal_id；不属于任何目标就不填。';
const SET_REMINDER_TEXT = '在某个时间提醒对方一次，比如「明天晚上 8 点提醒我给妈妈打电话」。due_at 用 ISO 时间，按对方的当地时间换算，必须在将来。先跟对方说清楚什么时候提醒、提醒什么，对方没反对再调用。到点后，提醒会出现在对方的聊天里；对方接了微信的话也会发到微信。';

async function weaveStub(respond) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null});
    await respond(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
}

test('weaveServer 只接受工具表里的名字，不认识的名字直接报错', () => {
  const rpc = async () => ({ok: true, text: ''});
  const server = weaveServer(['send_message', 'log_completion'], rpc);
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'weave');
  assert.equal(weaveServer(['send_message', 'save_habit', 'log_completion', 'save_goal', 'set_reminder'], rpc).type, 'sdk');
  assert.throws(() => weaveServer(['send_message', 'read_everything'], rpc), /read_everything/);
  assert.throws(() => weaveServer(['__proto__'], rpc));
});

test('makeHandler 把参数和 toolUseId 原样交给 rpc；失败时 isError 为 true，只返回文字', async () => {
  const calls = [];
  const rpc = async (...args) => { calls.push(args); return {ok: false, text: '对方还没授权共享时间，请先让对方确认'}; };
  const result = await makeHandler('log_completion', rpc)({habit_id: 'h1', date: '2026-11-01'}, {_meta: {'claudecode/toolUseId': 'toolu_1'}});
  assert.deepEqual(calls, [['log_completion', {habit_id: 'h1', date: '2026-11-01'}, 'toolu_1']]);
  assert.deepEqual(result, {isError: true, content: [{type: 'text', text: '对方还没授权共享时间，请先让对方确认'}]});
  const ok = await makeHandler('save_habit', async () => ({ok: true, text: '{"habit":{}}'}))({name: '走路'}, {_meta: {'claudecode/toolUseId': 'toolu_2'}});
  assert.deepEqual(ok, {isError: false, content: [{type: 'text', text: '{"habit":{}}'}]});
});

test('makeHandler：拿不到 toolUseId 时也给一个不重复的编号，不让后端因为缺编号拒绝', async () => {
  const ids = [];
  const rpc = async (_name, _args, id) => { ids.push(id); return {ok: true, text: 'ok'}; };
  await makeHandler('send_message', rpc)({text: 'a'}, undefined);
  await makeHandler('send_message', rpc)({text: 'b'}, {});
  assert.equal(ids.length, 2);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.notEqual(ids[0], ids[1]);
});

test('rpc 带上通行证，POST 到 /api/internal/agent/tools/<name>', async t => {
  const weave = await weaveStub((req, res) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"ok":true,"text":"已记录"}'); });
  t.after(weave.close);
  const rpc = toolBackend({weaveUrl: weave.url + '/', capability: 'cap-123'});
  assert.deepEqual(await rpc('log_completion', {habit_id: 'h1', date: '2026-11-01'}, 'toolu_9'), {ok: true, text: '已记录'});
  assert.equal(weave.seen.length, 1);
  const [req] = weave.seen;
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/internal/agent/tools/log_completion');
  assert.equal(req.headers.authorization, 'Bearer cap-123');
  assert.match(req.headers['content-type'], /application\/json/);
  assert.deepEqual(req.body, {args: {habit_id: 'h1', date: '2026-11-01'}, toolUseId: 'toolu_9'});
});

test('rpc：后端说规则不允许（200 + ok:false）时原样把理由交回模型', async t => {
  const weave = await weaveStub((req, res) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"ok":false,"text":"不记未来日期"}'); });
  t.after(weave.close);
  assert.deepEqual(await toolBackend({weaveUrl: weave.url, capability: 'c'})('log_completion', {}, 'toolu_1'), {ok: false, text: '不记未来日期'});
});

test('rpc：Weave 返回 500、401、格式不对、超时或连不上，都说「结果不确定」，不假装成功', async t => {
  const replies = [
    res => { res.writeHead(500); res.end('boom'); },
    res => { res.writeHead(401, {'Content-Type': 'application/json'}); res.end('{"error":"通行证无效或已过期"}'); },
    res => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"foo":1}'); },
    () => { /* never answers */ },
  ];
  let i = 0;
  const weave = await weaveStub((req, res) => replies[i++](res));
  t.after(weave.close);
  const rpc = toolBackend({weaveUrl: weave.url, capability: 'c', timeoutMs: 300});
  for (let n = 0; n < replies.length; n++) assert.deepEqual(await rpc('send_message', {text: 'x'}, 'toolu_' + n), {ok: false, text: UNCERTAIN}, `reply ${n}`);
  assert.deepEqual(await toolBackend({weaveUrl: 'http://127.0.0.1:9', capability: 'c'})('send_message', {}, 'toolu_x'), {ok: false, text: UNCERTAIN});
});

test('log_completion 的说明和参数照文档第 4 节：日期必填，备注最多 500 字', () => {
  const def = TOOL_DEFS.log_completion;
  assert.equal(def.description, '记录用户完成了一次习惯。只记用户明确说做了的，猜测不要记。');
  const schema = z.object(def.shape);
  assert.equal(schema.safeParse({habit_id: 'h1', date: '2026-11-01'}).success, true);
  assert.equal(schema.safeParse({habit_id: 'h1'}).success, false);
  assert.equal(schema.safeParse({habit_id: 'h1', date: '2026-11-01', note: 'x'.repeat(500)}).success, true);
  assert.equal(schema.safeParse({habit_id: 'h1', date: '2026-11-01', note: 'x'.repeat(501)}).success, false);
});

test('send_message 不能选收件人，文字 1–700 字；save_habit 名字最多 30 字', () => {
  const send = z.object(TOOL_DEFS.send_message.shape);
  assert.deepEqual(Object.keys(TOOL_DEFS.send_message.shape), ['text']);
  assert.equal(send.safeParse({text: ''}).success, false);
  assert.equal(send.safeParse({text: 'x'.repeat(700)}).success, true);
  assert.equal(send.safeParse({text: 'x'.repeat(701)}).success, false);
  const save = z.object(TOOL_DEFS.save_habit.shape);
  assert.equal(save.safeParse({name: 'x'.repeat(30)}).success, true);
  assert.equal(save.safeParse({name: 'x'.repeat(31)}).success, false);
});

test('save_goal 的说明是附录 A-1 原文；参数都可选，名字 1–30 字，类别只能是七个之一', () => {
  const def = TOOL_DEFS.save_goal;
  assert.equal(def.description, SAVE_GOAL_TEXT);
  assert.deepEqual(Object.keys(def.shape), ['goal_id', 'title', 'category', 'archived']);
  const schema = z.object(def.shape);
  assert.equal(schema.safeParse({}).success, true, '新建还是修改、缺什么，由后端按规则说');
  assert.equal(schema.safeParse({title: '每天动一动', category: 'health'}).success, true);
  assert.equal(schema.safeParse({goal_id: 'g:1', archived: true}).success, true);
  assert.equal(schema.safeParse({title: 'x'.repeat(30)}).success, true);
  assert.equal(schema.safeParse({title: 'x'.repeat(31)}).success, false);
  assert.equal(schema.safeParse({title: ''}).success, false);
  for (const category of GOAL_CATEGORIES) assert.equal(schema.safeParse({category}).success, true, category);
  assert.equal(schema.safeParse({category: 'fitness'}).success, false);
  assert.equal(schema.safeParse({archived: 'true'}).success, false);
});

test('save_goal 的 category 选项和 Weave 后端的 GOAL_CATEGORIES 一模一样，顺序也一样', () => {
  const json = z.toJSONSchema(z.object(TOOL_DEFS.save_goal.shape));
  assert.deepEqual(json.properties.category.enum, GOAL_CATEGORIES);
  assert.deepEqual(json.required ?? [], [], '四个参数都不是必填');
});

test('save_habit 多一个可选的 goal_id，说明是附录 A-2 原文；原来的参数不变', () => {
  assert.deepEqual(Object.keys(TOOL_DEFS.save_habit.shape), ['habit_id', 'name', 'identity', 'trigger', 'minimum_action', 'goal_id']);
  const json = z.toJSONSchema(z.object(TOOL_DEFS.save_habit.shape));
  assert.equal(json.properties.goal_id.description, GOAL_ID_TEXT);
  assert.deepEqual(json.required, ['name']);
  assert.equal(z.object(TOOL_DEFS.save_habit.shape).safeParse({name: '走路', goal_id: 'g:1'}).success, true);
});

test('set_reminder 的说明是附录 A-3 原文；文字 1–500 字，due_at 必填', () => {
  const def = TOOL_DEFS.set_reminder;
  assert.equal(def.description, SET_REMINDER_TEXT);
  assert.deepEqual(Object.keys(def.shape), ['text', 'due_at']);
  const schema = z.object(def.shape), due_at = '2026-11-04T20:00:00+08:00';
  assert.equal(schema.safeParse({text: '给妈妈打电话', due_at}).success, true);
  assert.equal(schema.safeParse({text: 'x'.repeat(500), due_at}).success, true);
  assert.equal(schema.safeParse({text: 'x'.repeat(501), due_at}).success, false);
  assert.equal(schema.safeParse({text: '', due_at}).success, false);
  assert.equal(schema.safeParse({text: '喝水'}).success, false);
  assert.equal(schema.safeParse({due_at}).success, false);
});

test('makeHandler 对 save_goal、set_reminder 一样原样转给 rpc', async () => {
  const calls = [];
  const rpc = async (...args) => { calls.push(args); return {ok: true, text: '{"goal":{}}'}; };
  const extra = {_meta: {'claudecode/toolUseId': 'toolu_7'}};
  assert.deepEqual(await makeHandler('save_goal', rpc)({title: '每天动一动', category: 'health'}, extra), {isError: false, content: [{type: 'text', text: '{"goal":{}}'}]});
  await makeHandler('set_reminder', rpc)({text: '喝水', due_at: '2026-11-04T20:00:00+08:00'}, extra);
  assert.deepEqual(calls, [['save_goal', {title: '每天动一动', category: 'health'}, 'toolu_7'], ['set_reminder', {text: '喝水', due_at: '2026-11-04T20:00:00+08:00'}, 'toolu_7']]);
});

test('只有五个会写东西的工具（读数据走快照），都不碰外部世界，都不是只读', () => {
  assert.deepEqual(Object.keys(TOOL_DEFS).sort(), ['log_completion', 'save_goal', 'save_habit', 'send_message', 'set_reminder']);
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    assert.equal(def.annotations.openWorldHint, false, name);
    assert.equal(def.annotations.readOnlyHint, false, name);
    assert.equal(def.annotations.destructiveHint, false, name);
  }
});
