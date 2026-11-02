// One source for how the Agent connection is described, used by the header pill and the settings row.
// A hosted Agent needs no test step, so "connected" never depends on whether someone pressed a test button.
export function agentStatus({replying = false, ready = false} = {}) {
  if (replying) return {tone: 'working', label: 'Agent 正在回复…', rowLabel: ready ? '已连接' : '待连接'};
  if (ready) return {tone: 'live', label: 'Agent 已连接', rowLabel: '已连接'};
  return {tone: 'off', label: '连接 Agent', rowLabel: '待连接'};
}
