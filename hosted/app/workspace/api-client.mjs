// Calls to /api/*, shared by the workspace. Pure of React so it can be tested with a fake fetch.

const GET_PATHS = new Set(['status', 'connections/notion/pending', 'wechat', 'memory', 'proactivity', 'export', 'calendar.ics']);
const RELOAD_KEY = 'weave:reloaded-for-401';

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

// Why a 401 happened, from the response headers:
//  - 'reload': the site is behind HTTP Basic auth (single-user mode). The browser asks for the password
//    again when the page is reloaded.
//  - 'guest':  guest-cookie mode. A new guest session is started at /api/auth/guest/start.
export function unauthorizedAction(headers) {
  return headers && typeof headers.get === 'function' && headers.get('www-authenticate') ? 'reload' : 'guest';
}

// Reload at most once every 30 seconds, so a password that keeps being refused cannot loop.
export function reloadAllowed(storage, now = Date.now()) {
  try {
    const last = Number(storage.getItem(RELOAD_KEY) || 0);
    if (now - last < 30000) return false;
    storage.setItem(RELOAD_KEY, String(now));
  } catch { /* storage can be blocked; reload anyway */ }
  return true;
}

// GET for the read-only paths when no body is given, POST (JSON) otherwise. Always throws an ApiError whose
// message is safe to show: the server's own message, or a plain fallback. Proxy error pages and other
// non-JSON bodies are never shown as-is.
export async function apiRequest(path, data, {fetchImpl = fetch, onUnauthorized} = {}) {
  const useGet = data === undefined && GET_PATHS.has(path);
  let response;
  try {
    response = await fetchImpl('/api/' + path, useGet ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data === undefined ? {} : data)});
  } catch {
    throw new ApiError('请求失败');
  }
  if (response.status === 401) {
    if (onUnauthorized) onUnauthorized(response);
    throw new ApiError('请重新开始', 401);
  }
  let result = null;
  try { result = JSON.parse(await response.text()); } catch { /* not JSON */ }
  if (!response.ok) throw new ApiError(result && typeof result.error === 'string' && result.error ? result.error : '请求失败', response.status);
  if (result === null) throw new ApiError('请求失败', response.status);
  return result;
}

// A real status snapshot has everything the workspace reads. Anything else (an empty object from a proxy, a
// half-written answer) is treated as a failed request instead of being rendered into a broken page.
export function looksLikeStatus(value) {
  const lists = ['messages', 'plans', 'checkins', 'calendar', 'reminders', 'notifications', 'people', 'invites', 'negotiations'];
  return !!value && typeof value === 'object'
    && !!value.profile && typeof value.profile.name === 'string' && typeof value.profile.timezone === 'string'
    && Array.isArray(value.profile.slots) && Array.isArray(value.profile.activities)
    && !!value.settings && typeof value.settings === 'object'
    && lists.every(key => Array.isArray(value[key]));
}
