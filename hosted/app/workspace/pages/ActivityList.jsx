'use client';
import {useId} from 'react';
import {activityDays} from '../activity-view.mjs';
import {COPY} from '../copy.mjs';
import {Check} from '../ui/Icons';

// 动态, the first tab of the assistant's home page (activity-view.mjs): what Weave did on its own lately, under 今天,
// 昨天 and older days, newest first. Each row has a round tick, what happened in bold, a grey line under it (a message
// Weave sent shows two lines of it at most) and the time, in the account's zone. Read-only.
export default function ActivityList({state, tz, today}) {
  const days = activityDays({activity: state.activity, tz, today});
  const ids = useId();
  if (!days.length) return <p className="wv-empty">{COPY.activityEmpty}</p>;
  return <div className="wv-activity">
    {days.map(day => <section key={day.day} className="wv-activity-day" aria-labelledby={ids + day.day}>
      <h2 id={ids + day.day}>{day.label}</h2>
      <ul className="wv-activity-list">
        {day.items.map(item => <li key={item.key} className="wv-activity-item">
          <span className="wv-activity-icon" aria-hidden="true"><Check size={16} strokeWidth={2.4}/></span>
          <div className="wv-activity-text">
            <span className="wv-activity-title">{item.title}</span>
            <span className={'wv-activity-detail' + (item.kind === 'message' ? ' is-clamped' : '')}>{item.detail}</span>
          </div>
          <time className="wv-activity-time" dateTime={item.at}>{item.time}</time>
        </li>)}
      </ul>
    </section>)}
  </div>;
}
