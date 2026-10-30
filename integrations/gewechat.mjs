import {timingSafeEqual,createHash} from 'node:crypto';
const str=v=>typeof v==='string'?v:typeof v?.string==='string'?v.string:'';
export function authenticated(actual,expected){
 if(!expected||expected.length<24||typeof actual!=='string')return false;
 const digest=s=>createHash('sha256').update(s).digest();return timingSafeEqual(digest(actual),digest(expected));
}
export function normalizeEvent(payload,{appId,ownerWxid}){
 if(!appId||!ownerWxid)throw Error('Gewechat appId 和指定用户尚未配置');
 const type=payload?.TypeName??payload?.type_name;
 if(type!=='AddMsg')return null;
 if((payload.Appid??payload.appid)!==appId)return null;
 const d=payload.Data??payload.data;
 if(!d||Number(d.MsgType)!==1)return null;
 const from=str(d.FromUserName),to=str(d.ToUserName),self=str(payload.Wxid);
 if(from!==ownerWxid||from===self||!to||!self||to!==self||from.endsWith('@chatroom')||to.endsWith('@chatroom'))return null;
 const text=str(d.Content).trim();if(!text||text.length>4000)return null;
 // NewMsgId is commonly beyond JS integer precision. Never coerce large numeric IDs.
 const raw=d.NewMsgId??d.MsgId;
 if((typeof raw!=='string'&&typeof raw!=='number')||!String(raw)||raw===0)return null;
 const id=typeof raw==='number'&&!Number.isSafeInteger(raw)?d.MsgId:raw;
 if((typeof id!=='string'&&typeof id!=='number')||(typeof id==='number'&&!Number.isSafeInteger(id)))return null;
 return {id:`${appId}:${from}:${String(id)}`,from,text};
}
export class GewechatClient{
 constructor({baseUrl,token,appId,fetcher=fetch}){
  if(!baseUrl||!token)throw Error('请配置 GEWECHAT_BASE_URL 和 GEWECHAT_TOKEN');
  const url=new URL(baseUrl);if(url.username||url.password||url.search||url.hash)throw Error('Gewechat 地址不能包含凭证或查询参数');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('远程 Gewechat 地址必须使用 HTTPS；本机允许 HTTP');
  this.baseUrl=url.href.replace(/\/$/,'');this.token=token;this.appId=appId;this.fetcher=fetcher;
 }
 async request(path,body){
  let r;try{r=await this.fetcher(this.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json','X-GEWE-TOKEN':this.token},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});}catch{throw Error('Gewechat 请求未确认，请检查服务连接；发送请求不会自动重试');}
  if(!r.ok)throw Error(`Gewechat HTTP 请求失败 (${r.status})`);
  let data;try{data=await r.json();}catch{throw Error('Gewechat 返回格式错误');}
  if(Number(data.ret)!==200)throw Error('Gewechat 服务未确认成功，请检查服务端状态');return data;
 }
 sendText(toWxid,content){if(!this.appId||!toWxid||!content||content.length>4000)throw Error('微信发送参数无效');return this.request('/message/postText',{appId:this.appId,toWxid,content,ats:''});}
 setCallback(callbackUrl){return this.request('/tools/setCallback',{token:this.token,callbackUrl});}
 getQr(){return this.request('/login/getLoginQrCode',{appId:this.appId||''});}
 checkLogin(uuid,captchCode=''){return this.request('/login/checkLogin',{appId:this.appId,uuid,captchCode});}
 checkOnline(){return this.request('/login/checkOnline',{appId:this.appId});}
}
export function formatReply(reply,plan){
 if(!plan)return reply.text;
 return `${reply.text}\n\n${plan.conflict}\n\n${plan.actions.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\n${plan.mode==='demo'?'【规则演示】':'【模型协商】'}\n回复「确认计划」保存；确认后回复「同步 Notion」写入页面。`.slice(0,4000);
}
