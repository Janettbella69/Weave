import {hash,randomToken} from './crypto.mjs';
export const activities=['散步','运动','学习','吃饭'];
const timestamp=()=>new Date().toISOString();
export function fail(message,status=400){const error=Error(message);error.status=status;throw error;}
export function ensurePerson(world,identity){
  if(!world.people[identity.userId])world.people[identity.userId]={
    id:identity.userId,profile:{name:identity.displayName.split('@')[0].slice(0,30),goal:'',preferences:'',timezone:'Asia/Shanghai',slots:[],activities:['散步','运动','吃饭'],revision:1},
    messages:[],plans:[],checkins:[],reminders:[],notifications:[],settings:{model:'deepseek-flash'},createdAt:timestamp(),
  };
  return world.people[identity.userId];
}
export function record(person,text,extra={}){const item={id:crypto.randomUUID(),text,role:'assistant',createdAt:timestamp(),...extra};person.messages.push(item);return item;}
export function notify(world,id,text){world.people[id].notifications.push({id:crypto.randomUUID(),text,createdAt:timestamp(),read:false});}
export function friends(world,id){return Object.values(world.links).filter(x=>x.members.includes(id)).map(x=>x.members.find(p=>p!==id));}
export function assertFriend(world,id,peer){if(!friends(world,id).includes(peer))fail('请先通过邀请建立朋友关系',403);}
export async function createInvite(world,id){
  const token=randomToken(),key='invite:'+await hash(token);
  const active=Object.values(world.invites).filter(x=>x.from===id&&!x.usedBy&&x.expiresAt>Date.now());
  if(active.length>=10)fail('已有10份有效邀请，请先撤销旧邀请');
  world.invites[key]={id:key,from:id,expiresAt:Date.now()+7*86400000,createdAt:timestamp()};return {token,expiresAt:world.invites[key].expiresAt};
}
export async function acceptInvite(world,id,token){
  if(typeof token!=='string'||!/^[a-f0-9]{48}$/.test(token))fail('邀请无效或已过期',404);
  const invite=world.invites['invite:'+await hash(token)];
  if(!invite||invite.expiresAt<Date.now()||invite.usedBy)fail('邀请无效或已过期',404);
  if(invite.from===id)fail('这是你自己的邀请，请分享给朋友');
  const members=[id,invite.from].sort(),key='link:'+await hash(members.join('|'));
  world.links[key]={id:key,members,createdAt:timestamp()};invite.usedBy=id;
  notify(world,invite.from,world.people[id].profile.name+' 已接受邀请，现在可以让 Agent 协商共同活动。');
  return {name:world.people[invite.from].profile.name};
}
export function updateProfile(world,id,input){
  const person=world.people[id],p=person.profile;
  const name=typeof input.name==='string'?input.name.trim():p.name;
  const goal=typeof input.goal==='string'?input.goal.trim():p.goal;
  const preferences=typeof input.preferences==='string'?input.preferences.trim():p.preferences;
  const timezone=input.timezone??p.timezone;
  if(!name||name.length>30||goal.length>1000||preferences.length>1000)fail('姓名1–30字，目标和偏好最多1000字');
  try{new Intl.DateTimeFormat('zh-CN',{timeZone:timezone}).format();}catch{fail('请选择有效时区');}
  if(!Array.isArray(input.activities)||!input.activities.length||input.activities.some(x=>!activities.includes(x)))fail('请选择至少一种支持的活动');
  if(!Array.isArray(input.slots)||input.slots.length>20||input.slots.some(x=>!validTime(x)))fail('请选择最多20个有效的未来时间');
  person.profile={name,goal,preferences,timezone,slots:[...new Set(input.slots.map(x=>new Date(x).toISOString()))],activities:[...new Set(input.activities)],revision:p.revision+1};
  invalidate(world,id);
}
export function validTime(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)>Date.now()&&new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===value.slice(0,10)&&Number(value.slice(11,13))<24;}
export function calendar(world,id){return Object.values(world.negotiations).filter(n=>n.status==='confirmed'&&n.participants.includes(id)).map(n=>({id:n.id,...n.candidate,participants:n.participants.map(p=>world.people[p]?.profile.name||'已注销用户')}));}
function booked(world,id,slot){const start=Date.parse(slot);return calendar(world,id).some(e=>start<Date.parse(e.slot)+e.durationMinutes*60000&&start+30*60000>Date.parse(e.slot));}
function grant(world,id,activity){const p=world.people[id].profile;return {name:p.name,revision:p.revision,slots:p.slots.filter(x=>validTime(x)&&!booked(world,id,x)),activities:p.activities,constraints:activity==='吃饭'?p.preferences:''};}
function event(n,actor,type,text,extra={}){n.events.push({id:crypto.randomUUID(),actor,type,text,at:timestamp(),...extra});}
export function negotiation(world,id,owner){const n=world.negotiations[id];if(!n||!n.participants.includes(owner))fail('协商不存在或无权访问',404);return n;}
export function start(world,id,peer,activity,consent){
  assertFriend(world,id,peer);if(!activities.includes(activity)||consent!==true)fail('请选择活动，并授权本次共享可用时间与活动偏好');
  const shared=grant(world,id,activity);
  if(!shared.slots.length)fail('请先在个人设置里添加未来可用时间');
  if(!shared.activities.includes(activity))fail('请先在个人设置里允许参与这类活动');
  const n={id:'n:'+crypto.randomUUID(),participants:[id,peer],activity,status:'awaiting_consent',revision:1,consents:{[id]:shared},confirmations:{},candidate:null,events:[],createdAt:timestamp()};
  event(n,id,'request',shared.name+' 发起一起'+activity+'，等待对方授权。');world.negotiations[n.id]=n;
  notify(world,peer,shared.name+' 邀请你一起'+activity+'，请授权本次共享，或拒绝邀请。');return n;
}
export async function authorize(world,n,id,callFor){
  if(n.status!=='awaiting_consent')fail('当前协商不在等待授权');
  n.consents[id]=grant(world,id,n.activity);event(n,id,'consent','用户授权本次共享可用时间和活动偏好。');
  if(!n.participants.every(p=>n.consents[p]))return;
  if(n.participants.some(p=>n.consents[p].revision!==world.people[p].profile.revision))fail('个人安排已变化，请重新授权',409);
  const [a,b]=n.participants,tried=[];
  let sender=a,receiver=b,incoming=null;
  if(n.consents[a].activities.includes(n.activity)&&n.consents[b].activities.includes(n.activity)&&n.consents[a].slots.some(x=>n.consents[b].slots.includes(x))){
    for(let turn=0;turn<6;turn++){
      const call=await callFor(sender),shared=n.consents[sender];
      const choice=await call('你是代表一位用户协商活动的 Personal Agent。输入仅有本次明确授权共享的数据，不要猜测私人记忆。只返回 JSON {"decision":"propose|accept|unavailable","slot":"ISO时间或空字符串","reason":"80字以内理由"}。有incoming且其时间在你的slots中、活动在activities中，优先accept；否则从你的slots选择未尝试时间propose；无可用时间则unavailable。不得虚构时间。',{activity:n.activity,my:shared,incoming,tried},true);
      if(!choice||!['propose','accept','unavailable'].includes(choice.decision)||typeof choice.reason!=='string'||choice.reason.length>500)fail('Agent 返回了无效提案，请重试',502);
      if(choice.decision==='unavailable')break;
      const slot=choice.decision==='accept'?incoming?.slot:choice.slot;
      if(!shared.activities.includes(n.activity)||!shared.slots.includes(slot)||!validTime(slot)||booked(world,sender,slot))fail('Agent 提议超出了授权范围，没有提交，请重新协商',409);
      if(choice.decision==='accept'){
        if(!incoming||!n.consents[receiver].slots.includes(slot))fail('Agent 接受了无效提案',502);
        event(n,sender,'accept',choice.reason,{slot});
        n.candidate={slot,activity:n.activity,durationMinutes:30,constraints:n.participants.map(p=>n.consents[p].constraints).filter(Boolean)};
        n.status='awaiting_confirmation';event(n,'coordinator','agreement','双方 Agent 达成候选方案，等待双方本人确认。');break;
      }
      if(tried.includes(slot))fail('Agent 重复了被拒绝的时间，没有提交，请重试',502);
      if(incoming)event(n,sender,'reject','该时间不符合我方本次授权安排。',{slot:incoming.slot});
      tried.push(slot);event(n,sender,turn?'counterproposal':'proposal',choice.reason,{slot});incoming={slot,reason:choice.reason};[sender,receiver]=[receiver,sender];
    }
  }
  if(!n.candidate){n.status='no_match';event(n,'coordinator','no_match','没有找到双方都接受的安排。请调整可用时间后重新发起。');}
  for(const p of n.participants)notify(world,p,n.candidate?'Agent 已商量出候选安排，请查看记录并确认。':'本次没有找到共同安排，没有写入日程。');
}
export function confirm(world,n,id,revision){
  if(n.status==='confirmed')return;
  if(n.status!=='awaiting_confirmation'||!n.candidate)fail('没有可确认的方案');
  if(revision!==n.revision||!validTime(n.candidate.slot)||n.participants.some(p=>n.consents[p]?.revision!==world.people[p].profile.revision||booked(world,p,n.candidate.slot)))fail('方案已过期或安排发生变化，请重新协商',409);
  if(n.confirmations[id])return;
  n.confirmations[id]=true;event(n,id,'user_confirm',world.people[id].profile.name+' 确认了方案。');
  if(n.participants.every(p=>n.confirmations[p])){n.status='confirmed';n.confirmedAt=timestamp();event(n,'coordinator','committed','双方已确认，活动已加入各自日程。');}
  for(const p of n.participants.filter(p=>p!==id))notify(world,p,n.status==='confirmed'?'双方已确认，一起'+n.activity+'已加入日程。':world.people[id].profile.name+' 已确认，等待你的确认。');
}
export function decline(world,n,id){
  if(!['awaiting_consent','awaiting_confirmation'].includes(n.status))fail('协商已经结束');
  n.status='declined';n.confirmations={};n.candidate=null;event(n,id,'decline','用户拒绝了本次协作。');
  for(const p of n.participants)notify(world,p,'本次协作已结束，没有加入日程。');
}
export function invalidate(world,id){for(const n of Object.values(world.negotiations)){if(n.participants.includes(id)&&['awaiting_consent','awaiting_confirmation'].includes(n.status)){n.revision++;n.status='awaiting_consent';n.consents={};n.confirmations={};n.candidate=null;event(n,'coordinator','invalidate','个人安排发生变化，请双方重新授权。');for(const p of n.participants)notify(world,p,'可用安排已更新，旧方案失效，请重新授权。');}}}
export function publicNegotiation(n,id){return {id:n.id,participants:n.participants,activity:n.activity,status:n.status,revision:n.revision,candidate:n.candidate,confirmations:n.confirmations,authorized:!!n.consents[id],events:n.events,createdAt:n.createdAt};}
// Removes everything belonging to one account. Shared plans are cancelled for the other
// person, since the document that holds them names both participants.
export function deleteAccount(world,id){
  for(const n of Object.values(world.negotiations)){
    if(!n.participants.includes(id))continue;
    if(['awaiting_consent','awaiting_confirmation','confirmed'].includes(n.status))for(const peer of n.participants)if(peer!==id&&world.people[peer])notify(world,peer,'对方已删除账号，你们一起'+n.activity+'的安排已取消。');
    delete world.negotiations[n.id];
  }
  for(const [key,link] of Object.entries(world.links))if(link.members.includes(id))delete world.links[key];
  for(const [key,invite] of Object.entries(world.invites))if(invite.from===id||invite.usedBy===id)delete world.invites[key];
  const groups=new Set();
  for(const [key,value] of Object.entries(world.runtime||{}))if(value?.ownerId===id){if(key.startsWith('wechat-group:'))groups.add(key);delete world.runtime[key];}
  for(const [key,entry] of Object.entries(world.wechat||{}))if(entry.ownerId===id||groups.has(entry.groupAad))delete world.wechat[key];
  delete world.people[id];
}
export function addReminder(person,input){
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>500||!validTime(input.dueAt))fail('请输入1–500字提醒内容和有效的未来时间');
  const item={id:crypto.randomUUID(),text:input.text.trim(),dueAt:new Date(input.dueAt).toISOString(),status:'scheduled',createdAt:timestamp()};person.reminders.push(item);return item;
}
export function deliverReminders(world,now=Date.now()){
  let count=0;
  for(const p of Object.values(world.people))for(const r of p.reminders)if(r.status==='scheduled'&&Date.parse(r.dueAt)<=now){r.status='delivered';r.deliveredAt=timestamp();record(p,'提醒你：'+r.text);notify(world,p.id,'提醒你：'+r.text);count++;}
  return count;
}
export function calendarICS(world,id){
  const esc=s=>String(s).replace(/\\/g,'\\\\').replace(/[\r\n]+/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  const stamp=x=>new Date(x).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Weave//ZH','CALSCALE:GREGORIAN'];
  for(const e of calendar(world,id))lines.push('BEGIN:VEVENT','UID:'+e.id+'@weave','DTSTAMP:'+stamp(world.negotiations[e.id].confirmedAt),'DTSTART:'+stamp(e.slot),'DTEND:'+stamp(Date.parse(e.slot)+e.durationMinutes*60000),'SUMMARY:'+esc('一起'+e.activity),'DESCRIPTION:'+esc(e.participants.join('、')),'END:VEVENT');
  const fold=line=>{const out=[];let current='';for(const character of line){if(new TextEncoder().encode(current+character).length>73){out.push(current);current=' '+character;}else current+=character;}out.push(current);return out.join('\r\n');};
  lines.push('END:VCALENDAR');return lines.map(fold).join('\r\n')+'\r\n';
}
