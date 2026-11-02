import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dockerArgs, isolationFor} from '../sandbox.mjs';
import {scopeFor} from '../scopes.mjs';

const dirs = {workspace: '/srv/weave/owner/ab12/workspace', config: '/srv/weave/owner/ab12/claude', home: '/srv/weave/owner/ab12/home'};

test('dockerArgs：断网、只读根目录、限资源，只挂工作目录、配置目录、只读插件和代理 socket', () => {
  const args = dockerArgs({
    scope: scopeFor('owner'), dirs, pluginDir: '/opt/app/plugin', socketDir: '/srv/weave/run', image: 'weave-agent:0.3.316',
    name: 'weave-run-abc', uid: 1001, gid: 1001,
    env: {ANTHROPIC_AUTH_TOKEN: 'run-token', HOME: '/home/agent', SKIPPED: undefined},
    cliArgs: ['--output-format', 'stream-json'],
  });
  assert.deepEqual(args, [
    'run', '-i', '--rm', '--init', '--name', 'weave-run-abc', '--user', '1001:1001', '--network', 'none',
    '--memory', '1g', '--cpus', '1', '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/home/agent:uid=1001,gid=1001',
    '-w', '/workspace', '-v', '/srv/weave/owner/ab12/workspace:/workspace', '-v', '/srv/weave/owner/ab12/claude:/home/agent/.claude',
    '-v', '/opt/app/plugin:/opt/weave/plugin:ro', '-v', '/srv/weave/run:/run/weave',
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

test('不认识的隔离方式直接报错，不会静默退回不隔离', () => {
  assert.throws(() => isolationFor({mode: 'none', scope: scopeFor('owner'), dirs, pluginDir: '/p', proxy: {}}));
});
