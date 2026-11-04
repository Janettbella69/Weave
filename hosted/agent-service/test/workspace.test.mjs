import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync, realpathSync, mkdirSync, chmodSync, symlinkSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {scopeDirs, prepare, readMemory, readHandoff, sessionFor, saveSession, clearSession, forget} from '../workspace.mjs';

const WORKSPACE_MODULE = pathToFileURL(fileURLToPath(new URL('../workspace.mjs', import.meta.url))).href;

// MEMORY.md 换成命名管道时，没有 O_NONBLOCK 的 open 会一直等写入方，占住一个 libuv 线程。
// 在子进程里读，卡住就被 SIGKILL，不拖住这个测试进程。
test('MEMORY.md 被换成命名管道（FIFO）时立刻返回空字符串，不卡住线程池', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:fifo');
  await prepare(dirs);
  execFileSync('mkfifo', [join(dirs.workspace, 'MEMORY.md')]);
  const script = `import {readMemory} from ${JSON.stringify(WORKSPACE_MODULE)}; console.log(JSON.stringify(await readMemory(${JSON.stringify(dirs)})));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'});
  assert.equal(out.trim(), '""');
});

const dataDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'weave-data-')));
const inside = (parent, child) => { const r = relative(parent, child); return !!r && !r.startsWith('..') && !isAbsolute(r); };

test('不同的人目录不重叠；id 里有 ../ 也跑不出数据目录', () => {
  const data = dataDir();
  const a = scopeDirs(data, 'owner', 'u:alice'), b = scopeDirs(data, 'owner', 'u:bob'), evil = scopeDirs(data, 'owner', '../../etc');
  assert.notEqual(a.root, b.root);
  for (const dirs of [a, b, evil]) for (const dir of Object.values(dirs)) assert.ok(inside(data, dir), dir);
  assert.notEqual(scopeDirs(data, 'group', 'u:alice').root, a.root);
  // 快照目录在这个人的根目录里、工作目录外：容器挂不到它的可写副本。
  assert.ok(inside(a.root, a.snapshot) && !inside(a.workspace, a.snapshot), a.snapshot);
  assert.throws(() => scopeDirs(data, 'research', 'u:alice'));
  assert.throws(() => scopeDirs(data, 'owner', ''));
});

test('没有 MEMORY.md 时是空字符串；超过 20000 字只取前 20000 字', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  await prepare(dirs);
  assert.equal(await readMemory(dirs), '');
  writeFileSync(join(dirs.workspace, 'MEMORY.md'), '早' + 'x'.repeat(30000));
  const memory = await readMemory(dirs);
  assert.equal(memory.length, 20000);
  assert.ok(memory.startsWith('早x'));
});

test('HANDOFF.md 和 MEMORY.md 一样读：没有是空字符串；是链接不读；超过 8000 字只取前 8000 字', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  await prepare(dirs);
  assert.equal(await readHandoff(dirs), '');
  writeFileSync(join(dirs.workspace, 'HANDOFF.md'), '明' + 'x'.repeat(9000));
  const handoff = await readHandoff(dirs);
  assert.equal(handoff.length, 8000);
  assert.ok(handoff.startsWith('明x'));
  const secret = join(dataDir(), 'secret.txt');
  writeFileSync(secret, 'SERVICE_SECRET');
  const linked = scopeDirs(dataDir(), 'owner', 'u:link');
  await prepare(linked);
  symlinkSync(secret, join(linked.workspace, 'HANDOFF.md'));
  assert.equal(await readHandoff(linked), '');
});

test('同一个当地日期拿到同一段会话，换一天、清掉之后都是 null', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  await prepare(dirs);
  assert.equal(await sessionFor(dirs, '2026-11-02'), null);
  await saveSession(dirs, '2026-11-02', 'sess-1');
  assert.equal(await sessionFor(dirs, '2026-11-02'), 'sess-1');
  assert.equal(await sessionFor(dirs, '2026-11-03'), null);
  await clearSession(dirs);
  assert.equal(await sessionFor(dirs, '2026-11-02'), null);
});

test('换了一天，前一天的会话多留一段（给换日收尾接）：当天的照旧；再换一天只留最近的前一天；清掉当天的不影响前一天', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  await prepare(dirs);
  await saveSession(dirs, '2026-11-02', 'day-1');
  await saveSession(dirs, '2026-11-02', 'day-1-fork');
  await saveSession(dirs, '2026-11-03', 'today-1');
  assert.equal(await sessionFor(dirs, '2026-11-03'), 'today-1');
  assert.equal(await sessionFor(dirs, '2026-11-02'), 'day-1-fork', '前一天的是那天最后存的那段');
  await clearSession(dirs);
  assert.equal(await sessionFor(dirs, '2026-11-03'), null, '当天出错照旧清掉');
  assert.equal(await sessionFor(dirs, '2026-11-02'), 'day-1-fork', '前一天的还在');
  await saveSession(dirs, '2026-11-03', 'today-2');
  await saveSession(dirs, '2026-11-04', 'next-1');
  assert.deepEqual([await sessionFor(dirs, '2026-11-02'), await sessionFor(dirs, '2026-11-03'), await sessionFor(dirs, '2026-11-04')], [null, 'today-2', 'next-1']);
});

test('会话记录放在工作目录外面，Agent 改不到', async () => {
  const dirs = scopeDirs(dataDir(), 'owner', 'u:alice');
  await prepare(dirs);
  await saveSession(dirs, '2026-11-02', 'sess-1');
  assert.ok(existsSync(join(dirs.root, 'sessions.json')));
  assert.ok(!inside(dirs.workspace, join(dirs.root, 'sessions.json')));
});

test('forget 删掉这个人的整个目录，别人的不动', async () => {
  const data = dataDir();
  const a = scopeDirs(data, 'owner', 'u:alice'), b = scopeDirs(data, 'owner', 'u:bob');
  await prepare(a); await prepare(b);
  writeFileSync(join(a.workspace, 'MEMORY.md'), 'secret');
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

test('MEMORY.md 是指向别处的链接时一律不读，免得把服务进程里的东西读进提示词', async () => {
  const data = dataDir(), dirs = scopeDirs(data, 'owner', 'u:link');
  await prepare(dirs);
  writeFileSync(join(data, 'secret.txt'), 'DEEPSEEK_API_KEY=sk-should-not-leak');
  symlinkSync(join(data, 'secret.txt'), join(dirs.workspace, 'MEMORY.md'));
  assert.equal(await readMemory(dirs), '');
});
