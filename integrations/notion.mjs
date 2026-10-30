export class NotionClient{
 constructor({token,pageId,fetcher=fetch}){this.token=token;this.pageId=pageId;this.fetcher=fetcher;}
 configured(){return !!(this.token&&this.pageId);}
 async request(path,method='GET',body){
  let r;try{r=await this.fetcher('https://api.notion.com/v1/'+path,{method,headers:{Authorization:`Bearer ${this.token}`,'Notion-Version':'2025-09-03','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});}catch{throw Error('Notion 请求未确认，请检查网络连接');}
  if(!r.ok)throw Error(`Notion 请求失败 (${r.status})，请检查页面授权和配置`);return r.json();
 }
 async children(id){let cursor,blocks=[];do{const r=await this.request(`blocks/${encodeURIComponent(id)}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`);blocks.push(...r.results);cursor=r.has_more?r.next_cursor:null;}while(cursor&&blocks.length<500);return blocks;}
 async memory(){
  if(!this.configured())return '';
  const blocks=await this.children(this.pageId),lines=[];
  const collect=items=>{for(const b of items){const rich=b[b.type]?.rich_text;if(rich)lines.push(rich.map(x=>x.plain_text||x.text?.content||'').join(''));}};
  collect(blocks);
  // Read only the most recent application-created plan pages, not unrelated content.
  const pages=blocks.filter(b=>b.type==='child_page'&&b.child_page?.title?.startsWith('习惯议会 · ')).slice(-7);
  for(const p of pages)collect(await this.children(p.id));return lines.join('\n').slice(-12000);
 }
 async syncPlan(plan,checkins=[]){
  if(!plan?.approved)throw Error('请先确认计划');if(!this.configured())throw Error('尚未配置 Notion；请填写服务端 .env');
  if(plan.notionUrl)return {url:plan.notionUrl};
  const block=text=>({object:'block',type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:text.slice(0,2000)}}]}});
  return this.request('pages','POST',{parent:{page_id:this.pageId},properties:{title:{type:'title',title:[{type:'text',text:{content:`习惯议会 · ${plan.createdAt.slice(0,10)}`}}]}},children:[block(plan.context.text),block(plan.conflict),...plan.actions.map(block),...checkins.slice(-7).map(x=>block('习惯反馈：'+x.text)),block(`来源：${plan.mode==='demo'?'规则演示':'真实模型协商'}；计划 ID：${plan.id}`)]});
 }
}
