import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {VIEWS,NAV,readView,viewSearch,hasTopBar,historyMode} from '../hosted/app/workspace/view-route.mjs';

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

test('opening the assistant\'s home page adds a history entry; every other change of page takes the current entry\'s place',()=>{
  const tabs=NAV.map(n=>n.id);
  for(const from of tabs){
    assert.equal(historyMode(from,'agent'),'push',from+' -> agent');
    for(const to of tabs)assert.equal(historyMode(from,to),'replace',from+' -> '+to+': the tabs do not fill up the history');
    assert.equal(historyMode('agent',from),'replace','agent -> '+from);
  }
  assert.equal(historyMode('agent','agent'),'replace','already there: no second entry');
});

test('in one browser tab: back from the assistant\'s home page lands on the page it was opened from, and the tabs never pile up',()=>{
  // The tab's history, written the way Workspace.jsx's navigate writes it, and the back gesture.
  const entries=['chat'];let at=0;
  const open=to=>{if(historyMode(entries[at],to)==='push'){entries.splice(at+1,Infinity,to);at++;}else entries[at]=to;};
  const back=()=>{assert.ok(at>0,'a back gesture here would leave the site');return entries[--at];};
  for(const tab of ['todo','goals','records','settings','chat'])open(tab);
  assert.deepEqual(entries,['chat'],'five switches of tab, still one entry');
  open('agent');
  assert.equal(back(),'chat','back from the assistant\'s home page: the chat');
  open('records');open('agent');
  assert.equal(back(),'records','opened from 记录, back to 记录');
  open('settings');open('agent');open('todo');
  assert.deepEqual(entries,['settings','todo'],'a tab opened from the assistant\'s home page takes its entry');
  assert.equal(back(),'settings');
});

test('the shell writes the history the way historyMode says, and the back gesture shows the page of the entry it lands on',async()=>{
  const workspace=await readFile(new URL('../hosted/app/workspace/Workspace.jsx',import.meta.url),'utf8');
  assert.match(workspace,/^import \{[^}]*\bhistoryMode\b[^}]*\} from '\.\/view-route\.mjs';$/m);
  assert.match(workspace,/const mode=historyMode\(readView\(location\.search\),next\)/,'the page that is open now is the one in the address');
  assert.match(workspace,/if\(mode==='push'\)history\.pushState\(null,'',url\);\s*else history\.replaceState\(null,'',url\);/);
  assert.equal(workspace.split('history.pushState').length-1,1,'only navigate adds an entry');
  const listener=/window\.addEventListener\('popstate',(\w+)\)/.exec(workspace);
  assert.ok(listener,'it listens for the back gesture');
  assert.match(workspace,new RegExp('const '+listener[1]+'=\\(\\)=>show\\(readView\\(location\\.search\\)\\);'));
  assert.ok(workspace.includes("return()=>window.removeEventListener('popstate',"+listener[1]+');'),'and stops listening when the shell goes away');
  // Back from Notion still lands on settings in the entry it came back to, without adding one.
  assert.ok(workspace.includes("history.replaceState(null,'',location.pathname+viewSearch('settings'));"));
  assert.match(workspace,/setView\(back\?'settings':entry\.current\.view\);/);
});
