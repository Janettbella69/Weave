// Runs next to the agent-wechat daemon. Connects outward only: no public port, tunnel
// or webhook. Follows the daemon's event stream into Weave and delivers Weave's queue.
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const TERMINAL=new Set(['accepted','succeeded','failed','cancelled','needs_review']);
const CONSUMER='weave-bridge';
// Only a request the daemon can never accept is a failure. Being logged out (409
// auth_required), rate limits and outages keep the job queued for the next claim.
const REJECTED=new Set([400,404,413,422]);

export function createDaemon({baseUrl,token,account,fetcher=fetch}){
  const root=`${baseUrl.replace(/\/$/,'')}/accounts/${encodeURIComponent(account)}`;
  const request=async(path,options={})=>{
    const response=await fetcher(root+path,{...options,redirect:'manual',headers:{Authorization:'Bearer '+token,...options.headers}});
    if(!response.ok){
      const code=await response.json().then(x=>x?.error?.code,()=>undefined);
      const error=Error(`agent-wechat 请求失败 (${response.status}${code?' '+code:''})`);error.status=response.status;error.code=code;throw error;
    }
    return response;
  };
  return {
    stream:(after,signal)=>request('/events/stream'+(after?`?after=${encodeURIComponent(after)}`:''),{signal,headers:{Accept:'text/event-stream'}}),
    message:async id=>(await request('/messages/'+encodeURIComponent(id),{signal:AbortSignal.timeout(30000)})).json(),
    ack:cursor=>request(`/consumers/${CONSUMER}/ack`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({cursor})}),
    send:async(job)=>(await request('/sends',{method:'POST',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','Idempotency-Key':job.id},body:JSON.stringify({threadId:job.threadId,text:job.text,...(job.mentions?{mentions:job.mentions}:{})})})).json(),
    sendStatus:async id=>(await request('/sends/'+encodeURIComponent(id),{signal:AbortSignal.timeout(15000)})).json(),
    // One read from WeChat of a group's member list, written into the daemon's own copy; nothing is posted in the group. Read scope is enough.
    // It starts an operation (202); operation() follows it.
    refreshMembers:async group=>(await request('/groups/'+encodeURIComponent(group)+'/members/refresh',{method:'POST',signal:AbortSignal.timeout(15000)})).json(),
    operation:async id=>(await request('/operations/'+encodeURIComponent(id),{signal:AbortSignal.timeout(15000)})).json(),
  };
}
export function createWeave({origin,token,fetcher=fetch}){
  return async(path,data,{timeoutMs=25000}={})=>{
    const response=await fetcher(`${origin.replace(/\/$/,'')}/api/internal/wechat/${path}`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(data)});
    if(!response.ok){const error=Error('Weave 拒绝了请求 ('+response.status+')');error.status=response.status;throw error;}
    return response.json();
  };
}
// Only what Weave needs leaves this machine; other message types are never forwarded.
export function forwardable(message){
  if(message?.type!==1||message.direction!=='incoming'||typeof message.body!=='string'||!message.body.trim())return null;
  const {id,threadId,senderId,type,direction,body,createdAt,mentions}=message;
  return {id,threadId,senderId,type,direction,body,createdAt,mentions:{self:mentions?.self===true}};
}
export async function* sseEvents(body){
  const decoder=new TextDecoder();let buffer='',id='',data=[];
  for await(const chunk of body){
    buffer+=decoder.decode(chunk,{stream:true});
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index).replace(/\r$/,'');buffer=buffer.slice(index+1);
      if(line===''){
        if(data.length){try{const event=JSON.parse(data.join('\n'));event.cursor??=id;yield event;}catch{/* a malformed frame must not stop the stream */}}
        data=[];id='';
      }else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());
      else if(line.startsWith('id:'))id=line.slice(3).trim();
    }
  }
}
// What the daemon says about the WeChat session itself. A logged-out account raises no error here (the event stream stays up and
// nothing is being sent), so without these lines bridge.log would say nothing at all. Only the fields named here are ever copied,
// and only short plain values: never a message body, a name or a list of commands, whatever else the event carries.
const SESSION_FACTS={'account.connection':['state','source','serviceCode','authentication'],'account.updated':['authentication','connection'],'account.push':['state','reason','fallback'],'projection.blocked':['reason','blockedCommandCount','retryableAfterRepair']};
const plain=value=>(typeof value==='number'&&Number.isFinite(value))||typeof value==='boolean'||(typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(value));
export function eventFacts(event){
  const keys=SESSION_FACTS[event?.kind];
  if(!keys||!event.data||typeof event.data!=='object')return null;
  const facts=keys.filter(key=>plain(event.data[key])).map(key=>`${key}=${event.data[key]}`);
  return facts.length?facts.join(' '):null;
}
export function describeEvent(event){
  const facts=eventFacts(event);
  if(!facts)return null;
  if(event.kind==='account.connection'&&event.data.state==='auth_required')return '小号需要重新登录（Mac 上跑 login.sh）：'+facts;
  return {'account.connection':'微信连接：','account.updated':'微信账号：','account.push':'微信长连接：','projection.blocked':'有同步批次没能写入账号库：'}[event.kind]+facts;
}
export async function handleEvent(event,{daemon,weave,saveCursor,log=(...args)=>console.log(...args)}){
  const line=describeEvent(event);
  if(line)log(line);
  if(event.kind==='message.committed'&&event.data?.direction==='incoming'&&typeof event.data.messageId==='string'){
    const message=forwardable(await daemon.message(event.data.messageId));
    if(message)await weave('events',message);
  }
  // Advance only after Weave has the message, so a failure replays instead of losing it.
  if(event.cursor){await saveCursor(event.cursor);await daemon.ack(event.cursor).catch(()=>{});}
}
// Limits on what this bridge sends to WeChat. agent-wechat has none of its own, and what WeChat's risk control
// tolerates is unverified (there is no ban data), so these are conservative guesses, tunable from the environment.
// A refusal here is not a failure: a held job keeps its lease in Weave and is claimed again (same idempotency key)
// after the lease runs out. One held for longer than maxHoldMs is dropped instead, so a backlog is never sent late.
export function createThrottle({perChatPerMinute=6,totalPerMinute=12,perDay=200,minGapMs=1500,maxHoldMs=600000,now=Date.now}={}){
  const total=[],day=[],chats=new Map(),held=new Map();let last=-Infinity;
  const prune=(list,t,windowMs)=>{while(list.length&&t-list[0]>=windowMs)list.shift();};
  return {
    // 'send', 'hold' (over a limit, try again later) or 'drop' (held too long, give up).
    admit(job){
      const t=now(),chat=chats.get(job.threadId)??[];
      prune(total,t,60000);prune(day,t,86400000);prune(chat,t,60000);
      if(!chat.length)chats.delete(job.threadId);
      // Forget jobs that vanished from the queue (cancelled in Weave) so this map cannot grow.
      for(const [id,at] of held)if(t-at>3600000)held.delete(id);
      const since=held.get(job.id);
      if(since!==undefined&&t-since>maxHoldMs){held.delete(job.id);return 'drop';}
      if(chat.length>=perChatPerMinute||total.length>=totalPerMinute||day.length>=perDay){if(since===undefined)held.set(job.id,t);return 'hold';}
      held.delete(job.id);return 'send';
    },
    // How long to wait so two sends are at least minGapMs apart.
    gap(){return Math.max(0,last+minGapMs-now());},
    // Called once a send has actually been handed to the daemon.
    record(job){
      const t=now(),chat=chats.get(job.threadId)??[];
      total.push(t);day.push(t);chat.push(t);chats.set(job.threadId,chat);last=t;
    },
  };
}
const whole=(value,fallback,{zero=false}={})=>{const n=Number(value);return value!==undefined&&value!==''&&Number.isInteger(n)&&(zero?n>=0:n>0)?n:fallback;};
export function throttleFromEnv(env=process.env,now=Date.now){
  return createThrottle({
    perChatPerMinute:whole(env.WECHAT_SEND_PER_CHAT_PER_MIN,6),totalPerMinute:whole(env.WECHAT_SEND_TOTAL_PER_MIN,12),
    perDay:whole(env.WECHAT_SEND_PER_DAY,200),minGapMs:whole(env.WECHAT_SEND_MIN_GAP_MS,1500,{zero:true}),maxHoldMs:whole(env.WECHAT_SEND_MAX_HOLD_MS,600000),now,
  });
}
// A group reply asks the daemon to @ the person who asked. The daemon takes that person's display name from its own copy of the group's
// member list, and that copy can be missing or partial (a group it has only seen in an incoming message has no member table at all):
// 404 media_not_cached = no table, 409 = the person (or the account itself) is not in it, 400 invalid_mentions = an id it will not take.
// That must not lose the answer. In this order: ask WeChat once for the group's member list (one read, nothing is posted in the group)
// and try the @ again; if that does not help, or is not allowed again yet, send the answer without the @.
// Refused on the request (400, 404, 409): no send was created, because the member lookup runs before the send is stored. So the second
// try with the @ may use the same idempotency key.
const MENTION_REFUSALS={400:['invalid_mentions'],404:['media_not_cached'],409:['mention_member_unavailable','mention_group_membership_unavailable','profile_unavailable']};
const mentionRefused=error=>MENTION_REFUSALS[error?.status]?.includes(error.code)===true;
// Taken, then failed: the daemon checks the members once more when it submits, and ends the send as failed with an errorCode. That send
// exists under the first key, so the second try with the @ needs another one (:m2), and the version without the @ has its own (:plain).
const MENTION_FAILURES=new Set(['mention_member_unavailable','mention_group_membership_unavailable','mention_all_forbidden','mention_all_permission_unavailable','profile_unavailable']);
const mentionFailed=send=>send.state==='failed'&&MENTION_FAILURES.has(send.errorCode);
// A group's member list is asked for at most once per 10 minutes, and the bridge waits at most 60 s for the answer.
const REFRESH_EVERY_MS=600000,REFRESH_POLL_MS=1000,REFRESH_POLLS=60;
const OPERATION_END=new Set(['succeeded','failed','cancelled','expired','rejected']);
// A daemon error, state or number goes into the log only as a short plain value, never as anything that could carry a message or a name.
const word=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(value)?value:'-';
const why=error=>`${Number.isInteger(error?.status)?error.status:'-'} ${word(error?.code)}`;
const count=value=>Number.isInteger(value)&&value>=0?value:'-';
const flag=value=>typeof value==='boolean'?value:'-';
const asVersion=(job,name)=>name==='plain'?{id:job.id+':plain',threadId:job.threadId,text:job.text}:name==='m2'?{...job,id:job.id+':m2'}:job;
// What the bridge remembers between claims. A job that already moved to another version goes straight there when it is claimed again after a
// lease that ran out: the @ version might work by now, and sending that as well would put the same answer in the group twice.
const newMemory=()=>({version:new Map(),refreshedAt:new Map()});
export async function deliverOnce({daemon,weave,waitMs=500,attempts=20,sleep=delay,throttle,log=(...args)=>console.error(...args),memory=newMemory(),now=Date.now}){
  const {jobs}=await weave('claim',{});let delivered=0;
  // Waits (a few seconds at most) for the daemon to bring a send to an end state.
  const settle=async send=>{for(let i=0;i<attempts&&!TERMINAL.has(send.state);i++){await sleep(waitMs);send=await daemon.sendStatus(send.id);}return send;};
  // Sends one version of a job and follows it. A refusal throws.
  const sendAs=async(job,name)=>{const send=await daemon.send(asVersion(job,name));throttle?.record(job);return settle(send);};
  // Sends the version of a job with the @. {send}: the daemon took it and it did not fail on the @. Otherwise {problem} says what happened,
  // {stored} that a failed send now holds the key, {hard} that no member list can help (the id itself is refused).
  const withMentions=async(job,name)=>{
    let send;
    try{send=await sendAs(job,name);}
    catch(error){if(!mentionRefused(error))throw error;return {problem:`被拒（${why(error)}）`,hard:error.status===400};}
    return mentionFailed(send)?{problem:`发送失败（failed ${word(send.errorCode)}）`,stored:true}:{send};
  };
  // Asks WeChat for the group's member list and waits for the daemon to write it down. true = it finished.
  const refreshGroup=async(job,because)=>{
    const last=memory.refreshedAt.get(job.threadId);
    if(last!==undefined&&now()-last<REFRESH_EVERY_MS){log(`这个群的成员 10 分钟内刷新过了，这次不再刷新：${job.id}`);return false;}
    memory.refreshedAt.set(job.threadId,now());
    log(`${because}：${job.id}`);
    let operation;
    try{
      operation=await daemon.refreshMembers(job.threadId);
      for(let i=0;i<REFRESH_POLLS&&!OPERATION_END.has(operation.state);i++){await sleep(REFRESH_POLL_MS);operation=await daemon.operation(operation.id);}
    }catch(error){log(`刷新群成员没有成功（${why(error)}）：${job.id}`);return false;}
    if(!OPERATION_END.has(operation.state)){log(`群成员刷新 ${REFRESH_POLLS*REFRESH_POLL_MS/1000} 秒内没有结束（${word(operation.state)}）：${job.id}`);return false;}
    const result=operation.result??{};
    log(`群成员刷新结束（${word(operation.state)}，成员 ${count(result.memberCount)}，名单完整 ${flag(result.completeRoster)}）：${job.id}`);
    return operation.state==='succeeded';
  };
  const toPlain=async(job,because)=>{log(`${because}，已去掉 @ 重发：${job.id}`);memory.version.set(job.id,'plain');return sendAs(job,'plain');};
  const deliver=async job=>{
    const fixed=memory.version.get(job.id);
    if(!job.mentions||fixed==='plain')return sendAs(job,fixed==='plain'?'plain':'as-is');
    const first=await withMentions(job,fixed??'as-is');
    if(first.send)return first.send;
    // One refresh and one more try with the @ per job (a job already on :m2 has had its turn), and none for an id the daemon refuses.
    if(!fixed&&!first.hard&&await refreshGroup(job,`群消息带 @ ${first.problem}，先向微信刷新这个群的成员`)){
      const name=first.stored?'m2':'as-is';
      if(name==='m2')memory.version.set(job.id,'m2');
      const again=await withMentions(job,name);
      if(again.send){log(`刷新后带 @ 重发被守护进程收下：${job.id}`);return again.send;}
      return toPlain(job,`刷新后带 @ 重发仍${again.problem}`);
    }
    return toPlain(job,`群消息带 @ ${first.problem}`);
  };
  for(const job of jobs){
    if(throttle){
      const verdict=throttle.admit(job);
      if(verdict==='drop'){log('这条消息被发送上限压了太久，已放弃：'+job.id);await weave('receipt',{id:job.id,state:'failed'});continue;}
      if(verdict==='hold')continue;
      const gap=throttle.gap();if(gap>0)await sleep(gap);
    }
    let state;
    try{
      const send=await deliver(job);
      state=send.state;
      if(state==='failed'||state==='cancelled'||state==='needs_review')log(`发送结果是 ${word(state)}${send.errorCode?`（${word(send.errorCode)}）`:''}，已原样报告给 Weave：${job.id}`);
    }catch(error){
      if(REJECTED.has(error.status)){state='failed';log(`守护进程拒绝了这条消息（${why(error)}），已向 Weave 报告发送失败：${job.id}`);}
      else{log('消息暂时发不出去，稍后用同一幂等键重试：'+error.message);continue;}
    }
    // Not terminal yet: keep the lease; the next claim reuses the same idempotency key.
    if(!TERMINAL.has(state))continue;
    await weave('receipt',{id:job.id,state});memory.version.delete(job.id);delivered++;
  }
  return delivered;
}
export function cursorStore(file){
  return {
    async load(){try{return JSON.parse(await readFile(file,'utf8')).cursor||'';}catch{return '';}},
    async save(cursor){await mkdir(dirname(file),{recursive:true,mode:0o700});const temp=file+'.tmp';await writeFile(temp,JSON.stringify({cursor}),{mode:0o600});await rename(temp,file);},
  };
}
// For deployments where Cron does not fire. A tick can wait on several model calls.
async function tickLoop({weave,isStopping}){
  while(!isStopping()){
    try{await weave('tick',{},{timeoutMs:170000});}catch(error){console.error('定时任务暂时跑不了：'+error.message);}
    await delay(60000);
  }
}
// 3 s after the first failure, doubling up to 60 s. A logged-out daemon refuses every time; waiting longer keeps the log short.
export const reconnectDelay=failures=>Math.min(3000*2**failures,60000);
async function follow({daemon,weave,cursors,isStopping}){
  let cursor=await cursors.load(),failures=0;
  while(!isStopping()){
    const controller=new AbortController();
    try{
      const response=await daemon.stream(cursor,controller.signal);
      // Connected: whatever was wrong before is over, even if nothing arrives for a long while.
      failures=0;
      for await(const event of sseEvents(response.body)){
        await handleEvent(event,{daemon,weave,saveCursor:async next=>{cursor=next;await cursors.save(next);}});
        if(isStopping())break;
      }
    }catch(error){console.error('事件连接中断，将从保存的位置继续：'+error.message);}
    finally{controller.abort();}
    if(!isStopping()){await delay(reconnectDelay(failures));failures++;}
  }
}
export async function main(env=process.env){
  // launchd's log has no times of its own, and times are what you need when WeChat starts acting up.
  for(const level of ['log','error'])console[level]=(write=>(...args)=>write(new Date().toISOString(),...args))(console[level].bind(console));
  const origin=(env.WEAVE_ORIGIN||'').replace(/\/$/,'');
  if(!origin.startsWith('https://')&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('WEAVE_ORIGIN 必须是 HTTPS（本机测试可用 127.0.0.1）');
  if(!env.WECHAT_BRIDGE_TOKEN||env.WECHAT_BRIDGE_TOKEN.length<32)throw Error('请配置 WECHAT_BRIDGE_TOKEN（至少 32 字符）');
  if(!env.WX_TOKEN||!env.WX_ACCOUNT)throw Error('请配置 WX_TOKEN 和 WX_ACCOUNT');
  const daemon=createDaemon({baseUrl:env.WX_BASE_URL||'http://127.0.0.1:6174/v1',token:env.WX_TOKEN,account:env.WX_ACCOUNT});
  const weave=createWeave({origin,token:env.WECHAT_BRIDGE_TOKEN});
  const cursors=cursorStore(resolve(env.WECHAT_BRIDGE_STATE||fileURLToPath(new URL('./.data/cursor.json',import.meta.url))));
  // On a stop signal the loops finish what they are doing, but some are asleep for up to a minute, and launchd gives a
  // process 20 s before it kills it. So leave after 3 s at most. Nothing is lost: an unfinished send keeps its
  // idempotency key and is claimed again, and the cursor is saved atomically.
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;setTimeout(()=>process.exit(0),3000).unref();});
  const throttle=throttleFromEnv(env),memory=newMemory();
  console.log('微信桥接已启动。');
  void follow({daemon,weave,cursors,isStopping:()=>stopping});
  if(env.WEAVE_TICK==='1')void tickLoop({weave,isStopping:()=>stopping});
  while(!stopping){
    try{await deliverOnce({daemon,weave,throttle,memory});}catch(error){console.error('发送队列暂时不可用：'+error.message);}
    // Weave queues replies from a once-a-minute Cron, and each poll reads D1.
    await delay(20000);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
