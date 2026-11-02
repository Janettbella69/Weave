// Agent 服务（docs/ARCHITECTURE.md 第 1、11 节）：全仓库唯一调用 query() 的地方。
//   POST /wake    叫醒一轮。Weave 服务决定该不该叫醒，醒了做什么由 Agent 自己决定。
//   POST /forget  注销时删掉这个人的工作目录和会话记录。
//   POST /memory  读本人的 MEMORY.md，给网页看。
//   GET  /health
//   POST /query   旧路，第 2 步删（runtime.mjs）。
// 模型代理也在这个进程里：docker 模式监听 Unix socket（挂进容器），本机模式监听 127.0.0.1 随机端口。
import http from 'node:http';
import {timingSafeEqual, createHash, randomUUID} from 'node:crypto';
import {mkdir, chmod, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {query} from '@anthropic-ai/claude-agent-sdk';
import {runAgent} from './runtime.mjs';
import {scopeFor} from './scopes.mjs';
import {providerFor, modelAllowed} from './providers.mjs';
import {renderTrigger} from './prompts.mjs';
import {createLedger} from './ledger.mjs';
import {createModelProxy} from './model-proxy.mjs';
import {toolBackend} from './mcp/rpc.mjs';
import {isolationFor} from './sandbox.mjs';
import {wake} from './runner.mjs';
import {createRunQueue} from './queue.mjs';
import * as workspace from './workspace.mjs';
import {fetchSnapshot, writeSnapshot, mirroringRpc} from './snapshot.mjs';

const PLUGIN_DIR = fileURLToPath(new URL('./plugin', import.meta.url));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const digest = value => createHash('sha256').update(value).digest();
const fail = (status, message) => { throw Object.assign(Error(message), {status}); };

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

function checkWake(input) {
  const scope = checkScope(input);
  checkId(input.id);
  if (typeof input.capability !== 'string' || !input.capability || input.capability.length > 4096) fail(400, '通行证无效');
  if (typeof input.localDate !== 'string' || !DATE.test(input.localDate)) fail(400, '当地日期无效');
  if (!input.trigger || typeof input.trigger !== 'object' || typeof input.trigger.text !== 'string' || input.trigger.text.length > 20000) fail(400, 'trigger 无效');
  try { renderTrigger(input.trigger); } catch { fail(400, 'trigger 无效'); }
  let provider;
  try { provider = providerFor(input.provider); } catch { fail(400, '模型提供方无效'); }
  if (!modelAllowed(provider, input.model)) fail(400, '模型无效');
  if (input.userKey !== undefined && (typeof input.userKey !== 'string' || input.userKey.length < 12 || input.userKey.length > 512 || /\s/.test(input.userKey))) fail(400, 'Key 无效');
  return {scope, provider};
}

export async function createAgentService({
  token, dataDir, isolation = 'docker', image = 'weave-agent:0.3.316', weaveUrl, keys = {}, upstreams,
  limits = {perAccount: 400000, total: 6000000}, maxConcurrent = 3, pluginDir = PLUGIN_DIR, sandbox = true,
  fetcher = fetch, queryFn = query, host = '127.0.0.1', port = 0, containerMemory = '1g',
  uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000,
}) {
  if (typeof token !== 'string' || token.length < 32) throw Error('请配置至少32字符的 AGENT_SERVICE_TOKEN');
  if (!['docker', 'local'].includes(isolation)) throw Error(`不支持的隔离方式：${isolation}`);
  if (!/^\d+[kmg]$/i.test(containerMemory)) throw Error(`AGENT_CONTAINER_MEMORY 写成 768m、1g 这样：${containerMemory}`);
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
  let legacyActive = 0;

  async function handleWake(input) {
    const {scope, provider} = checkWake(input);
    if (!weaveUrl) fail(503, 'Agent 服务没有配置 WEAVE_API_URL');
    if (isolation === 'docker' && uid === 0) fail(503, '请用非 root 用户运行 Agent 服务');
    if (!input.userKey && !keys[provider.name]) fail(503, `没有 ${provider.name} 的模型 Key`);
    return queue.run(`${scope.kind}:${input.id}`, async () => {
      const dirs = workspace.scopeDirs(dataDir, scope.kind, input.id);
      await workspace.prepare(dirs);
      // 叫醒前把数据写进工作目录（教材 p.16、p.20）。取不到就不醒：回 503，dispatcher 当成「没有处理」。
      let dbPath;
      try {
        ({dbPath} = await writeSnapshot(dirs, await fetchSnapshot({weaveUrl, capability: input.capability, fetcher})));
      } catch (error) {
        console.error('Agent service: snapshot unavailable:', error instanceof Error ? error.message : 'unknown');
        fail(503, '取不到 Weave 的数据快照，这一轮没有叫醒');
      }
      const memory = await workspace.readMemory(dirs);
      const sessionId = await workspace.sessionFor(dirs, input.localDate);
      const run = proxy.openRun({account: input.id, provider: provider.name, model: input.model, userKey: input.userKey});
      const name = 'weave-run-' + randomUUID().replaceAll('-', '').slice(0, 12);
      try {
        const result = await wake({
          scope, trigger: input.trigger, memory, provider, model: input.model, runToken: run.token, sessionId, queryFn,
          isolation: isolationFor({mode: isolation, scope, dirs, pluginDir, proxy: proxyInfo, image, name, uid, gid, sandbox, memory: containerMemory}),
          rpc: mirroringRpc(toolBackend({weaveUrl, capability: input.capability, fetcher}), dbPath),
        });
        // 出错的那段会话可能停在半路，下次重新开一段，靠 MEMORY.md 带过去。
        if (result.outcome === 'success' && result.sessionId) await workspace.saveSession(dirs, input.localDate, result.sessionId);
        else await workspace.clearSession(dirs);
        return {outcome: result.outcome, reply: result.reply, sessionId: result.sessionId, tools: result.tools};
      } finally {
        run.close();
        if (isolation === 'docker') execFile('docker', ['rm', '-f', name], () => {});
      }
    });
  }

  // 本人在网页上看 Agent 记了什么（docs/ARCHITECTURE.md 第 10 节：MEMORY.md 本人可看）。只读，只给 owner。
  async function handleMemory(input) {
    const scope = checkScope(input);
    if (scope.kind !== 'owner') fail(400, '范围无效');
    checkId(input.id);
    return {text: await workspace.readMemory(workspace.scopeDirs(dataDir, 'owner', input.id))};
  }

  async function handleForget(input) {
    const scope = checkScope(input);
    checkId(input.id);
    await queue.run(`${scope.kind}:${input.id}`, () => workspace.forget(dataDir, scope.kind, input.id));
    return {ok: true};
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); };
    const path = new URL(req.url, 'http://agent').pathname;
    if (path === '/health' && req.method === 'GET') return reply(200, {ok: true});
    if (req.method !== 'POST' || !['/wake', '/forget', '/memory', '/query'].includes(path)) return reply(404, {error: '未找到'});
    if (!timingSafeEqual(digest(req.headers.authorization || ''), digest('Bearer ' + token))) return reply(401, {error: '未授权'});
    if (path === '/query') {
      if (legacyActive >= 4) return reply(429, {error: 'Agent 服务繁忙'});
      legacyActive++;
      try { return reply(200, {output: await runAgent(await readJson(req, 32000), queryFn)}); }
      catch { return reply(502, {error: 'Agent 生成失败，请重试'}); }
      finally { legacyActive--; }
    }
    try {
      const input = await readJson(req, 64 * 1024);
      const handlers = {'/wake': handleWake, '/forget': handleForget, '/memory': handleMemory};
      return reply(200, await handlers[path](input));
    } catch (error) {
      if (error.status) return reply(error.status, {error: error.message});
      console.error('Agent service error:', error instanceof Error ? error.message : 'unknown');
      return reply(500, {error: 'Agent 服务内部错误'});
    }
  });
  await new Promise(ok => server.listen(port, host, ok));

  return {
    server,
    url: `http://${host}:${server.address().port}`,
    async close() {
      server.closeAllConnections(); proxyServer.closeAllConnections();
      await Promise.all([new Promise(r => server.close(r)), new Promise(r => proxyServer.close(r))]);
    },
  };
}

const count = (value, fallback) => { const n = Number(value); return value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : fallback; };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const isolation = env.AGENT_ISOLATION || 'docker';
  const service = await createAgentService({
    token: env.AGENT_SERVICE_TOKEN,
    dataDir: resolve(env.AGENT_DATA_DIR || './data'),
    isolation,
    image: env.AGENT_IMAGE || 'weave-agent:0.3.316',
    weaveUrl: env.WEAVE_API_URL,
    keys: {deepseek: env.DEEPSEEK_API_KEY || env.AGENT_PROVIDER_API_KEY || '', kimi: env.KIMI_API_KEY || '', glm: env.GLM_API_KEY || '', qwen: env.QWEN_API_KEY || ''},
    limits: {perAccount: count(env.AGENT_DAILY_TOKENS_PER_ACCOUNT, 400000), total: count(env.AGENT_DAILY_TOKENS_TOTAL, 6000000)},
    maxConcurrent: count(env.AGENT_MAX_CONCURRENCY, 3) || 3,
    containerMemory: env.AGENT_CONTAINER_MEMORY || '1g',
    // 服务本身跑在容器里时，插件要放在宿主机看得到的路径上（见 Dockerfile 的入口脚本）。
    ...(env.AGENT_PLUGIN_DIR ? {pluginDir: env.AGENT_PLUGIN_DIR} : {}),
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT) || 4320,
  });
  console.log(`Weave Agent service started on ${service.url} (isolation: ${isolation})`);
  if (isolation === 'local') console.warn('AGENT_ISOLATION=local 只用于本机开发：Bash 靠 SDK 的 sandbox 隔离，没有容器。');
}
