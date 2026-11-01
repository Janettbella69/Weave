import {hash,randomToken,seal,unseal} from './crypto.mjs';

const text=value=>typeof value==='string'?value:typeof value?.string==='string'?value.string:'';
const stamp=now=>new Date(now).toISOString();
const bindPattern=/^绑定\s*(?:weave\s*)?([a-f0-9]{48})$/i;

export function gewechatConfig(env){
  if(env?.baseUrl||env?.callbackSecret)return {baseUrl:env.baseUrl||'',token:env.token||'',appId:env.appId||'',callbackSecret:env.callbackSecret||'',publicOrigin:(env.publicOrigin||'').replace(/\/$/,'')};
  return {baseUrl:env?.GEWECHAT_BASE_URL||'',token:env?.GEWECHAT_TOKEN||'',appId:env?.GEWECHAT_APP_ID||'',callbackSecret:env?.GEWECHAT_CALLBACK_SECRET||'',publicOrigin:(env?.GEWECHAT_PUBLIC_ORIGIN||'').replace(/\/$/,'')};
}
export function callbackURL(config){
  if(!config.publicOrigin||!config.callbackSecret)return '';
  return `${config.publicOrigin}/api/gewechat/callback/${config.callbackSecret}`;
}
export async function callbackAuthorized(actual,expected){
  if(typeof actual!=='string'||typeof expected!=='string'||expected.length<24)return false;
  return (await hash(actual))===(await hash(expected));
}
export function normalizeEvent(payload,{appId}){
  if(!appId)return null;
  const type=payload?.TypeName??payload?.type_name;
  if(type!=='AddMsg'||(payload.Appid??payload.appid)!==appId)return null;
  const data=payload.Data??payload.data;
  if(!data||Number(data.MsgType)!==1)return null;
  const from=text(data.FromUserName),to=text(data.ToUserName),self=text(payload.Wxid);
  if(!from||!to||!self||from===self||to!==self||from.endsWith('@chatroom')||to.endsWith('@chatroom'))return null;
  const raw=data.NewMsgId??data.MsgId;
  if((typeof raw!=='string'&&typeof raw!=='number')||!String(raw)||raw===0)return null;
  const id=typeof raw==='number'&&!Number.isSafeInteger(raw)?data.MsgId:raw;
  if((typeof id!=='string'&&typeof id!=='number')||(typeof id==='number'&&!Number.isSafeInteger(id)))return null;
  const message=text(data.Content).trim();
  if(!message||message.length>4000)return null;
  return {id:`${appId}:${from}:${String(id)}`,from,text:message};
}

export class GewechatClient{
  constructor({baseUrl,token,appId,fetcher=fetch}){
    if(!baseUrl||!token||!appId)throw Error('Gewechat 尚未配置');
    const url=new URL(baseUrl);
    if(url.username||url.password||url.search||url.hash)throw Error('Gewechat 地址不能包含凭证或查询参数');
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('远程 Gewechat 地址必须使用 HTTPS');
    this.baseUrl=url.href.replace(/\/$/,'');this.token=token;this.appId=appId;this.fetcher=fetcher;
  }
  async request(path,body){
    let response;try{response=await this.fetcher(this.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json','X-GEWE-TOKEN':this.token},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{throw Error('Gewechat 请求未确认，请检查服务连接');}
    if(!response.ok)throw Error(`Gewechat HTTP 请求失败 (${response.status})`);
    let data;try{data=await response.json();}catch{throw Error('Gewechat 返回格式错误');}
    if(Number(data.ret)!==200)throw Error('Gewechat 服务未确认成功，请检查服务端状态');
    return data;
  }
  sendText(toWxid,content){if(!toWxid||!content||content.length>4000)throw Error('微信发送参数无效');return this.request('/message/postText',{appId:this.appId,toWxid,content,ats:''});}
  setCallback(url){return this.request('/tools/setCallback',{token:this.token,callbackUrl:url});}
  checkOnline(){return this.request('/login/checkOnline',{appId:this.appId});}
}

function queue(world,item){world.wechat??={};world.wechat[item.id]=item;return item;}
function mappingKey(hashValue){return `wechat:${hashValue}`;}
function bindKey(hashValue){return `wechat-bind:${hashValue}`;}
export async function startBinding(world,ownerId,now=Date.now()){
  world.runtime??={};
  for(const [key,value] of Object.entries(world.runtime))if(key.startsWith('wechat-bind:')&&value.ownerId===ownerId)delete world.runtime[key];
  const code=randomToken(),expiresAt=now+15*60*1000;
  world.runtime[bindKey(await hash(code))]= {ownerId,expiresAt};
  return {code,expiresAt,instruction:`绑定 ${code}`};
}
export async function unbind(world,person,ownerId){
  const key=person.settings.wechatWxidHash?mappingKey(person.settings.wechatWxidHash):'';
  if(key)delete world.runtime[key];
  delete person.settings.wechatWxidHash;delete person.settings.wechatWxid;
  for(const [id,value] of Object.entries(world.runtime||{}))if(id.startsWith('wechat-bind:')&&value.ownerId===ownerId)delete world.runtime[id];
  return {ok:true};
}
export async function ingest(world,payload,{appId,now=Date.now(),secret}){
  const event=normalizeEvent(payload,{appId});
  if(!event)return {accepted:true,ignored:true};
  world.runtime??={};world.wechat??={};
  if(world.wechat[event.id])return {accepted:true,duplicate:true};
  const senderHash=await hash(event.from),mapping=world.runtime[mappingKey(senderHash)];
  let ownerId=mapping?.ownerId;
  if(!ownerId){
    const match=event.text.match(bindPattern);
    if(match){
      const pending=world.runtime[bindKey(await hash(match[1]))];
      if(pending&&pending.expiresAt>now){
        ownerId=pending.ownerId;const person=world.people[ownerId];
        if(person){
          if(person.settings.wechatWxidHash)delete world.runtime[mappingKey(person.settings.wechatWxidHash)];
          person.settings.wechatWxidHash=senderHash;person.settings.wechatWxid=await seal(event.from,secret,ownerId);person.settings.wechatBoundAt=now;
          world.runtime[mappingKey(senderHash)]={ownerId,updatedAt:now};delete world.runtime[bindKey(await hash(match[1]))];
          queue(world,{id:'out:'+crypto.randomUUID(),direction:'outbound',ownerId,text:'微信已连接到你的 Weave 空间。之后可以直接在这里记录反馈、询问个人 Agent。',status:'queued',createdAt:stamp(now),source:'binding'});
          world.wechat[event.id]={...event,direction:'inbound',ownerId,status:'ignored',createdAt:stamp(now)};
          return {accepted:true,bound:true};
        }
      }
    }
  }
  if(!ownerId){world.wechat[event.id]={...event,direction:'inbound',status:'ignored',createdAt:stamp(now)};return {accepted:true,ignored:true};}
  queue(world,{...event,direction:'inbound',ownerId,status:'queued',createdAt:stamp(now)});
  return {accepted:true,queued:true};
}
export async function wxidFor(person,ownerId,secret){
  return person.settings.wechatWxid?unseal(person.settings.wechatWxid,secret,ownerId):'';
}
export function publicBinding(person,config){
  return {configured:!!(config.baseUrl&&config.token&&config.appId&&config.callbackSecret&&config.publicOrigin),bound:!!person.settings.wechatWxidHash,callbackConfigured:!!callbackURL(config)};
}

export async function drainGewechat(world,{client,secret,now=Date.now(),handleMessage}){
  let processed=0;
  world.wechat??={};
  for(const entry of Object.values(world.wechat)){
    if(entry.direction!=='inbound'||entry.status!=='queued')continue;
    const person=world.people[entry.ownerId];
    if(!person){entry.status='ignored';continue;}
    entry.status='processing';entry.startedAt=stamp(now);
    try{
      entry.reply=await handleMessage(person,entry.text);
      if(typeof entry.reply!=='string'||!entry.reply.trim())throw Error('微信回复为空');
      entry.status='sending';entry.reply=entry.reply.slice(0,4000);
      const wxid=await wxidFor(person,entry.ownerId,secret);
      await client.sendText(wxid,entry.reply);
      entry.status='sent';entry.sentAt=stamp(now);processed++;
    }catch(error){
      entry.status='uncertain';entry.error=error instanceof Error?error.message:'微信处理失败';
    }
  }
  for(const entry of Object.values(world.wechat))if(entry.direction==='outbound'&&entry.status==='queued'){
    const person=world.people[entry.ownerId];
    if(!person){entry.status='ignored';continue;}
    try{await client.sendText(await wxidFor(person,entry.ownerId,secret),entry.text);entry.status='sent';entry.sentAt=stamp(now);processed++;}
    catch(error){entry.status='uncertain';entry.error=error instanceof Error?error.message:'微信发送未确认';}
  }
  return processed;
}
