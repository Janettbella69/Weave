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

test('the records page counts days in the account\'s zone and turns months only where the status answer reaches',async()=>{
  const page=await read('app/workspace/pages/RecordsPage.jsx');
  assert.match(page,/const tz = state\.profile\.timezone, today = state\.today/);
  for(const name of ['monthModel','recentNotes','monthBounds'])assert.match(page,new RegExp(name+'\\(\\{[^}]*\\btz\\b[^}]*\\btoday\\b|'+name+'\\(\\{[^}]*\\btoday\\b[^}]*\\btz\\b'),name+' gets the zone and the day');
  assert.match(page,/COPY\.earliest/,'the first month says why there is nothing before it');
});

test('the records calendar has only 做到了 / 没做 / 还没开始: today has no mark of its own',async()=>{
  // v3-Records and spec §3.4 draw no ring and say no 「今天」 on the calendar; today's cell is drawn by its kind.
  const page=await read('app/workspace/pages/RecordsPage.jsx'),css=await read('app/globals.css');
  assert.match(page,/const SAID = \{done: COPY\.done, missed: COPY\.missed, before: COPY\.notStarted\};/);
  assert.ok(!/is-today|COPY\.today/.test(page),'no today ring, no 「今天」 reading');
  assert.ok(!/\.wv-cal-day\.is-today/.test(css));
});

test('the settings page saves the zone that was picked, with the whole profile, and never the browser\'s',async()=>{
  const page=await read('app/workspace/pages/SettingsPage.jsx');
  assert.match(page,/api\('profile', profileForSave\(/);
  assert.match(page,/zoneOptions\(/);
  assert.ok(!/Intl\.DateTimeFormat\(\)/.test(page),'the browser\'s zone is not read here');
});

test('the settings page keeps export, the privacy page and deleting the account as they were',async()=>{
  const page=await read('app/workspace/pages/SettingsPage.jsx');
  assert.match(page,/href="\/api\/export"/);
  assert.match(page,/href="\/privacy"/);
  assert.match(page,/window\.confirm\(COPY\.deleteConfirm\)/,'deleting asks first, with the old question');
  assert.match(page,/api\('account\/delete', \{confirm: true\}\)/);
  assert.match(page,/authKind === 'guest' \? '\/api\/auth\/guest\/signout\?return_to=%2F' : '\/'/,'a guest is signed out, anyone else goes home');
});

test('the assistant\'s home page: reminders in the account\'s zone, memory read when its tab opens and drawn as Markdown',async()=>{
  const page=await read('app/workspace/pages/AgentPage.jsx');
  const tab=await read('app/workspace/pages/ProactiveReminders.jsx'),view=await read('app/workspace/proactive-view.mjs');
  assert.match(page,/const tz = state\.profile\.timezone, today = state\.today/);
  assert.match(page,/<ProactiveReminders state=\{state\} api=\{api\} act=\{act\} refresh=\{refresh\} tz=\{tz\} today=\{today\}\/>/,'the 提醒 tab gets the account\'s zone and day');
  assert.ok(!/function Reminders\(|REPEATING|notLive/.test(page),'the block-one tab is gone');
  assert.match(tab,/reminderGroups\(\{[^}]*\bnow, tz, today\}\)/);
  assert.match(view,/formatDue\([^)]*, tz, today\)/,'when a one-off row is due, next to the person\'s day');
  assert.match(view,/upcomingReminders\(\{/,'the one-off reminders by the same rule as 待办\'s 之后');
  assert.match(view,/removeAction: 'reminders\/cancel'/);assert.match(view,/removeAction: 'schedules\/cancel'/);
  // every change waits for the ones before it, and a clash with Weave writing at the same moment is tried once more
  assert.match(tab,/retryOnConflict\(\(\) => api\(item\.removeAction, \{id: item\.id\}\), refresh\)/);
  assert.match(tab,/api\('schedules\/pause', \{id: item\.id, paused: !item\.paused\}\)/);
  assert.match(tab,/api\('proactive\/level', \{level\}\)/);
  assert.match(tab,/answer = await retryOnConflict\(change, refresh\);/);
  assert.equal(tab.split('act(async').length-1,2,'the delete, and the press of the dial or of a pause button');
  assert.match(page,/api\('agent-memory'\)/);
  assert.match(page,/^import Markdown from '\.\.\/Markdown';$/m);
  assert.match(page,/<Markdown text=\{[^}]+\}\/>/);
  // three tabs, 动态 first and open at first
  assert.match(page,/const TABS = \[\['activity', COPY\.activityTab, List\], \['reminders', COPY\.remindersTab, Clock\], \['memory', COPY\.memoryTab, NotepadText\]\];/);
  assert.match(page,/useState\('activity'\)/);
  assert.match(page,/aria-pressed=\{tab === id\}/);
  assert.match(page,/<ActivityList state=\{state\} tz=\{tz\} today=\{today\}\/>/,'动态 in the account\'s zone and day');
  assert.match(page,/<ViewLink view="chat"/,'its own way back to the chat');
});

test('the memory tab is the file MEMORY.md, read-only: its name on top and what is in it as Markdown, nothing of our own',async()=>{
  const page=await read('app/workspace/pages/AgentPage.jsx');
  const memory=page.slice(page.indexOf('function Memory('));
  assert.ok(memory.length>0&&memory.length<page.length,'the memory tab is found');
  assert.match(memory,/<h2 id=\{fileId\} className="wv-memory-file-name"><FileText [^>]*\/>\{COPY\.memoryFile\}<\/h2>/);
  assert.match(memory,/<div className="wv-memory-text"><Markdown text=\{memory\.text\}\/><\/div>/,'the file\'s text as it is, through Markdown');
  assert.match(memory,/COPY\.memoryIntro/);assert.match(memory,/COPY\.memoryEmpty/);assert.match(memory,/COPY\.retry/);
  // one read and no writes: the page asks for the file and nothing else, and has no box to type in
  assert.deepEqual([...page.matchAll(/api\('([^']+)'/g)].map(match=>match[1]),['agent-memory']);
  assert.ok(!/<textarea|<input|contentEditable|\.split\(/.test(memory),'no editing, and no memory cut up into items of our own');
});

test('on a wide screen the assistant\'s home page is a panel beside the chat; elsewhere the avatar opens it as a view',async()=>{
  const chat=await read('app/workspace/pages/ChatPage.jsx'),side=await read('app/workspace/pages/AgentSide.jsx'),page=await read('app/workspace/pages/AgentPage.jsx');
  // one body in two places
  assert.match(page,/export function AgentBody\(/);
  assert.match(page,/<AgentBody state=\{state\} api=\{api\} act=\{act\} refresh=\{refresh\}\/>/);
  assert.match(side,/<AgentBody state=\{state\} api=\{api\} act=\{act\} refresh=\{refresh\} compact\/>/);
  // the avatar: where there is room, a button that shows or hides the panel in place; elsewhere the link to the view,
  // which the back gesture leaves
  assert.match(chat,/side\.wide\s*\? <button [^>]*aria-expanded=\{side\.open\}[^>]*onClick=\{side\.toggle\}/);
  assert.match(chat,/: <ViewLink view="agent" navigate=\{navigate\} className="wv-agent-link" aria-label=\{COPY\.openAgent\}>/);
  assert.match(chat,/\{side\.shown && <AgentSide side=\{side\} /);
  assert.ok(!/navigate|pushState|replaceState|location/.test(side),'the panel opens nothing and changes no address');
  // one width for the script and the styles; the closed panel is remembered with the storage behind try/catch
  assert.match(await read('app/workspace/side-panel.mjs'),/PANEL_MEDIA = '\(min-width: 1200px\)'/);
  assert.match(await read('app/globals.css'),/\.wv-side\{display:none\}\s*@media\(min-width:1200px\)\{\s*\.wv-side\{/);
  assert.match(side,/readPanelOpen\(storage\(\)\)/);assert.match(side,/writePanelOpen\(storage\(\), next\)/);
  assert.match(side,/try \{ return typeof window === 'undefined' \? null : window\.localStorage; \} catch \{ return null; \}/);
});

test('every view has its page now, and the assistant\'s home page is not a tab',async()=>{
  const workspace=await read('app/workspace/Workspace.jsx');
  assert.match(workspace,/const PAGES=\{chat:ChatPage,todo:TodoPage,goals:GoalsPage,records:RecordsPage,settings:SettingsPage,agent:AgentPage\};/);
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
  const firstRun=await read('app/workspace/pages/FirstRun.jsx');
  assert.match(goals,/<Composer [^>]*maxLength=\{goalWordsLimit\(picked\)\}/);
  // maxLength only stops typing; the words typed for another category stay in the box through 换一个, so the send cuts them.
  assert.match(goals,/sendChat\(props, COPY\.goalStarter\(CATEGORY_LABEL\[picked\], words\.slice\(0, goalWordsLimit\(picked\)\)\)\)/);
  assert.match(composer,/maxLength = MESSAGE_MAX_LENGTH/,'every other box keeps the chat\'s own limit');
  assert.match(firstRun,/maxLength=\{MESSAGE_MAX_LENGTH\}/,'the first run\'s own line too');
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
