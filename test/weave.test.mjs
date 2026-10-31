import {test} from 'node:test';import assert from 'node:assert/strict';
import {migrateWorld,updateProfile,futureSlots} from '../workspace.mjs';
import {startNegotiation,authorize,confirm,decline,publicNegotiation,exportPlan,invalidateNegotiations} from '../negotiation.mjs';
import {addReminder,runReminders} from '../reminders.mjs';
import {calendarICS} from '../calendar.mjs';
import {handleWeaveChat} from '../weave-chat.mjs';
const setup=()=>migrateWorld();
function agreed(w){const n=startNegotiation(w,'lulu','meng','散步',true);authorize(w,n.id,'meng');return n;}
test('migration preserves existing personal records and creates an independent friend space',()=>{const old={plans:[{id:'old'}],messages:[{text:'private'}],checkins:[{text:'private feedback'}],pending:'private pending',wechatInbox:{}};const w=migrateWorld(old);assert.equal(w.people.lulu.plans[0].id,'old');assert.equal(w.people.meng.messages.length,0);assert.equal(w.people.meng.checkins.length,0);assert.equal(w.people.meng.pending,'');assert.equal(migrateWorld(w),w);});
test('agents wait for consent and share neither private chat nor unrelated memories',()=>{const w=setup();w.people.meng.checkins.push({text:'DO_NOT_SHARE'});w.people.meng.profile.preferences='PRIVATE_PREFERENCE';assert.throws(()=>startNegotiation(w,'lulu','meng','散步',false),/授权/);const n=startNegotiation(w,'lulu','meng','散步',true);assert.equal(n.status,'awaiting_consent');assert.equal(n.consents.meng,undefined);authorize(w,n.id,'meng');const wire=JSON.stringify(publicNegotiation(n,'lulu'));assert.ok(!wire.includes('DO_NOT_SHARE'));assert.ok(!wire.includes('PRIVATE_PREFERENCE'));assert.ok(!wire.includes('consents'));});
test('independently scoped agents reject conflicting proposals then counterpropose a shared slot',()=>{const w=setup(),n=agreed(w);assert.equal(n.status,'awaiting_confirmation');assert.equal(n.candidate.slot,futureSlots()[2]);assert.deepEqual(n.events.filter(e=>['proposal','reject','counterproposal','accept'].includes(e.type)).map(e=>e.type),['proposal','reject','counterproposal','reject','counterproposal','accept']);assert.equal(w.people.lulu.calendar.length,0);assert.equal(w.people.meng.calendar.length,0);});
test('one-sided confirmation does not commit; mutual confirmation is idempotent',()=>{const w=setup(),n=agreed(w);confirm(w,n.id,'lulu',n.revision);assert.equal(n.status,'awaiting_confirmation');assert.equal(w.people.lulu.calendar.length,0);confirm(w,n.id,'meng',n.revision);confirm(w,n.id,'meng',n.revision);assert.equal(n.status,'confirmed');assert.equal(w.people.lulu.calendar.length,1);assert.equal(w.people.meng.calendar.length,1);assert.equal(w.people.lulu.calendar[0].negotiationId,n.id);});
test('no available intersection produces no agreement and no fake schedule',()=>{const w=setup();w.people.meng.profile.slots=[futureSlots()[1]];const n=agreed(w);assert.equal(n.status,'no_match');assert.equal(n.candidate,null);assert.throws(()=>confirm(w,n.id,'lulu',n.revision),/候选/);assert.equal(w.people.lulu.calendar.length,0);});
test('changing a profile invalidates old grants and prevents stale confirmation',()=>{const w=setup(),n=agreed(w),oldRevision=n.revision;updateProfile(w.people.lulu,{...w.people.lulu.profile,slots:[futureSlots()[2]]});invalidateNegotiations(w,'lulu');assert.equal(n.revision,oldRevision+1);assert.equal(n.status,'awaiting_consent');assert.deepEqual(n.confirmations,{});assert.deepEqual(n.consents,{});authorize(w,n.id,'lulu');authorize(w,n.id,'meng');assert.throws(()=>confirm(w,n.id,'lulu',oldRevision),/更新/);});
test('unauthorized participant cannot confirm, authorize or read a negotiation',()=>{const w=setup(),n=agreed(w);assert.throws(()=>confirm(w,n.id,'intruder',1),/参与者/);assert.throws(()=>authorize(w,n.id,'intruder'),/参与者/);assert.throws(()=>publicNegotiation(n,'intruder'),/参与者/);});
test('decline ends a pending agreement and never creates calendar entries',()=>{const w=setup(),n=agreed(w);decline(w,n.id,'meng');assert.equal(n.status,'declined');assert.throws(()=>confirm(w,n.id,'lulu',1));assert.equal(w.people.meng.calendar.length,0);});
test('pending parallel agreements cannot double book a confirmed time',()=>{const w=setup(),first=agreed(w),second=agreed(w);confirm(w,first.id,'lulu',1);confirm(w,first.id,'meng',1);assert.throws(()=>confirm(w,second.id,'lulu',1),/占用/);const third=agreed(w);assert.equal(third.status,'no_match');});
test('Notion cooperative export requires mutual consent and exports no private feedback',()=>{const w=setup(),n=agreed(w);assert.throws(()=>exportPlan(w,n,'lulu'),/双方确认/);w.people.lulu.checkins.push({text:'secret'});confirm(w,n.id,'lulu',1);confirm(w,n.id,'meng',1);const p=exportPlan(w,n,'lulu');assert.equal(p.approved,true);assert.ok(!JSON.stringify(p).includes('secret'));assert.notEqual(p.id,exportPlan(w,n,'meng').id);});
test('reminders deliver only to their owner and are not repeated',()=>{const w=setup(),now=Date.now();const r=addReminder(w.people.meng,{text:'喝水',dueAt:new Date(now+1000).toISOString()},now);const pushed=[];assert.equal(runReminders(w,now,()=>{}),0);assert.equal(runReminders(w,now+2000,(...args)=>pushed.push(args)),1);assert.equal(runReminders(w,now+3000,()=>{}),0);assert.deepEqual(pushed,[['meng','提醒你：喝水']]);assert.equal(r.status,'delivered');assert.equal(w.people.lulu.messages.length,0);});
test('reminders reject nonexistent dates instead of silently scheduling a different day',()=>{
 const person=setup().people.lulu,now=new Date('2028-01-01T00:00:00Z').getTime();
 for(const dueAt of ['2028-02-30T20:00','2029-02-29T20:00','2028-02-30T20:00:00Z','2029-02-29T20:00:00+08:00','2028-01-02T24:00:00Z','2028-01-02T20:60:00Z',null,[],20280102])assert.throws(()=>addReminder(person,{text:'散步',dueAt},now),/有效的未来时间/);
 assert.equal(person.reminders.length,0);
 for(const dueAt of ['2028-02-29T20:00','2028-02-29T20:00:00.123Z','2028-02-29T20:00:00+08:00'])assert.equal(addReminder(person,{text:'散步',dueAt},now).dueAt,new Date(dueAt).toISOString());
});
test('chat reports no match to both participants without asking them to keep waiting',async()=>{
 const w=setup(),sent=[],opts={notionFor:()=>({configured:()=>false,memory:async()=>''}),save:async()=>{},notify:(...args)=>sent.push(args)};
 w.people.meng.profile.slots=[];
 await handleWeaveChat(w,'lulu','约阿梦散步',opts);
 const n=w.negotiations[0],result=await handleWeaveChat(w,'meng','授权协商 '+n.id.slice(0,8),opts);
 assert.equal(n.status,'no_match');assert.match(result.messages.at(-1).text,/没有找到双方都接受/);assert.match(result.messages.at(-1).text,/重新发起邀请/);assert.doesNotMatch(result.messages.at(-1).text,/等待/);
 assert.ok(sent.some(([id,text])=>id==='lulu'&&text.includes('没有找到双方都接受')));
 assert.equal(w.people.lulu.calendar.length,0);assert.equal(w.people.meng.calendar.length,0);
});
test('confirmation notifications identify the sender without claiming the recipient has confirmed',async()=>{
 const w=setup(),sent=[],opts={notionFor:()=>({configured:()=>false,memory:async()=>''}),save:async()=>{},notify:(...args)=>sent.push(args)};
 const n=agreed(w);
 const result=await handleWeaveChat(w,'lulu','确认协商 '+n.id.slice(0,8),opts);
 assert.match(result.messages.at(-1).text,/你已确认/);
 assert.equal(sent.at(-1)[0],'meng');assert.match(sent.at(-1)[1],/Lulu 已确认本次方案，等待你的确认/);assert.doesNotMatch(sent.at(-1)[1],/你已确认/);
 assert.deepEqual(n.confirmations,{lulu:true});assert.equal(n.status,'awaiting_confirmation');
});
test('calendar export has UTC event times and distinct calendar ownership',()=>{const w=setup(),n=agreed(w);confirm(w,n.id,'lulu',1);confirm(w,n.id,'meng',1);const ics=calendarICS(w.people.lulu);assert.match(ics,/BEGIN:VCALENDAR\r\n/);assert.match(ics,/DTSTART:\d{8}T\d{6}Z/);assert.match(ics,/SUMMARY:一起散步/);assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1);assert.notEqual(calendarICS(w.people.lulu),calendarICS(w.people.meng));});
test('chat starts, authorizes and confirms an actual protocol session in separate contexts',async()=>{const w=setup(),sent=[];const opts={notionFor:()=>({configured:()=>false,memory:async()=>''}),save:async()=>{},notify:(...args)=>sent.push(args)};await handleWeaveChat(w,'lulu','约阿梦散步',opts);assert.equal(w.people.lulu.messages[0].role,'user');const n=w.negotiations[0];await handleWeaveChat(w,'meng','授权协商 '+n.id.slice(0,8),opts);await handleWeaveChat(w,'lulu','确认协商 '+n.id.slice(0,8),opts);await handleWeaveChat(w,'meng','确认协商 '+n.id.slice(0,8),opts);assert.equal(n.status,'confirmed');assert.ok(sent.length>=3);await handleWeaveChat(w,'meng','反馈：只属于阿梦的记录',opts);assert.equal(w.people.lulu.checkins.length,0);assert.equal(w.people.meng.checkins.length,1);});
