// iLink 测试程序的测试：对着本机一个假的 iLink 服务器跑，不连微信、不花钱。
//   node --test scripts/ilink-probe/probe.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createCipheriv, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProbe, imageKey, nextProbe} from './probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const H = 3600_000;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const OWNER = 'owner-1@im.wechat';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(700)]);
const encrypt = (plain, key) => {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

// 假的 iLink：接口路径和字段照腾讯官方插件 @tencent-weixin/openclaw-weixin 2.4.10。
async function fakeIlink() {
  const requests = [];
  const updates = [];
  const files = new Map();
  let statuses = [];
  let sendReply = {ret: 0};
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fake');
    requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : null});
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    switch (url.pathname) {
      case '/ilink/bot/get_bot_qrcode': return json({qrcode: 'qr-1', qrcode_img_content: 'https://qr.example.test/qr-1'});
      case '/ilink/bot/get_qrcode_status': return json(statuses.shift() ?? {status: 'wait'});
      case '/ilink/bot/getupdates': {
        const next = updates.shift() ?? {ret: 0, msgs: []};
        await new Promise(resolve => setTimeout(resolve, next.holdMs ?? 20));
        return json(next);
      }
      case '/ilink/bot/sendmessage': return json(sendReply);
      case '/ilink/bot/msg/notifystart':
      case '/ilink/bot/msg/notifystop': return json({ret: 0});
      case '/c2c/download': {
        const file = files.get(url.searchParams.get('encrypted_query_param'));
        if (!file) { res.statusCode = 404; return res.end('missing'); }
        return res.end(file);
      }
      default: res.statusCode = 404; return res.end('unknown');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, requests, updates, files,
    setStatuses: list => { statuses = list; },
    setSendReply: reply => { sendReply = reply; },
    sent: () => requests.filter(r => r.path === '/ilink/bot/sendmessage').map(r => r.body.msg),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

const confirmed = base => ({status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-1@im.bot', ilink_user_id: OWNER, baseurl: base});
const textFrom = (from, text, contextToken, extra = {}) => ({message_type: 1, from_user_id: from, context_token: contextToken, item_list: [{type: 1, text_item: {text}}], ...extra});

async function setup(t, {hours = [1, 3, 6]} = {}) {
  const ilink = await fakeIlink();
  t.after(() => ilink.close());
  const dir = await mkdtemp(join(tmpdir(), 'ilink-probe-'));
  const clock = {now: T0};
  const probe = createProbe({dataDir: dir, baseUrl: ilink.base, cdnBaseUrl: `${ilink.base}/c2c`, now: () => clock.now, pollDelayMs: 0, schedule: hours, log: () => {}});
  ilink.setStatuses([confirmed(ilink.base)]);
  await probe.login({show: () => {}, ask: async () => assert.fail('不该问验证数字')});
  return {ilink, dir, clock, probe};
}

async function allStoredText(dir) {
  let text = '';
  for (const name of await readdir(dir, {recursive: true})) {
    const path = join(dir, name);
    if ((await stat(path)).isFile()) text += await readFile(path, 'utf8');
  }
  return text;
}

test('login shows the QR link, then saves the confirmed account readable only by its owner', async t => {
  const ilink = await fakeIlink();
  t.after(() => ilink.close());
  const dir = await mkdtemp(join(tmpdir(), 'ilink-probe-'));
  ilink.setStatuses([{status: 'wait'}, {status: 'scaned'}, confirmed(ilink.base)]);
  const shown = [];
  const probe = createProbe({dataDir: dir, baseUrl: ilink.base, now: () => T0, pollDelayMs: 0, log: () => {}});
  const account = await probe.login({show: url => shown.push(url), ask: async () => assert.fail('不该问验证数字')});

  assert.deepEqual(shown, ['https://qr.example.test/qr-1']);
  assert.equal(account.userId, OWNER);
  const saved = JSON.parse(await readFile(join(dir, 'account.json'), 'utf8'));
  assert.equal(saved.botToken, 'tok-1');
  assert.equal(saved.botId, 'bot-1@im.bot');
  assert.equal(saved.baseUrl, ilink.base);
  assert.equal((await stat(join(dir, 'account.json'))).mode & 0o777, 0o600);

  const qr = ilink.requests.find(r => r.path === '/ilink/bot/get_bot_qrcode');
  assert.equal(qr.query.bot_type, '3');
  assert.equal(qr.headers['ilink-app-id'], 'bot');
  assert.equal(qr.headers.authorization, undefined);
  assert.equal(ilink.requests.filter(r => r.path === '/ilink/bot/get_qrcode_status').at(-1).query.qrcode, 'qr-1');
});

test('login passes on the number shown on the phone when WeChat asks for it', async t => {
  const ilink = await fakeIlink();
  t.after(() => ilink.close());
  const dir = await mkdtemp(join(tmpdir(), 'ilink-probe-'));
  ilink.setStatuses([{status: 'need_verifycode'}, confirmed(ilink.base)]);
  const probe = createProbe({dataDir: dir, baseUrl: ilink.base, now: () => T0, pollDelayMs: 0, log: () => {}});
  await probe.login({show: () => {}, ask: async () => '42'});
  assert.equal(ilink.requests.filter(r => r.path === '/ilink/bot/get_qrcode_status').at(-1).query.verify_code, '42');
});

test('a text from the owner is answered at once with its context token, and its words are not stored', async t => {
  const {ilink, dir, probe} = await setup(t);
  ilink.updates.push({ret: 0, get_updates_buf: 'buf-1', msgs: [textFrom(OWNER, '你好 secret words', 'ctx-1')]});
  await probe.pollOnce();

  const [reply] = ilink.sent();
  assert.equal(reply.to_user_id, OWNER);
  assert.equal(reply.context_token, 'ctx-1');
  assert.equal(reply.message_type, 2);
  assert.equal(reply.message_state, 2);
  assert.match(reply.item_list[0].text_item.text, /收到/);

  const poll = ilink.requests.find(r => r.path === '/ilink/bot/getupdates');
  assert.equal(poll.headers.authorization, 'Bearer tok-1');
  assert.equal(poll.headers.authorizationtype, 'ilink_bot_token');
  assert.equal(poll.headers['ilink-app-clientversion'], String((2 << 16) | (4 << 8) | 10));
  assert.match(Buffer.from(poll.headers['x-wechat-uin'], 'base64').toString(), /^\d+$/);
  assert.equal(poll.body.get_updates_buf, '');

  await probe.pollOnce();
  assert.equal(ilink.requests.filter(r => r.path === '/ilink/bot/getupdates')[1].body.get_updates_buf, 'buf-1');
  assert.ok(!(await allStoredText(dir)).includes('secret words'));
});

test('an owner photo is downloaded from the CDN, decrypted and kept as a file', async t => {
  const {ilink, dir, probe} = await setup(t);
  const key = randomBytes(16);
  ilink.files.set('photo-1', encrypt(JPEG, key));
  ilink.updates.push({ret: 0, msgs: [{message_type: 1, from_user_id: OWNER, context_token: 'ctx-1', item_list: [{type: 2, image_item: {aeskey: key.toString('hex'), media: {encrypt_query_param: 'photo-1'}}}]}]});
  await probe.pollOnce();

  const photos = await readdir(join(dir, 'photos'));
  assert.equal(photos.length, 1);
  assert.match(photos[0], /\.jpg$/);
  assert.deepEqual(await readFile(join(dir, 'photos', photos[0])), JPEG);
  assert.equal((await stat(join(dir, 'photos', photos[0]))).mode & 0o777, 0o600);
  assert.match(ilink.sent()[0].item_list[0].text_item.text, /照片收到 ✅/);
  assert.match(await probe.status(), /照片：1 张，解开 1 张/);
});

test('imageKey prefers the hex key and accepts both base64 forms of media.aes_key', () => {
  const key = randomBytes(16);
  assert.deepEqual(imageKey({aeskey: key.toString('hex'), media: {aes_key: 'ignored'}}), key);
  assert.deepEqual(imageKey({media: {aes_key: key.toString('base64')}}), key);
  assert.deepEqual(imageKey({media: {aes_key: Buffer.from(key.toString('hex')).toString('base64')}}), key);
  assert.equal(imageKey({media: {}}), null);
  assert.throws(() => imageKey({media: {aes_key: randomBytes(8).toString('base64')}}));
  assert.throws(() => imageKey({aeskey: 'abcd'}));
});

test('nextProbe picks the latest due slot, counts the skipped ones as missed, and waits for a first message', () => {
  const hours = [1, 3, 6];
  assert.equal(nextProbe({now: T0 + 0.5 * H, epochAt: T0, done: [], hours}), null);
  assert.deepEqual(nextProbe({now: T0 + H, epochAt: T0, done: [], hours}), {index: 0, missed: []});
  assert.deepEqual(nextProbe({now: T0 + 4 * H, epochAt: T0, done: [], hours}), {index: 1, missed: [0]});
  assert.equal(nextProbe({now: T0 + 4 * H, epochAt: T0, done: [0, 1], hours}), null);
  assert.equal(nextProbe({now: T0 + 9 * H, epochAt: null, done: [], hours}), null);
});

test('probes go out on schedule, counted from the owner\'s latest message, using its context token', async t => {
  const {ilink, clock, probe} = await setup(t);
  ilink.updates.push({ret: 0, msgs: [textFrom(OWNER, 'hi', 'ctx-1')]});
  await probe.pollOnce();
  const replies = ilink.sent().length;

  clock.now = T0 + H;
  await probe.tick();
  clock.now = T0 + 1.5 * H;
  await probe.tick();
  clock.now = T0 + 3 * H;
  await probe.tick();
  let probes = ilink.sent().slice(replies);
  assert.equal(probes.length, 2);
  assert.match(probes[0].item_list[0].text_item.text, /^测试 #1：距你上次说话 1\.0 小时/);
  assert.match(probes[1].item_list[0].text_item.text, /^测试 #2：距你上次说话 3\.0 小时/);
  assert.equal(probes[1].context_token, 'ctx-1');

  clock.now = T0 + 4 * H;
  ilink.updates.push({ret: 0, msgs: [textFrom(OWNER, 'again', 'ctx-2')]});
  await probe.pollOnce();
  const replies2 = ilink.sent().length;
  clock.now = T0 + 5 * H;
  await probe.tick();
  probes = ilink.sent().slice(replies2);
  assert.equal(probes.length, 1);
  assert.match(probes[0].item_list[0].text_item.text, /^测试 #3：距你上次说话 1\.0 小时/);
  assert.equal(probes[0].context_token, 'ctx-2');
});

test('a long poll that runs past the server-given timeout counts as a normal empty poll', async t => {
  const {ilink, probe} = await setup(t);
  ilink.updates.push({ret: 0, msgs: [], longpolling_timeout_ms: 100});
  ilink.updates.push({ret: 0, msgs: [], holdMs: 400});
  await probe.pollOnce();
  await probe.pollOnce();
  assert.match(await probe.status(), /收消息：成功 2 次/);
  assert.match(await probe.status(), /出错 0 次/);
});

test('a stale token pauses polling for an hour and shows up in the status', async t => {
  const {ilink, probe} = await setup(t);
  ilink.updates.push({ret: -14, errcode: -14, errmsg: 'token stale'});
  assert.deepEqual(await probe.pollOnce(), {delayMs: H});
  assert.match(await probe.status(), /令牌失效（-14）1 次/);
});

test('a send the server rejects is recorded with its codes and not retried', async t => {
  const {ilink, clock, probe} = await setup(t);
  ilink.updates.push({ret: 0, msgs: [textFrom(OWNER, 'hi', 'ctx-1')]});
  await probe.pollOnce();
  ilink.setSendReply({ret: -2, errcode: -3, errmsg: 'context expired'});
  const before = ilink.sent().length;
  clock.now = T0 + H;
  await probe.tick();
  await probe.tick();
  assert.equal(ilink.sent().length, before + 1);
  assert.match(await probe.status(), /#1 +1\.0 小时 +→ 失败 ret=-2 errcode=-3 context expired/);
});

test('messages from anyone else and the bot\'s own echoes are ignored', async t => {
  const {ilink, clock, probe} = await setup(t);
  ilink.updates.push({ret: 0, msgs: [textFrom('someone-else@im.wechat', 'hi', 'ctx-x'), textFrom(OWNER, 'echo', 'ctx-y', {message_type: 2})]});
  await probe.pollOnce();
  clock.now = T0 + 7 * H;
  await probe.tick();
  assert.equal(ilink.sent().length, 0);
  assert.match(await probe.status(), /还没收到你的第一条消息/);
});

test('the run command polls until it is stopped, then tells iLink it went offline', async t => {
  const ilink = await fakeIlink();
  t.after(() => ilink.close());
  const dir = await mkdtemp(join(tmpdir(), 'ilink-probe-'));
  await writeFile(join(dir, 'account.json'), JSON.stringify({botToken: 'tok-1', botId: 'bot-1@im.bot', userId: OWNER, baseUrl: ilink.base, loggedInAt: new Date(T0).toISOString()}), {mode: 0o600});
  const child = spawn(process.execPath, [join(here, 'probe.mjs'), 'run'], {env: {...process.env, PROBE_DATA: dir}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 5000;
  while (!ilink.requests.some(r => r.path === '/ilink/bot/getupdates') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  child.kill('SIGTERM');
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0, output);
  assert.ok(ilink.requests.some(r => r.path === '/ilink/bot/msg/notifystart'), output);
  assert.ok(ilink.requests.some(r => r.path === '/ilink/bot/msg/notifystop'), output);
});

test('the status command works before anyone has logged in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ilink-probe-'));
  const child = spawn(process.execPath, [join(here, 'probe.mjs'), 'status'], {env: {...process.env, PROBE_DATA: dir}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(output, /还没连上/);
});
