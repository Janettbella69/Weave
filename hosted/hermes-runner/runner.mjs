import {spawn} from 'node:child_process';
import {mkdir,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
export const REVISION='f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f';
const script=fileURLToPath(new URL('./assess.py',import.meta.url));
export async function executeHermes(job,{python,dataDir,spawnImpl=spawn}={}){
  const owner=job?.run?.owner;
  if(!/^u:[a-f0-9]{64}$/.test(owner||'')||!/^[-a-f0-9]{36}$/.test(job.run.leaseId)||typeof job.apiKey!=='string'||job.apiKey.length>512)throw Error('Invalid Hermes job');
  const home=join(dataDir,owner.slice(2));await mkdir(home,{recursive:true,mode:0o700});await chmod(home,0o700);
  return runPython(python,[],job,home,spawnImpl);
}
function runPython(python,args,payload,home,spawnImpl=spawn){
  return new Promise((resolveResult,reject)=>{
    const child=spawnImpl(python,[script,...args],{cwd:home,env:{PATH:process.env.PATH,HOME:home,HERMES_HOME:home,PYTHONUNBUFFERED:'1',HERMES_QUIET:'1'},stdio:['pipe','pipe','pipe']});
    let output='',overflow=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Hermes execution timed out'));},125000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>64000){overflow=true;child.kill('SIGKILL');}});
    // Consume diagnostics without logging private prompts or provider errors.
    child.stderr.on('data',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(Error('Hermes Python could not start'));});
    child.once('close',code=>{clearTimeout(timer);try{if(code!==0||overflow)throw Error();const result=JSON.parse(output.trim().split('\n').at(-1));if(result.error)throw Error();resolveResult(result);}catch{reject(Error('Hermes execution failed'));}});
    child.stdin.on('error',()=>{});child.stdin.end(payload?JSON.stringify(payload):'');
  });
}
export async function pollOnce({origin,token,python,dataDir,fetcher=fetch,execute=executeHermes}){
  const post=async(path,data)=>{
    const response=await fetcher(origin+'/api/internal/hermes/'+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(data)});
    if(!response.ok){const error=Error('Hermes queue rejected request ('+response.status+')');error.status=response.status;throw error;}return response.json();
  };
  const {job}=await post('claim',{version:REVISION});if(!job)return {idle:true};
  let result;
  try{result=await execute(job,{python,dataDir});}catch{result={error:true};}
  const receipt={owner:job.run.owner,leaseId:job.run.leaseId,...result};
  // Results are idempotent. If the acknowledgement was lost, repeat only the
  // receipt, never the model call. Failed receipts expire through the DB lease.
  for(let attempt=0;attempt<3;attempt++){
    try{return await post('result',receipt);}catch(error){
      if(error.status===409)return {ok:true,delivered:false,discarded:true};
      if(error.status===422)return post('result',{owner:job.run.owner,leaseId:job.run.leaseId,error:true});
      if([401,403].includes(error.status)||attempt===2)throw error;
      await delay(1000*(attempt+1));
    }
  }
}
export async function main(){
  const origin=(process.env.WEAVE_ORIGIN||'').replace(/\/$/,'');
  if(!origin.startsWith('https://')&&!(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)))throw Error('WEAVE_ORIGIN must be HTTPS (local test server may use loopback)');
  const token=process.env.HERMES_RUNNER_TOKEN;if(!token||token.length<32)throw Error('Configure HERMES_RUNNER_TOKEN');
  const python=process.env.HERMES_PYTHON||fileURLToPath(new URL('./.venv/bin/python',import.meta.url)),dataDir=resolve(process.env.HERMES_DATA_DIR||fileURLToPath(new URL('./.data/',import.meta.url)));
  const probe=join(dataDir,'probe');await mkdir(probe,{recursive:true,mode:0o700});
  const engine=await runPython(python,['--probe'],null,probe);if(!engine.ok||engine.revision!==REVISION)throw Error('Hermes is not installed at the expected version');
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
  console.log('Hermes ready; outbound Weave queue polling started.');
  while(!stopping){
    try{const result=await pollOnce({origin,token,python,dataDir});if(!result.idle)console.log(result.delivered?'Hermes decision delivered.':'Hermes check completed quietly.');}
    catch(error){console.error(error.message);}
    if(process.argv.includes('--once'))break;
    // No inbound port, tunnel, webhook key in prompts, or public gateway needed.
    await delay(30000);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
