// 工具后端（docs/ARCHITECTURE.md「一张嘴」）：Weave 说话只有一个出口 send_message，Agent 服务里的 MCP 工具是薄壳，
// 参数和这一条消息是什么（turn）转到这里。POST /api/internal/agent/tools/send_message，Authorization 是这一条的通行证。
// 这里只做基础设施的事：收件人由通行证决定（模型选不了）、同一次调用重放不发两次、记进聊天、排进微信。
// 不替 Weave 判断该不该说、说几句：每天几条、多久不重复、几点不打扰，这些「防它做蠢事」的上限都删了（教材 p.54「前者删」）。
// 唯一的例外是 Jev（她定的用途：判断要不要主动提醒用户）：Weave 主动开口时（不是回她、不是她让设的提醒），先问 Jev 现在发不发。
import {withWorld, Store} from './store.mjs';
import {verifyCapability} from './capability.mjs';
import {fail, record, notify} from './domain.mjs';
import {localClock} from './proactivity.mjs';
import {groupTool, queueOwnerText} from './wechat.mjs';
import {askJev} from './jev.mjs';

const RECEIPTS = 200, JEV_LOG = 50, WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 草稿文案，待确认：给模型看的结果。
export const TEXT = {
  length: '消息要 1–700 字。',
  sent: '已发出。',
  jevQuiet: 'Jev 判断现在不打扰，这条没有发出。想晚点再看，可以给自己定个闹钟。',
};

// 这句话是不是 Weave 主动开口：心跳、它自己定的闹钟。她发来的话、她让设的提醒（alarmKind reminder）、事件都不是。
export const isProactive = turn => turn?.kind === 'heartbeat' || (turn?.kind === 'alarm' && turn.alarmKind === 'self');

// 给 Jev 的状态（英文字段，Jev 主要用英文训练）：Agent 服务从本子里算好的习惯和备忘（turn.facts），加上这边聊天记录里的
// 「她多久没说话、几句主动的话还没回、今天主动说了几句」。不放聊天原文（隐私页写着发给 Jev 的是哪些）。
function jevState(person, turn, now) {
  const facts = turn.facts || {}, today = localClock(person, now).day;
  const lastOwn = Math.max(0, ...(person.messages || []).filter(m => m.role === 'user').map(m => Date.parse(m.createdAt) || 0));
  const proactive = (person.messages || []).filter(m => m.proactive === true);
  const local = typeof facts.local_time === 'string' ? facts.local_time : null;
  return {
    ...(local ? {local_time: local, weekday: WEEKDAYS[new Date(local.slice(0, 10) + 'T12:00:00Z').getUTCDay()]} : {}),
    reason: turn.kind === 'heartbeat' ? 'A periodic time check; the assistant is considering a message the user did not ask for.' : 'A follow-up the assistant scheduled for itself is due.',
    ...(typeof facts.assistant_note === 'string' ? {assistant_note: facts.assistant_note} : {}),
    proactive_messages_today: proactive.filter(m => localClock(person, Date.parse(m.createdAt) || 0).day === today).length,
    minutes_since_user_last_spoke: lastOwn ? Math.round((now - lastOwn) / 60000) : null,
    unanswered_proactive_messages: proactive.filter(m => (Date.parse(m.createdAt) || 0) > lastOwn && (m.wechat === undefined || m.wechat === 'sent')).length,
    goals: Array.isArray(facts.goals) ? facts.goals : [],
    habits: Array.isArray(facts.habits) ? facts.habits : [],
  };
}

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

export async function handleAgentTool(request, {db, secret, readBody, jev = null, fetcher = fetch, now = Date.now()}) {
  try {
    if (request.method !== 'POST') return json({error: '方法不支持'}, 405);
    const name = new URL(request.url).pathname.slice('/api/internal/agent/tools/'.length);
    if (name !== 'send_message') return json({error: '工具不存在'}, 404);
    const auth = request.headers.get('authorization') || '';
    const claims = await verifyCapability(secret, auth.startsWith('Bearer ') ? auth.slice(7) : '', now);
    if (!db) return json({error: '数据库尚未就绪'}, 503);
    const input = await readBody(request);
    const {args, toolUseId} = input;
    const turn = input.turn && typeof input.turn === 'object' && !Array.isArray(input.turn) ? input.turn : {kind: 'message'};
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 200) {
      return json({error: '参数无效'}, 400);
    }
    // 群：发回这个群，有人 @ 它的那一条就 @ 提问的人（wechat.mjs）。
    if (claims.scope === 'group') return json(await withWorld(db, world => groupTool(world, claims, args, toolUseId, now)));
    const key = `${claims.runId}:${toolUseId}`;
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    // 先看是不是重放、Jev 要不要问：Jev 是外部请求，放在写数据的事务外面（事务冲突重试时不重复问、不重复花钱）。
    const before = await new Store(db).load();
    const owner = before.people[claims.owner];
    if (!owner) return json({error: '账号不存在'}, 404);
    const done = owner.toolReceipts?.find(receipt => receipt.key === key);
    if (done) return json({ok: done.ok, text: done.text});
    let verdict = null;
    if (text && text.length <= 700 && jev && isProactive(turn)) {
      try {
        const answer = await askJev(jev, jevState(owner, turn, now), {fetcher});
        verdict = {noul: answer.noul, model: answer.model, threshold: jev.threshold, ...(answer.cost !== undefined ? {cost: answer.cost} : {})};
      } catch (error) {
        // 问不到 Jev（超时、出错）：照旧发，交给 Weave 自己的判断。
        console.error('Jev 这次没判断，照旧发出：' + (error instanceof Error ? error.message : 'unknown'));
        verdict = {error: true};
      }
    }
    const out = await withWorld(db, world => {
      const person = world.people[claims.owner];
      if (!person) fail('账号不存在', 404);
      const receipt = person.toolReceipts?.find(r => r.key === key);
      if (receipt) return {ok: receipt.ok, text: receipt.text};
      let ok = true, reply;
      if (!text || text.length > 700) { ok = false; reply = TEXT.length; }
      else if (verdict && typeof verdict.noul === 'number' && verdict.noul < verdict.threshold) { ok = false; reply = TEXT.jevQuiet; }
      else {
        const proactive = isProactive(turn);
        const message = record(person, text, {source: 'agent', runId: claims.runId, createdAt: new Date(now).toISOString(), ...(proactive ? {proactive: true} : {})});
        // 收件人和通道由通行证决定：微信就排进她的微信（主动的话等桥接回执说送到了，才算她看到了），网页就发网页通知。
        if (claims.channel === 'wechat') { if (queueOwnerText(world, person, text, now, {message, proactive}) && proactive) message.wechat = 'queued'; }
        else notify(world, person.id, text);
        reply = TEXT.sent;
      }
      // Jev 的每一次判断都记下来（发了没有），网页「动态」能看到，以后用来看 Jev 判得准不准。
      if (verdict) person.jevLog = [...(person.jevLog || []), {at: now, kind: turn.kind, sent: ok, ...verdict}].slice(-JEV_LOG);
      person.toolReceipts = [...(person.toolReceipts || []), {key, ok, text: reply, at: now}].slice(-RECEIPTS);
      return {ok, text: reply};
    });
    return json(out);
  } catch (error) {
    return json({error: error.status ? error.message : '工具后端暂时不可用'}, error.status || 500);
  }
}
