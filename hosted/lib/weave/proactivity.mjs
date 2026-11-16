// 允许打扰的时段（activeStart、activeEnd）和「现在」「今天」的算法。后台叫醒、提醒和每日收尾都按它们算（proactive.mjs 等）。
// 旧版后台判断（Hermes）留在数据里的其他字段不再读，也不会报错。
export function proactiveState(person){
  person.proactivity??={activeStart:'09:00',activeEnd:'21:00'};
  return person.proactivity;
}
export function localClock(person,now){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:person.profile.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
  return {day:`${parts.year}-${parts.month}-${parts.day}`,minute:Number(parts.hour)*60+Number(parts.minute)};
}
// 打卡群里的「今天」和「现在」按北京时间算（2026-11-02 定：用户多在中国），不用开启者自己的时区。
export const GROUP_TIMEZONE='Asia/Shanghai';
const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
export function activeNow(person,now){const p=proactiveState(person),current=localClock(person,now).minute,start=minutes(p.activeStart),end=minutes(p.activeEnd);return start<end?current>=start&&current<end:current>=start||current<end;}
