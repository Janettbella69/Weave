import {randomUUID} from 'node:crypto';
import {record,validateSlot} from './workspace.mjs';
function reminderTime(value,now){
 // Browser/chat inputs use local minutes; API clients may send an ISO timestamp.
 if(typeof value!=='string')return null;
 if(validateSlot(value,now))return new Date(value);
 const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
 if(!match)return null;
 const [year,month,day,hour,minute,second]=match.slice(1,7).map(x=>Number(x||0));
 const date=new Date(value),calendar=new Date(0);
 calendar.setUTCFullYear(year,month-1,day);
 if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||hour>23||minute>59||second>59||!Number.isFinite(date.getTime())||date.getTime()<=now)return null;
 return date;
}
export function addReminder(person,input,now=Date.now()){
 const text=typeof input.text==='string'?input.text.trim():'';const due=reminderTime(input.dueAt,now);
 if(!text||text.length>500||!due)throw Error('提醒需要 1–500 字内容和有效的未来时间');
 const reminder={id:randomUUID(),text,dueAt:due.toISOString(),status:'scheduled',createdAt:new Date().toISOString()};person.reminders.push(reminder);return reminder;
}
export function runReminders(world,now=Date.now(),notify=()=>{}){
 let count=0;for(const [id,person] of Object.entries(world.people))for(const r of person.reminders){if(r.status!=='scheduled'||new Date(r.dueAt).getTime()>now)continue;r.status='delivered';r.deliveredAt=new Date(now).toISOString();record(person,'提醒你：'+r.text,{reminderId:r.id});notify(id,'提醒你：'+r.text);count++;}return count;
}
