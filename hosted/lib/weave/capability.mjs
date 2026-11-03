// 每次唤醒的短期通行证（docs/ARCHITECTURE.md 第 4 节规则 4）。写明这一轮是谁、什么范围、
// 哪一轮、从哪个通道来、是不是有人直接找它、什么时候过期。由 Weave 服务签发和校验，
// Agent 服务只是原样带着，它出 bug 也越不了权。HMAC 的钥匙从 WEAVE_ENCRYPTION_KEY 派生。
import {fail} from './domain.mjs';

const PREFIX = 'wcap1';
const SCOPES = ['owner', 'group'], CHANNELS = ['web', 'wechat'];
const encoder = new TextEncoder();

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw Error('服务端尚未配置密钥，请联系管理员');
  return crypto.subtle.importKey('raw', encoder.encode('weave-agent-capability-v1:' + secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}

// 群范围的通行证要写明是哪个群（群 id 的哈希，不是微信的群号），别的范围不能带。
const groupOk = c => c.scope === 'group' ? typeof c.group === 'string' && c.group.length > 0 && c.group.length <= 200 : c.group === undefined;
const wellFormed = c => c && typeof c.owner === 'string' && c.owner.length > 0 && SCOPES.includes(c.scope)
  && typeof c.runId === 'string' && c.runId.length > 0 && CHANNELS.includes(c.channel) && typeof c.direct === 'boolean' && groupOk(c);

export async function issueCapability(secret, {owner, scope, runId, channel, direct, group}, now, ttlMs = 15 * 60 * 1000) {
  const claims = {owner, scope, runId, channel, direct, ...(group === undefined ? {} : {group}), exp: now + ttlMs};
  if (!wellFormed(claims)) throw Error('通行证内容无效');
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${PREFIX}.${payload}`)));
  return `${PREFIX}.${payload}.${toBase64Url(signature)}`;
}

export async function verifyCapability(secret, token, now) {
  const invalid = () => fail('通行证无效或已过期', 401);
  if (typeof token !== 'string' || token.length > 4096) invalid();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) invalid();
  let signature, claims;
  try { signature = fromBase64Url(parts[2]); } catch { invalid(); }
  // crypto.subtle.verify 是常数时间比较。
  if (!await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(`${PREFIX}.${parts[1]}`))) invalid();
  try { claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))); } catch { invalid(); }
  if (!wellFormed(claims) || !Number.isFinite(claims.exp) || claims.exp <= now) invalid();
  return {owner: claims.owner, scope: claims.scope, runId: claims.runId, channel: claims.channel, direct: claims.direct, ...(claims.group === undefined ? {} : {group: claims.group}), exp: claims.exp};
}
