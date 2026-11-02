// Notion 一键连接的后端：用户在 Notion 同意之后回到 Weave，到这里为止就已经连好了，不再让用户自己选页面。
// api.mjs 只负责把路由接到这里。规则：
// - 同意时用户在 Notion 自己的页面选择器里勾选了页面（https://developers.notion.com/docs/authorization），
//   所以 Weave 只用这些页面。勾了一个就用它；勾了好几个就按 chooseDefaultPage 选一个，之后可以改；一个都没勾就明确告诉前端。
// - token 在这里加密后存进本人的设置，不进浏览器，不进日志。
// - 回调永远 303 回到网站（成功和失败都是），失败带 detail，页面不会空白。
import {withWorld} from './store.mjs';
import {Store} from './store.mjs';
import {hash,seal,unseal} from './crypto.mjs';
import {fail} from './domain.mjs';
import {NotionClient,exchangeNotionOAuth,scrubNotionError,sameNotionId as sameId} from './notion.mjs';

const STATE_PREFIX='notion-oauth:',PENDING_PREFIX='notion-pending:';
const PENDING_MS=15*60*1000;
const PAGE_ID=/^[a-f0-9-]{32,36}$/i;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const validSecret=secret=>typeof secret==='string'&&/^[a-f0-9]{64}$/i.test(secret);

// ---- 运行时记录（OAuth 的 state、没有页面可用时留着的授权）----
const isNotionKey=key=>key.startsWith(STATE_PREFIX)||key.startsWith(PENDING_PREFIX);
// 过期的记录没人清，每次开始连接时顺手扫掉。
export function sweepNotionRuntime(world,now){for(const [key,value] of Object.entries(world.runtime||{}))if(isNotionKey(key)&&!(value?.expiresAt>now))delete world.runtime[key];}
// 断开连接时，这个人所有没用完的授权记录一起删掉，免得旧的待选页面又冒出来。
export function forgetNotionRuntime(world,ownerId){for(const [key,value] of Object.entries(world.runtime||{}))if(isNotionKey(key)&&value?.ownerId===ownerId)delete world.runtime[key];}
export function clearNotionSettings(settings){for(const name of ['notionToken','notionPageId','notionPage','notionConnectedAt','notionWorkspace'])delete settings[name];}
function latestPending(world,ownerId,now){
 let latest=null;
 for(const [key,value] of Object.entries(world.runtime||{}))if(key.startsWith(PENDING_PREFIX)&&value?.ownerId===ownerId&&value.expiresAt>now&&(!latest||value.expiresAt>latest.value.expiresAt))latest={key,value};
 return latest;
}

// ---- 选默认页面 ----
// 「顶层」页面 = 不是另一个已分享页面的子页面，也就是用户在选择器里亲手勾的那些。
// 勾了一个父页面，它下面所有子页面也都搜得到，不能把子页面当成用户的选择。数据库里的行只有在别的都没有时才算。
export function topLevelPages(pages){
 const ids=new Set(pages.map(page=>page.id));
 const roots=pages.filter(page=>!(page.parentId&&ids.has(page.parentId)));
 const real=roots.filter(page=>page.parentType!=='database_id');
 return real.length?real:roots;
}
// 规则：顶层页面里，标题带 weave（不分大小写）的优先，没有就选最近编辑的。用户之后可以在设置里换。
export function chooseDefaultPage(pages){
 const ranked=[...topLevelPages(pages)].sort((a,b)=>String(b.editedAt||'').localeCompare(String(a.editedAt||'')));
 return ranked.find(page=>/weave/i.test(page.title))||ranked[0]||pages[0]||null;
}

// ---- 给前端看的状态 ----
// state: connected | disconnected | needs_pages（授权了但没有可用的页面，带 reason）| unavailable（网站没配置 Notion）
export function connectionState(world,person,ownerId,config,now){
 const settings=person.settings||{};
 if(settings.notionToken&&settings.notionPageId){
  const title=settings.notionPage&&sameId(settings.notionPage.id,settings.notionPageId)?settings.notionPage.title:'';
  return {state:'connected',page:{title:title||''},...(settings.notionWorkspace?{workspace:settings.notionWorkspace}:{})};
 }
 const pending=latestPending(world,ownerId,now);
 if(pending)return {state:'needs_pages',reason:pending.value.reason||(pending.value.pages?.length?'not_finished':'no_pages')};
 if(!config?.clientId||!config?.clientSecret||!config?.redirectUri)return {state:'unavailable'};
 return {state:'disconnected'};
}

async function connectedClient(person,ownerId,{secret,fetcher,apiProxy}){
 const settings=person.settings||{};
 if(!settings.notionToken||!settings.notionPageId)fail('请先连接 Notion',428);
 return new NotionClient({token:await unseal(settings.notionToken,secret,ownerId),pageId:settings.notionPageId,fetcher,apiProxy});
}
function notionProblem(error){
 const status=error?.notionStatus;
 if(status===401||status===403)fail('Notion 的授权已失效，请重新连接 Notion',428);
 fail('Notion 暂时连不上，请稍后重试',502);
}

// 搜页面。刚授权完 Notion 的搜索索引可能还没跟上（搜到 0 个），出错也可能只是一时的，所以最多再试两次，总共不超过约 9 秒。
async function listWithRetry(client,{retries=2,delayMs=1200,budgetMs=9000}={}){
 const started=Date.now();let last;
 for(let attempt=0;attempt<=retries;attempt++){
  if(attempt){if(Date.now()-started+delayMs>budgetMs)break;await sleep(delayMs);}
  try{const pages=await client.listPages();last={pages};if(pages.length)return pages;}catch(error){last={error};}
 }
 if(last?.error)throw last.error;
 return last?.pages||[];
}

// 授权结果落到这个人身上：有页面就连好；没有就把 token 留着（加密），等 finish 重试。
function settle(world,person,ownerId,{sealed,pages,searchFailed,workspace,pendingKey,now}){
 for(const [key,value] of Object.entries(world.runtime))if(key.startsWith(PENDING_PREFIX)&&value?.ownerId===ownerId)delete world.runtime[key];
 const previous=person.settings.notionPageId&&pages.find(page=>sameId(page.id,person.settings.notionPageId));
 const page=pages.length?(previous||chooseDefaultPage(pages)):null;
 if(page){
  person.settings.notionToken=sealed;person.settings.notionPageId=page.id;person.settings.notionPage={id:page.id,title:page.title};person.settings.notionConnectedAt=now;
  if(workspace)person.settings.notionWorkspace=String(workspace).slice(0,100);else delete person.settings.notionWorkspace;
  return {connected:true,page};
 }
 const reason=searchFailed?'search_failed':'no_pages';
 world.runtime[pendingKey]={ownerId,token:sealed,pages:[],reason,...(workspace?{workspace:String(workspace).slice(0,100)}:{}),expiresAt:now+PENDING_MS};
 return {connected:false,reason};
}

// ---- 回调：Notion 同意之后浏览器回到这里 ----
function redirectBack(request,config,status,detail){
 const requestURL=new URL(request.url);
 let origin='';
 // 配了公开地址就用它：回调本来就是 Notion 按这个地址跳回来的，不依赖 nginx 有没有带对 Host 和 X-Forwarded-Proto。
 try{const configured=new URL(config?.publicOrigin||'');if(configured.protocol==='https:'||configured.protocol==='http:')origin=configured.origin;}catch{/* 没配置 */}
 if(!origin){
  const forwarded=(request.headers.get('x-forwarded-proto')||'').split(',')[0].trim().toLowerCase();
  origin=`${forwarded==='https'||requestURL.protocol==='https:'?'https':'http'}://${request.headers.get('host')||requestURL.host}`;
 }
 const location=`${origin}/?connection=notion&status=${status}${detail?`&detail=${encodeURIComponent(detail)}`:''}`;
 return new Response(null,{status:303,headers:{Location:location,'Cache-Control':'no-store'}});
}

export async function notionCallback(request,{db,secret,fetcher=fetch,notionOAuth,now=Date.now()}){
 const requestURL=new URL(request.url),redirect=(status,detail='')=>redirectBack(request,notionOAuth,status,detail);
 if(request.method!=='GET'||!db||!notionOAuth?.clientId||!notionOAuth?.clientSecret||!notionOAuth?.redirectUri||!validSecret(secret))return redirect('error','missing_config');
 const code=requestURL.searchParams.get('code'),state=requestURL.searchParams.get('state'),providerError=requestURL.searchParams.get('error');
 const stateKey=state&&/^[a-f0-9]{48}$/i.test(state)?STATE_PREFIX+await hash(state):'';
 // 用户在 Notion 点了「取消」时，Notion 带着 error=access_denied 和 state 跳回来，没有 code。
 if(providerError)return redirect('error',providerError==='access_denied'?'access_denied':'notion_error');
 if(!code||!stateKey)return redirect('error','bad_code_state');
 const pending=(await new Store(db).load()).runtime?.[stateKey];
 if(!pending||!(pending.expiresAt>now)||!pending.ownerId)return redirect('error','missing_state');

 let tokenResult;
 try{tokenResult=await exchangeNotionOAuth(notionOAuth,code,fetcher);}
 catch(error){console.error('notion_oauth_exchange_failed',scrubNotionError(error&&error.message||error,notionOAuth,code));return redirect('error','exchange_failed');}
 const token=tokenResult.access_token;
 const client=new NotionClient({token,fetcher,apiProxy:notionOAuth.apiProxyUrl||''});
 let pages=[],searchFailed=false;
 try{pages=await listWithRetry(client,{delayMs:Number.isFinite(notionOAuth.searchRetryDelayMs)?notionOAuth.searchRetryDelayMs:1200,retries:Number.isFinite(notionOAuth.searchRetries)?notionOAuth.searchRetries:2});}
 catch(error){searchFailed=true;console.error('notion_search_pages_failed',scrubNotionError(error&&error.message||error,notionOAuth,code));}

 try{
  // 网络请求都做完了，这里只改库；遇到别的请求同时提交会自动重读再做，不会重复换授权码。
  const outcome=await withWorld(db,async world=>{
   const record=world.runtime[stateKey],person=record&&world.people[record.ownerId];
   if(!record||!(record.expiresAt>now)||!person)return {status:'error',detail:'missing_state'};
   delete world.runtime[stateKey];
   const sealed=await seal(token,secret,record.ownerId);
   const result=settle(world,person,record.ownerId,{sealed,pages,searchFailed,workspace:tokenResult.workspace_name,pendingKey:PENDING_PREFIX+stateKey.slice(STATE_PREFIX.length),now});
   return result.connected?{status:'connected'}:{status:'error',detail:result.reason};
  });
  return redirect(outcome.status,outcome.detail);
 }catch(error){console.error('notion_oauth_save_failed',scrubNotionError(error&&error.message||error,notionOAuth,code));return redirect('error','save_failed');}
}

// ---- 已登录用户的接口（api.mjs 把路由接到这里）----
// POST connections/notion/finish：授权做完了但没有可用页面（没勾选，或搜索出错）时，不用再去 Notion 走一遍，直接重试。
export async function finishNotion(world,person,ownerId,{secret,fetcher,notionOAuth,now}){
 const pending=latestPending(world,ownerId,now);
 if(!pending)return connectionState(world,person,ownerId,notionOAuth,now);
 const client=new NotionClient({token:await unseal(pending.value.token,secret,ownerId),fetcher,apiProxy:notionOAuth?.apiProxyUrl||''});
 let pages=[],searchFailed=false;
 try{pages=await listWithRetry(client,{retries:0});}catch(error){searchFailed=true;console.error('notion_search_pages_failed',scrubNotionError(error&&error.message||error,notionOAuth));}
 settle(world,person,ownerId,{sealed:pending.value.token,pages,searchFailed,workspace:pending.value.workspace,pendingKey:pending.key,now});
 return connectionState(world,person,ownerId,notionOAuth,now);
}

// GET connections/notion/pages：现在能看到的页面，供「换一个页面」用。顶层页面在前。
export async function listNotionPages(person,ownerId,{secret,fetcher,notionOAuth}){
 const client=await connectedClient(person,ownerId,{secret,fetcher,apiProxy:notionOAuth?.apiProxyUrl||''});
 let pages;try{pages=await client.listPages();}catch(error){notionProblem(error);}
 const top=new Set(topLevelPages(pages).map(page=>page.id));
 const recent=(a,b)=>String(b.editedAt||'').localeCompare(String(a.editedAt||''));
 const ordered=[...pages.filter(page=>top.has(page.id)).sort(recent),...pages.filter(page=>!top.has(page.id)).sort(recent)].slice(0,100);
 return {selectedId:person.settings.notionPageId,pages:ordered.map(page=>({id:page.id,title:page.title,topLevel:top.has(page.id)}))};
}

// POST connections/notion/select {pageId}：换成另一个已分享的页面。
export async function selectNotionPage(world,person,ownerId,input,{secret,fetcher,notionOAuth,now}){
 if(typeof input?.pageId!=='string'||!PAGE_ID.test(input.pageId))fail('请选择一个 Notion 页面');
 const client=await connectedClient(person,ownerId,{secret,fetcher,apiProxy:notionOAuth?.apiProxyUrl||''});
 let pages;try{pages=await client.listPages();}catch(error){notionProblem(error);}
 const page=pages.find(candidate=>sameId(candidate.id,input.pageId));
 if(!page)fail('这个页面没有分享给 Weave。请先在 Notion 里把它分享给 Weave，再选它',404);
 person.settings.notionPageId=page.id;person.settings.notionPage={id:page.id,title:page.title};
 return connectionState(world,person,ownerId,notionOAuth,now);
}
