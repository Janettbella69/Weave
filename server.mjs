import http from 'node:http';
import {chatIntent} from './chat.mjs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {validateContext,demoCouncil,liveCouncil,matchSlots} from './council.mjs';
const root=new URL('./public/',import.meta.url), dataDir=new URL('./.data/',import.meta.url);
await mkdir(dataDir,{recursive:true});
let state;try{state=JSON.parse(await readFile(new URL('state.json',dataDir),'utf8'));}catch{state={plans:[],checkins:[]};}
state.messages??=[];state.pending??='';
const save=()=>writeFile(new URL('state.json',dataDir),JSON.stringify(state,null,2));
const configured=()=>!!(process.env.NOTION_TOKEN&&process.env.NOTION_PAGE_ID);
async function notion(path,method='GET',body){
 const r=await fetch(`https://api.notion.com/v1/${path}`,{method,headers:{Authorization:`Bearer ${process.env.NOTION_TOKEN}`,'Notion-Version':'2025-09-03','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw new Error(`Notion 请求失败 (${r.status})，请检查页面授权和配置`);return r.json();
}
async function memory(){
 if(!configured())return '';
 let cursor, lines=[];
 do {const r=await notion(`blocks/${encodeURIComponent(process.env.NOTION_PAGE_ID)}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`);for(const b of r.results){const t=b[b.type];if(t?.rich_text)lines.push(t.rich_text.map(x=>x.plain_text||x.text?.content||'').join(''));}cursor=r.has_more?r.next_cursor:null;}while(cursor&&lines.join('').length<12000);
 return lines.join('\n').slice(0,12000);
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
const locks=new Set();
http.createServer(async(req,res)=>{
 try{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{model:process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL?'live':'demo',notion:configured(),plans:state.plans,checkins:state.checkins,messages:state.messages});
 if(req.method==='GET'&&url.pathname==='/api/memory')return json(res,200,{text:await memory()});
 if(req.method==='POST'&&url.pathname.startsWith('/api/')){
  const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`)return json(res,403,{error:'不允许跨站请求'});
  if(!(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'需要 JSON 请求'});
  let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)return json(res,413,{error:'输入过长'});}let input;try{input=JSON.parse(body);}catch{return json(res,400,{error:'JSON 格式错误'});}
  if(url.pathname==='/api/chat'){
   if(locks.has('chat'))return json(res,409,{error:'上一条消息还在处理中'});
   locks.add('chat');try{
    const intent=chatIntent(input.text,state.pending);
    const additions=[{id:randomUUID(),role:'user',text:input.text.trim(),createdAt:new Date().toISOString()}];
    let reply;
    if(intent.kind==='feedback'){
     state.checkins.push({id:randomUUID(),text:intent.text,createdAt:new Date().toISOString()});
     reply={text:'记下了：'+intent.text+'。下一次协商会参考这条反馈。'};
    }else if(intent.kind==='plan'){
     const mem=[await memory(),...state.checkins.slice(-7).map(x=>x.text)].join('\n').trim();
     const live=!!(process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL);
     const result=live?await liveCouncil(intent.context,mem):demoCouncil(intent.context,mem);
     const plan={id:randomUUID(),createdAt:new Date().toISOString(),context:intent.context,...result,mode:live?'live':'demo',approved:false};
     state.plans.push(plan);state.pending='';reply={text:plan.summary,planId:plan.id};
    }else {reply={text:intent.text};if(intent.kind==='clarify')state.pending=intent.pending;}
    additions.push({id:randomUUID(),role:'assistant',...reply,createdAt:new Date().toISOString()});
    state.messages.push(...additions);await save();return json(res,200,{messages:additions});
   }finally{locks.delete('chat');}
  }
  if(url.pathname==='/api/council'){
   const c=validateContext(input); const mem=[await memory(),...state.checkins.slice(-7).map(x=>x.text)].join('\n').trim();
   const live=!!(process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL);
   const result=live?await liveCouncil(c,mem):demoCouncil(c,mem);
   const plan={id:randomUUID(),createdAt:new Date().toISOString(),context:c,...result,mode:live?'live':'demo',approved:false};state.plans.push(plan);await save();return json(res,200,plan);
  }
  if(url.pathname==='/api/approve') {const p=state.plans.find(x=>x.id===input.id);if(!p)return json(res,404,{error:'计划不存在'});p.approved=true;await save();return json(res,200,p);}
  if(url.pathname==='/api/checkin'){if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)return json(res,400,{error:'请填写 1–2000 字反馈'});state.checkins.push({id:randomUUID(),text:input.text.trim(),createdAt:new Date().toISOString()});await save();return json(res,200,{ok:true});}
  if(url.pathname==='/api/match')return json(res,200,{slots:matchSlots(input.mine,input.theirs),mode:'simulation',message:'本地双角色协商演示，不会联系朋友或创建真实日程'});
  if(url.pathname==='/api/sync'){
   const p=state.plans.find(x=>x.id===input.id);if(!p?.approved)return json(res,400,{error:'请先确认计划'});
   if(!configured())return json(res,400,{error:'尚未配置 Notion；可先导出 Markdown'});
   if(p.notionUrl)return json(res,200,{url:p.notionUrl});if(locks.has(p.id))return json(res,409,{error:'正在同步，请稍候'});
   locks.add(p.id);try{
    const block=text=>({object:'block',type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:text.slice(0,2000)}}]}});
    const out=await notion('pages','POST',{parent:{page_id:process.env.NOTION_PAGE_ID},properties:{title:{type:'title',title:[{type:'text',text:{content:`习惯议会 · ${p.createdAt.slice(0,10)}`}}]}},children:[block(p.context.text),block(p.conflict),...p.actions.map(block),block(`来源：${p.mode==='demo'?'规则演示':'真实模型协商'}；计划 ID：${p.id}`)]});
    p.notionUrl=out.url;await save();return json(res,200,{url:out.url});
   }finally{locks.delete(p.id);}
  }
  return json(res,404,{error:'接口不存在'});
 }
 if(req.method!=='GET')return json(res,405,{error:'方法不支持'});
 const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=files[url.pathname];if(!file)return json(res,404,{error:'未找到'});
 res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL(file,root)));
 }catch(e){json(res,400,{error:e.message||'操作失败，请重试'});}
}).listen(Number(process.env.PORT)||4317,'127.0.0.1',()=>console.log('Habit Council: http://127.0.0.1:'+(Number(process.env.PORT)||4317)));
