// 动态, the first tab of the assistant's home page and of the panel beside the chat: what Weave did on its own lately,
// from status.activity, newest first, a day at a time. Pure: the page passes in the zone and `today` (the person's own
// day, from the status answer); nothing here reads the clock.
//
// status.activity (block two; an older server sends none) is a list of
//   {id, at, kind: 'message', text}                          a message Weave sent on its own
//   {id, at, kind: 'reminder', text}                         a reminder that came at its time
//   {id, at, kind: 'check' | 'followup', outcome}            Weave looked in (定期看看) or came as it had said it would
//                                                            (跟进), and kept quiet: outcome 'quiet' or 'jev-quiet'
//   {id, at, kind: 'completion', habit, date}                a day of a habit Weave recorded from the chat
// `at` is when it happened (an ISO time).
import {COPY} from './copy.mjs';
import {addDays, formatTime, localDay, toMs} from './dates.mjs';
import {SERVER_DEFAULT_TIMEZONE} from './timezone.mjs';

// How far back the tab goes: today and the 13 days before it; and how many rows it shows at most.
export const ACTIVITY_DAYS = 14;
export const ACTIVITY_LIMIT = 50;

const QUIET = {quiet: COPY.activityQuiet, 'jev-quiet': COPY.activityJevQuiet};
const trimmed = value => (typeof value === 'string' ? value.trim() : '');

// The title and the grey line of one entry, or null for one the tab does not show: a kind it does not know, a look-in
// that did not end in keeping quiet (when Weave spoke, the message is an entry of its own), or one with nothing to say.
function wordsOf(item) {
  const text = trimmed(item.text);
  switch (item.kind) {
    case 'message': return text ? {title: COPY.activityMessage, detail: text} : null;
    case 'reminder': return text ? {title: text, detail: COPY.activityReminder} : null;
    case 'check': case 'followup':
      return Object.hasOwn(QUIET, item.outcome) ? {title: item.kind === 'check' ? COPY.activityCheck : COPY.activityFollowup, detail: QUIET[item.outcome]} : null;
    case 'completion': {
      const habit = trimmed(item.habit);
      return habit ? {title: COPY.activityCompletion(habit), detail: COPY.activityCompletionDetail} : null;
    }
    default: return null;
  }
}

// 今天, 昨天, or 11月1日 over the rows of a day.
function dayLabel(day, today) {
  if (day === today) return COPY.today;
  if (today && day === addDays(today, -1)) return COPY.yesterday;
  return COPY.activityDay(Number(day.slice(5, 7)), Number(day.slice(8, 10)));
}

// The tab: [{day, label, items: [{key, kind, title, detail, time, at}]}], the newest day first and the newest row first
// in each day. `day` is 'YYYY-MM-DD' in the person's zone; `time` is 「19:30」 there; `at` is the moment as an ISO time
// (for <time dateTime>). The rows are the last ACTIVITY_LIMIT entries of the last ACTIVITY_DAYS days; an entry whose
// time cannot be read is left out. Without `today` (an older server) every day is kept. `tz` is the person's zone
// (profile.timezone); left out, it is Beijing time, the zone every new account starts with.
export function activityDays({activity = [], tz = SERVER_DEFAULT_TIMEZONE, today = ''} = {}) {
  const first = today ? addDays(today, -(ACTIVITY_DAYS - 1)) : '';
  const rows = [];
  for (const item of Array.isArray(activity) ? activity : []) {
    if (!item || typeof item !== 'object') continue;
    const ms = toMs(item.at), day = localDay(ms, tz), words = Number.isFinite(ms) ? wordsOf(item) : null;
    if (!words || !day || (first && day < first)) continue;
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : String(ms);
    rows.push({ms, day, row: {key: item.kind + ':' + id, kind: item.kind, ...words, time: formatTime(ms, tz), at: new Date(ms).toISOString()}});
  }
  rows.sort((a, b) => b.ms - a.ms);
  const days = [];
  for (const {day, row} of rows.slice(0, ACTIVITY_LIMIT)) {
    if (!days.length || days[days.length - 1].day !== day) days.push({day, label: dayLabel(day, today), items: []});
    days[days.length - 1].items.push(row);
  }
  return days;
}
