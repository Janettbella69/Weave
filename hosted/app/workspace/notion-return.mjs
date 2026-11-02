// Coming back from Notion. The server's callback (/api/connections/notion/callback) saves the pages the
// person shared and redirects to /?connection=notion&status=ready (or status=error&detail=…).

export function readNotionReturn(search) {
  const params = new URLSearchParams(search || '');
  if (params.get('connection') !== 'notion') return null;
  return {status: params.get('status') === 'ready' ? 'ready' : 'error'};
}

// Only what the picker needs, whatever shape the server sent.
export function normalizePages(pages) {
  return (Array.isArray(pages) ? pages : [])
    .filter(page => page && typeof page.id === 'string' && page.id)
    .map(page => ({id: page.id, title: typeof page.title === 'string' && page.title.trim() ? page.title : '未命名页面'}));
}

// The pages are saved just before the redirect, but the first read can still come back empty-handed. Ask a few
// times. Resolves to {pages} to pick from, {connected:true} when Notion turns out to be connected already (the
// server finished the connection itself and there is nothing to pick), or null when neither happened (or the
// caller stopped waiting). `isConnected` is asked at most once, after the first read that has nothing to pick.
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
