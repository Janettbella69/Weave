// Jev（TypeSafe 的判断模型）决定「现在要不要主动找她」。2026-11-03 她定：决策模型就是用来做是否主动提醒用户的。
// 后台叫醒 Weave 之前问一个是非题（Noul），概率够了才叫醒 Weave 去写那句话；不够就这次不打扰，也省下一轮的钱。
// 她让设的提醒不经过这里。Jev 连不上、没配 Key 时，照旧交给 Weave 自己判断（proactive.mjs）。
//
// 接口出自官方文档（2026-11-03 读）：docs.typesafe.ai/api/system-one.md（OpenAPI 0.2.0）POST /v1/systemone，
// questions 是按名字作键的对象，答案在 answers.<名字>.noul（回答「是」的概率）；docs.typesafe.ai/models.md：
// 当前版本 jev-1.14.0，jev-latest 会跟着新版本变，所以钉版本；「English is the primary training language」，所以问题用英文。
// 这是全仓库唯一不走 Agent SDK 的模型调用（docs/ARCHITECTURE.md 第 7 节）：只打一个分，不决定醒了做什么。
//
// 也能经 OpenRouter 调（2026-11-16 读 openrouter.ai/docs/guides/community/typesafe-sdk.md）：「The System One API
// implements TypeSafe's request and response shapes」，base URL 是 https://openrouter.ai/api，Key 用 OpenRouter 的，
// 另外多返回 id、provider 和 usage.cost（这一次花了多少美元）。官方 SDK 用 TYPESAFE_BASE_URL 切过去，这里用同一个名字。
// 模型名带 typesafe/ 前缀（openrouter.ai/docs/guides/community/jev.md：当前 typesafe/jev-1.14）。
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.14.0';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
export const OPENROUTER_JEV_URL = OPENROUTER_BASE_URL + '/v1/systemone';
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.14';
export const DEFAULT_THRESHOLD = 0.5;
const TIMEOUT_MS = 8000;

// Key 和状态只发给这两个地址：没设 TYPESAFE_BASE_URL 是 TypeSafe 自己，设成 OpenRouter 就走 OpenRouter。
// 设成别的就不启用，免得写错一个地址，就把 Key 和用户的状态发到别处去。
const ENDPOINTS = new Map([
  ['https://api.typesafe.ai', {url: JEV_URL, model: JEV_MODEL}],
  [OPENROUTER_BASE_URL, {url: OPENROUTER_JEV_URL, model: OPENROUTER_JEV_MODEL}],
]);

// 服务器配了 TYPESAFE_API_KEY 才启用。TYPESAFE_BASE_URL、JEV_MODEL、JEV_THRESHOLD 可选（阈值是草稿数字，待她定）。
export function jevConfig(env) {
  const key = typeof env?.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY.trim() : '';
  if (key.length < 12 || key.length > 512 || /\s/.test(key)) return null;
  const base = typeof env.TYPESAFE_BASE_URL === 'string' ? env.TYPESAFE_BASE_URL.trim().replace(/\/+$/, '') : '';
  const endpoint = ENDPOINTS.get(base || 'https://api.typesafe.ai');
  if (!endpoint) return null;
  const threshold = Number(env.JEV_THRESHOLD);
  return {
    key,
    url: endpoint.url,
    model: typeof env.JEV_MODEL === 'string' && /^(typesafe\/)?jev-[a-z0-9.-]{1,40}$/.test(env.JEV_MODEL) ? env.JEV_MODEL : endpoint.model,
    threshold: env.JEV_THRESHOLD !== undefined && env.JEV_THRESHOLD !== '' && Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : DEFAULT_THRESHOLD,
  };
}

// 草稿，待确认（设计稿附录 A）：给 Jev 的问题。
export const QUESTION = {
  type: 'noul',
  instructions: 'The state describes one user of a habit-building assistant at the moment the assistant is considering sending them one short message without being asked. Should the assistant reach out to the user right now?',
  criteria: {
    true: 'Reaching out now is timely and useful: for example, a habit the user planned for today is still not logged as the day goes on, a follow-up the assistant scheduled for itself is due and still relevant, or something worth noticing happened today.',
    false: "Better to stay quiet now: nothing has changed, today's habits are already done, the user was messaged recently or has not answered earlier messages, or the message would only be a generic reminder or encouragement.",
  },
};

// 问一次。返回 {noul, model}，经 OpenRouter 时多一个 cost（美元）；HTTP 不是 200、超时、答案不对都抛错，
// 由调用方当成「Jev 这次没判断」。
export async function askJev(config, state, {fetcher = fetch, timeoutMs = TIMEOUT_MS} = {}) {
  const response = await fetcher(config.url || JEV_URL, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.key},
    body: JSON.stringify({model: config.model, state, questions: {reach_out: QUESTION}}),
  });
  if (response.status !== 200) {
    try { await response.body?.cancel(); } catch { /* nothing to free */ }
    throw Error('Jev HTTP ' + response.status);
  }
  const out = await response.json();
  const noul = out?.answers?.reach_out?.noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) throw Error('Jev answer missing');
  const cost = out?.usage?.cost;
  return {
    noul, model: typeof out.model === 'string' ? out.model.slice(0, 40) : config.model,
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? {cost} : {}),
  };
}
