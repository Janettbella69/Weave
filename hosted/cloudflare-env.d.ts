declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    WEAVE_ENCRYPTION_KEY?: string;
    AGENT_SERVICE_URL?: string;
    AGENT_SERVICE_TOKEN?: string;
    WEAVE_AGENT_RUNTIME?: string;
    WEAVE_BASIC_AUTH?: string;
    AGENT_PROVIDER_API_KEY?: string;
    HERMES_RUNNER_TOKEN?: string;
    WECHAT_BRIDGE_TOKEN?: string;
    WEAVE_WECHAT_IMAGES?: string;
    AGENT_DAILY_CALLS_PER_ACCOUNT?: string;
    AGENT_DAILY_CALLS_TOTAL?: string;
    NOTION_OAUTH_CLIENT_ID?: string;
    NOTION_OAUTH_CLIENT_SECRET?: string;
    NOTION_OAUTH_REDIRECT_URI?: string;
    NOTION_PUBLIC_ORIGIN?: string;
    BUCKET?: R2Bucket;
  }
}
