// 每个人（或每个群）一个空间（docs/ARCHITECTURE.md 第 10 节）：
//   workspace/  Agent 的工作目录，MEMORY.md、笔记、脚本都在这里，挂进容器
//   claude/     SDK 的配置和会话记录，挂进容器
//   home/       本机模式下 CLI 的 HOME
//   sessions.json  当天用哪段会话，放在工作目录外，Agent 改不到
// 目录名是 id 的哈希，id 里写什么都跑不出数据目录。
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
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

export async function forget(dataDir, kind, id) {
  await rm(scopeDirs(dataDir, kind, id).root, {recursive: true, force: true});
}
