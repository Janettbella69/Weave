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
