import {Store} from './store.mjs';
import {deliverReminders} from './domain.mjs';
import {processInbound,wechatConfig} from './wechat.mjs';
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

export async function runScheduled({db,secret,env={},agentServiceUrl,agentServiceToken,agentProviderApiKey,fetcher=fetch,now=Date.now()}){
  if(!db)throw Error('Reminder database is unavailable');
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
