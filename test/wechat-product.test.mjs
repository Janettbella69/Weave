import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {ensurePerson} from '../hosted/lib/weave/domain.mjs';
import {hash,seal} from '../hosted/lib/weave/crypto.mjs';
import {runScheduled} from '../hosted/lib/weave/scheduler.mjs';
import {groupRecord} from '../hosted/lib/weave/wechat.mjs';

const secret='ab'.repeat(32),token='bridge-token-'+'x'.repeat(32),wechat={token};
const start=Date.parse('2030-01-01T00:00:00Z'),ROOM='123456@chatroom';
async function setup(){
  const db=new D1(),store=new Store(db),world=await store.load(),id='u:'+await hash('alice');
  ensurePerson(world,{userId:id,displayName:'Alice'});await store.save(world);let now=start,seq=0;
  const call=async(identity,path,data,headers={})=>{const r=await handleAPI(new Request('https://weave.example/api/'+path,{method:data===undefined?'GET':'POST',headers:data?{Origin:'https://weave.example','Content-Type':'application/json',...headers}:headers,body:data?JSON.stringify(data):undefined}),{db,secret,identity:identity?{userId:identity,displayName:identity,email:identity+'@example.test'}:null,wechat,now});return {status:r.status,data:await r.json()};};
  const bridge=(path,data,bearer=token)=>call(null,'internal/wechat/'+path,data,{Authorization:'Bearer '+bearer});
  const message=(body,over={})=>({id:'msg_'+(++seq),threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body,createdAt:new Date(now).toISOString(),mentions:{state:'known',userIds:[],self:false,all:false,source:null},...over});
  const group=(sender,body,mentioned=false,over={})=>message(body,{threadId:ROOM,senderId:sender,mentions:{state:'known',userIds:mentioned?['wxid-bot']:[],self:mentioned,all:false,source:'msgsource.atuserlist'},...over});
  const bind=async()=>{const code=(await call('alice','wechat/bind',{})).data.instruction;return bridge('events',message(code));};
  const read=()=>new Store(db).load();
  return {db,id,call,bridge,message,group,bind,read,setNow(v){now=v;},get now(){return now;}};
}
// A model stub: records what the group prompt actually received.
function schedule(h,reply='收到',seen=[]){
  const fetcher=async(_url,options)=>{const b=JSON.parse(options.body);seen.push(b);return Response.json({content:[{type:'text',text:reply}],stop_reason:'end_turn'});};
  return runScheduled({db:h.db,secret,env:{WECHAT_BRIDGE_TOKEN:token},agentProviderApiKey:'managed-provider-key',fetcher,now:h.now});
}

test('the tick endpoint needs the bridge token and does the scheduled work',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.message('你好'));
  assert.equal((await h.call(null,'internal/wechat/tick',{})).status,401);
  const r=await h.bridge('tick',{});
  // No model is configured in this harness, so the message is attempted and recorded as uncertain.
  assert.equal(r.status,200);assert.equal(r.data.processed,1);
  assert.equal(Object.values((await h.read()).wechat).filter(x=>x.direction==='inbound'&&x.status==='queued').length,0);
});
test('bridge endpoints reject a missing or wrong token',async()=>{
  const h=await setup();
  assert.equal((await h.call(null,'internal/wechat/claim',{})).status,401);
  assert.equal((await h.bridge('claim',{},'wrong-token-'+'y'.repeat(32))).status,401);
  assert.equal((await h.bridge('claim',{})).status,200);
});
test('private messages bind once, then queue for the bound person and are never duplicated',async()=>{
  const h=await setup();
  assert.equal((await h.call('alice','status')).data.settings.wechat.configured,true);
  assert.equal((await h.bind()).data.bound,true);
  const hello=h.message('你好');
  assert.equal((await h.bridge('events',hello)).data.queued,true);
  assert.equal((await h.bridge('events',hello)).data.duplicate,true);
  const world=await h.read();
  assert.equal(Object.values(world.wechat).filter(x=>x.direction==='inbound'&&x.status==='queued').length,1);
  assert.equal((await h.call('alice','wechat/unbind',{})).status,200);
});
test('a stranger private message is dropped without keeping its text',async()=>{
  const h=await setup();
  assert.equal((await h.bridge('events',h.message('我的秘密',{threadId:'wxid-stranger',senderId:'wxid-stranger'}))).data.ignored,true);
  assert.ok(!JSON.stringify(await h.read()).includes('我的秘密'));
});
test('non-text, outgoing and malformed messages are ignored',async()=>{
  const h=await setup();await h.bind();
  for(const over of [{type:3},{direction:'outgoing'},{body:''},{body:'x'.repeat(4001)}])assert.equal((await h.bridge('events',h.message('你好',over))).data.ignored,true);
  assert.equal((await h.bridge('events',{threadId:'wxid-alice'})).data.ignored,true);
});
test('private replies go out through the bridge once, keyed for idempotent resend',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.message('你好'));
  assert.equal((await schedule(h,'你好呀')).processed,1);
  const {jobs}=(await h.bridge('claim',{})).data;
  const texts=jobs.map(j=>j.text);assert.ok(texts.includes('你好呀'));
  assert.ok(jobs.every(j=>j.threadId==='wxid-alice'&&!j.mentions));
  assert.deepEqual((await h.bridge('claim',{})).data.jobs,[]);
  for(const job of jobs)assert.equal((await h.bridge('receipt',{id:job.id,state:'accepted'})).data.ok,true);
  h.setNow(start+3600000);assert.deepEqual((await h.bridge('claim',{})).data.jobs,[]);
});
test('a send that lost its receipt is re-claimed with the same id after the lease',async()=>{
  const h=await setup();await h.bind();
  const first=(await h.bridge('claim',{})).data.jobs[0];
  assert.deepEqual((await h.bridge('claim',{})).data.jobs,[]);
  h.setNow(start+6*60000);
  assert.equal((await h.bridge('claim',{})).data.jobs[0].id,first.id);
});
test('needs_review stops retries instead of resending',async()=>{
  const h=await setup();await h.bind();
  const job=(await h.bridge('claim',{})).data.jobs[0];
  await h.bridge('receipt',{id:job.id,state:'needs_review'});
  h.setNow(start+3600000);assert.deepEqual((await h.bridge('claim',{})).data.jobs,[]);
  assert.equal((await h.read()).wechat[job.id].status,'uncertain');
});
test('due reminders are queued for the bound person once',async()=>{
  const h=await setup(),store=new Store(h.db),world=await store.load(),person=world.people[h.id];
  person.settings.wechatWxidHash=await hash('wxid-alice');person.settings.wechatWxid=await seal('wxid-alice',secret,h.id);
  person.reminders.push({id:'r1',text:'喝水',dueAt:new Date(start-1000).toISOString(),status:'scheduled',createdAt:new Date(start-60000).toISOString()});await store.save(world);
  const first=await schedule(h);assert.equal(first.delivered,1);assert.equal(first.queued,1);
  assert.deepEqual((await h.bridge('claim',{})).data.jobs.map(j=>[j.threadId,j.text]),[['wxid-alice','提醒你：喝水']]);
  assert.equal((await schedule(h)).queued,0);
});
test('an unenabled group leaves no trace, even when the bot is mentioned',async()=>{
  const h=await setup();await h.bind();const before=JSON.stringify((await h.read()).wechat);
  for(const m of [h.group('wxid-bob','Bob 的秘密'),h.group('wxid-bob','@助理 Bob 的问题',true)])assert.equal((await h.bridge('events',m)).data.ignored,true);
  const world=await h.read(),dump=JSON.stringify(world);
  assert.ok(!dump.includes('Bob'));assert.equal(JSON.stringify(world.wechat),before);
});
test('only a bound member can enable a group, and enabling announces that it reads messages',async()=>{
  const h=await setup();await h.bind();
  await h.bridge('claim',{});
  assert.equal((await h.bridge('events',h.group('wxid-bob','@助理 开启打卡群',true))).data.denied,true);
  assert.equal(groupRecord(await h.read(),await hash(ROOM)),undefined);
  assert.equal((await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true))).data.enabled,true);
  const jobs=(await h.bridge('claim',{})).data.jobs,enabled=jobs.find(j=>j.text.includes('已开启'));
  assert.equal(enabled.threadId,ROOM);assert.match(enabled.text,/别记/);assert.match(enabled.text,/关闭打卡群/);
});
test('group messages become sealed context, without a model call unless the bot is mentioned',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  assert.equal((await h.bridge('events',h.group('wxid-bob','今天走了八千步'))).data.stored,true);
  const dump=JSON.stringify(await h.read());assert.ok(!dump.includes('八千步'));assert.ok(!dump.includes('wxid-bob'));
  const seen=[];assert.equal((await schedule(h,'x',seen)).processed,0);assert.equal(seen.length,0);
});
test('a duplicate group event is not stored twice',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  const m=h.group('wxid-bob','一条消息');await h.bridge('events',m);
  assert.equal((await h.bridge('events',m)).data.duplicate,true);
  const seen=[];await h.bridge('events',h.group('wxid-bob','@助理 怎么样',true));await schedule(h,'好',seen);
  const prompt=JSON.stringify(seen[0]);assert.equal(prompt.split('一条消息').length-1,1);
});
test('「别记」messages are not stored and do not trigger a reply',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  assert.equal((await h.bridge('events',h.group('wxid-bob','别记 我今天情绪很差'))).data.skipped,true);
  assert.equal((await h.bridge('events',h.group('wxid-bob','@助理 别记 我今天情绪很差',true))).data.skipped,true);
  const seen=[];await h.bridge('events',h.group('wxid-bob','@助理 今天如何',true));await schedule(h,'好',seen);
  assert.ok(!JSON.stringify(seen).includes('情绪很差'));
});
test('a group reply sees only the group: never private memory, ids or other groups',async()=>{
  const h=await setup();await h.bind();
  const store=new Store(h.db),world=await store.load();world.people[h.id].profile.goal='PRIVATE_GOAL_减到50公斤';world.people[h.id].checkins.push({id:'c',text:'PRIVATE_FEEDBACK',createdAt:new Date(start).toISOString()});await store.save(world);
  await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  await h.bridge('events',h.group('wxid-bob','今天走了八千步'));
  await h.bridge('events',h.group('wxid-alice','@助理 我们这周怎么样',true));
  const seen=[];assert.equal((await schedule(h,'你们这周都在坚持',seen)).processed,1);
  const prompt=JSON.stringify(seen[0]);
  assert.match(prompt,/八千步/);assert.match(prompt,/这周怎么样/);
  for(const secretText of ['PRIVATE_GOAL','PRIVATE_FEEDBACK','wxid-bob','wxid-alice'])assert.ok(!prompt.includes(secretText),secretText);
  await h.bridge('claim',{});
});
test('a group reply mentions the asker and is not written into personal memory',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));await h.bridge('claim',{});
  await h.bridge('events',h.group('wxid-bob','@助理 今天怎么样',true));await schedule(h,'今天不错');
  const job=(await h.bridge('claim',{})).data.jobs.find(j=>j.text==='今天不错');
  assert.equal(job.threadId,ROOM);assert.deepEqual(job.mentions,{userIds:['wxid-bob']});
  const person=(await h.read()).people[h.id];
  assert.ok(!JSON.stringify(person.messages).includes('今天不错'));assert.ok(!JSON.stringify(person.messages).includes('今天怎么样'));
});
test('after sending, group text is scrubbed from the queue',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));await h.bridge('claim',{});
  await h.bridge('events',h.group('wxid-bob','@助理 今天怎么样',true));await schedule(h,'今天不错');
  const job=(await h.bridge('claim',{})).data.jobs.find(j=>j.text==='今天不错');await h.bridge('receipt',{id:job.id,state:'accepted'});
  const dump=JSON.stringify((await h.read()).wechat);assert.ok(!dump.includes('今天不错'));assert.ok(!dump.includes('今天怎么样'));
});
test('any member can close a group, which deletes its context and stops reading',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  await h.bridge('events',h.group('wxid-bob','今天走了八千步'));
  assert.equal((await h.bridge('events',h.group('wxid-bob','@助理 关闭打卡群',true))).data.closed,true);
  assert.equal(groupRecord(await h.read(),await hash(ROOM)),undefined);
  assert.equal((await h.bridge('events',h.group('wxid-bob','继续说话'))).data.ignored,true);
  const jobs=(await h.bridge('claim',{})).data.jobs;assert.ok(jobs.some(j=>j.threadId===ROOM&&j.text.includes('已关闭')));
});
test('messages older than six hours are context only, so a sleeping Mac does not cause stale replies',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  const old=new Date(start-7*3600000).toISOString();
  assert.equal((await h.bridge('events',h.group('wxid-bob','@助理 还在吗',true,{createdAt:old}))).data.stored,true);
  assert.equal((await h.bridge('events',h.message('昨晚的私聊',{createdAt:old}))).data.stale,true);
  const seen=[];assert.equal((await schedule(h,'x',seen)).processed,0);assert.equal(seen.length,0);
});
test('group replies have no daily cap: every @ in one day is queued',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  let queued=0;for(let i=0;i<32;i++)if((await h.bridge('events',h.group('wxid-bob','@助理 第'+i+'次',true))).data.queued)queued++;
  assert.equal(queued,32);
});
test('group context stays bounded',async()=>{
  const h=await setup();await h.bind();await h.bridge('events',h.group('wxid-alice','@助理 开启打卡群',true));
  for(let i=0;i<60;i++)await h.bridge('events',h.group('wxid-bob','消息'+i));
  const seen=[];await h.bridge('events',h.group('wxid-bob','@助理 总结',true));await schedule(h,'好',seen);
  const prompt=JSON.stringify(seen[0]);assert.ok(!prompt.includes('消息0"'));assert.ok(prompt.includes('消息59'));
});
