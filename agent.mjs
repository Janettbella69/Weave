import {randomUUID} from 'node:crypto';
import {chatIntent} from './chat.mjs';
import {demoCouncil,liveCouncil} from './council.mjs';
export async function createPlan(state,context,notion){
 const memory=[state.profile?`个人目标：${state.profile.goal}；个人偏好：${state.profile.preferences}`:'',await notion.memory(),...state.checkins.slice(-7).map(x=>x.text)].join('\n').trim();
 const live=!!(process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_MODEL);
 const result=live?await liveCouncil(context,memory):demoCouncil(context,memory);
 const plan={id:randomUUID(),createdAt:new Date().toISOString(),context,...result,mode:live?'live':'demo',approved:false};state.plans.push(plan);return plan;
}
export async function syncPlan(state,plan,notion,save){
 if(!plan?.approved)throw Error('请先确认计划');
 if(plan.notionUrl)return {url:plan.notionUrl};
 if(plan.syncStatus==='sending'||plan.syncStatus==='uncertain')throw Error('上次 Notion 写入结果未确认，请先核对目标页面，避免重复创建');
 if(!notion.configured())throw Error('尚未配置 Notion；请填写服务端 .env');
 plan.syncStatus='sending';await save();
 try{const result=await notion.syncPlan(plan,state.checkins);plan.notionUrl=result.url;plan.syncStatus='sent';await save();return {url:result.url};}
 catch(e){plan.syncStatus='uncertain';await save();throw e;}
}
export async function processChat(state,text,notion,save){
 const clean=typeof text==='string'?text.trim():'';let reply;
 if(/^(确认|确认计划)$/.test(clean)){
  const plan=state.plans.at(-1);if(!plan)reply={text:'还没有待确认的计划。先告诉我今天的状态吧。'};
  else{plan.approved=true;reply={text:'计划已确认。回复「同步 Notion」即可写入你的页面。'};}
 }else if(/^(同步\s*Notion|同步到\s*Notion)$/i.test(clean)){
  const result=await syncPlan(state,state.plans.at(-1),notion,save);reply={text:'已同步到 Notion：'+result.url};
 }else{
  const intent=chatIntent(text,state.pending);
  if(intent.kind==='feedback'){state.checkins.push({id:randomUUID(),text:intent.text,createdAt:new Date().toISOString()});reply={text:'记下了：'+intent.text+'。下一次协商会参考；同步下一份计划到 Notion 时，会一并写入最近的反馈。'};}
  else if(intent.kind==='plan'){const plan=await createPlan(state,intent.context,notion);state.pending='';reply={text:plan.summary,planId:plan.id};}
  else {reply={text:intent.text};if(intent.kind==='clarify')state.pending=intent.pending;}
 }
 const messages=[{id:randomUUID(),role:'user',text:clean,createdAt:new Date().toISOString()},{id:randomUUID(),role:'assistant',...reply,createdAt:new Date().toISOString()}];
 state.messages.push(...messages);await save();return {messages};
}
