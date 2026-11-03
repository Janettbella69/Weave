// 叫醒前的数据快照。教材 p.16「查数留SQL,不要封成MCP」；p.20 代码合法的位置之一
// 「Agent启动之前 预处理。不在循环中间,不影响灵活性」。
// Agent 服务每次叫醒前拿这一轮的通行证来取，落成工作目录里的 weave/weave.db，Agent 自己写 SQL 查。
// 写入仍走 MCP 工具（agent-tools.mjs），规则在那边。格式见 docs/ARCHITECTURE.md 第 10 节。
import {Store} from './store.mjs';
import {verifyCapability} from './capability.mjs';
import {localClock, GROUP_TIMEZONE} from './proactivity.mjs';
import {groupSnapshotMessages} from './wechat.mjs';

// 列的顺序和 hosted/agent-service/snapshot.mjs 的 TABLES 一一对应；新列只往后加（weekly-review 的 stats.py 按列名读，不受影响）。
const habitRow = h => ({
  habit_id: h.id, name: h.name, identity: h.identity ?? '', trigger: h.trigger ?? '', minimum_action: h.minimumAction ?? '',
  created_at: h.createdAt ?? null, updated_at: h.updatedAt ?? null, goal_id: h.goalId ?? null,
});
const completionRow = c => ({habit_id: c.habitId, date: c.date, note: c.note ?? '', source: c.source ?? null, created_at: c.createdAt ?? null});
// 全部目标，归档的也给（archived 是 0 / 1）；全部提醒，不分状态（scheduled、delivered、cancelled）。
const goalRow = g => ({goal_id: g.id, title: g.title, category: g.category, archived: g.archived ? 1 : 0, created_at: g.createdAt ?? null});
const reminderRow = r => ({reminder_id: r.id, text: r.text, due_at: r.dueAt, status: r.status});

export function snapshotFor(person, claims, now) {
  const owner = claims.scope === 'owner';
  // 群那一轮看不到任何人的私人资料，连开启者在哪个时区也不给；群里的 today 按北京时间（GROUP_TIMEZONE）。
  const clock = owner ? person : {profile: {timezone: GROUP_TIMEZONE}};
  const snapshot = {version: 1, today: localClock(clock, now).day, timezone: owner ? person.profile?.timezone ?? null : null, tables: {}, files: {}};
  if (!owner) return snapshot;
  snapshot.tables.habits = (person.habits || []).map(habitRow);
  snapshot.tables.completions = (person.completions || []).map(completionRow);
  snapshot.tables.goals = (person.goals || []).map(goalRow);
  snapshot.tables.reminders = (person.reminders || []).map(reminderRow);
  return snapshot;
}

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

export async function handleAgentSnapshot(request, {db, secret, now = Date.now()}) {
  try {
    if (request.method !== 'GET') return json({error: '方法不支持'}, 405);
    const auth = request.headers.get('authorization') || '';
    const claims = await verifyCapability(secret, auth.startsWith('Bearer ') ? auth.slice(7) : '', now);
    if (!db) return json({error: '数据库尚未就绪'}, 503);
    const world = await new Store(db).load();
    const person = Object.hasOwn(world.people || {}, claims.owner) ? world.people[claims.owner] : null;
    if (!person) return json({error: '账号不存在'}, 404);
    const snapshot = snapshotFor(person, claims, now);
    // 群那一轮：只有这个群自己的消息（成员编号、文字、时间），由微信那边给。
    if (claims.scope === 'group') snapshot.tables.group_messages = await groupSnapshotMessages(world, {groupId: claims.group, ownerId: claims.owner, secret});
    return json(snapshot);
  } catch (error) {
    return json({error: error.status ? error.message : '快照暂时取不到'}, error.status || 500);
  }
}
