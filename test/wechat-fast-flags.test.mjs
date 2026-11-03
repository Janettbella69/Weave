// What the answer to /api/internal/wechat/events says to the bridge: wake:true when the event queued something for the Agent,
// outbound:true when it queued a message to send. Each field is present only when true, so an older bridge sees the same answers
// as before. Fake Agent service, fake D1, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/wechat-sdk.mjs';

const flags = data => ({wake: data.wake, outbound: data.outbound});
const noFlags = {wake: undefined, outbound: undefined};
const wake = {wake: true, outbound: undefined};
const outbound = {wake: undefined, outbound: true};
const bothAbsent = data => assert.ok(!('wake' in data) && !('outbound' in data), JSON.stringify(data));

test('private chat: a bound person\'s message says wake; a stranger\'s, a stale one and a repeat say nothing', async () => {
  const h = await setup();
  const stranger = await h.bridge('events', h.message('hi'));
  assert.equal(stranger.data.ignored, true);
  bothAbsent(stranger.data);
  await h.bind();
  const hello = h.message('你好');
  const first = await h.bridge('events', hello);
  assert.equal(first.data.queued, true);
  assert.deepEqual(flags(first.data), wake);
  const again = await h.bridge('events', hello);
  assert.equal(again.data.duplicate, true);
  bothAbsent(again.data);
  const stale = await h.bridge('events', h.message('昨晚的私聊', {createdAt: new Date(h.now - 7 * 3600_000).toISOString()}));
  assert.equal(stale.data.stale, true);
  bothAbsent(stale.data);
  for (const over of [{type: 3}, {direction: 'outgoing'}, {body: ''}]) bothAbsent((await h.bridge('events', h.message('你好', over))).data);
});

test('binding: the confirmation that is queued says outbound, and no wake', async () => {
  const h = await setup();
  const bound = await h.bind();
  assert.equal(bound.data.bound, true);
  assert.deepEqual(flags(bound.data), outbound);
  assert.equal((await h.bridge('claim', {})).data.jobs.length, 1);
});

test('groups: enabling, refusing and closing say outbound; an @ in an enabled group says wake; chatter, a repeat, 别记 and the daily limit say nothing', async () => {
  const h = await setup();
  const denied = await h.bridge('events', h.group('wxid-bob', '@助理 开启打卡群', true));
  assert.equal(denied.data.denied, true);
  assert.deepEqual(flags(denied.data), outbound);
  await h.bind();
  const enabled = await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true));
  assert.equal(enabled.data.enabled, true);
  assert.deepEqual(flags(enabled.data), outbound);
  const already = await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true));
  assert.equal(already.data.enabled, true);
  bothAbsent(already.data);                            // nothing new was queued this time
  const chatter = await h.bridge('events', h.group('wxid-bob', '今天走了八千步'));
  assert.equal(chatter.data.stored, true);
  bothAbsent(chatter.data);
  const question = h.group('wxid-bob', '@助理 我们这周怎么样', true);
  const asked = await h.bridge('events', question);
  assert.equal(asked.data.queued, true);
  assert.deepEqual(flags(asked.data), wake);
  const repeat = await h.bridge('events', question);
  assert.equal(repeat.data.duplicate, true);
  bothAbsent(repeat.data);
  const forget = await h.bridge('events', h.group('wxid-bob', '@助理 别记 我今天情绪很差', true));
  assert.equal(forget.data.skipped, true);
  bothAbsent(forget.data);
  let many;
  for (let i = 0; i < 31; i++) many = await h.bridge('events', h.group('wxid-bob', '@助理 第' + i + '次', true));
  assert.equal(many.data.limited, undefined);      // no daily cap on group replies
  assert.equal(many.data.queued, true);
  assert.deepEqual(flags(many.data), wake);
  const closed = await h.bridge('events', h.group('wxid-bob', '@助理 关闭打卡群', true));
  assert.equal(closed.data.closed, true);
  assert.deepEqual(flags(closed.data), outbound);
  const after = await h.bridge('events', h.group('wxid-bob', '继续说话'));
  assert.equal(after.data.ignored, true);              // a group that is not enabled: dropped
  bothAbsent(after.data);
});

test('the hints are true exactly when a tick would find work and a claim would find a message', async () => {
  const h = await setup();
  const events = () => [
    ['a stranger says hi', h.message('hi')],
    ['the binding', null],
    ['a bound person says hi', h.message('你好')],
    ['enable the group', h.group('wxid-alice', '@助理 开启打卡群', true)],
    ['group chatter', h.group('wxid-bob', '今天走了八千步')],
    ['an @ in the group', h.group('wxid-bob', '@助理 这周怎么样', true)],
    ['a repeat of that @', null],
  ];
  let previous;
  const rows = [];
  for (const [name, message] of events()) {
    let answer;
    if (name === 'the binding') answer = await h.bind();
    else if (name === 'a repeat of that @') answer = await h.bridge('events', previous);
    else answer = await h.bridge('events', message);
    previous = message;
    const processed = (await h.tick()).data.processed, jobs = (await h.bridge('claim', {})).data.jobs.length;
    rows.push({name, wake: answer.data.wake === true, outbound: answer.data.outbound === true, work: processed > 0, sends: jobs > 0});
  }
  for (const row of rows) {
    assert.equal(row.wake, row.work, `${row.name}: wake ${row.wake}, a tick found work ${row.work}`);
    if (row.name !== 'a bound person says hi' && row.name !== 'an @ in the group') assert.equal(row.outbound, row.sends, `${row.name}: outbound ${row.outbound}, a claim found a message ${row.sends}`);
  }
  // after a wake the tick queues the reply itself; the bridge delivers it once the tick returns, so the answer to the event did not need to say outbound
  const wakes = rows.filter(row => row.wake).map(row => row.name);
  assert.deepEqual(wakes, ['a bound person says hi', 'an @ in the group']);
});

test('claim and receipt answers carry no hints, and the fields the bridge already reads are unchanged', async () => {
  const h = await setup();
  await h.bind();
  const claim = await h.bridge('claim', {});
  assert.deepEqual(Object.keys(claim.data), ['jobs']);
  const receipt = await h.bridge('receipt', {id: claim.data.jobs[0].id, state: 'accepted'});
  assert.deepEqual(receipt.data, {ok: true});
  const message = await h.bridge('events', h.message('你好'));
  assert.deepEqual(Object.keys(message.data).sort(), ['accepted', 'queued', 'wake']);
  assert.equal(message.data.accepted, true);
});
