import {randomUUID} from 'node:crypto';
import {processChat,syncPlan} from './agent.mjs';
import {personFor,record} from './workspace.mjs';
import {startNegotiation,authorize,confirm,decline,findNegotiation,exportPlan,invalidateNegotiations} from './negotiation.mjs';
import {addReminder} from './reminders.mjs';
const labels={awaiting_consent:'等待授权',awaiting_confirmation:'等待双方确认',confirmed:'双方已确认',declined:'已拒绝',no_match:'暂无共同安排'};
function resolve(world,personId,short){const matches=world.negotiations.filter(n=>n.participants.includes(personId)&&n.id.startsWith(short));if(matches.length!==1)throw Error('请使用协商卡片中的唯一编号');return matches[0];}
export async function handleWeaveChat(world,personId,text,{notionFor,save,notify=()=>{}}){
 const person=personFor(world,personId);if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('请输入 1–4000 字消息');const clean=text.trim(),messageIndex=person.messages.length;let reply,n;
 const invite=clean.match(/^约\s*(阿梦|Lulu|lulu)\s*(?:一起)?\s*(散步|运动|学习|吃饭)[。！!]?$/);
 const command=clean.match(/^(授权协商|确认协商|拒绝协商|同步协商)\s+([\w-]+)$/);
 const preference=clean.match(/^(目标|偏好|记住)[：:]\s*(.+)$/s);
 const reminder=clean.match(/^提醒[：:]\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})\s+(.+)$/s);
 if(invite){const to=invite[1].toLowerCase()==='lulu'?'lulu':'meng';n=startNegotiation(world,personId,to,invite[2],true);reply='已发起协商 '+n.id.slice(0,8)+'。对方授权后，Agent 会交换本次可用时间。';notify(to,`${person.profile.name} 邀请你一起${invite[2]}。回复「授权协商 ${n.id.slice(0,8)}」或「拒绝协商 ${n.id.slice(0,8)}」。`);}
 else if(command){n=resolve(world,personId,command[2]);if(command[1]==='授权协商'){authorize(world,n.id,personId);reply=n.candidate?`双方 Agent 已协商：${n.candidate.slot.replace('T',' ')} ${n.activity}，请回复「确认协商 ${n.id.slice(0,8)}」。`:n.status==='no_match'?'这次没有找到双方都接受的时间与活动，没有写入日程。请调整可用时间或活动偏好后，重新发起邀请。':'已记录授权；等待另一方授权后开始协商。';}
  else if(command[1]==='确认协商'){confirm(world,n.id,personId,n.revision);reply=n.status==='confirmed'?'双方已确认，约好了。已写入各自的 Weave 本地日程。':'你已确认，等待另一方确认。';}
  else if(command[1]==='拒绝协商'){decline(world,n.id,personId);reply='已拒绝本次协商。';}
  else{const plan=exportPlan(world,n,personId);const result=await syncPlan(person,plan,notionFor(personId),save);reply='已同步本次协作到你的 Notion：'+result.url;}
  if(command[1]!=='同步协商'){
   const notice=command[1]==='确认协商'&&n.status==='awaiting_confirmation'?`${person.profile.name} 已确认本次方案，等待你的确认。`:command[1]==='授权协商'&&n.status==='awaiting_consent'?`${person.profile.name} 已授权本次共享，等待你的授权。`:reply;
   for(const peer of n.participants.filter(x=>x!==personId))notify(peer,`${notice}\n协商编号：${n.id.slice(0,8)}${n.status==='awaiting_confirmation'?`\n回复「确认协商 ${n.id.slice(0,8)}」确认。`:n.status==='awaiting_consent'?`\n回复「授权协商 ${n.id.slice(0,8)}」授权。`:''}`);
  }
 }
 else if(clean==='我的协商'){const items=world.negotiations.filter(n=>n.participants.includes(personId));reply=items.length?items.slice(-5).map(n=>`${n.id.slice(0,8)} · ${n.activity} · ${labels[n.status]||n.status}${n.candidate?' · '+n.candidate.slot.replace('T',' '):''}`).join('\n'):'还没有协商。可以说“约阿梦散步”或“约Lulu散步”。';}
 else if(preference){const value=preference[2].trim();if(value.length>1000)throw Error('目标或偏好最多 1000 字');if(preference[1]==='目标')person.profile.goal=value;else person.profile.preferences=preference[1]==='记住'?(person.profile.preferences+'；'+value).slice(-1000):value;person.profile.revision++;invalidateNegotiations(world,personId);reply='已记住，后续建议会参考你的'+(preference[1]==='目标'?'目标':'偏好')+'。';}
 else if(reminder){const r=addReminder(person,{dueAt:reminder[1].replace(' ','T'),text:reminder[2]});reply='提醒已设置：'+new Date(r.dueAt).toLocaleString('zh-CN')+'。本地服务运行时会提醒你。';}
 else return processChat(person,text,notionFor(personId),save);
 const userMessage={id:randomUUID(),role:'user',text:clean,createdAt:new Date().toISOString()};person.messages.splice(messageIndex,0,userMessage);const message=record(person,reply,n?{negotiationId:n.id}:{});await save();return {messages:[userMessage,message]};
}
