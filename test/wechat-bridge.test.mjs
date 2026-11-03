import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDaemon,createThrottle,createWeave,cursorStore,deliverOnce,describeEvent,eventFacts,forwardable,handleEvent,reconnectDelay,sseEvents,throttleFromEnv} from '../hosted/wechat-bridge/bridge.mjs';

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
// A logged-out account raises no error in the bridge (the stream stays up, nothing is being sent), so these events are the only
// trace of the drop. The test pattern: the event carries a message body and a name in places they must never be copied from.
test('a session event is logged with its fixed fields and nothing else, and the cursor still advances',async()=>{
  const lines=[],saved=[],acked=[];
  const context={daemon:{message:async()=>{throw Error('should not fetch');},ack:async c=>acked.push(c)},weave:async()=>{throw Error('should not forward');},saveCursor:async c=>saved.push(c),log:line=>lines.push(line)};
  const secret={body:'SECRET-BODY',text:'SECRET-TEXT',nickname:'SECRET-NAME',commands:[{text:'SECRET-COMMAND'}]};
  await handleEvent({cursor:'11',kind:'account.connection',data:{state:'auth_required',source:'polling',serviceCode:-13,authentication:'logged_out',...secret}},context);
  await handleEvent({cursor:'12',kind:'account.updated',data:{accountId:'acc-1',connection:'disconnected',...secret}},context);
  await handleEvent({cursor:'13',kind:'account.updated',data:{authentication:'logged_out'}},context);
  await handleEvent({cursor:'14',kind:'account.push',data:{state:'reconnecting',reason:'connection_unavailable',fallback:'heartbeat_polling',...secret}},context);
  await handleEvent({cursor:'15',kind:'projection.blocked',data:{batchId:'b1',reason:'unsupported_or_unavailable_profile',retryableAfterRepair:true,blockedCommandCount:3,truncated:false,...secret}},context);
  assert.deepEqual(lines,[
    '小号需要重新登录（Mac 上跑 login.sh）：state=auth_required source=polling serviceCode=-13 authentication=logged_out',
    '微信账号：connection=disconnected',
    '微信账号：authentication=logged_out',
    '微信长连接：state=reconnecting reason=connection_unavailable fallback=heartbeat_polling',
    '有同步批次没能写入账号库：reason=unsupported_or_unavailable_profile blockedCommandCount=3 retryableAfterRepair=true',
  ]);
  assert.ok(!lines.join('\n').includes('SECRET'));
  assert.deepEqual(saved,['11','12','13','14','15']);
  assert.deepEqual(acked,['11','12','13','14','15']);
});
test('other connection states are logged too, but ordinary messages and unrelated events are not',async()=>{
  const lines=[];const context={daemon:{message:async()=>incoming,ack:async()=>{}},weave:async()=>{},saveCursor:async()=>{},log:line=>lines.push(line)};
  await handleEvent({cursor:'1',kind:'account.connection',data:{state:'connection_unavailable'}},context);
  await handleEvent({cursor:'2',kind:'message.committed',data:{messageId:'msg_1',direction:'incoming',body:'SECRET-BODY'}},context);
  await handleEvent({cursor:'3',kind:'account.updated',data:{accountId:'acc-1',avatar:'x'}},context);   // nothing about the session in it
  await handleEvent({cursor:'4',kind:'group.updated',data:{state:'x'}},context);
  await handleEvent({cursor:'5',kind:'account.connection',data:{}},context);
  await handleEvent({cursor:'6',kind:'account.connection'},context);
  assert.deepEqual(lines,['微信连接：state=connection_unavailable']);
});
test('a value that is not short and plain never reaches the log, so an event cannot smuggle text or fake a log line into it',()=>{
  const data={state:'auth_required\n2030-01-01T00:00:00.000Z 假的一行',source:'x'.repeat(65),serviceCode:{nested:1},authentication:'a b',ok:'fine'};
  assert.equal(eventFacts({kind:'account.connection',data}),null);
  assert.equal(eventFacts({kind:'account.connection',data:{...data,state:'auth_required',source:'sync'}}),'state=auth_required source=sync');
  assert.equal(describeEvent({kind:'account.connection',data:{...data,state:'auth_required',source:'sync'}}),'小号需要重新登录（Mac 上跑 login.sh）：state=auth_required source=sync');
  assert.equal(eventFacts(null),null);
  assert.equal(eventFacts({kind:'account.connection',data:'text'}),null);
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

// ── a group reply whose @ the daemon cannot resolve (its copy of the member list is missing or partial) is not lost ──────────
const refusal = (status, code) => { const e = Error(`agent-wechat 请求失败 (${status} ${code})`); e.status = status; e.code = code; return e; };
const GROUP = '99999@chatroom';
const groupJob = (extra = {}) => ({id: 'out:1', threadId: GROUP, text: 'SECRET-TEXT 好的', mentions: {userIds: ['wxid_secret_user']}, ...extra});
const harness = jobs => { const receipts = [], logs = []; return {receipts, logs, log: line => logs.push(line), weave: async (path, data) => { if (path === 'claim') return {jobs}; receipts.push(data); return {ok: true}; }}; };
const quick = {sleep: async () => {}};
const memoryOf = () => ({version: new Map(), refreshedAt: new Map()});
const ROSTER = {memberCount: 12, profileProjection: 'complete', completeRoster: true};
// The daemon's member-list refresh: an operation that is running for `running` polls and then ends as `final`. `seen` records what was asked.
const refresher = (final = {state: 'succeeded', result: ROSTER}, running = 1, onDone = () => {}) => {
  const seen = {groups: [], polls: 0};
  return {seen,
    refreshMembers: async group => { seen.groups.push(group); return {id: 'op1', state: 'queued'}; },
    operation: async () => { seen.polls++; if (seen.polls <= running) return {id: 'op1', state: 'running'}; onDone(final); return {id: 'op1', ...final}; }};
};
// A daemon that refuses the @ with `refused` until a refresh has succeeded (the real one reads its own copy of the member list), and
// records every send as [key, hasMentions].
const strictDaemon = ({refused = refusal(404, 'media_not_cached'), final, running, sendState = 'accepted'} = {}) => {
  let listed = false;
  const sent = [], r = refresher(final, running, done => { if (done.state === 'succeeded') listed = true; });
  return {sent, seen: r.seen, refreshMembers: r.refreshMembers, operation: r.operation,
    send: async job => { sent.push([job.id, !!job.mentions]); if (job.mentions && !listed) throw refused; return {id: 's' + sent.length, state: sendState}; }};
};

test('delivery: an @ the daemon refuses is tried again after the group\'s member list was refreshed, with the same key, and the answer keeps its @', async () => {
  const daemon = strictDaemon(), h = harness([groupJob()]);
  assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, ...quick}), 1);
  assert.deepEqual(daemon.sent, [['out:1', true], ['out:1', true]]);
  assert.deepEqual(daemon.seen.groups, [GROUP]);
  assert.equal(daemon.seen.polls, 2);                      // running once, then done
  assert.deepEqual(h.receipts, [{id: 'out:1', state: 'accepted'}]);
  assert.deepEqual(h.logs, [
    '群消息带 @ 被拒（404 media_not_cached），先向微信刷新这个群的成员：out:1',
    '群成员刷新结束（succeeded，成员 12，名单完整 true）：out:1',
    '刷新后带 @ 重发被守护进程收下：out:1',
  ]);
});

test('delivery: the 409 mention codes take the same path, and 400 invalid_mentions goes straight to the plain version because no member list can help', async () => {
  for (const code of ['mention_member_unavailable', 'mention_group_membership_unavailable', 'profile_unavailable']) {
    const daemon = strictDaemon({refused: refusal(409, code), sendState: 'succeeded'}), h = harness([groupJob()]);
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, ...quick}), 1, code);
    assert.deepEqual(daemon.sent, [['out:1', true], ['out:1', true]], code);
    assert.deepEqual(h.receipts, [{id: 'out:1', state: 'succeeded'}], code);
    assert.equal(h.logs[0], `群消息带 @ 被拒（409 ${code}），先向微信刷新这个群的成员：out:1`);
  }
  const daemon = strictDaemon({refused: refusal(400, 'invalid_mentions')}), h = harness([groupJob()]);
  assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, ...quick}), 1);
  assert.deepEqual(daemon.sent, [['out:1', true], ['out:1:plain', false]]);
  assert.deepEqual(daemon.seen.groups, []);
  assert.deepEqual(h.logs, ['群消息带 @ 被拒（400 invalid_mentions），已去掉 @ 重发：out:1']);
});

test('delivery: if the refresh fails, ends badly or does not end in 60 s, the answer goes out without the @ under the :plain key', async () => {
  const cases = [
    ['the request is refused', {refreshMembers: async () => { throw refusal(500, 'operation_failed'); }}, ['刷新群成员没有成功（500 operation_failed）：out:1']],
    ['the operation fails', refresher({state: 'failed', result: {code: 'operation_failed'}}), ['群成员刷新结束（failed，成员 -，名单完整 -）：out:1']],
    ['the operation is cancelled', refresher({state: 'cancelled', result: {}}), ['群成员刷新结束（cancelled，成员 -，名单完整 -）：out:1']],
    ['the operation never ends', refresher({state: 'running', result: {}}, Infinity), ['群成员刷新 60 秒内没有结束（running）：out:1']],
  ];
  for (const [name, refreshing, line] of cases) {
    const sent = [], h = harness([groupJob()]);
    const daemon = {...refreshing, send: async job => { sent.push([job.id, !!job.mentions]); if (job.mentions) throw refusal(404, 'media_not_cached'); return {id: 's2', state: 'accepted'}; }};
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, ...quick}), 1, name);
    assert.deepEqual(sent, [['out:1', true], ['out:1:plain', false]], name);
    assert.deepEqual(h.receipts, [{id: 'out:1', state: 'accepted'}], name);
    assert.deepEqual(h.logs, ['群消息带 @ 被拒（404 media_not_cached），先向微信刷新这个群的成员：out:1', ...line, '群消息带 @ 被拒（404 media_not_cached），已去掉 @ 重发：out:1'], name);
    if (name === 'the operation never ends') assert.equal(refreshing.seen.polls, 60);
  }
});

test('delivery: if the @ is still refused after the refresh, the answer goes out without it', async () => {
  const sent = [], r = refresher(), h = harness([groupJob()]);
  const daemon = {...r, send: async job => { sent.push([job.id, !!job.mentions]); if (job.mentions) throw refusal(sent.length === 1 ? 404 : 409, sent.length === 1 ? 'media_not_cached' : 'mention_member_unavailable'); return {id: 's3', state: 'accepted'}; }};
  assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, ...quick}), 1);
  assert.deepEqual(sent, [['out:1', true], ['out:1', true], ['out:1:plain', false]]);
  assert.deepEqual(h.receipts, [{id: 'out:1', state: 'accepted'}]);
  assert.deepEqual(h.logs, [
    '群消息带 @ 被拒（404 media_not_cached），先向微信刷新这个群的成员：out:1',
    '群成员刷新结束（succeeded，成员 12，名单完整 true）：out:1',
    '刷新后带 @ 重发仍被拒（409 mention_member_unavailable），已去掉 @ 重发：out:1',
  ]);
});

test('delivery: a send the daemon took and then ended as failed because of the @ (errorCode) is tried again after a refresh under the :m2 key; if that fails too it goes out plain', async () => {
  for (const code of ['mention_member_unavailable', 'mention_group_membership_unavailable', 'mention_all_forbidden', 'mention_all_permission_unavailable', 'profile_unavailable']) {
    const sent = [], r = refresher(), h = harness([groupJob()]);
    const daemon = {...r,
      send: async job => { sent.push([job.id, !!job.mentions]); return {id: 's' + sent.length, state: 'queued'}; },
      sendStatus: async id => id === 's1' ? {id, state: 'failed', errorCode: code} : {id, state: 'accepted'}};
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, ...quick}), 1, code);
    assert.deepEqual(sent, [['out:1', true], ['out:1:m2', true]], code);   // the first key holds the failed send
    assert.deepEqual(h.receipts, [{id: 'out:1', state: 'accepted'}], code);
    assert.deepEqual(h.logs, [`群消息带 @ 发送失败（failed ${code}），先向微信刷新这个群的成员：out:1`, '群成员刷新结束（succeeded，成员 12，名单完整 true）：out:1', '刷新后带 @ 重发被守护进程收下：out:1'], code);
  }
  const sent = [], h = harness([groupJob()]);
  const daemon = {...refresher(),
    send: async job => { sent.push([job.id, !!job.mentions]); return {id: 's' + sent.length, state: 'queued'}; },
    sendStatus: async id => id === 's3' ? {id, state: 'accepted'} : {id, state: 'failed', errorCode: 'mention_member_unavailable'}};
  assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, ...quick}), 1);
  assert.deepEqual(sent, [['out:1', true], ['out:1:m2', true], ['out:1:plain', false]]);
  assert.deepEqual(h.receipts, [{id: 'out:1', state: 'accepted'}]);
  assert.equal(h.logs.at(-1), '刷新后带 @ 重发仍发送失败（failed mention_member_unavailable），已去掉 @ 重发：out:1');
  // Failed for another reason: reported as it is, no refresh, nothing sent again.
  const other = harness([groupJob()]), otherSent = [], r = refresher();
  await deliverOnce({daemon: {...r, send: async job => { otherSent.push(job.id); return {id: 's1', state: 'queued'}; }, sendStatus: async () => ({id: 's1', state: 'failed', errorCode: 'worker_interrupted'})}, weave: other.weave, log: other.log, ...quick});
  assert.deepEqual(otherSent, ['out:1']);
  assert.deepEqual(r.seen.groups, []);
  assert.deepEqual(other.receipts, [{id: 'out:1', state: 'failed'}]);
  assert.deepEqual(other.logs, ['发送结果是 failed（worker_interrupted），已原样报告给 Weave：out:1']);
});

test('delivery: a group\'s member list is asked for at most once per 10 minutes, and a refresh that failed counts too', async () => {
  let t = 1_000_000;
  const memory = memoryOf(), sent = [], r = refresher({state: 'failed', result: {}});
  const daemon = {...r, send: async job => { sent.push([job.id, !!job.mentions]); if (job.mentions) throw refusal(404, 'media_not_cached'); return {id: 's', state: 'accepted'}; }};
  const h = harness([groupJob(), groupJob({id: 'out:2'})]);
  const run = () => deliverOnce({daemon, weave: h.weave, log: h.log, memory, now: () => t, ...quick});
  assert.equal(await run(), 2);
  assert.deepEqual(r.seen.groups, [GROUP]);                // out:1 asked; out:2, same group, did not
  assert.ok(h.logs.includes('这个群的成员 10 分钟内刷新过了，这次不再刷新：out:2'));
  assert.deepEqual(sent.filter(([id]) => id.endsWith(':plain')).map(([id]) => id), ['out:1:plain', 'out:2:plain']);
  t += 599_000;
  await run();
  assert.equal(r.seen.groups.length, 1);                   // 599 s later: still not
  t += 2_000;
  await run();
  assert.equal(r.seen.groups.length, 2);                   // past 10 minutes: asked again
});

test('delivery: a refusal that is not about the @ is not retried or refreshed: logged and reported failed, or kept for later when the daemon is logged out', async () => {
  const cases = [
    [groupJob(), refusal(404, 'not_found'), 'failed', '守护进程拒绝了这条消息（404 not_found），已向 Weave 报告发送失败：out:1'],
    [groupJob({mentions: undefined}), refusal(404, 'media_not_cached'), 'failed', '守护进程拒绝了这条消息（404 media_not_cached），已向 Weave 报告发送失败：out:1'],   // a private reply has no @ to drop
    [groupJob(), refusal(400, 'invalid_request'), 'failed', '守护进程拒绝了这条消息（400 invalid_request），已向 Weave 报告发送失败：out:1'],
    [groupJob(), refusal(409, 'auth_required'), null, '消息暂时发不出去，稍后用同一幂等键重试：agent-wechat 请求失败 (409 auth_required)'],
  ];
  for (const [job, error, receipt, line] of cases) {
    let calls = 0;
    const h = harness([job]), r = refresher();
    await deliverOnce({daemon: {...r, send: async () => { calls++; throw error; }}, weave: h.weave, log: h.log, ...quick});
    assert.equal(calls, 1, line);
    assert.deepEqual(r.seen.groups, [], line);
    assert.deepEqual(h.receipts, receipt ? [{id: 'out:1', state: receipt}] : [], line);
    assert.deepEqual(h.logs, [line]);
  }
});

test('delivery: an end state of failed, cancelled or needs_review is logged with the job id and state (and the daemon\'s errorCode); accepted and succeeded are not', async () => {
  for (const [state, errorCode, line] of [
    ['needs_review', null, '发送结果是 needs_review，已原样报告给 Weave：out:1'],
    ['cancelled', null, '发送结果是 cancelled，已原样报告给 Weave：out:1'],
    ['failed', 'worker_interrupted', '发送结果是 failed（worker_interrupted），已原样报告给 Weave：out:1'],
    ['accepted', null, null],
    ['succeeded', null, null],
  ]) {
    const h = harness([{id: 'out:1', threadId: GROUP, text: 'SECRET-TEXT'}]);
    await deliverOnce({daemon: {send: async () => ({id: 's', state, errorCode})}, weave: h.weave, log: h.log, ...quick});
    assert.deepEqual(h.receipts, [{id: 'out:1', state}], state);
    assert.deepEqual(h.logs, line ? [line] : [], state);
  }
});

test('delivery: a retry that is not finished keeps the lease, and the next claim continues with that same version: the same key after a refresh, :m2, or :plain, never the @ version twice', async () => {
  // (a) refreshed, the @ version taken but not finished: the claim after it replays the same key (the daemon answers with the same send)
  {
    const sent = [], memory = memoryOf(), h = harness([groupJob()]);
    let listed = false, finished = false;
    const r = refresher(undefined, 1, () => { listed = true; });
    const daemon = {...r, send: async job => { sent.push([job.id, !!job.mentions]); if (job.mentions && !listed) throw refusal(404, 'media_not_cached'); return {id: 's2', state: finished ? 'accepted' : 'queued'}; }, sendStatus: async () => ({id: 's2', state: finished ? 'accepted' : 'queued'})};
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, attempts: 2, memory, ...quick}), 0);
    assert.deepEqual(h.receipts, []);
    finished = true;
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, attempts: 2, memory, ...quick}), 1);
    assert.deepEqual(sent, [['out:1', true], ['out:1', true], ['out:1', true]]);
    assert.equal(r.seen.groups.length, 1);                 // one refresh, however many claims
    assert.equal(memory.version.size, 0);
  }
  // (b) the :m2 version taken but not finished: the claim after it goes straight to :m2 (the first key holds a failed send)
  {
    const sent = [], memory = memoryOf(), h = harness([groupJob()]);
    let finished = false;
    const daemon = {...refresher(),
      send: async job => { sent.push([job.id, !!job.mentions]); return {id: job.id.endsWith(':m2') ? 's2' : 's1', state: 'queued'}; },
      sendStatus: async id => id === 's1' ? {id, state: 'failed', errorCode: 'mention_member_unavailable'} : {id, state: finished ? 'accepted' : 'queued'}};
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, attempts: 2, memory, ...quick}), 0);
    finished = true;
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, attempts: 2, memory, ...quick}), 1);
    assert.deepEqual(sent, [['out:1', true], ['out:1:m2', true], ['out:1:m2', true]]);
    assert.deepEqual(h.receipts, [{id: 'out:1', state: 'accepted'}]);
  }
  // (c) the plain version taken but not finished: the claim after it goes straight to :plain, so the @ version cannot also go out
  {
    const sent = [], memory = memoryOf(), h = harness([groupJob()]);
    let finished = false;
    const daemon = {...refresher({state: 'failed', result: {}}),
      send: async job => { sent.push([job.id, !!job.mentions]); if (job.mentions) throw refusal(404, 'media_not_cached'); return {id: 's2', state: finished ? 'accepted' : 'queued'}; },
      sendStatus: async () => ({id: 's2', state: finished ? 'accepted' : 'queued'})};
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, attempts: 2, memory, ...quick}), 0);
    finished = true;
    assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, attempts: 2, memory, ...quick}), 1);
    assert.deepEqual(sent, [['out:1', true], ['out:1:plain', false], ['out:1:plain', false]]);
    assert.equal(h.logs.filter(line => line.includes('已去掉 @ 重发')).length, 1);     // the fallback is logged once, not on every claim
    assert.equal(memory.version.size, 0);                  // forgotten once reported
  }
});

test('delivery: if the plain version cannot be taken right now (logged out), the lease is kept and the next claim sends only that', async () => {
  const sent = [], memory = memoryOf(), h = harness([groupJob()]);
  let loggedOut = true;
  const daemon = {...refresher({state: 'failed', result: {}}), send: async job => { sent.push([job.id, !!job.mentions]); if (job.mentions) throw refusal(409, 'mention_member_unavailable'); if (loggedOut) throw refusal(409, 'auth_required'); return {id: 's2', state: 'accepted'}; }};
  assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, memory, ...quick}), 0);
  assert.deepEqual(h.receipts, []);
  loggedOut = false;
  assert.equal(await deliverOnce({daemon, weave: h.weave, log: h.log, memory, ...quick}), 1);
  assert.deepEqual(sent, [['out:1', true], ['out:1:plain', false], ['out:1:plain', false]]);
  assert.deepEqual(h.receipts, [{id: 'out:1', state: 'accepted'}]);
});

test('delivery: nothing the new log lines print can carry the message text, the thread id or a user id', async () => {
  const secrets = ['SECRET-TEXT', GROUP, 'wxid_secret_user'];
  const dirty = secrets.join(' ');
  const leaky = (status, code) => { const e = Error(`${status} ${dirty}`); e.status = status; e.code = code; return e; };
  const logs = [];
  const run = async daemon => { const h = harness([groupJob()]); await deliverOnce({daemon, weave: h.weave, log: line => logs.push(line), memory: memoryOf(), ...quick}); };
  const hostile = {state: dirty, result: {memberCount: dirty, completeRoster: dirty}};
  // the @ is refused, the refresh ends with hostile fields, the retry is refused with hostile text, the plain retry fails with a hostile errorCode
  await run({...refresher(hostile), send: async job => { if (job.mentions) throw leaky(404, 'media_not_cached'); return {id: 's', state: 'failed', errorCode: dirty}; }});
  await run({...refresher({state: 'succeeded', result: {memberCount: dirty, completeRoster: dirty}}), send: async job => { if (job.mentions) throw leaky(409, 'mention_member_unavailable'); return {id: 's', state: 'accepted'}; }});
  await run({refreshMembers: async () => { throw leaky(500, dirty); }, send: async job => { if (job.mentions) throw leaky(404, 'media_not_cached'); return {id: 's', state: 'accepted'}; }});
  await run({send: async () => { throw leaky(404, dirty); }});                                                  // refused with a code that is not a plain word
  await run({send: async () => { throw leaky(400, undefined); }});                                              // a rejection with no code at all
  await run({...refresher(), send: async () => ({id: 's1', state: 'queued'}), sendStatus: async () => ({id: 's1', state: 'failed', errorCode: 'mention_member_unavailable'})});   // the async path
  await run({send: async () => ({id: 's', state: 'needs_review', errorCode: dirty})});
  assert.ok(logs.length >= 12, logs.join('\n'));
  for (const secret of secrets) assert.ok(!logs.join('\n').includes(secret), `${secret} leaked into: ${logs.join(' | ')}`);
});

test('the daemon client refreshes a group\'s members and follows the operation with read-scope routes', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({url, options}); return Response.json({id: 'op 1', state: 'queued'}, {status: 202}); };
  const daemon = createDaemon({baseUrl: 'http://127.0.0.1:6174/v1/', token: 'tok', account: 'acc 1', fetcher});
  assert.equal((await daemon.refreshMembers(GROUP)).id, 'op 1');
  assert.equal(calls[0].url, 'http://127.0.0.1:6174/v1/accounts/acc%201/groups/99999%40chatroom/members/refresh');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
  await daemon.operation('op 1');
  assert.equal(calls[1].url, 'http://127.0.0.1:6174/v1/accounts/acc%201/operations/op%201');
  assert.equal(calls[1].options.method, undefined);
});

test('reconnecting to the daemon backs off while it is down or logged out, so the log does not fill up and nobody is hammered', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(reconnectDelay), [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
});
