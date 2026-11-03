'use client';
import {viewSearch} from '../view-route.mjs';

// A link to another page of the workspace (the assistant's home page from an avatar, the chat from 待办). A plain click
// opens the page in place with `navigate`; a click that asks for a new tab or window keeps what a link does, as in Nav.
// Everything else (className, aria-label) goes on the <a>.
export default function ViewLink({view, navigate, children, ...rest}) {
  const open = event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(view);
  };
  return <a {...rest} href={'/' + viewSearch(view)} onClick={open}>{children}</a>;
}
