// 网站容器里的 Notion 本地代理（127.0.0.1:4319）：Worker 换 token、调 Notion API 都经过它。
// 单文件、不依赖仓库里别的代码（Dockerfile.vps 只把这一个文件拷进镜像）。
//
// 加固（见 test/notion-proxy.test.mjs）：
// - 对上游的每个请求都有超时，Notion 不回话时 Worker 拿到明确的 504，而不是一直挂着；
// - 任何错误回给 Worker 的内容都不带请求里的东西（client secret、token、授权码）：
//   格式错误的请求只回 bad_json，不回 JSON.parse 的报错（那条报错会带一段请求原文）；
//   上游的错误正文里如果出现我们发出去的密钥，替换成 [已隐藏]；
// - 只往 Notion 的 /v1/ 下面发，方法和路径都要合规。
//
// NOTION_UPSTREAM_BASE 只给测试用（scripts/notion-oauth-e2e 把它指向本机的假 Notion）。不设就是
// https://api.notion.com，线上行为不变；设了的话也只接受 https，或者本机回环地址上的 http。
import http from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_UPSTREAM = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";
const MAX_REQUEST_BYTES = 256 * 1024;
const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function upstreamOrigin(value = DEFAULT_UPSTREAM) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("NOTION_UPSTREAM_BASE 只能是 https，或本机回环地址上的 http");
  }
  return url.origin;
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "too_large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    // 不把 JSON.parse 的报错回出去：它会带一段请求原文，里面有密钥。
    throw new HttpError(400, "bad_json");
  }
}

// 把我们发给上游的密钥从要回给调用方的文字里去掉。
function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join("[已隐藏]");
  return out;
}

export function createNotionProxy({ upstream = DEFAULT_UPSTREAM, timeoutMs = 20000, fetcher = fetch } = {}) {
  const origin = upstreamOrigin(upstream);

  function send(res, status, body, type = "application/json") {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  // 调上游。超时和连不上都变成 504 / 502，错误里不带任何东西。成功的响应原样转回；
  // 失败（非 2xx）的响应正文要先把发出去的密钥隐藏掉。
  async function callUpstream(res, label, url, init, secrets) {
    let response, text;
    try {
      response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch (err) {
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      console.error(`notion-oauth-proxy: ${label} ${timedOut ? "timed out" : "failed"}`);
      throw new HttpError(timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_unreachable");
    }
    if (!response.ok) console.error(`notion-oauth-proxy: ${label} answered ${response.status}`);
    send(res, response.status, response.ok ? text : redact(text, secrets));
  }

  async function exchange(req, res) {
    const { clientId, clientSecret, code, redirectUri } = await readJson(req);
    if (!clientId || !clientSecret || !code || !redirectUri) throw new HttpError(400, "missing_fields");
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    await callUpstream(res, "exchange", `${origin}/v1/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    }, [clientSecret, auth, code]);
  }

  // 通用转发：POST /api  { method, path, token, body, notionVersion }
  async function forward(req, res) {
    const body = await readJson(req);
    const method = String(body.method || "GET").toUpperCase();
    const path = String(body.path || "").replace(/^\/+/, "");
    const token = body.token;
    if (!path || !token || typeof token !== "string") throw new HttpError(400, "missing_path_or_token");
    if (!METHODS.has(method)) throw new HttpError(400, "bad_method");
    let target;
    try {
      target = new URL("/v1/" + path, origin);
    } catch {
      throw new HttpError(400, "bad_path");
    }
    // 不管 path 写成什么，都得落在 Notion 自己的 /v1/ 下面，而且不带 ..、. 或反斜杠（连百分号编码的 %2f 也不行：
    // 上游如果先解码再规整路径，..%2f 就能跳出 /v1/）。
    let decoded;
    try {
      decoded = decodeURIComponent(target.pathname);
    } catch {
      throw new HttpError(400, "bad_path");
    }
    if (target.origin !== origin || !target.pathname.startsWith("/v1/") || decoded.includes("\\") || decoded.split("/").some(part => part === "." || part === "..")) {
      throw new HttpError(400, "bad_path");
    }
    await callUpstream(res, `${method} /v1/${path.split("?")[0].split("/")[0]}`, target.href, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": typeof body.notionVersion === "string" && body.notionVersion ? body.notionVersion : NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body.body != null ? JSON.stringify(body.body) : undefined,
    }, [token]);
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return send(res, 200, "ok", "text/plain");
      if (req.method === "POST" && req.url === "/exchange") return await exchange(req, res);
      if (req.method === "POST" && req.url === "/api") return await forward(req, res);
      res.writeHead(404);
      res.end();
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.code });
      console.error("notion-oauth-proxy: unexpected error");
      send(res, 502, { error: "proxy_failed" });
    }
  });
}

// 直接运行（node scripts/notion-oauth-proxy.mjs）时才监听；被测试 import 时不监听。
// import.meta.url 是解开符号链接后的真实路径，所以另一边也要解开，不然从链接路径启动会悄悄什么都不做。
const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  const port = Number(process.env.NOTION_OAUTH_PROXY_PORT || 4319);
  const timeoutMs = Number(process.env.NOTION_PROXY_TIMEOUT_MS || 20000);
  const server = createNotionProxy({ upstream: process.env.NOTION_UPSTREAM_BASE || DEFAULT_UPSTREAM, timeoutMs });
  server.listen(port, "127.0.0.1", () => {
    console.log(`notion-oauth-proxy listening on 127.0.0.1:${port}`);
  });
}
