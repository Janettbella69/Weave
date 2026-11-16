// WeChat photos end to end with no key and no cost (docs/superpowers/specs/2026-11-03-wechat-images-design.md): the bridge's
// side is played by hand (an @ with photo:'ready', then the photo's bytes to /photo), Weave runs in-process with the switch on,
// its tick wakes the real Agent service over HTTP, and the real CLI sends the photo to the fake model. Checked: the model gets
// exactly the bytes, on deepseek-flash even for someone who picked v4-pro; the reply goes back to the chat; nothing of the
// photo is left in D1, the world or the Agent's directories afterwards.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D1} from '../../../test/helpers/product-db.mjs';
import {Store} from '../../lib/weave/store.mjs';
import {hash} from '../../lib/weave/crypto.mjs';
import {handleAPI} from '../../lib/weave/api.mjs';
import {ensurePerson} from '../../lib/weave/domain.mjs';
import {createAgentService} from '../server.mjs';
import {isMain, startFakeModel} from './helpers/fake-model.mjs';
import {png} from './helpers/png.mjs';

const secret = 'ab'.repeat(32), TOKEN = 'e'.repeat(40), BRIDGE = 'bridge-token-' + 'x'.repeat(32), ROOM = '777@chatroom';
const PHOTO = png(20, 20, 41), PHOTO64 = PHOTO.toString('base64');

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
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'weave-e2e-images-')));
  const agent = await createAgentService({
    token: TOKEN, dataDir, isolation: 'local', sandbox: false, weaveUrl: `http://127.0.0.1:${server.address().port}`,
    keys: {deepseek: 'real-key'}, upstreams: {deepseek: fake.baseUrl}, limits: {perAccount: 1e9, total: 1e10},
  });
  const options = () => ({db, secret, wechat: {token: BRIDGE, images: true}, agentServiceUrl: agent.url, agentServiceToken: TOKEN, agentRuntime: 'sdk'});
  const web = async (path, data) => (await handleAPI(new Request('https://weave.test/api/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://weave.test'}, body: JSON.stringify(data)}), {...options(), identity: {userId: 'alice', displayName: 'Alice', email: 'alice@example.test'}})).json();
  // The bridge with its own switch on says so on every request (X-Weave-Photos: on).
  const bridge = async (path, data) => (await handleAPI(new Request('https://weave.test/api/internal/wechat/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE, 'X-Weave-Photos': 'on'}, body: JSON.stringify(data)}), options())).json();
  const photo = async (forId, thread, sender) => (await handleAPI(new Request('https://weave.test/api/internal/wechat/photo', {method: 'POST', headers: {'Content-Type': 'image/png', Authorization: 'Bearer ' + BRIDGE, 'X-Weave-Photos': 'on', 'X-Weave-For': forId, 'X-Weave-Thread': thread, 'X-Weave-Sender': sender}, body: PHOTO}), options())).json();
  // The iLink bridge: private chat only, a photo is a message of its own (POST /image with the decrypted bytes).
  const ilink = async (path, data) => (await handleAPI(new Request('https://weave.test/api/internal/wechat/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE, 'X-Weave-Channel': 'ilink'}, body: JSON.stringify(data)}), options())).json();
  const image = async (messageId, sender) => (await handleAPI(new Request('https://weave.test/api/internal/wechat/image', {method: 'POST', headers: {'Content-Type': 'image/png', Authorization: 'Bearer ' + BRIDGE, 'X-Weave-Channel': 'ilink', 'X-Weave-Message': messageId, 'X-Weave-Sender': sender, 'X-Weave-Created-At': new Date().toISOString()}, body: PHOTO}), options())).json();
  let seq = 0;
  const message = (body, over = {}) => ({id: 'msg_' + (++seq), threadId: 'wxid-alice', senderId: 'wxid-alice', type: 1, direction: 'incoming', body, createdAt: new Date().toISOString(), mentions: {self: false}, ...over});
  const group = (sender, body, mentioned = false, over = {}) => message(body, {threadId: ROOM, senderId: sender, mentions: {self: mentioned}, ...over});
  return {
    fake, db, alice, dataDir, agent, bridge, photo, message, group, web, ilink, image,
    tick: () => bridge('tick', {}),
    bind: async () => bridge('events', message((await web('wechat/bind', {})).instruction)),
    bindIlink: async () => ilink('events', message((await web('wechat/bind', {})).instruction, {threadId: 'o9alice@im.wechat', senderId: 'o9alice@im.wechat', mentions: undefined})),
    mainRequests: () => fake.captured.filter(c => isMain(c.body)),
    async close() { await agent.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fake.close(); },
  };
}
const imagesIn = body => (body.messages || []).filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'image') : []);
const files = dir => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []);
function assertGone(h) {
  let rows = 0;
  try { rows = h.db.sql.prepare('SELECT COUNT(*) AS n FROM weave_wechat_photos').get().n; } catch { /* no table */ }
  assert.equal(rows, 0, 'photo rows left in D1');
  assert.ok(!JSON.stringify(h.db.sql.prepare('SELECT document FROM weave_documents').all()).includes(PHOTO64.slice(0, 80)), 'the photo is in the world');
  for (const file of files(h.dataDir)) {
    const bytes = readFileSync(file);
    assert.equal(bytes.indexOf(PHOTO64.slice(0, 200)), -1, 'the photo (base64) is in ' + file);
    assert.equal(bytes.indexOf(PHOTO), -1, 'the photo (bytes) is in ' + file);
  }
}

test('a check-in group photo end to end: photo first, then the same person\'s @; the model sees the photo on deepseek-flash, the reply @s the asker, nothing is left', async () => {
  const h = await start();
  try {
    h.fake.script(body => !isMain(body) ? {text: 't'} : imagesIn(body).length ? {text: '看起来是一碗牛肉面，大约 650 千卡。'} : {text: '没看到照片'});
    await h.bind();
    await h.web('settings', {model: 'deepseek-v4-pro'});
    assert.equal((await new Store(h.db).load()).people[h.alice].settings.model, 'deepseek-v4-pro', 'setup: the owner picked v4-pro');
    await h.bridge('events', h.group('wxid-alice', '@助理 开启打卡群', true));
    // The opening text carries the photo notice; the group uses photos once the bridge reports it sent.
    for (const job of (await h.bridge('claim', {})).jobs) await h.bridge('receipt', {id: job.id, state: 'accepted'});
    const ask = h.group('wxid-bob', '@助理 这顿大概多少卡', true, {photo: 'ready'});
    assert.equal((await h.bridge('events', ask)).photo, 'upload');
    assert.equal((await h.photo(ask.id, ROOM, 'wxid-bob')).attached, true);
    assert.equal((await h.tick()).processed, 1);
    const [request] = h.mainRequests();
    assert.equal(request.body.model, 'deepseek-flash');
    assert.deepEqual(imagesIn(request.body).map(b => b.source), [{type: 'base64', media_type: 'image/png', data: PHOTO64}]);
    const everything = JSON.stringify(h.mainRequests().map(r => r.body));
    for (const leak of ['wxid-bob', 'wxid-alice', ROOM, 'Alice']) assert.ok(!everything.includes(leak), leak);
    const jobs = (await h.bridge('claim', {})).jobs.filter(j => j.threadId === ROOM);
    assert.deepEqual(jobs.map(j => [j.text, j.mentions]), [['看起来是一碗牛肉面，大约 650 千卡。', {userIds: ['wxid-bob']}]]);
    assertGone(h);
  } finally { await h.close(); }
});

test('a private chat photo over iLink end to end: the photo goes to an owner-scope wake, is kept in her workspace, and the next message the same day still has it in its history', async () => {
  const h = await start();
  try {
    const IL = 'o9alice@im.wechat';
    h.fake.script(body => !isMain(body) ? {text: 't'} : imagesIn(body).length ? {text: '这是一份沙拉，大约 350 千卡。'} : {text: '记得，是沙拉。'});
    await h.bindIlink();
    await h.ilink('claim', {});
    assert.equal((await h.image('img_1', IL)).queued, true);
    assert.equal((await h.ilink('tick', {})).processed, 1);
    const [first] = h.mainRequests();
    assert.equal(first.body.model, 'deepseek-flash');
    assert.equal(imagesIn(first.body).length, 1);
    // The file is in her workspace and the turn was told where.
    const ownerDir = join(h.dataDir, 'owner'), photos = files(ownerDir).filter(f => f.includes('/workspace/photos/'));
    assert.equal(photos.length, 1);
    assert.deepEqual(readFileSync(photos[0]), PHOTO);
    assert.ok(JSON.stringify(first.body.messages).includes('photos/'), 'the note names the file');
    // The next message resumes the same session, which still has the photo.
    await h.ilink('events', h.message('我刚才吃的是什么', {threadId: IL, senderId: IL, mentions: undefined}));
    assert.equal((await h.ilink('tick', {})).processed, 1);
    assert.equal(imagesIn(h.mainRequests().at(-1).body).length, 1, 'the photo is in the history of the next turn');
    const replies = (await h.ilink('claim', {})).jobs.map(j => j.text);
    // The fake model answers the same way whenever a photo is in front of it: both answers say salad.
    assert.deepEqual(replies, ['这是一份沙拉，大约 350 千卡。', '这是一份沙拉，大约 350 千卡。']);
    // D1 and the world never keep the photo: it lives only in her workspace (and her session there).
    let rows = 0;
    try { rows = h.db.sql.prepare('SELECT COUNT(*) AS n FROM weave_wechat_photos').get().n; } catch { /* no table */ }
    assert.equal(rows, 0);
    assert.ok(!JSON.stringify(h.db.sql.prepare('SELECT document FROM weave_documents').all()).includes(PHOTO64.slice(0, 80)));
  } finally { await h.close(); }
});
