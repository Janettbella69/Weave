// 设置 (settings): the choices and the answers the page works out. Pure: the page passes in the clock.
import {COPY} from './copy.mjs';
import {isValidTimezone} from './timezone.mjs';

// The choices of 所在地时间: the six zones of COPY.zones, in their order, and the account's own zone once more at the
// end when it is none of them (an account that was moved to another zone before this page existed). That zone has no
// name on the boards, so it is shown as it is stored, e.g. 'Europe/Berlin'. A zone that is not a real one is left out.
export function zoneOptions(current, zones = COPY.zones) {
  const options = zones.map(({value, label}) => ({value, label}));
  if (isValidTimezone(current) && !options.some(option => option.value === current)) options.push({value: current, label: current});
  return options;
}

// What POST /api/profile is sent when a zone is picked. The endpoint replaces the whole profile, so this is all of it,
// as the old settings form sent it: the zone that was picked (the person's choice, never the browser's zone), and only
// the free times still to come (the server refuses a time that has passed), written as the server keeps them.
// `now` is in milliseconds.
export function profileForSave(profile, {timezone, now}) {
  const slots = (Array.isArray(profile.slots) ? profile.slots : []).filter(slot => Date.parse(slot) > now).map(slot => new Date(slot).toISOString());
  return {...profile, timezone, slots};
}

// A WeChat binding code lives 15 minutes (POST wechat/bind answers {code, expiresAt}, expiresAt in milliseconds).
export const BIND_CODE_LIFETIME = 15 * 60 * 1000;

// How long the code stays on screen from `now`, in milliseconds: until it expires, never longer than a code lives. When
// the browser's clock is ahead of the server's by more than that (or there is no expiry), the code still gets its life.
export function bindCodeTimeout(expiresAt, now) {
  const left = (typeof expiresAt === 'number' ? expiresAt : NaN) - now;
  return Number.isFinite(left) && left > 0 ? Math.min(left, BIND_CODE_LIFETIME) : BIND_CODE_LIFETIME;
}
