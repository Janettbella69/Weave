import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync, symlinkSync, lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validateSnapshot, writeSnapshot, prepareMountpoint, fetchSnapshot, applyWrite, mirroringRpc} from '../snapshot.mjs';
// Both sides of the contract ship together: the Weave side's real output goes through this side's validator and mirror.
import {snapshotFor} from '../../lib/weave/agent-snapshot.mjs';
import {saveGoal, saveHabit} from '../../lib/weave/habits.mjs';

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
const goal = (id, title, category = 'health', archived = 0, extra = {}) => ({goal_id: id, title, category, archived, created_at: '2026-11-01T00:00:00.000Z', ...extra});
const reminder = (id, text, status = 'scheduled', extra = {}) => ({reminder_id: id, text, due_at: '2026-11-03T12:00:00.000Z', status, ...extra});
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

test('validateSnapshot 认识 goals 和 reminders 两张表，habits 多一列 goal_id；表外的列丢掉', () => {
  const out = validateSnapshot({version: 1, today: '2026-11-02', timezone: 'Asia/Shanghai', files: {}, tables: {
    habits: [habit('h:1', '走路', {goal_id: 'g:1'}), habit('h:2', '读书')],
    goals: [goal('g:1', '每天动一动', 'health', 0, {extra: 'ignored'}), goal('g:2', '学理财', 'finance', 1)],
    reminders: [reminder('r:1', '给妈妈打电话', 'scheduled', {extra: 'ignored'})],
  }});
  assert.deepEqual(out.tables.goals.map(g => Object.keys(g)), [['goal_id', 'title', 'category', 'archived', 'created_at'], ['goal_id', 'title', 'category', 'archived', 'created_at']]);
  assert.deepEqual(out.tables.goals.map(g => [g.goal_id, g.archived]), [['g:1', 0], ['g:2', 1]]);
  assert.deepEqual(Object.keys(out.tables.reminders[0]), ['reminder_id', 'text', 'due_at', 'status']);
  assert.deepEqual(out.tables.habits.map(h => h.goal_id), ['g:1', null], '没给 goal_id 的习惯是 null');
  assert.deepEqual(Object.keys(out.tables.habits[0]).at(-1), 'goal_id');
  for (const bad of [{goals: {}}, {goals: ['x']}, {reminders: {}}, {reminders: [1]}, {goals: [{archived: true}]}, {reminders: [{text: {x: 1}}]}]) {
    assert.throws(() => validateSnapshot({version: 1, today: '2026-11-02', timezone: null, files: {}, tables: bad}), JSON.stringify(bad));
  }
});

test('写出 weave.db：goals 和 reminders 两张表，habits 带 goal_id，列的顺序固定', async () => {
  const out = await write(tenant(), owner({
    habits: [habit('h:1', '走路', {goal_id: 'g:1'}), habit('h:2', '读书')],
    goals: [goal('g:1', '每天动一动'), goal('g:2', '学理财', 'finance', 1)],
    reminders: [reminder('r:1', '给妈妈打电话'), reminder('r:2', '喝水', 'cancelled')],
  }));
  const columns = table => query(out.dbPath, `pragma table_info(${table})`).map(c => c.name);
  assert.deepEqual(columns('goals'), ['goal_id', 'title', 'category', 'archived', 'created_at']);
  assert.deepEqual(columns('reminders'), ['reminder_id', 'text', 'due_at', 'status']);
  assert.deepEqual(columns('habits').at(-1), 'goal_id');
  assert.deepEqual(query(out.dbPath, 'select goal_id, title, category, archived from goals order by goal_id'), [
    {goal_id: 'g:1', title: '每天动一动', category: 'health', archived: 0}, {goal_id: 'g:2', title: '学理财', category: 'finance', archived: 1},
  ]);
  assert.deepEqual(query(out.dbPath, 'select reminder_id, text, status from reminders order by reminder_id'), [
    {reminder_id: 'r:1', text: '给妈妈打电话', status: 'scheduled'}, {reminder_id: 'r:2', text: '喝水', status: 'cancelled'},
  ]);
  assert.deepEqual(query(out.dbPath, 'select h.name, g.title from habits h join goals g on g.goal_id = h.goal_id'), [{name: '走路', title: '每天动一动'}]);
  assert.deepEqual(query(out.dbPath, 'select name from habits where goal_id is null'), [{name: '读书'}]);
});

test('没有目标和提醒的账号：两张表是空的，仍然存在，可以查', async () => {
  const out = await write(tenant(), owner({habits: [], completions: [], goals: [], reminders: []}));
  assert.deepEqual(tablesIn(out.dbPath), ['completions', 'goals', 'habits', 'meta', 'reminders']);
  assert.equal(query(out.dbPath, 'select count(*) as n from goals')[0].n, 0);
  assert.equal(query(out.dbPath, 'select count(*) as n from reminders')[0].n, 0);
});

test('applyWrite：save_goal 新建、改名、归档都同步，archived 是 0 / 1', async () => {
  const out = await write(tenant(), owner({goals: [goal('g:1', '每天动一动')]}));
  applyWrite(out.dbPath, 'save_goal', JSON.stringify({goal: {goal_id: 'g:2', title: '学理财', category: 'finance', archived: false}}));
  applyWrite(out.dbPath, 'save_goal', JSON.stringify({goal: {goal_id: 'g:1', title: '每天活动', category: 'health', archived: false}}));
  applyWrite(out.dbPath, 'save_goal', JSON.stringify({goal: {goal_id: 'g:2', title: '学理财', category: 'finance', archived: true}}));
  assert.deepEqual(query(out.dbPath, 'select goal_id, title, category, archived from goals order by goal_id'), [
    {goal_id: 'g:1', title: '每天活动', category: 'health', archived: 0}, {goal_id: 'g:2', title: '学理财', category: 'finance', archived: 1},
  ]);
  assert.equal(query(out.dbPath, "select created_at from goals where goal_id = 'g:1'")[0].created_at, '2026-11-01T00:00:00.000Z', '改名不动创建时间');
  assert.match(query(out.dbPath, "select created_at from goals where goal_id = 'g:2'")[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('applyWrite：set_reminder 同步进 reminders；save_habit 带 goal_id 同步进 habits', async () => {
  const out = await write(tenant(), owner({habits: [habit('h:1', '走路')], goals: [goal('g:1', '每天动一动')], reminders: []}));
  applyWrite(out.dbPath, 'set_reminder', JSON.stringify({reminder: {reminder_id: 'r:1', text: '给妈妈打电话', due_at: '2026-11-03T12:00:00.000Z', status: 'scheduled'}}));
  assert.deepEqual(query(out.dbPath, 'select * from reminders'), [{reminder_id: 'r:1', text: '给妈妈打电话', due_at: '2026-11-03T12:00:00.000Z', status: 'scheduled'}]);
  applyWrite(out.dbPath, 'save_habit', JSON.stringify({habit: {habit_id: 'h:1', name: '走路', identity: '', trigger: '', minimum_action: '', goal_id: 'g:1'}}));
  applyWrite(out.dbPath, 'save_habit', JSON.stringify({habit: {habit_id: 'h:2', name: '读书', identity: '', trigger: '', minimum_action: '', goal_id: null}}));
  applyWrite(out.dbPath, 'save_habit', JSON.stringify({habit: {habit_id: 'h:3', name: '写字', identity: '', trigger: '', minimum_action: ''}}));
  assert.deepEqual(query(out.dbPath, 'select habit_id, goal_id from habits order by habit_id'), [
    {habit_id: 'h:1', goal_id: 'g:1'}, {habit_id: 'h:2', goal_id: null}, {habit_id: 'h:3', goal_id: null},
  ]);
});

test('mirroringRpc：save_goal 和 set_reminder 成功才同步，失败不动本地快照', async () => {
  const out = await write(tenant(), owner({goals: [], reminders: []}));
  const replies = {
    save_goal: {ok: true, text: JSON.stringify({goal: {goal_id: 'g:9', title: '每天动一动', category: 'health', archived: false}})},
    set_reminder: {ok: false, text: '请输入1–500字提醒内容和有效的未来时间'},
  };
  const rpc = mirroringRpc(async name => replies[name], out.dbPath);
  assert.deepEqual(await rpc('save_goal', {}, 't1'), replies.save_goal);
  assert.deepEqual(await rpc('set_reminder', {}, 't2'), replies.set_reminder);
  assert.deepEqual(query(out.dbPath, 'select goal_id, archived from goals'), [{goal_id: 'g:9', archived: 0}]);
  assert.equal(query(out.dbPath, 'select count(*) as n from reminders')[0].n, 0);
  replies.set_reminder = {ok: true, text: JSON.stringify({reminder: {reminder_id: 'r:9', text: '喝水', due_at: '2026-11-03T12:00:00.000Z', status: 'scheduled'}})};
  assert.deepEqual(await rpc('set_reminder', {}, 't3'), replies.set_reminder);
  assert.deepEqual(query(out.dbPath, 'select reminder_id, status from reminders'), [{reminder_id: 'r:9', status: 'scheduled'}]);
  const broken = mirroringRpc(async () => ({ok: true, text: '不是 JSON'}), out.dbPath);
  assert.deepEqual(await broken('save_goal', {}, 't4'), {ok: true, text: '不是 JSON'});
});

test('Weave 这边 snapshotFor 给出的整份 owner 快照，这边原样收下：表、列、值一个都不多不少', async () => {
  const person = {
    id: 'u:alice', profile: {timezone: 'Asia/Shanghai'},
    goals: [
      {id: 'g:1', title: '每天动一动', category: 'health', archived: false, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z'},
      {id: 'g:2', title: '学理财', category: 'finance', archived: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z'},
    ],
    habits: [
      {id: 'h:1', name: '走路', identity: '我是爱走路的人', trigger: '起床后', minimumAction: '穿上鞋', goalId: 'g:1', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z'},
      {id: 'h:2', name: '读书', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'},
    ],
    completions: [{id: 'c:1', habitId: 'h:1', date: '2026-11-02', note: '饭后', source: 'web', createdAt: '2026-11-02T12:00:00.000Z'}],
    reminders: ['scheduled', 'delivered', 'cancelled'].map((status, i) => ({id: 'r:' + i, text: '提醒' + i, dueAt: '2026-11-03T12:00:00.000Z', status, createdAt: '2026-11-02T00:00:00.000Z'})),
  };
  const sent = JSON.parse(JSON.stringify(snapshotFor(person, {scope: 'owner'}, NOW)));
  assert.deepEqual(Object.keys(sent.tables), ['habits', 'completions', 'goals', 'reminders']);
  assert.deepEqual(validateSnapshot(sent), sent, '这边认得的表和列，和 Weave 那边给的完全一样');
  const out = await write(tenant(), validateSnapshot(sent));
  assert.deepEqual(query(out.dbPath, 'select h.name, g.title, g.archived from habits h join goals g on g.goal_id = h.goal_id'), [{name: '走路', title: '每天动一动', archived: 0}]);
  assert.deepEqual(query(out.dbPath, 'select goal_id from goals where archived = 1'), [{goal_id: 'g:2'}]);
  assert.deepEqual(query(out.dbPath, 'select status from reminders order by reminder_id'), [{status: 'scheduled'}, {status: 'delivered'}, {status: 'cancelled'}]);
  // 群那一轮：Weave 不给这几张表，这边也不会凭空建出来。
  const group = validateSnapshot(JSON.parse(JSON.stringify(snapshotFor(person, {scope: 'group'}, NOW))));
  assert.deepEqual(group.tables, {});
  assert.deepEqual(tablesIn((await write(tenant(), group)).dbPath), ['meta']);
});

test('Weave 后端真实返回的 save_goal、save_habit 结果，applyWrite 照单同步：习惯挂在目标下', async () => {
  const person = {};
  const goalResult = saveGoal(person, {title: '每天动一动', category: 'health'}, NOW);
  const habitResult = saveHabit(person, {name: '走路', goal_id: goalResult.goal.goal_id}, NOW);
  const out = await write(tenant(), owner({habits: [], goals: []}));
  applyWrite(out.dbPath, 'save_goal', JSON.stringify(goalResult));
  applyWrite(out.dbPath, 'save_habit', JSON.stringify(habitResult));
  assert.deepEqual(query(out.dbPath, 'select h.name, g.title, g.category, g.archived from habits h join goals g on g.goal_id = h.goal_id'), [{name: '走路', title: '每天动一动', category: 'health', archived: 0}]);
  const archived = saveGoal(person, {goal_id: goalResult.goal.goal_id, archived: true}, NOW);
  applyWrite(out.dbPath, 'save_goal', JSON.stringify(archived));
  assert.deepEqual(query(out.dbPath, 'select archived from goals'), [{archived: 1}]);
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
