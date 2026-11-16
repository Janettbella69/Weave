// iLink 的协议：微信官方给 Agent 的私聊通道（腾讯官方插件 @tencent-weixin/openclaw-weixin 2.4.10，MIT）。
// 写法照 scripts/ilink-probe/probe.mjs（分支 exp/ilink-probe，2026-11 在服务器上实测过：扫码、收文字、收照片并解密）。
// 这个文件只管和 iLink 说话，不认识 Weave；只用 Node 自带的东西。
import {createDecipheriv, randomBytes} from 'node:crypto';

export const OFFICIAL_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const OFFICIAL_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
// 这几项照官方插件 2.4.10：iLink-App-Id 是它 package.json 里的 ilink_appid，iLink-App-ClientVersion 把版本号编成 0x00MMNNPP，
// bot_type 3 是它扫码时用的默认值。
const PROTOCOL_VERSION = '2.4.10';
const APP_ID = 'bot';
const CLIENT_VERSION = String(PROTOCOL_VERSION.split('.').reduce((value, part) => (value << 8) | (Number(part) & 0xff), 0));
const BOT_TYPE = '3';
// bot_agent 是自报身份（插件的注释：只用来记日志和统计，不做鉴权），照实写这是 Weave 的桥接。
const BOT_AGENT = 'Weave-ilink-bridge/1.0';
// 服务器说钥匙失效时回的错误码。插件的做法是停 1 小时再接着用，不让人重新扫码。
export const STALE_TOKEN = -14;
export const LONG_POLL_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
// 照片从 CDN 下载的上限（加密后的大小）。Weave 只收 2 MiB，这里放宽一点，是为了先下下来、再明确告诉 Weave「太大」。
const DOWNLOAD_LIMIT = 30 * 1024 * 1024;

const endpoint = (base, path) => new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
const randomUin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');
const commonHeaders = () => ({'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': CLIENT_VERSION});
const postHeaders = token => ({
  'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': randomUin(), ...commonHeaders(),
  ...(token ? {Authorization: `Bearer ${token}`} : {}),
});
const baseInfo = () => ({channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT});
export const short = error => String(error?.message ?? error).slice(0, 200);

// 图片的解密钥匙：先用 image_item.aeskey（16 字节的十六进制），没有再用 media.aes_key（base64，解出来是 16 字节原样，或者 32 个十六进制字符）。
// 两者都没有就是没加密。照插件 media-download.ts / pic-decrypt.ts。
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
export function decryptAesEcb(data, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function createIlink({fetchFn = fetch, baseUrl = OFFICIAL_BASE_URL, cdnBaseUrl = OFFICIAL_CDN_BASE_URL} = {}) {
  async function request(url, {method = 'POST', body, token, timeoutMs = API_TIMEOUT_MS, signal}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forward = () => controller.abort();
    signal?.addEventListener('abort', forward, {once: true});
    try {
      const res = await fetchFn(url, {method, headers: method === 'GET' ? commonHeaders() : postHeaders(token), ...(method === 'GET' ? {} : {body: JSON.stringify(body)}), signal: controller.signal});
      const text = await res.text();
      if (!res.ok) throw Object.assign(Error(`HTTP ${res.status}`), {status: res.status});
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  }
  return {
    baseUrl,
    // 扫码登录。
    fetchQr: () => request(endpoint(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`), {body: {local_token_list: []}}),
    qrStatus: (qrcode, {host = baseUrl, verifyCode} = {}) => request(
      endpoint(host, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`),
      {method: 'GET', timeoutMs: LONG_POLL_MS}),
    // 长轮询收消息。到点没有消息、是我们这边先断开的：当作一次空的成功（官方插件也是这样）。
    async getUpdates(account, {buf = '', timeoutMs = LONG_POLL_MS, signal} = {}) {
      try {
        return await request(endpoint(account.baseUrl, 'ilink/bot/getupdates'), {body: {get_updates_buf: buf, base_info: baseInfo()}, token: account.botToken, timeoutMs, signal});
      } catch (error) {
        if (error?.name === 'AbortError' && !signal?.aborted) return {ret: 0, msgs: []};
        throw error;
      }
    },
    // 发一条文字。context_token 是这个人最近一条消息给的，要原样带上。返回 {ok, ret, errcode, errmsg}；网络和 HTTP 错误会抛出。
    async sendText(account, {to, text, contextToken, clientId}) {
      const res = await request(endpoint(account.baseUrl, 'ilink/bot/sendmessage'), {token: account.botToken, body: {
        msg: {
          from_user_id: '', to_user_id: to, client_id: clientId, message_type: 2 /* BOT */, message_state: 2 /* FINISH */,
          item_list: [{type: 1, text_item: {text}}], context_token: contextToken ?? undefined,
        },
        base_info: baseInfo(),
      }});
      const ret = res.ret ?? 0, errcode = res.errcode ?? 0;
      return {ok: ret === 0 && errcode === 0, ret, errcode, errmsg: res.errmsg ?? ''};
    },
    // 上线、下线通知（失败不影响收发）。
    async notify(account, kind) {
      try { await request(endpoint(account.baseUrl, `ilink/bot/msg/notify${kind}`), {body: {base_info: baseInfo()}, token: account.botToken, timeoutMs: 10_000}); return true; }
      catch { return false; }
    },
    // 下载并解密一张图片，返回明文字节。
    async downloadImage(image) {
      const key = imageKey(image), media = image?.media ?? {};
      const link = media.full_url || (media.encrypt_query_param ? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : null);
      if (!link) throw Error('消息里没有图片地址');
      const res = await fetchFn(link, {signal: AbortSignal.timeout(60_000)});
      if (!res.ok) throw Error(`CDN 回了 HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > DOWNLOAD_LIMIT) throw Error('图片超过 30 MB');
      return new Uint8Array(key ? decryptAesEcb(data, key) : data);
    },
  };
}
