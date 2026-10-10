import React, { useCallback, useEffect, useState } from 'react';
import { addDays, gymDateOf, toMs } from '@/lib/staffRoster/time';
import { at, Banner, BUTTON, dateName, GHOST, INPUT, LABEL, monthName, Pill, Sheet } from './coachingUi';
import CoachClassDetail from './CoachClassDetail';

const ROLE = { lead: 'Lead', assistant: 'Assistant', shadow: 'Shadow' };

/** The coach's published classes. Drafts are never shown here. */
export default function CoachRoster({ client, today, onChanged, notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [coverFor, setCoverFor] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailFor, setDetailFor] = useState(null);

  const load = useCallback(async () => {
    try { setData(await client.myRoster(today, addDays(today, 62))); setError(null); } catch (failure) { setError(failure); }
  }, [client, today]);
  useEffect(() => { load(); }, [load]);

  const act = async (action, message) => {
    setBusy(true);
    try { await action(); notify(message); await load(); onChanged?.(); return true; } catch (failure) { notify(failure.message, 'error'); return false; } finally { setBusy(false); }
  };

  if (error) return <Banner tone="danger" title="Couldn’t load your roster" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>;
  if (!data) return <p className="font-body text-sm text-xert-pale/60" role="status">Loading your classes…</p>;
  const groups = new Map();
  for (const item of data.assignments) {
    const date = gymDateOf(toMs(item.start));
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }

  return (
    <div className="space-y-5">
      {data.pending_acknowledgements.map(ack => (
        <Banner key={ack.revision_id} tone="warning" title={`Your ${monthName(ack.month)} roster changed`}
          action={<button type="button" className={BUTTON} disabled={busy} onClick={() => act(() => client.acknowledge(ack.revision_id), 'Thanks — marked as seen.')}>I’ve seen it</button>}>
          The manager published changes. Check your classes below, then tap I’ve seen it.
        </Banner>
      ))}
      {data.assignments.length === 0 && <div className="coaching-card"><p className="font-body text-sm text-xert-pale/70">No published classes for you in the next two months. Once the manager publishes a roster, your classes show here.</p></div>}
      {[...groups.entries()].map(([date, items]) => (
        <section key={date} aria-label={dateName(date)} className="space-y-2">
          <h2 className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">{date === today ? 'Today' : dateName(date)}</h2>
          {items.map(item => {
            const cancelled = item.status === 'cancelled' || item.status === 'removed';
            return (
              <article key={item.assignment_id} className="coaching-card space-y-2" data-changed={item.changed_since_publish && !cancelled} data-cancelled={cancelled}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-xl text-xert-offwhite">{at(item.start)} <span className="text-xert-pale/50 text-base">– {at(item.end)}</span></p>
                    <p className="font-body text-sm text-xert-offwhite">{item.title}</p>
                    <p className="font-body text-xs text-xert-pale/60">{ROLE[item.role] || item.role}{item.duty_start && toMs(item.duty_start) < toMs(item.start) ? ` · arrive by ${at(item.duty_start)}` : ''}{item.colleagues.length ? ` · with ${item.colleagues.map(colleague => colleague.display_name).join(', ')}` : ''}</p>
                  </div>
                  {cancelled ? <Pill tone="danger">Cancelled</Pill> : item.cover ? <Pill tone="warning">{item.cover.status === 'offered' ? 'Cover offered, awaiting manager' : 'Cover requested'}</Pill> : null}
                </div>
                {item.changed_since_publish && !cancelled && (
                  <Banner tone="warning" title="This class moved after the roster was published">
                    It was {at(item.published_start)}–{at(item.published_end)} on {dateName(gymDateOf(toMs(item.published_start)))}. {item.availability && !['PREFERRED', 'AVAILABLE', 'IF_NEEDED'].includes(item.availability) ? 'Your availability doesn’t cover the new time yet.' : ''}
                  </Banner>
                )}
                {!cancelled && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={GHOST} onClick={() => setDetailFor(item)} aria-label={`Who’s booked and session plan: ${item.title}, ${dateName(date)} ${at(item.start)}`}>Who’s booked &amp; plan</button>
                    {toMs(item.start) > Date.now() && <>
                    {item.changed_since_publish && <>
                      <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.confirmSession(item.session_id, 'AVAILABLE'), 'Thanks — you’re confirmed for the new time.')}>I can do the new time</button>
                      <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.confirmSession(item.session_id, 'UNAVAILABLE'), 'Noted. The manager will find cover.')}>I can’t</button>
                    </>}
                    {!item.cover && <button type="button" className={GHOST} disabled={busy} onClick={() => { setCoverFor(item); setReason(''); }}>Ask for cover</button>}
                    {item.cover && <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.withdraw('cover', item.cover.id), 'Cover request withdrawn. You’re still on this class.')}>Withdraw cover request</button>}
                    </>}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      ))}

      {detailFor && <CoachClassDetail client={client} item={detailFor} notify={notify} onClose={() => setDetailFor(null)} />}
      <Sheet open={Boolean(coverFor)} title="Ask for cover" onClose={() => setCoverFor(null)}
        footer={<>
          <button type="button" className={BUTTON} disabled={busy} onClick={async () => { if (await act(() => client.requestCover(coverFor.assignment_id, reason), 'Cover requested. Other coaches can offer; the manager approves.')) setCoverFor(null); }}>Ask for cover</button>
          <button type="button" className={GHOST} onClick={() => setCoverFor(null)}>Cancel</button>
        </>}>
        {coverFor && <p className="font-body text-sm text-xert-pale/80">{coverFor.title}, {dateName(gymDateOf(toMs(coverFor.start)))} at {at(coverFor.start)}. You stay on this class until the manager approves someone else.</p>}
        <div>
          <label htmlFor="cover-reason" className={LABEL}>Note for the manager (optional)</label>
          <input id="cover-reason" className={INPUT} value={reason} onChange={event => setReason(event.target.value)} maxLength={300} />
          <p className="font-body text-xs text-xert-pale/50 mt-1">Only managers see this. You don’t need to give a reason or any health details.</p>
        </div>
      </Sheet>
    </div>
  );
}
