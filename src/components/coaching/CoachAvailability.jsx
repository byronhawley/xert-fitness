import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateAvailability } from '@/lib/staffRoster/availability';
import { availabilityStatus, availabilitySummary, monthClassSessions, periodPhase, startingPoint } from '@/lib/staffRoster/availabilityEditor';
import {
  CLASS_CHOICES, DAY_RANGES, datesOnWeekday, dayStates, fillFromPattern, hasSharedDuty, setClassStatus, setDay, setDayRange, toggleWeekday, weekPatternOf,
} from '@/lib/staffRoster/dayAvailability';
import { clockLabel, datesOfMonth, gymDateOf, parseClock, weekdayOf } from '@/lib/staffRoster/time';
import { at, Banner, BUTTON, dateName, GHOST, INPUT, LABEL, monthName, monthOnly, monthSpan, Pill, Sheet, STATUS_WORDS, WEEKDAYS } from './coachingUi';

const TONE = { PREFERRED: 'success', AVAILABLE: 'success', IF_NEEDED: 'warning', UNAVAILABLE: 'danger', PARTIAL: 'warning', UNKNOWN: 'neutral' };
/** Calendar columns run Monday to Sunday. */
const COLUMNS = [1, 2, 3, 4, 5, 6, 0];
const DAY_WORD = { available: 'Work', away: 'Away' };
const DAY_SPOKEN = { available: 'can work', away: 'away', none: 'not answered' };

/** The two calendar modes. Each has a symbol and a word, so colour is never the only signal. */
export const DAY_MODES = Object.freeze([
  { state: 'available', label: 'I can work', symbol: '✓', help: 'Tap the days you can work. Tap a marked day to see its classes; tap it again to clear it.' },
  { state: 'away', label: 'I’m away', symbol: '✕', help: 'Tap the days you can’t work at all. Tap again to undo.' },
]);

const classWord = count => `${count} ${count === 1 ? 'class' : 'classes'}`;

/** The month calendar: the main control. */
function MonthCalendar({ month, states, mode, setMode, selected, onTap, onWeekday, ready, startsOn }) {
  const dates = datesOfMonth(month);
  const pad = (weekdayOf(dates[0]) + 6) % 7;
  const modeInfo = DAY_MODES.find(item => item.state === mode);
  const counts = { available: 0, away: 0 };
  for (const day of states.values()) if (day.state && !day.outside) counts[day.state]++;
  return (
    <div className="coaching-card coaching-calendar-card space-y-3">
      <div className="coaching-brush coaching-mode" role="radiogroup" aria-label="What a tap marks">
        {DAY_MODES.map(item => (
          <button key={item.state} type="button" role="radio" aria-checked={mode === item.state} data-status={item.state === 'away' ? 'UNAVAILABLE' : 'AVAILABLE'} onClick={() => setMode(item.state)}>
            <span aria-hidden="true">{item.symbol}</span> {item.label}
          </button>
        ))}
      </div>
      <p className="font-body text-sm text-xert-pale/75">{modeInfo.help}</p>
      <h4 className="coaching-calendar-title">{monthName(month)}</h4>
      <div className="coaching-calendar coaching-every" role="group" aria-label={`Mark every weekday: ${modeInfo.label.toLowerCase()}`}>
        {COLUMNS.map(weekday => {
          const dates = datesOnWeekday(month, weekday, { startsOn });
          const all = dates.length > 0 && dates.every(date => states.get(date)?.state === mode);
          return (
            <button key={weekday} type="button" className="coaching-every-day" aria-pressed={all} disabled={!ready || !dates.length} aria-label={`Every ${WEEKDAYS[weekday]}`}
              onClick={() => onWeekday(weekday)}>
              <span className="coaching-every-word" aria-hidden="true">Every</span>
              <span aria-hidden="true">{WEEKDAYS[weekday].slice(0, 3)}</span>
            </button>
          );
        })}
      </div>
      <div className="coaching-calendar" role="group" aria-label={`Days in ${monthName(month)}`}>
        {Array.from({ length: pad }, (_, index) => <span key={`pad-${index}`} aria-hidden="true" />)}
        {dates.map(date => {
          const day = states.get(date);
          const count = day.classes.length;
          return (
            <button key={date} type="button" className="coaching-day" data-state={day.outside ? 'outside' : day.state || 'none'} aria-pressed={selected === date} disabled={!ready || day.outside}
              aria-label={day.outside ? `${dateName(date)}, not part of this roster` : `${dateName(date)}, ${DAY_SPOKEN[day.state || 'none']}, ${count ? classWord(count) : 'no classes'}`}
              onClick={() => onTap(date)}>
              <span>{Number(date.slice(8))}</span>
              <span className="coaching-day-word">{DAY_WORD[day.state] || ''}</span>
              {count > 0 && <span className="coaching-day-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <p className="coaching-legend-line"><span className="coaching-day-dot coaching-day-dot--inline" aria-hidden="true" /> has classes · blank = not answered (the manager won’t count on you){startsOn && ` · this roster starts ${dateName(startsOn)}; earlier days are greyed out`}</p>
      <p className="font-body text-xs text-xert-pale/70" role="status">
        {ready ? `Can work ${counts.available} ${counts.available === 1 ? 'day' : 'days'} · Away ${counts.away} ${counts.away === 1 ? 'day' : 'days'}` : 'Loading the timetable…'}
      </p>
    </div>
  );
}

/** From/To for a can-work day with no classes. */
function DayRange({ date, range, onChange }) {
  const [from, setFrom] = useState(clockLabel(range?.start ?? 0));
  const [to, setTo] = useState(clockLabel(range?.end ?? 1440));
  useEffect(() => { setFrom(clockLabel(range?.start ?? 0)); setTo(clockLabel(range?.end ?? 1440)); }, [range?.start, range?.end]);
  const start = parseClock(from);
  const end = parseClock(to);
  const valid = start !== null && end !== null && end > start;
  const commit = (nextFrom, nextTo) => {
    const a = parseClock(nextFrom);
    const b = parseClock(nextTo);
    if (a !== null && b !== null && b > a) onChange(a, b);
  };
  return (
    <div className="space-y-3">
      <p className="font-body text-sm text-xert-offwhite">No classes on the timetable this day yet. When are you free?</p>
      <div className="coaching-presets" role="group" aria-label="Free time">
        {DAY_RANGES.map(item => (
          <button key={item.key} type="button" aria-pressed={range?.start === item.start && range?.end === item.end && range?.pieces === 1}
            onClick={() => onChange(item.start, item.end)}>
            <span>{item.label}</span>
            <span className="coaching-preset-time">{item.key === 'all' ? 'any time' : `${clockLabel(item.start)}–${clockLabel(item.end)}`}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label htmlFor={`from-${date}`} className={LABEL}>From</label>
          <input id={`from-${date}`} type="time" className={INPUT} value={from} onChange={event => { setFrom(event.target.value); commit(event.target.value, to); }} /></div>
        <div><label htmlFor={`to-${date}`} className={LABEL}>To</label>
          <input id={`to-${date}`} type="time" className={INPUT} value={to === '24:00' ? '23:59' : to} onChange={event => { const value = event.target.value === '23:59' ? '24:00' : event.target.value; setTo(value); commit(from, value); }} /></div>
      </div>
      {!valid && <p className="font-body text-xs text-status-danger-200">The end time must be after the start.</p>}
      {range?.pieces > 1 && <p className="font-body text-xs text-xert-pale/60">You gave more than one time this day before. Choosing a time here replaces them.</p>}
    </div>
  );
}

/** The selected day: its state, then its classes or its free time. */
function DayPanel({ date, day, ready, onDay, onClass, onRange }) {
  if (!date || !day) {
    return <p className="coaching-card font-body text-sm text-xert-pale/70">Tap a day you can work to see its classes and say which ones you can do.</p>;
  }
  const shared = day.state === 'available' && hasSharedDuty(day.classes);
  return (
    <section className="coaching-card coaching-day-panel space-y-3" aria-label={`${dateName(date)} classes`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-body text-base font-semibold text-xert-offwhite">{dateName(date)}</h4>
        <span className="font-body text-xs text-xert-pale/60">{day.classes.length ? classWord(day.classes.length) : 'No classes'}</span>
      </div>
      <div className="coaching-day-states" role="group" aria-label={`${dateName(date)}: answer for the day`}>
        {[['available', 'Can work'], ['away', 'Away'], [null, 'Not answered']].map(([state, label]) => (
          <button key={label} type="button" data-state={state || 'none'} aria-pressed={day.state === state} disabled={!ready} onClick={() => onDay(state)}>{label}</button>
        ))}
      </div>
      {day.state === 'away' && <p className="font-body text-sm text-xert-pale/75">You’re away all day. You won’t be put on anything.</p>}
      {!day.state && <p className="font-body text-sm text-xert-pale/75">Not answered. The manager sees this day as unanswered, not as free.</p>}
      {day.state === 'available' && day.classes.length > 0 && (
        <>
          <p className="font-body text-xs text-xert-pale/60">Every class starts as Can do. Change any you’d prefer or can’t do.</p>
          <ul className="space-y-2" aria-label="Classes this day">
            {day.classes.map(item => {
              const time = at(item.session.start);
              return (
                <li key={item.session.id} className="coaching-class">
                  <p className="font-body text-sm text-xert-offwhite"><strong>{time}</strong> · {item.session.title}</p>
                  <div className="coaching-class-choices" role="group" aria-label={`${time} ${item.session.title}`}>
                    {CLASS_CHOICES.map(choice => (
                      <button key={choice.status} type="button" data-status={choice.status} aria-pressed={item.status === choice.status}
                        aria-label={`${choice.label}: ${time} ${item.session.title}`} onClick={() => onClass(item.session.id, choice.status)}>
                        <span aria-hidden="true">{choice.symbol}</span> {choice.label}
                      </button>
                    ))}
                  </div>
                  {item.status === 'IF_NEEDED' && <p className="font-body text-xs text-status-warning-200">Earlier answer: if needed. Pick one above to change it.</p>}
                  {!item.status && <p className="font-body text-xs text-xert-pale/60">{item.read === 'PARTIAL' ? 'Only part of this class was covered, so it counts as not answered. Pick one.' : 'Not answered yet. Pick one.'}</p>}
                </li>
              );
            })}
          </ul>
          {shared && <p className="font-body text-xs text-xert-pale/60">Some classes here share setup or pack-down time. If you can’t do one of them, you’re counted as can’t for the other too.</p>}
        </>
      )}
      {day.state === 'available' && day.classes.length === 0 && (
        <DayRange key={date} date={date} range={day.range} onChange={onRange} />
      )}
    </section>
  );
}

/** Monthly availability: answer, review, submit. Drafts autosave; submitting makes a new version. */
export default function CoachAvailability({ client, me, monthParam, setMonthParam, onChanged, notify }) {
  const periods = me.periods || [];
  const preferred = periods.find(period => period.month.slice(0, 7) === monthParam)
    || periods.find(period => periodPhase(period) === 'open' && !period.submission) || periods.find(period => periodPhase(period) === 'open') || periods[periods.length - 1];
  const period = preferred || null;
  const month = period?.month.slice(0, 7);
  // A part-month period covers classes from starts_on to the month's end; null means the whole month.
  const startsOn = period?.starts_on && period.starts_on.slice(0, 7) === month ? period.starts_on.slice(0, 10) : null;
  const scope = useMemo(() => ({ startsOn }), [startsOn]);
  const phase = periodPhase(period);
  const editable = phase === 'open';

  const [payload, setPayload] = useState(null);
  const [source, setSource] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const [classes, setClasses] = useState([]);
  const [classesReady, setClassesReady] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [step, setStep] = useState('answer');
  const [mode, setMode] = useState('available');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [changeMessage, setChangeMessage] = useState('');
  const timer = useRef(null);
  const topRef = useRef(null);
  // Autosave. Drafts are versioned on the server and a save must name the
  // version it replaces, so saves run one at a time, each with the version
  // the previous one returned (`versions`, by month). The latest unsaved
  // answer waits in `pending` and is saved on leaving the tab or the month
  // too, never dropped. `answers` keeps this screen's own answer per month,
  // so returning to a month (or a reload that only echoes our own saves)
  // shows it rather than an older copy.
  const versions = useRef(new Map());
  const answers = useRef(new Map());
  const pending = useRef(null);
  const queue = useRef(Promise.resolve());
  const shown = useRef(null);
  const beforeNone = useRef(null);
  const savedHere = useRef(false);
  const currentMonth = useRef(month);
  currentMonth.current = month;

  const persist = useCallback((target, next) => {
    const run = queue.current.then(async () => {
      const here = () => currentMonth.current === target;
      if (here()) setSaveState('saving');
      try {
        const result = await client.saveAvailabilityDraft(target, next, versions.current.get(target) ?? 0);
        versions.current.set(target, result.version);
        savedHere.current = true;
        if (here()) setSaveState(pending.current?.month === target ? 'pending' : 'saved');
      } catch (failure) {
        if (here()) setSaveState('error');
        if (failure.code === 'STALE_VERSION') {
          answers.current.delete(target);
          notify('Your availability was changed on another device. Showing the latest.', 'error');
          onChanged?.();
        }
      }
    });
    queue.current = run.catch(() => {});
    return run;
  }, [client, notify, onChanged]);

  const flush = () => {
    clearTimeout(timer.current);
    const item = pending.current;
    pending.current = null;
    return item ? persist(item.month, item.payload) : queue.current;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  // Leaving the tab: save the last change, then refresh the coach's data so
  // coming back shows the saved draft, not the copy loaded before it.
  useEffect(() => () => {
    flushRef.current().then(() => { if (savedHere.current) onChangedRef.current?.(); });
  }, []);

  useEffect(() => {
    if (!period) return;
    const key = period.month.slice(0, 7);
    const submission = period.submission?.version || 0;
    const serverDraft = period.draft?.version || 0;
    const switching = shown.current && shown.current !== key;
    // Leaving a month: its last answer is saved, not dropped.
    if (switching && pending.current && pending.current.month !== key) flushRef.current();
    const mine = answers.current.get(key);
    if (mine && mine.submission === submission && (versions.current.get(key) ?? 0) >= serverDraft) {
      // Only our own saves since: keep the answer on screen (and any unsaved change).
      if (switching) { setPayload(mine.payload); setSource('draft'); setSaveState(pending.current?.month === key ? 'pending' : 'idle'); setStep('answer'); setSelected(null); beforeNone.current = null; }
      shown.current = key;
      return;
    }
    // A submit, a reopening or another device changed it: the server's copy wins.
    if (pending.current?.month === key) { clearTimeout(timer.current); pending.current = null; }
    answers.current.delete(key);
    versions.current.set(key, serverDraft);
    const start = startingPoint(period, me.usual_week);
    setPayload(start.payload);
    setSource(start.source);
    setSaveState('idle');
    setStep('answer');
    setSelected(null);
    beforeNone.current = null;
    shown.current = key;
  }, [period?.month, period?.draft?.version, period?.submission?.version]);

  useEffect(() => {
    if (!month) return;
    let live = true;
    setClassesReady(false);
    client.monthClasses(month)
      .then(rows => { if (live) { setClasses(monthClassSessions(rows)); setClassesReady(true); } })
      .catch(() => { if (live) { setClasses([]); setClassesReady(true); } });
    return () => { live = false; };
  }, [client, month]);

  const update = next => {
    if (next === payload) return;
    setPayload(next);
    answers.current.set(month, { payload: next, submission: period?.submission?.version || 0 });
    pending.current = { month, payload: next };
    setSaveState('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flushRef.current(); }, 1200);
  };
  useEffect(() => { if (step === 'review') topRef.current?.focus(); }, [step]);

  const states = useMemo(() => (payload && month ? dayStates(payload, month, classes, scope) : new Map()), [payload, month, classes, scope]);
  const summary = useMemo(() => (payload && month ? availabilitySummary(payload, month, classes, scope) : null), [payload, month, classes, scope]);
  const local = payload && month ? validateAvailability(payload, month) : { errors: [] };

  if (!period) {
    return (
      <div className="coaching-card space-y-1">
        <p className="font-body text-sm font-semibold text-xert-offwhite">Nothing to fill in right now</p>
        <p className="font-body text-sm text-xert-pale/70">The manager hasn’t asked for availability yet. You’ll get a notice in your Inbox when they do.</p>
      </div>
    );
  }

  const status = availabilityStatus(period, { editedHere: saveState !== 'idle' });
  const lastMonth = me.last_submission && me.last_submission.month !== period.month ? me.last_submission : null;
  const lastPattern = lastMonth && !lastMonth.no_availability ? weekPatternOf(lastMonth.payload || {}, lastMonth.month.slice(0, 7)) : [];
  const usualPattern = me.usual_week?.pattern || [];
  const monthPattern = payload ? weekPatternOf(payload, month) : [];
  const classesLabel = `${monthOnly(month)} classes`;

  const tapDay = date => {
    const day = states.get(date);
    if (!day || day.outside) return;
    if (mode === 'away') {
      update(setDay(payload, month, classes, date, day.state === 'away' ? null : 'away', scope));
    } else if (day.state === 'available') {
      if (selected === date) update(setDay(payload, month, classes, date, null, scope));
    } else {
      update(setDay(payload, month, classes, date, 'available', scope));
    }
    setSelected(date);
  };

  const submit = async () => {
    setBusy(true);
    try {
      // Save the latest answer as the draft first (and let any save on its
      // way finish), so it is kept even if the submit is refused, and no
      // draft save lands after the submission.
      await flushRef.current();
      const result = await client.submitAvailability(month, payload);
      notify(`${monthName(month)} submitted${result?.version > 1 ? ` (version ${result.version})` : ''}. You can change it until ${dateName(period.due_on)}.`);
      onChanged?.();
    } catch (failure) {
      notify(failure.message, 'error');
    } finally { setBusy(false); }
  };

  const freeDays = [...states.values()].filter(day => day.state === 'available' && !day.classes.length);

  return (
    <div className="space-y-5">
      {periods.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Which month’s classes">
          {periods.map(item => <button key={item.month} type="button" className={GHOST} aria-pressed={item.month === period.month} onClick={() => setMonthParam(item.month.slice(0, 7))}>{monthOnly(item.month)} classes</button>)}
        </div>
      )}

      <header className="coaching-card coaching-ask space-y-2" aria-labelledby="availability-heading">
        <p className="font-body text-xs uppercase tracking-wider text-xert-pale/60">What we need from you</p>
        <h2 id="availability-heading" className="font-display text-2xl uppercase text-xert-offwhite">
          Your availability for {classesLabel} <span className="coaching-ask-span">({monthSpan(month, startsOn)})</span>
        </h2>
        <p className="font-body text-sm text-xert-pale/80">
          {phase === 'not_open' && `The manager will ask for ${monthOnly(month)} availability on ${dateName(period.opens_on)}. You’ll get a notice.`}
          {phase === 'open' && `Tell the manager which days and classes you can coach in ${monthName(month)}. They build the roster from your answers.`}
          {phase === 'closed' && `The due date has passed, so your answers are locked.`}
        </p>
        <dl className="coaching-ask-facts">
          <div><dt>Send your answers by</dt><dd>{dateName(period.due_on)}</dd></div>
          <div><dt>Status</dt><dd><Pill tone={status.tone}>{status.label}</Pill></dd></div>
        </dl>
        {period.reopened && phase === 'open' && <p className="font-body text-xs text-status-warning-200">The manager reopened this for you. Submit again when you’re done.</p>}
        {period.submission?.late && <p className="font-body text-xs text-xert-pale/60">Your last answer was sent after the due date.</p>}
        {editable && (
          <p className="coaching-save-state" data-state={saveState} role="status" aria-live="polite">
            {saveState === 'saving' && 'Saving…'}{saveState === 'pending' && 'Saving soon…'}{saveState === 'saved' && 'Draft saved. Not sent to the manager until you submit.'}
            {saveState === 'error' && <>Couldn’t save. <button type="button" className="underline" onClick={() => persist(month, payload)}>Try again</button></>}
            {saveState === 'idle' && (source === 'usual_week' ? 'Started from your usual week.' : source === 'submission' ? 'Showing what you submitted.' : source === 'draft' ? 'Picking up your saved draft.' : '')}
          </p>
        )}
      </header>

      {phase === 'closed' && (
        <Banner tone="warning" title="Need to change something?" action={period.change_request_open ? <Pill tone="info">Request sent</Pill> : <button type="button" className={GHOST} onClick={() => setSheet('change')}>Ask the manager</button>}>
          After the due date the manager has to reopen your availability. If you can’t make a class, use Requests to ask for time away or cover.
        </Banner>
      )}

      {editable && payload && step === 'answer' && (
        <>
          {(usualPattern.length > 0 || lastPattern.length > 0) && !payload.noAvailability && (
            <section className="space-y-2" aria-labelledby="quick-heading">
              <h3 id="quick-heading" className="coaching-step-heading">Quick start</h3>
              <div className="coaching-quick">
                {usualPattern.length > 0 && <button type="button" className={GHOST} disabled={!classesReady} onClick={() => update(fillFromPattern(payload, month, usualPattern, scope))}>Same as my usual week</button>}
                {lastPattern.length > 0 && <button type="button" className={GHOST} disabled={!classesReady} onClick={() => update(fillFromPattern(payload, month, lastPattern, scope))}>Copy {monthOnly(lastMonth.month)}</button>}
              </div>
              <p className="font-body text-xs text-xert-pale/55">Fills in your days from a usual week. Days you’ve marked away stay away.</p>
            </section>
          )}

          {!payload.noAvailability && (
            <>
              <section className="space-y-2" aria-labelledby="days-heading">
                <h3 id="days-heading" className="coaching-step-heading">1. Your days in {monthName(month)}</h3>
                <MonthCalendar month={month} states={states} mode={mode} setMode={setMode} selected={selected} ready={classesReady} startsOn={startsOn}
                  onTap={tapDay} onWeekday={weekday => update(toggleWeekday(payload, month, classes, weekday, mode, scope))} />
              </section>

              <section className="space-y-2" aria-labelledby="day-heading">
                <h3 id="day-heading" className="coaching-step-heading">2. Classes on the day</h3>
                <DayPanel date={selected} day={selected ? states.get(selected) : null} ready={classesReady}
                  onDay={state => update(setDay(payload, month, classes, selected, state, scope))}
                  onClass={(sessionId, value) => update(setClassStatus(payload, month, classes, selected, sessionId, value, scope))}
                  onRange={(start, end) => update(setDayRange(payload, month, selected, start, end, scope))} />
              </section>
            </>
          )}

          <label className="coaching-card flex items-center gap-3 font-body text-sm text-xert-offwhite min-h-11">
            <input type="checkbox" className="h-5 w-5" checked={Boolean(payload.noAvailability)} onChange={event => {
              // Ticking clears the answers; unticking brings back what was there, so a mis-tap loses nothing.
              if (event.target.checked) { beforeNone.current = payload; update({ weekly: [], exceptions: [], noAvailability: true }); }
              else { update(beforeNone.current && !beforeNone.current.noAvailability ? beforeNone.current : { ...payload, noAvailability: false }); beforeNone.current = null; }
            }} />
            I can’t coach at all in {monthName(month)}
          </label>

          {!payload.noAvailability && (
            <details className="coaching-card">
              <summary className="font-body text-sm text-xert-pale cursor-pointer min-h-11 flex items-center">More options</summary>
              <div className="space-y-2 mt-2">
                <p className="font-body text-xs text-xert-pale/55">Save this month’s pattern as your usual week, so next month starts from it. Each weekday takes the answer most of its days share.</p>
                <button type="button" className={GHOST} disabled={!monthPattern.length} onClick={async () => {
                  try { await client.saveUsualWeek(monthPattern, me.usual_week?.version ?? 0); notify('Saved as your usual week. Next month starts from it.'); onChanged?.(); } catch (failure) { notify(failure.message, 'error'); }
                }}>Save as my usual week</button>
              </div>
            </details>
          )}

          {local.errors.length > 0 && (
            <Banner tone="warning" title="Before you can submit">
              <ul className="list-disc ps-4">{local.errors.map(message => <li key={message}>{message}</li>)}</ul>
            </Banner>
          )}
          <div className="coaching-submit-bar">
            {summary && local.errors.length === 0 && <p className="font-body text-xs text-xert-pale/75" aria-live="polite">{summary.sentence}</p>}
            <button type="button" className={`${BUTTON} w-full`} disabled={local.errors.length > 0} onClick={() => setStep('review')}>Review and submit</button>
          </div>
        </>
      )}

      {editable && payload && step === 'review' && summary && (
        <section className="space-y-4" aria-labelledby="review-heading">
          <h3 id="review-heading" ref={topRef} tabIndex={-1} className="font-display text-2xl uppercase text-xert-offwhite">Check and submit</h3>
          {payload.noAvailability ? <Banner tone="info" title={`You’re telling the manager you can’t coach in ${monthName(month)}`}>You won’t be put on any class. You can still offer to cover a class later.</Banner> : (
            <div className="coaching-card space-y-3">
              <p className="font-body text-base text-xert-offwhite">{summary.sentence}</p>
              <dl className="coaching-stats">
                <div className="coaching-card"><dt className="font-body text-xs text-xert-pale/60">Can do</dt><dd className="font-display text-2xl text-xert-offwhite">{summary.canDo}</dd></div>
                <div className="coaching-card"><dt className="font-body text-xs text-xert-pale/60">Prefer</dt><dd className="font-display text-2xl text-xert-offwhite">{summary.prefer}</dd></div>
                <div className="coaching-card"><dt className="font-body text-xs text-xert-pale/60">Can’t</dt><dd className="font-display text-2xl text-xert-offwhite">{summary.cant}</dd></div>
                <div className="coaching-card"><dt className="font-body text-xs text-xert-pale/60">Days away</dt><dd className="font-display text-2xl text-xert-offwhite">{summary.away}</dd></div>
                {summary.freeDays > 0 && <div className="coaching-card"><dt className="font-body text-xs text-xert-pale/60">Free days, no classes</dt><dd className="font-display text-2xl text-xert-offwhite">{summary.freeDays}</dd></div>}
              </dl>
              {summary.ifNeeded > 0 && <p className="font-body text-sm text-xert-pale/75">{summary.ifNeeded} of those only if nobody else can.</p>}
              {summary.partial > 0 && <p className="font-body text-sm text-status-warning-200">{summary.partial} only partly covered — you won’t be put on those. Pick an answer for each class on the day.</p>}
              {summary.unknown > 0 && <p className="font-body text-sm text-xert-pale/65">{summary.unknown} not answered — the manager will treat these as can’t.</p>}
            </div>
          )}
          {!payload.noAvailability && summary.rows.length > 0 && (
            <details className="coaching-card">
              <summary className="font-body text-sm text-xert-pale cursor-pointer min-h-11 flex items-center">See every class</summary>
              <ul className="mt-2 space-y-1">
                {summary.rows.map(row => (
                  <li key={row.session.id} className="flex flex-wrap items-center justify-between gap-2 font-body text-sm">
                    <span>{dateName(gymDateOf(row.session.start))} {at(row.session.start)} · {row.session.title}</span>
                    <Pill tone={TONE[row.status]}>{STATUS_WORDS[row.status]}</Pill>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!payload.noAvailability && freeDays.length > 0 && (
            <details className="coaching-card">
              <summary className="font-body text-sm text-xert-pale cursor-pointer min-h-11 flex items-center">Free days with no classes ({freeDays.length})</summary>
              <ul className="mt-2 space-y-1">
                {freeDays.map(day => (
                  <li key={day.date} className="flex flex-wrap items-center justify-between gap-2 font-body text-sm">
                    <span>{dateName(day.date)}</span>
                    <span className="text-xert-pale/75">{!day.range ? '' : day.range.start === 0 && day.range.end === 1440 ? 'All day' : `${clockLabel(day.range.start)}–${clockLabel(day.range.end)}`}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button type="button" className={`${BUTTON} w-full`} disabled={busy} onClick={submit}>{period.submission ? 'Submit changes' : `Submit ${classesLabel}`}</button>
          <button type="button" className={`${GHOST} w-full`} onClick={() => setStep('answer')}>Change my answers</button>
          <p className="font-body text-xs text-xert-pale/55">Submitting doesn’t put you on the roster yet. The manager builds it and publishes it, and you’ll get a notice when they do. You can change your answers until {dateName(period.due_on)}.</p>
        </section>
      )}

      <Sheet open={sheet === 'change'} title="Ask to change availability" onClose={() => setSheet(null)}
        footer={<><button type="button" className={BUTTON} disabled={busy || changeMessage.trim().length < 3} onClick={async () => {
          setBusy(true);
          try { await client.requestChange(month, changeMessage.trim()); notify('Sent. The manager can reopen your availability.'); setSheet(null); onChanged?.(); } catch (failure) { notify(failure.message, 'error'); } finally { setBusy(false); }
        }}>Send</button><button type="button" className={GHOST} onClick={() => setSheet(null)}>Cancel</button></>}>
        <label htmlFor="change-message" className={LABEL}>What do you need to change?</label>
        <textarea id="change-message" rows={3} className={INPUT} value={changeMessage} onChange={event => setChangeMessage(event.target.value)} maxLength={500} />
      </Sheet>
    </div>
  );
}
