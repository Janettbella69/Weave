// 端到端演练的基础设施：起假 Notion、真的 notion-oauth-proxy.mjs、真的网站（wrangler dev --local，
// 单用户模式 + 访问密码），以及一个只用 node:http 的浏览器替身。不写死任何钥匙。
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, createWriteStream, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../..');
export const hostedDir = join(repoRoot, 'hosted');
export const BASIC = { user: 'weave', password: 'e2e-password' };
export const PUBLIC_HOST = 'weave.azorashopping.site';
export const PUBLIC_ORIGIN = 'https://' + PUBLIC_HOST;
export const OWNER = { userId: 'me@weave.local', email: 'me@weave.local', name: 'Me' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function assertPortFree(port, label) {
  await new Promise((ok, fail) => {
    const probe = createServer();
    probe.once('error', error => fail(Error(`${label}端口 ${port} 已被占用（${error.code}）。换一个：见 README 里的环境变量。`)));
    probe.listen(port, '127.0.0.1', () => probe.close(ok));
  });
}

export function preflight() {
  const problems = [];
  if (!existsSync(join(hostedDir, 'node_modules/wrangler/bin/wrangler.js'))) problems.push('hosted/ 里还没装依赖：cd hosted && npm ci --no-audit --no-fund');
  if (!existsSync(join(hostedDir, 'dist/server/wrangler.json'))) problems.push('hosted/ 还没构建：cd hosted && WRANGLER_SEND_METRICS=false npm run build');
  if (problems.length) throw Error(problems.join('\n'));
}

// start-vps.sh 写进 .dev.vars 的变量名。演练用的变量必须是它的子集，免得演练里有、线上没有。
export function startVpsVarNames() {
  const script = readFileSync(join(hostedDir, 'scripts/start-vps.sh'), 'utf8');
  const heredoc = script.split('cat > /app/.dev.vars <<ENV')[1]?.split('\nENV')[0] || '';
  return new Set([...heredoc.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1]));
}

export function devVars(vars) {
  const allowed = startVpsVarNames();
  const unknown = Object.keys(vars).filter(name => !allowed.has(name));
  if (unknown.length) throw Error(`start-vps.sh 不会写这些变量，演练不该用：${unknown.join(', ')}`);
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

// 起一个子进程，输出写进日志文件。
function launch(name, command, args, { env = {}, cwd = repoRoot, logDir }) {
  // 先同步建好日志文件：写入流是异步打开的，马上读日志会读到「不存在」。
  closeSync(openSync(join(logDir, `${name}.log`), 'a'));
  const log = createWriteStream(join(logDir, `${name}.log`), { flags: 'a' });
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.exited = new Promise(done => child.once('exit', done));
  child.logFile = join(logDir, `${name}.log`);
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await Promise.race([child.exited, sleep(4000)]);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  await Promise.race([child.exited, sleep(2000)]);
}

// `wrangler d1 execute` 打印成功之后进程不一定退出，看到成功的那一行就停掉它。
async function d1Execute(tmp, varsFile, sqlFile, logDir) {
  const child = launch('d1-' + sqlFile.split('/').pop(), process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--env-file', varsFile,
    '--config', 'dist/server/wrangler.json', '--persist-to', join(tmp, 'state'), '--file', sqlFile,
  ], { cwd: hostedDir, logDir, env: { WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const output = readFileSync(child.logFile, 'utf8');
    if (/commands? executed successfully/.test(output)) { await stopProcess(child); return; }
    if (child.exitCode !== null) throw Error(`d1 execute 提前退出：\n${output.slice(-1500)}`);
    await sleep(300);
  }
  await stopProcess(child);
  throw Error('d1 execute 90 秒没有出结果');
}

// ---- 浏览器替身 ----
// 只用 node:http：要能自己写 Host 和 X-Forwarded-Proto（Node 的 fetch 不让改 Host），也不能自动跟随跳转。
export function http(port, { method = 'GET', path = '/', headers = {}, body, auth = true, timeoutMs = 30000 } = {}) {
  return new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    // 值是 undefined 的头不发（用来模拟「nginx 没带这个头」）。
    const finalHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    if (auth && !('authorization' in finalHeaders)) finalHeaders.authorization = 'Basic ' + Buffer.from(`${BASIC.user}:${BASIC.password}`).toString('base64');
    if (payload !== undefined) {
      finalHeaders['content-length'] = Buffer.byteLength(payload);
      if (!('content-type' in finalHeaders)) finalHeaders['content-type'] = 'application/json';
    }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: finalHeaders }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        resolveRequest({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Error(`请求 ${method} ${path} 超过 ${timeoutMs} 毫秒没有回应`)));
    req.once('error', reject);
    req.end(payload);
  });
}

export async function startStack({ ports, vars = {}, upstreamPort, proxyTimeoutMs = 1500, startProxy = true, startSite = true, tmp, logDir }) {
  const runDir = tmp || mkdtempSync(join(tmpdir(), 'weave-notion-e2e-'));
  const logs = logDir || join(runDir, 'logs');
  mkdirSync(join(runDir, 'state'), { recursive: true });
  mkdirSync(logs, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  const proxyBase = `http://127.0.0.1:${ports.proxy}`;
  const baseVars = {
    WEAVE_ENCRYPTION_KEY: secret, WEAVE_VPS_MODE: 'true', WEAVE_VPS_USER_ID: OWNER.userId, WEAVE_VPS_EMAIL: OWNER.email,
    WEAVE_VPS_NAME: OWNER.name, WEAVE_BASIC_AUTH: `${BASIC.user}:${BASIC.password}`,
    NOTION_OAUTH_EXCHANGE_URL: `${proxyBase}/exchange`, NOTION_API_PROXY_URL: `${proxyBase}/api`, ...vars,
  };
  const varsFile = join(runDir, 'dev.vars');
  writeFileSync(varsFile, devVars(baseVars), { mode: 0o600 });

  const stack = { runDir, logs, secret, varsFile, ports, vars: baseVars, children: {} };
  stack.startProxy = async () => {
    await assertPortFree(ports.proxy, '代理');
    stack.children.proxy = launch('proxy', process.execPath, [join(hostedDir, 'scripts/notion-oauth-proxy.mjs')], {
      logDir: logs, env: { NOTION_OAUTH_PROXY_PORT: String(ports.proxy), NOTION_UPSTREAM_BASE: `http://127.0.0.1:${upstreamPort}`, NOTION_PROXY_TIMEOUT_MS: String(proxyTimeoutMs) },
    });
    for (let i = 0; i < 50; i++) {
      try { if ((await http(ports.proxy, { path: '/health', auth: false, timeoutMs: 1000 })).status === 200) return; } catch { /* 还没起来 */ }
      await sleep(200);
    }
    throw Error('代理没有起来：\n' + readFileSync(stack.children.proxy.logFile, 'utf8').slice(-1000));
  };
  stack.stopProxy = async () => { await stopProcess(stack.children.proxy); };
  stack.startSite = async () => {
    await assertPortFree(ports.site, '网站');
    stack.children.site = launch('site', process.execPath, [
      'node_modules/wrangler/bin/wrangler.js', 'dev', '--env-file', varsFile, '--config', 'dist/server/wrangler.json', '--local',
      '--persist-to', join(runDir, 'state'), '--ip', '127.0.0.1', '--port', String(ports.site), '--inspector-port', '0',
    ], { cwd: hostedDir, logDir: logs, env: { X_LOCAL_EXPLORER: 'false', WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (stack.children.site.exitCode !== null) throw Error('网站进程退出了：\n' + readFileSync(stack.children.site.logFile, 'utf8').slice(-2000));
      try { if ((await http(ports.site, { path: '/', timeoutMs: 5000 })).status === 200) return; } catch { /* 还没起来 */ }
      await sleep(500);
    }
    throw Error('网站 120 秒没有起来：\n' + readFileSync(stack.children.site.logFile, 'utf8').slice(-2000));
  };
  stack.stopSite = async () => { await stopProcess(stack.children.site); };
  stack.stop = async () => { await stack.stopSite(); await stack.stopProxy(); };

  if (!existsSync(join(runDir, 'state/v3'))) {
    for (const file of ['drizzle/0000_aromatic_slapstick.sql', 'drizzle/0001_guest_sessions.sql']) await d1Execute(runDir, varsFile, file, logs);
  }
  if (startProxy) await stack.startProxy();
  if (startSite) await stack.startSite();
  return stack;
}

// 换一份网站配置重启（比如去掉 Notion 配置）。数据库保留。
export async function restartSite(stack, vars) {
  await stack.stopSite();
  stack.vars = { ...stack.vars, ...vars };
  for (const [name, value] of Object.entries(stack.vars)) if (value === undefined) delete stack.vars[name];
  writeFileSync(stack.varsFile, devVars(stack.vars), { mode: 0o600 });
  await stack.startSite();
}

// ---- 直接读写网站的本地 D1（SQLite）----
// 演练要造「已有计划」「状态已过期」这类现场，不方便走接口（计划要靠模型生成）。网站每次请求都重新读库，改了立刻生效。
export function openDatabase(stack) {
  const dir = join(stack.runDir, 'state/v3/d1/miniflare-D1DatabaseObject');
  const files = readdirSync(dir).filter(f => f.endsWith('.sqlite')).map(f => join(dir, f));
  const file = files.sort((a, b) => statSync(b).size - statSync(a).size)[0];
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  return {
    documents: () => db.prepare('SELECT id, kind, document FROM weave_documents').all().map(row => ({ ...row, document: JSON.parse(row.document) })),
    get: id => { const row = db.prepare('SELECT document FROM weave_documents WHERE id = ?').get(id); return row ? JSON.parse(row.document) : undefined; },
    set: (id, kind, value) => db.prepare('INSERT INTO weave_documents (id, kind, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document').run(id, kind, JSON.stringify(value)),
    runtime: () => Object.fromEntries(db.prepare("SELECT id, document FROM weave_documents WHERE kind = 'runtime'").all().map(row => [row.id, JSON.parse(row.document)])),
    raw: () => db.prepare('SELECT * FROM weave_documents').all().map(row => JSON.stringify(row)).join('\n'),
    close: () => db.close(),
  };
}

export const ownerPersonId = () => 'u:' + createHash('sha256').update(OWNER.userId).digest('hex');

export function cleanup(stack, keep) {
  if (!keep) rmSync(stack.runDir, { recursive: true, force: true });
}
