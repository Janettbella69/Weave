// 谁该醒（docs/ARCHITECTURE.md 第 7 节）。叫醒 Agent 服务只有一个入口 wake()，各个通道（网页、微信私聊、
// 打卡群 @，以后还有定时和事件）只是传不同的参数：范围（owner / group）、通道、触发信息。
// 醒了做什么由 Agent 决定，这里只负责叫醒、算出结果、存回复。
//
// 顺序很重要：先存用户消息，再叫醒，回来重新读一遍再存回复。叫醒期间工具后端会单独写 world，
// 拿着叫醒前读到的 world 存回去会覆盖那些写入，或者报 409。所以这里每一步都是自己的 withWorld，
// 调用方也不要把 world 拿着等一轮醒来。
import {withWorld} from './store.mjs';
import {unseal} from './crypto.mjs';
import {fail, record} from './domain.mjs';
import {localClock, GROUP_TIMEZONE} from './proactivity.mjs';
import {DEFAULT_MODEL, IMAGE_MODEL} from './model.mjs';
import {issueCapability} from './capability.mjs';

// 一次 tick（网页 / Cloudflare Cron / 微信桥接每分钟调一次）总共不能超过约 150 秒：桥接 170 秒放弃，nginx 200 秒放弃。
// 所以 60 秒以后不再开始新的一轮，每一轮最多等到 tick 结束。主动唤醒也用同样的预算。
export const TICK_BUDGET_MS = 150_000;
export const START_BY_MS = 60_000;
const WAKE_TIMEOUT_MS = 180_000;
const SCOPES = ['owner', 'group'], CHANNELS = ['web', 'wechat'];

// 草稿文案，待确认。
export const REPLIES = {
  busy: '现在排队的人有点多，没有处理这条，请稍后再发一次。',
  unavailable: 'Agent 暂时不可用，没有处理这条，请稍后再试。',
  uncertain: '这次没有拿到完整结果，Weave 可能已经做了一部分（比如记了一条记录），请先看看再决定要不要重发。',
};
// Agent 服务明确说没开始跑的状态码：这时可以说「没有处理」。其余失败都可能跑到一半。
const NOT_STARTED = new Set([400, 401, 403, 404, 413, 503]);

// 通行证和用户自己的 Key 都会发给 Agent 服务，所以只接受 https、同一台机器上的 http，
// 或者 docker 网络里不带点的服务名（如 http://agent:4320，只在那个网络里解析得到）。
export function agentServiceConfig(url, token) {
  if (typeof url !== 'string' || typeof token !== 'string' || token.length < 32) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const internal = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || /^[a-z][a-z0-9-]*$/i.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && internal)) return null;
  return {url: url.replace(/\/+$/, ''), token};
}

// 带时区偏移的当地时间，比如 2026-11-01T23:30:00-08:00，写进 <trigger at="…">。
export function localISO(timezone, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// 叫醒一轮：全仓库唯一向 Agent 服务发 /wake 的地方。只管叫醒和算结果，不替调用方存任何东西。
//   scope     'owner'（本人）或 'group'（打卡群）。群范围要给 groupId：群 id 的哈希，不是微信的群号。
//   ownerId   本人；群范围里是开启这个群的人，用他的模型和 Key。
//   channel   通行证上的通道（web / wechat），决定 send_message 发到哪。
//   trigger   {kind, channel, direct, text}：kind 默认 message，direct 默认 true；at 由这里补上：本人范围按本人时区，群范围按北京时间。
//   beforeWake  可选，在读模型设置的同一个事务里先跑（网页和微信用它先存用户的消息）。
//   background  后台那一轮（定时、定期看看，proactive.mjs）：Agent 服务从当天的会话分叉出去，失败了不碰原会话。
//   image     可选，{mediaType, data}（base64）：微信看图时这一轮带的那张照片。带照片的一轮一律用 IMAGE_MODEL。
//   purpose   可选，写进通行证：'close' 是换日收尾那一轮（day-close.mjs），工具后端不让它发消息。
//   sessionDate  可选，接哪一天的会话（收尾那一轮接前一天的）；不给就是今天。
// 本人直接找它的那一轮（网页、微信私聊），记下她这一天跟 Weave 说过话（person.agentDay），换日后由 day-close.mjs 收尾。
// 后台那一轮（定期看看、跟进、收尾）不算：她没说话的那天没有新的「说好的事」，上一份 HANDOFF.md 留着就行。
// 返回 {outcome, reply, uncertain, retryable, runId}：
//   retryable  Agent 服务明确说没开始跑（429 / 400 401 403 404 413 503），可以说「没有处理」，稍后重试也安全；
//   uncertain  其余没拿到完整结果的情况（超时、断线、500、这一轮没成功）可能已经做了一部分，不自动重试。
export async function wake({db, secret, service, fetcher = fetch, now = Date.now(), scope = 'owner', ownerId, groupId, channel = 'web', trigger, timeoutMs = WAKE_TIMEOUT_MS, beforeWake, background = false, image, purpose, sessionDate}) {
  if (!SCOPES.includes(scope)) throw Error(`不支持的范围：${scope}`);
  if (!CHANNELS.includes(channel)) throw Error(`不支持的通道：${channel}`);
  if (scope === 'group' && (typeof groupId !== 'string' || !groupId)) throw Error('群范围需要 groupId');
  if (scope === 'owner' && groupId !== undefined) throw Error('本人范围不能带 groupId');
  const direct = trigger.direct ?? true, runId = crypto.randomUUID();
  const run = await withWorld(db, async world => {
    const person = world.people[ownerId];
    if (!person) fail('账号不存在', 404);
    await beforeWake?.(world, person);
    // 群里的日期和时间按北京时间，不用开启者的时区（GROUP_TIMEZONE）。
    const localDate = localClock(scope === 'group' ? {profile: {timezone: GROUP_TIMEZONE}} : person, now).day;
    if (scope === 'owner' && direct) person.agentDay = localDate;
    return {
      model: person.settings?.model || DEFAULT_MODEL,
      // 用自己 Key 的人自己付费，模型代理不计他的额度（沿用 budget.mjs 的口径）。
      userKey: person.settings?.deepseekKey ? await unseal(person.settings.deepseekKey, secret, ownerId) : undefined,
      localDate: sessionDate ?? localDate,
      at: localISO(scope === 'group' ? GROUP_TIMEZONE : person.profile.timezone, now),
    };
  });
  const capability = await issueCapability(secret, {owner: ownerId, scope, runId, channel, direct, ...(scope === 'group' ? {group: groupId} : {}), ...(purpose ? {purpose} : {})}, now);

  let outcome = 'error', reply = null, retryable = false;
  try {
    const response = await fetcher(service.url + '/wake', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
      body: JSON.stringify({
        scope, id: scope === 'group' ? groupId : ownerId, capability, localDate: run.localDate,
        trigger: {kind: trigger.kind ?? 'message', channel: trigger.channel, direct, at: run.at, text: trigger.text},
        provider: 'deepseek', model: image ? IMAGE_MODEL : run.model, ...(run.userKey ? {userKey: run.userKey} : {}),
        ...(background ? {background: true} : {}),
        ...(image ? {image} : {}),
      }),
    });
    if (response.status === 429) { outcome = 'busy'; retryable = true; }
    else if (NOT_STARTED.has(response.status)) { outcome = 'unavailable'; retryable = true; }
    else if (response.status === 200) {
      const out = await response.json();
      outcome = typeof out?.outcome === 'string' ? out.outcome : 'error';
      if (outcome === 'success' && typeof out.reply === 'string' && out.reply.trim()) reply = out.reply.trim();
    }
  } catch {
    // 超时或断线：Agent 可能已经跑了一部分。
  }
  // 不自动重试：可能已经记过东西或发过消息（文档第 2 节「出错时」）。
  // 有人直接找它的那一轮，成功就必须有最后一段话；没人找它的那一轮（定时、事件），不说话是正常的。
  const uncertain = !retryable && !(outcome === 'success' && (reply !== null || !direct));
  return {outcome, reply, uncertain, retryable, runId};
}

// 有人直接找它的那一轮一定要有一句话回给人：没有拿到结果时用这三句。
function answerFor(result) {
  if (result.reply !== null) return result.reply;
  return result.outcome === 'busy' ? REPLIES.busy : result.outcome === 'unavailable' ? REPLIES.unavailable : REPLIES.uncertain;
}

// 本人发来一条消息（网页或微信私聊）：先存用户消息，叫醒，回来重读再存回复。
// afterWake(world, person, done) 在存回复的同一个事务里跑，微信用它把回复排进发送队列。
export async function wakeForMessage({db, secret, ownerId, text, image, service, fetcher = fetch, now = Date.now(), channel = 'web', timeoutMs, afterWake}) {
  const result = await wake({
    // 照片只交给这一轮，不写进 person.messages：那里只存文字。
    db, secret, service, fetcher, now, ownerId, channel, timeoutMs, trigger: {channel, text}, image,
    beforeWake: (world, person) => { person.messages.push({id: crypto.randomUUID(), role: 'user', text, createdAt: new Date(now).toISOString()}); },
  });
  const reply = answerFor(result), done = {reply, outcome: result.outcome, uncertain: result.uncertain, runId: result.runId};
  await withWorld(db, async world => {
    const person = world.people[ownerId];
    if (person) record(person, reply, {source: 'agent', runId: done.runId, outcome: done.outcome, ...(done.uncertain ? {uncertain: true} : {})});
    await afterWake?.(world, person, done);
  });
  return done;
}

// 打卡群里有人 @ 它：群范围，通道是微信，触发信息的通道是 group。
// 不往本人的任何记录里写东西；回复排进哪个群、@ 谁，由 afterWake 决定。
export async function wakeForGroup({db, secret, ownerId, groupId, text, image, service, fetcher = fetch, now = Date.now(), timeoutMs, afterWake}) {
  const result = await wake({db, secret, service, fetcher, now, ownerId, scope: 'group', groupId, channel: 'wechat', timeoutMs, trigger: {channel: 'group', text}, image});
  const done = {reply: answerFor(result), outcome: result.outcome, uncertain: result.uncertain, runId: result.runId};
  if (afterWake) await withWorld(db, world => afterWake(world, world.people[ownerId], done));
  return done;
}

// 注销或关闭群时先删 Agent 的工作目录和会话记录，删不掉就不往下走，免得留下没人管的个人数据。
export async function forgetAgentWorkspace({service, scope = 'owner', id, ownerId, fetcher = fetch}) {
  let done = false;
  try {
    const response = await fetcher(service.url + '/forget', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
      body: JSON.stringify({scope, id: id ?? ownerId}),
    });
    done = response.status === 200;
  } catch {
    done = false;
  }
  // 草稿文案，待确认。
  if (!done) fail('暂时删不掉 Agent 的工作目录，账号没有删除，请稍后重试', 503);
}
