import {Store} from './store.mjs';
import {hash,unseal} from './crypto.mjs';
import {deliverReminders,fail} from './domain.mjs';
import {claimAssessment,receiveAssessment,HERMES_REVISION,ASSESSMENT_SYSTEM} from './proactivity.mjs';

export async function hermesQueue(request,{db,secret,runnerToken,agentProviderApiKey,readBody,now=Date.now()}){
  const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  try{
    if(typeof runnerToken!=='string'||runnerToken.length<32||await hash(request.headers.get('authorization')||'')!==await hash('Bearer '+runnerToken))return json({error:'未授权'},401);
    if(request.method!=='POST')return json({error:'方法不支持'},405);
    const input=await readBody(request),store=new Store(db,{strict:true}),world=await store.load(),path=new URL(request.url).pathname;
    if(path==='/api/internal/hermes/claim'){
      if(input.version!==HERMES_REVISION)fail('Hermes 执行器版本不匹配',409);
      world.runtime['runtime:hermes']={id:'runtime:hermes',version:HERMES_REVISION,lastSeenAt:now};
      deliverReminders(world,now);
      const job=await claimAssessment(world,now,typeof agentProviderApiKey==='string'&&agentProviderApiKey.length>=12);
      if(!job){await store.save(world);return json({job:null});}
      const person=world.people[job.run.owner];
      const apiKey=person.settings.deepseekKey?await unseal(person.settings.deepseekKey,secret,person.id):typeof agentProviderApiKey==='string'&&agentProviderApiKey.length>=12?agentProviderApiKey:'';
      if(!apiKey)fail('Agent 连接暂不可用，请稍后重试',428);
      await store.save(world);
      return json({job:{...job,apiKey,model:person.settings.model,system:ASSESSMENT_SYSTEM}});
    }
    if(path==='/api/internal/hermes/result'){
      const result=await receiveAssessment(world,input,now);await store.save(world);return json(result);
    }
    return json({error:'接口不存在'},404);
  }catch(error){return json({error:error.status?error.message:'Hermes 队列暂时不可用'},error.status||503);}
}
