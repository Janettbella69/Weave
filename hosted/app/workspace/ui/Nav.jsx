'use client';
import {NAV, viewSearch} from '../view-route.mjs';
import {COPY} from '../copy.mjs';
import Avatar from './Avatar';
import {NAV_ICONS} from './Icons';

// The first character of a name, for the round mark next to it (a whole character, also one outside the BMP).
const initial = name => Array.from(name.trim())[0] || '';

// The five tabs (v3 boards). On a wide screen they are the left column, with Weave on top and the person's name at the
// bottom; on a phone the same links are the bar at the bottom (globals.css decides which, under .wv).
// `view` is the open page. No tab is marked while it is null (the address has not been read yet) or 'agent' (the
// assistant's home page is reached from the avatars, not from a tab).
export default function Nav({view, onNavigate, name = ''}) {
  // A plain click opens the page in place. A click that asks for a new tab or window keeps what a link does.
  const open = (event, id) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(id);
  };
  return <nav className="wv-nav" aria-label={COPY.mainNav}>
    <div className="wv-nav-brand"><Avatar size={30}/><span>{COPY.brand}</span></div>
    {NAV.map(({id, label}) => {
      const Icon = NAV_ICONS[id];
      return <a key={id} className="wv-nav-item" href={'/' + viewSearch(id)} aria-current={view === id ? 'page' : undefined} onClick={event => open(event, id)}>
        <span className="wv-nav-icon"><Icon size={22} strokeWidth={1.7}/></span>
        <span>{label}</span>
      </a>;
    })}
    <div className="wv-nav-spacer"/>
    {name && <div className="wv-nav-user">
      <span className="wv-nav-user-mark" aria-hidden="true">{initial(name)}</span>
      <span className="wv-nav-user-name">{name}</span>
    </div>}
  </nav>;
}
