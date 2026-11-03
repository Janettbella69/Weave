// 工具后端（docs/ARCHITECTURE.md 第 4 节规则 1、4、6、7）：Agent 服务里的 MCP 工具只是薄壳，
// 规则都在这里。POST /api/internal/agent/tools/<name>，Authorization 是这一轮的通行证。
// 规则不允许时回 200 + {ok:false, text}，让模型看到能照做的原因；通行证不对才是 4xx。
// 同一次调用（runId + toolUseId）重放时，原样返回上次的结果，不会记两条、发两次。
import {withWorld} from './store.mjs';
import {verifyCapability} from './capability.mjs';
import {fail, record, notify, addReminder} from './domain.mjs';
import {activeNow, localClock} from './proactivity.mjs';
import {saveGoal, saveHabit, logCompletion} from './habits.mjs';
import {groupTool, queueOwnerText} from './wechat.mjs';

// 这一轮能用哪些工具，按通行证上的范围。群范围只有 send_message，而且只能发给通行证上的那个群。
// 只有会写东西的工具；读数据走叫醒前的快照（agent-snapshot.mjs，教材 p.16）。
export const TOOL_SCOPES = {
  send_message: ['owner', 'group'],
  save_habit: ['owner'],
  log_completion: ['owner'],
  save_goal: ['owner'],
  set_reminder: ['owner'],
};
const RECEIPTS = 200, DAILY_MESSAGES = 20, REPEAT_MS = 24 * 60 * 60 * 1000;

// 草稿文案和每天 20 条的上限，待确认。
const TEXT = {
  length: '消息要 1–700 字。',
  quiet: '现在是对方的安静时段，这条没有发出。',
  cap: '今天发的消息已经到上限了，这条没有发出。',
  repeat: '这句话 24 小时内已经发过了，没有重复发送。',
  sent: '已发出。',
};

// 收件人由通行证决定，模型选不了（文档第 4 节工具表）。通行证上的通道是微信就发到本人的微信，是网页就发网页通知。
function sendMessage(world, person, claims, args, now) {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text || text.length > 700) fail(TEXT.length);
  if (!claims.direct && !activeNow(person, now)) fail(TEXT.quiet);
  const day = localClock(person, now).day, previous = person.agentOutbox;
  const outbox = {
    day,
    count: previous?.day === day ? previous.count : 0,
    recent: (previous?.recent || []).filter(item => now - item.at < REPEAT_MS),
  };
  if (outbox.count >= DAILY_MESSAGES) fail(TEXT.cap);
  if (outbox.recent.some(item => item.text === text)) fail(TEXT.repeat);
  outbox.count++;
  outbox.recent.push({text, at: now});
  person.agentOutbox = outbox;
  record(person, text, {source: 'agent', runId: claims.runId});
  if (claims.channel === 'wechat') queueOwnerText(world, person, text, now);
  else notify(world, person.id, text);
  return TEXT.sent;
}

// 模型常把时间写到分钟、不带秒，比如 2026-11-04T20:00+08:00；domain.validTime（网页的表单也用它）要求有秒。
// 所以只在这个工具里补上 :00：形如 YYYY-MM-DDTHH:MM 后面紧跟 Z 或 ±HH:MM 的才补，其他一概不动。
// 没有时区、已经过去、日期或钟点不存在，照样由 addReminder 按原来的规则拒绝。
const MINUTES_ONLY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/;
const withSeconds = value => typeof value === 'string' ? value.replace(MINUTES_ONLY, '$1:00$2') : value;

// 只响一次的提醒：直接用现有的 domain.addReminder（1–500 字、必须是将来的 ISO 时间，规则和网页上设提醒一样）。
// 到点后怎么送达不在这里：网页每次请求时把到点的提醒写进聊天和通知，微信由 scheduler.mjs 排队。
function setReminder(person, args) {
  const item = addReminder(person, {text: args.text, dueAt: withSeconds(args.due_at)});
  return {reminder: {reminder_id: item.id, text: item.text, due_at: item.dueAt, status: item.status}};
}

const BACKENDS = {
  send_message: sendMessage,
  save_habit: (world, person, claims, args, now) => JSON.stringify(saveHabit(person, args, now)),
  log_completion: (world, person, claims, args, now) => JSON.stringify(logCompletion(person, args, now, 'agent')),
  save_goal: (world, person, claims, args, now) => JSON.stringify(saveGoal(person, args, now)),
  set_reminder: (world, person, claims, args) => JSON.stringify(setReminder(person, args)),
};

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

export async function handleAgentTool(request, {db, secret, readBody, now = Date.now()}) {
  try {
    if (request.method !== 'POST') return json({error: '方法不支持'}, 405);
    const name = new URL(request.url).pathname.slice('/api/internal/agent/tools/'.length);
    if (!Object.hasOwn(TOOL_SCOPES, name)) return json({error: '工具不存在'}, 404);
    const auth = request.headers.get('authorization') || '';
    const claims = await verifyCapability(secret, auth.startsWith('Bearer ') ? auth.slice(7) : '', now);
    if (!TOOL_SCOPES[name].includes(claims.scope)) return json({error: '这一轮不能用这个工具'}, 403);
    if (!db) return json({error: '数据库尚未就绪'}, 503);
    const input = await readBody(request);
    const args = input.args, toolUseId = input.toolUseId;
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 200) {
      return json({error: '参数无效'}, 400);
    }
    const out = await withWorld(db, world => {
      const person = world.people[claims.owner];
      if (!person) fail('账号不存在', 404);
      // 群范围的工具走单独一条路：不拿本人的记录，回执也记在群自己的记录里。
      if (claims.scope === 'group') return groupTool(name, world, claims, args, toolUseId, now);
      const key = `${claims.runId}:${toolUseId}`;
      const done = person.toolReceipts?.find(receipt => receipt.key === key);
      if (done) return {ok: done.ok, text: done.text};
      let ok = true, text;
      try {
        text = BACKENDS[name](world, person, claims, args, now);
      } catch (error) {
        if (error.status !== 400) throw error;
        ok = false;
        text = error.message;
      }
      person.toolReceipts = [...(person.toolReceipts || []), {key, ok, text, at: now}].slice(-RECEIPTS);
      return {ok, text};
    });
    return json(out);
  } catch (error) {
    return json({error: error.status ? error.message : '工具后端暂时不可用'}, error.status || 500);
  }
}
