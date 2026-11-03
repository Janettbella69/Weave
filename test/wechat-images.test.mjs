// WeChat photos on the Weave side (docs/superpowers/specs/2026-11-03-wechat-images-design.md): the server switch
// WEAVE_WECHAT_IMAGES, the photo:'ready'/'watch' fields on /events, the /photo route, the short-lived photo store and the
// wake that carries the photo. Fake Agent service, fake D1, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {GROUP_ENABLED_TEXT, GROUP_PHOTO_TEXT} from '../hosted/lib/weave/wechat.mjs';
import {PHOTO_MAX_BYTES, PHOTO_TTL_MS, putPhoto, takePhoto} from '../hosted/lib/weave/wechat-photos.mjs';
import {REPLIES} from '../hosted/lib/weave/dispatcher.mjs';
import {setup, reply, ok, secret, ROOM, SERVICE, SERVICE_TOKEN} from './helpers/wechat-sdk.mjs';

// A JPEG as far as anyone here can tell (only the first bytes are checked), with bytes unique enough to search for.
const jpeg = (size = 6000, seed = 3) => { const b = new Uint8Array(size); let x = seed; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16 & 0xff; } b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const PHOTO = jpeg(), PHOTO64 = Buffer.from(PHOTO).toString('base64');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const photoRows = h => { try { return h.db.sql.prepare('SELECT COUNT(*) AS n FROM weave_wechat_photos').get().n; } catch { return 0; } };
const tableExists = h => !!h.db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='weave_wechat_photos'").get();
// Everything the world keeps, as one string: no photo may ever be in it.
const worldDump = h => JSON.stringify(h.db.sql.prepare('SELECT document FROM weave_documents').all());
const assertNoPhotoInWorld = h => { const dump = worldDump(h); assert.ok(!dump.includes(PHOTO64.slice(0, 64)) && !dump.includes(Buffer.from(PHOTO).toString('hex').slice(0, 64)), 'a photo is in the world'); };
const keysOf = data => Object.keys(data).sort();
const entryOf = async (h, messageId) => (await h.read()).wechat['in:' + await hash(messageId)];

test('flag off: photo:\'ready\' and \'watch\' on /events change nothing; the answer, the queue and the wake body are exactly as for plain text', async () => {
  for (const photo of ['ready', 'watch']) {
    const h = await setup();
    await h.bind();
    const plain = await h.bridge('events', h.message('你好'));
    const marked = await h.bridge('events', h.message('这顿多少卡', {photo}));
    assert.deepEqual(keysOf(marked.data), ['accepted', 'queued', 'wake']);
    assert.deepEqual(keysOf(plain.data), keysOf(marked.data));
    assert.equal((await entryOf(h, 'msg_3')).status, 'queued');
    assert.equal((await h.tick()).data.processed, 2);
    for (const wake of h.wakes()) {
      const {capability, ...body} = wake.body;
      assert.deepEqual(keysOf(body), ['id', 'localDate', 'model', 'provider', 'scope', 'trigger']);
      assert.deepEqual(keysOf(body.trigger), ['at', 'channel', 'direct', 'kind', 'text']);
    }
    assert.equal(tableExists(h), false, 'the photo table must not even be created while the switch is off');
  }
});

test('flag off: /photo is not a route, it answers like any unknown path; and a group is opened with exactly today\'s text', async () => {
  const h = await setup();
  const unknown = await h.bridge('nothing-here', {for: 'msg_1'}), json = await h.bridge('photo', {for: 'msg_1', none: 'none'});
  assert.deepEqual(json, unknown);
  const raw = await h.photo('msg_1', PHOTO), rawUnknown = await h.call(null, 'internal/wechat/nothing-here', undefined);
  assert.equal(raw.status, 415);
  assert.notEqual(rawUnknown.status, 200);
  await h.enableGroup();
  const texts = (await h.read()).wechat;
  assert.ok(Object.values(texts).every(entry => !entry.text?.includes(GROUP_PHOTO_TEXT)));
  assert.equal(tableExists(h), false);
});

test('flag on but the old (non-SDK) runtime: no photo hints, plain text behaviour', async () => {
  const h = await setup({runtime: '', images: true});
  await h.bind();
  const answer = await h.bridge('events', h.message('这顿多少卡', {photo: 'ready'}));
  assert.equal(answer.data.queued, true);
  assert.ok(!('photo' in answer.data));
  assert.equal((await h.photo('msg_2', PHOTO)).status, 415, '/photo does not exist on this runtime');
});

test('private chat, photo first: the owner\'s text is held, the answer asks for the photo, the wake carries it on deepseek-flash, and it is deleted when the turn starts', async () => {
  const h = await setup({images: true, agent: async () => reply('大约 600 千卡')});
  assert.equal((await h.call('alice', 'settings', {model: 'deepseek-v4-pro'})).status, 200);
  await h.bind();
  await h.bridge('claim', {});
  const text = h.message('这顿多少卡', {photo: 'ready'});
  const answer = await h.bridge('events', text);
  assert.deepEqual(answer.data, {accepted: true, queued: true, photo: 'upload'});
  assert.equal((await entryOf(h, text.id)).status, 'awaiting-photo');
  assert.equal((await h.tick()).data.processed, 0, 'nothing starts while the photo is on its way');
  const sent = await h.photo(text.id, PHOTO);
  assert.deepEqual(sent.data, {accepted: true, attached: true, wake: true});
  assert.equal(photoRows(h) > 0, true);
  assertNoPhotoInWorld(h);
  assert.equal((await h.tick()).data.processed, 1);
  const body = h.wakes()[0].body;
  assert.equal(body.model, 'deepseek-flash', 'a photo turn runs on the model that can see it');
  assert.deepEqual(body.image, {mediaType: 'image/jpeg', data: PHOTO64});
  assert.equal(body.trigger.text, '这顿多少卡');
  assert.equal(photoRows(h), 0, 'the photo is deleted once the turn has it');
  const person = (await h.read()).people[h.id];
  assert.deepEqual(person.messages.filter(m => m.role === 'user').map(m => m.text), ['这顿多少卡']);
  assertNoPhotoInWorld(h);
  const jobs = (await h.bridge('claim', {})).data.jobs;
  assert.deepEqual(jobs.map(j => j.text), ['大约 600 千卡']);
});

test('private chat, text first: \'watch\' holds the turn; the bridge says there is no photo and it starts at once without one', async () => {
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('帮我看看这个', {photo: 'watch'});
  assert.deepEqual((await h.bridge('events', text)).data, {accepted: true, queued: true, photo: 'watch'});
  assert.equal((await h.tick()).data.processed, 0);
  assert.deepEqual((await h.bridge('photo', {for: text.id, none: 'none'})).data, {accepted: true, attached: false, wake: true});
  assert.equal((await h.tick()).data.processed, 1);
  assert.ok(!('image' in h.wakes()[0].body));
  assert.equal(h.wakes()[0].body.model, 'deepseek-flash');
});

test('private chat, text first: the photo comes within the wait and is attached', async () => {
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('帮我看看这个', {photo: 'watch'});
  await h.bridge('events', text);
  assert.equal((await h.photo(text.id, PNG, {type: 'image/png'})).data.attached, true);
  await h.tick();
  assert.deepEqual(h.wakes()[0].body.image, {mediaType: 'image/png', data: Buffer.from(PNG).toString('base64')});
});

test('if the bridge never answers, the held turn starts by itself after 30 s, without a photo', async () => {
  const h = await setup({images: true});
  await h.bind();
  await h.bridge('events', h.message('这顿多少卡', {photo: 'ready'}));
  h.setNow(h.now + 29_000);
  assert.equal((await h.tick()).data.processed, 0);
  h.setNow(h.now + 2_000);
  assert.equal((await h.tick()).data.processed, 1);
  assert.ok(!('image' in h.wakes()[0].body));
});

test('a stranger in private chat: no photo hint, and a photo sent for that message is not stored', async () => {
  const h = await setup({images: true});
  const text = h.message('看看这张', {photo: 'ready', threadId: 'wxid-stranger', senderId: 'wxid-stranger'});
  const answer = await h.bridge('events', text);
  assert.equal(answer.data.ignored, true);
  assert.ok(!('photo' in answer.data));
  assert.deepEqual((await h.photo(text.id, PHOTO, {thread: 'wxid-stranger'})).data, {accepted: true, ignored: true});
  assert.equal(photoRows(h), 0);
  assert.equal(tableExists(h), false);
});

test('a photo from someone else, or from another chat, is not stored; that turn goes on without a photo', async () => {
  for (const wrong of [{thread: 'wxid-bob', sender: 'wxid-bob'}, {thread: 'wxid-alice', sender: 'wxid-bob'}, {thread: ROOM, sender: 'wxid-alice'}]) {
    const h = await setup({images: true});
    await h.bind();
    const text = h.message('这顿多少卡', {photo: 'ready'});
    await h.bridge('events', text);
    assert.deepEqual((await h.photo(text.id, PHOTO, wrong)).data, {accepted: true, attached: false, wake: true}, JSON.stringify(wrong));
    assert.equal(photoRows(h), 0);
    await h.tick();
    assert.ok(!('image' in h.wakes()[0].body));
  }
});

test('group, photo first: an @ in an enabled group with photo:\'ready\' gets its photo into a group-scope wake; nothing of it is kept anywhere', async () => {
  const h = await setup({images: true, agent: async () => reply('看起来是一份沙拉')});
  await h.enableGroup();
  await h.bridge('events', h.group('wxid-bob', '今天走了八千步', false, {photo: 'ready'}));
  const ask = h.group('wxid-bob', '@助理 这顿多少卡', true, {photo: 'ready'});
  assert.deepEqual((await h.bridge('events', ask)).data, {accepted: true, queued: true, photo: 'upload'});
  assert.equal((await h.photo(ask.id, PHOTO, {thread: ROOM, sender: 'wxid-bob'})).data.attached, true);
  assert.equal((await h.tick()).data.processed, 1);
  const body = h.wakes()[0].body;
  assert.equal(body.scope, 'group');
  assert.equal(body.trigger.text, '成员1：这顿多少卡');
  assert.deepEqual(body.image, {mediaType: 'image/jpeg', data: PHOTO64});
  assert.equal(photoRows(h), 0);
  const job = (await h.bridge('claim', {})).data.jobs.find(j => j.threadId === ROOM && j.text === '看起来是一份沙拉');
  assert.deepEqual(job.mentions, {userIds: ['wxid-bob']});
  assertNoPhotoInWorld(h);
});

test('group: the opening text gets the photo sentence only when the switch is on', async () => {
  for (const images of [false, true]) {
    const h = await setup({images});
    await h.bind();
    await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true));
    const jobs = (await h.bridge('claim', {})).data.jobs.filter(j => j.threadId === ROOM);
    assert.deepEqual(jobs.map(j => j.text), [images ? GROUP_ENABLED_TEXT + GROUP_PHOTO_TEXT : GROUP_ENABLED_TEXT]);
  }
});

test('a group that is not enabled: an @ with a photo is dropped, nothing is stored, and a photo sent anyway is refused', async () => {
  const h = await setup({images: true});
  await h.bind();
  const ask = h.group('wxid-bob', '@助理 这顿多少卡', true, {photo: 'ready'});
  const answer = await h.bridge('events', ask);
  assert.equal(answer.data.ignored, true);
  assert.ok(!('photo' in answer.data));
  assert.deepEqual((await h.photo(ask.id, PHOTO, {thread: ROOM, sender: 'wxid-bob'})).data, {accepted: true, ignored: true});
  assert.equal(tableExists(h), false);
  assert.ok(!worldDump(h).includes(await hash(ask.id)));
});

test('group: 别记 with a photo, and chatter without an @, get no photo hint and store no photo', async () => {
  const h = await setup({images: true});
  await h.enableGroup();
  const skip = await h.bridge('events', h.group('wxid-bob', '@助理 别记 这顿吃多了', true, {photo: 'ready'}));
  assert.equal(skip.data.skipped, true);
  assert.ok(!('photo' in skip.data));
  const chatter = await h.bridge('events', h.group('wxid-bob', '这是午饭', false, {photo: 'ready'}));
  assert.equal(chatter.data.stored, true);
  assert.ok(!('photo' in chatter.data));
  assert.equal((await h.photo(h.group('wxid-bob', 'x').id, PHOTO, {thread: ROOM, sender: 'wxid-bob'})).data.ignored, true);
  assert.equal(tableExists(h), false);
});

test('closing the group while a photo waits deletes the waiting message and its photo', async () => {
  const h = await setup({images: true});
  await h.enableGroup();
  const ask = h.group('wxid-bob', '@助理 这顿多少卡', true, {photo: 'watch'});
  await h.bridge('events', ask);
  // the photo arrived, but the turn has not started yet
  await h.photo(ask.id, PHOTO, {thread: ROOM, sender: 'wxid-bob'});
  assert.equal(photoRows(h) > 0, true);
  await h.bridge('events', h.group('wxid-carol', '@助理 关闭打卡群', true));
  assert.equal(photoRows(h), 0);
  assert.equal(await entryOf(h, ask.id), undefined);
  assert.equal((await h.tick()).data.processed, 0);
});

test('size and format: too big, not an image, or not what it says it is: not stored, and the turn goes on without it', async () => {
  const big = jpeg(PHOTO_MAX_BYTES + 1), exact = jpeg(PHOTO_MAX_BYTES);
  const cases = [[big, 'image/jpeg'], [new TextEncoder().encode('<svg/>'), 'image/svg+xml'], [PNG, 'image/jpeg'], [new Uint8Array([1, 2, 3, 4]), 'image/png'], [new Uint8Array(0), 'image/jpeg']];
  for (const [bytes, type] of cases) {
    const h = await setup({images: true});
    await h.bind();
    const text = h.message('这顿多少卡', {photo: 'ready'});
    await h.bridge('events', text);
    assert.deepEqual((await h.photo(text.id, bytes, {type})).data, {accepted: true, attached: false, wake: true}, type + ' ' + bytes.length);
    assert.equal(photoRows(h), 0);
    await h.tick();
    assert.ok(!('image' in h.wakes()[0].body));
  }
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('这顿多少卡', {photo: 'ready'});
  await h.bridge('events', text);
  assert.equal((await h.photo(text.id, exact)).data.attached, true, 'exactly 2 MiB is still taken');
  await h.tick();
  assert.equal(Buffer.from(h.wakes()[0].body.image.data, 'base64').length, PHOTO_MAX_BYTES);
  assert.equal(photoRows(h), 0);
});

test('the photo is deleted whatever the turn does: success, an Agent service error, busy, or a dropped connection', async () => {
  const outcomes = [async () => reply('好'), async () => new Response('{}', {status: 500}), async () => new Response('{}', {status: 429}), async () => { throw Error('connection reset'); }];
  for (const agent of outcomes) {
    const h = await setup({images: true, agent});
    await h.bind();
    const text = h.message('这顿多少卡', {photo: 'ready'});
    await h.bridge('events', text);
    await h.photo(text.id, PHOTO);
    assert.ok(photoRows(h) > 0);
    await h.tick();
    assert.equal(h.wakes().length, 1);
    assert.equal(photoRows(h), 0);
    assertNoPhotoInWorld(h);
    assert.notEqual((await entryOf(h, text.id)).status, 'processing');
  }
});

test('one photo per turn: a second photo for the same message is not taken, and the message is answered once', async () => {
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('这顿多少卡', {photo: 'ready'});
  await h.bridge('events', text);
  assert.equal((await h.photo(text.id, PHOTO)).data.attached, true);
  assert.deepEqual((await h.photo(text.id, PNG, {type: 'image/png'})).data, {accepted: true, ignored: true});
  assert.equal((await h.tick()).data.processed, 1);
  assert.equal((await h.tick()).data.processed, 0);
  assert.equal(h.wakes().length, 1);
  assert.equal(h.wakes()[0].body.image.mediaType, 'image/jpeg');
});

test('the store: a photo is sealed, comes back once, and an unused one is gone after 10 minutes (swept on the next tick)', async () => {
  const h = await setup({images: true});
  const id = await putPhoto(h.db, {bytes: PHOTO, mediaType: 'image/jpeg'}, {secret, now: h.now});
  const stored = JSON.stringify(h.db.sql.prepare('SELECT * FROM weave_wechat_photos').all());
  assert.ok(!stored.includes(PHOTO64.slice(0, 64)), 'stored in the clear');
  assert.deepEqual(await takePhoto(h.db, id, {secret, now: h.now}), {mediaType: 'image/jpeg', data: PHOTO64, bytes: PHOTO.length});
  assert.equal(await takePhoto(h.db, id, {secret, now: h.now}), null, 'a photo can be taken once');
  const late = await putPhoto(h.db, {bytes: PHOTO, mediaType: 'image/jpeg'}, {secret, now: h.now});
  h.setNow(h.now + PHOTO_TTL_MS);
  await h.tick();
  assert.equal(photoRows(h), 0);
  assert.equal(await takePhoto(h.db, late, {secret, now: h.now}), null);
});

test('a big photo is split over several rows and comes back whole', async () => {
  const h = await setup({images: true});
  const big = jpeg(PHOTO_MAX_BYTES, 9);
  const id = await putPhoto(h.db, {bytes: big, mediaType: 'image/jpeg'}, {secret, now: h.now});
  assert.ok(photoRows(h) >= 3, 'rows: ' + photoRows(h));
  const back = await takePhoto(h.db, id, {secret, now: h.now});
  assert.equal(back.bytes, big.length);
  assert.ok(Buffer.from(back.data, 'base64').equals(Buffer.from(big)));
  assert.equal(photoRows(h), 0);
});

test('the photo goes to the Agent service only inside /wake, with the service token; nothing else is called', async () => {
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('这顿多少卡', {photo: 'ready'});
  await h.bridge('events', text);
  await h.photo(text.id, PHOTO);
  await h.tick();
  assert.deepEqual(h.calls.map(c => c.path), ['/wake']);
  assert.equal(h.calls[0].auth, 'Bearer ' + SERVICE_TOKEN);
  assert.ok(SERVICE.startsWith('https://'));
  assert.equal(typeof ok, 'function');
  assert.equal(REPLIES.busy.length > 0, true);
});
