// The bridge's fast path: Weave says in its answer to /events that a message needs the Agent (wake) or that a message is queued
// to send (outbound), and the bridge acts at once instead of at the next poll. Fakes only: no network, no real timers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFastPath, createTick, deliveryLoop, handleEvent, singleFlight, tickLoop, withHints} from '../hosted/wechat-bridge/bridge.mjs';

// Lets pending promises settle without waiting on a timer.
const turns = async (count = 6) => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); };
// A job whose runs the test finishes by hand; it records how many runs were going at once.
const gated = () => {
  const state = {runs: 0, live: 0, peak: 0, gates: []};
  const job = async () => { state.runs++; state.live++; state.peak = Math.max(state.peak, state.live); await new Promise(resolve => state.gates.push(resolve)); state.live--; };
  state.finish = () => state.gates.shift()();     // finishes the oldest run that is going
  return {job, state};
};
const quietly = async run => { const keep = console.error, lines = []; console.error = (...args) => lines.push(args.join(' ')); try { await run(); } finally { console.error = keep; } return lines; };

test('singleFlight: a burst of requests is one run going and one run waiting, never two at once', async () => {
  const {job, state} = gated(), flight = singleFlight(job);
  const first = flight.request();
  await turns();
  assert.equal(state.runs, 1);
  for (let i = 0; i < 10; i++) flight.request();
  await turns();
  assert.equal(state.runs, 1);                         // still the first one
  state.finish();
  await turns();
  assert.equal(state.runs, 2);                         // exactly one more, however many asked
  state.finish();
  await first;
  await turns();
  assert.equal(state.runs, 2);
  assert.equal(state.peak, 1);
  const again = flight.request();                      // idle again: a request runs at once
  await turns();
  assert.equal(state.runs, 3);
  state.finish();
  await again;
});

test('singleFlight: ifIdle runs only when nothing is running, and queues nothing behind a run that is going', async () => {
  const {job, state} = gated(), flight = singleFlight(job);
  const first = flight.ifIdle();
  await turns();
  assert.equal(state.runs, 1);
  await flight.ifIdle();                               // skipped
  state.finish();
  await first;
  await turns();
  assert.equal(state.runs, 1);                         // and nothing waited behind it
  const second = flight.ifIdle();
  await turns();
  assert.equal(state.runs, 2);
  state.finish();
  await second;
});

test('singleFlight: a job that throws is logged, does not reject, and does not wedge the flight', async () => {
  let runs = 0;
  const flight = singleFlight(async () => { runs++; throw Error('boom'); });
  const lines = await quietly(async () => { await flight.request(); await flight.request(); });
  assert.equal(runs, 2);
  assert.deepEqual(lines, ['后台任务出错：boom', '后台任务出错：boom']);
});

test('withHints: wake and outbound in the answer to /events start the right thing, and an older server\'s answer starts nothing', async () => {
  const started = [], hints = {onWake: () => started.push('wake'), onOutbound: () => started.push('outbound')};
  const answers = [
    [{accepted: true, queued: true, wake: true}, ['wake']],
    [{accepted: true, bound: true, outbound: true}, ['outbound']],
    [{accepted: true, enabled: true, outbound: true}, ['outbound']],
    [{accepted: true, queued: true, wake: true, outbound: true}, ['wake', 'outbound']],
    [{accepted: true, queued: true}, []],              // what servers that do not know the fields answer
    [{accepted: true, ignored: true}, []],
    [{wake: 'yes', outbound: 1}, []],                  // only the boolean true counts
    [null, []],
  ];
  for (const [answer, expected] of answers) {
    started.length = 0;
    const result = await withHints(async () => answer, hints)('events', {id: 'm'});
    assert.deepEqual(result, answer, 'the answer itself is passed on untouched');
    assert.deepEqual(started, expected, JSON.stringify(answer));
  }
  started.length = 0;
  await withHints(async () => ({jobs: [], wake: true, outbound: true}), hints)('claim', {});      // only the answer to /events is read
  await withHints(async () => ({ok: true, wake: true}), hints)('receipt', {});
  assert.deepEqual(started, []);
  // arguments go through; an error goes through and starts nothing
  const seen = [];
  await withHints(async (...args) => { seen.push(args); return {}; }, hints)('events', {id: 'm'}, {timeoutMs: 5});
  assert.deepEqual(seen, [['events', {id: 'm'}, {timeoutMs: 5}]]);
  await assert.rejects(withHints(async () => { throw Error('down'); }, hints)('events', {}), /down/);
  assert.deepEqual(started, []);
});

// A bridge with fake Weave and fake delivery. Ticks and deliveries are held until the test lets them go, and `peak` counts how many were going at once.
function rig({withTick = true} = {}) {
  const log = [], gates = {tick: [], deliver: []}, peak = {tick: 0, deliver: 0}, live = {tick: 0, deliver: 0};
  const answer = {events: {accepted: true, queued: true}};
  const hold = async name => { log.push(name); live[name]++; peak[name] = Math.max(peak[name], live[name]); await new Promise(resolve => gates[name].push(resolve)); live[name]--; };
  let stopping = false;
  const weave = async (path, data, options) => {
    if (path === 'tick') { await hold('tick'); return {processed: 1}; }
    log.push(path);
    return answer[path] ?? {};
  };
  const fast = createFastPath({weave, deliver: () => hold('deliver'), withTick, isStopping: () => stopping});
  return {...fast, log, answer, peak, live, weave,
    ticksStarted: () => log.filter(x => x === 'tick').length,
    deliveriesStarted: () => log.filter(x => x === 'deliver').length,
    finish: name => gates[name].shift()(),
    stop: () => { stopping = true; }};
}

test('a wake hint runs a tick at once with the long timeout, and the tick returning runs a delivery pass at once', async () => {
  const r = rig();
  r.answer.events = {accepted: true, queued: true, wake: true};
  await r.hinted('events', {id: 'm1'});
  await turns();
  assert.deepEqual(r.log, ['events', 'tick']);        // the tick started the moment the answer arrived
  assert.equal(r.deliveriesStarted(), 0);
  r.finish('tick');
  await turns();
  assert.deepEqual(r.log, ['events', 'tick', 'deliver']);   // and the reply it queued goes out at once
  r.finish('deliver');
  await turns();
});

test('the tick is called with the 170 s timeout, and a delivery pass follows it even when the tick failed', async () => {
  const calls = [];
  const ticks = createTick({weave: async (path, data, options) => { calls.push([path, data, options]); throw Error('timed out'); }, afterTick: () => calls.push('after')});
  const lines = await quietly(() => ticks.request());
  assert.deepEqual(calls, [['tick', {}, {timeoutMs: 170000}], 'after']);
  assert.deepEqual(lines, ['定时任务暂时跑不了：timed out']);
});

test('a burst of wakes is at most one tick running and one waiting, and deliveries never overlap', async () => {
  const r = rig();
  r.answer.events = {accepted: true, queued: true, wake: true};
  for (let i = 0; i < 8; i++) await r.hinted('events', {id: 'm' + i});
  await turns();
  assert.equal(r.ticksStarted(), 1);                   // seven wakes arrived while it ran; they count as one more
  r.finish('tick');
  await turns();
  assert.equal(r.ticksStarted(), 2);                   // exactly one more tick, not seven
  r.finish('tick');
  await turns();
  assert.equal(r.ticksStarted(), 2);
  assert.equal(r.peak.tick, 1);
  // Each tick that returned asked for a delivery pass: one is going, the other waits behind it.
  assert.equal(r.deliveriesStarted(), 1);
  r.finish('deliver');
  await turns();
  assert.equal(r.deliveriesStarted(), 2);
  r.finish('deliver');
  await turns();
  assert.equal(r.deliveriesStarted(), 2);
  assert.equal(r.peak.deliver, 1);
});

test('an outbound hint runs a delivery pass at once and no tick', async () => {
  const r = rig();
  r.answer.events = {accepted: true, bound: true, outbound: true};
  await r.hinted('events', {id: 'm1'});
  await turns();
  assert.deepEqual(r.log, ['events', 'deliver']);
  r.finish('deliver');
  await turns();
  assert.equal(r.ticksStarted(), 0);
});

test('outbound hints that arrive while a delivery pass is going make exactly one more pass', async () => {
  const r = rig();
  r.answer.events = {accepted: true, enabled: true, outbound: true};
  for (let i = 0; i < 5; i++) await r.hinted('events', {id: 'm' + i});
  await turns();
  assert.equal(r.deliveriesStarted(), 1);
  r.finish('deliver');
  await turns();
  assert.equal(r.deliveriesStarted(), 2);
  r.finish('deliver');
  await turns();
  assert.equal(r.deliveriesStarted(), 2);
  assert.equal(r.peak.deliver, 1);
});

test('answers without the new fields (an older server) start nothing: behaviour is unchanged', async () => {
  const r = rig();
  for (const answer of [{accepted: true, queued: true}, {accepted: true, bound: true}, {accepted: true, ignored: true}, {accepted: true, duplicate: true}]) {
    r.answer.events = answer;
    await r.hinted('events', {id: 'm'});
  }
  await turns();
  assert.deepEqual(r.log, ['events', 'events', 'events', 'events']);
});

test('without WEAVE_TICK the bridge never ticks, but an outbound hint still delivers', async () => {
  const r = rig({withTick: false});
  assert.equal(r.ticking, null);
  r.answer.events = {accepted: true, queued: true, wake: true};
  await r.hinted('events', {id: 'm1'});
  await turns();
  assert.deepEqual(r.log, ['events']);
  r.answer.events = {accepted: true, bound: true, outbound: true};
  await r.hinted('events', {id: 'm2'});
  await turns();
  assert.deepEqual(r.log, ['events', 'events', 'deliver']);
  r.finish('deliver');
  await turns();
});

test('once the bridge is stopping, hints start nothing', async () => {
  const r = rig();
  r.stop();
  r.answer.events = {accepted: true, queued: true, wake: true, outbound: true};
  await r.hinted('events', {id: 'm1'});
  await turns();
  assert.deepEqual(r.log, ['events']);
});

test('the fallbacks stay: the 60 s tick loop and the 20 s delivery loop run when idle, and add nothing behind a run that is going', async () => {
  const r = rig();
  // idle: every turn of the loop runs one, after waiting the right time
  const waits = [];
  let turnsLeft = 2;
  const tickRun = tickLoop({ticking: r.ticking, isStopping: () => turnsLeft <= 0, wait: async ms => { waits.push(['tick', ms]); turnsLeft--; }});
  await turns();
  r.finish('tick');
  await turns();
  r.finish('tick');
  await tickRun;
  assert.equal(r.ticksStarted(), 2);
  assert.deepEqual(waits, [['tick', 60000], ['tick', 60000]]);
  // a tick going because of a wake: the loop's turn neither starts a second one nor queues one
  r.answer.events = {accepted: true, queued: true, wake: true};
  await r.hinted('events', {id: 'm1'});
  await turns();
  assert.equal(r.ticksStarted(), 3);
  turnsLeft = 1;
  await tickLoop({ticking: r.ticking, isStopping: () => turnsLeft <= 0, wait: async () => { turnsLeft--; }});
  r.finish('tick');
  await turns();
  assert.equal(r.ticksStarted(), 3);
  // the delivery loop is the same, every 20 s. First let go of the delivery passes the ticks above asked for.
  for (let i = 0; i < 10 && r.live.deliver > 0; i++) { r.finish('deliver'); await turns(); }
  let before = r.deliveriesStarted(), waits20 = [], left = 1;
  const idleRun = deliveryLoop({delivery: r.delivery, isStopping: () => left <= 0, wait: async ms => { waits20.push(ms); left--; }});
  await turns();
  assert.equal(r.deliveriesStarted(), before + 1);     // idle: the loop's turn runs one
  r.finish('deliver');
  await idleRun;
  assert.deepEqual(waits20, [20000]);
  // a pass going because of an outbound hint: the loop's turn neither starts another nor queues one
  r.answer.events = {accepted: true, bound: true, outbound: true};
  await r.hinted('events', {id: 'm2'});
  await turns();
  before = r.deliveriesStarted();
  left = 1;
  await deliveryLoop({delivery: r.delivery, isStopping: () => left <= 0, wait: async () => { left--; }});
  r.finish('deliver');
  await turns();
  assert.equal(r.deliveriesStarted(), before);
});

test('with handleEvent: a committed message that Weave marks as wake starts a tick at once, the cursor still advances, and an older server\'s answer starts nothing', async () => {
  const incoming = {id: 'msg_1', threadId: 'wxid-alice', senderId: 'wxid-alice', type: 1, direction: 'incoming', body: '你好', createdAt: '2030-01-01T00:00:00+00:00', mentions: {self: false}};
  for (const [answer, ticks] of [[{accepted: true, queued: true, wake: true}, 1], [{accepted: true, queued: true}, 0]]) {
    const r = rig(), saved = [], acked = [];
    r.answer.events = answer;
    const daemon = {message: async () => incoming, ack: async cursor => acked.push(cursor)};
    await handleEvent({cursor: '7', kind: 'message.committed', data: {messageId: 'msg_1', direction: 'incoming'}}, {daemon, weave: r.hinted, saveCursor: async cursor => saved.push(cursor)});
    await turns();
    assert.equal(r.ticksStarted(), ticks);
    assert.deepEqual(saved, ['7']);
    assert.deepEqual(acked, ['7']);
    if (ticks) { r.finish('tick'); await turns(); r.finish('deliver'); await turns(); }
  }
});
