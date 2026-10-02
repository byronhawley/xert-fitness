import React, { useMemo, useState } from 'react';
import { AdminButton, AdminDrawer, AdminFormField, ADMIN_TEXT } from '@/components/admin/ui';
import { checkAssignment, LIVE_SESSION_STATUSES } from '@/lib/staffRoster/validate';
import { normalizeStaffing } from '@/lib/staffRoster/duty';
import { publishImpact } from '@/lib/staffRoster/snapshot';
import { toMs } from '@/lib/staffRoster/time';
import { monthLabel, sessionLabel, staffName } from './rosterFormat';
import { Notice, ProblemList } from './rosterBits';
import RosterTexts from './RosterTexts';

/** What publishing would do, computed from the draft; the server decides. */
export function publishPreview(snapshot, ctx) {
  const blocked = [];
  const gaps = [];
  for (const session of ctx.sessions.values()) {
    if (!session.inMonth || session.start <= ctx.now || !LIVE_SESSION_STATUSES.includes(session.status)) continue;
    const filled = ctx.bySession.get(session.id) || [];
    for (const slot of normalizeStaffing(session.staffing).slots) {
      const assignment = filled.find(item => item.slotKey === slot.key);
      if (!assignment) { if (slot.required) gaps.push({ session, slot }); continue; }
      const result = checkAssignment(ctx, assignment, { ignoreAssignmentIds: [assignment.id] });
      if (!result.ok) blocked.push({ session, assignment, problems: result.hard });
    }
  }
  return { blocked, gaps, impact: publishImpact(snapshot) };
}

/**
 * Open required spots to show: the server's count once it has refused for
 * gaps (it returns a number), otherwise the screen's own preview.
 */
export function gapCount(serverResult, preview) {
  if (serverResult?.reason === 'GAPS_NEED_ACKNOWLEDGEMENT') {
    const gaps = serverResult.gaps;
    if (Array.isArray(gaps)) return gaps.length;
    const count = Number(gaps);
    return Number.isFinite(count) && count >= 0 ? count : preview.gaps.length;
  }
  return preview.gaps.length;
}

/** After a publish: what coaches were told, and what happened to the texts. */
export function PublishedView({ result, month, client }) {
  const affected = result.affected_staff?.length || 0;
  return (
    <div className="space-y-4">
      <Notice tone="success" title={`Version ${result.number} of ${monthLabel(month)} is published`}>
        {affected ? `${affected} ${affected === 1 ? 'coach has' : 'coaches have'} a notice in their app inbox.` : 'No coach’s classes changed, so nobody was notified.'}
      </Notice>
      {client && <RosterTexts client={client} month={month} autoSend />}
    </div>
  );
}

export default function PublishDialog({ open, onOpenChange, month, snapshot, ctx, busy, onPublish, client = null }) {
  const [published, setPublished] = useState(null);
  const preview = useMemo(() => (open && !published ? publishPreview(snapshot, ctx) : null), [open, published, snapshot, ctx]);
  const [reason, setReason] = useState('');
  const [serverResult, setServerResult] = useState(null);
  if (published) {
    return (
      <AdminDrawer open={open} onOpenChange={onOpenChange} title={`Publish ${monthLabel(month)}`} closeLabel="Close publish"
        description="Coaches can see their classes now."
        footer={<AdminButton onClick={() => onOpenChange(false)}>Done</AdminButton>}>
        <PublishedView result={published} month={month} client={client} />
      </AdminDrawer>
    );
  }
  if (!preview) return null;
  const gaps = gapCount(serverResult, preview);
  const blocked = preview.blocked.length > 0 || serverResult?.reason === 'HARD_CONFLICTS';
  const ready = !blocked && (gaps === 0 || reason.trim().length >= 3);
  const first = !snapshot.published;
  const describe = row => sessionLabel({ title: row.session_title, start: toMs(row.session_start) });

  const submit = async () => {
    const result = await onPublish(reason.trim() || null);
    if (result && result.ok === false) setServerResult(result);
    else if (result?.ok) setPublished(result);
  };

  return (
    <AdminDrawer open={open} onOpenChange={onOpenChange} title={`Publish ${monthLabel(month)}`}
      description={first ? 'Coaches will see their classes and get a notice in their coach inbox.' : 'Replaces the roster coaches can see now. Only coaches whose classes change get a notice.'}
      closeLabel="Close publish"
      footer={<>
        <AdminButton disabled={busy || !ready} onClick={submit}>{gaps ? `Publish with ${gaps} empty ${gaps === 1 ? 'spot' : 'spots'}` : 'Publish roster'}</AdminButton>
        <AdminButton variant="ghost" onClick={() => onOpenChange(false)}>Not yet</AdminButton>
      </>}>
      <div className="space-y-5">
        {blocked && (
          <Notice tone="danger" title="Fix these before publishing">
            Each of these coaches can’t take that class any more — usually because of time off or changed availability since you chose them. Pick someone else first.
          </Notice>
        )}
        {preview.blocked.length > 0 && (
          <ul className="staff-roster-list">
            {preview.blocked.map(item => (
              <li key={item.assignment.id} className="staff-roster-row">
                <div className="min-w-0">
                  <p className="font-body text-sm text-xert-offwhite">{staffName(ctx, item.assignment.staffId)} · {sessionLabel(item.session)}</p>
                  <ProblemList problems={item.problems} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {serverResult?.reason === 'HARD_CONFLICTS' && preview.blocked.length === 0 && <p className="font-body text-sm text-status-danger-200">The server found conflicts the screen had not seen yet. Close this and refresh.</p>}

        <section>
          <h3 className={ADMIN_TEXT.sectionHeading}>Classes still without a coach</h3>
          {gaps === 0 ? <p className="font-body text-sm text-xert-pale/70 mt-1">Every class has its coaches.</p> : (
            <>
              <p className="font-body text-sm text-status-warning-200 mt-1">{gaps} required {gaps === 1 ? 'spot is' : 'spots are'} still open. You can publish anyway and fill them later.</p>
              <ul className="mt-2 space-y-1">
                {preview.gaps.slice(0, 12).map(item => <li key={`${item.session.id}:${item.slot.key}`} className="font-body text-xs text-xert-pale/65">{sessionLabel(item.session)}</li>)}
                {preview.gaps.length > 12 && <li className="font-body text-xs text-xert-pale/50">and {preview.gaps.length - 12} more</li>}
              </ul>
              <div className="mt-3">
                <AdminFormField label="Why publish with empty spots?" helper="A short note, e.g. “Hiring a weekend coach”. Kept with this roster so you remember why." required>
                  <textarea rows={2} value={reason} onChange={event => setReason(event.target.value)} />
                </AdminFormField>
              </div>
            </>
          )}
        </section>

        <section>
          <h3 className={ADMIN_TEXT.sectionHeading}>Coaches who’ll get a notice ({preview.impact.length})</h3>
          {preview.impact.length === 0 ? <p className="font-body text-sm text-xert-pale/60 mt-1">No coach’s classes change.</p> : (
            <ul className="staff-roster-list mt-2">
              {preview.impact.map(row => (
                <li key={row.staffId} className="staff-roster-row">
                  <div className="min-w-0">
                    <p className="font-body text-sm font-semibold text-xert-offwhite">{staffName(ctx, row.staffId)}</p>
                    {row.added.map(item => <p key={`a-${item.id}`} className="font-body text-xs staff-roster-diff-added">+ {describe(item)}</p>)}
                    {row.removed.map(item => <p key={`r-${item.id}`} className="font-body text-xs staff-roster-diff-removed">{describe(item)}</p>)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="font-body text-xs text-xert-pale/50 mt-2">Notices go to each coach’s inbox on the website (and phone, if they allowed notifications). Email copies go only if switched on in Settings.{snapshot.settings?.sms_enabled && snapshot.settings?.enabled ? ' They also get a text listing their classes (each coach can turn texts off).' : ''}</p>
        </section>
      </div>
    </AdminDrawer>
  );
}
