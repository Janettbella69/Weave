import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export async function runAgent(input,query){
  if(typeof input.apiKey!=='string'||input.apiKey.length<12||!['deepseek-flash','deepseek-v4-pro'].includes(input.model)||typeof input.system!=='string'||input.system.length>5000)throw Error('Agent 参数无效');
  const dir=await mkdtemp(join(tmpdir(),'weave-agent-'));
  const abortController=new AbortController(),timer=setTimeout(()=>abortController.abort(),110000);
  try{
    const session=query({prompt:JSON.stringify(input.input),options:{
      model:input.model,systemPrompt:input.system+(input.json?' 只输出有效 JSON 对象，不要 Markdown。':''),
      cwd:dir,settingSources:[],tools:[],disallowedTools:['*'],permissionMode:'dontAsk',
      persistSession:false,maxTurns:2,abortController,
      env:{PATH:process.env.PATH,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'.claude'),
        ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_AUTH_TOKEN:input.apiKey,ANTHROPIC_API_KEY:'',
        ANTHROPIC_MODEL:input.model,ANTHROPIC_DEFAULT_HAIKU_MODEL:input.model,ANTHROPIC_DEFAULT_SONNET_MODEL:input.model,ANTHROPIC_DEFAULT_OPUS_MODEL:input.model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},
    }});
    for await(const message of session){
      if(message.type==='result'){
        if(message.subtype!=='success'||typeof message.result!=='string'||!message.result.trim())throw Error('Agent 未能生成完整结果');
        return input.json?JSON.parse(message.result.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')):message.result;
      }
    }
    throw Error('Agent 未返回结果');
  }finally{clearTimeout(timer);await rm(dir,{recursive:true,force:true});}
}
