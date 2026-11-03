// End to end with no key and no cost: the Weave API (in-process, D1 test database) wakes the real
// Agent service over HTTP, the real CLI runs against the fake model through the real model proxy,
// and the weave MCP tools call back into the Weave API's tool backend over HTTP.
// Lives in the agent-service suite because it needs the SDK installed.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D1} from '../../../test/helpers/product-db.mjs';
import {Store} from '../../lib/weave/store.mjs';
import {handleAPI} from '../../lib/weave/api.mjs';
import {createAgentService} from '../server.mjs';
import {isMain, lastToolResults, steps, startFakeModel} from './helpers/fake-model.mjs';

const secret = 'ab'.repeat(32), TOKEN = 'e'.repeat(40);
let fake, db, weave, agent;

before(async () => {
  fake = await startFakeModel();
  db = new D1();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1${req.url}`, {method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks)});
    const response = await handleAPI(request, {db, identity: null, secret});
    res.writeHead(response.status, {'Content-Type': response.headers.get('content-type') || 'application/json'});
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  weave = {url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
  agent = await createAgentService({
    token: TOKEN, dataDir: realpathSync(mkdtempSync(join(tmpdir(), 'weave-e2e-'))), isolation: 'local', sandbox: false,
    weaveUrl: weave.url, keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
});
after(async () => { await agent.close(); await weave.close(); await fake.close(); });

async function chat(name, text) {
  const request = new Request('https://weave.test/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://weave.test'}, body: JSON.stringify({text})});
  const response = await handleAPI(request, {
    db, secret, identity: {userId: name, displayName: name, email: name + '@example.test'},
    agentServiceUrl: agent.url, agentServiceToken: TOKEN, agentRuntime: 'sdk',
  });
  return {status: response.status, data: await response.json()};
}
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());

// The agent reads its data with SQL on the pre-wake snapshot (textbook p.16), like a person would.
const sql = query => ({tool: 'Bash', input: {command: `python3 -c "import sqlite3,json;print(json.dumps(sqlite3.connect('weave/weave.db').execute('${query}').fetchall()))"`, description: 'sql'}});

test('网页聊天端到端：「今天走了 20 分钟」→ Agent 用 SQL 查 weave.db、save_habit、log_completion，再查一次看得到今天这条 → 回复进 messages，完成记录在 D1 里', async () => {
  fake.script(steps([
    sql('select habit_id, name from habits'),
    {tool: 'mcp__weave__save_habit', input: {name: '走路', minimum_action: '走到楼下'}},
    body => ({tool: 'mcp__weave__log_completion', input: {habit_id: JSON.parse(lastToolResults(body)[0]).habit.habit_id, date: today()}}),
    sql('select date from completions'),
    {text: '记好了，今天走了 20 分钟。'},
  ]));
  const r = await chat('Alice', '今天走了 20 分钟');
  assert.deepEqual(r, {status: 200, data: {reply: '记好了，今天走了 20 分钟。'}});
  const person = Object.values((await new Store(db).load()).people)[0];
  assert.equal(person.habits.length, 1);
  assert.equal(person.habits[0].name, '走路');
  assert.equal(person.habits[0].minimumAction, '走到楼下');
  assert.deepEqual(person.completions.map(c => c.date), [today()]);
  assert.deepEqual(person.messages.slice(-2).map(m => [m.role, m.text]), [['user', '今天走了 20 分钟'], ['assistant', '记好了，今天走了 20 分钟。']]);
  const results = fake.captured.filter(c => isMain(c.body)).flatMap(c => lastToolResults(c.body));
  assert.ok(results.some(x => x.includes('"duplicate":false')), results.join(' | '));
  assert.equal(results[0].trim(), '[]', '第一次查的时候还没有习惯');
  assert.ok(results.some(x => x.includes(`[["${today()}"]]`)), '写完以后同一轮再查，本地快照里就有今天这条：' + results.join(' | '));
});

test('同一天第二条消息接上同一段会话，Agent 看得到上一条', async () => {
  fake.captured.length = 0;
  fake.script(steps([{text: '第一条'}, {text: '第一条'}, {text: '第一条'}, {text: '第一条'}, {text: '第一条'}, {text: '你刚才说今天走了 20 分钟'}]));
  const r = await chat('Alice', '我刚才说了什么？');
  assert.equal(r.data.reply, '你刚才说今天走了 20 分钟');
  const lastCall = fake.captured.filter(c => isMain(c.body)).at(-1);
  assert.ok(JSON.stringify(lastCall.body.messages).includes('今天走了 20 分钟'));
});
