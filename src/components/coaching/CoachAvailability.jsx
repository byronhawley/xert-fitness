import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AVAILABILITY_STATUSES, copyPreviousMonth, startFromPattern, validateAvailability } from '@/lib/staffRoster/availability';
import {
  availabilityStatus, availabilitySummary, awayDates, classTimeShortcuts, monthClassSessions, periodPhase, setShortcut, setShortcuts,
  shortcutStatus, startingPoint, toggleAwayDate,
} from '@/lib/staffRoster/availabilityEditor';
import { clockLabel, datesOfMonth, gymDateOf, parseClock, weekdayOf } from '@/lib/staffRoster/time';
import { at, Banner, BUTTON, dateName, GHOST, INPUT, LABEL, monthName, Pill, Sheet, STATUS_WORDS, WEEKDAYS } from './coachingUi';

const SHORT = { PREFERRED: 'Prefer', AVAILABLE: 'Yes', IF_NEEDED: 'If needed', UNAVAILABLE: 'No' };
const TONE = { PREFERRED: 'success', AVAILABLE: 'success', IF_NEEDED: 'warning', UNAVAILABLE: 'danger', PARTIAL: 'warning', UNKNOWN: 'neutral' };

/** The three answers on the tap grid. Each has a symbol and a word, so colour is never the only signal. */
export const GRID_CHOICES = Object.freeze([
  { status: 'AVAILABLE', label: 'Can do', symbol: '✓', help: 'You can coach it.' },
  { status: 'PREFERRED', label: 'Prefer', symbol: '★', help: 'You’d like these first.' },
  { status: 'UNAVAILABLE', label: 'Can’t', symbol: '✕', help: 'Don’t put you on it.' },
]);
const CELL_WORD = { AVAILABLE: ['✓', 'Can do'], PREFERRED: ['★', 'Prefer'], UNAVAILABLE: ['✕', 'Can’t'], IF_NEEDED: ['?', 'If needed'] };

function Choice({ label, value, onChange, disabled = false }) {
  return (
    <div className="coaching-choice" role="group" aria-label={label}>
      {AVAILABILITY_STATUSES.map(status => (
        <button key={status} type="button" data-status={status} aria-pressed={value === status} disabled={disabled}
          onClick={() => onChange(value === status ? null : status)}>{SHORT[status]}</button>
      ))}
    </div>
  );
}

function WindowSheet({ open, mode, month, onClose, onAdd }) {
  const [weekday, setWeekday] = useState(1);
  const [date, setDate] = useState(`${month}-01`);
  const [from, setFrom] = useState('05:00');
  const [to, setTo] = useState('08:00');
  const [status, setStatus] = useState(mode === 'date' ? 'UNAVAILABLE' : 'AVAILABLE');
  const start = parseClock(from);
  const end = parseClock(to);
  const valid = start !== null && end !== null && end > start;
  return (
    <Sheet open={open} title={mode === 'date' ? 'Change one date' : 'Add a usual time'} onClose={onClose}
      footer={<><button type="button" className={BUTTON} disabled={!valid} onClick={() => onAdd(mode === 'date' ? { date, start, end, status } : { weekday, start, end, status })}>Add</button><button type="button" className={GHOST} onClick={onClose}>Cancel</button></>}>
      {mode === 'date' ? (
        <div><label htmlFor="exception-date" className={LABEL}>Date</label><input id="exception-date" type="date" className={INPUT} min={`${month}-01`} max={datesOfMonth(month).at(-1)} value={date} onChange={event => setDate(event.target.value)} /></div>
      ) : (
        <div><label htmlFor="window-day" className={LABEL}>Day</label>
          <select id="window-day" className={INPUT} value={weekday} onChange={event => setWeekday(Number(event.target.value))}>{WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div><label htmlFor="window-from" className={LABEL}>From</label><input id="window-from" type="time" className={INPUT} value={from} onChange={event => setFrom(event.target.value)} /></div>
        <div><label htmlFor="window-to" className={LABEL}>Until</label><input id="window-to" type="time" className={INPUT} value={to} onChange={event => setTo(event.target.value || '24:00')} /></div>
      </div>
      {mode === 'date' && <button type="button" className={GHOST} onClick={() => { setFrom('00:00'); setTo('24:00'); }}>Whole day</button>}
      <Choice label="Answer" value={status} onChange={value => setStatus(value || status)} />
      {!valid && <p className="font-body text-xs text-status-danger-200">The end time must be after the start.</p>}
    </Sheet>
  );
}

/** Weekly tap grid: pick an answer, then tap the class times it applies to. */
function WeekGrid({ grid, payload, brush, setBrush, onChange, monthLabel }) {
  const brushChoice = GRID_CHOICES.find(item => item.status === brush);
  if (grid.length === 0) {
    return <p className="coaching-card font-body text-sm text-xert-pale/70">No classes are on the timetable for {monthLabel} yet. Use “Add a usual time” under More options, or check back later.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="coaching-card space-y-2">
        <p id="brush-label" className="font-body text-sm text-xert-offwhite">Choose an answer, then tap the class times it applies to. Tap a time again to clear it.</p>
        <div className="coaching-brush" role="radiogroup" aria-labelledby="brush-label">
          {GRID_CHOICES.map(item => (
            <button key={item.status} type="button" role="radio" aria-checked={brush === item.status} data-status={item.status} onClick={() => setBrush(item.status)}>
              <span aria-hidden="true">{item.symbol}</span> {item.label}
            </button>
          ))}
        </div>
        <ul className="coaching-legend" aria-label="What the answers mean">
          {GRID_CHOICES.map(item => <li key={item.status}><span aria-hidden="true" data-status={item.status}>{item.symbol}</span> <strong>{item.label}</strong> — {item.help}</li>)}
          <li><span aria-hidden="true">–</span> <strong>Not set</strong> — counts as can’t.</li>
        </ul>
      </div>
      {WEEKDAYS.map((name, weekday) => {
        const cells = grid.filter(item => item.weekday === weekday);
        if (!cells.length) return null;
        const allBrush = cells.every(cell => shortcutStatus(payload, cell) === brush);
        return (
          <section key={name} className="coaching-card space-y-2" aria-label={`${name}s`}>
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-body text-sm font-semibold text-xert-offwhite">{name}s</h4>
              <button type="button" className="coaching-link" onClick={() => onChange(setShortcuts(payload, cells, allBrush ? null : brush))}>
                {allBrush ? `Clear all ${name}s` : `All ${name}s: ${brushChoice.label}`}
              </button>
            </div>
            <div className="coaching-cells">
              {cells.map(cell => {
                const status = shortcutStatus(payload, cell);
                const [symbol, word] = CELL_WORD[status] || ['–', 'Not set'];
                const next = status === brush ? 'clear it' : `mark ${brushChoice.label}`;
                return (
                  <button key={cell.presetMinute} type="button" className="coaching-cell" data-status={status || 'NONE'}
                    aria-label={`${name} ${cell.label}: ${word}. Tap to ${next}`}
                    onClick={() => onChange(setShortcut(payload, cell, status === brush ? null : brush))}>
                    <span className="coaching-cell-time">{cell.label}</span>
                    <span className="coaching-cell-state"><span aria-hidden="true">{symbol}</span> {word}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** "I'm away these days": tap whole days in a month calendar. */
function AwayCalendar({ month, payload, onChange }) {
  const dates = datesOfMonth(month);
  const away = new Set(awayDates(payload));
  const pad = (weekdayOf(dates[0]) + 6) % 7;
  return (
    <div className="coaching-card coaching-calendar-card space-y-2">
      <p className="font-body text-sm text-xert-pale/75">Tap any day you can’t work at all, even if it’s usually fine. Tap again to undo.</p>
      <div className="coaching-calendar" aria-hidden="true">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span key={day} className="coaching-calendar-head">{day.slice(0, 2)}</span>)}</div>
      <div className="coaching-calendar" role="group" aria-label={`Days away in ${monthName(month)}`}>
        {Array.from({ length: pad }, (_, index) => <span key={`pad-${index}`} aria-hidden="true" />)}
        {dates.map(date => (
          <button key={date} type="button" className="coaching-day" aria-pressed={away.has(date)} aria-label={`${dateName(date)}${away.has(date) ? ', away' : ''}`}
            onClick={() => onChange(toggleAwayDate(payload, date))}>
            <span>{Number(date.slice(8))}</span>
            {away.has(date) && <span className="coaching-day-away">Away</span>}
          </button>
        ))}
      </div>
      <p className="font-body text-xs text-xert-pale/60" role="status">{away.size ? `Away ${away.size} ${away.size === 1 ? 'day' : 'days'}: ${[...away].map(date => dateName(date, { weekday: false })).join(', ')}.` : 'No days away.'}</p>
    </div>
  );
}

/** Monthly availability: answer, review, submit. Drafts autosave; submitting makes a new version. */
export default function CoachAvailability({ client, me, monthParam, setMonthParam, onChanged, notify }) {
  const periods = me.periods || [];
  const preferred = periods.find(period => period.month.slice(0, 7) === monthParam)
    || periods.find(period => periodPhase(period) === 'open' && !period.submission) || periods.find(period => periodPhase(period) === 'open') || periods[periods.length - 1];
  const period = preferred || null;
  const month = period?.month.slice(0, 7);
  const phase = periodPhase(period);
  const editable = phase === 'open';

  const [payload, setPayload] = useState(null);
  const [source, setSource] = useState(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [saveState, setSaveState] = useState('idle');
  const [classes, setClasses] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [step, setStep] = useState('answer');
  const [brush, setBrush] = useState('AVAILABLE');
  const [busy, setBusy] = useState(false);
  const [changeMessage, setChangeMessage] = useState('');
  const dirty = useRef(false);
  const timer = useRef(null);
  const topRef = useRef(null);

  useEffect(() => {
    if (!period) return;
    const start = startingPoint(period, me.usual_week);
    setPayload(start.payload);
    setSource(start.source);
    setDraftVersion(period.draft?.version || 0);
    setSaveState('idle');
    setStep('answer');
    dirty.current = false;
  }, [period?.month, period?.draft?.version, period?.submission?.version]);

  useEffect(() => {
    if (!month) return;
    let live = true;
    client.monthClasses(month).then(rows => { if (live) setClasses(monthClassSessions(rows)); }).catch(() => { if (live) setClasses([]); });
    return () => { live = false; };
  }, [client, month]);

  const saveDraft = useCallback(async next => {
    setSaveState('saving');
    try {
      const result = await client.saveAvailabilityDraft(month, next, draftVersion);
      setDraftVersion(result.version);
      setSaveState('saved');
      dirty.current = false;
    } catch (failure) {
      setSaveState('error');
      if (failure.code === 'STALE_VERSION') { notify('Your availability was changed on another device. Showing the latest.', 'error'); onChanged?.(); }
    }
  }, [client, month, draftVersion, notify, onChanged]);

  const update = next => {
    setPayload(next);
    dirty.current = true;
    setSaveState('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveDraft(next), 1200);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (step === 'review') topRef.current?.focus(); }, [step]);

  const grid = useMemo(() => classTimeShortcuts(classes, me.settings?.class_time_presets || []), [classes, me.settings]);
  const summary = useMemo(() => (payload && month ? availabilitySummary(payload, month, classes) : null), [payload, month, classes]);
  const local = payload && month ? validateAvailability(payload, month) : { errors: [] };
  const gridKeys = new Set(grid.map(item => `${item.weekday}:${item.start}:${item.end}`));
  const customWeekly = (payload?.weekly || []).filter(item => !gridKeys.has(`${item.weekday}:${item.start}:${item.end}`));
  const away = new Set(awayDates(payload));
  const otherDates = (payload?.exceptions || []).filter(item => !(away.has(item.date) && item.status === 'UNAVAILABLE' && item.start === 0 && item.end === 1440));

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
  const submit = async () => {
    clearTimeout(timer.current);
    setBusy(true);
    try {
      const result = await client.submitAvailability(month, payload);
      notify(`${monthName(month)} submitted${result?.version > 1 ? ` (version ${result.version})` : ''}. You can change it until ${dateName(period.due_on)}.`);
      onChanged?.();
    } catch (failure) {
      notify(failure.message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      {periods.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Month">
          {periods.map(item => <button key={item.month} type="button" className={GHOST} aria-pressed={item.month === period.month} onClick={() => setMonthParam(item.month.slice(0, 7))}>{monthName(item.month)}</button>)}
        </div>
      )}

      <header className="coaching-card coaching-ask space-y-2" aria-labelledby="availability-heading">
        <p className="font-body text-xs uppercase tracking-wider text-xert-pale/60">What we need from you</p>
        <h2 id="availability-heading" className="font-display text-3xl uppercase text-xert-offwhite">{monthName(month)}</h2>
        <p className="font-body text-sm text-xert-pale/80">
          {phase === 'not_open' && `The manager will ask for ${monthName(month)} availability on ${dateName(period.opens_on)}. You’ll get a notice.`}
          {phase === 'open' && `Tell the manager which classes you can coach. They build the roster from your answers.`}
          {phase === 'closed' && `The due date has passed, so your answers are locked.`}
        </p>
        <dl className="coaching-ask-facts">
          <div><dt>Due by</dt><dd>{dateName(period.due_on)}</dd></div>
          <div><dt>Status</dt><dd><Pill tone={status.tone}>{status.label}</Pill></dd></div>
        </dl>
        {period.reopened && phase === 'open' && <p className="font-body text-xs text-status-warning-200">The manager reopened this for you. Submit again when you’re done.</p>}
        {period.submission?.late && <p className="font-body text-xs text-xert-pale/60">Your last answer was sent after the due date.</p>}
        {editable && (
          <p className="coaching-save-state" data-state={saveState} role="status" aria-live="polite">
            {saveState === 'saving' && 'Saving…'}{saveState === 'pending' && 'Saving soon…'}{saveState === 'saved' && 'Draft saved. Not sent to the manager until you submit.'}
            {saveState === 'error' && <>Couldn’t save. <button type="button" className="underline" onClick={() => saveDraft(payload)}>Try again</button></>}
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
          {(me.usual_week?.pattern?.length > 0 || lastMonth) && (
            <section className="space-y-2" aria-labelledby="quick-heading">
              <h3 id="quick-heading" className="coaching-step-heading">Quick start</h3>
              <div className="coaching-quick">
                {me.usual_week?.pattern?.length > 0 && <button type="button" className={GHOST} onClick={() => update(startFromPattern(me.usual_week.pattern))}>Same as my usual week</button>}
                {lastMonth && <button type="button" className={GHOST} onClick={() => update(copyPreviousMonth({ ...lastMonth.payload, noAvailability: lastMonth.no_availability }))}>Copy {monthName(lastMonth.month)}</button>}
              </div>
              <p className="font-body text-xs text-xert-pale/55">Fills in your weekly times. Days away are never copied.</p>
            </section>
          )}

          {!payload.noAvailability && (
            <>
              <section className="space-y-2" aria-labelledby="week-heading">
                <h3 id="week-heading" className="coaching-step-heading">1. Your usual week</h3>
                <WeekGrid grid={grid} payload={payload} brush={brush} setBrush={setBrush} onChange={update} monthLabel={monthName(month)} />
              </section>

              <section className="space-y-2" aria-labelledby="away-heading">
                <h3 id="away-heading" className="coaching-step-heading">2. Days you’re away</h3>
                <AwayCalendar month={month} payload={payload} onChange={update} />
                {otherDates.length > 0 && (
                  <ul className="space-y-2" aria-label="Other date changes">
                    {otherDates.map((item, index) => (
                      <li key={`${item.date}-${item.start}-${index}`} className="coaching-card flex items-center justify-between gap-2">
                        <span className="font-body text-sm">{dateName(item.date)} {item.start === 0 && item.end === 1440 ? 'all day' : `${clockLabel(item.start)}–${clockLabel(item.end)}`} · <Pill tone={TONE[item.status]}>{STATUS_WORDS[item.status]}</Pill></span>
                        <button type="button" className={GHOST} aria-label={`Remove ${dateName(item.date)}`} onClick={() => update({ ...payload, exceptions: payload.exceptions.filter(entry => entry !== item) })}>Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          <label className="coaching-card flex items-center gap-3 font-body text-sm text-xert-offwhite min-h-11">
            <input type="checkbox" className="h-5 w-5" checked={Boolean(payload.noAvailability)} onChange={event => update(event.target.checked ? { weekly: [], exceptions: [], noAvailability: true } : { ...payload, noAvailability: false })} />
            I can’t coach at all in {monthName(month)}
          </label>

          {!payload.noAvailability && (
            <details className="coaching-card" open={customWeekly.length > 0 || undefined}>
              <summary className="font-body text-sm text-xert-pale cursor-pointer min-h-11 flex items-center">More options</summary>
              <div className="space-y-3 mt-2">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-body text-sm font-semibold text-xert-offwhite">Other usual times</h4>
                    <button type="button" className={GHOST} onClick={() => setSheet('weekly')}>Add a usual time</button>
                  </div>
                  <p className="font-body text-xs text-xert-pale/55">For a time that isn’t a class above, or to say “if needed”.</p>
                  {customWeekly.map((item, index) => (
                    <div key={`${item.weekday}-${item.start}-${index}`} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-body text-sm">{WEEKDAYS[item.weekday]} {clockLabel(item.start)}–{clockLabel(item.end)} · <Pill tone={TONE[item.status]}>{STATUS_WORDS[item.status]}</Pill></span>
                      <button type="button" className={GHOST} aria-label={`Remove ${WEEKDAYS[item.weekday]} ${clockLabel(item.start)}`} onClick={() => update({ ...payload, weekly: payload.weekly.filter(entry => entry !== item) })}>Remove</button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={GHOST} onClick={() => setSheet('date')}>Change part of one day</button>
                  <button type="button" className={GHOST} disabled={!payload.weekly.length} onClick={async () => {
                    try { await client.saveUsualWeek(payload.weekly, me.usual_week?.version ?? 0); notify('Saved as your usual week. Next month starts from it.'); onChanged?.(); } catch (failure) { notify(failure.message, 'error'); }
                  }}>Save as my usual week</button>
                </div>
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
              </dl>
              {summary.ifNeeded > 0 && <p className="font-body text-sm text-xert-pale/75">{summary.ifNeeded} of those only if nobody else can.</p>}
              {summary.partial > 0 && <p className="font-body text-sm text-status-warning-200">{summary.partial} only partly covered — you won’t be put on those. Make your times cover the whole class, including setup.</p>}
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
          <button type="button" className={`${BUTTON} w-full`} disabled={busy} onClick={submit}>{period.submission ? 'Submit changes' : `Submit ${monthName(month)}`}</button>
          <button type="button" className={`${GHOST} w-full`} onClick={() => setStep('answer')}>Change my answers</button>
          <p className="font-body text-xs text-xert-pale/55">Submitting doesn’t put you on the roster yet. The manager builds it and publishes it, and you’ll get a notice when they do. You can change your answers until {dateName(period.due_on)}.</p>
        </section>
      )}

      <WindowSheet key={sheet} open={sheet === 'weekly' || sheet === 'date'} mode={sheet} month={month} onClose={() => setSheet(null)}
        onAdd={item => { update(sheet === 'date' ? { ...payload, noAvailability: false, exceptions: [...payload.exceptions, item] } : { ...payload, noAvailability: false, weekly: [...payload.weekly, item] }); setSheet(null); }} />
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
