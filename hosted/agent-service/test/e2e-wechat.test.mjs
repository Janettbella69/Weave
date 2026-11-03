// WeChat end to end with no key and no cost: a WeChat message goes through Weave's tick (in-process, D1 test
// database), which wakes the real Agent service over HTTP; the real CLI runs against the fake model through the
// real model proxy; the weave MCP tools call back into the Weave tool backend over HTTP; the reply is queued for the
// bridge. A private chat wakes owner scope, an @ in a check-in group wakes group scope.
// Lives in the agent-service suite because it needs the SDK installed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync, mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D1} from '../../../test/helpers/product-db.mjs';
import {Store} from '../../lib/weave/store.mjs';
import {hash} from '../../lib/weave/crypto.mjs';
import {handleAPI} from '../../lib/weave/api.mjs';
import {ensurePerson} from '../../lib/weave/domain.mjs';
import {createAgentService} from '../server.mjs';
import {scopeDirs} from '../workspace.mjs';
import {isMain, steps, startFakeModel} from './helpers/fake-model.mjs';

const secret = 'ab'.repeat(32), TOKEN = 'e'.repeat(40), BRIDGE = 'bridge-token-' + 'x'.repeat(32), ROOM = '123456@chatroom';

async function start() {
  const fake = await startFakeModel(), db = new D1(), store = new Store(db), world = await store.load();
  const alice = 'u:' + await hash('alice');
  ensurePerson(world, {userId: alice, displayName: 'Alice'});
  await store.save(world);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1${req.url}`, {method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks)});
    const response = await handleAPI(request, {db, identity: null, secret});
    res.writeHead(response.status, {'Content-Type': response.headers.get('content-type') || 'application/json'});
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-e2e-wechat-')));
  const agent = await createAgentService({
    token: TOKEN, dataDir, isolation: 'local', sandbox: false, weaveUrl: `http://127.0.0.1:${server.address().port}`,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
  const options = () => ({db, secret, wechat: {token: BRIDGE}, agentServiceUrl: agent.url, agentServiceToken: TOKEN, agentRuntime: 'sdk'});
  const web = async (path, data) => (await handleAPI(new Request('https://weave.test/api/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://weave.test'}, body: JSON.stringify(data)}), {...options(), identity: {userId: 'alice', displayName: 'Alice', email: 'alice@example.test'}})).json();
  const bridge = async (path, data) => (await handleAPI(new Request('https://weave.test/api/internal/wechat/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE}, body: JSON.stringify(data)}), options())).json();
  let seq = 0;
  const message = (body, over = {}) => ({id: 'msg_' + (++seq), threadId: 'wxid-alice', senderId: 'wxid-alice', type: 1, direction: 'incoming', body, createdAt: new Date().toISOString(), mentions: {self: false}, ...over});
  const group = (sender, body, mentioned = false) => message(body, {threadId: ROOM, senderId: sender, mentions: {self: mentioned}});
  return {
    fake, db, alice, dataDir, agent, bridge, message, group,
    tick: () => bridge('tick', {}),
    bind: async () => bridge('events', message((await web('wechat/bind', {})).instruction)),
    mainRequests: () => fake.captured.filter(c => isMain(c.body)),
    world: () => new Store(db).load(),
    async close() { await agent.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fake.close(); },
  };
}

test('WeChat private chat end to end: the Agent runs in owner scope on the wechat channel, its tool writes the habit, and the reply is queued for WeChat', async () => {
  const h = await start();
  try {
    h.fake.script(steps([{tool: 'mcp__weave__save_habit', input: {name: '走路', minimum_action: '走到楼下'}}, {text: '记好了，今天走了 20 分钟。'}]));
    await h.bind();
    await h.bridge('claim', {});
    assert.equal((await h.bridge('events', h.message('今天走了 20 分钟'))).queued, true);
    assert.equal((await h.tick()).processed, 1);
    const [request] = h.mainRequests();
    assert.match(JSON.stringify(request.body.messages), /channel=\\"wechat\\" direct=\\"true\\"/);
    assert.ok(request.body.tools.some(t => t.name === 'mcp__weave__save_habit'));
    const jobs = (await h.bridge('claim', {})).jobs;
    assert.deepEqual(jobs.map(j => [j.threadId, j.text]), [['wxid-alice', '记好了，今天走了 20 分钟。']]);
    const person = (await h.world()).people[h.alice];
    assert.equal(person.habits.length, 1);
    assert.equal(person.habits[0].name, '走路');
    assert.deepEqual(person.messages.slice(-2).map(m => [m.role, m.text]), [['user', '今天走了 20 分钟'], ['assistant', '记好了，今天走了 20 分钟。']]);
    assert.ok(existsSync(scopeDirs(h.dataDir, 'owner', h.alice).root));
  } finally { await h.close(); }
});

test('WeChat group end to end: group scope sees only the group, personal tools do not exist, nothing personal reaches the model, and the reply goes to the group', async () => {
  const h = await start();
  try {
    const store = new Store(h.db), world = await store.load();
    world.people[h.alice].profile.goal = 'PRIVATE_GOAL_减到50公斤';
    world.people[h.alice].checkins.push({id: 'c1', text: 'PRIVATE_FEEDBACK', createdAt: new Date().toISOString()});
    await store.save(world);
    h.fake.script(steps([{tool: 'mcp__weave__save_habit', input: {name: 'PRIVATE_HABIT'}}, {text: '你们这周都在坚持'}]));
    await h.bind();
    await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true));
    await h.bridge('claim', {});
    await h.bridge('events', h.group('wxid-bob', '今天走了八千步'));
    assert.equal((await h.bridge('events', h.group('wxid-bob', '@助理 我们这周怎么样', true))).queued, true);
    assert.equal((await h.tick()).processed, 1);
    const requests = h.mainRequests(), names = requests[0].body.tools.map(t => t.name);
    assert.deepEqual(names.filter(n => n.startsWith('mcp__')), ['mcp__weave__send_message']);
    assert.ok(!names.includes('WebSearch') && !names.includes('WebFetch') && !names.includes('Agent'));
    const everything = JSON.stringify(requests.map(r => r.body));
    assert.match(everything, /channel=\\"group\\" direct=\\"true\\"/);
    assert.ok(everything.includes('成员1：我们这周怎么样'));
    for (const leak of ['PRIVATE_GOAL', 'PRIVATE_FEEDBACK', 'wxid-bob', 'wxid-alice', ROOM, 'Alice']) assert.ok(!everything.includes(leak), leak);
    // The model tried a personal tool anyway: it does not exist in this scope, so nothing was written.
    assert.ok(everything.includes('No such tool available: mcp__weave__save_habit'));
    assert.equal((await h.world()).people[h.alice].habits, undefined);
    const jobs = (await h.bridge('claim', {})).jobs.filter(j => j.threadId === ROOM);
    assert.deepEqual(jobs.map(j => [j.text, j.mentions]), [['你们这周都在坚持', {userIds: ['wxid-bob']}]]);
    const groupId = await hash(ROOM);
    assert.ok(existsSync(scopeDirs(h.dataDir, 'group', groupId).root));
    assert.ok(!existsSync(scopeDirs(h.dataDir, 'owner', h.alice).root), 'a group wake must not create or use the owner\'s workspace');
  } finally { await h.close(); }
});

test('closing a group deletes its workspace in the Agent service on the next tick', async () => {
  const h = await start();
  try {
    h.fake.script(steps([{text: '好'}]));
    await h.bind();
    await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true));
    await h.bridge('events', h.group('wxid-bob', '@助理 在吗', true));
    await h.tick();
    const root = scopeDirs(h.dataDir, 'group', await hash(ROOM)).root;
    assert.ok(existsSync(root));
    assert.equal((await h.bridge('events', h.group('wxid-bob', '@助理 关闭打卡群', true))).closed, true);
    await h.tick();
    assert.ok(!existsSync(root));
    assert.equal(Object.keys((await h.world()).runtime).filter(k => k.startsWith('wechat-forget:')).length, 0);
  } finally { await h.close(); }
});
