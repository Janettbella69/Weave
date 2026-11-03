import {Store,withWorld} from './store.mjs';
import {deliverReminders} from './domain.mjs';
import {processInbound,processInboundSdk,wechatConfig} from './wechat.mjs';
import {agentServiceConfig} from './dispatcher.mjs';
import {chatFor,groupChatFor} from './api.mjs';
import {modelBudgetConfig} from './budget.mjs';
import {notionOAuthConfig} from './notion.mjs';

function queueReminderMessages(world,now,enabled){
  if(!enabled)return 0;
  world.wechat??={};let queued=0;
  for(const person of Object.values(world.people||{})){
    if(!person.settings?.wechatWxidHash)continue;
    for(const reminder of person.reminders||[]){
      if(reminder.status!=='delivered'||reminder.wechatQueued||!reminder.deliveredAt)continue;
      reminder.wechatQueued=true;const id='out:'+crypto.randomUUID();
      world.wechat[id]={id,direction:'outbound',ownerId:person.id,text:`提醒你：${reminder.text}`,status:'queued',createdAt:new Date(now).toISOString(),source:'reminder'};queued++;
    }
  }
  return queued;
}

// On the Agent SDK path (WEAVE_AGENT_RUNTIME=sdk) a WeChat message wakes the Agent, which takes seconds to minutes and
// writes the world through the tool backend meanwhile, so nothing here holds a world across it: the reminders are
// their own transaction and processInboundSdk does its own claiming and saving.
async function runScheduledSdk({db,secret,env,agentServiceUrl,agentServiceToken,fetcher,now}){
  const enabled=!!(wechatConfig(env).token&&secret);
  const {delivered,queued}=await withWorld(db,world=>({delivered:deliverReminders(world,now),queued:queueReminderMessages(world,now,enabled)}));
  let processed=0;
  if(enabled){
    const service=agentServiceConfig(agentServiceUrl,agentServiceToken);
    if(service)processed=await processInboundSdk({db,secret,service,fetcher,now});
    else console.error('WEAVE_AGENT_RUNTIME=sdk，但 Agent 服务没有配置好，微信消息先留在队列里。');
  }
  return {delivered,queued,processed};
}

export async function runScheduled({db,secret,env={},agentRuntime='',agentServiceUrl,agentServiceToken,agentProviderApiKey,fetcher=fetch,now=Date.now()}){
  if(!db)throw Error('Reminder database is unavailable');
  if(agentRuntime==='sdk')return runScheduledSdk({db,secret,env,agentServiceUrl,agentServiceToken,fetcher,now});
  const agent={secret,fetcher,agentServiceUrl,agentServiceToken,agentProviderApiKey,modelBudget:modelBudgetConfig(env),now,apiProxy:notionOAuthConfig(env).apiProxyUrl||''};
  for(let attempt=0;attempt<3;attempt++)try{
    const store=new Store(db),world=await store.load();
    const enabled=!!(wechatConfig(env).token&&secret),delivered=deliverReminders(world,now),queued=queueReminderMessages(world,now,enabled);
    // Replies are only queued here; the local bridge is what actually reaches WeChat.
    const processed=enabled?await processInbound(world,{secret,now,handleMessage:(person,text)=>chatFor(person,world,text,agent),handleGroup:(person,input)=>groupChatFor(person,world,input,agent)}):0;
    if(delivered||queued||processed)await store.save(world);
    return {delivered,queued,processed};
  }catch(error){if(attempt===2)throw error;}
}
