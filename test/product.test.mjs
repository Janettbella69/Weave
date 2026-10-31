import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {seal,unseal} from '../hosted/lib/weave/crypto.mjs';
import * as domain from '../hosted/lib/weave/domain.mjs';
import {runAgent} from '../hosted/agent-service/runtime.mjs';
const secret='ab'.repeat(32),identity=name=>({userId:name,displayName:name,email:name+'@example.test'});
function harness(){
 const db=new D1(),requests=[];
 const fetcher=async(url,options)=>{
  requests.push({url,options});
  if(url.startsWith('https://api.notion.com/'))return options.method==='POST'?Response.json({url:'https://notion.so/own-plan'}):Response.json({results:[{type:'paragraph',paragraph:{rich_text:[{plain_text:'NOTION_PRIVATE_MEMORY'}]}}],has_more:false});
  const b=JSON.parse(options.body),input=JSON.parse(b.messages[0].content);let output;
  if(input.my){const incoming=input.incoming?.slot;output=incoming&&input.my.slots.includes(incoming)?{decision:'accept',reason:'这个时间符合我的授权安排。'}:{decision:'propose',slot:input.my.slots.find(x=>!input.tried.includes(x)),reason:'建议在这个可用时间一起行动。'};}
  else if(b.system.includes('协调员'))output={summary:'今天轻松一点。',conflict:'精力与训练强度冲突，降低强度。',actions:['散步10分钟','正常吃饭','早点放松']};
  else output='已参考个人状态，保留一个小行动。';
  return Response.json({stop_reason:'end_turn',content:[{type:'text',text:typeof output==='string'?output:JSON.stringify(output)}]});
 };
 async function api(name,path,data,extra={}){
  const request=new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{headers:{'Content-Type':'application/json',Origin:'https://weave.test',...extra.headers},body:JSON.stringify(data)})});
  const r=await handleAPI(request,{db,identity:name?identity(name):null,secret,fetcher});return {status:r.status,data:await r.json()};
 }
 return {db,api,requests};
}
const future=()=>{const d=new Date(Date.now()+7*86400000);d.setUTCHours(12,0,0,0);return [0,60,120].map(m=>new Date(d.getTime()+m*60000).toISOString());};
async function paired(h){
 for(const user of ['Alice','Bob','Eve'])assert.equal((await h.api(user,'status')).status,200);
 const invite=await h.api('Alice','friends/invite',{});assert.equal(invite.status,200);assert.equal((await h.api('Bob','friends/accept',{token:invite.data.token})).status,200);
 const a=(await h.api('Alice','status')).data,b=(await h.api('Bob','status')).data,slots=future();
 for(const [name,p,available] of [['Alice',a,[slots[0],slots[2]]],['Bob',b,[slots[1],slots[2]]]]){
  assert.equal((await h.api(name,'settings',{apiKey:'sk-private-'+name+'-123456',model:'deepseek-flash'})).status,200);
  assert.equal((await h.api(name,'profile',{...p.profile,slots:available,goal:name+' PRIVATE GOAL',preferences:name+' PRIVATE PREFERENCE'})).status,200);
 }
 return {a:a.personId,b:b.personId,slots,token:invite.data.token};
}
test('product requires login and an authenticated session cannot select another user with a query parameter',async()=>{
 const h=harness();assert.equal((await h.api(null,'status')).status,401);
 const alice=(await h.api('Alice','status')).data,bob=(await h.api('Bob','status')).data;
 const forged=(await h.api('Alice','status?person='+bob.personId)).data;
 assert.equal(forged.personId,alice.personId);assert.notEqual(forged.personId,bob.personId);assert.deepEqual(forged.people,[]);
 assert.equal((await h.api('Alice','profile',{}, {headers:{Origin:'https://attacker.test'}})).status,403);
});
test('friend invitations are explicit, single use, revocable and do not expose a global user directory',async()=>{
 const h=harness(),{token,b}=await paired(h);
 assert.equal((await h.api('Eve','friends/accept',{token})).status,404);
 assert.deepEqual((await h.api('Eve','status')).data.people,[]);
 const invite=await h.api('Alice','friends/invite',{}),state=(await h.api('Alice','status')).data;
 assert.ok(state.people.some(p=>p.id===b));assert.equal((await h.api('Bob','friends/revoke',{id:state.invites[0].id})).status,404);
 await h.api('Alice','friends/revoke',{id:state.invites[0].id});assert.equal((await h.api('Eve','friends/accept',{token:invite.data.token})).status,404);
});
test('credentials are owner-bound encrypted data and never returned by status or personal export',async()=>{
 const h=harness();await paired(h);
 const raw=JSON.stringify(h.db.sql.prepare('SELECT * FROM weave_documents').all());assert.ok(!raw.includes('sk-private-'));
 assert.ok(!JSON.stringify((await h.api('Alice','status')).data).includes('deepseekKey'));assert.ok(!JSON.stringify((await h.api('Alice','export')).data).includes('deepseekKey'));
 const cipher=await seal('sk-test-secret',secret,'Alice');assert.equal(await unseal(cipher,secret,'Alice'),'sk-test-secret');await assert.rejects(()=>unseal(cipher,secret,'Bob'));
});
test('product uses the DeepSeek Anthropic protocol and two separately scoped model agents with mutual confirmation',async()=>{
 const h=harness(),{a,b,slots}=await paired(h);
 const invite=await h.api('Alice','negotiations/start',{peer:b,activity:'散步',consent:true}),id=invite.data.id;
 assert.equal(invite.status,200);assert.equal(invite.data.status,'awaiting_consent');
 assert.equal((await h.api('Eve','negotiations/action',{id,action:'authorize'})).status,404);
 const agreed=await h.api('Bob','negotiations/action',{id,action:'authorize'});assert.equal(agreed.status,200);assert.equal(agreed.data.status,'awaiting_confirmation');assert.equal(agreed.data.candidate.slot,slots[2]);
 assert.ok(agreed.data.events.some(e=>e.type==='counterproposal'));
 for(const r of h.requests){assert.equal(r.url,'https://api.deepseek.com/anthropic/v1/messages');assert.equal(r.options.headers['anthropic-version'],'2023-06-01');const wire=r.options.body;assert.ok(!wire.includes('PRIVATE GOAL'));assert.ok(!wire.includes('PRIVATE PREFERENCE'));}
 assert.equal(new Set(h.requests.map(r=>r.options.headers['x-api-key'])).size,2);
 await h.api('Alice','negotiations/action',{id,action:'confirm',revision:1});assert.equal((await h.api('Bob','status')).data.calendar.length,0);
 await h.api('Bob','negotiations/action',{id,action:'confirm',revision:1});await h.api('Bob','negotiations/action',{id,action:'confirm',revision:1});
 assert.equal((await h.api('Alice','status')).data.calendar.length,1);assert.equal((await h.api('Bob','status')).data.calendar.length,1);assert.equal((await h.api('Eve','status')).data.calendar.length,0);
 const reopened=new Store(h.db),world=await reopened.load();assert.equal(world.negotiations[id].status,'confirmed');assert.deepEqual(world.negotiations[id].confirmations,{[a]:true,[b]:true});
 await h.api('Bob','negotiations/action',{id,action:'cancel'});assert.equal((await h.api('Alice','status')).data.calendar.length,0);
});
test('product invalidates consent and old confirmations when profile changes',async()=>{
 const h=harness(),{b}=await paired(h);const {data:n}=await h.api('Alice','negotiations/start',{peer:b,activity:'散步',consent:true});await h.api('Bob','negotiations/action',{id:n.id,action:'authorize'});
 const profile=(await h.api('Bob','status')).data.profile;await h.api('Bob','profile',{...profile,goal:'新目标'});
 assert.equal((await h.api('Alice','negotiations/action',{id:n.id,action:'confirm',revision:1})).status,400);const latest=(await h.api('Alice','status')).data.negotiations[0];assert.equal(latest.status,'awaiting_consent');assert.equal(latest.authorized,false);
});
test('concurrent independent accounts merge, but conflicting changes cannot overwrite confirmations',async()=>{
 const h=harness();await h.api('Alice','status');await h.api('Bob','status');
 const one=new Store(h.db),two=new Store(h.db),w1=await one.load(),w2=await two.load();const ids=Object.keys(w1.people);
 w1.people[ids[0]].profile.goal='first';w2.people[ids[1]].profile.goal='second';await one.save(w1);await two.save(w2);
 const check=await(new Store(h.db)).load();assert.equal(check.people[ids[0]].profile.goal,'first');assert.equal(check.people[ids[1]].profile.goal,'second');
 const three=new Store(h.db),four=new Store(h.db),w3=await three.load(),w4=await four.load();w3.people[ids[0]].profile.goal='new';w4.people[ids[0]].profile.goal='stale';await three.save(w3);await assert.rejects(()=>four.save(w4),/变化/);assert.equal((await(new Store(h.db)).load()).people[ids[0]].profile.goal,'new');
});
test('two parallel agreements cannot double book through a disjoint-document merge',async()=>{
 const h=harness(),{a,b}=await paired(h);
 const ids=[];
 for(let i=0;i<2;i++){const {data:n}=await h.api('Alice','negotiations/start',{peer:b,activity:'散步',consent:true});await h.api('Bob','negotiations/action',{id:n.id,action:'authorize'});ids.push(n.id);}
 await h.api('Alice','negotiations/action',{id:ids[0],action:'confirm',revision:1});await h.api('Bob','negotiations/action',{id:ids[1],action:'confirm',revision:1});
 const first=new Store(h.db,{strict:true}),second=new Store(h.db,{strict:true}),w1=await first.load(),w2=await second.load();
 domain.confirm(w1,w1.negotiations[ids[0]],b,1);domain.confirm(w2,w2.negotiations[ids[1]],a,1);
 await first.save(w1);await assert.rejects(()=>second.save(w2),/变化/);
 const latest=await(new Store(h.db)).load();assert.equal(domain.calendar(latest,a).length,1);assert.equal(domain.calendar(latest,b).length,1);
 assert.throws(()=>domain.confirm(latest,latest.negotiations[ids[1]],a,1),/安排发生变化/);
});
test('each user owns their Notion memory and confirmed plan sync is idempotent',async()=>{
 const h=harness();await paired(h);
 await h.api('Alice','settings',{notionToken:'ntn-private-alice-token',notionPageId:'123456781234123412341234567890ab'});
 assert.match((await h.api('Alice','memory')).data.text,/NOTION_PRIVATE_MEMORY/);assert.equal((await h.api('Bob','memory')).data.text,'');
 await h.api('Alice','chat',{text:'帮我调整计划'});const plan=(await h.api('Alice','status')).data.plans[0];
 assert.equal((await h.api('Alice','plans/sync',{id:plan.id})).status,400);
 await h.api('Alice','plans/approve',{id:plan.id});await h.api('Alice','plans/sync',{id:plan.id});await h.api('Alice','plans/sync',{id:plan.id});
 const writes=h.requests.filter(r=>r.url==='https://api.notion.com/v1/pages');assert.equal(writes.length,1);assert.equal(writes[0].options.headers.Authorization,'Bearer ntn-private-alice-token');assert.ok(!JSON.stringify((await h.api('Bob','export')).data).includes('NOTION_PRIVATE_MEMORY'));assert.ok(!JSON.stringify((await h.api('Alice','status')).data).includes('ntn-private-alice-token'));
});
test('Notion one-click OAuth keeps the token server-side and lets the owner choose a page',async()=>{
 const db=new D1(),oauth={clientId:'notion-client',clientSecret:'notion-secret',redirectUri:'https://weave.test/api/connections/notion/callback'},requests=[];
 const fetcher=async(url,options)=>{
  requests.push({url,options});
  if(url==='https://api.notion.com/v1/oauth/token')return Response.json({access_token:'ntn-oauth-private-token'});
  if(url==='https://api.notion.com/v1/search')return Response.json({results:[{id:'123456781234123412341234567890ab',url:'https://notion.so/private-page',properties:{title:{type:'title',title:[{plain_text:'我的长期记忆'}]}}}],has_more:false});
  throw Error('unexpected Notion request');
 };
 const call=async(name,path,data)=>{
  const request=new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{headers:{'Content-Type':'application/json',Origin:'https://weave.test'},body:JSON.stringify(data)})});
  const response=await handleAPI(request,{db,identity:name?identity(name):null,secret,fetcher,notionOAuth:oauth});
  return {status:response.status,data:response.status===303?response.headers.get('location'):await response.json()};
 };
 const started=await call('Alice','connections/notion/start',{});assert.equal(started.status,200);const authURL=new URL(started.data.url),state=authURL.searchParams.get('state');assert.match(state,/^[a-f0-9]{48}$/);
 const callback=await call(null,'connections/notion/callback?code=oauth-code&state='+state);assert.equal(callback.status,303);assert.match(callback.data,/status=ready/);
 const pending=await call('Alice','connections/notion/pending');assert.deepEqual(pending.data.pages,[{id:'123456781234123412341234567890ab',title:'我的长期记忆',url:'https://notion.so/private-page'}]);
 const completed=await call('Alice','connections/notion/complete',{pageId:pending.data.pages[0].id});assert.equal(completed.status,200);
 const status=await call('Alice','status');assert.equal(status.data.settings.notion,true);assert.equal(JSON.stringify(status.data).includes('ntn-oauth-private-token'),false);
 const raw=JSON.stringify(db.sql.prepare('SELECT * FROM weave_documents').all());assert.equal(raw.includes('ntn-oauth-private-token'),false);assert.equal(requests.filter(x=>x.url==='https://api.notion.com/v1/oauth/token').length,1);
 assert.equal((await call('Alice','connections/notion/disconnect',{})).status,200);assert.equal((await call('Alice','status')).data.settings.notion,false);
});
test('missing model credentials do not silently produce a demo plan; private plans cannot be approved by friends',async()=>{
 const h=harness();await h.api('Alice','status');assert.equal((await h.api('Alice','chat',{text:'帮我调整计划'})).status,428);assert.equal((await h.api('Alice','status')).data.plans.length,0);
 await h.api('Alice','settings',{apiKey:'sk-private-key-123456',model:'deepseek-flash'});assert.equal((await h.api('Alice','chat',{text:'昨晚睡了5小时，帮我调整计划'})).status,200);
 const plan=(await h.api('Alice','status')).data.plans[0];assert.equal(plan.agents.length,3);assert.equal(plan.mode,'deepseek');assert.equal((await h.api('Bob','plans/approve',{id:plan.id})).status,404);
});
test('managed provider connection keeps its credential server-side while enabling chat',async()=>{
 const h=harness(),managed='sk-managed-provider-123456';
 const fetcher=async()=>Response.json({stop_reason:'end_turn',content:[{type:'text',text:'托管连接成功'}]});
 const request=async(name,path,data)=>{const r=await handleAPI(new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{headers:{'Content-Type':'application/json',Origin:'https://weave.test'},body:JSON.stringify(data)})}),{db:h.db,identity:identity(name),secret,fetcher,agentProviderApiKey:managed});return {status:r.status,data:await r.json()};};
 const status=await request('Alice','status');assert.equal(status.data.settings.agent,true);assert.equal(JSON.stringify(status.data).includes(managed),false);
 assert.equal((await request('Alice','connections/agent/start',{})).status,200);
 assert.equal((await request('Alice','chat',{text:'你好'})).status,200);
 const raw=JSON.stringify(h.db.sql.prepare('SELECT * FROM weave_documents').all());assert.equal(raw.includes(managed),false);
});
test('product reminders are validated and remain exactly once after reopening the database',async()=>{
 const h=harness();await h.api('Alice','status');assert.equal((await h.api('Alice','reminders',{text:'散步',dueAt:'2028-02-30T20:00:00Z'})).status,400);
 const dueAt=new Date(Date.now()+10000).toISOString();await h.api('Alice','reminders',{text:'散步',dueAt});const store=new Store(h.db),world=await store.load();assert.equal(domain.deliverReminders(world,Date.parse(dueAt)+1),1);await store.save(world);
 const reopened=new Store(h.db),latest=await reopened.load();assert.equal(domain.deliverReminders(latest,Date.parse(dueAt)+2),0);assert.equal((await h.api('Alice','status')).data.messages.filter(m=>m.text==='提醒你：散步').length,1);
});
test('Claude Agent SDK runs DeepSeek through Anthropic with isolated sessions and no shell or filesystem tools',async()=>{
 let options;
 async function* query(input){options=input.options;yield {type:'result',subtype:'success',result:'{"ok":true}'};}
 const output=await runAgent({apiKey:'sk-test-key-123456',model:'deepseek-flash',system:'只返回JSON',input:{task:'test'},json:true},query);
 assert.deepEqual(output,{ok:true});assert.equal(options.env.ANTHROPIC_BASE_URL,'https://api.deepseek.com/anthropic');assert.equal(options.env.ANTHROPIC_AUTH_TOKEN,'sk-test-key-123456');assert.deepEqual(options.tools,[]);assert.deepEqual(options.disallowedTools,['*']);assert.equal(options.persistSession,false);assert.equal(options.settingSources.length,0);assert.notEqual(options.cwd,process.cwd());
});
