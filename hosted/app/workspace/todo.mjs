// 待办 (to-do): what the page lists, worked out from the status answer. Pure: the page passes in `today` (the person's
// own day, from the status answer) and `now`; nothing here reads the clock.
import {COPY} from './copy.mjs';
import {addDays, dayRange, localDay, toMs, weekStart} from './dates.mjs';
import {doneDaysByHabit} from './records.mjs';
import {SERVER_DEFAULT_TIMEZONE} from './timezone.mjs';

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

// today   one row per habit that is being tracked
//         {habitId, title, meta, done, missedYesterday, weekCount}
//         meta  「为了「目标名」 · 什么时候 · 最小一步：…」 with the parts the habit does not have left out
//         missedYesterday  the habit existed before today, was not done yesterday and is not done today
//         weekCount        the days from Monday to today it was done: 「记下了，这周第 N 天」
//         A habit is left out only when its goal is in the list and archived. A habit with no goal, or with a goal that
//         is not in the list, stays.
// later   {reminderId, title, dueAt}: one-off reminders that are still scheduled and not due yet, soonest first
// doneCount / total   the 「今天 n / m」 of the header; reminders are not in it
//
// `tz` is the person's zone (profile.timezone): it decides on which day a habit was created. Left out, it is Beijing
// time, the zone every new account starts with.
export function todoModel({goals = [], habits = [], completions = [], reminders = [], today = '', now, tz = SERVER_DEFAULT_TIMEZONE} = {}) {
  const goalById = new Map(goals.map(goal => [goal.id, goal]));
  const doneDays = doneDaysByHabit(completions);
  const week = dayRange(weekStart(today), today);
  const yesterday = addDays(today, -1);

  const rows = habits
    .filter(habit => (goalById.get(habit.goalId) || {}).archived !== true)
    .map(habit => {
      const goal = goalById.get(habit.goalId), days = doneDays.get(habit.id) || new Set();
      const createdDay = localDay(habit.createdAt, tz), step = trimmed(habit.minimumAction);
      const done = days.has(today);
      return {
        habitId: habit.id,
        title: habit.name,
        meta: [goal && trimmed(goal.title) ? COPY.forGoal(trimmed(goal.title)) : '', trimmed(habit.trigger), step ? COPY.minimumStep(step) : ''].filter(Boolean).join(' · '),
        done,
        missedYesterday: !done && !!createdDay && createdDay < today && !days.has(yesterday),
        weekCount: week.filter(day => days.has(day)).length,
      };
    });

  const later = upcomingReminders({reminders, now});
  return {today: rows, later, doneCount: rows.filter(row => row.done).length, total: rows.length};
}

// The one-off reminders that are still scheduled and not due yet at `now`, soonest first: {reminderId, title, dueAt}.
// 待办 lists them under 之后, the assistant's home page under 只响一次.
export function upcomingReminders({reminders = [], now} = {}) {
  const nowMs = toMs(now);
  return reminders
    .filter(reminder => reminder.status === 'scheduled' && toMs(reminder.dueAt) > nowMs)
    .sort((a, b) => toMs(a.dueAt) - toMs(b.dueAt))
    .map(reminder => ({reminderId: reminder.id, title: reminder.text, dueAt: reminder.dueAt}));
}
