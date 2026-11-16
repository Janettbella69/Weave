// hosted/ilink-bridge against a fake iLink server (the protocol of Tencent's official plugin) and the real Weave server code
// (handleAPI, in process, with a fake Agent service and a fake D1). No WeChat, no network, no cost.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createCipheriv, randomBytes} from 'node:crypto';
import {mkdtemp, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {createBridge, createStore, createWeave, login, statusText, configFromEnv} from '../hosted/ilink-bridge/bridge.mjs';
import {createIlink, imageKey, STALE_TOKEN} from '../hosted/ilink-bridge/ilink.mjs';
import {PHOTO_MESSAGE_TEXT, PHOTO_UNAVAILABLE_FACT} from '../hosted/lib/weave/wechat.mjs';
import {setup, reply, bridgeToken} from './helpers/wechat-sdk.mjs';

const USER = 'o9alice@im.wechat', BOT = 'bot-1@im.bot';
const encrypt = (plain, key) => { const c = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(plain), c.final()]); };
// The same real JPEG with an EXIF segment (a GPS position, in words) planted after the start marker: the bridge must strip it.
// A tiny JPEG with the structure the stripper reads (start, JFIF, frame header, scan, end); it need not decode.
const CLEAN_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9,
]);
const EXIF = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, 30]), Buffer.from('Exif\0\0GPS north of the lake.')]);
const DIRTY = new Uint8Array(Buffer.concat([Buffer.from(CLEAN_JPEG.subarray(0, 2)), EXIF, Buffer.from(CLEAN_JPEG.subarray(2))]));

// The fake iLink: the paths and fields of the official plugin. `updates` is the queue the long poll answers from.
async function fakeIlink() {
  const requests = [], updates = [], files = new Map();
  let statuses = [], sendReply = {ret: 0}, sendFails = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fake');
    requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : null});
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    switch (url.pathname) {
      case '/ilink/bot/get_bot_qrcode': return json({qrcode: 'qr-1', qrcode_img_content: 'https://qr.example.test/qr-1'});
      case '/ilink/bot/get_qrcode_status': return json(statuses.shift() ?? {status: 'wait'});
      case '/ilink/bot/getupdates': return json(updates.shift() ?? {ret: 0, msgs: []});
      case '/ilink/bot/sendmessage': if (sendFails) { res.statusCode = 502; return res.end('bad gateway'); } return json(sendReply);
      case '/ilink/bot/msg/notifystart': case '/ilink/bot/msg/notifystop': return json({ret: 0});
      case '/c2c/download': {
        const file = files.get(url.searchParams.get('encrypted_query_param'));
        if (!file) { res.statusCode = 404; return res.end('missing'); }
        return res.end(file);
      }
      default: res.statusCode = 404; return res.end('unknown');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, requests, updates, files,
    setStatuses: list => { statuses = list; },
    setSendReply: r => { sendReply = r; },
    failSends: on => { sendFails = on; },
    sent: () => requests.filter(r => r.path === '/ilink/bot/sendmessage').map(r => r.body.msg),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}

const textMsg = (text, extra = {}) => ({message_id: extra.message_id ?? Math.floor(Math.random() * 1e9), message_type: 1, from_user_id: USER, create_time_ms: String(Date.parse('2030-01-01T00:00:00Z')), context_token: 'ctx-1', item_list: [{type: 1, text_item: {text}}], ...extra});
const imageMsg = (item, extra = {}) => ({message_id: extra.message_id ?? Math.floor(Math.random() * 1e9), message_type: 1, from_user_id: USER, create_time_ms: String(Date.parse('2030-01-01T00:00:00Z')), context_token: 'ctx-2', item_list: [{type: 2, image_item: item}], ...extra});

async function rig(t, {agent = async () => reply('收到'), weaveFetch} = {}) {
  const h = await setup({agent});
  const ilinkServer = await fakeIlink();
  t.after(() => ilinkServer.close());
  const dir = await mkdtemp(join(tmpdir(), 'ilink-bridge-'));
  const store = createStore(dir);
  const ilink = createIlink({baseUrl: ilinkServer.base, cdnBaseUrl: `${ilinkServer.base}/c2c`});
  // The real Weave server code, reached the way the bridge reaches it: fetch(origin + path).
  let down = false;
  const fetcher = weaveFetch ?? (async (url, init) => {
    if (down) throw Error('Weave is down');
    return handleAPI(new Request(url, init), {...h.options(), identity: null});
  });
  const weave = createWeave({origin: 'http://host.docker.internal:4317', token: bridgeToken, fetcher});
  const results = [];
  const bridge = createBridge({ilink, weave, store, log: () => {}, sleep: async () => {}, onResult: r => results.push(r)});
  await store.addAccount({botToken: 'tok-1', botId: BOT, userId: USER, baseUrl: ilinkServer.base, loggedInAt: new Date().toISOString()});
  const account = (await store.accounts())[0];
  return {h, ilink: ilinkServer, store, bridge, account, weave, results, dir, setDown: v => { down = v; }, poll: () => bridge.pollOnce(account), deliver: () => bridge.deliverOnce(), tick: () => weave('tick', {}, {timeoutMs: 1000})};
}
const bindInstruction = async r => (await r.h.call('alice', 'wechat/bind', {})).data.instruction;

test('login: scan, the number on the phone when asked, and the key is saved with mode 600; a second scan by the same person replaces the first', async t => {
  const server = await fakeIlink();
  t.after(() => server.close());
  const store = createStore(await mkdtemp(join(tmpdir(), 'ilink-login-')));
  const ilink = createIlink({baseUrl: server.base});
  server.setStatuses([{status: 'wait'}, {status: 'scaned'}, {status: 'need_verifycode'}, {status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: BOT, ilink_user_id: USER, baseurl: server.base}]);
  const shown = [], asked = [];
  const saved = await login({ilink, store, show: link => shown.push(link), ask: async q => { asked.push(q); return '1234'; }, log: () => {}, pollDelayMs: 0});
  assert.deepEqual(shown, ['https://qr.example.test/qr-1']);
  assert.equal(asked.length, 1);
  assert.equal(server.requests.filter(r => r.path === '/ilink/bot/get_qrcode_status').at(-1).query.verify_code, '1234');
  assert.equal(saved.botToken, 'tok-1');
  assert.equal((await stat(store.files.accounts)).mode & 0o777, 0o600);
  server.setStatuses([{status: 'confirmed', bot_token: 'tok-2', ilink_bot_id: 'bot-2@im.bot', ilink_user_id: USER, baseurl: server.base}]);
  await login({ilink, store, show: () => {}, ask: async () => '', log: () => {}, pollDelayMs: 0});
  assert.deepEqual((await store.accounts()).map(a => a.botToken), ['tok-2']);
  // Every request says who it is, honestly.
  assert.ok(server.requests.every(r => r.headers['ilink-app-id'] === 'bot'));
});

test('text end to end: the binding message binds over iLink, the confirmation and the reply go out with the context token, and the key is the iLink channel header', async t => {
  const r = await rig(t, {agent: async () => reply('今天也辛苦了')});
  r.ilink.updates.push({ret: 0, get_updates_buf: 'buf-1', msgs: [textMsg(await bindInstruction(r))]});
  await r.poll();
  assert.equal((await r.h.read()).people[r.h.id].settings.wechatChannel, 'ilink');
  assert.equal(await r.deliver(), 1);
  assert.equal(r.ilink.sent().length, 1);
  assert.equal(r.ilink.sent()[0].to_user_id, USER);
  assert.equal(r.ilink.sent()[0].context_token, 'ctx-1');
  assert.match(r.ilink.sent()[0].client_id, /^weave:out:/);

  r.ilink.updates.push({ret: 0, msgs: [textMsg('今天走了 8000 步', {context_token: 'ctx-9'})]});
  await r.poll();
  assert.equal(r.results.at(-1).wake, true, 'the bridge is told to tick now');
  await r.tick();
  assert.equal(r.h.wakes().at(-1).body.trigger.text, '今天走了 8000 步');
  assert.equal(await r.deliver(), 1);
  assert.deepEqual([r.ilink.sent().at(-1).item_list[0].text_item.text, r.ilink.sent().at(-1).context_token], ['今天也辛苦了', 'ctx-9']);
  // Nothing is left to claim, and the position marker moved on.
  assert.equal(await r.deliver(), 0);
  assert.equal((await r.store.state()).accounts[BOT].buf, 'buf-1');
  assert.deepEqual((await r.h.read()).people[r.h.id].messages.at(-1).text, '今天也辛苦了');
});

test('a photo: downloaded, decrypted, stripped of its GPS position, and handed to Weave as the bytes; Weave wakes the Agent with it', async t => {
  const r = await rig(t, {agent: async () => reply('一片湖')});
  await bindAndConfirm(r);
  const key = randomBytes(16);
  r.ilink.files.set('p1', encrypt(DIRTY, key));
  r.ilink.updates.push({ret: 0, msgs: [imageMsg({aeskey: key.toString('hex'), media: {encrypt_query_param: 'p1'}})]});
  await r.poll();
  assert.equal(r.results.at(-1).wake, true);
  await r.tick();
  const wake = r.h.wakes().at(-1).body;
  assert.equal(wake.trigger.text, PHOTO_MESSAGE_TEXT);
  assert.deepEqual(wake.image, {mediaType: 'image/jpeg', data: Buffer.from(CLEAN_JPEG).toString('base64')});
  assert.ok(!JSON.stringify(wake).includes('GPS'));
  assert.equal(await r.deliver(), 1);
  assert.equal(r.ilink.sent().at(-1).item_list[0].text_item.text, '一片湖');
  assert.equal((await r.store.state()).photos.ok, 1);
});

test('a photo that cannot be opened (the CDN says 404): Weave is still woken, with the fact; what is said back is the Agent\'s, not the bridge\'s', async t => {
  const r = await rig(t, {agent: async () => reply('这张没打开，再发一次？')});
  await bindAndConfirm(r);
  r.ilink.updates.push({ret: 0, msgs: [imageMsg({media: {encrypt_query_param: 'missing'}, aeskey: randomBytes(16).toString('hex')})]});
  await r.poll();
  await r.tick();
  const wake = r.h.wakes().at(-1).body;
  assert.equal(wake.trigger.text, PHOTO_MESSAGE_TEXT + '\n' + PHOTO_UNAVAILABLE_FACT);
  assert.equal(wake.image, undefined);
  assert.equal(await r.deliver(), 1);
  assert.equal(r.ilink.sent().at(-1).item_list[0].text_item.text, '这张没打开，再发一次？');
  assert.equal((await r.store.state()).photos.failed, 1);
});

test('a photo over 2 MiB, or one that is not an image after decryption: same thing, woken with the fact, no bytes sent', async t => {
  for (const make of [() => new Uint8Array(2 * 1024 * 1024 + 1).fill(7).map((v, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : v)), () => new TextEncoder().encode('definitely not a photo')]) {
    const r = await rig(t, {agent: async () => reply('收到')});
    await bindAndConfirm(r);
    const key = randomBytes(16);
    r.ilink.files.set('p', encrypt(make(), key));
    r.ilink.updates.push({ret: 0, msgs: [imageMsg({aeskey: key.toString('hex'), media: {encrypt_query_param: 'p'}})]});
    await r.poll();
    await r.tick();
    assert.equal(r.h.wakes().at(-1).body.trigger.text, PHOTO_MESSAGE_TEXT + '\n' + PHOTO_UNAVAILABLE_FACT);
    assert.equal(r.h.wakes().at(-1).body.image, undefined);
  }
});

test('imageKey takes aeskey hex, or media.aes_key as 16 raw bytes or 32 hex characters, or none; anything else is refused', () => {
  const raw = randomBytes(16);
  assert.deepEqual(imageKey({aeskey: raw.toString('hex')}), raw);
  assert.deepEqual(imageKey({media: {aes_key: raw.toString('base64')}}), raw);
  assert.deepEqual(imageKey({media: {aes_key: Buffer.from(raw.toString('hex')).toString('base64')}}), raw);
  assert.equal(imageKey({media: {}}), null);
  assert.throws(() => imageKey({aeskey: 'zz'}));
  assert.throws(() => imageKey({media: {aes_key: Buffer.from('short').toString('base64')}}));
});

test('Weave down: the batch is not marked as read, and when it is back the same messages come again and are used once', async t => {
  const r = await rig(t);
  await bindAndConfirm(r);
  const msg = textMsg('记一下', {message_id: 777});
  r.ilink.updates.push({ret: 0, get_updates_buf: 'buf-2', msgs: [msg]});
  r.setDown(true);
  const before = (await r.store.state()).accounts[BOT]?.buf ?? '';
  assert.equal((await r.poll()).delayMs, 5000);
  assert.equal((await r.store.state()).accounts[BOT]?.buf ?? '', before, 'the position did not move');
  r.setDown(false);
  r.ilink.updates.push({ret: 0, get_updates_buf: 'buf-2', msgs: [msg]});
  await r.poll();
  r.ilink.updates.push({ret: 0, get_updates_buf: 'buf-3', msgs: [msg]}); // delivered a third time: a duplicate
  await r.poll();
  await r.tick();
  assert.equal(r.h.wakes().filter(w => w.body.trigger.text === '记一下').length, 1);
});

test('the iLink answers: not accepted (ret != 0) is reported as failed; a network error or a 502 is retried with no receipt; -14 on a send waits; no account for the person fails at once', async t => {
  const r = await rig(t);
  await bindAndConfirm(r);
  // Replies are queued by the real Agent path: a message in, a tick, the reply is in the outbound queue.
  const ask = async text => { r.ilink.updates.push({ret: 0, msgs: [textMsg(text)]}); await r.poll(); await r.tick(); };

  r.ilink.setSendReply({ret: 1, errcode: 0, errmsg: 'no'});
  await ask('一');
  assert.equal(await r.deliver(), 1);
  assert.equal((await r.store.state()).sent.failed, 1);
  assert.equal((await r.h.read()).wechat && Object.values((await r.h.read()).wechat).filter(e => e.direction === 'outbound' && e.status === 'failed').length, 1);

  r.ilink.failSends(true);
  await ask('二');
  assert.equal(await r.deliver(), 0, 'nothing delivered');
  assert.equal(Object.values((await r.h.read()).wechat).filter(e => e.direction === 'outbound' && e.status === 'sending').length, 1, 'still leased, no receipt');
  assert.equal((await r.store.state()).sent.retried, 1);
  r.ilink.failSends(false);
  r.ilink.setSendReply({ret: STALE_TOKEN});
  r.h.setNow(r.h.now + 6 * 60_000); // the lease runs out
  assert.equal(await r.deliver(), 0);
  r.ilink.setSendReply({ret: 0});
  r.h.setNow(r.h.now + 6 * 60_000);
  assert.equal(await r.deliver(), 1, 'the same job is claimed again and goes out once the key works');
  assert.equal(r.ilink.sent().at(-1).client_id, r.ilink.sent().at(-2).client_id, 'the same client_id for the retry');
});

test('a reply for someone the bridge holds no iLink account for is reported as failed at once, not retried for ever', async t => {
  const r = await rig(t);
  await bindAndConfirm(r);
  r.ilink.updates.push({ret: 0, msgs: [textMsg('在吗')]});
  await r.poll();
  await r.tick();
  await writeFile(r.store.files.accounts, '[]');
  assert.equal(await r.deliver(), 1);
  assert.equal(r.ilink.sent().length, 0);
  assert.equal(Object.values((await r.h.read()).wechat).filter(e => e.direction === 'outbound' && e.status === 'failed').length, 1);
});

test('-14 on the long poll pauses that person for an hour without a new scan; groups and the bot\'s own messages are not forwarded', async t => {
  const r = await rig(t);
  await bindAndConfirm(r);
  r.ilink.updates.push({ret: STALE_TOKEN, errmsg: 'stale'});
  assert.equal((await r.poll()).delayMs, 3600_000);
  assert.equal((await r.store.state()).polls.stale, 1);
  const before = r.ilink.requests.length;
  assert.ok((await r.poll()).delayMs > 0);
  assert.equal(r.ilink.requests.length, before, 'while paused it does not ask again');
  assert.match(await statusText(r.store), /钥匙失效（-14）1 次/);

  const s2 = await rig(t);
  await bindAndConfirm(s2);
  s2.ilink.updates.push({ret: 0, msgs: [textMsg('群里的话', {group_id: 'g1'}), textMsg('自己发的', {message_type: 2}), textMsg('别人的话', {from_user_id: 'o9other@im.wechat'})]});
  await s2.poll();
  await s2.tick();
  assert.equal(s2.h.wakes().length, 0);
});

test('status says nothing about what was said, and the origin must be https or this machine', async t => {
  const r = await rig(t);
  await bindAndConfirm(r);
  r.ilink.updates.push({ret: 0, msgs: [textMsg('一句很私密的话')]});
  await r.poll();
  const text = await statusText(r.store);
  assert.ok(!text.includes('私密') && !text.includes(USER) && !text.includes('tok-1'));
  assert.deepEqual(configFromEnv({WEAVE_ORIGIN: 'http://host.docker.internal:4317', WECHAT_BRIDGE_TOKEN: bridgeToken}), {origin: 'http://host.docker.internal:4317', token: bridgeToken});
  for (const origin of ['http://weave.example', 'http://host.docker.internal', 'http://evil.example:4317', '']) assert.throws(() => configFromEnv({WEAVE_ORIGIN: origin, WECHAT_BRIDGE_TOKEN: bridgeToken}), /WEAVE_ORIGIN/);
  assert.throws(() => configFromEnv({WEAVE_ORIGIN: 'https://weave.example', WECHAT_BRIDGE_TOKEN: 'short'}), /WECHAT_BRIDGE_TOKEN/);
});

test('every request to Weave says X-Weave-Channel: ilink, and a photo goes as raw bytes with the message, sender and time in headers', async t => {
  const seen = [];
  const r = await rig(t, {weaveFetch: async (url, init) => { seen.push({url: String(url), headers: init.headers, body: init.body}); return Response.json({accepted: true}); }});
  await r.weave('claim', {});
  await r.weave('image', {messageId: 'm1', senderId: USER, createdAt: '2030-01-01T00:00:00.000Z', bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png'});
  assert.ok(seen.every(c => c.headers['X-Weave-Channel'] === 'ilink' && c.headers.Authorization === 'Bearer ' + bridgeToken));
  assert.equal(seen[1].url, 'http://host.docker.internal:4317/api/internal/wechat/image');
  assert.deepEqual({...seen[1].headers, Authorization: undefined}, {'Content-Type': 'image/png', 'X-Weave-Message': 'm1', 'X-Weave-Sender': USER, 'X-Weave-Created-At': '2030-01-01T00:00:00.000Z', 'X-Weave-Channel': 'ilink', Authorization: undefined});
  assert.deepEqual([...seen[1].body], [1, 2, 3]);
});

async function bindAndConfirm(r) {
  r.ilink.updates.push({ret: 0, msgs: [textMsg(await bindInstruction(r))]});
  await r.poll();
  await r.deliver();
  r.ilink.requests.length = 0;
}
