import {randomUUID} from 'node:crypto';
import {record} from './workspace.mjs';
export function addReminder(person,input,now=Date.now()){
 const text=typeof input.text==='string'?input.text.trim():'';const due=new Date(input.dueAt);
 if(!text||text.length>500||!Number.isFinite(due.getTime())||due.getTime()<=now)throw Error('提醒需要 1–500 字内容和有效的未来时间');
 const reminder={id:randomUUID(),text,dueAt:due.toISOString(),status:'scheduled',createdAt:new Date().toISOString()};person.reminders.push(reminder);return reminder;
}
export function runReminders(world,now=Date.now(),notify=()=>{}){
 let count=0;for(const [id,person] of Object.entries(world.people))for(const r of person.reminders){if(r.status!=='scheduled'||new Date(r.dueAt).getTime()>now)continue;r.status='delivered';r.deliveredAt=new Date(now).toISOString();record(person,'提醒你：'+r.text,{reminderId:r.id});notify(id,'提醒你：'+r.text);count++;}return count;
}
