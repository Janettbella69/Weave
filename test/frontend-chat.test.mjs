import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isImeComposing,shouldSendOnEnter} from '../hosted/app/workspace/chat-input.mjs';
import {beginPending,finishPending,dropSettled,visibleMessages,isReplying} from '../hosted/app/workspace/chat-pending.mjs';
import {agentStatus} from '../hosted/app/workspace/agent-status.mjs';

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
