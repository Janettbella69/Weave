'use client';
import {useEffect,useRef,useState} from 'react';
import ProactivePanel from './ProactivePanel';
import {CalendarDays,ChevronDown,MessageCircle,Plus,Settings,Sparkles,UserPlus,UsersRound,Brain} from 'lucide-react';
import Link from 'next/link';
import Markdown from './Markdown';
import {apiRequest,normalizeStatus,unauthorizedAction,reloadAllowed} from './api-client.mjs';
import {shouldSendOnEnter} from './chat-input.mjs';
import {beginPending,finishPending,dropSettled,visibleMessages,isReplying} from './chat-pending.mjs';
import {agentStatus} from './agent-status.mjs';
import {FEATURES,navViews} from './features.mjs';
import {NOTION_TEXT,readNotionReturn,resolveNotionReturn,waitForNotionPages,normalizePages,normalizePickerPages,notionRow} from './notion-return.mjs';
import {deviceTimezone,shouldAdoptDeviceTimezone,wallClockIn,instantFromWallClock} from './timezone.mjs';
const labels={awaiting_consent:'等待授权',awaiting_confirmation:'等待双方确认',confirmed:'已加入日程',declined:'已拒绝',no_match:'没有共同安排',cancelled:'已取消'};
const eventLabels={request:'邀请',consent:'授权',proposal:'提案',counterproposal:'反提案',reject:'时间冲突',accept:'接受',agreement:'Agent 达成一致',user_confirm:'本人确认',committed:'加入日程',no_match:'未达成一致',invalidate:'安排更新',decline:'拒绝'};
const localTime=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
const makeDraft=profile=>({...profile,slots:profile.slots.filter(x=>Date.parse(x)>Date.now()).map(localTime)});
// A 401 means the password (single-user mode) or the guest session (guest mode) is no longer accepted.
function onUnauthorized(response){
 if(unauthorizedAction(response.headers)==='guest'){window.location.href='/api/auth/guest/start?return_to='+encodeURIComponent(location.pathname+location.search);return;}
 let storage=null;try{storage=window.sessionStorage;}catch{/* storage is blocked */}
 if(reloadAllowed(storage))window.location.reload();
}
const api=(path,data)=>apiRequest(path,data,{onUnauthorized});
export default function Workspace({authKind='guest'}){
 const [state,setState]=useState(null),[view,setView]=useState('chat'),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busyCount,setBusyCount]=useState(0),[text,setText]=useState(''),[draft,setDraft]=useState(null),[inviteURL,setInviteURL]=useState(''),[join,setJoin]=useState(()=>typeof window==='undefined'||!FEATURES.collaboration?'':new URL(window.location.href).searchParams.get('join')||''),[peer,setPeer]=useState(''),[activity,setActivity]=useState('散步'),[consent,setConsent]=useState(false),[reminder,setReminder]=useState(''),[due,setDue]=useState(''),[pendings,setPendings]=useState([]);
 const bottom=useRef(null),inputRef=useRef(null),chain=useRef(Promise.resolve()),seq=useRef(0),inflight=useRef(null),again=useRef(false),composing=useRef(false),zoneTried=useRef(false),notionBack=useRef(undefined);
 const [originSuggestion,setOriginSuggestion]=useState(null);
 const [notionPages,setNotionPages]=useState([]),[notion,setNotion]=useState(null),[pickerMode,setPickerMode]=useState('complete'),[wechatCode,setWechatCode]=useState(''),[quickMenu,setQuickMenu]=useState(false);
 const replying=isReplying(pendings),busy=busyCount>0;
 // A status snapshot arrived. Local chat entries wait for one that was requested after their reply came back.
 function applyState(result,id){
  setState(result);
  setPendings(list=>dropSettled(list,id));
  // An account that still has the server's default zone and was never saved takes the browser's zone, so reminders,
  // quiet hours and the Agent's sense of "now" agree with where the person actually is.
  if(!zoneTried.current&&shouldAdoptDeviceTimezone(result.profile)){
   zoneTried.current=true;
   const profile=result.profile;
   api('profile',{...profile,timezone:deviceTimezone(),slots:profile.slots.filter(x=>Date.parse(x)>Date.now())}).then(()=>refresh({queue:true})).catch(()=>{});
  }
 }
 // One status request at a time, so a slow GET /api/status can neither pile up nor arrive out of order.
 // refresh({queue:true}) guarantees a request that starts after this call (use it after something changed).
 function refresh({queue=false}={}){
  if(inflight.current){if(queue)again.current=true;return inflight.current;}
  const id=++seq.current;
  const request=(async()=>{
   try{const result=normalizeStatus(await api('status'));if(!result)throw Error('请求失败');applyState(result,id);return result;}
   finally{inflight.current=null;if(again.current){again.current=false;refresh().catch(()=>{});}}
  })();
  inflight.current=request;
  return request;
 }
 useEffect(()=>{
  let active=true;
  refresh().catch(e=>{if(active)setError(e.message);});
  // Back from Notion: /?connection=notion&status=connected|ready|error. Read it once, then clean the address.
  if(notionBack.current===undefined)notionBack.current=readNotionReturn(window.location.search);
  const back=notionBack.current;
  if(back){
   history.replaceState(null,'','/');
   resolveNotionReturn(back,{
    getConnection:()=>api('connections/notion'),
    legacyPages:()=>waitForNotionPages(()=>api('connections/notion/pending'),{active:()=>active,isConnected:async()=>(await refresh({queue:true})).settings.notion===true}),
   }).then(outcome=>{
    if(!active)return;
    setView('settings');
    if(outcome.kind==='pick'){setPickerMode('complete');setNotionPages(outcome.pages);}
    else if(outcome.kind==='connected')setNotice(NOTION_TEXT.connected);
    else if(outcome.kind==='needs_pages')setNotion({state:'needs_pages',reason:outcome.reason});
    else setError(outcome.message);
    refresh({queue:true}).catch(()=>{});
   }).catch(e=>{if(active){setView('settings');setError(e.message);}});
  }
  return()=>{active=false;};
 },[]);
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)refresh().catch(()=>{});},5000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{if(view==='settings'&&state)loadNotion();},[view,!!state,state?.settings.notion]);
 useEffect(()=>{if(view==='chat')bottom.current?.scrollIntoView({behavior:'smooth'});},[state?.messages.length,pendings.length,replying,view]);
 async function deleteAccount(){if(!window.confirm('确定要永久删除账号吗？你的聊天、计划和日程都会被删除，无法恢复。'))return;setError('');try{await api('account/delete',{confirm:true});location.href=authKind==='guest'?'/api/auth/guest/signout?return_to=%2F':'/';}catch(e){setError(e.message);}}
 // Changes go one after another and are never dropped. They do not wait for the (possibly slow) status refresh:
 // that runs in the background after each one.
 function act(task,success=''){
  const run=async()=>{
   setBusyCount(n=>n+1);setError('');setNotice('');
   try{await task();if(success)setNotice(success);refresh({queue:true}).catch(()=>{});}
   catch(e){setError(e.message);}
   finally{setBusyCount(n=>n-1);}
  };
  const next=chain.current.then(run);
  chain.current=next;
  return next;
 }
 function go(next){setError('');setNotice('');setView(next);}
 function settings(){if(!state)return;setDraft(makeDraft(state.profile));setWechatCode('');go('settings');}
 // Where Notion stands (GET connections/notion). A failure here is not worth a banner: the row still works from the status answer.
 function loadNotion(){return api('connections/notion').then(result=>{setNotion(result);return result;}).catch(()=>null);}
 async function connectNotion(){await act(async()=>{const pending=await api('connections/notion/pending');const pages=normalizePages(pending.pages);if(pending.ready&&pages.length){setPickerMode('complete');setNotionPages(pages);return;}const result=await api('connections/notion/start');window.location.assign(result.url);});}
 // Choosing from the list: the older flow finishes the connection, "更换页面" switches the connected page.
 function pickNotionPage(pageId){return act(async()=>{
  if(pickerMode==='select')setNotion(await api('connections/notion/select',{pageId}));
  else await api('connections/notion/complete',{pageId});
  setNotionPages([]);
 },pickerMode==='select'?'':NOTION_TEXT.connected);}
 function changeNotionPage(){
  if(notionPages.length&&pickerMode==='select'){setNotionPages([]);return;}
  return act(async()=>{
   const pages=normalizePickerPages(await api('connections/notion/pages'));
   if(!pages.length)throw Error(NOTION_TEXT.failed);
   setPickerMode('select');setNotionPages(pages);
  });
 }
 // Authorized in Notion but no page yet: look again without going back to Notion.
 function retryNotion(){return act(async()=>{
  const result=await api('connections/notion/finish');
  setNotion(result);
  if(result.state!=='connected')throw Error(NOTION_TEXT.failed);
 },NOTION_TEXT.connected);}
 function openGroupComposer(){setQuickMenu(false);setView('connections');}
 function addFriend(){setQuickMenu(false);setView('connections');act(async()=>{const r=await api('friends/invite',{});setInviteURL(location.origin+'/?join='+r.token);},'好友邀请链接已生成');}
 const format=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:state?.profile.timezone||'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
 const peerName=id=>id===state?.personId?state.profile.name:state?.people.find(p=>p.id===id)?.name||'朋友';
 const unread=state?.notifications.filter(n=>!n.read).length||0;
 // Sending never waits for the status refresh: the message shows at once, a thinking bubble follows, and the reply
 // is shown as soon as the chat request returns. Nothing here is silently ignored.
 async function send(e){
  if(e&&e.preventDefault)e.preventDefault();
  const message=text.trim();
  if(!message)return;
  if(!state.settings.agent){setError('请先连接 Agent 才能使用聊天功能');return;}
  if(replying){setNotice('Agent 正在处理，请稍候…');return;}
  setError('');setNotice('');
  const entry=beginPending(state.messages,message);
  setPendings(list=>[...list,entry]);
  setText('');
  if(inputRef.current)inputRef.current.style.height='auto';
  try{
   const result=await api('chat',{text:message});
   const mark=seq.current;   // status requests numbered above this one start after the reply was stored
   setNotice('');
   setPendings(list=>finishPending(list,entry.key,result.reply,mark));
   refresh({queue:true}).catch(()=>{});
  }catch(err){
   setPendings(list=>list.filter(p=>p.key!==entry.key));
   setText(current=>current||message);
   setError(err.message);
  }
 }
 function planCard(plan){return <article className="thread-card card plan" key={plan.id}><span className="eyebrow">习惯团队 · 计划卡片</span><h3>{plan.summary}</h3><p>{plan.conflict}</p><ol>{plan.actions.map((a,i)=><li key={i}>{a}</li>)}</ol><details><summary>运动、睡眠、饮食 Agent 如何商量</summary>{plan.agents.map(a=><p key={a.role}><b>{a.role} Agent</b> · {a.proposal}</p>)}</details><div className="actions thread-actions"><button className="primary" disabled={plan.approved} onClick={()=>act(()=>api('plans/approve',{id:plan.id}),'计划已确认')}>{plan.approved?'已确认 ✓':'确认计划 ✓'}</button>{plan.notionUrl?<a className="button btn-ghost" href={plan.notionUrl} target="_blank" rel="noopener noreferrer">打开 Notion ↗</a>:(state.settings.notion||state.settings.notionConfigured!==false)&&<button className="btn-ghost" disabled={!plan.approved} onClick={()=>state.settings.notion?act(()=>api('plans/sync',{id:plan.id}),'计划已保存到你的 Notion'):settings()}>同步到 Notion ↗</button>}</div>{['sending','uncertain'].includes(plan.syncStatus)&&<p className="muted">上次同步结果待核对，请先检查 Notion 页面，避免重复创建。</p>}</article>;}
 function negotiationCard(n){return <article className="thread-card card negotiation" key={n.id}><div className="row between"><h3>和{peerName(n.participants.find(p=>p!==state.personId))}一起{n.activity}</h3><span className="chip">{labels[n.status]}</span></div>{n.candidate&&<><p className="candidate">{format(n.candidate.slot)}</p><p className="muted">30 分钟 · {state.profile.timezone}</p>{n.candidate.constraints.length>0&&<p>本次共享偏好：{n.candidate.constraints.join('；')}</p>}</>}
 <details><summary>查看提案、冲突与反提案</summary><ol className="transcript">{n.events.map(e=><li key={e.id}><span className="eyebrow">{eventLabels[e.type]||e.type} · {e.actor==='coordinator'?'协调员':peerName(e.actor)+'的 Agent'}</span><p>{e.slot&&<b>{format(e.slot)} · </b>}{e.text}</p></li>)}</ol></details>
 <div className="actions thread-actions">{n.status==='awaiting_consent'&&(n.authorized?<p className="muted">你已授权，等待对方共享本次安排。</p>:<button className="primary" onClick={()=>act(()=>api('negotiations/action',{id:n.id,action:'authorize'}),'授权已记录')}>授权并协商</button>)}
 {n.status==='awaiting_confirmation'&&<><button className="primary" disabled={!!n.confirmations[state.personId]} onClick={()=>act(()=>api('negotiations/action',{id:n.id,action:'confirm',revision:n.revision}),'确认已记录')}>{n.confirmations[state.personId]?'你已确认 ✓':'确认这个共同安排 ✓'}</button><p className="muted">{n.participants.map(p=>peerName(p)+(n.confirmations[p]?'：已确认':'：待确认')).join(' · ')}</p></>}
 {['awaiting_consent','awaiting_confirmation'].includes(n.status)&&<button type="button" className="btn-decline" onClick={()=>act(()=>api('negotiations/action',{id:n.id,action:'decline'}),'本次邀请已拒绝')}>拒绝</button>}
 {n.status==='confirmed'&&<button onClick={()=>setView('calendar')}>查看日程 →</button>}</div><small>仅本次授权的时间与活动偏好进入协商。双方本人确认后才加入日程。</small></article>;}
 if(!state)return <main className="loading"><div className="symbol">w</div><h1>正在打开你的空间…</h1>{error&&<><p role="alert">{error}</p><button onClick={()=>refresh().catch(e=>setError(e.message))}>重试</button></>}</main>;
 const agentReady=!!state.settings.agent,status=agentStatus({replying,ready:agentReady}),shown=visibleMessages(state.messages,pendings);
 const wechatShown=!!(state.settings.wechat?.configured||state.settings.wechat?.bound),row=notionRow({connection:notion,connected:!!state.settings.notion,configured:state.settings.notionConfigured});
 const form=draft||makeDraft(state.profile),zone=state.profile.timezone;
 const navIcons=navViews().map(([id,label])=>[{chat:MessageCircle,connections:UsersRound,calendar:CalendarDays,proactive:Sparkles,memory:Brain}[id],id,label]);
 return <fieldset className={'app-fieldset'+(view==='chat'?' chat-first':'')} aria-busy={busy||undefined}><nav className="workspace-rail" aria-label="主导航"><Link className="rail-logo" href="/" title="Weave" aria-label="Weave 首页">w</Link>{navIcons.map(([Icon,id,label])=><button key={id} type="button" className={view===id?'selected':''} title={label} aria-label={label} aria-current={view===id?'page':undefined} onClick={()=>go(id)}><Icon size={20} strokeWidth={1.75} aria-hidden="true"/>{id==='memory'&&unread>0&&<span className="rail-badge">{unread}</span>}</button>)}<div className="workspace-rail-bottom"><button type="button" title="个人设置" aria-label="个人设置" onClick={settings}><Settings size={18} strokeWidth={1.8}/></button><button type="button" className="rail-avatar" title={state.profile.name} aria-label={state.profile.name} onClick={settings}><b>{state.profile.name.slice(0,1)}</b></button></div></nav>
 <main className={'workspace'+(view==='chat'?' is-chat workspace-chat':'')+(view==='connections'?' is-connections':'')}><header className="shell-header"><div className="shell-title"><span className="shell-heading">{view==='settings'?'个人设置':view==='connections'?'协作':'我的 Agent'}</span>{view!=='settings'&&<span className={'agent-pill is-'+status.tone} role="status">{status.label}</span>}</div><div className="header-tools">{FEATURES.collaboration&&<div className="quick-actions"><button type="button" className="icon-button plus-button" onClick={()=>setQuickMenu(open=>!open)} aria-label="创建或添加" aria-expanded={quickMenu} title="创建或添加"><Plus size={20} strokeWidth={1.8}/></button>{quickMenu&&<><button type="button" className="quick-backdrop" aria-label="关闭菜单" onClick={()=>setQuickMenu(false)}/><div className="quick-menu" role="menu"><button type="button" role="menuitem" onClick={openGroupComposer}><span className="quick-icon"><UsersRound size={18}/></span><span><b>创建群聊</b><small>让多个 Agent 一起商量</small></span><ChevronDown className="quick-arrow" size={15}/></button><button type="button" role="menuitem" onClick={addFriend}><span className="quick-icon"><UserPlus size={18}/></span><span><b>添加好友 Agent</b><small>生成一次性邀请链接</small></span><ChevronDown className="quick-arrow" size={15}/></button></div></>}</div>}</div></header><nav className="mobile-nav">{navViews().map(([id,label])=><button key={id} className={view===id?'selected':''} onClick={()=>go(id)}>{label}</button>)}</nav>
 <div className={'content'+(view==='chat'?' content-chat':'')+(view==='connections'?' content-connections':'')}>{error&&<div className="banner error" role="alert">{error}<button type="button" onClick={()=>setError('')} aria-label="关闭错误">×</button></div>}{notice&&<p className="banner" role="status">{notice}</p>}
 {busy&&<p className="working" role="status">Agent 正在处理，请稍候…</p>}
 {FEATURES.collaboration&&join&&<article className="card invitation"><h3>收到一份朋友邀请</h3><p>接受后，双方可以发起活动协商。接受邀请不会共享你的私聊或个人时间；每次协作还需要另外授权。</p><button className="primary" onClick={()=>act(async()=>{const r=await api('friends/accept',{token:join});setJoin('');history.replaceState(null,'','/');setView('connections');setNotice('已和'+r.name+'建立朋友关系');})}>接受邀请，连接朋友</button><button onClick={()=>{setJoin('');history.replaceState(null,'','/');}}>暂时不接受</button></article>}
 {view==='chat'&&<div className="chat-shell"><div className="chat-scroll"><div className="chat-column">{!shown.length&&<section className="welcome welcome-compact"><h1>今天想聊点什么？</h1><p className="muted">说说状态、调整习惯，或记录「反馈：…」</p></section>}{!agentReady&&<div className="banner warning"><span>请先连接 Agent 才能使用聊天功能</span><button type="button" onClick={settings}>立即连接</button></div>}{FEATURES.collaboration&&agentReady&&!state.profile.slots.length&&<div className="banner banner-inline"><span>想和朋友一起行动？先添加未来可用时间。</span><button type="button" onClick={settings}>去设置</button></div>}{state.messages.length>0&&state.messages.length<3&&<div className="banner chat-tip"><span>提示：输入「反馈：…」可记录日常反馈，帮助 Agent 更了解你。</span></div>}<section className="messages" role="log" aria-label="与个人 Agent 的对话" aria-live="polite">{shown.map(m=><article key={m.id} className={'message '+m.role} data-local={m.local?'true':undefined}><small>{m.role==='user'?state.profile.name:'我的 Agent'}</small><div className={'bubble'+(m.role==='assistant'?' md':'')+(m.thinking?' thinking':'')}>{m.thinking?'Agent 正在思考…':m.role==='assistant'?<Markdown text={m.text}/>:m.text}</div>{m.planId&&state.plans.find(p=>p.id===m.planId)&&planCard(state.plans.find(p=>p.id===m.planId))}</article>)}<div ref={bottom}/></section></div></div>{!shown.length&&(<div className="suggestions suggestions-chat suggestions-near-composer"><button type="button" onClick={()=>setText('昨晚睡了5小时，今天想练腿，晚上还要聚餐，有点累。帮我调整计划。')}>调整今天的习惯计划</button>{FEATURES.collaboration&&<button type="button" onClick={()=>setView('connections')}>和朋友 Agent 商量散步</button>}<button type="button" onClick={()=>setText('反馈：今天午饭后散步5分钟，比晚上更容易坚持。')}>记录一个小进步</button></div>)}<form className="composer composer-sticky" onSubmit={send}><div className="chat-column"><label className="sr-only" htmlFor="message">发送消息</label><div className="composer-card"><textarea id="message" ref={inputRef} rows="3" maxLength="4000" value={text} onChange={e=>{setText(e.target.value);e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,200)+'px';}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{setTimeout(()=>{composing.current=false;},0);}} onKeyDown={e=>{if(shouldSendOnEnter(e,composing.current)){e.preventDefault();send(e);}}} placeholder={agentReady?'说说今天的状态，或记录「反馈：今天的小进展」…':'连接 Agent 后即可开始对话…'}/><div className="composer-bar"><button type="submit" className="primary" disabled={!text.trim()||!agentReady}>发送</button></div></div><p className="muted composer-hint">{replying?'Agent 正在思考…':'个人记忆仅用于你的建议'}</p></div></form></div>}
 {FEATURES.collaboration&&view==='connections'&&<div className="page-stack"><header className="page-hero"><h1>我的 Agent，遇见你的 Agent</h1><p className="lede">明确授权 → 独立提案 → 冲突与反提案 → 双方本人确认</p></header><div className="card-grid"><article className="card card-accent"><h2>连接真正的朋友</h2><p className="card-lead">生成一次性邀请链接，分享给朋友。对方登录并接受后，就能一起行动。</p><div className="actions card-actions"><button type="button" className="primary" onClick={()=>act(async()=>{const r=await api('friends/invite',{});setInviteURL(location.origin+'/?join='+r.token);})}>生成朋友邀请链接</button></div>{inviteURL&&<div className="share"><label>邀请链接（7 天有效，仅能接受一次）<input readOnly value={inviteURL}/></label><button type="button" onClick={()=>act(async()=>{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(inviteURL);}else{const input=document.createElement('textarea');input.value=inviteURL;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.select();document.execCommand('copy');document.body.removeChild(input);}},'已复制邀请链接')}>复制链接</button></div>}
 {!!state.invites.length&&<details className="card-details"><summary>管理有效邀请（{state.invites.length}）</summary>{state.invites.map(i=><div className="row between invite-row" key={i.id}><span className="muted">{format(i.expiresAt)} 到期</span><button type="button" onClick={()=>act(()=>api('friends/revoke',{id:i.id}),'邀请已撤销')}>撤销</button></div>)}</details>}
 <p className="muted friends-status">{state.people.length?'已连接：'+state.people.map(p=>p.name).join('、'):'还没有连接朋友。接受邀请后才能查看姓名，不公开账号目录。'}</p></article>
 {state.people.length>0&&<form className="card card-accent" onSubmit={e=>{e.preventDefault();act(async()=>{await api('negotiations/start',{peer:peer||state.people[0].id,activity,consent,suggestionId:originSuggestion});setConsent(false);setOriginSuggestion(null);},'邀请已发起，等待朋友授权');}}><h2>一起做点什么？</h2><div className="form-grid"><label>和谁一起<select value={peer||state.people[0].id} onChange={e=>setPeer(e.target.value)}>{state.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>活动<select value={activity} onChange={e=>setActivity(e.target.value)}>{['散步','运动','学习','吃饭'].map(a=><option key={a}>{a}</option>)}</select></label></div><label className="checkbox"><input type="checkbox" required checked={consent} onChange={e=>setConsent(e.target.checked)}/>我授权本次共享个人设置里的未来可用时间与活动偏好；吃饭活动也共享饮食偏好。</label><div className="actions card-actions"><button type="submit" className="primary">交给我们的 Agent</button></div></form>}</div>
 <section className="negotiation-list">{Object.values(state.negotiations).length?Object.values(state.negotiations).slice().reverse().map(negotiationCard):<p className="empty empty-card">还没有活动协商。和朋友一起计划散步、运动或吃饭吧。</p>}</section></div>}
 {view==='calendar'&&<><h1>把商量好的事，留给生活。</h1>{FEATURES.collaboration&&<><a className="button" href="/api/calendar.ics" download>导出我的日历 .ics ↓</a>{!state.calendar.length&&<p className="empty">双方本人确认后，共同安排会出现在这里。</p>}</>}{state.calendar.map(e=><article className="card" key={e.id}><h3>{format(e.slot)} · 一起{e.activity}</h3><p>{e.participants.join(' 与 ')} · {e.durationMinutes}分钟</p><button onClick={()=>act(()=>api('negotiations/action',{id:e.id,action:'cancel'}),'活动已取消，双方日程已更新')}>取消这次活动</button></article>)}
 <form className="card" onSubmit={e=>{e.preventDefault();act(async()=>{await api('reminders',{text:reminder,dueAt:(instantFromWallClock(due,zone)||new Date(due)).toISOString()});setReminder('');setDue('');},'提醒已保存');}}><h2>在合适的时候提醒我</h2><label>提醒内容<input required maxLength="500" value={reminder} onChange={e=>setReminder(e.target.value)} placeholder="放下手机，准备休息"/></label><label>时间<input type="datetime-local" required value={due} min={wallClockIn(Date.now(),zone)} onChange={e=>setDue(e.target.value)}/></label><button type="submit" className="primary" disabled={!reminder||!due}>设置提醒</button><p className="muted">提醒保存在账户中，到期后进入通知与聊天。网页打开时自动刷新通知。</p></form>
 {state.reminders.slice().reverse().map(r=><article className="card row between" key={r.id}><div><h3>{r.text}</h3><p className="muted">{format(r.dueAt)} · {({scheduled:'待提醒',delivered:'已提醒',cancelled:'已取消'})[r.status]}</p></div>{r.status==='scheduled'&&<button onClick={()=>act(()=>api('reminders/cancel',{id:r.id}),'提醒已取消')}>取消提醒</button>}</article>)}</>}
 {FEATURES.proactive&&view==='proactive'&&<ProactivePanel request={api} act={act} profile={state.profile} hasModel={state.settings.agent} onInvite={s=>{setPeer(s.proposal.peerId);setActivity(s.proposal.activity);setConsent(false);setOriginSuggestion(s.id);setView('connections');}}/>}
 {view==='memory'&&<><h1>属于你的长期记忆。</h1><div className="card"><h2>目标与偏好</h2><p>{state.profile.goal||'尚未设置目标'}</p><p>{state.profile.preferences||'尚未记录偏好'}</p><button onClick={settings}>更新目标与偏好</button></div><div className="card"><h2>日常反馈</h2>{state.checkins.length?state.checkins.slice().reverse().map(x=><p key={x.id}>{x.text}</p>):<p>聊天中输入“反馈：今天的小进展”，让下一次建议更贴近你的生活。</p>}</div><div className="card"><div className="row between"><h2>通知 {unread>0&&'· '+unread+'条未读'}</h2>{unread>0&&<button onClick={()=>act(()=>api('notifications/read',{}))}>全部已读</button>}</div>{state.notifications.slice().reverse().map(n=><p key={n.id}>{n.read?'':'● '}{n.text}<small>{format(n.createdAt)}</small></p>)}{!state.notifications.length&&<p>还没有通知。</p>}</div><a className="button" href="/api/export" download="weave-personal-data.json">导出我的个人数据 ↓</a></>}
 {view==='settings'&&<><h1>连接你的工作方式。</h1><p className="muted">所有连接都由你授权。Weave 只显示连接状态，不显示密钥或部署配置。</p><div className="channels-card"><div className="channel-list">
 {row.shown&&<div className={'channel-row'+(state.settings.notion||row.needsPages?' wide':'')}><span className="channel-icon notion-mark">N</span><span className="channel-copy"><b>Notion</b><small>长期记忆与计划归档</small>{row.title&&<small>{'页面：'+row.title}</small>}{row.note&&<small className="channel-note">{row.note}</small>}</span>{state.settings.notion?<><span className="channel-status connected">已连接</span><button type="button" onClick={changeNotionPage}>更换页面</button><button type="button" onClick={()=>act(async()=>{await api('connections/notion/disconnect');setNotionPages([]);setNotion(null);},'Notion 已断开')}>断开</button></>:<>{row.needsPages&&<button type="button" onClick={retryNotion}>重试</button>}<button type="button" className="channel-connect" onClick={connectNotion}>连接</button></>}</div>}
 {notionPages.length>0&&<div className="channel-picker"><p>选择用于 Weave 长期记忆的页面</p>{notionPages.map(page=><button type="button" key={page.id} disabled={page.selected} onClick={()=>pickNotionPage(page.id)}><b>{page.title}</b><span>{page.selected?'已连接':'选择此页面'}</span></button>)}</div>}
 {wechatShown&&<div className="channel-row"><span className="channel-icon wechat-mark">⌕</span><span className="channel-copy"><b>微信</b><small>聊天与到期提醒</small></span>{state.settings.wechat?.bound?<><span className="channel-status connected">已连接</span><button type="button" onClick={()=>act(()=>api('wechat/unbind',{}),'微信已断开')}>断开</button></>:<button type="button" className="channel-connect" disabled={!state.settings.wechat?.configured} onClick={()=>act(async()=>{const r=await api('wechat/bind',{});setWechatCode(r.code);},'绑定码已生成')}>连接</button>}</div>}
 {wechatCode&&<div className="channel-pairing"><b>在微信中发送：绑定 {wechatCode}</b><button type="button" onClick={()=>navigator.clipboard?.writeText('绑定 '+wechatCode)}>复制绑定消息</button><small>绑定码 15 分钟内有效，只能绑定当前账号。</small></div>}
 <div className="channel-row"><span className="channel-icon agent-mark">w</span><span className="channel-copy"><b>我的 Agent</b><small>习惯建议与主动提醒</small></span><span className={'channel-status'+(agentReady?' connected':'')}>{status.rowLabel}</span>{(!agentReady||state.agentRuntime==='user')&&<button type="button" className="channel-connect" onClick={()=>act(()=>api('connections/agent/start'),'Agent 已连接')}>{agentReady?'测试':'连接'}</button>}</div>
 </div></div>
 {state.agentRuntime==='user'&&<div id="agent-connection" className="card connection-card"><h2>我的 Agent</h2><p>Agent 连接由安全服务处理。点击上面的连接按钮即可开始使用。你的消息和相关资料会发给 DeepSeek 生成回复。</p>{state.settings.agent&&<div className="actions"><button type="button" className="primary" onClick={()=>act(()=>api('connections/agent/start'),'Agent 连接测试成功')}>测试连接</button><button type="button" onClick={()=>act(()=>api('settings',{disconnect:true}),'Agent 已断开')}>断开</button></div>}</div>}
 {wechatShown&&<div className="card"><h2>微信通道</h2><p>微信绑定已准备好。点击“连接”后，在微信中发送一次性绑定消息。</p></div>}
 <div className="card"><h2>你的数据</h2><p>你的资料保存在 Weave 的服务器上，你的消息和相关资料会发给 DeepSeek 生成回复。详情见<a className="inline-link" href="/privacy">隐私说明</a>。</p><div className="actions"><a className="button" href="/api/export" download="weave-export.json">导出全部数据</a><button type="button" onClick={deleteAccount}>永久删除账号</button></div></div>
 {form&&<form className="card" onSubmit={e=>{e.preventDefault();act(()=>api('profile',{...form,slots:form.slots.filter(Boolean).map(x=>new Date(x).toISOString())}),'个人安排已保存');}}><h2>目标与偏好</h2><label>我的名字<input required maxLength="30" value={form.name} onChange={e=>setDraft({...form,name:e.target.value})}/></label><label>习惯目标<textarea maxLength="1000" value={form.goal} onChange={e=>setDraft({...form,goal:e.target.value})}/></label><label>个人偏好<textarea maxLength="1000" value={form.preferences} onChange={e=>setDraft({...form,preferences:e.target.value})} placeholder="例如：午饭后更容易运动；不吃猪肉"/></label><label>日程显示时区<input value={form.timezone} onChange={e=>setDraft({...form,timezone:e.target.value})} list="timezones"/><datalist id="timezones">{['Asia/Shanghai','America/Los_Angeles','Asia/Tokyo','Europe/London','UTC',Intl.DateTimeFormat().resolvedOptions().timeZone].map((tz,i)=><option key={i}>{tz}</option>)}</datalist></label>{FEATURES.collaboration&&<><p className="muted">可用时间按设备时区 {Intl.DateTimeFormat().resolvedOptions().timeZone} 输入，自动换算保存。每次活动30分钟。</p><div className="choices">{['散步','运动','学习','吃饭'].map(a=><label className="checkbox" key={a}><input type="checkbox" checked={form.activities.includes(a)} onChange={e=>setDraft({...form,activities:e.target.checked?[...form.activities,a]:form.activities.filter(x=>x!==a)})}/>{a}</label>)}</div>{form.slots.map((slot,i)=><div key={i} className="row"><label className="sr-only" htmlFor={'slot-'+i}>可用时间{i+1}</label><input id={'slot-'+i} required type="datetime-local" value={slot} min={localTime(Date.now())} onChange={e=>setDraft({...form,slots:form.slots.map((x,j)=>j===i?e.target.value:x)})}/><button type="button" onClick={()=>setDraft({...form,slots:form.slots.filter((_,j)=>j!==i)})}>移除</button></div>)}</>}<div className="actions">{FEATURES.collaboration&&<button type="button" disabled={form.slots.length>=20} onClick={()=>setDraft({...form,slots:[...form.slots,'']})}>添加空闲时间 ＋</button>}<button type="submit" className="primary">保存个人安排</button></div>{FEATURES.collaboration&&<p className="muted">保存会撤销进行中协商的旧授权与确认。双方已确认的活动保留。</p>}</form>}</>}
 </div>{view!=='chat'&&<footer className="app-footer">Weave · 由你授权，由你决定。{view!=='settings'&&<span> · {state.profile.timezone}</span>}{authKind==='chatgpt'?<> · <a href="/signout-with-chatgpt?return_to=%2F" target="_top">退出登录</a></>:authKind==='guest'?<> · <span className="muted">访客模式</span> · <a href="/api/auth/guest/signout?return_to=%2F">退出（之后找不回这个空间，要删除数据请先到设置）</a></>:null}</footer>}</main></fieldset>;
}
