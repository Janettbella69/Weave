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
export async function deliverOnce({daemon,weave,waitMs=500,attempts=20,sleep=delay}){
  const {jobs}=await weave('claim',{});let delivered=0;
  for(const job of jobs){
    let state;
    try{
      let send=await daemon.send(job);
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
async function follow({daemon,weave,cursors,isStopping}){
  let cursor=await cursors.load();
  while(!isStopping()){
    const controller=new AbortController();
    try{
      const response=await daemon.stream(cursor,controller.signal);
      for await(const event of sseEvents(response.body)){
        await handleEvent(event,{daemon,weave,saveCursor:async next=>{cursor=next;await cursors.save(next);}});
        if(isStopping())break;
      }
    }catch(error){console.error('事件连接中断，将从保存的位置继续：'+error.message);}
    finally{controller.abort();}
    if(!isStopping())await delay(3000);
  }
}
export async function main(env=process.env){
  const origin=(env.WEAVE_ORIGIN||'').replace(/\/$/,'');
  if(!origin.startsWith('https://')&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('WEAVE_ORIGIN 必须是 HTTPS（本机测试可用 127.0.0.1）');
  if(!env.WECHAT_BRIDGE_TOKEN||env.WECHAT_BRIDGE_TOKEN.length<32)throw Error('请配置 WECHAT_BRIDGE_TOKEN（至少 32 字符）');
  if(!env.WX_TOKEN||!env.WX_ACCOUNT)throw Error('请配置 WX_TOKEN 和 WX_ACCOUNT');
  const daemon=createDaemon({baseUrl:env.WX_BASE_URL||'http://127.0.0.1:6174/v1',token:env.WX_TOKEN,account:env.WX_ACCOUNT});
  const weave=createWeave({origin,token:env.WECHAT_BRIDGE_TOKEN});
  const cursors=cursorStore(resolve(env.WECHAT_BRIDGE_STATE||fileURLToPath(new URL('./.data/cursor.json',import.meta.url))));
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
  console.log('微信桥接已启动。');
  void follow({daemon,weave,cursors,isStopping:()=>stopping});
  if(env.WEAVE_TICK==='1')void tickLoop({weave,isStopping:()=>stopping});
  while(!stopping){
    try{await deliverOnce({daemon,weave});}catch(error){console.error('发送队列暂时不可用：'+error.message);}
    // Weave queues replies from a once-a-minute Cron, and each poll reads D1.
    await delay(20000);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
