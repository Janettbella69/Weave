import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GOAL_CATEGORIES, saveGoal, saveHabit, logCompletion, checkToday, uncheckToday} from '../hosted/lib/weave/habits.mjs';

const person = (timezone = 'Asia/Shanghai') => ({id: 'u:a', profile: {timezone}, habits: [], completions: []});
const NOW = Date.parse('2026-11-02T07:30:00Z');
// 洛杉矶 2026-11-02 23:30（太平洋标准时间 UTC-8）；这一刻 UTC 和上海都已经是 11-03。
const LA_LATE = Date.parse('2026-11-03T07:30:00Z');
const rejects400 = fn => assert.throws(fn, error => error.status === 400);
const rejectsWith = (fn, message) => assert.throws(fn, {status: 400, message});
// 草稿文案，待确认：和 habits.mjs 里 TEXT 的对应几条逐字一致，改文案时两边一起改。
const GOAL_TEXT = {
  title: '目标名字要 1–30 个字。',
  category: '类别只能是 health、relationships、finance、career、interests、productivity、other 之一。',
  tooMany: '最多同时追踪 10 个目标。先把不再追踪的目标归档（archived: true），再加新的。',
  notFound: '没有这个目标。先查 weave/weave.db 的 goals 表，看现有的目标和编号。',
};
const HABIT_NOT_FOUND = '没有这个习惯。先查 weave/weave.db 的 habits 表，看现有的习惯和编号。';

test('新建习惯：名字去掉空白后 1–30 字，身份句、触发、最小动作各不超过 200 字', () => {
  const p = person();
  const {habit} = saveHabit(p, {name: '  走路  ', identity: '我是每天都会动一动的人', trigger: '吃完午饭', minimum_action: '走到楼下'}, NOW);
  assert.match(habit.habit_id, /^h:/);
  assert.deepEqual({...habit, habit_id: 'x'}, {habit_id: 'x', name: '走路', identity: '我是每天都会动一动的人', trigger: '吃完午饭', minimum_action: '走到楼下', goal_id: null});
  for (const args of [{name: ''}, {name: '   '}, {name: 'x'.repeat(31)}, {name: 42}, {name: '读书', identity: 'x'.repeat(201)}, {name: '读书', trigger: 7}]) rejects400(() => saveHabit(p, args, NOW));
  assert.equal(p.habits.length, 1);
});

test('最多 20 个习惯，第 21 个拒绝', () => {
  const p = person();
  for (let i = 0; i < 20; i++) saveHabit(p, {name: '习惯' + i}, NOW);
  rejects400(() => saveHabit(p, {name: '第二十一个'}, NOW));
  assert.equal(p.habits.length, 20);
});

test('改习惯只改给了的字段；别人的 habit_id 当作不存在', () => {
  const alice = person(), bob = person();
  const {habit} = saveHabit(alice, {name: '走路', identity: '我是爱走路的人', trigger: '午饭后'}, NOW);
  const updated = saveHabit(alice, {habit_id: habit.habit_id, name: '散步', trigger: '晚饭后'}, NOW + 1000).habit;
  assert.deepEqual(updated, {habit_id: habit.habit_id, name: '散步', identity: '我是爱走路的人', trigger: '晚饭后', minimum_action: '', goal_id: null});
  assert.equal(alice.habits.length, 1);
  rejects400(() => saveHabit(bob, {habit_id: habit.habit_id, name: '偷改'}, NOW));
  assert.equal(alice.habits[0].name, '散步');
  assert.equal(bob.habits.length, 0);
});

test('不记未来日期，按本人时区算今天：洛杉矶还是 11-01，上海已经是 11-02', () => {
  const la = person('America/Los_Angeles'), sh = person('Asia/Shanghai');
  const walkLa = saveHabit(la, {name: '走路'}, NOW).habit.habit_id, walkSh = saveHabit(sh, {name: '走路'}, NOW).habit.habit_id;
  assert.throws(() => logCompletion(la, {habit_id: walkLa, date: '2026-11-02'}, NOW), error => error.status === 400 && error.message.includes('2026-11-01'));
  assert.equal(logCompletion(la, {habit_id: walkLa, date: '2026-11-01'}, NOW).duplicate, false);
  assert.equal(logCompletion(sh, {habit_id: walkSh, date: '2026-11-02'}, NOW).duplicate, false);
  rejects400(() => logCompletion(sh, {habit_id: walkSh, date: '2026-11-03'}, NOW));
});

test('同一习惯同一天只记一次，第二次 duplicate 为 true；不同习惯同一天各记一条', () => {
  const p = person();
  const walk = saveHabit(p, {name: '走路'}, NOW).habit.habit_id, read = saveHabit(p, {name: '读书'}, NOW).habit.habit_id;
  assert.deepEqual(logCompletion(p, {habit_id: walk, date: '2026-11-01', note: '20 分钟'}, NOW), {completion: {habit_id: walk, date: '2026-11-01', note: '20 分钟'}, duplicate: false});
  assert.deepEqual(logCompletion(p, {habit_id: walk, date: '2026-11-01', note: '又说了一遍'}, NOW), {completion: {habit_id: walk, date: '2026-11-01', note: '20 分钟'}, duplicate: true});
  logCompletion(p, {habit_id: read, date: '2026-11-01'}, NOW);
  assert.equal(p.completions.length, 2);
});

test('日期格式不对、不存在的日期、没有这个习惯、备注太长都拒绝', () => {
  const p = person(), walk = saveHabit(p, {name: '走路'}, NOW).habit.habit_id;
  for (const date of ['2026-02-30', '2026-1-5', '', undefined, '2026-11-01T00:00:00Z', 20261101]) rejects400(() => logCompletion(p, {habit_id: walk, date}, NOW));
  rejects400(() => logCompletion(p, {habit_id: 'h:nope', date: '2026-11-01'}, NOW));
  rejects400(() => logCompletion(p, {habit_id: walk, date: '2026-11-01', note: 'x'.repeat(501)}, NOW));
  assert.equal(p.completions.length, 0);
});

test('GOAL_CATEGORIES is the seven category ids in display order', () => {
  assert.deepEqual(GOAL_CATEGORIES, ['health', 'relationships', 'finance', 'career', 'interests', 'productivity', 'other']);
});

test('saveGoal creates and updates a goal', () => {
  const p = person();
  assert.equal(p.goals, undefined);
  const {goal} = saveGoal(p, {title: '  每天动一动  ', category: 'health'}, NOW);
  assert.match(goal.goal_id, /^g:/);
  assert.deepEqual({...goal, goal_id: 'x'}, {goal_id: 'x', title: '每天动一动', category: 'health', archived: false});
  assert.deepEqual(p.goals, [{id: goal.goal_id, title: '每天动一动', category: 'health', archived: false, createdAt: '2026-11-02T07:30:00.000Z', updatedAt: '2026-11-02T07:30:00.000Z'}]);
  // 30 个字刚好够。
  assert.equal(saveGoal(p, {title: '长'.repeat(30), category: 'other'}, NOW).goal.title.length, 30);

  // 修改只改给了的字段：归档时名字和类别不动。
  const archived = saveGoal(p, {goal_id: goal.goal_id, archived: true}, NOW + 1000).goal;
  assert.deepEqual(archived, {goal_id: goal.goal_id, title: '每天动一动', category: 'health', archived: true});
  assert.equal(p.goals[0].createdAt, '2026-11-02T07:30:00.000Z');
  assert.equal(p.goals[0].updatedAt, '2026-11-02T07:30:01.000Z');
  // 改名字和类别：归档状态不动。恢复追踪时名字和类别也不动。
  assert.deepEqual(saveGoal(p, {goal_id: goal.goal_id, title: ' 每天走一走 ', category: 'interests'}, NOW + 2000).goal, {goal_id: goal.goal_id, title: '每天走一走', category: 'interests', archived: true});
  assert.deepEqual(saveGoal(p, {goal_id: goal.goal_id, archived: false}, NOW + 3000).goal, {goal_id: goal.goal_id, title: '每天走一走', category: 'interests', archived: false});
  assert.equal(p.goals.length, 2);
});

test('saveGoal rejects bad input', () => {
  const p = person();
  for (const title of ['', '   ', 'x'.repeat(31), 42, null, undefined]) rejectsWith(() => saveGoal(p, {title, category: 'health'}, NOW), GOAL_TEXT.title);
  for (const category of ['sport', 'Health', '', 7, null, undefined]) rejectsWith(() => saveGoal(p, {title: '每天动一动', category}, NOW), GOAL_TEXT.category);
  rejectsWith(() => saveGoal(p, undefined, NOW), GOAL_TEXT.title);
  assert.equal(p.goals, undefined, '被拒绝的调用不改文档，连空数组也不建');

  // 前 10 个在追踪，第 11 个被拒绝。
  const first = saveGoal(p, {title: '目标 0', category: GOAL_CATEGORIES[0]}, NOW).goal;
  for (let i = 1; i < 10; i++) saveGoal(p, {title: '目标 ' + i, category: GOAL_CATEGORIES[i % GOAL_CATEGORIES.length]}, NOW);
  rejectsWith(() => saveGoal(p, {title: '第十一个', category: 'other'}, NOW), GOAL_TEXT.tooMany);
  assert.equal(p.goals.length, 10);

  // 修改时同样检查；一项不合格，整条都不改。
  rejectsWith(() => saveGoal(p, {goal_id: first.goal_id, title: '改个名字', category: 'sport'}, NOW + 1000), GOAL_TEXT.category);
  rejectsWith(() => saveGoal(p, {goal_id: first.goal_id, title: '   '}, NOW + 1000), GOAL_TEXT.title);
  assert.deepEqual(p.goals[0], {id: first.goal_id, title: '目标 0', category: 'health', archived: false, createdAt: '2026-11-02T07:30:00.000Z', updatedAt: '2026-11-02T07:30:00.000Z'});

  // 没有这个目标：编号不存在、不是字符串，或者是别人的。（空字符串当作没给，见下面那条测试。）
  for (const goal_id of ['g:nope', 42, null]) rejectsWith(() => saveGoal(p, {goal_id, archived: true}, NOW), GOAL_TEXT.notFound);
  const bob = person();
  rejectsWith(() => saveGoal(bob, {goal_id: first.goal_id, archived: true}, NOW), GOAL_TEXT.notFound);
  assert.equal(p.goals[0].archived, false);
  assert.equal(bob.goals, undefined);
});

test('saveGoal: archived goals do not count toward the 10, and restoring one respects the cap', () => {
  const p = person();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(saveGoal(p, {title: '目标 ' + i, category: 'other'}, NOW).goal.goal_id);
  // 照提示先归档一个，就能再加一个。
  saveGoal(p, {goal_id: ids[0], archived: true}, NOW);
  assert.equal(saveGoal(p, {title: '新目标', category: 'other'}, NOW).goal.archived, false);
  assert.equal(p.goals.length, 11);
  // 又满了：恢复那个归档的会变成 11 个在追踪，拒绝，它仍是归档的。
  rejectsWith(() => saveGoal(p, {goal_id: ids[0], archived: false}, NOW), GOAL_TEXT.tooMany);
  assert.equal(p.goals[0].archived, true);
  // 满了的时候，改在追踪的目标的名字，或者对它重复说 archived:false，都不受影响。
  assert.equal(saveGoal(p, {goal_id: ids[1], title: '改了名', archived: false}, NOW).goal.title, '改了名');
});

test('saveHabit links a habit to a goal', () => {
  const p = person();
  const {goal} = saveGoal(p, {title: '每天动一动', category: 'health'}, NOW);
  const other = saveGoal(p, {title: '多读书', category: 'interests'}, NOW).goal;
  const {habit} = saveHabit(p, {name: '走路', goal_id: goal.goal_id}, NOW);
  assert.equal(habit.goal_id, goal.goal_id);
  assert.equal(p.habits[0].goalId, goal.goal_id);
  // 没给 goal_id：不挂目标，公开形状里是 null（旧习惯一直是这样）。
  assert.equal(saveHabit(p, {name: '读书'}, NOW).habit.goal_id, null);
  assert.equal(p.habits[1].goalId, undefined);
  // 改习惯：没给 goal_id 就保持原来的目标；给了就换。
  assert.equal(saveHabit(p, {habit_id: habit.habit_id, name: '快走'}, NOW).habit.goal_id, goal.goal_id);
  assert.equal(saveHabit(p, {habit_id: habit.habit_id, name: '快走', goal_id: other.goal_id}, NOW).habit.goal_id, other.goal_id);

  // 目标不存在、已归档、是别人的：都当作没有这个目标，而且什么也不改。
  saveGoal(p, {goal_id: other.goal_id, archived: true}, NOW);
  const before = JSON.stringify(p.habits);
  rejectsWith(() => saveHabit(p, {name: '游泳', goal_id: 'g:nope'}, NOW), GOAL_TEXT.notFound);
  rejectsWith(() => saveHabit(p, {name: '游泳', goal_id: other.goal_id}, NOW), GOAL_TEXT.notFound);
  rejectsWith(() => saveHabit(p, {habit_id: habit.habit_id, name: '改名', goal_id: other.goal_id}, NOW), GOAL_TEXT.notFound);
  assert.equal(JSON.stringify(p.habits), before);
  const bob = person();
  rejectsWith(() => saveHabit(bob, {name: '走路', goal_id: goal.goal_id}, NOW), GOAL_TEXT.notFound);
  assert.equal(bob.habits.length, 0);
});

test('an empty goal_id or habit_id counts as not given: saveGoal and saveHabit create, or keep what was there', () => {
  // 模型有时把没有的编号写成 ''（工具参数的 z.string().optional() 收它）。以前这会回「没有这个目标…」，模型只好再试一次。
  const p = person();
  for (const goal_id of ['', '   ']) assert.match(saveGoal(p, {goal_id, title: '每天动一动', category: 'health'}, NOW).goal.goal_id, /^g:/, '新建：' + JSON.stringify(goal_id));
  assert.equal(p.goals.length, 2);
  // 只给了空编号和 archived：就是新建一个没名字的目标，回名字那句，不回「没有这个目标」。
  rejectsWith(() => saveGoal(p, {goal_id: '', archived: true}, NOW), GOAL_TEXT.title);
  assert.equal(p.goals.length, 2);

  const goal = p.goals[0].id;
  // 空的 habit_id 新建习惯，空的 goal_id 不挂目标。
  const {habit} = saveHabit(p, {habit_id: '', name: '走路', goal_id: ''}, NOW);
  assert.match(habit.habit_id, /^h:/);
  assert.equal(habit.goal_id, null);
  assert.equal('goalId' in p.habits[0], false);
  assert.equal(saveHabit(p, {habit_id: ' ', name: '读书', goal_id: goal}, NOW).habit.goal_id, goal);
  assert.equal(p.habits.length, 2);
  // 改习惯时空的 goal_id 也当作没给：原来的目标不动。
  const read = p.habits[1].id;
  assert.deepEqual(saveHabit(p, {habit_id: read, name: '多读书', goal_id: '  '}, NOW).habit, {habit_id: read, name: '多读书', identity: '', trigger: '', minimum_action: '', goal_id: goal});
  // 别的找不到的编号照旧拒绝，什么也不改。
  rejectsWith(() => saveHabit(p, {habit_id: 'h:nope', name: '游泳'}, NOW), HABIT_NOT_FOUND);
  rejectsWith(() => saveHabit(p, {name: '游泳', goal_id: 'g:nope'}, NOW), GOAL_TEXT.notFound);
  assert.equal(p.habits.length, 2);
});

test("checkToday uses the person's local day", () => {
  const la = person('America/Los_Angeles'), sh = person('Asia/Shanghai');
  const walk = saveHabit(la, {name: '走路'}, LA_LATE).habit.habit_id;
  assert.deepEqual(checkToday(la, walk, LA_LATE), {completion: {habit_id: walk, date: '2026-11-02', note: ''}, duplicate: false});
  assert.equal(la.completions[0].source, 'web');
  // 同一天再点一次：不重复记。
  assert.deepEqual(checkToday(la, walk, LA_LATE + 60_000), {completion: {habit_id: walk, date: '2026-11-02', note: ''}, duplicate: true});
  assert.equal(la.completions.length, 1);
  // 过了本人的午夜（洛杉矶 00:30）才是新的一天。
  assert.deepEqual(checkToday(la, walk, LA_LATE + 3_600_000), {completion: {habit_id: walk, date: '2026-11-03', note: ''}, duplicate: false});
  assert.equal(la.completions.length, 2);
  // 同一时刻，上海的人已经是 11-03 的下午。
  const read = saveHabit(sh, {name: '读书'}, LA_LATE).habit.habit_id;
  assert.equal(checkToday(sh, read, LA_LATE).completion.date, '2026-11-03');
  rejectsWith(() => checkToday(la, 'h:nope', LA_LATE), HABIT_NOT_FOUND);
  assert.equal(la.completions.length, 2);
});

test("uncheckToday removes only today's completion", () => {
  const p = person(); // 上海：NOW 是当地 2026-11-02 15:30
  const walk = saveHabit(p, {name: '走路'}, NOW).habit.habit_id, read = saveHabit(p, {name: '读书'}, NOW).habit.habit_id;
  logCompletion(p, {habit_id: walk, date: '2026-11-01'}, NOW);
  logCompletion(p, {habit_id: walk, date: '2026-11-02', note: '20 分钟'}, NOW); // 今天这条是 Agent 记的，也照样能取消
  checkToday(p, read, NOW); // 另一个习惯今天的，网页记的，不该被动
  const datesOf = id => p.completions.filter(c => c.habitId === id).map(c => c.date);

  assert.deepEqual(uncheckToday(p, walk, NOW), {removed: true});
  assert.deepEqual(datesOf(walk), ['2026-11-01']);
  assert.deepEqual(datesOf(read), ['2026-11-02']);
  assert.deepEqual(uncheckToday(p, walk, NOW), {removed: false});
  assert.deepEqual(datesOf(walk), ['2026-11-01']);
  // 网页记的也能取消。
  assert.deepEqual(uncheckToday(p, read, NOW), {removed: true});
  assert.equal(p.completions.length, 1);
  rejectsWith(() => uncheckToday(p, 'h:nope', NOW), HABIT_NOT_FOUND);

  // 今天按本人时区算：洛杉矶 23:30 点上的，洛杉矶 23:30 就能取消（UTC 那天是 11-03）。
  const la = person('America/Los_Angeles'), run = saveHabit(la, {name: '跑步'}, LA_LATE).habit.habit_id;
  checkToday(la, run, LA_LATE);
  assert.deepEqual(uncheckToday(la, run, LA_LATE), {removed: true});
  assert.equal(la.completions.length, 0);

  // 从没记过任何东西的人：什么也没删，也不凭空建出 completions。
  const bare = person(), swim = saveHabit(bare, {name: '游泳'}, NOW).habit.habit_id;
  delete bare.completions;
  assert.deepEqual(uncheckToday(bare, swim, NOW), {removed: false});
  assert.equal(bare.completions, undefined);
});

