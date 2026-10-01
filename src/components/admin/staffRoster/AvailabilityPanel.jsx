import React, { useMemo, useState } from 'react';
import { AdminButton, AdminFormField, AdminStatCard, ADMIN_TEXT } from '@/components/admin/ui';
import { defaultPeriodDates, planPeriodOpening } from '@/lib/staffRoster/cycle';
import { gymDateOf } from '@/lib/staffRoster/time';
import { submissionProgress } from '@/lib/staffRoster/snapshot';
import { LIVE_SESSION_STATUSES } from '@/lib/staffRoster/validate';
import { dayLabel, monthLabel, SUBMISSION_LABELS, SUBMISSION_TONE, timeLabel } from './rosterFormat';
import { Notice, Tone } from './rosterBits';

function OpenPeriod({ month, today, cycle, busy, onOpen }) {
  let plan = null;
  let problem = null;
  try { plan = planPeriodOpening(month, { today, cycle }); } catch (error) { problem = error.message; }
  const [dueOn, setDueOn] = useState(plan?.dueOn || '');
  const [publishTargetOn, setPublishTargetOn] = useState(plan?.publishTargetOn || '');
  if (problem) return <Notice tone="warning" title="This month can’t be opened for availability">{problem}</Notice>;
  return (
    <section className="space-y-3" aria-labelledby="roster-open-period">
      <h3 id="roster-open-period" className={ADMIN_TEXT.sectionHeading}>Ask coaches for {monthLabel(month)} availability</h3>
      {plan.shortened && <Notice tone="warning" title="Shortened cycle">The usual opening date ({dayLabel(defaultPeriodDates(month, cycle).opensOn)}) has passed, so this opens today and coaches get less notice. Nothing is backdated.</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminFormField label="Opens"><input type="date" value={plan.opensOn} readOnly /></AdminFormField>
        <AdminFormField label="Due" required helper={plan.needsDueDate ? 'The usual due date has passed. Choose a new one.' : null}>
          <input type="date" value={dueOn} min={plan.opensOn} onChange={event => setDueOn(event.target.value)} />
        </AdminFormField>
        <AdminFormField label="Aim to publish by" helper="A reminder for you. Publishing is always your decision.">
          <input type="date" value={publishTargetOn} min={dueOn || plan.opensOn} onChange={event => setPublishTargetOn(event.target.value)} />
        </AdminFormField>
      </div>
      <AdminButton disabled={busy || !dueOn} onClick={() => onOpen({ opensOn: plan.opensOn, dueOn, publishTargetOn: publishTargetOn || dueOn, shortened: plan.shortened })}>Open availability</AdminButton>
    </section>
  );
}

/** Availability progress for the month, and the coach-by-class answer grid. */
export default function AvailabilityPanel({ month, today, data, settings, focusStaffId, onMutate }) {
  const { snapshot, draftCtx: ctx, busy } = data;
  const period = snapshot.period;
  const progress = useMemo(() => submissionProgress(snapshot, today), [snapshot, today]);
  const [reopenFor, setReopenFor] = useState(null);
  const [reason, setReason] = useState('');
  const [dueOn, setDueOn] = useState(period?.due_on || '');
  const sessions = useMemo(() => [...ctx.sessions.values()].filter(session => session.inMonth && LIVE_SESSION_STATUSES.includes(session.status)).sort((a, b) => a.start - b.start), [ctx]);
  const coverageByStaff = useMemo(() => {
    const result = new Map();
    for (const member of ctx.staff.values()) {
      const counts = { PREFERRED: 0, AVAILABLE: 0, IF_NEEDED: 0, UNAVAILABLE: 0, UNKNOWN: 0, PARTIAL: 0, ABSENT: 0 };
      for (const session of sessions) {
        const status = ctx.availability(member.id, session.id)?.status || 'UNKNOWN';
        counts[status] = (counts[status] || 0) + 1;
      }
      result.set(member.id, counts);
    }
    return result;
  }, [ctx, sessions]);
  const changeRequests = snapshot.change_requests || [];

  return (
    <div className="space-y-6">
      {!period ? (
        <OpenPeriod month={month} today={today} cycle={settings?.cycle} busy={busy}
          onOpen={values => onMutate(client => client.openPeriod(month, values), 'Availability opened. Coaches can now answer.')} />
      ) : (
        <section className="grid gap-3 sm:grid-cols-4" aria-label="Availability progress">
          <AdminStatCard label="Answered" value={`${progress.submitted} of ${progress.total}`} detail="Coaches with a sign-in" />
          <AdminStatCard label="Still to answer" value={progress.missing} detail={progress.overdue ? `${progress.overdue} overdue` : 'None overdue'} />
          <AdminStatCard label="Due" value={dayLabel(period.due_on)} detail={`Opened ${dayLabel(period.opens_on)}${period.shortened ? ' (shortened)' : ''}`} />
          <AdminStatCard label="Aim to publish" value={dayLabel(period.publish_target_on)} detail="Your target, not automatic" />
        </section>
      )}

      {period && (
        <details className="staff-roster-row">
          <summary className="font-body text-sm text-xert-pale cursor-pointer min-h-11 flex items-center">Change the due date</summary>
          <div className="flex flex-wrap items-end gap-3 mt-3 w-full">
            <AdminFormField label="New due date"><input type="date" value={dueOn} min={today} onChange={event => setDueOn(event.target.value)} /></AdminFormField>
            <AdminButton variant="ghost" disabled={busy || !dueOn || dueOn === period.due_on}
              onClick={() => onMutate(client => client.updatePeriod(month, { dueOn, publishTargetOn: period.publish_target_on < dueOn ? dueOn : period.publish_target_on }, period.version), 'Due date changed')}>Save due date</AdminButton>
          </div>
        </details>
      )}

      {changeRequests.length > 0 && (
        <section aria-labelledby="roster-change-requests" className="space-y-2">
          <h3 id="roster-change-requests" className={ADMIN_TEXT.sectionHeading}>Asked to change after the deadline ({changeRequests.length})</h3>
          {changeRequests.map(request => (
            <div key={request.id} className="staff-roster-row">
              <div className="min-w-0">
                <p className="font-body text-sm font-semibold text-xert-offwhite">{ctx.staff.get(request.staff_id)?.name}</p>
                <p className="font-body text-sm text-xert-pale/70">{request.message}</p>
              </div>
              <AdminButton variant="ghost" onClick={() => { setReopenFor(request.staff_id); setReason('Change requested by coach'); }}>Reopen for them</AdminButton>
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="roster-progress" className="space-y-2">
        <h3 id="roster-progress" className={ADMIN_TEXT.sectionHeading}>Coaches</h3>
        <ul className="staff-roster-list">
          {progress.rows.map(row => {
            const counts = coverageByStaff.get(row.staffId) || {};
            const canTake = (counts.PREFERRED || 0) + (counts.AVAILABLE || 0);
            return (
              <li key={row.staffId} className="staff-roster-row" data-focused={focusStaffId === row.staffId} id={`roster-staff-${row.staffId}`}>
                <div className="min-w-0">
                  <p className="font-body text-sm font-semibold text-xert-offwhite">{row.name} {row.late && <Tone tone="warning">Late</Tone>}</p>
                  <p className="font-body text-xs text-xert-pale/60">
                    {row.state === 'submitted' || row.state === 'reopened' ? `Version ${row.version} · can take ${canTake} of ${sessions.length} classes${counts.IF_NEEDED ? `, ${counts.IF_NEEDED} more if needed` : ''}${counts.PARTIAL ? ` · ${counts.PARTIAL} only partly` : ''}` : null}
                    {row.state === 'submitted_none' && 'Answered: not available this month.'}
                    {row.state === 'no_account' && 'Link a sign-in on the Coaches tab so they can answer.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Tone tone={SUBMISSION_TONE[row.state]}>{SUBMISSION_LABELS[row.state]}</Tone>
                  {period && today > period.due_on && row.state !== 'no_account' && row.state !== 'reopened' && (
                    <AdminButton variant="ghost" onClick={() => { setReopenFor(row.staffId); setReason(''); }}>Reopen</AdminButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {reopenFor && (
        <Notice tone="info" title={`Reopen availability for ${ctx.staff.get(reopenFor)?.name}`}
          action={<div className="flex gap-2">
            <AdminButton disabled={busy || reason.trim().length < 3} onClick={async () => { if (await onMutate(client => client.reopenSubmission(month, reopenFor, reason.trim()), 'Reopened. Their next submission is marked late.')) setReopenFor(null); }}>Reopen</AdminButton>
            <AdminButton variant="ghost" onClick={() => setReopenFor(null)}>Cancel</AdminButton>
          </div>}>
          <AdminFormField label="Reason (kept in the activity log)"><input value={reason} onChange={event => setReason(event.target.value)} /></AdminFormField>
        </Notice>
      )}

      {sessions.length > 0 && progress.submitted > 0 && (
        <section aria-labelledby="roster-matrix" className="space-y-2">
          <h3 id="roster-matrix" className={ADMIN_TEXT.sectionHeading}>Who can take what</h3>
          <p className={ADMIN_TEXT.lede}>Answers for each class’s full duty time, including setup and pack-down. Blank means not stated, which is never treated as available.</p>
          <div className="staff-roster-matrix">
            <table>
              <thead><tr><th scope="col">Class</th>{[...ctx.staff.values()].filter(member => member.status === 'active').map(member => <th key={member.id} scope="col">{member.name}</th>)}</tr></thead>
              <tbody>
                {sessions.slice(0, 120).map(session => (
                  <tr key={session.id}>
                    <th scope="row">{session.title} <span className="text-xert-pale/50">{dayLabel(gymDateOf(session.start))} {timeLabel(session.start)}</span></th>
                    {[...ctx.staff.values()].filter(member => member.status === 'active').map(member => {
                      const status = ctx.availability(member.id, session.id)?.status || 'UNKNOWN';
                      return <td key={member.id} data-status={status}>{status === 'UNKNOWN' ? '' : ({ PREFERRED: 'Preferred', AVAILABLE: 'Yes', IF_NEEDED: 'If needed', UNAVAILABLE: 'No', PARTIAL: 'Part', ABSENT: 'Away' })[status] || status}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sessions.length > 120 && <p className="font-body text-xs text-xert-pale/50">Showing the first 120 classes. Use the roster’s day view for the rest.</p>}
        </section>
      )}
    </div>
  );
}

