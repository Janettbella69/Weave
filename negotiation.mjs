import {randomUUID} from 'node:crypto';
import {personFor,record,validateSlot,activities} from './workspace.mjs';
const now=()=>new Date().toISOString();
function log(n,actor,type,text,extra={}){n.events.push({id:randomUUID(),at:now(),actor,type,text,...extra});}
function member(n,id){if(!n.participants.includes(id))throw Error('你不是这次协商的参与者');}
export function findNegotiation(world,id,personId){const n=world.negotiations.find(n=>n.id===id);if(!n)throw Error('协商不存在');member(n,personId);return n;}
// Each participant agent is handed only that person's explicitly shared snapshot.
export class ParticipantAgent{
 constructor(id,shared){this.id=id;this.shared=shared;}
 propose(activity,excluded=[]){if(!this.shared.activities.includes(activity))return null;return this.shared.slots.find(x=>validateSlot(x)&&!excluded.includes(x))||null;}
 accept(activity,slot){return this.shared.activities.includes(activity)&&this.shared.slots.includes(slot)&&validateSlot(slot);}
}
function isBooked(person,slot){const start=new Date(slot).getTime(),end=start+30*60000;return person.calendar.some(e=>{const a=new Date(e.slot).getTime(),b=a+e.durationMinutes*60000;return start<b&&end>a;});}
function snapshot(person,activity){return {name:person.profile.name,revision:person.profile.revision,slots:person.profile.slots.filter(s=>validateSlot(s)&&!isBooked(person,s)),activities:[...person.profile.activities],constraints:activity==='吃饭'?person.profile.preferences:''};}
export function startNegotiation(world,from,to,activity,consent){
 personFor(world,from);personFor(world,to);if(from===to||!activities.includes(activity))throw Error('请选择另一位用户和支持的活动');
 if(consent!==true)throw Error('请先授权本次共享可用时间和活动偏好');
 const n={id:randomUUID(),participants:[from,to],initiator:from,activity,status:'awaiting_consent',revision:1,consents:{[from]:snapshot(world.people[from],activity)},confirmations:{},events:[],createdAt:now(),candidate:null,exports:{}};
 log(n,from,'request',`${world.people[from].profile.name} 发起一起${activity}，等待对方授权共享时间。`);
 world.negotiations.push(n);
 for(const id of n.participants)record(world.people[id],id===from?'邀请已建立，等待对方授权后，两个 Agent 才会开始协商。':`${world.people[from].profile.name} 想约你一起${activity}。你可以授权本次共享可用时间与活动偏好，也可以拒绝。`,{negotiationId:n.id});
 return n;
}
export function authorize(world,id,personId){const n=findNegotiation(world,id,personId);if(n.status!=='awaiting_consent')throw Error('当前协商不在等待授权');n.consents[personId]=snapshot(personFor(world,personId),n.activity);log(n,personId,'consent','用户授权本次共享可用时间和活动偏好。');if(n.participants.every(p=>n.consents[p]))negotiate(world,n);return n;}
function negotiate(world,n){
 const [a,b]=n.participants,aa=new ParticipantAgent(a,n.consents[a]),bb=new ParticipantAgent(b,n.consents[b]);let slot=aa.propose(n.activity),sender=a,receiver=b;
 const agents={[a]:aa,[b]:bb},tried=[];n.candidate=null;
 while(slot&&tried.length<40){
  tried.push(slot);log(n,sender,tried.length===1?'proposal':'counterproposal',`${n.consents[sender].name} 的 Agent 提议 ${slot.replace('T',' ')} 一起${n.activity}。`,{slot});
  if(agents[receiver].accept(n.activity,slot)){
   log(n,receiver,'accept','该时间和活动符合我方已授权的安排，接受提案。',{slot});
   n.candidate={slot,activity:n.activity,durationMinutes:30,constraints:n.participants.map(id=>n.consents[id].constraints).filter(Boolean)};n.status='awaiting_confirmation';
   log(n,'coordinator','agreement','两个 Agent 已达成候选方案，等待双方用户确认。');break;
  }
  log(n,receiver,'reject','这个时间或活动不在我方授权的可用安排内。',{slot});
  [sender,receiver]=[receiver,sender];slot=agents[sender].propose(n.activity,tried);
 }
 if(!n.candidate){n.status='no_match';log(n,'coordinator','no_match','没有找到双方都接受的时间与活动。请调整可用安排后重新发起。');}
 for(const id of n.participants)record(world.people[id],n.candidate?`Agent 已协商出：${n.candidate.slot.replace('T',' ')}，一起${n.activity} 30 分钟。请查看协商记录并确认。`:'这次没有找到共同安排。可以调整空闲时间，再发起一次。',{negotiationId:n.id});
}
export function confirm(world,id,personId,revision){
 const n=findNegotiation(world,id,personId);if(n.status==='confirmed')return n;
 if(n.status!=='awaiting_confirmation'||!n.candidate)throw Error('还没有可确认的候选方案');
 if(revision!==n.revision)throw Error('方案已经更新，请查看最新方案后再确认');
 if(!validateSlot(n.candidate.slot))throw Error('候选时间已过期，请重新协商');
 if(n.participants.some(p=>isBooked(world.people[p],n.candidate.slot)))throw Error('候选时间已被新的日程占用，请重新协商');
 if(n.participants.some(p=>n.consents[p]?.revision!==world.people[p].profile.revision))throw Error('个人安排已变化，请重新授权协商');
 n.confirmations[personId]=true;log(n,personId,'user_confirm',`${world.people[personId].profile.name} 确认本次方案。`);
 if(n.participants.every(p=>n.confirmations[p])){
  n.status='confirmed';n.confirmedAt=now();
  for(const p of n.participants){const person=world.people[p];if(!person.calendar.some(e=>e.negotiationId===n.id))person.calendar.push({id:randomUUID(),negotiationId:n.id,...n.candidate,participants:n.participants.map(x=>world.people[x].profile.name),createdAt:now()});record(person,`约好了：${n.candidate.slot.replace('T',' ')}，一起${n.activity}。双方已确认，已记入各自的 Weave 本地日程。`,{negotiationId:n.id});}
  log(n,'coordinator','committed','双方已确认，已分别写入本地日程。');
 }return n;
}
export function decline(world,id,personId){const n=findNegotiation(world,id,personId);if(['confirmed','declined'].includes(n.status))throw Error('这次协商已结束');n.status='declined';n.candidate=null;n.confirmations={};log(n,personId,'decline','用户拒绝本次协商。');for(const p of n.participants)record(world.people[p],'本次协商已结束，没有写入日程。',{negotiationId:n.id});return n;}
export function invalidateNegotiations(world,personId){for(const n of world.negotiations){if(!n.participants.includes(personId)||!['awaiting_consent','awaiting_confirmation'].includes(n.status))continue;n.revision++;n.status='awaiting_consent';n.consents={};n.confirmations={};n.candidate=null;log(n,'coordinator','invalidate','个人安排已更新，旧方案失效，需双方重新授权。');}}
export function publicNegotiation(n,personId){member(n,personId);return {id:n.id,participants:n.participants,activity:n.activity,status:n.status,revision:n.revision,candidate:n.candidate,confirmations:n.confirmations,authorized:!!n.consents[personId],events:n.events,createdAt:n.createdAt,notionUrl:n.exports?.[personId]?.notionUrl};}
export function exportPlan(world,n,personId){member(n,personId);if(n.status!=='confirmed')throw Error('双方确认后才能同步协作计划');if(!n.exports[personId])n.exports[personId]={id:`a2a-${n.id}-${personId}`,createdAt:n.createdAt,approved:true,mode:'protocol',context:{text:`共同活动：${n.activity}；参与者：${n.participants.map(id=>world.people[id].profile.name).join('、')}`},conflict:'双方 Agent 完成提案、冲突处理与协商，双方用户已确认。',actions:[`${n.candidate.slot.replace('T',' ')}，${n.activity} ${n.candidate.durationMinutes} 分钟`,...n.candidate.constraints]};return n.exports[personId];}
