import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {ensurePerson} from '../hosted/lib/weave/domain.mjs';
import {seal,hash} from '../hosted/lib/weave/crypto.mjs';
import {proactiveState,configureProactivity,activeNow,HERMES_REVISION} from '../hosted/lib/weave/proactivity.mjs';
import {pollOnce} from '../hosted/hermes-runner/runner.mjs';
const secret='12'.repeat(32),runnerToken='runner-secret-'.repeat(5),start=Date.parse('2030-01-07T12:00:00Z');
const policy={enabled:true,mode:'discover',goal:'',intervalMinutes:60,activeStart:'09:00',activeEnd:'21:00',maxDailyMessages:2,consent:true};
async function setup(){
 const db=new D1(),store=new Store(db),world=await store.load();
 const ids={};
 for(const name of ['Alice','Bob']){
  const id=ids[name]='u:'+await hash(name),person=ensurePerson(world,{userId:id,displayName:name});
  person.profile.timezone='UTC';person.profile.slots=[new Date(start+3600000).toISOString()];
  person.settings.deepseekKey=await seal('sk-private-'+name+'-123456',secret,id);
  person.messages.push({id:'message-'+name,role:'user',text:name+' 今天午饭后有空，想找容易坚持的小活动',createdAt:new Date(start-60000).toISOString()});
  proactiveState(person);
 }
 await store.save(world);
 let now=start;
 const request=async(name,path,data,headers={})=>{
  const r=await handleAPI(new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{headers:{Origin:'https://weave.test','Content-Type':'application/json',...headers},body:JSON.stringify(data)})}),{db,secret,runnerToken,identity:name?{userId:name,displayName:name}:null,now});
  return {status:r.status,data:await r.json()};
 };
 const worker=(path,data)=>request(null,'internal/hermes/'+path,data,{Authorization:'Bearer '+runnerToken});
 const claim=()=>worker('claim',{version:HERMES_REVISION});
 const enable=async(name='Alice')=>{await claim();const r=await request(name,'proactivity/configure',policy);assert.equal(r.status,200,JSON.stringify(r.data));};
 const finish=(job,decision)=>worker('result',{owner:job.run.owner,leaseId:job.run.leaseId,decision});
 const read=async()=>new Store(db).load();
 return {db,ids,request,worker,claim,enable,finish,read,now:()=>now,setNow:value=>{now=value;}};
}
const suggest=job=>({decision:'suggest',confidence:0.95,whyNow:'近期聊天明确提到午饭后有空，可以先试一个小行动。',evidenceIds:[job.context.facts.find(f=>f.kind==='message').id],message:'午饭后愿意先散步5分钟吗？如果不合适，可以直接拒绝。',proposal:{kind:'small_action',activity:'散步',peerId:''},followUpMinutes:60});
async function offered(h){await h.enable();const {data:{job}}=await h.claim();assert.ok(job);const result=await h.finish(job,suggest(job));assert.equal(result.status,200);assert.equal(result.data.delivered,true);return (await h.request('Alice','proactivity')).data.suggestions[0];}
test('Hermes worker endpoints require a secret and a pinned engine revision',async()=>{
 const h=await setup();assert.equal((await h.request(null,'internal/hermes/claim',{version:HERMES_REVISION})).status,401);assert.equal((await h.worker('claim',{version:'other'})).status,409);
 assert.equal((await h.request('Alice','internal/hermes/claim',{version:HERMES_REVISION})).status,401);
 const r=await h.claim();assert.equal(r.status,200);assert.equal(r.data.job,null);assert.equal((await h.request('Alice','proactivity')).data.runtime.connected,true);
});
test('background inference is opt-in, requires a live runner and explicit data-use consent',async()=>{
 const h=await setup();assert.equal((await h.request('Alice','proactivity/configure',policy)).status,428);
 await h.claim();assert.equal((await h.request('Alice','proactivity/configure',{...policy,consent:false})).status,428);
 assert.equal((await h.claim()).data.job,null);await h.enable();assert.ok((await h.claim()).data.job);
 const state=(await h.request('Bob','proactivity')).data;assert.equal(state.policy.enabled,false);assert.deepEqual(state.suggestions,[]);
});
test('a claimed job includes only the consenting account context and its own credential',async()=>{
 const h=await setup();await h.enable();const job=(await h.claim()).data.job;
 assert.equal(job.apiKey,'sk-private-Alice-123456');const context=JSON.stringify(job.context);assert.ok(context.includes('Alice'));assert.ok(!context.includes('Bob'));assert.ok(!context.includes('sk-private-'));assert.equal(job.run.owner,h.ids.Alice);assert.ok(job.system.includes('为什么现在介入'));
 const publicWire=JSON.stringify((await h.request('Alice','proactivity')).data);assert.ok(!publicWire.includes(job.apiKey));assert.ok(!publicWire.includes(job.run.leaseId));assert.equal((await h.claim()).data.job,null);
});
test('quiet hours and timezones suppress both inference and notifications',async()=>{
 const h=await setup();await h.enable();h.setNow(Date.parse('2030-01-07T23:00:00Z'));assert.equal((await h.claim()).data.job,null);
 const w=await h.read(),p=w.people[h.ids.Alice];p.profile.timezone='America/Los_Angeles';assert.equal(activeNow(p,Date.parse('2030-01-07T06:00:00Z')),false);assert.equal(activeNow(p,Date.parse('2030-01-07T20:00:00Z')),true);
});
test('confidence and evidence are checked independently of the model recommendation',async()=>{
 for(const change of [{confidence:0.4},{evidenceIds:['message-Bob']},{evidenceIds:['program-goal']}]){
  const h=await setup();await h.enable();const job=(await h.claim()).data.job;const result=await h.finish(job,{...suggest(job),...change});assert.equal(result.data.delivered,false);const p=(await h.read()).people[h.ids.Alice];assert.equal(p.notifications.length,0);assert.equal(p.suggestions.length,0);
 }
});
test('valid suggestions persist with reasons, while duplicate result receipts cannot notify twice',async()=>{
 const h=await setup();await h.enable();const job=(await h.claim()).data.job;
 const first=await h.finish(job,suggest(job));assert.equal(first.data.delivered,true);assert.equal((await h.finish(job,suggest(job))).data.duplicate,true);
 const p=(await h.read()).people[h.ids.Alice];assert.equal(p.notifications.length,1);assert.equal(p.suggestions.length,1);assert.equal(p.suggestions[0].status,'awaiting_response');assert.ok(p.suggestions[0].whyNow);assert.equal(p.messages.at(-1).source,'hermes');
});
test('stopping or changing policy invalidates in-flight Hermes decisions',async()=>{
 for(const operation of ['stop','change']){
  const h=await setup();await h.enable();const job=(await h.claim()).data.job;
  const result=operation==='stop'?await h.request('Alice','proactivity/stop',{}):await h.request('Alice','proactivity/configure',{...policy,goal:'新的关注方向'});assert.equal(result.status,200);
  assert.equal((await h.finish(job,suggest(job))).status,409);assert.equal((await h.read()).people[h.ids.Alice].notifications.length,0);
 }
});
test('context changes during reasoning discard stale suggestions and schedule a fresh check',async()=>{
 const h=await setup();await h.enable();const job=(await h.claim()).data.job;
 const store=new Store(h.db),world=await store.load();world.people[h.ids.Alice].messages.push({id:'new-input',role:'user',text:'今天不想运动，想休息',createdAt:new Date(start).toISOString()});await store.save(world);
 const result=await h.finish(job,suggest(job));assert.equal(result.data.delivered,false);const p=(await h.read()).people[h.ids.Alice];assert.equal(p.notifications.length,0);assert.equal(p.proactivity.assessments.at(-1).outcome,'stale');
});
test('a user can accept a proposal and Hermes follows that same item after it is due',async()=>{
 const h=await setup(),s=await offered(h);await h.request('Alice','proactivity/action',{id:s.id,action:'accept'});
 h.setNow(start+3600000);assert.equal((await h.claim()).data.job,null);
 h.setNow(start+86400000);const job=(await h.claim()).data.job;assert.equal(job.context.followUp.id,s.id);assert.equal(job.context.followUp.status,'accepted');
 const result=await h.finish(job,{...suggest(job),decision:'follow_up',message:'上次说的小散步后来怎么样？没做也没关系，可以调整。',evidenceIds:['suggestion:'+s.id]});assert.equal(result.data.delivered,true);
 const p=(await h.read()).people[h.ids.Alice];assert.equal(p.suggestions.length,1);assert.equal(p.suggestions[0].followUpCount,1);
});
test('snooze, completion and dismissal persist and never become implicit invitations',async()=>{
 const h=await setup(),s=await offered(h);
 assert.equal((await h.request('Bob','proactivity/action',{id:s.id,action:'complete'})).status,404);
 await h.request('Alice','proactivity/action',{id:s.id,action:'snooze',minutes:120});h.setNow(start+3600000);assert.equal((await h.claim()).data.job,null);
 await h.request('Alice','proactivity/action',{id:s.id,action:'complete'});const world=await h.read(),person=world.people[h.ids.Alice];assert.equal(person.suggestions[0].status,'done');assert.equal(person.checkins.at(-1).suggestionId,s.id);assert.equal(Object.keys(world.negotiations).length,0);
});
test('dismissed proposals stay in cooldown even when the model paraphrases them',async()=>{
 const h=await setup(),s=await offered(h);await h.request('Alice','proactivity/action',{id:s.id,action:'dismiss'});h.setNow(start+3600000);
 const job=(await h.claim()).data.job;assert.ok(job);const result=await h.finish(job,{...suggest(job),message:'换个说法：去走一小会儿怎么样？'});assert.equal(result.data.delivered,false);assert.equal((await h.read()).people[h.ids.Alice].notifications.length,1);
});
test('daily delivery and paid assessment budgets bound background work',async()=>{
 const h=await setup();await h.claim();await h.request('Alice','proactivity/configure',{...policy,maxDailyMessages:1});const job=(await h.claim()).data.job;await h.finish(job,suggest(job));h.setNow(start+3600000);assert.equal((await h.claim()).data.job,null);
 const other=await setup();await other.enable();
 for(let i=0;i<6;i++){other.setNow(start+i*3600000);const job=(await other.claim()).data.job;assert.ok(job);assert.equal((await other.worker('result',{owner:job.run.owner,leaseId:job.run.leaseId,error:true})).status,200);}
 other.setNow(start+6*3600000);assert.equal((await other.claim()).data.job,null);assert.equal((await other.read()).people[other.ids.Alice].proactivity.dailyAssessments,6);
});
test('expired leases recover without accepting late results or duplicating work',async()=>{
 const h=await setup();await h.enable();const job=(await h.claim()).data.job;h.setNow(start+181000);const next=(await h.claim()).data.job;assert.ok(next);assert.notEqual(next.run.leaseId,job.run.leaseId);assert.equal((await h.finish(job,suggest(job))).status,409);assert.equal((await h.read()).people[h.ids.Alice].notifications.length,0);
});
test('the persistent runner can complete a real API/SQLite queue cycle without any browser',async()=>{
 const h=await setup();await h.enable();let executions=0;
 const fetcher=(url,options)=>handleAPI(new Request(url,options),{db:h.db,secret,runnerToken,identity:null,now:start});
 const result=await pollOnce({origin:'https://weave.test',token:runnerToken,python:'unused',dataDir:'unused',fetcher,execute:async job=>{executions++;return {decision:suggest(job)};}});
 assert.equal(result.delivered,true);assert.equal(executions,1);assert.equal((await h.request('Alice','proactivity')).data.suggestions.length,1);
});
test('runner retries a lost receipt acknowledgement without re-running Hermes',async()=>{
 const h=await setup();await h.enable();let executions=0,lost=false;
 const fetcher=async(url,options)=>{const r=await handleAPI(new Request(url,options),{db:h.db,secret,runnerToken,identity:null,now:start});if(url.endsWith('/result')&&!lost){lost=true;throw Error('lost acknowledgement');}return r;};
 const result=await pollOnce({origin:'https://weave.test',token:runnerToken,fetcher,execute:async job=>{executions++;return {decision:suggest(job)};}});
 assert.equal(result.duplicate,true);assert.equal(executions,1);assert.equal((await h.read()).people[h.ids.Alice].notifications.length,1);
});
test('Hermes cannot propose inviting a non-friend or change business state through model output',async()=>{
 const h=await setup();await h.enable();const job=(await h.claim()).data.job;
 assert.equal((await h.finish(job,{...suggest(job),proposal:{kind:'invite',activity:'散步',peerId:h.ids.Bob}})).status,422);
 const p=(await h.read()).people[h.ids.Alice];assert.equal(p.suggestions.length,0);assert.equal(Object.keys((await h.read()).negotiations).length,0);
});
test('a goal is never inferred from an interest or enabled without the user granting it',async()=>{
 const h=await setup();const p=(await h.read()).people[h.ids.Alice];assert.equal(p.proactivity.enabled,false);assert.equal(p.proactivity.goal,'');assert.throws(()=>configureProactivity(p,{...policy,mode:'goal',goal:''},true,start),/持续目标/);
});
