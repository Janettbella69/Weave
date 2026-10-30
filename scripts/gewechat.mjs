import {GewechatClient} from '../integrations/gewechat.mjs';
const command=process.argv[2];
try{
 if(command==='status'){
  console.log(JSON.stringify({baseUrl:!!process.env.GEWECHAT_BASE_URL,token:!!process.env.GEWECHAT_TOKEN,appId:!!process.env.GEWECHAT_APP_ID,owner:!!process.env.GEWECHAT_OWNER_WXID,friend:!!process.env.GEWECHAT_FRIEND_WXID,callbackSecret:(process.env.GEWECHAT_CALLBACK_SECRET?.length||0)>=24,notion:!!(process.env.NOTION_TOKEN&&process.env.NOTION_PAGE_ID),friendNotion:!!((process.env.NOTION_FRIEND_TOKEN||process.env.NOTION_TOKEN)&&process.env.NOTION_FRIEND_PAGE_ID)},null,2));
 }else{
  const client=new GewechatClient({baseUrl:process.env.GEWECHAT_BASE_URL,token:process.env.GEWECHAT_TOKEN,appId:process.env.GEWECHAT_APP_ID});
  if(command==='callback'){
   const secret=process.env.GEWECHAT_CALLBACK_SECRET,origin=process.env.GEWECHAT_PUBLIC_ORIGIN;
   if(!secret||secret.length<24||!origin)throw Error('请配置回调密钥和 GEWECHAT_PUBLIC_ORIGIN');
   const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('公网回调 origin 应为 HTTPS 域名，不包含路径或凭证');
   await client.setCallback(url.origin+'/webhooks/gewechat/'+encodeURIComponent(secret));console.log('回调地址已注册（密钥不显示）');
  }else if(command==='qr'){
   const r=await client.getQr();const d=r.data||{};
   console.log(JSON.stringify({appId:d.appId??d.appid,uuid:d.uuid,qrData:d.qrData,qrImgBase64:d.qrImgBase64},null,2));
  }else if(command==='login'){
   if(!process.env.GEWECHAT_LOGIN_UUID)throw Error('请填写 GEWECHAT_LOGIN_UUID');
   const r=await client.checkLogin(process.env.GEWECHAT_LOGIN_UUID,process.env.GEWECHAT_LOGIN_CODE||'');console.log(JSON.stringify({ret:r.ret,status:r.data?.status,wxid:r.data?.wxid},null,2));
  }else if(command==='online'){
   const r=await client.checkOnline();console.log(JSON.stringify({ret:r.ret,online:r.data},null,2));
  }else throw Error('用法：npm run gewechat -- status|qr|login|online|callback');
 }
}catch(e){console.error(e.message);process.exitCode=1;}
