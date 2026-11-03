// deploy/tencent/wechat: the compose project that runs the agent-wechat daemon (wx) and the bridge on the server.
// The compose file is checked as text here, and with `docker compose config` wherever docker exists (CI always).
// The scripts run for real from a copy of the directory in a temp sandbox, with a fake docker, curl and ss on PATH:
// nothing touches Docker, the network or WeChat, and nothing is written into this checkout.
import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = join(root, 'deploy/tencent/wechat');
const composeText = readFileSync(join(dir, 'compose.yml'), 'utf8');
const libText = readFileSync(join(dir, 'lib.sh'), 'utf8');
const scripts = ['lib.sh', 'up.sh', 'login.sh', 'status.sh', 'stop.sh', 'wx.sh'];
const bash = (args, options = {}) => spawnSync('bash', args, {encoding: 'utf8', ...options});
const mode = path => statSync(path).mode & 0o777;
// Like bash() but without blocking, so the sandbox tests can run at the same time.
const runAsync = (args, env) => new Promise((resolve, reject) => {
  const child = spawn('bash', args, {env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
  child.on('error', reject).on('close', status => resolve({status, stdout, stderr}));
});
const has = tool => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
const inCI = process.env.CI === 'true';
const libValue = name => new RegExp(`^${name}=(.+)$`, 'm').exec(libText)?.[1];

// The lines of one service under `services:` (two-space indent), up to the next service or top-level key.
function service(name) {
  const lines = composeText.split('\n'), start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `service ${name} is missing`);
  const block = [];
  for (const line of lines.slice(start + 1)) { if (/^ {0,2}\S/.test(line)) break; block.push(line); }
  return block.join('\n');
}

// ── the compose file ─────────────────────────────────────────────────────────────────────────
test('compose: its own project, only wx and bridge, no published ports, nothing on 0.0.0.0, no outside networks or volumes', () => {
  assert.match(composeText, /^name: wechat$/m);
  const services = [...composeText.split(/^volumes:$/m)[0].matchAll(/^ {2}([a-z-]+):$/gm)].map(m => m[1]);
  assert.deepEqual(services, ['wx', 'bridge']);
  assert.doesNotMatch(composeText, /^\s*ports:/m);
  assert.doesNotMatch(composeText, /0\.0\.0\.0/);
  assert.doesNotMatch(composeText, /^\s*(networks|external|depends_on|privileged|pid|ipc|cap_add|devices):/m);
  assert.doesNotMatch(composeText, /docker\.sock|weave_|web-state|weave-data/);
  assert.match(composeText, /^volumes:\n {2}wx-data:\n {2}wx-scratch:\n {2}bridge-state:\n?$/m);
});

test('compose: wx is the pinned official image, listens only on 127.0.0.1:6179, and runs locked down with its own limits', () => {
  const wx = service('wx');
  assert.match(wx, /^ {4}image: ghcr\.io\/thisnick\/agent-wechat-native:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/m);
  assert.match(wx, /^ {4}container_name: wechat-wx-1$/m);
  assert.match(wx, /^ {4}command: \["serve", "--data-dir", "\/var\/lib\/agent-wechat", "--listen", "127\.0\.0\.1:6179"\]$/m);
  // No token file is named, so the daemon makes its own owner token inside the data volume (agent-wechat docs: reference/tokens).
  assert.doesNotMatch(wx.replace(/^\s*#.*$/gm, ''), /token|secrets/i);
  for (const line of ['network_mode: host', 'user: "10001:10001"', 'read_only: true', 'cap_drop: [ALL]', 'security_opt: ["no-new-privileges:true"]',
    'mem_limit: ${WEAVE_WECHAT_WX_MEM:-256m}', 'memswap_limit: ${WEAVE_WECHAT_WX_MEM:-256m}', 'oom_score_adj: 500', 'restart: unless-stopped',
    '- wx-data:/var/lib/agent-wechat', '- wx-scratch:/var/cache/agent-wechat']) assert.ok(wx.split('\n').some(l => l.trim() === line), line);
});

test('compose: the bridge runs this checkout read-only on node:22-alpine, keeps its cursor in a volume, and has its own limits', () => {
  const bridge = service('bridge');
  for (const line of ['image: node:22-alpine', 'container_name: wechat-bridge-1', 'network_mode: host', 'init: true', 'user: node', 'working_dir: /app',
    'command: ["node", "bridge.mjs"]', 'env_file: bridge.env', 'WECHAT_BRIDGE_STATE: /home/node/cursor.json', '- ../../../hosted/wechat-bridge:/app:ro',
    '- bridge-state:/home/node', 'read_only: true', 'cap_drop: [ALL]', 'security_opt: ["no-new-privileges:true"]', 'mem_limit: 128m', 'memswap_limit: 128m',
    'oom_score_adj: 500', 'restart: unless-stopped']) assert.ok(bridge.split('\n').some(l => l.trim() === line), line);
  assert.ok(existsSync(join(dir, '../../../hosted/wechat-bridge/bridge.mjs')), 'the mounted path must hold bridge.mjs');
  // WEAVE_ORIGIN stays the public HTTPS address (bridge.mjs refuses anything else but 127.0.0.1) and comes from bridge.env.
  assert.doesNotMatch(bridge, /WEAVE_ORIGIN|http:\/\/web|4317/);
});

test('the image, version and port agree across compose.yml, this lib.sh and the Mac lib.sh', () => {
  const image = /^ {4}image: (ghcr\.io\S+)$/m.exec(service('wx'))[1];
  assert.equal(image, `${libValue('WX_IMAGE_REPO')}:v${libValue('WX_VERSION')}@${libValue('WX_IMAGE_DIGEST')}`);
  const mac = readFileSync(join(root, 'deploy/wechat-mac/lib.sh'), 'utf8');
  assert.equal(libValue('WX_VERSION'), /^WX_VERSION=(.+)$/m.exec(mac)[1]);
  assert.equal(libValue('WX_PORT'), '6179');
  assert.match(mac, /WX_PORT="\$\{WEAVE_WECHAT_PORT:-6179\}"/);
  assert.ok(composeText.includes(`127.0.0.1:${libValue('WX_PORT')}`));
});

// `docker compose config` resolves the file the way the server will. It needs bridge.env to exist, so it runs on a copy of
// the layout in a temp directory. Without docker it is skipped, except in CI, where it must run.
const compose = has('docker') && spawnSync('docker', ['compose', 'version']).status === 0;
test('compose: `docker compose config` accepts the file and resolves the limits, mounts and project name', {skip: !compose && !inCI && 'docker compose is not installed here (CI runs this)'}, () => {
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
      assert.equal(s.network_mode, 'host', name);
      assert.equal(s.restart, 'unless-stopped', name);
      assert.equal(s.oom_score_adj, 500, name);
      assert.equal(s.read_only, true, name);
      assert.deepEqual(s.cap_drop, ['ALL'], name);
      assert.ok(s.security_opt.includes('no-new-privileges:true'), name);
      assert.equal(s.ports, undefined, name);
      assert.equal(bytes(s.mem_limit), bytes(s.memswap_limit), name);
    }
    assert.equal(bytes(c.services.wx.mem_limit), 256 * 2 ** 20);
    assert.equal(bytes(c.services.bridge.mem_limit), 128 * 2 ** 20);
    assert.match(c.services.wx.image, /@sha256:[0-9a-f]{64}$/);
    assert.ok(c.services.wx.command.includes('127.0.0.1:6179'));
    const code = c.services.bridge.volumes.find(v => v.target === '/app');
    assert.equal(code.type, 'bind');
    assert.equal(code.source, join(box, 'hosted/wechat-bridge'));
    assert.equal(code.read_only, true);
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

// ── the scripts, in a sandbox ────────────────────────────────────────────────────────────────
const WEB_TOKEN = 'ab12cd34'.repeat(8);
const FAKE_DOCKER = String.raw`#!/usr/bin/env node
// A stand-in for docker: the compose, exec, inspect, stop, cp, logs and stats calls the scripts make, with the wx CLI inside the
// wx container answering with the JSON shapes of agent-wechat 1.3.3. Every call goes into one ordered log.
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const args = process.argv.slice(2), logs = process.env.FAKE_LOG, file = logs + '/state.json';
const event = line => appendFileSync(logs + '/events', line + '\n');
event('docker ' + args.join(' '));
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
state.running ??= {}; state.exists ??= {}; state.accounts ??= []; state.loggedIn ??= false; state.created ??= 0;
state.tokens ??= [{id: 't-old', name: 'weave-bridge', revoked: false}, {id: 't-gone', name: 'weave-bridge', revoked: true}, {id: 't-other', name: 'other', revoked: false}];
const save = () => writeFileSync(file, JSON.stringify(state));
const out = v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const end = (code = 0) => { save(); process.exit(code); };
const fail = (message, code = 1) => { process.stderr.write(message + '\n'); end(code); };
const names = {wx: 'wechat-wx-1', bridge: 'wechat-bridge-1'};

function wx(argv, tty) {
  const valued = new Set(['--server', '--token-file', '--account', '--accounts', '--scopes', '--alias', '--qr-output']);
  const words = [], values = {};
  for (let i = 0; i < argv.length; i++) {
    if (valued.has(argv[i])) { (values[argv[i]] ??= []).push(argv[i + 1]); i++; } else if (!argv[i].startsWith('--')) words.push(argv[i]);
  }
  event('wx ' + argv.join(' '));
  const json = argv.includes('--json'), joined = words.join(' ');
  const status = () => ({authenticated: state.loggedIn, connection: state.loggedIn ? 'online' : 'disconnected'});
  if (joined === 'version') return out({version: '1.3.3', target: 'x86_64-unknown-linux-gnu'});
  if (joined === 'accounts list') return out({items: state.accounts.map(a => ({...a, ...status(), incomingTransport: 'push', pendingProjectionBatches: 0}))});
  if (joined === 'accounts create') { state.accounts.push({id: 'acc-1', alias: values['--alias'][0]}); return out({id: 'acc-1', alias: values['--alias'][0]}); }
  if (joined === 'account status') return out(status());
  if (joined === 'auth login') {
    if (json) fail('the QR is only drawn without --json', 2);
    if (process.env.FAKE_LAN === '1') process.stderr.write('WeChat requires a local network check. Keep your phone on a network that can reach this computer.\n');
    if (tty) process.stderr.write('[QR CODE HERE]\n');
    else if (values['--qr-output']) process.stderr.write('QR PNG: ' + values['--qr-output'][0] + '\n');
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
      state.running[names[s]] = true; state.exists[names[s]] = true;
      if (s === 'bridge') { state.bridgeEnvAtStart = readFileSync(where + '/bridge.env', 'utf8'); if (process.env.FAKE_BRIDGE_BROKEN === '1') state.running[names[s]] = false; }
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
  const format = args[args.indexOf('-f') + 1] || '';
  const running = !!state.running[name];
  if (format === '{{.State.Running}}') out(String(running) + '\n');
  else if (format.startsWith('{{.State.Status}}')) out((running ? 'running' : 'exited') + ' 0 false 268435456\n');
  else if (format === '{{.HostConfig.Memory}}') out('268435456\n');
  else out('[]\n');
  end();
}
if (args[0] === 'stop') { state.running[name] = false; out(name + '\n'); end(); }
if (args[0] === 'exec') {
  let i = 1, tty = false;
  while (args[i].startsWith('-')) { if (args[i].includes('t')) tty = true; i++; }
  const target = args[i], cmd = args.slice(i + 1);
  if (!state.running[target]) fail('Error response from daemon: container ' + target + ' is not running');
  if (cmd[0] === 'wx' && target === 'wechat-wx-1') { wx(cmd.slice(1), tty); end(); }
  if (cmd[0] === 'cat') { out(target === 'wechat-wx-1' ? '123731968\n' : '47185920\n'); end(); }
  if (cmd[0] === 'sh') end();
  fail('unexpected exec: ' + cmd.join(' '), 2);
}
if (args[0] === 'cp') { writeFileSync(args[2], 'FAKE-PNG'); end(); }
if (args[0] === 'logs') {
  if (!state.exists[name]) fail('Error: No such container: ' + name);
  out(name === 'wechat-bridge-1' ? (process.env.FAKE_BRIDGE_BROKEN === '1' ? 'Error: WEAVE_ORIGIN 必须是 HTTPS\n' : '2026-11-03T13:40:00.000Z 微信桥接已启动。\n') : '{"state":"ready","listen":"127.0.0.1:6179"}\n');
  end();
}
if (args[0] === 'stats') { out('NAME MEM USAGE / LIMIT MEM %\n' + args.filter(a => /^wechat-|^weave-/.test(a)).map(n => n + ' 50MiB / 256MiB 19.53%').join('\n') + '\n'); end(); }
fail('unexpected docker call: ' + args.join(' '), 2);
`;
const FAKE_CURL = `#!/usr/bin/env bash
# curl: 401 unless the Bearer token that arrives in the -K config on stdin is the right one. Records its arguments.
printf '%s\\n' "$*" >> "$FAKE_LOG/curl-argv"
config=""
for a in "$@"; do [ "$a" = "-K" ] && config=$(cat); done
url="\${@: -1}"
[ "\${FAKE_CURL_DOWN:-}" = 1 ] && { printf 000; exit 7; }
case "$url" in
  */api/internal/wechat/events) want=$(sed -n 's/^WECHAT_BRIDGE_TOKEN=//p' "$FAKE_WEB_ENV" | head -1) ;;
  */v1/accounts/*) want=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.FAKE_LOG+"/state.json","utf8")).lastKey||"")') ;;
  *) printf 404; exit 0 ;;
esac
if [ -n "$config" ] && [ -n "$want" ] && printf '%s' "$config" | grep -qF "Authorization: Bearer $want"; then printf 200; else printf 401; fi
`;
const FAKE_SS = `#!/usr/bin/env bash
[ "\${FAKE_PORT_BUSY:-}" = 1 ] && echo 'LISTEN 0 4096 127.0.0.1:6179 0.0.0.0:*'
exit 0
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
  for (const f of [...scripts, 'compose.yml']) cpSync(join(dir, f), join(where, f));
  const webEnvFile = join(repo, 'deploy/tencent/web.env');
  if (webEnv !== null) writeFileSync(webEnvFile, webEnv, {mode: 0o600});
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, {mode: 0o755});
  writeFileSync(join(bin, 'curl'), FAKE_CURL, {mode: 0o755});
  writeFileSync(join(bin, 'ss'), FAKE_SS, {mode: 0o755});
  if (state) writeFileSync(join(logs, 'state.json'), JSON.stringify(state));
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: logs, FAKE_WEB_ENV: webEnvFile};
  for (const k of ['WEAVE_ORIGIN', 'WEAVE_WEB_ENV', 'WEAVE_WECHAT_QR_MODE', 'COMPOSE_PROJECT_NAME', 'TMPDIR']) delete env[k];
  env.TMPDIR = join(base, 'tmp'); mkdirSync(env.TMPDIR);
  const run = (script, args = [], extra = {}) => runAsync([join(where, script), ...args], {...env, ...extra});
  const events = () => existsSync(join(logs, 'events')) ? readFileSync(join(logs, 'events'), 'utf8').split('\n').filter(Boolean) : [];
  const fakeState = () => JSON.parse(readFileSync(join(logs, 'state.json'), 'utf8'));
  return {base, repo, where, bin, logs, home, env, run, events, fakeState, bridgeEnv: join(where, 'bridge.env'), composeEnv: join(where, '.env'), done: () => rmSync(base, {recursive: true, force: true})};
}
const upAndRunning = {running: {'wechat-wx-1': true}, exists: {'wechat-wx-1': true}};
const everything = r => r.stdout + r.stderr;

describe('the scripts, run in a sandbox', {concurrency: true}, () => {
  test('up.sh: writes a 600 bridge.env with only the non-secret defaults, pulls and starts wx only, and checks the version', async () => {
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
      assert.match(r.stdout, /wx 守护进程正常：版本 1\.3\.3，只听 127\.0\.0\.1:6179/);
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

  test('up.sh refuses root, a different compose project that is also called wechat, and a port someone else holds', async () => {
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
    const busy = sandbox();
    try {
      const r = await busy.run('up.sh', [], {FAKE_PORT_BUSY: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /6179/);
      assert.ok(!busy.events().some(e => / up -d /.test(e)));
    } finally { busy.done(); }
    const busyButOurs = sandbox({state: upAndRunning});
    try {
      assert.equal((await busyButOurs.run('up.sh', [], {FAKE_PORT_BUSY: '1'})).status, 0, 'the port is held by our own wx');
    } finally { busyButOurs.done(); }
  });

  async function loggedInFlow(box, args = [], extra = {}) {
    assert.equal((await box.run('up.sh')).status, 0);
    return box.run('login.sh', args, extra);
  }

  test('login.sh: logs in once, makes the new key before revoking old ones, writes a 600 bridge.env, starts the bridge, and never shows a secret', async () => {
    const box = sandbox();
    try {
      const r = await loggedInFlow(box);
      assert.equal(r.status, 0, everything(r));
      const events = box.events(), at = re => events.findIndex(e => re.test(e));
      // Logged in once, through the PNG path (no terminal here), after the scan instructions.
      assert.equal(events.filter(e => /^wx .*auth login/.test(e)).length, 1);
      assert.match(events.find(e => /^wx .*auth login/.test(e)), /--qr-output \/var\/lib\/agent-wechat\/weave-login-qr\.png/);
      assert.ok(r.stdout.indexOf('用小号扫这个二维码') >= 0 && r.stdout.indexOf('用小号扫这个二维码') < r.stdout.indexOf('scp -i'));
      assert.ok(events.some(e => /^docker cp wechat-wx-1:\/var\/lib\/agent-wechat\/weave-login-qr\.png /.test(e)));
      assert.ok(!existsSync(join(box.home, 'weave-wechat-qr.png')), 'the copied QR is removed after the login');
      // New key (read + send only) → bridge restarted with it → only then the old weave-bridge keys are revoked.
      const create = at(/^wx .*tokens create weave-bridge/), start = at(/ up -d --force-recreate bridge$/), revoke = at(/^wx .*tokens revoke t-old$/);
      assert.ok(create >= 0 && start > create && revoke > start, events.join('\n'));
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
      // No secret on screen, in docker's or curl's arguments.
      const argv = events.join('\n') + readFileSync(join(box.logs, 'curl-argv'), 'utf8');
      for (const secret of [key, WEB_TOKEN]) { assert.ok(!everything(r).includes(secret)); assert.ok(!argv.includes(secret)); }
      assert.match(r.stdout, /小号登录成功/);
      assert.match(r.stdout, /旧的桥接密钥作废了 1 把/);
    } finally { box.done(); }
  });

  test('login.sh: keeps the media scope when bridge.env has WEAVE_WECHAT_IMAGES=1 (PR #33), and passes the flag through untouched', async () => {
    const box = sandbox();
    try {
      assert.equal((await box.run('up.sh')).status, 0);
      writeFileSync(box.bridgeEnv, readFileSync(box.bridgeEnv, 'utf8') + 'WEAVE_WECHAT_IMAGES=1\n', {mode: 0o600});
      const r = await box.run('login.sh');
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
      const r = await box.run('login.sh');
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

  test('login.sh in a terminal draws the QR there: docker exec -it, no --json', async () => {
    const box = sandbox();
    try {
      const r = await loggedInFlow(box, [], {WEAVE_WECHAT_QR_MODE: 'terminal'});
      assert.equal(r.status, 0, everything(r));
      const call = box.events().find(e => /^docker exec .*auth login/.test(e));
      assert.match(call, /^docker exec -it wechat-wx-1 wx --server http:\/\/127\.0\.0\.1:6179 --token-file \/var\/lib\/agent-wechat\/api-token --account acc-1 auth login$/);
    } finally { box.done(); }
  });

  test('login.sh stops before any login or key when the site has no bridge token, or this server cannot reach Weave', async () => {
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
      assert.ok(!odd.events().some(e => /auth login|tokens create/.test(e)));
    } finally { odd.done(); }
    const down = sandbox();
    try {
      const r = await loggedInFlow(down, [], {FAKE_CURL_DOWN: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /HTTP 401，拿到的是 000/);
      assert.ok(!down.events().some(e => /auth login|tokens create/.test(e)));
    } finally { down.done(); }
    const missing = sandbox({webEnv: null});
    try {
      assert.notEqual((await loggedInFlow(missing)).status, 0);
      assert.ok(!missing.events().some(e => /auth login|tokens create/.test(e)));
    } finally { missing.done(); }
    const noWx = sandbox();
    try {
      const r = await noWx.run('login.sh');
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /up\.sh/);
    } finally { noWx.done(); }
  });

  test('login.sh: a failed login (the same-network check) stops with the stop signal, makes no key and starts no bridge', async () => {
    const box = sandbox();
    try {
      const r = await loggedInFlow(box, [], {FAKE_LOGIN_EXIT: '9', FAKE_LOGIN_CODE: 'login_lan_challenge_failed', FAKE_LAN: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /同一局域网/);
      assert.match(r.stderr, /同一局域网检查/);
      assert.match(r.stderr, /README 第 2 节/);
      assert.ok(!box.events().some(e => /tokens create|up -d --force-recreate bridge/.test(e)));
      assert.ok(!existsSync(join(box.home, 'weave-wechat-qr.png')));
    } finally { box.done(); }
    const expired = sandbox();
    try {
      const r = await loggedInFlow(expired, [], {FAKE_LOGIN_EXIT: '9', FAKE_LOGIN_CODE: ''});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /没有登录成功.*状态：failed/);
    } finally { expired.done(); }
  });

  test('login.sh: if the bridge does not come up, the old keys stay valid and the log is shown', async () => {
    const box = sandbox();
    try {
      const r = await loggedInFlow(box, [], {FAKE_BRIDGE_BROKEN: '1'});
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /WEAVE_ORIGIN 必须是 HTTPS/);
      assert.ok(!box.events().some(e => /tokens revoke/.test(e)));
    } finally { box.done(); }
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

  test('status.sh: runs before anything exists, and later shows the account, memory and logs without any secret', async () => {
    const box = sandbox();
    try {
      const r = await box.run('status.sh');
      assert.equal(r.status, 0, everything(r));
      assert.match(r.stdout, /还没建/);
      assert.equal((await loggedInFlow(box)).status, 0);
      const s = await box.run('status.sh');
      assert.equal(s.status, 0, everything(s));
      assert.match(s.stdout, /wx 守护进程（wechat-wx-1）：运行中，自动重启过 0 次，内存上限 256 MiB/);
      assert.match(s.stdout, /weave：已登录，连接：在线/);
      assert.match(s.stdout, /wx 守护进程 启动以来最多用过：118 MiB/);
      assert.match(s.stdout, /微信桥接已启动/);
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

test('the server scripts are executable, pass bash -n, and avoid what breaks on the Mac bash 3.2 the tests run on', () => {
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
