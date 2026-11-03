'use client';
import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {COPY} from '../copy.mjs';
import {formatDue, formatHeader} from '../dates.mjs';
import {retryOnConflict} from '../retry.mjs';
import {todoModel} from '../todo.mjs';
import {habitKey, reminderKey, settleChecks, withChecks} from '../todo-checks.mjs';
import {Check} from '../ui/Icons';
import ViewLink from '../ui/ViewLink';

// 待办 (v3-Main, v3-Mobile): the date and 「今天 n / m」, a row for each habit being tracked, the one-off reminders still to
// come under 之后, and a way to the chat for anything else. Days are the account's (status.today, profile.timezone).
//
// A tick box changes at once (todo-checks.mjs) and the change goes to the server after the ones before it (`act`). A
// clash with Weave writing at the same moment (409) is tried once more after a refresh. A habit's tick that does not go
// through goes back and says COPY.checkFailed: the server's own words are written for the model, not for the person. A
// reminder's box cancels the reminder; if that fails, the box goes back and the banner has the server's reason.
export default function TodoPage({state, api, act, refresh, navigate}) {
  const tz = state.profile.timezone, today = state.today;
  // The clock, for the reminders still to come: read when the page opens and every half minute after (a reminder that
  // is due also leaves the list on its own, once the server has delivered it).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const model = useMemo(() => todoModel({goals: state.goals, habits: state.habits, completions: state.completions, reminders: state.reminders, today, now, tz}), [state, today, now, tz]);
  const [presses, setPresses] = useState({});
  // Each new status answer settles the presses once: not a tick of the clock, and not a second run of this effect (React
  // runs effects twice in development).
  const settled = useRef(state);
  useEffect(() => {
    if (settled.current === state) return;
    settled.current = state;
    setPresses(current => settleChecks(current, model, today));
  }, [state, model, today]);
  const shown = withChecks(model, presses, today);
  const todayId = useId(), laterId = useId();

  // One press: shown at once, then sent. Pressing the same box again before the answer replaces this press; the answer
  // to this one then no longer decides what the box shows.
  const press = (key, value, change, failure) => {
    const token = {};
    setPresses(current => ({...current, [key]: {value, day: today, finished: false, seen: 0, token}}));
    const answered = worked => setPresses(current => {
      const own = current[key];
      if (!own || own.token !== token) return current;
      if (worked) return {...current, [key]: {...own, finished: true}};
      const rest = {...current};
      delete rest[key];
      return rest;
    });
    act(async () => {
      try {
        await retryOnConflict(change, refresh);
      } catch (error) {
        answered(false);
        refresh({queue: true}).catch(() => {});
        throw failure ? new Error(failure) : error;
      }
      answered(true);
    });
  };
  const tick = row => press(habitKey(row.habitId), !row.done, () => api(row.done ? 'habits/uncheck' : 'habits/check', {habit_id: row.habitId}), COPY.checkFailed);
  const cancel = item => press(reminderKey(item.reminderId), true, () => api('reminders/cancel', {id: item.reminderId}), '');

  return <div className="wv-page">
    <div className="wv-page-column">
      <header className="wv-page-head">
        <div className="wv-page-titles">
          {today && <p className="wv-page-date">{formatHeader(today)}</p>}
          <h1 className="wv-page-title">{COPY.todo}</h1>
        </div>
        <span className="wv-chip">{COPY.progress(shown.doneCount, shown.total)}</span>
      </header>

      <section className="wv-section" aria-labelledby={todayId}>
        <h2 id={todayId}>{COPY.todayLabel}</h2>
        {shown.today.length ? <ul className="wv-rows">
          {shown.today.map(row => {
            const note = row.done ? COPY.doneNote(row.weekCount) : row.missedYesterday ? COPY.missedYesterday : '';
            return <li key={row.habitId} className={'wv-row' + (row.done ? ' is-done' : '')}>
              <TickBox done={row.done} label={COPY.checkLabel(row.title)} onPress={() => tick(row)}/>
              <div className="wv-row-text">
                <span className="wv-row-title">{row.title}</span>
                {row.meta && <span className="wv-row-meta">{row.meta}</span>}
                {note && <span className="wv-row-note">{note}</span>}
              </div>
            </li>;
          })}
        </ul> : <p className="wv-empty">{COPY.todoEmpty}</p>}
      </section>

      {shown.later.length > 0 && <section className="wv-section" aria-labelledby={laterId}>
        <h2 id={laterId}>{COPY.later}</h2>
        <ul className="wv-rows">
          {shown.later.map(item => <li key={item.reminderId} className={'wv-row' + (item.done ? ' is-done' : '')}>
            {/* Cancelling cannot be undone here, so a ticked reminder's box stays ticked until the row goes. */}
            <TickBox done={item.done} disabled={item.done} label={COPY.checkLabel(item.title)} onPress={() => cancel(item)}/>
            <div className="wv-row-text">
              <span className="wv-row-title">{item.title}</span>
              <span className="wv-row-meta">{[formatDue(item.dueAt, tz, today), COPY.remindNote].filter(Boolean).join(' · ')}</span>
            </div>
          </li>)}
        </ul>
      </section>}

      <p className="wv-hint">{COPY.addHint}<ViewLink view="chat" navigate={navigate}>{COPY.addLink}</ViewLink>。</p>
    </div>
  </div>;
}

// The 24px box inside a 44px button, as on the boards; pressed = ticked.
function TickBox({done, disabled = false, label, onPress}) {
  return <button type="button" className="wv-tick" aria-pressed={done} aria-label={label} disabled={disabled} onClick={onPress}>
    <span className="wv-tick-box" aria-hidden="true">{done && <Check size={16} strokeWidth={3}/>}</span>
  </button>;
}
