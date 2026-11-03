import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import {runScheduled} from '../lib/weave/scheduler.mjs';
import {basicAuthGate} from '../lib/weave/basic-auth.mjs';
import {withBufferedBody} from '../lib/weave/request-body.mjs';

const worker = {
  async scheduled(_event: ScheduledController, env: Cloudflare.Env) {
    // Cron is the server's own clock here, so it also does the background wakes (proactive design §4.7).
    try { await runScheduled({db:env.DB,secret:env.WEAVE_ENCRYPTION_KEY,env,agentRuntime:env.WEAVE_AGENT_RUNTIME,agentServiceUrl:env.AGENT_SERVICE_URL,agentServiceToken:env.AGENT_SERVICE_TOKEN,agentProviderApiKey:env.AGENT_PROVIDER_API_KEY,now:Date.now(),proactive:true}); }
    catch(error){ console.error('Reminder scheduler failed:',error instanceof Error?error.message:'unknown'); throw error; }
  },
  async fetch(incoming: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    // Read the whole body before anything answers, or wrangler dev's proxy fails on the reused connection
    // (503 "worker restarted mid-request", or wrangler exits on "/"). See lib/weave/request-body.mjs.
    const request: Request = await withBufferedBody(incoming);
    // Access password for single-user deployments; internal machine-to-machine routes are exempt.
    const denied = await basicAuthGate(request, env.WEAVE_BASIC_AUTH);
    if (denied) return denied;
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};

export default worker;
