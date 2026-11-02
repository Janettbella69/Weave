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
export async function handleEvent(event,{daemon,weave,saveCursor}){
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
export async function deliverOnce({daemon,weave,waitMs=500,attempts=20,sleep=delay,throttle}){
  const {jobs}=await weave('claim',{});let delivered=0;
  for(const job of jobs){
    if(throttle){
      const verdict=throttle.admit(job);
      if(verdict==='drop'){console.error('这条消息被发送上限压了太久，已放弃：'+job.id);await weave('receipt',{id:job.id,state:'failed'});continue;}
      if(verdict==='hold')continue;
      const gap=throttle.gap();if(gap>0)await sleep(gap);
    }
    let state;
    try{
      let send=await daemon.send(job);
      throttle?.record(job);
      for(let i=0;i<attempts&&!TERMINAL.has(send.state);i++){await sleep(waitMs);send=await daemon.sendStatus(send.id);}
      state=send.state;
    }catch(error){
      if(REJECTED.has(error.status))state='failed';
      else{console.error('消息暂时发不出去，稍后用同一幂等键重试：'+error.message);continue;}
    }
    // Not terminal yet: keep the lease; the next claim reuses the same idempotency key.
    if(!TERMINAL.has(state))continue;
    await weave('receipt',{id:job.id,state});delivered++;
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
  const throttle=throttleFromEnv(env);
  console.log('微信桥接已启动。');
  void follow({daemon,weave,cursors,isStopping:()=>stopping});
  if(env.WEAVE_TICK==='1')void tickLoop({weave,isStopping:()=>stopping});
  while(!stopping){
    try{await deliverOnce({daemon,weave,throttle});}catch(error){console.error('发送队列暂时不可用：'+error.message);}
    // Weave queues replies from a once-a-minute Cron, and each poll reads D1.
    await delay(20000);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
