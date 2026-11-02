import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';

const secret = 'ab'.repeat(32);
// 15:00Z is 23:00 in Shanghai, still 2026-11-02 there.
const NOW = Date.parse('2026-11-02T15:00:00Z');
const HABIT_COLUMNS = ['habit_id', 'name', 'identity', 'trigger', 'minimum_action', 'created_at', 'updated_at'];
const COMPLETION_COLUMNS = ['habit_id', 'date', 'note', 'source', 'created_at'];

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

test('没有通行证、过期、篡改都是 401；POST 是 405；group 通行证拿到空的 tables 和 files', async () => {
  const s = await setup(), good = await s.cap(s.alice);
  await s.tool('save_habit', {name: '走路'}, good, 'toolu_1');
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
  assert.deepEqual(group.data.tables, {});
  assert.deepEqual(group.data.files, {});
  assert.ok(!JSON.stringify(group.data).includes('走路'));
});
