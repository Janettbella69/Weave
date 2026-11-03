'use client';
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import Markdown from '../Markdown';
import {agentStatus} from '../agent-status.mjs';
import {COPY} from '../copy.mjs';
import Avatar from '../ui/Avatar';
import {ChevronLeft, Clock, FileText, List, NotepadText, Zap} from '../ui/Icons';
import ViewLink from '../ui/ViewLink';
import ActivityList from './ActivityList';
import ProactiveReminders from './ProactiveReminders';

// The three tabs, in order; the first is the one that is open at first.
const TABS = [['activity', COPY.activityTab, List], ['reminders', COPY.remindersTab, Clock], ['memory', COPY.memoryTab, NotepadText]];

// 助理主页 (v3-Agent): Weave, whether it is connected, and three tabs (AgentBody below).
//   动态  what Weave did on its own lately, newest first, a day at a time (ActivityList.jsx).
//   提醒  how often Weave comes on its own, with the three buttons that change it, and what is planned: 只响一次, 每天,
//         每周, 每月, each row with a way to delete it and the repeating ones to pause it (ProactiveReminders.jsx).
//   记忆  what Weave wrote down about the person (GET agent-memory), read each time the tab opens, read-only, drawn as
//         Markdown. When it cannot be read, the server's own sentence says why (it is written for people), with 重试.
// It is reached from Weave's avatar and from settings, not from a tab, and has its own way back to the chat instead of
// the phone's top bar (Workspace.jsx). On a wide screen the same body is also the panel beside the chat (AgentSide.jsx).
export default function AgentPage({state, api, act, refresh, navigate}) {
  return <div className="wv-agent">
    <div className="wv-agent-column">
      <ViewLink view="chat" navigate={navigate} className="wv-back"><ChevronLeft size={16} strokeWidth={2}/>{COPY.backToChat}</ViewLink>
      <AgentBody state={state} api={api} act={act} refresh={refresh}/>
    </div>
  </div>;
}

// What the page holds; also the panel beside the chat (`compact`), where the avatar is smaller and the tabs show their
// icons only (their names are read out, and show when the pointer rests on them).
export function AgentBody({state, api, act, refresh, compact = false}) {
  const tz = state.profile.timezone, today = state.today, ready = !!state.settings.agent;
  const status = agentStatus({ready});
  const [tab, setTab] = useState('activity');
  return <>
    <header className="wv-agent-head">
      <Avatar size={compact ? 56 : 128}/>
      <h1>{COPY.brand}</h1>
      <p className="wv-agent-status">
        {ready && <span className="wv-connected-mark is-20" aria-hidden="true"><Zap size={12} strokeWidth={0} fill="currentColor"/></span>}
        {status.rowLabel}
      </p>
    </header>
    <div className="wv-tabs" role="group" aria-label={COPY.agentTabs}>
      {TABS.map(([id, label, Icon]) => <button key={id} type="button" className="wv-tab" aria-pressed={tab === id} title={compact ? label : undefined} onClick={() => setTab(id)}>
        <Icon size={20} strokeWidth={1.8}/><span className={compact ? 'wv-sr-only' : undefined}>{label}</span>
      </button>)}
    </div>
    {tab === 'activity' ? <ActivityList state={state} tz={tz} today={today}/>
      : tab === 'reminders' ? <ProactiveReminders state={state} api={api} act={act} refresh={refresh} tz={tz} today={today}/>
      : <Memory api={api}/>}
  </>;
}

// The tab mounts each time it is opened, so the memory is read again then. An answer to an older request, or one that
// comes after the tab was left, is dropped. Weave's memory is the file MEMORY.md in its workspace and nothing else, so
// the tab shows that file: its name on top, then what is in it, read-only, as Markdown. There is nothing to edit here.
function Memory({api}) {
  // {phase: 'loading'} | {phase: 'ready', text} | {phase: 'failed', error}
  const [memory, setMemory] = useState({phase: 'loading'});
  const asked = useRef(0), fileId = useId();
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
    <section className="wv-memory-file" aria-labelledby={fileId}>
      <h2 id={fileId} className="wv-memory-file-name"><FileText size={18} strokeWidth={1.8}/>{COPY.memoryFile}</h2>
      {memory.phase !== 'loading' && <div className="wv-memory-file-body">
        {memory.phase === 'failed' ? <div className="wv-memory-failed">
          <p role="alert">{memory.error}</p>
          <button type="button" className="wv-button" onClick={load}>{COPY.retry}</button>
        </div>
          : memory.text.trim() ? <div className="wv-memory-text"><Markdown text={memory.text}/></div> : <p className="wv-empty">{COPY.memoryEmpty}</p>}
      </div>}
    </section>
  </div>;
}
