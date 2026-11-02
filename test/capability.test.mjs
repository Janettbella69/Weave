import {test} from 'node:test';
import assert from 'node:assert/strict';
import {issueCapability, verifyCapability} from '../hosted/lib/weave/capability.mjs';

const secret = 'ab'.repeat(32), now = Date.parse('2026-11-02T08:00:00Z');
const claims = {owner: 'u:alice', scope: 'owner', runId: 'run-1', channel: 'web', direct: true};
const rejects401 = promise => assert.rejects(promise, error => error.status === 401);

test('签发后能验证，拿回同样的 owner、scope、runId、channel、direct，15 分钟后过期', async () => {
  const token = await issueCapability(secret, claims, now);
  assert.match(token, /^wcap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await verifyCapability(secret, token, now + 60_000), {...claims, exp: now + 15 * 60_000});
  const group = await issueCapability(secret, {...claims, scope: 'group', channel: 'wechat', direct: false, group: 'g1'}, now);
  const back = await verifyCapability(secret, group, now);
  assert.equal(back.scope, 'group');
  assert.equal(back.direct, false);
  assert.equal(back.group, 'g1');
});

test('a group capability names its group, and an owner capability never does', async () => {
  const group = {...claims, scope: 'group', channel: 'wechat', direct: true};
  await assert.rejects(issueCapability(secret, group, now), /通行证内容无效/);
  await assert.rejects(issueCapability(secret, {...group, group: ''}, now), /通行证内容无效/);
  await assert.rejects(issueCapability(secret, {...group, group: 'g'.repeat(201)}, now), /通行证内容无效/);
  await assert.rejects(issueCapability(secret, {...group, group: 42}, now), /通行证内容无效/);
  await assert.rejects(issueCapability(secret, {...claims, group: 'g1'}, now), /通行证内容无效/);
  const token = await issueCapability(secret, {...group, group: 'g1'}, now);
  assert.equal((await verifyCapability(secret, token, now)).group, 'g1');
  assert.equal('group' in await verifyCapability(secret, await issueCapability(secret, claims, now), now), false);
});

test('a forged group claim added to an owner capability is rejected even with a valid signature shape', async () => {
  const token = await issueCapability(secret, claims, now);
  const [prefix, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({...claims, group: 'g1', exp: now + 900_000})).toString('base64url');
  await rejects401(verifyCapability(secret, `${prefix}.${forged}.${signature}`, now));
});

test('改一个字符、换密钥、过期，都是 401', async () => {
  const token = await issueCapability(secret, claims, now);
  const [prefix, payload, signature] = token.split('.');
  const flip = s => s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  await rejects401(verifyCapability(secret, `${prefix}.${flip(payload)}.${signature}`, now));
  await rejects401(verifyCapability(secret, `${prefix}.${payload}.${flip(signature)}`, now));
  await rejects401(verifyCapability('cd'.repeat(32), token, now));
  await rejects401(verifyCapability(secret, token, now + 15 * 60_000));
  await rejects401(verifyCapability(secret, token, now + 16 * 60_000));
});

test('换一份别的内容也骗不过：把 owner 改成别人重新编码，签名对不上', async () => {
  const token = await issueCapability(secret, claims, now);
  const [prefix, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({...claims, owner: 'u:bob', exp: now + 900_000})).toString('base64url');
  await rejects401(verifyCapability(secret, `${prefix}.${forged}.${signature}`, now));
});

test('乱写的通行证都是 401，不会抛出别的错误', async () => {
  for (const token of [undefined, '', 'wcap1..', 'a.b.c', 'wcap2.e30.e30', 'wcap1.%%%.***', 'x'.repeat(5000)]) {
    await rejects401(verifyCapability(secret, token, now));
  }
});
