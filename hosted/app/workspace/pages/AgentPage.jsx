'use client';
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import Markdown from '../Markdown';
import {agentStatus} from '../agent-status.mjs';
import {COPY} from '../copy.mjs';
import {formatDue} from '../dates.mjs';
import {retryOnConflict} from '../retry.mjs';
import {upcomingReminders} from '../todo.mjs';
import Avatar from '../ui/Avatar';
import {ChevronLeft, Clock, NotepadText, Trash2, Zap} from '../ui/Icons';
import ViewLink from '../ui/ViewLink';

// The groups that repeat. Block one has none of these yet, so each says 「暂时没有安排。」 (spec section 3.6).
const REPEATING = [['daily', COPY.daily], ['weekly', COPY.weekly], ['monthly', COPY.monthly]];

// 助理主页 (v3-Agent): Weave, whether it is connected, and two tabs.
//   提醒  the sentence that proactive reminders are not live yet; the one-off reminders still to come, soonest first, each
//         with a button that deletes it (POST reminders/cancel); the three repeating groups, empty for now. The dial
//         (多找我一点 …) belongs to block two and is not shown.
//   记忆  what Weave wrote down about the person (GET agent-memory), read each time the tab opens, read-only, drawn as
//         Markdown. When it cannot be read, the server's own sentence says why (it is written for people), with 重试.
// It is reached from Weave's avatar and from settings, not from a tab, and has its own way back to the chat instead of
// the phone's top bar (Workspace.jsx).
export default function AgentPage({state, api, act, refresh, navigate}) {
  const tz = state.profile.timezone, today = state.today, ready = !!state.settings.agent;
  const status = agentStatus({ready});
  const [tab, setTab] = useState('reminders');
  return <div className="wv-agent">
    <div className="wv-agent-column">
      <ViewLink view="chat" navigate={navigate} className="wv-back"><ChevronLeft size={16} strokeWidth={2}/>{COPY.backToChat}</ViewLink>
      <header className="wv-agent-head">
        <Avatar size={128}/>
        <h1>{COPY.brand}</h1>
        <p className="wv-agent-status">
          {ready && <span className="wv-connected-mark is-20" aria-hidden="true"><Zap size={12} strokeWidth={0} fill="currentColor"/></span>}
          {status.rowLabel}
        </p>
      </header>
      <div className="wv-tabs" role="group" aria-label={COPY.agentTabs}>
        <button type="button" className="wv-tab" aria-pressed={tab === 'reminders'} onClick={() => setTab('reminders')}><Clock size={20} strokeWidth={1.8}/>{COPY.remindersTab}</button>
        <button type="button" className="wv-tab" aria-pressed={tab === 'memory'} onClick={() => setTab('memory')}><NotepadText size={20} strokeWidth={1.8}/>{COPY.memoryTab}</button>
      </div>
      {tab === 'reminders' ? <Reminders state={state} api={api} act={act} refresh={refresh} tz={tz} today={today}/> : <Memory api={api}/>}
    </div>
  </div>;
}

function Reminders({state, api, act, refresh, tz, today}) {
  // The clock, for the reminders still to come: read when the tab opens and every half minute after.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  // Deleted here and not yet gone from the status answer: off the list at once, back if the server says no.
  const [gone, setGone] = useState(() => new Set());
  const once = upcomingReminders({reminders: state.reminders, now}).filter(item => !gone.has(item.reminderId));
  const heading = useRef(null), ids = useId();

  const remove = item => {
    setGone(current => new Set(current).add(item.reminderId));
    // The button goes with its row: the focus waits on the group's title instead of falling to the page.
    if (heading.current) heading.current.focus();
    act(async () => {
      try {
        await retryOnConflict(() => api('reminders/cancel', {id: item.reminderId}), refresh);
      } catch (error) {
        setGone(current => { const next = new Set(current); next.delete(item.reminderId); return next; });
        throw error;
      }
    });
  };

  return <div className="wv-agent-panel">
    <p className="wv-not-live">{COPY.notLive}</p>
    <section className="wv-schedule" aria-labelledby={ids + 'once'}>
      <h2 id={ids + 'once'} ref={heading} tabIndex={-1}>{COPY.once}</h2>
      {once.length ? <ul className="wv-reminders">
        {once.map(item => <li key={item.reminderId} className="wv-reminder">
          <span className="wv-reminder-icon" aria-hidden="true"><Clock size={20} strokeWidth={1.8}/></span>
          <div className="wv-reminder-text">
            <span className="wv-reminder-title">{item.title}</span>
            <span className="wv-reminder-meta">{formatDue(item.dueAt, tz, today)}</span>
          </div>
          <button type="button" className="wv-round is-quiet" aria-label={COPY.removeReminder(item.title)} onClick={() => remove(item)}><Trash2 size={18} strokeWidth={1.8}/></button>
        </li>)}
      </ul> : <p className="wv-schedule-empty">{COPY.noneScheduled}</p>}
    </section>
    {REPEATING.map(([key, title]) => <section key={key} className="wv-schedule" aria-labelledby={ids + key}>
      <h2 id={ids + key}>{title}</h2>
      <p className="wv-schedule-empty">{COPY.noneScheduled}</p>
    </section>)}
  </div>;
}

// The tab mounts each time it is opened, so the memory is read again then. An answer to an older request, or one that
// comes after the tab was left, is dropped.
function Memory({api}) {
  // {phase: 'loading'} | {phase: 'ready', text} | {phase: 'failed', error}
  const [memory, setMemory] = useState({phase: 'loading'});
  const asked = useRef(0);
  const load = useCallback(() => {
    const id = ++asked.current;
    setMemory({phase: 'loading'});
    api('agent-memory').then(
      result => { if (asked.current === id) setMemory({phase: 'ready', text: result && typeof result.text === 'string' ? result.text : ''}); },
      error => { if (asked.current === id) setMemory({phase: 'failed', error: error.message}); },
    );
  }, [api]);
  useEffect(() => {
    load();
    return () => { asked.current++; };
  }, [load]);

  return <div className="wv-memory" aria-busy={memory.phase === 'loading' || undefined}>
    <p className="wv-memory-intro">{COPY.memoryIntro}</p>
    {memory.phase === 'failed' ? <div className="wv-memory-failed">
      <p role="alert">{memory.error}</p>
      <button type="button" className="wv-button" onClick={load}>{COPY.retry}</button>
    </div>
      : memory.phase === 'ready' ? (memory.text.trim() ? <div className="wv-memory-text"><Markdown text={memory.text}/></div> : <p className="wv-empty">{COPY.memoryEmpty}</p>)
      : null}
  </div>;
}
