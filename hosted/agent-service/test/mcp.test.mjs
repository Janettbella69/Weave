import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {z} from 'zod';
import {toolBackend, UNCERTAIN} from '../mcp/rpc.mjs';
import {TOOL_DEFS, makeHandler, weaveServer} from '../mcp/tools.mjs';

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

const handlers = {send_message: async () => ({ok: true, text: ''}), schedule: async () => ({ok: true, text: ''})};

test('只有两个工具：send_message（说话）和 schedule（定闹钟）；不认识的名字、没给做法的工具都直接报错', () => {
  assert.deepEqual(Object.keys(TOOL_DEFS), ['send_message', 'schedule']);
  const server = weaveServer(['send_message', 'schedule'], handlers);
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'weave');
  assert.throws(() => weaveServer(['send_message', 'read_everything'], handlers), /read_everything/);
  assert.throws(() => weaveServer(['__proto__'], handlers));
  assert.throws(() => weaveServer(['schedule'], {send_message: handlers.send_message}), /schedule/);
});

test('makeHandler 把参数和 toolUseId 原样交出去；失败时 isError 为 true，只返回文字', async () => {
  const calls = [];
  const result = await makeHandler(async (...args) => { calls.push(args); return {ok: false, text: '时间要写成带时区的 ISO 格式'}; })({at: 'x', note: 'y'}, {_meta: {'claudecode/toolUseId': 'toolu_1'}});
  assert.deepEqual(calls, [[{at: 'x', note: 'y'}, 'toolu_1']]);
  assert.deepEqual(result, {isError: true, content: [{type: 'text', text: '时间要写成带时区的 ISO 格式'}]});
});

test('makeHandler：拿不到 toolUseId 时也给一个不重复的编号，不让后端因为缺编号拒绝', async () => {
  const ids = [];
  const handle = makeHandler(async (_args, id) => { ids.push(id); return {ok: true, text: 'ok'}; });
  await handle({text: 'a'}, undefined);
  await handle({text: 'b'}, {});
  assert.equal(ids.length, 2);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.notEqual(ids[0], ids[1]);
});

test('rpc 带上通行证和这一条消息是什么（turn），POST 到 /api/internal/agent/tools/<name>', async t => {
  const weave = await weaveStub((req, res) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"ok":true,"text":"已发出。"}'); });
  t.after(weave.close);
  const rpc = toolBackend({weaveUrl: weave.url + '/', capability: 'cap-123', turn: {kind: 'alarm', alarmKind: 'self'}});
  assert.deepEqual(await rpc('send_message', {text: '晚饭吃了吗'}, 'toolu_9'), {ok: true, text: '已发出。'});
  const [req] = weave.seen;
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/internal/agent/tools/send_message');
  assert.equal(req.headers.authorization, 'Bearer cap-123');
  assert.deepEqual(req.body, {args: {text: '晚饭吃了吗'}, toolUseId: 'toolu_9', turn: {kind: 'alarm', alarmKind: 'self'}});
});

test('rpc：后端说不发（200 + ok:false）时原样把理由交回模型', async t => {
  const weave = await weaveStub((req, res) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"ok":false,"text":"Jev 判断现在不打扰，这条没有发出。"}'); });
  t.after(weave.close);
  assert.deepEqual(await toolBackend({weaveUrl: weave.url, capability: 'c'})('send_message', {text: 'x'}, 'toolu_1'), {ok: false, text: 'Jev 判断现在不打扰，这条没有发出。'});
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

test('参数：send_message 1–700 字；schedule 要 at 和 note，kind 只能 reminder / self，repeat 只能四种', () => {
  const send = z.object(TOOL_DEFS.send_message.shape);
  assert.ok(send.safeParse({text: '好'}).success);
  assert.ok(!send.safeParse({text: ''}).success);
  assert.ok(!send.safeParse({text: 'x'.repeat(701)}).success);
  const schedule = z.object(TOOL_DEFS.schedule.shape);
  assert.ok(schedule.safeParse({at: '2026-11-17T20:00:00+08:00', note: '给妈妈打电话', kind: 'reminder', repeat: 'daily'}).success);
  assert.ok(schedule.safeParse({at: '2026-11-17T20:00:00+08:00', note: '看看她走了没有'}).success);
  assert.ok(!schedule.safeParse({at: '2026-11-17T20:00:00+08:00', note: 'x', kind: 'other'}).success);
  assert.ok(!schedule.safeParse({at: '2026-11-17T20:00:00+08:00', note: 'x', repeat: 'hourly'}).success);
  assert.ok(!schedule.safeParse({note: 'x'}).success);
});

test('工具说明讲清：只有 send_message 才发得出去；闹钟到点会在这段对话里收到 kind="alarm"、两种 kind 的意思、在 alarms 表里', () => {
  assert.ok(TOOL_DEFS.send_message.description.includes('只有调用它，对方才看得到'));
  const text = TOOL_DEFS.schedule.description;
  for (const words of ['kind="alarm"', 'reminder', 'self', 'alarms', '带时区的 ISO']) assert.ok(text.includes(words), words);
});
