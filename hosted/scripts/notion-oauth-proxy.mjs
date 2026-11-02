import http from "node:http";

const port = Number(process.env.NOTION_OAUTH_PROXY_PORT || 4319);

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/exchange") {
      const body = await readJson(req);
      const { clientId, clientSecret, code, redirectUri } = body;
      if (!clientId || !clientSecret || !code || !redirectUri) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_fields" }));
        return;
      }
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const upstream = await fetch("https://api.notion.com/v1/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(text);
      return;
    }

    // Generic Notion API proxy: POST /api  { method, path, token, body }
    if (req.method === "POST" && req.url === "/api") {
      const body = await readJson(req);
      const method = body.method || "GET";
      const path = String(body.path || "").replace(/^\/+/, "");
      const token = body.token;
      if (!path || !token) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_path_or_token" }));
        return;
      }
      const upstream = await fetch("https://api.notion.com/v1/" + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": body.notionVersion || "2022-06-28",
          "Content-Type": "application/json",
        },
        body: body.body != null ? JSON.stringify(body.body) : undefined,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(text);
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_failed", message: String(err && err.message || err) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`notion-oauth-proxy listening on 127.0.0.1:${port}`);
});
