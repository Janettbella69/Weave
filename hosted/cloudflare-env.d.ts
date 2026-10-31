declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    WEAVE_ENCRYPTION_KEY?: string;
    AGENT_SERVICE_URL?: string;
    AGENT_SERVICE_TOKEN?: string;
    AGENT_PROVIDER_API_KEY?: string;
    HERMES_RUNNER_TOKEN?: string;
    GEWECHAT_BASE_URL?: string;
    GEWECHAT_TOKEN?: string;
    GEWECHAT_APP_ID?: string;
    GEWECHAT_CALLBACK_SECRET?: string;
    GEWECHAT_PUBLIC_ORIGIN?: string;
    NOTION_OAUTH_CLIENT_ID?: string;
    NOTION_OAUTH_CLIENT_SECRET?: string;
    NOTION_OAUTH_REDIRECT_URI?: string;
    NOTION_PUBLIC_ORIGIN?: string;
    BUCKET?: R2Bucket;
  }
}
