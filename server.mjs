import http from 'node:http';
import {calendarICS} from './calendar.mjs';
import {readFile,mkdir,writeFile,rename,copyFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {validateContext,matchSlots} from './council.mjs';
import {createPlan,syncPlan} from './agent.mjs';
import {migrateWorld,personFor,updateProfile,peopleIds} from './workspace.mjs';
import {handleWeaveChat} from './weave-chat.mjs';
import {startNegotiation,authorize,confirm,decline,findNegotiation,publicNegotiation,exportPlan,invalidateNegotiations} from './negotiation.mjs';
import {addReminder,runReminders} from './reminders.mjs';
import {NotionClient} from './integrations/notion.mjs';
import {GewechatClient,authenticated,normalizeEvent} from './integrations/gewechat.mjs';
import {createWorker} from './integrations/worker.mjs';
const root=new URL('./public/',import.meta.url),dataDir=new URL('./.data/',import.meta.url);
await mkdir(dataDir,{recursive:true});let previous;
try{previous=JSON.parse(await readFile(new URL('state.json',dataDir),'utf8'));if(previous.version!==2)await copyFile(new URL('state.json',dataDir),new URL('state-v1-backup.json',dataDir),1);}catch(e){if(e.code!=='ENOENT'&&e.code!=='EEXIST')throw e;}
const world=migrateWorld(previous);
for(const entry of Object.values(world.wechatInbox)){if(['processing','sending'].includes(entry.status)){entry.status='uncertain';entry.error='进程中断，执行结果需人工核对';}}
for(const person of Object.values(world.people))for(const p of person.plans)if(p.syncStatus==='sending')p.syncStatus='uncertain';
for(const n of world.negotiations)for(const p of Object.values(n.exports||{}))if(p.syncStatus==='sending')p.syncStatus='uncertain';
let diskQueue=Promise.resolve();
function save(){const snapshot=JSON.stringify(world,null,2);const result=diskQueue.then(async()=>{const temp=new URL('state.tmp',dataDir);await writeFile(temp,snapshot,{mode:0o600});await rename(temp,new URL('state.json',dataDir));});diskQueue=result.catch(()=>{});return result;}
await save();let operations=Promise.resolve();
function exclusive(task){const result=operations.then(task);operations=result.catch(()=>{});return result;}
const notions={lulu:new NotionClient({token:process.env.NOTION_TOKEN,pageId:process.env.NOTION_PAGE_ID}),meng:new NotionClient({token:process.env.NOTION_FRIEND_TOKEN||process.env.NOTION_TOKEN,pageId:process.env.NOTION_FRIEND_PAGE_ID})};
function notionFor(id){return notions[id];}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function readJson(req,limit=20000){if(!(req.headers['content-type']||'').startsWith('application/json'))throw Error('需要 JSON 请求');let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('输入过长');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('JSON 格式错误');}}
const geweEnabled=!!process.env.GEWECHAT_BASE_URL;
const wxids={lulu:process.env.GEWECHAT_OWNER_WXID,meng:process.env.GEWECHAT_FRIEND_WXID};
if(wxids.lulu&&wxids.meng&&wxids.lulu===wxids.meng)throw Error('两个用户必须使用不同的 wxid');
let drain;const acknowledgements=new Map();
function notify(personId,text){if(!geweEnabled||!wxids[personId])return;const id='notification:'+randomUUID();world.wechatInbox[id]={id,personId,from:wxids[personId],reply:text.slice(0,4000),status:'ready',createdAt:new Date().toISOString()};}
const chat=(id,text)=>handleWeaveChat(world,id,text,{notionFor,save,notify});
if(geweEnabled){
 const secret=process.env.GEWECHAT_CALLBACK_SECRET;
 if(!secret||secret.length<24||!process.env.GEWECHAT_APP_ID||!wxids.lulu)throw Error('微信接入需要 appId、指定用户和至少 24 字符的回调密钥');
 const client=new GewechatClient({baseUrl:process.env.GEWECHAT_BASE_URL,token:process.env.GEWECHAT_TOKEN,appId:process.env.GEWECHAT_APP_ID});
 drain=createWorker({state:world,save,client,exclusive,handleMessage:entry=>chat(entry.personId||'lulu',entry.text)});
 http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost'),prefix='/webhooks/gewechat/';
  if(req.method!=='POST'||!url.pathname.startsWith(prefix)||!authenticated(decodeURIComponent(url.pathname.slice(prefix.length)),secret))return json(res,403,{error:'回调鉴权失败'});
  const payload=await readJson(req,100000),event=normalizeEvent(payload,{appId:process.env.GEWECHAT_APP_ID,allowedWxids:Object.values(wxids).filter(Boolean)});
  if(!event)return json(res,200,{ok:true,ignored:true});const existing=world.wechatInbox[event.id];
  if(existing){await acknowledgements.get(event.id);return json(res,200,{ok:true,duplicate:true});}
  if(Object.keys(world.wechatInbox).length>=5000)return json(res,503,{error:'回调记录已达上限，请维护本地记录后重试'});
  world.wechatInbox[event.id]={...event,personId:peopleIds.find(id=>wxids[id]===event.from),status:'queued',createdAt:new Date().toISOString()};
  const durable=save();acknowledgements.set(event.id,durable);try{await durable;}catch(e){delete world.wechatInbox[event.id];throw e;}finally{acknowledgements.delete(event.id);}
  json(res,200,{ok:true});void drain().catch(()=>console.error('微信队列处理失败，请检查本地状态'));
 }catch(e){json(res,400,{error:e.message});}}).listen(Number(process.env.GEWECHAT_WEBHOOK_PORT)||4318,process.env.GEWECHAT_WEBHOOK_HOST||'127.0.0.1',()=>console.log('Gewechat callback listener enabled'));
 void drain().catch(()=>console.error('微信队列恢复失败'));
}
const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost'),id=url.searchParams.get('person')||'lulu',person=personFor(world,id),notion=notionFor(id);
 // Local persona selector is a demo surface, not a hosted multiuser authentication system.
 if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{brand:'Weave',localDemo:true,timezone,personId:id,profile:person.profile,people:peopleIds.map(p=>({id:p,name:world.people[p].profile.name})),model:process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL?'live':'demo',notion:notion.configured(),wechat:{configured:geweEnabled,online:'unchecked',queued:Object.values(world.wechatInbox).filter(x=>['queued','ready','processing'].includes(x.status)).length,uncertain:Object.values(world.wechatInbox).filter(x=>x.status==='uncertain').length},plans:person.plans,checkins:person.checkins,messages:person.messages,calendar:person.calendar,reminders:person.reminders,negotiations:world.negotiations.filter(n=>n.participants.includes(id)).map(n=>publicNegotiation(n,id))});
 if(req.method==='GET'&&url.pathname==='/api/calendar.ics'){res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'attachment; filename=weave-calendar.ics','Cache-Control':'no-store'});return res.end(calendarICS(person));}
 if(req.method==='GET'&&url.pathname==='/api/memory')return json(res,200,{text:await notion.memory()});
 if(req.method==='POST'&&url.pathname.startsWith('/api/')){
  const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`)return json(res,403,{error:'不允许跨站请求'});const input=await readJson(req);
  const output=await exclusive(async()=>{
   if(url.pathname==='/api/chat')return chat(id,input.text);
   if(url.pathname==='/api/profile'){updateProfile(person,input);invalidateNegotiations(world,id);await save();return person.profile;}
   if(url.pathname==='/api/negotiations/start'){const n=startNegotiation(world,id,input.peer,input.activity,input.consent);for(const peer of n.participants.filter(x=>x!==id))notify(peer,`${person.profile.name} 邀请你一起${n.activity}。回复「授权协商 ${n.id.slice(0,8)}」参与，或「拒绝协商 ${n.id.slice(0,8)}」。`);await save();return publicNegotiation(n,id);}
   if(url.pathname==='/api/negotiations/action'){
    const n=findNegotiation(world,input.id,id);
    if(input.action==='authorize')authorize(world,n.id,id);else if(input.action==='confirm')confirm(world,n.id,id,input.revision);else if(input.action==='decline')decline(world,n.id,id);else if(input.action==='sync'){const p=exportPlan(world,n,id);await syncPlan(person,p,notion,save);}else throw Error('未知协商操作');
    if(input.action!=='sync')for(const peer of n.participants.filter(x=>x!==id))notify(peer,`协商 ${n.id.slice(0,8)} 已更新：${n.status}${n.candidate?'，'+n.candidate.slot.replace('T',' ')+' '+n.activity:''}。${n.status==='awaiting_confirmation'?'回复「确认协商 '+n.id.slice(0,8)+'」确认。':''}`);await save();return publicNegotiation(n,id);
   }
   if(url.pathname==='/api/reminders'){const r=addReminder(person,input);await save();return r;}
   if(url.pathname==='/api/reminders/cancel'){const r=person.reminders.find(r=>r.id===input.id);if(!r||r.status!=='scheduled')throw Error('没有可取消的提醒');r.status='cancelled';await save();return r;}
   if(url.pathname==='/api/council'){const plan=await createPlan(person,validateContext(input),notion);await save();return plan;}
   if(url.pathname==='/api/approve'){const p=person.plans.find(x=>x.id===input.id);if(!p)throw Error('计划不存在');p.approved=true;await save();return p;}
   if(url.pathname==='/api/checkin'){if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw Error('请填写 1–2000 字反馈');person.checkins.push({id:randomUUID(),text:input.text.trim(),createdAt:new Date().toISOString()});await save();return {ok:true};}
   if(url.pathname==='/api/match')return {slots:matchSlots(input.mine,input.theirs),mode:'simulation',message:'旧版本时间交集演示；完整协商请使用 /api/negotiations 接口'};
   if(url.pathname==='/api/sync')return syncPlan(person,person.plans.find(x=>x.id===input.id),notion,save);
   throw Error('接口不存在');
  });json(res,200,output);if(drain)void drain().catch(()=>console.error('微信通知发送失败'));return;
 }
 if(req.method!=='GET')return json(res,405,{error:'方法不支持'});const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'},file=files[url.pathname];if(!file)return json(res,404,{error:'未找到'});
 res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL(file,root)));
}catch(e){json(res,400,{error:e.message||'操作失败，请重试'});}}).listen(Number(process.env.PORT)||4317,'127.0.0.1',()=>console.log('Weave: http://127.0.0.1:'+(Number(process.env.PORT)||4317)));
async function tick(){await exclusive(async()=>{if(runReminders(world,Date.now(),notify))await save();});if(drain)void drain().catch(()=>console.error('微信提醒发送失败'));}
const timer=setInterval(()=>void tick().catch(()=>console.error('提醒任务执行失败')),1000);timer.unref();await tick();
