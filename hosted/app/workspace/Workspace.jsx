'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {apiRequest,normalizeStatus,unauthorizedAction,reloadAllowed} from './api-client.mjs';
import {readView,viewSearch,hasTopBar} from './view-route.mjs';
import {NOTION_TEXT,readNotionReturn,resolveNotionReturn,waitForNotionPages} from './notion-return.mjs';
import {beginPending,finishPending,dropSettled} from './chat-pending.mjs';
import {formatHeaderShort} from './dates.mjs';
import {COPY} from './copy.mjs';
import Nav from './ui/Nav';
import Avatar from './ui/Avatar';
import ViewLink from './ui/ViewLink';
import ChatPage from './pages/ChatPage';
import FirstRun from './pages/FirstRun';
import TodoPage from './pages/TodoPage';
import GoalsPage from './pages/GoalsPage';
import RecordsPage from './pages/RecordsPage';
import SettingsPage from './pages/SettingsPage';
import AgentPage from './pages/AgentPage';

// The workspace shell: it loads /api/status and keeps it fresh, remembers which page is open, and draws the navigation
// around that page. Everything a page shows is the page's own (one component per page).

// A 401 means the password (single-user mode) or the guest session (guest mode) is no longer accepted.
function onUnauthorized(response){
 if(unauthorizedAction(response.headers)==='guest'){window.location.href='/api/auth/guest/start?return_to='+encodeURIComponent(location.pathname+location.search);return;}
 let storage=null;try{storage=window.sessionStorage;}catch{/* storage is blocked */}
 if(reloadAllowed(storage))window.location.reload();
}
const api=(path,data)=>apiRequest(path,data,{onUnauthorized});

// The page of each view. Every page gets the same props:
//   {state, api, act, refresh, navigate, authKind, chat}
//   state     the last /api/status answer, through normalizeStatus. A page only shows once there is one.
//   api       (path, body?) => Promise of the answer: a call to /api/<path>, with the 401 handling above.
//   act       (task, notice?) => Promise: runs `task` after the changes before it. When it worked: shows `notice` and
//             refreshes in the background; when it failed: shows the error in the banner. It never rejects.
//   refresh   ({queue}?) => Promise of the status. One request at a time; {queue:true} makes sure another one starts
//             after the one in flight, so a change just made shows up.
//   navigate  (view) => opens that page and keeps it in the address (?view=…).
//   authKind  'chatgpt' | 'guest' | 'single'
//   chat      what is on its way to Weave, and the chat's box, kept here so a change of page loses neither (chat-send.mjs
//             sends with it): {pendings, begin, finish, cancel, restore, draft, setDraft}
//             pendings  the entries of chat-pending.mjs. begin(text) -> entry; finish(entry, reply); cancel(entry, error)
//             takes the entry off and shows the error; restore(text) puts a text that did not go out back in the box,
//             unless something new was typed there; draft / setDraft are the box's text.
// The settings page also gets `notionReturn`: what a return from Notion left for it to show (see the first effect).
// A page renders inside the shell's <main> (which scrolls), so it brings no <main> of its own. Every view has its page.
const PAGES={chat:ChatPage,todo:TodoPage,goals:GoalsPage,records:RecordsPage,settings:SettingsPage,agent:AgentPage};
// The chat of someone who has no habits and has never written anything opens on the first-run screen, until a first
// message is on its way: then the chat shows it, with the thinking bubble, at once.
const FIRST_RUN=FirstRun;
const isFirstRun=(state,pendings)=>state.habits.length===0&&state.messages.length===0&&pendings.length===0;

export default function Workspace({authKind='guest'}){
 // `view` stays null until the address has been read, after the first render, so the server and the browser draw the same.
 const [state,setState]=useState(null),[view,setView]=useState(null),[loadFailed,setLoadFailed]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busyCount,setBusyCount]=useState(0),[notionReturn,setNotionReturn]=useState(null);
 const [pendings,setPendings]=useState([]),[draft,setDraft]=useState('');
 const chain=useRef(Promise.resolve()),inflight=useRef(null),again=useRef(false),entry=useRef(undefined),seq=useRef(0),latest=useRef(null);

 // A status snapshot arrived; `id` is the number of its request. A message that was on its way leaves the screen once a
 // snapshot requested after its reply came back is in (chat-pending.mjs): from then on the server's copy shows.
 const applyState=useCallback((result,id)=>{latest.current=result;setState(result);setLoadFailed(false);setPendings(list=>dropSettled(list,id));},[]);
 // One status request at a time, so a slow GET /api/status can neither pile up nor arrive out of order.
 // refresh({queue:true}) guarantees a request that starts after this call (use it after something changed).
 const refresh=useCallback(function refresh({queue=false}={}){
  if(inflight.current){if(queue)again.current=true;return inflight.current;}
  const id=++seq.current;
  const request=(async()=>{
   try{const result=normalizeStatus(await api('status'));if(!result)throw Error('请求失败');applyState(result,id);return result;}
   finally{inflight.current=null;if(again.current){again.current=false;refresh().catch(()=>{});}}
  })();
  inflight.current=request;
  return request;
 },[applyState]);
 // Opening a page keeps it in the address, so a reload lands on it again. Like every switch of page, it clears the banner.
 const navigate=useCallback(next=>{
  setError('');setNotice('');
  if(next!=='settings')setNotionReturn(null);
  setView(next);
  history.replaceState(null,'',location.pathname+viewSearch(next));
 },[]);
 // Changes go one after another and are never dropped. They do not wait for the (possibly slow) status refresh:
 // that runs in the background after each one.
 const act=useCallback((task,success='')=>{
  const run=async()=>{
   setBusyCount(n=>n+1);setError('');setNotice('');
   try{await task();if(success)setNotice(success);refresh({queue:true}).catch(()=>{});}
   catch(e){setError(e.message);}
   finally{setBusyCount(n=>n-1);}
  };
  const next=chain.current.then(run);
  chain.current=next;
  return next;
 },[refresh]);

 useEffect(()=>{
  let active=true;
  // The address is read once; a second run of this effect (React's development mode) works from the same reading.
  if(entry.current===undefined){const search=window.location.search;entry.current={back:readNotionReturn(search),view:readView(search)};}
  const {back}=entry.current;
  // Back from Notion (/?connection=notion&status=connected|ready|error): it always lands on settings.
  setView(back?'settings':entry.current.view);
  // The first load is the one place where a failed status request shows (with a retry button).
  refresh().catch(()=>{if(active)setLoadFailed(true);});
  if(back){
   history.replaceState(null,'',location.pathname+viewSearch('settings'));
   resolveNotionReturn(back,{
    getConnection:()=>api('connections/notion'),
    legacyPages:()=>waitForNotionPages(()=>api('connections/notion/pending'),{active:()=>active,isConnected:async()=>(await refresh({queue:true})).settings.notion===true}),
   }).then(outcome=>{
    if(!active)return;
    navigate('settings');
    if(outcome.kind==='connected')setNotice(NOTION_TEXT.connected);
    // 'pick' carries the pages to choose from, 'needs_pages' the reason: the settings page shows them.
    else if(outcome.kind==='pick'||outcome.kind==='needs_pages')setNotionReturn(outcome);
    else setError(outcome.message);
    refresh({queue:true}).catch(()=>{});
   }).catch(e=>{if(active){navigate('settings');setError(e.message);}});
  }
  return()=>{active=false;};
 },[refresh,navigate]);
 // Every 5 seconds while the tab is in view, and at once when it comes back into view. A failure here stays quiet:
 // the next round tries again.
 useEffect(()=>{
  const poll=()=>{if(!document.hidden)refresh().catch(()=>{});};
  const timer=setInterval(poll,5000);
  document.addEventListener('visibilitychange',poll);
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',poll);};
 },[refresh]);

 // Sending to Weave (chat-send.mjs), as the old chat's send did: the text shows at once and the banner clears, and the
 // reply stays on screen until a status request that started after it came back is in. A send does not go through
 // `act`: a reply can take a while, and a change made meanwhile (a tick in 待办) should not wait for it.
 const chat=useMemo(()=>({
  pendings,draft,setDraft,
  begin:text=>{const item=beginPending(latest.current?latest.current.messages:[],text);setError('');setNotice('');setPendings(list=>[...list,item]);return item;},
  // The status requests numbered above `mark` start after the reply was stored; the next one is asked for here.
  finish:(item,reply)=>{const mark=seq.current;setPendings(list=>finishPending(list,item.key,reply,mark));refresh({queue:true}).catch(()=>{});},
  cancel:(item,failure)=>{setPendings(list=>list.filter(p=>p.key!==item.key));if(failure)setError(failure.message);},
  restore:text=>setDraft(current=>current||text),
 }),[pendings,draft,refresh]);

 const retry=()=>{setLoadFailed(false);refresh().catch(()=>setLoadFailed(true));};
 const firstRun=!!state&&view==='chat'&&!!FIRST_RUN&&isFirstRun(state,pendings);
 const Page=state&&(firstRun?FIRST_RUN:PAGES[view]);
 // Until the first status arrives the navigation stands alone, with an empty page next to it.
 return <div className="wv">
  <Nav view={view} onNavigate={navigate} name={state?state.profile.name:''}/>
  <div className="wv-body">
   {/* On a phone: the bar at the top (view-route.mjs says which pages have it; the first run does, the chat does not) */}
   {hasTopBar(view,{firstRun})&&<header className="wv-topbar">
    <ViewLink view="agent" navigate={navigate} className="wv-topbar-brand" aria-label={COPY.openAgent}><Avatar size={32}/><span>{COPY.brand}</span></ViewLink>
    {state&&state.today&&<span className="wv-topbar-date">{formatHeaderShort(state.today)}</span>}
   </header>}
   <p className="wv-banner is-error" role="alert">{error}</p>
   <p className="wv-banner" role="status">{notice}</p>
   <main className="wv-main" key={view||''} aria-busy={busyCount>0||(!state&&!loadFailed)||undefined}>
    {Page?<Page state={state} api={api} act={act} refresh={refresh} navigate={navigate} authKind={authKind} chat={chat} {...(view==='settings'?{notionReturn}:null)}/>
     :!state&&loadFailed?<div className="wv-load-failed"><p role="alert">{COPY.loadFailed}</p><button type="button" className="wv-button is-primary" onClick={retry}>{COPY.retry}</button></div>
     :null}
   </main>
  </div>
 </div>;
}
