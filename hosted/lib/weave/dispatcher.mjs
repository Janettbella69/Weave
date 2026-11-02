// 谁该醒（docs/ARCHITECTURE.md 第 7 节）。第 1 步只有一种：本人在网页上发消息。
// 定时、事件、微信和打卡群在第 3 步加。醒了做什么由 Agent 决定，这里只负责叫醒和存结果。
//
// 顺序很重要：先存用户消息，再叫醒，回来重新读一遍再存回复。叫醒期间工具后端会单独写 world，
// 拿着叫醒前读到的 world 存回去会覆盖那些写入，或者报 409。
import {withWorld} from './store.mjs';
import {unseal} from './crypto.mjs';
import {fail, record} from './domain.mjs';
import {localClock} from './proactivity.mjs';
import {DEFAULT_MODEL} from './model.mjs';
import {issueCapability} from './capability.mjs';

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

export async function wakeForMessage({db, secret, ownerId, text, service, fetcher = fetch, now = Date.now()}) {
  const runId = crypto.randomUUID();
  const run = await withWorld(db, async world => {
    const person = world.people[ownerId];
    person.messages.push({id: crypto.randomUUID(), role: 'user', text, createdAt: new Date(now).toISOString()});
    return {
      model: person.settings?.model || DEFAULT_MODEL,
      // 用自己 Key 的人自己付费，模型代理不计他的额度（沿用 budget.mjs 的口径）。
      userKey: person.settings?.deepseekKey ? await unseal(person.settings.deepseekKey, secret, ownerId) : undefined,
      localDate: localClock(person, now).day,
      at: localISO(person.profile.timezone, now),
    };
  });
  const capability = await issueCapability(secret, {owner: ownerId, scope: 'owner', runId, channel: 'web', direct: true}, now);

  let outcome = 'error', reply = null;
  try {
    const response = await fetcher(service.url + '/wake', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(180_000),
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
      body: JSON.stringify({
        scope: 'owner', id: ownerId, capability, localDate: run.localDate,
        trigger: {kind: 'message', channel: 'web', direct: true, at: run.at, text},
        provider: 'deepseek', model: run.model, ...(run.userKey ? {userKey: run.userKey} : {}),
      }),
    });
    if (response.status === 429) { outcome = 'busy'; reply = REPLIES.busy; }
    else if (NOT_STARTED.has(response.status)) { outcome = 'unavailable'; reply = REPLIES.unavailable; }
    else if (response.status === 200) {
      const out = await response.json();
      outcome = typeof out?.outcome === 'string' ? out.outcome : 'error';
      if (outcome === 'success' && typeof out.reply === 'string' && out.reply.trim()) reply = out.reply.trim();
    }
  } catch {
    // 超时或断线：Agent 可能已经跑了一部分。
  }
  // 不自动重试：可能已经记过东西或发过消息（文档第 2 节「出错时」）。
  const uncertain = reply === null;
  if (uncertain) reply = REPLIES.uncertain;
  await withWorld(db, world => {
    const person = world.people[ownerId];
    if (person) record(person, reply, {source: 'agent', runId, outcome, ...(uncertain ? {uncertain: true} : {})});
  });
  return {reply, outcome};
}

// 注销时先删 Agent 的工作目录和会话记录，删不掉就不删账号，免得留下没人管的个人数据。
export async function forgetAgentWorkspace({service, ownerId, fetcher = fetch}) {
  let done = false;
  try {
    const response = await fetcher(service.url + '/forget', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
      body: JSON.stringify({scope: 'owner', id: ownerId}),
    });
    done = response.status === 200;
  } catch {
    done = false;
  }
  // 草稿文案，待确认。
  if (!done) fail('暂时删不掉 Agent 的工作目录，账号没有删除，请稍后重试', 503);
}
