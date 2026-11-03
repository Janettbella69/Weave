'use client';
import {useId, useMemo, useState} from 'react';
import {COPY} from '../copy.mjs';
import {addMonths, formatDay, formatMonth, localDay} from '../dates.mjs';
import {monthBounds, monthModel, newestHabitsFirst, recentNotes} from '../records.mjs';
import {ChevronLeft, ChevronRight} from '../ui/Icons';

// What a day of the calendar says to a screen reader, after its date (the board: 「10 月 12 日：做到了」).
const SAID = {done: COPY.done, missed: COPY.missed, before: COPY.notStarted};

// 记录 (v3-Records). A button for each habit, the newest first: all of them, also those of a goal that is no longer
// tracked. For the habit picked: the goal it is for and the day it began, the three numbers of the month, the month's
// calendar and the newest records (records.mjs). Days are the account's (status.today, profile.timezone).
//
// The months go back as far as the status answer has records (monthBounds): at that month the button back is off and
// COPY.earliest says why. Its days from before the answer's window are 'unknown': drawn plain, like a day that is not
// there, and not read out. A month can have nothing done or missed in it (0 / 0 天); the numbers are shown as they are.
export default function RecordsPage({state}) {
  const tz = state.profile.timezone, today = state.today;
  const habits = useMemo(() => newestHabitsFirst(state.habits), [state.habits]);
  const [picked, setPicked] = useState(''), [month, setMonth] = useState('');
  const habit = habits.find(item => item.id === picked) || habits[0] || null;
  const {earliest, latest} = monthBounds({today, tz});
  // The month on screen: the one turned to, kept inside the months there are (the day may have moved on meanwhile).
  const shown = !month || month > latest ? latest : month < earliest ? earliest : month;
  const model = useMemo(() => monthModel({habit, completions: state.completions, month: shown, today, tz}), [habit, state.completions, shown, today, tz]);
  const notes = useMemo(() => (habit ? recentNotes({completions: state.completions, habitId: habit.id, today, tz}) : []), [habit, state.completions, today, tz]);
  const notesId = useId(), earliestId = useId();

  if (!habit) return <div className="wv-page">
    <div className="wv-page-column is-records">
      <h1 className="wv-page-title">{COPY.records}</h1>
      <p className="wv-empty">{COPY.recordsEmpty}</p>
    </div>
  </div>;

  const goal = state.goals.find(item => item.id === habit.goalId);
  const goalTitle = goal && typeof goal.title === 'string' ? goal.title.trim() : '';
  const begun = localDay(habit.createdAt, tz);
  const line = [goalTitle ? COPY.forGoal(goalTitle) : '', begun ? COPY.since(formatDay(begun)) : ''].filter(Boolean).join(' · ');
  const number = Number(shown.slice(5, 7)), {stats} = model;
  const atEarliest = !!shown && shown <= earliest, atLatest = !shown || shown >= latest;

  return <div className="wv-page">
    <div className="wv-page-column is-records">
      <header className="wv-page-titles">
        <h1 className="wv-page-title">{COPY.records}</h1>
        {line && <p className="wv-records-line">{line}</p>}
      </header>

      <div className="wv-pills" role="group" aria-label={COPY.pickHabit}>
        {habits.map(item => <button key={item.id} type="button" className="wv-option" aria-pressed={item.id === habit.id} onClick={() => setPicked(item.id)}>{item.name}</button>)}
      </div>

      {/* Without the person's day (an older server sends none) there is no month to show: only the records. */}
      {shown && <dl className="wv-stats">
        <Stat label={COPY.monthDone(number)} value={stats.done} unit={COPY.outOf(stats.elapsed)}/>
        <Stat label={COPY.longest} value={stats.longest} unit={COPY.dayUnit}/>
        <Stat label={COPY.doubleMiss} value={stats.doubleMisses} unit={COPY.timeUnit}/>
      </dl>}

      <div className="wv-records-body">
        {shown && <section className="wv-calendar" aria-label={COPY.calendarLabel(number)}>
          <div className="wv-calendar-head">
            {/* aria-disabled rather than disabled: the button keeps the focus when the last month is reached */}
            <button type="button" className="wv-round" aria-label={COPY.prevMonth} aria-disabled={atEarliest} aria-describedby={atEarliest ? earliestId : undefined}
              onClick={() => { if (!atEarliest) setMonth(addMonths(shown, -1)); }}><ChevronLeft size={18} strokeWidth={2}/></button>
            <h2>{formatMonth(shown)}</h2>
            <button type="button" className="wv-round" aria-label={COPY.nextMonth} aria-disabled={atLatest}
              onClick={() => { if (!atLatest) setMonth(addMonths(shown, 1)); }}><ChevronRight size={18} strokeWidth={2}/></button>
          </div>
          {atEarliest && <p id={earliestId} className="wv-calendar-note">{COPY.earliest}</p>}
          <div className="wv-weekdays" aria-hidden="true">{COPY.weekdays.map(day => <span key={day}>{day}</span>)}</div>
          <ol className="wv-cal-days">
            {model.cells.map((cell, index) => <Day key={cell.day || 'pad' + index} cell={cell} today={today}/>)}
          </ol>
          <ul className="wv-legend">
            <li><span className="wv-swatch is-done" aria-hidden="true"/>{COPY.done}</li>
            <li><span className="wv-swatch is-missed" aria-hidden="true"/>{COPY.missed}</li>
            <li><span className="wv-swatch is-before" aria-hidden="true"/>{COPY.notStarted}</li>
          </ul>
        </section>}

        <section className="wv-notes" aria-labelledby={notesId}>
          <h2 id={notesId}>{COPY.recent}</h2>
          {notes.length ? <ul>
            {notes.map((note, index) => <li key={note.day + ':' + index} className="wv-note">
              <div className="wv-note-head">
                <span className="wv-note-date">{formatDay(note.day)}</span>
                <span className={'wv-source is-' + note.source}>{note.source === 'web' ? COPY.sourceWeb : COPY.sourceAgent}</span>
              </div>
              {note.note && <p>{note.note}</p>}
            </li>)}
          </ul> : <p className="wv-empty">{COPY.recordsEmpty}</p>}
        </section>
      </div>
    </div>
  </div>;
}

// One of the three numbers: 「10 月做到」 16 / 20 天.
function Stat({label, value, unit}) {
  return <div className="wv-stat">
    <dt>{label}</dt>
    <dd>{value} <span className="wv-stat-unit">{unit}</span></dd>
  </div>;
}

// A day of the calendar. Its number is drawn; a screen reader hears the date and what happened. Padding and the days the
// page knows nothing about ('unknown') say nothing. Today, until it is done, is still open: a ring, and 「今天」.
function Day({cell, today}) {
  if (cell.kind === 'empty' || cell.kind === 'unknown') return <li className={'wv-cal-day is-' + cell.kind} aria-hidden="true">{cell.label}</li>;
  const isToday = cell.day === today && cell.kind === 'future';
  const said = SAID[cell.kind] || (isToday ? COPY.today : '');
  return <li className={'wv-cal-day is-' + cell.kind + (isToday ? ' is-today' : '')}>
    <span aria-hidden="true">{cell.label}</span>
    <span className="wv-sr-only">{said ? COPY.dayState(formatDay(cell.day), said) : formatDay(cell.day)}</span>
  </li>;
}
