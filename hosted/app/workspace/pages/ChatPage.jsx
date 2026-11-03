'use client';
import {memo, useLayoutEffect, useMemo, useRef} from 'react';
import Markdown from '../Markdown';
import {agentStatus} from '../agent-status.mjs';
import {isReplying, visibleMessages} from '../chat-pending.mjs';
import {isProactive, proactiveLabel, withSeparators} from '../chat-view.mjs';
import {sendChat} from '../chat-send.mjs';
import {COPY} from '../copy.mjs';
import Avatar from '../ui/Avatar';
import Composer from '../ui/Composer';
import {Clock, Zap} from '../ui/Icons';
import ViewLink from '../ui/ViewLink';

// The first run and the goals page send through the chat's own send (chat-send.mjs).
export {sendChat};

// 聊天, the home page (v3-Chat, v3-ChatMobile). At the top, Weave and whether it is connected: a link to the assistant's
// home page. Then the conversation, with a day label before the first message of each day, and the box at the bottom.
// The messages are the server's (status.messages) plus what is still on its way (props.chat). Weave's words go through
// Markdown, which never writes raw HTML; the person's own are plain text. Times and days are in the account's zone.
export default function ChatPage(props) {
  const {state, chat, navigate} = props;
  const tz = state.profile.timezone, ready = !!state.settings.agent, replying = isReplying(chat.pendings);
  const status = agentStatus({ready, replying});
  // Worked out again only when the messages change, not on every key typed in the box (the box's text lives in the shell).
  const shown = useMemo(() => visibleMessages(state.messages, chat.pendings), [state.messages, chat.pendings]);
  const items = useMemo(() => withSeparators(shown, tz, state.today), [shown, tz, state.today]);

  // The newest message stays in view: at once when the page opens, smoothly when one is added. Reading further up is
  // left alone until something new arrives.
  const log = useRef(null), placed = useRef(false);
  const last = shown[shown.length - 1];
  const tail = shown.length + ':' + (last ? last.id : '');
  useLayoutEffect(() => {
    const box = log.current;
    if (!box) return;
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({top: box.scrollHeight, behavior: placed.current && !still ? 'smooth' : 'auto'});
    placed.current = true;
  }, [tail]);

  const send = text => { chat.setDraft(''); sendChat(props, text); };
  return <div className="wv-chat">
    <header className="wv-chat-head">
      <ViewLink view="agent" navigate={navigate} className="wv-agent-link" aria-label={COPY.openAgent}>
        <Avatar size={36}/>
        <span className="wv-agent-name">
          <span className="wv-agent-title">{COPY.brand}</span>
          <span className="wv-agent-state">
            {ready && <span className="wv-connected-mark" aria-hidden="true"><Zap size={9} strokeWidth={0} fill="currentColor"/></span>}
            {status.rowLabel}
          </span>
        </span>
      </ViewLink>
    </header>
    <section ref={log} className="wv-chat-log" role="log" aria-label={COPY.conversation}>
      <div className="wv-chat-column">
        {items.map((item, index) => item.kind === 'separator'
          // A day label always comes right before a message: it is named after that message.
          ? <p key={'day:' + items[index + 1].message.id} className="wv-day">{item.label}</p>
          : <Message key={item.message.id} message={item.message} tz={tz}/>)}
      </div>
    </section>
    <div className="wv-chat-compose">
      <div className="wv-chat-width">
        <Composer label={COPY.messageLabel} placeholder={COPY.placeholder} value={chat.draft} onChange={chat.setDraft} onSend={send} disabled={!ready || replying}>
          <p className="wv-chat-note">{COPY.deepseek}</p>
        </Composer>
      </div>
    </div>
  </div>;
}

// One message. A message Weave sent on its own has its time and 「Weave 主动来问」 above it.
const Message = memo(function Message({message, tz}) {
  if (message.role === 'user') return <div className="wv-bubble is-user">{message.text}</div>;
  if (message.thinking) return <div className="wv-bubble is-assistant is-thinking">{COPY.thinking}</div>;
  return <>
    {isProactive(message) && <span className="wv-proactive"><Clock size={14} strokeWidth={2}/>{proactiveLabel(message, tz)}</span>}
    <div className="wv-bubble is-assistant"><Markdown text={message.text}/></div>
  </>;
});
