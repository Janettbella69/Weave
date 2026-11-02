// What the chat shows between pressing send and the server's own copy arriving.
//
// The server only reports messages through GET /api/status, which can be slow. So the page keeps a local
// "pending" entry per sent message: the user's text shows at once, then a thinking bubble, then the reply
// from the POST response. Once a status snapshot that was requested after the reply came back has been
// applied, the entry is dropped and the server's copy takes over. Until then the local copy is hidden
// whenever the snapshot already contains it, so nothing shows twice.

let counter = 0;

export function beginPending(messages, text) {
  return {key: 'pending-' + Date.now() + '-' + (counter++), text, known: (messages || []).map(m => m.id), reply: null, done: false, doneMark: 0};
}

// The reply arrived. `mark` is the number of status requests started so far: only a request with a
// higher number was sent after the reply was stored, so only it is guaranteed to contain it.
export function finishPending(list, key, reply, mark) {
  return list.map(p => p.key === key ? {...p, reply: typeof reply === 'string' ? reply : '', done: true, doneMark: mark} : p);
}

export function dropSettled(list, requestId) {
  const next = list.filter(p => !(p.done && requestId > p.doneMark));
  return next.length === list.length ? list : next;
}

// The server saves a plan reply without the sentence that is appended to the HTTP response.
const sameReply = (saved, reply) => saved === reply || reply.startsWith(saved + '\n\n');

// The list to render: the server's messages, then whatever of each pending entry the server does not have yet.
// Items added here carry `local: true`; the thinking bubble also carries `thinking: true`.
export function visibleMessages(messages, pendings) {
  const base = messages || [];
  if (!pendings || !pendings.length) return base;
  const items = base.slice();
  for (const p of pendings) {
    const known = new Set(p.known), fresh = base.filter(m => !known.has(m.id));
    if (!fresh.some(m => m.role === 'user' && m.text === p.text)) items.push({id: p.key + ':user', role: 'user', text: p.text, local: true});
    if (!p.done) items.push({id: p.key + ':thinking', role: 'assistant', text: '', local: true, thinking: true});
    else if (p.reply && !fresh.some(m => m.role === 'assistant' && typeof m.text === 'string' && sameReply(m.text, p.reply))) items.push({id: p.key + ':reply', role: 'assistant', text: p.reply, local: true});
  }
  return items;
}

export const isReplying = pendings => !!pendings && pendings.some(p => !p.done);
