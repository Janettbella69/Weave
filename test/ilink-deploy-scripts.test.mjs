// deploy/tencent/ilink: login.sh / start.sh / stop.sh / status.sh run for real from a copy in a temp directory, with a fake docker on PATH
// (it records every call and answers from a few state files). No Docker, network or WeChat; nothing is written into this repository.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const here = join(root, 'deploy/tencent/ilink');
const lib = readFileSync(join(here, 'lib.sh'), 'utf8');
const TOKEN = 'a'.repeat(40);

// State in $FAKE/state (running, stopped, account, volume, probe); every call is appended to $FAKE/calls.
const FAKE_DOCKER = `#!/usr/bin/env bash
s="$FAKE/state"; mkdir -p "$s"
printf '%s\\n' "$*" >> "$FAKE/calls"
case "$1" in
  inspect)
    name="\${@: -1}"
    if [ "$name" = ilink-probe ]; then [ -e "$s/probe" ] && { echo true; exit 0; }; exit 1; fi
    if [ "$2" = -f ]; then
      [ -e "$s/running" ] && { echo true; exit 0; }
      [ -e "$s/stopped" ] && { echo false; exit 0; }
      exit 1
    fi
    [ -e "$s/running" ] || [ -e "$s/stopped" ]; exit $? ;;
  run)
    case " $* " in
      *" -d "*) touch "$s/volume"; rm -f "$s/stopped"; touch "$s/running"; echo container-id; exit 0 ;;
      *" -it "*) touch "$s/volume"; [ "\${FAKE_LOGIN:-ok}" = ok ] || { echo "登录失败"; exit 1; }; touch "$s/account"; echo "已连上 ✅"; exit 0 ;;
      *" test -s /home/node/accounts.json"*) [ -e "$s/account" ]; exit $? ;;
      *" status"*) echo "BRIDGE-STATUS"; exit 0 ;;
    esac
    echo "fake docker: unexpected run $*" >&2; exit 9 ;;
  stop) [ -e "$s/running" ] && { rm -f "$s/running"; touch "$s/stopped"; }; exit 0 ;;
  rm) rm -f "$s/running" "$s/stopped"; exit 0 ;;
  volume)
    [ "$2" = inspect ] && { [ -e "$s/volume" ]; exit $?; }
    [ "$2" = rm ] && [ -e "$s/volume" ] && { rm -f "$s/volume" "$s/account"; exit 0; }
    exit 1 ;;
  logs) echo "fake logs"; exit 0 ;;
esac
echo "fake docker: unexpected $*" >&2; exit 9
`;

function sandbox({account = false, running = false, stopped = false, probe = false, webEnv = `WECHAT_BRIDGE_TOKEN=${TOKEN}\nWEAVE_AGENT_RUNTIME=sdk\n`} = {}) {
  const box = mkdtempSync(join(tmpdir(), 'ilink-sh-'));
  // The scripts find the repository two levels up from deploy/tencent, so copy the same layout.
  const scripts = join(box, 'repo/deploy/tencent/ilink');
  mkdirSync(scripts, {recursive: true});
  cpSync(here, scripts, {recursive: true});
  const bin = join(box, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const fake = join(box, 'fake');
  mkdirSync(join(fake, 'state'), {recursive: true});
  for (const [flag, on] of Object.entries({account, running, stopped, probe})) if (on) writeFileSync(join(fake, 'state', flag), '');
  if (account) writeFileSync(join(fake, 'state', 'volume'), '');
  const web = join(box, 'web.env');
  if (webEnv !== null) writeFileSync(web, webEnv);
  const run = (script, args = [], env = {}) => spawnSync('bash', [join(scripts, script), ...args], {
    encoding: 'utf8', env: {PATH: `${bin}:/usr/bin:/bin`, HOME: box, FAKE: fake, WEAVE_WEB_ENV: web, WEAVE_ILINK_SETTLE_SECONDS: '0', ...env},
  });
  const calls = () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  return {run, calls, has: flag => existsSync(join(fake, 'state', flag)), scripts, bridgeEnv: join(scripts, 'bridge.env')};
}

test('lib.sh pins the same Node image the WeChat bridge already uses on the server', () => {
  const wechatLib = readFileSync(join(root, 'deploy/tencent/wechat/lib.sh'), 'utf8');
  const bridgeImage = /^BRIDGE_IMAGE=(.+)$/m.exec(wechatLib)[1];
  assert.equal(/^IMAGE=(.+)$/m.exec(lib)[1], bridgeImage);
});

test('lib.sh reaches Weave directly on the host (no nginx, whose 1 MB body limit would stop photos), on the port the web container binds', () => {
  assert.equal(/^ORIGIN_DEFAULT=(.+)$/m.exec(lib)[1], 'http://host.docker.internal:4317');
  const compose = readFileSync(join(root, 'deploy/tencent/compose.yml'), 'utf8');
  assert.match(compose, /:4317:4317/);
});

test('login.sh: writes bridge.env (mode 600, token copied from web.env, direct origin), scans in an interactive one-off container, and starts nothing', () => {
  const box = sandbox();
  const result = box.run('login.sh', [], {WEAVE_ILINK_TTY: '1'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const env = readFileSync(box.bridgeEnv, 'utf8');
  assert.match(env, new RegExp(`^WECHAT_BRIDGE_TOKEN=${TOKEN}$`, 'm'));
  assert.match(env, /^WEAVE_ORIGIN=http:\/\/host\.docker\.internal:4317$/m);
  assert.equal(statSync(box.bridgeEnv).mode & 0o777, 0o600);
  const login = box.calls().find(call => call.startsWith('run ') && call.includes(' -it '));
  assert.ok(login);
  assert.match(login, /qrcode-terminal@0\.12\.0/);
  assert.match(login, /node \/app\/bridge\.mjs login/);
  assert.ok(box.has('account'));
  assert.ok(!box.calls().some(call => call.startsWith('run -d ')));
  assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN) && !box.calls().join('\n').includes(TOKEN), 'the token is never printed or passed on a command line');
});

test('login.sh without a terminal, with the probe still running, or without a token: refuses and changes nothing', () => {
  let box = sandbox();
  let result = box.run('login.sh');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ssh -t/);
  assert.ok(!existsSync(box.bridgeEnv));

  box = sandbox({probe: true});
  result = box.run('login.sh', [], {WEAVE_ILINK_TTY: '1'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ilink-probe/);
  assert.ok(!box.calls().some(call => call.startsWith('run ')));

  box = sandbox({webEnv: 'WEAVE_AGENT_RUNTIME=sdk\n'});
  result = box.run('login.sh', [], {WEAVE_ILINK_TTY: '1'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WECHAT_BRIDGE_TOKEN/);
  assert.ok(!existsSync(box.bridgeEnv));
});

test('login.sh keeps the origin that bridge.env already has and does not start anything when the scan does not finish', () => {
  const box = sandbox();
  writeFileSync(box.bridgeEnv, 'WEAVE_ORIGIN=http://127.0.0.1:4317\n');
  const result = box.run('login.sh', [], {WEAVE_ILINK_TTY: '1', FAKE_LOGIN: 'fail'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /没连上/);
  assert.match(readFileSync(box.bridgeEnv, 'utf8'), /^WEAVE_ORIGIN=http:\/\/127\.0\.0\.1:4317$/m);
  assert.ok(!box.has('running'));
});

test('start.sh: a locked-down container with the host mapped in, both bridge directories read-only, its own volume, and nothing else', () => {
  const box = sandbox({account: true});
  const result = box.run('start.sh');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const daemon = box.calls().find(call => call.startsWith('run -d '));
  for (const part of ['--name ilink-bridge', '--restart unless-stopped', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--user node', '--memory 128m',
    '-v ilink-data:/home/node', '/hosted/ilink-bridge:/app:ro', '/hosted/wechat-bridge:/wechat-bridge:ro', '--add-host host.docker.internal:host-gateway', `--env-file ${box.bridgeEnv}`, 'node /app/bridge.mjs run']) {
    assert.ok(daemon.includes(part), `missing ${part}: ${daemon}`);
  }
  assert.ok(box.has('running'));
  assert.ok(!result.stdout.includes(TOKEN) && !daemon.includes(TOKEN));
});

test('start.sh with nobody connected, or the probe running, starts nothing; with a container already there it replaces it (stop, remove, run) without scanning', () => {
  let box = sandbox();
  let result = box.run('start.sh');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /login\.sh/);
  assert.ok(!box.calls().some(call => call.startsWith('run -d ')));

  box = sandbox({account: true, probe: true});
  result = box.run('start.sh');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ilink-probe/);
  assert.ok(!box.calls().some(call => call.startsWith('run -d ')));

  box = sandbox({account: true, running: true});
  result = box.run('start.sh');
  assert.equal(result.status, 0, result.stderr);
  const calls = box.calls();
  assert.ok(!calls.some(call => call.includes(' -it ')));
  assert.ok(calls.indexOf('stop -t 15 ilink-bridge') < calls.indexOf('rm ilink-bridge') && calls.indexOf('rm ilink-bridge') < calls.findIndex(call => call.startsWith('run -d ')), calls.join('\n'));
});

test('stop.sh stops gracefully and keeps the data; --delete-data also removes the volume; anything else is refused', () => {
  const box = sandbox({account: true, running: true});
  let result = box.run('stop.sh');
  assert.equal(result.status, 0, result.stderr);
  const calls = box.calls();
  assert.ok(calls.indexOf('stop -t 15 ilink-bridge') >= 0 && calls.indexOf('stop -t 15 ilink-bridge') < calls.indexOf('rm ilink-bridge'));
  assert.ok(box.has('volume'));
  assert.match(result.stdout, /数据还留着/);
  result = box.run('stop.sh', ['--delete-data']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!box.has('volume'));
  assert.notEqual(box.run('stop.sh', ['--everything']).status, 0);
});

test('status.sh says whether the bridge runs, warns about a running probe, and prints the bridge summary; it changes nothing', () => {
  const box = sandbox({account: true, running: true, probe: true});
  const result = box.run('status.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /在跑/);
  assert.match(result.stdout, /ilink-probe/);
  assert.match(result.stdout, /BRIDGE-STATUS/);
  assert.ok(box.calls().every(call => !/^(stop|rm|run -d)/.test(call)));
});

test('the scripts only ever touch their own container and volume (and only look at the probe)', () => {
  const box = sandbox({account: true});
  box.run('login.sh', [], {WEAVE_ILINK_TTY: '1'});
  box.run('start.sh');
  box.run('status.sh');
  box.run('stop.sh', ['--delete-data']);
  const image = /^IMAGE=(.+)$/m.exec(lib)[1];
  for (const call of box.calls()) {
    const rest = call.replaceAll(image, '').replaceAll(box.scripts.replace(/\/deploy\/tencent\/ilink$/, ''), '').replace('--add-host host.docker.internal:host-gateway', '').replaceAll('host.docker.internal', '').replaceAll('ilink-probe', '').replace('/hosted/wechat-bridge:/wechat-bridge:ro', '');
    assert.doesNotMatch(rest, /weave|wechat\b|azora|docker\.sock|--privileged|--network host|-p /i, call);
    if (/^(stop|rm|volume rm|run -d)/.test(call)) assert.doesNotMatch(call, /ilink-probe/);
  }
});
