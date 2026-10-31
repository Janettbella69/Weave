// Isolated local transport test. No real WeChat or Notion requests.
import http from 'node:http';import {mkdtemp,cp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const close=server=>new Promise(r=>server.close(r));
async function freePort(){const s=http.createServer();const p=await listen(s);await close(s);return p;}
const dir=await mkdtemp(join(tmpdir(),'habit-gewechat-')),sent=[];let child;
const mock=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;sent.push({path:req.url,token:req.headers['x-gewe-token'],body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ret:200,data:{}}));});
try{
 const mockPort=await listen(mock),uiPort=await freePort(),hookPort=await freePort();
 for(const f of ['server.mjs','agent.mjs','chat.mjs','council.mjs','workspace.mjs','negotiation.mjs','reminders.mjs','weave-chat.mjs','calendar.mjs','public','integrations'])await cp(new URL('../'+f,import.meta.url),join(dir,f),{recursive:true});
 const secret='test-callback-secret-1234567890';
 child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,PORT:String(uiPort),ANTHROPIC_API_KEY:'',NOTION_TOKEN:'',GEWECHAT_BASE_URL:`http://127.0.0.1:${mockPort}/v2/api`,GEWECHAT_TOKEN:'test-token',GEWECHAT_APP_ID:'test-app',GEWECHAT_OWNER_WXID:'owner',GEWECHAT_FRIEND_WXID:'friend',GEWECHAT_CALLBACK_SECRET:secret,GEWECHAT_WEBHOOK_HOST:'127.0.0.1',GEWECHAT_WEBHOOK_PORT:String(hookPort)},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);
 const status=async()=>{const r=await fetch(`http://127.0.0.1:${uiPort}/api/status`);return r.json();};
 let ready=false;for(let i=0;i<100;i++){try{await status();ready=true;break;}catch{await delay(30);}}assert.ok(ready,'server should start: '+stderr);
 const payload=(id,text,from='owner')=>({TypeName:'AddMsg',Appid:'test-app',Wxid:'bot',Data:{MsgId:id,NewMsgId:String(id),MsgType:1,FromUserName:{string:from},ToUserName:{string:'bot'},Content:{string:text}}});
 const post=async(event,key=secret)=>{const r=await fetch(`http://127.0.0.1:${hookPort}/webhooks/gewechat/${key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});return {status:r.status,data:await r.json()};};
 const waitSent=async n=>{for(let i=0;i<100;i++){if(sent.length>=n&&(await status()).wechat.queued===0)return;await delay(30);}throw Error('reply timeout');};
 assert.equal((await post(payload(1,'你好'),'wrong')).status,403);
 assert.ok((await post(payload(2,'你好','stranger'))).data.ignored);
 assert.equal((await post(payload(3,'今天很累，晚上聚餐'))).status,200);await waitSent(1);assert.match(sent[0].body.content,/几个小时/);
 assert.ok((await post(payload(3,'今天很累，晚上聚餐'))).data.duplicate);
 await post(payload(4,'5 小时'));await waitSent(2);assert.match(sent[1].body.content,/散步/);assert.equal(sent[1].path,'/v2/api/message/postText');assert.equal(sent[1].token,'test-token');assert.equal(sent[1].body.toWxid,'owner');
 await post(payload(5,'确认计划'));await waitSent(3);assert.ok((await status()).plans.at(-1).approved);
 await post(payload(6,'同步 Notion'));await waitSent(4);assert.match(sent[3].body.content,/尚未配置 Notion/);
 await post(payload(7,'反馈：午饭后活动更容易坚持'));await waitSent(5);assert.equal((await status()).checkins.length,1);
 await post(payload(8,'约阿梦散步'));await waitSent(7);
 const invite=(await status()).negotiations[0];assert.equal(invite.status,'awaiting_consent');assert.ok(sent.some(x=>x.body.toWxid==='friend'&&x.body.content.includes('邀请')));
 await post(payload(9,'授权协商 '+invite.id.slice(0,8),'friend'));await waitSent(9);assert.equal((await status()).negotiations[0].status,'awaiting_confirmation');
 await post(payload(10,'确认协商 '+invite.id.slice(0,8)));await waitSent(11);
 assert.ok(sent.some(x=>x.body.toWxid==='friend'&&x.body.content.includes('Lulu 已确认本次方案，等待你的确认')));
 await post(payload(11,'确认协商 '+invite.id.slice(0,8),'friend'));await waitSent(13);assert.equal((await status()).negotiations[0].status,'confirmed');assert.equal((await status()).calendar.length,1);
 const friend=await(await fetch(`http://127.0.0.1:${uiPort}/api/status?person=meng`)).json();assert.equal(friend.calendar.length,1);assert.equal(friend.checkins.length,0);
 const isolated=await fetch(`http://127.0.0.1:${hookPort}/api/status`);assert.equal(isolated.status,403);
 console.log('PASS: authenticated webhook → shared Agent → Gewechat HTTP reply; duplicate/stranger rejection; confirm; Notion configuration guard; feedback persistence; isolated ingress; two WeChat identities negotiate, mutually confirm and receive separate calendar entries.');
}finally{if(child){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}await close(mock);await rm(dir,{recursive:true,force:true});}
