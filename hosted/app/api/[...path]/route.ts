import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {handleAPI} from '../../../lib/weave/api.mjs';
export const dynamic='force-dynamic';
async function handle(request:Request){
  const config=env as unknown as Record<string,any>;
  return handleAPI(request,{db:config.DB,identity:await getChatGPTUser(),secret:config.WEAVE_ENCRYPTION_KEY,agentServiceUrl:config.AGENT_SERVICE_URL,agentServiceToken:config.AGENT_SERVICE_TOKEN});
}
export const GET=handle;
export const POST=handle;
