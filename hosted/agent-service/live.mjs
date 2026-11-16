// 常驻会话（docs/ARCHITECTURE.md「一直在线」）：每个人（或每个群）一个一直开着的 Weave。
// SDK 推荐的 streaming input：一个 query() 长期开着，新消息推进同一段会话（SDK 文档：「allows the agent to operate as a long lived
// process」）。空闲一段时间就关掉、会话记录留在磁盘上，下一条消息来了用 resume 接上：部署文档的「混合」方式（Hybrid sessions）。
// 这里的代码只管基础设施（开、关、推消息、记账），不替 Weave 决定任何事：它这一轮调什么工具、说不说话，全由模型决定。
// 系统提示整段会话不变（教材 p.75），新消息只往后追加；太长了由 SDK 自动压缩，压缩前存档原文（教材 p.50「摘要不能取代原始数据」）。
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {appendFile, copyFile, mkdir, readdir, rm, stat} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {systemPromptFor} from './prompts.mjs';
import {cliEnv} from './providers.mjs';
import {weaveServer} from './mcp/tools.mjs';
import {notebookPath} from './notebook.mjs';

export const TURN_TIMEOUT_MS = 10 * 60 * 1000;
// 空闲多久把常驻会话关掉、腾出内存（官方建议每个 Agent 起步按 1 GB 算）。关掉不丢东西：下一条消息来了接着同一段会话。
export const IDLE_MS = 30 * 60 * 1000;
const KEEP_BACKUPS = 30;

// SDK 读的输入：推一条，它就处理一条；end() 以后会话自然结束。
function inbox() {
  const items = [];
  let wake = null, ended = false;
  const poke = () => { wake?.(); wake = null; };
  return {
    push(item) { items.push(item); poke(); },
    end() { ended = true; poke(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (ended) return;
        await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

const zeroUsage = () => ({input: 0, cacheRead: 0, cacheWrite: 0, output: 0});

// 每一轮一行原始日志（教材 p.63「日志从第一版就带,而且是写给AI读的」，p.64「原始日志不许封装……按时间流走」）。
// 放在工作目录外（Agent 改不到），只记发生了什么，不记她说的原话。
async function logTurn(dirs, entry) {
  try { await appendFile(join(dirs.root, 'runs.jsonl'), JSON.stringify(entry) + '\n', {mode: 0o600}); }
  catch (error) { console.error('Agent service: run log not written:', error instanceof Error ? error.message : 'unknown'); }
}

// 她的记录被改之前先备份（教材 p.53：做成 Hook，「他就是百分之百」）。每一轮第一次跑 Bash 前备份一次，留最近 30 份。
async function backupNotebook(dirs, at) {
  const from = notebookPath(dirs);
  if (!(await stat(from).catch(() => null))?.isFile()) return;
  const dir = join(dirs.root, 'backups');
  await mkdir(dir, {recursive: true, mode: 0o700});
  await copyFile(from, join(dir, `records-${new Date(at).toISOString().replace(/[:.]/g, '-')}.db`));
  const old = (await readdir(dir)).filter(name => name.startsWith('records-')).sort();
  for (const name of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await rm(join(dir, name), {force: true});
}

// 压缩前把会话原文存一份（容器里看到的路径换回宿主上的）。
async function archiveTranscript(setup, transcriptPath, at) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return;
  const inside = setup.isolation.configDir;
  const hostPath = inside && transcriptPath.startsWith(inside + '/') ? join(setup.dirs.config, transcriptPath.slice(inside.length + 1)) : transcriptPath;
  await mkdir(setup.dirs.archive, {recursive: true, mode: 0o700});
  await copyFile(hostPath, join(setup.dirs.archive, `${new Date(at).toISOString().replace(/[:.]/g, '-')}-${basename(hostPath)}`));
}

// setup（开会话时要的东西，由 server.mjs 准备）：
//   scope, dirs, provider, model, runToken, isolation, sessionId（上次那段，没有就 null）,
//   handlers(state) -> {send_message(args, toolUseId), schedule(args, toolUseId)}：工具怎么做，按这一轮的 state.current 走。
//   fingerprint：模型、Key 这类会话开着时不能换的东西；变了就关掉重开（接同一段会话）。
//   release()：会话关掉时调（交回模型代理的令牌、删容器）。
export function createLive({queryFn = sdkQuery, now = Date.now, turnTimeoutMs = TURN_TIMEOUT_MS, idleMs = IDLE_MS} = {}) {
  const sessions = new Map();

  function start(key, setup) {
    const input = inbox(), abortController = new AbortController();
    const state = {key, setup, input, abortController, sessionId: setup.sessionId ?? null, lastActive: now(), busy: false, closed: false, current: null, turn: null};
    const audit = async hook => { if (hook?.tool_name && state.turn) state.turn.tools.push(hook.tool_name); return {}; };
    const backup = async () => {
      if (state.turn && !state.turn.backedUp) {
        state.turn.backedUp = true;
        await backupNotebook(setup.dirs, now()).catch(error => console.error('Agent service: notebook backup failed:', error instanceof Error ? error.message : 'unknown'));
      }
      return {};
    };
    const archive = async hook => {
      await archiveTranscript(setup, hook?.transcript_path, now()).catch(error => console.error('Agent service: transcript not archived:', error instanceof Error ? error.message : 'unknown'));
      return {};
    };
    const {isolation, scope} = setup;
    const options = {
      systemPrompt: systemPromptFor(scope),
      tools: [...scope.builtins],
      allowedTools: [...isolation.allowedTools],
      disallowedTools: [...scope.denied],
      permissionMode: 'dontAsk',
      mcpServers: {weave: weaveServer(scope.tools, setup.handlers(state))},
      plugins: [{type: 'local', path: isolation.pluginPath}],
      skills: [...scope.skills],
      // 不读任何文件配置：Agent 改了配置也影响不到自己（探针实测）。
      settingSources: [],
      strictMcpConfig: true,
      settings: {attribution: false},
      cwd: isolation.cwd,
      env: cliEnv({provider: setup.provider, model: setup.model, runToken: setup.runToken, baseUrl: isolation.baseUrl, home: isolation.home, configDir: isolation.configDir, path: isolation.path}),
      ...(isolation.spawnClaudeCodeProcess ? {spawnClaudeCodeProcess: isolation.spawnClaudeCodeProcess} : {}),
      ...(isolation.sandbox ? {sandbox: isolation.sandbox} : {}),
      ...(state.sessionId ? {resume: state.sessionId} : {}),
      thinking: {type: 'disabled'},
      // 失败的工具调用不触发 PostToolUse，要另挂 PostToolUseFailure，审计才不漏（实测）。
      hooks: {
        PreToolUse: [{matcher: 'Bash', hooks: [backup]}],
        PostToolUse: [{hooks: [audit]}],
        PostToolUseFailure: [{hooks: [audit]}],
        PreCompact: [{hooks: [archive]}],
      },
      abortController,
    };
    state.query = queryFn({prompt: input, options});
    state.iterator = state.query[Symbol.asyncIterator]();
    sessions.set(key, state);
    return state;
  }

  async function stop(state) {
    if (sessions.get(state.key) === state) sessions.delete(state.key);
    state.closed = true;
    state.input.end();
    // 等 CLI 自己收尾；10 秒还没完就掐断。
    const drained = (async () => { try { for (;;) { const {done} = await state.iterator.next(); if (done) return; } } catch { /* already gone */ } })();
    const timer = setTimeout(() => state.abortController.abort(), 10_000);
    await drained;
    clearTimeout(timer);
    await state.setup.release?.();
  }

  // 推一条消息，等这一轮做完。同一个 key 的调用方要自己排队（server.mjs 的 queue），这里不并发。
  //   open()   -> setup，只在这个人还没有开着的会话（或要换模型）时调。
  //   message  SDKUserMessage（prompts.mjs 的 userMessage）。
  //   context  这一轮的上下文，工具按它走：{capability, kind, alarmKind?, ...}。
  async function turn(key, {open, fingerprint, message, context, meta = {}}) {
    let state = sessions.get(key);
    if (state && (state.closed || state.setup.fingerprint !== fingerprint)) { await stop(state); state = null; }
    if (!state) state = start(key, await open());
    state.busy = true;
    state.current = context;
    state.turn = {tools: [], usage: zeroUsage(), compactions: [], seen: new Map(), backedUp: false};
    const began = now();
    let result = null, failure = null, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; state.abortController.abort(); }, turnTimeoutMs);
    try {
      state.input.push(message);
      for (;;) {
        const {value, done} = await state.iterator.next();
        if (done) { failure = Error('会话意外结束'); break; }
        if (typeof value?.session_id === 'string') state.sessionId = value.session_id;
        if (value.type === 'assistant' && value.message?.id && value.message.usage) state.turn.seen.set(value.message.id, value.message.usage);
        if (value.type === 'system' && value.subtype === 'compact_boundary') state.turn.compactions.push(value.compact_metadata ?? {});
        if (value.type === 'result') { result = value; break; }
      }
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      state.busy = false;
      state.lastActive = now();
    }
    for (const u of state.turn.seen.values()) {
      state.turn.usage.input += u.input_tokens ?? 0;
      state.turn.usage.cacheRead += u.cache_read_input_tokens ?? 0;
      state.turn.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      state.turn.usage.output += u.output_tokens ?? 0;
    }
    // 出错、超时、会话断了：这段会话关掉（下次用 resume 接上，对话不丢）。出错不自动重试：可能已经说过话。
    const ok = result?.subtype === 'success' && !result.is_error && !failure && !timedOut;
    if (!ok) await stop(state);
    const outcome = ok ? 'success' : timedOut ? 'timeout' : 'error';
    const {usage, tools, compactions} = state.turn;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    await logTurn(state.setup.dirs, {
      at: new Date(began).toISOString(), ms: now() - began, ...meta, kind: context?.kind ?? null, outcome,
      tools, usage, cacheHitRate: prompt ? Math.round((usage.cacheRead / prompt) * 1000) / 1000 : null,
      compactions, sessionId: state.sessionId, sdkCostUsd: result?.total_cost_usd ?? null,
      ...(failure && !timedOut ? {error: failure instanceof Error ? failure.message.slice(0, 200) : 'unknown'} : {}),
    });
    return {outcome, reply: ok && typeof result.result === 'string' ? result.result.trim() : '', sessionId: state.sessionId, tools: [...tools], usage: {...usage}, compactions};
  }

  return {
    turn,
    isLive: key => sessions.has(key),
    isBusy: key => !!sessions.get(key)?.busy,
    sessionIdOf: key => sessions.get(key)?.sessionId ?? null,
    // 关掉空闲太久的（调用方在这个 key 的队列里调，免得关在一轮中间）。
    idleKeys: () => [...sessions.values()].filter(s => !s.busy && now() - s.lastActive > idleMs).map(s => s.key),
    async close(key) { const state = sessions.get(key); if (state && !state.busy) await stop(state); },
    async closeAll() { await Promise.all([...sessions.values()].map(stop)); },
    get size() { return sessions.size; },
  };
}
