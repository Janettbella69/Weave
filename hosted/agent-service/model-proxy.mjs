// 模型代理（docs/ARCHITECTURE.md 第 6、12 节）。CLI 只拿到这一轮的运行令牌：Bash 读得到它，
// 但它只能在这一轮里、为这一家的这几个模型调用 /v1/messages，并且记在这个账号的额度上。
// 真 Key 只在这个进程里。一轮结束 close() 之后令牌立即作废。
import {randomBytes} from 'node:crypto';
import {providerFor, modelAllowed} from './providers.mjs';

const PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const MAX_BODY = 8 * 1024 * 1024;
// 草稿文案，待确认。
const QUOTA_MESSAGE = '今天的模型额度用完了，明天再来。';
const FORWARD_REQUEST = ['anthropic-version', 'anthropic-beta'];
const FORWARD_RESPONSE = ['content-type', 'request-id', 'retry-after', 'x-should-retry'];
// 上游这些错误重试也没用（Key 无效、请求不合规）。不告诉 CLI 的话，它会退避重试十次、拖上三分钟（实测）。
const NO_RETRY = new Set([400, 401, 403, 404, 413, 422]);

function sendError(res, status, type, message, headers = {}) {
  res.writeHead(status, {'Content-Type': 'application/json', ...headers});
  res.end(JSON.stringify({type: 'error', error: {type, message}}));
}

const inputOf = usage => (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

// 边转发边数 token：流式取 message_start 的输入和 message_delta 的输出，非流式取 usage。
function tokenMeter() {
  const decoder = new TextDecoder();
  let pending = '', whole = '', input = 0, output = 0;
  const onData = data => {
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === 'message_start' && event.message?.usage) input = inputOf(event.message.usage);
    if (event.type === 'message_delta' && event.usage && Number.isFinite(event.usage.output_tokens)) output = event.usage.output_tokens;
  };
  return {
    push(chunk) {
      const text = decoder.decode(chunk, {stream: true});
      if (whole.length < 4_000_000) whole += text;
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.startsWith('data:')) onData(line.slice(5).trim());
      }
    },
    total(contentType) {
      if (!/event-stream/.test(contentType || '')) {
        try {
          const usage = JSON.parse(whole).usage;
          if (usage) { input = inputOf(usage); output = usage.output_tokens || 0; }
        } catch { /* not JSON: nothing to count */ }
      }
      return input + output;
    },
  };
}

export function createModelProxy({keys, upstreams = {}, ledger, limits, fetcher = fetch}) {
  const runs = new Map();

  function openRun({account, provider, model, userKey}) {
    const p = providerFor(provider);
    if (!modelAllowed(p, model)) throw Object.assign(Error(`${p.name} 不支持模型 ${model}`), {status: 400});
    const key = userKey || keys[p.name];
    if (!key) throw Object.assign(Error(`没有 ${p.name} 的模型 Key`), {status: 503});
    const token = randomBytes(24).toString('hex');
    runs.set(token, {account, provider: p, key, metered: !userKey});
    return {token, close: () => { runs.delete(token); }};
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://model-proxy');
    if (req.method !== 'POST' || !PATHS.has(url.pathname)) return sendError(res, 404, 'not_found_error', 'Not found');
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const run = runs.get(bearer ?? req.headers['x-api-key']);
    if (!run) return sendError(res, 401, 'authentication_error', 'Invalid or expired run token');

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      // 超长后不再缓存，但把请求读完再回答：提前断开的话，客户端只看到连接被重置，看不到 413。
      if (size <= MAX_BODY) chunks.push(chunk);
    }
    if (size > MAX_BODY) return sendError(res, 413, 'request_too_large', 'Request too large');
    const raw = Buffer.concat(chunks);
    let body;
    try { body = JSON.parse(raw); } catch { return sendError(res, 400, 'invalid_request_error', 'Invalid JSON'); }
    if (!modelAllowed(run.provider, body?.model)) return sendError(res, 400, 'invalid_request_error', `Model not allowed: ${body?.model}`);
    // x-should-retry: false 让 CLI 不要反复重试：额度明天才恢复。
    if (run.metered && (ledger.used(run.account) >= limits.perAccount || ledger.total() >= limits.total)) {
      return sendError(res, 429, 'rate_limit_error', QUOTA_MESSAGE, {'x-should-retry': 'false'});
    }

    const headers = {'content-type': 'application/json', authorization: 'Bearer ' + run.key};
    for (const name of FORWARD_REQUEST) if (req.headers[name]) headers[name] = req.headers[name];
    let upstream;
    try {
      upstream = await fetcher((upstreams[run.provider.name] || run.provider.baseUrl) + url.pathname + url.search, {method: 'POST', headers, body: raw, signal: AbortSignal.timeout(300_000)});
    } catch {
      return sendError(res, 502, 'api_error', 'Model provider unavailable');
    }
    const outgoing = {};
    for (const name of FORWARD_RESPONSE) { const value = upstream.headers.get(name); if (value) outgoing[name] = value; }
    if (NO_RETRY.has(upstream.status)) outgoing['x-should-retry'] = 'false';
    res.writeHead(upstream.status, outgoing);
    const meter = tokenMeter();
    try {
      if (upstream.body) for await (const chunk of upstream.body) { res.write(chunk); meter.push(chunk); }
    } catch { /* upstream dropped mid-stream; count what arrived */ }
    res.end();
    const tokens = meter.total(upstream.headers.get('content-type'));
    if (run.metered && tokens > 0) ledger.add(run.account, tokens);
  }

  return {handler, openRun};
}
