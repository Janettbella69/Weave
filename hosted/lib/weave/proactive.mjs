// Weave 主动找人（docs/superpowers/specs/2026-11-03-proactive-wake-design.md）。
// 三种：她让设的重复提醒（原样发一句，不叫醒模型）、Weave 自己排的跟进、按档位的定期看看。
// 这里的代码只判断「到点了、该不该花这次钱叫醒 Agent」：教材 p.20 代码合法的位置「Agent 启动之前 预处理」
// 和「基础设施 网关、计费、鉴权」。醒了说不说、说什么由 Agent 决定（Skill proactive-judgment），
// 只有调用 send_message 才发得出去（docs/ARCHITECTURE.md 第 2 节）。
import {withWorld} from './store.mjs';
import {fail, record, notify} from './domain.mjs';
import {activeNow, localClock, proactiveState} from './proactivity.mjs';
import {wake, localISO, START_BY_MS, TICK_BUDGET_MS} from './dispatcher.mjs';
import {localParts, localHHMM, nextAfter} from './repeat.mjs';
import {askJev} from './jev.mjs';

export const LEVELS = ['off', 'low', 'normal', 'high'];
export const DEFAULT_LEVEL = 'normal';
// 草稿数字，待她定（设计稿第 4.2 节、附录 B）：每天定期看看几次、最多主动说几句、最多后台醒几次。
const LIMITS = {
  off: {checks: 0, messages: 0, wakes: 0},
  low: {checks: 1, messages: 1, wakes: 2},
  normal: {checks: 2, messages: 2, wakes: 4},
  high: {checks: 4, messages: 4, wakes: 8},
};
export const limitsFor = level => LIMITS[LEVELS.includes(level) ? level : DEFAULT_LEVEL];

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const GRACE_MS = 2 * HOUR;           // 晚了这么久（服务器停过）就不补了
const LEASE_MS = 15 * MINUTE;        // 一轮后台醒来最多占这么久，过了还没回来就当结果不确定
const MAX_AHEAD_MS = 30 * DAY;       // 跟进最远排多久
const IGNORED_AFTER = 2;             // 连着几句主动消息没回，就先不定期看看
const INACTIVE_MS = 7 * DAY;         // 多久没来，就先不定期看看
const MAX_ACTIVE_WAKES = 10, MAX_ACTIVE = 30, KEEP_FINISHED = 50, LOG_SIZE = 30;
export const MAX_WAKES_PER_TICK = 2;
const MAX_CLAIMS_PER_TICK = 6;       // 含 Jev 判断不用打扰、没叫醒模型的那些
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const REPEATS = {reminder: ['daily', 'weekly', 'monthly'], wake: ['none', 'daily', 'weekly']};

// 草稿文案，待确认（设计稿附录 A-4）：规则不允许时的原因，工具后端原样给模型，网页原样给人看。
export const TEXT = {
  noteLength: '跟进的备忘要 1–200 字。',
  reminderLength: '提醒内容要 1–500 字。',
  badTime: '时间要写成带时区的 ISO 格式，并且在将来，比如 2026-11-04T19:30:00+08:00。',
  tooFar: '跟进最远只能排到 30 天以后。',
  quietAt: (start, end) => `这个时间在对方的安静时段（${end}–${start}）里，换一个 ${start}–${end} 之间的时间。`,
  tooManyWakes: '已经排了 10 条跟进，先取消用不着的再排。',
  tooMany: '排期已经有 30 条了，先取消用不着的再排。',
  badRepeat: kind => kind === 'wake' ? 'repeat 只能是 none、daily 或 weekly。' : 'repeat 只能是 none、daily、weekly 或 monthly。',
  notFound: '没有这条安排，或者它已经结束了。',
  badLevel: 'level 只能是 off、low、normal 或 high。',
  pauseOnlyRepeat: '只有重复的安排能暂停。',
};

// 草稿文案，待确认（设计稿附录 A-3）：后台叫醒时写进 <trigger> 的话。
export const TRIGGER_TEXT = {
  timer: (note, sent, cap) => `你之前排的跟进到点了：${note}\n今天已经主动说了 ${sent} 句，最多 ${cap} 句。`,
  check: (n, total, sent, cap) => `定期看看对方的进展（今天第 ${n} 次，共 ${total} 次）。\n今天已经主动说了 ${sent} 句，最多 ${cap} 句。`,
};

const iso = ms => new Date(ms).toISOString();
const toMinutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = minutes => { const m = ((Math.round(minutes) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const ruleOf = s => ({repeat: s.repeat, localTime: s.localTime, anchorDay: s.anchorDay});

// 这个人的主动状态。计数按本人的当地日期，换日清零。
export function proactiveOf(person, now) {
  const p = person.proactive ??= {level: DEFAULT_LEVEL};
  if (!LEVELS.includes(p.level)) p.level = DEFAULT_LEVEL;
  const day = localClock(person, now).day;
  if (p.day !== day) Object.assign(p, {day, sent: 0, wakes: 0, checksDone: []});
  p.running ??= null;
  p.log ??= [];
  return p;
}
export const schedulesOf = person => person.schedules ??= [];
const isActive = s => s.status === 'scheduled' || s.status === 'paused';

// 定期看看的时间点（本人当地时间）。跟着允许打扰的时段走：早上那次 = 开始后 1 小时，晚上那次 = 结束前 1.5 小时，
// 四次的话中间两次平均分，取到半点。时段太短（3 小时以内）就都放在中间。
export function checkTimes(person, level) {
  const n = limitsFor(level).checks;
  if (!n) return [];
  const {activeStart, activeEnd} = proactiveState(person);
  const start = toMinutes(activeStart), span = ((toMinutes(activeEnd) - start) + 1440) % 1440 || 1440;
  const roomy = span > 180, evening = roomy ? start + span - 90 : start + span / 2, morning = roomy ? start + 60 : evening;
  if (n === 1) return [toHHMM(evening)];
  if (n === 2) return [...new Set([toHHMM(morning), toHHMM(evening)])];
  const gap = (evening - morning) / 3, half = m => Math.round(m / 30) * 30;
  return [...new Set([morning, half(morning + gap), half(morning + 2 * gap), evening].map(toHHMM))];
}

// 她最后一次自己动手：在聊天里说话（网页或微信），或者在网页上打勾。
function lastOwnActivity(person) {
  let at = 0;
  for (const m of person.messages || []) if (m.role === 'user') at = Math.max(at, Date.parse(m.createdAt) || 0);
  for (const c of person.completions || []) if (c.source !== 'agent') at = Math.max(at, Date.parse(c.createdAt) || 0);
  return at;
}

// 为什么现在不做定期看看：'ignored'（连着两句主动消息没回）、'inactive'（7 天没来），都不是就 null。
export function quietReason(person, now) {
  const since = lastOwnActivity(person);
  const unanswered = (person.messages || []).filter(m => m.proactive === true && (Date.parse(m.createdAt) || 0) > since).length;
  if (unanswered >= IGNORED_AFTER) return 'ignored';
  if (!since || now - since > INACTIVE_MS) return 'inactive';
  return null;
}

// 新排一条：kind 'reminder'（重复的提醒，只响一次的仍在 person.reminders）或 'wake'（Weave 自己的跟进）。
// origin：'chat'（她在聊天里时排的）、'background'（后台那一轮排的）、'web'。
export function addSchedule(person, {kind, text, at, repeat = 'none', origin}, now) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (kind === 'wake' ? !body || body.length > 200 : !body || body.length > 500) fail(kind === 'wake' ? TEXT.noteLength : TEXT.reminderLength);
  if (!REPEATS[kind]?.includes(repeat)) fail(TEXT.badRepeat(kind));
  const atMs = typeof at === 'string' && ISO.test(at) ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs) || atMs <= now) fail(TEXT.badTime);
  const list = schedulesOf(person), active = list.filter(isActive);
  if (kind === 'wake') {
    if (atMs - now > MAX_AHEAD_MS) fail(TEXT.tooFar);
    if (!activeNow(person, atMs)) { const {activeStart, activeEnd} = proactiveState(person); fail(TEXT.quietAt(activeStart, activeEnd)); }
    if (active.filter(s => s.kind === 'wake').length >= MAX_ACTIVE_WAKES) fail(TEXT.tooManyWakes);
  }
  if (active.length >= MAX_ACTIVE) fail(TEXT.tooMany);
  const timezone = person.profile.timezone;
  const item = {
    id: crypto.randomUUID(), kind, text: body, repeat, nextAt: iso(atMs), localTime: localHHMM(atMs, timezone), anchorDay: localParts(atMs, timezone).day,
    status: 'scheduled', origin, createdAt: iso(now), lastRunAt: null, lastOutcome: null,
  };
  list.push(item);
  // 结束了的只留最近 50 条。
  const finished = list.filter(s => !isActive(s));
  if (finished.length > KEEP_FINISHED) {
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED));
    person.schedules = list.filter(s => !drop.has(s));
  }
  return item;
}

// 取消一条：跟进、重复提醒，或者 person.reminders 里只响一次的提醒。返回 {schedule_id, table}。
export function cancelSchedule(person, id) {
  const s = typeof id === 'string' ? schedulesOf(person).find(x => x.id === id && isActive(x)) : null;
  if (s) { s.status = 'cancelled'; return {schedule_id: s.id, table: 'schedules'}; }
  const r = typeof id === 'string' ? (person.reminders || []).find(x => x.id === id && x.status === 'scheduled') : null;
  if (r) { r.status = 'cancelled'; return {schedule_id: r.id, table: 'reminders'}; }
  fail(TEXT.notFound, 404);
}

// 暂停或恢复一条重复的安排。恢复时排到下一个还没过的时间。
export function pauseSchedule(person, id, paused, now) {
  const s = typeof id === 'string' ? schedulesOf(person).find(x => x.id === id && isActive(x)) : null;
  if (!s) fail(TEXT.notFound, 404);
  if (s.repeat === 'none') fail(TEXT.pauseOnlyRepeat);
  if (paused === true) s.status = 'paused';
  else if (paused === false) {
    s.status = 'scheduled';
    const at = Date.parse(s.nextAt);
    if (at <= now) s.nextAt = iso(nextAfter(ruleOf(s), at, now, person.profile.timezone));
  } else fail(TEXT.pauseOnlyRepeat);
  return s;
}

// 改档位。返回给工具和网页的都是这一份。
export function setLevel(person, level, now) {
  if (!LEVELS.includes(level)) fail(TEXT.badLevel);
  proactiveOf(person, now).level = level;
  return {level, check_times: checkTimes(person, level).join(','), message_cap: limitsFor(level).messages, wake_cap: limitsFor(level).wakes};
}

// 这一次跑完（或跳过）以后：一次性的结束，重复的排到下一个还没过的时间。
function settle(person, s, outcome, now) {
  s.lastOutcome = outcome;
  if (s.repeat === 'none') { s.status = outcome === 'missed' ? 'missed' : 'done'; return; }
  const next = nextAfter(ruleOf(s), Date.parse(s.nextAt), now, person.profile.timezone);
  if (next === null) s.status = 'done'; else s.nextAt = iso(next);
}

// 到点的重复提醒：原样发「提醒你：…」到聊天和网页通知，不叫醒模型。微信由 scheduler.mjs 按 unsent 排队。
// 晚了 2 小时以上（服务器停过）就不补这一次。只响一次的提醒仍由 domain.deliverReminders 管。
export function deliverRoutines(world, now) {
  let count = 0;
  for (const person of Object.values(world.people || {})) {
    for (const s of person.schedules || []) {
      if (s.kind !== 'reminder' || s.status !== 'scheduled' || Date.parse(s.nextAt) > now) continue;
      if (now - Date.parse(s.nextAt) <= GRACE_MS) {
        record(person, '提醒你：' + s.text, {scheduleId: s.id});
        notify(world, person.id, '提醒你：' + s.text);
        s.unsent = true;
        s.lastRunAt = iso(now);
        settle(person, s, 'sent', now);
        count++;
      } else settle(person, s, 'missed', now);
    }
  }
  return count;
}

// 现在该不该叫醒这个人的 Agent，该的话占住（租约）并返回要叫醒的内容。在 withWorld 里调用：两个 tick 同时跑时，
// 只有先提交的那个占得到，后一个重读后看到 running 就跳过。
function claimFor(person, now) {
  const p = proactiveOf(person, now);
  if (p.running && now - p.running.since > LEASE_MS) {
    // 上一轮没回来：可能已经说过话，不重跑，记成结果不确定。
    const s = p.running.scheduleId ? schedulesOf(person).find(x => x.id === p.running.scheduleId) : null;
    if (s && isActive(s)) settle(person, s, 'uncertain', now);
    log(p, {at: now, kind: p.running.kind, scheduleId: p.running.scheduleId, outcome: 'uncertain', spoke: null});
    p.running = null;
  }
  if (p.running) return null;
  const limits = limitsFor(p.level), reason = quietReason(person, now), list = schedulesOf(person);
  const due = list.filter(s => s.kind === 'wake' && s.status === 'scheduled' && Date.parse(s.nextAt) <= now).sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt));
  // 关掉了：到点的跟进不跑，直接往后排（一次性的结束），免得以后打开时一起涌出来。
  if (p.level === 'off') { for (const s of due) settle(person, s, 'off', now); return null; }
  // 不在允许时段：先不动，到了时段再看（晚太久的那时会记成 missed）。
  if (!activeNow(person, now)) return null;
  const begin = (kind, s, text, check) => {
    p.running = {kind, scheduleId: s?.id ?? null, since: now, sentBefore: p.sent};
    p.wakes++;
    if (s) s.lastRunAt = iso(now);
    return {
      ownerId: person.id, kind, scheduleId: s?.id ?? null, since: now, channel: person.settings?.wechatWxidHash ? 'wechat' : 'web', text,
      jevState: jevStateFor(person, p, {kind, note: s?.text, check}, now),
    };
  };
  for (const s of due) {
    if (now - Date.parse(s.nextAt) > GRACE_MS) { settle(person, s, 'missed', now); continue; }
    // 被忽略了：后台那一轮自己排的跟进先不跑；她在聊天里时排的照跑。
    if (reason === 'ignored' && s.origin === 'background') { settle(person, s, 'ignored', now); continue; }
    if (p.wakes >= limits.wakes) { settle(person, s, 'cap', now); continue; }
    return begin('timer', s, TRIGGER_TEXT.timer(s.text, p.sent, limits.messages));
  }
  if (reason) return null;
  // 定期看看：今天还没做过、时间到了、晚了不到 2 小时的那个点；漏了几个只补最近的一个。
  const times = checkTimes(person, p.level);
  const start = toMinutes(proactiveState(person).activeStart), nowMinute = localClock(person, now).minute;
  const rel = minutes => ((minutes - start) + 1440) % 1440;
  const passed = times.filter(t => !p.checksDone.includes(t) && rel(toMinutes(t)) <= rel(nowMinute));
  if (!passed.length) return null;
  const latest = passed.reduce((a, b) => rel(toMinutes(b)) > rel(toMinutes(a)) ? b : a);
  p.checksDone.push(...passed);
  if ((rel(nowMinute) - rel(toMinutes(latest))) * MINUTE > GRACE_MS) return null;
  if (p.wakes >= limits.wakes) { log(p, {at: now, kind: 'check', outcome: 'cap', spoke: false}); return null; }
  const check = {number: times.indexOf(latest) + 1, of: times.length};
  return begin('check', null, TRIGGER_TEXT.check(check.number, check.of, p.sent, limits.messages), check);
}

function log(p, item) { p.log = [...p.log, item].slice(-LOG_SIZE); }

// 给 Jev 看的状态（jev.mjs）。英文字段、尽量是结构化的事实：习惯名和今天做没做、最近 7 天做了几次、跟进的备忘、
// 今天已经主动说了几句、她多久没说话、有几句主动的话还没回。不放聊天原文。
function jevStateFor(person, p, {kind, note, check}, now) {
  const timezone = person.profile.timezone, today = localClock(person, now).day, {activeStart, activeEnd} = proactiveState(person);
  const weekAgo = localClock(person, now - 6 * DAY).day, since = lastOwnActivity(person);
  const done = (person.completions || []).filter(c => c.date >= weekAgo && c.date <= today);
  const unanswered = (person.messages || []).filter(m => m.proactive === true && (Date.parse(m.createdAt) || 0) > since).length;
  return {
    local_time: localISO(timezone, now),
    weekday: WEEKDAY_NAMES[localParts(now, timezone).weekday],
    reason: kind === 'timer' ? 'A follow-up the assistant scheduled for itself is due.' : `Periodic check-in ${check.number} of ${check.of} today.`,
    ...(kind === 'timer' ? {assistant_note: note} : {}),
    allowed_hours: `${activeStart}-${activeEnd}`,
    proactive_messages_today: {sent: p.sent, limit: limitsFor(p.level).messages},
    minutes_since_user_last_spoke: since ? Math.round((now - since) / MINUTE) : null,
    unanswered_proactive_messages: unanswered,
    goals: (person.goals || []).filter(g => !g.archived).map(g => g.title),
    habits: (person.habits || []).map(h => ({
      name: h.name, minimum_action: h.minimumAction || '', trigger: h.trigger || '',
      done_today: done.some(c => c.habitId === h.id && c.date === today),
      days_done_last_7: done.filter(c => c.habitId === h.id).length,
    })),
  };
}

// 一轮后台醒来回来以后：放掉租约，跟进排到下一次，记一笔（说了没有）。
function finish(world, claim, result, now) {
  const person = world.people?.[claim.ownerId];
  if (!person) return;
  const p = proactiveOf(person, now);
  // 租约已经被当成超时放掉了：那边已经记过，这里不再动。
  if (!p.running || p.running.since !== claim.since || p.running.kind !== claim.kind) return;
  const spoke = p.sent > (p.running.sentBefore ?? p.sent);
  const outcome = result.skipped ? 'jev-quiet' : result.uncertain ? 'uncertain' : result.outcome === 'success' ? (spoke ? 'sent' : 'quiet') : result.outcome;
  const s = claim.scheduleId ? schedulesOf(person).find(x => x.id === claim.scheduleId) : null;
  if (s && isActive(s)) settle(person, s, outcome, now);
  // 没叫醒模型（Jev 判断不用打扰），或者 Agent 服务明确说没开始跑：这一次不算进今天的后台次数。
  if (result.skipped || result.retryable) p.wakes = Math.max(0, p.wakes - 1);
  log(p, {at: now, kind: claim.kind, scheduleId: claim.scheduleId, outcome, spoke, ...(claim.jev ? {jev: claim.jev} : {})});
  p.running = null;
}

// 一次 tick 里的后台叫醒（只有服务器自己的闹钟和 Cloudflare Cron 调，微信桥接的 tick 不调）。返回开始了几轮。
// startBy / deadline 和 wechat.processInboundSdk 一样：60 秒后不再开始新的一轮，每一轮最多等到 tick 结束。
// jev（jev.mjs 的 jevConfig）：配了就先问 Jev 现在值不值得主动找她，分数低于阈值就这次不叫醒（记成 jev-quiet）；
// 问不到（超时、出错）就照旧叫醒，交给 Weave 自己判断。
export async function runProactive({db, secret, service, fetcher = fetch, now = Date.now(), clock = Date.now, startBy, deadline, maxWakes = MAX_WAKES_PER_TICK, jev = null}) {
  const began = clock();
  startBy ??= began + START_BY_MS;
  deadline ??= began + TICK_BUDGET_MS;
  let started = 0, claims = 0;
  while (started < maxWakes && claims < MAX_CLAIMS_PER_TICK && (claims === 0 || clock() < startBy)) {
    const claim = await withWorld(db, world => {
      for (const id of Object.keys(world.people || {}).sort()) {
        const found = claimFor(world.people[id], now);
        if (found) return found;
      }
      return null;
    });
    if (!claim) break;
    claims++;
    if (jev) {
      try {
        const answer = await askJev(jev, claim.jevState, {fetcher});
        claim.jev = {noul: answer.noul, model: answer.model, threshold: jev.threshold};
      } catch (error) {
        console.error('Jev 这次没判断，照旧交给 Weave：' + (error instanceof Error ? error.message : 'unknown'));
        claim.jev = {error: true};
      }
      if (typeof claim.jev.noul === 'number' && claim.jev.noul < jev.threshold) {
        await withWorld(db, world => finish(world, claim, {skipped: true}, now));
        continue;
      }
    }
    started++;
    let result;
    try {
      result = await wake({
        db, secret, service, fetcher, now, scope: 'owner', ownerId: claim.ownerId, channel: claim.channel, background: true,
        timeoutMs: Math.max(5000, Math.min(180_000, deadline - clock())),
        trigger: {kind: claim.kind, channel: 'system', direct: false, text: claim.text},
      });
    } catch (error) {
      console.error('后台叫醒失败，记为结果不确定：' + (error instanceof Error ? error.message : 'unknown'));
      result = {outcome: 'error', uncertain: true};
    }
    await withWorld(db, world => finish(world, claim, result, now));
  }
  return started;
}

// 快照（本人范围）：全部排期，时间写成带偏移的当地时间；档位和今天的计数一行。
export function scheduleRows(person) {
  const timezone = person.profile.timezone, local = value => value ? localISO(timezone, Date.parse(value)) : null;
  return schedulesOf(person).map(s => ({
    schedule_id: s.id, kind: s.kind, text: s.text, repeat: s.repeat, next_at: local(s.nextAt), status: s.status,
    created_by: s.origin ?? null, last_run_at: local(s.lastRunAt), last_outcome: s.lastOutcome ?? null,
  }));
}
export function settingsRow(person, now) {
  const p = proactiveOf(person, now), limits = limitsFor(p.level), {activeStart, activeEnd} = proactiveState(person);
  return {
    level: p.level, active_start: activeStart, active_end: activeEnd, check_times: checkTimes(person, p.level).join(','),
    message_cap: limits.messages, sent_today: p.sent, wake_cap: limits.wakes, wakes_today: p.wakes,
  };
}
// 工具返回的一条排期，和快照的列一致。
export const scheduleResult = (person, s) => ({schedule_id: s.id, kind: s.kind, text: s.text, repeat: s.repeat, next_at: localISO(person.profile.timezone, Date.parse(s.nextAt)), status: s.status});

// 网页（GET /api/status）的「动态」：Weave 最近 14 天主动做过的事，新的在前，最多 50 条。文字由网页按 kind 配：
//   message     它自己找你说的一句（聊天里带 proactive 标记的那些）
//   reminder    到点提醒了你（只响一次的和重复的都是「提醒你：…」）
//   check       定期看看、followup 到点的跟进：只列没开口的那些（outcome quiet = 看过没说，jev-quiet = Jev 判断不用打扰）；
//               开口了的已经作为 message 列出
//   completion  它在聊天里帮你记的一次完成
const ACTIVITY_DAYS = 14, ACTIVITY_MAX = 50, QUIET_OUTCOMES = new Set(['quiet', 'jev-quiet']), REMINDER_PREFIX = '提醒你：';
export function publicActivity(person, now) {
  const since = now - ACTIVITY_DAYS * DAY, items = [];
  for (const m of person.messages || []) {
    const at = Date.parse(m.createdAt);
    if (m.role !== 'assistant' || !(at >= since) || typeof m.text !== 'string') continue;
    if (m.proactive === true) items.push({id: 'm:' + m.id, at: m.createdAt, kind: 'message', text: m.text.slice(0, 300)});
    else if (m.text.startsWith(REMINDER_PREFIX)) items.push({id: 'm:' + m.id, at: m.createdAt, kind: 'reminder', text: m.text.slice(REMINDER_PREFIX.length, REMINDER_PREFIX.length + 300)});
  }
  for (const entry of person.proactive?.log || []) {
    if (entry.spoke || !QUIET_OUTCOMES.has(entry.outcome) || !(entry.at >= since)) continue;
    items.push({id: `l:${entry.at}:${entry.kind}`, at: iso(entry.at), kind: entry.kind === 'timer' ? 'followup' : 'check', outcome: entry.outcome});
  }
  const habitNames = new Map((person.habits || []).map(h => [h.id, h.name]));
  for (const c of person.completions || []) {
    if (c.source !== 'agent' || !(Date.parse(c.createdAt) >= since)) continue;
    items.push({id: 'c:' + c.id, at: c.createdAt, kind: 'completion', habit: habitNames.get(c.habitId) ?? '', date: c.date});
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, ACTIVITY_MAX);
}

// 网页（GET /api/status）：有效的排期，加最近 20 条结束的。
export function publicSchedules(person) {
  const list = schedulesOf(person), finished = list.filter(s => !isActive(s)).slice(-20);
  return [...list.filter(isActive), ...finished].map(publicSchedule);
}
export const publicSchedule = s => ({id: s.id, kind: s.kind, text: s.text, repeat: s.repeat, nextAt: s.nextAt, status: s.status, origin: s.origin ?? null, lastRunAt: s.lastRunAt ?? null, lastOutcome: s.lastOutcome ?? null});
export function publicProactive(person, now) {
  const p = proactiveOf(person, now), limits = limitsFor(p.level), {activeStart, activeEnd} = proactiveState(person);
  return {
    level: p.level, activeStart, activeEnd, timezone: person.profile.timezone, checkTimes: checkTimes(person, p.level),
    messageCap: limits.messages, sentToday: p.sent, wakeCap: limits.wakes, wakesToday: p.wakes,
    quietReason: p.level === 'off' ? null : quietReason(person, now),
  };
}
