import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL('../hosted/'+path,import.meta.url),'utf8');

test('the workspace has no English labels or titles',async()=>{
  const workspace=await read('app/workspace/Workspace.jsx'),panel=await read('app/workspace/ProactivePanel.jsx');
  for(const text of ['YOUR LIFE, REMEMBERED','SMALL COMMITMENTS','NOTICE, ASK','CHANNELS','<h2>Channels</h2>','Personal Agent','>个人 Agent<','>Agent 协作<','Agent 待测试'])
    for(const [name,source] of [['Workspace.jsx',workspace],['ProactivePanel.jsx',panel]])assert.ok(!source.includes(text),name+' still has '+text);
});

test('nothing in the workspace writes raw HTML',async()=>{
  for(const path of ['app/workspace/Workspace.jsx','app/workspace/ProactivePanel.jsx','app/workspace/Markdown.jsx'])
    assert.ok(!(await read(path)).includes('dangerouslySetInnerHTML'),path);
});

test('friends, negotiation and the background page are behind the feature flags',async()=>{
  const workspace=await read('app/workspace/Workspace.jsx');
  for(const guarded of ["FEATURES.collaboration&&view==='connections'","FEATURES.proactive&&view==='proactive'","{FEATURES.collaboration&&<div className=\"quick-actions\">","{FEATURES.collaboration&&join&&","FEATURES.collaboration&&agentReady&&!state.profile.slots.length"])
    assert.ok(workspace.includes(guarded),guarded);
});

test('a 401 is not sent to the guest URL when the site is behind the access password',async()=>{
  const workspace=await read('app/workspace/Workspace.jsx');
  assert.ok(workspace.includes("unauthorizedAction(response.headers)==='guest'"));
  assert.equal(workspace.split('/api/auth/guest/start').length-1,1,'one guest redirect, only for guest mode');
});

test('single-user mode gets no sign-out link that does not exist',async()=>{
  const auth=await read('app/weave-auth.ts'),workspace=await read('app/workspace/Workspace.jsx');
  assert.ok(auth.includes('authKind: "single"'));
  assert.ok(workspace.includes("authKind==='chatgpt'?<>")&&workspace.includes("authKind==='guest'?<>")&&workspace.includes(':null}</footer>'));
});

test('the error boundary does not show the raw error',async()=>{
  const boundary=await read('components/ErrorBoundary.jsx');
  assert.ok(boundary.includes('请刷新页面重试')&&boundary.includes('刷新页面'));
  assert.ok(!boundary.includes('error?.message')&&!boundary.includes('error.message'));
});
