import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {localDay,addDays,weekStart,dayRange,formatDay,formatHeader,formatHeaderShort,formatTime,formatDue,formatMonth,addMonths} from '../hosted/app/workspace/dates.mjs';
import {todoModel,upcomingReminders} from '../hosted/app/workspace/todo.mjs';
import {habitKey,reminderKey,withChecks,settleChecks} from '../hosted/app/workspace/todo-checks.mjs';
import {CATEGORY_LABEL,goalsModel,goalWordsLimit} from '../hosted/app/workspace/goals-view.mjs';
import {MESSAGE_MAX_LENGTH} from '../hosted/app/workspace/chat-input.mjs';
import {monthModel,recentNotes,monthBounds,newestHabitsFirst} from '../hosted/app/workspace/records.mjs';
import {zoneOptions,profileForSave,bindCodeTimeout,BIND_CODE_LIFETIME} from '../hosted/app/workspace/settings-view.mjs';
import {withSeparators,isProactive,proactiveLabel} from '../hosted/app/workspace/chat-view.mjs';
import {retryOnConflict} from '../hosted/app/workspace/retry.mjs';
import {ApiError} from '../hosted/app/workspace/api-client.mjs';
import {COPY} from '../hosted/app/workspace/copy.mjs';

// The pure view models behind the pages. Monday 2026-11-02 is the "today" of the v3 boards; the person is in Shanghai unless a test says otherwise.
const SH='Asia/Shanghai',LA='America/Los_Angeles';
const TODAY='2026-11-02';
const NOW=Date.parse('2026-11-02T12:00:00Z');   // 20:00 in Shanghai

const goal=(id,title,category,extra={})=>({id,title,category,archived:false,createdAt:'2026-10-12T03:00:00.000Z',updatedAt:'2026-10-12T03:00:00.000Z',...extra});
const habit=(id,name,extra={})=>({id,name,identity:'',trigger:'',minimumAction:'',createdAt:'2026-10-12T03:00:00.000Z',updatedAt:'2026-10-12T03:00:00.000Z',...extra});
const done=(habitId,date,extra={})=>({id:'c:'+habitId+':'+date,habitId,date,note:'',source:'web',createdAt:date+'T10:00:00.000Z',...extra});
const reminder=(id,text,dueAt,status='scheduled')=>({id,text,dueAt,status,createdAt:'2026-11-01T00:00:00.000Z'});

// ---- dates ----

test('localDay is the date on the wall in the person\'s zone',()=>{
  assert.equal(localDay('2026-11-03T07:30:00Z',LA),'2026-11-02','23:30 in Los Angeles is still the 2nd');
  assert.equal(localDay('2026-11-03T07:30:00Z',SH),'2026-11-03');
  assert.equal(localDay(Date.parse('2026-11-03T07:30:00Z'),LA),'2026-11-02','milliseconds work too');
  assert.equal(localDay(new Date('2026-11-03T07:30:00Z'),LA),'2026-11-02','and a Date');
  assert.equal(localDay('2026-11-02T15:59:59Z',SH),'2026-11-02');
  assert.equal(localDay('2026-11-02T16:00:00Z',SH),'2026-11-03','midnight is 00:00 of the next day, not 24:00');
  assert.equal(localDay('2026-11-01T08:30:00Z',LA),'2026-11-01','the hour the US clocks go back');
  for(const bad of [undefined,null,'','not a time',NaN])assert.equal(localDay(bad,SH),'','nothing to show for '+String(bad));
});

test('addDays moves along the calendar, over months, years and leap days',()=>{
  assert.equal(addDays('2026-11-02',1),'2026-11-03');
  assert.equal(addDays('2026-11-02',-1),'2026-11-01');
  assert.equal(addDays('2026-11-02',0),'2026-11-02');
  assert.equal(addDays('2026-10-31',1),'2026-11-01');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
  assert.equal(addDays('2026-03-01',-1),'2026-02-28');
  assert.equal(addDays('2028-02-28',1),'2028-02-29');
  assert.equal(addDays('2026-11-02',-6),'2026-10-27');
  assert.equal(addDays('',1),'');assert.equal(addDays('soon',1),'');
});

test('weekStart is the Monday of the week, and Sunday belongs to the week before',()=>{
  assert.equal(weekStart('2026-11-02'),'2026-11-02');
  assert.equal(weekStart('2026-11-04'),'2026-11-02');
  assert.equal(weekStart('2026-11-08'),'2026-11-02','Sunday is the last day of its week');
  assert.equal(weekStart('2026-11-01'),'2026-10-26');
  assert.equal(weekStart('2027-01-01'),'2026-12-28','over a year');
  assert.equal(weekStart(''),'');
});

test('dayRange lists the days from one to the other, both included',()=>{
  assert.deepEqual(dayRange('2026-10-30','2026-11-02'),['2026-10-30','2026-10-31','2026-11-01','2026-11-02']);
  assert.deepEqual(dayRange('2026-11-02','2026-11-02'),['2026-11-02']);
  assert.deepEqual(dayRange('2026-11-03','2026-11-02'),[],'nothing when it ends before it starts');
  assert.deepEqual(dayRange('','2026-11-02'),[]);
});

test('formatDay writes the day without leading zeros',()=>{
  assert.equal(formatDay('2026-11-02'),'11 月 2 日');
  assert.equal(formatDay('2026-01-09'),'1 月 9 日');
  assert.equal(formatDay('2026-10-31'),'10 月 31 日');
  assert.equal(formatDay(''),'');
});

test('formatHeader adds the weekday, long as on the wide board and short as on the phone board',()=>{
  assert.equal(formatHeader('2026-11-02'),'11 月 2 日 · 星期一');
  assert.deepEqual(['2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'].map(day=>formatHeader(day).split(' · ')[1]),['星期二','星期三','星期四','星期五','星期六','星期日']);
  assert.equal(formatHeader('2026-11-02',{short:true}),'11 月 2 日 · 周一');
  assert.equal(formatHeader('2026-11-08',{short:true}),'11 月 8 日 · 周日');
  assert.equal(formatHeader(''),'');
});

test('formatHeaderShort is the date of the phone\'s top bar, as on the phone boards',()=>{
  assert.equal(formatHeaderShort('2026-11-02'),'11 月 2 日 · 周一');
  assert.deepEqual(['2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'].map(day=>formatHeaderShort(day).split(' · ')[1]),['周二','周三','周四','周五','周六','周日']);
  assert.equal(formatHeaderShort('2027-01-01'),'1 月 1 日 · 周五');
  for(const bad of ['','2026-02-30','soon',undefined])assert.equal(formatHeaderShort(bad),'','nothing to show for '+String(bad));
});

test('formatMonth is the records page\'s month title, as on the board',()=>{
  assert.equal(formatMonth('2026-10'),'2026 年 10 月');
  assert.equal(formatMonth('2027-01'),'2027 年 1 月','no leading zero');
  for(const bad of ['2026-13','2026-00','2026-1','soon','',undefined,null])assert.equal(formatMonth(bad),'',String(bad));
});

test('addMonths turns the month, over the turn of the year both ways',()=>{
  assert.equal(addMonths('2026-10',-1),'2026-09');
  assert.equal(addMonths('2026-10',1),'2026-11');
  assert.equal(addMonths('2026-12',1),'2027-01');
  assert.equal(addMonths('2026-01',-1),'2025-12');
  assert.equal(addMonths('2026-10',0),'2026-10');
  assert.equal(addMonths('2026-10',-13),'2025-09');
  for(const bad of ['2026-13','2026-1','',undefined])assert.equal(addMonths(bad,1),'',String(bad));
});

test('formatTime is the clock in the person\'s zone',()=>{
  assert.equal(formatTime('2026-11-02T11:30:00Z',SH),'19:30');
  assert.equal(formatTime('2026-11-02T11:30:00Z',LA),'03:30');
  assert.equal(formatTime('2026-11-02T08:30:00Z',LA),'00:30','midnight is 00:xx');
  assert.equal(formatTime('nope',SH),'');
});

test('formatDue says tomorrow, today, or the day, with the time',()=>{
  assert.equal(formatDue('2026-11-04T12:00:00Z',SH,'2026-11-03'),'明天 20:00');
  assert.equal(formatDue('2026-11-03T12:00:00Z',SH,'2026-11-03'),'今天 20:00');
  assert.equal(formatDue('2026-11-05T12:00:00Z',SH,'2026-11-03'),'11 月 5 日 20:00');
  assert.equal(formatDue('2026-11-04T12:00:00Z',SH,'2026-11-02'),'11 月 4 日 20:00');
  assert.equal(formatDue('2026-11-03T16:30:00Z',SH,'2026-11-03'),'明天 00:30','past midnight in the person\'s zone is tomorrow');
  assert.equal(formatDue('2026-11-04T04:00:00Z',LA,'2026-11-03'),'今天 20:00','the same instant is the evening before in Los Angeles');
  assert.equal(formatDue('2026-12-31T12:00:00Z',SH,'2026-12-30'),'明天 20:00');
  assert.equal(formatDue('2027-01-01T12:00:00Z',SH,'2026-12-31'),'明天 20:00','over New Year');
  assert.equal(formatDue('nope',SH,TODAY),'');
});

// ---- 待办 ----

test('todoModel: a habit done today is done, and counts in the progress',()=>{
  const habits=[habit('h:walk','饭后走 10 分钟',{trigger:'吃完晚饭后',minimumAction:'走到楼下',goalId:'g:1'}),habit('h:read','睡前读 1 页',{trigger:'睡前'})];
  const model=todoModel({goals:[goal('g:1','每天动一动','health')],habits,completions:[done('h:walk',TODAY)],reminders:[],today:TODAY,now:NOW,tz:SH});
  assert.equal(model.doneCount,1);assert.equal(model.total,2);
  assert.equal(model.today[0].habitId,'h:walk');assert.equal(model.today[0].title,'饭后走 10 分钟');assert.equal(model.today[0].done,true);
  assert.equal(model.today[1].done,false);
  assert.deepEqual(model.later,[]);
});

test('todoModel: the line under a habit is 为了「目标」 · 什么时候 · 最小一步, without the parts it does not have',()=>{
  const habits=[
    habit('h:all','饭后走 10 分钟',{trigger:'吃完晚饭后',minimumAction:'走到楼下',goalId:'g:1'}),
    habit('h:no-step','睡前读 1 页',{trigger:'睡前',goalId:'g:2'}),
    habit('h:no-goal','起床先喝水',{trigger:'起床后',minimumAction:'一杯就行'}),
    habit('h:bare','拉伸'),
    habit('h:blank','深呼吸',{trigger:'  ',minimumAction:' ',goalId:'g:1'}),
  ];
  const goals=[goal('g:1','每天动一动','health'),goal('g:2','多读点书','interests')];
  const rows=todoModel({goals,habits,completions:[],reminders:[],today:TODAY,now:NOW,tz:SH}).today;
  assert.deepEqual(rows.map(r=>r.meta),['为了「每天动一动」 · 吃完晚饭后 · 最小一步：走到楼下','为了「多读点书」 · 睡前','起床后 · 最小一步：一杯就行','','为了「每天动一动」']);
});

test('todoModel: the habits of an archived goal are not listed; a habit with no goal, or with a goal nobody sent, is',()=>{
  const goals=[goal('g:1','每天动一动','health'),goal('g:2','旧目标','other',{archived:true})];
  const habits=[habit('h:walk','走路',{goalId:'g:1'}),habit('h:old','旧习惯',{goalId:'g:2'}),habit('h:none','没有目标'),habit('h:lost','目标不在列表里',{goalId:'g:404'})];
  const model=todoModel({goals,habits,completions:[done('h:old',TODAY)],reminders:[],today:TODAY,now:NOW,tz:SH});
  assert.deepEqual(model.today.map(r=>r.habitId),['h:walk','h:none','h:lost']);
  assert.equal(model.total,3);assert.equal(model.doneCount,0,'a done habit of an archived goal does not count either');
  assert.equal(model.today[2].meta,'','no goal name to show for a goal that is not in the list');
});

test('todoModel: yesterday missed is noted for a habit that existed yesterday and is not done yet',()=>{
  const walk=habit('h:walk','走路',{createdAt:'2026-10-12T03:00:00.000Z'});
  const run=(completions,habits=[walk],tz=SH,today=TODAY)=>todoModel({goals:[],habits,completions,reminders:[],today,now:NOW,tz}).today;
  assert.equal(run([])[0].missedYesterday,true,'nothing yesterday');
  assert.equal(run([done('h:walk','2026-11-01')])[0].missedYesterday,false,'done yesterday');
  assert.equal(run([done('h:walk','2026-10-31')])[0].missedYesterday,true,'the day before does not count');
  assert.equal(run([done('h:walk',TODAY)])[0].missedYesterday,false,'done today already: nothing to make up');
  assert.equal(run([done('h:other','2026-11-01')])[0].missedYesterday,true,'another habit\'s record does not count');
  const fresh=habit('h:new','新习惯',{createdAt:'2026-11-02T01:00:00.000Z'});
  assert.equal(run([],[fresh])[0].missedYesterday,false,'created today: there was no yesterday for it');
  // 2026-11-02T07:30Z is 23:30 on the 1st in Los Angeles but 15:30 on the 2nd in Shanghai
  const late=habit('h:late','晚上才加的',{createdAt:'2026-11-02T07:30:00.000Z'});
  assert.equal(run([],[late],LA)[0].missedYesterday,true,'created yesterday where the person lives');
  assert.equal(run([],[late],SH)[0].missedYesterday,false,'created today where the person lives');
  assert.equal(todoModel({goals:[],habits:[late],completions:[],reminders:[],today:TODAY,now:NOW}).today[0].missedYesterday,false,'Beijing time when no zone is given');
});

test('todoModel: the week count is the days from Monday to today, today included',()=>{
  const walk=habit('h:walk','走路');
  const completions=[done('h:walk','2026-11-01'),done('h:walk','2026-11-02'),done('h:walk','2026-11-03'),done('h:walk','2026-11-05'),done('h:other','2026-11-04')];
  const row=todoModel({goals:[],habits:[walk],completions,reminders:[],today:'2026-11-05',now:NOW,tz:SH}).today[0];
  assert.equal(row.weekCount,3,'Mon 2nd, Tue 3rd and Thu 5th; Sunday the 1st is last week\'s');
  assert.equal(row.done,true);
  assert.equal(COPY.doneNote(row.weekCount),'记下了，这周第 3 天。');
  const monday=todoModel({goals:[],habits:[walk],completions,reminders:[],today:'2026-11-02',now:NOW,tz:SH}).today[0];
  assert.equal(monday.weekCount,1,'on a Monday the week is one day long');
  assert.equal(todoModel({goals:[],habits:[walk],completions:[done('h:walk','2026-11-03'),done('h:walk','2026-11-03')],reminders:[],today:'2026-11-05',now:NOW,tz:SH}).today[0].weekCount,1,'a day counts once');
});

test('todoModel: later is the one-off reminders still to come, soonest first',()=>{
  const reminders=[
    reminder('r:tomorrow','给妈妈打个电话','2026-11-03T12:00:00.000Z'),
    reminder('r:tonight','拿快递','2026-11-02T13:00:00.000Z'),
    reminder('r:past','已经过了','2026-11-02T11:00:00.000Z'),
    reminder('r:now','正好是现在','2026-11-02T12:00:00.000Z'),
    reminder('r:cancelled','取消了','2026-11-04T12:00:00.000Z','cancelled'),
    reminder('r:delivered','已提醒','2026-11-04T12:00:00.000Z','delivered'),
    reminder('r:broken','时间坏了','not a time'),
  ];
  const model=todoModel({goals:[],habits:[],completions:[],reminders,today:TODAY,now:NOW,tz:SH});
  assert.deepEqual(model.later,[
    {reminderId:'r:tonight',title:'拿快递',dueAt:'2026-11-02T13:00:00.000Z'},
    {reminderId:'r:tomorrow',title:'给妈妈打个电话',dueAt:'2026-11-03T12:00:00.000Z'},
  ]);
  assert.deepEqual([model.total,model.doneCount,model.today],[0,0,[]],'reminders are not part of 今天 n / m');
  assert.deepEqual(todoModel({goals:[],habits:[],completions:[],reminders,today:TODAY,now:'2026-11-02T12:30:00Z',tz:SH}).later.map(r=>r.reminderId),['r:tonight','r:tomorrow'],'now may be an ISO time');
});

test('upcomingReminders: the list of 只响一次 on the assistant\'s home page is 待办\'s 之后, from the same rule',()=>{
  const reminders=[
    reminder('r:tomorrow','给妈妈打个电话','2026-11-03T12:00:00.000Z'),
    reminder('r:tonight','拿快递','2026-11-02T13:00:00.000Z'),
    reminder('r:past','已经过了','2026-11-02T11:00:00.000Z'),
    reminder('r:cancelled','取消了','2026-11-04T12:00:00.000Z','cancelled'),
  ];
  assert.deepEqual(upcomingReminders({reminders,now:NOW}),[
    {reminderId:'r:tonight',title:'拿快递',dueAt:'2026-11-02T13:00:00.000Z'},
    {reminderId:'r:tomorrow',title:'给妈妈打个电话',dueAt:'2026-11-03T12:00:00.000Z'},
  ],'scheduled and still to come, soonest first');
  assert.deepEqual(upcomingReminders({reminders,now:NOW}),todoModel({reminders,today:TODAY,now:NOW,tz:SH}).later);
  assert.deepEqual(upcomingReminders({now:NOW}),[]);
  assert.equal(reminders[0].id,'r:tomorrow','the list it was given is left in its order');
});

test('todoModel: the answer of an older server, with no lists at all, is an empty page and not an error',()=>{
  assert.deepEqual(todoModel({today:'',now:NOW}),{today:[],later:[],doneCount:0,total:0});
  assert.deepEqual(todoModel({goals:[],habits:[habit('h:a','a')],completions:[],reminders:[],today:'',now:NOW}).today.map(r=>[r.done,r.missedYesterday,r.weekCount]),[[false,false,0]],'without today there is nothing to be done or missed');
});

// ---- 待办's tick boxes (todo-checks.mjs) ----

// Monday 2026-11-02: the walk is not done (and was missed yesterday), the reading is done, a call is still to come.
const tickModel=(extra={})=>todoModel({goals:[],habits:[habit('h:walk','饭后走 10 分钟'),habit('h:read','睡前读 1 页')],completions:[done('h:read',TODAY)],
  reminders:[reminder('r:call','给妈妈打个电话','2026-11-03T12:00:00.000Z')],today:TODAY,now:NOW,tz:SH,...extra});
const press=(value,extra={})=>({value,day:TODAY,finished:false,seen:0,...extra});
const rowOf=(model,id)=>model.today.find(row=>row.habitId===id);

test('withChecks: a press shows at once, in the box, the progress and the week count',()=>{
  const model=tickModel();
  assert.deepEqual([rowOf(model,'h:walk').done,rowOf(model,'h:walk').missedYesterday,rowOf(model,'h:walk').weekCount,model.doneCount],[false,true,0,1],'the model as the server has it');
  let shown=withChecks(model,{[habitKey('h:walk')]:press(true)},TODAY);
  assert.deepEqual([rowOf(shown,'h:walk').done,rowOf(shown,'h:walk').missedYesterday,rowOf(shown,'h:walk').weekCount],[true,false,1],'ticked: done, this week\'s first day, no missed note');
  assert.deepEqual([shown.doneCount,shown.total],[2,2]);
  shown=withChecks(model,{[habitKey('h:read')]:press(false)},TODAY);
  assert.deepEqual([rowOf(shown,'h:read').done,rowOf(shown,'h:read').weekCount,shown.doneCount],[false,0,0],'unticked: the day comes off the week');
  assert.deepEqual(withChecks(model,{[habitKey('h:read')]:press(true)},TODAY).today,model.today,'a press the server already agrees with changes nothing');
  assert.equal(rowOf(withChecks(model,{[habitKey('h:walk')]:press(true,{day:'2026-11-01'})},TODAY),'h:walk').done,false,'a press made on another day is not today\'s');
  assert.deepEqual(withChecks(model,{[reminderKey('r:call')]:press(true)},TODAY).later.map(item=>[item.reminderId,item.done]),[['r:call',true]],'a ticked reminder');
  assert.deepEqual(withChecks(model,{},TODAY).later.map(item=>item.done),[false]);
  assert.equal(withChecks(model,{},TODAY).doneCount,1);
});

test('settleChecks: a press stays until the server shows the same, or until the second answer after it came back',()=>{
  const model=tickModel(),agreeing=tickModel({completions:[done('h:read',TODAY),done('h:walk',TODAY)]});
  const waiting={[habitKey('h:walk')]:press(true)};
  assert.equal(settleChecks(waiting,agreeing,TODAY),waiting,'on its way: kept even when an answer agrees, and the same object comes back');
  assert.deepEqual(settleChecks({[habitKey('h:walk')]:press(true,{finished:true})},agreeing,TODAY),{},'back, and the server shows the same: the server\'s copy takes over');
  // Back, but the answer still says otherwise: it may have been asked for before the change, so the press stays once.
  // The second answer was asked for after it, so from then on the server's word stands, whatever it says.
  let presses=settleChecks({[habitKey('h:walk')]:press(true,{finished:true})},model,TODAY);
  assert.deepEqual(presses,{[habitKey('h:walk')]:press(true,{finished:true,seen:1})});
  presses=settleChecks(presses,model,TODAY);
  assert.deepEqual(presses,{});
  assert.deepEqual(settleChecks({[habitKey('h:gone')]:press(true),[reminderKey('r:gone')]:press(true,{finished:true})},model,TODAY),{},'nothing kept for a row that is no longer listed');
  assert.deepEqual(settleChecks({[habitKey('h:walk')]:press(true,{day:'2026-11-01'})},model,TODAY),{},'nor for a press of another day');
  // A cancelled reminder leaves the list once the server has it; until then it stays ticked.
  const cancelled={[reminderKey('r:call')]:press(true,{finished:true})};
  assert.equal(settleChecks(cancelled,model,TODAY)[reminderKey('r:call')].seen,1);
  assert.deepEqual(settleChecks(cancelled,tickModel({reminders:[]}),TODAY),{});
  const none={};
  assert.equal(settleChecks(none,model,TODAY),none,'nothing to settle: the same object');
});

// ---- 目标 ----

test('CATEGORY_LABEL has the seven categories, in order',()=>{
  assert.deepEqual(Object.entries(CATEGORY_LABEL),[['health','健康'],['relationships','人际关系'],['finance','财务'],['career','事业'],['interests','兴趣爱好'],['productivity','效率'],['other','其他']]);
  assert.throws(()=>{CATEGORY_LABEL.health='x';},TypeError);
});

test('goalsModel: a goal card has its habits, its week, and the last 7 days of each habit',()=>{
  const goals=[goal('g:1','每天动一动','health',{createdAt:'2026-10-12T03:00:00.000Z'}),goal('g:2','多读点书','interests',{createdAt:'2026-10-20T03:00:00.000Z'})];
  const habits=[habit('h:walk','饭后走 10 分钟',{goalId:'g:1'}),habit('h:read','睡前读 1 页',{goalId:'g:2',createdAt:'2026-11-03T03:00:00.000Z'})];
  const completions=[
    done('h:walk','2026-10-30'),done('h:walk','2026-11-01'),done('h:walk','2026-11-02'),done('h:walk','2026-11-03'),done('h:walk','2026-10-26'),
    done('h:read','2026-11-04',{source:'agent'}),
  ];
  const {cards,ungrouped}=goalsModel({goals,habits,completions,today:'2026-11-05',tz:SH});
  assert.equal(ungrouped,null);
  assert.deepEqual(cards.map(c=>[c.goalId,c.title,c.category,c.categoryLabel,c.startedDay]),[['g:1','每天动一动','health','健康','2026-10-12'],['g:2','多读点书','interests','兴趣爱好','2026-10-20']]);
  const [walk,read]=cards;
  assert.equal(walk.weekCount,2,'Monday 2nd and Tuesday 3rd; the 26th and the 1st are other weeks');
  assert.deepEqual(walk.habits.map(h=>[h.habitId,h.name]),[['h:walk','饭后走 10 分钟']]);
  assert.deepEqual(walk.habits[0].last7,[
    {day:'2026-10-30',kind:'done'},{day:'2026-10-31',kind:'missed'},{day:'2026-11-01',kind:'done'},{day:'2026-11-02',kind:'done'},
    {day:'2026-11-03',kind:'done'},{day:'2026-11-04',kind:'missed'},{day:'2026-11-05',kind:'today'},
  ]);
  assert.equal(walk.habits[0].last7.length,7);assert.equal(walk.habits[0].last7.at(-1).day,'2026-11-05','the last dot is today');
  // the reading habit began on the 3rd: the days before it are not misses
  assert.deepEqual(read.habits[0].last7.map(d=>d.kind),['before','before','before','before','missed','done','today']);
  assert.equal(read.weekCount,1);
});

test('goalsModel: today is a dot of its own until it is done',()=>{
  const goals=[goal('g:1','动','health')];
  const habits=[habit('h:walk','走路',{goalId:'g:1'})];
  const dots=completions=>goalsModel({goals,habits,completions,today:TODAY,tz:SH}).cards[0].habits[0].last7.map(d=>d.kind).join(' ');
  assert.equal(dots([]),'missed missed missed missed missed missed today');
  assert.equal(dots([done('h:walk',TODAY)]),'missed missed missed missed missed missed done');
});

test('goalsModel: the latest line is the newest record that has a note, and says who wrote it',()=>{
  const goals=[goal('g:1','动','health')];
  const habits=[habit('h:walk','走路',{goalId:'g:1'}),habit('h:stretch','拉伸',{goalId:'g:1'})];
  const completions=[
    done('h:walk','2026-10-31',{source:'agent',note:'下雨，在客厅来回走了 5 分钟'}),
    done('h:walk','2026-11-01',{note:'饭后绕小区走了一圈，大概 12 分钟'}),
    done('h:stretch','2026-11-02',{note:'  '}),
    done('h:walk','2026-11-02'),
  ];
  const model=goalsModel({goals,habits,completions,today:TODAY,tz:SH});
  assert.deepEqual(model.cards[0].latest,{day:'2026-11-01',source:'web',note:'饭后绕小区走了一圈，大概 12 分钟'},'the newer ticks have no note to show');
  assert.equal(COPY.latest(formatDay(model.cards[0].latest.day),model.cards[0].latest.source,model.cards[0].latest.note),'最近：11 月 1 日，你在网页上记下「饭后绕小区走了一圈，大概 12 分钟」');
  const agent=goalsModel({goals,habits,completions:[completions[0]],today:TODAY,tz:SH}).cards[0].latest;
  assert.deepEqual(agent,{day:'2026-10-31',source:'agent',note:'下雨，在客厅来回走了 5 分钟'});
  const same=goalsModel({goals,habits,completions:[done('h:walk','2026-11-01',{note:'早一点',createdAt:'2026-11-01T01:00:00.000Z'}),done('h:stretch','2026-11-01',{note:'晚一点',createdAt:'2026-11-01T14:00:00.000Z',source:'agent'})],today:TODAY,tz:SH}).cards[0].latest;
  assert.deepEqual(same,{day:'2026-11-01',source:'agent',note:'晚一点'},'on the same day the later one');
  assert.equal(goalsModel({goals,habits,completions:[done('h:walk','2026-11-01')],today:TODAY,tz:SH}).cards[0].latest,null,'no note, no line');
  const oldRecord=goalsModel({goals,habits,completions:[{id:'c1',habitId:'h:walk',date:'2026-10-20',note:'更早',createdAt:'2026-10-20T01:00:00.000Z'}],today:TODAY,tz:SH}).cards[0].latest;
  assert.equal(oldRecord.source,'agent','a record from before the web could write any was Weave\'s');
});

test('goalsModel: habits with no goal, or with a goal that is not there, share one card; the habits of an archived goal are dropped',()=>{
  const goals=[goal('g:1','动','health'),goal('g:2','旧目标','other',{archived:true})];
  const habits=[
    habit('h:walk','走路',{goalId:'g:1'}),
    habit('h:water','喝水',{createdAt:'2026-10-25T03:00:00.000Z'}),
    habit('h:old','旧习惯',{goalId:'g:2'}),
    habit('h:lost','目标不见了',{goalId:'g:404'}),
  ];
  const completions=[done('h:water','2026-11-02',{note:'一大杯'}),done('h:old','2026-11-02',{note:'不该出现'}),done('h:water','2026-11-01')];
  const {cards,ungrouped}=goalsModel({goals,habits,completions,today:TODAY,tz:SH});
  assert.deepEqual(cards.map(c=>c.goalId),['g:1'],'an archived goal has no card');
  assert.equal(ungrouped.title,COPY.ungrouped);assert.equal(ungrouped.goalId,null);
  assert.deepEqual(ungrouped.habits.map(h=>h.habitId),['h:water','h:lost'],'not h:old');
  assert.equal(ungrouped.weekCount,1,'the 2nd, in the week of Monday the 2nd');
  assert.deepEqual(ungrouped.latest,{day:'2026-11-02',source:'web',note:'一大杯'},'the archived goal\'s note does not leak in');
  assert.ok(!JSON.stringify(cards).includes('h:old'));
  // nothing to group: no card
  assert.equal(goalsModel({goals,habits:[habit('h:walk','走路',{goalId:'g:1'})],completions:[],today:TODAY,tz:SH}).ungrouped,null);
});

test('goalsModel: an old account, with habits and no goals, shows its habits in the card for habits with no goal',()=>{
  const model=goalsModel({goals:[],habits:[habit('h:a','走路'),habit('h:b','读书')],completions:[],today:TODAY,tz:SH});
  assert.deepEqual(model.cards,[]);
  assert.deepEqual(model.ungrouped.habits.map(h=>h.habitId),['h:a','h:b']);
  assert.deepEqual(goalsModel({today:TODAY}),{cards:[],ungrouped:null},'and nothing at all is an empty page');
});

test('goalsModel: a goal with no habit yet is a card with no lines; the start day follows the person\'s zone',()=>{
  const goals=[goal('g:1','早点睡','health',{createdAt:'2026-10-12T17:00:00.000Z'})];
  const sh=goalsModel({goals,habits:[],completions:[],today:TODAY,tz:SH}).cards[0];
  assert.deepEqual([sh.habits,sh.weekCount,sh.latest,sh.startedDay],[[],0,null,'2026-10-13']);
  assert.equal(goalsModel({goals,habits:[],completions:[],today:TODAY,tz:LA}).cards[0].startedDay,'2026-10-12');
  assert.equal(goalsModel({goals,habits:[],completions:[],today:TODAY}).cards[0].startedDay,'2026-10-13','Beijing time when nothing else is said');
  assert.equal(goalsModel({goals:[goal('g:2','x','nonsense')],habits:[],completions:[],today:TODAY,tz:SH}).cards[0].categoryLabel,CATEGORY_LABEL.other,'a category nobody knows is 其他');
});

test('goalWordsLimit: a new goal\'s words leave room for the starter, so the message never passes what the chat takes',()=>{
  // The words go to POST /api/chat with COPY.goalStarter in front; the chat refuses more than 4000 characters.
  assert.equal(MESSAGE_MAX_LENGTH,4000);
  for(const [category,label] of Object.entries(CATEGORY_LABEL)){
    const max=goalWordsLimit(category);
    assert.ok(max>0&&max<MESSAGE_MAX_LENGTH,category);
    assert.equal(COPY.goalStarter(label,'字'.repeat(max)).length,MESSAGE_MAX_LENGTH,category+': the fullest box makes a message of exactly the chat\'s limit');
    assert.equal(COPY.goalStarter(label,'字'.repeat(max+1)).length,MESSAGE_MAX_LENGTH+1,category+': one more character would be refused');
  }
  assert.ok(goalWordsLimit('relationships')<goalWordsLimit('health'),'a longer category name leaves less room');
  assert.equal(goalWordsLimit('nonsense'),goalWordsLimit('other'),'a category nobody knows is 其他, as on the cards');
});

// ---- 记录 ----

const octoberWalk=misses=>{
  const walk=habit('h:walk','饭后走 10 分钟',{createdAt:'2026-10-12T03:00:00.000Z'});
  const days=[];for(let d=12;d<=31;d++)if(!misses.includes(d))days.push(done('h:walk','2026-10-'+String(d).padStart(2,'0')));
  return {walk,completions:days};
};

test('monthModel: October 2026 for a habit begun on the 12th, as on the board',()=>{
  const {walk,completions}=octoberWalk([14,20,26,29]);
  const model=monthModel({habit:walk,completions,month:'2026-10',today:'2026-11-02',tz:SH});
  assert.deepEqual(model.stats,{done:16,elapsed:20,longest:5,doubleMisses:0});
  assert.deepEqual(model.cells.slice(0,3).map(c=>[c.label,c.kind]),[['','empty'],['','empty'],['','empty']],'Monday-first: the 1st is a Thursday');
  assert.deepEqual([model.cells[3].label,model.cells[3].day],['1','2026-10-01']);
  assert.equal(model.cells.length,35,'3 padding + 31 days + 1 padding: whole weeks');
  assert.equal(model.cells.length%7,0);
  assert.deepEqual(model.cells.at(-1),{label:'',kind:'empty',day:''});
  const kind=d=>model.cells[3+d-1].kind;
  assert.deepEqual([1,11].map(kind),['before','before'],'before the habit began');
  assert.deepEqual([12,13,15,19,21,25,27,28,30,31].map(kind),Array(10).fill('done'));
  assert.deepEqual([14,20,26,29].map(kind),['missed','missed','missed','missed']);
  assert.equal(model.cells.filter(c=>c.kind==='future').length,0);
});

test('monthModel: two misses in a row are counted once, and a run of three still once',()=>{
  const read=habit('h:read','睡前读 1 页',{createdAt:'2026-10-20T03:00:00.000Z'});
  const walkLike=misses=>{const out=[];for(let d=20;d<=31;d++)if(!misses.includes(d))out.push(done('h:read','2026-10-'+d));return out;};
  const board=monthModel({habit:read,completions:walkLike([22,24,27,28]),month:'2026-10',today:'2026-11-02',tz:SH});
  assert.deepEqual(board.stats,{done:8,elapsed:12,longest:3,doubleMisses:1},'8 / 12 days, 3 in a row, one double miss: the second board');
  const three=monthModel({habit:read,completions:walkLike([22,23,24,29]),month:'2026-10',today:'2026-11-02',tz:SH});
  assert.equal(three.stats.doubleMisses,1);
  const two=monthModel({habit:read,completions:walkLike([22,23,26,27]),month:'2026-10',today:'2026-11-02',tz:SH});
  assert.equal(two.stats.doubleMisses,2,'two separate times');
  const single=monthModel({habit:read,completions:walkLike([22,24,26]),month:'2026-10',today:'2026-11-02',tz:SH});
  assert.equal(single.stats.doubleMisses,0,'a miss, a day, a miss is not two in a row');
});

test('monthModel: the days to come are future, and so is today until it is done; none of them is counted',()=>{
  const {walk,completions}=octoberWalk([14,20]);                      // done: 12, 13, 15 to 19, 21 to 31
  const upTo=date=>completions.filter(c=>c.date<=date);
  const futureLabels=model=>model.cells.filter(c=>c.kind==='future').map(c=>c.label);
  const rest=from=>Array.from({length:32-from},(_,i)=>String(from+i));
  // today is the 20th and not ticked: the day is not over, so it is neither done nor missed
  const open=monthModel({habit:walk,completions:upTo('2026-10-19'),month:'2026-10',today:'2026-10-20',tz:SH});
  assert.deepEqual(open.stats,{done:7,elapsed:8,longest:5,doubleMisses:0},'the 12th to the 19th: eight days, the 14th missed');
  assert.deepEqual(futureLabels(open),rest(20));
  // ticked: it is done, and the days after it are still to come
  const ticked=monthModel({habit:walk,completions:[...upTo('2026-10-19'),done('h:walk','2026-10-20')],month:'2026-10',today:'2026-10-20',tz:SH});
  assert.deepEqual(ticked.stats,{done:8,elapsed:9,longest:6,doubleMisses:0});
  assert.equal(ticked.cells[3+19].kind,'done');assert.deepEqual(futureLabels(ticked),rest(21));
  // yesterday missed and today still open is not two in a row ("今天做一下就不算连着错过") ...
  const toThe18th=octoberWalk([]).completions.filter(c=>c.date<='2026-10-18');
  const yesterday=monthModel({habit:walk,completions:toThe18th,month:'2026-10',today:'2026-10-20',tz:SH});
  assert.deepEqual(yesterday.stats,{done:7,elapsed:8,longest:7,doubleMisses:0});
  // ... and once the day after is open, the 19th and the 20th are two finished days missed
  assert.deepEqual(monthModel({habit:walk,completions:toThe18th,month:'2026-10',today:'2026-10-21',tz:SH}).stats,{done:7,elapsed:9,longest:7,doubleMisses:1});
  // a month that has not begun is all future; a month before the habit is all "not yet begun"
  const later=monthModel({habit:walk,completions:[],month:'2026-11',today:'2026-10-20',tz:SH});
  assert.ok(later.cells.filter(c=>c.label).every(c=>c.kind==='future'));assert.deepEqual(later.stats,{done:0,elapsed:0,longest:0,doubleMisses:0});
  const earlier=monthModel({habit:walk,completions:[],month:'2026-09',today:'2026-10-20',tz:SH});
  assert.ok(earlier.cells.filter(c=>c.label).every(c=>c.kind==='before'));assert.deepEqual(earlier.stats,{done:0,elapsed:0,longest:0,doubleMisses:0});
});

test('monthModel: a record dated before the habit was added still shows as done; other habits\' records do not',()=>{
  const walk=habit('h:walk','走路',{createdAt:'2026-10-12T03:00:00.000Z'});
  const completions=[done('h:walk','2026-10-10'),done('h:other','2026-10-13'),done('h:walk','2026-10-12')];
  const model=monthModel({habit:walk,completions,month:'2026-10',today:'2026-11-02',tz:SH});
  assert.equal(model.cells[3+9].kind,'done','the 10th, logged afterwards');
  assert.equal(model.cells[3+10].kind,'before','the 11th');
  assert.equal(model.cells[3+12].kind,'missed','the 13th: the other habit was done, this one was not');
  assert.deepEqual(model.stats,{done:2,elapsed:21,longest:1,doubleMisses:1},'elapsed is the done days and the missed days');
});

test('monthModel: the habit\'s first day is its day in the person\'s zone',()=>{
  const walk=habit('h:walk','走路',{createdAt:'2026-10-12T17:00:00.000Z'});   // the 13th in Shanghai, the 12th in Los Angeles
  const first=tz=>monthModel({habit:walk,completions:[],month:'2026-10',today:'2026-11-02',tz}).cells.find(c=>c.kind!=='empty'&&c.kind!=='before').label;
  assert.equal(first(SH),'13');assert.equal(first(LA),'12');
  assert.equal(first(undefined),'13','Beijing time when no zone is given');
});

test('monthModel: months of different shapes are padded to whole weeks',()=>{
  const walk=habit('h:walk','走路',{createdAt:'2026-01-01T03:00:00.000Z'});
  const shape=month=>{const cells=monthModel({habit:walk,completions:[],month,today:'2027-01-01',tz:SH}).cells;return [cells.findIndex(c=>c.label==='1'),cells.filter(c=>c.label).length,cells.length];};
  assert.deepEqual(shape('2026-06'),[0,30,35],'June 2026 begins on a Monday');
  assert.deepEqual(shape('2026-11'),[6,30,42],'November 2026 begins on a Sunday');
  assert.deepEqual(shape('2026-02'),[6,28,35]);
  assert.deepEqual(shape('2028-02'),[1,29,35],'leap year');
  assert.deepEqual(monthModel({habit:walk,completions:[],month:'nonsense',today:TODAY,tz:SH}),{cells:[],stats:{done:0,elapsed:0,longest:0,doubleMisses:0}});
  assert.deepEqual(monthModel({habit:walk,completions:[],month:'2026-13',today:TODAY,tz:SH}).cells,[]);
});

// /api/status carries the records of today and of the 61 days before it. With today = 2026-12-20 that is 2026-10-20 to 2026-12-20.
// A day before it may have records the page was not sent, so it cannot be called a miss.
const WINDOW_TODAY='2026-12-20';
const windowDays=(from,to)=>{const days=[];for(let day=from;day<=to;day=addDays(day,1))days.push(day);return days;};
const kindsOf=model=>model.cells.filter(c=>c.label).map(c=>c.kind);
const repeat=(kind,n)=>Array(n).fill(kind);

test('monthModel: days before the status window are unknown, not missed, and are not counted',()=>{
  const walk=habit('h:walk','走路',{createdAt:'2026-08-01T03:00:00.000Z'});
  const everyDay=windowDays('2026-10-20',WINDOW_TODAY).map(day=>done('h:walk',day));
  assert.equal(everyDay.length,62,'today and the 61 days before it');
  const month=(name,completions=everyDay)=>monthModel({habit:walk,completions,month:name,today:WINDOW_TODAY,tz:SH});

  const october=month('2026-10');
  assert.deepEqual(kindsOf(october),[...repeat('unknown',19),...repeat('done',12)],'1 to 19 October are before the window; the 20th is its first day');
  assert.deepEqual(october.stats,{done:12,elapsed:12,longest:12,doubleMisses:0},'only the days the page knows about (it used to say 12 / 31 days and one double miss)');
  assert.deepEqual(october.cells[3],{label:'1',kind:'unknown',day:'2026-10-01'});
  assert.deepEqual(october.cells[3+19],{label:'20',kind:'done',day:'2026-10-20'});

  const september=month('2026-09');
  assert.deepEqual(kindsOf(september),repeat('unknown',30),'a whole month before the window, the habit already begun');
  assert.deepEqual(september.stats,{done:0,elapsed:0,longest:0,doubleMisses:0});

  const november=month('2026-11');
  assert.deepEqual(kindsOf(november),repeat('done',30));
  assert.deepEqual(november.stats,{done:30,elapsed:30,longest:30,doubleMisses:0});

  const december=month('2026-12');
  assert.deepEqual(kindsOf(december),[...repeat('done',20),...repeat('future',11)]);
  assert.deepEqual(december.stats,{done:20,elapsed:20,longest:20,doubleMisses:0});

  // a record is a record, wherever it is: one from before the window still shows, and does not join the run after it
  const early=month('2026-10',[done('h:walk','2026-10-05'),...everyDay]);
  assert.equal(early.cells[3+4].kind,'done');
  assert.deepEqual(early.stats,{done:13,elapsed:13,longest:12,doubleMisses:0});
});

test('monthModel: the first day of the window is known; the unknown days before it make no run and no double miss',()=>{
  const walk=habit('h:walk','走路',{createdAt:'2026-08-01T03:00:00.000Z'});
  const without=(...skipped)=>windowDays('2026-10-20',WINDOW_TODAY).filter(day=>!skipped.includes(day)).map(day=>done('h:walk',day));
  const stats=completions=>monthModel({habit:walk,completions,month:'2026-10',today:WINDOW_TODAY,tz:SH}).stats;
  assert.deepEqual(stats(without('2026-10-20')),{done:11,elapsed:12,longest:11,doubleMisses:0},'a miss on the first day of the window, next to 19 unknown days, is one miss');
  assert.deepEqual(stats(without('2026-10-20','2026-10-21')),{done:10,elapsed:12,longest:10,doubleMisses:1},'two misses in the window are two in a row');
  assert.deepEqual(stats(without('2026-10-25','2026-10-26')),{done:10,elapsed:12,longest:5,doubleMisses:1});
  // the window starts on the 1st: nothing of that month is unknown
  const everyDay=windowDays('2026-10-01','2026-12-01').map(day=>done('h:walk',day));
  const edge=month=>monthModel({habit:walk,completions:everyDay,month,today:'2026-12-01',tz:SH});
  assert.deepEqual(kindsOf(edge('2026-10')),repeat('done',31));
  assert.deepEqual(kindsOf(edge('2026-09')),repeat('unknown',30));
  assert.deepEqual(monthModel({habit:walk,completions:[],month:'2026-10',today:'',tz:SH}).stats,{done:0,elapsed:0,longest:0,doubleMisses:0},'without today there is no window to measure from');
});

test('monthModel: a habit created inside the window is not changed by it',()=>{
  const month=(habit,completions,name)=>monthModel({habit,completions,month:name,today:WINDOW_TODAY,tz:SH});
  const fresh=habit('h:new','新习惯',{createdAt:'2026-11-10T03:00:00.000Z'});
  const november=month(fresh,windowDays('2026-11-10',WINDOW_TODAY).filter(day=>day!=='2026-11-15').map(day=>done('h:new',day)),'2026-11');
  assert.deepEqual(kindsOf(november),[...repeat('before',9),...repeat('done',5),'missed',...repeat('done',15)]);
  assert.deepEqual(november.stats,{done:20,elapsed:21,longest:15,doubleMisses:0});
  // created in the month the window starts in: before the habit is "before" (not begun), never "unknown"
  const october=habit('h:oct','十月新习惯',{createdAt:'2026-10-25T03:00:00.000Z'});
  const inOctober=month(october,windowDays('2026-10-25',WINDOW_TODAY).filter(day=>day!=='2026-10-28').map(day=>done('h:oct',day)),'2026-10');
  assert.deepEqual(kindsOf(inOctober),[...repeat('before',24),'done','done','done','missed','done','done','done']);
  assert.deepEqual(inOctober.stats,{done:6,elapsed:7,longest:3,doubleMisses:0});
  // created on the first day of the window
  const first=habit('h:first','窗口第一天',{createdAt:'2026-10-20T03:00:00.000Z'});
  const onTheDay=month(first,windowDays('2026-10-20',WINDOW_TODAY).map(day=>done('h:first',day)),'2026-10');
  assert.deepEqual(kindsOf(onTheDay),[...repeat('before',19),...repeat('done',12)]);
  assert.ok(!kindsOf(onTheDay).includes('unknown'));
});

test('recentNotes: the newest records of one habit, with who made them',()=>{
  const completions=[
    done('h:walk','2026-10-30',{source:'agent',note:'和朋友一起走到公园，聊了一路。'}),
    done('h:walk','2026-11-01',{note:'饭后绕小区走了一圈，大概 12 分钟。'}),
    done('h:read','2026-11-02',{note:'读书的，不是走路的'}),
    done('h:walk','2026-10-31',{source:'agent',note:'下雨，在客厅来回走了 5 分钟。'}),
    done('h:walk','2026-10-29'),
    {id:'c:old',habitId:'h:walk',date:'2026-10-28',note:'没有来源的老记录',createdAt:'2026-10-28T01:00:00.000Z'},
  ];
  const notes=recentNotes({completions,habitId:'h:walk'});
  assert.deepEqual(notes,[
    {day:'2026-11-01',source:'web',note:'饭后绕小区走了一圈，大概 12 分钟。'},
    {day:'2026-10-31',source:'agent',note:'下雨，在客厅来回走了 5 分钟。'},
    {day:'2026-10-30',source:'agent',note:'和朋友一起走到公园，聊了一路。'},
  ],'three by default, newest first');
  assert.deepEqual(recentNotes({completions,habitId:'h:walk',limit:5}).map(n=>n.day),['2026-11-01','2026-10-31','2026-10-30','2026-10-29','2026-10-28']);
  assert.deepEqual(recentNotes({completions,habitId:'h:walk',limit:5}).slice(3).map(n=>[n.source,n.note]),[['web',''],['agent','没有来源的老记录']],'a tick with no note is a record too; one with no source was Weave\'s');
  assert.deepEqual(recentNotes({completions,habitId:'h:walk',limit:1}).map(n=>n.day),['2026-11-01']);
  assert.deepEqual(recentNotes({completions,habitId:'h:none'}),[]);
  assert.equal(completions[0].date,'2026-10-30','the list it was given is left as it was');
});

test('monthBounds: from the month the status window starts in to the month of today, whatever has been recorded',()=>{
  // the window is today and the 61 days before it, so it reaches back to 2 September when today is 2 November
  assert.deepEqual(monthBounds({completions:[],today:'2026-11-02'}),{earliest:'2026-09',latest:'2026-11'});
  const completions=[done('h:a','2026-10-12'),done('h:a','2026-09-05'),done('h:b','2026-11-01')];
  assert.deepEqual(monthBounds({completions,today:'2026-11-02'}),{earliest:'2026-09',latest:'2026-11'});
  assert.deepEqual(monthBounds({completions:[done('h:a','2026-11-01')],today:'2026-11-02'}),{earliest:'2026-09',latest:'2026-11'},'a new habit does not shorten it');
  assert.deepEqual(monthBounds({completions:[done('h:a','2026-12-05')],today:'2026-11-02'}),{earliest:'2026-09',latest:'2026-11'},'a date from the future cannot be turned to');
  assert.deepEqual(monthBounds({completions:[],today:WINDOW_TODAY}),{earliest:'2026-10',latest:'2026-12'},'the window starts on 20 October: the month the unknown days are in');
  assert.deepEqual(monthBounds({completions:[],today:'2026-12-01'}),{earliest:'2026-10',latest:'2026-12'},'the window starts on 1 October');
  assert.deepEqual(monthBounds({completions:[],today:'2026-12-31'}),{earliest:'2026-10',latest:'2026-12'},'the window starts on 31 October');
  assert.deepEqual(monthBounds({completions:[],today:'2026-01-01'}),{earliest:'2025-11',latest:'2026-01'},'over New Year');
  assert.deepEqual(monthBounds({completions:[],today:'2026-03-01'}),{earliest:'2025-12',latest:'2026-03'},'over New Year, the other way');
  for(const today of ['','2026-1-2','soon',undefined])assert.deepEqual(monthBounds({completions:[],today}),{earliest:'',latest:''},String(today));
  assert.deepEqual(monthBounds({}),{earliest:'',latest:''});
});

test('newestHabitsFirst: the habit added last comes first; the list it was given stays as it was',()=>{
  const habits=[habit('h:a','a',{createdAt:'2026-10-12T03:00:00.000Z'}),habit('h:b','b',{createdAt:'2026-10-20T03:00:00.000Z'}),habit('h:c','c',{createdAt:'2026-10-20T03:00:00.000Z'}),habit('h:d','d',{createdAt:undefined})];
  assert.deepEqual(newestHabitsFirst(habits).map(h=>h.id),['h:b','h:c','h:a','h:d'],'newest first; added at the same moment, in the order given; with no date, last');
  assert.deepEqual(habits.map(h=>h.id),['h:a','h:b','h:c','h:d']);
  assert.deepEqual(newestHabitsFirst([]),[]);assert.deepEqual(newestHabitsFirst(undefined),[]);
});

// ---- 设置 ----

test('zoneOptions: the six zones in order, and the account\'s own zone once at the end when it is none of them',()=>{
  const six=COPY.zones.map(zone=>zone.value);
  assert.deepEqual(zoneOptions('Asia/Shanghai').map(o=>o.value),six);
  assert.deepEqual(zoneOptions('America/Los_Angeles').map(o=>o.value),six,'a zone on the list is not added again');
  assert.deepEqual(zoneOptions('Asia/Shanghai').map(o=>o.label),['北京时间','洛杉矶时间','纽约时间','伦敦时间','东京时间','新加坡时间']);
  const berlin=zoneOptions('Europe/Berlin');
  assert.deepEqual(berlin.map(o=>o.value),[...six,'Europe/Berlin']);
  assert.equal(berlin.filter(o=>o.value==='Europe/Berlin').length,1,'once');
  assert.deepEqual(berlin.at(-1),{value:'Europe/Berlin',label:'Europe/Berlin'},'a zone with no name on the boards is shown as it is stored');
  for(const bad of ['','Mars/Olympus',undefined,null,42])assert.deepEqual(zoneOptions(bad).map(o=>o.value),six,'nothing to add for '+String(bad));
  assert.ok(Object.isFrozen(COPY.zones),'COPY.zones is left as it was');
});

test('profileForSave: the whole profile with the zone that was picked, and only the free times still to come',()=>{
  const now=Date.parse('2026-11-02T12:00:00Z');
  const profile={name:'养成宝',goal:'早点睡',preferences:'晚上别找我',timezone:'America/Los_Angeles',activities:['散步'],revision:7,
    slots:['2026-11-01T12:00:00.000Z','2026-11-02T12:00:00.000Z','2026-11-03T09:30:00.000Z','2026-11-04T01:00:00+08:00']};
  const saved=profileForSave(profile,{timezone:'Asia/Shanghai',now});
  assert.deepEqual(saved,{name:'养成宝',goal:'早点睡',preferences:'晚上别找我',timezone:'Asia/Shanghai',activities:['散步'],revision:7,
    slots:['2026-11-03T09:30:00.000Z','2026-11-03T17:00:00.000Z']},'past and present times are dropped; the rest are ISO, as the server keeps them');
  assert.equal(profile.timezone,'America/Los_Angeles','the profile it was given is left as it was');
  assert.equal(profile.slots.length,4);
  assert.deepEqual(profileForSave({...profile,slots:undefined},{timezone:'Asia/Tokyo',now}).slots,[],'no times at all is an empty list');
});

test('bindCodeTimeout: the binding code stays until it expires, never longer than a code lives',()=>{
  const now=Date.parse('2026-11-02T12:00:00Z');
  assert.equal(BIND_CODE_LIFETIME,15*60*1000);
  assert.equal(bindCodeTimeout(now+15*60*1000,now),15*60*1000,'a code just issued: 15 minutes');
  assert.equal(bindCodeTimeout(now+5*60*1000,now),5*60*1000);
  assert.equal(bindCodeTimeout(now+60*60*1000,now),BIND_CODE_LIFETIME,'a clock behind the server\'s does not keep it longer');
  for(const odd of [now,now-1000,undefined,null,'soon',NaN])assert.equal(bindCodeTimeout(odd,now),BIND_CODE_LIFETIME,'a clock ahead of the server\'s, or no expiry, still shows it for its life: '+String(odd));
});

// ---- 聊天 ----

const message=(id,role,createdAt,extra={})=>({id,role,text:id,createdAt,...extra});

test('withSeparators: a day label goes before the first message of each day',()=>{
  const messages=[
    message('m1','user','2026-10-30T02:00:00.000Z'),message('m2','assistant','2026-10-30T02:00:05.000Z'),
    message('m3','user','2026-11-01T14:00:00.000Z'),message('m4','assistant','2026-11-01T14:00:08.000Z'),
    message('m5','user','2026-11-02T01:00:00.000Z'),message('m6','assistant','2026-11-02T01:00:07.000Z'),
  ];
  const label=list=>list.map(item=>item.kind==='separator'?'—'+item.label:item.message.id);
  assert.deepEqual(label(withSeparators(messages,SH,TODAY)),['—10 月 30 日','m1','m2','—昨天','m3','m4','—今天','m5','m6']);
  // in Los Angeles the 1st at 17:00 is still yesterday
  assert.deepEqual(label(withSeparators(messages,LA,TODAY)),['—10 月 29 日','m1','m2','—昨天','m3','m4','m5','m6']);
  const first=withSeparators(messages,SH,TODAY)[0];
  assert.deepEqual(first,{kind:'separator',label:'10 月 30 日'});
  assert.deepEqual(withSeparators(messages,SH,TODAY)[1],{kind:'message',message:messages[0]},'the message itself, untouched');
});

test('withSeparators: the first message of today is 今天 and of yesterday is 昨天, as the chat board has them',()=>{
  const list=withSeparators([message('a','user','2026-11-01T02:00:00.000Z'),message('b','assistant','2026-11-02T02:00:00.000Z')],SH,TODAY);
  assert.deepEqual(list.filter(item=>item.kind==='separator').map(item=>item.label),[COPY.yesterday,COPY.today]);
  assert.deepEqual(withSeparators([],SH,TODAY),[]);assert.deepEqual(withSeparators(undefined,SH,TODAY),[]);
});

test('withSeparators: a message that is not saved yet belongs to today',()=>{
  const messages=[message('m3','user','2026-11-01T14:00:00.000Z'),message('m4','assistant','2026-11-01T14:00:08.000Z'),
    {id:'pending-1:user',role:'user',text:'你好',local:true},{id:'pending-1:thinking',role:'assistant',text:'',local:true,thinking:true}];
  const list=withSeparators(messages,SH,TODAY);
  assert.deepEqual(list.map(item=>item.kind==='separator'?'—'+item.label:item.message.id),['—昨天','m3','m4','—今天','pending-1:user','pending-1:thinking']);
  const afterToday=withSeparators([message('m5','user','2026-11-02T01:00:00.000Z'),{id:'pending-2:user',role:'user',text:'嗯',local:true}],SH,TODAY);
  assert.equal(afterToday.filter(item=>item.kind==='separator').length,1,'no second 今天');
});

test('withSeparators: a message whose time cannot be read stays with the day before it, or with today if it is the first',()=>{
  const label=list=>list.map(item=>item.kind==='separator'?'—'+item.label:item.message.id);
  const odd=message('odd','assistant','garbage');
  assert.deepEqual(label(withSeparators([message('m3','user','2026-11-01T14:00:00.000Z'),odd,message('m5','user','2026-11-02T01:00:00.000Z')],SH,TODAY)),['—昨天','m3','odd','—今天','m5']);
  assert.deepEqual(label(withSeparators([odd],SH,TODAY)),['—今天','odd']);
});

test('isProactive: only a message that says so, with the flag or from the background judge',()=>{
  assert.equal(isProactive({proactive:true}),true);
  assert.equal(isProactive({source:'hermes'}),true);
  for(const not of [{},{role:'assistant'},{proactive:false},{proactive:'true'},{proactive:1},{source:'web'},{source:'Hermes'},null,undefined])assert.equal(isProactive(not),false,JSON.stringify(not));
});

test('proactiveLabel: the time it was sent, in the person\'s zone, and the words from the board',()=>{
  assert.equal(proactiveLabel({createdAt:'2026-11-02T11:30:00.000Z',proactive:true},SH),'19:30 · Weave 主动来问');
  assert.equal(proactiveLabel({createdAt:'2026-11-02T11:30:00.000Z',proactive:true},LA),'03:30 · Weave 主动来问');
});

// ---- the zone ----

test('with no zone given, the date and time helpers use Beijing time and never the machine\'s zone',()=>{
  // 2026-11-03T07:30Z is 15:30 on the 3rd in Shanghai, 23:30 on the 2nd in Los Angeles
  const instant='2026-11-03T07:30:00Z';
  assert.equal(localDay(instant),'2026-11-03');
  assert.equal(formatTime(instant),'15:30');
  assert.equal(formatDue('2026-11-04T12:00:00Z',undefined,'2026-11-03'),'明天 20:00');
  assert.equal(proactiveLabel({createdAt:instant}),'15:30 · Weave 主动来问');
  const sent={id:'m',role:'user',text:'m',createdAt:'2026-11-02T16:30:00.000Z'};   // 00:30 on the 3rd in Shanghai
  assert.deepEqual(withSeparators([sent],undefined,'2026-11-03'),[{kind:'separator',label:'今天'},{kind:'message',message:sent}]);

  // The same calls in a process whose own zone is Los Angeles, where a helper that fell back to the machine would answer
  // 2026-11-02, 23:30, 明天 04:00, 昨天, and so on. This is what makes the test hold on any machine, not only on one in Shanghai.
  const href=name=>JSON.stringify(new URL('../hosted/app/workspace/'+name,import.meta.url).href);
  const script=`
    import {localDay,formatTime,formatDue} from ${href('dates.mjs')};
    import {withSeparators,proactiveLabel} from ${href('chat-view.mjs')};
    const list=withSeparators([{id:'m',role:'user',text:'m',createdAt:'2026-11-02T16:30:00.000Z'}],undefined,'2026-11-03');
    console.log(JSON.stringify({
      machine:Intl.DateTimeFormat().resolvedOptions().timeZone,
      localDay:localDay('2026-11-03T07:30:00Z'),
      formatTime:formatTime('2026-11-03T07:30:00Z'),
      formatDue:formatDue('2026-11-04T12:00:00Z',undefined,'2026-11-03'),
      proactiveLabel:proactiveLabel({createdAt:'2026-11-03T07:30:00.000Z'}),
      separators:list.map(item=>item.kind==='separator'?item.label:item.message.id),
    }));`;
  const out=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:'America/Los_Angeles'},encoding:'utf8'}));
  assert.equal(out.machine,'America/Los_Angeles','the child process really is in another zone');
  assert.deepEqual(out,{machine:'America/Los_Angeles',localDay:'2026-11-03',formatTime:'15:30',formatDue:'明天 20:00',proactiveLabel:'15:30 · Weave 主动来问',separators:['今天','m']});
});

// ---- 重试 ----

test('retryOnConflict: one refresh and one more try after a 409, and nothing of the sort for any other error',async()=>{
  const log=[];
  let calls=0;
  const flaky=async()=>{log.push('fn');if(++calls===1)throw new ApiError('conflict',409);return 'ok';};
  assert.equal(await retryOnConflict(flaky,async()=>{log.push('refresh');}),'ok');
  assert.deepEqual(log,['fn','refresh','fn'],'it refreshes first, then tries again');

  log.length=0;
  assert.equal(await retryOnConflict(async()=>{log.push('fn');return 7;},async()=>{log.push('refresh');}),7);
  assert.deepEqual(log,['fn'],'no refresh when it works');

  log.length=0;
  await assert.rejects(retryOnConflict(async()=>{log.push('fn');throw new ApiError('again',409);},async()=>{log.push('refresh');}),{status:409,message:'again'});
  assert.deepEqual(log,['fn','refresh','fn'],'a second 409 is shown, not retried again');

  for(const error of [new ApiError('bad',400),new ApiError('gone',404),new ApiError('请求失败'),new TypeError('boom'),Object.assign(new Error('x'),{status:409})]){
    log.length=0;
    await assert.rejects(retryOnConflict(async()=>{log.push('fn');throw error;},async()=>{log.push('refresh');}),e=>e===error);
    assert.deepEqual(log,['fn'],'tried once: '+error.name+' '+error.status);
  }
});

test('retryOnConflict: if the refresh fails, that error is the one that comes out and the action is not tried again',async()=>{
  let calls=0;
  const failure=new ApiError('offline');
  await assert.rejects(retryOnConflict(async()=>{calls++;throw new ApiError('conflict',409);},async()=>{throw failure;}),e=>e===failure);
  assert.equal(calls,1);
});
