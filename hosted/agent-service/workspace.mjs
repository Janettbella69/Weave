// 每个人（或每个群）一个空间（docs/ARCHITECTURE.md 第 10 节）：
//   workspace/  Agent 的工作目录，MEMORY.md、笔记、脚本都在这里，挂进容器
//   claude/     SDK 的配置和会话记录，挂进容器
//   home/       本机模式下 CLI 的 HOME
//   sessions.json  当天用哪段会话，放在工作目录外，Agent 改不到
// 目录名是 id 的哈希，id 里写什么都跑不出数据目录。
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, rm, chmod, readdir} from 'node:fs/promises';
import {join} from 'node:path';

const KINDS = ['owner', 'group'];
const MEMORY_LIMIT = 20000;

export function scopeDirs(dataDir, kind, id) {
  if (!KINDS.includes(kind)) throw Error(`不支持的范围：${kind}`);
  if (typeof id !== 'string' || !id) throw Error('缺少 id');
  const root = join(dataDir, kind, createHash('sha256').update(id).digest('hex').slice(0, 32));
  return {root, workspace: join(root, 'workspace'), config: join(root, 'claude'), home: join(root, 'home')};
}

export async function prepare(dirs) {
  for (const dir of [dirs.workspace, dirs.config, dirs.home]) await mkdir(dir, {recursive: true, mode: 0o700});
}

export async function readMemory(dirs) {
  try { return (await readFile(join(dirs.workspace, 'MEMORY.md'), 'utf8')).slice(0, MEMORY_LIMIT); }
  catch { return ''; }
}

const sessionsFile = dirs => join(dirs.root, 'sessions.json');

// 同一个当地日期接着用同一段会话，第二天开新的，靠 MEMORY.md 带过去。
export async function sessionFor(dirs, localDate) {
  try {
    const saved = JSON.parse(await readFile(sessionsFile(dirs), 'utf8'));
    return saved?.localDate === localDate && typeof saved.sessionId === 'string' ? saved.sessionId : null;
  } catch {
    return null;
  }
}

export async function saveSession(dirs, localDate, sessionId) {
  const temporary = join(dirs.root, `sessions.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({localDate, sessionId}));
  await rename(temporary, sessionsFile(dirs));
}

export async function clearSession(dirs) {
  await rm(sessionsFile(dirs), {force: true});
}

// Agent 能用 Bash 把子目录改成 000，rm 就会因 EACCES 失败，注销也就删不掉。所以先把目录权限改回来。
// 只改真实目录：readdir 的 isDirectory() 不跟随符号链接，指向外面的链接不会被碰。
async function makeRemovable(dir) {
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
