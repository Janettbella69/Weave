import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saveHabit, logCompletion} from '../hosted/lib/weave/habits.mjs';

const person = (timezone = 'Asia/Shanghai') => ({id: 'u:a', profile: {timezone}, habits: [], completions: []});
const NOW = Date.parse('2026-11-02T07:30:00Z');
const rejects400 = fn => assert.throws(fn, error => error.status === 400);

test('新建习惯：名字去掉空白后 1–30 字，身份句、触发、最小动作各不超过 200 字', () => {
  const p = person();
  const {habit} = saveHabit(p, {name: '  走路  ', identity: '我是每天都会动一动的人', trigger: '吃完午饭', minimum_action: '走到楼下'}, NOW);
  assert.match(habit.habit_id, /^h:/);
  assert.deepEqual({...habit, habit_id: 'x'}, {habit_id: 'x', name: '走路', identity: '我是每天都会动一动的人', trigger: '吃完午饭', minimum_action: '走到楼下'});
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
  assert.deepEqual(updated, {habit_id: habit.habit_id, name: '散步', identity: '我是爱走路的人', trigger: '晚饭后', minimum_action: ''});
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

