import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDaemon,createWeave,cursorStore,deliverOnce,forwardable,handleEvent,sseEvents} from '../hosted/wechat-bridge/bridge.mjs';

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
  const failing=createWeave({origin:'https://weave.example',token:'t',fetcher:async()=>new Response('{}',{status:503})});
  await assert.rejects(failing('claim',{}),e=>e.status===503);
});
test('the cursor survives a restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'weave-bridge-'));
  try{const file=join(dir,'nested/cursor.json');assert.equal(await cursorStore(file).load(),'');await cursorStore(file).save('77');assert.equal(await cursorStore(file).load(),'77');}
  finally{await rm(dir,{recursive:true,force:true});}
});
