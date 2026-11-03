// 目标 (goals): the cards of the goals page, worked out from the status answer. Pure: the page passes in `today` (the
// person's own day) and `tz` (profile.timezone); nothing here reads the clock.
import {MESSAGE_MAX_LENGTH} from './chat-input.mjs';
import {COPY} from './copy.mjs';
import {addDays, dayRange, localDay, weekStart} from './dates.mjs';
import {doneDaysByHabit, newestFirst, sourceOf} from './records.mjs';
import {SERVER_DEFAULT_TIMEZONE} from './timezone.mjs';

// The seven categories, in the order the page lists them.
export const CATEGORY_LABEL = Object.freeze({
  health: '健康',
  relationships: '人际关系',
  finance: '财务',
  career: '事业',
  interests: '兴趣爱好',
  productivity: '效率',
  other: '其他',
});

const labelOf = category => (Object.prototype.hasOwnProperty.call(CATEGORY_LABEL, category) ? CATEGORY_LABEL[category] : CATEGORY_LABEL.other);
const trimmed = value => (typeof value === 'string' ? value.trim() : '');

// cards      one per goal being tracked, in the order given:
//            {goalId, title, category, categoryLabel, startedDay, weekCount, habits, latest}
//            habits  [{habitId, name, last7: [{day, kind}]}]: the 7 days ending with `today`; kind is
//                    done (a record), before (the habit was not added yet), today (not done yet: the day is not over),
//                    or missed
//            weekCount  on how many days, from Monday to today, any habit of the goal was done
//            latest     the newest record of the goal's habits that has a note, {day, source: 'web' | 'agent', note}, or null.
//                       A tick with no note has nothing to say, so it is not the "latest".
// ungrouped  a card of the same shape (goalId null, titled 「还没归到目标的习惯」) for the habits whose goalId is absent or
//            names no goal in the list, or null when there are none.
// The habits of an archived goal are on no card.
// `tz` is the person's zone (profile.timezone): it decides on which day a goal or a habit was created. Left out, it is
// Beijing time, the zone every new account starts with.
export function goalsModel({goals = [], habits = [], completions = [], today = '', tz = SERVER_DEFAULT_TIMEZONE} = {}) {
  const doneDays = doneDaysByHabit(completions);
  const week = dayRange(weekStart(today), today);
  const lastSeven = dayRange(addDays(today, -6), today);
  const listed = new Set(goals.map(goal => goal.id));

  const dots = habit => {
    const days = doneDays.get(habit.id) || new Set(), begun = localDay(habit.createdAt, tz);
    return lastSeven.map(day => ({day, kind: days.has(day) ? 'done' : begun && day < begun ? 'before' : day === today ? 'today' : 'missed'}));
  };
  const card = (head, members) => {
    const ids = new Set(members.map(habit => habit.id));
    const newest = completions.filter(c => c && ids.has(c.habitId) && typeof c.date === 'string' && trimmed(c.note)).sort(newestFirst)[0];
    return {
      ...head,
      weekCount: week.filter(day => members.some(habit => (doneDays.get(habit.id) || new Set()).has(day))).length,
      habits: members.map(habit => ({habitId: habit.id, name: habit.name, last7: dots(habit)})),
      latest: newest ? {day: newest.date, source: sourceOf(newest), note: trimmed(newest.note)} : null,
    };
  };

  const cards = goals
    .filter(goal => goal.archived !== true)
    .map(goal => card(
      {goalId: goal.id, title: goal.title, category: goal.category, categoryLabel: labelOf(goal.category), startedDay: localDay(goal.createdAt, tz)},
      habits.filter(habit => habit.goalId === goal.id),
    ));
  const loose = habits.filter(habit => !habit.goalId || !listed.has(habit.goalId));
  return {cards, ungrouped: loose.length ? card({goalId: null, title: COPY.ungrouped, category: '', categoryLabel: '', startedDay: ''}, loose) : null};
}

// How much the box of a new goal takes. What the person writes goes to the chat with the starter in front
// (COPY.goalStarter, with the category's name), and the chat takes MESSAGE_MAX_LENGTH characters at most, so the box
// leaves room for the starter of the category that was picked.
export function goalWordsLimit(category) {
  return MESSAGE_MAX_LENGTH - COPY.goalStarter(labelOf(category), '').length;
}
