// A real, decodable PNG for tests: width x height of pseudo-random pixels, so the bytes (and their base64) are unique
// enough to search the disk for afterwards. No image library needed.
import {crc32, deflateSync} from 'node:zlib';

export function png(width = 24, height = 24, seed = 7) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const row = width * 3 + 1, raw = Buffer.alloc(row * height);
  let x = seed;
  for (let i = 0; i < raw.length; i++) {
    if (i % row === 0) continue; // filter byte: none
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = x >> 16 & 0xff;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
