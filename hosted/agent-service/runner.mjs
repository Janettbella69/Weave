// 一次唤醒（docs/ARCHITECTURE.md 第 2 节）。这段配置就是 Agent 的全部定义：
// 这一轮调什么工具、调几次、用不用 Skill，全部由模型决定，这里没有别的 Agent 逻辑。
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {systemPromptFor, renderTrigger, imageMessage} from './prompts.mjs';
import {cliEnv} from './providers.mjs';
import {weaveServer} from './mcp/tools.mjs';

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LIMIT_OUTCOMES = ['error_max_budget_usd'];

// forkSession：后台那一轮（定时、定期看看）从 sessionId 分叉出一段新会话，原会话不动（设计文档 2026-11-03-proactive-wake-design.md 4.6）。
// SDK 文档原文：fork「creates a new session that starts with a copy of the original's history. The original stays unchanged.」
// 要和 resume 一起用（sdk.d.ts：「Use with `resume`」），所以没有 sessionId 时不设；返回的 sessionId 是分叉出来的那段。
// image：可选，{mediaType, data}（base64），这一轮带的那张照片（微信看图，docs/superpowers/specs/2026-11-03-wechat-images-design.md）。
export async function wake({scope, trigger, memory = '', provider, model, runToken, isolation, rpc, sessionId, forkSession = false, image, queryFn = sdkQuery}) {
  const tools = [];
  const audit = async input => { if (input?.tool_name) tools.push(input.tool_name); return {}; };
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), RUN_TIMEOUT_MS);
  const options = {
    // 不用预设：预设会告诉模型「你是 Claude Code」（实测）。
    systemPrompt: systemPromptFor(scope, memory),
    // 没人在场：不在清单上的直接拒绝，不弹确认。
    tools: [...scope.builtins],
    allowedTools: [...isolation.allowedTools],
    disallowedTools: [...scope.denied],
    permissionMode: 'dontAsk',
    mcpServers: {weave: weaveServer(scope.tools, rpc)},
    plugins: [{type: 'local', path: isolation.pluginPath}],
    skills: [...scope.skills],
    // 不读任何文件配置，Agent 改了配置也影响不到下一轮（实测）。
    settingSources: [],
    strictMcpConfig: true,
    settings: {attribution: false},
    cwd: isolation.cwd,
    env: cliEnv({provider, model, runToken, baseUrl: isolation.baseUrl, home: isolation.home, configDir: isolation.configDir, path: isolation.path}),
    ...(isolation.spawnClaudeCodeProcess ? {spawnClaudeCodeProcess: isolation.spawnClaudeCodeProcess} : {}),
    ...(isolation.sandbox ? {sandbox: isolation.sandbox} : {}),
    ...(sessionId ? {resume: sessionId, ...(forkSession ? {forkSession: true} : {})} : {}),
    // 带照片的一轮不写会话记录：照片不落在这台机器的磁盘上，下一轮接着用叫醒前那段会话（SDK 文档 sessions：
    // persistSession: false「The session exists only in memory for the duration of the call」）。server.mjs 也不动 sessions.json。
    ...(image ? {persistSession: false} : {}),
    // 不设轮数上限（教材 p.22、p.26）；兜底是 maxBudgetUsd 熔断和 10 分钟超时。
    maxBudgetUsd: scope.circuitBreakerUsd,
    thinking: {type: 'disabled'},
    // 失败的工具调用不触发 PostToolUse，要另挂 PostToolUseFailure，审计才不漏（实测）。
    hooks: {PostToolUse: [{hooks: [audit]}], PostToolUseFailure: [{hooks: [audit]}]},
    abortController,
  };

  // 只有文字的一轮照旧传字符串；带照片的一轮用流式输入：一条用户消息，先文字后照片（prompts.mjs 的 imageMessage）。
  const prompt = image ? (async function* () { yield imageMessage(trigger, image); })() : renderTrigger(trigger);
  let last = null, failure = null;
  try {
    // 一直读到结束：后台子 Agent 完成后，同一个 query() 会再出一个 result（实测）。
    for await (const message of queryFn({prompt, options})) {
      if (message.type === 'result') last = message;
    }
  } catch (error) {
    // 预算到了会抛错，这时 last 里有原因（实测）。
    failure = error;
  } finally {
    clearTimeout(timer);
  }

  // 出错不重试：这一轮可能已经发过消息或记过东西。
  let outcome = 'error';
  if (last?.subtype === 'success' && !last.is_error && !failure) outcome = 'success';
  else if (LIMIT_OUTCOMES.includes(last?.subtype)) outcome = last.subtype;
  const reply = outcome === 'success' && trigger.direct && typeof last.result === 'string' ? last.result.trim() : '';
  return {outcome, reply, sessionId: last?.session_id ?? null, tools, costUsd: last?.total_cost_usd ?? 0};
}
