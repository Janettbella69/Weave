// 叫醒前的数据快照（docs/ARCHITECTURE.md 第 10 节）。教材 p.16「查数留SQL,不要封成MCP」；
// p.20 代码合法的位置之一「Agent启动之前 预处理。不在循环中间,不影响灵活性」。
// Weave 服务按这一轮的通行证给一份 JSON，这里写成一个快照目录：
//   weave.db  SQLite：meta，加上快照里给了的表（habits、completions、group_messages）
//   其他文件  比如 notion/*.md
// docker：快照目录在工作目录外（scopeDirs 的 snapshot），只读挂到容器的 /workspace/weave。
//   Agent 改不到它，写入后的同步也只碰宿主自己的文件（审查发现：同步若打开 Agent 改得到的
//   weave.db，Agent 埋个触发器就能卡住整个服务）。
// local（只用于本机开发）：快照目录就在工作目录里的 weave/。
// 每次叫醒前整个换掉，Agent 在里面改的东西带不到下一轮；要改数据走 weave 工具。
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lstat, mkdir, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {makeRemovable} from './workspace.mjs';

export const SNAPSHOT_DIR = 'weave';
export const DB_FILE = 'weave.db';
const LIMITS = {files: 200, fileBytes: 1024 * 1024, totalBytes: 5 * 1024 * 1024, segmentBytes: 200};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 已知的表和列。别的表名让整份快照无效：说明两边的格式对不上了，宁可这一轮不醒。
export const TABLES = Object.freeze({
  habits: {
    columns: ['habit_id', 'name', 'identity', 'trigger', 'minimum_action', 'created_at', 'updated_at'],
    ddl: 'habit_id TEXT PRIMARY KEY, name TEXT, identity TEXT, trigger TEXT, minimum_action TEXT, created_at TEXT, updated_at TEXT',
  },
  completions: {
    columns: ['habit_id', 'date', 'note', 'source', 'created_at'],
    ddl: 'habit_id TEXT NOT NULL, date TEXT NOT NULL, note TEXT, source TEXT, created_at TEXT, PRIMARY KEY (habit_id, date)',
  },
  group_messages: {
    columns: ['seq', 'member', 'text', 'at'],
    ddl: 'seq INTEGER PRIMARY KEY, member TEXT, text TEXT, at TEXT',
  },
});

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const cell = value => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw Error('快照里的值只能是文字、数字或空');
};

export function validateSnapshot(value) {
  if (!isPlainObject(value) || value.version !== 1) throw Error('快照版本不对');
  if (typeof value.today !== 'string' || !DATE.test(value.today)) throw Error('快照里的 today 不对');
  if (value.timezone !== null && typeof value.timezone !== 'string') throw Error('快照里的 timezone 不对');
  if (!isPlainObject(value.tables) || !isPlainObject(value.files)) throw Error('快照缺少 tables 或 files');
  const tables = {};
  for (const [name, rows] of Object.entries(value.tables)) {
    if (!Object.hasOwn(TABLES, name)) throw Error(`快照里有不认识的表：${name}`);
    if (!Array.isArray(rows)) throw Error(`快照里的 ${name} 不是列表`);
    tables[name] = rows.map(row => {
      if (!isPlainObject(row)) throw Error(`快照里的 ${name} 有一行不是对象`);
      return Object.fromEntries(TABLES[name].columns.map(column => [column, cell(row[column])]));
    });
  }
  return {version: 1, today: value.today, timezone: value.timezone, tables, files: {...value.files}};
}

export async function fetchSnapshot({weaveUrl, capability, fetcher = fetch, timeoutMs = 15000}) {
  const response = await fetcher(`${weaveUrl.replace(/\/+$/, '')}/api/internal/agent/snapshot`, {
    method: 'GET', redirect: 'manual', headers: {Authorization: 'Bearer ' + capability}, signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw Error(`快照接口返回 ${response.status}`);
  return validateSnapshot(await response.json());
}

const segmentOk = segment => segment.length > 0 && segment !== '.' && segment !== '..' && !/[\\\0]/.test(segment)
  && Buffer.byteLength(segment) <= LIMITS.segmentBytes;

// 把旧的整个挪到 trashDir（在工作目录外），再在后台尽力删。rename 一步完成、不跟随链接，
// 目录链再深也挪得走；后台删不掉只是留点垃圾，不会让这个人以后都叫不醒（审查发现）。
// 调用时这一轮的容器已经删掉（removeContainer），没有进程能再动它。
async function moveAside(path, trashDir) {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  const trash = join(trashDir, `.trash-${randomUUID()}`);
  await rename(path, trash);
  (async () => {
    if (info.isDirectory()) await makeRemovable(trash);
    await rm(trash, {recursive: true, force: true});
  })().catch(error => console.error('Agent service: old snapshot left behind:', error instanceof Error ? error.message : 'unknown'));
}

// docker 的挂载点 <工作目录>/weave 必须是一个空的真目录：旧版留下的快照、文件、链接都挪走。
export async function prepareMountpoint(path, trashDir) {
  const info = await lstat(path).catch(() => null);
  if (info?.isDirectory() && (await readdir(path).catch(() => ['?'])).length === 0) return;
  await moveAside(path, trashDir);
  await mkdir(path, {mode: 0o700});
}

function writeDatabase(dbPath, snapshot, now) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('today', snapshot.today);
    meta.run('timezone', snapshot.timezone);
    meta.run('generated_at', new Date(now).toISOString());
    for (const [name, rows] of Object.entries(snapshot.tables)) {
      const {columns, ddl} = TABLES[name];
      db.exec(`CREATE TABLE ${name} (${ddl})`);
      const insert = db.prepare(`INSERT OR REPLACE INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      db.exec('BEGIN');
      for (const row of rows) insert.run(...columns.map(column => row[column]));
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

export async function writeSnapshot(dir, snapshot, now = Date.now(), {trashDir = dirname(dir)} = {}) {
  await moveAside(dir, trashDir);
  await mkdir(dir, {mode: 0o700});
  const dbPath = join(dir, DB_FILE);
  writeDatabase(dbPath, snapshot, now);

  // 文件不合规就跳过、记下来，不让整轮失败（比如 Notion 页面名里带了 /）。
  const skipped = [];
  let count = 0, total = 0;
  for (const [relative, text] of Object.entries(snapshot.files)) {
    const parts = relative.split('/');
    const bytes = typeof text === 'string' ? Buffer.byteLength(text) : Infinity;
    const allowed = parts.every(segmentOk) && relative !== DB_FILE && bytes <= LIMITS.fileBytes
      && count < LIMITS.files && total + bytes <= LIMITS.totalBytes;
    if (!allowed) { skipped.push(relative); continue; }
    try {
      if (parts.length > 1) await mkdir(join(dir, ...parts.slice(0, -1)), {recursive: true, mode: 0o700});
      await writeFile(join(dir, ...parts), text, {flag: 'wx', mode: 0o600});
      count++;
      total += bytes;
    } catch {
      skipped.push(relative);
    }
  }
  if (skipped.length) console.error(`快照里有 ${skipped.length} 个文件没写：${skipped.slice(0, 5).join(', ')}`);
  return {dir, dbPath, skipped};
}

// 写工具成功后同步进本地快照，同一轮里再查就看得到（我的看法：这是 p.20 说的「副作用」，不进循环）。
export function applyWrite(dbPath, toolName, resultText) {
  const data = JSON.parse(resultText);
  const db = new DatabaseSync(dbPath);
  try {
    const at = new Date().toISOString();
    if (toolName === 'save_habit') {
      const h = data.habit;
      db.prepare(`INSERT INTO habits (habit_id, name, identity, trigger, minimum_action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(habit_id) DO UPDATE SET name = excluded.name, identity = excluded.identity, trigger = excluded.trigger,
        minimum_action = excluded.minimum_action, updated_at = excluded.updated_at`)
        .run(h.habit_id, h.name, h.identity ?? '', h.trigger ?? '', h.minimum_action ?? '', at, at);
    } else if (toolName === 'log_completion') {
      const c = data.completion;
      db.prepare('INSERT OR IGNORE INTO completions (habit_id, date, note, source, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(c.habit_id, c.date, c.note ?? '', 'agent', at);
    }
  } finally {
    db.close();
  }
}

const MIRRORED = new Set(['save_habit', 'log_completion']);

export function mirroringRpc(rpc, dbPath) {
  return async (name, args, toolUseId) => {
    const out = await rpc(name, args, toolUseId);
    if (out.ok && MIRRORED.has(name)) {
      try { applyWrite(dbPath, name, out.text); } catch (error) { console.error(`快照没同步（${name}）：`, error instanceof Error ? error.message : 'unknown'); }
    }
    return out;
  };
}
