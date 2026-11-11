// Private chat over iLink (hosted/ilink-bridge): the official WeChat channel for agents, beside the alt-account bridge.
// Both bridges use the same internal API; the iLink one says X-Weave-Channel: ilink. A person's private chat lives on the
// channel they bound on, so only that bridge gets their messages to send; groups stay on the alt account.
// A photo in private chat is a message of its own (POST /api/internal/wechat/image): it wakes the Agent with the photo.
// Fake Agent service, fake D1, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {PHOTO_MAX_BYTES} from '../hosted/lib/weave/wechat-photos.mjs';
import {PHOTO_MESSAGE_TEXT, PHOTO_UNREADABLE_TEXT} from '../hosted/lib/weave/wechat.mjs';
import {setup, reply, ROOM, ILINK_ALICE} from './helpers/wechat-sdk.mjs';

const jpeg = (size = 6000, seed = 5) => { const b = new Uint8Array(size); let x = seed; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16 & 0xff; } b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const PHOTO = jpeg(), PHOTO64 = Buffer.from(PHOTO).toString('base64');
const photoRows = h => { try { return h.db.sql.prepare('SELECT COUNT(*) AS n FROM weave_wechat_photos').get().n; } catch { return 0; } };
const worldDump = h => JSON.stringify(h.db.sql.prepare('SELECT document FROM weave_documents').all());
const jobsOf = async (h, channel) => (await (channel === 'ilink' ? h.ilink('claim', {}) : h.bridge('claim', {}))).data.jobs;

test('bound over iLink: the confirmation and every reply go to the iLink bridge only', async () => {
  const h = await setup({agent: async () => reply('今天也辛苦了')});
  await h.bindIlink();
  assert.deepEqual(await jobsOf(h, 'wx'), [], 'the alt-account bridge must not get an iLink person\'s messages');
  const [confirmation] = await jobsOf(h, 'ilink');
  assert.equal(confirmation.threadId, ILINK_ALICE);
  await h.ilink('receipt', {id: confirmation.id, state: 'accepted'});

  const answer = await h.ilink('events', h.ilinkMessage('今天走了 8000 步'));
  assert.equal(answer.data.queued, true);
  assert.equal((await h.ilink('tick', {})).status, 200);
  assert.equal(h.wakes().at(-1).body.trigger.text, '今天走了 8000 步');
  assert.deepEqual(await jobsOf(h, 'wx'), []);
  const [job] = await jobsOf(h, 'ilink');
  assert.deepEqual({threadId: job.threadId, text: job.text}, {threadId: ILINK_ALICE, text: '今天也辛苦了'});
});

test('binding over iLink moves private chat off the alt account; groups stay with the alt-account bridge', async () => {
  const h = await setup({agent: async () => reply('收到')});
  await h.enableGroup();
  await h.bindIlink();
  await h.ilink('claim', {});

  // The old wxid is no longer bound: a private message from it over the alt account wakes nothing and gets no answer.
  await h.bridge('events', h.message('还在吗'));
  await h.bridge('tick', {});
  assert.equal(h.wakes().length, 0);

  // An @ in the group that was opened before still works, and its answer is the alt-account bridge's to send.
  await h.bridge('events', h.group('wxid-bob', '@助理 今天打卡了', true));
  await h.bridge('tick', {});
  assert.equal(h.wakes().length, 1);
  assert.deepEqual(await jobsOf(h, 'ilink'), [], 'the iLink bridge must never get a group message');
  const [groupJob] = await jobsOf(h, 'wx');
  assert.equal(groupJob.threadId, ROOM);
});

test('iLink is private only: a group-looking thread from the iLink bridge is ignored', async () => {
  const h = await setup();
  await h.bindIlink();
  const answer = await h.ilink('events', h.group(ILINK_ALICE, '@助理 开启打卡群', true));
  assert.equal(answer.data.ignored, true);
});

test('a photo from the owner over iLink is a message of its own: it wakes the Agent with it on the vision model, then the photo is gone', async () => {
  const h = await setup({agent: async () => reply('看起来是一碗沙拉')});
  assert.equal((await h.call('alice', 'settings', {model: 'deepseek-v4-pro'})).status, 200);
  await h.bindIlink();
  await h.ilink('claim', {});

  const answer = await h.image('img_1', PHOTO);
  assert.deepEqual(answer.data, {accepted: true, queued: true, wake: true});
  assert.equal(photoRows(h), 1);
  assert.ok(!worldDump(h).includes(PHOTO64.slice(0, 64)), 'the photo itself is never in the world');

  await h.ilink('tick', {});
  const wake = h.wakes().at(-1);
  assert.equal(wake.body.model, 'deepseek-flash');
  assert.deepEqual(wake.body.image, {mediaType: 'image/jpeg', data: PHOTO64});
  assert.equal(wake.body.trigger.text, PHOTO_MESSAGE_TEXT);
  assert.equal(wake.body.trigger.channel, 'wechat');
  assert.equal(photoRows(h), 0, 'the photo is deleted once the turn has it');

  const [job] = await jobsOf(h, 'ilink');
  assert.equal(job.text, '看起来是一碗沙拉');
  const messages = (await h.read()).people[h.id].messages;
  assert.ok(messages.some(m => m.role === 'user' && m.text === PHOTO_MESSAGE_TEXT), 'her chat shows that she sent a photo');
});

test('the same photo message delivered twice is used once', async () => {
  const h = await setup();
  await h.bindIlink();
  assert.equal((await h.image('img_1', PHOTO)).data.queued, true);
  assert.deepEqual((await h.image('img_1', PHOTO)).data, {accepted: true, duplicate: true});
  assert.equal(photoRows(h), 1);
});

test('a photo from someone who is not bound is dropped: nothing stored, nothing woken, nothing said', async () => {
  const h = await setup();
  const answer = await h.image('img_1', PHOTO, {sender: 'stranger@im.wechat'});
  assert.deepEqual(answer.data, {accepted: true, ignored: true});
  assert.equal(photoRows(h), 0);
  await h.ilink('tick', {});
  assert.equal(h.wakes().length, 0);
  assert.deepEqual(await jobsOf(h, 'ilink'), []);
});

test('a photo for a person whose private chat is on the alt account is not taken from the iLink bridge', async () => {
  const h = await setup();
  await h.bind();
  const answer = await h.image('img_1', PHOTO, {sender: 'wxid-alice'});
  assert.deepEqual(answer.data, {accepted: true, ignored: true});
  assert.equal(photoRows(h), 0);
});

test('too big or not an image: not stored, no wake, and the owner is told in one short line', async () => {
  for (const [bytes, type] of [[jpeg(PHOTO_MAX_BYTES + 1), 'image/jpeg'], [new TextEncoder().encode('not a photo at all'), 'image/jpeg']]) {
    const h = await setup();
    await h.bindIlink();
    await h.ilink('claim', {});
    const answer = await h.image('img_x', bytes, {type});
    assert.equal(answer.data.accepted, true);
    assert.ok(answer.data.rejected);
    assert.equal(photoRows(h), 0);
    await h.ilink('tick', {});
    assert.equal(h.wakes().length, 0);
    const [job] = await jobsOf(h, 'ilink');
    assert.equal(job.text, PHOTO_UNREADABLE_TEXT);
  }
});

test('an old photo (more than 6 hours late, like old text) is not answered', async () => {
  const h = await setup();
  await h.bindIlink();
  const answer = await h.image('img_old', PHOTO, {createdAt: new Date(h.now - 7 * 3600_000).toISOString()});
  assert.deepEqual(answer.data, {accepted: true, stale: true});
  assert.equal(photoRows(h), 0);
});

test('photo messages need the Agent SDK runtime (the photo goes to the model through the Agent service)', async () => {
  const h = await setup({runtime: ''});
  assert.equal((await h.image('img_1', PHOTO)).status, 404);
});

test('a photo message needs the bridge token like everything else', async () => {
  const h = await setup();
  await h.bindIlink();
  const {handleAPI} = await import('../hosted/lib/weave/api.mjs');
  const r = await handleAPI(new Request('https://weave.example/api/internal/wechat/image', {method: 'POST', headers: {'Content-Type': 'image/jpeg', 'X-Weave-Channel': 'ilink', 'X-Weave-Message': 'img_1', 'X-Weave-Sender': ILINK_ALICE}, body: PHOTO}), {...h.options(), identity: null});
  assert.equal(r.status, 401);
  assert.equal(photoRows(h), 0);
});

test('online is about the bridge of the person\'s own channel', async () => {
  const h = await setup();
  await h.bindIlink();
  let binding = (await h.call('alice', 'wechat')).data.binding;
  assert.equal(binding.bound, true);
  assert.equal(binding.channel, 'ilink');
  assert.equal(binding.online, true, 'the iLink bridge was just heard from');
  h.setNow(h.now + 10 * 60_000);
  await h.bridge('claim', {});
  binding = (await h.call('alice', 'wechat')).data.binding;
  assert.equal(binding.online, false, 'only the alt-account bridge was heard from lately');
  await h.ilink('claim', {});
  binding = (await h.call('alice', 'wechat')).data.binding;
  assert.equal(binding.online, true);
});

test('an entry id is the message id hashed, so text and photo with distinct ids never collide', async () => {
  const h = await setup();
  await h.bindIlink();
  await h.ilink('events', h.ilinkMessage('先发一句', {id: 'm1'}));
  await h.image('m2', PHOTO);
  const world = await h.read();
  assert.equal(world.wechat['in:' + await hash('m1')].text, '先发一句');
  assert.equal(world.wechat['in:' + await hash('m2')].text, PHOTO_MESSAGE_TEXT);
});
