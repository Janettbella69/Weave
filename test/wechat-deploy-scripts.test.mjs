// The Mac scripts in deploy/wechat-mac and the server script in deploy/tencent, run for real in a temp directory
// with a fake ssh, curl and wx on PATH. Nothing touches launchd, the network or WeChat.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const mac = join(root, 'deploy/wechat-mac'), server = join(root, 'deploy/tencent/set-wechat-token.sh');
const bash = (args, options = {}) => spawnSync('bash', args, {encoding: 'utf8', ...options});
const mode = path => statSync(path).mode & 0o777;
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'weave-scripts-'));
  return {dir, home: join(dir, 'home'), done: () => rmSync(dir, {recursive: true, force: true})};
}
// Runs a snippet with lib.sh sourced, pointed at the sandbox.
const lib = (box, snippet, env = {}) => bash(['-c', `set -euo pipefail; . '${mac}/lib.sh'; ${snippet}`], {env: {...process.env, WEAVE_WECHAT_HOME: box.home, WEAVE_WECHAT_LAUNCH_DIR: join(box.dir, 'LaunchAgents'), WEAVE_WECHAT_NO_LAUNCHD: '1', ...env}});

test('env_set replaces one key, keeps every other line as it was, and writes the file with mode 600', () => {
  const box = sandbox();
  try {
    const file = join(box.dir, 'x.env');
    writeFileSync(file, '# 注释\nA=1\n\nWECHAT_BRIDGE_TOKEN_OLD=keep-me\nWECHAT_BRIDGE_TOKEN=old\nB=has = and spaces\nWECHAT_BRIDGE_TOKEN=duplicate\nlast=no newline');
    const r = lib(box, `env_set '${file}' WECHAT_BRIDGE_TOKEN 'new$HOME&\`x\`\\y'`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(file, 'utf8'), '# 注释\nA=1\n\nWECHAT_BRIDGE_TOKEN_OLD=keep-me\nWECHAT_BRIDGE_TOKEN=new$HOME&`x`\\y\nB=has = and spaces\nlast=no newline\n');
    assert.equal(mode(file), 0o600);
  } finally { box.done(); }
});

test('env_set creates a missing file and appends a missing key; env_get reads it back', () => {
  const box = sandbox();
  try {
    const file = join(box.dir, 'nested/new.env');
    assert.equal(lib(box, `env_set '${file}' K v1; env_set '${file}' K2 v2`).status, 0);
    assert.equal(readFileSync(file, 'utf8'), 'K=v1\nK2=v2\n');
    assert.equal(mode(file), 0o600);
    assert.equal(lib(box, `env_get '${file}' K2`).stdout, 'v2');
    assert.equal(lib(box, `env_get '${file}' NOPE`).stdout, '');
    assert.equal(lib(box, `env_get '${join(box.dir, 'missing.env')}' K`).stdout, '');
  } finally { box.done(); }
});

test('write_bridge_defaults fills in only what is missing and never touches a value or a secret that is already there', () => {
  const box = sandbox();
  try {
    assert.equal(lib(box, `mkdir -p '${box.home}'; printf 'WEAVE_ORIGIN=https://other.example\\nWX_TOKEN=secret-token\\n' > '${box.home}/bridge.env'; write_bridge_defaults`).status, 0);
    const text = readFileSync(join(box.home, 'bridge.env'), 'utf8');
    assert.match(text, /^WEAVE_ORIGIN=https:\/\/other\.example$/m);
    assert.match(text, /^WX_TOKEN=secret-token$/m);
    assert.match(text, /^WX_BASE_URL=http:\/\/127\.0\.0\.1:6179\/v1$/m);
    assert.match(text, /^WEAVE_TICK=1$/m);
    assert.match(text, new RegExp(`^WECHAT_BRIDGE_STATE=${box.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/state/cursor\\.json$`, 'm'));
  } finally { box.done(); }
});

test('the launchd files run the pinned wx and the bridge from this checkout, and are valid plists', () => {
  const box = sandbox();
  try {
    const r = lib(box, `write_plists /opt/weave '/opt/homebrew/bin/node' 1`);
    assert.equal(r.status, 0, r.stderr);
    const dir = join(box.dir, 'LaunchAgents');
    const daemon = readFileSync(join(dir, 'com.weave.wechat.daemon.plist'), 'utf8');
    const bridge = readFileSync(join(dir, 'com.weave.wechat.bridge.plist'), 'utf8');
    const awake = readFileSync(join(dir, 'com.weave.wechat.awake.plist'), 'utf8');
    for (const item of [`${box.home}/bin/wx`, '<string>serve</string>', `${box.home}/data`, '127.0.0.1:6179', `${box.home}/logs/daemon.log`]) assert.ok(daemon.includes(item), item);
    for (const item of ['/opt/homebrew/bin/node', `--env-file=${box.home}/bridge.env`, '/opt/weave/hosted/wechat-bridge/bridge.mjs', '<key>WorkingDirectory</key><string>/opt/weave/hosted/wechat-bridge</string>']) assert.ok(bridge.includes(item), item);
    assert.ok(awake.includes('/usr/bin/caffeinate') && awake.includes('<string>-s</string>'));
    for (const text of [daemon, bridge, awake]) assert.match(text, /<key>KeepAlive<\/key><true\/>[\s\S]*<key>ThrottleInterval<\/key><integer>30<\/integer>/);
    // The bridge's secrets are in bridge.env, never in the plist.
    assert.ok(!/TOKEN/.test(bridge));
    if (spawnSync('which', ['plutil']).status === 0) for (const name of ['daemon', 'bridge', 'awake']) assert.equal(spawnSync('plutil', ['-lint', join(dir, `com.weave.wechat.${name}.plist`)]).status, 0, name);
    // Without the flag, no awake task is written.
    const box2 = sandbox();
    try { assert.equal(lib(box2, `write_plists /opt/weave node 0`).status, 0); assert.ok(!existsSync(join(box2.dir, 'LaunchAgents/com.weave.wechat.awake.plist'))); } finally { box2.done(); }
  } finally { box.done(); }
});

// bash 5.2 added a shell option, patsub_replacement (on by default), that turns an unquoted & in the replacement of
// ${var//pattern/replacement} into the text that matched. macOS ships bash 3.2, which has no such option, so escaping with
// ${s//</&lt;} passed on the Mac and produced "<lt;" on Ubuntu's bash 5.2. Every case runs under the default options and with
// the option forced on and off wherever the shell knows it (older shells ignore the shopt), so the result must not depend on it.
const escapeCases = [
  ['a<b>&c', 'a&lt;b&gt;&amp;c'],
  ['&lt;', '&amp;lt;'],
  ['x & y < z > w', 'x &amp; y &lt; z &gt; w'],
  ['<<>>&&', '&lt;&lt;&gt;&gt;&amp;&amp;'],
  ["it's \"quoted\"", "it's \"quoted\""],
  ['/Users/张三/微信 & 日志 <1>', '/Users/张三/微信 &amp; 日志 &lt;1&gt;'],
  ['plain', 'plain'],
  ['', ''],
];
const quoted = text => `'${text.replace(/'/g, `'\\''`)}'`;
for (const [name, prefix] of [['default options', ''], ['patsub_replacement on', 'shopt -s patsub_replacement 2>/dev/null || true; '], ['patsub_replacement off', 'shopt -u patsub_replacement 2>/dev/null || true; ']]) {
  test(`xml_escape gives the same answer under ${name}`, () => {
    const box = sandbox();
    try {
      for (const [input, expected] of escapeCases) {
        const r = lib(box, `${prefix}printf '%s' "$(xml_escape ${quoted(input)})"`);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, expected, `escaping ${JSON.stringify(input)} under ${name}`);
      }
    } finally { box.done(); }
  });
  test(`plist text escapes what would break the XML under ${name}`, () => {
    const box = sandbox();
    try {
      const r = lib(box, `${prefix}plist_text 'a.b' '/tmp/x&y.log' '' '/bin/echo' 'a<b>&c'`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('<string>a&lt;b&gt;&amp;c</string>'), r.stdout);
      assert.ok(r.stdout.includes('/tmp/x&amp;y.log'), r.stdout);
    } finally { box.done(); }
  });
}

// ── the server side ─────────────────────────────────────────────────────────────────────────
function serverBox(webEnv = 'WEAVE_ENCRYPTION_KEY=aa\nWEAVE_BASIC_AUTH=weave:p@ss=word\nWEAVE_AGENT_RUNTIME=sdk\nWECHAT_BRIDGE_TOKEN=\nAGENT_SERVICE_TOKEN=bb\n') {
  const box = sandbox(), deploy = join(box.dir, 'weave/deploy/tencent');
  mkdirSync(deploy, {recursive: true});
  mkdirSync(box.home, {recursive: true});
  writeFileSync(join(deploy, 'web.env'), webEnv, {mode: 0o600});
  writeFileSync(join(deploy, 'deploy.sh'), '#!/usr/bin/env bash\necho redeployed > "$(dirname "$0")/deployed.marker"\n');
  return {...box, deploy, webEnv: join(deploy, 'web.env')};
}
const runServer = (box, token, env = {}) => bash([server], {input: token, env: {...process.env, HOME: box.home, WEAVE_DEPLOY_DIR: box.deploy, ...env}});
const GOOD = 'ab12cd34'.repeat(8);

test('server script: writes the token into web.env, keeps every other line, backs the old file up, never prints the token, then redeploys', () => {
  const box = serverBox();
  try {
    const before = readFileSync(box.webEnv, 'utf8');
    const r = runServer(box, GOOD + '\n');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(box.webEnv, 'utf8'), before.replace('WECHAT_BRIDGE_TOKEN=\n', `WECHAT_BRIDGE_TOKEN=${GOOD}\n`));
    assert.equal(mode(box.webEnv), 0o600);
    assert.ok(!(r.stdout + r.stderr).includes(GOOD));
    assert.match(r.stdout, /64 位/);
    const backups = join(box.home, 'weave-data/env-backups'), names = readdirSync(backups);
    assert.equal(names.length, 1);
    assert.equal(readFileSync(join(backups, names[0]), 'utf8'), before);
    assert.equal(mode(join(backups, names[0])), 0o600);
    assert.ok(existsSync(join(box.deploy, 'deployed.marker')));
  } finally { box.done(); }
});

test('server script: adds the key when web.env has none, collapses duplicates, and an empty line switches the channel off', () => {
  const box = serverBox('A=1\nWECHAT_BRIDGE_TOKEN=x\nB=2\nWECHAT_BRIDGE_TOKEN=y\n');
  try {
    assert.equal(runServer(box, GOOD + '\n', {WEAVE_SKIP_DEPLOY: '1'}).status, 0);
    assert.equal(readFileSync(box.webEnv, 'utf8'), `A=1\nWECHAT_BRIDGE_TOKEN=${GOOD}\nB=2\n`);
    assert.equal(runServer(box, '\n', {WEAVE_SKIP_DEPLOY: '1'}).status, 0);
    assert.equal(readFileSync(box.webEnv, 'utf8'), 'A=1\nWECHAT_BRIDGE_TOKEN=\nB=2\n');
  } finally { box.done(); }
  const bare = serverBox('A=1');
  try {
    assert.equal(runServer(bare, GOOD + '\n', {WEAVE_SKIP_DEPLOY: '1'}).status, 0);
    assert.equal(readFileSync(bare.webEnv, 'utf8'), `A=1\nWECHAT_BRIDGE_TOKEN=${GOOD}\n`);
  } finally { bare.done(); }
});

test('server script: a token that is too short or has odd characters changes nothing and deploys nothing', () => {
  const box = serverBox();
  try {
    const before = readFileSync(box.webEnv, 'utf8');
    for (const bad of ['short', 'x'.repeat(31), 'a'.repeat(129), GOOD.slice(1) + '$(touch pwned)', GOOD + '-', 'has space ' + GOOD]) {
      const r = runServer(box, bad + '\n');
      assert.notEqual(r.status, 0, bad);
      assert.equal(readFileSync(box.webEnv, 'utf8'), before, bad);
    }
    assert.ok(!existsSync(join(box.deploy, 'deployed.marker')));
    assert.ok(!existsSync(join(box.dir, 'pwned')));
  } finally { box.done(); }
});

test('server script: warns when web.env does not turn the Agent SDK on, and refuses when web.env is missing', () => {
  const box = serverBox('A=1\n');
  try {
    const r = runServer(box, GOOD + '\n', {WEAVE_SKIP_DEPLOY: '1'});
    assert.match(r.stdout, /WEAVE_AGENT_RUNTIME=sdk/);
    rmSync(box.webEnv);
    const missing = runServer(box, GOOD + '\n', {WEAVE_SKIP_DEPLOY: '1'});
    assert.notEqual(missing.status, 0);
  } finally { box.done(); }
});

// ── set-token.sh on the Mac, with the server pipeline run locally by a fake ssh ─────────────
function fakeBin(box) {
  const bin = join(box.dir, 'bin');
  mkdirSync(bin, {recursive: true});
  // ssh: record how it was called, then run the remote command locally, with the server box as "the server".
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG/ssh-argv"
[ "\${FAKE_SSH_FAIL:-}" = 1 ] && { echo "ssh: connection refused" >&2; exit 255; }
cmd="\${@: -1}"
exec bash -c "$cmd"
`, {mode: 0o755});
  // curl: 401 unless a Bearer token that matches the server's web.env arrives in the -K config on stdin.
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG/curl-argv"
config=""
for a in "$@"; do [ "$a" = "-K" ] && config=$(cat); done
want=$(sed -n 's/^WECHAT_BRIDGE_TOKEN=//p' "$FAKE_WEB_ENV" | head -1)
if [ -n "$config" ] && [ -n "$want" ] && printf '%s' "$config" | grep -qF "Authorization: Bearer $want"; then printf 200; else printf 401; fi
`, {mode: 0o755});
  return bin;
}
function macBox(webEnv) {
  const box = serverBox(webEnv), bin = fakeBin(box), logs = join(box.dir, 'logs');
  mkdirSync(logs);
  const key = join(box.dir, 'key');
  writeFileSync(key, 'not a real key');
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: box.home, FAKE_LOG: logs, FAKE_WEB_ENV: box.webEnv, WEAVE_DEPLOY_DIR: box.deploy, WEAVE_SKIP_DEPLOY: '1', WEAVE_SSH_KEY: key, WEAVE_SSH_HOST: 'ubuntu@server.invalid', WEAVE_WECHAT_HOME: join(box.dir, 'wxhome'), WEAVE_WECHAT_LAUNCH_DIR: join(box.dir, 'LaunchAgents'), WEAVE_WECHAT_NO_LAUNCHD: '1', WEAVE_WECHAT_FAKE_DNS_IP: '203.0.113.7' /* a real-looking address, so no test does a DNS lookup */};
  return {...box, env, logs, bridgeEnv: join(box.dir, 'wxhome/bridge.env')};
}

test('set-token.sh: one new token lands in web.env on the server and in bridge.env here, other lines stay, and the token is never shown', () => {
  const box = macBox();
  try {
    mkdirSync(join(box.dir, 'wxhome'), {recursive: true});
    writeFileSync(box.bridgeEnv, '# mine\nWX_TOKEN=keep-this\nWX_ACCOUNT=acc-1\n', {mode: 0o600});
    const serverBefore = readFileSync(box.webEnv, 'utf8');
    const r = bash([join(mac, 'set-token.sh')], {env: box.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const serverToken = /^WECHAT_BRIDGE_TOKEN=(.+)$/m.exec(readFileSync(box.webEnv, 'utf8'))[1];
    const localToken = /^WECHAT_BRIDGE_TOKEN=(.+)$/m.exec(readFileSync(box.bridgeEnv, 'utf8'))[1];
    assert.match(serverToken, /^[0-9a-f]{64}$/);
    assert.equal(localToken, serverToken);
    assert.equal(readFileSync(box.webEnv, 'utf8'), serverBefore.replace('WECHAT_BRIDGE_TOKEN=\n', `WECHAT_BRIDGE_TOKEN=${serverToken}\n`));
    const local = readFileSync(box.bridgeEnv, 'utf8');
    for (const line of ['# mine', 'WX_TOKEN=keep-this', 'WX_ACCOUNT=acc-1', 'WEAVE_ORIGIN=https://weave.azorashopping.site', 'WEAVE_TICK=1']) assert.ok(local.split('\n').includes(line), line);
    assert.equal(mode(box.bridgeEnv), 0o600);
    for (const where of [r.stdout, r.stderr, readFileSync(join(box.logs, 'ssh-argv'), 'utf8'), readFileSync(join(box.logs, 'curl-argv'), 'utf8')]) assert.ok(!where.includes(serverToken));
    assert.match(r.stdout, /没带令牌：HTTP 401/);
    assert.match(r.stdout, /带令牌：HTTP 200/);
    // A redeploy can be silent for minutes; without keepalives a proxy or router drops the idle connection mid-deploy.
    assert.match(readFileSync(join(box.logs, 'ssh-argv'), 'utf8'), /-o ServerAliveInterval=30 -o ServerAliveCountMax=20/);
  } finally { box.done(); }
});

test('set-token.sh: if the server step fails, the Mac config is left as it was', () => {
  const box = macBox();
  try {
    mkdirSync(join(box.dir, 'wxhome'), {recursive: true});
    writeFileSync(box.bridgeEnv, 'WECHAT_BRIDGE_TOKEN=old-token-value\n', {mode: 0o600});
    const r = bash([join(mac, 'set-token.sh')], {env: {...box.env, FAKE_SSH_FAIL: '1'}});
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(box.bridgeEnv, 'utf8'), 'WECHAT_BRIDGE_TOKEN=old-token-value\n');
    assert.match(r.stderr, /没有成功/);
  } finally { box.done(); }
});

test('set-token.sh --remove: the token is cleared on both sides and nothing is generated', () => {
  const box = macBox('WECHAT_BRIDGE_TOKEN=' + GOOD + '\nA=1\n');
  try {
    mkdirSync(join(box.dir, 'wxhome'), {recursive: true});
    writeFileSync(box.bridgeEnv, `WECHAT_BRIDGE_TOKEN=${GOOD}\nWX_TOKEN=keep\n`, {mode: 0o600});
    const r = bash([join(mac, 'set-token.sh'), '--remove'], {env: box.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(box.webEnv, 'utf8'), 'WECHAT_BRIDGE_TOKEN=\nA=1\n');
    assert.match(readFileSync(box.bridgeEnv, 'utf8'), /^WECHAT_BRIDGE_TOKEN=$/m);
    assert.match(readFileSync(box.bridgeEnv, 'utf8'), /^WX_TOKEN=keep$/m);
  } finally { box.done(); }
});

// ── login.sh with a fake wx ─────────────────────────────────────────────────────────────────
function fakeWx(box) {
  const file = join(box.dir, 'wxhome/bin/wx');
  mkdirSync(join(box.dir, 'wxhome/bin'), {recursive: true});
  mkdirSync(join(box.dir, 'wxhome/data'), {recursive: true});
  writeFileSync(join(box.dir, 'wxhome/data/api-token'), 'owner-token');
  // A stand-in for the real wx: same subcommands and JSON shapes (checked against the real 1.3.3 binary offline).
  writeFileSync(file, `#!/usr/bin/env node
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const args = process.argv.slice(2), log = process.env.FAKE_LOG + '/wx-calls', stateFile = process.env.FAKE_LOG + '/wx-state';
appendFileSync(log, args.join(' ') + '\\n');
const withValue = new Set(['--server', '--token-file', '--account', '--accounts', '--scopes', '--alias', '--after', '--limit']);
const words = [];
for (let i = 0; i < args.length; i++) { if (withValue.has(args[i])) i++; else if (!args[i].startsWith('--')) words.push(args[i]); }
const state = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = value => writeFileSync(stateFile, JSON.stringify({...state(), ...value}));
const out = value => process.stdout.write(JSON.stringify(value));
const joined = words.join(' ');
if (joined === 'version') out({version: '1.3.3', target: 'aarch64-apple-darwin'});
else if (joined === 'accounts list') out({items: state().created ? [{id: 'acc-1', alias: 'weave'}] : []});
else if (joined === 'accounts create') { save({created: true}); out({id: 'acc-1'}); }
else if (joined === 'account status') out({authenticated: !!state().loggedIn});
else if (joined === 'auth login') { console.log('[QR CODE HERE]'); save({loggedIn: true}); }
else if (joined === 'tokens list') out({items: [{id: 't-old', name: 'weave-bridge', revoked: false}, {id: 't-other', name: 'other', revoked: false}]});
else if (joined === 'tokens revoke t-old') out({revoked: true});
else if (joined === 'tokens create weave-bridge') out({grant: {id: 't-new'}, token: 'SECRET-BRIDGE-KEY-123'});
else if (joined === 'events list') {
  // Like the real daemon: pages of 1 to 200 events in cursor order, {items, nextCursor}.
  const value = name => args[args.indexOf(name) + 1], after = Number(value('--after') ?? 0), limit = Number(value('--limit') ?? 100);
  if (state().failEvents || !(limit >= 1 && limit <= 200)) { console.error('invalid event cursor/limit'); process.exit(2); }
  const items = (state().events ?? []).filter(event => Number(event.cursor) > after).slice(0, limit);
  out({items, nextCursor: items.length ? items[items.length - 1].cursor : String(after)});
}
else { console.error('unexpected: ' + joined); process.exit(2); }
`, {mode: 0o755});
  return file;
}

test('login.sh: shows the scan line before the QR, logs in once, replaces the old bridge key, and writes the new one without printing it', () => {
  const box = macBox();
  try {
    fakeWx(box);
    mkdirSync(join(box.dir, 'wxhome'), {recursive: true});
    writeFileSync(box.bridgeEnv, `WECHAT_BRIDGE_TOKEN=${GOOD}\n`, {mode: 0o600});
    const r = bash([join(mac, 'login.sh')], {env: box.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.indexOf('用小号扫这个二维码') >= 0 && r.stdout.indexOf('用小号扫这个二维码') < r.stdout.indexOf('[QR CODE HERE]'));
    // A re-login uses the saved credentials first and may show no QR at all; the header must not leave her waiting for one.
    assert.ok(r.stdout.indexOf('可能不出二维码') >= 0 && r.stdout.indexOf('可能不出二维码') < r.stdout.indexOf('[QR CODE HERE]'));
    const calls =readFileSync(join(box.logs, 'wx-calls'), 'utf8').split('\n').filter(Boolean);
    assert.equal(calls.filter(c => /auth login/.test(c)).length, 1);
    assert.ok(!calls.find(c => /auth login/.test(c)).includes('--json'), 'the QR is only drawn without --json');
    assert.ok(calls.some(c => /tokens revoke t-old/.test(c)));
    assert.ok(!calls.some(c => /tokens revoke t-other/.test(c)));
    const create = calls.find(c => /tokens create weave-bridge/.test(c));
    assert.match(create, /--accounts acc-1 --scopes read --scopes send/);
    const env = readFileSync(box.bridgeEnv, 'utf8');
    assert.match(env, /^WX_TOKEN=SECRET-BRIDGE-KEY-123$/m);
    assert.match(env, /^WX_ACCOUNT=acc-1$/m);
    assert.match(env, new RegExp(`^WECHAT_BRIDGE_TOKEN=${GOOD}$`, 'm'));
    assert.equal(mode(box.bridgeEnv), 0o600);
    assert.ok(!(r.stdout + r.stderr).includes('SECRET-BRIDGE-KEY-123'));
  } finally { box.done(); }
});

test('login.sh: asks for set-token.sh first when there is no bridge token, and does not start a login', () => {
  const box = macBox();
  try {
    fakeWx(box);
    const r = bash([join(mac, 'login.sh')], {env: box.env});
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /set-token\.sh/);
    assert.ok(!existsSync(join(box.logs, 'wx-calls')) || !/auth login/.test(readFileSync(join(box.logs, 'wx-calls'), 'utf8')));
  } finally { box.done(); }
});

test('login.sh: a small account that is already signed in is not asked to scan again', () => {
  const box = macBox();
  try {
    fakeWx(box);
    writeFileSync(join(box.logs, 'wx-state'), JSON.stringify({created: true, loggedIn: true}));
    mkdirSync(join(box.dir, 'wxhome'), {recursive: true});
    writeFileSync(box.bridgeEnv, `WECHAT_BRIDGE_TOKEN=${GOOD}\n`, {mode: 0o600});
    const r = bash([join(mac, 'login.sh')], {env: box.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!r.stdout.includes('用小号扫这个二维码'));
    assert.ok(!/auth login/.test(readFileSync(join(box.logs, 'wx-calls'), 'utf8')));
  } finally { box.done(); }
});

// ── a proxy app in TUN + fake-ip mode: wx cannot be given a proxy, but it is captured anyway ──────────────────────────
test('the proxy check tells the proxy app\'s fake addresses (198.18.0.0/15) from real ones', () => {
  const box = sandbox();
  try {
    for (const [ip, expected] of [['198.18.0.100', 'captured'], ['198.19.3.4', 'captured'], ['203.0.113.7', 'real'], ['198.20.0.1', 'real'], ['none', 'real']]) {
      assert.equal(lib(box, 'if proxy_fake_ip; then echo captured; else echo real; fi', {WEAVE_WECHAT_FAKE_DNS_IP: ip}).stdout.trim(), expected, JSON.stringify(ip));
    }
  } finally { box.done(); }
});

test('local calls to the daemon never go through a proxy named in the shell, and what was already in NO_PROXY is kept', () => {
  const box = sandbox();
  try {
    const r = lib(box, 'printf "%s|%s" "$NO_PROXY" "$no_proxy"', {NO_PROXY: 'example.com', no_proxy: '', http_proxy: 'http://127.0.0.1:1082'});
    assert.equal(r.stdout, '127.0.0.1,localhost,example.com|127.0.0.1,localhost');
  } finally { box.done(); }
});

test('login.sh warns before the QR when the proxy app has captured the network, and says nothing when it has not', () => {
  const caught = macBox();
  try {
    fakeWx(caught);
    mkdirSync(join(caught.dir, 'wxhome'), {recursive: true});
    writeFileSync(caught.bridgeEnv, `WECHAT_BRIDGE_TOKEN=${GOOD}\n`, {mode: 0o600});
    const r = bash([join(mac, 'login.sh')], {env: {...caught.env, WEAVE_WECHAT_FAKE_DNS_IP: '198.18.0.100'}});
    assert.equal(r.status, 0, r.stdout + r.stderr);   // not a terminal here, so it cannot ask and carries on
    assert.match(r.stdout, /代理软件正在接管所有联网/);
    assert.match(r.stdout, /彻底退出/);
    assert.ok(r.stdout.indexOf('代理软件正在接管') < r.stdout.indexOf('用小号扫这个二维码'));
  } finally { caught.done(); }
  const clean = macBox();
  try {
    fakeWx(clean);
    mkdirSync(join(clean.dir, 'wxhome'), {recursive: true});
    writeFileSync(clean.bridgeEnv, `WECHAT_BRIDGE_TOKEN=${GOOD}\n`, {mode: 0o600});
    const r = bash([join(mac, 'login.sh')], {env: {...clean.env, WEAVE_WECHAT_FAKE_DNS_IP: '203.0.113.7'}});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!r.stdout.includes('代理软件正在接管'));
  } finally { clean.done(); }
});

// ── install.sh end to end: a fake macOS toolchain, a fake download and a fake wx; nothing leaves the temp directory ──
const PINNED_SHA = '64d9098cbe329069f73b0ddecc22c6e57d388f2c47b593412d9dc80d15fcc394';
function installBox() {
  const box = macBox(), source = join(box.dir, 'wx-source'), ibin = join(box.dir, 'ibin');
  const wx = fakeWx(box);
  renameSync(wx, source);   // the fake wx is what the "download" delivers, not something already installed
  mkdirSync(ibin, {recursive: true});
  const tool = (name, body) => writeFileSync(join(ibin, name), `#!/usr/bin/env bash\n${body}\n`, {mode: 0o755});
  tool('uname', 'case "$1" in -m) echo arm64;; *) echo Darwin;; esac');
  tool('plutil', 'exit 0');
  tool('launchctl', 'exit 0');
  tool('shasum', `printf '%s  %s\\n' "\${FAKE_SHA:-${PINNED_SHA}}" "\${@: -1}"`);
  tool('curl', `printf '%s\\n' "$*" >> "$FAKE_LOG/curl-argv"
case "$*" in
  *releases/download/*) out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done; cp "$FAKE_WX_SOURCE" "$out"; exit 0 ;;
  *127.0.0.1:6179/v1/*) exit 0 ;;
esac
echo "unexpected curl: $*" >&2; exit 99`);
  return {...box, env: {...box.env, PATH: `${ibin}:${box.env.PATH}`, FAKE_WX_SOURCE: source}};
}

test('install.sh: downloads the pinned wx so an interrupted download resumes, installs it, writes the three launchd files and a bridge.env that turns the tick on', () => {
  const box = installBox();
  try {
    const r = bash([join(mac, 'install.sh'), '--keep-awake'], {env: box.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /校验通过/);
    assert.match(r.stdout, /wx 版本：1\.3\.3（目标 aarch64-apple-darwin）/);
    const download = readFileSync(join(box.logs, 'curl-argv'), 'utf8').split('\n').find(line => line.includes('releases/download/'));
    assert.ok(download.includes('https://github.com/thisnick/agent-wechat/releases/download/v1.3.3/wx-v1.3.3-darwin-arm64'), download);
    // Resumable, and no total time limit: a slow line through a proxy took about 8 minutes for the 29 MB.
    assert.match(download, / -C - /);
    assert.match(download, /--speed-time 60/);
    assert.ok(!download.includes('--max-time'), download);
    const wxBin = join(box.dir, 'wxhome/bin/wx');
    assert.equal(mode(wxBin), 0o755);
    assert.ok(!existsSync(join(box.dir, 'wxhome/bin/.wx-download.part')));
    for (const name of ['daemon', 'bridge', 'awake']) assert.ok(existsSync(join(box.dir, 'LaunchAgents', `com.weave.wechat.${name}.plist`)), name);
    const env = readFileSync(box.bridgeEnv, 'utf8');
    for (const line of ['WEAVE_ORIGIN=https://weave.azorashopping.site', 'WX_BASE_URL=http://127.0.0.1:6179/v1', 'WEAVE_TICK=1']) assert.ok(env.split('\n').includes(line), line);
    for (const dir of ['wxhome', 'wxhome/bin', 'wxhome/data', 'wxhome/logs', 'wxhome/state']) assert.equal(mode(join(box.dir, dir)), 0o700, dir);
    // A second run finds the right wx in place and downloads nothing.
    const again = bash([join(mac, 'install.sh')], {env: box.env});
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /已经装好了，跳过下载/);
    assert.equal(readFileSync(join(box.logs, 'curl-argv'), 'utf8').split('\n').filter(line => line.includes('releases/download/')).length, 1);
  } finally { box.done(); }
});

test('install.sh: a download whose SHA-256 is not the pinned one is deleted and nothing is installed', () => {
  const box = installBox();
  try {
    const r = bash([join(mac, 'install.sh')], {env: {...box.env, FAKE_SHA: 'deadbeef'.repeat(8)}});
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /校验没通过/);
    assert.ok(!existsSync(join(box.dir, 'wxhome/bin/wx')));
    assert.ok(!existsSync(join(box.dir, 'wxhome/bin/.wx-download.part')));
    assert.ok(!existsSync(join(box.dir, 'LaunchAgents')));
  } finally { box.done(); }
});

// ── status.sh: why the account is logged out is only in the daemon's event log, so status.sh shows the latest connection event ──
const SECRET = 'SECRET-BODY';
function eventLog() {
  const stamp = n => `2030-01-01T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}+00:00`;
  const events = [];
  for (let cursor = 1; cursor <= 450; cursor++) events.push({cursor: String(cursor), kind: 'message.committed', createdAt: stamp(cursor), data: {messageId: 'm' + cursor, direction: 'incoming', body: SECRET}});
  const set = (cursor, kind, data) => { events[cursor - 1] = {cursor: String(cursor), kind, createdAt: stamp(cursor), data}; };
  set(5, 'account.connection', {state: 'connection_unavailable'});
  set(130, 'account.connection', {state: 'auth_required', source: 'push', serviceCode: -13, authentication: 'logged_out', body: SECRET});
  set(433, 'account.connection', {state: 'auth_required', source: 'sync', serviceCode: -13, authentication: 'logged_out', text: SECRET, commands: [{text: SECRET}]});
  set(440, 'account.updated', {authentication: 'logged_out'});
  return events;
}
const statusBox = state => {
  const box = macBox();
  fakeWx(box);
  writeFileSync(join(box.logs, 'wx-state'), JSON.stringify(state));
  return box;
};

test('status.sh shows the most recent connection event, found across pages of 200, with its fixed fields and no message content', () => {
  const box = statusBox({created: true, events: eventLog()});
  try {
    const r = bash([join(mac, 'status.sh')], {env: box.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /== 最近一次连接事件/);
    assert.ok(r.stdout.includes('account.connection state=auth_required source=sync serviceCode=-13 authentication=logged_out（2030-01-01T00:07:13+00:00，事件号 433）'), r.stdout);
    assert.ok(!r.stdout.includes('source=push') && !r.stdout.includes('connection_unavailable'), 'only the latest one');
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
    // It pages like the real daemon (never more than 200 at a time) and stops when a page comes back empty.
    const pages = readFileSync(join(box.logs, 'wx-calls'), 'utf8').split('\n').filter(line => line.includes('events list'));
    assert.deepEqual(pages.map(line => /--after (\d+) --limit (\d+)/.exec(line).slice(1)), [['0', '200'], ['200', '200'], ['400', '200'], ['450', '200']]);
  } finally { box.done(); }
});

test('status.sh says so when there is no connection event yet, when the event log cannot be read, and shows nothing about it when there is no account', () => {
  const none = statusBox({created: true, events: [{cursor: '1', kind: 'message.committed', createdAt: 'x', data: {}}]});
  try {
    const r = bash([join(mac, 'status.sh')], {env: none.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /== 最近一次连接事件[^\n]*\n（还没有）/);
  } finally { none.done(); }
  const broken = statusBox({created: true, failEvents: true});
  try {
    const r = bash([join(mac, 'status.sh')], {env: broken.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /== 最近一次连接事件[^\n]*\n（读不到）/);
  } finally { broken.done(); }
  const empty = statusBox({});
  try {
    const r = bash([join(mac, 'status.sh')], {env: empty.env});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /还没有账号/);
    assert.ok(!r.stdout.includes('最近一次连接事件'));
  } finally { empty.done(); }
});

test('stop.sh and status.sh run without anything installed; stop.sh refuses an option it does not know', () => {
  const box = macBox();
  try {
    assert.equal(bash([join(mac, 'status.sh')], {env: box.env}).status, 0);
    assert.equal(bash([join(mac, 'stop.sh')], {env: box.env}).status, 0);
    assert.notEqual(bash([join(mac, 'stop.sh'), '--wipe-everything'], {env: box.env}).status, 0);
    mkdirSync(join(box.dir, 'LaunchAgents'), {recursive: true});
    writeFileSync(join(box.dir, 'LaunchAgents/com.weave.wechat.bridge.plist'), 'x');
    assert.equal(bash([join(mac, 'stop.sh'), '--uninstall'], {env: box.env}).status, 0);
    assert.ok(!existsSync(join(box.dir, 'LaunchAgents/com.weave.wechat.bridge.plist')));
  } finally { box.done(); }
});

test('the scripts are executable and pass bash -n', () => {
  for (const file of [...['lib.sh', 'install.sh', 'set-token.sh', 'login.sh', 'status.sh', 'stop.sh', 'wx.sh'].map(f => join(mac, f)), server]) {
    assert.equal(bash(['-n', file]).status, 0, file);
    if (!file.endsWith('lib.sh')) assert.ok(mode(file) & 0o100, file + ' is not executable');
  }
});

test('no script has a bare $name right before a non-ASCII character: bash 3.2 reads the first byte as part of the name and dies with "unbound variable"', () => {
  const scripts = ['lib.sh', 'install.sh', 'set-token.sh', 'login.sh', 'status.sh', 'stop.sh', 'wx.sh'].map(f => join(mac, f)).concat(server);
  for (const file of scripts) {
    const bad = readFileSync(file, 'utf8').split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line));
    assert.deepEqual(bad, [], file + ': write ${name} here');
  }
});
