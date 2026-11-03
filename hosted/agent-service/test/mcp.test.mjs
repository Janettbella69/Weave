import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {z} from 'zod';
import {toolBackend, UNCERTAIN} from '../mcp/rpc.mjs';
import {TOOL_DEFS, makeHandler, weaveServer} from '../mcp/tools.mjs';
// The image of this service has no hosted/lib, so tools.mjs keeps its own copy of the category list; this test keeps the two equal.
import {GOAL_CATEGORIES} from '../../lib/weave/habits.mjs';

// The model-facing texts, copied from the frontend-v3 spec's Appendix A (A-1, A-2), drafts pending confirmation.
const SAVE_GOAL_TEXT = '保存或修改对方的一个目标，比如「每天动一动」。新建时不带 goal_id；修改时带上 goal_id，只改给了的字段；archived 设为 true 表示对方不再追踪这个目标。先在聊天里把目标和每天要做的小事说给对方听，对方同意了再调用。category 从这七个里选：health、relationships、finance、career、interests、productivity、other。';
const GOAL_ID_TEXT = '这个习惯属于哪个目标。填 weave/weave.db 里 goals 表的 goal_id；不属于任何目标就不填。';
// The proactive-wake spec's Appendix A item 2, drafts pending confirmation. set_reminder's first sentence changed
// (it was the frontend-v3 spec's A-3); the rest of it is unchanged.
const SET_REMINDER_TEXT = '在某个时间提醒对方，比如「明天晚上 8 点提醒我给妈妈打电话」；要每天、每周或每月提醒的，填 repeat。due_at 用 ISO 时间，按对方的当地时间换算，必须在将来。先跟对方说清楚什么时候提醒、提醒什么，对方没反对再调用。到点后，提醒会出现在对方的聊天里；对方接了微信的话也会发到微信。';
const REMINDER_REPEAT_TEXT = '不填就是只提醒一次。daily、weekly、monthly 是从 due_at 那次开始，每天、每周、每月在同一个当地时间提醒。';
const SCHEDULE_WAKE_TEXT = '给自己排一次跟进：到 at 那个时间，你会在后台被叫醒，看了情况再决定要不要找对方说一句。note 写给自己看：到时候看什么、为什么，比如「她说 18:00 去走路，看看记了没有，没记就轻轻问一句」。at 用 ISO 时间，按对方的当地时间换算，必须在将来、30 天以内，并且在对方允许打扰的时段里。repeat 不填就是只一次；daily、weekly 是每天、每周同一时间。排过的在 weave/weave.db 的 schedules 表里，用不着了就用 cancel_schedule 取消。';
const CANCEL_SCHEDULE_TEXT = '取消一条还没到点的跟进或提醒。schedule_id 填 weave/weave.db 里 schedules 表的 schedule_id，或者 reminders 表的 reminder_id。';
const SET_PROACTIVITY_TEXT = '对方说「别主动找我」「少找我一点」「多找我一点」这类话时调用，改 Weave 主动找对方的档位：off 是不主动找（对方让设的提醒照常响），low、normal、high 是越来越多。只在对方亲口说的时候用。';
const ALL_TOOLS = ['send_message', 'save_habit', 'log_completion', 'save_goal', 'set_reminder', 'schedule_wake', 'cancel_schedule', 'set_proactivity'];

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
  assert.equal(weaveServer(ALL_TOOLS, rpc).type, 'sdk');
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

test('set_reminder 的说明是第二块附录 A 第 2 条的草稿；文字 1–500 字，due_at 必填，原来的参数不变', () => {
  const def = TOOL_DEFS.set_reminder;
  assert.equal(def.description, SET_REMINDER_TEXT);
  assert.deepEqual(Object.keys(def.shape), ['text', 'due_at', 'repeat']);
  const schema = z.object(def.shape), due_at = '2026-11-04T20:00:00+08:00';
  assert.equal(schema.safeParse({text: '给妈妈打电话', due_at}).success, true);
  assert.equal(schema.safeParse({text: 'x'.repeat(500), due_at}).success, true);
  assert.equal(schema.safeParse({text: 'x'.repeat(501), due_at}).success, false);
  assert.equal(schema.safeParse({text: '', due_at}).success, false);
  assert.equal(schema.safeParse({text: '喝水'}).success, false);
  assert.equal(schema.safeParse({due_at}).success, false);
});

test('set_reminder 多一个可选的 repeat：none、daily、weekly、monthly，说明是附录 A 第 2 条的草稿', () => {
  const schema = z.object(TOOL_DEFS.set_reminder.shape), base = {text: '喝水', due_at: '2026-11-04T20:00:00+08:00'};
  for (const repeat of ['none', 'daily', 'weekly', 'monthly']) assert.equal(schema.safeParse({...base, repeat}).success, true, repeat);
  for (const repeat of ['yearly', 'hourly', '', 1, null]) assert.equal(schema.safeParse({...base, repeat}).success, false, String(repeat));
  const json = z.toJSONSchema(schema);
  assert.equal(json.properties.repeat.description, REMINDER_REPEAT_TEXT);
  assert.deepEqual(json.properties.repeat.enum, ['none', 'daily', 'weekly', 'monthly']);
  assert.deepEqual(json.required, ['text', 'due_at'], '不填 repeat 就是只提醒一次，和以前一样');
});

test('schedule_wake：说明是附录 A 第 2 条的草稿；note 1–200 字、at 必填，repeat 只有 none、daily、weekly', () => {
  const def = TOOL_DEFS.schedule_wake;
  assert.equal(def.description, SCHEDULE_WAKE_TEXT);
  assert.deepEqual(Object.keys(def.shape), ['note', 'at', 'repeat']);
  const schema = z.object(def.shape), at = '2026-11-04T19:30+08:00';
  assert.equal(schema.safeParse({note: '看看走路记了没有', at}).success, true, 'at 可以不写秒，后端补');
  assert.equal(schema.safeParse({note: 'x'.repeat(200), at}).success, true);
  assert.equal(schema.safeParse({note: 'x'.repeat(201), at}).success, false);
  assert.equal(schema.safeParse({note: '', at}).success, false);
  assert.equal(schema.safeParse({note: '看看'}).success, false);
  assert.equal(schema.safeParse({at}).success, false);
  for (const repeat of ['none', 'daily', 'weekly']) assert.equal(schema.safeParse({note: '看看', at, repeat}).success, true, repeat);
  assert.equal(schema.safeParse({note: '看看', at, repeat: 'monthly'}).success, false, '跟进没有每月');
  assert.deepEqual(z.toJSONSchema(schema).required, ['note', 'at']);
});

test('cancel_schedule：说明是附录 A 第 2 条的草稿；只有一个 schedule_id，1–200 字', () => {
  const def = TOOL_DEFS.cancel_schedule;
  assert.equal(def.description, CANCEL_SCHEDULE_TEXT);
  assert.deepEqual(Object.keys(def.shape), ['schedule_id']);
  const schema = z.object(def.shape);
  assert.equal(schema.safeParse({schedule_id: 'r:1'}).success, true);
  assert.equal(schema.safeParse({schedule_id: 'x'.repeat(200)}).success, true);
  assert.equal(schema.safeParse({schedule_id: 'x'.repeat(201)}).success, false);
  assert.equal(schema.safeParse({schedule_id: ''}).success, false);
  assert.equal(schema.safeParse({}).success, false);
});

test('set_proactivity：说明是附录 A 第 2 条的草稿；档位只有 off、low、normal、high', () => {
  const def = TOOL_DEFS.set_proactivity;
  assert.equal(def.description, SET_PROACTIVITY_TEXT);
  assert.deepEqual(Object.keys(def.shape), ['level']);
  const schema = z.object(def.shape);
  assert.deepEqual(z.toJSONSchema(schema).properties.level.enum, ['off', 'low', 'normal', 'high']);
  for (const level of ['off', 'low', 'normal', 'high']) assert.equal(schema.safeParse({level}).success, true, level);
  for (const level of ['max', 'OFF', '', undefined]) assert.equal(schema.safeParse({level}).success, false, String(level));
});

test('makeHandler 对 save_goal、set_reminder 和第二块的三个工具一样原样转给 rpc', async () => {
  const calls = [];
  const rpc = async (...args) => { calls.push(args); return {ok: true, text: '{"goal":{}}'}; };
  const extra = {_meta: {'claudecode/toolUseId': 'toolu_7'}};
  assert.deepEqual(await makeHandler('save_goal', rpc)({title: '每天动一动', category: 'health'}, extra), {isError: false, content: [{type: 'text', text: '{"goal":{}}'}]});
  await makeHandler('set_reminder', rpc)({text: '喝水', due_at: '2026-11-04T20:00:00+08:00'}, extra);
  await makeHandler('set_reminder', rpc)({text: '喝水', due_at: '2026-11-04T20:00:00+08:00', repeat: 'daily'}, extra);
  await makeHandler('schedule_wake', rpc)({note: '看看走路记了没有', at: '2026-11-04T19:30:00+08:00'}, extra);
  await makeHandler('cancel_schedule', rpc)({schedule_id: 's:1'}, extra);
  await makeHandler('set_proactivity', rpc)({level: 'low'}, extra);
  assert.deepEqual(calls, [
    ['save_goal', {title: '每天动一动', category: 'health'}, 'toolu_7'],
    ['set_reminder', {text: '喝水', due_at: '2026-11-04T20:00:00+08:00'}, 'toolu_7'],
    ['set_reminder', {text: '喝水', due_at: '2026-11-04T20:00:00+08:00', repeat: 'daily'}, 'toolu_7'],
    ['schedule_wake', {note: '看看走路记了没有', at: '2026-11-04T19:30:00+08:00'}, 'toolu_7'],
    ['cancel_schedule', {schedule_id: 's:1'}, 'toolu_7'],
    ['set_proactivity', {level: 'low'}, 'toolu_7'],
  ]);
});

test('只有八个会写东西的工具（读数据走快照，排过的跟进也是），都不碰外部世界，都不是只读', () => {
  assert.deepEqual(Object.keys(TOOL_DEFS).sort(), [...ALL_TOOLS].sort());
  assert.ok(!Object.hasOwn(TOOL_DEFS, 'list_schedule'), '查排期写 SQL（教材 p.16）');
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    assert.equal(def.annotations.openWorldHint, false, name);
    assert.equal(def.annotations.readOnlyHint, false, name);
    assert.equal(def.annotations.destructiveHint, false, name);
  }
});
