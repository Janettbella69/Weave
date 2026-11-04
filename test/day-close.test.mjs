// 换日收尾（2026-11-04 第一性原理复查第 2 条）：会话按当地日期换，第二天开新的。以前中间没有任何一步，
// 她晚上说的「明天早上 7 点去走路」第二天就没了（MEMORY.md 只写长期的事）。
// 教材 p.47「Handoff ≠ 记忆」，对话结尾要「写一个 handoff 文档方便新开的对话接着做任务，同时把…值得写到记忆的东西写到记忆里」；
// p.53「如果让 AI 自己去调用…他有可能忘记调用……做成 Hook，他就是百分之百」——所以什么时候收尾由代码定，写什么由 Agent 定。
// 这里测网站这边：服务器闹钟在换日后叫醒一轮收尾、只收一次、收尾那一轮能做什么。Agent 服务那边在 hosted/agent-service/test/day-close.test.mjs。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, ok, reply, SERVICE, SERVICE_TOKEN, secret as SECRET} from './helpers/wechat-sdk.mjs';
import {runDayClose} from '../hosted/lib/weave/day-close.mjs';

// 2030-01-01 是星期二；测试账号在上海（UTC+8）。
const at = (day, hhmm) => Date.parse(`2030-01-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`);
const quiet = () => ok({outcome: 'success', reply: '', sessionId: 's-bg', tools: []});
const isClose = call => call.path === '/wake' && call.body.trigger?.kind === 'close';

async function harness(onClose = async () => quiet()) {
  const s = await setup({agent: async call => isClose(call) ? onClose(call) : reply('好')});
  const serverTick = () => s.call(null, 'internal/tick', {}, {Authorization: 'Bearer ' + SERVICE_TOKEN});
  const chat = text => s.call('alice', 'chat', {text});
  const closes = () => s.calls.filter(isClose);
  const person = async () => (await s.read()).people[s.id];
  return Object.setPrototypeOf({serverTick, chat, closes, person}, s);
}

test('换日后服务器闹钟的第一拍叫醒一轮收尾：后台、kind close、不是直接找它、接前一天的会话；凌晨的安静时段照样跑', async () => {
  const s = await harness();
  s.setNow(at(1, '20:00'));
  assert.equal((await s.chat('明天早上 7 点去走路，到时候问问我')).status, 200);
  s.setNow(at(1, '23:59')); await s.serverTick();
  assert.equal(s.closes().length, 0, '还没换日');
  s.setNow(at(2, '00:01')); await s.serverTick();
  assert.equal(s.closes().length, 1);
  const {body} = s.closes()[0];
  assert.deepEqual(
    [body.scope, body.trigger.kind, body.trigger.channel, body.trigger.direct, body.background, body.localDate],
    ['owner', 'close', 'system', false, true, '2030-01-01'],
  );
  assert.match(body.trigger.text, /HANDOFF\.md/);
  assert.match(body.trigger.text, /MEMORY\.md/);
});

test('收尾不算主动找她：不占当天的后台次数，「动态」里没有它；档位关了也照样收尾', async () => {
  const s = await harness();
  s.setNow(at(1, '20:00')); await s.chat('明天开始每天走 20 分钟');
  assert.equal((await s.call('alice', 'proactive/level', {level: 'off'})).status, 200);
  s.setNow(at(2, '00:01')); await s.serverTick();
  assert.equal(s.closes().length, 1);
  assert.equal((await s.person()).proactive.wakes, 0);
  assert.deepEqual((await s.call('alice', 'status')).data.activity, []);
});

test('每天只收一次尾；只收她直接说过话的那天：后台看看过、她没说话的那天不收；收尾那一轮本身也不算', async () => {
  const s = await harness();
  s.setNow(at(2, '00:01')); await s.serverTick();
  assert.equal(s.closes().length, 0, '从没聊过');
  s.setNow(at(2, '08:00')); await s.chat('早');
  s.setNow(at(3, '00:01')); await s.serverTick();
  s.setNow(at(3, '00:02')); await s.serverTick();
  assert.equal(s.closes().length, 1);
  assert.equal(s.closes()[0].body.localDate, '2030-01-02');
  // 第 3 天她没来，只有 10:00 的定期看看（后台）：第 4 天凌晨不收尾，第 2 天的 HANDOFF.md 留着。
  s.setNow(at(3, '10:00')); await s.serverTick();
  assert.equal(s.calls.filter(c => c.path === '/wake' && c.body.trigger?.kind === 'check').length, 1, '定期看看照常跑了');
  s.setNow(at(4, '00:01')); await s.serverTick();
  assert.equal(s.closes().length, 1);
});

// Agent 服务明确说没开始跑的（4xx 拒收、503、429）隔 10 分钟再试，不是下一拍；其余结果都可能跑到一半，沿用「出错不自动重试」。
for (const [label, answer, retried] of [
  ['Agent 服务说没开始跑（503）', () => new Response('{}', {status: 503}), true],
  ['排队的人太多（429）', () => new Response('{}', {status: 429}), true],
  ['Agent 服务拒收（400，比如它还不认识收尾）', () => new Response('{}', {status: 400}), true],
  ['这一轮出错', () => ok({outcome: 'error', reply: '', sessionId: null, tools: []}), false],
  ['那天没有会话可收（skipped）', () => ok({outcome: 'skipped', reply: '', sessionId: null, tools: []}), false],
  ['收好了', () => quiet(), false],
]) {
  test(`收尾的结果是「${label}」：${retried ? '下一拍不试，10 分钟后再试一次' : '不再试'}`, async () => {
    const s = await harness(async () => answer());
    s.setNow(at(1, '20:00')); await s.chat('明天见');
    s.setNow(at(2, '00:01')); await s.serverTick();
    s.setNow(at(2, '00:02')); await s.serverTick();
    assert.equal(s.closes().length, 1);
    s.setNow(at(2, '00:11')); await s.serverTick();
    assert.equal(s.closes().length, retried ? 2 : 1);
  });
}

test('一个人的收尾一直被拒（Agent 服务说没开始跑），别人照样收；被拒的隔 10、20 分钟各再试一次，第 3 次还不行就记成 unavailable、不再试，日志留一行', async t => {
  let blocked = null;
  const s = await harness(async call => call.body.id === blocked ? new Response('{}', {status: 503}) : quiet());
  s.setNow(at(1, '20:00'));
  await s.chat('明天见');
  assert.equal((await s.call('bob', 'chat', {text: '明天见'})).status, 200);
  const ids = Object.keys((await s.read()).people).sort();
  blocked = ids[0];
  const errors = t.mock.method(console, 'error', () => {});
  for (let minute = 1; minute <= 59; minute++) {
    s.setNow(at(2, `00:${String(minute).padStart(2, '0')}`));
    await s.serverTick();
  }
  const tries = id => s.closes().filter(c => c.body.id === id).map(c => c.body.trigger.at.slice(11, 16));
  assert.deepEqual(tries(ids[1]), ['00:01'], '没被挡住的人第一拍就收了');
  assert.deepEqual(tries(ids[0]), ['00:01', '00:11', '00:31']);
  const world = await s.read();
  assert.deepEqual([world.people[ids[0]].closedDay, world.people[ids[0]].lastClose.outcome], ['2030-01-01', 'unavailable']);
  assert.equal(errors.mock.calls.filter(c => String(c.arguments[0]).includes('收尾')).length, 1);
});

test('收尾不急：这一拍已经过了 60 秒（前面的后台叫醒占掉了时间），就一轮也不开始，留到下一拍', async () => {
  const s = await harness();
  s.setNow(at(1, '20:00')); await s.chat('明天见');
  const real = Date.now();
  const late = await runDayClose({db: s.db, secret: SECRET, service: {url: SERVICE, token: SERVICE_TOKEN}, fetcher: s.options().fetcher, now: at(2, '00:01'), startBy: real - 1, deadline: real + 90_000});
  assert.equal(late, 0);
  assert.equal(s.closes().length, 0);
  s.setNow(at(2, '00:02')); await s.serverTick();
  assert.equal(s.closes().length, 1, '下一拍照常收');
});

test('收尾那一轮：发不了消息；能排一次性的跟进；不能替她设提醒', async () => {
  const results = {};
  const s = await harness(async call => {
    const cap = call.body.capability;
    results.send = (await s.tool('send_message', {text: '晚安'}, cap, 'c1')).data;
    results.wake = (await s.tool('schedule_wake', {note: '她说早上去走路，10 点问问走了没有', at: '2030-01-02T10:00:00+08:00'}, cap, 'c2')).data;
    results.remind = (await s.tool('set_reminder', {text: '走路', due_at: '2030-01-02T10:00:00+08:00'}, cap, 'c3')).data;
    return quiet();
  });
  s.setNow(at(1, '20:00')); await s.chat('明天早上去走路');
  s.setNow(at(2, '00:01')); await s.serverTick();
  assert.equal(results.send.ok, false);
  assert.match(results.send.text, /收尾/);
  assert.equal(results.wake.ok, true, JSON.stringify(results.wake));
  assert.equal(results.remind.ok, false);
  const p = await s.person();
  assert.ok(!p.messages.some(m => m.text === '晚安'));
  assert.equal(p.schedules.filter(x => x.kind === 'wake' && x.status === 'scheduled').length, 1);
});
