import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {D1} from './helpers/product-db.mjs';
import {Store} from '../hosted/lib/weave/store.mjs';
import {handleAPI} from '../hosted/lib/weave/api.mjs';
import {hash} from '../hosted/lib/weave/crypto.mjs';
import {SAFETY_RULES} from '../hosted/lib/weave/model.mjs';

const secret='ab'.repeat(32),managed='sk-managed-provider-123456',bridgeToken='bridge-token-'+'x'.repeat(32);
const ROOM='123456@chatroom',start=Date.parse('2030-01-01T00:00:00Z');
function harness(options={}){
  const db=new D1(),systems=[];let calls=0;
  const fetcher=async(_url,request)=>{calls++;const body=JSON.parse(request.body);systems.push(body.system);return Response.json({content:[{type:'text',text:body.system.includes('协调员')?JSON.stringify({summary:'好',conflict:'无',actions:['a','b','c']}):'好的'}],stop_reason:'end_turn'});};
  const request=async(name,path,data,headers={})=>{const r=await handleAPI(new Request('https://weave.test/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?headers:{Origin:'https://weave.test','Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)}),{db,secret,identity:name?{userId:name,displayName:name,email:name+'@example.test'}:null,fetcher,agentProviderApiKey:managed,wechat:{token:bridgeToken},now:start,...options});return {status:r.status,data:await r.json().catch(()=>null)};};
  return {db,request,systems,fetcher,get calls(){return calls;}};
}
const idOf=name=>hash(name).then(x=>'u:'+x);
const bridgeHeaders={Authorization:'Bearer '+bridgeToken};
const groupMessage=(id,sender,body,mentioned=false)=>({id,threadId:ROOM,senderId:sender,type:1,direction:'incoming',body,createdAt:new Date(start).toISOString(),mentions:{self:mentioned}});

test('deleting an account requires explicit confirmation',async()=>{
  const h=harness();await h.request('Alice','status');
  assert.equal((await h.request('Alice','account/delete',{})).status,400);
  assert.ok((await new Store(h.db).load()).people[await idOf('Alice')]);
});
test('deleting an account removes everything of theirs and nothing of anyone else',async()=>{
  const h=harness(),alice=await idOf('Alice'),bob=await idOf('Bob');
  await h.request('Bob','status');
  const code=(await h.request('Alice','wechat/bind',{})).data.instruction;
  await h.request(null,'internal/wechat/events',{id:'m1',threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body:code,createdAt:new Date(start).toISOString()},bridgeHeaders);
  await h.request(null,'internal/wechat/events',groupMessage('g1','wxid-alice','@助理 开启打卡群',true),bridgeHeaders);
  await h.request(null,'internal/wechat/events',{id:'m2',threadId:'wxid-alice',senderId:'wxid-alice',type:1,direction:'incoming',body:'ALICE_WECHAT_消息',createdAt:new Date(start).toISOString()},bridgeHeaders);
  let store=new Store(h.db),world=await store.load();
  // Data the removed friend feature left behind: a friend link, invitations, a shared plan. Old data must still load and go with the account.
  world.people[alice].messages.push({id:'a1',role:'user',text:'ALICE_PRIVATE_消息',createdAt:new Date(start).toISOString()});
  world.people[bob].messages.push({id:'b1',role:'user',text:'BOB_PRIVATE_消息',createdAt:new Date(start).toISOString()});
  world.links['link:1']={id:'link:1',members:[alice,bob].sort(),createdAt:new Date(start).toISOString()};
  world.invites['invite:1']={id:'invite:1',from:alice,expiresAt:start+86400000,createdAt:new Date(start).toISOString()};
  world.invites['invite:2']={id:'invite:2',from:bob,usedBy:alice,expiresAt:start+86400000,createdAt:new Date(start).toISOString()};
  world.negotiations['n:1']={id:'n:1',participants:[alice,bob].sort(),activity:'散步',status:'confirmed',revision:1,consents:{},confirmations:{},candidate:{slot:new Date(start+86400000).toISOString(),activity:'散步',durationMinutes:30},events:[],createdAt:new Date(start).toISOString()};
  await store.save(world);
  assert.equal((await h.request('Alice','account/delete',{confirm:true})).status,200);
  world=await new Store(h.db).load();
  assert.equal(world.people[alice],undefined);assert.ok(world.people[bob]);
  assert.equal(Object.keys(world.negotiations).length,0);assert.equal(Object.keys(world.links).length,0);
  assert.equal(Object.values(world.invites).filter(i=>i.from===alice||i.usedBy===alice).length,0);assert.equal(Object.keys(world.invites).length,0);
  assert.equal(Object.values(world.runtime).filter(x=>x.ownerId===alice).length,0);
  assert.equal(Object.values(world.wechat).filter(x=>x.ownerId===alice||x.groupAad).length,0);
  const dump=JSON.stringify(world);
  assert.ok(!dump.includes('ALICE_PRIVATE'));assert.ok(!dump.includes('ALICE_WECHAT'));assert.ok(!dump.includes(alice));
  assert.ok(dump.includes('BOB_PRIVATE'));
  assert.equal((await h.request('Bob','status')).status,200);
  // Their group is closed too: new messages leave no trace.
  assert.equal((await h.request(null,'internal/wechat/events',groupMessage('g2','wxid-bob','还在吗'),bridgeHeaders)).data.ignored,true);
});
test('deleting a guest account also removes its session row',async()=>{
  const h=harness();h.db.sql.exec('CREATE TABLE IF NOT EXISTS weave_guest_sessions (id TEXT PRIMARY KEY, created_at INTEGER)');
  const token='ab'.repeat(24);h.db.sql.prepare('INSERT INTO weave_guest_sessions (id,created_at) VALUES (?,?)').run(token,start);
  assert.equal((await h.request('guest:'+token,'account/delete',{confirm:true})).status,200);
  assert.equal(h.db.sql.prepare('SELECT COUNT(*) AS n FROM weave_guest_sessions').get().n,0);
});

test('the health safety rules say what they must',()=>{
  assert.match(SAFETY_RULES,/节食/);assert.match(SAFETY_RULES,/伤害自己/);
});

// Every source file of the workspace (hosted/app/workspace/**), as one text: the shell, its pages, its ui parts and modules.
async function workspaceText(){
  const walk=async dir=>(await Promise.all((await readdir(dir,{withFileTypes:true})).map(entry=>entry.isDirectory()?walk(new URL(entry.name+'/',dir)):[new URL(entry.name,dir)]))).flat();
  const files=(await walk(new URL('../hosted/app/workspace/',import.meta.url))).filter(file=>/\.(jsx?|mjs|tsx?)$/.test(file.pathname));
  return (await Promise.all(files.map(file=>readFile(file,'utf8')))).join('\n');
}

test('product copy no longer makes the claims the code contradicts',async()=>{
  const read=path=>readFile(new URL('../hosted/app/'+path,import.meta.url),'utf8');
  const landing=await read('LandingMarketing.tsx'),workspace=await workspaceText();
  for(const text of ['数据保存在当前浏览器','产品宣传','自动回跳','高级通道'])assert.ok(!landing.includes(text),text);
  assert.ok(!workspace.includes('清除本机数据'));assert.ok(!workspace.includes('Hermes'));assert.ok(!workspace.includes('HERMES'));
  assert.ok(workspace.includes('DeepSeek'));
  const privacy=await read('privacy/page.tsx');for(const text of ['DeepSeek','Notion','删除','导出'])assert.ok(privacy.includes(text),text);
});

test('the workspace still offers to delete the account',async()=>{
  assert.ok((await workspaceText()).includes('account/delete'));
});
