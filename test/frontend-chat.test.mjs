import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isImeComposing,shouldSendOnEnter} from '../hosted/app/workspace/chat-input.mjs';
import {beginPending,finishPending,dropSettled,visibleMessages,isReplying} from '../hosted/app/workspace/chat-pending.mjs';
import {agentStatus} from '../hosted/app/workspace/agent-status.mjs';
import {sendChat} from '../hosted/app/workspace/chat-send.mjs';
import {ApiError} from '../hosted/app/workspace/api-client.mjs';

const key=(init={})=>({key:'Enter',shiftKey:false,...init});
const react=(init={},native={})=>({...key(init),nativeEvent:{isComposing:false,keyCode:13,...native}});

test('Enter sends, Shift+Enter does not, other keys do not',()=>{
  assert.equal(shouldSendOnEnter(key()),true);
  assert.equal(shouldSendOnEnter(react()),true);
  assert.equal(shouldSendOnEnter(key({shiftKey:true})),false);
  assert.equal(shouldSendOnEnter(key({key:'a'})),false);
  assert.equal(shouldSendOnEnter(null),false);
});

test('Enter that confirms an input-method candidate never sends',()=>{
  // Chrome/Firefox: isComposing on the keydown
  assert.equal(shouldSendOnEnter(react({},{isComposing:true})),false);
  assert.equal(shouldSendOnEnter({...key(),isComposing:true}),false);
  // Safari: compositionend already fired, but the same keydown still reports keyCode 229
  assert.equal(shouldSendOnEnter(react({},{isComposing:false,keyCode:229})),false);
  assert.equal(shouldSendOnEnter({...key(),keyCode:229}),false);
  // some Windows input methods report key "Process"
  assert.equal(shouldSendOnEnter({key:'Process',nativeEvent:{key:'Process',keyCode:229}}),false);
  // the caller's own compositionstart/compositionend flag
  assert.equal(shouldSendOnEnter(react(),true),false);
  assert.equal(isImeComposing(react()),false);
  assert.equal(isImeComposing(react({},{isComposing:true})),true);
});

const msg=(id,role,text)=>({id,role,text,createdAt:'2026-11-02T00:00:00.000Z'});

test('a sent message shows at once, then a thinking bubble, then the reply, without waiting for the server',()=>{
  const server=[msg('1','user','早'),msg('2','assistant','早上好')];
  let pendings=[beginPending(server,'今天想散步')];
  assert.equal(isReplying(pendings),true);
  let shown=visibleMessages(server,pendings);
  assert.deepEqual(shown.map(m=>[m.role,m.text,!!m.thinking]),[['user','早',false],['assistant','早上好',false],['user','今天想散步',false],['assistant','',true]]);
  pendings=finishPending(pendings,pendings[0].key,'**好的**，走起',7);
  assert.equal(isReplying(pendings),false);
  shown=visibleMessages(server,pendings);
  assert.deepEqual(shown.slice(2).map(m=>[m.role,m.text,!!m.thinking]),[['user','今天想散步',false],['assistant','**好的**，走起',false]]);
  assert.ok(shown.slice(2).every(m=>m.local));
});

test('the server copy takes over without showing anything twice',()=>{
  const before=[msg('1','user','早')];
  let pendings=[beginPending(before,'你好')];
  // Agent turns store the user message first, then the reply: a poll in the middle already has the user message.
  const middle=[...before,msg('2','user','你好')];
  assert.deepEqual(visibleMessages(middle,pendings).map(m=>[m.role,m.text]),[['user','早'],['user','你好'],['assistant','']]);
  pendings=finishPending(pendings,pendings[0].key,'你好呀',3);
  const full=[...middle,msg('3','assistant','你好呀')];
  assert.deepEqual(visibleMessages(full,pendings).map(m=>m.id),['1','2','3']);
});

test('the same text sent twice is not mistaken for the first copy',()=>{
  const before=[msg('1','user','好'),msg('2','assistant','嗯')];
  const pendings=[beginPending(before,'好')];
  const shown=visibleMessages(before,pendings);
  assert.equal(shown.filter(m=>m.role==='user').length,2);
});

test('a plan reply saved without the appended sentence still counts as the same reply',()=>{
  const before=[];
  let pendings=[beginPending(before,'帮我调整计划')];
  pendings=finishPending(pendings,pendings[0].key,'今天轻松一点。\n\n计划已生成，请在 Weave 中查看并确认。',1);
  const saved=[msg('a','user','帮我调整计划'),msg('b','assistant','今天轻松一点。')];
  assert.deepEqual(visibleMessages(saved,pendings).map(m=>m.id),['a','b']);
});

test('an entry is dropped only by a status request that started after its reply arrived',()=>{
  let pendings=[beginPending([],'a'),beginPending([],'b')];
  pendings=finishPending(pendings,pendings[0].key,'ra',5);
  assert.equal(dropSettled(pendings,5).length,2,'a request that was already running does not count');
  assert.equal(dropSettled(pendings,4).length,2);
  const next=dropSettled(pendings,6);
  assert.equal(next.length,1);assert.equal(next[0].text,'b','an unanswered entry stays');
  assert.equal(dropSettled(next,99).length,1);
});

test('two sends in a row keep both conversations on screen until each is settled',()=>{
  const server=[];
  let pendings=[beginPending(server,'一')];
  pendings=finishPending(pendings,pendings[0].key,'答一',2);
  pendings=[...pendings,beginPending(server,'二')];
  const shown=visibleMessages(server,pendings);
  assert.deepEqual(shown.map(m=>m.text),['一','答一','二','']);
});

test('the Agent status says the same thing in the header and in settings, and never "waiting for a test"',()=>{
  assert.deepEqual(agentStatus({ready:true}),{tone:'live',label:'Agent 已连接',rowLabel:'已连接'});
  assert.equal(agentStatus({ready:false}).label,'连接 Agent');
  assert.equal(agentStatus({ready:false}).rowLabel,'待连接');
  assert.equal(agentStatus({ready:true,replying:true}).label,'Agent 正在回复…');
  assert.equal(agentStatus({ready:true,replying:true}).rowLabel,'已连接');
  for(const input of [{ready:true},{ready:false},{ready:true,replying:true},{}])assert.ok(!JSON.stringify(agentStatus(input)).includes('测试'));
});

// ---- sending (chat-send.mjs) ----

// A stand-in for the shell's `chat` prop (Workspace.jsx): the same calls, each written down, on a real pending list.
function fakeShell({messages=[],agent=true}={}){
  const log=[];
  const shell={state:{messages,settings:{agent}},pendings:[],draft:'',error:'',requests:0};
  const chat={
    get pendings(){return shell.pendings;},
    begin(text){log.push(['begin',text]);const entry=beginPending(shell.state.messages,text);shell.pendings=[...shell.pendings,entry];return entry;},
    finish(entry,reply){log.push(['finish',reply]);shell.pendings=finishPending(shell.pendings,entry.key,reply,shell.requests);},
    cancel(entry,error){log.push(['cancel',error.message]);shell.pendings=shell.pendings.filter(p=>p.key!==entry.key);shell.error=error.message;},
    restore(text){log.push(['restore',text]);shell.draft=shell.draft||text;},
  };
  return {shell,chat,log};
}

test('sendChat: the message and the thinking bubble show at once, the reply when the request comes back',async()=>{
  const {shell,chat,log}=fakeShell({messages:[msg('1','user','早')]});
  let answer;
  const api=(path,body)=>{log.push(['api',path,body]);return new Promise(resolve=>{answer=resolve;});};
  const sent=sendChat({state:shell.state,api,chat},'  今天想散步  ');
  assert.deepEqual(log,[['begin','今天想散步'],['api','chat',{text:'今天想散步'}]],'on screen before the request goes out, and trimmed');
  assert.deepEqual(visibleMessages(shell.state.messages,shell.pendings).map(m=>[m.role,m.text,!!m.thinking]),[['user','早',false],['user','今天想散步',false],['assistant','',true]]);
  answer({reply:'**好**，走起'});
  assert.equal(await sent,true);
  assert.deepEqual(log.slice(2),[['finish','**好**，走起']]);
  assert.deepEqual(visibleMessages(shell.state.messages,shell.pendings).slice(1).map(m=>[m.role,m.text,!!m.thinking]),[['user','今天想散步',false],['assistant','**好**，走起',false]]);
  assert.equal(shell.draft,'','nothing is put back after a send that worked');
});

test('sendChat: nothing goes out without an Agent or while Weave is still answering, and the text stays in the chat box',async()=>{
  const busy=fakeShell();busy.shell.pendings=[beginPending([],'上一句')];
  for(const [what,{shell,chat,log}] of [['no Agent',fakeShell({agent:false})],['still answering',busy]]){
    const calls=[];
    const ok=await sendChat({state:shell.state,api:async(...args)=>{calls.push(args);return {reply:''};},chat},'你好');
    assert.equal(ok,false,what);
    assert.deepEqual(calls,[],what+': no request');
    assert.deepEqual(log,[['restore','你好']],what+': nothing on screen, the text kept');
    assert.equal(shell.draft,'你好',what);
  }
  const blank=fakeShell();
  assert.equal(await sendChat({state:blank.shell.state,api:async()=>{throw Error('not called');},chat:blank.chat},'  \n '),false);
  assert.deepEqual(blank.log,[],'a blank text is no message at all');
});

test('sendChat: a failed send takes the message off the screen, says why, and puts the text back in the chat box',async()=>{
  const {shell,chat,log}=fakeShell();
  const ok=await sendChat({state:shell.state,api:async()=>{throw new ApiError('服务暂时不可用，请稍后重试',503);},chat},'帮我定个目标');
  assert.equal(ok,false);
  assert.deepEqual(log,[['begin','帮我定个目标'],['cancel','服务暂时不可用，请稍后重试'],['restore','帮我定个目标']]);
  assert.deepEqual(shell.pendings,[]);
  assert.equal(shell.error,'服务暂时不可用，请稍后重试','the server\'s own words, as the old send showed them');
  assert.equal(shell.draft,'帮我定个目标');
});

test('sendChat: an answer without a reply text leaves no empty bubble behind',async()=>{
  const {shell,chat}=fakeShell();
  assert.equal(await sendChat({state:shell.state,api:async()=>({}),chat},'在吗'),true);
  assert.deepEqual(visibleMessages([],shell.pendings).map(m=>[m.role,m.text]),[['user','在吗']]);
});
