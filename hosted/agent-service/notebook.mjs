// 本子：每个人工作目录里的 records.db（docs/ARCHITECTURE.md「本子」）。
// Weave 自己用 sqlite3 读写它：教材 p.28「数据库也是个文件呀」，p.30「给Agent一台电脑,意味着它可以用自己的方式读原始数据,
// 而不是只能拿你预处理过的东西」。网页只读它来显示；她在网页上打勾，也写这一个文件。
// 这里的代码只做三件事：建表（启动前预处理）、给网页读写（基础设施）、闹钟的计时（基础设施）。记什么、怎么记由 Weave 定。
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {localParts, localHHMM, nextAfter} from './repeat.mjs';

export const NOTEBOOK_FILE = 'records.db';

// 表的格式是约定（系统提示里告诉 Weave，网页按它显示），代码不校验 Weave 写进去的内容。
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (goal_id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS habits (habit_id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT, trigger TEXT, minimum_action TEXT, goal_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS completions (habit_id TEXT NOT NULL, date TEXT NOT NULL, note TEXT, source TEXT, created_at TEXT, PRIMARY KEY (habit_id, date));
CREATE TABLE IF NOT EXISTS alarms (alarm_id TEXT PRIMARY KEY, at TEXT NOT NULL, note TEXT NOT NULL, repeat TEXT NOT NULL DEFAULT 'none', kind TEXT NOT NULL DEFAULT 'self', status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT, fired_at TEXT);
`;

export const REPEATS = Object.freeze(['none', 'daily', 'weekly', 'monthly']);
// reminder：她让 Weave 到点提醒她的；self：Weave 自己要回来看看的。到点时这两种都进同一段对话，Weave 自己说；
// 区分它们只为了 Jev：她让设的提醒不经过 Jev（docs/ARCHITECTURE.md「主动性」）。
export const ALARM_KINDS = Object.freeze(['reminder', 'self']);

// 草稿文案，待确认：schedule 工具出错时给 Weave 看的原因（教材 p.38「错误返回要能指导自我纠正」）。
export const ALARM_TEXT = Object.freeze({
  badTime: '时间要写成带时区的 ISO 格式，并且在将来，比如 2026-11-17T20:00:00+08:00。',
  note: '闹钟上写给自己的话要 1–500 字。',
  repeat: 'repeat 只能是 none、daily、weekly 或 monthly。',
  kind: 'kind 只能是 reminder（对方让你到点提醒的）或 self（你自己想到点回来看看的）。',
});

export const notebookPath = dirs => join(dirs.workspace, NOTEBOOK_FILE);

function open(path) {
  const db = new DatabaseSync(path);
  // Weave 可能正在容器里用 sqlite3 写同一个文件：等一会儿，不立刻报「database is locked」。
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function withDb(dirs, fn) {
  const db = open(notebookPath(dirs));
  try { return fn(db); } finally { db.close(); }
}

// 以前存在网站库里的数据（旧快照接口的格式，snapshot.mjs 的 validateSnapshot）：只导还有用的。
// 提醒和跟进只导还没结束的，变成闹钟；历史上响过的不导。
function importLegacy(db, legacy) {
  const t = legacy?.tables || {};
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  for (const g of t.goals || []) run('INSERT OR IGNORE INTO goals (goal_id, title, category, archived, created_at) VALUES (?, ?, ?, ?, ?)', g.goal_id, g.title ?? '', g.category ?? null, g.archived ? 1 : 0, g.created_at ?? null);
  for (const h of t.habits || []) run('INSERT OR IGNORE INTO habits (habit_id, name, identity, trigger, minimum_action, goal_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', h.habit_id, h.name ?? '', h.identity ?? '', h.trigger ?? '', h.minimum_action ?? '', h.goal_id || null, h.created_at ?? null, h.updated_at ?? null);
  for (const c of t.completions || []) run('INSERT OR IGNORE INTO completions (habit_id, date, note, source, created_at) VALUES (?, ?, ?, ?, ?)', c.habit_id, c.date, c.note ?? '', c.source ?? null, c.created_at ?? null);
  for (const r of t.reminders || []) {
    if (r.status === 'scheduled') run("INSERT OR IGNORE INTO alarms (alarm_id, at, note, repeat, kind, status) VALUES (?, ?, ?, 'none', 'reminder', 'scheduled')", r.reminder_id, r.due_at, r.text ?? '');
  }
  for (const s of t.schedules || []) {
    if (s.status !== 'scheduled' && s.status !== 'paused') continue;
    run('INSERT OR IGNORE INTO alarms (alarm_id, at, note, repeat, kind, status) VALUES (?, ?, ?, ?, ?, ?)', s.schedule_id, s.next_at, s.text ?? '', REPEATS.includes(s.repeat) ? s.repeat : 'none', s.kind === 'reminder' ? 'reminder' : 'self', s.status);
  }
}

// 第一次建本子：建表；legacy() 给了旧数据就一起导进来，只做这一次。先写到临时文件再改名，
// 取旧数据失败（抛错）就不建，下一次再试，免得留下一个空本子、旧数据再也导不进来。
export async function ensureNotebook(dirs, {legacy} = {}) {
  const path = notebookPath(dirs);
  if (existsSync(path)) return {created: false, imported: false};
  const rows = legacy ? await legacy() : null;
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const db = open(temporary);
    try {
      db.exec(SCHEMA);
      if (rows) { db.exec('BEGIN'); importLegacy(db, rows); db.exec('COMMIT'); }
    } finally { db.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
  return {created: true, imported: !!rows};
}

const alarmRow = a => ({id: a.alarm_id, at: a.at, note: a.note, repeat: a.repeat, kind: a.kind, status: a.status, firedAt: a.fired_at ?? null});

// 网页显示用（/api/status）：格式和以前网站库里的一样，页面不用改。since：只要这一天以后的打卡。
export function readNotebook(dirs, {since = ''} = {}) {
  return withDb(dirs, db => ({
    goals: db.prepare('SELECT * FROM goals ORDER BY created_at, goal_id').all().map(g => ({id: g.goal_id, title: g.title, category: g.category, archived: !!g.archived, createdAt: g.created_at})),
    habits: db.prepare('SELECT * FROM habits ORDER BY created_at, habit_id').all().map(h => ({id: h.habit_id, name: h.name, identity: h.identity ?? '', trigger: h.trigger ?? '', minimumAction: h.minimum_action ?? '', goalId: h.goal_id || null, createdAt: h.created_at, updatedAt: h.updated_at})),
    completions: db.prepare('SELECT * FROM completions WHERE date >= ? ORDER BY date, habit_id').all(since).map(c => ({habitId: c.habit_id, date: c.date, note: c.note ?? '', source: c.source, createdAt: c.created_at})),
    alarms: db.prepare("SELECT * FROM alarms WHERE status IN ('scheduled', 'paused') ORDER BY at").all().map(alarmRow),
  }));
}

// 她在网页上给某个习惯的某一天打勾（done: true）或取消（false）。习惯不存在就回 null。
export function setCompletion(dirs, {habitId, date, done, now = Date.now()}) {
  return withDb(dirs, db => {
    if (!db.prepare('SELECT 1 FROM habits WHERE habit_id = ?').get(habitId)) return null;
    if (done) db.prepare("INSERT OR IGNORE INTO completions (habit_id, date, note, source, created_at) VALUES (?, ?, '', 'web', ?)").run(habitId, date, new Date(now).toISOString());
    else db.prepare('DELETE FROM completions WHERE habit_id = ? AND date = ?').run(habitId, date);
    return {habitId, date, done: !!done};
  });
}

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const fail = message => { throw Object.assign(Error(message), {status: 400}); };

// 带偏移的当地时间，比如 2026-11-17T20:00:00+08:00。
export function localISO(ms, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// schedule 工具：Weave 给自己定一个闹钟。只检查格式（时间、字数、选项），不替它判断该不该定。
// 模型常把时间写到分钟、不带秒（2026-11-17T20:00+08:00），这里补上 :00。
export function addAlarm(dirs, {at, note, repeat = 'none', kind = 'self', now = Date.now()}) {
  const match = typeof at === 'string' ? at.match(ISO) : null;
  const atMs = match ? Date.parse(match[1] + (match[2] || ':00') + match[3]) : NaN;
  if (!Number.isFinite(atMs) || atMs <= now) fail(ALARM_TEXT.badTime);
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text || text.length > 500) fail(ALARM_TEXT.note);
  if (!REPEATS.includes(repeat)) fail(ALARM_TEXT.repeat);
  if (!ALARM_KINDS.includes(kind)) fail(ALARM_TEXT.kind);
  const row = {alarm_id: randomUUID().slice(0, 8), at: match[1] + (match[2] || ':00') + match[3], note: text, repeat, kind, status: 'scheduled', fired_at: null};
  withDb(dirs, db => db.prepare('INSERT INTO alarms (alarm_id, at, note, repeat, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.alarm_id, row.at, row.note, row.repeat, row.kind, row.status, new Date(now).toISOString()));
  return alarmRow(row);
}

// 到点了的闹钟（Weave 用 SQL 改成 cancelled 或删掉的不算）。时间写不对、读不出来的跳过，不让一条坏数据挡住别的。
export function dueAlarms(dirs, now = Date.now()) {
  return withDb(dirs, db => db.prepare("SELECT * FROM alarms WHERE status = 'scheduled'").all())
    .filter(a => Date.parse(a.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map(alarmRow);
}

// 响过一次：不重复的记成 done；重复的排到下一个还没过的时间（按她所在时区的当地钟点）。
export function markFired(dirs, alarm, {now = Date.now(), timezone = 'Asia/Shanghai'} = {}) {
  const atMs = Date.parse(alarm.at);
  const next = alarm.repeat === 'none' ? null
    : nextAfter({repeat: alarm.repeat, localTime: localHHMM(atMs, timezone), anchorDay: localParts(atMs, timezone).day}, atMs, now, timezone);
  const fired = new Date(now).toISOString();
  withDb(dirs, db => {
    if (next === null) db.prepare("UPDATE alarms SET status = 'done', fired_at = ? WHERE alarm_id = ?").run(fired, alarm.id);
    else db.prepare('UPDATE alarms SET at = ?, fired_at = ? WHERE alarm_id = ?').run(localISO(next, timezone), fired, alarm.id);
  });
  return next;
}

const shiftDay = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

// 给 Jev 的事实（她定的用途：判断要不要主动提醒用户）：每个习惯今天做没做、最近 7 天做了几天。
// 只在 Weave 想主动开口时、由 Agent 服务交给网站去问 Jev；不替 Weave 做任何判断。
export function habitFacts(dirs, today) {
  const from = shiftDay(today, -6);
  return withDb(dirs, db => {
    const done = db.prepare('SELECT habit_id, date FROM completions WHERE date >= ? AND date <= ?').all(from, today);
    return {
      goals: db.prepare('SELECT title FROM goals WHERE archived = 0').all().map(g => g.title),
      habits: db.prepare('SELECT habit_id, name, minimum_action, trigger FROM habits').all().map(h => ({
        name: h.name, minimum_action: h.minimum_action ?? '', trigger: h.trigger ?? '',
        done_today: done.some(c => c.habit_id === h.habit_id && c.date === today),
        days_done_last_7: new Set(done.filter(c => c.habit_id === h.habit_id).map(c => c.date)).size,
      })),
    };
  });
}

// 她在网页上取消一个闹钟。没有这条（或已经结束）回 false。
export function cancelAlarm(dirs, alarmId) {
  return withDb(dirs, db => db.prepare("UPDATE alarms SET status = 'cancelled' WHERE alarm_id = ? AND status IN ('scheduled', 'paused')").run(alarmId).changes > 0);
}

// 她在网页上暂停或恢复一个重复的闹钟。恢复时，已经过去的那一次跳过，排到下一个还没过的时间。没有这条回 null。
export function pauseAlarm(dirs, alarmId, paused, {now = Date.now(), timezone = 'Asia/Shanghai'} = {}) {
  return withDb(dirs, db => {
    const row = db.prepare("SELECT * FROM alarms WHERE alarm_id = ? AND status IN ('scheduled', 'paused') AND repeat != 'none'").get(alarmId);
    if (!row) return null;
    let at = row.at;
    if (!paused && Date.parse(at) <= now) {
      const atMs = Date.parse(at);
      const next = nextAfter({repeat: row.repeat, localTime: localHHMM(atMs, timezone), anchorDay: localParts(atMs, timezone).day}, atMs, now, timezone);
      if (next !== null) at = localISO(next, timezone);
    }
    db.prepare('UPDATE alarms SET status = ?, at = ? WHERE alarm_id = ?').run(paused ? 'paused' : 'scheduled', at, alarmId);
    return alarmRow({...row, status: paused ? 'paused' : 'scheduled', at});
  });
}
