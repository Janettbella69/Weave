// 同一个 Agent 的范围（docs/ARCHITECTURE.md「内置能力和边界」）。代码只有这张表不同，没有几套逻辑。
// 依据：私人资料、不可信内容、对外通道，这三样不同时出现在一段会话里（教材 p.56〔补〕「断一条腿就够」）。
// 费用的上限在模型代理里（每账号每天的 token 额度，model-proxy.mjs），不在这里：常驻会话没有「一轮」的预算。
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

export const SCOPES = deepFreeze({
  // 有私人资料，对外只能发给本人自己，Bash 没有网络。
  // 记录直接在工作目录的 records.db 里读写（教材 p.16「查数留SQL」、p.28「数据库也是个文件」），所以只有两个工具：
  // 说话（对外，跨系统）和定闹钟（给基础设施的计时器排时间）。
  owner: {
    kind: 'owner',
    builtins: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'WebSearch'],
    denied: ['WebFetch', 'Agent'],
    tools: ['send_message', 'schedule'],
    skills: ['weave:weekly-review'],
    network: 'none',
  },
  // 群消息谁都能写，所以这段会话看不到任何人的私人资料。
  // 群里也能定闹钟（2026-11-16 她问「为啥群里没有 schedule」）：打卡群的助理要能「每晚 9 点提醒大家打卡」。
  // 闹钟在这个群自己工作目录的 records.db 里，不碰任何人的本子；到点只能发回这个群。
  group: {
    kind: 'group',
    builtins: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'],
    denied: ['WebSearch', 'WebFetch', 'Agent'],
    tools: ['send_message', 'schedule'],
    skills: [],
    network: 'none',
  },
});

export function scopeFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(SCOPES, kind)) throw Error(`不支持的范围：${kind}`);
  return SCOPES[kind];
}
