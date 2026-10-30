import {processChat} from '../agent.mjs';
import {formatReply} from './gewechat.mjs';
export function createWorker({state,save,notion,client,exclusive}){
 let running=false;
 return async function drain(){
  if(running)return;running=true;
  try{while(true){
   const entry=Object.values(state.wechatInbox).find(x=>x.status==='queued'||x.status==='ready');
   if(!entry)break;
   await exclusive(async()=>{
    if(entry.status==='queued'){
     entry.status='processing';await save();
     // Work on a draft: model failures cannot leave a half-created conversation.
     const draft=structuredClone(state);
     try{const result=await processChat(draft,entry.text,notion,async()=>{ // Persist Notion uncertainty before issuing a remote write.
       const p=draft.plans.at(-1);if(p?.syncStatus){const original=state.plans.find(x=>x.id===p.id);if(original)Object.assign(original,p);await save();}
      });
      state.plans=draft.plans;state.checkins=draft.checkins;state.messages=draft.messages;state.pending=draft.pending;
      const reply=result.messages.at(-1);entry.reply=formatReply(reply,state.plans.find(p=>p.id===reply.planId));
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
