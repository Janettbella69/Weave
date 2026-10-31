import http from 'node:http';
import {timingSafeEqual,createHash} from 'node:crypto';
import {query} from '@anthropic-ai/claude-agent-sdk';
import {runAgent} from './runtime.mjs';
const token=process.env.AGENT_SERVICE_TOKEN;
if(!token||token.length<32)throw Error('请配置至少32字符的 AGENT_SERVICE_TOKEN');
const digest=value=>createHash('sha256').update(value).digest();
let active=0;
http.createServer(async(req,res)=>{
  const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.url==='/health'&&req.method==='GET')return reply(200,{ok:true});
  if(req.url!=='/query'||req.method!=='POST')return reply(404,{error:'未找到'});
  if(!timingSafeEqual(digest(req.headers.authorization||''),digest('Bearer '+token)))return reply(401,{error:'未授权'});
  if(active>=4)return reply(429,{error:'Agent 服务繁忙'});
  active++;
  try{
    let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32000)throw Error('请求过长');chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString());
    reply(200,{output:await runAgent(input,query)});
  }catch{reply(502,{error:'Agent 生成失败，请重试'});}finally{active--;}
}).listen(Number(process.env.PORT)||4320,process.env.HOST||'127.0.0.1',()=>console.log('Weave Agent SDK service started'));
