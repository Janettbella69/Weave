import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VIEWS,NAV,readView,viewSearch,hasTopBar} from '../hosted/app/workspace/view-route.mjs';

test('the view comes from ?view= and falls back to chat',()=>{
  assert.equal(readView('?view=todo'),'todo');
  assert.equal(readView('?view=agent'),'agent');
  assert.equal(readView('?view=todo&connection=notion'),'todo','other parameters do not matter');
  assert.equal(readView('?view=calendar'),'chat','a view that no longer exists');
  assert.equal(readView('?view=constructor'),'chat');
  assert.equal(readView('?view='),'chat');
  assert.equal(readView('?connection=notion&status=connected'),'chat','the Notion return carries no view');
  assert.equal(readView(''),'chat');assert.equal(readView(undefined),'chat');assert.equal(readView(null),'chat');
});

test('the search for a view reads back as the same view, and chat needs none',()=>{
  assert.equal(viewSearch('chat'),'');
  assert.equal(viewSearch('todo'),'?view=todo');
  assert.equal(viewSearch('agent'),'?view=agent');
  assert.equal(viewSearch('calendar'),'','not a view');
  assert.equal(viewSearch(undefined),'');
  for(const view of VIEWS)assert.equal(readView(viewSearch(view)),view,view);
});

test('the navigation has five pages in order; the agent home is reached from elsewhere',()=>{
  assert.deepEqual(VIEWS,['chat','todo','goals','records','settings','agent']);
  assert.deepEqual(NAV.map(n=>n.id),['chat','todo','goals','records','settings']);
  assert.deepEqual(NAV.map(n=>n.label),['聊天','待办','目标','记录','设置']);
  assert.ok(NAV.every(n=>VIEWS.includes(n.id)),'every tab is a view');
  assert.ok(!NAV.some(n=>n.id==='agent'),'no tab for the agent home');
});

test('on a phone, the shell\'s top bar is on every page with no header of its own, the first run included',()=>{
  for(const view of ['todo','goals','records','settings'])assert.equal(hasTopBar(view),true,view);
  assert.equal(hasTopBar('chat'),false,'the chat has its own header');
  assert.equal(hasTopBar('chat',{firstRun:true}),true,'the first run stands in for the chat and has no header');
  assert.equal(hasTopBar('agent'),false,'the assistant\'s home page has its own way back');
  assert.equal(hasTopBar('agent',{firstRun:true}),false);
  for(const view of [null,undefined,'','calendar'])assert.equal(hasTopBar(view,{firstRun:true}),false,'nothing before the address is read: '+String(view));
});
