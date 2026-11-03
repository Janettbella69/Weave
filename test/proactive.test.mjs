// 主动服务（docs/superpowers/specs/2026-11-03-proactive-wake-design.md）：服务器自己的闹钟、定期看看、Weave 自己排的跟进、
// 档位、每天的上限、被忽略就少说、重复提醒、网页上的档位和排期。Agent 服务是假的（test/helpers/wechat-sdk.mjs），
// 它可以拿 /wake 里的通行证去调工具后端，就像模型调用了 send_message。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../hosted/lib/weave/store.mjs';
import {setup, ok, until, SERVICE_TOKEN} from './helpers/wechat-sdk.mjs';
import {checkTimes, quietReason, limitsFor} from '../hosted/lib/weave/proactive.mjs';
import {following, nextAfter, zonedTime, localParts} from '../hosted/lib/weave/repeat.mjs';
import {basicAuthGate} from '../hosted/lib/weave/basic-auth.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';

// 2030-01-01 是星期二。上海 = UTC+8：10:00 上海 = 02:00Z，19:30 上海 = 11:30Z，23:00 上海 = 15:00Z。
const at = (day, hhmm) => Date.parse(`2030-01-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`);
const quiet = () => ok({outcome: 'success', reply: '', sessionId: 's-bg', tools: []});

async function harness({agent = async () => quiet()} = {}) {
  const s = await setup({agent});
  const serverTick = (token = SERVICE_TOKEN) => s.call(null, 'internal/tick', {}, token === null ? {} : {Authorization: 'Bearer ' + token});
  const edit = async fn => { const store = new Store(s.db), world = await store.load(); await fn(world.people[s.id], world); await store.save(world); };
  // 她最近说过话：定期看看只给最近 7 天来过的人做。
  const active = (when = s.now - 3600_000) => edit(p => { p.messages.push({id: 'u-' + when, role: 'user', text: '在', createdAt: new Date(when).toISOString()}); });
  const person = async () => (await s.read()).people[s.id];
  const bgWakes = () => s.wakes().filter(c => c.body.background === true);
  // 继承而不是展开：展开会把 s.now 这个 getter 冻成当时的值。
  return Object.setPrototypeOf({serverTick, edit, active, person, bgWakes}, s);
}

// 假 Agent：被后台叫醒时说一句话（调 send_message），返回工具后端的答复。
const speaking = (s, text = '今天走了吗？走了的话回我一句，我帮你记上。', answers = []) => async call => {
  if (call.path === '/wake' && call.body.background) answers.push((await s.tool('send_message', {text: text + answers.length}, call.body.capability, 'toolu_' + answers.length)).data);
  return quiet();
};

test('重复的时间按当地钟点算：洛杉矶夏令时结束前后都是早上 8 点；每月 31 号到二月用月底；漏了几天只往后跳', () => {
  const la = 'America/Los_Angeles', rule = {repeat: 'daily', localTime: '08:00', anchorDay: 31};
  const oct31 = Date.parse('2026-10-31T15:00:00Z'); // 08:00 PDT
  const nov1 = following(rule, oct31, la), nov2 = following(rule, nov1, la);
  assert.equal(new Date(nov1).toISOString(), '2026-11-01T16:00:00.000Z'); // 08:00 PST
  assert.equal(new Date(nov2).toISOString(), '2026-11-02T16:00:00.000Z');
  const sh = 'Asia/Shanghai', monthly = {repeat: 'monthly', localTime: '08:00', anchorDay: 31};
  const jan31 = zonedTime({year: 2030, month: 1, day: 31, hour: 8, minute: 0}, sh);
  const feb = following(monthly, jan31, sh), mar = following(monthly, feb, sh);
  assert.deepEqual([localParts(feb, sh).month, localParts(feb, sh).day, localParts(mar, sh).day], [2, 28, 31]);
  assert.equal(localParts(following({repeat: 'weekly', localTime: '19:30'}, at(1, '19:30'), sh), sh).weekday, 2);
  assert.equal(nextAfter(rule, oct31, Date.parse('2026-11-05T00:00:00Z'), la), Date.parse('2026-11-05T16:00:00Z'));
  assert.equal(nextAfter({repeat: 'none', localTime: '08:00'}, oct31, oct31 + 1, la), null);
});

test('定期看看的时间跟着允许时段走：默认 09:00–21:00 时各档的时间点；上限数字', () => {
  const person = {profile: {timezone: 'Asia/Shanghai'}};
  assert.deepEqual(checkTimes(person, 'off'), []);
  assert.deepEqual(checkTimes(person, 'low'), ['19:30']);
  assert.deepEqual(checkTimes(person, 'normal'), ['10:00', '19:30']);
  assert.deepEqual(checkTimes(person, 'high'), ['10:00', '13:00', '16:30', '19:30']);
  person.proactivity.activeStart = '07:00'; person.proactivity.activeEnd = '22:00';
  assert.deepEqual(checkTimes(person, 'normal'), ['08:00', '20:30']);
  assert.deepEqual([limitsFor('normal').messages, limitsFor('high').wakes, limitsFor('nonsense').messages], [2, 8, 2]);
});

test('服务器的闹钟：令牌不对 401；没配 Agent 服务 503；对了 200，只做提醒和后台叫醒，不处理微信收到的消息；不走访问密码', async () => {
  const s = await harness();
  assert.equal((await s.serverTick(null)).status, 401);
  assert.equal((await s.serverTick('x'.repeat(40))).status, 401);
  await s.bind();
  await s.bridge('events', s.message('今天走了 20 分钟'));
  const r = await s.serverTick();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['delivered', 'proactive', 'processed', 'queued', 'routines']);
  assert.equal(r.data.processed, 0);
  assert.equal(s.wakes().length, 0, '服务器的闹钟不替桥接回微信消息');
  await s.tick();
  assert.equal(s.wakes().length, 1, '桥接的 tick 照旧回');
  assert.equal(await basicAuthGate(new Request('https://weave.example/api/internal/tick', {method: 'POST'}), 'me:pw'), null);
  const legacy = await setup({runtime: ''});
  assert.equal((await legacy.call(null, 'internal/tick', {}, {Authorization: 'Bearer ' + SERVICE_TOKEN})).status, 503);
});

test('定期看看：10:00 叫醒一次（后台、system、不是直接找它），没说话就什么都没发；同一个点不醒第二次；晚了 2 小时以上不补', async () => {
  const s = await harness();
  s.setNow(at(1, '09:59')); await s.active();
  await s.serverTick();
  assert.equal(s.bgWakes().length, 0, '还没到 10:00');
  s.setNow(at(1, '10:00'));
  const before = (await s.person()).messages.length;
  assert.equal((await s.serverTick()).data.proactive.started, 1);
  const wake = s.bgWakes()[0].body;
  assert.deepEqual([wake.trigger.kind, wake.trigger.channel, wake.trigger.direct, wake.scope], ['check', 'system', false, 'owner']);
  assert.match(wake.trigger.text, /定期看看对方的进展（今天第 1 次，共 2 次）/);
  let p = await s.person();
  assert.equal(p.messages.length, before, '没调 send_message 就没有任何话');
  assert.equal(p.proactive.log.at(-1).outcome, 'quiet');
  assert.equal(p.proactive.running, null);
  s.setNow(at(1, '10:05'));
  await s.serverTick();
  assert.equal(s.bgWakes().length, 1, '同一个点只醒一次');
  // 第二天服务器 12:30 才恢复：10:00 那次晚了 2.5 小时，不补；19:30 照常。
  s.setNow(at(2, '12:30')); await s.active();
  await s.serverTick();
  assert.equal(s.bgWakes().length, 1);
  p = await s.person();
  assert.deepEqual(p.proactive.checksDone, ['10:00']);
  s.setNow(at(2, '19:30'));
  await s.serverTick();
  assert.equal(s.bgWakes().length, 2);
});

test('后台那一轮说了话：聊天里带「主动」标记、进网页通知；接了微信就发到微信；每天主动的句数到档位上限就不发', async () => {
  const answers = [];
  const s = await harness();
  s.agent(speaking(s, '今天走了吗？', answers));
  s.setNow(at(1, '10:00')); await s.active();
  await s.serverTick();
  let p = await s.person();
  const said = p.messages.filter(m => m.proactive === true);
  assert.equal(said.length, 1);
  assert.equal(said[0].source, 'agent');
  assert.equal(p.notifications.at(-1).text, said[0].text);
  assert.equal(p.proactive.sent, 1);
  assert.equal(p.proactive.log.at(-1).outcome, 'sent');
  // 接上微信以后，19:30 那次说的话进微信的发送队列。
  await s.bind(); await s.bridge('claim', {});
  s.setNow(at(1, '19:30'));
  await s.serverTick();
  const world = await s.read();
  assert.ok(Object.values(world.wechat).some(x => x.direction === 'outbound' && x.source === 'agent' && x.text.startsWith('今天走了吗？1')));
  // normal 每天最多主动说 2 句：第三句被挡。
  const cap = await s.tool('send_message', {text: '再说一句'}, s.bgWakes()[1].body.capability, 'toolu_extra');
  assert.deepEqual(cap.data, {ok: false, text: '今天主动说的话已经到上限了，这条没有发出。'});
  assert.deepEqual(answers.map(a => a.ok), [true, true]);
});

test('档位：别主动找我以后不定期看看、后台那一轮发不出话；她让设的提醒照响；只有她亲口说的那一轮能改档位', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active();
  // 先在网页上关掉。
  const off = await s.call('alice', 'proactive/level', {level: 'off'});
  assert.equal(off.status, 200);
  assert.deepEqual([off.data.proactive.level, off.data.proactive.checkTimes, off.data.proactive.messageCap], ['off', [], 0]);
  assert.equal((await s.call('alice', 'proactive/level', {level: 'loud'})).status, 400);
  await s.call('alice', 'reminders', {text: '喝水', dueAt: new Date(at(1, '09:30')).toISOString()});
  s.setNow(at(1, '10:00'));
  await s.serverTick();
  assert.equal(s.bgWakes().length, 0);
  const p = await s.person();
  assert.ok(p.messages.some(m => m.text === '提醒你：喝水'), '提醒照响');
  // 模型在聊天那一轮（直接找它）把档位调回来；后台那一轮不能调。
  const chat = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r-chat', channel: 'web', direct: true}, s.now);
  const background = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r-bg', channel: 'web', direct: false}, s.now);
  assert.deepEqual((await s.tool('send_message', {text: '在吗'}, background)).data, {ok: false, text: '对方关掉了主动消息，这条没有发出。'});
  assert.equal((await s.tool('set_proactivity', {level: 'high'}, background, 'toolu_2')).data.ok, false);
  const up = await s.tool('set_proactivity', {level: 'high'}, chat, 'toolu_3');
  assert.equal(up.data.ok, true);
  assert.deepEqual(JSON.parse(up.data.text), {proactivity: {level: 'high', check_times: '10:00,13:00,16:30,19:30', message_cap: 4, wake_cap: 8}});
  assert.equal((await s.person()).proactive.level, 'high');
});

test('跟进：聊天那一轮排的到点在后台叫醒，备忘写进 trigger；一次性的跑完就结束，每天的排到明天同一时间', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active();
  const chat = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r-chat', channel: 'web', direct: true}, s.now);
  const once = await s.tool('schedule_wake', {note: '她说 18:00 去走路，看看记了没有', at: '2030-01-01T18:30+08:00'}, chat, 'toolu_a');
  assert.equal(once.data.ok, true, once.data.text);
  const made = JSON.parse(once.data.text).schedule;
  assert.deepEqual({...made, schedule_id: 'x'}, {schedule_id: 'x', kind: 'wake', text: '她说 18:00 去走路，看看记了没有', repeat: 'none', next_at: '2030-01-01T18:30:00+08:00', status: 'scheduled'});
  const daily = JSON.parse((await s.tool('schedule_wake', {note: '睡前看看今天的小事', at: '2030-01-01T20:45:00+08:00', repeat: 'daily'}, chat, 'toolu_b')).data.text).schedule;
  s.setNow(at(1, '18:30'));
  await s.serverTick();
  const first = s.bgWakes()[0].body.trigger;
  assert.equal(first.kind, 'timer');
  assert.match(first.text, /^你之前排的跟进到点了：她说 18:00 去走路，看看记了没有/);
  let p = await s.person();
  assert.deepEqual([p.schedules[0].status, p.schedules[0].lastOutcome], ['done', 'quiet']);
  s.setNow(at(1, '20:45'));
  await s.serverTick();
  p = await s.person();
  const again = p.schedules.find(x => x.id === daily.schedule_id);
  assert.deepEqual([again.status, again.nextAt], ['scheduled', new Date(at(2, '20:45')).toISOString()]);
});

test('跟进的规则：安静时段、30 天以后、后台那一轮排重复的都不行；后台那一轮能排一次性的；取消找不到时告诉模型去哪查', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00'));
  const chat = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r1', channel: 'web', direct: true}, s.now);
  const bg = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r2', channel: 'web', direct: false}, s.now);
  const night = await s.tool('schedule_wake', {note: '看看', at: '2030-01-01T23:00:00+08:00'}, chat, 't1');
  assert.deepEqual(night.data, {ok: false, text: '这个时间在对方的安静时段（21:00–09:00）里，换一个 09:00–21:00 之间的时间。'});
  assert.equal((await s.tool('schedule_wake', {note: '看看', at: '2030-02-15T10:00:00+08:00'}, chat, 't2')).data.text, '跟进最远只能排到 30 天以后。');
  assert.equal((await s.tool('schedule_wake', {note: '看看', at: '2030-01-01T08:00:00+08:00'}, chat, 't3')).data.ok, false, '过去的时间');
  assert.equal((await s.tool('schedule_wake', {note: '每天看看', at: '2030-01-01T10:00:00+08:00', repeat: 'daily'}, bg, 't4')).data.text, '这一轮没有人找你，只能排一次性的跟进。');
  const later = await s.tool('schedule_wake', {note: '晚点再问一次', at: '2030-01-01T20:00:00+08:00'}, bg, 't5');
  assert.equal(later.data.ok, true);
  assert.equal((await s.person()).schedules[0].origin, 'background');
  assert.equal((await s.tool('set_reminder', {text: '喝水', due_at: '2030-01-01T12:00:00+08:00'}, bg, 't6')).data.text, '对方不在场，不能替对方设提醒。要晚点再看看，用 schedule_wake。');
  const id = JSON.parse(later.data.text).schedule.schedule_id;
  assert.deepEqual(JSON.parse((await s.tool('cancel_schedule', {schedule_id: id}, chat, 't7')).data.text), {cancelled: {schedule_id: id, table: 'schedules'}});
  const gone = await s.tool('cancel_schedule', {schedule_id: id}, chat, 't8');
  assert.deepEqual(gone.data, {ok: false, text: '没有这条安排，或者它已经结束了。先查 weave/weave.db 的 schedules 表和 reminders 表。'});
  // 只响一次的提醒也能取消，返回 reminders 表。
  const once = JSON.parse((await s.tool('set_reminder', {text: '打电话', due_at: '2030-01-01T20:00:00+08:00'}, chat, 't9')).data.text).reminder;
  assert.deepEqual(JSON.parse((await s.tool('cancel_schedule', {schedule_id: once.reminder_id}, chat, 't10')).data.text), {cancelled: {schedule_id: once.reminder_id, table: 'reminders'}});
});

test('被忽略就少说：连着两句主动消息没回，就不定期看看、不跑后台自己排的跟进；聊天里排的照跑；她一说话就恢复', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00')); await s.active();
  const chat = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r1', channel: 'web', direct: true}, s.now);
  const bg = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r2', channel: 'web', direct: false}, s.now);
  await s.tool('schedule_wake', {note: '后台自己排的', at: '2030-01-01T15:00:00+08:00'}, bg, 't1');
  await s.tool('schedule_wake', {note: '聊天里排的', at: '2030-01-01T16:00:00+08:00'}, chat, 't2');
  await s.edit(p => {
    for (const [i, hhmm] of [[1, '09:10'], [2, '09:20']]) p.messages.push({id: 'pro-' + i, role: 'assistant', text: '问 ' + i, proactive: true, createdAt: new Date(at(1, hhmm)).toISOString()});
  });
  assert.equal(quietReason(await s.person(), at(1, '10:00')), 'ignored');
  s.setNow(at(1, '10:00')); await s.serverTick();
  s.setNow(at(1, '15:00')); await s.serverTick();
  assert.equal(s.bgWakes().length, 0);
  assert.equal((await s.person()).schedules[0].lastOutcome, 'ignored');
  s.setNow(at(1, '16:00')); await s.serverTick();
  assert.equal(s.bgWakes().length, 1, '聊天里排的照跑');
  assert.match(s.bgWakes()[0].body.trigger.text, /聊天里排的/);
  assert.equal((await s.call('alice', 'status')).data.proactive.quietReason, 'ignored');
  await s.active(at(1, '18:00'));
  s.setNow(at(1, '19:30')); await s.serverTick();
  assert.equal(s.bgWakes().length, 2, '她说过话以后，19:30 的定期看看照常');
});

test('很久没来：7 天没说话也没打勾，就不定期看看；跟进照跑；新账号从没说过话也不定期看看', async () => {
  const s = await harness();
  s.setNow(at(1, '10:00'));
  await s.serverTick();
  assert.equal(s.bgWakes().length, 0, '从没说过话');
  await s.active(at(1, '10:01') - 8 * 86400_000);
  assert.equal(quietReason(await s.person(), at(1, '10:02')), 'inactive');
  s.setNow(at(1, '19:30')); await s.serverTick();
  assert.equal(s.bgWakes().length, 0);
});

test('两个闹钟同时跑：同一个点只叫醒一次；一轮 15 分钟还没回来就放掉、记成不确定，不重跑', async () => {
  let release;
  const s = await harness({agent: async call => { if (call.path === '/wake') await new Promise(r => { release = r; }); return quiet(); }});
  s.setNow(at(1, '10:00')); await s.active();
  const first = s.serverTick();
  await until(() => s.bgWakes().length === 1, 'first wake');
  await s.serverTick();
  assert.equal(s.bgWakes().length, 1, '第二个闹钟看到正在跑，不再叫醒');
  release();
  await first;
  assert.equal((await s.person()).proactive.running, null);
  // 一轮没回来：租约在 15 分钟后放掉，记成不确定；跟进不重跑。
  await s.edit(p => {
    p.proactive.running = {kind: 'timer', scheduleId: 'w1', since: at(1, '11:00'), sentBefore: 0};
    p.schedules = [{id: 'w1', kind: 'wake', text: '看看', repeat: 'none', nextAt: new Date(at(1, '11:00')).toISOString(), localTime: '11:00', anchorDay: 1, status: 'scheduled', origin: 'chat'}];
  });
  s.setNow(at(1, '11:10')); await s.serverTick();
  assert.ok((await s.person()).proactive.running, '15 分钟内还占着');
  s.setNow(at(1, '11:16')); await s.serverTick();
  const p = await s.person();
  assert.equal(p.proactive.running, null);
  assert.deepEqual([p.schedules[0].status, p.schedules[0].lastOutcome, p.proactive.log.at(-1).outcome], ['done', 'uncertain', 'uncertain']);
  assert.equal(s.bgWakes().length, 1, '那条跟进没有被再叫醒一次');
});

test('后台叫醒失败：Agent 服务明确说没开始跑，不算今天的次数；出错只记一笔，不重试', async () => {
  const s = await harness({agent: async () => new Response('{}', {status: 503})});
  s.setNow(at(1, '10:00')); await s.active();
  await s.serverTick();
  let p = await s.person();
  assert.deepEqual([p.proactive.wakes, p.proactive.log.at(-1).outcome], [0, 'unavailable']);
  s.agent(async () => new Response('{}', {status: 500}));
  s.setNow(at(1, '19:30')); await s.serverTick();
  p = await s.person();
  assert.deepEqual([p.proactive.wakes, p.proactive.log.at(-1).outcome], [1, 'uncertain']);
});

test('重复的提醒：到点原样发「提醒你：…」，不叫醒模型；接了微信只排一次；晚了 2 小时以上不补这一次，排到下一次', async () => {
  const s = await harness();
  s.setNow(at(1, '07:00'));
  const chat = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r1', channel: 'web', direct: true}, s.now);
  const r = await s.tool('set_reminder', {text: '吃药', due_at: '2030-01-01T08:00+08:00', repeat: 'daily'}, chat, 't1');
  const made = JSON.parse(r.data.text).schedule;
  assert.deepEqual([made.kind, made.repeat, made.next_at], ['reminder', 'daily', '2030-01-01T08:00:00+08:00']);
  await s.bind(); await s.bridge('claim', {});
  s.setNow(at(1, '08:00'));
  await s.tick();
  let world = await s.read(), p = world.people[s.id];
  assert.ok(p.messages.some(m => m.text === '提醒你：吃药'));
  assert.equal(p.schedules[0].nextAt, new Date(at(2, '08:00')).toISOString());
  const queued = () => Object.values(world.wechat).filter(x => x.source === 'reminder' && x.text === '提醒你：吃药').length;
  assert.equal(queued(), 1);
  await s.serverTick();
  world = await s.read();
  assert.equal(queued(), 1, '同一次只排一次');
  assert.equal(s.wakes().filter(c => c.body.background).length, 0, '提醒不叫醒模型');
  // 服务器停到第二天 11:00：8 点那次晚了 3 小时，不补，排到第三天。
  s.setNow(at(2, '11:00'));
  await s.serverTick();
  p = (await s.read()).people[s.id];
  assert.equal(p.messages.filter(m => m.text === '提醒你：吃药').length, 1);
  assert.deepEqual([p.schedules[0].lastOutcome, p.schedules[0].nextAt], ['missed', new Date(at(3, '08:00')).toISOString()]);
});

test('网页：状态里有排期和档位；删掉、暂停、恢复（恢复时排到下一个还没过的时间）；只响一次的提醒照旧走 reminders/cancel', async () => {
  const s = await harness();
  s.setNow(at(1, '07:00'));
  const chat = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r1', channel: 'web', direct: true}, s.now);
  const id = JSON.parse((await s.tool('set_reminder', {text: '吃药', due_at: '2030-01-01T08:00:00+08:00', repeat: 'weekly'}, chat, 't1')).data.text).schedule.schedule_id;
  const status = (await s.call('alice', 'status')).data;
  assert.deepEqual(status.proactive, {level: 'normal', activeStart: '09:00', activeEnd: '21:00', timezone: 'Asia/Shanghai', checkTimes: ['10:00', '19:30'], messageCap: 2, sentToday: 0, wakeCap: 4, wakesToday: 0, quietReason: 'inactive'});
  assert.deepEqual(status.schedules, [{id, kind: 'reminder', text: '吃药', repeat: 'weekly', nextAt: new Date(at(1, '08:00')).toISOString(), status: 'scheduled', origin: 'chat', lastRunAt: null, lastOutcome: null}]);
  assert.equal((await s.call('alice', 'schedules/pause', {id, paused: true})).data.schedule.status, 'paused');
  s.setNow(at(10, '07:00'));
  const resumed = (await s.call('alice', 'schedules/pause', {id, paused: false})).data.schedule;
  assert.deepEqual([resumed.status, resumed.nextAt], ['scheduled', new Date(at(15, '08:00')).toISOString()]);
  assert.equal((await s.call('alice', 'schedules/cancel', {id})).status, 200);
  const again = await s.call('alice', 'schedules/cancel', {id});
  assert.deepEqual([again.status, again.data.error], [404, '没有这条安排，或者它已经结束了。']);
  assert.equal((await s.call('alice', 'status')).data.schedules[0].status, 'cancelled');
});

test('快照：本人有 schedules（当地时间）和 proactive_settings 一行；群里两张都没有', async () => {
  const s = await harness();
  s.setNow(at(1, '09:00'));
  const chat = await issueCapability('ab'.repeat(32), {owner: s.id, scope: 'owner', runId: 'r1', channel: 'web', direct: true}, s.now);
  await s.tool('schedule_wake', {note: '看看走路', at: '2030-01-01T19:00:00+08:00', repeat: 'weekly'}, chat, 't1');
  const snap = await s.call(null, 'internal/agent/snapshot', undefined, {Authorization: 'Bearer ' + chat});
  assert.equal(snap.status, 200);
  const [row] = snap.data.tables.schedules;
  assert.deepEqual({...row, schedule_id: 'x'}, {schedule_id: 'x', kind: 'wake', text: '看看走路', repeat: 'weekly', next_at: '2030-01-01T19:00:00+08:00', status: 'scheduled', created_by: 'chat', last_run_at: null, last_outcome: null});
  assert.deepEqual(snap.data.tables.proactive_settings, [{level: 'normal', active_start: '09:00', active_end: '21:00', check_times: '10:00,19:30', message_cap: 2, sent_today: 0, wake_cap: 4, wakes_today: 0}]);
});
