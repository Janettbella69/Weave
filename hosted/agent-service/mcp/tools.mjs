// Weave 的 MCP 工具（docs/ARCHITECTURE.md 第 4 节）。每个都是薄壳：参数原样转给工具后端，
// 只返回文字（同时返回 structuredContent 时模型看不到文字），失败时 isError 加一句能照做的中文，
// 用 toolUseId 做幂等键。这一轮不给的工具根本不存在，所以按名单现建。
import {randomUUID} from 'node:crypto';
import {tool, createSdkMcpServer} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';

const writes = {readOnlyHint: false, destructiveHint: false, openWorldHint: false};

// 目标的七个类别，顺序和 hosted/lib/weave/habits.mjs 的 GOAL_CATEGORIES 一样。这个服务的镜像里没有 hosted/lib，
// 所以在这里存一份；test/mcp.test.mjs 保证两边一致。
const GOAL_CATEGORIES = ['health', 'relationships', 'finance', 'career', 'interests', 'productivity', 'other'];

// 提醒和跟进能不能重复、档位有哪几档，和设计文档 docs/superpowers/specs/2026-11-03-proactive-wake-design.md 4.8 节一样。
const REMINDER_REPEATS = ['none', 'daily', 'weekly', 'monthly'];
const WAKE_REPEATS = ['none', 'daily', 'weekly'];
const LEVELS = ['off', 'low', 'normal', 'high'];

// 只有会写东西的工具。读数据不封成工具，走叫醒前的快照 weave/weave.db（教材 p.16）；排过的跟进在 schedules 表里。
// 说明文字：log_completion 是文档原文，send_message 和 save_habit 是草稿，待确认。
// 草稿文案，待确认：save_goal 和 save_habit 的 goal_id 说明是设计文档
// docs/superpowers/specs/2026-11-03-frontend-v3-design.md 附录 A-1、A-2 的原文；set_reminder 的说明原来是那边的 A-3。
// 草稿文案，待确认。（第二块）schedule_wake、cancel_schedule、set_proactivity 的说明，set_reminder 改过第一句的说明和
// 新加的 repeat 说明，是设计文档 docs/superpowers/specs/2026-11-03-proactive-wake-design.md 附录 A 第 2 条的草稿。
export const TOOL_DEFS = {
  send_message: {
    description: '说一句话给这一轮的对象。不是有人直接找你的那一轮，只有调用它才有人看得到。收件人由系统决定。',
    shape: {text: z.string().min(1).max(700)},
    annotations: writes,
  },
  save_habit: {
    description: '新建或修改一个习惯的身份句、触发和最小动作。改已有的要带 habit_id。',
    shape: {
      habit_id: z.string().optional(),
      name: z.string().min(1).max(30),
      identity: z.string().max(200).optional(),
      trigger: z.string().max(200).optional(),
      minimum_action: z.string().max(200).optional(),
      goal_id: z.string().optional().describe('这个习惯属于哪个目标。填 weave/weave.db 里 goals 表的 goal_id；不属于任何目标就不填。'),
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
  save_goal: {
    description: '保存或修改对方的一个目标，比如「每天动一动」。新建时不带 goal_id；修改时带上 goal_id，只改给了的字段；archived 设为 true 表示对方不再追踪这个目标。先在聊天里把目标和每天要做的小事说给对方听，对方同意了再调用。category 从这七个里选：health、relationships、finance、career、interests、productivity、other。',
    shape: {
      goal_id: z.string().optional(),
      title: z.string().min(1).max(30).optional(),
      category: z.enum(GOAL_CATEGORIES).optional(),
      archived: z.boolean().optional(),
    },
    annotations: writes,
  },
  set_reminder: {
    description: '在某个时间提醒对方，比如「明天晚上 8 点提醒我给妈妈打电话」；要每天、每周或每月提醒的，填 repeat。due_at 用 ISO 时间，按对方的当地时间换算，必须在将来。先跟对方说清楚什么时候提醒、提醒什么，对方没反对再调用。到点后，提醒会出现在对方的聊天里；对方接了微信的话也会发到微信。',
    shape: {
      text: z.string().min(1).max(500),
      due_at: z.string(),
      repeat: z.enum(REMINDER_REPEATS).optional().describe('不填就是只提醒一次。daily、weekly、monthly 是从 due_at 那次开始，每天、每周、每月在同一个当地时间提醒。'),
    },
    annotations: writes,
  },
  // 到点在后台叫醒自己；时间、条数、后台那一轮只能排一次性的，都由工具后端把关（设计文档 4.5）。
  schedule_wake: {
    description: '给自己排一次跟进：到 at 那个时间，你会在后台被叫醒，看了情况再决定要不要找对方说一句。note 写给自己看：到时候看什么、为什么，比如「她说 18:00 去走路，看看记了没有，没记就轻轻问一句」。at 用 ISO 时间，按对方的当地时间换算，必须在将来、30 天以内，并且在对方允许打扰的时段里。repeat 不填就是只一次；daily、weekly 是每天、每周同一时间。排过的在 weave/weave.db 的 schedules 表里，用不着了就用 cancel_schedule 取消。',
    shape: {
      note: z.string().min(1).max(200),
      at: z.string(),
      repeat: z.enum(WAKE_REPEATS).optional(),
    },
    annotations: writes,
  },
  cancel_schedule: {
    description: '取消一条还没到点的跟进或提醒。schedule_id 填 weave/weave.db 里 schedules 表的 schedule_id，或者 reminders 表的 reminder_id。',
    shape: {schedule_id: z.string().min(1).max(200)},
    annotations: writes,
  },
  set_proactivity: {
    description: '对方说「别主动找我」「少找我一点」「多找我一点」这类话时调用，改 Weave 主动找对方的档位：off 是不主动找（对方让设的提醒照常响），low、normal、high 是越来越多。只在对方亲口说的时候用。',
    shape: {level: z.enum(LEVELS)},
    annotations: writes,
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
