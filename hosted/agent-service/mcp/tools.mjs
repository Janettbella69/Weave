// Weave 的 MCP 工具（docs/ARCHITECTURE.md 第 4 节）。每个都是薄壳：参数原样转给工具后端，
// 只返回文字（同时返回 structuredContent 时模型看不到文字），失败时 isError 加一句能照做的中文，
// 用 toolUseId 做幂等键。这一轮不给的工具根本不存在，所以按名单现建。
import {randomUUID} from 'node:crypto';
import {tool, createSdkMcpServer} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';

const writes = {readOnlyHint: false, destructiveHint: false, openWorldHint: false};
const reads = {readOnlyHint: true, openWorldHint: false};

// 说明文字：log_completion 是文档原文，其余四条是草稿，待确认。
export const TOOL_DEFS = {
  send_message: {
    description: '说一句话给这一轮的对象。不是有人直接找你的那一轮，只有调用它才有人看得到。收件人由系统决定。',
    shape: {text: z.string().min(1).max(700)},
    annotations: writes,
  },
  list_habits: {
    description: '读这个人的习惯：名字、身份句、触发、最小动作。',
    shape: {},
    annotations: reads,
  },
  save_habit: {
    description: '新建或修改一个习惯的身份句、触发和最小动作。改已有的要带 habit_id。',
    shape: {
      habit_id: z.string().optional(),
      name: z.string().min(1).max(30),
      identity: z.string().max(200).optional(),
      trigger: z.string().max(200).optional(),
      minimum_action: z.string().max(200).optional(),
    },
    annotations: writes,
  },
  log_completion: {
    description: '记录用户完成了一次习惯。只记用户明确说做了的，猜测不要记。',
    shape: {
      habit_id: z.string(),
      date: z.string().describe('用户当地日期，YYYY-MM-DD'),
      note: z.string().max(500).optional(),
    },
    annotations: writes,
  },
  query_completions: {
    description: '查这个人在一段日期内的完成记录，返回 JSON，里面带本人当地的今天。',
    shape: {
      from: z.string().describe('YYYY-MM-DD'),
      to: z.string().describe('YYYY-MM-DD'),
      habit_id: z.string().optional(),
    },
    annotations: reads,
  },
};

export const makeHandler = (name, rpc) => async (args, extra) => {
  // SDK 正常都会给 toolUseId（探针实测）；万一没有，就用一次性编号，只是失去重放去重。
  const toolUseId = extra?._meta?.['claudecode/toolUseId'] || 'local-' + randomUUID();
  const out = await rpc(name, args, toolUseId);
  return {isError: !out.ok, content: [{type: 'text', text: out.text}]};
};

export function weaveServer(toolNames, rpc) {
  const tools = toolNames.map(name => {
    if (!Object.hasOwn(TOOL_DEFS, name)) throw Error(`没有这个 weave 工具：${name}`);
    const def = TOOL_DEFS[name];
    return tool(name, def.description, def.shape, makeHandler(name, rpc), {annotations: def.annotations});
  });
  return createSdkMcpServer({name: 'weave', version: '1.0.0', alwaysLoad: true, tools});
}
