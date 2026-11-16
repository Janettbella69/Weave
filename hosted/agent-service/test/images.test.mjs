// 照片的格式检查（images.mjs）。照片怎么进一直在线的那段会话，见 server.test.mjs。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkImage, IMAGE_MAX_BYTES, sniffImage} from '../images.mjs';
import {png} from './helpers/png.mjs';

const PHOTO = png(24, 24, 11);

test('checkImage takes JPEG, PNG, GIF and WebP up to 2 MiB whose bytes match the declared type, and nothing else', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), gif = Buffer.from('GIF89a......'), webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  for (const [bytes, type] of [[jpeg, 'image/jpeg'], [PHOTO, 'image/png'], [gif, 'image/gif'], [webp, 'image/webp']]) {
    assert.equal(sniffImage(bytes), type);
    assert.deepEqual(checkImage({mediaType: type, data: bytes.toString('base64')}), {mediaType: type, data: bytes.toString('base64')});
  }
  const big = Buffer.alloc(IMAGE_MAX_BYTES + 1, 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  const exact = big.subarray(0, IMAGE_MAX_BYTES);
  assert.equal(checkImage({mediaType: 'image/jpeg', data: exact.toString('base64')}).mediaType, 'image/jpeg');
  for (const bad of [
    null, [], 'x', {mediaType: 'image/jpeg'}, {mediaType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64')},
    {mediaType: 'image/png', data: jpeg.toString('base64')}, {mediaType: 'image/jpeg', data: big.toString('base64')},
    {mediaType: 'image/jpeg', data: '!!!!'}, {mediaType: 'image/jpeg', data: jpeg.toString('base64').slice(1)},
    {mediaType: 'image/heic', data: jpeg.toString('base64')}, {mediaType: 'image/jpeg', data: ''},
  ]) assert.throws(() => checkImage(bad), JSON.stringify(bad)?.slice(0, 80));
});

test('the fixtures are real images: the PNG helper writes a valid signature, header and end chunk', () => {
  assert.equal(sniffImage(PHOTO), 'image/png');
  assert.equal(PHOTO.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(PHOTO.subarray(PHOTO.length - 8, PHOTO.length - 4).toString('ascii'), 'IEND');
});
