// 待办's tick boxes change the moment they are pressed, before the server has answered (spec section 3.2: 打勾先变勾).
// The page keeps each press here and shows the to-do model (todo.mjs) with the presses on top, until the status answer
// shows the same thing. Pure: the page passes in the model and `today`.
//
// presses  {[key]: {value, day, finished, seen}}, key habitKey(id) or reminderKey(id)
//   value     true: done (a habit), cancelled (a reminder); false: not done
//   day       the person's day it was pressed on (status.today). A habit's press is about that day only.
//   finished  its request came back. A request that failed is not kept: the page drops its press, and the box goes back.
//   seen      the status answers that arrived since it came back. The first may have been asked for before the change;
//             the second was asked for after it (the shell has one status request at a time and asks for another after
//             every change), so from then on the server's answer is the one shown, whatever it says.
// The page may keep more in a press (which click it belongs to); it is carried along.

export const habitKey = id => 'h:' + id;
export const reminderKey = id => 'r:' + id;

// The model as the page shows it: the pressed rows with their new state, and the counts that follow from them.
//   today  done as pressed; weekCount with today added or taken off; no missed-yesterday note on a ticked row
//   later  each reminder with `done`: ticked (it is being cancelled)
export function withChecks(model, presses, today) {
  const rows = model.today.map(row => {
    const press = presses[habitKey(row.habitId)];
    if (!press || press.day !== today || press.value === row.done) return row;
    return {...row, done: press.value, missedYesterday: press.value ? false : row.missedYesterday, weekCount: Math.max(0, row.weekCount + (press.value ? 1 : -1))};
  });
  const later = model.later.map(item => ({...item, done: !!(presses[reminderKey(item.reminderId)] || {}).value}));
  return {...model, today: rows, later, doneCount: rows.filter(row => row.done).length};
}

// The presses that still matter after a new status answer (call it once per answer). A press goes once it has come back
// and the answer shows the same, once two answers have come since it came back, when its row is no longer listed, or
// when it was made on another day. Returns `presses` itself when nothing changed.
export function settleChecks(presses, model, today) {
  const server = new Map(model.today.map(row => [habitKey(row.habitId), row.done]));
  for (const item of model.later) server.set(reminderKey(item.reminderId), false);   // listed: not cancelled yet
  let changed = false;
  const kept = {};
  for (const [key, press] of Object.entries(presses)) {
    const now = server.get(key), seen = press.finished ? press.seen + 1 : press.seen;
    const gone = now === undefined || (key.startsWith('h:') && press.day !== today);
    if (gone || (press.finished && (now === press.value || seen >= 2))) { changed = true; continue; }
    if (seen !== press.seen) changed = true;
    kept[key] = seen === press.seen ? press : {...press, seen};
  }
  return changed ? kept : presses;
}
