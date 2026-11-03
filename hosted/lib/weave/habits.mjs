// 习惯和完成记录（docs/ARCHITECTURE.md 第 10 节：要准确、要在网页上显示，所以放 D1，经工具后端写）。
// 存在本人的 person 文档里：person.goals、person.habits、person.completions。日期一律按本人时区的当地日期。
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
  // 草稿文案（目标这一层，同样会作为工具结果交给模型），待确认。
  goalTitle: '目标名字要 1–30 个字。',
  goalCategory: '类别只能是 health、relationships、finance、career、interests、productivity、other 之一。',
  goalTooMany: '最多同时追踪 10 个目标。先把不再追踪的目标归档（archived: true），再加新的。',
  goalNotFound: '没有这个目标。先查 weave/weave.db 的 goals 表，看现有的目标和编号。',
};
const MAX_HABITS = 20;
const MAX_ACTIVE_GOALS = 10;
// 目标的七个类别；顺序就是网页上显示的顺序。
export const GOAL_CATEGORIES = ['health', 'relationships', 'finance', 'career', 'interests', 'productivity', 'other'];

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
const publicHabit = h => ({habit_id: h.id, name: h.name, identity: h.identity, trigger: h.trigger, minimum_action: h.minimumAction, goal_id: h.goalId ?? null});
const publicCompletion = c => ({habit_id: c.habitId, date: c.date, note: c.note});
const publicGoal = g => ({goal_id: g.id, title: g.title, category: g.category, archived: g.archived});
const findHabit = (person, id) => (person.habits || []).find(h => h.id === id);
const findGoal = (person, id) => (person.goals || []).find(g => g.id === id);
const activeGoalCount = person => (person.goals || []).filter(g => !g.archived).length;

function goalTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > 30) fail(TEXT.goalTitle);
  return title;
}
function goalCategory(value) {
  if (!GOAL_CATEGORIES.includes(value)) fail(TEXT.goalCategory);
  return value;
}
// 习惯只能挂在存在、而且还在追踪的目标上。
function linkableGoalId(person, id) {
  const goal = findGoal(person, id);
  if (!goal || goal.archived) fail(TEXT.goalNotFound);
  return goal.id;
}

export function saveGoal(person, args, now = Date.now()) {
  const at = new Date(now).toISOString();
  if (args?.goal_id !== undefined) {
    const goal = findGoal(person, args.goal_id);
    if (!goal) fail(TEXT.goalNotFound);
    // 只改给了的字段，没给的保持原样。先全部检查完再改：失败时不留下改了一半的目标。
    const title = args.title === undefined ? goal.title : goalTitle(args.title);
    const category = args.category === undefined ? goal.category : goalCategory(args.category);
    // archived 只认 true / false，别的值当作没给。
    const archived = typeof args.archived === 'boolean' ? args.archived : goal.archived;
    // 恢复追踪也要守「最多 10 个在追踪」。
    if (goal.archived && !archived && activeGoalCount(person) >= MAX_ACTIVE_GOALS) fail(TEXT.goalTooMany);
    goal.title = title;
    goal.category = category;
    goal.archived = archived;
    goal.updatedAt = at;
    return {goal: publicGoal(goal)};
  }
  const title = goalTitle(args?.title);
  const category = goalCategory(args?.category);
  if (activeGoalCount(person) >= MAX_ACTIVE_GOALS) fail(TEXT.goalTooMany);
  const goal = {id: 'g:' + crypto.randomUUID(), title, category, archived: false, createdAt: at, updatedAt: at};
  person.goals ??= [];
  person.goals.push(goal);
  return {goal: publicGoal(goal)};
}

export function saveHabit(person, args, now = Date.now()) {
  const name = typeof args?.name === 'string' ? args.name.trim() : '';
  if (!name || name.length > 30) fail(TEXT.name);
  const identity = optionalText(args.identity, 200, TEXT.field);
  const trigger = optionalText(args.trigger, 200, TEXT.field);
  const minimumAction = optionalText(args.minimum_action, 200, TEXT.field);
  const goalId = args.goal_id === undefined ? undefined : linkableGoalId(person, args.goal_id);
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
    if (goalId !== undefined) habit.goalId = goalId;
    habit.updatedAt = at;
    return {habit: publicHabit(habit)};
  }
  if (person.habits.length >= MAX_HABITS) fail(TEXT.tooMany);
  const habit = {id: 'h:' + crypto.randomUUID(), name, identity: identity ?? '', trigger: trigger ?? '', minimumAction: minimumAction ?? '', createdAt: at, updatedAt: at};
  if (goalId !== undefined) habit.goalId = goalId;
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

// 网页上的打勾：今天按本人时区算，来源记 web；logCompletion 按「习惯 + 日期」去重，重复点不重复记。
export function checkToday(person, habitId, now = Date.now()) {
  return logCompletion(person, {habit_id: habitId, date: localClock(person, now).day}, now, 'web');
}

// 取消今天的打勾：只删这个习惯在本人当地今天的记录，不论是网页还是 Agent 记的；别的日子、别的习惯不动。
export function uncheckToday(person, habitId, now = Date.now()) {
  const habit = findHabit(person, habitId);
  if (!habit) fail(TEXT.notFound);
  const today = localClock(person, now).day;
  const all = person.completions || [];
  const kept = all.filter(c => !(c.habitId === habit.id && c.date === today));
  if (kept.length === all.length) return {removed: false};
  person.completions = kept;
  return {removed: true};
}
