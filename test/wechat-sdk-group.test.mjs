// Check-in groups on the Agent SDK path: a group wake is group scope. It sees the group's own
// records and nothing from anyone's personal space. Fake Agent service, fake D1, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../hosted/lib/weave/store.mjs';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {issueCapability, verifyCapability} from '../hosted/lib/weave/capability.mjs';
import {REPLIES} from '../hosted/lib/weave/dispatcher.mjs';
import {groupSnapshotMessages} from '../hosted/lib/weave/wechat.mjs';
import {setup, reply, ok, secret, ROOM} from './helpers/wechat-sdk.mjs';

const groupCapability = async (h, over = {}) => issueCapability(secret, {owner: h.id, scope: 'group', runId: 'run-g', channel: 'wechat', direct: true, group: await hash(ROOM), ...over}, h.now);
const ownerCapability = (h, over = {}) => issueCapability(secret, {owner: h.id, scope: 'owner', runId: 'run-o', channel: 'wechat', direct: true, ...over}, h.now);
async function addPrivateThings(h) {
  const store = new Store(h.db), world = await store.load(), alice = world.people[h.id];
  alice.profile.goal = 'PRIVATE_GOAL_减到50公斤';
  alice.checkins.push({id: 'c1', text: 'PRIVATE_FEEDBACK', createdAt: new Date(h.now).toISOString()});
  alice.messages.push({id: 'm1', role: 'user', text: 'PRIVATE_CHAT', createdAt: new Date(h.now).toISOString()});
  await store.save(world);
}
const ask = async (h, text = '@助理 我们这周怎么样') => {
  await h.bridge('events', h.group('wxid-bob', '今天走了八千步'));
  return h.bridge('events', h.group('wxid-bob', text, true));
};
const groupJobs = async h => (await h.bridge('claim', {})).data.jobs.filter(j => j.threadId === ROOM);

test('an @ in an enabled group wakes the Agent in group scope, carrying only the group\'s own id and words', async () => {
  const h = await setup({agent: async () => reply('你们这周都在坚持')});
  await addPrivateThings(h);
  await h.enableGroup();
  assert.equal((await ask(h)).data.queued, true);
  assert.equal((await h.tick()).data.processed, 1);
  assert.deepEqual(h.calls.map(c => c.path), ['/wake']);
  const groupId = await hash(ROOM), {capability, ...body} = h.wakes()[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['id', 'localDate', 'model', 'provider', 'scope', 'trigger']);
  assert.equal(body.scope, 'group');
  assert.equal(body.id, groupId);
  assert.deepEqual(body.trigger, {kind: 'message', channel: 'group', direct: true, at: body.trigger.at, text: '成员1：我们这周怎么样'});
  const dump = JSON.stringify(body);
  for (const leak of ['PRIVATE_GOAL', 'PRIVATE_FEEDBACK', 'PRIVATE_CHAT', 'wxid-bob', 'wxid-alice', ROOM, 'Alice', 'alice@example.test', h.id, '@助理']) assert.ok(!dump.includes(leak), leak);
  const claims = await verifyCapability(secret, capability, h.now);
  assert.deepEqual({...claims, runId: undefined}, {owner: h.id, scope: 'group', runId: undefined, channel: 'wechat', direct: true, group: groupId, exp: h.now + 15 * 60_000});
});

test('the person who enabled the group pays: their own key and model are used', async () => {
  const h = await setup();
  assert.equal((await h.call('alice', 'settings', {apiKey: 'sk-own-key-123456', model: 'deepseek-v4-pro'})).status, 200);
  await h.enableGroup();
  await ask(h);
  await h.tick();
  const body = h.wakes()[0].body;
  assert.equal(body.userKey, 'sk-own-key-123456');
  assert.equal(body.model, 'deepseek-v4-pro');
});

test('the group reply goes to the group and mentions the asker; it is not written into anyone\'s personal memory', async () => {
  const h = await setup({agent: async () => reply('你们这周都在坚持')});
  await h.enableGroup();
  await ask(h);
  await h.tick();
  const jobs = await groupJobs(h), job = jobs.find(j => j.text === '你们这周都在坚持');
  assert.ok(job, JSON.stringify(jobs));
  assert.deepEqual(job.mentions, {userIds: ['wxid-bob']});
  const person = (await h.read()).people[h.id];
  for (const text of ['你们这周都在坚持', '我们这周怎么样', '八千步']) assert.ok(!JSON.stringify(person.messages).includes(text), text);
  await h.bridge('receipt', {id: job.id, state: 'accepted'});
  const dump = JSON.stringify((await h.read()).wechat);
  for (const text of ['你们这周都在坚持', '我们这周怎么样']) assert.ok(!dump.includes(text), text);
});

test('ordinary group chatter is stored as context and never wakes the Agent', async () => {
  const h = await setup();
  await h.enableGroup();
  await h.bridge('events', h.group('wxid-bob', '今天走了八千步'));
  assert.equal((await h.tick()).data.processed, 0);
  assert.deepEqual(h.calls, []);
});

test('a busy, unavailable or uncertain group wake still answers the asker in the group', async () => {
  for (const [agent, text, status] of [
    [async () => Response.json({}, {status: 429}), REPLIES.busy, 'replied'],
    [async () => Response.json({}, {status: 503}), REPLIES.unavailable, 'replied'],
    [async () => new Response('x', {status: 500}), REPLIES.uncertain, 'uncertain'],
  ]) {
    const h = await setup({agent});
    await h.enableGroup();
    await ask(h);
    await h.tick();
    await h.tick();
    assert.equal(h.wakes().length, 1);
    const job = (await groupJobs(h)).find(j => j.text === text);
    assert.ok(job, text);
    assert.deepEqual(job.mentions, {userIds: ['wxid-bob']});
    const entry = Object.values((await h.read()).wechat).find(x => x.direction === 'inbound' && x.source === 'group');
    assert.equal(entry.status, status);
    assert.equal(entry.payload, undefined);
  }
});

test('groupSnapshotMessages returns the group\'s recent messages as plain rows: sequence number, member number, text, ISO time', async () => {
  const h = await setup();
  await addPrivateThings(h);
  await h.enableGroup();
  await h.bridge('events', h.group('wxid-bob', '今天走了八千步'));
  await h.bridge('events', h.group('wxid-carol', '我也走了'));
  await h.bridge('events', h.group('wxid-bob', '别记 今天情绪很差'));
  const rows = await groupSnapshotMessages(await h.read(), {groupId: await hash(ROOM), ownerId: h.id, secret});
  assert.deepEqual(rows, [
    {seq: 1, member: '成员1', text: '今天走了八千步', at: '2030-01-01T00:00:00.000Z'},
    {seq: 2, member: '成员2', text: '我也走了', at: '2030-01-01T00:00:00.000Z'},
  ]);
  // The snapshot builder only accepts strings, numbers and null.
  for (const row of rows) for (const value of Object.values(row)) assert.ok(['string', 'number'].includes(typeof value));
  for (const leak of ['wxid-', ROOM, 'PRIVATE', 'Alice', '情绪很差']) assert.ok(!JSON.stringify(rows).includes(leak), leak);
});

test('groupSnapshotMessages gives only that group\'s rows, and nothing for a closed, unknown or someone else\'s group', async () => {
  const h = await setup();
  await h.enableGroup();
  await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true, {threadId: '999@chatroom'}));
  await h.bridge('events', h.group('wxid-bob', '这个群的消息'));
  await h.bridge('events', h.group('wxid-bob', '另一个群的消息', false, {threadId: '999@chatroom'}));
  const world = await h.read(), groupId = await hash(ROOM);
  assert.deepEqual((await groupSnapshotMessages(world, {groupId, ownerId: h.id, secret})).map(r => r.text), ['这个群的消息']);
  assert.deepEqual((await groupSnapshotMessages(world, {groupId: await hash('999@chatroom'), ownerId: h.id, secret})).map(r => r.text), ['另一个群的消息']);
  assert.deepEqual(await groupSnapshotMessages(world, {groupId, ownerId: 'u:somebody-else', secret}), []);
  assert.deepEqual(await groupSnapshotMessages(world, {groupId: 'not-a-group', ownerId: h.id, secret}), []);
  await h.bridge('events', h.group('wxid-bob', '@助理 关闭打卡群', true));
  assert.deepEqual(await groupSnapshotMessages(await h.read(), {groupId, ownerId: h.id, secret}), []);
});

test('a group capability cannot use personal tools', async () => {
  const h = await setup();
  await h.enableGroup();
  const token = await groupCapability(h);
  assert.equal((await h.tool('save_habit', {name: 'PRIVATE_HABIT'}, token)).status, 403);
  assert.equal((await h.tool('log_completion', {habit_id: 'h', date: '2030-01-01'}, token)).status, 403);
  assert.equal((await h.read()).people[h.id].habits, undefined);
});

test('send_message in a group run speaks to that group only, once per call, and has no daily cap', async () => {
  const h = await setup();
  await h.enableGroup();
  const token = await groupCapability(h);
  const first = await h.tool('send_message', {text: '补一句：大家都很棒'}, token, 'toolu_1');
  assert.deepEqual(first.data, {ok: true, text: '已发出。'});
  assert.deepEqual(await h.tool('send_message', {text: '补一句：大家都很棒'}, token, 'toolu_1'), first);
  const jobs = await groupJobs(h);
  assert.deepEqual(jobs.map(j => [j.threadId, j.text, j.mentions]), [[ROOM, '补一句：大家都很棒', undefined]]);
  assert.ok(!JSON.stringify((await h.read()).people[h.id].messages).includes('大家都很棒'));
  for (let i = 2; i <= 35; i++) assert.equal((await h.tool('send_message', {text: '第' + i + '次'}, token, 'toolu_' + i)).data.ok, true);
  const last = await h.tool('send_message', {text: '第三十六次'}, token, 'toolu_36');
  assert.deepEqual(last.data, {ok: true, text: '已发出。'});
});

test('an owner run on the wechat channel speaks to WeChat; on the web channel it does not', async () => {
  const h = await setup();
  await h.bind();
  await h.bridge('claim', {});
  assert.equal((await h.tool('send_message', {text: '先提醒你一句'}, await ownerCapability(h, {channel: 'wechat'}), 'toolu_w')).data.ok, true);
  assert.deepEqual((await h.bridge('claim', {})).data.jobs.map(j => [j.threadId, j.text]), [['wxid-alice', '先提醒你一句']]);
  assert.equal((await h.tool('send_message', {text: '网页上说一句'}, await ownerCapability(h, {channel: 'web'}), 'toolu_x')).data.ok, true);
  assert.deepEqual((await h.bridge('claim', {})).data.jobs, []);
  const person = (await h.read()).people[h.id];
  assert.deepEqual(person.messages.slice(-2).map(m => m.text), ['先提醒你一句', '网页上说一句']);
});

test('closing a group deletes its Agent workspace; a failed delete is retried on the next tick until it succeeds', async () => {
  let status = 500;
  const h = await setup({agent: async call => call.path === '/forget' ? Response.json({ok: status === 200}, {status}) : reply('好')});
  await h.enableGroup();
  await h.bridge('events', h.group('wxid-bob', '今天走了八千步'));
  assert.equal((await h.bridge('events', h.group('wxid-bob', '@助理 关闭打卡群', true))).data.closed, true);
  const forgets = () => h.calls.filter(c => c.path === '/forget').map(c => c.body);
  await h.tick();
  const groupId = await hash(ROOM);
  assert.deepEqual(forgets(), [{scope: 'group', id: groupId}]);
  assert.equal(Object.keys((await h.read()).runtime).filter(k => k.startsWith('wechat-forget:')).length, 1);
  status = 200;
  await h.tick();
  assert.deepEqual(forgets(), [{scope: 'group', id: groupId}, {scope: 'group', id: groupId}]);
  assert.equal(Object.keys((await h.read()).runtime).filter(k => k.startsWith('wechat-forget:')).length, 0);
  await h.tick();
  assert.equal(forgets().length, 2);
});

test('deleting the account also deletes the Agent workspaces of the groups it enabled, and keeps the account if one cannot be deleted', async () => {
  let groupStatus = 500;
  const h = await setup({agent: async call => call.path === '/forget' ? Response.json({ok: call.body.scope === 'owner' || groupStatus === 200}, {status: call.body.scope === 'owner' ? 200 : groupStatus}) : ok({})});
  await h.enableGroup();
  const failed = await h.call('alice', 'account/delete', {confirm: true});
  assert.equal(failed.status, 503);
  assert.ok((await h.read()).people[h.id]);
  groupStatus = 200;
  assert.equal((await h.call('alice', 'account/delete', {confirm: true})).status, 200);
  assert.equal((await h.read()).people[h.id], undefined);
  const groupId = await hash(ROOM);
  assert.ok(h.calls.some(c => c.path === '/forget' && c.body.scope === 'group' && c.body.id === groupId));
  assert.ok(h.calls.some(c => c.path === '/forget' && c.body.scope === 'owner' && c.body.id === h.id));
});

test('群里叫醒带的日期和时间按北京时间，不跟开启者的时区走', async () => {
  const h = await setup({agent: async () => reply('好')});
  const store = new Store(h.db), world = await store.load();
  world.people[h.id].profile.timezone = 'America/Los_Angeles';
  await store.save(world);
  await h.enableGroup();
  await ask(h);
  assert.equal((await h.tick()).data.processed, 1);
  const {body} = h.wakes()[0];
  // 2030-01-01T00:00Z：洛杉矶还是 2029-12-31 16:00，北京已经是 2030-01-01 08:00。
  assert.equal(body.localDate, '2030-01-01');
  assert.equal(body.trigger.at, '2030-01-01T08:00:00+08:00');
});
