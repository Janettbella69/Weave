// 按浏览器的节奏轮询 GET /api/status，任何一次超过 1 秒就算没修好（退出码 1）。
//
// 背景：网页每 5 秒拉一次 /api/status。服务器上 `wrangler dev` 的代理和网站程序之间有一条闲了约 5 秒就会被关掉的长连接，
// 轮询正好撞在这个瞬间时，转发立刻失败；wrangler 4.92.0 把这个 GET 挂起来，等下一个请求到达才重试
// （见 scripts/patch-wrangler-proxy.mjs）。没打补丁时，按 5 秒的节奏轮询，本机约三分之一的请求会卡 5 秒。
// 这里每次请求都开新连接（和 nginx 转发的方式一样），按固定节奏发，不等上一个回来。
//
// 用法（在 hosted/ 里）：
//   node scripts/check-status-stall.mjs --url http://127.0.0.1:4317 --auth 用户名:密码   检查一个已经在跑的网站
//   node scripts/check-status-stall.mjs --spawn                                          自己起一个临时的 wrangler dev 再检查（先 npm run build）
// 可选：--polls 20（次数）  --every 5000（间隔毫秒）  --limit 1000（超过多少毫秒算卡）
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? 'true' : all[index + 1]]);
  return pairs;
}, []));
const polls = Number(args.polls || 20), every = Number(args.every || 5000), limit = Number(args.limit || 1000);

function poll(base, auth) {
  const url = new URL('/api/status', base);
  return new Promise((resolve) => {
    const started = performance.now();
    const done = (result) => resolve({ms: Math.round(performance.now() - started), ...result});
    const request = http.get(url, {agent: false, headers: {authorization: 'Basic ' + Buffer.from(auth).toString('base64')}}, (response) => {
      response.resume();
      response.on('end', () => done({status: response.statusCode}));
    });
    request.setTimeout(60_000, () => request.destroy(Error('60 秒没有回答')));
    request.on('error', (error) => done({error: error.message}));
  });
}

export async function checkStatusStall(base, auth, {count = polls, interval = every, slowMs = limit} = {}) {
  const results = [];
  await new Promise((finished) => {
    let sent = 0;
    const send = () => {
      const index = sent++;
      poll(base, auth).then((result) => { results.push({index, ...result}); if (results.length === count) finished(); });
    };
    send();
    const timer = setInterval(() => { if (sent >= count) clearInterval(timer); else send(); }, interval);
  });
  results.sort((a, b) => a.index - b.index);
  const slow = results.filter(r => r.error || r.status !== 200 || r.ms > slowMs);
  return {results, slow, max: Math.max(...results.map(r => r.ms))};
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
  server.on('error', reject);
});

// 起一个临时网站（和 deploy 里的启动方式一样：wrangler dev --local，单用户模式 + 访问密码）。
async function spawnSite() {
  if (!existsSync(join(root, 'dist/server/wrangler.json'))) throw Error('还没有构建：先在 hosted/ 里跑 npm run build');
  const dir = mkdtempSync(join(tmpdir(), 'weave-stall-'));
  const state = join(dir, 'state'), vars = join(dir, 'dev.vars'), auth = 'weave:pw', port = await freePort();
  writeFileSync(vars, [`WEAVE_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`, 'WEAVE_VPS_MODE=true', 'WEAVE_VPS_USER_ID=me@weave.local',
    'WEAVE_VPS_EMAIL=me@weave.local', 'WEAVE_VPS_NAME=Me', `WEAVE_BASIC_AUTH=${auth}`, ''].join('\n'));
  const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
  const env = {...process.env, X_LOCAL_EXPLORER: 'false', WRANGLER_SEND_METRICS: 'false', CI: 'true'};
  const children = [];
  const start = (argv) => { const child = spawn(process.execPath, [wrangler, ...argv], {cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']}); children.push(child); return child; };
  const stop = () => { for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已经退出 */ } } rmSync(dir, {recursive: true, force: true}); };
  // 被打断或出错退出时也要把临时网站停掉（它们在自己的进程组里，不会跟着一起退出）。
  process.once('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));
  // d1 execute 打印成功以后进程不一定会退出，看到成功那一行就把它停掉。
  for (const file of ['drizzle/0000_aromatic_slapstick.sql', 'drizzle/0001_guest_sessions.sql']) {
    await new Promise((resolve, reject) => {
      const child = start(['d1', 'execute', 'DB', '--local', '--env-file', vars, '--config', 'dist/server/wrangler.json', '--persist-to', state, '--file', file]);
      let output = '';
      const timer = setTimeout(() => reject(Error('建表超时：' + output.slice(-300))), 120_000);
      const onData = (chunk) => { output += chunk; if (/command[s]? executed successfully/.test(output)) { clearTimeout(timer); try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已经退出 */ } resolve(); } };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('exit', () => { if (!/executed successfully/.test(output)) { clearTimeout(timer); reject(Error('建表失败：' + output.slice(-300))); } });
    }).catch((error) => { stop(); throw error; });
  }
  const site = start(['dev', '--env-file', vars, '--config', 'dist/server/wrangler.json', '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0']);
  let log = '';
  site.stdout.on('data', (chunk) => { log += chunk; }); site.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    const probe = await poll(base, auth);
    if (probe.status === 200) return {base, auth, stop, log: () => log};
    await new Promise(r => setTimeout(r, 1000));
  }
  stop();
  throw Error('网站没有起来：' + log.slice(-500));
}

async function main() {
  let site = null, base = args.url, auth = args.auth;
  if (args.spawn === 'true') { site = await spawnSite(); ({base, auth} = site); }
  if (!base || !auth) { console.error('用法：--url http://地址 --auth 用户名:密码，或者 --spawn'); return 2; }
  try {
    console.log(`按 ${every / 1000} 秒的节奏轮询 ${base}/api/status ${polls} 次，超过 ${limit} 毫秒算卡……`);
    const {results, slow, max} = await checkStatusStall(base, auth);
    console.log(`最慢 ${max} 毫秒；超过 ${limit} 毫秒或出错的 ${slow.length} 次` + (slow.length ? '：' + slow.map(r => `#${r.index + 1} ${r.error || r.status} ${r.ms}ms`).join('，') : ''));
    const recovered = site ? site.log().split('\n').filter(l => l.includes('[weave patch]')) : [];
    if (recovered.length) console.log(`补丁救回来 ${recovered.length} 次（每一次原来都会卡 5 秒以上）：${recovered[0].replace(/\u001b\[[0-9;]*m/g, '')}`);
    if (slow.length) { console.error(`FAIL 轮询出现卡顿（共 ${results.length} 次）`); return 1; }
    console.log(`PASS 按 ${every / 1000} 秒的节奏轮询 /api/status ${results.length} 次，没有一次超过 ${limit} 毫秒`);
    return 0;
  } finally { site?.stop(); }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(await main());
