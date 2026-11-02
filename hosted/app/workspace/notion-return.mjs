// Coming back from Notion, and what the Notion row in settings says.
//
// The server's callback (/api/connections/notion/callback) always redirects back to the site:
//   /?connection=notion&status=connected             connected; the page was picked for the person
//   /?connection=notion&status=ready                 older flow: pages are waiting for the person to pick one
//   /?connection=notion&status=error&detail=<code>   not connected. Codes: access_denied, notion_error,
//        bad_code_state, missing_state, missing_config, exchange_failed, no_pages, search_failed, server_error
// GET /api/connections/notion says where things stand: {state: connected | disconnected | needs_pages | unavailable, …}.
// Only titles are ever shown; page ids stay inside click handlers.

export const NOTION_TEXT = Object.freeze({
  connected: 'Notion 已连接',
  failed: 'Notion 连接未完成，请重试',
  unavailable: 'Notion 连接暂不可用，请稍后重试',
  // 草稿文案，待确认。
  noPages: 'Notion 已授权，但你没有选任何页面。点「连接」，在 Notion 的页面选择器里勾选要分享给 Weave 的页面。',
  // 草稿文案，待确认。
  searchFailed: 'Notion 已授权，但读取页面时出错了。点「重试」。',
});

export function readNotionReturn(search) {
  const params = new URLSearchParams(search || '');
  if (params.get('connection') !== 'notion') return null;
  const status = params.get('status');
  return {status: status === 'connected' || status === 'ready' ? status : 'error', detail: params.get('detail') || ''};
}

// Authorized, but there is no page to use yet: the person can try again, or go through Notion again and tick pages.
export const needsPagesReason = code => (code === 'no_pages' || code === 'search_failed' ? code : '');

export function needsPagesText(reason) {
  return reason === 'search_failed' ? NOTION_TEXT.searchFailed : reason === 'no_pages' ? NOTION_TEXT.noPages : '';
}

// What to say for an error return. A code nobody knows is treated as "did not finish, try again".
export function notionErrorText(detail) {
  if (detail === 'missing_config') return NOTION_TEXT.unavailable;
  return needsPagesText(needsPagesReason(detail)) || NOTION_TEXT.failed;
}

// Only what the picker needs, whatever shape the server sent.
export function normalizePages(pages) {
  return (Array.isArray(pages) ? pages : [])
    .filter(page => page && typeof page.id === 'string' && page.id)
    .map(page => ({id: page.id, title: typeof page.title === 'string' && page.title.trim() ? page.title : '未命名页面'}));
}

const bare = id => String(id).replaceAll('-', '').toLowerCase();

// GET connections/notion/pages -> the pages to change to, the current one marked.
export function normalizePickerPages(result) {
  const selected = result && typeof result.selectedId === 'string' ? bare(result.selectedId) : '';
  return normalizePages(result && result.pages).map(page => ({...page, selected: !!selected && bare(page.id) === selected}));
}

// What the Notion row in settings shows. `connection` is GET connections/notion (null while unknown), `connected`
// is the status answer's settings.notion, `configured` its settings.notionConfigured (missing on older servers).
export function notionRow({connection, connected, configured}) {
  const needsPages = !connected && connection && connection.state === 'needs_pages' ? needsPagesReason(connection.reason) : '';
  const page = connected && connection && connection.state === 'connected' ? connection.page : null;
  return {
    title: page && typeof page.title === 'string' ? page.title.trim() : '',
    needsPages,
    note: needsPagesText(needsPages),
    // A site without Notion set up has nothing to connect to, unless something is already connected or waiting.
    shown: configured !== false || !!connected || !!needsPages,
  };
}

// These two can also mean "this return was opened a second time": the first one already finished the connection.
const CHECK_FIRST = new Set(['missing_state', 'bad_code_state']);

// Decides what the page shows after the return. `getConnection()` asks GET connections/notion; `legacyPages()` is the
// older pick-a-page wait (waitForNotionPages below).
// Outcomes: {kind:'connected'} | {kind:'pick', pages} | {kind:'needs_pages', reason} | {kind:'failed', message}
export async function resolveNotionReturn(back, {getConnection, legacyPages}) {
  // true / false, or null when the question could not be asked
  const isConnected = async () => {
    try { const connection = await getConnection(); return !!connection && connection.state === 'connected'; } catch { return null; }
  };
  if (back.status === 'connected') return (await isConnected()) === false ? {kind: 'failed', message: NOTION_TEXT.failed} : {kind: 'connected'};
  if (back.status === 'ready') {
    const found = await legacyPages();
    if (!found) return {kind: 'failed', message: NOTION_TEXT.failed};
    return found.pages ? {kind: 'pick', pages: found.pages} : {kind: 'connected'};
  }
  if (CHECK_FIRST.has(back.detail) && (await isConnected()) === true) return {kind: 'connected'};
  const reason = needsPagesReason(back.detail);
  if (reason) return {kind: 'needs_pages', reason};
  return {kind: 'failed', message: notionErrorText(back.detail)};
}

// Older flow (status=ready). The pages are saved just before the redirect, but the first read can still come back
// empty-handed. Ask a few times. Resolves to {pages} to pick from, {connected:true} when Notion turns out to be
// connected already (the server finished the connection itself and there is nothing to pick), or null when neither
// happened (or the caller stopped waiting). `isConnected` is asked at most once, after the first read that has
// nothing to pick.
export async function waitForNotionPages(fetchPending, {attempts = 10, delayMs = 800, sleep = ms => new Promise(r => setTimeout(r, ms)), active = () => true, isConnected} = {}) {
  let asked = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!active()) return null;
    const pending = await fetchPending();
    if (!active()) return null;
    const pages = pending && pending.ready ? normalizePages(pending.pages) : [];
    if (pages.length) return {pages};
    if (isConnected && !asked) {
      asked = true;
      if (await isConnected()) return active() ? {connected: true} : null;
    }
    if (pending && pending.ready) return null;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}
