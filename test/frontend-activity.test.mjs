import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVITY_DAYS, ACTIVITY_LIMIT, activityDays} from '../hosted/app/workspace/activity-view.mjs';
import {PANEL_KEY, PANEL_MEDIA, readPanelOpen, writePanelOpen} from '../hosted/app/workspace/side-panel.mjs';

// 动态, the first tab of the assistant's home page and of the panel beside the chat, and the panel itself. Tuesday
// 2026-11-03 is "today"; the person is in Shanghai unless a test says otherwise.
const SH = 'Asia/Shanghai', LA = 'America/Los_Angeles';
const TODAY = '2026-11-03';
const reminderAt = (id, at, text = id) => ({id, at, kind: 'reminder', text});
const titles = days => days.map(day => [day.label, day.items.map(item => item.title)]);

// ---- 动态 ----

test('activityDays: each kind of entry has its title and grey line, as the drafts have them, and the time on the wall', () => {
  const activity = [
    {id: 'a7', at: '2026-11-02T23:00:00.000Z', kind: 'completion', habit: ' 饭后走走 ', date: '2026-11-02'},     // 07:00
    {id: 'a1', at: '2026-11-03T11:31:00.000Z', kind: 'message', text: '  今天走了吗？要不要饭后一起出去转转？\n不想去也没关系。  '},   // 19:31
    {id: 'a2', at: '2026-11-03T11:30:00.000Z', kind: 'check', outcome: 'quiet'},                                   // 19:30
    {id: 'a3', at: '2026-11-03T02:00:00.000Z', kind: 'check', outcome: 'jev-quiet'},                               // 10:00
    {id: 'a4', at: '2026-11-03T01:00:00.000Z', kind: 'followup', outcome: 'quiet'},                                // 09:00
    {id: 'a5', at: '2026-11-03T00:30:00.000Z', kind: 'followup', outcome: 'jev-quiet'},                            // 08:30
    {id: 'a6', at: '2026-11-03T00:00:00.000Z', kind: 'reminder', text: '给妈妈打个电话'},                           // 08:00
  ];
  assert.deepEqual(activityDays({activity, tz: SH, today: TODAY}), [{day: TODAY, label: '今天', items: [
    {key: 'message:a1', kind: 'message', title: '主动问了你一句', detail: '今天走了吗？要不要饭后一起出去转转？\n不想去也没关系。', time: '19:31', at: '2026-11-03T11:31:00.000Z'},
    {key: 'check:a2', kind: 'check', title: '看了看你今天的进展', detail: '没什么要说的，就没打扰你', time: '19:30', at: '2026-11-03T11:30:00.000Z'},
    {key: 'check:a3', kind: 'check', title: '看了看你今天的进展', detail: '判断现在不用打扰你', time: '10:00', at: '2026-11-03T02:00:00.000Z'},
    {key: 'followup:a4', kind: 'followup', title: '按约好的来看看', detail: '没什么要说的，就没打扰你', time: '09:00', at: '2026-11-03T01:00:00.000Z'},
    {key: 'followup:a5', kind: 'followup', title: '按约好的来看看', detail: '判断现在不用打扰你', time: '08:30', at: '2026-11-03T00:30:00.000Z'},
    {key: 'reminder:a6', kind: 'reminder', title: '给妈妈打个电话', detail: '到点提醒了你', time: '08:00', at: '2026-11-03T00:00:00.000Z'},
    {key: 'completion:a7', kind: 'completion', title: '帮你记了一次：饭后走走', detail: '在聊天里记的', time: '07:00', at: '2026-11-02T23:00:00.000Z'},
  ]}]);
});

test('activityDays: newest first, under 今天, 昨天 and the date of each older day', () => {
  const activity = [
    reminderAt('交房租', '2026-11-01T12:00:00.000Z'),        // 1 November, 20:00
    reminderAt('喝水', '2026-11-03T01:00:00.000Z'),          // today, 09:00
    reminderAt('早饭', '2026-11-02T00:00:00.000Z'),          // yesterday, 08:00
    reminderAt('拉伸', '2026-11-02T13:00:00.000Z'),          // yesterday, 21:00
    reminderAt('万圣节', '2026-10-31T02:00:00.000Z'),        // 31 October, 10:00
  ];
  const days = activityDays({activity, tz: SH, today: TODAY});
  assert.deepEqual(days.map(day => [day.day, day.label, day.items.map(item => [item.title, item.time])]), [
    ['2026-11-03', '今天', [['喝水', '09:00']]],
    ['2026-11-02', '昨天', [['拉伸', '21:00'], ['早饭', '08:00']]],
    ['2026-11-01', '11 月 1 日', [['交房租', '20:00']]],
    ['2026-10-31', '10 月 31 日', [['万圣节', '10:00']]],
  ]);
  const newYear = [reminderAt('跨年', '2026-12-31T04:00:00.000Z'), reminderAt('前天', '2026-12-30T04:00:00.000Z'), reminderAt('元旦', '2027-01-01T04:00:00.000Z')];
  assert.deepEqual(titles(activityDays({activity: newYear, tz: SH, today: '2027-01-01'})), [['今天', ['元旦']], ['昨天', ['跨年']], ['12 月 30 日', ['前天']]], 'over New Year');
});

test('activityDays: the day and the time are the person\'s, not UTC\'s', () => {
  // 17:00 UTC on the 2nd is 01:00 on the 3rd in Shanghai, and 09:00 on the 2nd in Los Angeles
  const activity = [reminderAt('喝水', '2026-11-02T17:00:00.000Z')];
  const shown = (tz, today) => activityDays({activity, tz, today}).map(day => [day.label, day.items[0].time]);
  assert.deepEqual(shown(SH, '2026-11-03'), [['今天', '01:00']]);
  assert.deepEqual(shown(LA, '2026-11-03'), [['昨天', '09:00']]);
  assert.deepEqual(shown(LA, '2026-11-02'), [['今天', '09:00']]);
  assert.deepEqual(shown(undefined, '2026-11-03'), [['今天', '01:00']], 'no zone: Beijing time, never the machine\'s');
  // a time may come as milliseconds too; `at` is then written out as ISO, for <time dateTime>
  assert.equal(activityDays({activity: [reminderAt('毫秒', Date.parse('2026-11-03T01:00:00Z'))], tz: SH, today: TODAY})[0].items[0].at, '2026-11-03T01:00:00.000Z');
});

test('activityDays: the last 14 days, and 50 rows at most, the newest', () => {
  assert.deepEqual([ACTIVITY_DAYS, ACTIVITY_LIMIT], [14, 50]);
  const window = [
    reminderAt('第 14 天', '2026-10-21T04:00:00.000Z'),            // today minus 13 days: the first day kept
    reminderAt('第 14 天的零点', '2026-10-20T16:00:00.000Z'),      // 00:00 on 21 October in Shanghai
    reminderAt('第 15 天', '2026-10-20T15:59:00.000Z'),            // 23:59 on 20 October in Shanghai
  ];
  assert.deepEqual(titles(activityDays({activity: window, tz: SH, today: TODAY})), [['10 月 21 日', ['第 14 天', '第 14 天的零点']]]);
  assert.deepEqual(titles(activityDays({activity: window, tz: SH})), [['10 月 21 日', ['第 14 天', '第 14 天的零点']], ['10 月 20 日', ['第 15 天']]], 'without today (an older server) every day is kept');

  const start = Date.parse('2026-11-02T00:00:00.000Z');
  const many = Array.from({length: 60}, (_, i) => reminderAt('第 ' + i + ' 条', new Date(start + i * 30 * 60000).toISOString()));
  const shown = activityDays({activity: many, tz: SH, today: TODAY});
  const rows = shown.flatMap(day => day.items);
  assert.equal(rows.length, 50);
  assert.deepEqual([rows[0].title, rows[49].title], ['第 59 条', '第 10 条'], 'the 50 newest, the newest first');
  // the entries start at 08:00 on the 2nd in Shanghai, half an hour apart: the 33rd (number 32) is midnight
  assert.deepEqual(shown.map(day => [day.label, day.items.length]), [['今天', 28], ['昨天', 22]], 'the limit counts across days');
});

test('activityDays: what the tab does not show is left out', () => {
  const at = '2026-11-03T01:00:00.000Z';
  const activity = [
    reminderAt('ok', at, '喝水'),
    {id: 'kind', at, kind: 'wake', text: '别的东西'},
    {id: 'spoke', at, kind: 'check', outcome: 'spoke'},
    {id: 'failed', at, kind: 'followup', outcome: 'failed'},
    {id: 'no-outcome', at, kind: 'check'},
    {id: 'proto', at, kind: 'followup', outcome: 'toString'},
    {id: 'blank', at, kind: 'message', text: '   '},
    {id: 'no-text', at, kind: 'reminder'},
    {id: 'no-habit', at, kind: 'completion', date: TODAY},
    {id: 'bad-time', at: 'not a time', kind: 'reminder', text: '时间坏了'},
    {id: 'no-time', kind: 'reminder', text: '没有时间'},
    null, 'x', 7,
  ];
  assert.deepEqual(activityDays({activity, tz: SH, today: TODAY}).flatMap(day => day.items.map(item => item.key)), ['reminder:ok']);
  for (const odd of [undefined, null, 'x', {}, 7]) assert.deepEqual(activityDays({activity: odd, tz: SH, today: TODAY}), [], 'an older server: ' + String(odd));
  assert.deepEqual(activityDays(), []);
});

test('activityDays: each row has a key of its own, also without an id; the list it was given is left as it was', () => {
  const at = Date.parse('2026-11-03T01:00:00.000Z');
  const activity = [
    {id: 'x', at: '2026-11-03T01:00:00.000Z', kind: 'reminder', text: '同一个 id'},
    {id: 'x', at: '2026-11-03T01:00:00.000Z', kind: 'message', text: '同一个 id，另一种'},
    {id: 7, at: '2026-11-03T02:00:00.000Z', kind: 'reminder', text: '数字 id'},
    {at: '2026-11-03T01:00:00.000Z', kind: 'completion', habit: '喝水'},
  ];
  const before = JSON.stringify(activity);
  const keys = activityDays({activity, tz: SH, today: TODAY}).flatMap(day => day.items.map(item => item.key));
  assert.deepEqual(keys, ['reminder:7', 'reminder:x', 'message:x', 'completion:' + at]);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(JSON.stringify(activity), before);
});

// ---- the panel beside the chat ----

test('the panel is open unless it was closed in this browser; storage that is missing or refuses changes nothing', () => {
  assert.equal(PANEL_MEDIA, '(min-width: 1200px)');
  const items = new Map();
  const storage = {getItem: key => (items.has(key) ? items.get(key) : null), setItem: (key, value) => items.set(key, String(value)), removeItem: key => items.delete(key)};
  assert.equal(readPanelOpen(storage), true, 'open the first time');
  writePanelOpen(storage, false);
  assert.deepEqual([...items], [[PANEL_KEY, 'closed']]);
  assert.equal(readPanelOpen(storage), false, 'closed stays closed after a reload');
  writePanelOpen(storage, true);
  assert.deepEqual([...items], [], 'opened again: nothing is kept');
  items.set(PANEL_KEY, 'something else');
  assert.equal(readPanelOpen(storage), true, 'only 「closed」 closes it');

  const refusing = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }};
  assert.equal(readPanelOpen(refusing), true);
  assert.doesNotThrow(() => { writePanelOpen(refusing, false); writePanelOpen(refusing, true); });
  assert.equal(readPanelOpen(null), true);
  assert.doesNotThrow(() => writePanelOpen(null, false));
});
