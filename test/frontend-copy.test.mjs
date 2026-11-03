import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const read=path=>readFile(new URL('../hosted/'+path,import.meta.url),'utf8');

// Every source file of the workspace (hosted/app/workspace/**): the shell, its pages, its ui parts and its modules.
const walk=async dir=>(await Promise.all((await readdir(dir,{withFileTypes:true})).map(entry=>entry.isDirectory()?walk(new URL(entry.name+'/',dir)):[new URL(entry.name,dir)]))).flat();
async function workspaceSources(){
  const root=new URL('../hosted/app/workspace/',import.meta.url);
  const files=(await walk(root)).filter(file=>/\.(jsx?|mjs|tsx?)$/.test(file.pathname));
  return Promise.all(files.map(async file=>[file.pathname.slice(root.pathname.length),await readFile(file,'utf8')]));
}

test('the workspace has no English labels or titles',async()=>{
  const sources=await workspaceSources();
  assert.ok(sources.some(([name])=>name==='Workspace.jsx'),'the walk reaches the shell');
  for(const text of ['YOUR LIFE, REMEMBERED','SMALL COMMITMENTS','NOTICE, ASK','CHANNELS','<h2>Channels</h2>','Personal Agent','>个人 Agent<','>Agent 协作<','Agent 待测试','反馈：'])
    for(const [name,source] of sources)assert.ok(!source.includes(text),name+' still has '+text);
});

test('nothing in the workspace writes raw HTML',async()=>{
  const sources=await workspaceSources();
  assert.ok(sources.some(([name])=>name==='Markdown.jsx'),'the walk reaches the components');
  for(const [name,source] of sources)assert.ok(!source.includes('dangerouslySetInnerHTML'),name);
});

test('Weave\'s replies are drawn by the Markdown component, never as raw HTML',async()=>{
  const page=await read('app/workspace/pages/ChatPage.jsx');
  assert.match(page,/^import Markdown from '\.\.\/Markdown';$/m,'the page brings in the safe Markdown renderer');
  assert.match(page,/<Markdown text=\{[^}]+\}\/>/,'and renders assistant text through it');
  assert.ok(!page.includes('dangerouslySetInnerHTML'));
});

test('only timezone.mjs knows the browser\'s zone; the pages use the account\'s',async()=>{
  const sources=await workspaceSources();
  assert.ok(sources.some(([name])=>name==='pages/ChatPage.jsx'),'the walk reaches the pages');
  const readers=sources.filter(([,source])=>source.includes('deviceTimezone')).map(([name])=>name);
  assert.deepEqual(readers,['timezone.mjs']);
});

test('the busy flag is on the page, not on the whole workspace',async()=>{
  const workspace=await read('app/workspace/Workspace.jsx');
  assert.match(workspace,/<main className="wv-main"[^>]*\saria-busy=\{/);
  assert.doesNotMatch(workspace,/<div className="wv"[^>]*aria-busy/);
});

test('a message sent from the first run or a new goal goes through the chat\'s own send',async()=>{
  const firstRun=await read('app/workspace/pages/FirstRun.jsx'),workspace=await read('app/workspace/Workspace.jsx');
  assert.match(firstRun,/sendChat\(props,\s*COPY\.firstRunStarter\(option\.label,\s*option\.step\)\)/,'「就这样开始」 sends the sentence of A-4');
  assert.match(workspace,/const isFirstRun=\(state,pendings\)=>state\.habits\.length===0&&state\.messages\.length===0&&pendings\.length===0;/,'the first run gives way to the chat while a message is on its way');
});

test('a tick that did not go through says the agreed sentence, never the server\'s words',async()=>{
  // The habit endpoints' errors are written for the model (they name the database); spec A-4 has the page's sentence.
  const page=await read('app/workspace/pages/TodoPage.jsx');
  assert.ok(page.includes("'habits/check'")&&page.includes("'habits/uncheck'"));
  assert.match(page,/retryOnConflict\(/,'a clash with Weave writing at the same moment is tried once more');
  assert.match(page,/api\(row\.done \? 'habits\/uncheck' : 'habits\/check'[^\n]*\), COPY\.checkFailed\);/,'the habit tick hands COPY.checkFailed over as its failure text');
  assert.match(page,/throw failure \? new Error\(failure\) : error;/);
});

test('the to-do and goals pages count days in the account\'s zone',async()=>{
  const todo=await read('app/workspace/pages/TodoPage.jsx'),goals=await read('app/workspace/pages/GoalsPage.jsx');
  for(const page of [todo,goals])assert.match(page,/const tz = state\.profile\.timezone/);
  assert.match(todo,/todoModel\(\{[^}]*\btz\b[^}]*\}\)/);
  assert.match(goals,/goalsModel\(\{[^}]*\btz\b[^}]*\}\)/);
});

test('a new goal is talked over in the chat, with its category',async()=>{
  const goals=await read('app/workspace/pages/GoalsPage.jsx');
  assert.match(goals,/sendChat\(props,\s*COPY\.goalStarter\(/);
  assert.match(goals,/navigate\('chat'\)/);
});

test('the goal box takes no more than the chat can, with the starter in front',async()=>{
  // goalWordsLimit is tested in frontend-views.test.mjs; here: the page uses it, the box applies it, and the number is
  // the server's own (POST /api/chat refuses more than 4000 characters).
  const goals=await read('app/workspace/pages/GoalsPage.jsx'),composer=await read('app/workspace/ui/Composer.jsx'),api=await read('lib/weave/api.mjs');
  assert.match(goals,/<Composer [^>]*maxLength=\{goalWordsLimit\(picked\)\}/);
  assert.match(composer,/maxLength = MESSAGE_MAX_LENGTH/,'every other box keeps the chat\'s own limit');
  assert.match(composer,/<textarea [^>]*maxLength=\{maxLength\}/);
  assert.match(api,/if\(!text\|\|text\.length>4000\)domain\.fail\(/);
});

test('a 401 is not sent to the guest URL when the site is behind the access password',async()=>{
  const workspace=await read('app/workspace/Workspace.jsx');
  assert.ok(workspace.includes("unauthorizedAction(response.headers)==='guest'"));
  assert.equal(workspace.split('/api/auth/guest/start').length-1,1,'one guest redirect, only for guest mode');
});

test('the shell no longer brings in the feature flags or the background page',async()=>{
  const imports=source=>[...source.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(match=>match[1]);
  const workspace=imports(await read('app/workspace/Workspace.jsx'));
  assert.ok(workspace.length>0,'the imports were read');
  for(const path of workspace)assert.ok(!/features(\.mjs)?$/.test(path)&&!/ProactivePanel/.test(path),'Workspace.jsx imports '+path);
  for(const [name,source] of await workspaceSources())
    for(const path of imports(source))assert.ok(!/features(\.mjs)?$/.test(path)&&!/ProactivePanel/.test(path),name+' imports '+path);
});

test('the status poll stays at once every 5 seconds',async()=>{
  // PR #24 and `npm run check:stall` are tuned to this rhythm.
  assert.match(await read('app/workspace/Workspace.jsx'),/setInterval\([\s\S]{0,200}?,\s*5000\s*\)/);
});

test('the error boundary does not show the raw error',async()=>{
  const boundary=await read('components/ErrorBoundary.jsx');
  assert.ok(boundary.includes('请刷新页面重试')&&boundary.includes('刷新页面'));
  assert.ok(!boundary.includes('error?.message')&&!boundary.includes('error.message'));
});
