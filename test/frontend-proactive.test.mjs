import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LEVELS, LEVEL_KEY, levelSteps, reminderGroups, settlePresses, withPresses} from '../hosted/app/workspace/proactive-view.mjs';
import {upcomingReminders} from '../hosted/app/workspace/todo.mjs';

// The 提醒 tab of the assistant's home page (docs/superpowers/specs/2026-11-03-proactive-wake-design.md, sections 4.2,
// 4.8 and 4.9). Tuesday 2026-11-03 is "today"; it is noon in Shanghai, where the person is unless a test says otherwise.
const SH = 'Asia/Shanghai', LA = 'America/Los_Angeles';
const TODAY = '2026-11-03';
const NOW = Date.parse('2026-11-03T04:00:00Z');   // 12:00 in Shanghai

// The settings of each level as the draft has them (section 4.2), with the hours Weave may come at 09:00–21:00.
const CHECKS = {off: [], low: ['19:30'], normal: ['10:00', '19:30'], high: ['10:00', '13:30', '16:30', '19:30']};
const CAPS = {off: 0, low: 1, normal: 2, high: 4}, WAKES = {off: 0, low: 2, normal: 4, high: 8};
const settings = (level = 'normal', extra = {}) => ({level, activeStart: '09:00', activeEnd: '21:00', timezone: SH, checkTimes: CHECKS[level],
  messageCap: CAPS[level], sentToday: 0, wakeCap: WAKES[level], wakesToday: 0, quietReason: null, ...extra});
const schedule = (id, kind, text, repeat, nextAt, status = 'scheduled') => ({id, kind, text, repeat, nextAt, status, origin: 'chat', lastRunAt: null, lastOutcome: null});
const reminder = (id, text, dueAt, status = 'scheduled') => ({id, text, dueAt, status, createdAt: '2026-11-01T00:00:00.000Z'});
const groupsOf = extra => reminderGroups({now: NOW, tz: SH, today: TODAY, ...extra});
const EMPTY = {dial: null, notice: null, once: [], daily: [], weekly: [], monthly: []};

// ---- the dial ----

test('levelSteps: 多找我一点 goes one step up, from off to low; 少找我一点 one down, not below low; 别主动找我 to off', () => {
  assert.deepEqual(LEVELS, ['off', 'low', 'normal', 'high']);
  assert.deepEqual(levelSteps('off'), {can: {more: true, less: false, stop: false}, next: {more: 'low', less: null}});
  assert.deepEqual(levelSteps('low'), {can: {more: true, less: false, stop: true}, next: {more: 'normal', less: null}});
  assert.deepEqual(levelSteps('normal'), {can: {more: true, less: true, stop: true}, next: {more: 'high', less: 'low'}});
  assert.deepEqual(levelSteps('high'), {can: {more: false, less: true, stop: true}, next: {more: null, less: 'normal'}});
  for (const odd of ['', 'max', 'Normal', undefined, null, 2]) assert.deepEqual(levelSteps(odd), {can: {more: false, less: false, stop: false}, next: {more: null, less: null}}, String(odd));
});

test('the dial: what the level means now, the quiet hours while Weave may come, and the three buttons', () => {
  const dial = (level, extra) => groupsOf({proactive: settings(level, extra)}).dial;
  assert.deepEqual(dial('normal'), {level: 'normal', line: '每天看 2 次你的进展，最多主动说 2 句。', quietHours: '21:00–09:00 不打扰。', ...levelSteps('normal')});
  assert.deepEqual(dial('low'), {level: 'low', line: '每天看 1 次你的进展，最多主动说 1 句。', quietHours: '21:00–09:00 不打扰。', ...levelSteps('low')});
  assert.deepEqual(dial('high'), {level: 'high', line: '每天看 4 次你的进展，最多主动说 4 句。', quietHours: '21:00–09:00 不打扰。', ...levelSteps('high')});
  assert.deepEqual(dial('off'), {level: 'off', line: '现在不主动找你。你让 Weave 设的提醒照常响。', quietHours: null, ...levelSteps('off')}, 'off: its own sentence, and no quiet hours to speak of');
  assert.equal(dial('normal', {activeStart: '08:00', activeEnd: '22:30'}).quietHours, '22:30–08:00 不打扰。', 'the hours the server sends');
  assert.equal(dial('normal', {activeStart: '09:00', activeEnd: '09:00'}).quietHours, null, 'the whole day open: nothing is quiet');
  for (const odd of [{activeStart: undefined}, {activeEnd: '9:00'}, {activeEnd: '24:00'}]) assert.equal(dial('normal', odd).quietHours, null, JSON.stringify(odd));
  assert.equal(dial('normal', {messageCap: undefined}).line, '', 'no line rather than one with a hole in it');
  assert.equal(dial('normal', {checkTimes: undefined}).line, '每天看 0 次你的进展，最多主动说 2 句。', 'the times are counted as they are sent');
});

test('the notice says why Weave is not looking in right now, and only while it is not off', () => {
  const notice = (level, quietReason) => groupsOf({proactive: settings(level, {quietReason})}).notice;
  assert.equal(notice('normal', 'ignored'), '你最近两次没回，Weave 先不主动问了；你说一句话就恢复。');
  assert.equal(notice('low', 'inactive'), '你这周没来，Weave 先不主动问了；你说一句话就恢复。');
  assert.equal(notice('normal', null), null);
  for (const odd of ['busy', 'toString', 'constructor', '', undefined]) assert.equal(notice('high', odd), null, 'only the two reasons: ' + String(odd));
  assert.equal(notice('off', 'ignored'), null, 'off: speaking again would not bring it back, so it is not said');
});

// ---- an older server ----

test('an older server sends no settings and no schedules: the one-off reminders and three empty groups, and no dial', () => {
  const reminders = [reminder('r:call', '给妈妈打个电话', '2026-11-04T12:00:00.000Z')];
  const model = groupsOf({reminders});
  assert.deepEqual(model, {...EMPTY, once: [{key: 'reminder:r:call', id: 'r:call', kind: 'once-reminder', title: '给妈妈打个电话', meta: '明天 20:00 · 到时候 Weave 会提醒你',
    paused: false, canPause: false, removeAction: 'reminders/cancel'}]});
  for (const [schedules, proactive] of [[undefined, undefined], [null, null], ['x', 'x'], [{}, {}], [[], {level: 'max'}], [[], {checkTimes: ['10:00']}]])
    assert.deepEqual(groupsOf({reminders, schedules, proactive}), model, JSON.stringify({schedules, proactive}));
  assert.deepEqual(reminderGroups(), EMPTY, 'nothing at all');
  assert.deepEqual(groupsOf({reminders: 'x'}), EMPTY);
});

// ---- 只响一次 ----

test('只响一次: the one-off reminders still to come and Weave\'s one-off follow-ups still to come, soonest first', () => {
  const reminders = [
    reminder('r:tomorrow', '给妈妈打个电话', '2026-11-04T12:00:00.000Z'),        // tomorrow 20:00
    reminder('r:past', '已经过了', '2026-11-03T03:00:00.000Z'),
    reminder('r:cancelled', '取消了', '2026-11-05T12:00:00.000Z', 'cancelled'),
  ];
  const schedules = [
    schedule('w:later', 'wake', '问问周末的安排', 'none', '2026-11-06T02:00:00.000Z'),   // 6 November 10:00
    schedule('w:tonight', 'wake', '问问今天走了没有', 'none', '2026-11-03T11:30:00.000Z'),  // today 19:30
    schedule('w:past', 'wake', '已经过了', 'none', '2026-11-03T03:30:00.000Z'),
    schedule('w:now', 'wake', '正好是现在', 'none', '2026-11-03T04:00:00.000Z'),
    ...['done', 'missed', 'cancelled', 'paused'].map(status => schedule('w:' + status, 'wake', status, 'none', '2026-11-05T02:00:00.000Z', status)),
    schedule('w:daily', 'wake', '每天的', 'daily', '2026-11-03T11:30:00.000Z'),
  ];
  const once = groupsOf({reminders, schedules, proactive: settings('normal')}).once;
  assert.deepEqual(once.map(row => [row.key, row.kind, row.title, row.meta, row.removeAction]), [
    ['schedule:w:tonight', 'wake', '问问今天走了没有', '今天 19:30 · Weave 会来问问', 'schedules/cancel'],
    ['reminder:r:tomorrow', 'once-reminder', '给妈妈打个电话', '明天 20:00 · 到时候 Weave 会提醒你', 'reminders/cancel'],
    ['schedule:w:later', 'wake', '问问周末的安排', '11 月 6 日 10:00 · Weave 会来问问', 'schedules/cancel'],
  ]);
  assert.deepEqual(once[0], {key: 'schedule:w:tonight', id: 'w:tonight', kind: 'wake', title: '问问今天走了没有', meta: '今天 19:30 · Weave 会来问问', paused: false, canPause: false, removeAction: 'schedules/cancel'},
    'a one-off row has no pause button');
  assert.deepEqual(once.filter(row => row.kind === 'once-reminder').map(row => row.id), upcomingReminders({reminders, now: NOW}).map(item => item.reminderId), 'the reminders are 待办\'s 之后, by the same rule');
  assert.deepEqual(groupsOf({reminders, schedules, now: '2026-11-03T11:30:00.000Z'}).once.map(row => row.id), ['r:tomorrow', 'w:later'], 'at 19:30 the follow-up is due and leaves; now may be an ISO time');
  assert.deepEqual(groupsOf({reminders, schedules, tz: LA, today: '2026-11-02'}).once.map(row => row.meta), [
    '明天 03:30 · Weave 会来问问', '11 月 4 日 04:00 · 到时候 Weave 会提醒你', '11 月 5 日 18:00 · Weave 会来问问',
  ], 'the days and times are the person\'s');
});

test('只响一次: a one-off reminder kept with the schedules (the contract has none) still shows, as a reminder', () => {
  const once = groupsOf({schedules: [schedule('s:once', 'reminder', '取快递', 'none', '2026-11-03T10:00:00.000Z')]}).once;
  assert.deepEqual(once, [{key: 'schedule:s:once', id: 's:once', kind: 'reminder', title: '取快递', meta: '今天 18:00 · 到时候 Weave 会提醒你', paused: false, canPause: false, removeAction: 'schedules/cancel'}]);
});

// ---- 每天, 每周, 每月 ----

test('每天, 每周, 每月: the repeating reminders and follow-ups that run or are paused, by when they come round', () => {
  const schedules = [
    schedule('d:evening', 'reminder', '喝水', 'daily', '2026-11-03T13:00:00.000Z'),               // 21:00
    schedule('d:morning', 'wake', '问问睡得怎么样', 'daily', '2026-11-04T00:00:00.000Z'),          // 08:00
    schedule('d:paused', 'reminder', '拉伸', 'daily', '2026-11-03T11:30:00.000Z', 'paused'),        // 19:30
    ...['done', 'missed', 'cancelled'].map(status => schedule('d:' + status, 'reminder', status, 'daily', '2026-11-03T12:00:00.000Z', status)),
    schedule('w:sunday', 'reminder', '给爸妈打电话', 'weekly', '2026-11-08T02:00:00.000Z'),        // Sunday 10:00
    schedule('w:wednesday', 'wake', '问问这周走了几天', 'weekly', '2026-11-04T11:30:00.000Z'),      // Wednesday 19:30
    schedule('w:monday', 'reminder', '交周报', 'weekly', '2026-11-09T01:00:00.000Z', 'paused'),     // Monday 09:00
    schedule('w:monday-early', 'wake', '问问这周想做什么', 'weekly', '2026-11-09T00:30:00.000Z'),    // Monday 08:30
    schedule('m:third', 'reminder', '交房租', 'monthly', '2026-12-03T00:00:00.000Z'),              // the 3rd, 08:00
    schedule('m:first', 'reminder', '看信用卡账单', 'monthly', '2026-12-01T12:00:00.000Z'),        // the 1st, 20:00
    schedule('m:cancelled', 'reminder', '取消了', 'monthly', '2026-11-20T12:00:00.000Z', 'cancelled'),
  ];
  const model = groupsOf({schedules, proactive: settings('off')});
  assert.deepEqual(model.daily.map(row => [row.id, row.meta]), [
    ['d:morning', '08:00 · Weave 会来问问'],
    ['d:paused', '19:30 · 已暂停'],
    ['d:evening', '21:00 · 到时候 Weave 会提醒你'],
  ]);
  assert.deepEqual(model.weekly.map(row => [row.id, row.meta]), [
    ['w:monday-early', '每周一 08:30 · Weave 会来问问'],
    ['w:monday', '每周一 09:00 · 已暂停'],
    ['w:wednesday', '每周三 19:30 · Weave 会来问问'],
    ['w:sunday', '每周日 10:00 · 到时候 Weave 会提醒你'],
  ], 'Monday first and Sunday last, as the records calendar has the week');
  assert.deepEqual(model.monthly.map(row => [row.id, row.meta]), [
    ['m:first', '每月 1 号 20:00 · 到时候 Weave 会提醒你'],
    ['m:third', '每月 3 号 08:00 · 到时候 Weave 会提醒你'],
  ]);
  assert.deepEqual(model.once, [], 'nothing that repeats is in 只响一次');
  assert.deepEqual(model.daily[1], {key: 'schedule:d:paused', id: 'd:paused', kind: 'reminder', title: '拉伸', meta: '19:30 · 已暂停', paused: true, canPause: true, removeAction: 'schedules/cancel'});
  for (const row of [...model.daily, ...model.weekly, ...model.monthly]) {
    assert.deepEqual([row.canPause, row.removeAction, row.paused], [true, 'schedules/cancel', row.id.endsWith('paused') || row.id === 'w:monday'], row.id);
    assert.equal(row.kind, schedules.find(item => item.id === row.id).kind);
  }
});

test('a repeating row comes round on the person\'s weekday, day and time, not UTC\'s, and is sorted by them', () => {
  const meta = (repeat, nextAt, tz) => reminderGroups({schedules: [schedule('s', 'reminder', '交周报', repeat, nextAt)], now: NOW, tz, today: TODAY})[repeat][0].meta;
  // Wednesday 23:30 UTC is Thursday 07:30 in Shanghai; Thursday 03:30 UTC is Wednesday 19:30 in Los Angeles
  assert.equal(meta('weekly', '2026-11-04T23:30:00.000Z', SH), '每周四 07:30 · 到时候 Weave 会提醒你');
  assert.equal(meta('weekly', '2026-11-05T03:30:00.000Z', LA), '每周三 19:30 · 到时候 Weave 会提醒你');
  assert.equal(meta('weekly', '2026-11-05T03:30:00.000Z', SH), '每周四 11:30 · 到时候 Weave 会提醒你');
  // 1 December 02:00 UTC is 30 November 18:00 in Los Angeles; 30 November 16:30 UTC is 1 December 00:30 in Shanghai
  assert.equal(meta('monthly', '2026-12-01T02:00:00.000Z', LA), '每月 30 号 18:00 · 到时候 Weave 会提醒你');
  assert.equal(meta('monthly', '2026-11-30T16:30:00.000Z', SH), '每月 1 号 00:30 · 到时候 Weave 会提醒你');
  assert.equal(meta('daily', '2026-11-03T11:30:00.000Z', LA), '03:30 · 到时候 Weave 会提醒你');
  assert.equal(meta('weekly', '2026-11-04T23:30:00.000Z', undefined), '每周四 07:30 · 到时候 Weave 会提醒你', 'no zone: Beijing time, never the machine\'s');
  // Set for the 31st: in November it comes on the 30th (the server clamps to the end of the month), but it is still
  // the 31st's reminder. An anchorDay that is not a day of the month is ignored.
  const anchored = (anchorDay, nextAt) => reminderGroups({schedules: [{...schedule('a', 'reminder', '交房租', 'monthly', nextAt), anchorDay}], now: NOW, tz: SH, today: TODAY}).monthly[0].meta;
  assert.equal(anchored(31, '2026-11-30T00:00:00.000Z'), '每月 31 号 08:00 · 到时候 Weave 会提醒你');
  assert.equal(anchored(0, '2026-11-30T00:00:00.000Z'), '每月 30 号 08:00 · 到时候 Weave 会提醒你');
  assert.equal(anchored(null, '2026-11-30T00:00:00.000Z'), '每月 30 号 08:00 · 到时候 Weave 会提醒你');

  // 13:00 UTC is 21:00 in Shanghai and 05:00 in Los Angeles; 23:00 UTC is 07:00 and 15:00
  const schedules = [schedule('a', 'reminder', 'a', 'daily', '2026-11-03T13:00:00.000Z'), schedule('b', 'reminder', 'b', 'daily', '2026-11-03T23:00:00.000Z')];
  assert.deepEqual(groupsOf({schedules, tz: SH}).daily.map(row => row.id), ['b', 'a'], 'by the time on the wall in Shanghai');
  assert.deepEqual(groupsOf({schedules, tz: LA}).daily.map(row => row.id), ['a', 'b'], 'and in Los Angeles');
  // Sunday 20:00 in Los Angeles is Monday 04:00 UTC: in Los Angeles it is the last of the week
  const week = [schedule('sun', 'reminder', 'sun', 'weekly', '2026-11-09T04:00:00.000Z'), schedule('mon', 'reminder', 'mon', 'weekly', '2026-11-09T18:00:00.000Z')];
  assert.deepEqual(groupsOf({schedules: week, tz: LA}).weekly.map(row => row.meta.slice(0, 3)), ['每周一', '每周日']);
  assert.deepEqual(groupsOf({schedules: week, tz: SH}).weekly.map(row => row.meta.slice(0, 3)), ['每周一', '每周二']);
});

test('每天 starts with Weave\'s own look at the day while it is not off; it can be neither paused nor deleted', () => {
  const daily = (level, extra) => groupsOf({schedules: [schedule('d', 'reminder', '喝水', 'daily', '2026-11-03T00:00:00.000Z')], proactive: settings(level, extra)}).daily;
  assert.deepEqual(daily('normal')[0], {key: 'check', id: null, kind: 'check', title: '看看你今天的进展', meta: '10:00、19:30 · Weave 自己安排的', paused: false, canPause: false, removeAction: null});
  assert.deepEqual(daily('normal').map(row => row.key), ['check', 'schedule:d'], 'first, even before a row that comes earlier (08:00): the dial above is what it follows');
  assert.equal(daily('low')[0].meta, '19:30 · Weave 自己安排的');
  assert.equal(daily('high')[0].meta, '10:00、13:30、16:30、19:30 · Weave 自己安排的');
  assert.equal(daily('high').filter(row => row.kind === 'check').length, 1, 'one row, whatever the number of times');
  assert.deepEqual(daily('off').map(row => row.key), ['schedule:d'], 'off: Weave does not look in');
  for (const checkTimes of [[], undefined, 'x']) assert.deepEqual(daily('normal', {checkTimes}).map(row => row.key), ['schedule:d'], 'no times: no row (' + String(checkTimes) + ')');
  assert.equal(daily('normal', {checkTimes: ['10:00', 'soon', 7, '25:00', null]})[0].meta, '10:00 · Weave 自己安排的', 'only times that can be read');
  const quiet = groupsOf({proactive: settings('normal', {quietReason: 'ignored'})});
  assert.deepEqual([quiet.daily[0].key, !!quiet.notice], ['check', true], 'quiet for now: the row stays, and the notice above says why');
});

test('what the tab cannot place is left out: another kind, another repeat, a time that cannot be read', () => {
  const schedules = [
    schedule('ok', 'reminder', '喝水', 'daily', '2026-11-03T00:00:00.000Z'),
    schedule('kind', 'note', '别的东西', 'daily', '2026-11-03T00:00:00.000Z'),
    schedule('yearly', 'reminder', '生日', 'yearly', '2026-12-03T00:00:00.000Z'),
    schedule('no-repeat', 'wake', '没有 repeat', undefined, '2026-11-03T10:00:00.000Z'),
    schedule('broken', 'reminder', '时间坏了', 'weekly', 'not a time'),
    schedule('missing', 'wake', '没有时间', 'daily', undefined),
    schedule('once-broken', 'wake', '时间坏了', 'none', 'not a time'),
    {id: 'no-text', kind: 'wake', repeat: 'daily', nextAt: '2026-11-03T00:00:00.000Z', status: 'scheduled'},
    {kind: 'wake', text: '没有 id', repeat: 'daily', nextAt: '2026-11-03T00:00:00.000Z', status: 'scheduled'},
    {id: 7, kind: 'wake', text: 'id 是数字', repeat: 'daily', nextAt: '2026-11-03T00:00:00.000Z', status: 'scheduled'},
    null, 'x', 7,
  ];
  const model = groupsOf({schedules});
  assert.deepEqual([...model.once, ...model.daily, ...model.weekly, ...model.monthly].map(row => row.id), ['ok']);
});

// ---- changes on their way ----

const press = (value, extra = {}) => ({value, finished: false, seen: 0, answer: null, ...extra});

test('withPresses: a row paused or resumed shows so at once; the level shows once it is answered, and the buttons wait until then', () => {
  const schedules = [
    schedule('d', 'reminder', '喝水', 'daily', '2026-11-03T00:00:00.000Z'),
    schedule('w', 'wake', '问问这周走了几天', 'weekly', '2026-11-04T11:30:00.000Z', 'paused'),
    schedule('x', 'reminder', '取消了', 'daily', '2026-11-03T01:00:00.000Z', 'cancelled'),
  ];
  const status = {schedules, proactive: settings('normal')};
  assert.deepEqual(withPresses(status, {}), {schedules, proactive: status.proactive, busy: false}, 'nothing pressed: the status as it is');

  const shown = withPresses(status, {'schedule:d': press(true), 'schedule:w': press(false), 'schedule:x': press(true)});
  assert.deepEqual(shown.schedules.map(item => [item.id, item.status]), [['d', 'paused'], ['w', 'scheduled'], ['x', 'cancelled']], 'a row that has ended stays ended');
  const model = groupsOf({schedules: shown.schedules, proactive: shown.proactive});
  assert.deepEqual(model.daily.map(row => [row.key, row.meta, row.paused]), [['check', '10:00、19:30 · Weave 自己安排的', false], ['schedule:d', '08:00 · 已暂停', true]]);
  assert.deepEqual(model.weekly.map(row => [row.meta, row.paused]), [['每周三 19:30 · Weave 会来问问', false]]);

  const asked = withPresses(status, {[LEVEL_KEY]: press('high')});
  assert.deepEqual([asked.busy, asked.proactive], [true, status.proactive], 'on its way: the old settings, and the buttons wait');
  const answer = {proactive: settings('high')};
  const answered = withPresses(status, {[LEVEL_KEY]: press('high', {finished: true, answer})});
  assert.deepEqual([answered.busy, answered.proactive], [false, answer.proactive], 'answered: what the server says goes with the new level');
  const dial = groupsOf({proactive: answered.proactive}).dial;
  assert.deepEqual([dial.line, dial.next.less, dial.can.more], ['每天看 4 次你的进展，最多主动说 4 句。', 'normal', false], 'the next press starts from the new level');
  for (const odd of [{}, {ok: true}, {proactive: {level: 'max'}}, null])
    assert.deepEqual(Object.values(withPresses(status, {[LEVEL_KEY]: press('high', {finished: true, answer: odd})})).slice(1), [status.proactive, true], 'an answer without settings: the buttons wait for the status (' + JSON.stringify(odd) + ')');

  assert.deepEqual(withPresses({}, {}), {schedules: [], proactive: undefined, busy: false}, 'an older server');
  assert.deepEqual(withPresses(), {schedules: [], proactive: undefined, busy: false});
});

test('settlePresses: a change stays until the server shows the same, or until the second answer after it came back', () => {
  const status = (paused, level = 'normal') => ({schedules: [schedule('d', 'reminder', '喝水', 'daily', '2026-11-03T00:00:00.000Z', paused ? 'paused' : 'scheduled')], proactive: settings(level)});

  const waiting = {'schedule:d': press(true)};
  assert.equal(settlePresses(waiting, status(false)), waiting, 'not back yet: the same object, nothing changed');
  assert.equal(settlePresses(waiting, status(true)), waiting, 'not back yet, even when the server shows it already');
  assert.deepEqual(settlePresses({'schedule:d': press(true, {finished: true})}, status(true)), {}, 'back, and the server shows it');
  const first = settlePresses({'schedule:d': press(true, {finished: true})}, status(false));
  assert.equal(first['schedule:d'].seen, 1, 'the first answer after it came back may have been asked for before the change');
  assert.deepEqual(settlePresses(first, status(false)), {}, 'the second was asked for after it: from then on the server\'s answer is shown');
  assert.deepEqual(settlePresses(waiting, {schedules: [], proactive: settings('normal')}), {}, 'the row is gone');
  assert.deepEqual(settlePresses(waiting, {schedules: [schedule('d', 'reminder', '喝水', 'daily', '2026-11-03T00:00:00.000Z', 'cancelled')]}), {}, 'the row has ended');

  const level = extra => ({[LEVEL_KEY]: press('high', {finished: true, answer: {proactive: settings('high')}, ...extra})});
  assert.deepEqual(settlePresses(level(), status(false, 'high')), {});
  assert.equal(settlePresses(level(), status(false, 'normal'))[LEVEL_KEY].seen, 1);
  assert.deepEqual(settlePresses(level({seen: 1}), status(false, 'normal')), {});
  assert.equal(settlePresses(level({finished: false}), status(false, 'normal'))[LEVEL_KEY].seen, 0, 'on its way: kept, not counted');
  assert.deepEqual(settlePresses(level(), {schedules: []}), {}, 'no settings to go by (an older server)');

  const token = {};
  const kept = settlePresses({'schedule:d': press(true, {finished: true, token})}, status(false));
  assert.equal(kept['schedule:d'].token, token, 'what the page keeps in a press is carried along');
  assert.deepEqual(settlePresses({}, status(false)), {});
});

test('the lists and settings the tab is given are left as they were', () => {
  const reminders = [reminder('r:b', 'b', '2026-11-05T12:00:00.000Z'), reminder('r:a', 'a', '2026-11-04T12:00:00.000Z')];
  const schedules = [schedule('d2', 'reminder', 'd2', 'daily', '2026-11-03T13:00:00.000Z'), schedule('d1', 'wake', 'd1', 'daily', '2026-11-03T00:00:00.000Z', 'paused'), schedule('o', 'wake', 'o', 'none', '2026-11-03T10:00:00.000Z')];
  const proactive = settings('high'), presses = {'schedule:d1': press(false, {finished: true}), [LEVEL_KEY]: press('normal')};
  const before = JSON.stringify({reminders, schedules, proactive, presses});
  const shown = withPresses({schedules, proactive}, presses);
  groupsOf({reminders, schedules: shown.schedules, proactive: shown.proactive});
  settlePresses(presses, {schedules, proactive});
  assert.equal(JSON.stringify({reminders, schedules, proactive, presses}), before);
});
