import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store, withWorld} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';
import {STATUS_WINDOW_BACK} from '../hosted/app/workspace/records.mjs';
import {addDays} from '../hosted/app/workspace/dates.mjs';

const secret = 'ab'.repeat(32);
// 15:00Z is 23:00 on 2026-11-02 in Shanghai, the default zone.
const NOW = Date.parse('2026-11-02T15:00:00Z');
// Los Angeles at 23:30 on 2026-11-02 (UTC-8). In UTC and in Shanghai it is already 11-03.
const LA_LATE = Date.parse('2026-11-03T07:30:00Z');
// The model-facing draft text from habits.mjs (TEXT.notFound); keep the two in step.
const HABIT_NOT_FOUND = '没有这个习惯。先查 weave/weave.db 的 habits 表，看现有的习惯和编号。';
// Every top-level key of GET /api/status before the web check-in work, and the four it adds.
const OLD_STATUS_KEYS = ['profile', 'personId', 'people', 'messages', 'plans', 'checkins', 'calendar', 'reminders', 'notifications', 'negotiations', 'settings', 'invites', 'agentRuntime'];
const NEW_STATUS_KEYS = ['goals', 'habits', 'completions', 'today'];

async function setup() {
  const db = new D1();
  let toolCalls = 0;
  // A browser request from Alice or Bob. The clock is fixed unless a test passes its own.
  async function call(who, path, data, {now = NOW, origin = 'https://weave.test', via = db} = {}) {
    const init = data === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json', ...(origin ? {Origin: origin} : {})}, body: JSON.stringify(data)};
    const r = await handleAPI(new Request('https://weave.test/api/' + path, init), {db: via, identity: {userId: who, displayName: who, email: who + '@example.test'}, secret, now});
    return {status: r.status, data: await r.json()};
  }
  const status = async (who, options) => (await call(who, 'status', undefined, options)).data;
  const ids = {Alice: (await status('Alice')).personId, Bob: (await status('Bob')).personId};
  // What the Agent does: a tool call with the capability of one wake. Returns the parsed tool result.
  async function tool(who, name, args) {
    const token = await issueCapability(secret, {owner: ids[who], scope: 'owner', runId: 'run-1', channel: 'web', direct: true}, NOW);
    const r = await handleAPI(new Request('https://weave.test/api/internal/agent/tools/' + name, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
      body: JSON.stringify({args, toolUseId: 'toolu_' + ++toolCalls}),
    }), {db, secret, now: NOW});
    const data = await r.json();
    assert.equal(data.ok, true, JSON.stringify(data));
    return JSON.parse(data.text);
  }
  const habit = async (who, args = {name: '走路'}) => (await tool(who, 'save_habit', args)).habit.habit_id;
  const person = async who => (await new Store(db).load()).people[ids[who]];
  return {db, ids, call, status, tool, habit, person};
}

test("status of a fresh person: empty goals, habits and completions, and today in the person's zone", async () => {
  const s = await setup();
  const status = await s.status('Alice');
  assert.deepEqual([status.goals, status.habits, status.completions], [[], [], []]);
  assert.equal(status.today, '2026-11-02');
  // On the real clock it is still a plain YYYY-MM-DD date.
  assert.match((await s.status('Alice', {now: Date.now()})).today, /^\d{4}-\d{2}-\d{2}$/);
  // Nothing that was in the status before is gone or renamed.
  assert.deepEqual(Object.keys(status).sort(), [...OLD_STATUS_KEYS, ...NEW_STATUS_KEYS].sort());
});

test('habits/check logs today as a web completion, a second check is a duplicate, and uncheck takes it away', async () => {
  const s = await setup();
  const walk = await s.habit('Alice');
  // The checkToday result as is: no goal_id.
  const done = {completion: {habit_id: walk, date: '2026-11-02', note: ''}};
  assert.deepEqual(await s.call('Alice', 'habits/check', {habit_id: walk}), {status: 200, data: {...done, duplicate: false}});
  const status = await s.status('Alice');
  assert.equal(status.completions.length, 1);
  // Stored as is.
  assert.deepEqual({...status.completions[0], id: 'x'}, {id: 'x', habitId: walk, date: status.today, note: '', createdAt: new Date(NOW).toISOString(), source: 'web'});
  assert.deepEqual(await s.call('Alice', 'habits/check', {habit_id: walk}), {status: 200, data: {...done, duplicate: true}});
  assert.equal((await s.status('Alice')).completions.length, 1);
  assert.equal((await s.person('Alice')).completions.length, 1);
  assert.deepEqual(await s.call('Alice', 'habits/uncheck', {habit_id: walk}), {status: 200, data: {removed: true}});
  assert.deepEqual((await s.status('Alice')).completions, []);
});

test("habits/uncheck removes only today's completion, whoever logged it", async () => {
  const s = await setup();
  const walk = await s.habit('Alice'), read = await s.habit('Alice', {name: '读书'});
  await s.tool('Alice', 'log_completion', {habit_id: walk, date: '2026-11-01'}); // yesterday, by the Agent
  await s.tool('Alice', 'log_completion', {habit_id: read, date: '2026-11-02'}); // today, by the Agent
  await s.call('Alice', 'habits/check', {habit_id: walk}); // today, from the web
  const left = async () => (await s.status('Alice')).completions.map(c => [c.habitId === walk ? 'walk' : 'read', c.date, c.source]);
  assert.deepEqual(await left(), [['walk', '2026-11-01', 'agent'], ['read', '2026-11-02', 'agent'], ['walk', '2026-11-02', 'web']]);

  assert.deepEqual(await s.call('Alice', 'habits/uncheck', {habit_id: walk}), {status: 200, data: {removed: true}});
  assert.deepEqual(await left(), [['walk', '2026-11-01', 'agent'], ['read', '2026-11-02', 'agent']]);
  // Nothing left to remove for today: not an error.
  assert.deepEqual(await s.call('Alice', 'habits/uncheck', {habit_id: walk}), {status: 200, data: {removed: false}});
  assert.deepEqual(await s.call('Alice', 'habits/uncheck', {habit_id: read}), {status: 200, data: {removed: true}});
  assert.deepEqual(await left(), [['walk', '2026-11-01', 'agent']]);
});

test('check and uncheck with a missing or unknown habit_id are 400 with the not-found text', async () => {
  const s = await setup();
  const walk = await s.habit('Alice');
  for (const path of ['habits/check', 'habits/uncheck'])
    for (const body of [{habit_id: 'h:nope'}, {}, {habit_id: 42}, {habit_id: null}, {habit_id: {id: walk}}])
      assert.deepEqual(await s.call('Alice', path, body), {status: 400, data: {error: HABIT_NOT_FOUND}}, path + ' ' + JSON.stringify(body));
  assert.equal((await s.person('Alice')).completions, undefined, 'nothing was written');
});

test("another person's habit id is not found, and nothing of theirs changes", async () => {
  const s = await setup();
  const walk = await s.habit('Alice');
  await s.call('Alice', 'habits/check', {habit_id: walk});
  for (const path of ['habits/check', 'habits/uncheck'])
    assert.deepEqual(await s.call('Bob', path, {habit_id: walk}), {status: 400, data: {error: HABIT_NOT_FOUND}}, path);
  const bob = await s.status('Bob');
  assert.deepEqual([bob.habits, bob.completions], [[], []]);
  assert.equal((await s.person('Bob')).completions, undefined);
  const alice = await s.status('Alice');
  assert.deepEqual(alice.completions.map(c => [c.habitId, c.date, c.source]), [[walk, '2026-11-02', 'web']], 'Alice still has her check');
});

test('status.completions covers the last 62 days: today minus 61 is in, minus 62 and 70 are out; export keeps them all', async () => {
  const s = await setup();
  const walk = await s.habit('Alice');
  // 2026-11-02 minus 70, 62, 61 and 1 days.
  const dates = ['2026-08-24', '2026-09-01', '2026-09-02', '2026-11-01'];
  await withWorld(s.db, world => {
    const alice = world.people[s.ids.Alice];
    alice.completions ??= [];
    for (const date of dates) alice.completions.push({id: 'old-' + date, habitId: walk, date, note: '', createdAt: date + 'T08:00:00.000Z', source: 'agent'});
  });
  await s.call('Alice', 'habits/check', {habit_id: walk});
  assert.deepEqual((await s.status('Alice')).completions.map(c => c.date), ['2026-09-02', '2026-11-01', '2026-11-02']);
  const exported = (await s.call('Alice', 'export')).data;
  assert.deepEqual(exported.completions.map(c => c.date), [...dates, '2026-11-02']);
});

test("the records page's STATUS_WINDOW_BACK is the window /api/status sends", async () => {
  // The page (app/workspace/records.mjs) and the server (lib/weave/api.mjs) each keep the number: the page's bundle does
  // not bring in server code. Held together here, at any day: the first day sent is today minus STATUS_WINDOW_BACK.
  const s = await setup();
  const walk = await s.habit('Alice');
  for (const now of [NOW, LA_LATE, Date.parse('2027-03-01T04:00:00Z')]) {
    const today = (await s.status('Alice', {now})).today;
    const first = addDays(today, -STATUS_WINDOW_BACK), before = addDays(today, -STATUS_WINDOW_BACK - 1);
    await withWorld(s.db, world => {
      world.people[s.ids.Alice].completions = [before, first, today].map(date => ({id: 'old-' + date, habitId: walk, date, note: '', createdAt: date + 'T08:00:00.000Z', source: 'agent'}));
    });
    assert.deepEqual((await s.status('Alice', {now})).completions.map(c => c.date), [first, today], 'today is ' + today);
  }
});

test("check, today and the 62-day window follow the person's zone, not UTC", async () => {
  const s = await setup();
  const run = await s.habit('Alice', {name: '跑步'});
  await withWorld(s.db, world => {
    const alice = world.people[s.ids.Alice];
    alice.profile.timezone = 'America/Los_Angeles';
    // In Los Angeles on 11-02 these are today minus 62 and minus 61 days. Counted from the UTC date (11-03), 09-02 would be out.
    alice.completions = ['2026-09-01', '2026-09-02'].map(date => ({id: 'old-' + date, habitId: run, date, note: '', createdAt: date + 'T08:00:00.000Z', source: 'agent'}));
  });
  assert.equal((await s.status('Alice', {now: LA_LATE})).today, '2026-11-02');
  assert.deepEqual((await s.call('Alice', 'habits/check', {habit_id: run}, {now: LA_LATE})).data, {completion: {habit_id: run, date: '2026-11-02', note: ''}, duplicate: false});
  const late = await s.status('Alice', {now: LA_LATE});
  assert.deepEqual(late.completions.map(c => c.date), ['2026-09-02', '2026-11-02'], 'the Los Angeles day, and the window counted from it');
  // 00:30 in Los Angeles is the next day: the same habit can be checked again, and the window moves up a day.
  const after = LA_LATE + 3_600_000;
  assert.equal((await s.status('Alice', {now: after})).today, '2026-11-03');
  assert.deepEqual((await s.call('Alice', 'habits/check', {habit_id: run}, {now: after})).data, {completion: {habit_id: run, date: '2026-11-03', note: ''}, duplicate: false});
  assert.deepEqual((await s.status('Alice', {now: after})).completions.map(c => c.date), ['2026-11-02', '2026-11-03']);
  // Uncheck takes the same clock and zone: it removes the 11-03 check, and the 11-02 one is no longer "today".
  assert.deepEqual((await s.call('Alice', 'habits/uncheck', {habit_id: run}, {now: after})).data, {removed: true});
  assert.deepEqual((await s.call('Alice', 'habits/uncheck', {habit_id: run}, {now: after})).data, {removed: false});
  assert.deepEqual((await s.status('Alice', {now: after})).completions.map(c => c.date), ['2026-11-02']);
});

test('an old account with habits but no goals: status.goals is [] and the habits come back as stored', async () => {
  const s = await setup();
  const walk = await s.habit('Alice', {name: '走路', identity: '我是爱走路的人'});
  const stored = await s.person('Alice');
  assert.equal(stored.goals, undefined);
  assert.equal('goalId' in stored.habits[0], false);
  const response = await s.call('Alice', 'status');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.goals, []);
  assert.deepEqual(response.data.habits, stored.habits);
  assert.equal(response.data.habits[0].id, walk);
  assert.equal('goalId' in response.data.habits[0], false);
  // The export of the same account does not trip over the missing list either.
  assert.deepEqual((await s.call('Alice', 'export')).data.goals, []);
});

test('status.goals has every stored goal, archived ones too, so their habits can be matched; status.habits keeps every habit; export.goals has all goals', async () => {
  const s = await setup();
  const {goal: move} = await s.tool('Alice', 'save_goal', {title: '每天动一动', category: 'health'});
  const {goal: read} = await s.tool('Alice', 'save_goal', {title: '多读书', category: 'interests'});
  const walk = await s.habit('Alice', {name: '走路', goal_id: move.goal_id});
  const book = await s.habit('Alice', {name: '睡前读十页', goal_id: read.goal_id});
  const loose = await s.habit('Alice', {name: '喝水'});
  await s.tool('Alice', 'save_goal', {goal_id: read.goal_id, archived: true});

  const stored = await s.person('Alice');
  assert.equal(stored.goals.length, 2);
  const status = await s.status('Alice');
  // Every goal as stored (id, title, category, archived, createdAt, updatedAt), the archived one with its flag.
  assert.deepEqual(status.goals, stored.goals);
  assert.deepEqual(status.goals.map(g => [g.id, g.title, g.category, g.archived]), [[move.goal_id, '每天动一动', 'health', false], [read.goal_id, '多读书', 'interests', true]]);
  // Every habit as stored, and each goalId can be looked up in status.goals: a habit of an archived goal is not mistaken for a goal-less one.
  assert.deepEqual(status.habits, stored.habits);
  assert.deepEqual(status.habits.map(h => [h.id, h.goalId]), [[walk, move.goal_id], [book, read.goal_id], [loose, undefined]]);
  const goalOf = habit => status.goals.find(g => g.id === status.habits.find(h => h.id === habit).goalId);
  assert.equal(goalOf(book).archived, true);
  assert.equal(goalOf(walk).archived, false);
  const exported = (await s.call('Alice', 'export')).data;
  assert.deepEqual(exported.goals, stored.goals);
  assert.deepEqual(exported.goals.map(g => g.archived), [false, true]);
  assert.equal((await s.status('Bob')).goals.length, 0, "Bob does not see Alice's goals");
});

test('a POST without an Origin, or from another site, is 403 and writes nothing', async () => {
  const s = await setup();
  const walk = await s.habit('Alice'), read = await s.habit('Alice', {name: '读书'});
  await s.call('Alice', 'habits/check', {habit_id: walk});
  for (const origin of [null, 'https://evil.test']) {
    assert.equal((await s.call('Alice', 'habits/check', {habit_id: read}, {origin})).status, 403, 'check, origin ' + origin);
    assert.equal((await s.call('Alice', 'habits/uncheck', {habit_id: walk}, {origin})).status, 403, 'uncheck, origin ' + origin);
  }
  assert.deepEqual((await s.status('Alice')).completions.map(c => c.habitId), [walk]);
});

// Runs `change` once, right before the first commit that goes through the returned database, as if another request had committed first.
const racing = (db, change) => {
  let armed = true;
  return {
    prepare: query => Object.assign(db.prepare(query), {query}),
    async batch(statements) {
      if (armed && statements[0].query?.startsWith('UPDATE weave_commits')) { armed = false; await change(); }
      return db.batch(statements);
    },
  };
};

test("a check that races a write to the same person is 409 and records nothing; a write to someone else's account does not block it", async () => {
  const s = await setup();
  const walk = await s.habit('Alice');
  await s.habit('Bob');
  // The Agent writes to Alice's document between the web request's read and its commit.
  const clash = await s.call('Alice', 'habits/check', {habit_id: walk}, {via: racing(s.db, () => s.tool('Alice', 'log_completion', {habit_id: walk, date: '2026-11-01'}))});
  assert.equal(clash.status, 409);
  assert.deepEqual((await s.status('Alice')).completions.map(c => [c.date, c.source]), [['2026-11-01', 'agent']], 'the check was not recorded');
  // Refresh and click again: it goes through.
  assert.deepEqual((await s.call('Alice', 'habits/check', {habit_id: walk})).data.duplicate, false);

  // Someone else's account changing in the meantime is merged around, not a conflict.
  const read = await s.habit('Alice', {name: '读书'});
  const fine = await s.call('Alice', 'habits/check', {habit_id: read}, {via: racing(s.db, () => s.tool('Bob', 'save_habit', {name: '游泳'}))});
  assert.equal(fine.status, 200);
  assert.equal(fine.data.duplicate, false);
  assert.equal((await s.person('Bob')).habits.length, 2, "Bob's write is kept");
  assert.deepEqual((await s.status('Alice')).completions.map(c => c.habitId === read), [false, false, true]);
});
