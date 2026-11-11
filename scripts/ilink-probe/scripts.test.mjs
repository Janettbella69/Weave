// start.sh / status.sh / stop.sh：从临时目录里的一份拷贝真跑，PATH 上放一个假的 docker（记下每次调用、按状态文件回答）。
// 不碰 Docker、网络和微信，也不往这个仓库里写东西。
//   node --test scripts/ilink-probe/scripts.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const lib = readFileSync(join(here, 'lib.sh'), 'utf8');

// 假 docker：状态放在 $FAKE/state 下几个文件里（running、stopped、account、volume），每次调用追加一行到 $FAKE/calls。
const FAKE_DOCKER = `#!/usr/bin/env bash
s="$FAKE/state"; mkdir -p "$s"
printf '%s\\n' "$*" >> "$FAKE/calls"
case "$1" in
  inspect)
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
      *" test -f /home/node/account.json"*) touch "$s/volume"; [ -e "$s/account" ]; exit $? ;;
      *" status"*) echo "PROBE-STATUS"; exit 0 ;;
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

function sandbox({account = false, running = false, stopped = false} = {}) {
  const box = mkdtempSync(join(tmpdir(), 'ilink-probe-sh-'));
  const scripts = join(box, 'ilink-probe');
  cpSync(here, scripts, {recursive: true});
  const bin = join(box, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const fake = join(box, 'fake');
  mkdirSync(join(fake, 'state'), {recursive: true});
  for (const [flag, on] of Object.entries({account, running, stopped})) if (on) writeFileSync(join(fake, 'state', flag), '');
  if (account) writeFileSync(join(fake, 'state', 'volume'), '');
  const run = (script, args = [], env = {}) => spawnSync('bash', [join(scripts, script), ...args], {
    encoding: 'utf8',
    env: {PATH: `${bin}:/usr/bin:/bin`, HOME: box, FAKE: fake, PROBE_SETTLE_SECONDS: '0', ...env},
  });
  const calls = () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  const has = flag => existsSync(join(fake, 'state', flag));
  return {run, calls, has, scripts};
}

test('lib.sh pins the same Node image the WeChat bridge already uses on the server', () => {
  const wechatLib = readFileSync(join(root, 'deploy/tencent/wechat/lib.sh'), 'utf8');
  const bridgeImage = /^BRIDGE_IMAGE=(.+)$/m.exec(wechatLib)[1];
  assert.equal(/^IMAGE=(.+)$/m.exec(lib)[1], bridgeImage);
  assert.match(bridgeImage, /^node:22-alpine@sha256:[0-9a-f]{64}$/);
});

test('start.sh with no account: scan first in an interactive one-off container, then start the locked-down daemon', () => {
  const box = sandbox();
  const result = box.run('start.sh', [], {PROBE_TTY: '1'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = box.calls();
  const login = calls.find(call => call.startsWith('run ') && call.includes(' -it '));
  assert.ok(login, calls.join('\n'));
  assert.match(login, /qrcode-terminal@0\.12\.0/);
  assert.match(login, /node \/app\/probe\.mjs login/);
  const daemon = calls.find(call => call.startsWith('run -d '));
  assert.ok(daemon, calls.join('\n'));
  assert.ok(calls.indexOf(login) < calls.indexOf(daemon));
  for (const part of ['--name ilink-probe', '--restart unless-stopped', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--user node', '--memory 96m', '-v ilink-probe-data:/home/node', '/app:ro', 'node /app/probe.mjs run']) {
    assert.ok(daemon.includes(part), `daemon is missing ${part}: ${daemon}`);
  }
  assert.ok(box.has('running'));
  assert.match(result.stdout, /测试开始了 ✅/);
});

test('start.sh does not start a second copy when the test is already running', () => {
  const box = sandbox({account: true, running: true});
  const result = box.run('start.sh', [], {PROBE_TTY: '1'});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!box.calls().some(call => call.startsWith('run -d ') || call.includes(' -it ')));
  assert.match(result.stdout, /已经在跑了/);
  assert.match(result.stdout, /PROBE-STATUS/);
});

test('start.sh without a terminal refuses to scan and starts nothing', () => {
  const box = sandbox();
  const result = box.run('start.sh');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ssh -t/);
  assert.ok(!box.calls().some(call => call.startsWith('run -d ') || call.includes(' -it ')));
});

test('start.sh starts nothing when the scan does not complete', () => {
  const box = sandbox();
  const result = box.run('start.sh', [], {PROBE_TTY: '1', FAKE_LOGIN: 'fail'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /没连上/);
  assert.ok(!box.calls().some(call => call.startsWith('run -d ')));
  assert.ok(!box.has('running'));
});

test('start.sh with an account but a stopped container replaces the container without scanning again', () => {
  const box = sandbox({account: true, stopped: true});
  const result = box.run('start.sh', [], {PROBE_TTY: '1'});
  assert.equal(result.status, 0, result.stderr);
  const calls = box.calls();
  assert.ok(!calls.some(call => call.includes(' -it ')));
  assert.ok(calls.indexOf('rm ilink-probe') < calls.findIndex(call => call.startsWith('run -d ')), calls.join('\n'));
  assert.ok(box.has('running'));
});

test('stop.sh stops gracefully and keeps the data; --delete-data also removes the volume', () => {
  const box = sandbox({account: true, running: true});
  let result = box.run('stop.sh');
  assert.equal(result.status, 0, result.stderr);
  const calls = box.calls();
  assert.ok(calls.indexOf('stop -t 15 ilink-probe') >= 0 && calls.indexOf('stop -t 15 ilink-probe') < calls.indexOf('rm ilink-probe'), calls.join('\n'));
  assert.ok(box.has('volume'));
  assert.match(result.stdout, /数据还留着/);
  result = box.run('stop.sh', ['--delete-data']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!box.has('volume'));
  assert.match(result.stdout, /删掉了/);
});

test('status.sh says whether the test is running and prints the probe summary', () => {
  const box = sandbox({account: true, running: true});
  const result = box.run('status.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /在跑/);
  assert.match(result.stdout, /PROBE-STATUS/);
});

test('the scripts only ever touch their own container, volume and image', () => {
  const box = sandbox();
  box.run('start.sh', [], {PROBE_TTY: '1'});
  box.run('status.sh');
  box.run('stop.sh', ['--delete-data']);
  const image = /^IMAGE=(.+)$/m.exec(lib)[1];
  for (const call of box.calls()) {
    const rest = call.replaceAll(image, '').replaceAll(box.scripts, '');
    assert.doesNotMatch(rest, /weave|wechat|azora|docker\.sock|--privileged|--network host|-p /i, call);
  }
});
