// Times in the workspace are all in the account's time zone (profile.timezone): what the pages show, and what the
// Agent and quiet hours use on the server. That zone is Beijing time until the person picks another one in settings;
// the browser's own zone is never taken over on its own.

// The zone every new account starts with (hosted/lib/weave/domain.mjs, ensurePerson).
export const SERVER_DEFAULT_TIMEZONE = 'Asia/Shanghai';

export function isValidTimezone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try { new Intl.DateTimeFormat('en-US', {timeZone}).format(); return true; } catch { return false; }
}

export function deviceTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

// "2026-11-02T09:30" as seen on a wall clock in `timeZone`, for the given instant. This is the format of <input type="datetime-local">.
export function wallClockIn(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// How far the wall clock in `timeZone` is ahead of UTC at this instant, in milliseconds.
function offsetAt(instantMs, timeZone) {
  const wall = Date.parse(wallClockIn(instantMs, timeZone) + ':00Z');
  return wall - Math.floor(instantMs / 60000) * 60000;
}

// The instant at which a wall clock in `timeZone` shows `local` ("2026-11-02T09:30"). Null when `local` is not a time.
export function instantFromWallClock(local, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(local))) return null;
  const asUtc = Date.parse(String(local).slice(0, 16) + ':00Z');
  if (!Number.isFinite(asUtc)) return null;
  let guess = asUtc - offsetAt(asUtc, timeZone);
  guess = asUtc - offsetAt(guess, timeZone);   // a second pass settles the hours around a clock change
  return new Date(guess);
}
