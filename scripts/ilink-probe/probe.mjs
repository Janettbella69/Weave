#!/usr/bin/env node
// iLink 通道测试（实验，不是产品代码）：看微信官方给 Agent 的私聊通道 iLink 能不能当 Weave 私聊的底座。
// 要回答三件事：
//   1. 绑定能不能撑过 72 小时、撑满一周（小号那条路，每次登录 72 小时就被微信作废）；
//   2. 用户多久不说话以后，主动发的消息就送不到了（网上说是 24 小时，不是官方说法）；
//   3. 用户发来的照片能不能拿到，并解密成一个文件。
//
// 协议照腾讯官方插件 @tencent-weixin/openclaw-weixin 2.4.10（MIT）的写法：扫码登录、长轮询收消息、
// 发消息、从 CDN 下载图片再用 AES-128-ECB 解密。只用 Node 自带的东西；画二维码用 qrcode-terminal，
// 装了就用，没装就只给链接。
//
//   node probe.mjs login    扫码连上（要在终端里跑：会画二维码，微信可能还要你输入手机上显示的数字）
//   node probe.mjs run      一直跑：收消息、马上回一句、按计划发测试消息
//   node probe.mjs status   看结果（只有时间、类型和结果，没有消息内容）
//
// 数据都在 PROBE_DATA 目录（默认 ~/.ilink-probe）：account.json（钥匙，权限 600）、state.json、
// events.jsonl（发生了什么，不含消息内容）、photos/（解开的照片，测完连目录一起删）。
import {createDecipheriv, randomBytes} from 'node:crypto';
import {appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

export const OFFICIAL_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const OFFICIAL_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
// 这几项照官方插件 2.4.10：iLink-App-Id 是它 package.json 里的 ilink_appid，
// iLink-App-ClientVersion 把版本号编成 0x00MMNNPP，bot_type 3 是它扫码时用的默认值。
const PROTOCOL_VERSION = '2.4.10';
const APP_ID = 'bot';
const CLIENT_VERSION = String(PROTOCOL_VERSION.split('.').reduce((value, part) => (value << 8) | (Number(part) & 0xff), 0));
const BOT_TYPE = '3';
// bot_agent 是自报身份（插件的注释：只用来记日志和统计，不做鉴权），照实写这是测试程序。
const BOT_AGENT = 'Weave-ilink-probe/0.1';
// 服务器说钥匙失效时回的错误码。插件的做法是停 1 小时再接着用，不让人重新扫码。
const STALE_TOKEN = -14;
const LONG_POLL_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
const H = 3600_000;
const DAY = 24 * H;
// 距用户最后一句话多少小时发一条测试。24 小时前后排得密一点，好看清是不是卡在 24 小时。
export const DEFAULT_SCHEDULE_HOURS = [1, 3, 6, 12, 18, 22, 24, 26, 30, 36, 48, 60, 72, 96, 120, 144, 168];
const TYPE_NAMES = {1: '文字', 2: '图片', 3: '语音', 4: '文件', 5: '视频'};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const iso = ms => new Date(ms).toISOString();
const short = error => String(error?.message ?? error).slice(0, 200);
const endpoint = (base, path) => new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
const randomUin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');
const commonHeaders = () => ({'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': CLIENT_VERSION});
const postHeaders = token => ({
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': randomUin(),
  ...commonHeaders(),
  ...(token ? {Authorization: `Bearer ${token}`} : {}),
});
const baseInfo = () => ({channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT});

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, {once: true});
  });
}

async function request(fetchFn, url, {method = 'POST', body, token, timeoutMs, signal}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, {once: true});
  try {
    const res = await fetchFn(url, {
      method,
      headers: method === 'GET' ? commonHeaders() : postHeaders(token),
      ...(method === 'GET' ? {} : {body: JSON.stringify(body)}),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

// 图片的解密钥匙：先用 image_item.aeskey（16 字节的十六进制），没有再用 media.aes_key（base64，
// 解出来是 16 字节原样，或者 32 个十六进制字符）。两者都没有就是没加密。照插件 media-download.ts / pic-decrypt.ts。
export function imageKey(image) {
  if (image?.aeskey) {
    if (!/^[0-9a-f]{32}$/i.test(image.aeskey)) throw Error('图片钥匙 aeskey 不是 16 字节的十六进制');
    return Buffer.from(image.aeskey, 'hex');
  }
  const encoded = image?.media?.aes_key;
  if (!encoded) return null;
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length === 16) return raw;
  const ascii = raw.toString('ascii');
  if (raw.length === 32 && /^[0-9a-f]{32}$/i.test(ascii)) return Buffer.from(ascii, 'hex');
  throw Error(`图片钥匙 media.aes_key 格式不对（${raw.length} 字节）`);
}

function imageFormat(data) {
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
  if (data.subarray(0, 8).equals(PNG)) return 'png';
  if (data.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function decryptAesEcb(data, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// 现在该发第几条测试：计划里已经到点、还没发的最后一个时间点；它前面没发的（程序停过）记成跳过，
// 不补发，免得一下子来好几条。用户还没说过话（epochAt 为空）就不发。
export function nextProbe({now, epochAt, done, hours}) {
  if (epochAt == null) return null;
  let index = -1;
  for (let i = 0; i < hours.length; i++) if (epochAt + hours[i] * H <= now) index = i;
  if (index < 0 || done.includes(index)) return null;
  const missed = [];
  for (let i = 0; i < index; i++) if (!done.includes(i)) missed.push(i);
  return {index, missed};
}

const freshState = () => ({
  getUpdatesBuf: '', longPollMs: null,
  epochAt: null, lastInboundAt: null, contextToken: null, inbound: 0,
  probes: 0, done: [],
  polls: {ok: 0, errors: 0, consecutive: 0, stale: 0, lastOkAt: null, lastErrorAt: null, lastStaleAt: null, paused: false},
});

export function createProbe({
  dataDir,
  baseUrl = OFFICIAL_BASE_URL,
  cdnBaseUrl = OFFICIAL_CDN_BASE_URL,
  schedule = DEFAULT_SCHEDULE_HOURS,
  now = Date.now,
  fetchFn = fetch,
  log = line => console.log(line),
  pollDelayMs = 1000,
} = {}) {
  const files = {
    account: join(dataDir, 'account.json'),
    state: join(dataDir, 'state.json'),
    events: join(dataDir, 'events.jsonl'),
    photos: join(dataDir, 'photos'),
  };
  // 收消息和定时发测试会同时改 state.json：排成一队，一次只改一个。
  let queue = Promise.resolve();
  const serial = task => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const ensureDir = () => mkdir(dataDir, {recursive: true, mode: 0o700});
  async function readJson(path, fallback) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
  }
  async function writeJson(path, value, mode = 0o600) {
    await ensureDir();
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 1), {mode});
    await rename(temporary, path);
  }
  const account = () => readJson(files.account, null);
  async function loadState() {
    const saved = await readJson(files.state, {});
    const state = {...freshState(), ...saved};
    state.polls = {...freshState().polls, ...saved.polls};
    return state;
  }
  const saveState = state => writeJson(files.state, state);
  async function record(event) {
    await ensureDir();
    await appendFile(files.events, `${JSON.stringify({at: iso(now()), ...event})}\n`, {mode: 0o600});
  }
  async function events() {
    try {
      return (await readFile(files.events, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch { return []; }
  }
  const dayNumber = (owner, at) => Math.floor((at - Date.parse(owner.loggedInAt)) / DAY) + 1;

  async function login({show, ask, force = false, timeoutMs = 8 * 60_000}) {
    const existing = await account();
    if (existing && !force) return existing;
    const fetchQr = () => request(fetchFn, endpoint(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`), {body: {local_token_list: []}, timeoutMs: API_TIMEOUT_MS});
    let qr = await fetchQr();
    show(qr.qrcode_img_content);
    let host = baseUrl;
    let verifyCode;
    let scanned = false;
    let attempts = 1;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let status;
      try {
        const query = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`;
        status = await request(fetchFn, endpoint(host, query), {method: 'GET', timeoutMs: LONG_POLL_MS});
      } catch {
        status = {status: 'wait'}; // 长轮询到点或者网络抖一下：当作还在等，插件也是这样
      }
      switch (status.status) {
        case 'scaned':
          verifyCode = undefined;
          if (!scanned) log('已扫码，请在手机上点确认。');
          scanned = true;
          break;
        case 'need_verifycode':
          verifyCode = String(await ask(verifyCode ? '数字不对，请再输一次手机微信上显示的数字：' : '请输入手机微信上显示的数字：')).trim();
          continue;
        case 'expired':
        case 'verify_code_blocked':
          if (++attempts > 3) throw Error('二维码失效三次了，先停下。过几分钟再跑一次就行。');
          log(status.status === 'expired' ? '二维码过期了，换一张：' : '数字输错太多次，换一张二维码：');
          qr = await fetchQr();
          show(qr.qrcode_img_content);
          scanned = false;
          verifyCode = undefined;
          break;
        case 'scaned_but_redirect':
          if (status.redirect_host) host = `https://${status.redirect_host}`;
          break;
        case 'binded_redirect':
          throw Error('微信说这个微信之前已经连过，但这里没有那次的钥匙。先停下了。');
        case 'confirmed': {
          if (!status.bot_token || !status.ilink_bot_id) throw Error('微信确认了，但没有给钥匙（bot_token / ilink_bot_id）。');
          const saved = {botToken: status.bot_token, botId: status.ilink_bot_id, userId: status.ilink_user_id ?? null, baseUrl: status.baseurl || baseUrl, loggedInAt: iso(now())};
          await writeJson(files.account, saved);
          await record({kind: 'login', userId: Boolean(saved.userId)});
          return saved;
        }
        default:
          break;
      }
      if (pollDelayMs) await sleep(pollDelayMs);
    }
    throw Error('8 分钟里没有扫码，先停下了。再跑一次就行。');
  }

  async function send(state, owner, text, details) {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: owner.userId,
        client_id: `weave-ilink-probe:${now()}-${randomBytes(4).toString('hex')}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{type: 1, text_item: {text}}],
        context_token: state.contextToken ?? undefined,
      },
      base_info: baseInfo(),
    };
    let result;
    try {
      const res = await request(fetchFn, endpoint(owner.baseUrl, 'ilink/bot/sendmessage'), {body, token: owner.botToken, timeoutMs: API_TIMEOUT_MS});
      const ret = res.ret ?? 0;
      const errcode = res.errcode ?? 0;
      result = {ok: ret === 0 && errcode === 0, ret, errcode, errmsg: res.errmsg ?? ''};
    } catch (error) {
      result = {ok: false, error: short(error)};
    }
    await record({...details, ...result, contextToken: Boolean(state.contextToken)});
    return result;
  }

  async function savePhoto(image, at) {
    let result;
    try {
      const key = imageKey(image);
      const media = image?.media ?? {};
      const link = media.full_url || (media.encrypt_query_param ? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : null);
      if (!link) throw Error('消息里没有图片地址');
      const res = await fetchFn(link, {signal: AbortSignal.timeout(60_000)});
      if (!res.ok) throw Error(`CDN 回了 HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_PHOTO_BYTES) throw Error('图片超过 30 MB');
      const plain = key ? decryptAesEcb(data, key) : data;
      const format = imageFormat(plain);
      if (!format) throw Error('解出来的不是 JPEG/PNG/GIF/WebP（钥匙可能不对）');
      await mkdir(files.photos, {recursive: true, mode: 0o700});
      await writeFile(join(files.photos, `${iso(at).replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}.${format}`), plain, {mode: 0o600});
      result = {ok: true, bytes: plain.length, format, key: image?.aeskey ? 'aeskey' : key ? 'media.aes_key' : 'none', fullUrl: Boolean(media.full_url)};
    } catch (error) {
      result = {ok: false, error: short(error)};
    }
    await record({kind: 'photo', ...result});
    return result;
  }

  async function handleMessage(state, owner, message) {
    if (message.message_type === 2) return; // 机器人自己发的
    if (!owner.userId) {
      owner.userId = message.from_user_id;
      await writeJson(files.account, owner);
    }
    if (message.from_user_id !== owner.userId) {
      await record({kind: 'other_sender'});
      return;
    }
    const at = now();
    const items = message.item_list ?? [];
    state.inbound += 1;
    state.lastInboundAt = iso(at);
    state.epochAt = at; // 从这句话开始重新数「多久没说话」
    state.done = [];
    if (message.context_token) state.contextToken = message.context_token;
    await record({
      kind: 'inbound',
      types: items.map(item => TYPE_NAMES[item.type] ?? `type${item.type}`),
      textChars: items.reduce((sum, item) => sum + (item.text_item?.text?.length ?? 0), 0),
      contextToken: Boolean(message.context_token),
      sentAt: message.create_time_ms ? iso(Number(message.create_time_ms)) : null,
    });
    const photos = [];
    for (const item of items) if (item.type === 2) photos.push(await savePhoto(item.image_item, at));
    const text = photos.length
      ? photos.map(photo => photo.ok ? `照片收到 ✅ 已经解开存好（${photo.format}，${Math.round(photo.bytes / 1024)} KB）。` : `照片收到了，但没解开：${photo.error}`).join('\n')
      : `收到 ✅ 连接正常（连上后第 ${dayNumber(owner, at)} 天）。先别回我，我会隔几个小时发一条测试。`;
    await send(state, owner, text, {kind: 'reply'});
    log(`收到你的消息（${items.map(item => TYPE_NAMES[item.type] ?? '其他').join('、') || '空'}），已回复。`);
  }

  async function pollOnce({signal} = {}) {
    const owner = await account();
    if (!owner) throw Error('还没连上：先扫码（login）。');
    const before = await loadState();
    const started = Date.now();
    let res;
    let failure;
    try {
      res = await request(fetchFn, endpoint(owner.baseUrl, 'ilink/bot/getupdates'), {body: {get_updates_buf: before.getUpdatesBuf ?? '', base_info: baseInfo()}, token: owner.botToken, timeoutMs: before.longPollMs || LONG_POLL_MS, signal});
    } catch (error) {
      if (signal?.aborted) return {delayMs: 0}; // 程序要停了
      // 等到点还没消息、是我们这边先断开的：正常，官方插件也当成一次空的成功。
      if (error?.name === 'AbortError') res = {ret: 0, msgs: []};
      else failure = short(error);
    }
    return serial(async () => {
      const state = await loadState();
      const at = iso(now());
      const ret = res?.ret ?? 0;
      const errcode = res?.errcode ?? 0;
      if (!failure && (ret === STALE_TOKEN || errcode === STALE_TOKEN)) {
        state.polls.stale += 1;
        state.polls.lastStaleAt = at;
        state.polls.paused = true;
        await saveState(state);
        await record({kind: 'stale_token', ret, errcode, errmsg: res.errmsg ?? ''});
        log('服务器说钥匙失效（-14）。照官方插件的做法，停 1 小时再接着试。');
        return {delayMs: H};
      }
      if (failure || ret !== 0 || errcode !== 0) {
        state.polls.errors += 1;
        state.polls.consecutive += 1;
        state.polls.lastErrorAt = at;
        await saveState(state);
        await record({kind: 'poll_error', ...(failure ? {error: failure} : {ret, errcode, errmsg: res.errmsg ?? ''})});
        return {delayMs: state.polls.consecutive >= 3 ? 30_000 : 2000};
      }
      if (state.polls.paused) {
        state.polls.paused = false;
        await record({kind: 'recovered'}); // 钥匙失效之后，同一把钥匙又能用了
      }
      state.polls.ok += 1;
      state.polls.consecutive = 0;
      state.polls.lastOkAt = at;
      if (res.get_updates_buf) state.getUpdatesBuf = res.get_updates_buf;
      if (res.longpolling_timeout_ms > 0) state.longPollMs = res.longpolling_timeout_ms;
      const messages = res.msgs ?? [];
      for (const message of messages) await handleMessage(state, owner, message);
      await saveState(state);
      // 服务器正常会把请求挂住几十秒。要是没消息还马上回了，等 1 秒再问，别把它问爆。
      return {delayMs: !messages.length && Date.now() - started < 1000 ? 1000 : 0};
    });
  }

  function tick() {
    return serial(async () => {
      const owner = await account();
      if (!owner) return null;
      const state = await loadState();
      const due = nextProbe({now: now(), epochAt: state.epochAt, done: state.done, hours: schedule});
      if (!due) return null;
      for (const slot of due.missed) {
        state.done.push(slot);
        await record({kind: 'probe_missed', plannedHours: schedule[slot]});
      }
      state.done.push(due.index);
      state.probes += 1;
      const number = state.probes;
      const silence = (now() - state.epochAt) / H;
      // 先记下再发：发失败也不重发，要看的正是「这个时刻发不发得出去」。
      await saveState(state);
      const result = await send(state, owner, `测试 #${number}：距你上次说话 ${silence.toFixed(1)} 小时。不用回。`, {kind: 'probe', number, plannedHours: schedule[due.index], silenceHours: Number(silence.toFixed(2))});
      log(`测试 #${number}（距上次说话 ${silence.toFixed(1)} 小时）：${result.ok ? '服务器收下了' : '没发出去'}`);
      return result;
    });
  }

  async function notify(kind) {
    const owner = await account();
    if (!owner) return;
    try {
      await request(fetchFn, endpoint(owner.baseUrl, `ilink/bot/msg/notify${kind}`), {body: {base_info: baseInfo()}, token: owner.botToken, timeoutMs: 10_000});
    } catch (error) {
      log(`通知 iLink「${kind === 'start' ? '上线' : '下线'}」没成功（不影响测试）：${short(error)}`);
    }
  }

  async function status() {
    const owner = await account();
    if (!owner) return '还没连上：先跑 start.sh 扫码。';
    const state = await loadState();
    const all = await events();
    const t = now();
    const ago = at => (at ? `${((t - Date.parse(at)) / H).toFixed(1)} 小时前` : '还没有');
    const failed = event => (event.error ? `失败 ${event.error}` : `失败 ret=${event.ret} errcode=${event.errcode} ${event.errmsg}`.trim());
    const photos = all.filter(event => event.kind === 'photo');
    const goodPhotos = photos.filter(event => event.ok);
    const probes = all.filter(event => event.kind === 'probe');
    const missed = all.filter(event => event.kind === 'probe_missed').length;
    const badReplies = all.filter(event => event.kind === 'reply' && !event.ok);
    const lines = [
      'iLink 测试结果（只记了时间、类型和结果，没有记消息内容）',
      `连接：${ago(owner.loggedInAt)}连上，现在是第 ${dayNumber(owner, t)} 天`,
      `收消息：成功 ${state.polls.ok} 次，最近一次 ${ago(state.polls.lastOkAt)}；出错 ${state.polls.errors} 次；令牌失效（-14）${state.polls.stale} 次${state.polls.lastStaleAt ? `，最近一次 ${ago(state.polls.lastStaleAt)}${state.polls.paused ? '（还没恢复）' : '（后来恢复了）'}` : ''}`,
      state.inbound ? `你的消息：${state.inbound} 条，最近一次 ${ago(state.lastInboundAt)}` : '你的消息：还没收到你的第一条消息',
      `照片：${photos.length} 张，解开 ${goodPhotos.length} 张${goodPhotos.length ? `（${goodPhotos.map(photo => `${photo.format} ${Math.round(photo.bytes / 1024)} KB`).join('、')}）` : ''}${photos.length > goodPhotos.length ? `；没解开的原因：${photos.filter(photo => !photo.ok).map(photo => photo.error).join('；')}` : ''}`,
      ...(badReplies.length ? [`马上回你的那句，有 ${badReplies.length} 次没发出去：${badReplies.map(failed).join('；')}`] : []),
      probes.length ? '测试消息（距你上次说话多久发的 → 服务器怎么回）：' : '测试消息：还没发',
      ...probes.map(event => `  #${event.number}  ${event.silenceHours.toFixed(1)} 小时  → ${event.ok ? '服务器收下了' : failed(event)}`),
      ...(missed ? [`  另有 ${missed} 个时间点因为程序当时没在跑，跳过了`] : []),
      ...(probes.length ? ['「服务器收下了」不等于送到了，以你手机上看到的为准。'] : []),
    ];
    return lines.join('\n');
  }

  return {login, pollOnce, tick, notify, status, account, record};
}

// ── 命令行 ──────────────────────────────────────────────────────────────

function showQr(link) {
  try {
    createRequire(import.meta.url)('qrcode-terminal').generate(link, {small: true});
  } catch {
    console.log('（这里没有画二维码的小工具 qrcode-terminal，只能给你链接。）');
  }
  console.log(`用手机微信扫上面的二维码。扫不了的话，把下面这个链接发到手机微信里点开：\n${link}`);
}

function ask(question) {
  return new Promise(resolve => {
    const lines = createInterface({input: process.stdin, output: process.stdout});
    lines.question(question, answer => { lines.close(); resolve(answer); });
  });
}

function scheduleFromEnv(raw) {
  if (!raw) return DEFAULT_SCHEDULE_HOURS;
  const hours = raw.split(',').map(Number);
  if (!hours.length || hours.some((value, i) => !(value > 0) || (i && value <= hours[i - 1]))) throw Error('PROBE_SCHEDULE_HOURS 要是从小到大的正数，用逗号隔开');
  return hours;
}

async function run(probe) {
  if (!(await probe.account())) {
    console.error('还没连上：先扫码（login）。');
    return 1;
  }
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  await probe.notify('start');
  await probe.record({kind: 'run_start'});
  console.log('开始了：在收消息，每分钟看一次要不要发测试消息。');
  const due = () => probe.tick().catch(error => console.error(`发测试消息时出错：${short(error)}`));
  due();
  const timer = setInterval(due, 60_000);
  while (!stop.signal.aborted) {
    let delayMs = 0;
    try {
      ({delayMs} = await probe.pollOnce({signal: stop.signal}));
    } catch (error) {
      console.error(`收消息时出错：${short(error)}`);
      delayMs = 5000;
    }
    if (delayMs) await sleep(delayMs, stop.signal);
  }
  clearInterval(timer);
  await probe.notify('stop');
  await probe.record({kind: 'run_stop'});
  console.log('停了。');
  return 0;
}

async function main(command) {
  const probe = createProbe({
    dataDir: process.env.PROBE_DATA || join(homedir(), '.ilink-probe'),
    baseUrl: process.env.PROBE_BASE_URL || OFFICIAL_BASE_URL,
    cdnBaseUrl: process.env.PROBE_CDN_BASE_URL || OFFICIAL_CDN_BASE_URL,
    schedule: scheduleFromEnv(process.env.PROBE_SCHEDULE_HOURS),
  });
  if (command === 'status') {
    console.log(await probe.status());
    return 0;
  }
  if (command === 'login') {
    const existing = await probe.account();
    if (existing) {
      console.log(`已经连上过了（${existing.loggedInAt}）。要换个微信重新连，先跑 stop.sh --delete-data。`);
      return 0;
    }
    await probe.login({show: showQr, ask});
    // 接下来要做的事由 start.sh 在后台程序跑起来以后再说，免得第一句话发在程序开始收之前。
    console.log('已连上 ✅');
    return 0;
  }
  if (command === 'run') return run(probe);
  console.error('用法：node probe.mjs login | run | status');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(
    code => process.exit(code),
    error => { console.error(short(error)); process.exit(1); },
  );
}
