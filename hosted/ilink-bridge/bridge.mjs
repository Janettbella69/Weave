// 微信官方给 Agent 的私聊通道 iLink 的桥接。
// 和小号那条路（hosted/wechat-bridge）说同一套接口，每个请求多带 X-Weave-Channel: ilink；iLink 只有私聊，群不在这里。
//   node bridge.mjs login    扫码连上一个人的微信（要在终端里跑，会画二维码；每个人自己扫一次，可以连好几个人）
//   node bridge.mjs run      一直跑：长轮询收消息 → 文字发 /events、照片解密后发 /image；领 Weave 排好的回复发出去；每分钟兜底 tick
//   node bridge.mjs status   看状态（只有时间、次数和结果，没有消息内容）
// 只往外连：不开端口、不挂公网。数据在 ILINK_DATA 目录（默认 /home/node）：accounts.json（钥匙，权限 600）、state.json（读到哪儿、每个人最近的 context_token）。
// 教材 p.20：这里只做「基础设施」该做的事——搬运、解密、去掉照片里的位置信息、发出去；怎么回、回不回，都是 Weave 的事，桥接不替它说话。
import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createIlink, short, STALE_TOKEN} from './ilink.mjs';
// 小号桥接里现成的几样：只发一次的执行器、tick、两个兜底循环，和去掉照片附加信息（拍摄时间、GPS 位置、设备）的 stripMetadata。
// 服务器上两个目录都只读挂进容器（../wechat-bridge）。
import {singleFlight, createTick, tickLoop, deliveryLoop, stripMetadata, sniffImage, PHOTO_MAX_BYTES} from '../wechat-bridge/bridge.mjs';

const HOUR = 3600_000;
const print = id => createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
const word = value => (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : '-');
const SEND_GAP_MS = 1000;
// 一次收到的图片，下载失败时再试几次（CDN 偶尔抖一下）。
const DOWNLOAD_TRIES = 3;

// ── 存储：账号（钥匙）和状态，各一个 JSON 文件，写的时候排成一队 ──────────────────────────────────────────────────────
export function createStore(dir) {
  const files = {accounts: resolve(dir, 'accounts.json'), state: resolve(dir, 'state.json')};
  let queue = Promise.resolve();
  const serial = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };
  const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } };
  const writeJson = async (path, value) => {
    await mkdir(dir, {recursive: true, mode: 0o700});
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 1), {mode: 0o600});
    await rename(temporary, path);
  };
  const freshAccountState = () => ({buf: '', longPollMs: null, contexts: {}, pausedUntil: 0});
  const freshState = () => ({
    accounts: {}, inbound: 0,
    polls: {ok: 0, errors: 0, stale: 0, lastOkAt: null, lastErrorAt: null, lastStaleAt: null},
    photos: {ok: 0, failed: 0}, sent: {ok: 0, failed: 0, retried: 0},
  });
  const loadState = async () => ({...freshState(), ...await readJson(files.state, {})});
  return {
    files,
    async accounts() { const list = await readJson(files.accounts, []); return Array.isArray(list) ? list : []; },
    // 同一个人再扫一次：换掉旧的钥匙，不留两份。
    addAccount: account => serial(async () => {
      const list = (await readJson(files.accounts, [])).filter(a => a.botId !== account.botId && (!account.userId || a.userId !== account.userId));
      await writeJson(files.accounts, [...list, account]);
    }),
    state: loadState,
    // 改 state：fn 拿到当前的、改了就存。同一时间只有一个在改。
    update: fn => serial(async () => { const s = await loadState(); const out = await fn(s); await writeJson(files.state, s); return out; }),
    accountState: (s, botId) => (s.accounts[botId] ??= freshAccountState()),
  };
}

// ── 和 Weave 说话（每个请求都带 X-Weave-Channel: ilink）──────────────────────────────────────────────────────────────
// 一张照片按字节发，属于哪条消息、谁发的、什么时候发的写在请求头里（不进地址，免得进访问日志）。别的都是 JSON。
export function createWeave({origin, token, fetcher = fetch}) {
  return async (path, data, {timeoutMs = 25000} = {}) => {
    const photo = data?.bytes instanceof Uint8Array;
    const headers = photo
      ? {'Content-Type': data.mediaType, 'X-Weave-Message': data.messageId, 'X-Weave-Sender': data.senderId, ...(data.createdAt ? {'X-Weave-Created-At': data.createdAt} : {})}
      : {'Content-Type': 'application/json'};
    const response = await fetcher(`${origin.replace(/\/$/, '')}/api/internal/wechat/${path}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: {...headers, 'X-Weave-Channel': 'ilink', Authorization: 'Bearer ' + token},
      body: photo ? data.bytes : JSON.stringify(data),
    });
    if (!response.ok) { const error = Error('Weave 拒绝了请求 (' + response.status + ')'); error.status = response.status; throw error; }
    return response.json();
  };
}

// ── 一条 iLink 消息 → Weave ────────────────────────────────────────────────────────────────────────────────────────────
const messageIdOf = (botId, message, text) => `${botId}:${message.message_id ?? message.seq ?? createHash('sha256').update(`${message.from_user_id}|${message.create_time_ms}|${text}`).digest('hex').slice(0, 24)}`;
const createdAtOf = message => (Number.isFinite(Number(message.create_time_ms)) && Number(message.create_time_ms) > 0 ? new Date(Number(message.create_time_ms)).toISOString() : undefined);

export function createBridge({ilink, weave, store, now = Date.now, log = (...args) => console.error(...args), sleep = delay, onResult = () => {}}) {
  // 一张照片：下载、解密、去掉附加信息，然后发 /image。哪一步不成都发一个空的 /image：Weave 照样叫醒 Weave（助理），
  // 并把「照片没能打开」当事实交给它，由它自己回（桥接不替它回话，也不吞掉这条消息）。
  const pollFailures = new Map();
  async function forwardImage(account, message, item, messageId) {
    const base = {messageId, senderId: message.from_user_id, createdAt: createdAtOf(message)};
    let bytes = null, mediaType = 'image/jpeg', problem = '';
    for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
      let plain;
      try { plain = await ilink.downloadImage(item.image_item); }
      catch (error) {
        if (String(error?.message).startsWith('图片钥匙')) { problem = 'key_invalid'; break; }
        if (attempt < DOWNLOAD_TRIES) { await sleep(1000); continue; }
        problem = 'download_failed'; break;
      }
      const type = sniffImage(plain);
      if (!type) problem = 'unsupported';
      else if (plain.length > PHOTO_MAX_BYTES) problem = 'too_large';
      else { try { bytes = stripMetadata(plain, type); mediaType = type; } catch { problem = 'strip_failed'; } }
      break;
    }
    // 给 Weave 的：能用的照片，或者一个空的（它当作「照片没能打开」）。
    const result = await weave('image', {...base, bytes: bytes ?? new Uint8Array(0), mediaType}, {timeoutMs: 60000});
    await store.update(s => { s.photos[bytes ? 'ok' : 'failed']++; });
    log(bytes ? `照片已交给 Weave（${mediaType}，${bytes.length} 字节）：${print(messageId)}` : `照片没能打开（${word(problem)}），已照样告诉 Weave：${print(messageId)}`);
    onResult(result);
  }

  // 一个人发来的一条消息。有任何一步没交给 Weave（它挂了）就抛错，这一批消息下次轮询重新来（Weave 按消息 id 去重）。
  async function handleMessage(account, message) {
    if (message.message_type === 2) return;      // 机器人自己发的
    if (message.group_id) return;                // iLink 只用来做私聊，群在小号那一路
    if (!account.userId) { account.userId = message.from_user_id; await store.addAccount(account); }
    if (message.from_user_id !== account.userId) return;
    const items = message.item_list ?? [];
    await store.update(s => {
      s.inbound++;
      if (message.context_token) store.accountState(s, account.botId).contexts[message.from_user_id] = message.context_token;
    });
    const text = items.filter(item => item.type === 1).map(item => item.text_item?.text ?? '').join('\n').trim();
    const id = messageIdOf(account.botId, message, text);
    if (text) onResult(await weave('events', {id, threadId: message.from_user_id, senderId: message.from_user_id, type: 1, direction: 'incoming', body: text, createdAt: createdAtOf(message)}));
    let n = 0;
    for (const item of items) if (item.type === 2) await forwardImage(account, message, item, `${id}:img${n++}`);
  }

  // 一次长轮询。返回下次要等多少毫秒。
  async function pollOnce(account, {signal} = {}) {
    const before = await store.state(), mine = before.accounts[account.botId] ?? {};
    if (mine.pausedUntil > now()) return {delayMs: Math.min(mine.pausedUntil - now(), HOUR)};
    let res, failure;
    try { res = await ilink.getUpdates(account, {buf: mine.buf ?? '', timeoutMs: mine.longPollMs || undefined, signal}); }
    catch (error) { if (signal?.aborted) return {delayMs: 0}; failure = short(error); }
    const at = new Date(now()).toISOString(), ret = res?.ret ?? 0, errcode = res?.errcode ?? 0;
    if (!failure && (ret === STALE_TOKEN || errcode === STALE_TOKEN)) {
      await store.update(s => { s.polls.stale++; s.polls.lastStaleAt = at; store.accountState(s, account.botId).pausedUntil = now() + HOUR; });
      log('iLink 说钥匙失效（-14）。照官方插件的做法，这个人停 1 小时再试（不用重新扫码）。');
      return {delayMs: HOUR};
    }
    if (failure || ret !== 0 || errcode !== 0) {
      const consecutive = (pollFailures.get(account.botId) ?? 0) + 1;
      pollFailures.set(account.botId, consecutive);
      await store.update(s => { s.polls.errors++; s.polls.lastErrorAt = at; });
      return {delayMs: consecutive >= 3 ? 30_000 : 2000};
    }
    pollFailures.set(account.botId, 0);
    try {
      for (const message of res.msgs ?? []) await handleMessage(account, message);
    } catch (error) {
      // Weave 暂时收不了：位置标记不往前挪，过一会儿这一批再来一遍（Weave 认得出已经收过的）。
      log('消息暂时交不给 Weave，稍后重来：' + short(error));
      await store.update(s => { s.polls.errors++; s.polls.lastErrorAt = at; });
      return {delayMs: 5000};
    }
    await store.update(s => {
      s.polls.ok++; s.polls.lastOkAt = at;
      const mine = store.accountState(s, account.botId);
      if (res.get_updates_buf) mine.buf = res.get_updates_buf;
      if (res.longpolling_timeout_ms > 0) mine.longPollMs = res.longpolling_timeout_ms;
    });
    // 服务器正常会把请求挂住几十秒。没消息还马上回了，等 1 秒再问，别把它问爆。
    return {delayMs: !(res.msgs ?? []).length ? 1000 : 0};
  }

  // 领 Weave 排好的回复，发出去，回执。发给谁看 threadId（就是这个人的 iLink 用户 id），用扫他的码得到的那个账号发。
  // 网络出错、服务器 5xx、钥匙失效：不回执，租约到了同一条（同一个 client_id）会再来。iLink 明确不收（别的错误码）：回执 failed。
  async function deliverOnce() {
    const {jobs} = await weave('claim', {});
    const accounts = await store.accounts();
    let delivered = 0;
    for (const job of jobs ?? []) {
      const account = accounts.find(a => a.userId === job.threadId);
      if (!account) { log('没有这个人的 iLink 账号，回执失败：' + print(job.id)); await weave('receipt', {id: job.id, state: 'failed'}); delivered++; continue; }
      const contextToken = (await store.state()).accounts[account.botId]?.contexts?.[job.threadId];
      let result;
      try { result = await ilink.sendText(account, {to: job.threadId, text: job.text, contextToken, clientId: `weave:${job.id}`}); }
      catch (error) { log('消息暂时发不出去，稍后用同一个 client_id 重试：' + short(error)); await store.update(s => { s.sent.retried++; }); continue; }
      if (result.ret === STALE_TOKEN || result.errcode === STALE_TOKEN) { log('发送时 iLink 说钥匙失效（-14），稍后重试：' + print(job.id)); await store.update(s => { s.sent.retried++; }); continue; }
      const state = result.ok ? 'accepted' : 'failed';
      if (!result.ok) log(`iLink 没收这条消息（ret=${result.ret} errcode=${result.errcode}），已向 Weave 报告发送失败：${print(job.id)}`);
      await weave('receipt', {id: job.id, state});
      await store.update(s => { s.sent[result.ok ? 'ok' : 'failed']++; });
      delivered++;
      await sleep(SEND_GAP_MS);
    }
    return delivered;
  }

  return {pollOnce, deliverOnce, handleMessage};
}

// ── 扫码登录 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function login({ilink, store, show, ask, log = console.log, now = Date.now, pollDelayMs = 1000, timeoutMs = 8 * 60_000, sleep = delay}) {
  let qr = await ilink.fetchQr();
  show(qr.qrcode_img_content);
  let host = ilink.baseUrl, verifyCode, scanned = false, attempts = 1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status;
    try { status = await ilink.qrStatus(qr.qrcode, {host, verifyCode}); } catch { status = {status: 'wait'}; }
    switch (status.status) {
      case 'scaned': verifyCode = undefined; if (!scanned) log('已扫码，请在手机上点确认。'); scanned = true; break;
      case 'need_verifycode': verifyCode = String(await ask(verifyCode ? '数字不对，请再输一次手机微信上显示的数字：' : '请输入手机微信上显示的数字：')).trim(); continue;
      case 'expired': case 'verify_code_blocked':
        if (++attempts > 3) throw Error('二维码失效三次了，先停下。过几分钟再跑一次就行。');
        log(status.status === 'expired' ? '二维码过期了，换一张：' : '数字输错太多次，换一张二维码：');
        qr = await ilink.fetchQr(); show(qr.qrcode_img_content); scanned = false; verifyCode = undefined; break;
      case 'scaned_but_redirect': if (status.redirect_host) host = `https://${status.redirect_host}`; break;
      case 'binded_redirect': throw Error('微信说这个微信之前已经连过，但这里没有那次的钥匙。先停下了。');
      case 'confirmed': {
        if (!status.bot_token || !status.ilink_bot_id) throw Error('微信确认了，但没有给钥匙（bot_token / ilink_bot_id）。');
        const saved = {botToken: status.bot_token, botId: status.ilink_bot_id, userId: status.ilink_user_id ?? null, baseUrl: status.baseurl || ilink.baseUrl, loggedInAt: new Date(now()).toISOString()};
        await store.addAccount(saved);
        return saved;
      }
      default: break;
    }
    if (pollDelayMs) await sleep(pollDelayMs);
  }
  throw Error('8 分钟里没有扫码，先停下了。再跑一次就行。');
}

export async function statusText(store, now = Date.now()) {
  const accounts = await store.accounts();
  if (!accounts.length) return '还没有人连上：先跑 login.sh 扫码。';
  const s = await store.state(), ago = at => (at ? `${((now - Date.parse(at)) / HOUR).toFixed(1)} 小时前` : '还没有');
  return [
    `已连上 ${accounts.length} 个人（只记了时间、次数和结果，没有记消息内容）`,
    ...accounts.map((a, i) => `  第 ${i + 1} 个：${ago(a.loggedInAt)}连上${s.accounts[a.botId]?.pausedUntil > now ? '，现在钥匙失效（-14），暂停中' : ''}`),
    `收消息：成功 ${s.polls.ok} 次，最近一次 ${ago(s.polls.lastOkAt)}；出错 ${s.polls.errors} 次，最近一次 ${ago(s.polls.lastErrorAt)}；钥匙失效（-14）${s.polls.stale} 次${s.polls.lastStaleAt ? `，最近一次 ${ago(s.polls.lastStaleAt)}` : ''}`,
    `收到的消息：${s.inbound} 条；照片：交出去 ${s.photos.ok} 张，没能打开 ${s.photos.failed} 张`,
    `发出去的回复：iLink 收下 ${s.sent.ok} 条，没收 ${s.sent.failed} 条，暂时没发出去、等重试 ${s.sent.retried} 次`,
  ].join('\n');
}

// ── 命令行 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function showQr(link) {
  try { createRequire(import.meta.url)('qrcode-terminal').generate(link, {small: true}); }
  catch { console.log('（这里没有画二维码的小工具 qrcode-terminal，只能给你链接。）'); }
  console.log(`用手机微信扫上面的二维码。扫不了的话，把下面这个链接发到手机微信里点开：\n${link}`);
}
const ask = question => new Promise(done => { const lines = createInterface({input: process.stdin, output: process.stdout}); lines.question(question, answer => { lines.close(); done(answer); }); });

export function configFromEnv(env = process.env) {
  const origin = (env.WEAVE_ORIGIN || '').replace(/\/$/, '');
  // 服务器上直连宿主机的 Weave 网站（http://host.docker.internal:4317）：不走公网和 nginx（它限了请求体 1 MB），令牌不出这台机器。
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(127\.0\.0\.1|host\.docker\.internal):\d+$/.test(origin)) throw Error('WEAVE_ORIGIN 必须是 HTTPS，或者本机的 http://127.0.0.1:端口、http://host.docker.internal:端口');
  if (!env.WECHAT_BRIDGE_TOKEN || env.WECHAT_BRIDGE_TOKEN.length < 32) throw Error('请配置 WECHAT_BRIDGE_TOKEN（至少 32 字符）');
  return {origin, token: env.WECHAT_BRIDGE_TOKEN};
}

export async function run(env = process.env) {
  for (const level of ['log', 'error']) console[level] = (write => (...args) => write(new Date().toISOString(), ...args))(console[level].bind(console));
  const {origin, token} = configFromEnv(env);
  const store = createStore(env.ILINK_DATA || '/home/node');
  const ilink = createIlink({baseUrl: env.ILINK_BASE_URL || undefined, cdnBaseUrl: env.ILINK_CDN_BASE_URL || undefined});
  const weave = createWeave({origin, token});
  const accounts = await store.accounts();
  if (!accounts.length) throw Error('还没有人连上：先跑 login.sh 扫码。');
  const stop = new AbortController();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; stop.abort(); setTimeout(() => process.exit(0), 3000).unref(); });
  // 收到 wake（有一条排进了队、等 Weave 的 Agent 去做）就马上 tick，tick 回来或者有 outbound 提示就马上发一遍；
  // 兜底：每分钟一次 tick、每 20 秒一次发送。tick 是 /api/internal/wechat/tick：Weave 在这里开始那一轮，可能要等好几次模型调用，所以超时很长。
  let ticking, delivery;
  const bridge = createBridge({ilink, weave, store, onResult: result => {
    if (result?.wake === true && !stopping) void ticking.request();
    if (result?.outbound === true && !stopping) void delivery.request();
  }});
  delivery = singleFlight(async () => { try { await bridge.deliverOnce(); } catch (error) { console.error('发送队列暂时不可用：' + short(error)); } });
  ticking = createTick({weave, afterTick: () => { if (!stopping) void delivery.request(); }});
  console.log(`iLink 桥接已启动（${accounts.length} 个人）。`);
  for (const account of accounts) void ilink.notify(account, 'start');
  for (const account of accounts) {
    void (async () => {
      while (!stopping) {
        let delayMs = 0;
        try { ({delayMs} = await bridge.pollOnce(account, {signal: stop.signal})); } catch (error) { console.error('收消息时出错：' + short(error)); delayMs = 5000; }
        if (delayMs && !stopping) await delay(delayMs, undefined, {signal: stop.signal}).catch(() => {});
      }
    })();
  }
  void tickLoop({ticking, isStopping: () => stopping});
  await deliveryLoop({delivery, isStopping: () => stopping});
  for (const account of accounts) await ilink.notify(account, 'stop');
}

async function main(command) {
  const env = process.env;
  if (command === 'run') return run(env).then(() => 0);
  const store = createStore(env.ILINK_DATA || '/home/node');
  if (command === 'status') { console.log(await statusText(store)); return 0; }
  if (command === 'login') {
    const ilink = createIlink({baseUrl: env.ILINK_BASE_URL || undefined, cdnBaseUrl: env.ILINK_CDN_BASE_URL || undefined});
    await login({ilink, store, show: showQr, ask});
    console.log('已连上 ✅');
    return 0;
  }
  console.error('用法：node bridge.mjs login | run | status');
  return 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(code => process.exit(code), error => { console.error(short(error)); process.exit(1); });
}
