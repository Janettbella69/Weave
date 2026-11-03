// 记录 (records): the month calendar of one habit, its recent records, and which months can be turned to. This file also
// holds the small helpers on completions that the to-do and goals models use, so every page reads a record the same way.
//
// A completion, as the status answer has it: {id, habitId, date: 'YYYY-MM-DD', note, source: 'web' | 'agent', createdAt}.
// `date` is the person's own day. A record with no `source` is from before the web could record anything: Weave's.
import {addDays, localDay} from './dates.mjs';
import {SERVER_DEFAULT_TIMEZONE} from './timezone.mjs';

// /api/status sends the records of `today` and of the 61 days before it (hosted/lib/weave/api.mjs). A day before
// `addDays(today, -61)` may have records the page was not sent, so the page cannot say it was missed.
export const STATUS_WINDOW_BACK = 61;

// habit id -> the days that habit was done (a Set of 'YYYY-MM-DD').
export function doneDaysByHabit(completions) {
  const byHabit = new Map();
  for (const completion of completions || []) {
    if (!completion || typeof completion.date !== 'string') continue;
    if (!byHabit.has(completion.habitId)) byHabit.set(completion.habitId, new Set());
    byHabit.get(completion.habitId).add(completion.date);
  }
  return byHabit;
}

export const sourceOf = completion => (completion && completion.source === 'web' ? 'web' : 'agent');

// For sort(): the later day first; on the same day, the one written down later.
export function newestFirst(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const x = String(a.createdAt || ''), y = String(b.createdAt || '');
  return x === y ? 0 : x < y ? 1 : -1;
}

const MONTH = /^(\d{4})-(\d{2})$/;
const pad = n => String(n).padStart(2, '0');

// The calendar of `habit` for `month` ('2026-10'), Monday first, padded with empty cells to whole weeks.
//   cells  {label: '1'…, kind, day: 'YYYY-MM-DD'}, or {label: '', kind: 'empty', day: ''} for the padding
//   kind   done    there is a record for the day (also one logged for a day before the habit was added, or before the window)
//          before  the habit was not added yet (before the day it was created, in the person's zone)
//          unknown the habit existed, but the day is before the window the status answer covers (see STATUS_WINDOW_BACK):
//                  there may be a record the page was not sent, so it is neither done nor missed. The page shows it
//                  neutral; it is not in the legend.
//          future  the days after `today`, and today itself until it is done: the day is not over, so it is not a miss
//          missed  a day that is over, inside the window, with no record
//   stats  done = days done; elapsed = days done or missed; longest = the longest run of days done in a row;
//          doubleMisses = how many times two or more days in a row were missed (a run of three is one time).
//          Only done and missed days count; before, unknown and future days count for nothing and break a run.
// `tz` is the person's zone (profile.timezone): it decides on which day the habit was created. Left out, it is Beijing
// time, the zone every new account starts with.
export function monthModel({habit, completions = [], month, today = '', tz = SERVER_DEFAULT_TIMEZONE} = {}) {
  const match = MONTH.exec(month || '');
  const stats = {done: 0, elapsed: 0, longest: 0, doubleMisses: 0};
  if (!match || match[2] < '01' || match[2] > '12') return {cells: [], stats};
  const year = Number(match[1]), mon = Number(match[2]);
  const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, mon - 1, 1)).getUTCDay() + 6) % 7;
  const begun = habit ? localDay(habit.createdAt, tz) : '';
  const windowStart = addDays(today, -STATUS_WINDOW_BACK);   // '' when `today` is not a day
  const done = (habit && doneDaysByHabit(completions).get(habit.id)) || new Set();

  const padding = () => ({label: '', kind: 'empty', day: ''});
  const cells = Array.from({length: lead}, padding);
  for (let n = 1; n <= length; n++) {
    const day = month + '-' + pad(n);
    const kind = done.has(day) ? 'done'
      : begun && day < begun ? 'before'
      : windowStart && day < windowStart ? 'unknown'
      : day >= today ? 'future'
      : 'missed';
    cells.push({label: String(n), kind, day});
  }
  while (cells.length % 7) cells.push(padding());

  let run = 0, misses = 0;
  for (const {kind} of cells) {
    if (kind === 'done') { stats.done++; stats.elapsed++; stats.longest = Math.max(stats.longest, ++run); misses = 0; }
    else if (kind === 'missed') { stats.elapsed++; run = 0; if (++misses === 2) stats.doubleMisses++; }
    else { run = 0; misses = 0; }
  }
  return {cells, stats};
}

// The newest records of one habit, newest first: {day, source: 'web' | 'agent', note}. A tick with no note is a record
// too (its source is what the page shows), so `note` may be ''.
export function recentNotes({completions = [], habitId, limit = 3} = {}) {
  return completions
    .filter(completion => completion && completion.habitId === habitId && typeof completion.date === 'string')
    .sort(newestFirst)
    .slice(0, limit)
    .map(completion => ({day: completion.date, source: sourceOf(completion), note: typeof completion.note === 'string' ? completion.note : ''}));
}

// The months the page can turn to: from the month the status window starts in (the earliest day it has records for,
// see STATUS_WINDOW_BACK; the days of that month before the window are 'unknown' in monthModel) to the month of
// `today`. It depends on `today` alone, not on what has been recorded: a new habit does not shorten it, and the page
// can say 「更早的记录先看不了」 at its end. The other properties of the argument (the completions) are not needed.
export function monthBounds({today = ''} = {}) {
  const windowStart = addDays(today, -STATUS_WINDOW_BACK);
  return windowStart ? {earliest: windowStart.slice(0, 7), latest: today.slice(0, 7)} : {earliest: '', latest: ''};
}
