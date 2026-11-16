import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync, chmodSync, symlinkSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {scopeDirs, prepare, memoryDir, moveOldMemory, readMemoryFiles, sessionFor, saveSession, clearSession, forget} from '../workspace.mjs';

const WORKSPACE_MODULE = pathToFileURL(fileURLToPath(new URL('../workspace.mjs', import.meta.url))).href;
const dataDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'weave-data-')));
const inside = (parent, child) => { const r = relative(parent, child); return !!r && !r.startsWith('..') && !isAbsolute(r); };
const CWD = '/workspace';

// 记忆文件换成命名管道时，没有 O_NONBLOCK 的 open 会一直等写入方，占住一个 libuv 线程。
// 在子进程里读，卡住就被 SIGKILL，不拖住这个测试进程。
test('记忆文件被换成命名管道（FIFO）时立刻读成空字符串，不卡住线程池', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:fifo');
  await prepare(dirs);
  mkdirSync(memoryDir(dirs, CWD), {recursive: true});
  execFileSync('mkfifo', [join(memoryDir(dirs, CWD), 'MEMORY.md')]);
  const script = `import {readMemoryFiles} from ${JSON.stringify(WORKSPACE_MODULE)}; console.log(JSON.stringify(await readMemoryFiles(${JSON.stringify(dirs)}, ${JSON.stringify(CWD)})));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'});
  assert.deepEqual(JSON.parse(out), []);
});

test('不同的人目录不重叠；id 里有 ../ 也跑不出数据目录；存档目录在工作目录外', () => {
  const data = dataDir();
  const a = scopeDirs(data, 'owner', 'u:alice'), b = scopeDirs(data, 'owner', 'u:bob'), evil = scopeDirs(data, 'owner', '../../etc');
  assert.notEqual(a.root, b.root);
  for (const dirs of [a, b, evil]) for (const dir of Object.values(dirs)) assert.ok(inside(data, dir), dir);
  assert.notEqual(scopeDirs(data, 'group', 'u:alice').root, a.root);
  assert.ok(inside(a.root, a.archive) && !inside(a.workspace, a.archive), a.archive);
  assert.throws(() => scopeDirs(data, 'research', 'u:alice'));
  assert.throws(() => scopeDirs(data, 'owner', ''));
});

test('记忆目录照 SDK 的规则：配置目录/projects/<工作目录换成短横线>/memory，在工作目录外', () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  assert.equal(memoryDir(dirs, '/workspace'), join(dirs.config, 'projects', '-workspace', 'memory'));
  assert.ok(!inside(dirs.workspace, memoryDir(dirs, '/workspace')));
});

test('网页读记忆：没有是空列表；MEMORY.md 排第一；每个文件最多 20000 字；链接一律不读', async () => {
  const data = dataDir(), dirs = scopeDirs(data, 'owner', 'u:alice');
  await prepare(dirs);
  assert.deepEqual(await readMemoryFiles(dirs, CWD), []);
  const dir = memoryDir(dirs, CWD);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'walk.md'), '她喜欢晚饭后散步。');
  writeFileSync(join(dir, 'MEMORY.md'), '早' + 'x'.repeat(30000));
  writeFileSync(join(data, 'secret.txt'), 'DEEPSEEK_API_KEY=sk-should-not-leak');
  symlinkSync(join(data, 'secret.txt'), join(dir, 'leak.md'));
  const files = await readMemoryFiles(dirs, CWD);
  // 链接根本不列出来（只列普通文件）。
  assert.deepEqual(files.map(f => f.name), ['MEMORY.md', 'walk.md']);
  assert.equal(files[0].text.length, 20000);
  assert.equal(files[1].text, '她喜欢晚饭后散步。');
});

test('以前工作目录里的 MEMORY.md 挪进记忆目录当索引；那里已经有就不动；链接不挪', async () => {
  const data = dataDir(), dirs = scopeDirs(data, 'owner', 'u:alice');
  await prepare(dirs);
  writeFileSync(join(dirs.workspace, 'MEMORY.md'), '旧记忆');
  assert.equal(await moveOldMemory(dirs, CWD), true);
  assert.equal(existsSync(join(dirs.workspace, 'MEMORY.md')), false);
  assert.equal(readFileSync(join(memoryDir(dirs, CWD), 'MEMORY.md'), 'utf8'), '旧记忆');
  writeFileSync(join(dirs.workspace, 'MEMORY.md'), '又一份');
  assert.equal(await moveOldMemory(dirs, CWD), false);
  assert.equal(readFileSync(join(memoryDir(dirs, CWD), 'MEMORY.md'), 'utf8'), '旧记忆');
  const linked = scopeDirs(data, 'owner', 'u:link');
  await prepare(linked);
  writeFileSync(join(data, 'secret.txt'), 'x');
  symlinkSync(join(data, 'secret.txt'), join(linked.workspace, 'MEMORY.md'));
  assert.equal(await moveOldMemory(linked, CWD), false);
});

test('一个人只有一段会话，不按日期换；清掉之后是 null', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  await prepare(dirs);
  assert.equal(await sessionFor(dirs), null);
  await saveSession(dirs, 'sess-1');
  assert.equal(await sessionFor(dirs), 'sess-1');
  await saveSession(dirs, 'sess-2');
  assert.equal(await sessionFor(dirs), 'sess-2');
  await clearSession(dirs);
  assert.equal(await sessionFor(dirs), null);
});

test('会话编号放在工作目录外面，Agent 改不到', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  await prepare(dirs);
  await saveSession(dirs, 'sess-1');
  assert.ok(existsSync(join(dirs.root, 'sessions.json')));
  assert.ok(!inside(dirs.workspace, join(dirs.root, 'sessions.json')));
});

test('forget 删掉这个人的整个目录，别人的不动', async () => {
  const data = dataDir();
  const a = scopeDirs(data, 'owner', 'u:alice'), b = scopeDirs(data, 'owner', 'u:bob');
  await prepare(a); await prepare(b);
  writeFileSync(join(a.workspace, 'records.db'), 'secret');
  await forget(data, 'owner', 'u:alice');
  assert.ok(!existsSync(a.root));
  assert.ok(existsSync(b.workspace));
  await forget(data, 'owner', 'u:nobody');
});

test('Agent 把子目录改成 000 权限也删得掉；不顺着符号链接去改外面的权限', async () => {
  const data = dataDir(), dirs = scopeDirs(data, 'owner', 'u:locked');
  await prepare(dirs);
  mkdirSync(join(dirs.workspace, 'sub/deeper'), {recursive: true});
  writeFileSync(join(dirs.workspace, 'sub/deeper/notes.md'), 'private');
  const outside = join(data, 'outside');
  mkdirSync(outside);
  chmodSync(outside, 0o500);
  symlinkSync(outside, join(dirs.workspace, 'link-out'));
  chmodSync(join(dirs.workspace, 'sub/deeper'), 0o000);
  chmodSync(join(dirs.workspace, 'sub'), 0o000);
  await forget(data, 'owner', 'u:locked');
  assert.ok(!existsSync(dirs.root));
  assert.equal(statSync(outside).mode & 0o777, 0o500);
  chmodSync(outside, 0o700);
});
