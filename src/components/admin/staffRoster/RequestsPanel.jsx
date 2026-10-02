import React, { useState } from 'react';
import { AdminButton, AdminFormField, ADMIN_TEXT } from '@/components/admin/ui';
import { gymDateOf, gymInstant, parseClock, toMs } from '@/lib/staffRoster/time';
import { dayLabel, sessionLabel, staffName, timeLabel } from './rosterFormat';
import { Notice, Tone } from './rosterBits';

const ABSENCE_LABELS = { requested: 'Asked for time off', reported: 'Urgent — reported', approved: 'Approved', rejected: 'Declined', withdrawn: 'Withdrawn' };
const ABSENCE_TONE = { requested: 'warning', reported: 'danger', approved: 'success', rejected: 'neutral', withdrawn: 'neutral' };
const COVER_LABELS = { open: 'Looking for cover', offered: 'Volunteer found — needs your approval', approved: 'Approved', rejected: 'Declined', withdrawn: 'Withdrawn', cancelled: 'Cancelled', superseded: 'Replaced by a newer roster' };

function range(startsAt, endsAt) {
  const start = toMs(startsAt);
  const end = toMs(endsAt);
  const sameDay = gymDateOf(start) === gymDateOf(end - 1);
  return sameDay ? `${dayLabel(gymDateOf(start))}, ${timeLabel(start)}–${timeLabel(end)}` : `${dayLabel(gymDateOf(start))} ${timeLabel(start)} to ${dayLabel(gymDateOf(end))} ${timeLabel(end)}`;
}

function affected(ctx, staffId, startsAt, endsAt) {
  const start = toMs(startsAt);
  const end = toMs(endsAt);
  return (ctx.byStaff.get(staffId) || []).map(item => ctx.sessions.get(item.sessionId)).filter(session => session && session.start < end && start < session.end);
}

function RecordAbsence({ ctx, busy, onMutate, onDone }) {
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [from, setFrom] = useState('00:00');
  const [to, setTo] = useState('24:00');
  const [reason, setReason] = useState('');
  const start = date && parseClock(from) !== null ? gymInstant(date, parseClock(from)) : null;
  const end = (endDate || date) && parseClock(to) !== null ? gymInstant(endDate || date, parseClock(to)) : null;
  const valid = staffId && start !== null && end !== null && end > start;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminFormField label="Coach" required>
          <select value={staffId} onChange={event => setStaffId(event.target.value)}>
            <option value="">Choose…</option>
            {[...ctx.staff.values()].sort((a, b) => a.name.localeCompare(b.name)).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </AdminFormField>
        <AdminFormField label="From date" required><input type="date" value={date} onChange={event => setDate(event.target.value)} /></AdminFormField>
        <AdminFormField label="To date" helper="Leave blank for one day"><input type="date" value={endDate} min={date} onChange={event => setEndDate(event.target.value)} /></AdminFormField>
        <AdminFormField label="From time"><input value={from} onChange={event => setFrom(event.target.value)} placeholder="00:00" /></AdminFormField>
        <AdminFormField label="To time"><input value={to} onChange={event => setTo(event.target.value)} placeholder="24:00" /></AdminFormField>
        <AdminFormField label="Note (only managers see it)" helper="Don’t record medical details."><input value={reason} onChange={event => setReason(event.target.value)} /></AdminFormField>
      </div>
      <AdminButton disabled={busy || !valid} onClick={async () => {
        if (await onMutate(client => client.recordAbsence(staffId, new Date(start).toISOString(), new Date(end).toISOString(), reason), 'Absence recorded. Their classes in that time now need cover.')) onDone();
      }}>Record absence</AdminButton>
    </div>
  );
}

/** Absences and cover, kept separate: a volunteer accepting is not a manager approving. */
export default function RequestsPanel({ data, focus, onMutate, onShowSession }) {
  const { snapshot, publishedCtx: ctx, busy } = data;
  const [recording, setRecording] = useState(false);
  const absences = [...(snapshot.absences || [])].sort((a, b) => (Number(['reported', 'requested'].includes(b.status)) - Number(['reported', 'requested'].includes(a.status))) || toMs(a.starts_at) - toMs(b.starts_at));
  const covers = [...(snapshot.cover_requests || [])].sort((a, b) => (Number(['open', 'offered'].includes(b.status)) - Number(['open', 'offered'].includes(a.status))) || toMs(a.created_at) - toMs(b.created_at));

  const waiting = absences.filter(item => ['requested', 'reported'].includes(item.status)).length
    + covers.filter(item => item.status === 'offered' && item.current).length;

  return (
    <div className="space-y-8">
      <Notice tone={waiting ? 'warning' : 'success'} title={waiting ? `${waiting} ${waiting === 1 ? 'request needs' : 'requests need'} your decision` : 'Nothing waiting for you'}>
        Coaches ask for time off and for cover here. Requests waiting for you are listed first. If a coach tells you in person, use “Record an absence”.
      </Notice>
      <section aria-labelledby="roster-absences" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="roster-absences" className={ADMIN_TEXT.sectionHeading}>Time off</h3>
          <AdminButton variant="ghost" onClick={() => setRecording(value => !value)} aria-expanded={recording}>{recording ? 'Cancel' : 'Record an absence'}</AdminButton>
        </div>
        {recording && <RecordAbsence ctx={ctx} busy={busy} onMutate={onMutate} onDone={() => setRecording(false)} />}
        {absences.length === 0 && <p className="font-body text-sm text-xert-pale/60">No time off asked for this month.</p>}
        <ul className="staff-roster-list">
          {absences.map(absence => {
            const hit = affected(ctx, absence.staff_id, absence.starts_at, absence.ends_at);
            return (
              <li key={absence.id} className="staff-roster-row" data-focused={focus === absence.id}>
                <div className="min-w-0">
                  <p className="font-body text-sm font-semibold text-xert-offwhite">{staffName(ctx, absence.staff_id)} <Tone tone={ABSENCE_TONE[absence.status]}>{ABSENCE_LABELS[absence.status]}</Tone></p>
                  <p className="font-body text-sm text-xert-pale/70">{range(absence.starts_at, absence.ends_at)}</p>
                  {absence.reason && <p className="font-body text-xs text-xert-pale/55">Note: {absence.reason}</p>}
                  {hit.length > 0 && ['requested', 'reported', 'approved'].includes(absence.status) && (
                    <p className="font-body text-xs text-status-warning-200">
                      Rostered on {hit.length} {hit.length === 1 ? 'class' : 'classes'} in this time:{' '}
                      {hit.map((session, index) => <React.Fragment key={session.id}>{index ? ', ' : ''}<button type="button" className="underline" onClick={() => onShowSession(session)}>{sessionLabel(session)}</button></React.Fragment>)}
                    </p>
                  )}
                  {absence.status === 'reported' && <p className="font-body text-xs text-xert-pale/55">Urgent absences block assignment straight away. Approving just records that you’ve seen it.</p>}
                </div>
                {['requested', 'reported'].includes(absence.status) && (
                  <div className="flex flex-wrap gap-2">
                    <AdminButton disabled={busy} onClick={() => onMutate(client => client.decideAbsence(absence.id, 'approved', absence.version), 'Absence approved')}>{absence.status === 'reported' ? 'Acknowledge' : 'Approve'}</AdminButton>
                    {absence.status === 'requested' && <AdminButton variant="ghost" disabled={busy} onClick={() => onMutate(client => client.decideAbsence(absence.id, 'rejected', absence.version), 'Absence declined')}>Decline</AdminButton>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="roster-cover" className="space-y-3">
        <h3 id="roster-cover" className={ADMIN_TEXT.sectionHeading}>Cover requests</h3>
        <Notice tone="info">A coach offering to cover doesn’t change the roster. It changes only when you approve one volunteer, and the rules are checked again at that moment.</Notice>
        {covers.length === 0 && <p className="font-body text-sm text-xert-pale/60">No cover requests this month.</p>}
        <ul className="staff-roster-list">
          {covers.map(cover => {
            const session = ctx.sessions.get(cover.session_id);
            const offers = (cover.offers || []).filter(offer => offer.status === 'offered');
            const active = ['open', 'offered'].includes(cover.status);
            return (
              <li key={cover.id} className="staff-roster-row" data-focused={focus === cover.id}>
                <div className="min-w-0">
                  <p className="font-body text-sm font-semibold text-xert-offwhite">{session ? sessionLabel(session) : 'A class'} <Tone tone={cover.status === 'offered' ? 'warning' : active ? 'info' : 'neutral'}>{COVER_LABELS[cover.status]}</Tone></p>
                  <p className="font-body text-xs text-xert-pale/60">Asked by {staffName(ctx, cover.requester_staff_id)}{cover.reason ? ` · Note: ${cover.reason}` : ''}</p>
                  {active && !cover.current && <p className="font-body text-xs text-status-warning-200">The roster was republished after this was asked. It can’t be approved; decline it and ask again if needed.</p>}
                  {offers.length > 0 && (
                    <ul className="mt-2 space-y-2">
                      {offers.map(offer => (
                        <li key={offer.id} className="flex flex-wrap items-center gap-2">
                          <span className="font-body text-sm">{staffName(ctx, offer.staff_id)} offered</span>
                          {active && cover.current && <AdminButton disabled={busy} onClick={() => onMutate(client => client.approveCover(cover.id, offer.id, cover.version), `${staffName(ctx, offer.staff_id)} approved. A new roster version is published for this change.`)}>Approve {staffName(ctx, offer.staff_id)}</AdminButton>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {active && <AdminButton variant="ghost" disabled={busy} onClick={() => onMutate(client => client.rejectCover(cover.id, cover.version), 'Cover request declined. The original coach stays rostered.')}>Decline</AdminButton>}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
