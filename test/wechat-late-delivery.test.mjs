// 微信晚到的消息（2026-11-04 第一性原理复查第 3 条）：
//   1. 主动消息和提醒在发送队列里等太久（Mac 睡着、桥接断了），就不发了：晚了的「今天走了吗」「提醒你：吃药」比不发更打扰。
//      按「本该送到的时间」算：主动消息是它说出口的时间，提醒是这一次本该响的时间（不是排进队列的时间）。
//      普通回复、绑定确认、群消息不在这条规则里。
//   2. 「连着两句主动消息没回」只算真正送到的：微信回执说送到了才算，没送到、过期、失败、待人工确认的都不算。
//      只走网页的主动消息一出现在聊天里就算送到（网页聊天就是它的通道）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../hosted/lib/weave/store.mjs';
import {setup, ok, SERVICE, SERVICE_TOKEN, secret as SECRET} from './helpers/wechat-sdk.mjs';
import {quietReason, runProactive} from '../hosted/lib/weave/proactive.mjs';
import {JEV_URL, JEV_MODEL, jevConfig} from '../hosted/lib/weave/jev.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';

// 2030-01-01 是星期二；测试账号在上海（UTC+8）。
const at = (day, hhmm) => Date.parse(`2030-01-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`);
const quiet = () => ok({outcome: 'success', reply: '', sessionId: 's-bg', tools: []});

async function harness() {
  const s = await setup({agent: async () => quiet()});
  const serverTick = () => s.call(null, 'internal/tick', {}, {Authorization: 'Bearer ' + SERVICE_TOKEN});
  const edit = async fn => { const store = new Store(s.db), world = await store.load(); await fn(world.people[s.id], world); await store.save(world); };
  const active = (when = s.now - 3600_000) => edit(p => { p.messages.push({id: 'u-' + when, role: 'user', text: '在', createdAt: new Date(when).toISOString()}); });
  const person = async () => (await s.read()).people[s.id];
  const claimTexts = async () => (await s.bridge('claim', {})).data.jobs.map(j => j.text);
  // 后台那一轮（没人直接找它）在微信通道上调 send_message，和真的后台叫醒走同一个工具后端。
  const proactiveSay = async (text, toolUseId) => {
    const capability = await issueCapability(SECRET, {owner: s.id, scope: 'owner', runId: 'r-' + toolUseId, channel: 'wechat', direct: false}, s.now);
    const r = await s.tool('send_message', {text}, capability, toolUseId);
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
  };
  // 绑好微信，并让桥接把绑定确认领走、报成已发送，免得混进后面的断言。
  const bindAndDrain = async () => { await s.bind(); await s.deliverAll(); };
  return Object.setPrototypeOf({serverTick, edit, active, person, claimTexts, proactiveSay, bindAndDrain}, s);
}

test('后台那一轮说的话，记进聊天的时间用这一轮的时钟（「没回」和「过期」都按它算）', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00')); await s.proactiveSay('今天走了吗？', 't1');
  const said = (await s.person()).messages.find(m => m.proactive === true);
  assert.equal(said.createdAt, '2030-01-01T02:00:00.000Z');
});

test('主动消息说出口 2 小时后才被桥接领到（Mac 睡着），就不发了，标成过期；网页聊天里那句还在', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00')); await s.proactiveSay('今天走了吗？', 't1');
  s.setNow(at(1, '12:01'));
  assert.deepEqual(await s.claimTexts(), []);
  const world = await s.read();
  const entry = Object.values(world.wechat).find(x => x.direction === 'outbound' && x.source === 'agent');
  assert.equal(entry.status, 'expired');
  assert.equal(entry.text, undefined, '过期的不留正文，聊天记录里有一份就够了');
  const said = world.people[s.id].messages.find(m => m.proactive === true && m.text === '今天走了吗？');
  assert.equal(said.wechat, 'expired', '聊天里那一条记着没送到微信');
  assert.deepEqual(await s.claimTexts(), [], '过期的以后也不再领');
});

test('她解绑了微信，排着的主动消息发不出去：聊天里那一条记成 failed，不会一直停在 queued', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00')); await s.proactiveSay('今天走了吗？', 't1');
  assert.equal((await s.call('alice', 'wechat/unbind', {})).status, 200);
  assert.deepEqual(await s.claimTexts(), []);
  assert.equal((await s.person()).messages.find(m => m.proactive === true).wechat, 'failed');
});

test('桥接领走了却没回执（比如领完 Mac 就睡了），过了 2 小时：不再发，记成 uncertain（可能已经送到了），不是 expired', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00')); await s.proactiveSay('今天走了吗？', 't1');
  assert.deepEqual(await s.claimTexts(), ['今天走了吗？']);
  s.setNow(at(1, '12:30'));
  assert.deepEqual(await s.claimTexts(), []);
  assert.equal((await s.person()).messages.find(m => m.proactive === true).wechat, 'uncertain');
});

test('回执晚到：过了 2 小时才收到「已送到」，照样记成 sent，算进「没回」', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00'));
  await s.proactiveSay('今天走了吗？', 't1');
  await s.proactiveSay('晚饭后走一圈？', 't2');
  const jobs = (await s.bridge('claim', {})).data.jobs;
  s.setNow(at(1, '12:30'));
  for (const job of jobs) await s.bridge('receipt', {id: job.id, state: 'accepted'});
  assert.deepEqual((await s.person()).messages.filter(m => m.proactive).map(m => m.wechat), ['sent', 'sent']);
  assert.equal(quietReason(await s.person(), at(1, '12:31')), 'ignored');
});

test('绑定确认不过期：3 小时后才被领到也照发', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.bind();
  s.setNow(at(1, '12:00'));
  assert.deepEqual(await s.claimTexts(), ['微信已连接到你的 Weave 空间。之后可以直接在这里记录反馈、询问个人 Agent。']);
});

test('群里的回复不过期：3 小时后才被领到也照发', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.enableGroup();
  // 开启群时领走的两条（绑定确认、开启说明）租约过了，一起报成已发送。
  s.setNow(at(1, '09:06')); await s.deliverAll();
  s.agent(async () => ok({outcome: 'success', reply: '我看到成员1 走了', sessionId: 's-g', tools: []}));
  await s.bridge('events', s.group('wxid-alice', '@助理 今天谁走了', true));
  await s.tick();
  s.setNow(at(1, '12:30'));
  assert.deepEqual(await s.claimTexts(), ['我看到成员1 走了']);
});

test('主动消息 2 小时以内被领到，照常发', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00')); await s.proactiveSay('今天走了吗？', 't1');
  s.setNow(at(1, '11:59'));
  assert.deepEqual(await s.claimTexts(), ['今天走了吗？']);
});

test('一次性提醒按本该提醒的时间算：服务器 8 点到 11 点停着，11 点才写进聊天、排进队列，也不发微信了', async () => {
  const s = await harness();
  s.setNow(at(1, '07:00')); await s.active();
  const chat = await issueCapability(SECRET, {owner: s.id, scope: 'owner', runId: 'r-chat', channel: 'web', direct: true}, s.now);
  assert.equal((await s.tool('set_reminder', {text: '吃药', due_at: '2030-01-01T08:00+08:00'}, chat, 't1')).data.ok, true);
  await s.bindAndDrain();
  s.setNow(at(1, '11:00')); await s.serverTick();
  assert.ok((await s.person()).messages.some(m => m.text === '提醒你：吃药'), '网页聊天里照记');
  assert.deepEqual(await s.claimTexts(), []);
});

test('重复提醒按这一次本该响的时间算：晚 1.5 小时排进队列、马上领走的照发；第二天 8 点排进队列、10:01 才领的不发', async () => {
  const s = await harness();
  s.setNow(at(1, '07:00')); await s.active();
  const chat = await issueCapability(SECRET, {owner: s.id, scope: 'owner', runId: 'r-chat', channel: 'web', direct: true}, s.now);
  assert.equal((await s.tool('set_reminder', {text: '吃药', due_at: '2030-01-01T08:00+08:00', repeat: 'daily'}, chat, 't1')).data.ok, true);
  await s.bindAndDrain();
  s.setNow(at(1, '09:30')); await s.serverTick();
  s.setNow(at(1, '09:31'));
  assert.deepEqual((await s.deliverAll()).map(j => j.text), ['提醒你：吃药']);
  s.setNow(at(2, '08:00')); await s.serverTick();
  s.setNow(at(2, '10:01'));
  assert.deepEqual(await s.claimTexts(), []);
});

test('普通回复不过期：她发的消息 3 小时后回复才被领到，照发', async () => {
  const s = await harness();
  s.agent(async () => ok({outcome: 'success', reply: '收到，帮你记上了', sessionId: 's-1', tools: []}));
  s.setNow(at(1, '09:00')); await s.bindAndDrain();
  await s.bridge('events', s.message('今天走了 20 分钟'));
  await s.tick();
  s.setNow(at(1, '12:00'));
  assert.deepEqual(await s.claimTexts(), ['收到，帮你记上了']);
});

// 两句主动消息之后，桥接的回执是什么（null = 一直没领走，比如 Mac 睡着）：送到了才算她没回。
for (const [receipt, expected] of [
  ['accepted', 'ignored'],
  ['succeeded', 'ignored'],
  ['failed', null],
  ['cancelled', null],
  ['needs_review', null],
  [null, null],
]) {
  test(`「连着两句没回」只算送到的：两句主动消息的回执是 ${receipt ?? '（一直没领走）'} → ${expected ?? '照常定期看看'}`, async () => {
    const s = await harness();
    s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
    s.setNow(at(1, '10:00'));
    await s.proactiveSay('今天走了吗？', 't1');
    await s.proactiveSay('晚饭后走一圈？', 't2');
    if (receipt) for (const job of (await s.bridge('claim', {})).data.jobs) await s.bridge('receipt', {id: job.id, state: receipt});
    assert.equal(quietReason(await s.person(), at(1, '11:00')), expected);
  });
}

test('「连着两句没回」：过期没发出去的不算；没接微信、只走网页的照旧一出现就算', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00'));
  await s.proactiveSay('今天走了吗？', 't1');
  await s.proactiveSay('晚饭后走一圈？', 't2');
  s.setNow(at(1, '12:30'));
  assert.deepEqual(await s.claimTexts(), []);
  assert.equal(quietReason(await s.person(), at(1, '12:30')), null);
  // 只走网页（没接微信）的账号：同样两句，一出现在聊天里就算送到。
  const web = await harness();
  web.setNow(at(1, '09:00')); await web.active();
  web.setNow(at(1, '10:00'));
  for (const [text, id] of [['今天走了吗？', 'w1'], ['晚饭后走一圈？', 'w2']]) {
    const capability = await issueCapability(SECRET, {owner: web.id, scope: 'owner', runId: 'r-' + id, channel: 'web', direct: false}, web.now);
    assert.equal((await web.tool('send_message', {text}, capability, id)).data.ok, true);
  }
  assert.equal(quietReason(await web.person(), at(1, '11:00')), 'ignored');
});

test('Jev 看到的「还没回的主动消息」也只算送到的：两句都还在队列里时是 0', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active(); await s.bindAndDrain();
  s.setNow(at(1, '10:00'));
  await s.proactiveSay('今天走了吗？', 't1');
  await s.proactiveSay('晚饭后走一圈？', 't2');
  const jevCalls = [];
  const fetcher = async (url, options) => {
    if (url === JEV_URL) { jevCalls.push(JSON.parse(options.body)); return Response.json({model: JEV_MODEL, answers: {reach_out: {type: 'noul', noul: 0.1}}, usage: {input_tokens: 1, output_tokens: 1}}); }
    if (String(url).startsWith(SERVICE)) return quiet();
    throw Error('unexpected fetch ' + url);
  };
  s.setNow(at(1, '19:30'));
  await runProactive({db: s.db, secret: SECRET, service: {url: SERVICE, token: SERVICE_TOKEN}, fetcher, now: s.now, jev: jevConfig({TYPESAFE_API_KEY: 'ts_' + 'k'.repeat(30)})});
  assert.equal(jevCalls.length, 1);
  assert.equal(jevCalls[0].state.unanswered_proactive_messages, 0);
});
