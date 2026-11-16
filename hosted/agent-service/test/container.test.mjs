// Container contract tests (docs/ARCHITECTURE.md「内置能力和边界」): run only where Docker is available and the
// image is built, e.g. in CI:
//   docker build -f Dockerfile.agent -t weave-agent:ci . && WEAVE_TEST_DOCKER_IMAGE=weave-agent:ci node --test test/container.test.mjs
// 一直在线：每个人一个常驻容器，几条消息进同一个容器、同一段会话；会话关掉时容器删掉。
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAgentService} from '../server.mjs';
import {scopeDirs, memoryDir} from '../workspace.mjs';
import {notebookPath} from '../notebook.mjs';
import {isMain, lastToolResults, startFakeModel} from './helpers/fake-model.mjs';
import {png} from './helpers/png.mjs';

const IMAGE = process.env.WEAVE_TEST_DOCKER_IMAGE;
const skip = IMAGE ? false : 'set WEAVE_TEST_DOCKER_IMAGE to an image built from Dockerfile.agent';
const TOKEN = 'c'.repeat(40), REAL_KEY = 'sk-real-key-must-stay-outside-the-container';
const LEGACY = {version: 1, today: '2026-11-17', timezone: 'Asia/Shanghai', tables: {habits: [{habit_id: 'walk', name: '走路'}], completions: []}, files: {}};
let fake, weave, service, dataDir, outcome, results = [];

// 按顺序一步一步回；只看主 Agent 的请求。
const script = list => { let i = 0; fake.script(body => isMain(body) ? (list[i++] ?? {text: '完成'}) : {text: 't'}); };
const containers = () => execFileSync('docker', ['ps', '-a', '--filter', 'name=weave-live-', '--format', '{{.Names}}'], {encoding: 'utf8'}).trim().split('\n').filter(Boolean);
const send = (text, extra = {}) => fetch(service.url + '/message', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: JSON.stringify({
  scope: 'owner', id: 'u:container', capability: 'cap-1', provider: 'deepseek', model: 'deepseek-flash', wait: true,
  message: {kind: 'message', channel: 'web', at: '2026-11-17T08:00:00+08:00', text}, ...extra,
})}).then(r => r.json());

before(async () => {
  if (!IMAGE) return;
  fake = await startFakeModel();
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(req.method === 'GET' && req.url === '/api/internal/agent/snapshot' ? JSON.stringify(LEGACY) : '{"ok":true,"text":"已发出。"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  weave = {url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-container-')));
  service = await createAgentService({token: TOKEN, dataDir, isolation: 'docker', image: IMAGE, weaveUrl: weave.url, keys: {deepseek: REAL_KEY}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10}});
  const hostPort = new URL(fake.baseUrl).port;
  script([
    {tool: 'Bash', input: {command: `python3 -c "import urllib.request;urllib.request.urlopen('https://example.com',timeout=4)"; echo NET=$?; python3 -c "import socket;socket.create_connection(('172.17.0.1',${hostPort}),3)"; echo HOST=$?`, description: 'net'}},
    {tool: 'Bash', input: {command: 'env', description: 'env'}},
    {tool: 'Bash', input: {command: 'rm -f /run/weave/proxy.sock; echo RM=$?; touch /run/weave/evil; echo TOUCH=$?', description: 'attack'}},
    {tool: 'Write', input: {file_path: '/home/agent/.claude/projects/-workspace/memory/walk.md', content: '周末早上更容易走路\n'}},
    {tool: 'Bash', input: {command: 'echo x > /etc/weave-test; echo ETC=$?', description: 'ro'}},
    {tool: 'Bash', input: {command: `sqlite3 records.db "select name from habits"; sqlite3 records.db "insert into completions (habit_id, date) values ('walk', '2026-11-17')"; echo DB=$?`, description: 'db'}},
    {tool: 'mcp__weave__schedule', input: {at: '2099-01-01T08:00:00+08:00', note: '看看她走了没有'}},
    {tool: 'mcp__weave__send_message', input: {text: '记好了'}},
    {text: '完成'},
  ]);
  outcome = await send('跑一遍');
  results = fake.captured.filter(c => isMain(c.body)).flatMap(c => lastToolResults(c.body));
});
after(async () => { if (!IMAGE) return; await service.close(); await weave.close(); await fake.close(); });

test('一轮在常驻容器里跑完，模型请求经 socket 到代理，上游看到真 Key', {skip}, () => {
  assert.equal(outcome.outcome, 'success', JSON.stringify(outcome));
  const upstream = fake.captured.filter(c => c.path.startsWith('/v1/messages'));
  assert.ok(upstream.length >= 8);
  assert.ok(upstream.every(c => c.headers.authorization === 'Bearer ' + REAL_KEY));
  assert.equal(containers().length, 1, '这个人的常驻容器还开着');
});

test('容器里 Bash 连不了网，也连不到宿主机', {skip}, () => {
  const net = results.find(x => x.includes('NET=')) || '';
  assert.match(net, /NET=[1-9]/, net);
  assert.match(net, /HOST=[1-9]/, net);
});

test('容器里读不到真 Key，ANTHROPIC_AUTH_TOKEN 是这段会话的运行令牌', {skip}, () => {
  const env = results.find(x => x.includes('ANTHROPIC_AUTH_TOKEN=')) || '';
  assert.ok(!results.join('\n').includes(REAL_KEY), 'the real key reached the container');
  assert.match(env, /^ANTHROPIC_AUTH_TOKEN=[a-f0-9]{48}$/m, env);
});

test('一个容器删不掉、也换不了大家共用的代理 socket，这一轮照样跑完', {skip}, () => {
  const attack = results.find(x => x.includes('RM=')) || '';
  assert.match(attack, /RM=[1-9]/, attack);
  assert.match(attack, /TOUCH=[1-9]/, attack);
});

test('本子在工作目录里：容器里用 sqlite3 读得到以前导入的习惯，写的打卡落在宿主的 records.db；根目录只读', {skip}, () => {
  const db = results.find(x => x.includes('DB=')) || '';
  assert.match(db, /走路/, db);
  assert.match(db, /DB=0/, db);
  const book = new DatabaseSync(notebookPath(scopeDirs(dataDir, 'owner', 'u:container')));
  assert.equal(book.prepare("SELECT count(*) AS n FROM completions WHERE habit_id = 'walk' AND date = '2026-11-17'").get().n, 1);
  assert.equal(book.prepare('SELECT note FROM alarms').get().note, '看看她走了没有');
  book.close();
  const etc = results.find(x => x.includes('ETC=')) || '';
  assert.match(etc, /ETC=[1-9]/, etc);
});

test('记忆写进 SDK 自带的记忆目录，落在宿主的配置目录里', {skip}, () => {
  const dirs = scopeDirs(dataDir, 'owner', 'u:container');
  assert.equal(readFileSync(join(memoryDir(dirs, '/workspace'), 'walk.md'), 'utf8'), '周末早上更容易走路\n');
});

test('MCP 工具在宿主的 Agent 服务里执行：schedule 写本子，send_message 转给网站', {skip}, () => {
  assert.ok(outcome.tools.includes('mcp__weave__schedule') && outcome.tools.includes('mcp__weave__send_message'), outcome.tools.join(','));
  assert.ok(results.some(x => x.includes('看看她走了没有')));
  assert.ok(results.some(x => x.includes('已发出。')));
});

test('第二条消息进同一个容器、同一段会话（没有再起一个容器）', {skip}, async () => {
  const before = containers();
  fake.captured.length = 0;
  script([{text: '第二条'}]);
  const second = await send('我刚才让你做什么了？');
  assert.equal(second.outcome, 'success', JSON.stringify(second));
  assert.equal(second.sessionId, outcome.sessionId);
  assert.deepEqual(containers(), before);
  assert.ok(JSON.stringify(fake.captured.find(c => isMain(c.body)).body.messages).includes('跑一遍'));
});

test('带照片的消息在容器里也跑得通：照片原样到模型', {skip}, async () => {
  const data = png(12, 12, 5).toString('base64');
  fake.captured.length = 0;
  script([{text: '看到了'}]);
  const photo = await send('这是什么', {image: {mediaType: 'image/png', data}, message: {kind: 'message', channel: 'wechat', at: '2026-11-17T08:10:00+08:00', text: '这是什么'}});
  assert.equal(photo.outcome, 'success', JSON.stringify(photo));
  assert.ok(JSON.stringify(fake.captured.find(c => isMain(c.body)).body.messages).includes(data));
});

test('会话关掉（空闲、注销）时容器删掉', {skip}, async () => {
  await service.live.close('owner:u:container');
  let left = containers();
  for (let i = 0; i < 20 && left.length; i++) { await new Promise(r => setTimeout(r, 250)); left = containers(); }
  assert.deepEqual(left, []);
});
