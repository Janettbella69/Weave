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
}
export function validTime(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)>Date.now()&&new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===value.slice(0,10)&&Number(value.slice(11,13))<24;}
// Removes everything belonging to one account. Friend links, invitations and shared plans from the removed friend
// feature may still be in old data; they go with the account, with nothing said to the other person.
export function deleteAccount(world,id){
  for(const [key,n] of Object.entries(world.negotiations||{}))if(n.participants?.includes(id))delete world.negotiations[key];
  for(const [key,link] of Object.entries(world.links||{}))if(link.members?.includes(id))delete world.links[key];
  for(const [key,invite] of Object.entries(world.invites||{}))if(invite.from===id||invite.usedBy===id)delete world.invites[key];
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
