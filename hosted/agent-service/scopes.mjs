// 同一个 Agent 的范围（docs/ARCHITECTURE.md 第 6 节）。代码只有这张表不同，没有几套逻辑。
// 依据：私人资料、不可信内容、对外通道，这三样不同时出现在一轮里。
// research 范围和 Agent 工具在第 4 步加。
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

export const SCOPES = deepFreeze({
  // 有私人资料，对外只能发给本人自己，Bash 没有网络。
  owner: {
    kind: 'owner',
    builtins: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'WebSearch'],
    denied: ['WebFetch', 'Agent'],
    // 只有会写东西的工具；读数据走叫醒前的快照 weave/weave.db（教材 p.16「查数留SQL,不要封成MCP」），
    // 排过的跟进也是（schedules 表），所以没有 list_schedule。
    // set_reminder、set_proactivity 只在有人直接找它的那一轮能用，后台那一轮由工具后端拒绝（设计文档 4.5）。
    tools: ['send_message', 'save_habit', 'log_completion', 'save_goal', 'set_reminder', 'schedule_wake', 'cancel_schedule', 'set_proactivity'],
    skills: ['weave:weekly-review', 'weave:proactive-judgment'],
    circuitBreakerUsd: 2,
    network: 'none',
  },
  // 群消息谁都能写，所以这一轮看不到任何人的私人资料。
  group: {
    kind: 'group',
    builtins: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'],
    denied: ['WebSearch', 'WebFetch', 'Agent'],
    tools: ['send_message'],
    skills: [],
    circuitBreakerUsd: 1,
    network: 'none',
  },
});

export function scopeFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(SCOPES, kind)) throw Error(`不支持的范围：${kind}`);
  return SCOPES[kind];
}
