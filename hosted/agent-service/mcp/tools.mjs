// Weave 的 MCP 工具（docs/ARCHITECTURE.md「工具」）。只有两个：
//   send_message  说话：跨系统（微信、网页），参数原样转给网站的工具后端，收件人由那一条消息的通行证决定（薄壳）。
//   schedule      定闹钟：写进这个人本子里的 alarms 表（notebook.mjs），到点由基础设施的计时器把消息推进会话。
// 只返回文字（同时返回 structuredContent 时模型看不到文字）；失败时 isError 加一句能照做的中文（教材 p.38）；用 toolUseId 做幂等键。
// 记录不做工具：Weave 直接用 sqlite3 读写 records.db（教材 p.16「查数留SQL」、p.32「如果它不跟其他的系统互通,那最佳的形式就是代码」）。
import {randomUUID} from 'node:crypto';
import {tool, createSdkMcpServer} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import {REPEATS, ALARM_KINDS} from '../notebook.mjs';

const writes = {readOnlyHint: false, destructiveHint: false, openWorldHint: false};

// 草稿文案，待确认：两个工具的说明。
export const TOOL_DEFS = {
  send_message: {
    description: '把一句话发给对方（在群里就是发到群里）。只有调用它，对方才看得到你说的话；收件人由系统决定。没什么要说的时候就不调用。',
    shape: {text: z.string().min(1).max(700)},
    annotations: writes,
  },
  schedule: {
    description: '给自己定一个闹钟：到 at 那个时间，你会在这段对话里收到一条 kind="alarm" 的消息。note 写给到时候的自己看：要做什么、为什么，比如「她说 18:00 去走路，到时看看记了没有」。对方让你到点提醒的，kind 填 reminder；你自己想回来看看的，填 self。at 用带时区的 ISO 时间，按对方的当地时间，必须在将来。repeat 不填就是只响一次；daily、weekly、monthly 是每天、每周、每月同一个当地钟点。定过的都在 records.db 的 alarms 表里。',
    shape: {
      at: z.string(),
      note: z.string().min(1).max(500),
      kind: z.enum(ALARM_KINDS).optional(),
      repeat: z.enum(REPEATS).optional(),
    },
    annotations: writes,
  },
};

// handlers：{send_message(args, toolUseId), schedule(args)}，都返回 {ok, text}。
export const makeHandler = handle => async (args, extra) => {
  // SDK 正常都会给 toolUseId（探针实测）；万一没有，就用一次性编号，只是失去重放去重。
  const toolUseId = extra?._meta?.['claudecode/toolUseId'] || 'local-' + randomUUID();
  const out = await handle(args, toolUseId);
  return {isError: !out.ok, content: [{type: 'text', text: out.text}]};
};

export function weaveServer(toolNames, handlers) {
  const tools = toolNames.map(name => {
    if (!Object.hasOwn(TOOL_DEFS, name) || typeof handlers[name] !== 'function') throw Error(`没有这个 weave 工具：${name}`);
    const def = TOOL_DEFS[name];
    return tool(name, def.description, def.shape, makeHandler(handlers[name]), {annotations: def.annotations});
  });
  return createSdkMcpServer({name: 'weave', version: '1.0.0', alwaysLoad: true, tools});
}
