// 只在第一次建本子时用一次：把以前存在网站库里的数据（习惯、打卡、目标、还没结束的提醒和跟进）导进这个人的 records.db
// （notebook.mjs 的 ensureNotebook）。来源是网站的 GET /api/internal/agent/snapshot（agent-snapshot.mjs），按这一条消息的通行证取。
// 以前每次叫醒都要取一份快照、写成只读副本、写后再同步；现在数据就在 Agent 自己的工作目录里，这些都删了。
// 所有人都搬完以后，这个文件和网站那边的接口一起删。
export const TABLES = Object.freeze({
  habits: ['habit_id', 'name', 'identity', 'trigger', 'minimum_action', 'created_at', 'updated_at', 'goal_id'],
  completions: ['habit_id', 'date', 'note', 'source', 'created_at'],
  goals: ['goal_id', 'title', 'category', 'archived', 'created_at'],
  reminders: ['reminder_id', 'text', 'due_at', 'status'],
  schedules: ['schedule_id', 'kind', 'text', 'repeat', 'next_at', 'status', 'created_by', 'last_run_at', 'last_outcome'],
  proactive_settings: ['level', 'active_start', 'active_end', 'check_times', 'message_cap', 'sent_today', 'wake_cap', 'wakes_today'],
  group_messages: ['seq', 'member', 'text', 'at'],
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const cell = value => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw Error('旧数据里的值只能是文字、数字或空');
};

// 只取认识的表和列；不认识的表就说明两边对不上了，宁可这次不导（下次再试），也不导一半。
export function validateLegacy(value) {
  if (!isPlainObject(value) || value.version !== 1) throw Error('旧数据版本不对');
  if (typeof value.today !== 'string' || !DATE.test(value.today)) throw Error('旧数据里的 today 不对');
  if (!isPlainObject(value.tables)) throw Error('旧数据缺少 tables');
  const tables = {};
  for (const [name, rows] of Object.entries(value.tables)) {
    if (!Object.hasOwn(TABLES, name)) throw Error(`旧数据里有不认识的表：${name}`);
    if (!Array.isArray(rows)) throw Error(`旧数据里的 ${name} 不是列表`);
    tables[name] = rows.map(row => {
      if (!isPlainObject(row)) throw Error(`旧数据里的 ${name} 有一行不是对象`);
      return Object.fromEntries(TABLES[name].map(column => [column, cell(row[column])]));
    });
  }
  return {version: 1, today: value.today, tables};
}

export async function fetchLegacy({weaveUrl, capability, fetcher = fetch, timeoutMs = 15000}) {
  const response = await fetcher(`${weaveUrl.replace(/\/+$/, '')}/api/internal/agent/snapshot`, {
    method: 'GET', redirect: 'manual', headers: {Authorization: 'Bearer ' + capability}, signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw Error(`旧数据接口返回 ${response.status}`);
  return validateLegacy(await response.json());
}
