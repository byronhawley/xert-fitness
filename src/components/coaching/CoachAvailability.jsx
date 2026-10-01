import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AVAILABILITY_STATUSES, copyPreviousMonth, startFromPattern, validateAvailability } from '@/lib/staffRoster/availability';
import { monthClassSessions, periodPhase, presetShortcuts, reviewClasses, setShortcut, shortcutStatus, startingPoint } from '@/lib/staffRoster/availabilityEditor';
import { clockLabel, gymDateOf, minuteLabel, parseClock } from '@/lib/staffRoster/time';
import { at, Banner, BUTTON, dateName, GHOST, INPUT, LABEL, monthName, Pill, Sheet, STATUS_WORDS, WEEKDAYS } from './coachingUi';

const SHORT = { PREFERRED: 'Prefer', AVAILABLE: 'Yes', IF_NEEDED: 'If needed', UNAVAILABLE: 'No' };
const TONE = { PREFERRED: 'success', AVAILABLE: 'success', IF_NEEDED: 'warning', UNAVAILABLE: 'danger', PARTIAL: 'warning', UNKNOWN: 'neutral' };

function Choice({ label, value, onChange, disabled }) {
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
    <Sheet open={open} title={mode === 'date' ? 'Add a date' : 'Add a usual time'} onClose={onClose}
      footer={<><button type="button" className={BUTTON} disabled={!valid} onClick={() => onAdd(mode === 'date' ? { date, start, end, status } : { weekday, start, end, status })}>Add</button><button type="button" className={GHOST} onClick={onClose}>Cancel</button></>}>
      {mode === 'date' ? (
        <div><label htmlFor="exception-date" className={LABEL}>Date</label><input id="exception-date" type="date" className={INPUT} min={`${month}-01`} max={`${month}-31`} value={date} onChange={event => setDate(event.target.value)} /></div>
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
  const [busy, setBusy] = useState(false);
  const [changeMessage, setChangeMessage] = useState('');
  const dirty = useRef(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!period) return;
    const start = startingPoint(period, me.usual_week);
    setPayload(start.payload);
    setSource(start.source);
    setDraftVersion(period.draft?.version || 0);
    setSaveState(period.draft ? 'saved' : 'idle');
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

  const shortcuts = useMemo(() => presetShortcuts(classes, me.settings?.class_time_presets || []), [classes, me.settings]);
  const review = useMemo(() => (payload && month ? reviewClasses(payload, month, classes) : null), [payload, month, classes]);
  const local = payload && month ? validateAvailability(payload, month) : { errors: [] };
  const shortcutKeys = new Set(shortcuts.map(item => `${item.weekday}:${item.start}:${item.end}`));
  const customWeekly = (payload?.weekly || []).filter(item => !shortcutKeys.has(`${item.weekday}:${item.start}:${item.end}`));

  if (!period) return <div className="coaching-card"><p className="font-body text-sm text-xert-pale/70">The manager hasn’t asked for availability yet. You’ll get a notice here when they do.</p></div>;

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
      <header className="space-y-1">
        <h2 className="font-display text-3xl uppercase text-xert-offwhite">{monthName(month)}</h2>
        <p className="font-body text-sm text-xert-pale/70">
          {phase === 'not_open' && `Opens ${dateName(period.opens_on)}.`}
          {phase === 'open' && `Due ${dateName(period.due_on)}.${period.reopened ? ' Reopened for you by the manager.' : ''}`}
          {phase === 'closed' && `The deadline was ${dateName(period.due_on)}.`}
          {period.submission && ` Submitted ${period.submission.no_availability ? '“not available this month”' : `version ${period.submission.version}`}${period.submission.late ? ' (late)' : ''}.`}
        </p>
      </header>

      {phase === 'closed' && (
        <Banner tone="warning" title="Need to change something?" action={period.change_request_open ? <Pill tone="info">Request sent</Pill> : <button type="button" className={GHOST} onClick={() => setSheet('change')}>Ask the manager</button>}>
          After the deadline the manager has to reopen your availability. Absences can always be reported from Requests.
        </Banner>
      )}

      {editable && payload && step === 'answer' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="coaching-save-state" data-state={saveState} role="status" aria-live="polite">
              {saveState === 'saving' && 'Saving draft…'}{saveState === 'pending' && 'Unsaved changes'}{saveState === 'saved' && 'Draft saved — not submitted yet'}
              {saveState === 'error' && <>Couldn’t save. <button type="button" className="underline" onClick={() => saveDraft(payload)}>Try again</button></>}
              {saveState === 'idle' && (source === 'usual_week' ? 'Started from your usual week' : source === 'submission' ? 'Showing what you submitted' : '')}
            </span>
          </div>

          <label className="coaching-card flex items-center gap-3 font-body text-sm text-xert-offwhite">
            <input type="checkbox" checked={Boolean(payload.noAvailability)} onChange={event => update(event.target.checked ? { weekly: [], exceptions: [], noAvailability: true } : { ...payload, noAvailability: false })} />
            I can’t work at all in {monthName(month)}
          </label>

          {!payload.noAvailability && (
            <>
              <section className="space-y-3" aria-labelledby="shortcut-heading">
                <h3 id="shortcut-heading" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">Class times each week</h3>
                {shortcuts.length === 0 && <p className="font-body text-sm text-xert-pale/60">No classes are on the timetable for {monthName(month)} yet. Add usual times below instead.</p>}
                {WEEKDAYS.map((name, weekday) => {
                  const list = shortcuts.filter(item => item.weekday === weekday);
                  if (!list.length) return null;
                  return (
                    <div key={name} className="coaching-card space-y-3">
                      <p className="font-body text-sm font-semibold text-xert-offwhite">{name}s</p>
                      {list.map(item => (
                        <div key={`${item.presetMinute}`} className="space-y-1">
                          <p className="font-body text-xs text-xert-pale/70">{item.label} {item.sessions === 1 ? 'class' : 'classes'} · on duty {minuteLabel(item.start)}–{minuteLabel(item.end)}</p>
                          <Choice label={`${name} ${item.label}`} value={shortcutStatus(payload, item)} onChange={status => update(setShortcut(payload, item, status))} />
                        </div>
                      ))}
                    </div>
                  );
                })}
              </section>

              <section className="space-y-2" aria-labelledby="custom-heading">
                <div className="flex items-center justify-between gap-2">
                  <h3 id="custom-heading" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">Other usual times</h3>
                  <button type="button" className={GHOST} onClick={() => setSheet('weekly')}>Add time</button>
                </div>
                {customWeekly.map((item, index) => (
                  <div key={`${item.weekday}-${item.start}-${index}`} className="coaching-card flex items-center justify-between gap-2">
                    <span className="font-body text-sm">{WEEKDAYS[item.weekday]} {clockLabel(item.start)}–{clockLabel(item.end)} · <Pill tone={TONE[item.status]}>{STATUS_WORDS[item.status]}</Pill></span>
                    <button type="button" className={GHOST} aria-label={`Remove ${WEEKDAYS[item.weekday]} ${clockLabel(item.start)}`} onClick={() => update({ ...payload, weekly: payload.weekly.filter(entry => entry !== item) })}>Remove</button>
                  </div>
                ))}
              </section>

              <section className="space-y-2" aria-labelledby="dates-heading">
                <div className="flex items-center justify-between gap-2">
                  <h3 id="dates-heading" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">Specific dates</h3>
                  <button type="button" className={GHOST} onClick={() => setSheet('date')}>Add date</button>
                </div>
                <p className="font-body text-xs text-xert-pale/55">A date overrides your usual week for the times you give, e.g. away on the 14th.</p>
                {(payload.exceptions || []).map((item, index) => (
                  <div key={`${item.date}-${item.start}-${index}`} className="coaching-card flex items-center justify-between gap-2">
                    <span className="font-body text-sm">{dateName(item.date)} {item.start === 0 && item.end === 1440 ? 'all day' : `${clockLabel(item.start)}–${clockLabel(item.end)}`} · <Pill tone={TONE[item.status]}>{STATUS_WORDS[item.status]}</Pill></span>
                    <button type="button" className={GHOST} aria-label={`Remove ${dateName(item.date)}`} onClick={() => update({ ...payload, exceptions: payload.exceptions.filter(entry => entry !== item) })}>Remove</button>
                  </div>
                ))}
              </section>

              <div className="flex flex-wrap gap-2">
                {me.usual_week?.pattern?.length > 0 && <button type="button" className={GHOST} onClick={() => update(startFromPattern(me.usual_week.pattern))}>Reset to my usual week</button>}
                {me.last_submission && me.last_submission.month !== period.month && <button type="button" className={GHOST} onClick={() => update(copyPreviousMonth({ ...me.last_submission.payload, noAvailability: me.last_submission.no_availability }))}>Copy {monthName(me.last_submission.month)}</button>}
                <button type="button" className={GHOST} disabled={!payload.weekly.length} onClick={async () => {
                  try { await client.saveUsualWeek(payload.weekly, me.usual_week?.version ?? 0); notify('Saved as your usual week. Next month starts from it.'); onChanged?.(); } catch (failure) { notify(failure.message, 'error'); }
                }}>Save as my usual week</button>
              </div>
            </>
          )}

          {local.errors.length > 0 && (
            <Banner tone="warning" title="Before you can submit">
              <ul className="list-disc ps-4">{local.errors.map(message => <li key={message}>{message}</li>)}</ul>
            </Banner>
          )}
          <button type="button" className={`${BUTTON} w-full`} disabled={local.errors.length > 0} onClick={() => setStep('review')}>Review {monthName(month)}</button>
        </>
      )}

      {editable && payload && step === 'review' && review && (
        <section className="space-y-4" aria-labelledby="review-heading">
          <h3 id="review-heading" className="font-display text-2xl uppercase text-xert-offwhite">Check before you submit</h3>
          {payload.noAvailability ? <Banner tone="info" title={`You’re telling the manager you can’t work in ${monthName(month)}`}>You won’t be rostered. You can still offer to cover a class later.</Banner> : (
            <div className="coaching-card space-y-1 font-body text-sm">
              <p className="text-xert-offwhite">You’ll be considered for <strong>{review.considered}</strong> of {review.rows.length} classes.</p>
              {review.ifNeeded > 0 && <p className="text-xert-pale/75">{review.ifNeeded} more only if nobody else can.</p>}
              {review.partial > 0 && <p className="text-status-warning-200">{review.partial} only partly covered — you won’t be rostered on those. Extend your times if you can do the whole duty.</p>}
              {review.unknown > 0 && <p className="text-xert-pale/60">{review.unknown} not answered — treated as not available.</p>}
            </div>
          )}
          {!payload.noAvailability && review.rows.length > 0 && (
            <details className="coaching-card">
              <summary className="font-body text-sm text-xert-pale cursor-pointer min-h-11 flex items-center">See every class</summary>
              <ul className="mt-2 space-y-1">
                {review.rows.map(row => (
                  <li key={row.session.id} className="flex items-center justify-between gap-2 font-body text-sm">
                    <span>{dateName(gymDateOf(row.session.start))} {at(row.session.start)} · {row.session.title}</span>
                    <Pill tone={TONE[row.status]}>{STATUS_WORDS[row.status]}</Pill>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={busy} onClick={submit}>{period.submission ? 'Submit changes' : `Submit ${monthName(month)}`}</button>
            <button type="button" className={GHOST} onClick={() => setStep('answer')}>Back</button>
          </div>
          <p className="font-body text-xs text-xert-pale/55">Submitting doesn’t put you on the roster. The manager builds and publishes it, and you’ll get a notice when they do.</p>
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
