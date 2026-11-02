// Checks the Agent SDK behaviour docs/ARCHITECTURE.md depends on, against a scripted local
// Anthropic-format endpoint. No real model and no key: nothing here costs money. The CLI's
// HOME and CLAUDE_CONFIG_DIR live in a temp folder, so your own Claude config is not touched.
//
//   cd hosted/agent-service && npm ci && cd ../.. && node scripts/agent-sdk-probe/probe.mjs
//
// This is a probe, not product code. FAIL on a future SDK version means the architecture
// document needs another look.
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir,platform} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const NM=process.env.SDK_NODE_MODULES||join(here,'../../hosted/agent-service/node_modules');
const load=path=>import(pathToFileURL(join(NM,path)).href);
const {query,tool,createSdkMcpServer}=await load('@anthropic-ai/claude-agent-sdk/sdk.mjs');
const {z}=await load('zod/index.js');
const sdkVersion=JSON.parse(readFileSync(join(NM,'@anthropic-ai/claude-agent-sdk/package.json'))).version;

const ROOT=realpathSync(mkdtempSync(join(tmpdir(),'weave-probe-')));
const PLUGIN=join(ROOT,'plugin');
mkdirSync(join(PLUGIN,'.claude-plugin'),{recursive:true});
mkdirSync(join(PLUGIN,'skills/weekly-review/scripts'),{recursive:true});
writeFileSync(join(PLUGIN,'.claude-plugin/plugin.json'),JSON.stringify({name:'weave',version:'0.0.1',description:'probe'}));
writeFileSync(join(PLUGIN,'skills/weekly-review/SKILL.md'),'---\nname: weekly-review\ndescription: 每周复盘习惯完成情况时使用。\n---\n先查记录，再运行：\npython3 ${CLAUDE_SKILL_DIR}/scripts/stats.py\n');
writeFileSync(join(PLUGIN,'skills/weekly-review/scripts/stats.py'),'print("streak=3")\n');

// ---- Scripted model ------------------------------------------------------------------
let scene=null;const captured=[];
function reply(res,blocks,usage,model){
  const stop=blocks.some(b=>b.tool)?'tool_use':'end_turn';
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`);
  send('message_start',{message:{id:'msg_'+captured.length,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:usage.input,output_tokens:1}}});
  blocks.forEach((b,index)=>{
    if(b.tool){
      send('content_block_start',{index,content_block:{type:'tool_use',id:'toolu_'+Math.random().toString(36).slice(2,14),name:b.tool,input:{}}});
      send('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input||{})}});
    }else{
      send('content_block_start',{index,content_block:{type:'text',text:''}});
      send('content_block_delta',{index,delta:{type:'text_delta',text:b.text}});
    }
    send('content_block_stop',{index});
  });
  send('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:usage.output}});
  send('message_stop',{});res.end();
}
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  let body={};try{body=JSON.parse(raw);}catch{/* not JSON */}
  captured.push({path:req.url,auth:req.headers.authorization?'bearer':'none',beta:req.headers['anthropic-beta'],body,bytes:raw.length});
  if(req.url.startsWith('/v1/messages/count_tokens')){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"input_tokens":100}');}
  if(!req.url.startsWith('/v1/messages')){res.writeHead(404);return res.end('{}');}
  const route=scene?.route?.(body)??{text:'ok'};
  reply(res,Array.isArray(route)?route:[route],scene?.usage||{input:50,output:10},body.model);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const BASE=`http://127.0.0.1:${server.address().port}`;

// ---- Harness ---------------------------------------------------------------------------
let tenants=0;
function tenant(){const dir=join(ROOT,'t'+(++tenants));for(const d of ['home','config','work'])mkdirSync(join(dir,d),{recursive:true});return dir;}
const envFor=(dir,model,extra={})=>({PATH:process.env.PATH,HOME:join(dir,'home'),CLAUDE_CONFIG_DIR:join(dir,'config'),ANTHROPIC_BASE_URL:BASE,ANTHROPIC_AUTH_TOKEN:'probe-not-a-key',ANTHROPIC_API_KEY:'',ANTHROPIC_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_OPUS_MODEL:model,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1',...extra});
const isMain=b=>Array.isArray(b.tools)&&b.tools.some(t=>t.name==='Bash'||t.name==='Read');
const assistants=b=>(b.messages||[]).filter(m=>m.role==='assistant').length;
const lastResults=b=>{const m=(b.messages||[]).at(-1);return Array.isArray(m?.content)?m.content.filter(x=>x.type==='tool_result').map(x=>typeof x.content==='string'?x.content:(x.content||[]).map(y=>y.text||'').join('')):[];};
const steps=list=>b=>{if(!isMain(b))return {text:'t'};const s=list[assistants(b)]||{text:'end'};return typeof s==='function'?s(b):s;};

async function run({prompt='你好',options={},env={},model='deepseek-flash',route,usage,dir}){
  captured.length=0;scene={route,usage};
  const home=dir||tenant(),messages=[],abortController=new AbortController(),timer=setTimeout(()=>abortController.abort(),60000),started=Date.now();
  let error=null,initMs=null;
  try{for await(const m of query({prompt,options:{cwd:join(home,'work'),abortController,settingSources:[],env:envFor(home,model,env),...options}})){messages.push(m);if(initMs===null&&m.type==='system'&&m.subtype==='init')initMs=Date.now()-started;}}
  catch(e){error=String(e.message||e);}
  clearTimeout(timer);
  const main=captured.filter(c=>c.path.startsWith('/v1/messages')&&isMain(c.body));
  const results=messages.filter(m=>m.type==='result');
  return {dir:home,error,initMs,messages,results,result:results.at(-1),init:messages.find(m=>m.type==='system'&&m.subtype==='init'),first:main[0],all:[...captured],toolResults:main.flatMap(c=>lastResults(c.body))};
}
function weaveTools(log,only){
  const all=[
    tool('log_completion','记录一次习惯完成。',{habit:z.string()},async(args,extra)=>{log.push({tool:'log_completion',pid:process.pid,id:extra?._meta?.['claudecode/toolUseId']});return {content:[{type:'text',text:`已记录 ${args.habit}`}]};}),
    tool('with_structured','同时返回文字和结构化内容。',{},async()=>({content:[{type:'text',text:'TEXT_PART'}],structuredContent:{part:'STRUCTURED_PART'}})),
    tool('send_message','对外开口的唯一方式。',{text:z.string()},async args=>{log.push({tool:'send_message',text:args.text});return {content:[{type:'text',text:'已排队'}]};}),
    tool('failing','总是失败。',{},async()=>({isError:true,content:[{type:'text',text:'对方还没授权共享时间。'}]})),
  ].filter(t=>!only||only.includes(t.name));
  return createSdkMcpServer({name:'weave',version:'0.0.1',alwaysLoad:true,tools:all});
}
const TOOLS=['Bash','Read','Write','Edit','Glob','Grep','Skill','WebSearch'];
const ALLOW=['Bash','Read','Write','Edit','Glob','Grep','Skill','WebSearch','mcp__weave__*'];
const SYSTEM='你是 Weave，一位帮人坚持习惯的助理。';
const agent=(log,extra={})=>({tools:TOOLS,systemPrompt:SYSTEM,plugins:[{type:'local',path:PLUGIN}],skills:['weave:weekly-review'],mcpServers:{weave:weaveTools(log)},permissionMode:'dontAsk',allowedTools:ALLOW,strictMcpConfig:true,thinking:{type:'disabled'},settings:{attribution:false},...extra});

const rows=[];
const check=(claim,pass,detail='')=>{rows.push({claim,pass,detail});console.log(`${pass?'PASS':'FAIL'}  ${claim}${detail?`  (${detail})`:''}`);};
const note=(label,value)=>console.log(`NOTE  ${label}: ${value}`);
console.log(`Agent SDK ${sdkVersion} on ${platform()}\n`);

// ---- 1. One agent with native tools and a custom persona --------------------------------
{
  const r=await run({options:agent([]),route:steps([{text:'你好呀'}])});
  const tools=r.first.body.tools.map(t=>t.name),all=JSON.stringify(r.first.body),system=r.first.body.system.map(x=>x.text);
  check('Anthropic 格式地址 + Bearer Key 能跑通',r.result?.subtype==='success'&&r.first.auth==='bearer'&&r.first.path.startsWith('/v1/messages'),r.first.path);
  check('显式 tools 列表只发这些内置工具 + weave 工具',TOOLS.every(t=>tools.includes(t))&&tools.filter(t=>!t.startsWith('mcp__')).length===TOOLS.length,tools.filter(t=>!t.startsWith('mcp__')).join(','));
  check('settingSources:[] + plugins 能加载 Skill，并带上描述',all.includes('weave:weekly-review')&&all.includes('每周复盘'));
  check('skills 列表把 Claude Code 自带的写代码 Skill 挡在外面',!all.includes('dataviz')&&!all.includes('code-review'));
  check('自定义系统提示去掉了「You are Claude Code」',!/You are Claude Code/.test(all));
  check('但仍有一句去不掉的前缀 "You are a Claude agent"',/You are a Claude agent/.test(all),'提示词里要讲清对用户叫 Weave');
  note('从 query() 到就绪',`${r.initMs} ms（不含容器）`);
  note('请求大小',`${r.first.bytes} 字节（tools ${JSON.stringify(r.first.body.tools).length}，system ${JSON.stringify(r.first.body.system).length}，messages ${JSON.stringify(r.first.body.messages).length}）`);
  note('发给模型接口的顶层字段',Object.keys(r.first.body).join(','));
  note('output_config',JSON.stringify(r.first.body.output_config));
  note('anthropic-beta',r.first.beta);
  note('messages 里的角色',r.first.body.messages.map(m=>m.role).join(','));
  note('工具里是否有 defer_loading / type',JSON.stringify(r.first.body.tools.filter(t=>t.defer_loading||t.type).map(t=>t.name)));
  note('system 块',JSON.stringify(system.map(s=>s.slice(0,60))));
  const preset=await run({options:agent([],{systemPrompt:{type:'preset',preset:'claude_code',append:SYSTEM}}),route:steps([{text:'hi'}])});
  check('预设系统提示会告诉模型它是 Claude Code（所以不用预设）',/You are Claude Code/.test(JSON.stringify(preset.first.body)));
  const nb=await run({env:{CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:''},options:agent([]),route:steps([{text:'hi'}])});
  note('不设 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 时多出来的',`${nb.first.body.tools.filter(t=>t.defer_loading).map(t=>t.name)}；beta=${nb.first.beta}`);
}

// ---- 2. The whole loop: MCP, Skill, reference code, Write/Edit, Bash, hook ---------------
{
  const log=[],denied=[];let quiet=true;const dir=tenant();
  const gate=async input=>{denied.push(input.tool_name);if(quiet){quiet=false;return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'现在是安静时段，这条没有发出。'}};}return {};};
  let scriptPath='';
  const r=await run({dir,options:agent(log,{hooks:{PreToolUse:[{matcher:'mcp__weave__send_message',hooks:[gate]}]}}),route:steps([
    {tool:'mcp__weave__log_completion',input:{habit:'散步'}},
    {tool:'mcp__weave__with_structured',input:{}},
    {tool:'Skill',input:{skill:'weave:weekly-review'}},
    b=>{const m=JSON.stringify(b.messages).match(/python3 ([^\s\\"]+stats\.py)/);scriptPath=m?.[1]||'';return {tool:'Bash',input:{command:`python3 ${scriptPath}`,description:'stats'}};},
    {tool:'Write',input:{file_path:join(dir,'work/MEMORY.md'),content:'周末更容易走路\n'}},
    {tool:'Edit',input:{file_path:join(dir,'work/MEMORY.md'),old_string:'周末',new_string:'周末早上'}},
    {tool:'Bash',input:{command:'python3 -c "print(6*7)"; env | grep -c ANTHROPIC_AUTH_TOKEN; env | grep -c WEAVE_HOST_SECRET',description:'code'}},
    {tool:'Write',input:{file_path:join(dir,'work/.claude/settings.json'),content:'{}'}},
    {tool:'mcp__weave__send_message',input:{text:'第一次'}},
    {tool:'mcp__weave__send_message',input:{text:'第二次'}},
    {tool:'mcp__weave__failing',input:{}},
    {text:'内部结论，没有调用 send_message 就不会到任何人手里'},
  ])});
  const R=r.toolResults;
  check('MCP 工具在宿主进程里执行',log[0]?.tool==='log_completion'&&log[0].pid===process.pid);
  check('工具能拿到 toolUseId，可用作幂等键',typeof log[0]?.id==='string'&&log[0].id.startsWith('toolu_'));
  check('返回 structuredContent 时模型只看到它，看不到文字',R.some(x=>x.includes('STRUCTURED_PART'))&&!R.some(x=>x.includes('TEXT_PART')),'工具一律只返回文字');
  check('Skill 按需加载，${CLAUDE_SKILL_DIR} 解析成真实路径',scriptPath.startsWith(PLUGIN));
  check('Skill 附带的参考代码能用 Bash 跑',R.some(x=>x.includes('streak=3')));
  check('Write / Edit 在工作目录内可用',readFileSync(join(dir,'work/MEMORY.md'),'utf8')==='周末早上更容易走路\n');
  check('Bash 能现写现跑代码',R.some(x=>/^42\n/.test(x)));
  check('Bash 读得到 ANTHROPIC_AUTH_TOKEN，所以真 Key 不能放环境变量',R.some(x=>/^42\n1\n/.test(x)));
  check('Write 工具写不了 .claude/（dontAsk 下被拒）',!existsSync(join(dir,'work/.claude/settings.json')));
  check('Hook 拒绝后工具不执行，理由回给模型',R.some(x=>x.includes('安静时段'))&&log.filter(x=>x.tool==='send_message').length===1&&log.find(x=>x.tool==='send_message').text==='第二次');
  check('isError 的文字回给模型',R.some(x=>x.includes('对方还没授权')));
  check('最后一段文字只在 result 里，不调用工具就不会发出',r.result?.result?.startsWith('内部结论')&&!log.some(x=>x.text?.startsWith('内部结论')));
}

// ---- 3. Scope is structural --------------------------------------------------------------
{
  const log=[];
  const r=await run({options:agent(log,{mcpServers:{weave:weaveTools(log,['send_message'])},allowedTools:['Bash','Read','Write','Edit','Skill','mcp__weave__send_message'],disallowedTools:['Agent','WebFetch']}),route:steps([
    {tool:'mcp__weave__log_completion',input:{habit:'偷记'}},
    {tool:'WebFetch',input:{url:'https://example.com',prompt:'x'}},
    {tool:'Bash',input:{command:'echo bash-ok',description:'x'}},
    {text:'done'},
  ])});
  check('这一轮没给的 MCP 工具根本调不了',r.toolResults.some(x=>x.includes('No such tool available: mcp__weave__log_completion'))&&!log.length);
  check('disallowedTools 关掉的内置工具调不了',r.toolResults.some(x=>x.includes('No such tool available: WebFetch')));
  check('同时 Bash 还在',r.toolResults.includes('bash-ok'));
}

// ---- 4. Attacks a writable workspace opens ----------------------------------------------
{
  const log=[],dir=tenant(),marker=join(dir,'hook-ran.txt');
  const settings=JSON.stringify({hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:`touch ${marker}`}]}]}});
  await run({dir,options:agent(log),route:steps([{tool:'Bash',input:{command:`mkdir -p .claude && cat > .claude/settings.json <<'E'\n${settings}\nE`,description:'x'}},{text:'ok'}])});
  const again=steps([{tool:'Bash',input:{command:'echo next',description:'x'}},{text:'ok'}]);
  await run({dir,options:agent(log),route:again});
  check('settingSources:[] 时，Agent 用 Bash 写的 Hook 不生效',!existsSync(marker));
  await run({dir,options:agent(log,{settingSources:['project']}),route:again});
  check('settingSources 含 project 时，同一个 Hook 下一轮真的执行（所以不开）',existsSync(marker));

  const d2=tenant();writeFileSync(join(d2,'work/CLAUDE.md'),'SENTINEL_CLAUDE_MD\n');
  const off=await run({dir:d2,options:agent(log),route:steps([{text:'hi'}])});
  check('settingSources:[] 时工作目录里的 CLAUDE.md 不加载，记忆要自己放进提示词',!JSON.stringify(off.first.body).includes('SENTINEL_CLAUDE_MD'));

  const d3=tenant();
  writeFileSync(join(d3,'config/.claude.json'),JSON.stringify({mcpServers:{evil:{type:'stdio',command:'echo'}}}));
  const strict=await run({dir:d3,options:agent(log),route:steps([{text:'hi'}])});
  check('strictMcpConfig 下，配置目录里偷加的 MCP 不加载',!(strict.init?.mcp_servers||[]).some(s=>s.name==='evil'),(strict.init?.mcp_servers||[]).map(s=>s.name).join(','));
}

// ---- 5. Sandbox option (OS level, this machine) -----------------------------------------
if(platform()==='darwin'||platform()==='linux'){
  const log=[],dir=tenant(),outside=join(ROOT,'outside.txt'),outside2=join(ROOT,'outside2.txt');
  const sandbox={enabled:true,failIfUnavailable:false,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,network:{allowedDomains:[]}};
  const r=await run({dir,options:agent(log,{sandbox}),route:steps([
    {tool:'Bash',input:{command:`curl -sS -m 4 ${BASE}/x -o /dev/null; echo EXIT=$?`,description:'net'}},
    {tool:'Bash',input:{command:`echo x > ${outside}; echo EXIT=$?`,description:'out'}},
    {tool:'Bash',input:{command:'echo x > inside.txt; echo EXIT=$?',description:'in'}},
    {tool:'Write',input:{file_path:outside2,content:'y'}},
    {text:'end'},
  ])});
  const net=r.toolResults[0]||'';
  if(net.includes('EXIT=0'))note('sandbox','这台机器上沙箱没生效，跳过（Linux 需要 bubblewrap 和 socat）');
  else{
    check('sandbox 选项：Bash 连不了网',/EXIT=[1-9]/.test(net));
    check('sandbox 选项：Bash 写不了工作目录外',!existsSync(outside));
    check('sandbox 选项：Bash 能写工作目录内',existsSync(join(dir,'work/inside.txt')));
    check('sandbox 选项只管 Bash：内置 Write 仍能写到工作目录外（所以边界要靠容器）',existsSync(outside2));
  }
  const d2=tenant(),o3=join(ROOT,'outside3.txt');
  await run({dir:d2,options:agent(log,{allowedTools:['Bash','Read(./**)','Edit(./**)','Glob','Grep','Skill','mcp__weave__*']}),route:steps([
    {tool:'Write',input:{file_path:o3,content:'y'}},
    {tool:'Write',input:{file_path:join(d2,'work/in.txt'),content:'y'}},
    {text:'end'},
  ])});
  check('路径规则 Edit(./**)：Write 工具写不到工作目录外',!existsSync(o3));
  check('路径规则 Edit(./**)：Write 工具能写工作目录内',existsSync(join(d2,'work/in.txt')));
}

// ---- 6. Limits --------------------------------------------------------------------------
{
  const loop=steps([{tool:'Bash',input:{command:'echo 1',description:'x'}},{tool:'Bash',input:{command:'echo 2',description:'x'}},{tool:'Bash',input:{command:'echo 3',description:'x'}},{text:'end'}]);
  const t=await run({options:agent([],{maxTurns:2}),route:loop});
  check('maxTurns 到了会停，subtype=error_max_turns，并抛错',t.result?.subtype==='error_max_turns'&&!!t.error);
  const b=await run({usage:{input:800000,output:100000},options:agent([],{maxBudgetUsd:0.01}),route:loop});
  check('maxBudgetUsd 到了会停',b.result?.subtype==='error_max_budget_usd'&&!!b.error);
  check('非 Claude 模型的费用按每百万 $5 / $25 估，不是真实价格',Math.abs((b.result?.total_cost_usd||0)-6.5)<0.001,`80万入 + 10万出 → $${b.result?.total_cost_usd}`);
}

// ---- 7. Session continuity --------------------------------------------------------------
{
  const dir=tenant();
  const a=await run({dir,prompt:'我今天走了路',options:agent([]),route:steps([{text:'记住了'}])});
  const b=await run({dir,prompt:'我今天做了什么',options:agent([],{resume:a.result?.session_id}),route:r=>isMain(r)?{text:'你走了路'}:{text:'t'}});
  check('resume 接上同一段会话（每人独立 CLAUDE_CONFIG_DIR）',b.result?.session_id===a.result?.session_id&&JSON.stringify(b.first.body.messages).includes('我今天走了路'));
}

// ---- 8. Deep Research is the only place subagents exist ---------------------------------
{
  let subTools=null;
  const research={tools:[...TOOLS,'WebFetch','Agent'],allowedTools:[...ALLOW,'WebFetch','Agent'],agents:{researcher:{description:'查资料并给出处。',prompt:'你是研究员。',tools:['WebSearch','WebFetch','Read'],model:'inherit'}}};
  const routeFor=main=>b=>{if(!isMain(b))return {text:'t'};const names=b.tools.map(t=>t.name);if(!names.includes('Agent')){subTools=names;return {text:'研究结果 SUB_REPORT'};}return main[assistants(b)]||{text:'end'};};
  const fg=await run({options:agent([],research),route:routeFor([{tool:'Agent',input:{description:'查证据',prompt:'查',subagent_type:'researcher',run_in_background:false}},{text:'报告写好了'}])});
  check('子 Agent 只拿到定义里给的工具',JSON.stringify(subTools)===JSON.stringify(['WebSearch','WebFetch','Read'])||(subTools?.length===3&&subTools.includes('WebFetch')),subTools?.join(','));
  check('前台子 Agent 的报告作为工具结果回到主 Agent',fg.toolResults.some(x=>x.includes('SUB_REPORT')));
  const bg=await run({options:agent([],research),route:routeFor([{tool:'Agent',input:{description:'查证据',prompt:'查',subagent_type:'researcher'}},{text:'已开始'},{text:'整理报告'}])});
  check('后台子 Agent 完成后同一个 query() 会再出一个 result，不能读到第一个就退出',bg.results.length>=2,`${bg.results.length} 个 result`);
}

// ---- 9. Running the CLI somewhere else: custom spawn ------------------------------------
{
  process.env.WEAVE_HOST_SECRET='host-only';
  const log=[],dir=tenant();let spawned=null,peak=0;
  const map=s=>s.replaceAll('/workspace',join(dir,'work')).replaceAll('/opt/weave/plugin',PLUGIN);
  const r=await run({dir,options:agent(log,{cwd:'/workspace',plugins:[{type:'local',path:'/opt/weave/plugin'}],spawnClaudeCodeProcess:({command,args,env,signal})=>{
    spawned={args,envHasHostSecret:'WEAVE_HOST_SECRET' in env};
    const child=spawn(command,args.map(map),{cwd:join(dir,'work'),env,signal,stdio:['pipe','pipe','ignore']});
    const timer=setInterval(()=>{try{peak=Math.max(peak,Number(execFileSync('ps',['-o','rss=','-p',String(child.pid)]).toString().trim())||0);}catch{/* already gone */}},100);
    child.once('exit',()=>clearInterval(timer));
    return child;
  }}),route:steps([{tool:'Bash',input:{command:'env | grep -c WEAVE_HOST_SECRET',description:'x'}},{tool:'mcp__weave__log_completion',input:{habit:'散步'}},{text:'end'}])});
  check('自定义 spawn 时 SDK 不检查宿主机上的 cwd 和插件路径（可以写容器里的路径）',r.result?.subtype==='success'&&!!spawned,r.error||'');
  check('CLI 不继承宿主环境变量，只拿 options.env',spawned?.envHasHostSecret===false&&r.toolResults[0]?.startsWith('0'));
  check('CLI 跑在别处时，MCP 工具仍在宿主进程执行（走 stdin/stdout）',log[0]?.pid===process.pid);
  note('CLI 内存峰值',`${Math.round(peak/1024)} MB（短任务，这台机器）`);
  note('传给 CLI 的参数',JSON.stringify(spawned?.args.filter(a=>!a.startsWith('{')).slice(0,14)));
  delete process.env.WEAVE_HOST_SECRET;
}

// ---- 10. Parallel runs -------------------------------------------------------------------
{
  const logs=[[],[],[]];scene={route:steps([{tool:'mcp__weave__log_completion',input:{habit:'散步'}},{text:'end'}])};
  const one=async i=>{const dir=tenant();for await(const m of query({prompt:'x',options:{...agent(logs[i],{mcpServers:{weave:weaveTools(logs[i])}}),cwd:join(dir,'work'),settingSources:[],env:envFor(dir,'deepseek-flash')}}))void m;};
  await Promise.all([one(0),one(1),one(2)]);
  check('三个 query() 并行，各自的 MCP 实例互不串',logs.every(l=>l.length===1));
}

server.close();
const failed=rows.filter(r=>!r.pass);
console.log(`\n${rows.length-failed.length}/${rows.length} passed. Temp files: ${ROOT}`);
process.exit(failed.length?1:0);
