import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const STATS = fileURLToPath(new URL('../plugin/skills/weekly-review/scripts/stats.py', import.meta.url));
function stats(data, ...args) {
  const file = join(mkdtempSync(join(tmpdir(), 'weave-stats-')), 'week.json');
  writeFileSync(file, JSON.stringify(data));
  return JSON.parse(execFileSync('python3', [STATS, file, ...args], {encoding: 'utf8'}));
}

test('用数据里的 today 算最近 7 天、前 7 天和连续天数，同一天记两次只算一次', () => {
  const out = stats({today: '2026-11-02', completions: [
    {habit_id: 'walk', date: '2026-11-02'}, {habit_id: 'walk', date: '2026-11-01'}, {habit_id: 'walk', date: '2026-11-01'},
    {habit_id: 'walk', date: '2026-10-31'}, {habit_id: 'walk', date: '2026-10-29'},
    {habit_id: 'walk', date: '2026-10-25'}, {habit_id: 'walk', date: '2026-10-21'}, {habit_id: 'walk', date: '2026-10-19'},
    {habit_id: 'read', date: '2026-10-26'},
  ]});
  assert.deepEqual(out, {today: '2026-11-02', habits: {
    read: {last7: 0, prev7: 1, streak: 0},
    walk: {last7: 4, prev7: 2, streak: 3},
  }});
});

test('今天还没记不打断连续天数，昨天也没记才断', () => {
  const out = stats([
    {habit_id: 'walk', date: '2026-11-01'}, {habit_id: 'walk', date: '2026-10-31'},
    {habit_id: 'run', date: '2026-10-31'}, {habit_id: 'run', date: '2026-10-30'},
  ], '--today', '2026-11-02');
  assert.deepEqual(out, {today: '2026-11-02', habits: {
    run: {last7: 2, prev7: 0, streak: 0},
    walk: {last7: 2, prev7: 0, streak: 2},
  }});
});

test('坏日期跳过，不让整份统计失败', () => {
  const out = stats({today: '2026-11-02', completions: [{habit_id: 'walk', date: '2026-02-30'}, {habit_id: 'walk'}, {habit_id: 'walk', date: '2026-11-02'}]});
  assert.deepEqual(out.habits.walk, {last7: 1, prev7: 0, streak: 1});
});
