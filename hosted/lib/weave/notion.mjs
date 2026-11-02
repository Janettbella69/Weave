export class NotionClient{
 constructor({token,pageId,fetcher=fetch,apiProxy=''}){this.token=token;this.pageId=pageId;this.fetcher=fetcher;this.apiProxy=apiProxy;}
 configured(){return !!(this.token&&this.pageId);}
 async request(path,method='GET',body){
  let r;try{
  if(this.apiProxy){
    r=await this.fetcher(this.apiProxy,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,path,token:this.token,body,notionVersion:'2022-06-28'})});
  }else{
    r=await this.fetcher('https://api.notion.com/v1/'+path,{method,headers:{Authorization:`Bearer ${this.token}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  }
 }catch{throw Error('Notion 请求未确认，请检查网络连接');}
  if(!r.ok)throw Error(`Notion 请求失败 (${r.status})，请检查页面授权和配置`);return r.json();
 }
 async children(id){let cursor,blocks=[];do{const r=await this.request(`blocks/${encodeURIComponent(id)}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`);blocks.push(...r.results);cursor=r.has_more?r.next_cursor:null;}while(cursor&&blocks.length<500);return blocks;}
 async memory(){
  if(!this.configured())return '';
  const blocks=await this.children(this.pageId),lines=[];
  const collect=items=>{for(const b of items){const rich=b[b.type]?.rich_text;if(rich)lines.push(rich.map(x=>x.plain_text||x.text?.content||'').join(''));}};
  collect(blocks);
  // Read only the most recent application-created plan pages, not unrelated content.
  const pages=blocks.filter(b=>b.type==='child_page'&&(b.child_page?.title?.startsWith('习惯议会 · ')||b.child_page?.title?.startsWith('Weave · '))).slice(-7);
  for(const p of pages)collect(await this.children(p.id));return lines.join('\n').slice(-12000);
 }
 async searchPages(){
  if(!this.token) return [];
  const result=await this.request('search','POST',{page_size:100,filter:{property:'object',value:'page'}});
  return (Array.isArray(result?.results)?result.results:[]).map(page=>{
   const properties=page?.properties&&typeof page.properties==='object'?Object.values(page.properties):[];
   const title=properties.find(property=>property?.type==='title')?.title?.map(item=>item.plain_text||item.text?.content||'').join('')||page?.child_page?.title||'未命名页面';
   return {id:page.id,title:String(title).slice(0,200),url:typeof page.url==='string'?page.url:''};
  }).filter(page=>page.id);
 }
 async syncPlan(plan,checkins=[]){
  if(!plan?.approved)throw Error('请先确认计划');if(!this.configured())throw Error('请先连接 Notion');
  if(plan.notionUrl)return {url:plan.notionUrl};
  const block=text=>({object:'block',type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:text.slice(0,2000)}}]}});
  return this.request('pages','POST',{parent:{page_id:this.pageId},properties:{title:{type:'title',title:[{type:'text',text:{content:`Weave · ${plan.createdAt.slice(0,10)}`}}]}},children:[block(plan.context.text),block(plan.conflict),...plan.actions.map(block),...checkins.slice(-7).map(x=>block('习惯反馈：'+x.text)),block(`来源：${plan.mode==='demo'?'规则演示':plan.mode==='protocol'?'本地 A2A 协商协议':'真实模型协商'}；计划 ID：${plan.id}`)]});
 }
}

export function notionOAuthConfig(env){
 const clientId=env?.clientId||env?.NOTION_OAUTH_CLIENT_ID||'';
 const clientSecret=env?.clientSecret||env?.NOTION_OAUTH_CLIENT_SECRET||'';
 const publicOrigin=(env?.publicOrigin||env?.NOTION_PUBLIC_ORIGIN||'').replace(/\/$/,'');
 const redirectUri=env?.redirectUri||env?.NOTION_OAUTH_REDIRECT_URI||(publicOrigin?`${publicOrigin}/api/connections/notion/callback`:'');
 return {clientId,clientSecret,redirectUri,publicOrigin,exchangeUrl:env?.exchangeUrl||env?.NOTION_OAUTH_EXCHANGE_URL||'',apiProxyUrl:env?.apiProxyUrl||env?.NOTION_API_PROXY_URL||''};
}

export function notionOAuthURL(config,state){
 if(!config?.clientId||!config?.redirectUri||!state) return '';
 const url=new URL('https://api.notion.com/v1/oauth/authorize');
 url.searchParams.set('client_id',config.clientId);
 url.searchParams.set('response_type','code');
 url.searchParams.set('owner','user');
 url.searchParams.set('redirect_uri',config.redirectUri);
 url.searchParams.set('state',state);
 return url.href;
}

export async function exchangeNotionOAuth(config,code,fetcher=fetch){
 if(!config?.clientId||!config?.clientSecret||!config?.redirectUri||typeof code!=='string'||!code)throw Error('Notion 连接暂不可用，请稍后重试');
 let response;
 const proxy=typeof config.exchangeUrl==='string'?config.exchangeUrl.trim():'';
 try{
  if(proxy){
   response=await fetcher(proxy,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:config.clientId,clientSecret:config.clientSecret,code,redirectUri:config.redirectUri})});
  }else{
   response=await fetcher('https://api.notion.com/v1/oauth/token',{method:'POST',headers:{Authorization:`Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,'Content-Type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',code,redirect_uri:config.redirectUri})});
  }
 }catch(err){throw Error(`Notion 连接未完成，请稍后重试: ${err&&err.message||err}`);}
 if(!response.ok){let body='';try{body=await response.text()}catch{} throw Error(`Notion 连接未完成 (${response.status}) ${body.slice(0,200)}`);}
 let result;try{result=await response.json();}catch{throw Error('Notion 连接返回格式错误');}
 if(typeof result?.access_token!=='string'||!result.access_token)throw Error('Notion 连接未完成，请稍后重试');
 return result;
}
