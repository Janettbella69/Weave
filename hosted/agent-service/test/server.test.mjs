// Agent 服务的接口：令牌、参数检查、照片、用户自己的 Key、注销、docker 模式的镜像。真 CLI + 假模型，不花钱。
// 一直在线、本子、闹钟、心跳、记忆这些行为在 live.test.mjs。
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../server.mjs';
import {scopeDirs} from '../workspace.mjs';
import {IMAGE_NOTE} from '../prompts.mjs';
import {isMain, startFakeModel} from './helpers/fake-model.mjs';
import {png} from './helpers/png.mjs';

const TOKEN = 's'.repeat(40);
const PHOTO = png(24, 24, 11), IMAGE = {mediaType: 'image/png', data: PHOTO.toString('base64')};
let fake, weave, service, dataDir;

before(async () => {
  fake = await startFakeModel();
  fake.script(() => ({text: '好的'}));
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(req.url === '/api/internal/agent/snapshot' ? JSON.stringify({version: 1, today: '2026-11-17', tables: {}, files: {}}) : '{"ok":true,"text":"已发出。"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  weave = {url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-service-')));
  service = await createAgentService({
    token: TOKEN, dataDir, isolation: 'local', sandbox: false, weaveUrl: weave.url,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
});
after(async () => { await service.close(); await weave.close(); await fake.close(); });

const message = (extra = {}) => ({
  scope: 'owner', id: 'u:alice', capability: 'cap-abc', provider: 'deepseek', model: 'deepseek-flash', wait: true,
  message: {kind: 'message', channel: 'web', at: '2026-11-17T08:00:00+08:00', text: '今天走了 20 分钟'}, ...extra,
});
const post = (path, body, token = TOKEN) => fetch(service.url + path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: JSON.stringify(body)});
const modelCalls = () => fake.captured.filter(c => c.path.startsWith('/v1/messages') && isMain(c.body));
const lastUserContent = body => (body.messages || []).filter(m => m.role === 'user').at(-1).content;

test('/health 不需要令牌；别的接口没有令牌或令牌错误时 401', async () => {
  assert.equal((await fetch(service.url + '/health')).status, 200);
  for (const path of ['/message', '/tick', '/notebook/read', '/memory', '/forget']) {
    assert.equal((await post(path, {}, null)).status, 401, path);
    assert.equal((await post(path, {}, 'x'.repeat(40))).status, 401, path);
  }
  assert.equal((await post('/wake', message())).status, 404, '旧的 /wake 没有了');
});

test('范围、消息、模型、Key、通行证不对都是 400，CLI 没有启动', async () => {
  fake.captured.length = 0;
  for (const bad of [
    {scope: 'research'}, {id: ''}, {capability: ''},
    {message: {kind: 'close', channel: 'system', at: '2026-11-17T08:00:00+08:00', text: 'x'}},
    {message: {kind: 'message', channel: 'sms', at: '2026-11-17T08:00:00+08:00', text: 'x'}},
    {message: {kind: 'message', channel: 'web', at: '2026-11-17 08:00', text: 'x'}},
    {model: 'claude-opus-4'}, {provider: 'openai'}, {userKey: 'short'}, {alarmKind: 'other'},
    {image: {mediaType: 'image/png', data: 'AAAA'}},
  ]) assert.equal((await post('/message', message(bad))).status, 400, JSON.stringify(bad));
  assert.equal((await post('/tick', {entries: [{scope: 'owner', id: 'u:a', capability: 'c', provider: 'deepseek', model: 'deepseek-flash', timezone: 'Mars/Base'}]})).status, 400);
  assert.equal((await post('/notebook/check', {id: 'u:a', capability: 'c', habitId: 'h', date: '17/11', done: true})).status, 400);
  assert.equal(modelCalls().length, 0);
});

test('照片：能看图的模型在同一条消息里收到文字（加照片说明）和照片原样', async () => {
  fake.captured.length = 0;
  const r = await post('/message', message({id: 'u:photo', image: IMAGE}));
  assert.equal((await r.json()).outcome, 'success');
  const content = lastUserContent(modelCalls()[0].body);
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  assert.ok(text.includes('今天走了 20 分钟') && text.includes(IMAGE_NOTE), text);
  assert.deepEqual(content.filter(b => b.type === 'image').map(({type, source}) => ({type, source})), [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: IMAGE.data}}]);
});

test('照片：她选的模型看不了图（deepseek-v4-pro），照片不发，告诉 Weave 有一张它看不了的照片；不为照片换模型', async () => {
  fake.captured.length = 0;
  const r = await post('/message', message({id: 'u:pro', model: 'deepseek-v4-pro', image: IMAGE}));
  assert.equal((await r.json()).outcome, 'success');
  const call = modelCalls()[0];
  assert.equal(call.body.model, 'deepseek-v4-pro');
  const content = JSON.stringify(lastUserContent(call.body));
  assert.ok(content.includes('现在用的模型看不了图') && !content.includes(IMAGE.data.slice(0, 50)), content.slice(0, 300));
});

test('用户自己的 Key 经过代理时，上游看到的是用户 Key；没有托管 Key 也没有 userKey 时 503', async () => {
  fake.captured.length = 0;
  await post('/message', message({id: 'u:own', userKey: 'sk-user-own-key-123'}));
  assert.ok(fake.captured.some(c => c.headers['x-api-key'] === 'sk-user-own-key-123' || c.headers.authorization === 'Bearer sk-user-own-key-123'));
  assert.equal((await post('/message', message({id: 'u:none', provider: 'kimi', model: 'kimi-k3'}))).status, 503);
});

test('/forget 关掉这个人的会话，删掉他的目录，别人的不动', async () => {
  await post('/message', message({id: 'u:gone'}));
  await post('/message', message({id: 'u:stay'}));
  assert.equal(service.live.isLive('owner:u:gone'), true);
  assert.equal((await post('/forget', {scope: 'owner', id: 'u:gone'})).status, 200);
  assert.equal(service.live.isLive('owner:u:gone'), false);
  assert.ok(!existsSync(scopeDirs(dataDir, 'owner', 'u:gone').root));
  assert.ok(existsSync(scopeDirs(dataDir, 'owner', 'u:stay').workspace));
});

test('docker 模式用配置的镜像起这个人的常驻容器；会话关掉时删容器', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-fake-docker-'))), bin = join(dir, 'bin'), calls = join(dir, 'calls');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$1" = rm ] && exit 0\nexit 1\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  const docker = await createAgentService({
    token: TOKEN, dataDir: join(dir, 'data'), isolation: 'docker', image: 'weave-agent:regression', weaveUrl: weave.url,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
  t.after(async () => { process.env.PATH = saved; await docker.close(); });
  await fetch(docker.url + '/message', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: JSON.stringify(message({id: 'u:docker'}))});
  const lines = readFileSync(calls, 'utf8').split('\n');
  const run = lines.find(line => line.startsWith('run '));
  assert.ok(run && run.includes(' weave-agent:regression claude ') && !run.includes(' undefined '), run?.slice(0, 300));
  assert.ok(run.includes('--name weave-live-'), run.slice(0, 200));
  assert.ok(lines.some(line => line.startsWith('rm -f weave-live-')), '假 docker 起不来，会话关掉时删容器');
});
