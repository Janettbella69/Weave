// 主动服务端到端，不要 Key、不花钱（docs/superpowers/specs/2026-11-03-proactive-wake-design.md）：服务器的闹钟
// （/api/internal/tick，Weave 在进程里、D1 是测试库）发现到点的跟进，经 HTTP 叫醒真的 Agent 服务；真的 CLI 对着假模型跑，
// weave 工具经 HTTP 回调 Weave 的工具后端。没人直接找它的这一轮，只有调用 send_message 才有人看得到。
// 放在 agent-service 的测试里，因为要装好 SDK。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, realpathSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D1} from '../../../test/helpers/product-db.mjs';
import {Store} from '../../lib/weave/store.mjs';
import {hash} from '../../lib/weave/crypto.mjs';
import {handleAPI} from '../../lib/weave/api.mjs';
import {ensurePerson} from '../../lib/weave/domain.mjs';
import {proactiveState} from '../../lib/weave/proactivity.mjs';
import {createAgentService} from '../server.mjs';
import {scopeDirs} from '../workspace.mjs';
import {isMain, steps, startFakeModel} from './helpers/fake-model.mjs';

const secret = 'ab'.repeat(32), TOKEN = 'e'.repeat(40);

async function start() {
  const fake = await startFakeModel(), db = new D1(), store = new Store(db), world = await store.load();
  const alice = 'u:' + await hash('alice');
  const person = ensurePerson(world, {userId: alice, displayName: 'Alice'});
  // 全天都允许打扰（开始和结束一样就是全天），这样测试什么时候跑都在时段里。她没说过话（7 天没来），
  // 所以不做定期看看、只跑这条跟进：测试结果和跑的时刻无关。
  Object.assign(proactiveState(person), {activeStart: '00:00', activeEnd: '00:00'});
  // 一条已经到点的跟进，像是她在聊天里时 Weave 排的。
  person.schedules = [{id: 'w1', kind: 'wake', text: '她说晚上去走路，看看记了没有', repeat: 'none', nextAt: new Date(Date.now() - 60_000).toISOString(), localTime: '00:00', anchorDay: 1, status: 'scheduled', origin: 'chat', createdAt: new Date().toISOString(), lastRunAt: null, lastOutcome: null}];
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
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-e2e-proactive-')));
  const agent = await createAgentService({
    token: TOKEN, dataDir, isolation: 'local', sandbox: false, weaveUrl: `http://127.0.0.1:${server.address().port}`,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
  const options = () => ({db, secret, agentServiceUrl: agent.url, agentServiceToken: TOKEN, agentRuntime: 'sdk'});
  // 服务器的闹钟：Agent 服务平时每分钟自己来敲（AGENT_TICK_SECONDS），这里手动敲一次。
  const serverTick = async () => (await handleAPI(new Request('https://weave.test/api/internal/tick', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: '{}'}), options())).json();
  return {
    fake, db, alice, dataDir, serverTick,
    mainRequests: () => fake.captured.filter(c => isMain(c.body)),
    world: () => new Store(db).load(),
    async close() { await agent.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fake.close(); },
  };
}

test('到点的跟进端到端：后台叫醒（timer、system、不是直接找它），模型调 send_message 才有一句带「主动」标记的话，最后一段话不发出去', async () => {
  const h = await start();
  try {
    h.fake.script(steps([{tool: 'mcp__weave__send_message', input: {text: '今天走了吗？走了的话回我一句，我帮你记上。'}}, {text: 'BACKGROUND_FINAL_TEXT'}]));
    const out = await h.serverTick();
    assert.equal(out.proactive.started, 1);
    const [request] = h.mainRequests();
    const everything = JSON.stringify(request.body);
    assert.match(everything, /kind=\\"timer\\" channel=\\"system\\" direct=\\"false\\"/);
    assert.ok(everything.includes('你之前排的跟进到点了：她说晚上去走路，看看记了没有'));
    const tools = request.body.tools.map(t => t.name);
    for (const name of ['mcp__weave__send_message', 'mcp__weave__schedule_wake', 'mcp__weave__cancel_schedule', 'mcp__weave__set_proactivity']) assert.ok(tools.includes(name), name);
    const person = (await h.world()).people[h.alice];
    const said = person.messages.filter(m => m.role === 'assistant');
    assert.deepEqual(said.map(m => [m.text, m.proactive]), [['今天走了吗？走了的话回我一句，我帮你记上。', true]]);
    assert.ok(!JSON.stringify(person).includes('BACKGROUND_FINAL_TEXT'), '没人直接找它的那一轮，最后一段话不是回复');
    assert.deepEqual([person.schedules[0].status, person.schedules[0].lastOutcome], ['done', 'sent']);
    assert.deepEqual([person.proactive.sent, person.proactive.wakes, person.proactive.running], [1, 1, null]);
    // 后台那一轮成功：分叉出来的会话存成当天的会话，她回话时接得上。
    const saved = JSON.parse(readFileSync(join(scopeDirs(h.dataDir, 'owner', h.alice).root, 'sessions.json'), 'utf8'));
    assert.equal(typeof saved.sessionId, 'string');
  } finally { await h.close(); }
});

test('到点的跟进端到端：模型没调 send_message，就什么都没发，记成「看过、没说」', async () => {
  const h = await start();
  try {
    h.fake.script(steps([{text: '今天不用打扰她。'}]));
    assert.equal((await h.serverTick()).proactive.started, 1);
    const person = (await h.world()).people[h.alice];
    assert.equal(person.messages.filter(m => m.role === 'assistant').length, 0);
    assert.equal(person.notifications.length, 0);
    assert.deepEqual([person.schedules[0].lastOutcome, person.proactive.log.at(-1).outcome, person.proactive.log.at(-1).spoke], ['quiet', 'quiet', false]);
  } finally { await h.close(); }
});
