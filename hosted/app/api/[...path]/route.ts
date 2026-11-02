import {env} from 'cloudflare:workers';
import {getWeaveUser} from '../../weave-auth';
import {handleAPI} from '../../../lib/weave/api.mjs';
import {wechatConfig} from '../../../lib/weave/wechat.mjs';
import {notionOAuthConfig} from '../../../lib/weave/notion.mjs';
export const dynamic='force-dynamic';
async function handle(request:Request){
  const config=env as unknown as Cloudflare.Env;
  return handleAPI(request,{db:config.DB,identity:await getWeaveUser(),secret:config.WEAVE_ENCRYPTION_KEY,agentServiceUrl:config.AGENT_SERVICE_URL,agentServiceToken:config.AGENT_SERVICE_TOKEN,agentProviderApiKey:config.AGENT_PROVIDER_API_KEY,runnerToken:config.HERMES_RUNNER_TOKEN,wechat:wechatConfig(config),notionOAuth:notionOAuthConfig(config)});
}
export const GET=handle;
export const POST=handle;
