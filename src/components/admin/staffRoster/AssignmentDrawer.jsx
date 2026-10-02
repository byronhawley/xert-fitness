import React, { useMemo, useState } from 'react';
import { AdminButton, AdminDrawer, ADMIN_TEXT } from '@/components/admin/ui';
import { candidatesFor } from '@/lib/staffRoster/coverage';
import { checkAssignment } from '@/lib/staffRoster/validate';
import { gymDateOf, weekStartOf } from '@/lib/staffRoster/time';
import { normalizeStaffing } from '@/lib/staffRoster/duty';
import { ROLE_LABELS, sessionLabel, staffName, timeLabel } from './rosterFormat';
import { AvailabilityBadge, ProblemList, Tone } from './rosterBits';
import StaffingEditor from './StaffingEditor';
import { SessionPlanPeek } from './CoachRecords';

function workload(ctx, staffId, session) {
  const date = gymDateOf(session.start);
  const week = weekStartOf(date);
  let month = 0;
  let thisWeek = 0;
  let today = 0;
  for (const item of ctx.byStaff.get(staffId) || []) {
    const other = ctx.sessions.get(item.sessionId);
    if (!other) continue;
    const otherDate = gymDateOf(other.start);
    if (otherDate.slice(0, 7) === date.slice(0, 7)) month++;
    if (weekStartOf(otherDate) === week) thisWeek++;
    if (otherDate === date) today++;
  }
  const target = ctx.staff.get(staffId)?.targets?.classesPerMonth;
  return `${month}${target ? ` of ${target}` : ''} this month · ${thisWeek} this week · ${today} today`;
}

function Candidate({ ctx, session, entry, onAssign = null, busy = false, actionLabel = null }) {
  return (
    <li className="staff-roster-row">
      <div className="min-w-0">
        <p className="font-body text-sm font-semibold text-xert-offwhite">{entry.name}</p>
        <p className="font-body text-xs text-xert-pale/55">{workload(ctx, entry.staffId, session)}</p>
        {entry.soft.length > 0 && <p className="font-body text-xs text-status-warning-200 mt-0.5">{entry.soft.map(item => item.message).join(' ')}</p>}
        <ProblemList problems={entry.hard} />
      </div>
      <div className="flex items-center gap-2">
        <AvailabilityBadge status={entry.status} />
        {onAssign && <AdminButton variant="ghost" disabled={busy} onClick={() => onAssign(entry.staffId)} aria-label={`${actionLabel} ${entry.name}`}>{actionLabel}</AdminButton>}
      </div>
    </li>
  );
}

/**
 * Everything about one staffing position: who holds it, who else could, and
 * why everyone else can't. Assigning re-checks on the server.
 */
export default function AssignmentDrawer({ open, onOpenChange, ctx, session, slotKey, readOnly, busy, onApply, onStartMove, staffingVersion, onSaveStaffing, client = null }) {
  const [showIneligible, setShowIneligible] = useState(false);
  const [editingStaffing, setEditingStaffing] = useState(false);
  const staffing = session ? normalizeStaffing(session.staffing) : null;
  const slot = staffing?.slots.find(item => item.key === slotKey) || null;
  const current = session && slot ? (ctx.bySession.get(session.id) || []).find(item => item.slotKey === slot.key) : null;
  const pool = useMemo(() => (session && slot ? candidatesFor(ctx, session.id, slot.key, { ignoreAssignmentIds: current ? [current.id] : [] }) : null),
    [ctx, session, slot, current]);
  if (!session) return null;
  const currentCheck = current ? checkAssignment(ctx, current, { ignoreAssignmentIds: [current.id] }) : null;
  const assign = staffId => onApply(current
    ? [{ op: 'unassign', assignment_id: current.id }, { op: 'assign', session_id: session.id, slot_key: slot.key, staff_id: staffId }]
    : [{ op: 'assign', session_id: session.id, slot_key: slot.key, staff_id: staffId }], current ? 'Coach replaced' : 'Coach assigned');

  return (
    <AdminDrawer open={open} onOpenChange={onOpenChange} title={session.title}
      description={`${sessionLabel(session)}–${timeLabel(session.end)}${slot ? ` · ${slot.required ? '' : 'optional '}${ROLE_LABELS[slot.role].toLowerCase()} position` : ''}`}
      closeLabel="Close position details">
      <div className="space-y-6">
        {readOnly && <p className="font-body text-sm text-xert-pale/70">{readOnly}</p>}
        <section aria-labelledby="roster-current">
          <h3 id="roster-current" className={ADMIN_TEXT.sectionHeading}>In this position</h3>
          {current ? (
            <div className="staff-roster-row mt-2">
              <div className="min-w-0">
                <p className="font-body text-sm font-semibold text-xert-offwhite">{staffName(ctx, current.staffId)} {current.pinned && <Tone tone="info">Pinned</Tone>}</p>
                {currentCheck?.ok ? <p className="font-body text-xs text-xert-pale/55">{workload(ctx, current.staffId, session)}</p> : <ProblemList problems={currentCheck?.hard} />}
                {currentCheck?.soft?.length > 0 && <p className="font-body text-xs text-status-warning-200">{currentCheck.soft.map(item => item.message).join(' ')}</p>}
              </div>
              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <AdminButton variant="ghost" disabled={busy} onClick={() => onApply([{ op: 'pin', assignment_id: current.id, pinned: !current.pinned }], current.pinned ? 'Unpinned' : 'Pinned')}>{current.pinned ? 'Unpin' : 'Pin'}</AdminButton>
                  <AdminButton variant="ghost" disabled={busy} onClick={() => onStartMove(current)}>Move…</AdminButton>
                  <AdminButton variant="danger" disabled={busy} onClick={() => onApply([{ op: 'unassign', assignment_id: current.id }], 'Coach removed')}>Remove</AdminButton>
                </div>
              )}
            </div>
          ) : <p className="font-body text-sm text-xert-pale/60 mt-2">Nobody yet{slot?.required ? ' — this position must be filled before the roster is complete.' : '. This position is optional.'}</p>}
        </section>

        {pool && !readOnly && (
          <>
            <section aria-labelledby="roster-eligible">
              <h3 id="roster-eligible" className={ADMIN_TEXT.sectionHeading}>Can take it ({pool.eligible.length})</h3>
              {pool.eligible.length ? <ul className="staff-roster-list mt-2">{pool.eligible.map(entry => <Candidate key={entry.staffId} ctx={ctx} session={session} entry={entry} onAssign={assign} busy={busy} actionLabel={current ? 'Swap in' : 'Assign'} />)}</ul>
                : <p className="font-body text-sm text-xert-pale/60 mt-2">Nobody who said they’re available is free for this time.</p>}
            </section>
            <section aria-labelledby="roster-if-needed">
              <h3 id="roster-if-needed" className={ADMIN_TEXT.sectionHeading}>Only if needed ({pool.ifNeeded.length})</h3>
              {pool.ifNeeded.length ? <ul className="staff-roster-list mt-2">{pool.ifNeeded.map(entry => <Candidate key={entry.staffId} ctx={ctx} session={session} entry={entry} onAssign={assign} busy={busy} actionLabel={current ? 'Swap in' : 'Assign'} />)}</ul>
                : <p className="font-body text-sm text-xert-pale/60 mt-2">Nobody marked this time as “if needed”.</p>}
            </section>
            <section aria-labelledby="roster-ineligible">
              <div className="flex items-center justify-between gap-2">
                <h3 id="roster-ineligible" className={ADMIN_TEXT.sectionHeading}>Can’t take it ({pool.ineligible.length})</h3>
                {pool.ineligible.length > 0 && <AdminButton variant="ghost" aria-expanded={showIneligible} onClick={() => setShowIneligible(value => !value)}>{showIneligible ? 'Hide reasons' : 'Show reasons'}</AdminButton>}
              </div>
              {showIneligible && <ul className="staff-roster-list mt-2">{pool.ineligible.map(entry => <Candidate key={entry.staffId} ctx={ctx} session={session} entry={entry} />)}</ul>}
            </section>
          </>
        )}

        <SessionPlanPeek client={client} sessionId={session.id} />

        {!readOnly && onSaveStaffing && (
          <section aria-labelledby="roster-staffing">
            <div className="flex items-center justify-between gap-2">
              <h3 id="roster-staffing" className={ADMIN_TEXT.sectionHeading}>Staffing for this class</h3>
              <AdminButton variant="ghost" aria-expanded={editingStaffing} onClick={() => setEditingStaffing(value => !value)}>{editingStaffing ? 'Close' : 'Change positions'}</AdminButton>
            </div>
            {!editingStaffing && <p className="font-body text-sm text-xert-pale/60 mt-2">{staffing.slots.map(item => `${item.required ? '' : 'optional '}${ROLE_LABELS[item.role].toLowerCase()}`).join(', ')}{staffing.prepMinutes || staffing.wrapMinutes ? ` · ${staffing.prepMinutes} min before, ${staffing.wrapMinutes} min after` : ''}</p>}
            {editingStaffing && <StaffingEditor staffing={staffing} busy={busy} allowReset resetLabel="Use the class type’s staffing"
              onSave={async value => { await onSaveStaffing('session', session.id, value, staffingVersion); setEditingStaffing(false); }} />}
          </section>
        )}
      </div>
    </AdminDrawer>
  );
}
