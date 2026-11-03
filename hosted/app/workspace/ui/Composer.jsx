'use client';
import {useId, useLayoutEffect, useRef} from 'react';
import {shouldSendOnEnter} from '../chat-input.mjs';
import {COPY} from '../copy.mjs';
import {ArrowUp} from './Icons';

// How tall the box grows while the person types, in px; past that it scrolls.
const MAX_HEIGHT = 200;

// The pill-shaped text box with the round send button (v3 boards: the chat, the first run, a new goal).
// The caller owns the text (`value`, `onChange`) and gets it trimmed in `onSend(text)`; clearing it is up to the caller.
// Enter sends and Shift+Enter starts a new line; while an input method is composing, Enter only confirms the candidate.
// `label` names the box for screen readers; it is not shown unless `showLabel` is set (the first run writes it above the
// box). `disabled` stops sending; typing still works. Children show under the box (the chat's line about DeepSeek).
export default function Composer({label, showLabel = false, placeholder, value, onChange, onSend, disabled = false, children}) {
  const id = useId(), box = useRef(null), composing = useRef(false);
  const text = value.trim(), blocked = disabled || !text;
  // The box follows its text: it grows while the person types, shrinks when the caller clears it, and fits a text that
  // is put back after a failed send.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = Math.min(element.scrollHeight, MAX_HEIGHT) + 'px';
  }, [value]);
  const submit = event => {
    event.preventDefault();
    if (!blocked) onSend(text);
  };
  return <form className="wv-composer" onSubmit={submit}>
    <label className={showLabel ? 'wv-composer-label' : 'wv-sr-only'} htmlFor={id}>{label}</label>
    <div className="wv-composer-box">
      <textarea id={id} ref={box} rows={1} maxLength={4000} value={value} placeholder={placeholder} enterKeyHint="send"
        onChange={event => onChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { setTimeout(() => { composing.current = false; }, 0); }}
        onKeyDown={event => { if (shouldSendOnEnter(event, composing.current)) submit(event); }}/>
      <button type="submit" className="wv-send" aria-label={COPY.send} disabled={blocked}><ArrowUp size={22} strokeWidth={2.2}/></button>
    </div>
    {children}
  </form>;
}
