import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {ensurePerson} from '../hosted/lib/weave/domain.mjs';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {HERMES_REVISION} from '../hosted/lib/weave/proactivity.mjs';
import {runScheduled} from '../hosted/lib/weave/scheduler.mjs';
import {seal} from '../hosted/lib/weave/crypto.mjs';

const secret='ab'.repeat(32), config={baseUrl:'https://gewechat.example/v2/api',token:'ge-token',appId:'app-id',callbackSecret:'callback-secret-12345678901234567890',publicOrigin:'https://weave.example'};
async function setup(){
  const db=new D1(),store=new Store(db),world=await store.load(),id='u:'+await hash('alice');
  ensurePerson(world,{userId:id,displayName:'Alice'});await store.save(world);let now=Date.parse('2030-01-01T00:00:00Z');
  const request=async(name,path,data,headers={})=>{const r=await handleAPI(new Request('https://weave.example/api/'+path,{method:data===undefined?'GET':'POST',headers:data?{Origin:'https://weave.example','Content-Type':'application/json',...headers}:headers,body:data?JSON.stringify(data):undefined}),{db,secret,identity:name?{userId:name,displayName:name,email:name+'@example.test'}:null,gewechat:config,now,fetcher:async(url,options)=>{if(url.endsWith('/tools/setCallback'))return Response.json({ret:200});return Response.json({ret:200});}});return {status:r.status,data:await r.json()};};
  return {db,request,id,store,setNow(v){now=v;}};
}
function payload(text,id='1'){return {TypeName:'AddMsg',Appid:'app-id',Wxid:'wxid-bot',Data:{MsgType:1,FromUserName:'wxid-alice',ToUserName:'wxid-bot',NewMsgId:id,Content:text}};}
test('authenticated product binds a WeChat identity and queues messages for Cron',async()=>{
  const h=await setup(),status=await h.request('alice','status');assert.equal(status.data.settings.wechat.configured,true);
  const binding=await h.request('alice','wechat/bind',{});assert.match(binding.data.instruction,/绑定/);
  const callback=await h.request(null,'gewechat/callback/'+config.callbackSecret,payload(binding.data.instruction));assert.equal(callback.status,200);assert.equal(callback.data.bound,true);
  const duplicate=await h.request(null,'gewechat/callback/'+config.callbackSecret,payload('你好','2'));assert.equal(duplicate.data.queued,true);
  const world=await new Store(h.db).load();assert.equal(Object.values(world.wechat).filter(x=>x.status==='queued').length,2);
  assert.equal((await h.request('alice','wechat/unbind',{})).status,200);
});
test('product callback rejects wrong secret and Cron registration is explicit',async()=>{
  const h=await setup();assert.equal((await h.request(null,'gewechat/callback/wrong',payload('你好'))).status,403);
  assert.equal((await h.request('alice','wechat/register',{})).status,200);
});
test('the scheduled Worker delivers due reminders to a bound WeChat account once',async()=>{
  const h=await setup(),world=await new Store(h.db).load(),person=world.people[h.id],now=Date.parse('2030-01-01T00:00:00Z');
  person.settings.wechatWxidHash=await hash('wxid-alice');person.settings.wechatWxid=await seal('wxid-alice',secret,h.id);
  person.reminders.push({id:'r1',text:'喝水',dueAt:new Date(now-1000).toISOString(),status:'scheduled',createdAt:new Date(now-60000).toISOString()});await h.store.save(world);
  const sent=[];const options={baseUrl:config.baseUrl,token:config.token,appId:config.appId};
  const first=await runScheduled({db:h.db,secret,env:{...config,WEAVE_ENCRYPTION_KEY:secret},now,clientFactory:()=>({sendText:async(to,text)=>sent.push({to,text})})});
  assert.equal(first.delivered,1);assert.equal(first.sent,1);assert.deepEqual(sent,[{to:'wxid-alice',text:'提醒你：喝水'}]);
  const second=await runScheduled({db:h.db,secret,env:{...config,WEAVE_ENCRYPTION_KEY:secret},now:now+60000,clientFactory:()=>({sendText:async(to,text)=>sent.push({to,text})})});assert.equal(second.sent,0);assert.equal(sent.length,1);void options;
});
