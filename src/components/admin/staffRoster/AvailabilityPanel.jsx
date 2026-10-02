import React, { useMemo, useState } from 'react';
import { AdminButton, AdminFormField, AdminStatCard, ADMIN_TEXT } from '@/components/admin/ui';
import { defaultPeriodDates, partMonthStartRange, planPartMonthOpening, planPeriodOpening } from '@/lib/staffRoster/cycle';
import { suggestedOpening } from '@/lib/staffRoster/monthSteps';
import { addDays, compareDateKeys, dateInMonth, gymDateOf } from '@/lib/staffRoster/time';
import { submissionProgress } from '@/lib/staffRoster/snapshot';
import { LIVE_SESSION_STATUSES } from '@/lib/staffRoster/validate';
import { dayLabel, monthLabel, SUBMISSION_LABELS, SUBMISSION_TONE, timeLabel } from './rosterFormat';
import { Notice, Tone } from './rosterBits';

function OpenPeriod({ month, today, cycle, busy, onOpen }) {
  const { plan, problem } = suggestedOpening(month, { today, cycle });
  const [dueOn, setDueOn] = useState(plan?.dueOn || '');
  const [publishTargetOn, setPublishTargetOn] = useState(plan?.publishTargetOn || '');
  const [editing, setEditing] = useState(false);
  if (problem) return <Notice tone="warning" title={`It’s too late to ask for ${monthLabel(month)} availability`}>{problem} You can still choose coaches for each class on the Roster tab.</Notice>;
  // The dates actually sent: the same rules the database enforces (opens ≤ due
  // ≤ publish target, due before the month starts), so a stale or empty
  // publish target can never be refused.
  let chosen = null;
  let dateProblem = null;
  if (dueOn) {
    try { chosen = planPeriodOpening(month, { today, cycle, dueOn, publishTargetOn: publishTargetOn || null }); } catch (error) { dateProblem = error.message; }
  }
  const changeDue = value => {
    setDueOn(value);
    if (value && publishTargetOn && publishTargetOn < value) setPublishTargetOn(value);
  };
  const opensToday = plan.opensOn <= today;
  return (
    <section className="staff-roster-row" aria-labelledby="roster-open-period">
      <div className="min-w-0 w-full space-y-3">
        <h3 id="roster-open-period" className={ADMIN_TEXT.sectionHeading}>Ask coaches for {monthLabel(month)} availability</h3>
        <p className="font-body text-sm text-xert-pale/75">
          Every coach who can sign in gets a notice {opensToday ? 'today' : `on ${dayLabel(plan.opensOn)}`} and taps the class times they can do on the website.
          They get a reminder before it’s due.
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="font-body text-xs uppercase tracking-wider text-xert-pale/60">Due by</dt><dd className="font-body text-lg font-semibold text-xert-offwhite">{dueOn ? dayLabel(dueOn) : 'Choose a date'}</dd>
            <dd className="font-body text-xs text-xert-pale/60">The last day coaches can answer without asking you.</dd></div>
          <div><dt className="font-body text-xs uppercase tracking-wider text-xert-pale/60">Aim to publish by</dt><dd className="font-body text-lg font-semibold text-xert-offwhite">{chosen ? dayLabel(chosen.publishTargetOn) : publishTargetOn ? dayLabel(publishTargetOn) : '—'}</dd>
            <dd className="font-body text-xs text-xert-pale/60">Your own reminder, so coaches know their classes early. Nothing happens automatically.</dd></div>
        </dl>
        {plan.shortened && <p className="font-body text-xs text-status-warning-200">Coaches get less notice than usual: the usual day to ask ({dayLabel(defaultPeriodDates(month, cycle).opensOn)}) has passed, so this starts today.</p>}
        {plan.suggestedDue && <p className="font-body text-xs text-xert-pale/60">The usual due date has passed, so we picked {dayLabel(plan.dueOn)}. Change it if you like.</p>}
        {(editing || !dueOn) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminFormField label="Due by" required>
              <input type="date" value={dueOn} min={plan.opensOn} onChange={event => changeDue(event.target.value)} />
            </AdminFormField>
            <AdminFormField label="Aim to publish by">
              <input type="date" value={publishTargetOn} min={dueOn || plan.opensOn} onChange={event => setPublishTargetOn(event.target.value)} />
            </AdminFormField>
          </div>
        )}
        {dateProblem && <Notice tone="warning" title="Check the dates">{dateProblem}</Notice>}
        <div className="flex flex-wrap gap-2">
          <AdminButton disabled={busy || !chosen} onClick={() => onOpen({ opensOn: chosen.opensOn, dueOn: chosen.dueOn, publishTargetOn: chosen.publishTargetOn, shortened: chosen.shortened })}>{opensToday ? 'Ask coaches now' : `Ask coaches (notice goes ${dayLabel(plan.opensOn)})`}</AdminButton>
          {!editing && dueOn && <AdminButton variant="ghost" onClick={() => setEditing(true)}>Change dates</AdminButton>}
        </div>
      </div>
    </section>
  );
}

/**
 * A month that has started: ask coaches about the classes from a later day
 * only. Earlier classes keep whoever coaches them now.
 */
function OpenPartMonth({ month, today, busy, onOpen }) {
  const range = partMonthStartRange(month, today);
  const [startsOn, setStartsOn] = useState(range?.suggested || '');
  // Empty means "use the usual date" (worked out from the start day).
  const [dueOn, setDueOn] = useState('');
  const [publishTargetOn, setPublishTargetOn] = useState('');
  const [editing, setEditing] = useState(false);
  if (!range) {
    return <Notice tone="warning" title={`It’s too late to ask for ${monthLabel(month)} availability`}>Today is the last day of the month, so there are no classes left to ask about. You can still choose coaches for each class on the Roster tab.</Notice>;
  }
  let chosen = null;
  let dateProblem = null;
  if (startsOn) {
    try { chosen = planPartMonthOpening(month, { today, startsOn, dueOn: dueOn || null, publishTargetOn: publishTargetOn || null }); } catch (error) { dateProblem = error.message; }
  }
  const changeStart = value => {
    setStartsOn(value);
    setDueOn('');
    setPublishTargetOn('');
  };
  const name = monthLabel(month).split(' ')[0];
  return (
    <section className="staff-roster-row" aria-labelledby="roster-open-part-month">
      <div className="min-w-0 w-full space-y-3">
        <h3 id="roster-open-part-month" className={ADMIN_TEXT.sectionHeading}>Ask coaches for the rest of {name}</h3>
        <p className="font-body text-sm text-xert-pale/75">
          {name} has already started. You can still roster coaches for the classes from a day you choose. Every coach who can sign in gets a notice today
          and taps the class times they can do. Classes before that day keep the coach they have now.
        </p>
        <AdminFormField label="Roster coaches from" helper="The first day of classes this roster covers." required>
          <input type="date" value={startsOn} min={range.min} max={range.max} onChange={event => changeStart(event.target.value)} />
        </AdminFormField>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="font-body text-xs uppercase tracking-wider text-xert-pale/60">Due by</dt><dd className="font-body text-lg font-semibold text-xert-offwhite">{chosen ? dayLabel(chosen.dueOn) : '—'}</dd>
            <dd className="font-body text-xs text-xert-pale/60">The last day coaches can answer without asking you.</dd></div>
          <div><dt className="font-body text-xs uppercase tracking-wider text-xert-pale/60">Aim to publish by</dt><dd className="font-body text-lg font-semibold text-xert-offwhite">{chosen ? dayLabel(chosen.publishTargetOn) : '—'}</dd>
            <dd className="font-body text-xs text-xert-pale/60">Your own reminder, so coaches know their classes before they start. Nothing happens automatically.</dd></div>
        </dl>
        <p className="font-body text-xs text-status-warning-200">Coaches get less notice than usual, so check the due date suits them.</p>
        {editing && startsOn && (
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminFormField label="Due by" required>
              <input type="date" value={dueOn || chosen?.dueOn || ''} min={today} max={addDays(startsOn, -1)} onChange={event => setDueOn(event.target.value)} />
            </AdminFormField>
            <AdminFormField label="Aim to publish by">
              <input type="date" value={publishTargetOn || chosen?.publishTargetOn || ''} min={dueOn || chosen?.dueOn || today} max={addDays(startsOn, -1)} onChange={event => setPublishTargetOn(event.target.value)} />
            </AdminFormField>
          </div>
        )}
        {dateProblem && <Notice tone="warning" title="Check the dates">{dateProblem}</Notice>}
        <div className="flex flex-wrap gap-2">
          <AdminButton disabled={busy || !chosen} onClick={() => onOpen({ startsOn: chosen.startsOn, dueOn: chosen.dueOn, publishTargetOn: chosen.publishTargetOn })}>
            {chosen ? `Ask coaches about classes from ${dayLabel(chosen.startsOn)}` : 'Ask coaches now'}
          </AdminButton>
          {!editing && chosen && <AdminButton variant="ghost" onClick={() => setEditing(true)}>Change dates</AdminButton>}
        </div>
      </div>
    </section>
  );
}

/** Availability progress for the month, and the coach-by-class answer grid. */
export default function AvailabilityPanel({ month, today, data, settings, focusStaffId, onMutate, onAddCoach = null }) {
  const { snapshot, draftCtx: ctx, busy } = data;
  const period = snapshot.period;
  const progress = useMemo(() => submissionProgress(snapshot, today), [snapshot, today]);
  const [reopenFor, setReopenFor] = useState(null);
  const [reminded, setReminded] = useState(null);
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
  const started = compareDateKeys(today, dateInMonth(month, 1)) >= 0;

  return (
    <div className="space-y-6">
      {!period && started ? (
        <OpenPartMonth month={month} today={today} busy={busy}
          onOpen={values => onMutate(client => client.openPartMonth(month, values), `Coaches asked about classes from ${dayLabel(values.startsOn)}. They get a notice and can answer on the website.`)} />
      ) : !period ? (
        <OpenPeriod month={month} today={today} cycle={settings?.cycle} busy={busy}
          onOpen={values => onMutate(client => client.openPeriod(month, values), 'Coaches asked. They get a notice and can answer on the website.')} />
      ) : (
        <section className="grid gap-3 sm:grid-cols-4" aria-label="Availability progress">
          {period.starts_on && (
            <p className="font-body text-sm text-xert-pale/75 sm:col-span-4">
              <strong className="text-xert-offwhite">Classes from {dayLabel(period.starts_on)}.</strong> Earlier classes this month keep the coach they have now.
            </p>
          )}
          <AdminStatCard label="Answered" value={`${progress.submitted} of ${progress.total}`} detail="Coaches who can sign in" />
          <AdminStatCard label="Still to answer" value={progress.missing} detail={progress.overdue ? `${progress.overdue} overdue` : 'None overdue'} />
          <AdminStatCard label="Due by" value={dayLabel(period.due_on)} detail={`Asked ${dayLabel(period.opens_on)}${period.shortened ? ' (less notice than usual)' : ''}`} />
          <AdminStatCard label="Aim to publish by" value={dayLabel(period.publish_target_on)} detail="Your reminder; nothing is automatic" />
        </section>
      )}

      {period && (
        <details className="staff-roster-row">
          <summary className="font-body text-sm text-xert-pale cursor-pointer min-h-11 flex items-center">Change the due date or send reminders</summary>
          <div className="flex flex-wrap items-end gap-3 mt-3 w-full">
            <AdminFormField label="New due-by date"><input type="date" value={dueOn} min={today} max={addDays(period.starts_on || period.month, -1)} onChange={event => setDueOn(event.target.value)} /></AdminFormField>
            <AdminButton variant="ghost" disabled={busy || !dueOn || dueOn === period.due_on}
              onClick={() => onMutate(client => client.updatePeriod(month, { dueOn, publishTargetOn: period.publish_target_on < dueOn ? dueOn : period.publish_target_on }, period.version), 'Due date changed')}>Save due date</AdminButton>
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-3 w-full">
            <AdminButton variant="ghost" disabled={busy} onClick={async () => {
              const count = await onMutate(client => client.runReminders(), null);
              if (count !== null) setReminded(Number(count) || 0);
            }}>Send today’s reminders now</AdminButton>
            <p className="font-body text-xs text-xert-pale/60" role="status">
              {reminded === null ? 'Reminders go out by themselves. This only sends ones already due today, to coaches who haven’t answered; pressing it twice sends nothing new.'
                : reminded === 0 ? 'Nothing was due. No reminders sent.' : `${reminded} reminder${reminded === 1 ? '' : 's'} added to coach inboxes.`}
            </p>
          </div>
        </details>
      )}

      {changeRequests.length > 0 && (
        <section aria-labelledby="roster-change-requests" className="space-y-2">
          <h3 id="roster-change-requests" className={ADMIN_TEXT.sectionHeading}>Asked to change after the due date ({changeRequests.length})</h3>
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
        <h3 id="roster-progress" className={ADMIN_TEXT.sectionHeading}>Who has answered</h3>
        {progress.rows.length === 0 && (
          <Notice tone="info" title="No coaches yet" action={onAddCoach ? <AdminButton onClick={onAddCoach}>Add your first coach</AdminButton> : null}>
            Add the people who run your classes and send them an invite link. Then they can tell you when they’re free.
          </Notice>
        )}
        <ul className="staff-roster-list">
          {progress.rows.map(row => {
            const counts = coverageByStaff.get(row.staffId) || {};
            const canTake = (counts.PREFERRED || 0) + (counts.AVAILABLE || 0);
            return (
              <li key={row.staffId} className="staff-roster-row" data-focused={focusStaffId === row.staffId} id={`roster-staff-${row.staffId}`}>
                <div className="min-w-0">
                  <p className="font-body text-sm font-semibold text-xert-offwhite">{row.name} {row.late && <Tone tone="warning">Late</Tone>}</p>
                  <p className="font-body text-xs text-xert-pale/60">
                    {row.state === 'submitted' || row.state === 'reopened' ? `Can take ${canTake} of ${sessions.length} classes${counts.IF_NEEDED ? `, ${counts.IF_NEEDED} more if needed` : ''}${counts.PARTIAL ? ` · ${counts.PARTIAL} only partly` : ''}` : null}
                    {row.state === 'submitted_none' && 'Answered: not available this month.'}
                    {row.state === 'no_account' && 'Can’t answer yet: send them an invite link from the Coaches tab.'}
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
          <AdminFormField label="Reason (kept in the Activity tab)"><input value={reason} onChange={event => setReason(event.target.value)} /></AdminFormField>
        </Notice>
      )}

      {sessions.length > 0 && progress.submitted > 0 && (
        <section aria-labelledby="roster-matrix" className="space-y-2">
          <h3 id="roster-matrix" className={ADMIN_TEXT.sectionHeading}>Who can take what</h3>
          <p className={ADMIN_TEXT.lede}>Each coach’s answer for each class, counting setup and pack-down time. Blank means they didn’t say, so they won’t be suggested for it.</p>
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

