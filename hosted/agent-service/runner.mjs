// 一次唤醒（docs/ARCHITECTURE.md 第 2 节）。这段配置就是 Agent 的全部定义：
// 这一轮调什么工具、调几次、用不用 Skill，全部由模型决定，这里没有别的 Agent 逻辑。
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {systemPromptFor, renderTrigger} from './prompts.mjs';
import {cliEnv} from './providers.mjs';
import {weaveServer} from './mcp/tools.mjs';

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LIMIT_OUTCOMES = ['error_max_budget_usd'];

export async function wake({scope, trigger, memory = '', provider, model, runToken, isolation, rpc, sessionId, queryFn = sdkQuery}) {
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
    ...(sessionId ? {resume: sessionId} : {}),
    // 不设轮数上限（教材 p.22、p.26）；兜底是 maxBudgetUsd 熔断和 10 分钟超时。
    maxBudgetUsd: scope.circuitBreakerUsd,
    thinking: {type: 'disabled'},
    // 失败的工具调用不触发 PostToolUse，要另挂 PostToolUseFailure，审计才不漏（实测）。
    hooks: {PostToolUse: [{hooks: [audit]}], PostToolUseFailure: [{hooks: [audit]}]},
    abortController,
  };

  let last = null, failure = null;
  try {
    // 一直读到结束：后台子 Agent 完成后，同一个 query() 会再出一个 result（实测）。
    for await (const message of queryFn({prompt: renderTrigger(trigger), options})) {
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
