// Integration QA in a throwaway directory. Never modifies personal conversations.
import http from 'node:http';import {mkdtemp,cp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'weave-e2e-'));let child;
const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
try{
 for(const f of ['server.mjs','agent.mjs','chat.mjs','council.mjs','workspace.mjs','negotiation.mjs','reminders.mjs','weave-chat.mjs','calendar.mjs','public','integrations'])await cp(new URL('../'+f,import.meta.url),join(dir,f),{recursive:true});
 await mkdir(join(dir,'.data'));await writeFile(join(dir,'.data/state.json'),JSON.stringify({plans:[],checkins:[{text:'OWNER_PRIVATE_MEMORY'}],messages:[],pending:''}));
 child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,PORT:String(port),ANTHROPIC_API_KEY:'',NOTION_TOKEN:'',NOTION_FRIEND_TOKEN:'',GEWECHAT_BASE_URL:''},stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',c=>stderr+=c);
 async function api(path,person='lulu',data){const r=await fetch(`http://127.0.0.1:${port}/api/${path}?person=${person}`,data?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{});return {status:r.status,data:await r.json()};}
 let ready=false;for(let i=0;i<150;i++){try{if((await api('status')).status===200){ready=true;break;}}catch{}await delay(20);}assert.ok(ready,stderr);
 assert.equal((await api('status')).data.checkins[0].text,'OWNER_PRIVATE_MEMORY');assert.equal((await api('status','meng')).data.checkins.length,0);assert.ok(await readFile(join(dir,'.data/state-v1-backup.json'),'utf8'));
 const bad=await api('negotiations/start','lulu',{peer:'meng',activity:'散步',consent:false});assert.equal(bad.status,400);
 const created=await api('negotiations/start','lulu',{peer:'meng',activity:'散步',consent:true});assert.equal(created.status,200);const id=created.data.id;
 assert.equal((await api('status','meng')).data.negotiations[0].status,'awaiting_consent');
 const agreed=await api('negotiations/action','meng',{id,action:'authorize'});assert.equal(agreed.data.status,'awaiting_confirmation');assert.ok(agreed.data.events.filter(e=>e.type==='counterproposal').length>=1);
 assert.equal((await api('negotiations/action','lulu',{id,action:'confirm',revision:0})).status,400);
 await api('negotiations/action','lulu',{id,action:'confirm',revision:1});assert.equal((await api('status')).data.calendar.length,0);
 await api('negotiations/action','meng',{id,action:'confirm',revision:1});assert.equal((await api('status')).data.calendar.length,1);assert.equal((await api('status','meng')).data.calendar.length,1);
 const ics=await(await fetch(`http://127.0.0.1:${port}/api/calendar.ics?person=lulu`)).text();assert.match(ics,/BEGIN:VEVENT/);
 assert.equal((await api('negotiations/action','meng',{id,action:'sync'})).status,400);
 const noMatch=await api('negotiations/start','lulu',{peer:'meng',activity:'散步',consent:true});
 const noMatchReply=await api('chat','meng',{text:'授权协商 '+noMatch.data.id.slice(0,8)});
 assert.equal(noMatchReply.status,200);assert.match(noMatchReply.data.messages.at(-1).text,/没有找到双方都接受/);
 assert.equal((await api('status')).data.negotiations.at(-1).status,'no_match');
 assert.equal((await api('status')).data.calendar.length,1);
 await api('chat','meng',{text:'反馈：FRIEND_PRIVATE_MEMORY'});assert.ok(!JSON.stringify((await api('status')).data).includes('FRIEND_PRIVATE_MEMORY'));
 await api('chat','lulu',{text:'昨晚睡了 5 小时，有点累'});const plan=(await api('status')).data.plans.at(-1);assert.ok(plan);assert.equal((await api('approve','meng',{id:plan.id})).status,400);
 const invalidDate=(new Date().getFullYear()+1)+'-02-30T20:00';
 assert.equal((await api('reminders','meng',{text:'不存在的日期',dueAt:invalidDate})).status,400);
 assert.equal((await api('chat','meng',{text:'提醒：'+invalidDate.replace('T',' ')+' 不存在的日期'})).status,400);
 assert.equal((await api('status','meng')).data.reminders.length,0);
 const due=await api('reminders','meng',{text:'测试提醒',dueAt:new Date(Date.now()+1000).toISOString()});assert.equal(due.status,200);
 let delivered=false;for(let i=0;i<150;i++){if((await api('status','meng')).data.reminders[0].status==='delivered'){delivered=true;break;}await delay(20);}assert.ok(delivered);assert.ok((await api('status','meng')).data.messages.some(m=>m.reminderId));assert.ok(!(await api('status')).data.messages.some(m=>m.reminderId));
 const html=await(await fetch(`http://127.0.0.1:${port}/`)).text();assert.match(html,/Weave/);assert.match(html,/id="connections-view"/);assert.match(html,/id="composer"/);
 console.log('PASS: legacy migration+backup, persona isolation, A2A consent/counterproposal/mutual commit, stale revision rejection, calendar export, Notion configuration guard, habit plan ownership, scheduled reminders and Weave UI serving.');
}finally{if(child){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}await rm(dir,{recursive:true,force:true});}
