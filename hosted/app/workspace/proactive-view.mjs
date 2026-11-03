// 助理主页「提醒」栏 (docs/superpowers/specs/2026-11-03-proactive-wake-design.md, sections 4.2, 4.8 and 4.9): what the
// tab shows, worked out from the status answer. Pure: the page passes in `now`, the zone and `today` (the person's own
// day, from the status answer); nothing here reads the clock.
//
// The status answer brings, besides the one-off reminders it always had (`reminders`):
//   schedules  [{id, kind: 'reminder' | 'wake', text, repeat: 'none' | 'daily' | 'weekly' | 'monthly', nextAt, status,
//              origin, lastRunAt, lastOutcome}]: the repeating reminders and Weave's own follow-ups (跟进), the live ones
//              and the last ones that ended. nextAt is a UTC ISO time.
//   proactive  {level, activeStart, activeEnd, timezone, checkTimes, messageCap, sentToday, wakeCap, wakesToday,
//              quietReason}: how often Weave comes on its own, and why it is not looking in right now.
// An older server sends neither: the tab is then the one-off reminders and three empty groups, with no dial.
import {COPY} from './copy.mjs';
import {formatDue, formatTime, localDay, toMs} from './dates.mjs';
import {SERVER_DEFAULT_TIMEZONE} from './timezone.mjs';
import {upcomingReminders} from './todo.mjs';

// The levels, quietest first (section 4.2).
export const LEVELS = Object.freeze(['off', 'low', 'normal', 'high']);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const QUIET = {ignored: COPY.quietIgnored, inactive: COPY.quietInactive};
const live = schedule => schedule.status === 'scheduled' || schedule.status === 'paused';

// What the three buttons do from a level: 多找我一点 goes one step up (from off to low), 少找我一点 one step down but not
// below low, 别主动找我 straight to off. A button that would change nothing cannot be pressed.
//   -> {can: {more, less, stop}, next: {more, less}}   next: the level the button asks for, or null
export function levelSteps(level) {
  const at = LEVELS.indexOf(level);
  const more = at >= 0 && at < LEVELS.length - 1 ? LEVELS[at + 1] : null;
  const less = at >= 2 ? LEVELS[at - 1] : null;
  return {can: {more: !!more, less: !!less, stop: at > 0}, next: {more, less}};
}

// The status answer's `proactive`, or null when there is nothing to go by: an older server, or a level this page does
// not know.
const settingsOf = proactive => (proactive && typeof proactive === 'object' && LEVELS.includes(proactive.level) ? proactive : null);
const checkTimesOf = settings => (Array.isArray(settings.checkTimes) ? settings.checkTimes.filter(time => CLOCK.test(time)) : []);

// The block at the top, or null without settings: {level, line, quietHours, can, next} (levelSteps for the last two)
//   line        「现在不主动找你。…」 when Weave is off, otherwise 「每天看 2 次你的进展，最多主动说 2 句。」
//   quietHours  「21:00–09:00 不打扰。」 while Weave may come on its own; null when it is off, or when the hours it may
//               come are the whole day
function dialOf(settings) {
  if (!settings) return null;
  const on = settings.level !== 'off', {activeStart: start, activeEnd: end} = settings;
  const line = !on ? COPY.levelOff : Number.isFinite(settings.messageCap) ? COPY.levelLine(checkTimesOf(settings).length, settings.messageCap) : '';
  const quiet = on && CLOCK.test(start) && CLOCK.test(end) && start !== end;
  return {level: settings.level, line, quietHours: quiet ? COPY.quietHours(start, end) : null, ...levelSteps(settings.level)};
}

// Why Weave is not looking in right now, when it otherwise would: it was not answered twice, or the person has not
// been here for a week. Nothing while it is off: speaking again would not bring it back.
const noticeOf = settings => (settings && settings.level !== 'off' && Object.hasOwn(QUIET, settings.quietReason) ? QUIET[settings.quietReason] : null);

const isSchedule = item => !!item && typeof item === 'object' && typeof item.id === 'string' && (item.kind === 'reminder' || item.kind === 'wake') && typeof item.text === 'string';
const scheduleKey = id => 'schedule:' + id;

// A row of the tab: {key, id, kind, title, meta, paused, canPause, removeAction}
//   key           one per row on the tab: 'reminder:<id>' (a one-off reminder), 'schedule:<id>', or 'check'
//   kind          'once-reminder' (from `reminders`), 'reminder' (a repeating one), 'wake' (a follow-up), 'check'
//   meta          when it comes, and what happens then: 「明天 20:00 · 到时候 Weave 会提醒你」, 「每周三 19:30 · Weave 会来
//                 问问」; a paused row says 「19:30 · 已暂停」 instead
//   canPause      a repeating row can be paused and resumed (POST schedules/pause)
//   removeAction  what deletes it: 'reminders/cancel' for a one-off reminder, 'schedules/cancel' for the rest, null for
//                 the check, which the dial controls
function scheduleRow(schedule, when, repeating) {
  const paused = repeating && schedule.status === 'paused';
  const meta = paused ? when + ' · ' + COPY.paused : schedule.kind === 'wake' ? COPY.wakeMeta(when) : when + ' · ' + COPY.remindNote;
  return {key: scheduleKey(schedule.id), id: schedule.id, kind: schedule.kind, title: schedule.text, meta, paused, canPause: repeating, removeAction: 'schedules/cancel'};
}

// When a repeating row comes round, in the person's zone, from its next time: the time of day, 每周三 19:30 or 每月 3 号
// 08:00; with the key it is sorted by (the weekday from Monday, or the day of the month, then the time). Null when the
// time cannot be read. A monthly row says the day it was set for (anchorDay): one set for the 31st says 每月 31 号 also when
// its next time falls on the 30th of a shorter month.
function repeatingWhen(repeat, nextAt, tz, anchorDay) {
  const day = localDay(nextAt, tz), time = formatTime(nextAt, tz);
  if (!day) return null;
  if (repeat === 'daily') return {when: time, order: time};
  if (repeat === 'weekly') {
    const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
    return {when: COPY.weeklyAt(weekday, time), order: (weekday + 6) % 7 + ' ' + time};
  }
  const date = Number.isInteger(anchorDay) && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : Number(day.slice(8, 10));
  return {when: COPY.monthlyAt(date, time), order: String(date).padStart(2, '0') + ' ' + time};
}

// The tab: {dial, notice, once, daily, weekly, monthly}
//   dial     dialOf above, or null (an older server)
//   notice   why Weave is not looking in right now, or null
//   once     the one-off reminders still to come (upcomingReminders, as 待办 lists them) and Weave's one-off follow-ups
//            still to come, soonest first
//   daily, weekly, monthly
//            the repeating reminders and follow-ups that are running or paused, by the time they come round. 每天 starts
//            with one row for Weave's own look at the day while it is not off and has times for it.
// A row whose time cannot be read is left out, as upcomingReminders leaves out such a reminder; so is anything that is
// not a reminder or a follow-up, or repeats in some other way. `tz` is the person's zone (profile.timezone); left out,
// it is Beijing time, the zone every new account starts with.
export function reminderGroups({reminders = [], schedules = [], proactive = null, now, tz = SERVER_DEFAULT_TIMEZONE, today = ''} = {}) {
  const settings = settingsOf(proactive);
  const list = (Array.isArray(schedules) ? schedules : []).filter(isSchedule);
  const nowMs = toMs(now);

  const once = [
    ...upcomingReminders({reminders: Array.isArray(reminders) ? reminders : [], now}).map(item => ({at: toMs(item.dueAt), row: {
      key: 'reminder:' + item.reminderId, id: item.reminderId, kind: 'once-reminder', title: item.title,
      meta: [formatDue(item.dueAt, tz, today), COPY.remindNote].filter(Boolean).join(' · '), paused: false, canPause: false, removeAction: 'reminders/cancel',
    }})),
    ...list.filter(item => item.repeat === 'none' && item.status === 'scheduled' && toMs(item.nextAt) > nowMs)
      .map(item => ({at: toMs(item.nextAt), row: scheduleRow(item, formatDue(item.nextAt, tz, today), false)})),
  ].sort((a, b) => a.at - b.at).map(entry => entry.row);

  const repeating = repeat => list
    .filter(item => item.repeat === repeat && live(item))
    .map(item => ({item, at: repeatingWhen(repeat, item.nextAt, tz, item.anchorDay)}))
    .filter(entry => entry.at)
    .sort((a, b) => (a.at.order < b.at.order ? -1 : a.at.order > b.at.order ? 1 : 0))
    .map(entry => scheduleRow(entry.item, entry.at.when, true));
  const daily = repeating('daily');
  const checks = settings && settings.level !== 'off' ? checkTimesOf(settings) : [];
  if (checks.length) daily.unshift({key: 'check', id: null, kind: 'check', title: COPY.checkTitle, meta: COPY.checkMeta(checks), paused: false, canPause: false, removeAction: null});

  return {dial: dialOf(settings), notice: noticeOf(settings), once, daily, weekly: repeating('weekly'), monthly: repeating('monthly')};
}

// The tab's changes that the status answer may not show yet, kept the way todo-checks.mjs keeps 待办's ticks:
//   presses  {[key]: {value, finished, seen, answer}}, key LEVEL_KEY (the dial) or a row's key (paused or resumed)
//   value     the level asked for; for a row, true (paused) or false (running again)
//   finished  its request came back. A request that failed is not kept: the page drops its press, and what it changed
//             goes back.
//   seen      the status answers that arrived since it came back. The first may have been asked for before the change;
//             the second was asked for after it, so from then on the server's answer is the one shown.
//   answer    what the request answered: for the level, {proactive}, the settings that go with the new level
// The page may keep more in a press (which click it belongs to); it is carried along.
export const LEVEL_KEY = 'level';

// The status as the tab shows it, with the changes on their way:
//   schedules  a row paused or resumed shows so at once
//   proactive  the settings the level request answered, once it has, until the status has caught up
//   busy       a level change is on its way and its answer is not in yet: the three buttons wait for it, so that the
//              next press starts from the new level and not the old one
export function withPresses({schedules, proactive} = {}, presses = {}) {
  const level = presses[LEVEL_KEY];
  const answered = level && level.finished && level.answer ? settingsOf(level.answer.proactive) : null;
  return {
    schedules: (Array.isArray(schedules) ? schedules : []).map(item => {
      const press = isSchedule(item) && live(item) ? presses[scheduleKey(item.id)] : undefined;
      return press ? {...item, status: press.value ? 'paused' : 'scheduled'} : item;
    }),
    proactive: answered || proactive,
    busy: !!level && !answered,
  };
}

// The changes that still matter after a new status answer (call it once per answer). One goes once it has come back
// and the answer shows the same, once two answers have come since it came back, or when what it changed is no longer
// there (the row ended, or the server sends no settings). Returns `presses` itself when nothing changed.
export function settlePresses(presses, {schedules, proactive} = {}) {
  const server = new Map();
  const settings = settingsOf(proactive);
  if (settings) server.set(LEVEL_KEY, settings.level);
  for (const item of Array.isArray(schedules) ? schedules : []) if (isSchedule(item) && live(item)) server.set(scheduleKey(item.id), item.status === 'paused');
  let changed = false;
  const kept = {};
  for (const [key, press] of Object.entries(presses)) {
    const now = server.get(key), seen = press.finished ? press.seen + 1 : press.seen;
    if (now === undefined || (press.finished && (now === press.value || seen >= 2))) { changed = true; continue; }
    if (seen !== press.seen) changed = true;
    kept[key] = seen === press.seen ? press : {...press, seen};
  }
  return changed ? kept : presses;
}
