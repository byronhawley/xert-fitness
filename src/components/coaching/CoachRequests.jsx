import React, { useCallback, useEffect, useState } from 'react';
import { gymInstant, parseClock } from '@/lib/staffRoster/time';
import { Banner, BUTTON, GHOST, INPUT, LABEL, Pill, Sheet, when } from './coachingUi';

const ABSENCE = { requested: ['Waiting for the manager', 'warning'], reported: ['Reported — manager told', 'info'], approved: ['Approved', 'success'], rejected: ['Declined', 'danger'], withdrawn: ['Withdrawn', 'neutral'] };
const COVER = { open: ['Looking for cover', 'warning'], offered: ['Someone offered — manager to approve', 'info'], approved: ['Covered', 'success'], rejected: ['Declined — you’re still on', 'danger'], withdrawn: ['Withdrawn', 'neutral'], cancelled: ['Cancelled', 'neutral'], superseded: ['Roster changed — no longer applies', 'neutral'] };
const OFFER = { offered: ['You offered — manager to approve', 'info'], approved: ['Approved — it’s yours', 'success'], declined: ['Not needed', 'neutral'], withdrawn: ['Withdrawn', 'neutral'] };
const PROBLEM_WORDS = { ABSENT: 'you have an absence then', CLASS_OVERLAP: 'you’re already coaching then', DUTY_BUFFER_OVERLAP: 'it overlaps another duty', ROLE_NOT_AUTHORISED: 'it needs a role you’re not set up for', CAPABILITY_MISSING: 'it needs a capability you don’t have', CAPABILITY_EXPIRED: 'a required capability has expired', LIMIT_DAILY_DUTY: 'it’s over your daily limit', LIMIT_WEEKLY_CLASSES: 'it’s over your weekly limit', LIMIT_REST: 'it leaves too little rest', SAME_SESSION_DUPLICATE: 'you’re already in this class', STAFF_INACTIVE: 'your account is inactive' };

function AbsenceSheet({ open, today, onClose, onSubmit, busy }) {
  const [kind, setKind] = useState('planned');
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState(today);
  const [fromTime, setFromTime] = useState('00:00');
  const [untilTime, setUntilTime] = useState('24:00');
  const [reason, setReason] = useState('');
  const start = parseClock(fromTime) === null ? null : gymInstant(from, parseClock(fromTime));
  const end = parseClock(untilTime) === null ? null : gymInstant(until || from, parseClock(untilTime));
  const valid = from && start !== null && end !== null && end > start;
  return (
    <Sheet open={open} title="Time away" onClose={onClose}
      footer={<><button type="button" className={BUTTON} disabled={busy || !valid} onClick={() => onSubmit({ kind, start, end, reason })}>{kind === 'urgent' ? 'Tell the manager now' : 'Ask for time off'}</button><button type="button" className={GHOST} onClick={onClose}>Cancel</button></>}>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Type">
        <button type="button" role="radio" aria-checked={kind === 'planned'} className={GHOST} onClick={() => setKind('planned')}>Planned time off</button>
        <button type="button" role="radio" aria-checked={kind === 'urgent'} className={GHOST} onClick={() => setKind('urgent')}>Can’t make it (urgent)</button>
      </div>
      <p className="font-body text-xs text-xert-pale/60">{kind === 'urgent' ? 'Use this when you can’t work at short notice. You’re taken off straight away for that time and the manager is told; it’s never blocked by a deadline.' : 'The manager approves time off. Until then, check your roster.'}</p>
      <div className="grid grid-cols-2 gap-3">
        <div><label htmlFor="away-from" className={LABEL}>From</label><input id="away-from" type="date" className={INPUT} value={from} min={today} onChange={event => { setFrom(event.target.value); if (until < event.target.value) setUntil(event.target.value); }} /></div>
        <div><label htmlFor="away-from-time" className={LABEL}>Time</label><input id="away-from-time" type="time" className={INPUT} value={fromTime} onChange={event => setFromTime(event.target.value)} /></div>
        <div><label htmlFor="away-until" className={LABEL}>Until</label><input id="away-until" type="date" className={INPUT} value={until} min={from} onChange={event => setUntil(event.target.value)} /></div>
        <div><label htmlFor="away-until-time" className={LABEL}>Time</label><input id="away-until-time" type="time" className={INPUT} value={untilTime === '24:00' ? '' : untilTime} placeholder="End of day" onChange={event => setUntilTime(event.target.value || '24:00')} /></div>
      </div>
      <div>
        <label htmlFor="away-note" className={LABEL}>Note for the manager (optional)</label>
        <input id="away-note" className={INPUT} value={reason} maxLength={300} onChange={event => setReason(event.target.value)} />
        <p className="font-body text-xs text-xert-pale/50 mt-1">Only managers see this. You don’t need to give a reason or any health details.</p>
      </div>
      {!valid && <p className="font-body text-xs text-status-danger-200">The end must be after the start.</p>}
    </Sheet>
  );
}

/** Time away, cover requests and offers, and the cover board. */
export default function CoachRequests({ client, today, notify, onChanged }) {
  const [mine, setMine] = useState(null);
  const [board, setBoard] = useState([]);
  const [error, setError] = useState(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [requests, cover] = await Promise.all([client.myRequests(), client.coverBoard()]);
      setMine(requests); setBoard(cover); setError(null);
    } catch (failure) { setError(failure); }
  }, [client]);
  useEffect(() => { load(); }, [load]);
  const act = async (action, message) => {
    setBusy(true);
    try { const result = await action(); notify(message(result)); await load(); onChanged?.(); return true; } catch (failure) { notify(failure.message, 'error'); return false; } finally { setBusy(false); }
  };

  if (error) return <Banner tone="danger" title="Couldn’t load requests" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>;
  if (!mine) return <p className="font-body text-sm text-xert-pale/60" role="status">Loading…</p>;

  return (
    <div className="space-y-6">
      <button type="button" className={`${BUTTON} w-full`} onClick={() => setSheet(true)}>I need time away</button>

      <section className="space-y-2" aria-labelledby="board-heading">
        <h2 id="board-heading" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">Classes needing cover</h2>
        {board.length === 0 && <p className="font-body text-sm text-xert-pale/60">Nothing right now.</p>}
        {board.map(item => (
          <article key={item.id} className="coaching-card space-y-2">
            <p className="font-body text-sm text-xert-offwhite">{item.title} · {when(item.start)}</p>
            <p className="font-body text-xs text-xert-pale/60">{item.requested_by} asked for cover</p>
            {item.my_offer ? <Pill tone={OFFER[item.my_offer]?.[1]}>{OFFER[item.my_offer]?.[0] || item.my_offer}</Pill>
              : item.problems.length ? <p className="font-body text-xs text-xert-pale/60">You can’t take this: {item.problems.map(code => PROBLEM_WORDS[code] || code.toLowerCase()).join(', ')}.</p>
                : <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.offerCover(item.id), () => 'Offer sent. The class is yours only once the manager approves.')}>I can cover this</button>}
            {item.my_offer === 'offered' && <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.withdraw('offer', item.id), () => 'Offer withdrawn.')}>Withdraw offer</button>}
          </article>
        ))}
      </section>

      <section className="space-y-2" aria-labelledby="mine-heading">
        <h2 id="mine-heading" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">Your requests</h2>
        {mine.absences.length + mine.cover_requests.length + mine.offers.length + mine.change_requests.length === 0 && <p className="font-body text-sm text-xert-pale/60">None.</p>}
        {mine.absences.map(item => (
          <article key={item.id} className="coaching-card flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0"><p className="font-body text-sm text-xert-offwhite">Away {when(item.starts_at)} – {when(item.ends_at)}</p>{item.reason && <p className="font-body text-xs text-xert-pale/55">Your note: {item.reason}</p>}</div>
            <div className="flex flex-wrap items-center gap-2"><Pill tone={ABSENCE[item.status]?.[1]}>{ABSENCE[item.status]?.[0]}</Pill>
              {item.status === 'requested' && <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.withdraw('absence', item.id), () => 'Request withdrawn.')}>Withdraw</button>}</div>
          </article>
        ))}
        {mine.cover_requests.map(item => (
          <article key={item.id} className="coaching-card flex flex-wrap items-center justify-between gap-2">
            <p className="font-body text-sm text-xert-offwhite min-w-0">Cover for {item.title} · {when(item.start)}{item.offers ? ` · ${item.offers} offer${item.offers === 1 ? '' : 's'}` : ''}</p>
            <Pill tone={COVER[item.status]?.[1]}>{COVER[item.status]?.[0]}</Pill>
          </article>
        ))}
        {mine.offers.filter(item => !board.some(entry => entry.id === item.request_id)).map(item => (
          <article key={item.request_id} className="coaching-card flex flex-wrap items-center justify-between gap-2">
            <p className="font-body text-sm text-xert-offwhite min-w-0">Your offer: {item.title} · {when(item.start)}</p>
            <Pill tone={OFFER[item.status]?.[1]}>{OFFER[item.status]?.[0]}</Pill>
          </article>
        ))}
        {mine.change_requests.map(item => (
          <article key={item.id} className="coaching-card flex flex-wrap items-center justify-between gap-2">
            <p className="font-body text-sm text-xert-offwhite min-w-0">Availability change: “{item.message}”</p>
            <Pill tone={item.status === 'open' ? 'warning' : 'neutral'}>{item.status === 'open' ? 'Sent to manager' : item.status}</Pill>
          </article>
        ))}
      </section>

      <AbsenceSheet key={String(sheet)} open={sheet} today={today} busy={busy} onClose={() => setSheet(false)}
        onSubmit={async ({ kind, start, end, reason }) => {
          if (await act(() => client.requestAbsence(new Date(start).toISOString(), new Date(end).toISOString(), kind, reason),
            result => (kind === 'urgent' ? `The manager has been told.${result?.affected_classes ? ` ${result.affected_classes} of your classes need cover.` : ''}` : 'Sent to the manager for approval.'))) setSheet(false);
        }} />
    </div>
  );
}
