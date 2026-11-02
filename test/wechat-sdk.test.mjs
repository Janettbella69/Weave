// WeChat private messages on the Agent SDK path (WEAVE_AGENT_RUNTIME=sdk), and the dispatcher
// functions the WeChat and proactive code share. Fake Agent service, fake D1, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../hosted/lib/weave/store.mjs';
import {verifyCapability} from '../hosted/lib/weave/capability.mjs';
import {REPLIES, wake, forgetAgentWorkspace, TICK_BUDGET_MS, START_BY_MS} from '../hosted/lib/weave/dispatcher.mjs';
import {processInboundSdk} from '../hosted/lib/weave/wechat.mjs';
import {setup, reply, ok, until, secret, SERVICE, SERVICE_TOKEN} from './helpers/wechat-sdk.mjs';

const service = {url: SERVICE, token: SERVICE_TOKEN};
async function inLosAngeles(h) {
  const store = new Store(h.db), world = await store.load();
  world.people[h.id].profile.timezone = 'America/Los_Angeles';
  await store.save(world);
}
const inbound = world => Object.values(world.wechat).filter(x => x.direction === 'inbound');
const outbound = world => Object.values(world.wechat).filter(x => x.direction === 'outbound');

test('a bound person\'s WeChat message wakes the Agent in owner scope on the wechat channel, and the reply goes back to WeChat', async () => {
  const h = await setup({agent: async () => reply('你好呀')});
  await inLosAngeles(h);
  await h.bind();
  await h.bridge('claim', {});
  assert.equal((await h.bridge('events', h.message('你好'))).data.queued, true);
  const ticked = await h.tick();
  assert.equal(ticked.status, 200);
  assert.equal(ticked.data.processed, 1);
  // The only thing the Weave side asked of the network is one wake.
  assert.deepEqual(h.calls.map(c => c.path), ['/wake']);
  const [call] = h.wakes();
  assert.equal(call.auth, 'Bearer ' + SERVICE_TOKEN);
  const {capability, ...body} = call.body;
  assert.deepEqual(body, {
    scope: 'owner', id: h.id, localDate: '2029-12-31', provider: 'deepseek', model: 'deepseek-flash',
    trigger: {kind: 'message', channel: 'wechat', direct: true, at: '2029-12-31T16:00:00-08:00', text: '你好'},
  });
  const claims = await verifyCapability(secret, capability, h.now);
  assert.deepEqual({...claims, runId: undefined}, {owner: h.id, scope: 'owner', runId: undefined, channel: 'wechat', direct: true, exp: h.now + 15 * 60_000});
  assert.equal('group' in claims, false);
  const world = await h.read();
  assert.deepEqual(world.people[h.id].messages.slice(-2).map(m => [m.role, m.text]), [['user', '你好'], ['assistant', '你好呀']]);
  assert.equal(world.people[h.id].messages.at(-1).source, 'agent');
  assert.equal(inbound(world).find(x => x.text === '你好').status, 'replied');
  const jobs = (await h.bridge('claim', {})).data.jobs;
  assert.deepEqual(jobs.map(j => [j.threadId, j.text]), [['wxid-alice', '你好呀']]);
});

test('with the switch off, WeChat keeps the old path: the legacy /query, never a /wake', async () => {
  // null, not undefined: setup() would fill in the default 'sdk' for undefined.
  const h = await setup({runtime: null, agent: async () => ok({output: '旧路的回复'})});
  await h.bind();
  await h.bridge('claim', {});
  await h.bridge('events', h.message('你好'));
  await h.tick();
  assert.deepEqual(h.calls.map(c => c.path), ['/query']);
  assert.deepEqual((await h.bridge('claim', {})).data.jobs.map(j => j.text), ['旧路的回复']);
});

test('busy, unavailable and uncertain answers reach WeChat with the same words as the web, and a run is never retried', async () => {
  const cases = [
    ['429', async () => Response.json({error: 'x'}, {status: 429}), REPLIES.busy, 'replied'],
    ['503', async () => Response.json({error: 'x'}, {status: 503}), REPLIES.unavailable, 'replied'],
    ['500', async () => new Response('boom', {status: 500}), REPLIES.uncertain, 'uncertain'],
    ['disconnect', async () => { throw Error('ECONNREFUSED'); }, REPLIES.uncertain, 'uncertain'],
    ['max turns', async () => ok({outcome: 'error_max_turns', reply: '', sessionId: 's', tools: []}), REPLIES.uncertain, 'uncertain'],
    ['blank reply', async () => reply('   '), REPLIES.uncertain, 'uncertain'],
  ];
  for (const [label, agent, text, status] of cases) {
    const h = await setup({agent});
    await h.bind();
    await h.bridge('claim', {});
    await h.bridge('events', h.message('在吗'));
    await h.tick();
    await h.tick();
    assert.equal(h.wakes().length, 1, label);
    assert.deepEqual((await h.bridge('claim', {})).data.jobs.map(j => j.text), [text], label);
    const world = await h.read();
    assert.equal(inbound(world).find(x => x.text === '在吗').status, status, label);
    assert.equal(world.people[h.id].messages.at(-1).uncertain, status === 'uncertain' ? true : undefined, label);
  }
});

test('the person\'s own model key and model choice travel with the wake', async () => {
  const h = await setup();
  assert.equal((await h.call('alice', 'settings', {apiKey: 'sk-own-key-123456', model: 'deepseek-v4-pro'})).status, 200);
  await h.bind();
  await h.bridge('events', h.message('你好'));
  await h.tick();
  const {capability, ...body} = h.wakes()[0].body;
  assert.equal(body.userKey, 'sk-own-key-123456');
  assert.equal(body.model, 'deepseek-v4-pro');
});

test('strangers, stale messages and group chatter wake nothing', async () => {
  const h = await setup();
  await h.bind();
  await h.bridge('claim', {});
  await h.bridge('events', h.message('我是陌生人', {threadId: 'wxid-stranger', senderId: 'wxid-stranger'}));
  await h.bridge('events', h.message('昨晚的消息', {createdAt: new Date(h.now - 7 * 3600_000).toISOString()}));
  await h.bridge('events', h.group('wxid-bob', '没有开启的群里 @', true));
  assert.equal((await h.tick()).data.processed, 0);
  assert.deepEqual(h.calls, []);
});

test('a message is claimed before the wake, so a second tick while it runs does not wake twice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await setup({agent: async () => { await gate; return reply('好'); }});
  await h.bind();
  await h.bridge('claim', {});
  await h.bridge('events', h.message('你好'));
  const first = h.tick();
  await until(() => h.wakes().length === 1, 'the first wake');
  assert.equal(inbound(await h.read()).find(x => x.text === '你好').status, 'processing');
  const second = await h.tick();
  assert.equal(second.data.processed, 0);
  assert.equal(h.wakes().length, 1);
  release();
  assert.equal((await first).data.processed, 1);
  assert.deepEqual((await h.bridge('claim', {})).data.jobs.map(j => j.text), ['好']);
});

test('a message stuck in processing for over ten minutes becomes uncertain and the person is told; it is not retried', async () => {
  const h = await setup();
  await h.bind();
  await h.bridge('claim', {});
  await h.bridge('events', h.message('卡住了'));
  const store = new Store(h.db), world = await store.load(), entry = inbound(world).find(x => x.text === '卡住了');
  entry.status = 'processing';
  entry.startedAt = new Date(h.now - 11 * 60_000).toISOString();
  await store.save(world);
  await h.tick();
  assert.deepEqual(h.calls, []);
  const after = await h.read();
  assert.equal(inbound(after).find(x => x.text === '卡住了').status, 'uncertain');
  assert.deepEqual((await h.bridge('claim', {})).data.jobs.map(j => j.text), [REPLIES.uncertain]);
});

test('a message still within its ten minutes is left alone', async () => {
  const h = await setup();
  await h.bind();
  await h.bridge('events', h.message('还在跑'));
  const store = new Store(h.db), world = await store.load(), entry = inbound(world).find(x => x.text === '还在跑');
  entry.status = 'processing';
  entry.startedAt = new Date(h.now - 5 * 60_000).toISOString();
  await store.save(world);
  await h.tick();
  assert.deepEqual(h.calls, []);
  assert.equal(inbound(await h.read()).find(x => x.text === '还在跑').status, 'processing');
});

test('no new wake starts after the start-by time; the rest stay queued for the next tick', async () => {
  const h = await setup();
  await h.bind();
  await h.bridge('claim', {});
  await h.bridge('events', h.message('第一条'));
  await h.bridge('events', h.message('第二条'));
  let time = 0;
  const clock = () => time;
  h.agent(async () => { time += START_BY_MS + 10_000; return reply('好'); });
  const run = () => processInboundSdk({db: h.db, secret, service, fetcher: h.options().fetcher, now: h.now, clock});
  assert.equal(await run(), 1);
  assert.equal(h.wakes().length, 1);
  assert.equal(inbound(await h.read()).filter(x => x.status === 'queued').length, 1);
  time = 0;
  assert.equal(await run(), 1);
  assert.equal(h.wakes().length, 2);
  assert.equal(inbound(await h.read()).filter(x => x.status === 'queued').length, 0);
});

test('the tick budget stays under what the bridge and nginx allow', () => {
  assert.ok(TICK_BUDGET_MS <= 150_000);
  assert.ok(START_BY_MS < TICK_BUDGET_MS);
});

test('wake returns outcome, reply, uncertain and retryable; only a service that did not start is retryable', async () => {
  const h = await setup();
  const run = agent => { h.agent(agent); return wake({db: h.db, secret, service, fetcher: h.options().fetcher, now: h.now, ownerId: h.id, trigger: {channel: 'web', text: '嗨'}}); };
  const success = await run(async () => reply('好'));
  assert.deepEqual({...success, runId: undefined}, {outcome: 'success', reply: '好', uncertain: false, retryable: false, runId: undefined});
  assert.match(success.runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({...await run(async () => Response.json({}, {status: 429})), runId: undefined}, {outcome: 'busy', reply: null, uncertain: false, retryable: true, runId: undefined});
  assert.deepEqual({...await run(async () => Response.json({}, {status: 503})), runId: undefined}, {outcome: 'unavailable', reply: null, uncertain: false, retryable: true, runId: undefined});
  assert.deepEqual({...await run(async () => new Response('x', {status: 500})), runId: undefined}, {outcome: 'error', reply: null, uncertain: true, retryable: false, runId: undefined});
  assert.deepEqual({...await run(async () => ok({outcome: 'error_max_turns', reply: '半截', sessionId: 's', tools: []})), runId: undefined}, {outcome: 'error_max_turns', reply: null, uncertain: true, retryable: false, runId: undefined});
});

test('wake with no reply needed: a run nobody asked directly keeps direct:false in the capability and the trigger', async () => {
  const h = await setup();
  await wake({db: h.db, secret, service, fetcher: h.options().fetcher, now: h.now, ownerId: h.id, channel: 'wechat', trigger: {kind: 'timer', channel: 'system', direct: false, text: '到点了'}});
  const {capability, ...body} = h.wakes()[0].body;
  assert.equal(body.trigger.kind, 'timer');
  assert.equal(body.trigger.channel, 'system');
  assert.equal(body.trigger.direct, false);
  const claims = await verifyCapability(secret, capability, h.now);
  assert.equal(claims.direct, false);
  assert.equal(claims.channel, 'wechat');
});

test('wake refuses an unknown scope, and a group wake without a group id', async () => {
  const h = await setup();
  const base = {db: h.db, secret, service, fetcher: h.options().fetcher, now: h.now, ownerId: h.id, trigger: {channel: 'group', text: 'x'}};
  await assert.rejects(wake({...base, scope: 'research'}));
  await assert.rejects(wake({...base, scope: 'group'}));
  await assert.rejects(wake({...base, scope: 'owner', channel: 'sms'}));
  assert.deepEqual(h.calls, []);
});

test('wake gives up when its time is up and calls the run uncertain', async () => {
  const h = await setup();
  const fetcher = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  const result = await wake({db: h.db, secret, service, fetcher, now: h.now, ownerId: h.id, trigger: {channel: 'wechat', text: '慢'}, timeoutMs: 20});
  assert.equal(result.uncertain, true);
  assert.equal(result.reply, null);
});

test('forgetAgentWorkspace works for the group scope too and fails loudly when the service does not confirm', async () => {
  const h = await setup();
  const forgets = [];
  const fetcher = status => async (url, options) => { forgets.push(JSON.parse(options.body)); return Response.json({ok: status === 200}, {status}); };
  await forgetAgentWorkspace({service, scope: 'group', id: 'g'.repeat(64), fetcher: fetcher(200)});
  await forgetAgentWorkspace({service, ownerId: h.id, fetcher: fetcher(200)});
  await assert.rejects(forgetAgentWorkspace({service, scope: 'group', id: 'g'.repeat(64), fetcher: fetcher(500)}), error => error.status === 503);
  assert.deepEqual(forgets.map(f => f.scope), ['group', 'owner', 'group']);
  assert.equal(forgets[0].id, 'g'.repeat(64));
  assert.equal(forgets[1].id, h.id);
});
