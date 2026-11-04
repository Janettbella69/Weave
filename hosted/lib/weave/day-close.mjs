// 换日收尾（2026-11-04 她定：「换日前加一个固定的收尾步骤，把『说好的事』写进一个交接文件」）。
// 会话按当地日期换（hosted/agent-service/workspace.mjs 的 sessionFor），第二天开新的。以前中间没有任何一步：
// 她晚上说的「明天早上 7 点去走路」不写进 MEMORY.md（系统提示让它只写长期的事），第二天就没了。
// 教材 p.47「Handoff ≠ 记忆」：handoff 是「当前项目、下一次 session 参考的交接文档」，对话结尾要「写一个 handoff 文档
// 方便新开的对话接着做任务，同时把前面整个讨论中值得写到记忆的东西写到记忆里」。
// p.53：「如果让 AI 自己去调用 backup，他有可能忘记调用……做成 Hook，他就是百分之百」「打烊的时候必须关闭煤气」。
// 所以这里只由代码决定「什么时候收尾」（p.20「Agent 启动之前 预处理」）：本人某一天叫醒过 Agent，那一天过完以后，
// 服务器闹钟的下一拍叫醒一轮收尾。写什么由 Agent 决定：把还要接着的事写进工作目录的 HANDOFF.md（文件，不是自造的记忆系统，
// 她 11-03 原话「记忆以文件的形式 不要自造记忆系统」），第二天每一轮都放进系统提示（hosted/agent-service/prompts.mjs）。
// 收尾不找人：不受档位和安静时段限制，不算今天的后台次数，也发不了消息（通行证 purpose: close，agent-tools.mjs）。
import {withWorld} from './store.mjs';
import {localClock} from './proactivity.mjs';
import {wake, START_BY_MS, TICK_BUDGET_MS} from './dispatcher.mjs';

const LEASE_MS = 15 * 60_000;        // 一轮收尾最多占这么久，过了还没回来就当收过了（结果不确定，不重跑）
export const MAX_CLOSES_PER_TICK = 2;

// 草稿文案，待确认：收尾那一轮写进 <trigger> 的话。照教材 p.47 对话结尾那句黄金 prompt 的意思写。
export const CLOSE_TEXT = day => `${day} 这一天结束了，这是当天的收尾。没有人在等你回复，这一轮也发不了消息。
把还要接着的事写进 HANDOFF.md，整个文件重写：对方说好要做的事和时间、你答应对方的事、没聊完的话。只留还没结束的，做完或过期的删掉；一件都没有就写「没有」。
这一天学到的稳定事实（目标、什么有效、什么没用）写进 MEMORY.md。
对方说了具体时间要做的事，可以用 schedule_wake 排一次跟进。`;

// 现在该不该给这个人收尾，该的话占住（租约）并返回要收的是哪一天。在 withWorld 里调用：两个 tick 同时跑时，
// 只有先提交的那个占得到，后一个重读后看到 closing 就跳过。
function claimClose(person, now) {
  const day = person.agentDay;
  if (typeof day !== 'string' || person.closedDay === day) return null;
  // 那一天还没过完（按本人现在的时区）。
  if (day >= localClock(person, now).day) return null;
  const running = person.closing;
  if (running && now - running.since <= LEASE_MS) return null;
  if (running) {
    // 上一轮没回来：可能已经写过文件、排过跟进，不重跑，记成结果不确定。
    person.closedDay = running.day;
    person.closing = null;
    person.lastClose = {day: running.day, outcome: 'uncertain', at: new Date(now).toISOString()};
    if (person.closedDay === day) return null;
  }
  person.closing = {day, since: now};
  return {ownerId: person.id, day, since: now};
}

// 一轮收尾回来以后：放掉租约，记下收过了。Agent 服务明确说没开始跑（retryable）的，下一拍再试；
// 其余（成功、出错、超时、那一天没有会话可收）都只试一次，沿用「出错不自动重试」（docs/ARCHITECTURE.md 第 2 节）。
function finishClose(world, claim, result, now) {
  const person = world.people?.[claim.ownerId];
  if (!person || person.closing?.since !== claim.since || person.closing?.day !== claim.day) return;
  person.closing = null;
  if (result.retryable) return;
  person.closedDay = claim.day;
  person.lastClose = {day: claim.day, outcome: result.outcome, at: new Date(now).toISOString()};
}

// 一次 tick 里的收尾（服务器自己的闹钟和 Cloudflare Cron 调，scheduler.mjs，排在后台叫醒后面）。返回开始了几轮。
// startBy / deadline 和 proactive.runProactive 一样，但收尾不急：过了 startBy 一轮也不开始（连第一轮也不），留到下一拍，
// 免得后台叫醒占掉大半拍以后，收尾只剩几秒、被记成结果不确定。
export async function runDayClose({db, secret, service, fetcher = fetch, now = Date.now(), clock = Date.now, startBy, deadline, maxCloses = MAX_CLOSES_PER_TICK}) {
  const began = clock();
  startBy ??= began + START_BY_MS;
  deadline ??= began + TICK_BUDGET_MS;
  let started = 0;
  while (started < maxCloses && clock() < startBy) {
    const claim = await withWorld(db, world => {
      for (const id of Object.keys(world.people || {}).sort()) {
        const found = claimClose(world.people[id], now);
        if (found) return found;
      }
      return null;
    });
    if (!claim) break;
    started++;
    let result;
    try {
      result = await wake({
        db, secret, service, fetcher, now, scope: 'owner', ownerId: claim.ownerId, channel: 'web', background: true,
        purpose: 'close', sessionDate: claim.day,
        timeoutMs: Math.max(5000, Math.min(180_000, deadline - clock())),
        trigger: {kind: 'close', channel: 'system', direct: false, text: CLOSE_TEXT(claim.day)},
      });
    } catch (error) {
      console.error('收尾失败，记为结果不确定：' + (error instanceof Error ? error.message : 'unknown'));
      result = {outcome: 'error', uncertain: true};
    }
    await withWorld(db, world => finishClose(world, claim, result, now));
    // Agent 服务说没开始跑（不可用、排队太多）：这一拍不再打它，下一拍再试。
    if (result.retryable) break;
  }
  return started;
}
