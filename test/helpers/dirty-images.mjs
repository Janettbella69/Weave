// Plants the metadata a phone photo carries into a clean image: EXIF with a GPS position, XMP, IPTC, comments, text chunks, and
// data after the end of the image (some phones append a video there). Each result is still a valid file of the same type.
import {crc32} from 'node:zlib';

const ascii = text => Buffer.from(text, 'latin1');
const u16be = n => Buffer.from([n >> 8 & 0xff, n & 0xff]);
const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const GPS_NORTH = [39, 54, 27], GPS_EAST = [116, 23, 51];

// A little-endian TIFF block (what EXIF is) whose IFD0 points to a GPS IFD holding latitude and longitude.
export function exifWithGps() {
  const entries = (list, start) => {
    const table = Buffer.alloc(2 + list.length * 12 + 4), extra = [];
    table.writeUInt16LE(list.length, 0);
    let at = start + table.length;
    list.forEach(([tag, type, count, value], i) => {
      const o = 2 + i * 12;
      table.writeUInt16LE(tag, o); table.writeUInt16LE(type, o + 2); table.writeUInt32LE(count, o + 4);
      if (Buffer.isBuffer(value)) { table.writeUInt32LE(at, o + 8); extra.push(value); at += value.length; }
      else if (type === 2) Buffer.from(value + '\0', 'latin1').copy(table, o + 8);
      else table.writeUInt32LE(value, o + 8);
    });
    return Buffer.concat([table, ...extra]);
  };
  const rationals = parts => Buffer.concat(parts.map(n => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(1, 4); return b; }));
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const ifd0 = entries([[0x8825, 4, 1, 8 + 18]], 8); // GPSInfo -> right after IFD0 (2 + 12 + 4 bytes)
  const gps = entries([[1, 2, 2, 'N'], [2, 5, 3, rationals(GPS_NORTH)], [3, 2, 2, 'E'], [4, 5, 3, rationals(GPS_EAST)]], 8 + ifd0.length);
  return Buffer.concat([header, ifd0, gps]);
}
const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="39,54.45N" exif:GPSLongitude="116,23.85E"/></rdf:RDF></x:xmpmeta>';

export function dirtyJpeg(clean) {
  const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), u16be(body.length + 2), body]);
  const exif = segment(0xe1, Buffer.concat([ascii('Exif\0\0'), exifWithGps()]));
  const xmp = segment(0xe1, Buffer.concat([ascii('http://ns.adobe.com/xap/1.0/\0'), ascii(XMP)]));
  const iptc = segment(0xed, Buffer.concat([ascii('Photoshop 3.0\0'), ascii('8BIM\x04\x04\0\0\0\0\0\x18'), ascii('\x1c\x02\x78\0\x14GPS caption Beijing!')]));
  const comment = segment(0xfe, ascii('GPS 39.9N 116.4E taken on my phone'));
  const thumbnailApp = segment(0xe0, Buffer.concat([ascii('JFXX\0'), Buffer.from([0x10]), ascii('tiny thumbnail')]));
  const b = Buffer.from(clean);
  return new Uint8Array(Buffer.concat([b.subarray(0, 2), exif, xmp, b.subarray(2, 4 + b.readUInt16BE(4)), thumbnailApp, iptc, comment, b.subarray(4 + b.readUInt16BE(4)), ascii('MOTION-PHOTO-VIDEO GPS trailer')]));
}

export function dirtyPng(clean) {
  const chunk = (type, data) => { const body = Buffer.concat([ascii(type), data]); return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]); };
  const b = Buffer.from(clean), afterHeader = 8 + 12 + b.readUInt32BE(8);
  const planted = [
    chunk('eXIf', exifWithGps()), chunk('tEXt', ascii('Comment\0GPS 39.9N 116.4E')), chunk('iTXt', Buffer.concat([ascii('XML:com.adobe.xmp\0\0\0\0\0'), ascii(XMP)])),
    chunk('zTXt', ascii('Location\0\0x')), chunk('tIME', Buffer.from([0x07, 0xea, 11, 3, 12, 0, 0])), chunk('prVt', ascii('GPS private chunk')),
  ];
  return new Uint8Array(Buffer.concat([b.subarray(0, afterHeader), ...planted, b.subarray(afterHeader), ascii('GPS trailer after IEND')]));
}

// A simple (VP8 or VP8L) WebP turned into the extended form with EXIF and XMP chunks, flags set as a camera would.
export function webpChunk(type, data) { return Buffer.concat([ascii(type), u32le(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); }
export function webpFile(chunks) { const body = Buffer.concat(chunks); return new Uint8Array(Buffer.concat([ascii('RIFF'), u32le(body.length + 4), ascii('WEBP'), body])); }
export function vp8x(flags, width = 1, height = 1) { const d = Buffer.alloc(10); d[0] = flags; d.writeUIntLE(width - 1, 4, 3); d.writeUIntLE(height - 1, 7, 3); return webpChunk('VP8X', d); }
export function dirtyWebp(clean) {
  const image = Buffer.from(clean).subarray(12); // the one image chunk of a simple WebP
  return webpFile([vp8x(0x08 | 0x04), image, webpChunk('EXIF', exifWithGps()), webpChunk('XMP ', ascii(XMP))]);
}

export function dirtyGif(clean) {
  const b = Buffer.from(clean), palette = b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0, head = 13 + palette;
  const blocks = text => { const out = []; for (let i = 0; i < text.length; i += 255) { const part = text.subarray(i, i + 255); out.push(Buffer.from([part.length]), part); } out.push(Buffer.from([0])); return Buffer.concat(out); };
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe]), blocks(ascii('GPS 39.9N 116.4E'))]);
  const looping = Buffer.from([0x21, 0xff, 0x0b, ...ascii('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const xmp = Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), ascii('XMP DataXMP'), blocks(ascii(XMP))]);
  return new Uint8Array(Buffer.concat([b.subarray(0, head), comment, looping, xmp, b.subarray(head), ascii('GPS trailer')]));
}
