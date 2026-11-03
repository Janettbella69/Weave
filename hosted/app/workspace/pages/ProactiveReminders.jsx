'use client';
import {useEffect, useId, useRef, useState} from 'react';
import {COPY} from '../copy.mjs';
import {LEVEL_KEY, reminderGroups, settlePresses, withPresses} from '../proactive-view.mjs';
import {retryOnConflict} from '../retry.mjs';
import {Clock, Trash2} from '../ui/Icons';

const GROUPS = [['once', COPY.once], ['daily', COPY.daily], ['weekly', COPY.weekly], ['monthly', COPY.monthly]];

// The 提醒 tab of the assistant's home page (proactive design section 4.9), from proactive-view.mjs. At the top, what
// Weave does on its own: a sentence, then how often it comes now and the three buttons that change that (POST
// proactive/level), and why it is not looking in right now when it is not. Then what is planned, in four groups: 只响一次,
// 每天, 每周, 每月. Each row can be deleted (POST reminders/cancel for a one-off reminder, schedules/cancel for the rest)
// except Weave's own look at the day, which the buttons above control; a repeating row can be paused and resumed (POST
// schedules/pause). An older server sends no settings and no schedules: then there are no buttons, and the groups hold
// the one-off reminders only.
//
// Every change goes after the ones before it (`act`), and a clash with Weave writing at the same moment (409) is tried
// once more after a refresh. A deleted row leaves at once and a paused one shows so at once; the level shows once the
// server has answered with what goes with it. A change that does not go through goes back, and the banner has the
// server's reason.
export default function ProactiveReminders({state, api, act, refresh, tz, today}) {
  // The clock, for the one-off rows still to come: read when the tab opens and every half minute after.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  // A level asked for, or a row paused or resumed, that the status answer does not show yet (proactive-view.mjs).
  // Each new status answer settles them once: not a tick of the clock, and not a second run of this effect (React
  // runs effects twice in development).
  const [presses, setPresses] = useState({});
  const settled = useRef(state);
  useEffect(() => {
    if (settled.current === state) return;
    settled.current = state;
    setPresses(current => settlePresses(current, state));
  }, [state]);
  const shown = withPresses(state, presses);
  // Deleted here and not yet gone from the status answer: off the list at once, back if the server says no.
  const [gone, setGone] = useState(() => new Set());
  const groups = reminderGroups({reminders: state.reminders, schedules: shown.schedules, proactive: shown.proactive, now, tz, today});
  const {dial, notice} = groups;
  const headings = useRef({}), ids = useId();

  // One change: shown at once (the level once it is answered), then sent. A second press on the same thing before the
  // answer replaces this one; the answer to this one then no longer decides what shows.
  const press = (key, value, change) => {
    const token = {};
    setPresses(current => ({...current, [key]: {value, finished: false, seen: 0, answer: null, token}}));
    const answered = (worked, answer) => setPresses(current => {
      const own = current[key];
      if (!own || own.token !== token) return current;
      if (worked) return {...current, [key]: {...own, finished: true, answer}};
      const rest = {...current};
      delete rest[key];
      return rest;
    });
    act(async () => {
      let answer;
      try {
        answer = await retryOnConflict(change, refresh);
      } catch (error) {
        answered(false);
        throw error;
      }
      answered(true, answer);
    });
  };
  const changeLevel = level => press(LEVEL_KEY, level, () => api('proactive/level', {level}));
  const togglePause = item => press(item.key, !item.paused, () => api('schedules/pause', {id: item.id, paused: !item.paused}));

  const remove = (item, group) => {
    setGone(current => new Set(current).add(item.key));
    // The button goes with its row: the focus waits on the title of the row's group instead of falling to the page.
    const heading = headings.current[group];
    if (heading) heading.focus();
    act(async () => {
      try {
        await retryOnConflict(() => api(item.removeAction, {id: item.id}), refresh);
      } catch (error) {
        setGone(current => { const next = new Set(current); next.delete(item.key); return next; });
        throw error;
      }
    });
  };

  return <div className="wv-agent-panel">
    <div className="wv-dial" aria-busy={shown.busy || undefined}>
      <p>{COPY.proactiveIntro}</p>
      {dial && <p className="wv-dial-line" aria-live="polite">{dial.line}{dial.quietHours}</p>}
      {notice && <p className="wv-dial-notice">{notice}</p>}
      {dial && <div className="wv-dial-buttons">
        <LevelButton label={COPY.moreOften} level={dial.next.more} busy={shown.busy} onPress={changeLevel}/>
        <LevelButton label={COPY.lessOften} level={dial.next.less} busy={shown.busy} onPress={changeLevel}/>
        <LevelButton label={COPY.stopProactive} level={dial.can.stop ? 'off' : null} busy={shown.busy} onPress={changeLevel}/>
      </div>}
    </div>
    {GROUPS.map(([group, title]) => {
      const rows = groups[group].filter(item => !gone.has(item.key));
      return <section key={group} className="wv-schedule" aria-labelledby={ids + group}>
        <h2 id={ids + group} ref={element => { headings.current[group] = element; }} tabIndex={-1}>{title}</h2>
        {rows.length ? <ul className="wv-reminders">
          {rows.map(item => <li key={item.key} className={'wv-reminder' + (item.paused ? ' is-paused' : '')}>
            <span className="wv-reminder-icon" aria-hidden="true"><Clock size={20} strokeWidth={1.8}/></span>
            <div className="wv-reminder-text">
              <span className="wv-reminder-title">{item.title}</span>
              <span className="wv-reminder-meta">{item.meta}</span>
            </div>
            {item.canPause && <button type="button" className="wv-text-button" aria-label={(item.paused ? COPY.resumeLabel : COPY.pauseLabel)(item.title)} onClick={() => togglePause(item)}>{item.paused ? COPY.resume : COPY.pause}</button>}
            {item.removeAction && <button type="button" className="wv-round is-quiet" aria-label={COPY.removeReminder(item.title)} onClick={() => remove(item, group)}><Trash2 size={18} strokeWidth={1.8}/></button>}
          </li>)}
        </ul> : <p className="wv-schedule-empty">{COPY.noneScheduled}</p>}
      </section>;
    })}
  </div>;
}

// One of the dial's buttons; `level` is the one it asks for, null when it would change nothing. aria-disabled rather
// than disabled, as the records page's month buttons: the button keeps the focus when its level has been reached (the
// top for 多找我一点, off for 别主动找我), and while a change is on its way.
function LevelButton({label, level, busy, onPress}) {
  const off = !level || busy;
  return <button type="button" className="wv-button" aria-disabled={off} onClick={() => { if (!off) onPress(level); }}>{label}</button>;
}
