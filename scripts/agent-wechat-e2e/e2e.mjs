// End to end: real agent-wechat hub + simulated WeChat upstream + the real bridge + real Weave code.
// Only the model is stubbed. See README.md in this folder for the simulator setup.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const SRC=process.env.AGENT_WECHAT_SRC,binary=process.env.WX_DEV_BINARY;
if(!SRC||!binary){console.error('Set AGENT_WECHAT_SRC and WX_DEV_BINARY. See README.md in this folder.');process.exit(2);}
const W=new URL('../..',import.meta.url).pathname.replace(/\/$/,'');
const {NativeWeChatClient}=await import(SRC+'/packages/shared/src/native-client.ts');
const {createDaemon,handleEvent,deliverOnce,sseEvents}=await import(W+'/hosted/wechat-bridge/bridge.mjs');
const {handleAPI}=await import(W+'/hosted/lib/weave/api.mjs');
const {Store}=await import(W+'/hosted/lib/weave/store.mjs');
const {ensurePerson}=await import(W+'/hosted/lib/weave/domain.mjs');
const {hash}=await import(W+'/hosted/lib/weave/crypto.mjs');
const {D1}=await import(W+'/test/helpers/product-db.mjs');

const ACCOUNT='personal',results=[];
const check=(name,fn)=>{try{fn();results.push(['PASS',name]);console.log('PASS',name);}catch(e){results.push(['FAIL',name]);console.log('FAIL',name,'\n   ',e.message.split('\n').slice(0,6).join('\n    '));}};
const waitFor=async(label,condition,timeout=20000)=>{const end=Date.now()+timeout;let last;while(Date.now()<end){try{const v=await condition();if(v)return v;}catch(e){last=e;}await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+label+(last?' / '+last.message:''));};
const temp=await mkdtemp(join(tmpdir(),'weave-e2e-'));await chmod(temp,0o700);const data=join(temp,'state');
const processes=[];
async function start(command,args=[]){
  const child=spawn(binary,[command,'--data-dir',data,...args],{stdio:['ignore','pipe','pipe']});processes.push(child);
  let diagnostics='';child.stderr.on('data',c=>{diagnostics=(diagnostics+c).slice(-2000);});
  const ready=await new Promise((resolve,reject)=>{let out='';const t=setTimeout(()=>reject(Error('startup timeout '+command+': '+diagnostics)),30000);child.once('exit',c=>{clearTimeout(t);reject(Error(command+' exited '+c+': '+diagnostics));});child.stdout.on('data',c=>{out+=c;if(out.includes('\n')){clearTimeout(t);resolve(JSON.parse(out.slice(0,out.indexOf('\n'))));}});});
  return {child,ready};
}
let exit=1;
try{
  const remote=await start('upstream'),controlToken=(await readFile(remote.ready.controlTokenFile,'utf8')).trim();
  const hub=await start('hub',['--upstream',remote.ready.upstream]),token=(await readFile(hub.ready.tokenFile,'utf8')).trim();
  const control=async input=>{const r=await fetch(`http://${remote.ready.upstream}/control`,{method:'POST',headers:{Authorization:'Bearer '+controlToken,'Content-Type':'application/json'},body:JSON.stringify(input)});if(r.status!==200)throw Error('control '+input.op+': '+await r.text());return r.json();};
  const a=new NativeWeChatClient({baseUrl:hub.ready.endpoint,token});
  await a.createAccount(ACCOUNT);
  const op=await a.login(ACCOUNT,{strategy:'qr',qrRefresh:{mode:'manual',maxRefreshes:0}},'login-1');
  await waitFor('qr',async()=>(await a.operation(ACCOUNT,op.id)).state==='awaiting_scan');
  await control({op:'login',account:ACCOUNT,status:'approved'});
  await waitFor('signed in',async()=>(await a.operation(ACCOUNT,op.id)).state==='succeeded');
  await waitFor('push',async()=>(await a.account(ACCOUNT)).incomingTransport==='simulator_push');
  console.log('hub ready, logged in with a synthetic account');

  // Weave, in process, on the same D1 helper the product tests use.
  const secret='ab'.repeat(32),bridgeToken='bridge-token-'+'x'.repeat(32),db=new D1(),store=new Store(db),world=await store.load(),aliceId='u:'+await hash('alice');
  ensurePerson(world,{userId:aliceId,displayName:'Alice'});await store.save(world);
  // The simulator's clock is virtual; Weave's clock follows it so staleness rules stay meaningful.
  let now=Date.parse('2023-11-14T22:13:30Z');
  const callWeave=async(identity,path,data,headers={})=>{const r=await handleAPI(new Request('https://weave.example/api/'+path,{method:data===undefined?'GET':'POST',headers:data?{Origin:'https://weave.example','Content-Type':'application/json',...headers}:headers,body:data?JSON.stringify(data):undefined}),{db,secret,identity:identity?{userId:identity,displayName:identity,email:identity+'@example.test'}:null,wechat:{token:bridgeToken},now});return r.json();};
  // Exactly what the bridge sends: no Origin header.
  const forwarded=[],prompts=[];let lastResult,stubReply='收到';
  const stubModel=async(_u,o)=>{prompts.push(JSON.parse(o.body));return Response.json({content:[{type:'text',text:stubReply}],stop_reason:'end_turn'});};
  const weave=async(path,body)=>{
    if(path==='events'&&body.createdAt)now=Math.max(now,Date.parse(body.createdAt)+1000);
    const r=await handleAPI(new Request('https://weave.example/api/internal/wechat/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bridgeToken},body:JSON.stringify(body)}),{db,secret,identity:null,wechat:{token:bridgeToken},agentProviderApiKey:'managed-provider-key',fetcher:stubModel,now});
    if(!r.ok)throw Error('weave '+path+' '+r.status+' '+await r.text());
    const result=await r.json();if(path==='events'){forwarded.push({message:body,result});lastResult=result;}return result;
  };
  // The same call the bridge makes each minute with WEAVE_TICK=1.
  const schedule=()=>weave('tick',{});
  const daemon=createDaemon({baseUrl:hub.ready.endpoint+'/v1',token,account:ACCOUNT});
  let cursor='';
  const follow=()=>{const controller=new AbortController();const done=(async()=>{try{const r=await daemon.stream(cursor,controller.signal);for await(const e of sseEvents(r.body))await handleEvent(e,{daemon,weave,saveCursor:async c=>{cursor=c;}});}catch(e){if(!controller.signal.aborted)console.log('stream error',e.message);}})();return {stop:async()=>{controller.abort();await done;}};};
  let stream=follow();
  // First connect replays history: it must reach Weave and be ignored, never answered.
  await waitFor('baseline replay',()=>forwarded.length>=1);await new Promise(r=>setTimeout(r,300));
  const baseline=forwarded.at(-1);
  console.log('first-run replay:',baseline.message.body,'->',JSON.stringify(baseline.result));
  check('首次连接回放的历史消息不会被回复',()=>assert.equal(baseline.result.ignored,true));
  const nextResult=async(label,inject)=>{const before=forwarded.length;await inject();await waitFor(label,()=>forwarded.length>before);return forwarded.at(-1);};
  const deliver=()=>deliverOnce({daemon,weave,waitMs:50,attempts:60});

  // 1. Private: bind, then chat.
  const bind=await callWeave('alice','wechat/bind',{});
  const bound=await nextResult('bind',()=>control({op:'inbound',account:ACCOUNT,peer:'sim_mei',body:bind.instruction}));
  console.log('private message as Weave receives it:',JSON.stringify(bound.message));
  check('私聊绑定码经真实事件流到达 Weave 并绑定',()=>assert.equal(bound.result.bound,true));
  check('私聊发送者 senderId 是对方微信号',()=>assert.equal(bound.message.senderId,'sim_mei'));
  assert.ok(await deliver()>=1);
  const mei=await a.messages(ACCOUNT,'sim_mei');
  check('绑定确认出现在 hub 的外发历史里',()=>assert.ok(mei.items.some(m=>m.direction==='outgoing'&&m.body.includes('微信已连接'))));
  await nextResult('chat',()=>control({op:'inbound',account:ACCOUNT,peer:'sim_mei',body:'你好'}));
  check('已绑定用户的私聊进入队列',()=>assert.equal(lastResult.queued,true));
  stubReply='你好呀';assert.equal((await schedule()).processed,1);await deliver();
  const mei2=await a.messages(ACCOUNT,'sim_mei');
  check('私聊回复内容正确',()=>assert.ok(mei2.items.some(m=>m.direction==='outgoing'&&m.body==='你好呀')));
  const sendCountBefore=forwarded.length;await new Promise(r=>setTimeout(r,500));
  check('自己发出的消息不会被转回 Weave（不会自言自语）',()=>{assert.equal(forwarded.length,sendCountBefore);assert.ok(forwarded.every(f=>f.message.direction==='incoming'));});

  // 2. Group: real create, then inbound through the hub's real group parser.
  const created=await a.createGroup(ACCOUNT,{members:['sim_mei','sim_daniel'],name:'打卡群'},'group-1');
  const finished=await waitFor('group',async()=>{const o=await a.operation(ACCOUNT,created.id);return o.state==='succeeded'&&o;});
  const room=finished.result.groupId;console.log('group',room);
  const groupSay=(sender,text,mentioned=false)=>control({op:'inbound',account:ACCOUNT,peer:room,body:`${sender}:\n${text}`,...(mentioned?{source:'<msgsource><atuserlist>{self}</atuserlist></msgsource>'}:{})});
  const beforeGroup=await a.messages(ACCOUNT,room);
  const stranger=await nextResult('unenabled group',()=>groupSay('sim_daniel','还没开启时的群消息'));
  console.log('group message as Weave receives it:',JSON.stringify(stranger.message));
  check('群消息 senderId 是真实发言人，不是群号',()=>assert.equal(stranger.message.senderId,'sim_daniel'));
  check('群消息正文不带「发送者:」前缀',()=>assert.equal(stranger.message.body,'还没开启时的群消息'));
  check('未 @ 时 mentions.self 为假',()=>assert.equal(stranger.message.mentions.self,false));
  check('未开启的群被直接丢弃',()=>assert.equal(stranger.result.ignored,true));
  const dump1=JSON.stringify(await new Store(db).load());
  check('未开启的群消息不在数据库里',()=>assert.ok(!dump1.includes('还没开启时的群消息')));
  const denied=await nextResult('denied',()=>groupSay('sim_daniel','@助理 开启打卡群',true));
  console.log('mentioned group message as Weave receives it:',JSON.stringify(denied.message));
  check('被 @ 时真实解析出 mentions.self=true',()=>assert.equal(denied.message.mentions.self,true));
  check('未绑定成员不能开启',()=>assert.equal(denied.result.denied,true));
  await deliver();
  const enable=await nextResult('enable',()=>groupSay('sim_mei','@助理 开启打卡群',true));
  check('已绑定成员能开启',()=>assert.equal(enable.result.enabled,true));
  await deliver();
  const roomAfter=await a.messages(ACCOUNT,room);
  check('开启声明真实发到群里',()=>assert.ok(roomAfter.items.some(m=>m.direction==='outgoing'&&m.body.includes('已开启打卡助理'))));
  const context=await nextResult('context',()=>groupSay('sim_daniel','今天走了八千步'));
  check('普通消息只存上下文，不调模型',()=>{assert.equal(context.result.stored,true);});
  const promptsBefore=prompts.length;assert.equal((await schedule()).processed,0);
  check('普通消息没有触发模型',()=>assert.equal(prompts.length,promptsBefore));
  const skip=await nextResult('skip',()=>groupSay('sim_daniel','别记 今天情绪很差'));
  check('「别记」不保存',()=>assert.equal(skip.result.skipped,true));
  const ask=await nextResult('ask',()=>groupSay('sim_daniel','@助理 我们这周怎么样',true));
  check('@ 助理的提问进入队列',()=>assert.equal(ask.result.queued,true));
  stubReply='你们这周都在坚持';assert.equal((await schedule()).processed,1);
  const prompt=JSON.stringify(prompts.at(-1));
  check('群回复的提示词包含群聊记录',()=>{assert.match(prompt,/八千步/);assert.match(prompt,/这周怎么样/);});
  check('群回复的提示词没有微信号，也没有「别记」内容',()=>{for(const s of ['sim_daniel','sim_mei',room,'情绪很差'])assert.ok(!prompt.includes(s),s);});
  await deliver();
  const replied=(await a.messages(ACCOUNT,room)).items.find(m=>m.direction==='outgoing'&&m.body.includes('你们这周都在坚持'));
  console.log('group reply in hub:',JSON.stringify({body:replied?.body,mentions:replied?.mentions}));
  check('群回复真实发出',()=>assert.ok(replied));
  check('群回复真实 @ 了提问的人',()=>assert.deepEqual(replied.mentions.userIds,['sim_daniel']));
  const dump2=JSON.stringify(await new Store(db).load());
  check('群聊原文和微信号不以明文进数据库',()=>{for(const s of ['八千步','这周怎么样','你们这周都在坚持',room])assert.ok(!dump2.includes(s),s);});
  const close=await nextResult('close',()=>groupSay('sim_daniel','@助理 关闭打卡群',true));
  check('任何成员都能关闭',()=>assert.equal(close.result.closed,true));
  await deliver();
  const after=await nextResult('after close',()=>groupSay('sim_mei','关闭之后的消息'));
  check('关闭后不再读取',()=>assert.equal(after.result.ignored,true));

  // 3. Resilience against the real hub.
  await stream.stop();
  await control({op:'inbound',account:ACCOUNT,peer:'sim_mei',body:'桥接断开时收到的消息'});
  const before=forwarded.length;stream=follow();
  await waitFor('replay',()=>forwarded.slice(before).some(f=>f.message.body==='桥接断开时收到的消息'));
  check('补回时不会重复转发已处理的消息',()=>assert.ok(!forwarded.slice(before).some(f=>f.message.body==='你好')));
  const say=async text=>{stubReply=text;await nextResult('chat '+text,()=>control({op:'inbound',account:ACCOUNT,peer:'sim_mei',body:'问：'+text}));await schedule();};
  const statusOf=async text=>Object.values((await new Store(db).load()).wechat).find(x=>x.text===text)?.status;
  await deliver();
  await control({op:'send_fault',account:ACCOUNT,fault:'reject'});await say('会被拒绝的回复');await deliver();
  const rejected=await statusOf('会被拒绝的回复');check('微信拒收时记为 failed，不再重试',()=>assert.equal(rejected,'failed'));
  await control({op:'send_fault',account:ACCOUNT,fault:'lost_acknowledgment'});await say('确认丢失的回复');await deliver();
  const lost=await statusOf('确认丢失的回复');check('确认丢失时记为 uncertain，不重发',()=>assert.equal(lost,'uncertain'));
  await say('掉线前排队的回复');
  await control({op:'revoke',account:ACCOUNT});
  await control({op:'notify',account:ACCOUNT}).catch(()=>{});
  await waitFor('logged out',async()=>(await a.account(ACCOUNT)).authenticated===false,15000);
  const delivered=await deliver();
  const queued=await statusOf('掉线前排队的回复');
  console.log('after logout: delivered',delivered,'status',queued);
  check('小号掉线时消息留在队列，不判失败',()=>{assert.equal(delivered,0);assert.ok(['sending','queued'].includes(queued),queued);});
  await stream.stop();
  const fails=results.filter(r=>r[0]==='FAIL');
  console.log(`\n${results.length-fails.length}/${results.length} passed`);exit=fails.length?1:0;
}catch(error){console.error('E2E ABORTED:',error.message);}
finally{for(const p of processes)p.kill();await new Promise(r=>setTimeout(r,300));await rm(temp,{recursive:true,force:true}).catch(()=>{});process.exit(exit);}
