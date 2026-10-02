import React, { useCallback, useEffect, useState } from 'react';
import { gymDateOf, toMs } from '@/lib/staffRoster/time';
import { at, Banner, BUTTON, dateName, GHOST, LABEL, INPUT, Pill, Sheet, when } from './coachingUi';

const STATUS = { requested: 'Request', attended: 'Attended', no_show: 'No-show' };

/** Headcount line, e.g. "5 of 8 booked · 1 request · 2 waiting". */
export function headcountLine(detail) {
  if (!detail) return '';
  const parts = [`${detail.booked}${detail.capacity ? ` of ${detail.capacity}` : ''} booked`];
  if (detail.pending) parts.push(`${detail.pending} ${detail.pending === 1 ? 'request' : 'requests'}`);
  if (detail.waitlist) parts.push(`${detail.waitlist} waiting`);
  return parts.join(' · ');
}

/** Who's booked and the session plan, for a class the coach is rostered on. */
export function ClassDetailBody({ detail, draft, setDraft, busy, onSave, showHistory, setShowHistory }) {
  return (
    <>
      <section aria-label="Bookings" className="space-y-2">
        <p className="font-body text-sm font-semibold text-xert-offwhite">{headcountLine(detail)}</p>
        {detail.people.length === 0 ? <p className="font-body text-sm text-xert-pale/60">Nobody booked yet.</p> : (
          <ul className="flex flex-wrap gap-2">
            {detail.people.map((person, index) => (
              <li key={`${person.name}-${index}`} className="coaching-pill" data-tone={person.status === 'requested' ? 'warning' : 'neutral'}>
                {person.name}{person.guest ? ' (guest)' : ''}{STATUS[person.status] ? ` · ${STATUS[person.status]}` : ''}
              </li>
            ))}
          </ul>
        )}
        <p className="font-body text-xs text-xert-pale/50">First names and initials only. Contact and health details stay with the manager.</p>
      </section>
      <section aria-label="Session plan" className="space-y-2">
        <label htmlFor="session-plan" className={LABEL}>Session plan and notes</label>
        <textarea id="session-plan" rows={6} maxLength={4000} className={`${INPUT} py-2`} value={draft} onChange={event => setDraft(event.target.value)}
          placeholder="Warm-up, main set, finisher, scaling notes…" />
        <p className="font-body text-xs text-xert-pale/50">
          {detail.note ? `Last saved by ${detail.note.by || 'a coach'}, ${when(detail.note.at)}. ` : ''}Seen by the coaches on this class and the managers, not members.
        </p>
        <button type="button" className={BUTTON} disabled={busy || draft === (detail.note?.body || '')} onClick={onSave}>Save plan</button>
        {detail.note_history.length > 0 && (
          <div>
            <button type="button" className={GHOST} aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}>{showHistory ? 'Hide' : 'Show'} earlier versions ({detail.note_history.length})</button>
            {showHistory && <ul className="mt-2 space-y-2">{detail.note_history.map(item => (
              <li key={item.id} className="coaching-card"><p className="font-body text-xs text-xert-pale/60">{item.by || 'A coach'}, {when(item.at)}</p><p className="font-body text-sm text-xert-pale/80 whitespace-pre-wrap">{item.body || '(cleared)'}</p></li>
            ))}</ul>}
          </div>
        )}
      </section>
    </>
  );
}

export default function CoachClassDetail({ client, item, onClose, notify }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const load = useCallback(async () => {
    try { const result = await client.classDetail(item.session_id); setDetail(result); setDraft(result.note?.body || ''); setError(null); } catch (failure) { setError(failure); }
  }, [client, item.session_id]);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    setBusy(true);
    try { const result = await client.saveSessionNote(item.session_id, draft, detail.note?.id ?? null); setDetail(result); setDraft(result.note?.body || ''); notify('Session plan saved.'); }
    catch (failure) {
      notify(failure.code === 'STALE_VERSION' ? 'Another coach changed the plan. Showing theirs — copy yours back in if needed.' : failure.message, 'error');
      if (failure.code === 'STALE_VERSION') {
        const mine = draft;
        await load();
        setDraft(mine);
      }
    } finally { setBusy(false); }
  };
  const title = `${item.title}, ${dateName(gymDateOf(toMs(item.start)))} ${at(item.start)}`;
  return (
    <Sheet open title="Class details" onClose={onClose} footer={null}>
      <p className="font-body text-sm text-xert-pale/80">{title}</p>
      {error && <Banner tone="danger" title="Couldn’t load this class" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>}
      {!error && !detail && <p className="font-body text-sm text-xert-pale/60" role="status">Loading…</p>}
      {detail && detail.session.status === 'cancelled' && <Pill tone="danger">Cancelled</Pill>}
      {detail && <ClassDetailBody detail={detail} draft={draft} setDraft={setDraft} busy={busy} onSave={save} showHistory={showHistory} setShowHistory={setShowHistory} />}
    </Sheet>
  );
}
