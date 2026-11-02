// 叫醒前的数据快照。教材 p.16「查数留SQL,不要封成MCP」；p.20 代码合法的位置之一
// 「Agent启动之前 预处理。不在循环中间,不影响灵活性」。
// Agent 服务每次叫醒前拿这一轮的通行证来取，落成工作目录里的 weave/weave.db，Agent 自己写 SQL 查。
// 写入仍走 MCP 工具（agent-tools.mjs），规则在那边。格式见 docs/ARCHITECTURE.md 第 10 节。
import {Store} from './store.mjs';
import {verifyCapability} from './capability.mjs';
import {localClock} from './proactivity.mjs';

const habitRow = h => ({
  habit_id: h.id, name: h.name, identity: h.identity ?? '', trigger: h.trigger ?? '', minimum_action: h.minimumAction ?? '',
  created_at: h.createdAt ?? null, updated_at: h.updatedAt ?? null,
});
const completionRow = c => ({habit_id: c.habitId, date: c.date, note: c.note ?? '', source: c.source ?? null, created_at: c.createdAt ?? null});

export function snapshotFor(person, claims, now) {
  const snapshot = {version: 1, today: localClock(person, now).day, timezone: person.profile?.timezone ?? null, tables: {}, files: {}};
  // 群那一轮看不到任何人的私人资料；群消息（group_messages）由微信那边填。
  if (claims.scope !== 'owner') return snapshot;
  snapshot.tables.habits = (person.habits || []).map(habitRow);
  snapshot.tables.completions = (person.completions || []).map(completionRow);
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
    return json(snapshotFor(person, claims, now));
  } catch (error) {
    return json({error: error.status ? error.message : '快照暂时取不到'}, error.status || 500);
  }
}
