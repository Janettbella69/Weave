// 聊天 (chat): how the message list is laid out. Pure: the page passes in the zone and `today`. Without a zone, Beijing
// time (the zone every new account starts with), never the machine's.
import {COPY} from './copy.mjs';
import {addDays, formatDay, formatTime, localDay} from './dates.mjs';
import {SERVER_DEFAULT_TIMEZONE} from './timezone.mjs';

// The messages with a day label before the first message of each day: 今天, 昨天, or the date.
// -> [{kind: 'separator', label} | {kind: 'message', message}, ...]
// A message that is not stored yet (the one just sent, and the thinking bubble) has no time: it is from now, today.
export function withSeparators(messages, tz = SERVER_DEFAULT_TIMEZONE, today) {
  const yesterday = addDays(today, -1);
  const items = [];
  let current = '';
  for (const message of messages || []) {
    const stored = message.createdAt === undefined || message.createdAt === null ? today : localDay(message.createdAt, tz);
    const day = stored || current || today;
    if (day !== current) {
      items.push({kind: 'separator', label: day === today ? COPY.today : day === yesterday ? COPY.yesterday : formatDay(day)});
      current = day;
    }
    items.push({kind: 'message', message});
  }
  return items;
}

// A message Weave sent on its own, not as the answer to something: it says so, or it comes from the background judge.
export const isProactive = message => !!message && (message.proactive === true || message.source === 'hermes');

// 「19:30 · Weave 主动来问」: when it was sent, in the person's zone.
export const proactiveLabel = (message, tz = SERVER_DEFAULT_TIMEZONE) => COPY.proactive(formatTime(message.createdAt, tz));
