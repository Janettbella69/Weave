// 第一次建本子时导入以前存在网站库里的数据（legacy-import.mjs）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateLegacy, fetchLegacy, TABLES} from '../legacy-import.mjs';

const ok = (tables = {}) => ({version: 1, today: '2026-11-17', timezone: 'Asia/Shanghai', tables, files: {}});

test('只取认识的表和列：多出来的列丢掉，缺的列是 null', () => {
  const out = validateLegacy(ok({habits: [{habit_id: 'h1', name: '走路', extra: 'drop me'}]}));
  assert.deepEqual(Object.keys(out.tables.habits[0]), TABLES.habits);
  assert.equal(out.tables.habits[0].name, '走路');
  assert.equal(out.tables.habits[0].goal_id, null);
  assert.ok(!('extra' in out.tables.habits[0]));
});

test('版本、today、不认识的表、值的类型不对：整份不导（下次再试），不导一半', () => {
  assert.throws(() => validateLegacy({...ok(), version: 2}));
  assert.throws(() => validateLegacy({...ok(), today: '11/17'}));
  assert.throws(() => validateLegacy(ok({secrets: []})));
  assert.throws(() => validateLegacy(ok({habits: {}})));
  assert.throws(() => validateLegacy(ok({habits: [{habit_id: {nested: true}}]})));
});

test('fetchLegacy 带这条消息的通行证去网站取；网站不是 200 就抛错', async () => {
  let seen;
  const fetcher = async (url, init) => { seen = {url, auth: init.headers.Authorization}; return new Response(JSON.stringify(ok({goals: []})), {status: 200}); };
  const out = await fetchLegacy({weaveUrl: 'http://weave.test/', capability: 'cap-1', fetcher});
  assert.deepEqual(seen, {url: 'http://weave.test/api/internal/agent/snapshot', auth: 'Bearer cap-1'});
  assert.deepEqual(out.tables, {goals: []});
  await assert.rejects(fetchLegacy({weaveUrl: 'http://weave.test', capability: 'cap-1', fetcher: async () => new Response('{}', {status: 503})}), /503/);
});
