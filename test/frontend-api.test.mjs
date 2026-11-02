import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiRequest,ApiError,unauthorizedAction,reloadAllowed,normalizeStatus} from '../hosted/app/workspace/api-client.mjs';
import {readNotionReturn,normalizePages,waitForNotionPages} from '../hosted/app/workspace/notion-return.mjs';
import {FEATURES,navViews} from '../hosted/app/workspace/features.mjs';

const answer=(body,init={})=>async()=>new Response(typeof body==='string'?body:JSON.stringify(body),{status:200,...init});
const recorder=(handler)=>{const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});return handler(url,options);};return {fetchImpl,calls};};

test('read-only paths are fetched with GET and the rest with a JSON POST',async()=>{
  const {fetchImpl,calls}=recorder(answer({ok:true}));
  await apiRequest('status',undefined,{fetchImpl});
  await apiRequest('chat',{text:'hi'},{fetchImpl});
  await apiRequest('connections/notion/disconnect',undefined,{fetchImpl});
  assert.deepEqual(calls[0],{url:'/api/status',options:{}});
  assert.equal(calls[1].options.method,'POST');assert.equal(calls[1].options.body,'{"text":"hi"}');
  assert.equal(calls[1].options.headers['Content-Type'],'application/json');
  assert.equal(calls[2].options.method,'POST');assert.equal(calls[2].options.body,'{}');
});

test("the server's own error message is shown; proxy pages and network errors are not",async()=>{
  await assert.rejects(apiRequest('chat',{},{fetchImpl:answer({error:'操作太频繁，请一分钟后重试'},{status:429})}),{message:'操作太频繁，请一分钟后重试',status:429});
  await assert.rejects(apiRequest('status',undefined,{fetchImpl:answer('<html><h1>504 Gateway Time-out</h1></html>',{status:504})}),{message:'请求失败',status:504});
  await assert.rejects(apiRequest('status',undefined,{fetchImpl:answer('not json',{status:200})}),{message:'请求失败'});
  await assert.rejects(apiRequest('status',undefined,{fetchImpl:async()=>{throw new TypeError('Failed to fetch');}}),e=>e instanceof ApiError&&e.message==='请求失败');
  await assert.rejects(apiRequest('x',{},{fetchImpl:answer({error:''},{status:400})}),{message:'请求失败'});
});

test('a 401 from the access password is told apart from a missing guest session',async()=>{
  const seen=[];
  const basic=async()=>new Response('需要输入 Weave 的访问密码。',{status:401,headers:{'WWW-Authenticate':'Basic realm="Weave"','Content-Type':'text/plain; charset=utf-8'}});
  await assert.rejects(apiRequest('status',undefined,{fetchImpl:basic,onUnauthorized:r=>seen.push(unauthorizedAction(r.headers))}),{message:'请重新开始',status:401});
  const guest=answer({error:'请先登录'},{status:401});
  await assert.rejects(apiRequest('status',undefined,{fetchImpl:guest,onUnauthorized:r=>seen.push(unauthorizedAction(r.headers))}),{status:401});
  assert.deepEqual(seen,['reload','guest']);
  // without a handler it still throws, and never tries to parse the text body as JSON
  await assert.rejects(apiRequest('status',undefined,{fetchImpl:basic}),{status:401});
});

test('the reload for a refused password cannot loop',()=>{
  const store=new Map();const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
  assert.equal(reloadAllowed(storage,1_000_000),true);
  assert.equal(reloadAllowed(storage,1_005_000),false);
  assert.equal(reloadAllowed(storage,1_031_000),true);
  const blocked={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}};
  assert.equal(reloadAllowed(blocked,5),true);
});

test('the Notion return is recognised from the URL',()=>{
  assert.deepEqual(readNotionReturn('?connection=notion&status=ready'),{status:'ready'});
  assert.deepEqual(readNotionReturn('?connection=notion&status=error&detail=exchange_failed'),{status:'error'});
  assert.deepEqual(readNotionReturn('?connection=notion'),{status:'error'});
  assert.equal(readNotionReturn(''),null);assert.equal(readNotionReturn('?join=abc'),null);assert.equal(readNotionReturn(undefined),null);
});

test('whatever shape the pages come in, the picker gets ids and titles',()=>{
  assert.deepEqual(normalizePages([{id:'a',title:'我的页面',url:'u'},{id:'b',title:'  '},{id:'c'},{id:7,title:'x'},null,'s',{title:'no id'}]),[{id:'a',title:'我的页面'},{id:'b',title:'未命名页面'},{id:'c',title:'未命名页面'}]);
  assert.deepEqual(normalizePages(undefined),[]);assert.deepEqual(normalizePages({}),[]);
});

test('after the Notion return the pages are asked for a few times, then given up on',async()=>{
  const sleeps=[];const sleep=async ms=>{sleeps.push(ms);};
  let calls=0;
  const pages=await waitForNotionPages(async()=>++calls<3?{ready:false,pages:[]}:{ready:true,pages:[{id:'p1',title:'T'}]},{sleep});
  assert.deepEqual(pages,{pages:[{id:'p1',title:'T'}]});assert.equal(calls,3);assert.deepEqual(sleeps,[800,800]);
  calls=0;
  assert.equal(await waitForNotionPages(async()=>{calls++;return {ready:false,pages:[]};},{sleep:async()=>{},attempts:4}),null);assert.equal(calls,4);
  assert.equal(await waitForNotionPages(async()=>({ready:true,pages:[]}),{sleep}),null,'ready with nothing to pick is not a success');
  assert.equal(await waitForNotionPages(async()=>({ready:true,pages:[{id:'x',title:'y'}]}),{sleep,active:()=>false}),null,'stopped');
  await assert.rejects(waitForNotionPages(async()=>{throw new ApiError('请求失败');},{sleep}),{message:'请求失败'});
});

test('a connection the server finished by itself is recognised, and asked about only once',async()=>{
  const sleep=async()=>{};let asked=0,reads=0;
  const isConnected=async()=>{asked++;return true;};
  assert.deepEqual(await waitForNotionPages(async()=>{reads++;return {ready:false,pages:[]};},{sleep,isConnected}),{connected:true});
  assert.equal(asked,1);assert.equal(reads,1,'no need to keep reading');
  // ready with nothing to pick, and already connected
  assert.deepEqual(await waitForNotionPages(async()=>({ready:true,pages:[]}),{sleep,isConnected}),{connected:true});
  // not connected: keeps reading, asks once
  asked=0;reads=0;
  assert.equal(await waitForNotionPages(async()=>{reads++;return {ready:false,pages:[]};},{sleep,attempts:3,isConnected:async()=>{asked++;return false;}}),null);
  assert.equal(asked,1);assert.equal(reads,3);
  // pages win over the connected check
  assert.deepEqual(await waitForNotionPages(async()=>({ready:true,pages:[{id:'a',title:'b'}]}),{sleep,isConnected}),{pages:[{id:'a',title:'b'}]});
});

test('friends and the background page are not offered for now',()=>{
  assert.equal(FEATURES.collaboration,false);assert.equal(FEATURES.proactive,false);
  assert.deepEqual(navViews().map(([id])=>id),['chat','calendar','memory']);
  assert.deepEqual(navViews({collaboration:true,proactive:true}).map(([id])=>id),['chat','connections','calendar','proactive','memory']);
});

test('a status answer is only used when it has what the workspace shows; friend lists may be missing',()=>{
  const real={profile:{name:'Me',timezone:'Asia/Shanghai',slots:[],activities:['散步']},settings:{agent:true},messages:[],plans:[],checkins:[],calendar:[],reminders:[],notifications:[],people:[],invites:[],negotiations:[]};
  assert.deepEqual(normalizeStatus(real),real);
  const slim={profile:{name:'Me',timezone:'UTC'},settings:{},messages:[],plans:[],checkins:[],reminders:[],notifications:[]};
  const filled=normalizeStatus(slim);
  assert.deepEqual([filled.people,filled.invites,filled.negotiations,filled.calendar,filled.profile.slots,filled.profile.activities],[[],[],[],[],[],[]]);
  for(const bad of [null,undefined,{},[],'x',{...real,settings:undefined},{...real,messages:null},{...real,reminders:'no'},{...real,profile:{timezone:'UTC'}},{...real,profile:{name:'x'}}])assert.equal(normalizeStatus(bad),null);
});
