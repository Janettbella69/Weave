// Sending a message to Weave, from any page: the chat, the first run, a new goal on the goals page.
//
// The send itself is the old chat's: the text shows at once with a thinking bubble (chat-pending.mjs), the reply as soon
// as POST /api/chat answers, and the server's copy takes over later. What is on its way belongs to the shell (the
// `chat` prop, Workspace.jsx), not to the page that sent it, so it is still there after a change of page: the goals page
// sends and then opens the chat; the first run is replaced by the chat once its message is on screen.
//
// props.chat
//   pendings          the messages on their way (chat-pending.mjs)
//   begin(text)       puts the text on screen with a thinking bubble -> the pending entry
//   finish(entry, reply)  the reply arrived: it shows until the server's copy does
//   cancel(entry, error)  the send failed: the entry goes and the banner says why
//   restore(text)     puts the text back in the chat's box, unless something new was typed there
import {isReplying} from './chat-pending.mjs';

// -> Promise of true once the reply is in, false when nothing went out. A text that did not go out (no Agent, a reply
// still on its way, a failed request) is back in the chat's box, so nothing typed is lost; the first run and the goals
// page are no longer on screen by then. A blank text is no message at all.
export async function sendChat({state, api, chat}, text) {
  const message = typeof text === 'string' ? text.trim() : '';
  if (!message) return false;
  if (!state.settings.agent || isReplying(chat.pendings)) {
    chat.restore(message);
    return false;
  }
  const entry = chat.begin(message);
  let result;
  try {
    result = await api('chat', {text: message});
  } catch (error) {
    chat.cancel(entry, error);
    chat.restore(message);
    return false;
  }
  chat.finish(entry, result && result.reply);
  return true;
}
