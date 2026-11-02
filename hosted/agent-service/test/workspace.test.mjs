import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync, realpathSync, mkdirSync, chmodSync, symlinkSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {scopeDirs, prepare, readMemory, sessionFor, saveSession, clearSession, forget} from '../workspace.mjs';

const dataDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'weave-data-')));
const inside = (parent, child) => { const r = relative(parent, child); return !!r && !r.startsWith('..') && !isAbsolute(r); };

test('不同的人目录不重叠；id 里有 ../ 也跑不出数据目录', () => {
  const data = dataDir();
  const a = scopeDirs(data, 'owner', 'u:alice'), b = scopeDirs(data, 'owner', 'u:bob'), evil = scopeDirs(data, 'owner', '../../etc');
  assert.notEqual(a.root, b.root);
  for (const dirs of [a, b, evil]) for (const dir of Object.values(dirs)) assert.ok(inside(data, dir), dir);
  assert.notEqual(scopeDirs(data, 'group', 'u:alice').root, a.root);
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
