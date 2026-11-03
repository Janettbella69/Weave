// Jev（TypeSafe 的判断模型）决定「现在要不要主动找她」。2026-11-03 她定：决策模型就是用来做是否主动提醒用户的。
// 后台叫醒 Weave 之前问一个是非题（Noul），概率够了才叫醒 Weave 去写那句话；不够就这次不打扰，也省下一轮的钱。
// 她让设的提醒不经过这里。Jev 连不上、没配 Key 时，照旧交给 Weave 自己判断（proactive.mjs）。
//
// 接口出自官方文档（2026-11-03 读）：docs.typesafe.ai/api/system-one.md（OpenAPI 0.2.0）POST /v1/systemone，
// questions 是按名字作键的对象，答案在 answers.<名字>.noul（回答「是」的概率）；docs.typesafe.ai/models.md：
// 当前版本 jev-1.14.0，jev-latest 会跟着新版本变，所以钉版本；「English is the primary training language」，所以问题用英文。
// 这是全仓库唯一不走 Agent SDK 的模型调用（docs/ARCHITECTURE.md 第 7 节）：只打一个分，不决定醒了做什么。
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.14.0';
export const DEFAULT_THRESHOLD = 0.5;
const TIMEOUT_MS = 8000;

// 服务器配了 TYPESAFE_API_KEY 才启用。JEV_MODEL、JEV_THRESHOLD 可选（阈值是草稿数字，待她定）。
export function jevConfig(env) {
  const key = typeof env?.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY.trim() : '';
  if (key.length < 12 || key.length > 512 || /\s/.test(key)) return null;
  const threshold = Number(env.JEV_THRESHOLD);
  return {
    key,
    model: typeof env.JEV_MODEL === 'string' && /^jev-[a-z0-9.-]{1,40}$/.test(env.JEV_MODEL) ? env.JEV_MODEL : JEV_MODEL,
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

// 问一次。返回 {noul, model}；HTTP 不是 200、超时、答案不对都抛错，由调用方当成「Jev 这次没判断」。
export async function askJev(config, state, {fetcher = fetch, timeoutMs = TIMEOUT_MS} = {}) {
  const response = await fetcher(JEV_URL, {
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
  return {noul, model: typeof out.model === 'string' ? out.model.slice(0, 40) : config.model};
}
