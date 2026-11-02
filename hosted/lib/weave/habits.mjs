// 习惯和完成记录（docs/ARCHITECTURE.md 第 10 节：要准确、要在网页上显示，所以放 D1，经工具后端写）。
// 存在本人的 person 文档里：person.habits、person.completions。日期一律按本人时区的当地日期。
import {fail} from './domain.mjs';
import {localClock} from './proactivity.mjs';

// 草稿文案（会作为工具结果交给模型），待确认。
const TEXT = {
  name: '习惯名字要 1–30 个字。',
  field: '身份句、触发和最小动作每项最多 200 字。',
  tooMany: '最多 20 个习惯。先合并或删掉不用的，再加新的。',
  notFound: '没有这个习惯。先查 weave/weave.db 的 habits 表，看现有的习惯和编号。',
  date: '日期要写成 YYYY-MM-DD，并且是真实存在的日期。',
  future: today => `不记未来的日期。按对方的当地时间，今天是 ${today}。`,
  note: '备注最多 500 字。',
};
const MAX_HABITS = 20;

function validDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}
function optionalText(value, max, message) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length > max) fail(message);
  return value.trim();
}
const publicHabit = h => ({habit_id: h.id, name: h.name, identity: h.identity, trigger: h.trigger, minimum_action: h.minimumAction});
const publicCompletion = c => ({habit_id: c.habitId, date: c.date, note: c.note});
const findHabit = (person, id) => (person.habits || []).find(h => h.id === id);

export function saveHabit(person, args, now = Date.now()) {
  const name = typeof args?.name === 'string' ? args.name.trim() : '';
  if (!name || name.length > 30) fail(TEXT.name);
  const identity = optionalText(args.identity, 200, TEXT.field);
  const trigger = optionalText(args.trigger, 200, TEXT.field);
  const minimumAction = optionalText(args.minimum_action, 200, TEXT.field);
  const at = new Date(now).toISOString();
  person.habits ??= [];
  if (args.habit_id !== undefined) {
    const habit = findHabit(person, args.habit_id);
    if (!habit) fail(TEXT.notFound);
    // 只改给了的字段，没给的保持原样。
    habit.name = name;
    if (identity !== undefined) habit.identity = identity;
    if (trigger !== undefined) habit.trigger = trigger;
    if (minimumAction !== undefined) habit.minimumAction = minimumAction;
    habit.updatedAt = at;
    return {habit: publicHabit(habit)};
  }
  if (person.habits.length >= MAX_HABITS) fail(TEXT.tooMany);
  const habit = {id: 'h:' + crypto.randomUUID(), name, identity: identity ?? '', trigger: trigger ?? '', minimumAction: minimumAction ?? '', createdAt: at, updatedAt: at};
  person.habits.push(habit);
  return {habit: publicHabit(habit)};
}

export function logCompletion(person, args, now = Date.now(), source = 'agent') {
  const habit = findHabit(person, args?.habit_id);
  if (!habit) fail(TEXT.notFound);
  if (!validDate(args.date)) fail(TEXT.date);
  const today = localClock(person, now).day;
  if (args.date > today) fail(TEXT.future(today));
  const note = optionalText(args.note, 500, TEXT.note) ?? '';
  person.completions ??= [];
  const existing = person.completions.find(c => c.habitId === habit.id && c.date === args.date);
  if (existing) return {completion: publicCompletion(existing), duplicate: true};
  const completion = {id: crypto.randomUUID(), habitId: habit.id, date: args.date, note, createdAt: new Date(now).toISOString(), source};
  person.completions.push(completion);
  return {completion: publicCompletion(completion), duplicate: false};
}
