import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ensureNotebook, readNotebook, setCompletion, addAlarm, dueAlarms, markFired, cancelAlarm, notebookPath, ALARM_TEXT} from '../notebook.mjs';

const tenant = () => {
  const root = mkdtempSync(join(tmpdir(), 'weave-notebook-'));
  const dirs = {root, workspace: join(root, 'workspace')};
  mkdirSync(dirs.workspace, {recursive: true});
  return dirs;
};
const NOW = Date.parse('2026-11-17T12:00:00+08:00');

const LEGACY = {
  version: 1, today: '2026-11-17', timezone: 'Asia/Shanghai', files: {},
  tables: {
    goals: [{goal_id: 'g1', title: '每天动一动', category: 'health', archived: 0, created_at: '2026-11-01T00:00:00Z'}],
    habits: [{habit_id: 'h1', name: '走路', identity: '我是爱走路的人', trigger: '晚饭后', minimum_action: '走到楼下', created_at: '2026-11-01T00:00:00Z', updated_at: null, goal_id: 'g1'}],
    completions: [{habit_id: 'h1', date: '2026-11-16', note: '25 分钟', source: 'agent', created_at: '2026-11-16T12:00:00Z'}],
    reminders: [
      {reminder_id: 'r1', text: '给妈妈打电话', due_at: '2026-11-17T20:00:00+08:00', status: 'scheduled'},
      {reminder_id: 'r0', text: '早就响过了', due_at: '2026-11-10T20:00:00+08:00', status: 'delivered'},
    ],
    schedules: [
      {schedule_id: 's1', kind: 'reminder', text: '吃药', repeat: 'daily', next_at: '2026-11-18T08:00:00+08:00', status: 'scheduled'},
      {schedule_id: 's2', kind: 'wake', text: '看看她走了没有', repeat: 'none', next_at: '2026-11-17T19:30:00+08:00', status: 'scheduled'},
      {schedule_id: 's3', kind: 'wake', text: '取消了的', repeat: 'none', next_at: '2026-11-17T19:30:00+08:00', status: 'cancelled'},
    ],
  },
};

test('第一次建本子：建表，导入旧数据里还有用的；提醒和跟进变成闹钟，响过的、取消的不导；第二次什么都不做', async () => {
  const dirs = tenant();
  let calls = 0;
  const first = await ensureNotebook(dirs, {legacy: async () => { calls++; return LEGACY; }});
  assert.deepEqual(first, {created: true, imported: true});
  assert.deepEqual(await ensureNotebook(dirs, {legacy: async () => { calls++; return LEGACY; }}), {created: false, imported: false});
  assert.equal(calls, 1);
  const book = readNotebook(dirs);
  assert.deepEqual(book.goals, [{id: 'g1', title: '每天动一动', category: 'health', archived: false, createdAt: '2026-11-01T00:00:00Z'}]);
  assert.deepEqual(book.habits.map(h => [h.id, h.name, h.minimumAction, h.goalId]), [['h1', '走路', '走到楼下', 'g1']]);
  assert.deepEqual(book.completions.map(c => [c.habitId, c.date, c.note]), [['h1', '2026-11-16', '25 分钟']]);
  assert.deepEqual(book.alarms.map(a => [a.id, a.kind, a.repeat, a.note]).sort(), [
    ['r1', 'reminder', 'none', '给妈妈打电话'], ['s1', 'reminder', 'daily', '吃药'], ['s2', 'self', 'none', '看看她走了没有'],
  ].sort());
});

test('取旧数据失败就不建本子，下一次再试（不留一个空本子）', async () => {
  const dirs = tenant();
  await assert.rejects(ensureNotebook(dirs, {legacy: async () => { throw Error('快照接口返回 503'); }}));
  assert.equal(existsSync(notebookPath(dirs)), false);
  assert.deepEqual(await ensureNotebook(dirs, {legacy: async () => LEGACY}), {created: true, imported: true});
});

test('Weave 用 SQL 直接写的记录，网页读得到；since 之前的打卡不给', async () => {
  const dirs = tenant();
  await ensureNotebook(dirs);
  const db = new DatabaseSync(notebookPath(dirs));
  db.exec("INSERT INTO habits (habit_id, name) VALUES ('a', '早睡'); INSERT INTO completions (habit_id, date) VALUES ('a', '2026-09-01'), ('a', '2026-11-16')");
  db.close();
  const book = readNotebook(dirs, {since: '2026-10-01'});
  assert.deepEqual(book.habits.map(h => h.name), ['早睡']);
  assert.deepEqual(book.completions.map(c => c.date), ['2026-11-16']);
});

test('网页打勾和取消：写进同一个本子；没有这个习惯回 null', async () => {
  const dirs = tenant();
  await ensureNotebook(dirs, {legacy: async () => LEGACY});
  assert.deepEqual(setCompletion(dirs, {habitId: 'h1', date: '2026-11-17', done: true, now: NOW}), {habitId: 'h1', date: '2026-11-17', done: true});
  assert.ok(readNotebook(dirs).completions.some(c => c.date === '2026-11-17' && c.source === 'web'));
  setCompletion(dirs, {habitId: 'h1', date: '2026-11-17', done: false});
  assert.ok(!readNotebook(dirs).completions.some(c => c.date === '2026-11-17'));
  assert.equal(setCompletion(dirs, {habitId: 'nope', date: '2026-11-17', done: true}), null);
});

test('定闹钟只检查格式：只写到分钟的补上 :00；过去的时间、不带时区、字数、选项不对都给能照做的原因', async () => {
  const dirs = tenant();
  await ensureNotebook(dirs);
  const alarm = addAlarm(dirs, {at: '2026-11-17T20:00+08:00', note: ' 提醒她给妈妈打电话 ', kind: 'reminder', now: NOW});
  assert.equal(alarm.at, '2026-11-17T20:00:00+08:00');
  assert.equal(alarm.note, '提醒她给妈妈打电话');
  assert.equal(alarm.status, 'scheduled');
  for (const [input, message] of [
    [{at: '2026-11-17T08:00:00+08:00', note: '过去了'}, ALARM_TEXT.badTime],
    [{at: '2026-11-17T20:00:00', note: '没有时区'}, ALARM_TEXT.badTime],
    [{at: '2026-11-17T20:00:00+08:00', note: ''}, ALARM_TEXT.note],
    [{at: '2026-11-17T20:00:00+08:00', note: 'x', repeat: 'hourly'}, ALARM_TEXT.repeat],
    [{at: '2026-11-17T20:00:00+08:00', note: 'x', kind: 'other'}, ALARM_TEXT.kind],
  ]) assert.throws(() => addAlarm(dirs, {...input, now: NOW}), {message});
});

test('到点：按时间先后给；Weave 用 SQL 取消的、还没到的不给；响过后不重复的结束，每天的排到第二天同一个当地钟点', async () => {
  const dirs = tenant();
  await ensureNotebook(dirs);
  const later = addAlarm(dirs, {at: '2026-11-17T20:00:00+08:00', note: '晚上', now: NOW});
  const daily = addAlarm(dirs, {at: '2026-11-17T19:00:00+08:00', note: '每天吃药', repeat: 'daily', kind: 'reminder', now: NOW});
  const cancelled = addAlarm(dirs, {at: '2026-11-17T18:00:00+08:00', note: '不要了', now: NOW});
  const db = new DatabaseSync(notebookPath(dirs));
  db.prepare("UPDATE alarms SET status = 'cancelled' WHERE alarm_id = ?").run(cancelled.id);
  db.close();
  const at2030 = Date.parse('2026-11-17T20:30:00+08:00');
  assert.deepEqual(dueAlarms(dirs, at2030).map(a => a.note), ['每天吃药', '晚上']);
  assert.deepEqual(dueAlarms(dirs, Date.parse('2026-11-17T19:30:00+08:00')).map(a => a.note), ['每天吃药']);
  markFired(dirs, dueAlarms(dirs, at2030)[0], {now: at2030, timezone: 'Asia/Shanghai'});
  markFired(dirs, dueAlarms(dirs, at2030)[0], {now: at2030, timezone: 'Asia/Shanghai'});
  assert.deepEqual(dueAlarms(dirs, at2030), []);
  const left = readNotebook(dirs).alarms;
  assert.deepEqual(left.map(a => [a.id, a.at]), [[daily.id, '2026-11-18T19:00:00+08:00']]);
  assert.ok(!left.some(a => a.id === later.id));
});

test('网页取消闹钟：取消了就不再到点；没有这条回 false', async () => {
  const dirs = tenant();
  await ensureNotebook(dirs);
  const alarm = addAlarm(dirs, {at: '2026-11-17T20:00:00+08:00', note: 'x', now: NOW});
  assert.equal(cancelAlarm(dirs, alarm.id), true);
  assert.equal(cancelAlarm(dirs, alarm.id), false);
  assert.deepEqual(dueAlarms(dirs, Date.parse('2026-11-18T00:00:00+08:00')), []);
});
