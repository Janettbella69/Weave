// Fix round 1 of the photo review (docs/superpowers/specs/2026-11-03-wechat-images-design.md §12): photos count as on only
// when the Mac says so too; a group uses photos only after it was told; photo rows never outlive their message.
// Fake Agent service, fake D1, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {GROUP_ENABLED_TEXT, GROUP_PHOTO_TEXT, wechatPhotosShown} from '../hosted/lib/weave/wechat.mjs';
import {setup, reply, ROOM, bridgeToken, start, SERVICE_TOKEN} from './helpers/wechat-sdk.mjs';

const jpeg = (size = 4000) => { const b = new Uint8Array(size).fill(9); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const PHOTO = jpeg();
const photoRows = h => { try { return h.db.sql.prepare('SELECT COUNT(*) AS n FROM weave_wechat_photos').get().n; } catch { return 0; } };
const tableExists = h => !!h.db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='weave_wechat_photos'").get();
const groupRecord = async h => (await h.read()).runtime['wechat-group:' + await hash(ROOM)];
const groupTexts = jobs => jobs.filter(j => j.threadId === ROOM).map(j => j.text);
const ENV_ON = {WEAVE_WECHAT_IMAGES: '1', WEAVE_AGENT_RUNTIME: 'sdk'};

test('server on, Mac off: no photo sentence, no hints, nothing held or stored, and the privacy line stays hidden', async () => {
  const h = await setup({images: true, bridgePhotos: false});
  await h.bind();
  await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true, {photo: 'watch'}));
  assert.deepEqual(groupTexts(await h.deliverAll()), [GROUP_ENABLED_TEXT]);
  const ask = await h.bridge('events', h.group('wxid-bob', '@助理 这顿多少卡', true, {photo: 'ready'}));
  assert.equal(ask.data.queued, true);
  assert.ok(!('photo' in ask.data));
  assert.equal(ask.data.wake, true, 'an ordinary turn, not held');
  const mine = await h.bridge('events', h.message('这顿多少卡', {photo: 'ready'}));
  assert.ok(!('photo' in mine.data));
  assert.equal((await h.tick()).data.processed, 2);
  assert.ok(h.wakes().every(w => !('image' in w.body)));
  assert.equal(tableExists(h), false);
  const world = await h.read();
  assert.equal(world.runtime['runtime:wechat-photos'], undefined);
  assert.equal(Object.values(world.wechat).some(e => e.status === 'awaiting-photo'), false);
  assert.equal(await wechatPhotosShown({env: ENV_ON, db: h.db, now: h.now}), false);
  assert.ok(!(await groupRecord(h)).photoNotice && !(await groupRecord(h)).photosToldAt);
});

test('the Mac\'s word: X-Weave-Photos turns photos on (written at most once a minute), its absence turns them off at once, silence for 5 minutes too', async () => {
  const h = await setup({images: true});
  await h.bridge('claim', {});
  const first = (await h.read()).runtime['runtime:wechat-photos'];
  assert.equal(first.seenAt, h.now);
  assert.equal(await wechatPhotosShown({env: ENV_ON, db: h.db, now: h.now}), true);
  for (const env of [{}, {WEAVE_WECHAT_IMAGES: '1'}, {WEAVE_WECHAT_IMAGES: '0', WEAVE_AGENT_RUNTIME: 'sdk'}]) assert.equal(await wechatPhotosShown({env, db: h.db, now: h.now}), false, JSON.stringify(env));
  h.setNow(h.now + 30_000);
  await h.bridge('claim', {});
  assert.equal((await h.read()).runtime['runtime:wechat-photos'].seenAt, first.seenAt, 'not rewritten within the minute');
  assert.equal(await wechatPhotosShown({env: ENV_ON, db: h.db, now: h.now + 5 * 60_000}), false, 'expired after 5 minutes of silence');
  h.bridgePhotos(false);
  await h.bridge('claim', {});
  assert.equal((await h.read()).runtime['runtime:wechat-photos'], undefined);
  assert.equal(await wechatPhotosShown({env: ENV_ON, db: h.db, now: h.now}), false);
});

test('a group opened while photos are on uses them only after the opening text (which carries the notice) went out', async () => {
  const h = await setup({images: true});
  await h.bind();
  await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true));
  const early = await h.bridge('events', h.group('wxid-bob', '@助理 这顿多少卡', true, {photo: 'ready'}));
  assert.ok(!('photo' in early.data), 'the notice has not gone out yet');
  const jobs = await h.deliverAll();
  assert.ok(groupTexts(jobs).includes(GROUP_ENABLED_TEXT + GROUP_PHOTO_TEXT));
  assert.equal(groupTexts(jobs).filter(t => t === GROUP_PHOTO_TEXT).length, 0, 'no separate notice for a group told at opening');
  assert.equal(typeof (await groupRecord(h)).photosToldAt, 'number');
  const later = await h.bridge('events', h.group('wxid-bob', '@助理 这顿呢', true, {photo: 'ready'}));
  assert.equal(later.data.photo, 'upload');
});

test('a group opened before photos were on gets the notice once, at the first @ after they are on; photos only after it went out', async () => {
  const h = await setup({images: false});
  await h.enableGroup();
  h.images(true);
  h.bridgePhotos(true);
  const first = await h.bridge('events', h.group('wxid-bob', '@助理 这顿多少卡', true, {photo: 'ready'}));
  assert.ok(!('photo' in first.data), 'this @ is answered without a photo');
  assert.equal(first.data.outbound, true, 'the notice is queued');
  const second = await h.bridge('events', h.group('wxid-carol', '@助理 我的呢', true, {photo: 'ready'}));
  assert.ok(!('photo' in second.data));
  const jobs = (await h.bridge('claim', {})).data.jobs;
  assert.deepEqual(groupTexts(jobs).filter(t => t === GROUP_PHOTO_TEXT), [GROUP_PHOTO_TEXT], 'exactly one notice');
  assert.equal(await groupRecord(h).then(g => typeof g.photosToldAt), 'undefined');
  const notice = jobs.find(j => j.text === GROUP_PHOTO_TEXT);
  assert.equal(notice.mentions, undefined, 'the notice @s nobody');
  await h.bridge('receipt', {id: notice.id, state: 'accepted'});
  assert.equal(typeof (await groupRecord(h)).photosToldAt, 'number');
  const third = await h.bridge('events', h.group('wxid-bob', '@助理 这顿呢', true, {photo: 'ready'}));
  assert.equal(third.data.photo, 'upload');
});

test('a notice that did not go out (failed, cancelled or needs review) is sent again at the next @, and photos wait for it', async () => {
  for (const state of ['failed', 'cancelled', 'needs_review']) {
    const h = await setup({images: false});
    await h.enableGroup();
    h.images(true);
    h.bridgePhotos(true);
    await h.bridge('events', h.group('wxid-bob', '@助理 在吗', true, {photo: 'watch'}));
    const notice = (await h.bridge('claim', {})).data.jobs.find(j => j.text === GROUP_PHOTO_TEXT);
    await h.bridge('receipt', {id: notice.id, state});
    const g = await groupRecord(h);
    assert.ok(!g.photoNotice && !g.photosToldAt, state);
    const again = await h.bridge('events', h.group('wxid-bob', '@助理 这顿多少卡', true, {photo: 'ready'}));
    assert.ok(!('photo' in again.data), state);
    assert.equal(groupTexts((await h.bridge('claim', {})).data.jobs).filter(t => t === GROUP_PHOTO_TEXT).length, 1, state + ': sent again');
  }
});

test('deleting the account deletes its waiting photos at once, before they expire', async () => {
  const h = await setup({images: true, agent: async () => reply('好')});
  await h.bind();
  const text = h.message('这顿多少卡', {photo: 'ready'});
  await h.bridge('events', text);
  assert.equal((await h.photo(text.id, PHOTO)).data.attached, true);
  assert.ok(photoRows(h) > 0);
  assert.equal((await h.call('alice', 'account/delete', {confirm: true})).status, 200);
  assert.equal(photoRows(h), 0);
});

test('if writing the world keeps failing after the photo was stored, the photo is deleted, and the message still starts by itself later', async () => {
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('这顿多少卡', {photo: 'ready'});
  await h.bridge('events', text);
  // Every world write now loses the race (another writer always committed first), so withWorld gives up with 409.
  const real = h.db, failing = {
    prepare(query) { const statement = real.prepare(query); statement.query = query; return statement; },
    async batch(statements) { return statements[0]?.query?.startsWith('UPDATE weave_commits') ? statements.map(() => ({results: [], meta: {changes: 0}})) : real.batch(statements); },
  };
  const request = new Request('https://weave.example/api/internal/wechat/photo', {method: 'POST', headers: {'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + bridgeToken, 'X-Weave-For': text.id, 'X-Weave-Thread': 'wxid-alice', 'X-Weave-Sender': 'wxid-alice'}, body: PHOTO});
  const response = await handleAPI(request, {...h.options(), db: failing, identity: null});
  assert.equal(response.status, 409);
  assert.equal(photoRows(h), 0, 'the stored photo must not be left behind');
  h.setNow(h.now + 31_000);
  assert.equal((await h.tick()).data.processed, 1);
  assert.ok(!('image' in h.wakes()[0].body));
});

test('with photos on, every event also sweeps photos that expired', async () => {
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('这顿多少卡', {photo: 'ready'});
  await h.bridge('events', text);
  await h.photo(text.id, PHOTO);
  assert.ok(photoRows(h) > 0);
  h.setNow(h.now + 10 * 60_000);
  await h.bridge('events', h.message('还在吗'));
  assert.equal(photoRows(h), 0);
});

test('a notice that keeps coming back unconfirmed is sent again at most once a Beijing day, and photos wait until one is confirmed', async () => {
  const h = await setup({images: false});
  await h.enableGroup();
  h.images(true);
  h.bridgePhotos(true);
  const ask = text => h.bridge('events', h.group('wxid-bob', '@助理 ' + text, true, {photo: 'ready'}));
  const notices = async () => (await h.bridge('claim', {})).data.jobs.filter(j => j.text === GROUP_PHOTO_TEXT);
  // start is 08:00 in Beijing: the first notice, then one re-send the same day
  assert.ok(!('photo' in (await ask('一')).data));
  const [first] = await notices();
  await h.bridge('receipt', {id: first.id, state: 'needs_review'});
  assert.ok(!('photo' in (await ask('二')).data));
  const [again] = await notices();
  assert.ok(again, 'one re-send is allowed');
  await h.bridge('receipt', {id: again.id, state: 'needs_review'});
  // the same Beijing day: no third notice, and still no photos
  h.setNow(start + 15 * 3600_000); // 23:00 in Beijing
  assert.ok(!('photo' in (await ask('三')).data));
  assert.deepEqual(await notices(), [], 'no second re-send on the same Beijing day');
  // just past midnight in Beijing: one more try
  h.setNow(start + 16 * 3600_000 + 60_000);
  assert.ok(!('photo' in (await ask('四')).data));
  const [nextDay] = await notices();
  assert.ok(nextDay, 'a new Beijing day allows one more re-send');
  await h.bridge('receipt', {id: nextDay.id, state: 'accepted'});
  assert.equal((await ask('五')).data.photo, 'upload', 'photos only once a notice is confirmed');
});

test('the Agent service\'s server tick (/api/internal/tick, every minute since #35) sweeps expired photos too, without any bridge request', async () => {
  const h = await setup({images: true});
  await h.bind();
  const text = h.message('这顿多少卡', {photo: 'ready'});
  await h.bridge('events', text);
  await h.photo(text.id, PHOTO);
  assert.ok(photoRows(h) > 0);
  const tick = () => h.call(null, 'internal/tick', {}, {Authorization: 'Bearer ' + SERVICE_TOKEN});
  h.setNow(h.now + 9 * 60_000);
  assert.equal((await tick()).status, 200);
  assert.ok(photoRows(h) > 0, 'not expired yet: kept');
  h.setNow(h.now + 60_000);
  assert.equal((await tick()).status, 200);
  assert.equal(photoRows(h), 0, 'expired: swept by the server tick alone');
});
