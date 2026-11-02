import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {issueCapability} from '../hosted/lib/weave/capability.mjs';
import {agentServiceConfig, localISO, REPLIES} from '../hosted/lib/weave/dispatcher.mjs';

const secret = 'ab'.repeat(32), SERVICE = 'https://agent.test', TOKEN = 't'.repeat(40);
const identity = name => ({userId: name, displayName: name, email: name + '@example.test'});

function harness(agent, {runtime = 'sdk', serviceUrl = SERVICE} = {}) {
  const db = new D1(), calls = [];
  const fetcher = async (url, options) => {
    if (!url.startsWith(serviceUrl)) throw Error('unexpected fetch ' + url);
    const call = {path: new URL(url).pathname, body: JSON.parse(options.body), auth: options.headers.Authorization};
    calls.push(call);
    return agent(call);
  };
  async function api(name, path, data, {now} = {}) {
    const request = new Request('https://weave.test/api/' + path, data === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://weave.test'}, body: JSON.stringify(data)});
    const r = await handleAPI(request, {db, identity: identity(name), secret, fetcher, agentServiceUrl: serviceUrl, agentServiceToken: TOKEN, agentRuntime: runtime, now});
    return {status: r.status, data: await r.json()};
  }
  // What the Agent service's MCP shells do: call the tool backend with the capability from /wake.
  async function tool(name, args, capability, toolUseId) {
    const r = await handleAPI(new Request('https://weave.test/api/internal/agent/tools/' + name, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + capability}, body: JSON.stringify({args, toolUseId})}), {db, secret});
    return r.json();
  }
  return {db, api, tool, calls, world: () => new Store(db).load()};
}
const wakes = h => h.calls.filter(c => c.path === '/wake');
const ok = data => Response.json(data);

test('开关关着时 /api/chat 走旧路，一次 /wake 都不请求', async () => {
  const h = harness(async call => call.path === '/query' ? ok({output: '旧路的回复'}) : ok({}), {runtime: null});
  const r = await h.api('Alice', 'chat', {text: '你好'});
  assert.deepEqual(r, {status: 200, data: {reply: '旧路的回复'}});
  assert.equal(wakes(h).length, 0);
  assert.deepEqual(h.calls.map(c => c.path), ['/query']);
});

test('开关打开：先存用户消息，再叫醒，回来重读再存回复；Agent 中途记的完成记录不被覆盖，也不报 409', async () => {
  let sawUserMessage = false;
  const h = harness(async call => {
    const person = Object.values((await h.world()).people)[0];
    sawUserMessage = person.messages.at(-1)?.text === '今天走了 20 分钟' && person.messages.at(-1)?.role === 'user';
    const saved = await h.tool('save_habit', {name: '走路'}, call.body.capability, 'toolu_1');
    const habitId = JSON.parse(saved.text).habit.habit_id;
    const logged = await h.tool('log_completion', {habit_id: habitId, date: call.body.localDate}, call.body.capability, 'toolu_2');
    assert.equal(logged.ok, true, JSON.stringify(logged));
    return ok({outcome: 'success', reply: '记好了', sessionId: 's-1', tools: ['mcp__weave__save_habit', 'mcp__weave__log_completion']});
  });
  await h.api('Alice', 'status');
  const r = await h.api('Alice', 'chat', {text: '今天走了 20 分钟'});
  assert.deepEqual(r, {status: 200, data: {reply: '记好了'}});
  assert.ok(sawUserMessage, 'the user message should be saved before the wake');
  const person = Object.values((await h.world()).people)[0];
  assert.deepEqual(person.messages.slice(-2).map(m => [m.role, m.text]), [['user', '今天走了 20 分钟'], ['assistant', '记好了']]);
  assert.equal(person.messages.at(-1).source, 'agent');
  assert.equal(person.messages.at(-1).outcome, 'success');
  assert.equal(person.habits.length, 1);
  assert.equal(person.completions.length, 1);
  assert.equal(wakes(h).length, 1);
});

test('/wake 返回 500、连不上、或这一轮没成功：回复「结果不确定」并标 uncertain，/wake 只请求一次', async () => {
  for (const agent of [
    async () => new Response('boom', {status: 500}),
    async () => { throw Error('connect ECONNREFUSED'); },
    async () => ok({outcome: 'error_max_turns', reply: '', sessionId: 's', tools: []}),
    async () => ok({outcome: 'success', reply: '   ', sessionId: 's', tools: []}),
  ]) {
    const h = harness(agent);
    const r = await h.api('Alice', 'chat', {text: '今天走了 20 分钟'});
    assert.deepEqual(r, {status: 200, data: {reply: REPLIES.uncertain}});
    const last = Object.values((await h.world()).people)[0].messages.at(-1);
    assert.equal(last.uncertain, true);
    assert.equal(wakes(h).length, 1);
  }
});

test('/wake 429 回复排队的那句；503 或 400 回复暂时不可用；都不标 uncertain', async () => {
  for (const [status, reply] of [[429, REPLIES.busy], [503, REPLIES.unavailable], [400, REPLIES.unavailable]]) {
    const h = harness(async () => Response.json({error: 'x'}, {status}));
    const r = await h.api('Alice', 'chat', {text: '在吗'});
    assert.deepEqual(r.data, {reply}, String(status));
    assert.equal(Object.values((await h.world()).people)[0].messages.at(-1).uncertain, undefined);
  }
});

test('叫醒时带本人当地日期和带时区的 at；本人存了自己的 Key 就作为 userKey 传过去', async () => {
  const h = harness(async () => ok({outcome: 'success', reply: '好', sessionId: 's', tools: []}));
  await h.api('Alice', 'status');
  assert.equal((await h.api('Alice', 'settings', {apiKey: 'sk-own-key-123456', model: 'deepseek-v4-pro'})).status, 200);
  const store = new Store(h.db), w = await store.load(), person = Object.values(w.people)[0];
  person.profile.timezone = 'America/Los_Angeles';
  await store.save(w);
  await h.api('Alice', 'chat', {text: '今天走了 20 分钟'}, {now: Date.parse('2026-11-02T07:30:00Z')});
  const call = wakes(h)[0];
  assert.equal(call.auth, 'Bearer ' + TOKEN);
  const {capability, ...body} = call.body;
  assert.match(capability, /^wcap1\./);
  assert.deepEqual(body, {
    scope: 'owner', id: person.id, localDate: '2026-11-01', provider: 'deepseek', model: 'deepseek-v4-pro', userKey: 'sk-own-key-123456',
    trigger: {kind: 'message', channel: 'web', direct: true, at: '2026-11-01T23:30:00-08:00', text: '今天走了 20 分钟'},
  });
});

test('没有自己的 Key 时不带 userKey，用托管额度', async () => {
  const h = harness(async () => ok({outcome: 'success', reply: '好', sessionId: 's', tools: []}));
  await h.api('Alice', 'chat', {text: '在吗'});
  assert.equal('userKey' in wakes(h)[0].body, false);
  assert.equal(wakes(h)[0].body.model, 'deepseek-flash');
});

test('新路配置不对（外网 http 地址）时 503，不把通行证和 Key 发出去', async () => {
  const h = harness(async () => ok({}), {serviceUrl: 'http://agent.example.com'});
  const r = await h.api('Alice', 'chat', {text: '在吗'});
  assert.equal(r.status, 503);
  assert.equal(h.calls.length, 0);
});

test('agentServiceConfig：https 和本机 http 可以；外网 http、令牌太短不行', () => {
  assert.deepEqual(agentServiceConfig('https://agent.example.com/', TOKEN), {url: 'https://agent.example.com', token: TOKEN});
  assert.deepEqual(agentServiceConfig('http://127.0.0.1:4320', TOKEN), {url: 'http://127.0.0.1:4320', token: TOKEN});
  assert.ok(agentServiceConfig('http://localhost:4320', TOKEN));
  assert.equal(agentServiceConfig('http://agent.example.com', TOKEN), null);
  assert.equal(agentServiceConfig('https://agent.example.com', 'short'), null);
  assert.equal(agentServiceConfig(undefined, TOKEN), null);
  assert.equal(agentServiceConfig('not a url', TOKEN), null);
});

test('localISO 写出带偏移的当地时间', () => {
  const t = Date.parse('2026-11-02T07:30:00Z');
  assert.equal(localISO('Asia/Shanghai', t), '2026-11-02T15:30:00+08:00');
  assert.equal(localISO('America/Los_Angeles', t), '2026-11-01T23:30:00-08:00');
  assert.equal(localISO('UTC', t), '2026-11-02T07:30:00+00:00');
  assert.equal(localISO('Asia/Kolkata', t), '2026-11-02T13:00:00+05:30');
});

test('注销：先请求 /forget，成功才删账号；/forget 失败返回 503，账号还在', async () => {
  let forgetStatus = 500;
  const h = harness(async call => call.path === '/forget' ? Response.json({ok: forgetStatus === 200}, {status: forgetStatus}) : ok({}));
  const id = (await h.api('Alice', 'status')).data.personId;
  const failed = await h.api('Alice', 'account/delete', {confirm: true});
  assert.equal(failed.status, 503);
  assert.ok((await h.world()).people[id]);
  forgetStatus = 200;
  const done = await h.api('Alice', 'account/delete', {confirm: true});
  assert.equal(done.status, 200);
  assert.equal((await h.world()).people[id], undefined);
  assert.deepEqual(h.calls.filter(c => c.path === '/forget').map(c => c.body), [{scope: 'owner', id}, {scope: 'owner', id}]);
});

test('导出里有 habits 和 completions', async () => {
  const h = harness(async () => ok({}));
  const id = (await h.api('Alice', 'status')).data.personId;
  const capability = await issueCapability(secret, {owner: id, scope: 'owner', runId: 'r', channel: 'web', direct: true}, Date.now());
  const habitId = JSON.parse((await h.tool('save_habit', {name: '走路'}, capability, 'toolu_1')).text).habit.habit_id;
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
  await h.tool('log_completion', {habit_id: habitId, date}, capability, 'toolu_2');
  const exported = (await h.api('Alice', 'export')).data;
  assert.equal(exported.habits.length, 1);
  assert.equal(exported.habits[0].name, '走路');
  assert.equal(exported.completions.length, 1);
  assert.equal(exported.completions[0].date, date);
});
