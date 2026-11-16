import {Store} from './store.mjs';
import {hash,randomToken,seal,unseal} from './crypto.mjs';
import * as domain from './domain.mjs';
import {DEFAULT_MODEL} from './model.mjs';
import {NotionClient,notionOAuthConfig,notionOAuthURL,exchangeNotionOAuth} from './notion.mjs';
import {notionCallback,notionConfigured,connectionState,finishNotion,listNotionPages,selectNotionPage,sweepNotionRuntime,forgetNotionRuntime,clearNotionSettings} from './notion-connect.mjs';
import {proactiveState,localClock} from './proactivity.mjs';
import {checkToday,uncheckToday} from './habits.mjs';
import {wechatQueue,startBinding,unbind,publicBinding} from './wechat.mjs';
import {runScheduled} from './scheduler.mjs';
import {deliverRoutines,publicProactive,publicSchedules,publicSchedule,publicActivity,setLevel,cancelSchedule,pauseSchedule} from './proactive.mjs';
import {handleAgentTool} from './agent-tools.mjs';
import {handleAgentSnapshot} from './agent-snapshot.mjs';
import {readAgentMemory} from './agent-memory.mjs';
import {agentServiceConfig,wakeForMessage,forgetAgentWorkspace} from './dispatcher.mjs';
import {dropOwnerPhotos} from './wechat-photos.mjs';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function body(request){
  if(!request.headers.get('content-type')?.startsWith('application/json'))domain.fail('需要 JSON 请求',415);
  const reader=request.body?.getReader();if(!reader)domain.fail('请输入请求内容');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32000){await reader.cancel();domain.fail('请求过长',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{domain.fail('JSON 格式错误');}
  if(!value||Array.isArray(value)||typeof value!=='object')domain.fail('需要 JSON 对象');return value;
}
// Calendar arithmetic on a YYYY-MM-DD string, done in UTC so no zone or daylight-saving rule gets involved.
const daysBefore=(day,count)=>new Date(Date.parse(day+'T00:00:00Z')-count*86400000).toISOString().slice(0,10);
// POST /api/internal/tick. Only with the Agent service set up: it is the caller, and its token
// (which this side already holds to call it) is the password. No login and no site password (basic-auth.mjs).
async function internalTick(request,{tick,agentServiceUrl,agentServiceToken}){
  if(request.method!=='POST')return json({error:'方法不支持'},405);
  const service=agentServiceConfig(agentServiceUrl,agentServiceToken);
  if(!service)return json({error:'Agent 服务没有配置好'},503);
  if(await hash(request.headers.get('authorization')||'')!==await hash('Bearer '+service.token))return json({error:'未授权'},401);
  try{return json(await tick({proactive:true,wechatInbound:false}));}
  catch(error){console.error('Weave tick failed:',error instanceof Error?error.message:'unknown');return json({error:'这次没有跑完，下一分钟再试'},503);}
}

export async function handleAPI(request,{db,identity,secret,fetcher=fetch,agentServiceUrl,agentServiceToken,agentProviderApiKey,wechat,notionOAuth,jev,now=Date.now()}){
  try{
    const managedAgent=typeof agentServiceUrl==='string'&&agentServiceUrl.startsWith('https://')&&typeof agentServiceToken==='string'&&agentServiceToken.length>0;
    const managedProvider=typeof agentProviderApiKey==='string'&&agentProviderApiKey.length>=12;
    const requestURL=new URL(request.url),requestPath=requestURL.pathname;
    // Calls from the Agent service's MCP tools. Authorized by the per-wake capability, not a login.
    if(requestPath.startsWith('/api/internal/agent/tools/'))return handleAgentTool(request,{db,secret,readBody:body,now});
    // The Agent service's pre-wake data snapshot, same capability (textbook p.16, p.20).
    if(requestPath==='/api/internal/agent/snapshot')return handleAgentSnapshot(request,{db,secret,now});
    // Same work as the Cron handler, for deployments where Cron does not fire (`wrangler dev`).
    const tick=(flags={})=>runScheduled({db,secret,env:{WECHAT_BRIDGE_TOKEN:wechat?.token,NOTION_API_PROXY_URL:notionOAuth?.apiProxyUrl},agentServiceUrl,agentServiceToken,fetcher,now,jev,...flags});
    // The server's own clock: the Agent service calls this every minute (proactive design §4.7). Reminders and the
    // background wakes; queued WeChat messages stay with the Mac bridge's tick below.
    if(requestPath==='/api/internal/tick')return internalTick(request,{tick,agentServiceUrl,agentServiceToken});
    if(requestPath.startsWith('/api/internal/wechat/'))return wechatQueue(request,{db,secret,token:wechat?.token,readBody:body,tick,now,images:wechat?.images===true});
    // Any other internal path is not a route: answer before reading identity or touching the world.
    if(requestPath.startsWith('/api/internal/'))return json({error:'接口不存在'},404);
    // The browser comes back from Notion here (no login; the one-time state binds it to the account that clicked connect).
    if(requestPath==='/api/connections/notion/callback')return notionCallback(request,{db,secret,fetcher,notionOAuth,now});
    if(!identity) return json({error:'请先登录'},401);
    if(!db)return json({error:'数据库尚未就绪'},503);
    const url=requestURL,path=url.pathname.replace(/^\/api\//,'');
    if(request.method!=='GET'&&request.method!=='POST')return json({error:'方法不支持'},405);
    if(request.method==='POST'){const originHeader=request.headers.get('origin'),hostHeader=request.headers.get('host')||requestURL.host;if(!originHeader||!hostHeader)return json({error:'不允许跨站请求'},403);try{if(new URL(originHeader).host!==hostHeader)return json({error:'不允许跨站请求'},403);}catch{return json({error:'不允许跨站请求'},403);}}
    const store=new Store(db,{strict:path==='profile'||path==='account/delete'}),world=await store.load(),id='u:'+await hash(identity.userId);
    const person=domain.ensurePerson(world,{...identity,userId:id});
    proactiveState(person);
    domain.deliverReminders(world);
    deliverRoutines(world,now);
    const save=()=>store.save(world);
    async function notionFor(){return new NotionClient({token:person.settings.notionToken?await unseal(person.settings.notionToken,secret,id):'',pageId:person.settings.notionPageId,fetcher,apiProxy:notionOAuth?.apiProxyUrl||''});}
    if(request.method==='GET'){
      await save();
      if(path==='status'){
        // today is the person's own calendar day (the one a check-in is filed under), whatever zone the server or the browser is in.
        // The pages draw the last 62 days of check-ins: today and the 61 days before it. The export has them all.
        // The records page has the same 61 (STATUS_WINDOW_BACK, app/workspace/records.mjs); test/habits-web.test.mjs holds them together.
        // goals and habits go out whole, archived goals included: the pages hide an archived goal's habits, which they can only do if they see the goal and its flag.
        const today=localClock(person,now).day,since=daysBefore(today,61);
        return json({profile:person.profile,personId:id,messages:person.messages.slice(-200),plans:person.plans.slice(-50),checkins:person.checkins.slice(-100),reminders:person.reminders,notifications:person.notifications.slice(-100),settings:{model:person.settings.model,agent:!!(person.settings.deepseekKey||managedAgent||managedProvider),verifiedAt:person.settings.verifiedAt||null,notion:!!(person.settings.notionToken&&person.settings.notionPageId),notionConfigured:notionConfigured(notionOAuth),wechat:publicBinding(person,wechat,world,now)},agentRuntime:managedAgent?'hosted':managedProvider?'managed':'user',goals:person.goals||[],habits:person.habits||[],completions:(person.completions||[]).filter(c=>c.date>=since),today,schedules:publicSchedules(person),proactive:publicProactive(person,now),activity:publicActivity(person,now)});
      }
      if(path==='connections/notion/pending'){
        const keyPrefix='notion-pending:';for(const [key,value] of Object.entries(world.runtime||{}))if(key.startsWith(keyPrefix)&&value.ownerId===id){if(value.expiresAt>now){if(value.reason)continue;return json({ready:true,pages:value.pages||[]});}delete world.runtime[key];}
        await save();return json({ready:false,pages:[]});
      }
      if(path==='connections/notion')return json(connectionState(world,person,id,notionOAuth,now));
      if(path==='connections/notion/pages')return json(await listNotionPages(person,id,{secret,fetcher,notionOAuth}));
      if(path==='wechat')return json({binding:publicBinding(person,wechat,world,now),queue:Object.values(world.wechat||{}).filter(x=>x.ownerId===id).slice(-50).map(({id,status,direction,createdAt,error})=>({id,status,direction,createdAt,error}))});
      if(path==='memory')return json({text:await(await notionFor()).memory()});
      // What the Agent itself wrote in MEMORY.md (ARCHITECTURE §10: the owner can see it). Read through the Agent service.
      if(path==='agent-memory'){
        const service=agentServiceConfig(agentServiceUrl,agentServiceToken);
        if(!service)domain.fail('新版 Agent 还没有配置好，请联系管理员',503);
        return json({text:await readAgentMemory({service,ownerId:id,fetcher})});
      }
      if(path==='export')return json({profile:person.profile,messages:person.messages,plans:person.plans,checkins:person.checkins,reminders:person.reminders,goals:person.goals||[],habits:person.habits||[],completions:person.completions||[],schedules:person.schedules||[],proactive:person.proactive||null});
      return json({error:'接口不存在'},404);
    }
    const input=await body(request);
    // Durable, per-account limits survive Worker restarts. No API key is logged.
    const minute=Math.floor(Date.now()/60000);
    if(person.rate?.minute!==minute)person.rate={minute,count:0};
    if(person.rate.count>=40)domain.fail('操作太频繁，请一分钟后重试',429);
    person.rate.count++;await save();
    let output={ok:true};
    if(path==='connections/notion/start'){
      const config=notionOAuthConfig(notionOAuth);if(!config.clientId||!config.redirectUri)domain.fail('Notion 连接暂不可用，请稍后重试',503);
      sweepNotionRuntime(world,now);
      const state=randomToken();world.runtime[`notion-oauth:${await hash(state)}`]={ownerId:id,expiresAt:now+10*60*1000};output={url:notionOAuthURL(config,state)};
    }
    else if(path==='connections/notion/complete'){
      if(typeof input.pageId!=='string'||!/^[a-f0-9-]{32,36}$/i.test(input.pageId))domain.fail('请选择一个 Notion 页面');
      const keyPrefix='notion-pending:';let selected;
      for(const [key,value] of Object.entries(world.runtime||{}))if(key.startsWith(keyPrefix)&&value.ownerId===id){if(value.expiresAt<=now){delete world.runtime[key];continue;}if((value.pages||[]).some(page=>page.id===input.pageId))selected={key,value};}
      if(!selected)domain.fail('Notion 连接已过期，请重新连接',428);
      person.settings.notionToken=selected.value.token;person.settings.notionPageId=input.pageId;person.settings.notionConnectedAt=now;delete world.runtime[selected.key];output={ok:true};
      const chosen=(selected.value.pages||[]).find(page=>page.id===input.pageId);if(chosen)person.settings.notionPage={id:chosen.id,title:chosen.title};
    }
    else if(path==='connections/notion/finish')output=await finishNotion(world,person,id,{secret,fetcher,notionOAuth,now});
    else if(path==='connections/notion/select')output=await selectNotionPage(world,person,id,input,{secret,fetcher,notionOAuth,now});
    else if(path==='connections/notion/disconnect'){clearNotionSettings(person.settings);forgetNotionRuntime(world,id);}
    else if(path==='wechat/bind')output=await startBinding(world,id,now);
    else if(path==='wechat/unbind')output=await unbind(world,person,id);
    else if(path==='profile')domain.updateProfile(world,id,input);
    else if(path==='settings'){
      if(input.disconnect===true){delete person.settings.deepseekKey;delete person.settings.verifiedAt;}
      else {
        if(!['deepseek-flash','deepseek-v4-pro'].includes(input.model??person.settings.model??DEFAULT_MODEL))domain.fail('请选择支持的 DeepSeek 模型');
        if(input.apiKey){if(typeof input.apiKey!=='string'||input.apiKey.length<12||input.apiKey.length>512||/\s/.test(input.apiKey))domain.fail('请输入有效的 API Key');person.settings.deepseekKey=await seal(input.apiKey,secret,id);delete person.settings.verifiedAt;}
        person.settings.model=input.model??person.settings.model??DEFAULT_MODEL;
      }
      if(input.disconnectNotion===true){clearNotionSettings(person.settings);forgetNotionRuntime(world,id);}
      else {
        if(input.notionToken){if(typeof input.notionToken!=='string'||input.notionToken.length<12||input.notionToken.length>512)domain.fail('Notion Token 格式无效');person.settings.notionToken=await seal(input.notionToken,secret,id);}
        if(input.notionPageId!==undefined){if(typeof input.notionPageId!=='string'||!/^[a-f0-9-]{32,36}$/i.test(input.notionPageId))domain.fail('请输入Notion父页面ID，非完整链接');person.settings.notionPageId=input.notionPageId;}
      }
    }
    else if(path==='plans/approve'){
      const plan=person.plans.find(p=>p.id===input.id);if(!plan)domain.fail('计划不存在',404);plan.approved=true;
    }
    else if(path==='plans/sync'){
      const plan=person.plans.find(p=>p.id===input.id);if(!plan||!plan.approved)domain.fail('请先确认自己的计划');
      if(plan.notionUrl)return json({url:plan.notionUrl});
      if(['sending','uncertain'].includes(plan.syncStatus))domain.fail('上次写入结果未确认，请先在 Notion 核对，避免重复创建',409);
      const notion=await notionFor();if(!notion.configured())domain.fail('请先连接你自己的 Notion 页面',428);
      plan.syncStatus='sending';await save();
      try{const result=await notion.syncPlan(plan,person.checkins);plan.notionUrl=result.url;plan.syncStatus='sent';output={url:result.url};}
      catch(error){plan.syncStatus='uncertain';await save();throw error;}
    }
    else if(path==='chat'){
      const text=typeof input.text==='string'?input.text.trim():'';if(!text||text.length>4000)domain.fail('请输入1–4000字消息');
      const service=agentServiceConfig(agentServiceUrl,agentServiceToken);
      if(!service)domain.fail('新版 Agent 还没有配置好，请联系管理员',503);
      // The wake writes through the tool backend, so this request's world is stale from here:
      // return without the final save below.
      return json({reply:(await wakeForMessage({db,secret,ownerId:id,text,service,fetcher,now})).reply});
    }
    else if(path==='reminders')output=domain.addReminder(person,input);
    else if(path==='reminders/cancel'){
      const reminder=person.reminders.find(r=>r.id===input.id);if(!reminder||reminder.status!=='scheduled')domain.fail('提醒不存在或已经执行',404);reminder.status='cancelled';
    }
    // 助理主页「提醒」栏（proactive design §4.8）：档位、删掉一条重复的提醒或跟进、暂停和恢复。
    else if(path==='proactive/level'){setLevel(person,input.level,now);output={proactive:publicProactive(person,now)};}
    else if(path==='schedules/cancel')cancelSchedule(person,input.id);
    else if(path==='schedules/pause')output={schedule:publicSchedule(pauseSchedule(person,input.id,input.paused,now))};
    else if(path==='notifications/read')person.notifications.forEach(n=>n.read=true);
    // The web page's tick box: today only, in the person's own zone (habits.mjs). The result is the rule's own answer, sent as is.
    else if(path==='habits/check')output=checkToday(person,input.habit_id,now);
    else if(path==='habits/uncheck')output=uncheckToday(person,input.habit_id,now);
    else if(path==='account/delete'){
      if(input.confirm!==true)domain.fail('请确认要永久删除账号');
      const service=agentServiceConfig(agentServiceUrl,agentServiceToken);
      if(service){
        // Each group this account enabled has a workspace of its own. Delete those first, so a failure leaves the whole account in place.
        for(const [key,value] of Object.entries(world.runtime||{}))if(key.startsWith('wechat-group:')&&value?.ownerId===id)await forgetAgentWorkspace({service,scope:'group',id:key.slice('wechat-group:'.length),fetcher});
        await forgetAgentWorkspace({service,ownerId:id,fetcher});
      }
      domain.deleteAccount(world,id);
      // 微信看图暂存的照片不在 world 里，按主人另外删（表不存在时什么都不做）。
      await dropOwnerPhotos(db,id);
      // The guest row only stores the session token, but nothing of theirs should remain.
      if(identity.userId.startsWith('guest:')){try{await db.prepare('DELETE FROM weave_guest_sessions WHERE id=?').bind(identity.userId.slice('guest:'.length)).run();}catch{/* the row is optional metadata */}}
    }
    else return json({error:'接口不存在'},404);
    await save();return json(output);
  }catch(error){return json({error:error.status?error.message:(!/SQLITE|D1_|AES|decrypt|encrypt|OperationError/i.test(error.message)?error.message:'服务暂时不可用，请稍后重试')},error.status||400);}
}
