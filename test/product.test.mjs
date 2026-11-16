import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {seal,unseal} from '../hosted/lib/weave/crypto.mjs';
import * as domain from '../hosted/lib/weave/domain.mjs';
import {runScheduled} from '../hosted/lib/weave/scheduler.mjs';
import {activeNow} from '../hosted/lib/weave/proactivity.mjs';
const secret='ab'.repeat(32),identity=name=>({userId:name,displayName:name,email:name+'@example.test'});
function harness(){
 const db=new D1(),requests=[];
 const fetcher=async(url,options)=>{
  requests.push({url,options});
  if(url.startsWith('https://api.notion.com/'))return options.method==='POST'?Response.json({url:'https://notion.so/own-plan'}):Response.json({results:[{type:'paragraph',paragraph:{rich_text:[{plain_text:'NOTION_PRIVATE_MEMORY'}]}}],has_more:false});
  throw Error('unexpected request: '+url);
 };
 async function api(name,path,data,extra={}){
  const request=new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{headers:{'Content-Type':'application/json',Origin:'https://weave.test',...extra.headers},body:JSON.stringify(data)})});
  const r=await handleAPI(request,{db,identity:name?identity(name):null,secret,fetcher});return {status:r.status,data:await r.json()};
 }
 return {db,api,requests};
}
// Two accounts, each with their own model key saved (sealed) in settings.
async function accounts(h){
 for(const user of ['Alice','Bob'])assert.equal((await h.api(user,'status')).status,200);
 for(const name of ['Alice','Bob'])assert.equal((await h.api(name,'settings',{apiKey:'sk-private-'+name+'-123456',model:'deepseek-flash'})).status,200);
}
// A plan as the removed old chat path used to write it. Old data can still hold some; the plan endpoints stay for them.
async function seedPlan(h,name){
 const store=new Store(h.db),world=await store.load(),person=Object.values(world.people).find(p=>p.profile.name===name);
 const plan={id:'plan-'+name,createdAt:new Date().toISOString(),context:{text:'睡得少'},summary:'今天轻松一点。',conflict:'降低强度',actions:['散步10分钟','正常吃饭','早点放松'],agents:[],mode:'deepseek',approved:false};
 person.plans.push(plan);await store.save(world);return plan;
}
test('product requires login and an authenticated session cannot select another user with a query parameter',async()=>{
 const h=harness();assert.equal((await h.api(null,'status')).status,401);
 const alice=(await h.api('Alice','status')).data,bob=(await h.api('Bob','status')).data;
 const forged=(await h.api('Alice','status?person='+bob.personId)).data;
 assert.equal(forged.personId,alice.personId);assert.notEqual(forged.personId,bob.personId);
 assert.equal((await h.api('Alice','profile',{}, {headers:{Origin:'https://attacker.test'}})).status,403);
});
test('credentials are owner-bound encrypted data and never returned by status or personal export',async()=>{
 const h=harness();await accounts(h);
 const raw=JSON.stringify(h.db.sql.prepare('SELECT * FROM weave_documents').all());assert.ok(!raw.includes('sk-private-'));
 assert.ok(!JSON.stringify((await h.api('Alice','status')).data).includes('deepseekKey'));assert.ok(!JSON.stringify((await h.api('Alice','export')).data).includes('deepseekKey'));
 const cipher=await seal('sk-test-secret',secret,'Alice');assert.equal(await unseal(cipher,secret,'Alice'),'sk-test-secret');await assert.rejects(()=>unseal(cipher,secret,'Bob'));
});
test('concurrent independent accounts merge, but conflicting changes cannot overwrite confirmations',async()=>{
 const h=harness();await h.api('Alice','status');await h.api('Bob','status');
 const one=new Store(h.db),two=new Store(h.db),w1=await one.load(),w2=await two.load();const ids=Object.keys(w1.people);
 w1.people[ids[0]].profile.goal='first';w2.people[ids[1]].profile.goal='second';await one.save(w1);await two.save(w2);
 const check=await(new Store(h.db)).load();assert.equal(check.people[ids[0]].profile.goal,'first');assert.equal(check.people[ids[1]].profile.goal,'second');
 const three=new Store(h.db),four=new Store(h.db),w3=await three.load(),w4=await four.load();w3.people[ids[0]].profile.goal='new';w4.people[ids[0]].profile.goal='stale';await three.save(w3);await assert.rejects(()=>four.save(w4),/变化/);assert.equal((await(new Store(h.db)).load()).people[ids[0]].profile.goal,'new');
});
test('each user owns their Notion memory and confirmed plan sync is idempotent',async()=>{
 const h=harness();await accounts(h);
 await h.api('Alice','settings',{notionToken:'ntn-private-alice-token',notionPageId:'123456781234123412341234567890ab'});
 assert.match((await h.api('Alice','memory')).data.text,/NOTION_PRIVATE_MEMORY/);assert.equal((await h.api('Bob','memory')).data.text,'');
 const plan=await seedPlan(h,'Alice');
 assert.equal((await h.api('Alice','plans/sync',{id:plan.id})).status,400);
 assert.equal((await h.api('Bob','plans/approve',{id:plan.id})).status,404);
 await h.api('Alice','plans/approve',{id:plan.id});await h.api('Alice','plans/sync',{id:plan.id});await h.api('Alice','plans/sync',{id:plan.id});
 const writes=h.requests.filter(r=>r.url==='https://api.notion.com/v1/pages');assert.equal(writes.length,1);assert.equal(writes[0].options.headers.Authorization,'Bearer ntn-private-alice-token');assert.ok(!JSON.stringify((await h.api('Bob','export')).data).includes('NOTION_PRIVATE_MEMORY'));assert.ok(!JSON.stringify((await h.api('Alice','status')).data).includes('ntn-private-alice-token'));
});
test('Notion one-click OAuth keeps the token server-side and connects the shared page without a second step',async()=>{
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
 const callback=await call(null,'connections/notion/callback?code=oauth-code&state='+state);assert.equal(callback.status,303);assert.match(callback.data,/status=connected/);
 const pending=await call('Alice','connections/notion/pending');assert.deepEqual(pending.data,{ready:false,pages:[]});
 const status=await call('Alice','status');assert.equal(status.data.settings.notion,true);assert.equal(JSON.stringify(status.data).includes('ntn-oauth-private-token'),false);
 assert.deepEqual((await call('Alice','connections/notion')).data,{state:'connected',page:{title:'我的长期记忆'}});
 const raw=JSON.stringify(db.sql.prepare('SELECT * FROM weave_documents').all());assert.equal(raw.includes('ntn-oauth-private-token'),false);assert.equal(requests.filter(x=>x.url==='https://api.notion.com/v1/oauth/token').length,1);
 assert.equal((await call('Alice','connections/notion/disconnect',{})).status,200);assert.equal((await call('Alice','status')).data.settings.notion,false);
});
test('managed provider connection keeps its credential server-side',async()=>{
 const h=harness(),managed='sk-managed-provider-123456';
 const request=async(name,path,data)=>{const r=await handleAPI(new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{headers:{'Content-Type':'application/json',Origin:'https://weave.test'},body:JSON.stringify(data)})}),{db:h.db,identity:identity(name),secret,fetcher:async()=>{throw Error('no outside call expected');},agentProviderApiKey:managed});return {status:r.status,data:await r.json()};};
 const status=await request('Alice','status');assert.equal(status.data.settings.agent,true);assert.equal(JSON.stringify(status.data).includes(managed),false);
 assert.equal(JSON.stringify((await request('Alice','export')).data).includes(managed),false);
 const raw=JSON.stringify(h.db.sql.prepare('SELECT * FROM weave_documents').all());assert.equal(raw.includes(managed),false);
});
test('product reminders are validated and remain exactly once after reopening the database',async()=>{
 const h=harness();await h.api('Alice','status');assert.equal((await h.api('Alice','reminders',{text:'散步',dueAt:'2028-02-30T20:00:00Z'})).status,400);
 const dueAt=new Date(Date.now()+10000).toISOString();await h.api('Alice','reminders',{text:'散步',dueAt});const store=new Store(h.db),world=await store.load();assert.equal(domain.deliverReminders(world,Date.parse(dueAt)+1),1);await store.save(world);
 const reopened=new Store(h.db),latest=await reopened.load();assert.equal(domain.deliverReminders(latest,Date.parse(dueAt)+2),0);assert.equal((await h.api('Alice','status')).data.messages.filter(m=>m.text==='提醒你：散步').length,1);
});
test('old data from the removed friend and Hermes features still loads and is ignored',async()=>{
 const h=harness();await accounts(h);
 const store=new Store(h.db),world=await store.load(),[a,b]=Object.keys(world.people).sort();
 const now=new Date().toISOString();
 world.links['link:1']={id:'link:1',members:[a,b],createdAt:now};
 world.invites['invite:1']={id:'invite:1',from:a,expiresAt:Date.now()+86400000,createdAt:now};
 world.negotiations['n:1']={id:'n:1',participants:[a,b],activity:'散步',status:'confirmed',revision:1,consents:{},confirmations:{},candidate:{slot:now,activity:'散步',durationMinutes:30},events:[],createdAt:now};
 world.runtime['runtime:hermes']={id:'runtime:hermes',version:'f30105a',lastSeenAt:Date.now()};
 const person=world.people[a];
 person.suggestions=[{id:'s1',status:'awaiting_response',message:'走一走？',createdAt:Date.now()}];
 person.proactivity={enabled:true,mode:'discover',goal:'',intervalMinutes:60,activeStart:'08:00',activeEnd:'20:00',maxDailyMessages:2,maxDailyAssessments:6,revision:3,nextCheckAt:0,receipts:[],assessments:[]};
 await store.save(world);
 const status=await h.api('Alice','status');assert.equal(status.status,200);assert.equal('negotiations' in status.data,false);assert.equal('calendar' in status.data,false);
 assert.equal((await h.api('Alice','export')).status,200);
 assert.equal((await h.api('Alice','proactivity')).status,404);assert.equal((await h.api('Alice','negotiations/start',{})).status,404);assert.equal((await h.api('Alice','friends/invite',{})).status,404);
 await runScheduled({db:h.db,secret,env:{},now:Date.now()});
 // The allowed hours an old setting left behind are still the ones the background wake reads (08:00 in Shanghai is 00:00 UTC).
 assert.equal(activeNow(person,Date.parse('2030-01-01T00:00:00Z')),true);assert.equal(activeNow(person,Date.parse('2029-12-31T23:00:00Z')),false);
});
