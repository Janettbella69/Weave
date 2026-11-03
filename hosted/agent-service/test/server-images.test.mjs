// POST /wake with a photo (docs/superpowers/specs/2026-11-03-wechat-images-design.md): the real service, the real CLI,
// the fake model and a fake Weave backend. No key, no cost.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../server.mjs';
import {scopeDirs} from '../workspace.mjs';
import {isMain, startFakeModel} from './helpers/fake-model.mjs';
import {png} from './helpers/png.mjs';
import {IMAGE_MAX_BASE64} from '../images.mjs';

const TOKEN = 's'.repeat(40);
const SNAPSHOT = {version: 1, today: '2026-11-03', timezone: 'Asia/Shanghai', tables: {}, files: {}};
let fake, weave, service, dataDir;

before(async () => {
  fake = await startFakeModel();
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(req.url === '/api/internal/agent/snapshot' ? JSON.stringify(SNAPSHOT) : '{"ok":true,"text":"已记录"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  weave = {url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); }};
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-service-images-')));
  service = await createAgentService({
    token: TOKEN, dataDir, isolation: 'local', sandbox: false, weaveUrl: weave.url,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
});
after(async () => { await service.close(); await weave.close(); await fake.close(); });

const PHOTO = png(16, 16, 23), IMAGE = {mediaType: 'image/png', data: PHOTO.toString('base64')};
const wakeBody = (extra = {}) => ({
  scope: 'group', id: 'g:' + 'a'.repeat(20), capability: 'cap-abc', localDate: '2026-11-03',
  trigger: {kind: 'message', channel: 'group', direct: true, at: '2026-11-03T12:00:00+08:00', text: '成员2：这顿多少卡'},
  provider: 'deepseek', model: 'deepseek-flash', ...extra,
});
const post = (path, body) => fetch(service.url + path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN}, body: typeof body === 'string' ? body : JSON.stringify(body)});
const modelCalls = () => fake.captured.filter(c => c.path.startsWith('/v1/messages') && isMain(c.body));
const images = body => (body.messages || []).filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'image') : []);
const fresh = text => { fake.captured.length = 0; fake.script(body => isMain(body) ? {text} : {text: 't'}); };

test('a photo turn from someone who picked deepseek-v4-pro runs on deepseek-flash, and the model sees the photo', async () => {
  fresh('大约 600 千卡');
  const r = await post('/wake', wakeBody({model: 'deepseek-v4-pro', image: IMAGE}));
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.outcome, 'success');
  assert.equal(out.reply, '大约 600 千卡');
  const calls = modelCalls();
  assert.ok(calls.length >= 1);
  assert.ok(calls.every(c => c.body.model === 'deepseek-flash'), calls.map(c => c.body.model).join(','));
  assert.equal(images(calls[0].body)[0].source.data, IMAGE.data);
});

test('a text turn keeps the model the person picked', async () => {
  fresh('好的');
  const out = await (await post('/wake', wakeBody({id: 'g:' + 'b'.repeat(20), model: 'deepseek-v4-pro'}))).json();
  assert.equal(out.outcome, 'success');
  assert.ok(modelCalls().every(c => c.body.model === 'deepseek-v4-pro'));
  assert.ok(modelCalls().every(c => images(c.body).length === 0));
});

test('a bad photo, or a photo for a provider that cannot see images, is 400 and the CLI never starts', async () => {
  fresh('x');
  const jpegBytesAsPng = {mediaType: 'image/png', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString('base64')};
  for (const extra of [
    {image: jpegBytesAsPng}, {image: {mediaType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64')}}, {image: 'x'}, {image: null},
    {image: IMAGE, provider: 'kimi', model: 'kimi-k3[1m]'},
  ]) assert.equal((await post('/wake', wakeBody(extra))).status, 400, JSON.stringify(extra).slice(0, 120));
  assert.equal(fake.captured.length, 0);
});

test('the body limit grows only for /wake, and only by one photo', async () => {
  fresh('x');
  const over = JSON.stringify(wakeBody({image: {mediaType: 'image/png', data: 'A'.repeat(IMAGE_MAX_BASE64 + 64 * 1024)}}));
  assert.equal((await post('/wake', over)).status, 413);
  const forget = JSON.stringify({scope: 'group', id: 'g:x', pad: 'x'.repeat(64 * 1024)});
  assert.equal((await post('/forget', forget)).status, 413);
  assert.equal(fake.captured.length, 0);
});

test('a photo turn leaves sessions.json alone: the next text turn the same day resumes the session from before the photo', async () => {
  const id = 'g:' + 'c'.repeat(20), dirs = scopeDirs(dataDir, 'group', id), sessions = join(dirs.root, 'sessions.json');
  fresh('第一轮');
  const one = await (await post('/wake', wakeBody({id}))).json();
  const saved = readFileSync(sessions, 'utf8');
  assert.equal(JSON.parse(saved).sessionId, one.sessionId);
  fresh('看到了');
  const photo = await (await post('/wake', wakeBody({id, image: IMAGE}))).json();
  assert.equal(photo.outcome, 'success');
  assert.equal(readFileSync(sessions, 'utf8'), saved, 'sessions.json changed after a photo turn');
  fresh('第三轮');
  const three = await (await post('/wake', wakeBody({id, trigger: {...wakeBody().trigger, text: '成员2：我刚才说了什么'}}))).json();
  assert.equal(three.sessionId, one.sessionId);
  assert.equal(images(modelCalls().at(-1).body).length, 0);
});
