// 每个人（或每个群）一个空间（docs/ARCHITECTURE.md「本子」）：
//   workspace/  Agent 的工作目录，也是它的本子：MEMORY.md、records.db（notebook.mjs）、笔记、脚本，挂进容器
//   claude/     SDK 的配置和会话记录，挂进容器
//   home/       本机模式下 CLI 的 HOME
//   archive/    压缩前存档的会话原文，在工作目录外，Agent 改不到
//   sessions.json  这个人的那一段会话的编号，放在工作目录外，Agent 改不到
// 目录名是 id 的哈希，id 里写什么都跑不出数据目录。
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, readFile, writeFile, rename, rm, chmod, readdir, open, lstat} from 'node:fs/promises';
import {join} from 'node:path';

const KINDS = ['owner', 'group'];
const MEMORY_LIMIT = 20000;

export function scopeDirs(dataDir, kind, id) {
  if (!KINDS.includes(kind)) throw Error(`不支持的范围：${kind}`);
  if (typeof id !== 'string' || !id) throw Error('缺少 id');
  const root = join(dataDir, kind, createHash('sha256').update(id).digest('hex').slice(0, 32));
  // archive：压缩前存档的会话原文（live.mjs 的 PreCompact 钩子），在工作目录外，Agent 改不到。
  return {root, workspace: join(root, 'workspace'), config: join(root, 'claude'), home: join(root, 'home'), archive: join(root, 'archive')};
}

export async function prepare(dirs) {
  for (const dir of [dirs.workspace, dirs.config, dirs.home, dirs.archive]) await mkdir(dir, {recursive: true, mode: 0o700});
}

// 只读普通文件：Agent 能把记忆文件换成指向别处的链接（比如 /proc/self/environ），那样会把服务进程里的东西读到网页上。
async function readPlainFile(path, limit) {
  let handle;
  try {
    // O_NOFOLLOW：是链接就直接打不开，检查和读取之间没有空隙。
    // O_NONBLOCK：Agent 能把它换成命名管道（FIFO），阻塞的 open 会一直等写入方、占住线程池；普通文件不受影响。
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return '';
    return (await handle.readFile('utf8')).slice(0, limit);
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}
// 记忆用 SDK 自带的（providers.mjs）：$CLAUDE_CONFIG_DIR/projects/<CLI 看到的工作目录，非字母数字换成短横线>/memory/。
// cwd 是 CLI 看到的工作目录：容器里是 /workspace，本机开发是宿主上的路径（2026-11-16 用假模型核过这条规则）。
export const memoryDir = (dirs, cwd) => join(dirs.config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');

// 以前的记忆写在工作目录的 MEMORY.md，由 Agent 服务拼进系统提示。第一次用 SDK 自带的记忆时，把它原样挪进记忆目录
// 当索引（那里还没有 MEMORY.md 才挪），免得工作目录里还留着第二份。链接、管道之类的不挪。
export async function moveOldMemory(dirs, cwd) {
  const from = join(dirs.workspace, 'MEMORY.md'), dir = memoryDir(dirs, cwd), to = join(dir, 'MEMORY.md');
  const info = await lstat(from).catch(() => null);
  if (!info?.isFile() || await lstat(to).catch(() => null)) return false;
  await mkdir(dir, {recursive: true, mode: 0o700});
  await rename(from, to);
  return true;
}

// 网页「记忆」页（她 11-03：按文件显示，文件名 + 原文，只读）。MEMORY.md 排第一。
export async function readMemoryFiles(dirs, cwd, {limit = MEMORY_LIMIT, max = 50} = {}) {
  const dir = memoryDir(dirs, cwd);
  const names = (await readdir(dir, {withFileTypes: true}).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name)
    .sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b))).slice(0, max);
  const files = [];
  for (const name of names) files.push({name, text: await readPlainFile(join(dir, name), limit)});
  return files;
}

const sessionsFile = dirs => join(dirs.root, 'sessions.json');

// 一个人（或一个群）只有一段会话，一直接着用，不按日期切（docs/ARCHITECTURE.md「一直在线」）。
// 太长了由 SDK 自动压缩；这里只记它的编号，常驻会话关掉以后下一次用 resume 接上。
export async function sessionFor(dirs) {
  try {
    const saved = JSON.parse(await readFile(sessionsFile(dirs), 'utf8'));
    return typeof saved?.sessionId === 'string' ? saved.sessionId : null;
  } catch {
    return null;
  }
}

export async function saveSession(dirs, sessionId) {
  const temporary = join(dirs.root, `sessions.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({sessionId}));
  await rename(temporary, sessionsFile(dirs));
}

export async function clearSession(dirs) {
  await rm(sessionsFile(dirs), {force: true});
}

// Agent 能用 Bash 把子目录改成 000，rm 就会因 EACCES 失败，注销也就删不掉。所以先把目录权限改回来。
// 只改真实目录：readdir 的 isDirectory() 不跟随符号链接，指向外面的链接不会被碰。
export async function makeRemovable(dir) {
  try { await chmod(dir, 0o700); } catch { return; }
  let entries;
  try { entries = await readdir(dir, {withFileTypes: true}); } catch { return; }
  for (const entry of entries) if (entry.isDirectory()) await makeRemovable(join(dir, entry.name));
}

export async function forget(dataDir, kind, id) {
  const {root} = scopeDirs(dataDir, kind, id);
  await makeRemovable(root);
  await rm(root, {recursive: true, force: true});
}
