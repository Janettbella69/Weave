// Calls to /api/*, shared by the workspace. Pure of React so it can be tested with a fake fetch.

const GET_PATHS = new Set(['status', 'connections/notion', 'connections/notion/pending', 'connections/notion/pages', 'wechat', 'memory', 'agent-memory', 'proactivity', 'export', 'calendar.ics']);
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

// The status answer, checked and filled in. The workspace needs the profile, the settings and the lists it shows
// (messages, plans, feedback, reminders, notifications). The lists that only belong to friends and shared
// plans (people, invites, negotiations, calendar) may be missing; they become empty. So do the habit lists
// (goals, habits, completions) and `today`, the person's local date as 'YYYY-MM-DD': an answer from a server
// that does not send them yet, or a field of the wrong type, becomes [] and ''. Anything else (an empty
// object from a proxy, a half-written answer) gives null: it is a failed request, not a page to render.
export function normalizeStatus(value) {
  if (!value || typeof value !== 'object') return null;
  const profile = value.profile;
  if (!profile || typeof profile.name !== 'string' || typeof profile.timezone !== 'string') return null;
  if (!value.settings || typeof value.settings !== 'object') return null;
  if (!['messages', 'plans', 'checkins', 'reminders', 'notifications'].every(key => Array.isArray(value[key]))) return null;
  const out = {...value, profile: {...profile, slots: Array.isArray(profile.slots) ? profile.slots : [], activities: Array.isArray(profile.activities) ? profile.activities : []}};
  for (const key of ['people', 'invites', 'negotiations', 'calendar', 'goals', 'habits', 'completions']) if (!Array.isArray(out[key])) out[key] = [];
  if (typeof out.today !== 'string') out.today = '';
  return out;
}
