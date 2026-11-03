import {Store,withWorld} from './store.mjs';
import {deliverReminders} from './domain.mjs';
import {processInbound,processInboundSdk,wechatConfig} from './wechat.mjs';
import {agentServiceConfig} from './dispatcher.mjs';
import {chatFor,groupChatFor} from './api.mjs';
import {modelBudgetConfig} from './budget.mjs';
import {notionOAuthConfig} from './notion.mjs';
import {deliverRoutines,runProactive} from './proactive.mjs';

// Reminders that came due go to WeChat too: the one-off ones once (wechatQueued), each occurrence of a repeating one
// once (unsent, set by proactive.deliverRoutines).
function queueReminderMessages(world,now,enabled){
  if(!enabled)return 0;
  world.wechat??={};let queued=0;
  const queue=(person,text)=>{const id='out:'+crypto.randomUUID();world.wechat[id]={id,direction:'outbound',ownerId:person.id,text:`提醒你：${text}`,status:'queued',createdAt:new Date(now).toISOString(),source:'reminder'};queued++;};
  for(const person of Object.values(world.people||{})){
    if(!person.settings?.wechatWxidHash)continue;
    for(const reminder of person.reminders||[]){
      if(reminder.status!=='delivered'||reminder.wechatQueued||!reminder.deliveredAt)continue;
      reminder.wechatQueued=true;queue(person,reminder.text);
    }
    for(const routine of person.schedules||[]){
      if(routine.kind!=='reminder'||!routine.unsent)continue;
      routine.unsent=false;queue(person,routine.text);
    }
  }
  return queued;
}

// On the Agent SDK path (WEAVE_AGENT_RUNTIME=sdk) a WeChat message wakes the Agent, which takes seconds to minutes and
// writes the world through the tool backend meanwhile, so nothing here holds a world across it: the reminders are
// their own transaction and processInboundSdk does its own claiming and saving.
//   proactive      also wake people's Agents in the background (follow-ups and periodic looks, proactive.mjs). Only the
//                  server's own clock (/api/internal/tick, from the Agent service) and Cloudflare Cron ask for it.
//   wechatInbound  answer queued WeChat messages. The server's own clock leaves those to the Mac bridge's tick, so the
//                  two never race to answer and a reply is claimed right after the tick that wrote it.
async function runScheduledSdk({db,secret,env,agentServiceUrl,agentServiceToken,fetcher,now,proactive=false,wechatInbound=true}){
  const enabled=!!(wechatConfig(env).token&&secret);
  const {delivered,routines,queued}=await withWorld(db,world=>{
    const delivered=deliverReminders(world,now),routines=deliverRoutines(world,now);
    return {delivered,routines,queued:queueReminderMessages(world,now,enabled)};
  });
  const service=agentServiceConfig(agentServiceUrl,agentServiceToken);
  let processed=0;
  if(enabled&&wechatInbound){
    if(service)processed=await processInboundSdk({db,secret,service,fetcher,now});
    else console.error('WEAVE_AGENT_RUNTIME=sdk，但 Agent 服务没有配置好，微信消息先留在队列里。');
  }
  const started=proactive&&service?await runProactive({db,secret,service,fetcher,now}):0;
  return {delivered,routines,queued,processed,proactive:{started}};
}

export async function runScheduled({db,secret,env={},agentRuntime='',agentServiceUrl,agentServiceToken,agentProviderApiKey,fetcher=fetch,now=Date.now(),proactive=false,wechatInbound=true}){
  if(!db)throw Error('Reminder database is unavailable');
  if(agentRuntime==='sdk')return runScheduledSdk({db,secret,env,agentServiceUrl,agentServiceToken,fetcher,now,proactive,wechatInbound});
  const agent={secret,fetcher,agentServiceUrl,agentServiceToken,agentProviderApiKey,modelBudget:modelBudgetConfig(env),now,apiProxy:notionOAuthConfig(env).apiProxyUrl||''};
  for(let attempt=0;attempt<3;attempt++)try{
    const store=new Store(db),world=await store.load();
    const enabled=!!(wechatConfig(env).token&&secret),delivered=deliverReminders(world,now)+deliverRoutines(world,now),queued=queueReminderMessages(world,now,enabled);
    // Replies are only queued here; the local bridge is what actually reaches WeChat.
    const processed=enabled?await processInbound(world,{secret,now,handleMessage:(person,text)=>chatFor(person,world,text,agent),handleGroup:(person,input)=>groupChatFor(person,world,input,agent)}):0;
    if(delivered||queued||processed)await store.save(world);
    return {delivered,queued,processed};
  }catch(error){if(attempt===2)throw error;}
}
