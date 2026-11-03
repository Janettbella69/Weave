// Dates as the pages write them. A day is a 'YYYY-MM-DD' string in the person's own time zone (profile.timezone), the
// same form as `today` in the status answer; calendar arithmetic on it needs no zone. Nothing here reads the clock or
// the browser's zone: the page passes in the zone, the day and the time it wants to talk about. A function that takes a
// zone and is not given one uses Beijing time (the zone every new account starts with), never the machine's.
import {SERVER_DEFAULT_TIMEZONE, wallClockIn} from './timezone.mjs';

const DAY_MS = 86400000;
const WEEKDAY = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// A time as milliseconds: an ISO string, a number of milliseconds or a Date. NaN for anything else.
export function toMs(instant) {
  if (instant instanceof Date) return instant.getTime();
  if (typeof instant === 'number') return instant;
  return typeof instant === 'string' ? Date.parse(instant) : NaN;
}

// A calendar day as milliseconds at UTC midnight. NaN when `day` is not a real date ('2026-02-30' is not).
function dayMs(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const ms = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
}

// The day on the wall in `timeZone` at this moment; '' when there is no moment.
export function localDay(instant, timeZone = SERVER_DEFAULT_TIMEZONE) {
  const ms = toMs(instant);
  return Number.isFinite(ms) ? wallClockIn(ms, timeZone).slice(0, 10) : '';
}

export function addDays(day, n) {
  const ms = dayMs(day);
  return Number.isFinite(ms) ? new Date(ms + n * DAY_MS).toISOString().slice(0, 10) : '';
}

// The Monday of the week the day is in. Sunday is the last day of its week.
export function weekStart(day) {
  const ms = dayMs(day);
  return Number.isFinite(ms) ? addDays(day, -((new Date(ms).getUTCDay() + 6) % 7)) : '';
}

// Every day from `from` to `to`, both included. Nothing when either is not a day or `to` is before `from`.
export function dayRange(from, to) {
  const days = [];
  if (!Number.isFinite(dayMs(from)) || !Number.isFinite(dayMs(to))) return days;
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

const MONTH = /^(\d{4})-(\d{2})$/;

// The year and month of a month as 'YYYY-MM' ('2026-10'); null when it is not a month.
function monthParts(month) {
  const match = MONTH.exec(typeof month === 'string' ? month : '');
  if (!match) return null;
  const year = Number(match[1]), number = Number(match[2]);
  return number >= 1 && number <= 12 ? {year, number} : null;
}

// The month `n` months on from `month` ('2026-10', -1 -> '2026-09'); '' when `month` is not a month.
export function addMonths(month, n) {
  const parts = monthParts(month);
  if (!parts) return '';
  const index = parts.year * 12 + parts.number - 1 + n;
  return String(Math.floor(index / 12)).padStart(4, '0') + '-' + String((index % 12 + 12) % 12 + 1).padStart(2, '0');
}

// '2026 年 10 月': the month over the records calendar (v3-Records).
export function formatMonth(month) {
  const parts = monthParts(month);
  return parts ? parts.year + ' 年 ' + parts.number + ' 月' : '';
}

// '11 月 2 日'
export function formatDay(day) {
  const ms = dayMs(day);
  return Number.isFinite(ms) ? new Date(ms).getUTCMonth() + 1 + ' 月 ' + new Date(ms).getUTCDate() + ' 日' : '';
}

// '11 月 2 日 · 星期一'; the phone boards write the weekday short: '11 月 2 日 · 周一'.
export function formatHeader(day, {short = false} = {}) {
  const ms = dayMs(day);
  return Number.isFinite(ms) ? formatDay(day) + ' · ' + (short ? WEEKDAY_SHORT : WEEKDAY)[new Date(ms).getUTCDay()] : '';
}

// '11 月 2 日 · 周一': the date in the phone's top bar (v3-Mobile, v3-GoalsMobile).
export const formatHeaderShort = day => formatHeader(day, {short: true});

// '19:30'
export function formatTime(instant, timeZone = SERVER_DEFAULT_TIMEZONE) {
  const ms = toMs(instant);
  return Number.isFinite(ms) ? wallClockIn(ms, timeZone).slice(11, 16) : '';
}

// When something is due, next to `today` (the person's day): '今天 20:00', '明天 20:00' or '11 月 4 日 20:00'.
export function formatDue(instant, timeZone = SERVER_DEFAULT_TIMEZONE, today) {
  const day = localDay(instant, timeZone);
  if (!day) return '';
  return (day === today ? '今天' : day === addDays(today, 1) ? '明天' : formatDay(day)) + ' ' + formatTime(instant, timeZone);
}
