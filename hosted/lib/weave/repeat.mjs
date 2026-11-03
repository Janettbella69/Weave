// 重复的提醒和跟进下一次在什么时候（docs/superpowers/specs/2026-11-03-proactive-wake-design.md 第 4.8 节）。
// 按当地钟点重复：「每天 8 点」就是这个人所在时区的 8 点，夏令时前后都不漂。每月按几号重复，那个月没有这一天就用月底。
// 纯函数，不碰数据库，没有别的依赖。
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STEP_DAYS = {daily: 1, weekly: 7};

// 某个时刻在某个时区的当地年月日、时分秒、星期（0 是星期日）。
export function localParts(ms, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

const two = n => String(n).padStart(2, '0');
export const localHHMM = (ms, timezone) => { const p = localParts(ms, timezone); return `${two(p.hour)}:${two(p.minute)}`; };

// 当地时间比 UTC 快多少毫秒。
function offsetAt(ms, timezone) {
  const p = localParts(ms, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// 当地的某年某月某日几点几分是哪个时刻（UTC 毫秒）。夏令时跳过的那一段（不存在的钟点）挪到跳过之后；
// 重复的那一段取其中一个。
export function zonedTime({year, month, day, hour, minute}, timezone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetAt(wall, timezone);
  const second = wall - offsetAt(first, timezone);
  return first === second ? first : Math.max(first, second);
}

export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// 一条重复规则 {repeat, localTime: 'HH:MM', anchorDay} 在 fromMs 那一次之后的下一次。
export function following({repeat, localTime, anchorDay}, fromMs, timezone) {
  const [hour, minute] = localTime.split(':').map(Number);
  const p = localParts(fromMs, timezone);
  if (Object.hasOwn(STEP_DAYS, repeat)) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + STEP_DAYS[repeat]));
    return zonedTime({year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute}, timezone);
  }
  if (repeat === 'monthly') {
    const year = p.month === 12 ? p.year + 1 : p.year, month = p.month === 12 ? 1 : p.month + 1;
    return zonedTime({year, month, day: Math.min(anchorDay, daysInMonth(year, month)), hour, minute}, timezone);
  }
  return null;
}

// 从 startMs 那一次往后数，第一个晚于 afterMs 的时刻。服务器停了几天也只往后跳，不补中间漏掉的。
// 不重复的规则返回 null。
export function nextAfter(rule, startMs, afterMs, timezone) {
  let at = startMs;
  for (let step = 0; at <= afterMs; step++) {
    if (step > 5000) return null;
    at = following(rule, at, timezone);
    if (at === null) return null;
  }
  return at;
}
