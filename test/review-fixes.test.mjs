import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {runScheduled} from '../hosted/lib/weave/scheduler.mjs';
import {ASSESSMENT_SYSTEM} from '../hosted/lib/weave/proactivity.mjs';
import {GROUP_SYSTEM} from '../hosted/lib/weave/wechat.mjs';
import {SAFETY_RULES} from '../hosted/lib/weave/model.mjs';
import {modelBudgetConfig} from '../hosted/lib/weave/budget.mjs';

const secret='ab'.repeat(32),managed='sk-managed-provider-123456',bridgeToken='bridge-token-'+'x'.repeat(32),runnerToken='runner-token-'+'y'.repeat(32);
const ROOM='123456@chatroom',start=Date.parse('2030-01-01T00:00:00Z');
function harness(options={}){
  const db=new D1(),systems=[];let calls=0;
  const fetcher=async(_url,request)=>{calls++;const body=JSON.parse(request.body);systems.push(body.system);return Response.json({content:[{type:'text',text:body.system.includes('协调员')?JSON.stringify({summary:'好',conflict:'无',actions:['a','b','c']}):'好的'}],stop_reason:'end_turn'});};
  const request=async(name,path,data,headers={})=>{const r=await handleAPI(new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?headers:{Origin:'https://weave.test','Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)}),{db,secret,identity:name?{userId:name,displayName:name,email:name+'@example.test'}:null,fetcher,agentProviderApiKey:managed,runnerToken,wechat:{token:bridgeToken},now:start,...options});return {status:r.status,data:await r.json().catch(()=>null)};};
  return {db,request,systems,fetcher,get calls(){return calls;}};
}
const idOf=name=>hash(name).then(x=>'u:'+x);
const bridgeHeaders={Authorization:'Bearer '+bridgeToken};
const groupMessage=(id,sender,body,mentioned=false)=>({id,threadId:ROOM,senderId:sender,type:1,direction:'incoming',body,createdAt:new Date(start).toISOString(),mentions:{self:mentioned}});

test('managed model calls stop at the per-account daily limit, and the limit is not charged twice',async()=>{
  const h=harness({modelBudget:{perAccount:3,total:100}});
  for(let i=0;i<3;i++)assert.equal((await h.request('Alice','chat',{text:'你好'+i})).status,200);
  const blocked=await h.request('Alice','chat',{text:'你好'});
  assert.equal(blocked.status,429);assert.match(blocked.data.error,/额度/);assert.equal(h.calls,3);
  assert.equal((await h.request('Bob','chat',{text:'你好'})).status,200);
});
test('a council plan counts each of its model calls',async()=>{
  const h=harness({modelBudget:{perAccount:4,total:100}});
  assert.equal((await h.request('Alice','chat',{text:'帮我调整计划'})).status,200);assert.equal(h.calls,4);
  assert.equal((await h.request('Alice','chat',{text:'你好'})).status,429);
});
test('new anonymous accounts cannot get around the total daily limit',async()=>{
  const h=harness({modelBudget:{perAccount:100,total:5}});
  for(let i=0;i<5;i++)assert.equal((await h.request('guest'+i,'chat',{text:'你好'})).status,200);
  const blocked=await h.request('guest-new','chat',{text:'你好'});
  assert.equal(blocked.status,429);assert.equal(h.calls,5);
});
test('the limit resets the next day',async()=>{
  const db=new D1();const fetcher=async()=>Response.json({content:[{type:'text',text:'好'}],stop_reason:'end_turn'});
  const chat=now=>handleAPI(new Request('https://weave.test/api/chat',{method:'POST',headers:{Origin:'https://weave.test','Content-Type':'application/json'},body:JSON.stringify({text:'你好'})}),{db,secret,identity:{userId:'Alice',displayName:'Alice'},fetcher,agentProviderApiKey:managed,modelBudget:{perAccount:1,total:100},now});
  assert.equal((await chat(start)).status,200);assert.equal((await chat(start)).status,429);
  assert.equal((await chat(start+86400000)).status,200);
});
test('someone using their own key is not limited or counted',async()=>{
  const h=harness({modelBudget:{perAccount:1,total:1}});
  assert.equal((await h.request('Alice','settings',{apiKey:'sk-alice-own-key-123456',model:'deepseek-flash'})).status,200);
  for(let i=0;i<3;i++)assert.equal((await h.request('Alice','chat',{text:'你好'})).status,200);
  assert.equal((await h.request('Bob','chat',{text:'你好'})).status,200);
});
test('a background check on the managed key also counts, and stops at the limit',async()=>{
  // 03:00 UTC is 11:00 in the default timezone, inside the allowed hours.
  const h=harness({modelBudget:{perAccount:1,total:100},now:start+3*3600000});
  await h.request('Alice','chat',{text:'你好'});
  await h.request(null,'internal/hermes/claim',{version:(await import('../hosted/lib/weave/proactivity.mjs')).HERMES_REVISION},{Authorization:'Bearer '+runnerToken});
  const store=new Store(h.db),world=await store.load(),person=world.people[await idOf('Alice')];
  Object.assign(person.proactivity,{enabled:true,nextCheckAt:0});person.checkins.push({id:'c1',text:'午饭后散步更容易坚持',createdAt:new Date(start+3*3600000-1000).toISOString()});await store.save(world);
  const claim=await h.request(null,'internal/hermes/claim',{version:(await import('../hosted/lib/weave/proactivity.mjs')).HERMES_REVISION},{Authorization:'Bearer '+runnerToken});
  assert.equal(claim.status,429);
});
test('budget settings come from the environment and fall back to safe defaults',()=>{
  assert.deepEqual(modelBudgetConfig({AGENT_DAILY_CALLS_PER_ACCOUNT:'5',AGENT_DAILY_CALLS_TOTAL:'50'}),{perAccount:5,total:50});
  const fallback=modelBudgetConfig({AGENT_DAILY_CALLS_PER_ACCOUNT:'nonsense',AGENT_DAILY_CALLS_TOTAL:'-1'});
  assert.ok(fallback.perAccount>0&&fallback.total>=fallback.perAccount);
});
test('a WeChat user who hits the limit is told so instead of hearing nothing',async()=>{
  const h=harness({modelBudget:{perAccount:0,total:100}});
  const code=(await h.request('Alice','wechat/bind',{})).data.instruction;
  await h.request(null,'internal/wechat/events',{id:'m1',threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body:code,createdAt:new Date(start).toISOString()},bridgeHeaders);
  await h.request(null,'internal/wechat/events',{id:'m2',threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body:'你好',createdAt:new Date(start).toISOString()},bridgeHeaders);
  await runScheduled({db:h.db,secret,env:{WECHAT_BRIDGE_TOKEN:bridgeToken,AGENT_DAILY_CALLS_PER_ACCOUNT:'0'},agentProviderApiKey:managed,fetcher:h.fetcher,now:start});
  const texts=(await h.request(null,'internal/wechat/claim',{},bridgeHeaders)).data.jobs.map(j=>j.text);
  assert.ok(texts.some(t=>t.includes('额度')),JSON.stringify(texts));assert.equal(h.calls,0);
});

test('the tick endpoint obeys the same budget as Cron',async()=>{
  const h=harness({modelBudget:{perAccount:0,total:100}});
  const code=(await h.request('Alice','wechat/bind',{})).data.instruction;
  const say=(id,body)=>h.request(null,'internal/wechat/events',{id,threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body,createdAt:new Date(start).toISOString()},bridgeHeaders);
  await say('m1',code);await say('m2','你好');
  assert.equal((await h.request(null,'internal/wechat/tick',{},bridgeHeaders)).status,200);assert.equal(h.calls,0);
});
test('deleting an account requires explicit confirmation',async()=>{
  const h=harness();await h.request('Alice','status');
  assert.equal((await h.request('Alice','account/delete',{})).status,400);
  assert.ok((await new Store(h.db).load()).people[await idOf('Alice')]);
});
test('deleting an account removes everything of theirs and nothing of anyone else',async()=>{
  const h=harness(),alice=await idOf('Alice'),bob=await idOf('Bob');
  await h.request('Bob','status');
  const invite=(await h.request('Alice','friends/invite',{})).data.token;
  assert.equal((await h.request('Bob','friends/accept',{token:invite})).status,200);
  await h.request('Alice','friends/invite',{});
  await h.request('Alice','chat',{text:'ALICE_PRIVATE_消息'});
  await h.request('Bob','chat',{text:'BOB_PRIVATE_消息'});
  const code=(await h.request('Alice','wechat/bind',{})).data.instruction;
  await h.request(null,'internal/wechat/events',{id:'m1',threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body:code,createdAt:new Date(start).toISOString()},bridgeHeaders);
  await h.request(null,'internal/wechat/events',groupMessage('g1','wxid-alice','@助理 开启打卡群',true),bridgeHeaders);
  await h.request(null,'internal/wechat/events',{id:'m2',threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body:'ALICE_WECHAT_消息',createdAt:new Date(start).toISOString()},bridgeHeaders);
  let store=new Store(h.db),world=await store.load();
  world.negotiations['n:1']={id:'n:1',participants:[alice,bob].sort(),activity:'散步',status:'confirmed',revision:1,consents:{},confirmations:{},candidate:{slot:new Date(start+86400000).toISOString(),activity:'散步',durationMinutes:30},events:[],createdAt:new Date(start).toISOString()};
  await store.save(world);
  assert.equal((await h.request('Alice','account/delete',{confirm:true})).status,200);
  world=await new Store(h.db).load();
  assert.equal(world.people[alice],undefined);assert.ok(world.people[bob]);
  assert.equal(Object.keys(world.negotiations).length,0);assert.equal(Object.keys(world.links).length,0);
  assert.equal(Object.values(world.invites).filter(i=>i.from===alice||i.usedBy===alice).length,0);
  assert.equal(Object.values(world.runtime).filter(x=>x.ownerId===alice).length,0);
  assert.equal(Object.values(world.wechat).filter(x=>x.ownerId===alice||x.groupAad).length,0);
  const dump=JSON.stringify(world);
  assert.ok(!dump.includes('ALICE_PRIVATE'));assert.ok(!dump.includes('ALICE_WECHAT'));assert.ok(!dump.includes(alice));
  assert.ok(dump.includes('BOB_PRIVATE'));
  assert.ok(world.people[bob].notifications.some(n=>n.text.includes('删除账号')));
  assert.equal((await h.request('Bob','status')).status,200);
  // Their group is closed too: new messages leave no trace.
  assert.equal((await h.request(null,'internal/wechat/events',groupMessage('g2','wxid-bob','还在吗'),bridgeHeaders)).data.ignored,true);
});
test('deleting a guest account also removes its session row',async()=>{
  const h=harness();h.db.sql.exec('CREATE TABLE IF NOT EXISTS weave_guest_sessions (id TEXT PRIMARY KEY, created_at INTEGER)');
  const token='ab'.repeat(24);h.db.sql.prepare('INSERT INTO weave_guest_sessions (id,created_at) VALUES (?,?)').run(token,start);
  assert.equal((await h.request('guest:'+token,'account/delete',{confirm:true})).status,200);
  assert.equal(h.db.sql.prepare('SELECT COUNT(*) AS n FROM weave_guest_sessions').get().n,0);
});

test('every prompt that advises people carries the health safety rules',async()=>{
  assert.match(SAFETY_RULES,/节食/);assert.match(SAFETY_RULES,/伤害自己/);
  assert.ok(ASSESSMENT_SYSTEM.includes(SAFETY_RULES));assert.ok(GROUP_SYSTEM.includes(SAFETY_RULES));
  const h=harness();await h.request('Alice','chat',{text:'你好'});await h.request('Alice','chat',{text:'帮我调整计划'});
  assert.equal(h.systems.length,5);for(const system of h.systems)assert.ok(system.includes(SAFETY_RULES),system.slice(0,40));
});

test('product copy no longer makes the claims the code contradicts',async()=>{
  const read=path=>readFile(new URL('../hosted/app/'+path,import.meta.url),'utf8');
  const landing=await read('LandingMarketing.tsx'),workspace=await read('workspace/Workspace.jsx'),panel=await read('workspace/ProactivePanel.jsx');
  for(const text of ['数据保存在当前浏览器','产品宣传','自动回跳','高级通道'])assert.ok(!landing.includes(text),text);
  assert.ok(!workspace.includes('清除本机数据'));assert.ok(!panel.includes('Hermes'));assert.ok(!panel.includes('HERMES'));
  assert.ok(workspace.includes('account/delete'));assert.ok(workspace.includes('DeepSeek'));
  const privacy=await read('privacy/page.tsx');for(const text of ['DeepSeek','Notion','删除','导出'])assert.ok(privacy.includes(text),text);
});
