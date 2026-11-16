// 把消息交给一直在线的 Weave（docs/ARCHITECTURE.md「一直在线」「一张嘴」）。Weave 一直都在，这里不「叫醒」谁：
// 她在网页、微信里说的话，群里 @ 它的话，「微信刚连上」这类事件，都推进同一段会话；每条消息带一张这一条的通行证。
// Weave 说话只有一个出口 send_message（agent-tools.mjs），这里不替它说任何话；只有这一条没处理成、又一句话都没发出去时，
// 基础设施如实说一句（REPLIES，和 Claude Code 自己报 API 出错一样）。
import {withWorld} from './store.mjs';
import {unseal} from './crypto.mjs';
import {record} from './domain.mjs';
import {GROUP_TIMEZONE} from './proactivity.mjs';
import {DEFAULT_MODEL} from './model.mjs';
import {issueCapability} from './capability.mjs';

// 网页聊天等这一轮做完，最多等到 Agent 服务那边一轮的上限（10 分钟）再多一点。
const WAIT_MS = 10 * 60 * 1000 + 30_000;
const SCOPES = ['owner', 'group'], CHANNELS = ['web', 'wechat'];

// 草稿文案，待确认：这一条没处理成、Weave 也什么都没发出去时，基础设施说的真实原因。
export const REPLIES = {
  busy: '现在排队的人有点多，没有处理这条，请稍后再发一次。',
  unavailable: 'Weave 暂时不可用，没有处理这条，请稍后再试。',
  uncertain: '这条没有处理完，Weave 可能已经做了一部分（比如记了一条记录），请先看看再决定要不要重发。',
};
// 她 2026-11-16 确认过的原句：微信连上以后，由 Weave 自己打招呼。hosted/agent-service/prompts.mjs 有同一句，
// test/agent-prompts-sync.test.mjs 保证两边一致。
export const WECHAT_CONNECTED_TEXT = '对方刚把微信连上了。打个招呼，告诉对方以后在这里找你就行。';

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

// 带时区偏移的当地时间，比如 2026-11-01T23:30:00-08:00，写进 <message at="…">。
export function localISO(timezone, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// 这个人用的模型：她在设置页选的，和她自己的 Key（有的话，她自己付费，模型代理不计她的额度）。群用开启者的。
export async function modelOf(person, ownerId, secret) {
  return {
    provider: 'deepseek',
    model: person.settings?.model || DEFAULT_MODEL,
    ...(person.settings?.deepseekKey ? {userKey: await unseal(person.settings.deepseekKey, secret, ownerId)} : {}),
  };
}

// 这一条消息的通行证：说话发到哪（channel）、是谁、哪个群，由它决定，模型改不了（agent-tools.mjs）。
export const capabilityFor = (secret, {ownerId, scope = 'owner', channel, groupId, runId, now}) =>
  issueCapability(secret, {owner: ownerId, scope, runId, channel, direct: false, ...(scope === 'group' ? {group: groupId} : {})}, now);

// 推一条消息给 Agent 服务。wait：等这一轮做完（网页聊天）；否则对方马上回 202，做完了回报 /api/internal/agent/outcome。
async function post(service, fetcher, body, wait) {
  const response = await fetcher(service.url + '/message', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(wait ? WAIT_MS : 15000),
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
    body: JSON.stringify({...body, ...(wait ? {wait: true} : {})}),
  });
  let data = null;
  try { data = await response.json(); } catch { /* not JSON */ }
  return {status: response.status, data};
}
const failureOf = status => status === 429 ? 'busy' : status === 400 || status === 401 || status === 403 || status === 404 || status === 413 || status === 503 ? 'unavailable' : 'uncertain';

// 这一条里 Weave 用 send_message 说了哪些话（agent-tools.mjs 记在 person.messages 里，带 runId）。
export const sentInRun = (person, runId) => (person?.messages || []).filter(m => m.role === 'assistant' && m.source === 'agent' && m.runId === runId);

// 她发来一句话（网页或微信私聊）：先记下她的话，再推进会话。
//   web     她在页面上等：等这一轮做完，回复就是 Weave 这一轮说的话（可能没有）；没处理成又一句没说，回 REPLIES。
//   wechat  不等：交出去马上回来（ref 是微信那条消息的编号，做完回报时对得上），回复由 send_message 排进微信。
export async function sendFromOwner({db, secret, ownerId, text, image, service, fetcher = fetch, now = Date.now(), channel = 'web', kind = 'message', ref, remember = true}) {
  if (!CHANNELS.includes(channel)) throw Error(`不支持的通道：${channel}`);
  const runId = crypto.randomUUID();
  const setup = await withWorld(db, async world => {
    const person = world.people[ownerId];
    if (!person) throw Object.assign(Error('账号不存在'), {status: 404});
    if (remember && kind === 'message') person.messages.push({id: crypto.randomUUID(), role: 'user', text, channel, createdAt: new Date(now).toISOString()});
    return {at: localISO(person.profile.timezone, now), ...(await modelOf(person, ownerId, secret))};
  });
  const capability = await capabilityFor(secret, {ownerId, channel, runId, now});
  const body = {scope: 'owner', id: ownerId, capability, ...(ref ? {ref} : {}), provider: setup.provider, model: setup.model, ...(setup.userKey ? {userKey: setup.userKey} : {}),
    message: {kind, channel, at: setup.at, text}, ...(image ? {image} : {})};
  const wait = channel === 'web';
  let result;
  try { result = await post(service, fetcher, body, wait); }
  catch { result = {status: 0, data: null}; }
  if (!wait) return {runId, accepted: result.status === 202, outcome: result.status === 202 ? 'accepted' : failureOf(result.status)};
  const outcome = result.status === 200 && typeof result.data?.outcome === 'string' ? result.data.outcome : failureOf(result.status);
  // 这一条里 Weave 说过的话；没处理成又一句没说时，基础设施如实说一句，也记进聊天。
  const reply = await withWorld(db, world => {
    const person = world.people[ownerId];
    const said = sentInRun(person, runId).map(m => m.text);
    if (said.length || outcome === 'success') return said.join('\n\n');
    const text = REPLIES[outcome] ?? REPLIES.uncertain;
    if (person) record(person, text, {source: 'system', runId, outcome});
    return text;
  });
  return {runId, outcome, reply};
}

// 群里有人 @ 它：推进这个群自己的那段会话（不碰任何人的记录）。不等。text 里已经带上群里之前的几句（wechat.mjs）。
// mention 是提问的人（封好的），send_message 在群里回话时 @ 他（agent-tools.mjs 读 world.runtime 里这一条的记录）。
export async function sendFromGroup({db, secret, ownerId, groupId, text, image, service, fetcher = fetch, now = Date.now(), ref, mention}) {
  const runId = crypto.randomUUID();
  const setup = await withWorld(db, async world => {
    const person = world.people[ownerId];
    if (!person) throw Object.assign(Error('账号不存在'), {status: 404});
    if (mention) world.runtime[`group-run:${runId}`] = {mention, expiresAt: now + 30 * 60 * 1000};
    return modelOf(person, ownerId, secret);
  });
  const capability = await capabilityFor(secret, {ownerId, scope: 'group', groupId, channel: 'wechat', runId, now});
  let result;
  try {
    result = await post(service, fetcher, {
      scope: 'group', id: groupId, capability, ...(ref ? {ref} : {}), provider: setup.provider, model: setup.model, ...(setup.userKey ? {userKey: setup.userKey} : {}),
      message: {kind: 'message', channel: 'group', at: localISO(GROUP_TIMEZONE, now), text}, ...(image ? {image} : {}),
    }, false);
  } catch { result = {status: 0}; }
  return {runId, accepted: result.status === 202, outcome: result.status === 202 ? 'accepted' : failureOf(result.status)};
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
  if (!done) throw Object.assign(Error('暂时删不掉 Agent 的工作目录，账号没有删除，请稍后重试'), {status: 503});
}

// 调 Agent 服务的本子、记忆接口（网页读本子、打勾、取消闹钟、看记忆）。要这个人的通行证：第一次读时会从这里导入以前的数据。
export async function agentCall({service, fetcher = fetch, path, body}) {
  const response = await fetcher(service.url + path, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { /* not JSON */ }
  if (response.status !== 200) throw Object.assign(Error(data?.error || 'Weave 暂时不可用，请稍后再试'), {status: response.status === 404 ? 404 : 503});
  return data;
}
