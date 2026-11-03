// The group branch of the pre-wake snapshot, end to end with the WeChat test harness:
// a real enabled group, real group messages, the owner's private data next to it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';
import {setup, secret, ROOM} from './helpers/wechat-sdk.mjs';

test('群范围的快照：group_messages 只有这个群的消息，没有本人的习惯，时区是 null', async () => {
  const h = await setup();
  const ownerCap = await issueCapability(secret, {owner: h.id, scope: 'owner', runId: 'run-o', channel: 'web', direct: true}, h.now);
  await h.tool('save_habit', {name: '私人习惯'}, ownerCap, 'toolu_private');
  await h.enableGroup();
  await h.bridge('events', h.group('wxid-bob', '今天走了八千步'));
  await h.bridge('events', h.group('wxid-carol', '我也走了'));

  const groupCap = await issueCapability(secret, {owner: h.id, scope: 'group', runId: 'run-g', channel: 'wechat', direct: true, group: await hash(ROOM)}, h.now);
  const r = await handleAPI(new Request('https://weave.example/api/internal/agent/snapshot', {headers: {Authorization: 'Bearer ' + groupCap}}), {db: h.db, secret, now: h.now});
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.deepEqual(Object.keys(data.tables), ['group_messages']);
  assert.deepEqual(data.tables.group_messages.map(m => [m.seq, m.member, m.text]), [[1, '成员1', '今天走了八千步'], [2, '成员2', '我也走了']]);
  assert.equal(data.timezone, null, '群里看不到开启者在哪个时区');
  assert.deepEqual(data.files, {});
  for (const leak of ['私人习惯', 'wxid-', ROOM]) assert.ok(!JSON.stringify(data).includes(leak), leak);
});
