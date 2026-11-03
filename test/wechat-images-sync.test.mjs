// The three places that look at a WeChat photo's bytes (the bridge on the Mac, the Weave server, the Agent service) run
// separately, so each has its own copy of the format check and the limits. They must agree.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../hosted/wechat-bridge/bridge.mjs';
import * as server from '../hosted/lib/weave/wechat-photos.mjs';
import * as agent from '../hosted/agent-service/images.mjs';

test('the same sniffImage in all three places, with the same answers', () => {
  assert.equal(bridge.sniffImage.toString(), server.sniffImage.toString());
  assert.equal(server.sniffImage.toString(), agent.sniffImage.toString());
  const samples = [
    [0xff, 0xd8, 0xff, 0xe0], [0xff, 0xd8], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a],
    [...Buffer.from('GIF87a')], [...Buffer.from('GIF89a')], [...Buffer.from('GIF88a')], [...Buffer.from('RIFF\0\0\0\0WEBP')], [...Buffer.from('RIFF\0\0\0\0WAVE')],
    [...Buffer.from('<svg/>')], [...Buffer.from('\0\0\0 ftypheic')], [],
  ].map(bytes => new Uint8Array(bytes));
  for (const bytes of samples) {
    const answers = [bridge.sniffImage(bytes), server.sniffImage(bytes), agent.sniffImage(bytes)];
    assert.equal(new Set(answers).size, 1, `${Buffer.from(bytes).toString('hex')}: ${answers.join(' / ')}`);
  }
});

test('the same size limit and the same four formats everywhere', () => {
  assert.equal(bridge.PHOTO_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(server.PHOTO_MAX_BYTES, bridge.PHOTO_MAX_BYTES);
  assert.equal(agent.IMAGE_MAX_BYTES, bridge.PHOTO_MAX_BYTES);
  assert.deepEqual([...server.PHOTO_TYPES], [...agent.IMAGE_TYPES]);
  assert.deepEqual([...agent.IMAGE_TYPES], ['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  // The Agent service's /wake limit leaves room for exactly one such photo as base64.
  assert.equal(agent.IMAGE_MAX_BASE64, Buffer.alloc(agent.IMAGE_MAX_BYTES).toString('base64').length);
  // A photo is kept at most 10 minutes (ruling R-I4).
  assert.ok(server.PHOTO_TTL_MS <= 10 * 60_000);
});
