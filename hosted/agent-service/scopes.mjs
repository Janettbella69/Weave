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
    tools: ['send_message', 'list_habits', 'save_habit', 'log_completion', 'query_completions'],
    skills: ['weave:weekly-review'],
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
