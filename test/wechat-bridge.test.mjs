import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDaemon,createThrottle,createWeave,cursorStore,deliverOnce,forwardable,handleEvent,reconnectDelay,sseEvents,throttleFromEnv} from '../hosted/wechat-bridge/bridge.mjs';

const sse=text=>new Response(text).body;
const collect=async iterable=>{const items=[];for await(const item of iterable)items.push(item);return items;};
const incoming={id:'msg_1',accountId:'a',threadId:'1@chatroom',serverId:'9',senderId:'wxid-bob',type:1,direction:'incoming',body:'走了八千步',createdAt:'2030-01-01T00:00:00+00:00',mentions:{state:'known',userIds:['wxid-bot'],self:true,all:false,source:'x'},version:'1',media:[]};

test('SSE parsing skips heartbeats, survives bad frames and split chunks, and keeps the cursor',async()=>{
  const events=await collect(sseEvents(sse(': heartbeat\n\nid: 5\nevent: message.committed\ndata: {"kind":"message.committed","data":{"messageId":"m"}}\n\ndata: not json\n\nid: 6\ndata: {"cursor":"6","kind":"x","data":{}}\n\n')));
  assert.deepEqual(events.map(e=>[e.cursor,e.kind]),[['5','message.committed'],['6','x']]);
  const encoder=new TextEncoder(),frame=encoder.encode('data: {"cursor":"7","kind":"多字节","data":{}}\n\n');
  const split=new ReadableStream({start(c){c.enqueue(frame.slice(0,20));c.enqueue(frame.slice(20));c.close();}});
  assert.equal((await collect(sseEvents(split)))[0].kind,'多字节');
});
test('only incoming text is forwarded, with nothing extra',()=>{
  assert.deepEqual(Object.keys(forwardable(incoming)).sort(),['body','createdAt','direction','id','mentions','senderId','threadId','type']);
  assert.deepEqual(forwardable(incoming).mentions,{self:true});
  for(const over of [{type:3},{direction:'outgoing'},{body:'  '},{body:null}])assert.equal(forwardable({...incoming,...over}),null);
});
test('the daemon client uses the documented routes, bearer token and idempotency key',async()=>{
  const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});return Response.json({id:'s1',state:'queued'});};
  const daemon=createDaemon({baseUrl:'http://127.0.0.1:6174/v1/',token:'tok',account:'acc 1',fetcher});
  await daemon.send({id:'out:1',threadId:'1@chatroom',text:'好',mentions:{userIds:['wxid-bob']}});
  assert.equal(calls[0].url,'http://127.0.0.1:6174/v1/accounts/acc%201/sends');
  assert.equal(calls[0].options.headers.Authorization,'Bearer tok');
  assert.equal(calls[0].options.headers['Idempotency-Key'],'out:1');
  assert.deepEqual(JSON.parse(calls[0].options.body),{threadId:'1@chatroom',text:'好',mentions:{userIds:['wxid-bob']}});
  await daemon.stream('42');assert.equal(calls[1].url,'http://127.0.0.1:6174/v1/accounts/acc%201/events/stream?after=42');
  await daemon.ack('42');assert.equal(calls[2].url,'http://127.0.0.1:6174/v1/accounts/acc%201/consumers/weave-bridge/ack');
  assert.deepEqual(JSON.parse(calls[2].options.body),{cursor:'42'});
});
test('a committed incoming message reaches Weave before the cursor advances',async()=>{
  const log=[];const daemon={message:async()=>{log.push('fetch');return incoming;},ack:async()=>{log.push('ack');}};
  await handleEvent({cursor:'9',kind:'message.committed',data:{messageId:'msg_1',direction:'incoming'}},{daemon,weave:async(path,data)=>{log.push(path+':'+data.id);},saveCursor:async c=>{log.push('save:'+c);}});
  assert.deepEqual(log,['fetch','events:msg_1','save:9','ack']);
});
test('if Weave is unavailable the cursor does not advance, so the message replays',async()=>{
  const saved=[];const daemon={message:async()=>incoming,ack:async()=>{}};
  await assert.rejects(handleEvent({cursor:'9',kind:'message.committed',data:{messageId:'m',direction:'incoming'}},{daemon,weave:async()=>{throw Error('503');},saveCursor:async c=>saved.push(c)}));
  assert.deepEqual(saved,[]);
});
test('our own sends and other event kinds advance the cursor without fetching a message',async()=>{
  const saved=[];const daemon={message:async()=>{throw Error('should not fetch');},ack:async()=>{}};
  const context={daemon,weave:async()=>{throw Error('should not forward');},saveCursor:async c=>saved.push(c)};
  await handleEvent({cursor:'1',kind:'message.committed',data:{messageId:'m',direction:'outgoing'}},context);
  await handleEvent({cursor:'2',kind:'group.updated',data:{}},context);
  assert.deepEqual(saved,['1','2']);
});
test('a failed ack never blocks progress',async()=>{
  const saved=[];await handleEvent({cursor:'3',kind:'x',data:{}},{daemon:{ack:async()=>{throw Error('down');}},weave:async()=>{},saveCursor:async c=>saved.push(c)});
  assert.deepEqual(saved,['3']);
});
test('delivery waits for a terminal send state before reporting it',async()=>{
  const receipts=[];const states=['queued','sending','accepted'];
  const daemon={send:async()=>({id:'s1',state:states.shift()}),sendStatus:async()=>({id:'s1',state:states.shift()})};
  const weave=async(path,data)=>{if(path==='claim')return {jobs:[{id:'out:1',threadId:'t',text:'好'}]};receipts.push(data);return {ok:true};};
  assert.equal(await deliverOnce({daemon,weave,sleep:async()=>{}}),1);
  assert.deepEqual(receipts,[{id:'out:1',state:'accepted'}]);
});
test('a send still pending keeps its lease rather than reporting an outcome',async()=>{
  const receipts=[];const daemon={send:async()=>({id:'s1',state:'queued'}),sendStatus:async()=>({id:'s1',state:'queued'})};
  const weave=async(path,data)=>{if(path==='claim')return {jobs:[{id:'out:1',threadId:'t',text:'好'}]};receipts.push(data);};
  assert.equal(await deliverOnce({daemon,weave,attempts:2,sleep:async()=>{}}),0);assert.deepEqual(receipts,[]);
});
test('needs_review is reported as is, never treated as a failure to retry',async()=>{
  const receipts=[];const daemon={send:async()=>({id:'s1',state:'needs_review'})};
  await deliverOnce({daemon,weave:async(path,data)=>{if(path==='claim')return {jobs:[{id:'o',threadId:'t',text:'x'}]};receipts.push(data);},sleep:async()=>{}});
  assert.deepEqual(receipts,[{id:'o',state:'needs_review'}]);
});
test('a rejected request is a failure, but being logged out or offline keeps the message queued',async()=>{
  const receipts=[];const weave=async(path,data)=>{if(path==='claim')return {jobs:[{id:'o',threadId:'t',text:'x'}]};receipts.push(data);};
  const failing=status=>({send:async()=>{const e=Error('x');e.status=status;throw e;}});
  await deliverOnce({daemon:failing(400),weave,sleep:async()=>{}});
  assert.deepEqual(receipts,[{id:'o',state:'failed'}]);receipts.length=0;
  // 409 auth_required is what the real daemon returns when the account is logged out.
  for(const status of [409,401,403,429,500,undefined]){await deliverOnce({daemon:failing(status),weave,sleep:async()=>{}});assert.deepEqual(receipts,[],String(status));}
});
test('the daemon error code is kept for the log',async()=>{
  const daemon=createDaemon({baseUrl:'http://x/v1',token:'t',account:'a',fetcher:async()=>Response.json({error:{code:'auth_required'}},{status:409})});
  await assert.rejects(daemon.send({id:'o',threadId:'t',text:'x'}),e=>e.status===409&&e.code==='auth_required'&&e.message.includes('auth_required'));
});
test('the Weave client posts to the internal route with the bridge token',async()=>{
  let call;const weave=createWeave({origin:'https://weave.example/',token:'t',fetcher:async(url,options)=>{call={url,options};return Response.json({ok:true});}});
  await weave('claim',{});assert.equal(call.url,'https://weave.example/api/internal/wechat/claim');assert.equal(call.options.headers.Authorization,'Bearer t');
  await weave('tick',{},{timeoutMs:170000});assert.equal(call.url,'https://weave.example/api/internal/wechat/tick');
  const failing=createWeave({origin:'https://weave.example',token:'t',fetcher:async()=>new Response('{}',{status:503})});
  await assert.rejects(failing('claim',{}),e=>e.status===503);
});
test('the cursor survives a restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'weave-bridge-'));
  try{const file=join(dir,'nested/cursor.json');assert.equal(await cursorStore(file).load(),'');await cursorStore(file).save('77');assert.equal(await cursorStore(file).load(),'77');}
  finally{await rm(dir,{recursive:true,force:true});}
});

// ── Outbound throttle ──────────────────────────────────────────────────────────────────────
// WeChat's risk control is unverified, so the bridge keeps its own conservative limits on what it sends.
const clockAt = start => { const clock = {t: start, now: () => clock.t, advance(ms) { clock.t += ms; }}; return clock; };
const sendOne = (throttle, job) => { const verdict = throttle.admit(job); if (verdict === 'send') throttle.record(job); return verdict; };

test('throttle: one chat may send its per-minute limit, the rest are held until the minute has passed', () => {
  const clock = clockAt(0), throttle = createThrottle({perChatPerMinute: 3, totalPerMinute: 100, minGapMs: 0, now: clock.now});
  const jobs = ['a', 'b', 'c', 'd', 'e'].map(id => ({id, threadId: 'chat-1'}));
  assert.deepEqual(jobs.map(job => sendOne(throttle, job)), ['send', 'send', 'send', 'hold', 'hold']);
  clock.advance(59_999);
  assert.equal(sendOne(throttle, jobs[3]), 'hold');
  clock.advance(1);
  assert.equal(sendOne(throttle, jobs[3]), 'send');
});

test('throttle: chats are limited separately, and all chats together have a total limit', () => {
  const clock = clockAt(0), throttle = createThrottle({perChatPerMinute: 2, totalPerMinute: 3, minGapMs: 0, now: clock.now});
  assert.deepEqual([['1', 'x'], ['2', 'x'], ['3', 'x'], ['4', 'y']].map(([id, threadId]) => sendOne(throttle, {id, threadId})), ['send', 'send', 'hold', 'send']);
  assert.equal(sendOne(throttle, {id: '5', threadId: 'z'}), 'hold');
  clock.advance(60_000);
  assert.equal(sendOne(throttle, {id: '5', threadId: 'z'}), 'send');
});

test('throttle: a daily limit stops a runaway loop that stays under the per-minute limits', () => {
  const clock = clockAt(0), throttle = createThrottle({perChatPerMinute: 100, totalPerMinute: 100, perDay: 5, minGapMs: 0, now: clock.now});
  const verdicts = [];
  for (let i = 0; i < 7; i++) { verdicts.push(sendOne(throttle, {id: 'j' + i, threadId: 'c' + i})); clock.advance(61_000); }
  assert.deepEqual(verdicts, ['send', 'send', 'send', 'send', 'send', 'hold', 'hold']);
});

test('throttle: a minimum gap between sends is asked for as a wait, not a refusal', () => {
  const clock = clockAt(1000), throttle = createThrottle({minGapMs: 1500, now: clock.now});
  assert.equal(throttle.gap(), 0);
  throttle.record({id: 'a', threadId: 't'});
  clock.advance(500);
  assert.equal(throttle.gap(), 1000);
  clock.advance(1000);
  assert.equal(throttle.gap(), 0);
});

test('throttle: a job held for too long is dropped, so a backlog is never sent hours late', () => {
  const clock = clockAt(0), throttle = createThrottle({perChatPerMinute: 1, minGapMs: 0, maxHoldMs: 600_000, now: clock.now});
  sendOne(throttle, {id: 'first', threadId: 't'});
  const late = {id: 'late', threadId: 't'};
  assert.equal(throttle.admit(late), 'hold');
  clock.advance(600_001);
  // The minute window has long passed, but the job is already too old to be worth sending.
  assert.equal(throttle.admit(late), 'drop');
  assert.equal(sendOne(throttle, {id: 'fresh', threadId: 't'}), 'send');
});

test('throttle: limits come from the environment; anything that is not a positive whole number keeps the default', () => {
  const clock = clockAt(0);
  const throttle = throttleFromEnv({WECHAT_SEND_PER_CHAT_PER_MIN: '2', WECHAT_SEND_TOTAL_PER_MIN: 'many', WECHAT_SEND_MIN_GAP_MS: '0'}, clock.now);
  assert.deepEqual([1, 2, 3].map(i => sendOne(throttle, {id: 'p' + i, threadId: 'c'})), ['send', 'send', 'hold']);
  assert.equal(throttle.gap(), 0);
  const defaults = throttleFromEnv({WECHAT_SEND_PER_CHAT_PER_MIN: '-1', WECHAT_SEND_PER_DAY: '1.5', WECHAT_SEND_MIN_GAP_MS: ''}, clock.now);
  const verdicts = [];
  for (let i = 0; i < 7; i++) verdicts.push(sendOne(defaults, {id: 'd' + i, threadId: 'c'}));
  assert.deepEqual(verdicts, ['send', 'send', 'send', 'send', 'send', 'send', 'hold']);
  assert.ok(defaults.gap() > 0);
});

test('delivery: jobs over the limit are not sent, keep their lease, and go out on a later pass', async () => {
  const clock = clockAt(0), sent = [], receipts = [];
  const throttle = createThrottle({perChatPerMinute: 2, minGapMs: 0, now: clock.now});
  const jobs = [1, 2, 3, 4].map(i => ({id: 'out:' + i, threadId: 'chat-1', text: 'm' + i}));
  const daemon = {send: async job => { sent.push(job.id); return {id: 's' + job.id, state: 'accepted'}; }};
  // Like Weave: what has a receipt is not claimed again; what was held is claimed again on a later pass.
  const done = new Set();
  const weave = async (path, data) => { if (path === 'claim') return {jobs: jobs.filter(job => !done.has(job.id))}; receipts.push(data); done.add(data.id); return {ok: true}; };
  assert.equal(await deliverOnce({daemon, weave, throttle, sleep: async () => {}}), 2);
  assert.deepEqual(sent, ['out:1', 'out:2']);
  assert.deepEqual(receipts, [{id: 'out:1', state: 'accepted'}, {id: 'out:2', state: 'accepted'}]);
  assert.equal(await deliverOnce({daemon, weave, throttle, sleep: async () => {}}), 0);
  clock.advance(60_000);
  assert.equal(await deliverOnce({daemon, weave, throttle, sleep: async () => {}}), 2);
  assert.deepEqual(sent, ['out:1', 'out:2', 'out:3', 'out:4']);
});

test('delivery: a held job that is still held past the limit is reported failed and never sent', async () => {
  const clock = clockAt(0), sent = [], receipts = [];
  const throttle = createThrottle({perChatPerMinute: 1, minGapMs: 0, maxHoldMs: 600_000, now: clock.now});
  const daemon = {send: async job => { sent.push(job.id); return {id: 's', state: 'accepted'}; }};
  const weave = async (path, data) => { if (path === 'claim') return {jobs: [{id: 'out:a', threadId: 't', text: 'a'}, {id: 'out:b', threadId: 't', text: 'b'}]}; receipts.push(data); return {ok: true}; };
  await deliverOnce({daemon, weave, throttle, sleep: async () => {}});
  assert.deepEqual(sent, ['out:a']);
  clock.advance(600_001);
  await deliverOnce({daemon, weave, throttle, sleep: async () => {}});
  assert.ok(!sent.slice(1).includes('out:b'));
  assert.deepEqual(receipts.at(-1), {id: 'out:b', state: 'failed'});
});

test('delivery: the minimum gap is slept between two sends, never before the first', async () => {
  const clock = clockAt(1000), waits = [];
  const throttle = createThrottle({perChatPerMinute: 10, totalPerMinute: 10, minGapMs: 1500, now: clock.now});
  const daemon = {send: async () => ({id: 's', state: 'accepted'})};
  const weave = async path => path === 'claim' ? {jobs: [1, 2, 3].map(i => ({id: 'out:' + i, threadId: 't' + i, text: 'x'}))} : {ok: true};
  const sleep = async ms => { waits.push(ms); clock.advance(ms); };
  assert.equal(await deliverOnce({daemon, weave, throttle, sleep}), 3);
  assert.deepEqual(waits, [1500, 1500]);
});

test('delivery: a send that never reached WeChat (logged out, offline) does not use up the limit', async () => {
  const clock = clockAt(0), throttle = createThrottle({perChatPerMinute: 1, minGapMs: 0, now: clock.now});
  let fail = true;
  const daemon = {send: async () => { if (fail) { const e = Error('auth_required'); e.status = 409; throw e; } return {id: 's', state: 'accepted'}; }};
  const weave = async path => path === 'claim' ? {jobs: [{id: 'out:1', threadId: 't', text: 'x'}]} : {ok: true};
  assert.equal(await deliverOnce({daemon, weave, throttle, sleep: async () => {}}), 0);
  fail = false;
  assert.equal(await deliverOnce({daemon, weave, throttle, sleep: async () => {}}), 1);
});

test('reconnecting to the daemon backs off while it is down or logged out, so the log does not fill up and nobody is hammered', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(reconnectDelay), [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
});
