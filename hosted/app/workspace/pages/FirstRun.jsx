'use client';
import {useId, useRef, useState} from 'react';
import {MESSAGE_MAX_LENGTH, isImeComposing} from '../chat-input.mjs';
import {COPY} from '../copy.mjs';
import Avatar from '../ui/Avatar';
import Composer from '../ui/Composer';
import {sendChat} from './ChatPage';

// 第一次打开 (v3-FirstRun). The shell shows it in place of the chat to someone with no habits who has never written
// anything, and the chat takes over as soon as a message is on its way. Picking one of the small things shows its first
// step, and 「就这样开始」 sends Weave the sentence of spec A-4 for it. 「自己写一个」 opens a line for one's own, and
// 「好了」 sends what is written there as it is; so does the box at the bottom, which is the chat's own box.
export default function FirstRun(props) {
  const {state, chat} = props;
  const [picked, setPicked] = useState(null), [own, setOwn] = useState('');
  const ownId = useId(), composing = useRef(false);
  const option = COPY.firstRunOptions.find(item => item.key === picked);
  const ready = !!state.settings.agent;

  const sendOwn = event => {
    event.preventDefault();
    if (ready && own.trim()) sendChat(props, own);
  };
  // Enter sends the line, except while an input method is still composing: then it only confirms the candidate.
  const holdWhileComposing = event => {
    if (event.key === 'Enter' && (composing.current || isImeComposing(event))) event.preventDefault();
  };
  return <div className="wv-first-run">
    <div className="wv-first-run-column">
      <div className="wv-welcome">
        <Avatar size={56}/>
        <h1>{COPY.welcome}</h1>
        <p>{COPY.firstRunIntro}</p>
      </div>
      <div className="wv-options" role="group" aria-label={COPY.pickOne}>
        {COPY.firstRunOptions.map(item => <button key={item.key} type="button" className="wv-option" aria-pressed={picked === item.key} onClick={() => setPicked(item.key)}>{item.label}</button>)}
      </div>
      {option && option.step && <div className="wv-plan">
        <p className="wv-plan-title">{COPY.firstRunPick(option.label)}</p>
        <p className="wv-plan-step">{COPY.firstRunStep(option.step)}</p>
        <div className="wv-plan-actions">
          <button type="button" className="wv-button is-primary is-large" disabled={!ready} onClick={() => sendChat(props, COPY.firstRunStarter(option.label, option.step))}>{COPY.firstRunGo}</button>
          <span className="wv-plan-hint">{COPY.firstRunChange}</span>
        </div>
      </div>}
      {option && !option.step && <form className="wv-own" onSubmit={sendOwn}>
        <label htmlFor={ownId}>{COPY.ownHabit}</label>
        <div className="wv-own-row">
          <input id={ownId} className="wv-input" type="text" maxLength={MESSAGE_MAX_LENGTH} enterKeyHint="send" value={own} placeholder={COPY.ownPlaceholder}
            onChange={event => setOwn(event.target.value)} onKeyDown={holdWhileComposing}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { setTimeout(() => { composing.current = false; }, 0); }}/>
          <button type="submit" className="wv-button is-primary is-large" disabled={!ready || !own.trim()}>{COPY.ownDone}</button>
        </div>
      </form>}
      <Composer label={COPY.sayIt} showLabel placeholder={COPY.sayItPlaceholder} value={chat.draft} onChange={chat.setDraft} disabled={!ready}
        onSend={text => { chat.setDraft(''); sendChat(props, text); }}/>
    </div>
  </div>;
}
