// Container contract tests (docs/ARCHITECTURE.md §6): run only where Docker is available and the
// image is built, e.g. in CI:
//   docker build -f Dockerfile.agent -t weave-agent:ci . && WEAVE_TEST_DOCKER_IMAGE=weave-agent:ci node --test test/container.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../server.mjs';
import {scopeDirs} from '../workspace.mjs';
import {isMain, lastToolResults, steps, startFakeModel} from './helpers/fake-model.mjs';
import {png} from './helpers/png.mjs';

const IMAGE = process.env.WEAVE_TEST_DOCKER_IMAGE;
const skip = IMAGE ? false : 'set WEAVE_TEST_DOCKER_IMAGE to an image built from Dockerfile.agent';
const TOKEN = 'c'.repeat(40), REAL_KEY = 'sk-real-key-must-stay-outside-the-container';
let fake, weave, service, dataDir, outcome, results = [];

before(async () => {
  if (!IMAGE) return;
  fake = await startFakeModel();
  const snapshot = {version: 1, today: '2026-11-02', timezone: 'Asia/Shanghai', tables: {habits: [{habit_id: 'walk', name: '走路'}], completions: []}, files: {}};
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(req.method === 'GET' && req.url === '/api/internal/agent/snapshot' ? JSON.stringify(snapshot) : '{"ok":true,"text":"已记录"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  weave = {url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-container-')));
  service = await createAgentService({token: TOKEN, dataDir, isolation: 'docker', image: IMAGE, weaveUrl: weave.url, keys: {deepseek: REAL_KEY}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10}});
  const hostPort = new URL(fake.baseUrl).port;
  fake.script(steps([
    {tool: 'Bash', input: {command: `python3 -c "import urllib.request;urllib.request.urlopen('https://example.com',timeout=4)"; echo NET=$?; python3 -c "import socket;socket.create_connection(('172.17.0.1',${hostPort}),3)"; echo HOST=$?`, description: 'net'}},
    {tool: 'Bash', input: {command: 'env', description: 'env'}},
    {tool: 'Bash', input: {command: 'rm -f /run/weave/proxy.sock; echo RM=$?; touch /run/weave/evil; echo TOUCH=$?', description: 'attack'}},
    {tool: 'Write', input: {file_path: '/workspace/MEMORY.md', content: '周末早上更容易走路\n'}},
    {tool: 'Bash', input: {command: 'echo x > /etc/weave-test; echo ETC=$?', description: 'ro'}},
    {tool: 'mcp__weave__log_completion', input: {habit_id: 'walk', date: '2026-11-02'}},
    {tool: 'Bash', input: {command: 'sqlite3 weave/weave.db "select name from habits"; echo DB=$?; touch weave/x 2>/dev/null; echo RO=$?; sqlite3 weave/weave.db "create trigger t after insert on habits begin select 1; end" 2>/dev/null; echo TRIGGER=$?', description: 'db'}},
    {text: '完成'},
  ]));
  const r = await fetch(service.url + '/wake', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: JSON.stringify({
    scope: 'owner', id: 'u:container', capability: 'cap-1', localDate: '2026-11-02', provider: 'deepseek', model: 'deepseek-flash',
    trigger: {kind: 'message', channel: 'web', direct: true, at: '2026-11-02T08:00:00+08:00', text: '跑一遍'},
  })});
  outcome = await r.json();
  results = fake.captured.filter(c => isMain(c.body)).flatMap(c => lastToolResults(c.body));
});

const wake = text => fetch(service.url + '/wake', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: JSON.stringify({
  scope: 'owner', id: 'u:container', capability: 'cap-1', localDate: '2026-11-02', provider: 'deepseek', model: 'deepseek-flash',
  trigger: {kind: 'message', channel: 'web', direct: true, at: '2026-11-02T08:05:00+08:00', text},
})}).then(r => r.json());
after(async () => { if (!IMAGE) return; await service.close(); await weave.close(); await fake.close(); });

test('一轮在容器里跑完，模型请求经 socket 到代理，上游看到真 Key', {skip}, () => {
  assert.equal(outcome.outcome, 'success', JSON.stringify(outcome));
  assert.equal(outcome.reply, '完成');
  const upstream = fake.captured.filter(c => c.path.startsWith('/v1/messages'));
  assert.ok(upstream.length >= 7);
  assert.ok(upstream.every(c => c.headers.authorization === 'Bearer ' + REAL_KEY));
});

test('一个容器删不掉、也换不了大家共用的代理 socket，这一轮照样跑完', {skip}, () => {
  const attack = results.find(x => x.includes('RM=')) || '';
  assert.match(attack, /RM=[1-9]/, attack);
  assert.match(attack, /TOUCH=[1-9]/, attack);
  assert.equal(outcome.outcome, 'success');
});

test('容器里的 Agent 用 sqlite3 查得到 weave.db，但改不了它：只读挂载，写文件、埋触发器都失败', {skip}, () => {
  const db = results.find(x => x.includes('DB=')) || '';
  assert.match(db, /走路/, db);
  assert.match(db, /DB=0/, db);
  assert.match(db, /RO=[1-9]/, db);
  assert.match(db, /TRIGGER=[1-9]/, db);
});

test('同一天第二次唤醒在容器里接上同一段会话（socket 也还在）', {skip}, async () => {
  fake.captured.length = 0;
  fake.script(b => isMain(b) ? {text: '第二轮'} : {text: 't'});
  const second = await wake('我刚才让你做什么了？');
  assert.equal(second.outcome, 'success', JSON.stringify(second));
  assert.equal(second.reply, '第二轮');
  assert.equal(second.sessionId, outcome.sessionId);
  const first = fake.captured.find(c => isMain(c.body));
  assert.ok(JSON.stringify(first.body.messages).includes('跑一遍'));
});

// 微信看图（docs/superpowers/specs/2026-11-03-wechat-images-design.md）：生产用的就是容器，所以在容器里再跑一遍带照片的一轮。
test('带照片的一轮在容器里也跑得通：照片原样到模型、用 deepseek-flash，sessions.json 不变，挂进容器的目录里没有它', {skip}, async () => {
  const data = png(12, 12, 5).toString('base64'), dirs = scopeDirs(dataDir, 'owner', 'u:container');
  const sessions = readFileSync(join(dirs.root, 'sessions.json'), 'utf8');
  fake.captured.length = 0;
  fake.script(b => isMain(b) ? {text: '看到了'} : {text: 't'});
  const photo = await fetch(service.url + '/wake', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: JSON.stringify({
    scope: 'owner', id: 'u:container', capability: 'cap-1', localDate: '2026-11-02', provider: 'deepseek', model: 'deepseek-v4-pro',
    trigger: {kind: 'message', channel: 'wechat', direct: true, at: '2026-11-02T08:10:00+08:00', text: '这是什么'}, image: {mediaType: 'image/png', data},
  })}).then(r => r.json());
  assert.equal(photo.outcome, 'success', JSON.stringify(photo));
  assert.equal(photo.reply, '看到了');
  const calls = fake.captured.filter(c => isMain(c.body));
  assert.ok(calls.length >= 1 && calls.every(c => c.body.model === 'deepseek-flash'), calls.map(c => c.body.model).join(','));
  assert.ok(JSON.stringify(calls[0].body.messages).includes(data));
  assert.equal(readFileSync(join(dirs.root, 'sessions.json'), 'utf8'), sessions);
  const files = dir => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []);
  for (const file of files(dirs.root)) assert.equal(readFileSync(file).indexOf(data.slice(0, 120)), -1, 'the photo is in ' + file);
});

test('容器里 Bash 连不了网，也连不到宿主机', {skip}, () => {
  const net = results.find(x => x.includes('NET=')) || '';
  assert.match(net, /NET=[1-9]/, net);
  assert.match(net, /HOST=[1-9]/, net);
});

test('容器里读不到真 Key，ANTHROPIC_AUTH_TOKEN 是一轮一换的运行令牌', {skip}, () => {
  const env = results.find(x => x.includes('ANTHROPIC_AUTH_TOKEN=')) || '';
  assert.ok(!results.join('\n').includes(REAL_KEY), 'the real key reached the container');
  assert.match(env, /^ANTHROPIC_AUTH_TOKEN=[a-f0-9]{48}$/m, env);
});

test('Write 进 /workspace 的文件落在宿主的工作目录；根目录只读', {skip}, () => {
  const dirs = scopeDirs(dataDir, 'owner', 'u:container');
  assert.equal(readFileSync(join(dirs.workspace, 'MEMORY.md'), 'utf8'), '周末早上更容易走路\n');
  const etc = results.find(x => x.includes('ETC=')) || '';
  assert.match(etc, /ETC=[1-9]/, etc);
});

test('MCP 工具仍在宿主的 Agent 服务里执行', {skip}, () => {
  assert.ok(outcome.tools.includes('mcp__weave__log_completion'));
  assert.ok(results.some(x => x.includes('已记录')));
});

test('一轮结束容器已删除', {skip}, async () => {
  let left = 'unknown';
  for (let i = 0; i < 20; i++) {
    left = execFileSync('docker', ['ps', '-a', '--filter', 'name=weave-run-', '--format', '{{.Names}}'], {encoding: 'utf8'}).trim();
    if (!left) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(left, '');
});
