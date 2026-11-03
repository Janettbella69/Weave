// The bridge side of WeChat photos (docs/superpowers/specs/2026-11-03-wechat-images-design.md): which photo pairs with which
// @, what leaves the Mac and when. A fake daemon and a fake Weave; nothing touches WeChat or the network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPhotos, createWeave, handleEvent, readPhoto, stripMetadata, withHints, PHOTO_MAX_BYTES} from '../hosted/wechat-bridge/bridge.mjs';
import {png as makePng} from '../hosted/agent-service/test/helpers/png.mjs';
import {dirtyJpeg, dirtyPng, dirtyGif, dirtyWebp, webpChunk, webpFile, vp8x, GPS_NORTH} from './helpers/dirty-images.mjs';

const ROOM = '5550@chatroom', T0 = Date.parse('2030-01-01T08:00:00Z');
// A real 8x6 JPEG (made with sips, metadata stripped, checked to decode), and the same image padded to any size with comment
// segments, which the bridge strips before anything leaves the Mac.
export const CLEAN_JPEG = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBAMDAwQFBAQEBAUHBQUFBQUHCAcHBwcHBwgICAgICAgICgoKCgoKCwsLCwsNDQ0NDQ0NDQ0N/9sAQwECAgIDAwMGAwMGDQkHCQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0N/90ABAAB/9oADAMBAAIRAxEAPwDqdM8IeIrm80+6vtZkivft3iSZhB5bIYdLndVhtpPJR7LzVt7oSPi43jyA6yKZAOl+2XHrrH/g8g/+U9dLp/8AyENO/wCuvjj/ANKNXrmK/H/ErirM8rzj6lgKijTUItLlg7c15PeLerbfqzxMRj60Z2jZLV2SSSu23ZWtFXbdkkrtu2p//9k=', 'base64'));
function jpeg(size = 3000) {
  const parts = [CLEAN_JPEG.subarray(0, 2)];
  let left = size - CLEAN_JPEG.length;
  if (left < 0 || (left > 0 && left < 4)) throw Error('cannot pad a JPEG to ' + size);
  while (left > 0) {
    let n = Math.min(left, 65537);
    if (left - n > 0 && left - n < 4) n -= 4;
    const segment = new Uint8Array(n).fill(0x41);
    segment.set([0xff, 0xfe, (n - 2) >> 8, (n - 2) & 0xff]);
    parts.push(segment);
    left -= n;
  }
  parts.push(CLEAN_JPEG.subarray(2));
  return new Uint8Array(Buffer.concat(parts));
}
const PNG_IMAGE = new Uint8Array(makePng(4, 4, 5));
const iso = t => new Date(t).toISOString();
const photoMessage = (id, {thread = ROOM, sender = 'wxid-bob', at = T0} = {}) => ({id, threadId: thread, senderId: sender, type: 3, direction: 'incoming', body: null, createdAt: iso(at), mentions: {self: false}, media: []});
const textMessage = (id, body, {thread = ROOM, sender = 'wxid-bob', at = T0, mentioned = thread.endsWith('@chatroom')} = {}) => ({id, threadId: thread, senderId: sender, type: 1, direction: 'incoming', body, createdAt: iso(at), mentions: {self: mentioned}, media: []});
const asset = (messageId, variant, extra = {}) => ({id: `${messageId}:${variant}`, messageId, kind: 'image', variant, actualVariant: variant, state: 'available', contentType: 'image/jpeg', byteLength: 3000, ...extra});

// A daemon that knows some messages and their cached copies, and records every route it is asked for.
function fakeDaemon({messages = {}, assets = {}, bytes = {}, mediaError} = {}) {
  const routes = [];
  return {
    routes,
    message: async id => { routes.push('message ' + id); return messages[id]; },
    media: async id => { routes.push('media ' + id); if (mediaError) throw mediaError; return {items: (typeof assets === 'function' ? assets(id, routes.filter(r => r === 'media ' + id).length) : assets[id]) || []}; },
    content: async id => { routes.push('content ' + id); return new Response(bytes[id] ?? jpeg(), {headers: {'content-type': 'image/jpeg'}}); },
    ack: async () => {},
  };
}
// A Weave that answers /events with `answer(data)` and /photo with wake, and records what it was sent.
function fakeWeave(answer = () => ({accepted: true})) {
  const sent = [];
  const weave = async (path, data) => { sent.push({path, data}); return path === 'events' ? answer(data) : {accepted: true, wake: true}; };
  return {sent, weave, events: () => sent.filter(s => s.path === 'events').map(s => s.data), photos: () => sent.filter(s => s.path === 'photo').map(s => s.data)};
}
function clockAndTimers() {
  const clock = {t: T0 + 2000}, timers = [];
  return {clock, timers, now: () => clock.t, later: (fn, ms) => { const timer = {fn, ms, cancelled: false}; timers.push(timer); return timer; }, cancel: timer => { if (timer) timer.cancelled = true; }, fire: () => { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn(); }};
}
function rig({daemon, answer, photos = true} = {}) {
  const w = fakeWeave(answer), c = clockAndTimers(), logs = [];
  const p = photos ? createPhotos({daemon, weave: w.weave, now: c.now, later: c.later, cancel: c.cancel, log: line => logs.push(line), sleep: async () => {}}) : undefined;
  const deliver = id => handleEvent({cursor: id, kind: 'message.committed', data: {messageId: id, direction: 'incoming'}}, {daemon, weave: w.weave, photos: p, saveCursor: async () => {}});
  return {...w, ...c, logs, helper: p, deliver, settled: () => p?.settled()};
}
const uploadAnswer = data => data.photo === 'ready' ? {accepted: true, queued: true, photo: 'upload'} : data.photo === 'watch' ? {accepted: true, queued: true, photo: 'watch'} : {accepted: true};

test('switch off: a photo is fetched like any message and nothing leaves; a text goes with exactly the same fields as before', async () => {
  const daemon = fakeDaemon({messages: {p1: photoMessage('p1'), t1: textMessage('t1', '@助理 这顿多少卡')}, assets: {p1: [asset('p1', 'standard')]}});
  const r = rig({daemon, answer: uploadAnswer, photos: false});
  await r.deliver('p1');
  await r.deliver('t1');
  assert.deepEqual(daemon.routes, ['message p1', 'message t1']);
  assert.deepEqual(r.sent.map(s => s.path), ['events']);
  assert.deepEqual(Object.keys(r.events()[0]).sort(), ['body', 'createdAt', 'direction', 'id', 'mentions', 'senderId', 'threadId', 'type']);
});

test('group, photo first: the same person\'s @ within 60 s says ready; on upload the cached standard copy goes to Weave with who sent it', async () => {
  const bytes = jpeg(4321);
  const daemon = fakeDaemon({
    messages: {p1: photoMessage('p1', {at: T0}), t1: textMessage('t1', '@助理 这顿多少卡', {at: T0 + 30_000})},
    assets: {p1: [asset('p1', 'thumbnail'), asset('p1', 'standard', {byteLength: 4321}), asset('p1', 'original', {byteLength: 3e6})]}, bytes: {'p1:standard': bytes},
  });
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('p1');
  assert.deepEqual(r.sent, [], 'a photo on its own never leaves the Mac, not even its id');
  await r.deliver('t1');
  await r.settled();
  assert.equal(r.events()[0].photo, 'ready');
  assert.ok(!JSON.stringify(r.events()).includes('p1'), 'the photo\'s id is not sent');
  const [photo] = r.photos();
  assert.deepEqual({...photo, bytes: undefined}, {for: 't1', threadId: ROOM, senderId: 'wxid-bob', bytes: undefined, mediaType: 'image/jpeg'});
  assert.ok(Buffer.from(photo.bytes).equals(Buffer.from(CLEAN_JPEG)), 'the comment padding is stripped before it leaves');
  assert.ok(bytes.length > CLEAN_JPEG.length);
  assert.deepEqual(daemon.routes, ['message p1', 'message t1', 'media p1', 'content p1:standard']);
  assert.ok(daemon.routes.every(route => !route.includes('transfer')));
});

test('an unpaired group photo never leaves the Mac: chatter, someone else\'s @, an @ Weave does not want, an @ more than 60 s later', async () => {
  const daemon = fakeDaemon({
    messages: {
      p1: photoMessage('p1', {at: T0}),
      chat: textMessage('chat', '这是午饭', {at: T0 + 1000, mentioned: false}),
      other: textMessage('other', '@助理 我呢', {sender: 'wxid-carol', at: T0 + 2000}),
      unwanted: textMessage('unwanted', '@助理 别记 这个', {at: T0 + 3000}),
      p2: photoMessage('p2', {at: T0 + 100_000}),
      late: textMessage('late', '@助理 这顿多少卡', {at: T0 + 161_000}),
    },
    assets: {p1: [asset('p1', 'standard')], p2: [asset('p2', 'standard')]},
  });
  // Weave answers like it does for 别记 (and for a group that is not enabled): no photo field.
  const r = rig({daemon, answer: data => data.body.includes('别记') ? {accepted: true, skipped: true} : uploadAnswer(data)});
  for (const id of ['p1', 'chat', 'other', 'unwanted']) await r.deliver(id);
  r.clock.t += 120_000;
  for (const id of ['p2', 'late']) await r.deliver(id);
  r.fire();
  await r.settled();
  assert.deepEqual(daemon.routes.filter(route => !route.startsWith('message')), [], 'no cached copy was even read');
  assert.ok(r.photos().every(p => !p.bytes), 'no bytes were sent');
  const fields = Object.fromEntries(r.events().map(e => [e.id, e.photo]));
  assert.deepEqual(fields, {chat: undefined, other: 'watch', unwanted: 'ready', late: 'watch'});
});

test('@ first: Weave says watch; the same person\'s photo within 10 s is sent for that @, and the wait is over', async () => {
  const daemon = fakeDaemon({messages: {t1: textMessage('t1', '@助理 帮我看看', {at: T0}), p1: photoMessage('p1', {at: T0 + 6000})}, assets: {p1: [asset('p1', 'standard')]}});
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('t1');
  assert.equal(r.events()[0].photo, 'watch');
  await r.deliver('p1');
  await r.settled();
  assert.deepEqual(r.photos().map(p => [p.for, p.mediaType]), [['t1', 'image/jpeg']]);
  r.fire();
  await r.settled();
  assert.equal(r.photos().length, 1, 'once the photo came, the timer says nothing more');
});

test('@ first: no photo within 10 s, or one from someone else, or one taken later: the bridge tells Weave there is none and sends nothing', async () => {
  const daemon = fakeDaemon({messages: {
    t1: textMessage('t1', '@助理 帮我看看', {at: T0}),
    other: photoMessage('other', {sender: 'wxid-carol', at: T0 + 2000}),
    late: photoMessage('late', {at: T0 + 15_000}),
  }, assets: {other: [asset('other', 'standard')], late: [asset('late', 'standard')]}});
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('t1');
  await r.deliver('other');
  await r.deliver('late');
  assert.deepEqual(r.photos(), []);
  assert.deepEqual(r.timers.filter(timer => timer.ms === 10_000).length, 1, 'one wait for the @');
  r.fire();
  await r.settled();
  assert.deepEqual(r.photos(), [{for: 't1', none: 'none'}]);
  assert.deepEqual(daemon.routes.filter(route => !route.startsWith('message')), []);
});

test('a photo the bridge holds is forgotten 60 s later even when nothing else arrives', async () => {
  const daemon = fakeDaemon({messages: {p1: photoMessage('p1', {at: T0}), t1: textMessage('t1', '@助理 这顿多少卡', {at: T0 + 30_000})}, assets: {p1: [asset('p1', 'standard')]}});
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('p1');
  assert.deepEqual(r.timers.map(timer => timer.ms), [60_000]);
  r.fire();
  await r.deliver('t1');
  await r.settled();
  assert.equal(r.events()[0].photo, 'watch', 'the photo is no longer held');
  assert.deepEqual(daemon.routes.filter(route => !route.startsWith('message')), []);
});

test('a second @ before the first one got its photo: the first is released, the photo goes with the newest', async () => {
  const daemon = fakeDaemon({messages: {
    a: textMessage('a', '@助理 看看', {at: T0}), b: textMessage('b', '@助理 这个呢', {at: T0 + 1000}), p: photoMessage('p', {at: T0 + 3000}),
  }, assets: {p: [asset('p', 'standard')]}});
  const r = rig({daemon, answer: uploadAnswer});
  for (const id of ['a', 'b', 'p']) await r.deliver(id);
  await r.settled();
  assert.deepEqual(r.photos().map(p => p.none ? ['none', p.for, p.none] : ['photo', p.for]), [['none', 'a', 'replaced'], ['photo', 'b']]);
});

test('private chat: the bridge cannot tell who is bound, so it only says ready; a stranger (no upload asked) never has a copy read', async () => {
  const daemon = fakeDaemon({messages: {
    p1: photoMessage('p1', {thread: 'wxid-stranger', sender: 'wxid-stranger', at: T0}),
    t1: textMessage('t1', '这是什么', {thread: 'wxid-stranger', sender: 'wxid-stranger', at: T0 + 5000}),
    p2: photoMessage('p2', {thread: 'wxid-alice', sender: '', at: T0}),
    t2: textMessage('t2', '这顿多少卡', {thread: 'wxid-alice', sender: '', at: T0 + 5000}),
  }, assets: {p1: [asset('p1', 'standard')], p2: [asset('p2', 'standard')]}});
  const r = rig({daemon, answer: data => data.threadId === 'wxid-alice' ? uploadAnswer(data) : {accepted: true, ignored: true}});
  for (const id of ['p1', 't1', 'p2', 't2']) await r.deliver(id);
  await r.settled();
  assert.deepEqual(r.events().map(e => [e.id, e.photo]), [['t1', 'ready'], ['t2', 'ready']]);
  assert.deepEqual(daemon.routes.filter(route => !route.startsWith('message')), ['media p2', 'content p2:standard']);
  assert.deepEqual(r.photos().map(p => [p.for, p.threadId, p.senderId]), [['t2', 'wxid-alice', 'wxid-alice']]);
});

test('which copy, and the limits: standard, else thumbnail; only available JPEG/PNG/GIF/WebP up to 2 MiB; otherwise Weave hears there is none', async () => {
  const big = jpeg(PHOTO_MAX_BYTES + 1), notImage = new TextEncoder().encode('GIF-not-really'), png = PNG_IMAGE;
  const cases = [
    ['thumbnail when there is no standard', [asset('m', 'thumbnail')], {}, {mediaType: 'image/jpeg', from: 'm:thumbnail'}],
    ['thumbnail when the standard is too big', [asset('m', 'standard', {byteLength: PHOTO_MAX_BYTES + 1}), asset('m', 'thumbnail')], {}, {from: 'm:thumbnail'}],
    ['a standard copy that is not cached yet', [asset('m', 'standard', {state: 'pending'})], {}, {problem: 'not_cached'}],
    ['a copy of another message', [asset('other', 'standard', {id: 'x'})], {}, {problem: 'not_cached'}],
    ['a declared HEIC', [asset('m', 'standard', {contentType: 'image/heic'})], {}, {problem: 'unsupported'}],
    ['bigger than 2 MiB once read', [asset('m', 'standard', {byteLength: null})], {'m:standard': big}, {problem: 'too_large'}],
    ['bytes that are not an image', [asset('m', 'standard')], {'m:standard': notImage}, {problem: 'unsupported'}],
    ['a PNG declared as JPEG: the bytes win', [asset('m', 'standard')], {'m:standard': png}, {mediaType: 'image/png'}],
    ['exactly 2 MiB', [asset('m', 'standard', {byteLength: PHOTO_MAX_BYTES})], {'m:standard': jpeg(PHOTO_MAX_BYTES)}, {mediaType: 'image/jpeg'}],
    ['a JPEG whose structure cannot be read: not sent (fail closed)', [asset('m', 'standard')], {'m:standard': CLEAN_JPEG.subarray(0, 300)}, {problem: 'strip_failed'}],
  ];
  for (const [name, assets, bytes, want] of cases) {
    const daemon = fakeDaemon({assets: {m: assets}, bytes});
    const got = await readPhoto(daemon, 'm', {sleep: async () => {}});
    if (want.problem) assert.deepEqual(got, {problem: want.problem}, name);
    else {
      assert.ok(got.bytes instanceof Uint8Array, name);
      if (want.mediaType) assert.equal(got.mediaType, want.mediaType, name);
      if (want.from) assert.ok(daemon.routes.includes('content ' + want.from), name + ': ' + daemon.routes.join(', '));
    }
    assert.ok(daemon.routes.every(route => !route.includes('transfer')), name);
  }
  const forbidden = Object.assign(Error('agent-wechat 请求失败 (403 forbidden)'), {status: 403, code: 'forbidden'});
  assert.deepEqual(await readPhoto(fakeDaemon({mediaError: forbidden}), 'm', {sleep: async () => {}}), {problem: 'media_403'});
});

test('a photo that cannot be read is reported as none, and the log says to add the media scope when that is the reason', async () => {
  const forbidden = Object.assign(Error('agent-wechat 请求失败 (403 forbidden)'), {status: 403, code: 'forbidden'});
  const daemon = fakeDaemon({messages: {p1: photoMessage('p1'), t1: textMessage('t1', '@助理 这顿多少卡', {at: T0 + 1000})}, mediaError: forbidden});
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('p1');
  await r.deliver('t1');
  await r.settled();
  assert.deepEqual(r.photos(), [{for: 't1', none: 'media_403'}]);
  assert.ok(r.logs.some(line => line.includes('WX_TOKEN 可能没有 media 权限')), r.logs.join('\n'));
});

test('nothing the photo log lines print can carry a message id, a wxid, a chat id or the bytes', async () => {
  const daemon = fakeDaemon({messages: {p1: photoMessage('p1-SECRET-ID'), 'p1-SECRET-ID': photoMessage('p1-SECRET-ID', {sender: 'wxid_secret_user'}), t1: textMessage('t1-SECRET-ID', '@助理 SECRET-TEXT', {sender: 'wxid_secret_user', at: T0 + 1000})}, assets: {'p1-SECRET-ID': [asset('p1-SECRET-ID', 'standard')]}});
  daemon.message = async id => (id === 'p1' ? photoMessage('p1-SECRET-ID', {sender: 'wxid_secret_user'}) : textMessage('t1-SECRET-ID', '@助理 SECRET-TEXT', {sender: 'wxid_secret_user', at: T0 + 1000}));
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('p1');
  await r.deliver('t1');
  await r.settled();
  assert.equal(r.photos().length, 1);
  const all = r.logs.join('\n');
  for (const leak of ['SECRET-ID', 'wxid_secret_user', ROOM, 'SECRET-TEXT']) assert.ok(!all.includes(leak), leak + ' in ' + all);
});

test('the Weave client sends a photo as its own bytes with the message, chat and sender in headers; JSON calls are unchanged', async () => {
  const calls = [];
  const weave = createWeave({origin: 'https://weave.example/', token: 't', fetcher: async (url, options) => { calls.push({url, options}); return Response.json({accepted: true, wake: true}); }});
  const bytes = CLEAN_JPEG;
  await weave('photo', {for: 'msg_1', threadId: ROOM, senderId: 'wxid-bob', bytes, mediaType: 'image/jpeg'});
  assert.equal(calls[0].url, 'https://weave.example/api/internal/wechat/photo');
  assert.deepEqual(calls[0].options.headers, {'Content-Type': 'image/jpeg', 'X-Weave-For': 'msg_1', 'X-Weave-Thread': ROOM, 'X-Weave-Sender': 'wxid-bob', Authorization: 'Bearer t'});
  assert.equal(calls[0].options.body, bytes);
  await weave('photo', {for: 'msg_1', none: 'none'});
  assert.deepEqual(calls[1].options.headers, {'Content-Type': 'application/json', Authorization: 'Bearer t'});
  assert.equal(calls[1].options.body, JSON.stringify({for: 'msg_1', none: 'none'}));
  assert.ok(!calls[0].url.includes('wxid') && !calls[0].url.includes('msg_1'), 'nothing personal in the address');
  // With its own switch on, the bridge says so on every request, so Weave knows the Mac side is on too.
  const on = createWeave({origin: 'https://weave.example/', token: 't', photos: true, fetcher: async (url, options) => { calls.push({url, options}); return Response.json({jobs: []}); }});
  await on('claim', {});
  await on('photo', {for: 'msg_1', threadId: ROOM, senderId: 'wxid-bob', bytes, mediaType: 'image/jpeg'});
  assert.equal(calls[2].options.headers['X-Weave-Photos'], 'on');
  assert.equal(calls[3].options.headers['X-Weave-Photos'], 'on');
});

test('a /photo answer with wake:true runs a tick at once, like an /events answer', async () => {
  let wakes = 0, outbound = 0;
  const hinted = withHints(async path => (path === 'photo' ? {accepted: true, attached: true, wake: true} : {jobs: []}), {onWake: () => wakes++, onOutbound: () => outbound++});
  await hinted('photo', {for: 'm', none: 'none'});
  await hinted('claim', {});
  assert.equal(wakes, 1);
  assert.equal(outbound, 0);
});

// ── fix round 1: metadata, the bridge's own pairing check, and waiting for the clearer copy ──────────────────────────────
const WEBP = new Uint8Array(Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')); // 1x1 lossless, decodes (checked with sips)
const GIF = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')); // 1x1, decodes (checked with sips)
const LEAKS = ['Exif', 'GPS', 'xmpmeta', 'Photoshop', '8BIM', 'MOTION', 'NETSCAPE', 'XMP Data', 'Location', 'taken on my phone'];
const gpsBytes = () => Buffer.concat(GPS_NORTH.map(n => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(1, 4); return b; }));

test('before a photo leaves the Mac its metadata is stripped: EXIF with GPS, XMP, IPTC, comments, text chunks, data after the end; the picture itself is untouched', () => {
  const cases = [
    ['image/jpeg', dirtyJpeg(CLEAN_JPEG), CLEAN_JPEG],
    ['image/png', dirtyPng(PNG_IMAGE), PNG_IMAGE],
    ['image/gif', dirtyGif(GIF), GIF],
    // the extended form stays, with its "has EXIF" and "has XMP" flags cleared
    ['image/webp', dirtyWebp(WEBP), webpFile([vp8x(0), Buffer.from(WEBP).subarray(12)])],
  ];
  for (const [type, planted, expected] of cases) {
    // GIF has no EXIF: there the position is only in a comment and in XMP text.
    assert.ok(LEAKS.some(leak => Buffer.from(planted).includes(leak)) && (type === 'image/gif' || Buffer.from(planted).includes(gpsBytes())), type + ': the fixture really carries a GPS position');
    const out = stripMetadata(planted, type);
    assert.ok(Buffer.from(out).equals(Buffer.from(expected)), type + ': ' + Buffer.from(out).toString('hex').slice(0, 120));
    for (const leak of LEAKS) assert.ok(!Buffer.from(out).includes(leak), `${type}: ${leak} is still there`);
    assert.ok(!Buffer.from(out).includes(gpsBytes()), type + ': the GPS numbers are still there');
    assert.ok(Buffer.from(stripMetadata(out, type)).equals(Buffer.from(out)), type + ': the result reads back as a clean image');
  }
});

test('fail closed: an image the stripper cannot read is refused, never sent as it is', () => {
  const broken = [
    ['image/jpeg', CLEAN_JPEG.subarray(0, 300)], ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], ['image/jpeg', new Uint8Array([0xff, 0xd8, 0x00, 0x01, 0x02])],
    ['image/png', PNG_IMAGE.subarray(0, 40)], ['image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1])],
    ['image/webp', new Uint8Array([...WEBP.subarray(0, 4), 0xff, 0xff, 0, 0, ...WEBP.subarray(8)])], ['image/webp', webpFile([webpChunk('EXIF', Buffer.from('x'))])],
    ['image/gif', GIF.subarray(0, GIF.length - 1)], ['image/gif', new Uint8Array([...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b])],
    ['image/heic', CLEAN_JPEG],
  ];
  for (const [type, bytes] of broken) assert.throws(() => stripMetadata(bytes, type), `${type} ${Buffer.from(bytes).toString('hex').slice(0, 40)}`);
});

test('end to end on the Mac: a phone photo with a GPS position reaches Weave without it, and the log names the copy that went', async () => {
  const daemon = fakeDaemon({
    messages: {p1: photoMessage('p1', {at: T0}), t1: textMessage('t1', '@助理 这顿多少卡', {at: T0 + 5000})},
    assets: {p1: [asset('p1', 'standard')]}, bytes: {'p1:standard': dirtyJpeg(CLEAN_JPEG)},
  });
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('p1');
  await r.deliver('t1');
  await r.settled();
  const [photo] = r.photos();
  assert.ok(Buffer.from(photo.bytes).equals(Buffer.from(CLEAN_JPEG)));
  assert.ok(!Buffer.from(photo.bytes).includes(gpsBytes()));
  assert.ok(r.logs.some(line => line.includes(`${CLEAN_JPEG.length} 字节，standard`)), r.logs.join('\n'));
});

test('a photo that cannot be stripped is not sent: Weave hears there is none', async () => {
  const daemon = fakeDaemon({messages: {p1: photoMessage('p1'), t1: textMessage('t1', '@助理 这顿多少卡', {at: T0 + 1000})}, assets: {p1: [asset('p1', 'standard')]}, bytes: {'p1:standard': CLEAN_JPEG.subarray(0, 300)}});
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('p1');
  await r.deliver('t1');
  await r.settled();
  assert.deepEqual(r.photos(), [{for: 't1', none: 'strip_failed'}]);
});

test('an upload Weave asks for that the bridge\'s own pairing does not back reads nothing: an old photo, a group message without an @', async () => {
  const daemon = fakeDaemon({messages: {
    p1: photoMessage('p1', {at: T0}), late: textMessage('late', '@助理 这顿多少卡', {at: T0 + 61_000}),
    p2: photoMessage('p2', {at: T0 + 70_000}), chatter: textMessage('chatter', '这是午饭', {at: T0 + 71_000, mentioned: false}),
  }, assets: {p1: [asset('p1', 'standard')], p2: [asset('p2', 'standard')]}});
  // A Weave that (wrongly) asks for a photo for every message.
  const r = rig({daemon, answer: () => ({accepted: true, queued: true, photo: 'upload'})});
  for (const id of ['p1', 'late', 'p2', 'chatter']) await r.deliver(id);
  await r.settled();
  assert.deepEqual(daemon.routes.filter(route => !route.startsWith('message')), [], 'not a byte was read');
  assert.ok(r.photos().every(p => !p.bytes));
  assert.deepEqual(r.photos().map(p => [p.for, p.none]), [['late', 'not_paired'], ['chatter', 'not_paired']]);
});

test('standard is worth a short wait: with only the thumbnail cached, the list is looked at again for up to 3 s; standard wins if it shows up, else the thumbnail goes', async () => {
  const thumb = asset('m', 'thumbnail', {byteLength: 500}), standard = asset('m', 'standard');
  let sleeps = [];
  const sleep = async ms => { sleeps.push(ms); };
  const arriving = fakeDaemon({assets: (id, calls) => calls >= 3 ? [thumb, standard] : [thumb]});
  const got = await readPhoto(arriving, 'm', {sleep});
  assert.equal(got.variant, 'standard');
  assert.deepEqual(sleeps, [500, 500]);
  assert.ok(arriving.routes.includes('content m:standard') && !arriving.routes.includes('content m:thumbnail'));
  sleeps = [];
  const never = fakeDaemon({assets: {m: [thumb]}});
  const fallback = await readPhoto(never, 'm', {sleep});
  assert.equal(fallback.variant, 'thumbnail');
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 3000, 'waits 3 s in all, then takes the thumbnail');
  sleeps = [];
  assert.equal((await readPhoto(fakeDaemon({assets: {m: [standard]}}), 'm', {sleep})).variant, 'standard');
  assert.deepEqual(sleeps, [], 'no wait when standard is already there');
});
