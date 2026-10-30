import {randomUUID} from 'node:crypto';
export const peopleIds=['lulu','meng'];
export const activities=['散步','运动','学习','吃饭'];
export function futureSlots(now=new Date()){
 const next=day=>{const d=new Date(now);d.setDate(d.getDate()+((day-d.getDay()+7)%7||7));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
 return [`${next(3)}T20:00`,`${next(5)}T18:30`,`${next(3)}T18:30`];
}
export function blankPerson(id){const slots=futureSlots();return {profile:{id,name:id==='lulu'?'Lulu':'阿梦',agentName:id==='lulu'?'Lulu 的 Agent':'阿梦的 Agent',goal:'每周做几次容易坚持的小活动',preferences:'',activities:['散步','运动','吃饭'],slots:id==='lulu'?[slots[0],slots[2]]:[slots[1],slots[2]],revision:1},plans:[],messages:[],checkins:[],pending:'',calendar:[],reminders:[]};}
export function migrateWorld(old){
 if(old?.version===2)return old;
 const lulu=blankPerson('lulu');for(const key of ['plans','messages','checkins','pending'])if(old?.[key]!==undefined)lulu[key]=old[key];
 return {version:2,people:{lulu,meng:blankPerson('meng')},negotiations:[],wechatInbox:old?.wechatInbox||{}};
}
export function personFor(world,id){if(!peopleIds.includes(id)||!world.people[id])throw Error('个人空间不存在');return world.people[id];}
export function record(person,text,extra={}){const m={id:randomUUID(),role:'assistant',text,createdAt:new Date().toISOString(),...extra};person.messages.push(m);return m;}
export function validateSlot(slot,now=Date.now()){
 if(typeof slot!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot))return false;
 const d=new Date(slot);const parts=slot.match(/\d+/g).map(Number);
 return Number.isFinite(d.getTime())&&d.getTime()>now&&d.getFullYear()===parts[0]&&d.getMonth()+1===parts[1]&&d.getDate()===parts[2]&&d.getHours()===parts[3]&&d.getMinutes()===parts[4];
}
export function updateProfile(person,input){
 const name=String(input.name??person.profile.name).trim(),goal=String(input.goal??'').trim(),preferences=String(input.preferences??'').trim();
 if(!name||name.length>30||goal.length>1000||preferences.length>1000)throw Error('姓名最多 30 字，目标和偏好最多各 1000 字');
 if(!Array.isArray(input.slots)||input.slots.length>20||input.slots.some(s=>!validateSlot(s)))throw Error('请选择最多 20 个有效的未来时间');
 if(!Array.isArray(input.activities)||!input.activities.length||input.activities.some(x=>!activities.includes(x)))throw Error('请选择支持的活动');
 person.profile={...person.profile,name,agentName:name+' 的 Agent',goal,preferences,slots:[...new Set(input.slots)],activities:[...new Set(input.activities)],revision:person.profile.revision+1};return person.profile;
}
