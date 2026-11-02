import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync, symlinkSync, lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validateSnapshot, writeSnapshot, prepareMountpoint, fetchSnapshot, applyWrite, mirroringRpc} from '../snapshot.mjs';

const NOW = Date.parse('2026-11-02T15:00:00Z');
// Mirrors workspace.scopeDirs: <root>/workspace is the agent's, <root> is the service's own.
const tenant = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'weave-snap-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return {root, workspace, target: join(workspace, 'weave')};
};
const write = (t, snapshot) => writeSnapshot(t.target, snapshot, NOW, {trashDir: t.root});
const habit = (id, name, extra = {}) => ({habit_id: id, name, identity: '', trigger: '', minimum_action: '', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...extra});
const done = (id, date, extra = {}) => ({habit_id: id, date, note: '', source: 'agent', created_at: date + 'T12:00:00.000Z', ...extra});
const owner = (tables = {}, files = {}) => validateSnapshot({version: 1, today: '2026-11-02', timezone: 'Asia/Shanghai', tables, files});
const query = (dbPath, sql) => { const db = new DatabaseSync(dbPath); try { return db.prepare(sql).all().map(r => ({...r})); } finally { db.close(); } };
const tablesIn = dbPath => query(dbPath, "select name from sqlite_master where type = 'table' order by name").map(r => r.name);

test('写出 weave.db：meta 有 today/timezone，habits 和 completions 行数和内容对得上', async () => {
  const t = tenant();
  const out = await write(t, owner({
    habits: [habit('h:1', '走路', {trigger: '起床后', minimum_action: '穿上鞋'}), habit('h:2', '读书')],
    completions: [done('h:1', '2026-11-01', {note: '饭后'}), done('h:1', '2026-11-02')],
  }));
  assert.equal(out.dbPath, join(t.target, 'weave.db'));
  assert.deepEqual(query(out.dbPath, 'select key, value from meta order by key'), [
    {key: 'generated_at', value: '2026-11-02T15:00:00.000Z'}, {key: 'timezone', value: 'Asia/Shanghai'}, {key: 'today', value: '2026-11-02'},
  ]);
  assert.deepEqual(query(out.dbPath, 'select habit_id, name, trigger, minimum_action from habits order by habit_id'), [
    {habit_id: 'h:1', name: '走路', trigger: '起床后', minimum_action: '穿上鞋'}, {habit_id: 'h:2', name: '读书', trigger: '', minimum_action: ''},
  ]);
  assert.deepEqual(query(out.dbPath, 'select date, note from completions order by date'), [{date: '2026-11-01', note: '饭后'}, {date: '2026-11-02', note: ''}]);
  assert.deepEqual(out.skipped, []);
});

test('group 快照只有 meta 表', async () => {
  const out = await write(tenant(), owner({}));
  assert.deepEqual(tablesIn(out.dbPath), ['meta']);
});

test('weave/ 原来是指向外面的链接：只挪走链接，外面的文件和权限都不变', async () => {
  const t = tenant();
  const outside = join(t.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'x');
  chmodSync(outside, 0o755);
  symlinkSync(outside, t.target);
  const out = await write(t, owner({habits: [habit('h:1', '走路')]}));
  assert.ok(!lstatSync(t.target).isSymbolicLink());
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
  assert.equal(lstatSync(outside).mode & 0o777, 0o755, '外面目录的权限不该被改');
  assert.equal(query(out.dbPath, 'select count(*) as n from habits')[0].n, 1);
});

test('上一轮留下的文件和 000 权限的子目录都被换掉，重建成功；挪走的旧目录不在工作目录里', async () => {
  const t = tenant();
  const old = join(t.target, 'locked');
  mkdirSync(old, {recursive: true});
  writeFileSync(join(t.target, 'note.md'), '我自己记的');
  writeFileSync(join(old, 'x'), 'x');
  chmodSync(old, 0o000);
  const out = await write(t, owner({}));
  assert.deepEqual(readdirSync(t.target), ['weave.db']);
  assert.deepEqual(tablesIn(out.dbPath), ['meta']);
  assert.deepEqual(readdirSync(t.workspace), ['weave'], '旧目录要挪到工作目录外面');
});

test('weave/ 里有一条超过 PATH_MAX 的目录链：整个挪走，照样重建，不让这个人以后都叫不醒', async () => {
  const t = tenant();
  mkdirSync(t.target);
  const cwd = process.cwd();
  try {
    process.chdir(t.target);
    for (let i = 0; i < 1000; i++) { mkdirSync('dddd'); process.chdir('dddd'); }
  } finally {
    process.chdir(cwd);
  }
  const out = await write(t, owner({habits: [habit('h:1', '走路')]}));
  assert.deepEqual(readdirSync(t.target), ['weave.db']);
  assert.equal(query(out.dbPath, 'select count(*) as n from habits')[0].n, 1);
});

test('docker 挂载点：不是空的真目录就挪走重建；已经是空目录就不动', async () => {
  const t = tenant();
  const mountpoint = join(t.workspace, 'weave');
  await prepareMountpoint(mountpoint, t.root);
  assert.deepEqual(readdirSync(mountpoint), []);
  const before = lstatSync(mountpoint).ino;
  await prepareMountpoint(mountpoint, t.root);
  assert.equal(lstatSync(mountpoint).ino, before, '空目录不该被换掉');
  writeFileSync(join(mountpoint, 'weave.db'), '旧版留下的快照');
  await prepareMountpoint(mountpoint, t.root);
  assert.deepEqual(readdirSync(mountpoint), []);
  const outside = join(t.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'x');
  await prepareMountpoint(mountpoint, t.root);
  const linkTarget = join(t.workspace, 'weave');
  // Replace the mountpoint with a link to the outside: only the link moves.
  readdirSync(linkTarget);
  await import('node:fs/promises').then(fs => fs.rm(linkTarget, {recursive: true, force: true}));
  symlinkSync(outside, linkTarget);
  await prepareMountpoint(mountpoint, t.root);
  assert.ok(lstatSync(mountpoint).isDirectory() && !lstatSync(mountpoint).isSymbolicLink());
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
});

test('files 写到 weave/ 下；不合规的路径和超限的文件跳过，列在 skipped 里', async () => {
  const t = tenant();
  const long = '页'.repeat(70); // 210 bytes in UTF-8
  const out = await write(t, owner({}, {
    'notion/目标.md': '# 目标\n每天走路',
    'notion/周计划.md': '周三休息',
    '../escape.md': 'x', '/abs.md': 'x', 'a/../b.md': 'x', 'a//b.md': 'x', 'a\\b.md': 'x', 'weave.db': 'x', [`notion/${long}.md`]: 'x',
    'big.md': 'x'.repeat(1024 * 1024 + 1),
  }));
  assert.equal(readFileSync(join(t.target, 'notion', '目标.md'), 'utf8'), '# 目标\n每天走路');
  assert.equal(readFileSync(join(t.target, 'notion', '周计划.md'), 'utf8'), '周三休息');
  assert.deepEqual(out.skipped.sort(), ['../escape.md', '/abs.md', 'a/../b.md', 'a//b.md', 'a\\b.md', 'big.md', 'weave.db', `notion/${long}.md`].sort());
  assert.ok(!existsSync(join(t.root, 'escape.md')) && !existsSync(join(t.workspace, 'escape.md')));
  assert.equal(query(out.dbPath, 'select count(*) as n from meta')[0].n, 3, 'weave.db 没被文件盖掉');
});

test('文件超过 200 个、总量超过 5 MB 的部分跳过', async () => {
  const many = Object.fromEntries(Array.from({length: 205}, (_, i) => [`f/${i}.md`, 'x']));
  const out = await write(tenant(), owner({}, many));
  assert.equal(out.skipped.length, 5);
  const big = Object.fromEntries(Array.from({length: 6}, (_, i) => [`b/${i}.md`, 'x'.repeat(1024 * 1024)]));
  const second = await write(tenant(), owner({}, big));
  assert.deepEqual(second.skipped, ['b/5.md'], '5 个 1 MB 正好到 5 MB 上限，第 6 个放不下');
});

test('validateSnapshot：不认识的表名、行不是对象、值是对象、版本不对都报错', () => {
  const base = {version: 1, today: '2026-11-02', timezone: 'Asia/Shanghai', tables: {}, files: {}};
  for (const bad of [
    null, [], {...base, version: 2}, {...base, today: '2026/11/02'}, {...base, tables: []}, {...base, files: []},
    {...base, tables: {users: []}}, {...base, tables: JSON.parse('{"__proto__": []}')}, {...base, tables: {habits: {}}},
    {...base, tables: {habits: ['x']}}, {...base, tables: {habits: [{habit_id: {x: 1}}]}}, {...base, tables: {habits: [{habit_id: true}]}},
  ]) assert.throws(() => validateSnapshot(bad), JSON.stringify(bad));
  assert.deepEqual(validateSnapshot({...base, tables: {group_messages: [{seq: 1, member: '成员1', text: '早', at: '2026-11-02T00:00:00Z', extra: 'ignored'}]}}).tables.group_messages, [{seq: 1, member: '成员1', text: '早', at: '2026-11-02T00:00:00Z'}]);
});

test('一万两千行完成记录也能写完', async () => {
  const rows = Array.from({length: 12000}, (_, i) => done('h:' + (i % 20), new Date(Date.UTC(2024, 0, 1) + Math.floor(i / 20) * 86400000).toISOString().slice(0, 10)));
  const out = await write(tenant(), owner({completions: rows}));
  assert.equal(query(out.dbPath, 'select count(*) as n from completions')[0].n, 12000);
});

test('applyWrite：save_habit 新建和修改都同步，log_completion 重复不报错', async () => {
  const out = await write(tenant(), owner({habits: [habit('h:1', '走路')], completions: []}));
  applyWrite(out.dbPath, 'save_habit', JSON.stringify({habit: {habit_id: 'h:2', name: '读书', identity: '', trigger: '睡前', minimum_action: '读一页'}}));
  applyWrite(out.dbPath, 'save_habit', JSON.stringify({habit: {habit_id: 'h:1', name: '散步', identity: '我是爱走路的人', trigger: '', minimum_action: ''}}));
  const completion = JSON.stringify({completion: {habit_id: 'h:1', date: '2026-11-02', note: ''}, duplicate: false});
  applyWrite(out.dbPath, 'log_completion', completion);
  applyWrite(out.dbPath, 'log_completion', completion);
  assert.deepEqual(query(out.dbPath, 'select habit_id, name, identity, trigger from habits order by habit_id'), [
    {habit_id: 'h:1', name: '散步', identity: '我是爱走路的人', trigger: ''}, {habit_id: 'h:2', name: '读书', identity: '', trigger: '睡前'},
  ]);
  assert.deepEqual(query(out.dbPath, 'select habit_id, date, source from completions'), [{habit_id: 'h:1', date: '2026-11-02', source: 'agent'}]);
});

test('mirroringRpc：只同步成功的写工具；同步失败不改返回值', async () => {
  const out = await write(tenant(), owner({habits: [], completions: []}));
  const replies = {
    save_habit: {ok: true, text: JSON.stringify({habit: {habit_id: 'h:9', name: '跳绳', identity: '', trigger: '', minimum_action: ''}})},
    log_completion: {ok: false, text: '没有这个习惯。'},
    send_message: {ok: true, text: '已发出。'},
  };
  const rpc = mirroringRpc(async name => replies[name], out.dbPath);
  assert.deepEqual(await rpc('save_habit', {}, 't1'), replies.save_habit);
  assert.deepEqual(await rpc('log_completion', {}, 't2'), replies.log_completion);
  assert.deepEqual(await rpc('send_message', {}, 't3'), replies.send_message);
  assert.deepEqual(query(out.dbPath, 'select habit_id from habits'), [{habit_id: 'h:9'}]);
  assert.equal(query(out.dbPath, 'select count(*) as n from completions')[0].n, 0);
  const broken = mirroringRpc(async () => ({ok: true, text: '不是 JSON'}), out.dbPath);
  assert.deepEqual(await broken('save_habit', {}, 't4'), {ok: true, text: '不是 JSON'});
});

test('fetchSnapshot：带 Bearer 通行证 GET 快照地址；非 200 或格式不对就报错', async () => {
  const calls = [];
  const good = {version: 1, today: '2026-11-02', timezone: 'Asia/Shanghai', tables: {}, files: {}};
  const fetcher = reply => async (url, options) => { calls.push({url, method: options.method, auth: options.headers.Authorization}); return reply(); };
  assert.deepEqual(await fetchSnapshot({weaveUrl: 'http://weave:4317/', capability: 'cap-1', fetcher: fetcher(() => Response.json(good))}), good);
  assert.deepEqual(calls[0], {url: 'http://weave:4317/api/internal/agent/snapshot', method: 'GET', auth: 'Bearer cap-1'});
  await assert.rejects(fetchSnapshot({weaveUrl: 'http://weave:4317', capability: 'c', fetcher: fetcher(() => Response.json({error: 'x'}, {status: 500}))}));
  await assert.rejects(fetchSnapshot({weaveUrl: 'http://weave:4317', capability: 'c', fetcher: fetcher(() => Response.json({ok: true, text: '已记录'}))}));
});
