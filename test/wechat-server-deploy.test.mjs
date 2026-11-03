// deploy/tencent/wechat: the compose project that runs the agent-wechat daemon (wx) and the bridge on the server.
// The compose file is checked as text here, and with `docker compose config` wherever docker exists (CI always).
// bridge-guard.mjs is tested directly and as a real child process against local sockets.
// The scripts run for real from a copy of the directory in a temp sandbox, with a fake docker on PATH (it also plays the
// wx CLI inside the wx container): nothing touches Docker, the network or WeChat, and nothing is written into this checkout.
import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SAID_WEAVE, SAID_WX, announceFirstContact, canConnect, daemonAddress, watchDaemon} from '../deploy/tencent/wechat/bridge-guard.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = join(root, 'deploy/tencent/wechat');
const composeText = readFileSync(join(dir, 'compose.yml'), 'utf8');
const libText = readFileSync(join(dir, 'lib.sh'), 'utf8');
const scripts = ['lib.sh', 'up.sh', 'login.sh', 'status.sh', 'stop.sh', 'wx.sh'];
const bash = (args, options = {}) => spawnSync('bash', args, {encoding: 'utf8', ...options});
const mode = path => statSync(path).mode & 0o777;
// Like bash() but without blocking, so the sandbox tests can run at the same time. `input` goes to stdin.
const runAsync = (command, args, env, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
  if (input !== undefined) child.stdin.end(input);
  child.on('error', reject).on('close', status => resolve({status, stdout, stderr}));
});
const has = tool => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
const inCI = process.env.CI === 'true';
const libValue = name => new RegExp(`^${name}=(.+)$`, 'm').exec(libText)?.[1];
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));

// The lines of one service under `services:` (two-space indent), up to the next service or top-level key.
function service(name) {
  const lines = composeText.split('\n'), start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `service ${name} is missing`);
  const block = [];
  for (const line of lines.slice(start + 1)) { if (/^ {0,2}\S/.test(line)) break; block.push(line); }
  return block.join('\n');
}
const lines = block => block.split('\n').map(l => l.trim());

// ── the compose file ─────────────────────────────────────────────────────────────────────────
test('compose: its own project, only wx and bridge, no host network, no published ports, nothing on 0.0.0.0', () => {
  assert.match(composeText, /^name: wechat$/m);
  const services = [...composeText.split(/^volumes:$/m)[0].matchAll(/^ {2}([a-z-]+):$/gm)].map(m => m[1]);
  assert.deepEqual(services, ['wx', 'bridge']);
  assert.doesNotMatch(composeText, /network_mode: host|^\s*ports:|0\.0\.0\.0/m);
  assert.doesNotMatch(composeText, /^\s*(networks|external|privileged|pid|ipc|cap_add|devices|extra_hosts):/m);
  assert.doesNotMatch(composeText, /docker\.sock|weave_|web-state|weave-data/);
  assert.match(composeText, /^volumes:\n {2}wx-data:\n {2}wx-scratch:\n {2}bridge-state:\n?$/m);
});

test('compose: wx is the pinned official image on its own network, listens only on its own 127.0.0.1:6179, locked down, own limits', () => {
  const wx = service('wx');
  assert.match(wx, /^ {4}image: ghcr\.io\/thisnick\/agent-wechat-native:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/m);
  assert.match(wx, /^ {4}container_name: wechat-wx-1$/m);
  assert.doesNotMatch(wx, /^ {4}network_mode:/m, 'wx stays on the compose default network');
  assert.match(wx, /^ {4}command: \["serve", "--data-dir", "\/var\/lib\/agent-wechat", "--listen", "127\.0\.0\.1:6179"\]$/m);
  // No token file is named, so the daemon makes its own owner token inside the data volume (agent-wechat docs: reference/tokens).
  assert.doesNotMatch(wx.replace(/^\s*#.*$/gm, ''), /token|secrets/i);
  for (const line of ['user: "10001:10001"', 'read_only: true', 'cap_drop: [ALL]', 'security_opt: ["no-new-privileges:true"]',
    'mem_limit: ${WEAVE_WECHAT_WX_MEM:-256m}', 'memswap_limit: ${WEAVE_WECHAT_WX_MEM:-256m}', 'oom_score_adj: 500', 'restart: unless-stopped',
    '- wx-data:/var/lib/agent-wechat', '- wx-scratch:/var/cache/agent-wechat']) assert.ok(lines(wx).includes(line), line);
});

test('compose: the bridge joins wx\'s network, runs this checkout read-only through the guard, keeps its cursor in a volume, own limits', () => {
  const bridge = service('bridge');
  assert.match(bridge, /^ {4}image: node:22-alpine@sha256:[0-9a-f]{64}$/m);
  for (const line of ['container_name: wechat-bridge-1', 'network_mode: service:wx', 'init: true', 'user: node', 'working_dir: /app',
    'command: ["node", "/guard/bridge-guard.mjs"]', 'env_file: bridge.env', 'WECHAT_BRIDGE_STATE: /home/node/cursor.json', '- ../../../hosted/wechat-bridge:/app:ro',
    '- ./bridge-guard.mjs:/guard/bridge-guard.mjs:ro', '- bridge-state:/home/node', 'read_only: true', 'cap_drop: [ALL]', 'security_opt: ["no-new-privileges:true"]',
    'mem_limit: 128m', 'memswap_limit: 128m', 'oom_score_adj: 500', 'restart: unless-stopped']) assert.ok(lines(bridge).includes(line), line);
  assert.ok(existsSync(join(dir, '../../../hosted/wechat-bridge/bridge.mjs')), 'the mounted path must hold bridge.mjs');
  assert.ok(existsSync(join(dir, 'bridge-guard.mjs')));
  // WEAVE_ORIGIN stays the public HTTPS address (bridge.mjs refuses anything else but 127.0.0.1) and comes from bridge.env.
  assert.doesNotMatch(bridge, /WEAVE_ORIGIN|http:\/\/web|4317/);
});

test('the images, version and port agree across compose.yml, this lib.sh and the Mac lib.sh', () => {
  const image = /^ {4}image: (ghcr\.io\S+)$/m.exec(service('wx'))[1];
  assert.equal(image, `${libValue('WX_IMAGE_REPO')}:v${libValue('WX_VERSION')}@${libValue('WX_IMAGE_DIGEST')}`);
  assert.equal(/^ {4}image: (node\S+)$/m.exec(service('bridge'))[1], libValue('BRIDGE_IMAGE'));
  const mac = readFileSync(join(root, 'deploy/wechat-mac/lib.sh'), 'utf8');
  assert.equal(libValue('WX_VERSION'), /^WX_VERSION=(.+)$/m.exec(mac)[1]);
  assert.equal(libValue('WX_PORT'), '6179');
  assert.match(mac, /WX_PORT="\$\{WEAVE_WECHAT_PORT:-6179\}"/);
  assert.ok(composeText.includes(`127.0.0.1:${libValue('WX_PORT')}`));
});

// `docker compose config` resolves the file the way the server will. It needs bridge.env to exist, so it runs on a copy of
// the layout in a temp directory. Without docker it is skipped, except in CI, where it must run.
const compose = has('docker') && spawnSync('docker', ['compose', 'version']).status === 0;
test('compose: `docker compose config` accepts the file and resolves the network, limits, mounts and project name', {skip: !compose && !inCI && 'docker compose is not installed here (CI runs this)'}, () => {
  assert.ok(compose, 'docker compose must be available in CI');
  const box = mkdtempSync(join(tmpdir(), 'weave-compose-'));
  try {
    const where = join(box, 'deploy/tencent/wechat');
    mkdirSync(where, {recursive: true});
    mkdirSync(join(box, 'hosted/wechat-bridge'), {recursive: true});
    cpSync(join(dir, 'compose.yml'), join(where, 'compose.yml'));
    writeFileSync(join(where, 'bridge.env'), 'WEAVE_ORIGIN=https://weave.example\nWX_TOKEN=placeholder\n', {mode: 0o600});
    const config = (envText) => {
      if (envText === undefined) rmSync(join(where, '.env'), {force: true}); else writeFileSync(join(where, '.env'), envText);
      const r = spawnSync('docker', ['compose', '-p', 'wechat', '--project-directory', where, '-f', join(where, 'compose.yml'), 'config', '--format', 'json'], {encoding: 'utf8'});
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const bytes = v => typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : ({m: 2 ** 20, g: 2 ** 30}[String(v).slice(-1)] * Number(String(v).slice(0, -1)));
    const c = config();
    assert.equal(c.name, 'wechat');
    assert.deepEqual(Object.keys(c.services).sort(), ['bridge', 'wx']);
    for (const [name, s] of Object.entries(c.services)) {
      assert.notEqual(s.network_mode, 'host', name);
      assert.equal(s.restart, 'unless-stopped', name);
      assert.equal(s.oom_score_adj, 500, name);
      assert.equal(s.read_only, true, name);
      assert.deepEqual(s.cap_drop, ['ALL'], name);
      assert.ok(s.security_opt.includes('no-new-privileges:true'), name);
      assert.equal(s.ports, undefined, name);
      assert.equal(bytes(s.mem_limit), bytes(s.memswap_limit), name);
    }
    assert.equal(c.services.wx.network_mode, undefined);
    assert.ok(Object.keys(c.services.wx.networks ?? {}).includes('default'), JSON.stringify(c.services.wx.networks));
    assert.equal(c.services.bridge.network_mode, 'service:wx');
    assert.equal(bytes(c.services.wx.mem_limit), 256 * 2 ** 20);
    assert.equal(bytes(c.services.bridge.mem_limit), 128 * 2 ** 20);
    assert.match(c.services.wx.image, /@sha256:[0-9a-f]{64}$/);
    assert.match(c.services.bridge.image, /^node:22-alpine@sha256:[0-9a-f]{64}$/);
    assert.ok(c.services.wx.command.includes('127.0.0.1:6179'));
    const code = c.services.bridge.volumes.find(v => v.target === '/app');
    assert.equal(code.type, 'bind');
    assert.equal(code.source, join(box, 'hosted/wechat-bridge'));
    assert.equal(code.read_only, true);
    const guard = c.services.bridge.volumes.find(v => v.target === '/guard/bridge-guard.mjs');
    assert.equal(guard.source, join(where, 'bridge-guard.mjs'));
    assert.equal(guard.read_only, true);
    assert.equal(c.services.bridge.volumes.find(v => v.target === '/home/node').source, 'bridge-state');
    assert.equal(c.services.bridge.environment.WECHAT_BRIDGE_STATE, '/home/node/cursor.json');
    // bridge.env reaches the bridge: merged into environment, or at least named as its env_file (compose versions print it differently).
    assert.ok(c.services.bridge.environment.WEAVE_ORIGIN === 'https://weave.example' || JSON.stringify(c.services.bridge.env_file ?? '').includes('bridge.env'), JSON.stringify(c.services.bridge));
    // The one memory knob: .env (written by up.sh --wx-mem) raises wx and only wx.
    const raised = config('WEAVE_WECHAT_WX_MEM=384m\n');
    assert.equal(bytes(raised.services.wx.mem_limit), 384 * 2 ** 20);
    assert.equal(bytes(raised.services.wx.memswap_limit), 384 * 2 ** 20);
    assert.equal(bytes(raised.services.bridge.mem_limit), 128 * 2 ** 20);
  } finally { rmSync(box, {recursive: true, force: true}); }
});

// ── bridge-guard.mjs ─────────────────────────────────────────────────────────────────────────
test('guard: exits once wx has not answered for the whole limit, and an answer in between starts the count again', async () => {
  let t = 0, answers = [true, false, false, true, false, false, false, false];
  const exits = [], said = [];
  const guard = watchDaemon({probe: async () => answers.shift() ?? false, exit: code => exits.push(code), log: m => said.push(m), everyMs: 5000, limitMs: 30000, now: () => t, schedule: () => null});
  for (let i = 0; i < 4; i++) { await guard.check(); t += 10000; }
  assert.deepEqual(exits, [], 'two misses after an answer are only 10 s of silence');
  for (let i = 0; i < 4; i++) { await guard.check(); t += 10000; }
  assert.deepEqual(exits, [1], 'four misses in a row are 30 s of silence: exit once');
  assert.match(said[0], /30 秒没有回应/);
  await guard.check();
  assert.deepEqual(exits, [1], 'and only once');
  assert.deepEqual(daemonAddress('http://127.0.0.1:6179/v1'), {host: '127.0.0.1', port: 6179});
});

test('guard: canConnect says whether something accepts a TCP connection', async () => {
  const server = createServer(socket => socket.destroy());
  const port = await listen(server);
  assert.equal(await canConnect({host: '127.0.0.1', port, timeoutMs: 1000}), true);
  await new Promise(done => server.close(done));
  assert.equal(await canConnect({host: '127.0.0.1', port, timeoutMs: 1000}), false);
});

test('guard: says once that it reached wx and once that it reached Weave, only on a 2xx, and never says a URL', async () => {
  const said = [];
  const statuses = {'http://127.0.0.1:6179/v1/accounts/a/events/stream?after=1': 200, 'https://weave.example/api/internal/wechat/claim': 503};
  const fetcher = announceFirstContact({fetcher: async url => ({ok: statuses[url] < 300, status: statuses[url]}), wxBase: 'http://127.0.0.1:6179/v1', weaveOrigin: 'https://weave.example', log: m => said.push(m)});
  await fetcher('https://weave.example/api/internal/wechat/claim');
  assert.deepEqual(said, [], 'a 503 is not getting through');
  await fetcher('http://127.0.0.1:6179/v1/accounts/a/events/stream?after=1');
  await fetcher('http://127.0.0.1:6179/v1/accounts/a/events/stream?after=1');
  statuses['https://weave.example/api/internal/wechat/claim'] = 200;
  await fetcher('https://weave.example/api/internal/wechat/claim');
  assert.deepEqual(said, [SAID_WX, SAID_WEAVE]);
});

test('guard, as the container runs it: starts the bridge with fetch wrapped, logs both first contacts, and exits when wx goes away', async () => {
  const base = mkdtempSync(join(tmpdir(), 'weave-guard-'));
  // One local HTTP server plays both: "wx" under /v1 (the guard also watches its TCP port) and "Weave" for the rest.
  const http = createHttpServer((request, response) => { response.writeHead(200, {'Content-Type': 'application/json'}); response.end('{}'); });
  let child;
  try {
    const port = await listen(http);
    // A stand-in for bridge.mjs: one call to wx and one to Weave with the global fetch, then it runs until stopped.
    writeFileSync(join(base, 'bridge.mjs'), 'export async function main(env){await fetch(env.WX_BASE_URL+"/accounts/a/events/stream");await fetch(env.WEAVE_ORIGIN+"/api/internal/wechat/claim",{method:"POST",headers:{Authorization:"Bearer "+env.WECHAT_BRIDGE_TOKEN}});console.log("main is running");setInterval(()=>{},1000);await new Promise(()=>{});}\n');
    const env = {...process.env, WECHAT_BRIDGE_MODULE: join(base, 'bridge.mjs'), WECHAT_GUARD_EVERY_MS: '50', WECHAT_GUARD_LIMIT_MS: '400',
      WX_BASE_URL: `http://127.0.0.1:${port}/v1`, WEAVE_ORIGIN: `http://127.0.0.1:${port}`, WECHAT_BRIDGE_TOKEN: 'SECRET-WEB-TOKEN-0123456789abcdef0123456789'};
    child = spawn(process.execPath, [join(dir, 'bridge-guard.mjs')], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    const exited = new Promise(done => child.on('close', code => done(code)));
    await new Promise(done => setTimeout(done, 900));
    assert.equal(child.exitCode, null, 'still running while wx answers: ' + stderr);
    assert.ok(stdout.includes(SAID_WX) && stdout.includes(SAID_WEAVE) && stdout.includes('main is running'), stdout + stderr);
    // wx goes away (as when it restarts into a new network): nothing accepts connections on its port any more.
    http.close();
    http.closeAllConnections();
    const code = await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 5000))]);
    assert.equal(code, 1, stdout + stderr);
    assert.match(stderr, /秒没有回应/);
    assert.ok(!(stdout + stderr).includes('SECRET-WEB-TOKEN'));
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (http.listening) http.close();
    rmSync(base, {recursive: true, force: true});
  }
});

// The Weave check login.sh runs inside wx's network (in a throwaway node container): two answers, without and with the token from stdin.
test('the Weave probe script prints "401 200" for a site that wants the token, and 0 for one it cannot reach', async () => {
  const js = bash(['-c', `. '${join(dir, 'lib.sh')}'; printf '%s' "$weave_probe_js"`]).stdout;
  assert.match(js, /^let t=""/);
  const seen = [];
  const http = createHttpServer((request, response) => {
    seen.push([request.method, request.url, request.headers.authorization ?? '']);
    response.writeHead(request.headers.authorization === 'Bearer the-right-token' ? 200 : 401).end();
  });
  try {
    const port = await listen(http);
    const r = await runAsync(process.execPath, ['-e', js, `http://127.0.0.1:${port}`], process.env, 'the-right-token\n');
    assert.equal(r.stdout.trim(), '401 200', r.stderr);
    assert.deepEqual(seen.map(s => s.slice(0, 2)), [['POST', '/api/internal/wechat/events'], ['POST', '/api/internal/wechat/events']]);
    await new Promise(done => http.close(done));
    const down = await runAsync(process.execPath, ['-e', js, `http://127.0.0.1:${port}`], process.env, 'x\n');
    assert.equal(down.stdout.trim(), '0 0');
  } finally { if (http.listening) http.close(); }
});

// ── the scripts, in a sandbox ────────────────────────────────────────────────────────────────
const WEB_TOKEN = 'ab12cd34'.repeat(8);
const FAKE_DOCKER = String.raw`#!/usr/bin/env node
// A stand-in for docker: the compose, exec, run, inspect, stop, restart, cp, logs and stats calls the scripts make, with the
// wx CLI inside the wx container answering with the JSON shapes of agent-wechat 1.3.3. Every call goes into one ordered log.
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const args = process.argv.slice(2), logs = process.env.FAKE_LOG, file = logs + '/state.json';
const event = line => appendFileSync(logs + '/events', line + '\n');
event('docker ' + args.join(' '));
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
state.running ??= {}; state.exists ??= {}; state.ids ??= {}; state.serial ??= 0; state.accounts ??= []; state.loggedIn ??= false; state.created ??= 0;
state.tokens ??= [{id: 't-old', name: 'weave-bridge', revoked: false}, {id: 't-gone', name: 'weave-bridge', revoked: true}, {id: 't-other', name: 'other', revoked: false}];
const save = () => writeFileSync(file, JSON.stringify(state));
const out = v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const end = (code = 0) => { save(); process.exit(code); };
const fail = (message, code = 1) => { process.stderr.write(message + '\n'); end(code); };
const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
const webToken = () => existsSync(process.env.FAKE_WEB_ENV) ? (/^WECHAT_BRIDGE_TOKEN=(.*)$/m.exec(readFileSync(process.env.FAKE_WEB_ENV, 'utf8')) || [])[1] || '' : '';
const names = {wx: 'wechat-wx-1', bridge: 'wechat-bridge-1'};
const create = name => { state.exists[name] = true; state.running[name] = true; state.ids[name] = 'id-' + name + '-' + (++state.serial); };

function wx(argv, input) {
  const valued = new Set(['--server', '--token-file', '--account', '--accounts', '--scopes', '--alias', '--qr-output']);
  const words = [], values = {};
  for (let i = 0; i < argv.length; i++) {
    if (valued.has(argv[i])) { (values[argv[i]] ??= []).push(argv[i + 1]); i++; } else if (!argv[i].startsWith('--')) words.push(argv[i]);
  }
  event('wx ' + argv.join(' '));
  const json = argv.includes('--json'), joined = words.join(' ');
  // Only the bridge key check reads a key from stdin.
  if (argv.includes('--token-stdin') && (process.env.FAKE_KEY_REJECTED === '1' || input.trim() !== state.lastKey)) fail('unauthorized', 4);
  const status = () => ({authenticated: state.loggedIn, connection: state.loggedIn ? 'online' : 'disconnected'});
  if (joined === 'version') return out({version: '1.3.3', target: 'x86_64-unknown-linux-gnu'});
  if (joined === 'accounts list') { if (process.env.FAKE_ACCOUNTS_FAIL === '1') fail('daemon not ready', 3); return out({items: state.accounts.map(a => ({...a, ...status(), incomingTransport: 'push', pendingProjectionBatches: 0}))}); }
  if (joined === 'accounts create') { state.accounts.push({id: 'acc-1', alias: values['--alias'][0]}); return out({id: 'acc-1', alias: values['--alias'][0]}); }
  if (joined === 'account status') return out(status());
  if (joined === 'auth login') {
    if (json) fail('the QR is only drawn without --json', 2);
    if (process.env.FAKE_LAN === '1') process.stderr.write('WeChat requires a local network check. Keep your phone on a network that can reach this computer.\n');
    if (values['--qr-output']) process.stderr.write('QR PNG: ' + values['--qr-output'][0] + '\n');
    else process.stderr.write('[QR CODE HERE]\n');
    if (process.env.FAKE_LOGIN_EXIT) { out({state: 'failed', result: {code: process.env.FAKE_LOGIN_CODE || 'other'}}); end(Number(process.env.FAKE_LOGIN_EXIT)); }
    state.loggedIn = true;
    return out({state: 'succeeded', result: {method: 'approved_login'}});
  }
  if (joined === 'auth logout') { state.loggedIn = false; return out({state: 'succeeded'}); }
  if (joined === 'tokens list') return out({items: state.tokens});
  if (joined === 'tokens create weave-bridge') {
    const n = ++state.created, id = 't-new-' + n, token = 'SECRETWXKEY' + 'k'.repeat(40) + n;
    state.tokens.push({id, name: 'weave-bridge', revoked: false, scopes: values['--scopes']});
    state.lastKey = token;
    return out({token, grant: {id, name: 'weave-bridge', accounts: values['--accounts'], scopes: values['--scopes'], expiresAt: null, revoked: false}});
  }
  if (words[0] === 'tokens' && words[1] === 'revoke') { const t = state.tokens.find(x => x.id === words[2]); if (t) t.revoked = true; return out({revoked: !!t}); }
  fail('unexpected wx call: ' + joined, 2);
}

if (args[0] === 'compose') {
  let i = 1, project = '', where = '';
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-p') project = args[i + 1];
    if (args[i] === '--project-directory') where = args[i + 1];
    i += ['-p', '--project-directory', '-f'].includes(args[i]) ? 2 : 1;
  }
  const sub = args[i], rest = args.slice(i + 1), services = rest.filter(a => !a.startsWith('-'));
  if (sub === 'version') { out('Docker Compose version v2.29.7\n'); end(); }
  if (project !== 'wechat') fail('fake docker: compose without -p wechat', 3);
  // Like the real one: compose will not load the project without the env_file.
  if (!existsSync(where + '/bridge.env')) fail('env file ' + where + '/bridge.env not found: no such file or directory', 1);
  if (sub === 'pull') end();
  if (sub === 'up') {
    for (const s of services) {
      const n = names[s];
      if (rest.includes('--force-recreate') || !state.exists[n] || (s === 'wx' && process.env.FAKE_WX_RECREATE === '1')) create(n);
      else state.running[n] = true;
      if (s === 'bridge') { state.bridgeEnvAtStart = readFileSync(where + '/bridge.env', 'utf8'); if (process.env.FAKE_BRIDGE_BROKEN === '1') state.running[n] = false; }
    }
    end();
  }
  if (sub === 'down') { state.running = {}; state.exists = {}; state.volumes = 'removed'; end(); }
  fail('unexpected compose call: ' + sub, 2);
}
const name = args.find(a => /^wechat-|^weave-/.test(a));
if (args[0] === 'ps') { out(process.env.FAKE_FOREIGN || ''); end(); }
if (args[0] === 'inspect') {
  if (!state.exists[name]) fail('Error: No such object: ' + name);
  const format = args.includes('-f') ? args[args.indexOf('-f') + 1] : '';
  const running = !!state.running[name];
  if (format === '{{.State.Running}}') out(String(running) + '\n');
  else if (format === '{{.Id}}') out(state.ids[name] + '\n');
  else if (format === '{{.RestartCount}}') out('0\n');
  else if (format === '{{.State.StartedAt}}') out('2026-11-03T13:40:00.000000000Z\n');
  else if (format.startsWith('{{.State.Status}}')) out((running ? 'running' : 'exited') + ' 0 false 268435456\n');
  else if (format === '{{.HostConfig.Memory}}') out('268435456\n');
  else out('[]\n');
  end();
}
if (args[0] === 'stop') { state.running[name] = false; out(name + '\n'); end(); }
if (args[0] === 'restart') { out(name + '\n'); end(); }
if (args[0] === 'run') {
  // Only the Weave probe: node -e <script> <origin> inside wx's network, with the site's bridge token on stdin.
  if (!args.includes('container:wechat-wx-1')) fail('fake docker: the probe must run in the network of wechat-wx-1', 2);
  if (!state.running['wechat-wx-1']) fail('cannot join network of a non running container', 125);
  const token = stdin().trim();
  if (process.env.FAKE_WEAVE_DOWN === '1') { out('0 0\n'); end(); }
  out('401 ' + (token && token === webToken() ? 200 : 401) + '\n');
  end();
}
if (args[0] === 'exec') {
  let i = 1, tty = false, interactive = false;
  while (args[i].startsWith('-')) { if (args[i].includes('t')) tty = true; if (args[i].includes('i')) interactive = true; i++; }
  const target = args[i], cmd = args.slice(i + 1);
  if (!state.running[target]) fail('Error response from daemon: container ' + target + ' is not running');
  if (cmd[0] === 'wx' && target === 'wechat-wx-1') { wx(cmd.slice(1), interactive && !tty ? stdin() : ''); end(); }
  if (cmd[0] === 'cat') { out(target === 'wechat-wx-1' ? '123731968\n' : '47185920\n'); end(); }
  if (cmd[0] === 'sh') end();
  fail('unexpected exec: ' + cmd.join(' '), 2);
}
if (args[0] === 'cp') { writeFileSync(args[2], 'FAKE-PNG'); end(); }
if (args[0] === 'logs') {
  if (!state.exists[name]) fail('Error: No such container: ' + name);
  if (name === 'wechat-bridge-1') {
    if (process.env.FAKE_BRIDGE_BROKEN === '1') out('Error: WEAVE_ORIGIN 必须是 HTTPS\n');
    else out('2026-11-03T13:40:00.000Z 微信桥接已启动。\n2026-11-03T13:40:00.100Z 桥接已连上 wx 守护进程。\n' + (process.env.FAKE_BRIDGE_NO_WEAVE === '1' ? '2026-11-03T13:40:01.000Z 发送队列暂时不可用：Weave 拒绝了请求 (502)\n' : '2026-11-03T13:40:00.200Z 桥接已连上 Weave。\n'));
  } else out('{"state":"ready","listen":"127.0.0.1:6179"}\n');
  end();
}
if (args[0] === 'stats') { out('NAME MEM USAGE / LIMIT MEM %\n' + args.filter(a => /^wechat-|^weave-/.test(a)).map(n => n + ' 50MiB / 256MiB 19.53%').join('\n') + '\n'); end(); }
fail('unexpected docker call: ' + args.join(' '), 2);
`;
const FAKE_ID = `#!/usr/bin/env bash
[ "\${1:-}" = -u ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
`;

// The server's layout: ~/weave/deploy/tencent/{web.env, wechat/}, ~/weave/hosted/wechat-bridge.
function sandbox({webEnv = `WEAVE_ENCRYPTION_KEY=aa\nWEAVE_AGENT_RUNTIME=sdk\nWECHAT_BRIDGE_TOKEN=${WEB_TOKEN}\nAGENT_SERVICE_TOKEN=bb\n`, state} = {}) {
  const base = mkdtempSync(join(tmpdir(), 'weave-wechat-server-'));
  const repo = join(base, 'weave'), where = join(repo, 'deploy/tencent/wechat'), bin = join(base, 'bin'), logs = join(base, 'logs'), home = join(base, 'home');
  for (const d of [where, bin, logs, home, join(repo, 'hosted/wechat-bridge')]) mkdirSync(d, {recursive: true});
  for (const f of [...scripts, 'compose.yml', 'bridge-guard.mjs']) cpSync(join(dir, f), join(where, f));
  const webEnvFile = join(repo, 'deploy/tencent/web.env');
  if (webEnv !== null) writeFileSync(webEnvFile, webEnv, {mode: 0o600});
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, {mode: 0o755});
  if (state) writeFileSync(join(logs, 'state.json'), JSON.stringify(state));
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: logs, FAKE_WEB_ENV: webEnvFile, WEAVE_WECHAT_SETTLE_SECONDS: '0', WEAVE_WECHAT_CONTACT_SECONDS: '2'};
  for (const k of ['WEAVE_ORIGIN', 'WEAVE_WEB_ENV', 'WEAVE_WECHAT_TTY', 'COMPOSE_PROJECT_NAME', 'TMPDIR']) delete env[k];
  env.TMPDIR = join(base, 'tmp'); mkdirSync(env.TMPDIR);
  const run = (script, args = [], extra = {}, input) => runAsync('bash', [join(where, script), ...args], {...env, ...extra}, input);
  const events = () => existsSync(join(logs, 'events')) ? readFileSync(join(logs, 'events'), 'utf8').split('\n').filter(Boolean) : [];
  const fakeState = () => JSON.parse(readFileSync(join(logs, 'state.json'), 'utf8'));
  return {base, repo, where, bin, logs, home, env, run, events, fakeState, bridgeEnv: join(where, 'bridge.env'), composeEnv: join(where, '.env'), done: () => rmSync(base, {recursive: true, force: true})};
}
const everything = r => r.stdout + r.stderr;
const nothingStarted = events => !events.some(e => /auth login|tokens create|up -d --force-recreate bridge|docker run /.test(e));

describe('the scripts, run in a sandbox', {concurrency: true}, () => {
  test('up.sh: writes a 600 bridge.env with only the non-secret defaults, pulls both images, starts wx only, and checks the version', async () => {
    const box = sandbox();
    try {
      const r = await box.run('up.sh');
      assert.equal(r.status, 0, everything(r));
      const env = readFileSync(box.bridgeEnv, 'utf8');
      for (const line of ['WEAVE_ORIGIN=https://weave.azorashopping.site', 'WX_BASE_URL=http://127.0.0.1:6179/v1', 'WEAVE_TICK=1']) assert.ok(env.split('\n').includes(line), line);
      assert.doesNotMatch(env, /^(WX_TOKEN|WX_ACCOUNT|WECHAT_BRIDGE_TOKEN)=/m);
      assert.equal(mode(box.bridgeEnv), 0o600);
      const docker = box.events().filter(e => e.startsWith('docker compose -p'));
      assert.deepEqual(docker.map(e => e.split(' -f ')[1].split(' ').slice(1).join(' ')), ['pull --ignore-pull-failures wx bridge', 'up -d wx']);
      assert.match(r.stdout, /wx 守护进程正常：版本 1\.3\.3，只听它自己网络里的 127\.0\.0\.1:6179/);
      assert.match(r.stdout, /内存上限 256 MB/);
      assert.ok(!existsSync(box.composeEnv), 'no .env unless --wx-mem asks for one');
    } finally { box.done(); }
  });

  test('up.sh: running it again keeps what login.sh wrote and adds nothing twice', async () => {
    const box = sandbox();
    try {
      assert.equal((await box.run('up.sh')).status, 0);
      writeFileSync(box.bridgeEnv, readFileSync(box.bridgeEnv, 'utf8') + 'WX_TOKEN=keep-this-secret\nWX_ACCOUNT=acc-1\n', {mode: 0o600});
      const before = readFileSync(box.bridgeEnv, 'utf8');
      const r = await box.run('up.sh');
      assert.equal(r.status, 0, everything(r));
      assert.equal(readFileSync(box.bridgeEnv, 'utf8'), before);
      assert.ok(!everything(r).includes('keep-this-secret'));
    } finally { box.done(); }
  });

  test('up.sh --wx-mem: a size in range goes into a 600 .env; anything else changes nothing and starts nothing', async () => {
    const box = sandbox();
    try {
      const r = await box.run('up.sh', ['--wx-mem', '384m']);
      assert.equal(r.status, 0, everything(r));
      assert.equal(readFileSync(box.composeEnv, 'utf8'), 'WEAVE_WECHAT_WX_MEM=384m\n');
      assert.equal(mode(box.composeEnv), 0o600);
      for (const bad of ['64m', '2048m', '384', '0384m', '1g', '384mb', 'abc', '']) {
        const before = box.events().length;
        const b = await box.run('up.sh', ['--wx-mem', bad]);
        assert.notEqual(b.status, 0, bad);
        assert.equal(readFileSync(box.composeEnv, 'utf8'), 'WEAVE_WECHAT_WX_MEM=384m\n', bad);
        assert.ok(!box.events().slice(before).some(e => / up -d /.test(e)), bad);
      }
      assert.notEqual((await box.run('up.sh', ['--wx-mem'])).status, 0);
      assert.notEqual((await box.run('up.sh', ['--start-everything'])).status, 0);
    } finally { box.done(); }
  });

  test('up.sh refuses root and a different compose project that is also called wechat', async () => {
    const asRoot = sandbox();
    try {
      writeFileSync(join(asRoot.bin, 'id'), FAKE_ID, {mode: 0o755});
      const r = await asRoot.run('up.sh');
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /root/);
      assert.equal(asRoot.events().length, 0, 'nothing ran');
    } finally { asRoot.done(); }
    const foreign = sandbox();
    try {
      const r = await foreign.run('up.sh', [], {FAKE_FOREIGN: 'wechat-gewe-1 /home/ubuntu/old-wechat\n'});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /wechat-gewe-1/);
      assert.ok(!foreign.events().some(e => e.startsWith('docker compose -p')), 'compose never ran');
      assert.ok(!existsSync(foreign.bridgeEnv));
    } finally { foreign.done(); }
    const ours = sandbox();
    try {
      // Containers of this very project are fine.
      const r = await ours.run('up.sh', [], {FAKE_FOREIGN: `wechat-wx-1 ${ours.where}\n`});
      assert.equal(r.status, 0, everything(r));
    } finally { ours.done(); }
  });

  test('up.sh: when wx is replaced by a new container, a running bridge is re-created to join it; a stopped bridge is left alone', async () => {
    const running = sandbox({state: {running: {'wechat-wx-1': true, 'wechat-bridge-1': true}, exists: {'wechat-wx-1': true, 'wechat-bridge-1': true}, ids: {'wechat-wx-1': 'old'}}});
    try {
      const r = await running.run('up.sh', ['--wx-mem', '384m'], {FAKE_WX_RECREATE: '1'});
      assert.equal(r.status, 0, everything(r));
      const events = running.events(), wx = events.findIndex(e => / up -d wx$/.test(e)), bridge = events.findIndex(e => / up -d --no-deps --force-recreate bridge$/.test(e));
      assert.ok(wx >= 0 && bridge > wx, events.join('\n'));
    } finally { running.done(); }
    const stopped = sandbox({state: {running: {'wechat-wx-1': true}, exists: {'wechat-wx-1': true, 'wechat-bridge-1': true}, ids: {'wechat-wx-1': 'old'}}});
    try {
      assert.equal((await stopped.run('up.sh', [], {FAKE_WX_RECREATE: '1'})).status, 0);
      assert.ok(!stopped.events().some(e => /bridge$/.test(e) && / up /.test(e)), 'a bridge that was stopped stays stopped');
    } finally { stopped.done(); }
    const same = sandbox({state: {running: {'wechat-wx-1': true, 'wechat-bridge-1': true}, exists: {'wechat-wx-1': true, 'wechat-bridge-1': true}, ids: {'wechat-wx-1': 'old'}}});
    try {
      assert.equal((await same.run('up.sh')).status, 0);
      assert.ok(!same.events().some(e => / up -d --no-deps --force-recreate bridge$/.test(e)), 'wx unchanged: the bridge is not touched');
    } finally { same.done(); }
  });

  async function loggedInFlow(box, args = ['--mac-stopped'], extra = {}, input) {
    assert.equal((await box.run('up.sh')).status, 0);
    return box.run('login.sh', args, extra, input);
  }

  test('login.sh: logs in once, checks Weave from wx\'s network, makes and tries the new key, waits for the bridge to reach wx and Weave, then revokes old keys; no secret shows', async () => {
    const box = sandbox();
    try {
      const r = await loggedInFlow(box);
      assert.equal(r.status, 0, everything(r));
      const events = box.events(), at = re => events.findIndex(e => re.test(e));
      // The Weave check runs in wx's network, read-only, with the site's token only on stdin.
      assert.match(events[at(/^docker run /)], /^docker run --rm -i --network container:wechat-wx-1 --read-only --cap-drop ALL --security-opt no-new-privileges --user node --memory 128m node:22-alpine@sha256:[0-9a-f]{64} node -e /);
      // Logged in once, through the PNG path (no terminal here), after the scan instructions.
      assert.equal(events.filter(e => /^wx .*auth login/.test(e)).length, 1);
      assert.match(events.find(e => /^wx .*auth login/.test(e)), /--qr-output \/var\/lib\/agent-wechat\/weave-login-qr\.png/);
      assert.ok(r.stdout.indexOf('用小号扫这个二维码') >= 0 && r.stdout.indexOf('用小号扫这个二维码') < r.stdout.indexOf('scp -i'));
      assert.ok(events.some(e => /^docker cp wechat-wx-1:\/var\/lib\/agent-wechat\/weave-login-qr\.png /.test(e)));
      assert.ok(!existsSync(join(box.home, 'weave-wechat-qr.png')), 'the copied QR is removed after the login');
      // New key (read + send only) → tried through stdin → bridge started → its logs show both contacts → old keys revoked.
      const create = at(/^wx .*tokens create weave-bridge/), tried = at(/^docker exec -i wechat-wx-1 wx --json --server http:\/\/127\.0\.0\.1:6179 --token-stdin --account acc-1 account status$/);
      const start = at(/ up -d --force-recreate bridge$/), watched = events.findIndex((e, i) => i > start && /^docker logs .*wechat-bridge-1$/.test(e)), revoke = at(/^wx .*tokens revoke t-old$/);
      assert.ok(create >= 0 && tried > create && start > tried && watched > start && revoke > watched, events.join('\n'));
      assert.match(events[create], /--accounts acc-1 --scopes read --scopes send$/);
      assert.ok(!events.some(e => /tokens revoke (t-other|t-gone|t-new-1)/.test(e)));
      assert.equal(box.fakeState().tokens.find(t => t.id === 't-new-1').revoked, false);
      // bridge.env: every key the bridge needs, the site's token copied from web.env, and mode 600 — already when the bridge started.
      const key = box.fakeState().lastKey, env = readFileSync(box.bridgeEnv, 'utf8');
      for (const line of [`WECHAT_BRIDGE_TOKEN=${WEB_TOKEN}`, `WX_TOKEN=${key}`, 'WX_ACCOUNT=acc-1', 'WX_BASE_URL=http://127.0.0.1:6179/v1', 'WEAVE_ORIGIN=https://weave.azorashopping.site', 'WEAVE_TICK=1']) {
        assert.ok(env.split('\n').includes(line), line);
        assert.ok(box.fakeState().bridgeEnvAtStart.split('\n').includes(line), 'at start: ' + line);
      }
      assert.equal(mode(box.bridgeEnv), 0o600);
      // No secret on screen or in docker's arguments.
      for (const secret of [key, WEB_TOKEN]) { assert.ok(!everything(r).includes(secret)); assert.ok(!events.join('\n').includes(secret)); }
      assert.match(r.stdout, /小号登录成功/);
      assert.match(r.stdout, /Mac 上原来那次登录多半会被微信顶下线/);
      assert.match(r.stdout, /桥接已启动，连上了 wx 和 Weave/);
      assert.match(r.stdout, /旧的桥接密钥作废了 1 把/);
    } finally { box.done(); }
  });

  test('login.sh will not start until you confirm the Mac side is stopped: 已停 at a terminal, --mac-stopped without one', async () => {
    const noFlag = sandbox();
    try {
      const r = await loggedInFlow(noFlag, []);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /--mac-stopped/);
      assert.ok(nothingStarted(noFlag.events()), noFlag.events().join('\n'));
    } finally { noFlag.done(); }
    const wrong = sandbox();
    try {
      for (const answer of ['yes\n', '已经停了\n', '\n', '']) {
        const r = await loggedInFlow(wrong, [], {WEAVE_WECHAT_TTY: '1'}, answer);
        assert.notEqual(r.status, 0, JSON.stringify(answer));
        assert.match(r.stdout, /输入「已停」/);
        assert.match(r.stderr, /没有输入「已停」，什么都没做/);
      }
      assert.ok(nothingStarted(wrong.events()));
    } finally { wrong.done(); }
    // At a terminal, 已停 lets it go on, and the QR is drawn there: docker exec -it, no --json.
    const yes = sandbox();
    try {
      const r = await loggedInFlow(yes, [], {WEAVE_WECHAT_TTY: '1'}, '已停\n');
      assert.equal(r.status, 0, everything(r));
      assert.match(yes.events().find(e => /^docker exec .*auth login/.test(e)), /^docker exec -it wechat-wx-1 wx --server http:\/\/127\.0\.0\.1:6179 --token-file \/var\/lib\/agent-wechat\/api-token --account acc-1 auth login$/);
      assert.ok(yes.events().some(e => / up -d --force-recreate bridge$/.test(e)));
    } finally { yes.done(); }
  });

  test('login.sh: keeps the media scope when bridge.env has WEAVE_WECHAT_IMAGES=1 (PR #33), and passes the flag through untouched', async () => {
    const box = sandbox();
    try {
      assert.equal((await box.run('up.sh')).status, 0);
      writeFileSync(box.bridgeEnv, readFileSync(box.bridgeEnv, 'utf8') + 'WEAVE_WECHAT_IMAGES=1\n', {mode: 0o600});
      const r = await box.run('login.sh', ['--mac-stopped']);
      assert.equal(r.status, 0, everything(r));
      assert.match(box.events().find(e => /tokens create/.test(e)), /--scopes read --scopes send --scopes media$/);
      assert.match(readFileSync(box.bridgeEnv, 'utf8'), /^WEAVE_WECHAT_IMAGES=1$/m);
    } finally { box.done(); }
  });

  test('login.sh: a small account that is already signed in is not asked to scan again; the key is still replaced, new before old', async () => {
    const box = sandbox();
    try {
      assert.equal((await loggedInFlow(box)).status, 0);
      const before = box.events().length;
      const r = await box.run('login.sh', ['--mac-stopped']);
      assert.equal(r.status, 0, everything(r));
      const events = box.events().slice(before);
      assert.match(r.stdout, /小号已经登录着，跳过扫码/);
      assert.ok(!events.some(e => /auth login/.test(e)));
      const create = events.findIndex(e => /tokens create/.test(e)), revoke = events.findIndex(e => /tokens revoke t-new-1$/.test(e));
      assert.ok(create >= 0 && revoke > create);
      assert.match(readFileSync(box.bridgeEnv, 'utf8'), new RegExp(`^WX_TOKEN=${box.fakeState().lastKey}$`, 'm'));
      assert.equal(box.fakeState().lastKey.endsWith('2'), true);
    } finally { box.done(); }
  });

  test('login.sh stops before any login or key when the site has no bridge token, Weave cannot be reached from wx\'s network, or wx is not up', async () => {
    const none = sandbox({webEnv: 'WEAVE_AGENT_RUNTIME=sdk\nWECHAT_BRIDGE_TOKEN=\n'});
    try {
      const r = await loggedInFlow(none);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /set-wechat-token\.sh/);
      assert.ok(!none.events().some(e => /auth login|tokens create|accounts create/.test(e)));
    } finally { none.done(); }
    const odd = sandbox({webEnv: 'WECHAT_BRIDGE_TOKEN=short$(touch pwned)\n'});
    try {
      assert.notEqual((await loggedInFlow(odd)).status, 0);
      assert.ok(nothingStarted(odd.events()));
    } finally { odd.done(); }
    const down = sandbox();
    try {
      const r = await loggedInFlow(down, ['--mac-stopped'], {FAKE_WEAVE_DOWN: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /从 wx 的网络连 https:\/\/weave\.azorashopping\.site：没带令牌应该是 HTTP 401，拿到的是 0（0 是连不上）/);
      assert.ok(!down.events().some(e => /auth login|tokens create/.test(e)));
    } finally { down.done(); }
    const missing = sandbox({webEnv: null});
    try {
      assert.notEqual((await loggedInFlow(missing)).status, 0);
      assert.ok(nothingStarted(missing.events()));
    } finally { missing.done(); }
    const noWx = sandbox();
    try {
      const r = await noWx.run('login.sh', ['--mac-stopped']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /up\.sh/);
    } finally { noWx.done(); }
    const flaky = sandbox();
    try {
      assert.equal((await flaky.run('up.sh')).status, 0);
      const r = await flaky.run('login.sh', ['--mac-stopped'], {FAKE_ACCOUNTS_FAIL: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /连不上 wx 守护进程/);
    } finally { flaky.done(); }
  });

  test('login.sh: a failed login stops with the stop signal (the same-network check, or wx asking for more on the phone) and makes no key', async () => {
    const box = sandbox();
    try {
      const r = await loggedInFlow(box, ['--mac-stopped'], {FAKE_LOGIN_EXIT: '9', FAKE_LOGIN_CODE: 'login_lan_challenge_failed', FAKE_LAN: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /同一局域网/);
      assert.match(r.stderr, /同一局域网检查/);
      assert.match(r.stderr, /README 第 2 节/);
      assert.ok(!box.events().some(e => /tokens create|up -d --force-recreate bridge/.test(e)));
      assert.ok(!existsSync(join(box.home, 'weave-wechat-qr.png')));
    } finally { box.done(); }
    const expired = sandbox();
    try {
      const r = await loggedInFlow(expired, ['--mac-stopped'], {FAKE_LOGIN_EXIT: '9', FAKE_LOGIN_CODE: ''});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /没有登录成功.*状态：failed/);
    } finally { expired.done(); }
    const asks = sandbox();
    try {
      const r = await loggedInFlow(asks, ['--mac-stopped'], {FAKE_LOGIN_EXIT: '6', FAKE_LOGIN_CODE: ''});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /微信要你在手机上多做一步.*停的信号/);
      assert.ok(!asks.events().some(e => /tokens create/.test(e)));
    } finally { asks.done(); }
  });

  test('login.sh: a new key that does not work is revoked at once, and nothing else changes', async () => {
    const box = sandbox();
    try {
      const r = await loggedInFlow(box, ['--mac-stopped'], {FAKE_KEY_REJECTED: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /新密钥试用没通过，已经作废它/);
      const events = box.events();
      assert.ok(events.some(e => /^wx .*tokens revoke t-new-1$/.test(e)));
      assert.ok(!events.some(e => /tokens revoke t-old|up -d --force-recreate bridge/.test(e)));
      assert.doesNotMatch(readFileSync(box.bridgeEnv, 'utf8'), /^WX_TOKEN=/m);
    } finally { box.done(); }
  });

  test('login.sh: when the bridge does not reach Weave, or does not come up, the old keys stay valid and it says what to do', async () => {
    const noWeave = sandbox();
    try {
      const r = await loggedInFlow(noWeave, ['--mac-stopped'], {FAKE_BRIDGE_NO_WEAVE: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /桥接连不上 https:\/\/weave\.azorashopping\.site/);
      assert.match(r.stdout, /Weave 拒绝了请求 \(502\)/);
      assert.match(r.stderr, /旧的桥接密钥没有作废/);
      assert.match(r.stderr, /README 第 2 节/);
      assert.ok(!noWeave.events().some(e => /tokens revoke/.test(e)));
    } finally { noWeave.done(); }
    const broken = sandbox();
    try {
      const r = await loggedInFlow(broken, ['--mac-stopped'], {FAKE_BRIDGE_BROKEN: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /WEAVE_ORIGIN 必须是 HTTPS/);
      assert.ok(!broken.events().some(e => /tokens revoke/.test(e)));
    } finally { broken.done(); }
  });

  test('stop.sh: the bridge stops before wx, --logout signs out first, --delete-data removes only this project, and odd options are refused', async () => {
    const box = sandbox();
    try {
      assert.equal((await loggedInFlow(box)).status, 0);
      const before = box.events().length;
      const r = await box.run('stop.sh', ['--logout']);
      assert.equal(r.status, 0, everything(r));
      const events = box.events().slice(before);
      const bridge = events.findIndex(e => e === 'docker stop wechat-bridge-1'), logout = events.findIndex(e => /auth logout/.test(e)), wx = events.findIndex(e => e === 'docker stop wechat-wx-1');
      assert.ok(bridge >= 0 && logout > bridge && wx > logout, events.join('\n'));
      assert.match(r.stdout, /登录设备管理/);
      assert.equal((await box.run('stop.sh')).status, 0, 'stopping twice is fine');
      const d = await box.run('stop.sh', ['--delete-data']);
      assert.equal(d.status, 0, everything(d));
      assert.ok(box.events().some(e => /^docker compose -p wechat .* down --volumes --remove-orphans$/.test(e)));
      assert.ok(!existsSync(box.bridgeEnv));
      assert.notEqual((await box.run('stop.sh', ['--wipe-everything'])).status, 0);
    } finally { box.done(); }
    const empty = sandbox();
    try {
      const r = await empty.run('stop.sh');
      assert.equal(r.status, 0, everything(r));
      assert.match(r.stdout, /本来就没在跑/);
    } finally { empty.done(); }
  });

  test('status.sh: runs before anything exists, and later shows the account, the bridge\'s contacts, memory and logs without any secret', async () => {
    const box = sandbox();
    try {
      const r = await box.run('status.sh');
      assert.equal(r.status, 0, everything(r));
      assert.match(r.stdout, /还没建/);
      assert.equal((await loggedInFlow(box)).status, 0);
      const s = await box.run('status.sh');
      assert.equal(s.status, 0, everything(s));
      assert.match(s.stdout, /wx 守护进程（wechat-wx-1）：运行中，自动重启过 0 次，内存上限 256 MiB/);
      assert.match(s.stdout, /桥接这次启动以来：wx 连上了，Weave 连上了/);
      assert.match(s.stdout, /weave：已登录，连接：在线/);
      assert.match(s.stdout, /wx 守护进程 启动以来最多用过：118 MiB/);
      assert.ok(box.events().some(e => /^docker logs --since 2026-11-03T13:40:00\.000000000Z wechat-bridge-1$/.test(e)));
      for (const secret of [box.fakeState().lastKey, WEB_TOKEN]) assert.ok(!everything(s).includes(secret));
    } finally { box.done(); }
  });

  test('every compose call names the wechat project, and nothing but read-only calls ever names a weave container', async () => {
    const box = sandbox();
    try {
      assert.equal((await loggedInFlow(box)).status, 0);
      assert.equal((await box.run('status.sh')).status, 0);
      assert.equal((await box.run('stop.sh', ['--logout', '--delete-data'])).status, 0);
      const docker = box.events().filter(e => e.startsWith('docker '));
      for (const e of docker.filter(e => e.startsWith('docker compose ') && e !== 'docker compose version')) assert.match(e, /^docker compose -p wechat --project-directory \S+ -f \S+\/compose\.yml /, e);
      for (const e of docker.filter(e => /weave-(web|agent)/.test(e))) assert.match(e, /^docker (inspect|stats) /, e);
    } finally { box.done(); }
  });
});

test('env_set and env_get here give exactly what the Mac lib.sh gives', () => {
  const base = mkdtempSync(join(tmpdir(), 'weave-envset-'));
  try {
    const original = '# 注释\nA=1\n\nWECHAT_BRIDGE_TOKEN_OLD=keep-me\nWECHAT_BRIDGE_TOKEN=old\nB=has = and spaces\nWECHAT_BRIDGE_TOKEN=duplicate\nlast=no newline';
    const results = [];
    for (const lib of [join(dir, 'lib.sh'), join(root, 'deploy/wechat-mac/lib.sh')]) {
      const file = join(base, `${results.length}.env`);
      writeFileSync(file, original);
      const r = bash(['-c', `set -euo pipefail; . '${lib}'; env_set '${file}' WECHAT_BRIDGE_TOKEN 'new$HOME&\`x\`\\y'; env_set '${file}' NEW v; printf '%s|' "$(env_get '${file}' B)" "$(env_get '${file}' NOPE)"`], {env: {...process.env, HOME: base}});
      assert.equal(r.status, 0, r.stderr);
      assert.equal(mode(file), 0o600);
      results.push([readFileSync(file, 'utf8'), r.stdout]);
    }
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0][1], 'has = and spaces||');
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('the server scripts are executable, pass bash -n (and the guard node --check), and avoid what breaks on the Mac bash 3.2', () => {
  for (const f of scripts) {
    const file = join(dir, f);
    assert.equal(bash(['-n', file]).status, 0, file);
    assert.ok(mode(file) & 0o100, file + ' is not executable');
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^#!\/usr\/bin\/env bash\n/);
    if (f !== 'lib.sh') assert.match(text, /^set -euo pipefail$/m, f);
    // bash 3.2 reads the first byte of a non-ASCII character after $name as part of the name ("unbound variable").
    const bad = text.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line));
    assert.deepEqual(bad, [], file + ': write ${name} here');
  }
  assert.equal(spawnSync(process.execPath, ['--check', join(dir, 'bridge-guard.mjs')]).status, 0);
});

test('shellcheck finds nothing in the server scripts', {skip: !has('shellcheck') && !inCI && 'shellcheck is not installed here (CI runs this)'}, () => {
  assert.ok(has('shellcheck'), 'shellcheck must be available in CI');
  const r = spawnSync('shellcheck', ['-x', '-P', 'SCRIPTDIR', ...scripts.map(f => join(dir, f))], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('bridge.env and .env never go into git', () => {
  for (const f of ['bridge.env', 'bridge.env.Ab12Cd', '.env']) {
    const r = spawnSync('git', ['check-ignore', '-q', join('deploy/tencent/wechat', f)], {cwd: root});
    assert.equal(r.status, 0, f + ' is not ignored');
  }
  assert.notEqual(spawnSync('git', ['check-ignore', '-q', 'deploy/tencent/wechat/compose.yml'], {cwd: root}).status, 0);
});
