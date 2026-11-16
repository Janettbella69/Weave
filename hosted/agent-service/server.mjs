// Agent 服务（docs/ARCHITECTURE.md）：全仓库唯一调用 query() 的地方。每个人（或每个群）一个一直开着的 Weave（live.mjs）。
//   POST /message          往一个人（或群）的那段会话里推一条消息。wait: true 等这一轮做完再回（网页聊天，她在等）；
//                          否则马上回 202，做完了向网站回报结果（微信、闹钟：没有谁挂着等，教材 p.61、p.75「延迟预算」）。
//   POST /tick             网站的闹钟每分钟一次，带上要看的人和群（各自这一分钟的通行证）：到点的闹钟、该来的心跳推进各自的会话。
//   POST /notebook/read    网页读这个人的本子（records.db）。
//   POST /notebook/check   网页给习惯打勾、取消。
//   POST /notebook/cancel-alarm  网页取消一个闹钟。
//   POST /memory           网页读这个人的记忆文件（SDK 自带的记忆目录）。
//   POST /forget           注销或关群：关掉会话，删掉工作目录和会话记录。
//   GET  /health
// 模型代理也在这个进程里：docker 模式监听 Unix socket（挂进容器），本机模式监听 127.0.0.1 随机端口。
// 服务器自己的闹钟也在这里：每隔 AGENT_TICK_SECONDS 秒 POST 一次网站的 /api/internal/tick（createTicker）。
import http from 'node:http';
import {timingSafeEqual, createHash, randomUUID} from 'node:crypto';
import {mkdir, chmod, rm, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {query} from '@anthropic-ai/claude-agent-sdk';
import {scopeFor} from './scopes.mjs';
import {providerFor, modelAllowed, canonicalModel, canSeeImages} from './providers.mjs';
import {userMessage, reminderAlarmText, selfAlarmText, lateText, heartbeatText, KINDS} from './prompts.mjs';
import {createLedger} from './ledger.mjs';
import {createModelProxy} from './model-proxy.mjs';
import {toolBackend} from './mcp/rpc.mjs';
import {isolationFor, removeContainer} from './sandbox.mjs';
import {createLive} from './live.mjs';
import {createRunQueue} from './queue.mjs';
import {checkImage, IMAGE_MAX_BASE64} from './images.mjs';
import * as workspace from './workspace.mjs';
import {ensureNotebook, readNotebook, setCompletion, addAlarm, dueAlarms, markFired, cancelAlarm, localISO} from './notebook.mjs';
import {fetchLegacy} from './legacy-import.mjs';

const PLUGIN_DIR = fileURLToPath(new URL('./plugin', import.meta.url));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const digest = value => createHash('sha256').update(value).digest();
// /message 可能带一张照片（base64），所以只给它多留出一张照片的大小；别的接口 64 KiB。/tick 带很多人的通行证，给 1 MiB。
const JSON_LIMIT = 64 * 1024, MESSAGE_LIMIT = JSON_LIMIT + IMAGE_MAX_BASE64, TICK_LIMIT = 1024 * 1024;
const fail = (status, message) => { throw Object.assign(Error(message), {status}); };
// 心跳多久一次、白天哪几个钟点给（她当地时间）：省钱的基础设施设置，和 OpenClaw 的 activeHours 一样；说不说由 Weave 定。
export const HEARTBEAT = Object.freeze({everyMs: 30 * 60 * 1000, from: '07:00', to: '23:00'});
const LATE_MS = 5 * 60 * 1000;
const WEEKDAYS = '日一二三四五六';

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, '请求过长');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    fail(400, '需要 JSON 对象');
  }
}

function checkScope(input) {
  try { return scopeFor(input.scope); } catch { fail(400, '范围无效'); }
  return null;
}
const checkId = id => { if (typeof id !== 'string' || !id || id.length > 200) fail(400, 'id 无效'); };
const checkCapability = c => { if (typeof c !== 'string' || !c || c.length > 4096) fail(400, '通行证无效'); };
const checkTimezone = tz => {
  if (typeof tz !== 'string' || !tz) fail(400, '时区无效');
  try { new Intl.DateTimeFormat('en-US', {timeZone: tz}); } catch { fail(400, '时区无效'); }
};

// 这个人（或群）用哪个模型。会话开着的时候不能换：换了就关掉重开，接着同一段会话（live.mjs 的 fingerprint）。
function checkModel(input) {
  let provider;
  try { provider = providerFor(input.provider); } catch { fail(400, '模型提供方无效'); }
  if (!modelAllowed(provider, input.model)) fail(400, '模型无效');
  if (input.userKey !== undefined && (typeof input.userKey !== 'string' || input.userKey.length < 12 || input.userKey.length > 512 || /\s/.test(input.userKey))) fail(400, 'Key 无效');
  return {provider, model: canonicalModel(provider, input.model), userKey: input.userKey};
}

function checkMessage(input) {
  const scope = checkScope(input);
  checkId(input.id);
  checkCapability(input.capability);
  const m = input.message;
  if (!m || typeof m !== 'object' || typeof m.text !== 'string' || m.text.length > 20000) fail(400, '消息无效');
  if (!KINDS.includes(m.kind)) fail(400, '消息无效');
  try { userMessage(m); } catch { fail(400, '消息无效'); }
  if (input.alarmKind !== undefined && !['reminder', 'self'].includes(input.alarmKind)) fail(400, '消息无效');
  if (input.ref !== undefined && (typeof input.ref !== 'string' || input.ref.length > 200)) fail(400, 'ref 无效');
  const model = checkModel(input);
  let image;
  if (input.image !== undefined) {
    try { image = checkImage(input.image); } catch { fail(400, '照片无效'); }
  }
  return {scope, ...model, image};
}

// 当地时间写成「11月17日（周二）19:30」。
function label(ms, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'})
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return `${p.month}月${p.day}日（周${WEEKDAYS[weekday]}）${p.hour}:${p.minute}`;
}
const minuteOf = (ms, timezone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
};
const toMinutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const TICK_TIMEOUT_MS = 170_000;
const TICK_LOG_EVERY_MS = 10 * 60 * 1000;
// setInterval 超过这个数会悄悄改成 1 毫秒一次。
const MAX_TIMER_MS = 2 ** 31 - 1;

// 服务器自己的闹钟：每隔一段时间 POST 一次网站的 /api/internal/tick。网站那边收微信、再把要看的人和群发回 /tick。
// 上一次没回来就跳过这一拍；失败只记第一次，之后最多 10 分钟记一行，只写状态码或错误名，不写正文和令牌。
export function createTicker({weaveUrl, token, fetcher = fetch, now = Date.now}) {
  const url = `${weaveUrl.replace(/\/+$/, '')}/api/internal/tick`;
  let busy = false, stopped = false, loggedAt = -Infinity, controller = null;
  const failed = reason => {
    const at = now();
    if (stopped || at - loggedAt < TICK_LOG_EVERY_MS) return;
    loggedAt = at;
    console.error('Agent service: tick failed:', reason);
  };
  async function beat() {
    if (busy || stopped) return;
    busy = true;
    controller = new AbortController();
    try {
      const response = await fetcher(url, {
        method: 'POST', redirect: 'manual',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
        body: '{}',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TICK_TIMEOUT_MS)]),
      });
      response.body?.cancel().catch(() => {});
      if (response.status !== 200) failed(`HTTP ${response.status}`);
    } catch (error) {
      failed(error?.name || 'Error');
    } finally {
      busy = false;
      controller = null;
    }
  }
  return {beat, stop() { stopped = true; controller?.abort(); }};
}

export async function createAgentService({
  token, dataDir, isolation = 'docker', image = 'weave-agent:0.3.325', weaveUrl, keys = {}, upstreams,
  limits = {perAccount: 400000, total: 6000000}, maxConcurrent = 3, pluginDir = PLUGIN_DIR, sandbox = true,
  fetcher = fetch, queryFn = query, host = '127.0.0.1', port = 0, containerMemory = '1g', tickEveryMs = 0,
  heartbeat = HEARTBEAT, idleMs, now = Date.now,
  uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000,
}) {
  if (typeof token !== 'string' || token.length < 32) throw Error('请配置至少32字符的 AGENT_SERVICE_TOKEN');
  if (!['docker', 'local'].includes(isolation)) throw Error(`不支持的隔离方式：${isolation}`);
  if (!/^\d+[kmg]$/i.test(containerMemory)) throw Error(`AGENT_CONTAINER_MEMORY 写成 768m、1g 这样：${containerMemory}`);
  if (!Number.isInteger(tickEveryMs) || tickEveryMs < 0 || tickEveryMs > MAX_TIMER_MS) throw Error(`AGENT_TICK_SECONDS 写成 0 到 ${Math.floor(MAX_TIMER_MS / 1000)} 之间的整数，0 是关掉`);
  await mkdir(dataDir, {recursive: true, mode: 0o700});
  const ledger = createLedger({file: join(dataDir, 'usage.json')});
  const proxy = createModelProxy({keys, upstreams, ledger, limits, fetcher});
  const proxyServer = http.createServer(proxy.handler);
  let proxyInfo;
  if (isolation === 'docker') {
    const socketDir = join(dataDir, 'run'), socketPath = join(socketDir, 'proxy.sock');
    await mkdir(socketDir, {recursive: true, mode: 0o700});
    await rm(socketPath, {force: true});
    await new Promise((ok, bad) => proxyServer.once('error', bad).listen(socketPath, ok));
    // 容器用同一个 uid 运行（--user），所以只给这个用户读写。
    await chmod(socketPath, 0o600);
    proxyInfo = {socketDir};
  } else {
    await new Promise(ok => proxyServer.listen(0, '127.0.0.1', ok));
    proxyInfo = {url: `http://127.0.0.1:${proxyServer.address().port}`};
  }
  const queue = createRunQueue({maxConcurrent});
  const live = createLive({queryFn, now, ...(idleMs ? {idleMs} : {})});
  // CLI 看到的工作目录：容器里是 /workspace，本机开发是宿主上的路径（SDK 记忆目录的名字跟着它，workspace.mjs）。
  const cwdFor = dirs => isolation === 'docker' ? '/workspace' : dirs.workspace;

  // 第一次用这个空间时：建本子（本人的从网站导入以前的数据，只这一次）；以前的 MEMORY.md 挪进 SDK 的记忆目录。
  async function ready(scope, id, capability) {
    const dirs = workspace.scopeDirs(dataDir, scope.kind, id);
    await workspace.prepare(dirs);
    await workspace.moveOldMemory(dirs, cwdFor(dirs));
    const legacy = scope.kind === 'owner' && capability && weaveUrl ? () => fetchLegacy({weaveUrl, capability, fetcher}) : undefined;
    await ensureNotebook(dirs, {legacy});
    return dirs;
  }

  // 一个人（或群）的会话开起来时要的东西（live.mjs）。工具按这一条消息的上下文（state.current）走。
  function setupFor({scope, id, dirs, provider, model, userKey, fingerprint}) {
    const name = 'weave-live-' + randomUUID().replaceAll('-', '').slice(0, 12);
    const runIsolation = isolationFor({mode: isolation, scope, dirs, pluginDir, proxy: proxyInfo, image, name, uid, gid, sandbox, memory: containerMemory});
    const run = proxy.openRun({account: id, provider: provider.name, model, userKey});
    return workspace.sessionFor(dirs).then(sessionId => ({
      scope, dirs, provider, model, runToken: run.token, isolation: runIsolation, sessionId, fingerprint,
      handlers: state => ({
        send_message: (args, toolUseId) => toolBackend({weaveUrl, capability: state.current.capability, turn: {kind: state.current.kind, ...(state.current.alarmKind ? {alarmKind: state.current.alarmKind} : {})}, fetcher})('send_message', args, toolUseId),
        schedule: async args => {
          try { return {ok: true, text: JSON.stringify({alarm: addAlarm(dirs, {...args, now: now()})})}; }
          catch (error) { if (error.status === 400) return {ok: false, text: error.message}; throw error; }
        },
      }),
      async release() {
        run.close();
        if (isolation === 'docker') await removeContainer(name);
      },
    }));
  }

  // 推一条消息进这个人（或群）的会话，等这一轮做完。同一个 key 排队，不同的人并行（queue.mjs）。
  function deliver({scope, id, capability, message, image, alarmKind, provider, model, userKey}) {
    const key = `${scope.kind}:${id}`;
    return queue.run(key, async () => {
      if (!weaveUrl) fail(503, 'Agent 服务没有配置 WEAVE_API_URL');
      if (isolation === 'docker' && uid === 0) fail(503, '请用非 root 用户运行 Agent 服务');
      if (!userKey && !keys[provider.name]) fail(503, `没有 ${provider.name} 的模型 Key`);
      let dirs;
      try { dirs = await ready(scope, id, capability); }
      catch (error) { console.error('Agent service: workspace not ready:', error instanceof Error ? error.message : 'unknown'); fail(503, '这个人的本子暂时没准备好'); }
      // 看不了图的模型：照片不发，告诉它有一张照片它看不了（草稿文案，待确认）。
      const see = image && canSeeImages(provider, model);
      const text = image && !see ? message.text + '\n（对方发来一张照片，但现在用的模型看不了图。）' : message.text;
      const fingerprint = [provider.name, model, userKey ? createHash('sha256').update(userKey).digest('hex').slice(0, 12) : ''].join('|');
      const result = await live.turn(key, {
        open: () => setupFor({scope, id, dirs, provider, model, userKey, fingerprint}),
        fingerprint,
        message: userMessage({...message, text}, see ? image : undefined),
        context: {capability, kind: message.kind, ...(alarmKind ? {alarmKind} : {})},
        meta: {scope: scope.kind, channel: message.channel},
      });
      if (result.sessionId) await workspace.saveSession(dirs, result.sessionId);
      return result;
    });
  }

  // 没人等的那一轮做完以后，告诉网站结果：她发来的话没处理成、又什么都没发出去时，网站如实告诉她（基础设施的报错）。
  async function report({capability, ref, kind}, outcome) {
    try {
      const response = await fetcher(`${weaveUrl.replace(/\/+$/, '')}/api/internal/agent/outcome`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + capability},
        body: JSON.stringify({outcome, kind, ...(ref ? {ref} : {})}),
      });
      response.body?.cancel().catch(() => {});
    } catch (error) {
      console.error('Agent service: outcome not reported:', error instanceof Error ? error.name : 'unknown');
    }
  }

  async function handleMessage(input) {
    const checked = checkMessage(input);
    const job = {...checked, id: input.id, capability: input.capability, message: input.message, alarmKind: input.alarmKind};
    if (input.wait === true) {
      const result = await deliver(job);
      return {outcome: result.outcome, reply: result.reply, tools: result.tools, sessionId: result.sessionId};
    }
    deliver(job)
      .then(result => report({capability: input.capability, ref: input.ref, kind: input.message.kind}, result.outcome))
      .catch(error => report({capability: input.capability, ref: input.ref, kind: input.message.kind}, error?.status === 429 ? 'busy' : 'unavailable'));
    return {status: 202, body: {accepted: true}};
  }

  // 心跳：上一次之后过了 everyMs，而且在她当地的白天钟点里。上一次的时间记在工作目录外，重启后不会一下子补很多次。
  const heartbeatFile = dirs => join(dirs.root, 'heartbeat.json');
  async function heartbeatDue(dirs, at, timezone) {
    const minute = minuteOf(at, timezone);
    if (minute < toMinutes(heartbeat.from) || minute >= toMinutes(heartbeat.to)) return false;
    let last = 0;
    try { last = JSON.parse(await readFile(heartbeatFile(dirs), 'utf8')).at || 0; } catch { /* first time */ }
    return at - last >= heartbeat.everyMs;
  }

  // 网站的闹钟：到点的闹钟先响（一个闹钟一条消息），再看要不要心跳（只给本人）。都推进各自的那段会话，不等它们做完。
  async function handleTick(input) {
    if (!Array.isArray(input.entries) || input.entries.length > 1000) fail(400, 'entries 无效');
    const jobs = [];
    for (const entry of input.entries) {
      const scope = checkScope(entry);
      checkId(entry.id);
      checkCapability(entry.capability);
      checkTimezone(entry.timezone);
      jobs.push({scope, entry, ...checkModel(entry)});
    }
    for (const job of jobs) fire(job).catch(error => console.error('Agent service: tick entry failed:', error instanceof Error ? error.message : 'unknown'));
    return {status: 202, body: {accepted: jobs.length}};
  }

  async function fire({scope, entry, provider, model, userKey}) {
    const {id, capability, timezone} = entry;
    const dirs = await ready(scope, id, capability);
    const at = now(), base = {scope, id, capability, provider, model, userKey};
    // 先记成响过，再推消息：同一个闹钟最多响一次（推的时候出错不重来，和「出错不自动重试」一致）。
    for (const alarm of dueAlarms(dirs, at)) {
      markFired(dirs, alarm, {now: at, timezone});
      const late = at - Date.parse(alarm.at);
      const text = (alarm.kind === 'reminder' ? reminderAlarmText(alarm.note) : selfAlarmText(alarm.note)) + (late > LATE_MS ? lateText(label(Date.parse(alarm.at), timezone), Math.round(late / 60000)) : '');
      const message = {kind: 'alarm', channel: 'system', at: localISO(at, timezone), text};
      deliver({...base, message, alarmKind: alarm.kind})
        .then(result => report({capability, kind: 'alarm'}, result.outcome))
        .catch(error => report({capability, kind: 'alarm'}, error?.status === 429 ? 'busy' : 'unavailable'));
    }
    if (scope.kind === 'owner' && entry.heartbeat === true && await heartbeatDue(dirs, at, timezone)) {
      await writeFile(heartbeatFile(dirs), JSON.stringify({at}), {mode: 0o600});
      const message = {kind: 'heartbeat', channel: 'system', at: localISO(at, timezone), text: heartbeatText(label(at, timezone))};
      deliver({...base, message})
        .then(result => report({capability, kind: 'heartbeat'}, result.outcome))
        .catch(error => report({capability, kind: 'heartbeat'}, error?.status === 429 ? 'busy' : 'unavailable'));
    }
  }

  // 网页读本子。第一次读时也会建本子（从网站导入以前的数据），所以要这个人的通行证。
  async function handleNotebook(path, input) {
    checkId(input.id);
    checkCapability(input.capability);
    const scope = scopeFor('owner');
    return queue.run(`owner:${input.id}`, async () => {
      let dirs;
      try { dirs = await ready(scope, input.id, input.capability); }
      catch { fail(503, '这个人的本子暂时没准备好'); }
      if (path === '/notebook/read') {
        if (input.since !== undefined && (typeof input.since !== 'string' || !DATE.test(input.since))) fail(400, 'since 无效');
        return readNotebook(dirs, {since: input.since ?? ''});
      }
      if (path === '/notebook/check') {
        if (typeof input.habitId !== 'string' || !input.habitId || typeof input.date !== 'string' || !DATE.test(input.date) || typeof input.done !== 'boolean') fail(400, '参数无效');
        const out = setCompletion(dirs, {habitId: input.habitId, date: input.date, done: input.done, now: now()});
        if (!out) fail(404, '没有这个习惯');
        return {completion: out};
      }
      if (typeof input.alarmId !== 'string' || !input.alarmId) fail(400, '参数无效');
      if (!cancelAlarm(dirs, input.alarmId)) fail(404, '没有这个闹钟，或者它已经结束了');
      return {ok: true};
    });
  }

  // 本人在网页上看 Weave 记了什么（她 11-03：按文件显示，文件名 + 原文，只读）。
  async function handleMemory(input) {
    const scope = checkScope(input);
    if (scope.kind !== 'owner') fail(400, '范围无效');
    checkId(input.id);
    const dirs = workspace.scopeDirs(dataDir, 'owner', input.id);
    return {files: await workspace.readMemoryFiles(dirs, cwdFor(dirs))};
  }

  async function handleForget(input) {
    const scope = checkScope(input);
    checkId(input.id);
    const key = `${scope.kind}:${input.id}`;
    await queue.run(key, async () => {
      await live.close(key);
      await workspace.forget(dataDir, scope.kind, input.id);
    });
    return {ok: true};
  }

  const ROUTES = {
    '/message': [MESSAGE_LIMIT, handleMessage],
    '/tick': [TICK_LIMIT, handleTick],
    '/notebook/read': [JSON_LIMIT, input => handleNotebook('/notebook/read', input)],
    '/notebook/check': [JSON_LIMIT, input => handleNotebook('/notebook/check', input)],
    '/notebook/cancel-alarm': [JSON_LIMIT, input => handleNotebook('/notebook/cancel-alarm', input)],
    '/memory': [JSON_LIMIT, handleMemory],
    '/forget': [JSON_LIMIT, handleForget],
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); };
    const path = new URL(req.url, 'http://agent').pathname;
    if (path === '/health' && req.method === 'GET') return reply(200, {ok: true, live: live.size});
    if (req.method !== 'POST' || !Object.hasOwn(ROUTES, path)) return reply(404, {error: '未找到'});
    if (!timingSafeEqual(digest(req.headers.authorization || ''), digest('Bearer ' + token))) return reply(401, {error: '未授权'});
    try {
      const [limit, handle] = ROUTES[path];
      const out = await handle(await readJson(req, limit));
      if (out && typeof out.status === 'number' && out.body) return reply(out.status, out.body);
      return reply(200, out);
    } catch (error) {
      if (error.status) return reply(error.status, {error: error.message});
      console.error('Agent service error:', error instanceof Error ? error.message : 'unknown');
      return reply(500, {error: 'Agent 服务内部错误'});
    }
  });
  await new Promise(ok => server.listen(port, host, ok));

  // 空闲太久的会话关掉，腾出内存；关在这个人的队列里，不会关在一轮中间。
  const reaper = setInterval(() => {
    for (const key of live.idleKeys()) queue.run(key, () => live.close(key)).catch(() => {});
  }, 60_000);
  reaper.unref();
  // 能接 /message 了再开始敲：网站那边会回头调这里的 /tick。默认关（0），只有入口按 AGENT_TICK_SECONDS 打开。
  const ticker = tickEveryMs > 0 && weaveUrl ? createTicker({weaveUrl, token, fetcher}) : null;
  const tickTimer = ticker ? setInterval(ticker.beat, tickEveryMs) : null;
  // 闹钟本身不让进程一直活着。
  tickTimer?.unref();

  return {
    server,
    url: `http://${host}:${server.address().port}`,
    live,
    async close() {
      clearInterval(tickTimer);
      clearInterval(reaper);
      ticker?.stop();
      await live.closeAll();
      server.closeAllConnections(); proxyServer.closeAllConnections();
      await Promise.all([new Promise(r => server.close(r)), new Promise(r => proxyServer.close(r))]);
    },
  };
}

const count = (value, fallback) => { const n = Number(value); return value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : fallback; };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const isolation = env.AGENT_ISOLATION || 'docker';
  const tickSeconds = count(env.AGENT_TICK_SECONDS, 60);
  const service = await createAgentService({
    token: env.AGENT_SERVICE_TOKEN,
    dataDir: resolve(env.AGENT_DATA_DIR || './data'),
    isolation,
    image: env.AGENT_IMAGE || 'weave-agent:0.3.325',
    weaveUrl: env.WEAVE_API_URL,
    keys: {deepseek: env.DEEPSEEK_API_KEY || env.AGENT_PROVIDER_API_KEY || '', kimi: env.KIMI_API_KEY || '', glm: env.GLM_API_KEY || '', qwen: env.QWEN_API_KEY || ''},
    limits: {perAccount: count(env.AGENT_DAILY_TOKENS_PER_ACCOUNT, 400000), total: count(env.AGENT_DAILY_TOKENS_TOTAL, 6000000)},
    maxConcurrent: count(env.AGENT_MAX_CONCURRENCY, 3) || 3,
    containerMemory: env.AGENT_CONTAINER_MEMORY || '1g',
    // 每隔几秒敲一次网站的 /api/internal/tick（服务器自己的闹钟），默认 60，0 是关掉。
    tickEveryMs: tickSeconds * 1000,
    // 服务本身跑在容器里时，插件要放在宿主机看得到的路径上（见 Dockerfile 的入口脚本）。
    ...(env.AGENT_PLUGIN_DIR ? {pluginDir: env.AGENT_PLUGIN_DIR} : {}),
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT) || 4320,
  });
  console.log(`Weave Agent service started on ${service.url} (isolation: ${isolation}, tick: ${tickSeconds && env.WEAVE_API_URL ? `every ${tickSeconds}s` : 'off'})`);
  if (isolation === 'local') console.warn('AGENT_ISOLATION=local 只用于本机开发：Bash 靠 SDK 的 sandbox 隔离，没有容器。');
}
