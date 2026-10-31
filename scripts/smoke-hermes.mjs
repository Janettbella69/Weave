// Runs the installed official Hermes against an isolated Anthropic HTTP stub.
// Does not send real keys or contact DeepSeek.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const home=await mkdtemp(join(tmpdir(),'weave-hermes-native-')),requests=[];
const decision={decision:'quiet',confidence:0.95,whyNow:'近期没有值得介入的新线索。',evidenceIds:[],message:'',proposal:{kind:'clarify',activity:'',peerId:''},followUpMinutes:1440};
const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const data=JSON.parse(body||'{}');requests.push({path:req.url,headers:req.headers,data});
  const message={id:'msg_local_test',type:'message',role:'assistant',model:'deepseek-flash',content:[{type:'text',text:JSON.stringify(decision)}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:20,output_tokens:50}};
  if(data.stream){
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(event,data)=>res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');
    send('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:20,output_tokens:0}}});
    send('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
    send('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:JSON.stringify(decision)}});
    send('content_block_stop',{type:'content_block_stop',index:0});
    send('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:50}});
    send('message_stop',{type:'message_stop'});res.end();
  }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(message));}
});
let child;
try{
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const python=process.env.HERMES_PYTHON||fileURLToPath(new URL('../hosted/hermes-runner/.venv/bin/python',import.meta.url));
  const script=fileURLToPath(new URL('../hosted/hermes-runner/assess.py',import.meta.url));
  child=spawn(python,[script],{cwd:home,env:{PATH:process.env.PATH,HOME:home,HERMES_HOME:home,WEAVE_HERMES_TEST_MODE:'1'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),90000);
  child.stdin.end(JSON.stringify({apiKey:'sk-local-test-not-real',model:'deepseek-flash',run:{owner:'u:'+'ab'.repeat(32),leaseId:'12345678-1234-1234-1234-123456789abc'},system:'只返回 JSON 判断。不得调用工具。',context:{facts:[]},_test_base_url:'http://127.0.0.1:'+server.address().port+'/anthropic'}));
  const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});clearTimeout(timeout);
  assert.equal(code,0,stderr+'\n'+stdout);assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)).decision,decision);
  assert.ok(requests.length>0);
  for(const r of requests){assert.match(r.path,/^\/anthropic\/v1\/messages/);assert.equal(r.data.model,'deepseek-flash');assert.ok(!r.data.tools?.length);assert.equal(r.headers['x-api-key'],'sk-local-test-not-real');}
  console.log('PASS: installed official Hermes AIAgent → native Anthropic Messages HTTP → validated structured decision; no tool definitions or real credentials.');
}finally{if(child&&!child.killed)child.kill();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});}
