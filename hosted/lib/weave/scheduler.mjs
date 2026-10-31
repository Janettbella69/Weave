import {Store} from './store.mjs';
import {deliverReminders} from './domain.mjs';
import {GewechatClient,drainGewechat} from './gewechat.mjs';
import {chatFor} from './api.mjs';

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

export async function runScheduled({db,secret,env={},agentServiceUrl,agentServiceToken,agentProviderApiKey,fetcher=fetch,now=Date.now(),clientFactory=options=>new GewechatClient(options)}){
  if(!db)throw Error('Reminder database is unavailable');
  for(let attempt=0;attempt<3;attempt++)try{
    const store=new Store(db),world=await store.load();
    const config=env.baseUrl?env:{baseUrl:env.GEWECHAT_BASE_URL||'',token:env.GEWECHAT_TOKEN||'',appId:env.GEWECHAT_APP_ID||''};
    const enabled=!!(config.baseUrl&&config.token&&config.appId&&secret),delivered=deliverReminders(world,now),queued=queueReminderMessages(world,now,enabled);
    let sent=0;
    if(enabled){
      const client=clientFactory({baseUrl:config.baseUrl,token:config.token,appId:config.appId});
      sent=await drainGewechat(world,{client,secret,now,handleMessage:(person,text)=>chatFor(person,world,text,{secret,fetcher,agentServiceUrl,agentServiceToken,agentProviderApiKey})});
    }
    if(delivered||queued||sent)await store.save(world);
    return {delivered,queued,sent};
  }catch(error){if(attempt===2)throw error;}
}
