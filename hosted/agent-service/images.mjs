// 微信看图（docs/superpowers/specs/2026-11-03-wechat-images-design.md）：一轮最多带一张照片。
// Weave 服务收照片时查过一遍，这里叫醒前再查一遍：只收 JPEG、PNG、GIF、WebP，原始大小不超过 2 MiB，
// 字节开头要和声明的格式对得上。这个文件不 import SDK，根目录的测试也能直接读它。
// sniffImage 和 hosted/lib/weave/wechat-photos.mjs、hosted/wechat-bridge/bridge.mjs 里的是同一段，
// test/wechat-images-sync.test.mjs 保证三处结果一致。
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// IMAGE_MAX_BYTES 写成 base64（带补位）最长多少字。
export const IMAGE_MAX_BASE64 = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;

// 看字节开头认格式，不信文件名或声明的类型。认不出就是 null。
export function sniffImage(bytes) {
  const at = (offset, text) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  if (bytes.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return null;
}

// /wake 里的 image：{mediaType, data}，data 是 base64。合格就原样返回，不合格就抛错。
export function checkImage(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) throw Error('照片无效');
  const {mediaType, data} = image;
  if (!IMAGE_TYPES.includes(mediaType) || typeof data !== 'string' || !data || data.length > IMAGE_MAX_BASE64 || data.length % 4 !== 0) throw Error('照片无效');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Error('照片无效');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > IMAGE_MAX_BYTES || sniffImage(bytes) !== mediaType) throw Error('照片无效');
  return {mediaType, data};
}
