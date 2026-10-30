import {processChat} from '../agent.mjs';
import {formatReply} from './gewechat.mjs';
export function createWorker({state,save,notion,client,exclusive,handleMessage}){
 let running=false;
 return async function drain(){
  if(running)return;running=true;
  try{while(true){
   const entry=Object.values(state.wechatInbox).find(x=>x.status==='queued'||x.status==='ready');
   if(!entry)break;
   await exclusive(async()=>{
    if(entry.status==='queued'){
     entry.status='processing';await save();
     try{
      const result=handleMessage?await handleMessage(entry):await processChat(state,entry.text,notion,save);
      const reply=result.messages.at(-1);const person=entry.personId?state.people[entry.personId]:state;
      entry.reply=formatReply(reply,person.plans.find(p=>p.id===reply.planId));
     }catch(e){entry.reply='这次没有完成：'+e.message+'。请检查后重新发起请求。';}
     entry.status='ready';await save();
    }
    entry.status='sending';await save();
    try{await client.sendText(entry.from,entry.reply);entry.status='sent';}
    catch{entry.status='uncertain';entry.error='微信发送结果未确认，未自动重发；请核对服务端记录';}
    await save();
   });
  }}finally{running=false;}
 };
}
