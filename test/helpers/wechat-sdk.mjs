// Harness for WeChat messages that wake the Agent service (WEAVE_AGENT_RUNTIME=sdk).
// Everything is fake: the D1 is in memory, the Agent service is a function that sees each
// request the Weave side sends it, and no model is ever called.
import {D1} from './product-db.mjs';
import {Store} from '../../hosted/lib/weave/store.mjs';
import {handleAPI} from '../../hosted/lib/weave/api.mjs';
import {ensurePerson} from '../../hosted/lib/weave/domain.mjs';
import {hash} from '../../hosted/lib/weave/crypto.mjs';

export const secret = 'ab'.repeat(32);
export const bridgeToken = 'bridge-token-' + 'x'.repeat(32);
export const SERVICE = 'https://agent.test';
export const SERVICE_TOKEN = 's'.repeat(40);
export const ROOM = '123456@chatroom';
export const start = Date.parse('2030-01-01T00:00:00Z');
export const ok = data => Response.json(data);
export const reply = text => ok({outcome: 'success', reply: text, sessionId: 's-1', tools: []});

export async function setup({runtime = 'sdk', agent = async () => reply('收到')} = {}) {
  const db = new D1(), store = new Store(db), world = await store.load(), id = 'u:' + await hash('alice');
  ensurePerson(world, {userId: id, displayName: 'Alice'});
  await store.save(world);
  let now = start, seq = 0;
  const state = {agent}, calls = [];
  // The only network the Weave side may touch is the Agent service.
  const fetcher = async (url, options) => {
    if (!String(url).startsWith(SERVICE)) throw Error('unexpected fetch ' + url);
    const call = {path: new URL(url).pathname, body: JSON.parse(options.body), auth: options.headers.Authorization};
    calls.push(call);
    return state.agent(call);
  };
  const options = () => ({db, secret, wechat: {token: bridgeToken}, agentServiceUrl: SERVICE, agentServiceToken: SERVICE_TOKEN, agentRuntime: runtime, fetcher, now});
  const call = async (identity, path, data, headers = {}) => {
    const r = await handleAPI(new Request('https://weave.example/api/' + path, {method: data === undefined ? 'GET' : 'POST', headers: data ? {Origin: 'https://weave.example', 'Content-Type': 'application/json', ...headers} : headers, body: data ? JSON.stringify(data) : undefined}), {...options(), identity: identity ? {userId: identity, displayName: identity, email: identity + '@example.test'} : null});
    return {status: r.status, data: await r.json()};
  };
  const bridge = (path, data) => call(null, 'internal/wechat/' + path, data, {Authorization: 'Bearer ' + bridgeToken});
  // What the Agent service's MCP shells do: call the tool backend with the capability from /wake.
  const tool = async (name, args, capability, toolUseId = 'toolu_1') => {
    const r = await handleAPI(new Request('https://weave.example/api/internal/agent/tools/' + name, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + capability}, body: JSON.stringify({args, toolUseId})}), {db, secret, now});
    return {status: r.status, data: await r.json()};
  };
  const message = (body, over = {}) => ({id: 'msg_' + (++seq), threadId: 'wxid-alice', senderId: 'wxid-alice', type: 1, direction: 'incoming', body, createdAt: new Date(now).toISOString(), mentions: {state: 'known', userIds: [], self: false, all: false, source: null}, ...over});
  const group = (sender, body, mentioned = false, over = {}) => message(body, {threadId: ROOM, senderId: sender, mentions: {state: 'known', userIds: mentioned ? ['wxid-bot'] : [], self: mentioned, all: false, source: 'msgsource.atuserlist'}, ...over});
  const bind = async () => bridge('events', message((await call('alice', 'wechat/bind', {})).data.instruction));
  const enableGroup = async () => { await bind(); await bridge('events', group('wxid-alice', '@助理 开启打卡群', true)); await bridge('claim', {}); };
  return {
    db, id, call, bridge, tool, message, group, bind, enableGroup, calls, options,
    tick: () => bridge('tick', {}),
    wakes: () => calls.filter(c => c.path === '/wake'),
    read: () => new Store(db).load(),
    agent: fn => { state.agent = fn; },
    setNow(value) { now = value; },
    get now() { return now; },
  };
}

// Waits until a condition holds; used when a wake is deliberately left running.
// It waits on the clock, never on a number of event-loop turns: a tick goes through WebCrypto (hash, HMAC), which
// finishes on another thread, and on a slow CI runner 200 setImmediate turns were used up in about 6 ms before the
// first result came back ("timed out waiting for the first wake"). The limit is only there so that a real bug fails
// the test instead of hanging it.
export async function until(condition, label = 'condition', timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= end) throw Error('timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
