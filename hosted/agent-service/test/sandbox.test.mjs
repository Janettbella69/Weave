import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dockerArgs, isolationFor, removeContainer} from '../sandbox.mjs';
import {scopeFor} from '../scopes.mjs';

const dirs = {workspace: '/srv/weave/owner/ab12/workspace', config: '/srv/weave/owner/ab12/claude', home: '/srv/weave/owner/ab12/home'};

test('dockerArgs：断网、只读根目录、限资源（swap 也限住、内存不够先杀它）；代理 socket 目录只读挂载', () => {
  const args = dockerArgs({
    scope: scopeFor('owner'), dirs, pluginDir: '/opt/app/plugin', socketDir: '/srv/weave/run', image: 'weave-agent:0.3.316',
    name: 'weave-run-abc', uid: 1001, gid: 1001,
    env: {ANTHROPIC_AUTH_TOKEN: 'run-token', HOME: '/home/agent', SKIPPED: undefined},
    cliArgs: ['--output-format', 'stream-json'],
  });
  assert.deepEqual(args, [
    'run', '-i', '--rm', '--init', '--name', 'weave-run-abc', '--user', '1001:1001', '--network', 'none',
    '--memory', '1g', '--memory-swap', '1g', '--oom-score-adj', '500', '--cpus', '1', '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:size=256m', '--tmpfs', '/home/agent:uid=1001,gid=1001,size=64m',
    '-w', '/workspace', '-v', '/srv/weave/owner/ab12/workspace:/workspace', '-v', '/srv/weave/owner/ab12/claude:/home/agent/.claude',
    '-v', '/opt/app/plugin:/opt/weave/plugin:ro', '-v', '/srv/weave/run:/run/weave:ro',
    '-e', 'ANTHROPIC_AUTH_TOKEN=run-token', '-e', 'HOME=/home/agent',
    'weave-agent:0.3.316', 'claude', '--output-format', 'stream-json',
  ]);
});

test('docker 模式：CLI 看到的是容器里的路径，模型地址是容器内 socat 转出来的端口', () => {
  const iso = isolationFor({mode: 'docker', scope: scopeFor('group'), dirs, pluginDir: '/opt/app/plugin', proxy: {socketDir: '/srv/weave/run'}, image: 'weave-agent:0.3.316', name: 'weave-run-x', uid: 1001, gid: 1001});
  assert.equal(iso.cwd, '/workspace');
  assert.equal(iso.pluginPath, '/opt/weave/plugin');
  assert.equal(iso.baseUrl, 'http://127.0.0.1:4321');
  assert.equal(iso.home, '/home/agent');
  assert.equal(iso.configDir, '/home/agent/.claude');
  assert.equal(typeof iso.spawnClaudeCodeProcess, 'function');
  assert.equal(iso.sandbox, undefined);
  assert.deepEqual(iso.allowedTools, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'mcp__weave__*']);
});

test('local 模式：文件工具只许碰工作目录；sandbox 打开时没有沙箱就直接失败', () => {
  const iso = isolationFor({mode: 'local', scope: scopeFor('owner'), dirs, pluginDir: '/opt/app/plugin', proxy: {url: 'http://127.0.0.1:5555'}});
  assert.equal(iso.cwd, dirs.workspace);
  assert.equal(iso.baseUrl, 'http://127.0.0.1:5555');
  assert.equal(iso.home, dirs.home);
  assert.equal(iso.configDir, dirs.config);
  assert.equal(iso.spawnClaudeCodeProcess, undefined);
  assert.deepEqual(iso.allowedTools, ['Bash', 'Read(./**)', 'Edit(./**)', 'Glob', 'Grep', 'Skill', 'WebSearch', 'mcp__weave__*']);
  assert.deepEqual(iso.sandbox, {enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: {allowedDomains: []}});
  assert.equal(isolationFor({mode: 'local', scope: scopeFor('owner'), dirs, pluginDir: '/p', proxy: {url: 'http://x'}, sandbox: false}).sandbox, undefined);
});

test('removeContainer 等 docker rm 真正结束才返回；没有这个容器、或别的错误都不抛', async () => {
  let finished = false;
  await removeContainer('weave-run-x', (cmd, args, callback) => setTimeout(() => { finished = true; callback(null, '', ''); }, 50));
  assert.equal(finished, true, '返回时 docker rm 应该已经结束');
  const calls = [];
  await removeContainer('weave-run-y', (cmd, args, callback) => { calls.push([cmd, args]); callback(Error('exit 1'), '', 'Error: No such container: weave-run-y'); });
  assert.deepEqual(calls, [['docker', ['rm', '-f', 'weave-run-y']]]);
  await removeContainer('weave-run-z', (cmd, args, callback) => callback(Error('Cannot connect to the Docker daemon'), '', ''));
});

test('不认识的隔离方式直接报错，不会静默退回不隔离', () => {
  assert.throws(() => isolationFor({mode: 'none', scope: scopeFor('owner'), dirs, pluginDir: '/p', proxy: {}}));
});

test('dockerArgs 用传入的内存上限，不传就是 1g', () => {
  const base = {scope: scopeFor('owner'), dirs, pluginDir: '/p', socketDir: '/s', image: 'i', name: 'n', uid: 1000, gid: 1000, env: {}, cliArgs: []};
  const memoryOf = args => args[args.indexOf('--memory') + 1];
  assert.equal(memoryOf(dockerArgs({...base, memory: '768m'})), '768m');
  assert.equal(memoryOf(dockerArgs(base)), '1g');
});

test('swap 上限跟着内存上限走，不会多占一倍', () => {
  const base = {scope: scopeFor('owner'), dirs, pluginDir: '/p', socketDir: '/s', image: 'i', name: 'n', uid: 1000, gid: 1000, env: {}, cliArgs: []};
  const args = dockerArgs({...base, memory: '768m'});
  assert.equal(args[args.indexOf('--memory-swap') + 1], '768m');
});
