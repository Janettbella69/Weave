// Runs next to the agent-wechat daemon. Connects outward only: no public port, tunnel
// or webhook. Follows the daemon's event stream into Weave and delivers Weave's queue.
import {createHash} from 'node:crypto';
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
    // 看图（media 权限）：一条消息的附件清单，和守护进程已经存好的一份副本。这两个都只读本机，不会去微信下载；
    // 会去微信下载的是 POST /messages/{id}/media-transfers，这里没有，也不许加。
    media:async id=>(await request('/messages/'+encodeURIComponent(id)+'/media',{signal:AbortSignal.timeout(15000)})).json(),
    content:id=>request('/media/'+encodeURIComponent(id)+'/content',{signal:AbortSignal.timeout(30000)}),
  };
}
export function createWeave({origin,token,fetcher=fetch}){
  return async(path,data,{timeoutMs=25000}={})=>{
    // 看图：一张照片按原样的字节发，它属于哪条消息、谁发的写在请求头里（不进地址，免得进 nginx 的访问日志）。别的都是 JSON。
    const photo=data?.bytes instanceof Uint8Array;
    const headers=photo?{'Content-Type':data.mediaType,'X-Weave-For':data.for,'X-Weave-Thread':data.threadId,'X-Weave-Sender':data.senderId}:{'Content-Type':'application/json'};
    const response=await fetcher(`${origin.replace(/\/$/,'')}/api/internal/wechat/${path}`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{...headers,Authorization:'Bearer '+token},body:photo?data.bytes:JSON.stringify(data)});
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
// photos：看图打开时的 createPhotos()；关着时是 undefined，这里和以前一模一样。
export async function handleEvent(event,{daemon,weave,saveCursor,photos}){
  if(event.kind==='message.committed'&&event.data?.direction==='incoming'&&typeof event.data.messageId==='string'){
    const full=await daemon.message(event.data.messageId),message=forwardable(full);
    if(message&&photos)photos.answered(full,await weave('events',{...message,...photos.extraFor(full)}));
    else if(message)await weave('events',message);
    else photos?.seen(full);
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
// ── the fast path: act on a message when it arrives instead of at the next poll ───────────────────────────────────────────
// Runs `job` one at a time. request(): now, or, if it is running, exactly one more time after it, however many requests come in
// meanwhile. ifIdle(): only if nothing is running; the fallback loops use it, because behind a busy run they would only queue a
// pointless extra one. The job should handle its own errors; one that throws anyway is logged and does not wedge the flight.
export function singleFlight(job){
  let running=false,again=false;
  const start=async()=>{
    running=true;
    try{do{again=false;try{await job();}catch(error){console.error('后台任务出错：'+error.message);}}while(again);}
    finally{running=false;}
  };
  return {
    request:()=>{if(running){again=true;return Promise.resolve();}return start();},
    ifIdle:()=>running?Promise.resolve():start(),
  };
}
// The tick Weave needs when Cron does not fire (WEAVE_TICK=1). A tick can wait on several model calls, hence the long timeout.
// When it returns, afterTick runs: the replies it queued should go out now, not at the next poll.
export function createTick({weave,afterTick=()=>{}}){
  return singleFlight(async()=>{
    try{await weave('tick',{},{timeoutMs:170000});}catch(error){console.error('定时任务暂时跑不了：'+error.message);}
    afterTick();
  });
}
// Weave answers /events with wake:true when it queued something for the Agent and outbound:true when it queued a message to send.
// A server that sends neither (an older one) changes nothing. Only the answers to /events and /photo (看图: the message that waited
// for a photo is queued now) are looked at.
export function withHints(weave,{onWake,onOutbound}){
  return async(path,data,options)=>{
    const result=await weave(path,data,options);
    if((path==='events'||path==='photo')&&result){
      if(result.wake===true)onWake();
      if(result.outbound===true)onOutbound();
    }
    return result;
  };
}
// Puts the pieces together. `deliver` is one delivery pass; withTick says whether this bridge runs ticks itself (WEAVE_TICK=1).
// A wake runs a tick at once, a tick that returns is followed by a delivery pass, and an outbound hint runs one too. Everything is
// single-flight, so a burst of messages means at most one tick running and one waiting, and never two deliveries at the same time.
export function createFastPath({weave,deliver,withTick,isStopping=()=>false}){
  const delivery=singleFlight(deliver);
  const ticking=withTick?createTick({weave,afterTick:()=>{if(!isStopping())void delivery.request();}}):null;
  const hinted=withHints(weave,{
    onWake:()=>{if(ticking&&!isStopping())void ticking.request();},
    onOutbound:()=>{if(!isStopping())void delivery.request();},
  });
  return {hinted,delivery,ticking};
}
// The fallbacks, for whatever a hint missed or an older server never announces: a tick every 60 s (when the bridge runs ticks) and a
// delivery pass every 20 s. Weave queues replies from a once-a-minute Cron too, and each poll reads D1.
export async function tickLoop({ticking,isStopping,wait=delay}){
  while(!isStopping()){await ticking.ifIdle();await wait(60000);}
}
export async function deliveryLoop({delivery,isStopping,wait=delay}){
  while(!isStopping()){await delivery.ifIdle();await wait(20000);}
}
// 3 s after the first failure, doubling up to 60 s. A logged-out daemon refuses every time; waiting longer keeps the log short.
export const reconnectDelay=failures=>Math.min(3000*2**failures,60000);
async function follow({daemon,weave,cursors,isStopping,photos}){
  let cursor=await cursors.load(),failures=0;
  while(!isStopping()){
    const controller=new AbortController();
    try{
      const response=await daemon.stream(cursor,controller.signal);
      // Connected: whatever was wrong before is over, even if nothing arrives for a long while.
      failures=0;
      for await(const event of sseEvents(response.body)){
        await handleEvent(event,{daemon,weave,photos,saveCursor:async next=>{cursor=next;await cursors.save(next);}});
        if(isStopping())break;
      }
    }catch(error){console.error('事件连接中断，将从保存的位置继续：'+error.message);}
    finally{controller.abort();}
    if(!isStopping()){await delay(reconnectDelay(failures));failures++;}
  }
}
// ── 看图（WEAVE_WECHAT_IMAGES=1，默认关；docs/superpowers/specs/2026-11-03-wechat-images-design.md）───────────────────────
// 群里谁都能发照片，所以照片默认不离开这台 Mac。这里只在内存里记住最近 60 秒里每个人（按聊天 + 发照片的人）发的最后一张照片的
// 消息 id，不记内容。这个人 @ 它（私聊里是发一句话）时，在交给 Weave 的那条文字上加 photo：'ready' 是有一张配得上的照片，
// 'watch' 是没有、但可以再等 10 秒。Weave 只在这条消息真的要回复时（已绑定的本人、开启的群、不是「别记」）回 photo:'upload' 或
// 'watch'，这时才把照片读出来交过去（POST /photo）；回别的就什么都不做。读照片只读守护进程已经存好的副本（standard，没有就
// thumbnail，状态是 available），不调用 media-transfers，所以不会为了这个去微信下载。只收 JPEG、PNG、GIF、WebP，最多 2 MiB。
// 不合规定、读不出来、10 秒内没等到，就告诉 Weave「没有照片」（{for, none}），这一轮照常回答。日志里只有短指纹、大小和原因代码。
export const PHOTO_PAIR_MS=60000,PHOTO_WATCH_MS=10000,PHOTO_MAX_BYTES=2*1024*1024;
const PHOTO_TYPES=['image/jpeg','image/png','image/gif','image/webp'];
// 看字节开头认格式。和 hosted/lib/weave/wechat-photos.mjs、hosted/agent-service/images.mjs 里的是同一段（test/wechat-images-sync.test.mjs）。
export function sniffImage(bytes) {
  const at = (offset, text) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  if (bytes.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return null;
}
const timeOf=(message,fallback)=>{const t=Date.parse(message?.createdAt);return Number.isFinite(t)?t:fallback;};
const inGroup=threadId=>typeof threadId==='string'&&threadId.endsWith('@chatroom');
// 和 Weave 一样认人：私聊里聊天本身就是那个人。
const senderOf=message=>typeof message?.senderId==='string'&&message.senderId?message.senderId:inGroup(message?.threadId)?'':message?.threadId;
// 照片和文字配得上：照片在文字之前 60 秒内，或之后 10 秒内。用微信自己的时间，所以重启后补读的一批消息也一样配。
const pairs=(photoAt,textAt)=>photoAt-textAt<=PHOTO_WATCH_MS&&textAt-photoAt<=PHOTO_PAIR_MS;
// 日志里代替消息 id 的短指纹。
const print=id=>createHash('sha256').update(String(id)).digest('hex').slice(0,8);
async function readCapped(response,limit){
  if(Number(response.headers?.get?.('content-length'))>limit){await response.body?.cancel().catch(()=>{});return null;}
  const chunks=[];let size=0;
  for await(const chunk of response.body??[]){size+=chunk.length;if(size>limit)return null;chunks.push(chunk);}
  return new Uint8Array(Buffer.concat(chunks));
}
// 一张照片在守护进程里已经存好的副本：{bytes, mediaType}，或者 {problem: 原因代码}。
export async function readPhoto(daemon,messageId){
  let items;
  try{items=(await daemon.media(messageId))?.items;}catch(error){return {problem:'media_'+(Number.isInteger(error?.status)?error.status:'error')};}
  const usable=(Array.isArray(items)?items:[]).filter(a=>a&&typeof a.id==='string'&&a.messageId===messageId&&a.kind==='image'&&a.state==='available');
  let problem='not_cached';
  for(const variant of ['standard','thumbnail']){
    const asset=usable.find(a=>(a.actualVariant??a.variant)===variant);
    if(!asset)continue;
    const declared=typeof asset.contentType==='string'?asset.contentType.split(';')[0].trim().toLowerCase():'';
    if(Number.isFinite(asset.byteLength)&&asset.byteLength>PHOTO_MAX_BYTES){problem='too_large';continue;}
    if(declared&&!PHOTO_TYPES.includes(declared)){problem='unsupported';continue;}
    let bytes;
    try{bytes=await readCapped(await daemon.content(asset.id),PHOTO_MAX_BYTES);}catch(error){problem='content_'+(Number.isInteger(error?.status)?error.status:'error');continue;}
    if(!bytes){problem='too_large';continue;}
    const mediaType=sniffImage(bytes);
    if(!mediaType){problem='unsupported';continue;}
    return {bytes,mediaType};
  }
  return {problem};
}
// 看图在桥接这边的全部状态，只在内存里，重启就没了（没了也只是这一轮按没有照片回答）。
//   seen(message)              一张进来的照片（type 3）
//   extraFor(message)          一条要交给 Weave 的文字带不带 photo
//   answered(message, answer)  Weave 对那条文字的回答：'upload' 交照片，'watch' 等 10 秒
export function createPhotos({daemon,weave,now=Date.now,log=(...args)=>console.error(...args),later=(fn,ms)=>setTimeout(fn,ms),cancel=clearTimeout}){
  const held=new Map(),watching=new Map();
  let chain=Promise.resolve();
  // 照片一张一张地读、一张一张地交，不挡住事件流。
  const run=task=>{chain=chain.then(task).catch(error=>log('看图出错：'+error.message));return chain;};
  const keyOf=message=>message.threadId+'\n'+senderOf(message);
  const prune=()=>{const t=now();for(const [key,photo] of held)if(t-photo.seenAt>PHOTO_PAIR_MS)held.delete(key);};
  const tell=async(forId,problem)=>{
    try{await weave('photo',{for:forId,none:problem});}catch(error){log(`没能告诉 Weave 这条消息不带照片（${why(error)}），它最多 30 秒后自己开始：${print(forId)}`);}
  };
  const release=(forId,problem)=>run(async()=>{log(`这条消息不带照片（${word(problem)}）：${print(forId)}`);await tell(forId,problem);});
  const send=(text,photoId)=>run(async()=>{
    const photo=await readPhoto(daemon,photoId);
    if(!photo.bytes){
      log(`照片没有交给 Weave（${word(photo.problem)}${/^(media|content)_403$/.test(photo.problem)?'，桥接密钥可能没有 media 权限：跑 deploy/wechat-mac/images.sh on':''}）：${print(text.id)}`);
      return tell(text.id,photo.problem);
    }
    try{
      await weave('photo',{for:text.id,threadId:text.threadId,senderId:senderOf(text),bytes:photo.bytes,mediaType:photo.mediaType},{timeoutMs:60000});
      log(`照片已交给 Weave（${photo.mediaType}，${photo.bytes.length} 字节）：${print(text.id)}`);
    }catch(error){
      log(`照片没能交给 Weave（${why(error)}）：${print(text.id)}`);
      await tell(text.id,'upload_failed');
    }
  });
  return {
    seen(message){
      if(message?.type!==3||message.direction!=='incoming'||typeof message.id!=='string'||!message.id||typeof message.threadId!=='string')return;
      if(!senderOf(message))return;
      prune();
      const key=keyOf(message),at=timeOf(message,now()),watch=watching.get(key);
      if(watch&&pairs(at,watch.at)){cancel(watch.timer);watching.delete(key);void send(watch.text,message.id);return;}
      held.set(key,{id:message.id,at,seenAt:now()});
    },
    extraFor(message){
      // 只有可能开始一轮的消息才带：私聊里的每一句，群里 @ 了它的。
      if(inGroup(message?.threadId)&&message.mentions?.self!==true)return {};
      prune();
      const photo=held.get(keyOf(message));
      return {photo:photo&&pairs(photo.at,timeOf(message,now()))?'ready':'watch'};
    },
    answered(message,answer){
      const key=keyOf(message);
      if(answer?.photo==='upload'){
        const photo=held.get(key);held.delete(key);
        if(photo)void send(message,photo.id);else void release(message.id,'gone');
      }else if(answer?.photo==='watch'){
        const old=watching.get(key);
        if(old){cancel(old.timer);watching.delete(key);void release(old.text.id,'replaced');}
        const watch={text:message,at:timeOf(message,now())};
        watch.timer=later(()=>{if(watching.get(key)===watch){watching.delete(key);void release(message.id,'none');}},PHOTO_WATCH_MS);
        watch.timer?.unref?.();
        watching.set(key,watch);
      }
    },
    // 测试用：等手头的照片都处理完。
    settled:()=>chain,
  };
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
  const deliver=async()=>{try{await deliverOnce({daemon,weave,throttle,memory});}catch(error){console.error('发送队列暂时不可用：'+error.message);}};
  const {hinted,delivery,ticking}=createFastPath({weave,deliver,withTick:env.WEAVE_TICK==='1',isStopping:()=>stopping});
  // 看图默认关。打开要三样都有：这里的 WEAVE_WECHAT_IMAGES=1、带 media 权限的 WX_TOKEN、服务器的 WEAVE_WECHAT_IMAGES=1。
  const photos=env.WEAVE_WECHAT_IMAGES==='1'?createPhotos({daemon,weave:hinted}):undefined;
  if(photos)console.log('看图已打开：@ 它（私聊里是发一句话）的人刚发的一张照片会交给 Weave。');
  void follow({daemon,weave:hinted,cursors,isStopping:()=>stopping,photos});
  if(ticking)void tickLoop({ticking,isStopping:()=>stopping});
  await deliveryLoop({delivery,isStopping:()=>stopping});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
