import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';
import {snapshotFor} from '../hosted/lib/weave/agent-snapshot.mjs';

const secret = 'ab'.repeat(32);
// 15:00Z is 23:00 in Shanghai, still 2026-11-02 there.
const NOW = Date.parse('2026-11-02T15:00:00Z');
const HABIT_COLUMNS = ['habit_id', 'name', 'identity', 'trigger', 'minimum_action', 'created_at', 'updated_at', 'goal_id'];
const COMPLETION_COLUMNS = ['habit_id', 'date', 'note', 'source', 'created_at'];
const GOAL_COLUMNS = ['goal_id', 'title', 'category', 'archived', 'created_at'];
const REMINDER_COLUMNS = ['reminder_id', 'text', 'due_at', 'status'];
// domain.validTime compares with Date.now(), so a reminder time is relative to the real clock: one day ahead, +08:00.
const inOneDay = () => new Date(Date.now() + 24 * 3600_000 + 8 * 3600_000).toISOString().slice(0, 19) + '+08:00';

async function setup() {
  const db = new D1();
  const user = async name => {
    const r = await handleAPI(new Request('https://weave.test/api/status'), {db, identity: {userId: name, displayName: name, email: name + '@example.test'}, secret});
    return (await r.json()).personId;
  };
  const alice = await user('Alice'), bob = await user('Bob');
  const cap = (owner, extra = {}, issuedAt = NOW) => issueCapability(secret, {owner, scope: 'owner', runId: 'run-1', channel: 'web', direct: true, ...extra}, issuedAt);
  async function tool(name, args, token, toolUseId) {
    const r = await handleAPI(new Request('https://weave.test/api/internal/agent/tools/' + name, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token}, body: JSON.stringify({args, toolUseId}),
    }), {db, secret, now: NOW});
    return JSON.parse((await r.json()).text);
  }
  async function snapshot(token, {method = 'GET'} = {}) {
    const r = await handleAPI(new Request('https://weave.test/api/internal/agent/snapshot', {method, headers: token ? {Authorization: 'Bearer ' + token} : {}}), {db, secret, now: NOW});
    return {status: r.status, data: await r.json()};
  }
  return {alice, bob, cap, tool, snapshot};
}

test('owner 通行证拿到本人的习惯和完成记录，别人的拿不到', async () => {
  const s = await setup(), aliceToken = await s.cap(s.alice), bobToken = await s.cap(s.bob);
  const walk = (await s.tool('save_habit', {name: '走路', minimum_action: '穿上鞋'}, aliceToken, 'toolu_1')).habit.habit_id;
  await s.tool('save_habit', {name: '读书'}, aliceToken, 'toolu_2');
  await s.tool('log_completion', {habit_id: walk, date: '2026-11-02', note: '饭后'}, aliceToken, 'toolu_3');
  await s.tool('save_habit', {name: '跑步'}, bobToken, 'toolu_4');

  const r = await s.snapshot(aliceToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.version, 1);
  assert.equal(r.data.today, '2026-11-02');
  assert.equal(r.data.timezone, 'Asia/Shanghai');
  assert.deepEqual(r.data.files, {});
  assert.deepEqual(r.data.tables.habits.map(h => h.name), ['走路', '读书']);
  for (const row of r.data.tables.habits) assert.deepEqual(Object.keys(row), HABIT_COLUMNS);
  assert.equal(r.data.tables.habits[0].minimum_action, '穿上鞋');
  assert.equal(r.data.tables.completions.length, 1);
  assert.deepEqual(Object.keys(r.data.tables.completions[0]), COMPLETION_COLUMNS);
  assert.deepEqual({...r.data.tables.completions[0], created_at: 'x'}, {habit_id: walk, date: '2026-11-02', note: '饭后', source: 'agent', created_at: 'x'});
  assert.ok(!JSON.stringify(r.data).includes('跑步'), 'Bob 的习惯不该出现在 Alice 的快照里');
});

test('owner 通行证还拿到全部目标和提醒；习惯带 goal_id，列的顺序固定；别人的拿不到', async () => {
  const s = await setup(), aliceToken = await s.cap(s.alice), bobToken = await s.cap(s.bob), due = inOneDay();
  const move = (await s.tool('save_goal', {title: '每天动一动', category: 'health'}, aliceToken, 'toolu_1')).goal;
  const money = (await s.tool('save_goal', {title: '学理财', category: 'finance'}, aliceToken, 'toolu_2')).goal;
  await s.tool('save_goal', {goal_id: money.goal_id, archived: true}, aliceToken, 'toolu_3');
  const walk = (await s.tool('save_habit', {name: '走路', goal_id: move.goal_id}, aliceToken, 'toolu_4')).habit;
  await s.tool('save_habit', {name: '读书'}, aliceToken, 'toolu_5');
  const reminder = (await s.tool('set_reminder', {text: '给妈妈打电话', due_at: due}, aliceToken, 'toolu_6')).reminder;
  await s.tool('save_goal', {title: 'Bob 的目标', category: 'career'}, bobToken, 'toolu_7');
  await s.tool('set_reminder', {text: 'Bob 的提醒', due_at: due}, bobToken, 'toolu_8');

  const r = await s.snapshot(aliceToken);
  assert.equal(r.status, 200);
  const {goals, reminders, habits} = r.data.tables;
  for (const row of goals) assert.deepEqual(Object.keys(row), GOAL_COLUMNS);
  for (const row of reminders) assert.deepEqual(Object.keys(row), REMINDER_COLUMNS);
  for (const row of habits) assert.deepEqual(Object.keys(row), HABIT_COLUMNS);
  assert.deepEqual(Object.keys(r.data.tables), ['habits', 'completions', 'goals', 'reminders']);
  // 全部目标都在，归档的也在，archived 是 0 / 1。
  assert.deepEqual(goals, [
    {goal_id: move.goal_id, title: '每天动一动', category: 'health', archived: 0, created_at: '2026-11-02T15:00:00.000Z'},
    {goal_id: money.goal_id, title: '学理财', category: 'finance', archived: 1, created_at: '2026-11-02T15:00:00.000Z'},
  ]);
  assert.deepEqual(reminders, [{reminder_id: reminder.reminder_id, text: '给妈妈打电话', due_at: new Date(due).toISOString(), status: 'scheduled'}]);
  assert.deepEqual(habits.map(h => [h.habit_id, h.goal_id]), [[walk.habit_id, move.goal_id], [habits[1].habit_id, null]]);
  assert.ok(!JSON.stringify(r.data).includes('Bob'), 'Bob 的目标和提醒不该出现在 Alice 的快照里');
});

test('旧账号没有 goals、reminders 字段，习惯没有 goalId：快照给空表，goal_id 是 null，不报错', () => {
  const person = {id: 'u:old', profile: {timezone: 'Asia/Shanghai'}, habits: [{id: 'h:1', name: '走路', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'}]};
  const snapshot = snapshotFor(person, {scope: 'owner'}, NOW);
  assert.deepEqual(snapshot.tables.goals, []);
  assert.deepEqual(snapshot.tables.reminders, []);
  assert.equal(snapshot.tables.habits[0].goal_id, null);
  assert.deepEqual(snapshotFor({id: 'u:new', profile: {timezone: 'Asia/Shanghai'}}, {scope: 'owner'}, NOW).tables.habits, []);
});

test('提醒不分状态全部给出（排着的、已经响过的、取消的）', () => {
  const reminder = (id, status) => ({id, text: id, dueAt: '2026-11-03T12:00:00.000Z', status, createdAt: '2026-11-02T00:00:00.000Z', deliveredAt: '2026-11-03T12:00:01.000Z', wechatQueued: true});
  const person = {id: 'u:r', profile: {timezone: 'Asia/Shanghai'}, reminders: [reminder('r:1', 'scheduled'), reminder('r:2', 'delivered'), reminder('r:3', 'cancelled')]};
  const rows = snapshotFor(person, {scope: 'owner'}, NOW).tables.reminders;
  assert.deepEqual(rows.map(r => [r.reminder_id, r.status]), [['r:1', 'scheduled'], ['r:2', 'delivered'], ['r:3', 'cancelled']]);
  for (const row of rows) assert.deepEqual(Object.keys(row), REMINDER_COLUMNS);
});

test('没有通行证、过期、篡改都是 401；POST 是 405；group 通行证拿到空的 tables 和 files', async () => {
  const s = await setup(), good = await s.cap(s.alice);
  await s.tool('save_habit', {name: '走路'}, good, 'toolu_1');
  await s.tool('save_goal', {title: '私人目标', category: 'health'}, good, 'toolu_g');
  await s.tool('set_reminder', {text: '私人提醒', due_at: inOneDay()}, good, 'toolu_r');
  const tampered = good.slice(0, -3) + (good.at(-3) === 'A' ? 'B' : 'A') + good.slice(-2);
  for (const token of [undefined, 'not-a-token', tampered, await s.cap(s.alice, {}, NOW - 20 * 60_000)]) {
    const r = await s.snapshot(token);
    assert.equal(r.status, 401, String(token));
    assert.match(r.data.error, /通行证/);
  }
  assert.equal((await s.snapshot(good, {method: 'POST'})).status, 405);
  // 微信分支的通行证要求群范围带 group；这里先带上，两边合并后测试照样能过。
  const group = await s.snapshot(await s.cap(s.alice, {scope: 'group', group: 'g1'}));
  assert.equal(group.status, 200);
  assert.deepEqual(group.data.tables, {group_messages: []}, '没有开启的群就没有消息');
  for (const table of ['habits', 'completions', 'goals', 'reminders']) assert.ok(!(table in group.data.tables), `群的快照里不该有 ${table} 表`);
  assert.equal(group.data.timezone, null);
  assert.deepEqual(group.data.files, {});
  for (const leak of ['走路', '私人目标', '私人提醒']) assert.ok(!JSON.stringify(group.data).includes(leak), leak);
});
