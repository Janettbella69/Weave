// The bridge side of WeChat photos (docs/superpowers/specs/2026-11-03-wechat-images-design.md): which photo pairs with which
// @, what leaves the Mac and when. A fake daemon and a fake Weave; nothing touches WeChat or the network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPhotos, createWeave, handleEvent, readPhoto, withHints, PHOTO_MAX_BYTES} from '../hosted/wechat-bridge/bridge.mjs';

const ROOM = '5550@chatroom', T0 = Date.parse('2030-01-01T08:00:00Z');
const jpeg = (size = 3000) => { const b = new Uint8Array(size).fill(7); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
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
    media: async id => { routes.push('media ' + id); if (mediaError) throw mediaError; return {items: assets[id] || []}; },
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
  const p = photos ? createPhotos({daemon, weave: w.weave, now: c.now, later: c.later, cancel: c.cancel, log: line => logs.push(line)}) : undefined;
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
  assert.ok(Buffer.from(photo.bytes).equals(Buffer.from(bytes)));
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
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 10_000);
  r.fire();
  await r.settled();
  assert.deepEqual(r.photos(), [{for: 't1', none: 'none'}]);
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
  const big = jpeg(PHOTO_MAX_BYTES + 1), notImage = new TextEncoder().encode('GIF-not-really'), png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
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
  ];
  for (const [name, assets, bytes, want] of cases) {
    const daemon = fakeDaemon({assets: {m: assets}, bytes});
    const got = await readPhoto(daemon, 'm');
    if (want.problem) assert.deepEqual(got, {problem: want.problem}, name);
    else {
      assert.ok(got.bytes instanceof Uint8Array, name);
      if (want.mediaType) assert.equal(got.mediaType, want.mediaType, name);
      if (want.from) assert.ok(daemon.routes.includes('content ' + want.from), name + ': ' + daemon.routes.join(', '));
    }
    assert.ok(daemon.routes.every(route => !route.includes('transfer')), name);
  }
  const forbidden = Object.assign(Error('agent-wechat 请求失败 (403 forbidden)'), {status: 403, code: 'forbidden'});
  assert.deepEqual(await readPhoto(fakeDaemon({mediaError: forbidden}), 'm'), {problem: 'media_403'});
});

test('a photo that cannot be read is reported as none, and the log says to add the media scope when that is the reason', async () => {
  const forbidden = Object.assign(Error('agent-wechat 请求失败 (403 forbidden)'), {status: 403, code: 'forbidden'});
  const daemon = fakeDaemon({messages: {p1: photoMessage('p1'), t1: textMessage('t1', '@助理 这顿多少卡', {at: T0 + 1000})}, mediaError: forbidden});
  const r = rig({daemon, answer: uploadAnswer});
  await r.deliver('p1');
  await r.deliver('t1');
  await r.settled();
  assert.deepEqual(r.photos(), [{for: 't1', none: 'media_403'}]);
  assert.ok(r.logs.some(line => line.includes('images.sh on')), r.logs.join('\n'));
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
  const bytes = jpeg(10);
  await weave('photo', {for: 'msg_1', threadId: ROOM, senderId: 'wxid-bob', bytes, mediaType: 'image/jpeg'});
  assert.equal(calls[0].url, 'https://weave.example/api/internal/wechat/photo');
  assert.deepEqual(calls[0].options.headers, {'Content-Type': 'image/jpeg', 'X-Weave-For': 'msg_1', 'X-Weave-Thread': ROOM, 'X-Weave-Sender': 'wxid-bob', Authorization: 'Bearer t'});
  assert.equal(calls[0].options.body, bytes);
  await weave('photo', {for: 'msg_1', none: 'none'});
  assert.deepEqual(calls[1].options.headers, {'Content-Type': 'application/json', Authorization: 'Bearer t'});
  assert.equal(calls[1].options.body, JSON.stringify({for: 'msg_1', none: 'none'}));
  assert.ok(!calls[0].url.includes('wxid') && !calls[0].url.includes('msg_1'), 'nothing personal in the address');
});

test('a /photo answer with wake:true runs a tick at once, like an /events answer', async () => {
  let wakes = 0, outbound = 0;
  const hinted = withHints(async path => (path === 'photo' ? {accepted: true, attached: true, wake: true} : {jobs: []}), {onWake: () => wakes++, onOutbound: () => outbound++});
  await hinted('photo', {for: 'm', none: 'none'});
  await hinted('claim', {});
  assert.equal(wakes, 1);
  assert.equal(outbound, 0);
});
