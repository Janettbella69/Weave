// CLI 跑在哪（docs/ARCHITECTURE.md 第 6 节）。
// docker：每次唤醒一个用完即删的容器。owner 和 group 用 --network none，连本机也不通；
//   模型请求经挂进来的 Unix socket 到 Agent 服务里的模型代理，容器里由 socat 转成 127.0.0.1:4321。
// local：只给没有 Docker 的本机开发用。SDK 的 sandbox 管 Bash（断网、写不出工作目录），
//   路径规则 Read(./**)、Edit(./**) 管文件工具（sandbox 管不到 Write，实测）。
import {spawn} from 'node:child_process';

const IN_CONTAINER = {
  cwd: '/workspace',
  pluginPath: '/opt/weave/plugin',
  baseUrl: 'http://127.0.0.1:4321',
  home: '/home/agent',
  configDir: '/home/agent/.claude',
  path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
};

export function dockerArgs({scope, dirs, pluginDir, socketDir, image, name, uid, gid, env, cliArgs, memory = '1g'}) {
  return [
    'run', '-i', '--rm', '--init', '--name', name, '--user', `${uid}:${gid}`, '--network', scope.network,
    // swap 上限等于内存上限（不额外占 swap）；内存不够时内核先杀它，不杀同机的其他服务。
    '--memory', memory, '--memory-swap', memory, '--oom-score-adj', '500', '--cpus', '1', '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:size=256m', '--tmpfs', `/home/agent:uid=${uid},gid=${gid},size=64m`,
    '-w', IN_CONTAINER.cwd,
    '-v', `${dirs.workspace}:${IN_CONTAINER.cwd}`,
    '-v', `${dirs.config}:${IN_CONTAINER.configDir}`,
    '-v', `${pluginDir}:${IN_CONTAINER.pluginPath}:ro`,
    // 所有容器共用这一个 socket，所以只读：连接 socket 不受影响，删掉或换掉它都会被拒绝（EROFS）。
    '-v', `${socketDir}:/run/weave:ro`,
    ...Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : ['-e', `${key}=${value}`]),
    image, 'claude', ...cliArgs,
  ];
}

export function isolationFor({mode, scope, dirs, pluginDir, proxy, image, name, uid, gid, sandbox = true, memory = '1g'}) {
  if (mode === 'docker') {
    return {
      ...IN_CONTAINER,
      allowedTools: [...scope.builtins, 'mcp__weave__*'],
      // SDK 传来的 command 是宿主机上的 CLI 路径，用不上；容器里有同版本的 claude。
      spawnClaudeCodeProcess: ({args, env, signal}) => spawn('docker',
        dockerArgs({scope, dirs, pluginDir, socketDir: proxy.socketDir, image, name, uid, gid, env, cliArgs: args, memory}),
        {stdio: ['pipe', 'pipe', 'inherit'], signal}),
    };
  }
  if (mode === 'local') {
    const fileTools = {Read: ['Read(./**)'], Edit: ['Edit(./**)'], Write: []};
    return {
      cwd: dirs.workspace,
      pluginPath: pluginDir,
      baseUrl: proxy.url,
      home: dirs.home,
      configDir: dirs.config,
      path: process.env.PATH,
      allowedTools: [...scope.builtins.flatMap(t => fileTools[t] ?? [t]), 'mcp__weave__*'],
      ...(sandbox ? {sandbox: {enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: {allowedDomains: []}}} : {}),
    };
  }
  throw Error(`不支持的隔离方式：${mode}`);
}
