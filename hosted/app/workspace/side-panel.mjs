// Weave's panel beside the chat (pages/AgentSide.jsx): on a screen wide enough for the navigation, the chat and a 400px
// panel, the assistant's home page sits next to the chat instead of being a page of its own. Narrower, there is no
// panel and the avatar opens the page, as before. The panel is open unless the person closed it; that is remembered in
// this browser only (a convenience: storage can be blocked or cleared, and then the panel is simply open again).

// globals.css shows .wv-side from the same width.
export const PANEL_MEDIA = '(min-width: 1200px)';
export const PANEL_KEY = 'weave:agent-panel';

// Whether the panel is open, from the browser's storage (window.localStorage, or null when it cannot be had).
export function readPanelOpen(storage) {
  try { return !storage || storage.getItem(PANEL_KEY) !== 'closed'; } catch { return true; }
}

// Remembers that the panel was closed, or forgets it once it is open again. Storage that refuses is left alone.
export function writePanelOpen(storage, open) {
  try {
    if (!storage) return;
    if (open) storage.removeItem(PANEL_KEY);
    else storage.setItem(PANEL_KEY, 'closed');
  } catch { /* storage is blocked or full: the panel just will not be remembered */ }
}
