// WeChat photos in a wake (docs/superpowers/specs/2026-11-03-wechat-images-design.md): the real CLI of SDK 0.3.316 against
// the fake model, through the real model proxy. No key, no cost. What is checked here is what the SDK docs do not say:
// resume together with a streaming (generator) prompt, and that a photo turn leaves nothing on disk.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {createHarness, message, PLUGIN_DIR} from './helpers/harness.mjs';
import {isMain, steps} from './helpers/fake-model.mjs';
import {png} from './helpers/png.mjs';
import {scopeFor} from '../scopes.mjs';
import {wake} from '../runner.mjs';
import {isolationFor} from '../sandbox.mjs';
import {providerFor} from '../providers.mjs';
import {IMAGE_NOTE, renderTrigger} from '../prompts.mjs';
import {checkImage, IMAGE_MAX_BYTES, sniffImage} from '../images.mjs';

let h;
before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });

const PHOTO = png(24, 24, 11), IMAGE = {mediaType: 'image/png', data: PHOTO.toString('base64')};
const mainCalls = () => h.fake.captured.filter(c => c.path.startsWith('/v1/messages') && !c.path.includes('count_tokens') && isMain(c.body));
const fresh = route => { h.fake.captured.length = 0; h.fake.script(route); };
const userMessages = body => (body.messages || []).filter(m => m.role === 'user');
const imageBlocks = body => userMessages(body).flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'image') : []);
// The CLI marks the last user block for prompt caching (cache_control); the photo itself must arrive unchanged.
const photosIn = body => imageBlocks(body).map(({type, source}) => ({type, source}));
// Every file under a directory, recursively (links are not followed).
const files = dir => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []);
const sessionFile = (dirs, id) => files(dirs.config).find(f => f.endsWith(`/${id}.jsonl`));
function assertNoPhotoOnDisk(dirs) {
  for (const file of [...files(dirs.workspace), ...files(dirs.config), ...files(dirs.home)]) {
    const bytes = readFileSync(file);
    assert.equal(bytes.indexOf(IMAGE.data.slice(0, 200)), -1, 'the photo (base64) is in ' + file);
    assert.equal(bytes.indexOf(PHOTO), -1, 'the photo (bytes) is in ' + file);
  }
}

test('a photo turn: the model gets one user message, the trigger and the note first, then the photo exactly as sent', async () => {
  fresh(steps([{text: '这顿大约 600 千卡'}]));
  const r = await h.wakeOnce({trigger: message('这顿多少卡'), image: IMAGE});
  assert.equal(r.outcome, 'success');
  assert.equal(r.reply, '这顿大约 600 千卡');
  const body = mainCalls()[0].body, last = userMessages(body).at(-1);
  assert.ok(Array.isArray(last.content), JSON.stringify(last).slice(0, 300));
  const text = last.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  assert.ok(text.includes(renderTrigger(message('这顿多少卡'))), text);
  assert.ok(text.includes(IMAGE_NOTE), text);
  assert.deepEqual(photosIn(body), [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: IMAGE.data}}]);
  const kinds = last.content.map(b => b.type).filter(t => t === 'text' || t === 'image');
  assert.ok(kinds.lastIndexOf('image') > kinds.indexOf('text'), 'text first, then the photo: ' + kinds.join(','));
  assertNoPhotoOnDisk(r.dirs);
});

test('resume with a generator prompt works in SDK 0.3.316; the photo turn writes no session, and the next text turn resumes the session from before it', async () => {
  const dirs = h.tenant();
  const assistants = body => (body.messages || []).filter(m => m.role === 'assistant').map(m => JSON.stringify(m.content));
  fresh(body => !isMain(body) ? {text: 't'} : imageBlocks(body).length ? {text: '这顿大约 600 千卡'} : assistants(body).length ? {text: '你午饭吃了沙拉'} : {text: '记住了'});
  const a = await h.wakeOnce({dirs, trigger: message('我午饭吃了沙拉')});
  assert.equal(a.outcome, 'success');
  const saved = sessionFile(dirs, a.sessionId);
  assert.ok(saved, 'the first turn should write its session');
  const before = readFileSync(saved), sessions = files(dirs.config).filter(f => f.endsWith('.jsonl')).sort();

  const b = await h.wakeOnce({dirs, sessionId: a.sessionId, trigger: message('这顿多少卡'), image: IMAGE});
  assert.equal(b.outcome, 'success');
  assert.equal(b.reply, '这顿大约 600 千卡');
  const photoCall = mainCalls().at(-1).body;
  assert.ok(JSON.stringify(photoCall.messages).includes('我午饭吃了沙拉'), 'the photo turn should see the earlier turn (resume)');
  assert.equal(imageBlocks(photoCall).length, 1);
  assert.deepEqual(readFileSync(saved), before, 'the resumed session file must not change');
  assert.deepEqual(files(dirs.config).filter(f => f.endsWith('.jsonl')).sort(), sessions, 'no new session file');
  assertNoPhotoOnDisk(dirs);

  const c = await h.wakeOnce({dirs, sessionId: a.sessionId, trigger: message('我午饭吃了什么')});
  assert.equal(c.outcome, 'success');
  assert.equal(c.reply, '你午饭吃了沙拉');
  const next = mainCalls().at(-1).body;
  assert.ok(JSON.stringify(next.messages).includes('我午饭吃了沙拉'));
  // Exactly the turn before the photo: one earlier answer, and not the photo turn's question or answer.
  assert.equal(assistants(next).length, 1, assistants(next).join(' | '));
  assert.ok(assistants(next)[0].includes('记住了'));
  assert.ok(!JSON.stringify(next.messages).includes('这顿多少卡') && !JSON.stringify(next.messages).includes('600 千卡'));
  assert.equal(imageBlocks(next).length, 0, 'the photo must not come back in a later turn');
  assertNoPhotoOnDisk(dirs);
});

test('a photo turn can still call the weave tools (SDK MCP over the control channel) and its hooks still run', async () => {
  const calls = [];
  const rpc = async (name, args, toolUseId) => { calls.push({name, args, toolUseId}); return {ok: true, text: '已发出。'}; };
  fresh(steps([{tool: 'mcp__weave__send_message', input: {text: '收到照片'}}, {text: '好的'}]));
  const r = await h.wakeOnce({trigger: message('看看这个'), image: IMAGE, rpc});
  assert.equal(r.outcome, 'success');
  assert.equal(r.reply, '好的');
  assert.deepEqual(calls.map(c => c.name), ['send_message']);
  assert.deepEqual(r.tools, ['mcp__weave__send_message']);
});

test('what query() is given: a text turn is the same string as before with no persistSession; a photo turn is a stream of one message and persistSession: false', async () => {
  const seen = [];
  const queryFn = async function* (call) {
    const prompt = typeof call.prompt === 'string' ? call.prompt : [];
    if (typeof call.prompt !== 'string') for await (const m of call.prompt) prompt.push(m);
    seen.push({prompt, options: call.options});
    yield {type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0};
  };
  const scope = scopeFor('group');
  const isolation = isolationFor({mode: 'local', scope, dirs: h.tenant(), pluginDir: PLUGIN_DIR, proxy: {url: h.proxyUrl}, sandbox: false});
  const trigger = {kind: 'message', channel: 'group', direct: true, at: '2026-11-03T12:00:00+08:00', text: '成员2：这顿多少卡'};
  const common = {scope, trigger, provider: providerFor('deepseek'), model: 'deepseek-flash', runToken: 'run-token', isolation, rpc: async () => ({ok: true, text: 'ok'}), queryFn};
  await wake({...common, sessionId: 'prev'});
  await wake({...common, sessionId: 'prev', image: IMAGE});
  assert.equal(seen[0].prompt, renderTrigger(trigger));
  assert.ok(!('persistSession' in seen[0].options));
  assert.equal(seen[0].options.resume, 'prev');
  assert.equal(seen[1].prompt.length, 1);
  assert.deepEqual(seen[1].prompt[0], {
    type: 'user', parent_tool_use_id: null,
    message: {role: 'user', content: [{type: 'text', text: renderTrigger(trigger) + '\n' + IMAGE_NOTE}, {type: 'image', source: {type: 'base64', media_type: 'image/png', data: IMAGE.data}}]},
  });
  assert.equal(seen[1].options.persistSession, false);
  assert.equal(seen[1].options.resume, 'prev');
  const {persistSession, ...rest} = seen[1].options;
  assert.equal(persistSession, false);
  assert.deepEqual(Object.keys(rest).sort(), Object.keys(seen[0].options).sort(), 'nothing else changes for a photo turn');
});

test('checkImage takes JPEG, PNG, GIF and WebP up to 2 MiB whose bytes match the declared type, and nothing else', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), gif = Buffer.from('GIF89a......'), webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  for (const [bytes, type] of [[jpeg, 'image/jpeg'], [PHOTO, 'image/png'], [gif, 'image/gif'], [webp, 'image/webp']]) {
    assert.equal(sniffImage(bytes), type);
    assert.deepEqual(checkImage({mediaType: type, data: bytes.toString('base64')}), {mediaType: type, data: bytes.toString('base64')});
  }
  const big = Buffer.alloc(IMAGE_MAX_BYTES + 1, 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  const exact = big.subarray(0, IMAGE_MAX_BYTES);
  assert.equal(checkImage({mediaType: 'image/jpeg', data: exact.toString('base64')}).mediaType, 'image/jpeg');
  for (const bad of [
    null, [], 'x', {mediaType: 'image/jpeg'}, {mediaType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64')},
    {mediaType: 'image/png', data: jpeg.toString('base64')}, {mediaType: 'image/jpeg', data: big.toString('base64')},
    {mediaType: 'image/jpeg', data: '!!!!'}, {mediaType: 'image/jpeg', data: jpeg.toString('base64').slice(1)},
    {mediaType: 'image/heic', data: jpeg.toString('base64')}, {mediaType: 'image/jpeg', data: ''},
  ]) assert.throws(() => checkImage(bad), JSON.stringify(bad)?.slice(0, 80));
});

test('the 1x1-style fixtures are real images: the PNG helper writes a valid signature, header and end chunk', () => {
  assert.equal(sniffImage(PHOTO), 'image/png');
  assert.equal(PHOTO.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(PHOTO.subarray(PHOTO.length - 8, PHOTO.length - 4).toString('ascii'), 'IEND');
  assert.ok(statSync(PLUGIN_DIR).isDirectory());
});
