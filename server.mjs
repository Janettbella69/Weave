import http from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {validateContext,matchSlots} from './council.mjs';
import {processChat,createPlan,syncPlan} from './agent.mjs';
import {NotionClient} from './integrations/notion.mjs';
import {GewechatClient,authenticated,normalizeEvent} from './integrations/gewechat.mjs';
import {createWorker} from './integrations/worker.mjs';
const root=new URL('./public/',import.meta.url),dataDir=new URL('./.data/',import.meta.url);
await mkdir(dataDir,{recursive:true});
let state;try{state=JSON.parse(await readFile(new URL('state.json',dataDir),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={plans:[],checkins:[]};}
state.messages??=[];state.pending??='';state.wechatInbox??={};
for(const entry of Object.values(state.wechatInbox)){if(['processing','sending'].includes(entry.status)){entry.status='uncertain';entry.error='进程中断，执行结果需人工核对';}}
for(const p of state.plans)if(p.syncStatus==='sending')p.syncStatus='uncertain';
let diskQueue=Promise.resolve();
function save(){const snapshot=JSON.stringify(state,null,2);const result=diskQueue.then(async()=>{const temp=new URL('state.tmp',dataDir);await writeFile(temp,snapshot,{mode:0o600});await rename(temp,new URL('state.json',dataDir));});diskQueue=result.catch(()=>{});return result;}
await save();
let operations=Promise.resolve();
function exclusive(task){const result=operations.then(task);operations=result.catch(()=>{});return result;}
const notion=new NotionClient({token:process.env.NOTION_TOKEN,pageId:process.env.NOTION_PAGE_ID});
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function readJson(req,limit=20000){if(!(req.headers['content-type']||'').startsWith('application/json'))throw Error('需要 JSON 请求');let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('输入过长');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('JSON 格式错误');}}
const geweEnabled=!!process.env.GEWECHAT_BASE_URL;
let drain;
const acknowledgements=new Map();
if(geweEnabled){
 const secret=process.env.GEWECHAT_CALLBACK_SECRET;
 if(!secret||secret.length<24||!process.env.GEWECHAT_APP_ID||!process.env.GEWECHAT_OWNER_WXID)throw Error('微信接入需要 appId、指定用户和至少 24 字符的回调密钥');
 const client=new GewechatClient({baseUrl:process.env.GEWECHAT_BASE_URL,token:process.env.GEWECHAT_TOKEN,appId:process.env.GEWECHAT_APP_ID});
 drain=createWorker({state,save,notion,client,exclusive});
 // Separate ingress: exposing the callback does not expose local chat history or controls.
 http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   const prefix='/webhooks/gewechat/';
   if(req.method!=='POST'||!url.pathname.startsWith(prefix)||!authenticated(decodeURIComponent(url.pathname.slice(prefix.length)),secret))return json(res,403,{error:'回调鉴权失败'});
   const payload=await readJson(req,100000),event=normalizeEvent(payload,{appId:process.env.GEWECHAT_APP_ID,ownerWxid:process.env.GEWECHAT_OWNER_WXID});
   if(!event)return json(res,200,{ok:true,ignored:true});
   const existing=state.wechatInbox[event.id];
   if(existing){await acknowledgements.get(event.id);return json(res,200,{ok:true,duplicate:true});}
   if(Object.keys(state.wechatInbox).length>=5000)return json(res,503,{error:'回调记录已达上限，请维护本地记录后重试'});
   const entry={...event,status:'queued',createdAt:new Date().toISOString()};state.wechatInbox[event.id]=entry;
   const durable=save();acknowledgements.set(event.id,durable);
   try{await durable;}catch(e){delete state.wechatInbox[event.id];throw e;}finally{acknowledgements.delete(event.id);}
   json(res,200,{ok:true});void drain().catch(()=>console.error('微信队列处理失败，请检查本地运行状态'));
  }catch(e){json(res,400,{error:e.message});}
 }).listen(Number(process.env.GEWECHAT_WEBHOOK_PORT)||4318,process.env.GEWECHAT_WEBHOOK_HOST||'127.0.0.1',()=>console.log('Gewechat callback listener enabled (separate from local UI)'));
 void drain().catch(()=>console.error('微信队列恢复失败'));
}
http.createServer(async(req,res)=>{
 try{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{model:process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL?'live':'demo',notion:notion.configured(),wechat:{configured:geweEnabled,online:'unchecked',queued:Object.values(state.wechatInbox).filter(x=>['queued','ready','processing'].includes(x.status)).length,uncertain:Object.values(state.wechatInbox).filter(x=>x.status==='uncertain').length},plans:state.plans,checkins:state.checkins,messages:state.messages});
 if(req.method==='GET'&&url.pathname==='/api/memory')return json(res,200,{text:await notion.memory()});
 if(req.method==='POST'&&url.pathname.startsWith('/api/')){
  const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`)return json(res,403,{error:'不允许跨站请求'});
  const input=await readJson(req);
  const output=await exclusive(async()=>{
   if(url.pathname==='/api/chat')return processChat(state,input.text,notion,save);
   if(url.pathname==='/api/council'){const plan=await createPlan(state,validateContext(input),notion);await save();return plan;}
   if(url.pathname==='/api/approve'){const p=state.plans.find(x=>x.id===input.id);if(!p)throw Error('计划不存在');p.approved=true;await save();return p;}
   if(url.pathname==='/api/checkin'){if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw Error('请填写 1–2000 字反馈');state.checkins.push({id:randomUUID(),text:input.text.trim(),createdAt:new Date().toISOString()});await save();return {ok:true};}
   if(url.pathname==='/api/match')return {slots:matchSlots(input.mine,input.theirs),mode:'simulation',message:'本地双角色协商演示，不会联系朋友或创建真实日程'};
   if(url.pathname==='/api/sync')return syncPlan(state,state.plans.find(x=>x.id===input.id),notion,save);
   throw Error('接口不存在');
  });return json(res,200,output);
 }
 if(req.method!=='GET')return json(res,405,{error:'方法不支持'});
 const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'},file=files[url.pathname];if(!file)return json(res,404,{error:'未找到'});
 res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL(file,root)));
 }catch(e){json(res,400,{error:e.message||'操作失败，请重试'});}
}).listen(Number(process.env.PORT)||4317,'127.0.0.1',()=>console.log('Habit Council: http://127.0.0.1:'+(Number(process.env.PORT)||4317)));
