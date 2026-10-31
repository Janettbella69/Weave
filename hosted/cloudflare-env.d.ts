declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    WEAVE_ENCRYPTION_KEY?: string;
    AGENT_SERVICE_URL?: string;
    AGENT_SERVICE_TOKEN?: string;
    BUCKET?: R2Bucket;
  }
}
