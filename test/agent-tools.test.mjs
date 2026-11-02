import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store, withWorld} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';

const secret = 'ab'.repeat(32);
// 15:00Z is 23:00 in Shanghai: outside the default 09:00–21:00 window for proactive messages.
const NOW = Date.parse('2026-11-02T15:00:00Z');

async function setup() {
  const db = new D1();
  const user = async name => {
    const r = await handleAPI(new Request('https://weave.test/api/status'), {db, identity: {userId: name, displayName: name, email: name + '@example.test'}, secret});
    return (await r.json()).personId;
  };
  const alice = await user('Alice'), bob = await user('Bob');
  const cap = (owner, extra = {}, issuedAt = NOW) => issueCapability(secret, {owner, scope: 'owner', runId: 'run-1', channel: 'web', direct: true, ...extra}, issuedAt);
  async function tool(name, args, {token, toolUseId = 'toolu_1', now = NOW} = {}) {
    const r = await handleAPI(new Request('https://weave.test/api/internal/agent/tools/' + name, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
      body: JSON.stringify({args, toolUseId}),
    }), {db, secret, now});
    return {status: r.status, data: await r.json()};
  }
  const world = () => new Store(db).load();
  return {db, alice, bob, cap, tool, world};
}

test('没有通行证、改过的通行证、过期的通行证都是 401，什么都没写', async () => {
  const s = await setup();
  const good = await s.cap(s.alice);
  const tampered = good.slice(0, -3) + (good.at(-3) === 'A' ? 'B' : 'A') + good.slice(-2);
  const expired = await s.cap(s.alice, {}, NOW - 20 * 60_000);
  for (const token of [undefined, 'not-a-token', tampered, expired]) {
    const r = await s.tool('save_habit', {name: '走路'}, {token});
    assert.equal(r.status, 401, String(token));
  }
  const person = (await s.world()).people[s.alice];
  assert.equal(person.habits, undefined);
  assert.equal(person.toolReceipts, undefined);
});

test('未知工具 404；group 通行证调 log_completion 是 403', async () => {
  const s = await setup();
  assert.equal((await s.tool('delete_everything', {}, {token: await s.cap(s.alice)})).status, 404);
  assert.equal((await s.tool('__proto__', {}, {token: await s.cap(s.alice)})).status, 404);
  assert.equal((await s.tool('log_completion', {habit_id: 'h', date: '2026-11-01'}, {token: await s.cap(s.alice, {scope: 'group'})})).status, 403);
});

test('参数不对是 400：args 不是对象、缺 toolUseId', async () => {
  const s = await setup(), token = await s.cap(s.alice);
  for (const body of [{args: [], toolUseId: 't'}, {args: {}, toolUseId: ''}, {args: {}}]) {
    const r = await handleAPI(new Request('https://weave.test/api/internal/agent/tools/list_habits', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token}, body: JSON.stringify(body)}), {db: s.db, secret, now: NOW});
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('log_completion 写进本人的 completions；同一个 toolUseId 重放只记一条，返回同样的文字', async () => {
  const s = await setup(), token = await s.cap(s.alice);
  const saved = await s.tool('save_habit', {name: '走路'}, {token, toolUseId: 'toolu_a'});
  assert.equal(saved.data.ok, true);
  const habitId = JSON.parse(saved.data.text).habit.habit_id;
  const first = await s.tool('log_completion', {habit_id: habitId, date: '2026-11-02'}, {token, toolUseId: 'toolu_b'});
  const replay = await s.tool('log_completion', {habit_id: habitId, date: '2026-11-02'}, {token, toolUseId: 'toolu_b'});
  assert.deepEqual(first, {status: 200, data: {ok: true, text: JSON.stringify({completion: {habit_id: habitId, date: '2026-11-02', note: ''}, duplicate: false})}});
  assert.deepEqual(replay, first);
  const person = (await s.world()).people[s.alice];
  assert.equal(person.completions.length, 1);
  assert.equal(person.completions[0].source, 'agent');
  assert.equal((await s.world()).people[s.bob].completions, undefined);
});

test('规则失败返回 200 加 ok:false，把中文原因交给模型（未来日期）', async () => {
  const s = await setup(), token = await s.cap(s.alice);
  const habitId = JSON.parse((await s.tool('save_habit', {name: '走路'}, {token, toolUseId: 'toolu_a'})).data.text).habit.habit_id;
  const r = await s.tool('log_completion', {habit_id: habitId, date: '2026-12-31'}, {token, toolUseId: 'toolu_b'});
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  assert.match(r.data.text, /不记未来的日期/);
  assert.equal((await s.world()).people[s.alice].completions?.length ?? 0, 0);
});

test('list_habits 和 query_completions 只读，不留回执', async () => {
  const s = await setup(), token = await s.cap(s.alice);
  await s.tool('save_habit', {name: '走路'}, {token, toolUseId: 'toolu_a'});
  const before = (await s.world()).people[s.alice].toolReceipts.length;
  const listed = await s.tool('list_habits', {}, {token, toolUseId: 'toolu_c'});
  assert.equal(JSON.parse(listed.data.text).habits[0].name, '走路');
  const queried = await s.tool('query_completions', {from: '2026-10-27', to: '2026-11-02'}, {token, toolUseId: 'toolu_d'});
  assert.deepEqual(JSON.parse(queried.data.text), {today: '2026-11-02', completions: []});
  assert.equal((await s.world()).people[s.alice].toolReceipts.length, before);
});

test('send_message 只发给通行证上的本人：进本人的 messages 和通知，另一个账号看不到', async () => {
  const s = await setup();
  const r = await s.tool('send_message', {text: '今天也走一走吧'}, {token: await s.cap(s.alice)});
  assert.deepEqual(r.data, {ok: true, text: '已发出。'});
  const w = await s.world(), alice = w.people[s.alice], bob = w.people[s.bob];
  const sent = alice.messages.at(-1);
  assert.equal(sent.text, '今天也走一走吧');
  assert.equal(sent.role, 'assistant');
  assert.equal(sent.source, 'agent');
  assert.equal(sent.runId, 'run-1');
  assert.equal(alice.notifications.at(-1).text, '今天也走一走吧');
  assert.ok(!JSON.stringify(bob).includes('今天也走一走吧'));
});

test('send_message：不是直接找它的那一轮在安静时段不发；有人直接找时照发', async () => {
  const s = await setup();
  const quiet = await s.tool('send_message', {text: '晚安前提醒一下'}, {token: await s.cap(s.alice, {direct: false})});
  assert.equal(quiet.data.ok, false);
  assert.match(quiet.data.text, /安静时段/);
  const direct = await s.tool('send_message', {text: '晚安前提醒一下'}, {token: await s.cap(s.alice, {direct: true}), toolUseId: 'toolu_2'});
  assert.equal(direct.data.ok, true);
});

test('send_message：同一句 24 小时内不重复；每天最多 20 条', async () => {
  const s = await setup(), token = await s.cap(s.bob);
  assert.equal((await s.tool('send_message', {text: '早'}, {token, toolUseId: 'toolu_0'})).data.ok, true);
  const again = await s.tool('send_message', {text: '早'}, {token, toolUseId: 'toolu_dup'});
  assert.equal(again.data.ok, false);
  assert.match(again.data.text, /24 小时内已经发过/);
  for (let i = 1; i < 20; i++) assert.equal((await s.tool('send_message', {text: '第' + i + '条'}, {token, toolUseId: 'toolu_' + i})).data.ok, true, String(i));
  const over = await s.tool('send_message', {text: '第二十一条'}, {token, toolUseId: 'toolu_21'});
  assert.equal(over.data.ok, false);
  assert.match(over.data.text, /上限/);
  assert.equal((await s.world()).people[s.bob].messages.filter(m => m.source === 'agent').length, 20);
});

test('同一个人两个工具调用同时到，两条都记上', async () => {
  const s = await setup(), token = await s.cap(s.alice);
  const walk = JSON.parse((await s.tool('save_habit', {name: '走路'}, {token, toolUseId: 'toolu_a'})).data.text).habit.habit_id;
  const read = JSON.parse((await s.tool('save_habit', {name: '读书'}, {token, toolUseId: 'toolu_b'})).data.text).habit.habit_id;
  const [x, y] = await Promise.all([
    s.tool('log_completion', {habit_id: walk, date: '2026-11-02'}, {token, toolUseId: 'toolu_c'}),
    s.tool('log_completion', {habit_id: read, date: '2026-11-02'}, {token, toolUseId: 'toolu_d'}),
  ]);
  assert.equal(x.status, 200, JSON.stringify(x));
  assert.equal(y.status, 200, JSON.stringify(y));
  assert.equal((await s.world()).people[s.alice].completions.length, 2);
});

test('withWorld 遇到并发提交，会重读再做一遍，别人的改动也保留', async () => {
  const db = new D1(), seed = new Store(db), w0 = await seed.load();
  w0.people['u:x'] = {id: 'u:x', note: ''};
  await seed.save(w0);
  let calls = 0;
  const result = await withWorld(db, async world => {
    calls++;
    if (calls === 1) {
      const other = new Store(db), w = await other.load();
      w.people['u:x'].note = 'someone else';
      await other.save(w);
    }
    world.people['u:x'].mine = calls;
    return calls;
  });
  assert.equal(result, 2);
  const final = (await new Store(db).load()).people['u:x'];
  assert.deepEqual(final, {id: 'u:x', note: 'someone else', mine: 2});
});

test('不认识的内部接口直接 404，不算进本人的操作次数', async () => {
  const s = await setup();
  const before = (await s.world()).people[s.alice].rate;
  const r = await handleAPI(new Request('https://weave.test/api/internal/x', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://weave.test'}, body: '{}'}), {db: s.db, identity: {userId: 'Alice', displayName: 'Alice', email: 'alice@example.test'}, secret});
  assert.equal(r.status, 404);
  assert.deepEqual((await s.world()).people[s.alice].rate, before);
});
