// Which page of the workspace is open, kept in the address as ?view=<page> so a reload lands on the same page.
// The chat is the home page: it has no search at all. Other parameters on the same address (the Notion return,
// ?connection=notion&status=...) are not views; they are read by notion-return.mjs.

// Every page. 'agent' (the assistant's home page) is reached from the avatar and from settings, not from the tabs.
export const VIEWS = Object.freeze(['chat', 'todo', 'goals', 'records', 'settings', 'agent']);

// The five tabs, in order: the left column on a wide screen, the bottom bar on a phone.
export const NAV = Object.freeze([
  Object.freeze({id: 'chat', label: '聊天'}),
  Object.freeze({id: 'todo', label: '待办'}),
  Object.freeze({id: 'goals', label: '目标'}),
  Object.freeze({id: 'records', label: '记录'}),
  Object.freeze({id: 'settings', label: '设置'}),
]);

// The page named by `search` (window.location.search). Anything that is not a page, such as a view an older
// version of the site had (?view=calendar), is the chat.
export function readView(search) {
  const view = new URLSearchParams(search || '').get('view');
  return VIEWS.includes(view) ? view : 'chat';
}

// The search that opens `view`: '?view=todo', and '' for the chat.
export function viewSearch(view) {
  return view !== 'chat' && VIEWS.includes(view) ? '?view=' + view : '';
}

// How a change of page from `from` to `to` goes into the browser's history (Workspace.jsx, navigate). Opening the
// assistant's home page adds an entry ('push'), so the phone's back gesture, or the browser's back button, comes back to
// the page it was opened from instead of leaving the site. Every other change takes the place of the current entry
// ('replace'): moving between the five tabs, or from the assistant's home page to one of them, does not fill up the
// history. Going back to an entry shows the page its address names (readView, on popstate).
export function historyMode(from, to) {
  return to === 'agent' && from !== 'agent' ? 'push' : 'replace';
}

// On a phone, the shell draws a bar at the top of a page (Weave, which opens the assistant's home page, and the date;
// v3-Mobile, v3-GoalsMobile): on every page but the chat and the assistant's home page, which have a header of their
// own. The first-run screen stands in for the chat and has no header, so it gets the bar too (`firstRun`). Nothing has
// the bar before the address has been read, while the view is still null.
export function hasTopBar(view, {firstRun = false} = {}) {
  if (!VIEWS.includes(view) || view === 'agent') return false;
  return view !== 'chat' || firstRun;
}
