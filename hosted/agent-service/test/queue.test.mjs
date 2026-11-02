import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRunQueue} from '../queue.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const tick = () => new Promise(r => setImmediate(r));

test('同一个 key 串行，不同 key 并行', async () => {
  const q = createRunQueue({maxConcurrent: 3});
  const log = [], gates = [deferred(), deferred(), deferred()];
  const job = (name, gate) => async () => { log.push('start ' + name); await gate.promise; log.push('end ' + name); return name; };
  const a1 = q.run('alice', job('a1', gates[0])), a2 = q.run('alice', job('a2', gates[1])), b1 = q.run('bob', job('b1', gates[2]));
  await tick(); await tick();
  assert.deepEqual(log, ['start a1', 'start b1']);
  gates[0].resolve();
  assert.equal(await a1, 'a1');
  await tick(); await tick();
  assert.deepEqual(log, ['start a1', 'start b1', 'end a1', 'start a2']);
  gates[1].resolve(); gates[2].resolve();
  assert.deepEqual(await Promise.all([a2, b1]), ['a2', 'b1']);
});

test('总并发不超过上限，空出来就让下一个人开始', async () => {
  const q = createRunQueue({maxConcurrent: 2});
  let active = 0, peak = 0;
  const gates = [0, 1, 2, 3].map(() => deferred());
  const runs = gates.map((gate, i) => q.run('person' + i, async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; return i; }));
  await tick(); await tick();
  assert.equal(active, 2);
  gates.forEach(g => g.resolve());
  assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3]);
  assert.equal(peak, 2);
});

test('同一个 key 排队满了返回 429；前面的跑完又能排', async () => {
  const q = createRunQueue({maxConcurrent: 3, maxPerKey: 2});
  const gate = deferred();
  const first = q.run('alice', () => gate.promise), second = q.run('alice', async () => 'second');
  await assert.rejects(q.run('alice', async () => 'third'), error => error.status === 429);
  gate.resolve('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(await q.run('alice', async () => 'again'), 'again');
});

test('前一个失败不影响同一个 key 的下一个', async () => {
  const q = createRunQueue();
  const failed = q.run('alice', async () => { throw Error('boom'); });
  const next = q.run('alice', async () => 'next');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'next');
});
