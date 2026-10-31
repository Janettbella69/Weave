import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {handleAPI} from '../../../lib/weave/api.mjs';
import {gewechatConfig} from '../../../lib/weave/gewechat.mjs';
import {notionOAuthConfig} from '../../../lib/weave/notion.mjs';
export const dynamic='force-dynamic';
async function handle(request:Request){
  const config=env as unknown as Cloudflare.Env;
  return handleAPI(request,{db:config.DB,identity:await getChatGPTUser(),secret:config.WEAVE_ENCRYPTION_KEY,agentServiceUrl:config.AGENT_SERVICE_URL,agentServiceToken:config.AGENT_SERVICE_TOKEN,agentProviderApiKey:config.AGENT_PROVIDER_API_KEY,runnerToken:config.HERMES_RUNNER_TOKEN,gewechat:gewechatConfig(config),notionOAuth:notionOAuthConfig(config)});
}
export const GET=handle;
export const POST=handle;
