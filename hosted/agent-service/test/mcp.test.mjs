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

test('weaveServer 只接受工具表里的名字，不认识的名字直接报错', () => {
  const rpc = async () => ({ok: true, text: ''});
  const server = weaveServer(['send_message', 'log_completion'], rpc);
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'weave');
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

test('只剩三个会写东西的工具（读数据走快照），都不碰外部世界', () => {
  assert.deepEqual(Object.keys(TOOL_DEFS).sort(), ['log_completion', 'save_habit', 'send_message']);
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    assert.equal(def.annotations.openWorldHint, false, name);
    assert.equal(def.annotations.readOnlyHint, false, name);
  }
});
