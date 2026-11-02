// 假的 Notion：只实现 Weave 的代码用到的接口，给端到端演练用。不连任何真实服务，不需要真实钥匙。
//   POST /v1/oauth/token          用授权码换 token（Basic 认证，client id/secret 要对得上）
//   POST /v1/search               列出这个 token 看得到的页面（最近编辑的在前，和真实 Notion 默认一样）
//   POST /v1/pages                在看得到的页面下面建子页面（Weave 的「同步计划」）
//   GET  /v1/blocks/:id/children  读页面内容（Weave 的「记忆」）
//   PATCH /v1/blocks/:id/children 在页面末尾追加内容（只加不改，和真实 Notion 一样每次最多 100 块、每块文字最多 2000 字）
// 每个授权码对应一份「授权结果」：换到的 token、用户在 Notion 里勾选的页面，以及想让哪一步出错。
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const NOTION_VERSION = '2022-06-28';

// 造一个页面对象，字段和真实 API 返回的一致（只留 Weave 会用到的）。
// parent: 'workspace' | 另一个页面的 id | {database: 数据库 id}
export function notionPage({ id = randomUUID(), title = '无标题', parent = 'workspace', edited = new Date().toISOString(), archived = false, inTrash = false } = {}) {
  const parentObject = parent === 'workspace' ? { type: 'workspace', workspace: true }
    : typeof parent === 'object' && parent.database ? { type: 'database_id', database_id: parent.database }
    : { type: 'page_id', page_id: parent };
  const titleKey = typeof parent === 'object' && parent.database ? 'Name' : 'title';
  return {
    object: 'page', id, created_time: edited, last_edited_time: edited, archived, in_trash: inTrash, parent: parentObject,
    properties: { [titleKey]: { id: 'title', type: 'title', title: title ? [{ type: 'text', text: { content: title }, plain_text: title }] : [] } },
    url: `https://www.notion.so/${encodeURIComponent(title)}-${id.replaceAll('-', '')}`,
  };
}

// 造一个块（段落、标题、列表……），字段和真实 API 一致。extra: {id, hasChildren, checked, language, url, caption, ...}
export function notionBlock(type, text = '', { id = randomUUID(), hasChildren = false, ...data } = {}) {
  const richText = value => (value ? [{ type: 'text', text: { content: value }, plain_text: value }] : []);
  const { caption, ...rest } = data;
  const body = type === 'child_page' || type === 'child_database' ? { title: text, ...rest } : { rich_text: richText(text), ...rest };
  if (caption !== undefined) body.caption = richText(caption);
  return { object: 'block', id, type, has_children: hasChildren, [type]: body };
}

export function createFakeNotion({ clientId, clientSecret, redirectUri }) {
  const grants = new Map();   // 授权码 → 授权结果
  const tokens = new Map();   // access token → 授权结果
  const requests = [];        // 收到的每个请求：{method, path, authorization, version, body}
  const written = [];         // 通过 POST /v1/pages 建出来的页面
  const appended = [];        // 通过 PATCH /v1/blocks/:id/children 追加的内容
  const hanging = new Set();  // 故意不回话的连接，close() 时一起断掉
  const issued = new Set();   // 发出过的所有 token（reset 也不清），最后用来检查有没有漏到别处
  const blocks = new Map();   // 页面或块的 id → 它的子块（没登记的页面返回一个固定段落）
  const blockStatus = new Map(); // 页面或块的 id → 让读它的子块时返回这个状态码（模拟读不出来）

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const apiError = (res, status, code, message) => send(res, status, { object: 'error', status, code, message, request_id: randomUUID() });

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    try { return raw ? JSON.parse(raw) : {}; } catch { return { __invalid: raw }; }
  }

  function handleToken(req, res, body) {
    const expected = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    if (req.headers.authorization !== expected) return send(res, 401, { error: 'unauthorized', error_description: 'client authentication failed' });
    const grant = grants.get(body.code);
    if (body.grant_type !== 'authorization_code' || !grant || (grant.used && !grant.reusable) || body.redirect_uri !== redirectUri) {
      return send(res, 400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired, revoked, or does not match the redirection URI.' });
    }
    if (grant.exchange === 'hang') { hanging.add(res); return; }
    if (grant.exchange === 'server_error') return send(res, 500, { error: 'server_error' });
    if (grant.exchange === 'garbage') return send(res, 200, '<html>not json</html>');
    if (grant.exchange === 'no_token') return send(res, 200, { token_type: 'bearer' });
    grant.used = true;
    send(res, 200, {
      access_token: grant.token, token_type: 'bearer', bot_id: randomUUID(), workspace_id: randomUUID(),
      workspace_name: grant.workspaceName, workspace_icon: null, duplicated_template_id: null,
      owner: { type: 'user', user: { object: 'user', id: randomUUID(), name: 'Fake User' } }, request_id: randomUUID(),
    });
  }

  function authorized(req, res) {
    if (req.headers['notion-version'] !== NOTION_VERSION) { apiError(res, 400, 'validation_error', 'Notion-Version header is missing or unsupported.'); return null; }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const grant = tokens.get(token);
    if (!grant || grant.revoked) { apiError(res, 401, 'unauthorized', 'API token is invalid.'); return null; }
    return grant;
  }

  function handleSearch(req, res, body) {
    const grant = authorized(req, res);
    if (!grant) return;
    grant.searches++;
    if (grant.search === 'hang') { hanging.add(res); return; }
    if (grant.search === 'server_error') return apiError(res, 500, 'internal_server_error', 'Unexpected error.');
    if (grant.search === 'unauthorized') return apiError(res, 401, 'unauthorized', 'API token is invalid.');
    // 真实 Notion 的搜索索引有延迟：刚授权完的头几次搜索可能什么都搜不到。
    const titleOf = page => Object.values(page.properties || {}).find(property => property.type === 'title')?.title?.map(part => part.plain_text).join('') || '';
    const query = typeof body.query === 'string' ? body.query.toLowerCase() : '';
    const visible = grant.searches <= grant.emptySearches ? [] : grant.pages.filter(page => (body.filter?.value !== 'page' || page.object === 'page') && (!query || titleOf(page).toLowerCase().includes(query)));
    const sorted = [...visible].sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time));
    const size = Math.min(Number(body.page_size) || 100, 100), start = Number(body.start_cursor) || 0;
    const results = sorted.slice(start, start + size), more = start + size < sorted.length;
    send(res, 200, { object: 'list', results, next_cursor: more ? String(start + size) : null, has_more: more, type: 'page_or_database', page_or_database: {}, request_id: randomUUID() });
  }

  function handleCreatePage(req, res, body) {
    const grant = authorized(req, res);
    if (!grant) return;
    const parentId = body.parent?.page_id;
    if (!parentId || !grant.pages.some(page => page.id === parentId)) return apiError(res, 404, 'object_not_found', `Could not find page with ID: ${parentId}. Make sure the relevant pages and databases are shared with your integration.`);
    const title = body.properties?.title?.title?.map(part => part.text?.content || '').join('') || '';
    const page = notionPage({ title, parent: parentId });
    const record = { id: page.id, parentId, title, children: body.children || [], token: [...tokens].find(([, g]) => g === grant)?.[0], version: req.headers['notion-version'] };
    written.push(record);
    send(res, 200, { ...page, request_id: randomUUID() });
  }

  function handleChildren(req, res, id, url) {
    const grant = authorized(req, res);
    if (!grant) return;
    if (blockStatus.has(id)) return apiError(res, blockStatus.get(id), blockStatus.get(id) === 404 ? 'object_not_found' : 'internal_server_error', 'Could not read the block.');
    const isPage = grant.pages.some(page => page.id === id);
    if (!isPage && !blocks.has(id)) return apiError(res, 404, 'object_not_found', 'Could not find block.');
    const all = blocks.get(id) || (isPage ? [{ object: 'block', id: randomUUID(), type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: '我的长期目标：每天走路。' }] } }] : []);
    const size = Math.min(Number(url.searchParams.get('page_size')) || 100, 100), start = Number(url.searchParams.get('start_cursor')) || 0;
    const more = start + size < all.length;
    send(res, 200, { object: 'list', results: all.slice(start, start + size), next_cursor: more ? String(start + size) : null, has_more: more });
  }

  function handleAppend(req, res, id, body) {
    const grant = authorized(req, res);
    if (!grant) return;
    if (!grant.pages.some(page => page.id === id) && !blocks.has(id)) return apiError(res, 404, 'object_not_found', `Could not find block with ID: ${id}.`);
    const children = body.children;
    if (!Array.isArray(children) || !children.length || children.length > 100) return apiError(res, 400, 'validation_error', 'body.children must be an array of 1 to 100 blocks.');
    for (const child of children) {
      const parts = child?.paragraph?.rich_text;
      if (child?.object !== 'block' || child.type !== 'paragraph' || !Array.isArray(parts) || parts.some(part => String(part?.text?.content ?? '').length > 2000)) {
        return apiError(res, 400, 'validation_error', 'body.children[0].paragraph.rich_text[0].text.content.length should be ≤ 2000.');
      }
    }
    const created = children.map(child => ({ ...child, id: randomUUID(), has_children: false }));
    blocks.set(id, [...(blocks.get(id) || []), ...created]);
    appended.push({ id, children, token: [...tokens].find(([, g]) => g === grant)?.[0], version: req.headers['notion-version'] });
    send(res, 200, { object: 'list', results: created, next_cursor: null, has_more: false });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-notion.local');
    const body = req.method === 'GET' ? {} : await readBody(req);
    requests.push({ method: req.method, path: url.pathname + url.search, authorization: req.headers.authorization || '', version: req.headers['notion-version'] || '', body });
    if (body.__invalid !== undefined) return apiError(res, 400, 'invalid_json', 'Error parsing JSON body.');
    if (req.method === 'POST' && url.pathname === '/v1/oauth/token') return handleToken(req, res, body);
    if (req.method === 'POST' && url.pathname === '/v1/search') return handleSearch(req, res, body);
    if (req.method === 'POST' && url.pathname === '/v1/pages') return handleCreatePage(req, res, body);
    const children = req.method === 'GET' && url.pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/);
    if (children) return handleChildren(req, res, decodeURIComponent(children[1]), url);
    const append = req.method === 'PATCH' && url.pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/);
    if (append) return handleAppend(req, res, decodeURIComponent(append[1]), body);
    apiError(res, 404, 'invalid_request_url', `Invalid request URL: ${url.pathname}`);
  });

  return {
    requests, written, appended,
    // 登记一次授权：用户在 Notion 里勾选了 pages，授权码是 code。
    //   exchange: 'ok' | 'hang' | 'server_error' | 'garbage' | 'no_token'  换 token 这一步怎么样
    //   search:   'ok' | 'hang' | 'server_error' | 'unauthorized'          搜页面这一步怎么样
    //   emptySearches: 头几次搜索返回空（模拟搜索索引的延迟）
    //   reusable: 授权码可以反复用（手动试的时候方便，真实 Notion 的授权码只能用一次）
    grant(code, { pages = [], exchange = 'ok', search = 'ok', emptySearches = 0, workspaceName = '测试工作区', reusable = false, token = 'ntn_' + randomBytes(24).toString('hex') } = {}) {
      const grant = { code, token, pages, exchange, search, emptySearches, searches: 0, workspaceName, reusable, used: false, revoked: false };
      grants.set(code, grant);
      tokens.set(token, grant);
      issued.add(token);
      return { token, grant };
    },
    grantOf: token => tokens.get(token),
    allTokens: () => [...issued],
    // 登记一个页面（或块）的子块；让读它时出错用 failBlocks。
    setBlocks(id, list) { blocks.set(id, list); },
    failBlocks(id, status) { if (status) blockStatus.set(id, status); else blockStatus.delete(id); },
    // 用户在 Notion 里撤销了授权。
    revoke(token) { const grant = tokens.get(token); if (grant) grant.revoked = true; },
    // 之后用这个 token 搜索能看到的页面（比如用户后来多分享了一个页面）。
    setPages(token, pages) { const grant = tokens.get(token); if (grant) grant.pages = pages; },
    reset() { grants.clear(); tokens.clear(); blocks.clear(); blockStatus.clear(); requests.length = 0; written.length = 0; appended.length = 0; },
    listen: port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }),
    port: () => server.address().port,
    close: () => new Promise(resolve => { for (const res of hanging) res.destroy(); server.closeAllConnections?.(); server.close(resolve); }),
  };
}
