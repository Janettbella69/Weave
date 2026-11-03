'use client';
import {useEffect, useId, useRef, useState} from 'react';
import {isReplying} from '../chat-pending.mjs';
import {COPY} from '../copy.mjs';
import {formatDay} from '../dates.mjs';
import {CATEGORY_LABEL, goalWordsLimit, goalsModel} from '../goals-view.mjs';
import Composer from '../ui/Composer';
import {Briefcase, ChevronRight, Heart, JapaneseYen, Laptop, Palette, SquareCheck, Users} from '../ui/Icons';
import {sendChat} from './ChatPage';

// The icon of each category, in the order of CATEGORY_LABEL.
const CATEGORY_ICON = {health: Heart, relationships: Users, finance: JapaneseYen, career: Briefcase, interests: Palette, productivity: Laptop, other: SquareCheck};

// 目标 (v3-Goals, v3-GoalsMobile). 正在追踪: a card for each goal being tracked (goals-view.mjs), then one for the habits
// that belong to no goal. 创建一个目标: the seven categories; picking one opens a little chat on this page whose first
// line is Weave's question, and what the person writes there goes to the real chat with the category in front
// (COPY.goalStarter), where Weave talks it over and saves the goal. The page then shows the chat.
export default function GoalsPage(props) {
  const {state, chat, navigate} = props;
  const tz = state.profile.timezone;
  const {cards, ungrouped} = goalsModel({goals: state.goals, habits: state.habits, completions: state.completions, today: state.today, tz});
  const shown = ungrouped ? [...cards, ungrouped] : cards;
  const [picked, setPicked] = useState(null), [text, setText] = useState('');
  const trackingId = useId(), createId = useId();
  const canSend = !!state.settings.agent && !isReplying(chat.pendings);

  // Picking a category puts the cursor in the little chat; 「换一个」 puts it back on that category.
  const talk = useRef(null), list = useRef(null), returnTo = useRef('');
  useEffect(() => {
    if (picked) { const box = talk.current && talk.current.querySelector('textarea'); if (box) box.focus(); }
    else if (returnTo.current) {
      const button = list.current && list.current.querySelector('[data-category="' + returnTo.current + '"]');
      if (button) button.focus();
      returnTo.current = '';
    }
  }, [picked]);
  const back = () => { returnTo.current = picked; setPicked(null); };
  // The words are cut to what this category's box takes: they stay in the box through 「换一个」, and maxLength only
  // stops typing, so words written under a category with a shorter name can be longer than this one leaves room for.
  const send = words => {
    sendChat(props, COPY.goalStarter(CATEGORY_LABEL[picked], words.slice(0, goalWordsLimit(picked))));
    setText('');
    navigate('chat');
  };

  return <div className="wv-page">
    <div className="wv-page-column is-goals">
      <h1 className="wv-page-title">{COPY.goals}</h1>

      <section className="wv-section is-tracking" aria-labelledby={trackingId}>
        <h2 id={trackingId}>{COPY.tracking}</h2>
        {shown.length ? <ul className="wv-cards">
          {shown.map(card => <GoalCard key={card.goalId || 'ungrouped'} card={card}/>)}
        </ul> : <p className="wv-empty">{COPY.goalsEmpty}</p>}
      </section>

      <section className="wv-section is-create" aria-labelledby={createId}>
        <h2 id={createId}>{COPY.create}</h2>
        {picked ? <div ref={talk} className="wv-goal-talk">
          <div className="wv-goal-talk-head">
            <span className="wv-goal-talk-title">{COPY.newGoal(CATEGORY_LABEL[picked])}</span>
            <button type="button" className="wv-text-button" onClick={back}>{COPY.changeCategory}</button>
          </div>
          <div className="wv-goal-talk-body">
            <div className="wv-bubble is-assistant">{COPY.goalIntro(CATEGORY_LABEL[picked])}</div>
          </div>
          <div className="wv-goal-talk-compose">
            {/* The starter goes in front of these words, so the box keeps room for it (goals-view.mjs). */}
            <Composer label={COPY.goalLabel} placeholder={COPY.goalPlaceholder} value={text} onChange={setText} onSend={send} disabled={!canSend} maxLength={goalWordsLimit(picked)}/>
          </div>
        </div> : <ul ref={list} className="wv-categories">
          {Object.entries(CATEGORY_LABEL).map(([key, label]) => {
            const Icon = CATEGORY_ICON[key];
            return <li key={key}>
              <button type="button" className="wv-category" data-category={key} onClick={() => setPicked(key)}>
                <span className="wv-category-icon" aria-hidden="true"><Icon size={26} strokeWidth={1.5}/></span>
                <span className="wv-category-label">{label}</span>
                <ChevronRight className="wv-category-chevron" size={18} strokeWidth={1.8}/>
              </button>
            </li>;
          })}
        </ul>}
      </section>
    </div>
  </div>;
}

// One card. On a wide screen: the category and the day the goal began under its title, then a white line per habit
// with its last 7 days. On a phone, a goal with a single habit names the habit under the title instead and shows the
// dots alone, as the phone board does; with more habits it keeps the wide layout. The card of habits without a goal
// has no category: no icon and no line under its title.
function GoalCard({card}) {
  const Icon = card.category ? CATEGORY_ICON[card.category] || SquareCheck : null;
  const single = card.habits.length === 1;
  const begun = card.startedDay ? COPY.startedOn(card.categoryLabel, formatDay(card.startedDay)) : card.categoryLabel;
  const named = single ? [card.categoryLabel, COPY.everyDay(card.habits[0].name)].filter(Boolean).join(' · ') : begun;
  return <li className="wv-card">
    <div className="wv-card-head">
      {Icon && <span className="wv-card-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.6}/></span>}
      <div className="wv-card-titles">
        <h3>{card.title}</h3>
        {begun && <span className="wv-card-meta is-wide">{begun}</span>}
        {named && <span className="wv-card-meta is-narrow">{named}</span>}
      </div>
      <span className="wv-chip is-small">{COPY.weekCount(card.weekCount)}</span>
    </div>
    {card.habits.length > 0 && <ul className={'wv-habits' + (single ? ' is-single' : '')}>
      {card.habits.map(habit => <li key={habit.habitId} className="wv-habit">
        <span className="wv-habit-name">{COPY.everyDay(habit.name)}</span>
        <span className="wv-dots">
          <span className="wv-dots-label">{COPY.last7}</span>
          {habit.last7.map(dot => <span key={dot.day} className={'wv-dot is-' + dot.kind} aria-hidden="true"/>)}
        </span>
      </li>)}
    </ul>}
    {card.latest && <p className="wv-card-latest">{COPY.latest(formatDay(card.latest.day), card.latest.source, card.latest.note)}</p>}
  </li>;
}
