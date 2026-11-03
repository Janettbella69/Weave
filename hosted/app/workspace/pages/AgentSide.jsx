'use client';
import {useId, useState, useSyncExternalStore} from 'react';
import {COPY} from '../copy.mjs';
import {PANEL_MEDIA, readPanelOpen, writePanelOpen} from '../side-panel.mjs';
import {X} from '../ui/Icons';
import {AgentBody} from './AgentPage';

// Weave's panel beside the chat on a wide screen (side-panel.mjs): the assistant's home page (AgentBody, the same three
// tabs), next to the conversation instead of in its place, with a button at the top that closes it. The chat's avatar
// shows or hides it there; it opens nothing and changes no address. On a narrower screen there is no panel and the
// avatar opens the assistant's home page as a page of its own, which the back gesture leaves (ChatPage.jsx).
export default function AgentSide({side, state, api, act, refresh}) {
  return <aside id={side.id} className="wv-side" aria-label={COPY.agentPanel}>
    <button type="button" className="wv-round is-quiet wv-side-close" aria-label={COPY.closePanel} onClick={side.close}><X size={18} strokeWidth={1.8}/></button>
    <AgentBody state={state} api={api} act={act} refresh={refresh} compact/>
  </aside>;
}

// The width, as the browser has it now (it changes when the window is resized or a tablet is turned).
function subscribe(changed) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PANEL_MEDIA);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}
const wideNow = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PANEL_MEDIA).matches;
const storage = () => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };

// What the chat needs to draw the panel and the avatar that controls it:
//   wide    the screen has room for the panel. Otherwise the avatar is the link to the assistant's home page.
//   open    the person has not closed it (remembered in this browser); shown = wide && open
//   toggle  for the avatar; close for the panel's own button, which then hands the focus to the avatar
//   id, toggleId  the panel's id (the avatar's aria-controls) and the avatar button's
export function useAgentSide() {
  const wide = useSyncExternalStore(subscribe, wideNow, () => false);
  const [open, setOpen] = useState(() => readPanelOpen(storage()));
  const id = useId(), toggleId = useId();
  const set = next => { setOpen(next); writePanelOpen(storage(), next); };
  return {
    wide, open, shown: wide && open, id, toggleId,
    toggle: () => set(!open),
    // The close button goes with the panel: the focus waits on the avatar, which brings it back.
    close: () => {
      set(false);
      const avatar = document.getElementById(toggleId);
      if (avatar) avatar.focus();
    },
  };
}
