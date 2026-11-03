// 微信看图的照片暂存（docs/superpowers/specs/2026-11-03-wechat-images-design.md，WEAVE_WECHAT_IMAGES=1 时才会用到）。
// 照片不进 world：world 每个事件都整份读写，群记录还要留 14 天。一张照片只放到它那一轮开始：加密后存进 D1 的
// weave_wechat_photos 表，最多 10 分钟；那一轮开始时读出来就删掉（takePhoto），没人用的到期由 sweepPhotos 删掉。
// 一行最多放 900,000 个字符，大照片分几行存：D1 一个值最大 2,000,000 字节。
// 表在第一次存照片时才建，所以开关一直关着时，这个文件不会碰数据库（sweepPhotos 遇到没有这张表就什么都不做）。
import {sealBytes, unsealBytes} from './crypto.mjs';

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_TTL_MS = 10 * 60_000;
export const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TABLE = 'weave_wechat_photos', CHUNK = 900_000;
const aad = id => 'wechat-photo:' + id;

// 看字节开头认格式。和 hosted/agent-service/images.mjs、hosted/wechat-bridge/bridge.mjs 里的是同一段（test/wechat-images-sync.test.mjs）。
export function sniffImage(bytes) {
  const at = (offset, text) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  if (bytes.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return null;
}
// 为什么不收这张照片（只是一个短代码，可以写进日志）；收就是 null。
export function photoProblem(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return 'empty';
  if (bytes.length > PHOTO_MAX_BYTES) return 'too_large';
  if (!PHOTO_TYPES.includes(mediaType)) return 'unsupported';
  const sniffed = sniffImage(bytes);
  if (!sniffed) return 'unsupported';
  return sniffed === mediaType ? null : 'type_mismatch';
}

export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

const ensureTable = db => db.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT NOT NULL, seq INTEGER NOT NULL, media_type TEXT NOT NULL, iv TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (id, seq))`).run();

// 存一张已经查过的照片，返回它的 id。只有 id 会写进 world 里那一条消息。
export async function putPhoto(db, {bytes, mediaType}, {secret, now}) {
  await ensureTable(db);
  await sweepPhotos(db, now);
  const id = crypto.randomUUID(), sealed = await sealBytes(bytes, secret, aad(id)), text = toBase64(sealed.data), rows = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    rows.push(db.prepare(`INSERT INTO ${TABLE} (id, seq, media_type, iv, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, rows.length, mediaType, sealed.iv, text.slice(i, i + CHUNK), now + PHOTO_TTL_MS));
  }
  await db.batch(rows);
  return id;
}

// 一轮开始时取照片：读出来就删，不管这一轮后面怎样。过期、缺行、解不开或格式不对都是 null（这一轮照常回答，只是没有照片）。
// 返回 {mediaType, data（base64）, bytes（字节数，给日志用）}。
export async function takePhoto(db, id, {secret, now}) {
  let rows;
  try { rows = (await db.prepare(`SELECT seq, media_type, iv, data, expires_at FROM ${TABLE} WHERE id = ? ORDER BY seq`).bind(id).all()).results || []; }
  catch { return null; }
  await dropPhoto(db, id);
  if (!rows.length || rows.some((row, i) => row.seq !== i || row.expires_at <= now || row.iv !== rows[0].iv || row.media_type !== rows[0].media_type)) return null;
  let bytes;
  try { bytes = await unsealBytes({iv: rows[0].iv, data: fromBase64(rows.map(row => row.data).join(''))}, secret, aad(id)); }
  catch { return null; }
  if (photoProblem(bytes, rows[0].media_type)) return null;
  return {mediaType: rows[0].media_type, data: toBase64(bytes), bytes: bytes.length};
}

export async function dropPhoto(db, id) {
  try { await db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).bind(id).run(); } catch { /* no table: nothing stored */ }
}
// 到期的照片（没被任何一轮用掉的）。每次定时任务和每次存照片前跑一次。
export async function sweepPhotos(db, now) {
  try { await db.prepare(`DELETE FROM ${TABLE} WHERE expires_at <= ?`).bind(now).run(); } catch { /* no table: nothing stored */ }
}
