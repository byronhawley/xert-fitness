import React, { useEffect, useMemo, useState } from 'react';
import { AdminButton, AdminDrawer, AdminSegmented, ADMIN_TEXT } from '@/components/admin/ui';
import { suggestDraft } from '@/lib/staffRoster/suggest';
import { sessionLabel, staffName } from './rosterFormat';
import { Notice } from './rosterBits';

/**
 * Suggest Draft: a preview the manager accepts or discards. Nothing is saved
 * until "Add to draft", and the database re-checks every line then.
 */
export default function SuggestDialog({ open, onOpenChange, ctx, sessionIds, scopeLabel, allowIfNeeded, busy, onApply }) {
  const [mode, setMode] = useState('keep');
  const [result, setResult] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (!open || !ctx) return undefined;
    // Let the drawer paint "Working…" before the search takes the main thread.
    setWorking(true);
    const timer = setTimeout(() => {
      const started = performance.now();
      setResult(suggestDraft(ctx, { sessionIds, mode, allowIfNeeded }));
      setElapsed(Math.round(performance.now() - started));
      setWorking(false);
    }, 30);
    return () => clearTimeout(timer);
  }, [open, ctx, sessionIds, mode, allowIfNeeded]);

  const removals = useMemo(() => {
    if (!result || !ctx) return [];
    const keep = new Set([...result.kept, ...result.pinned].map(item => `${item.sessionId}:${item.slotKey}:${item.staffId}`));
    const inScope = new Set(sessionIds);
    return ctx.assignments.filter(item => inScope.has(item.sessionId) && !item.locked && !item.pinned
      && ctx.sessions.get(item.sessionId)?.start > ctx.now && !keep.has(`${item.sessionId}:${item.slotKey}:${item.staffId}`));
  }, [result, ctx, sessionIds]);

  if (!open) return null;
  if (!result || working) {
    return (
      <AdminDrawer open={open} onOpenChange={onOpenChange} title="Suggested draft" description={`For ${scopeLabel}.`} closeLabel="Close suggested draft">
        <p className="font-body text-sm text-xert-pale/70" role="status">Working out a draft…</p>
      </AdminDrawer>
    );
  }
  const changes = [
    ...removals.map(item => ({ op: 'unassign', assignment_id: item.id })),
    ...result.added.map(item => ({ op: 'assign', session_id: item.sessionId, slot_key: item.slotKey, staff_id: item.staffId, source: 'suggested' })),
  ];
  const session = id => ctx.sessions.get(id);

  return (
    <AdminDrawer open={open} onOpenChange={onOpenChange} title="Suggested draft" description={`For ${scopeLabel}. Review it first — nothing changes until you add it to the draft.`}
      closeLabel="Close suggested draft"
      footer={<>
        <AdminButton disabled={busy || changes.length === 0} onClick={() => onApply(changes)}>{changes.length ? `Add ${result.added.length} to draft${removals.length ? `, remove ${removals.length}` : ''}` : 'Nothing to change'}</AdminButton>
        <AdminButton variant="ghost" onClick={() => onOpenChange(false)}>Discard suggestion</AdminButton>
      </>}>
      <div className="space-y-5">
        <AdminSegmented label="Starting point" value={mode} onValueChange={setMode} options={[
          { value: 'keep', label: 'Keep my draft, fill gaps' },
          { value: 'fresh', label: 'Start over (keep pins)' },
        ]} />
        <Notice tone={result.limitReached ? 'warning' : 'info'} title={result.summary}>
          {result.limitReached ? 'Try a smaller range, or pin the classes you are sure about and run it again.' : `Worked out in ${elapsed} ms. Preferred times and fair spread come first; “if needed” only when nobody else can.`}
        </Notice>
        {result.added.length > 0 && (
          <section>
            <h3 className={ADMIN_TEXT.sectionHeading}>Would add ({result.added.length})</h3>
            <ul className="staff-roster-list mt-2">
              {result.added.map(item => (
                <li key={`${item.sessionId}:${item.slotKey}`} className="staff-roster-row">
                  <div className="min-w-0">
                    <p className="font-body text-sm text-xert-offwhite"><span className="staff-roster-diff-added">+ {staffName(ctx, item.staffId)}</span> · {sessionLabel(session(item.sessionId))}</p>
                    <p className="font-body text-xs text-xert-pale/55">{item.reason}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(removals.length > 0 || result.removed.length > 0) && (
          <section>
            <h3 className={ADMIN_TEXT.sectionHeading}>Would remove ({removals.length})</h3>
            <ul className="staff-roster-list mt-2">
              {removals.map(item => {
                const reason = result.removed.find(entry => entry.sessionId === item.sessionId && entry.slotKey === item.slotKey)?.reason;
                return (
                  <li key={item.id} className="staff-roster-row">
                    <div className="min-w-0">
                      <p className="font-body text-sm text-xert-offwhite"><span className="staff-roster-diff-removed">{staffName(ctx, item.staffId)}</span> · {sessionLabel(session(item.sessionId))}</p>
                      <p className="font-body text-xs text-xert-pale/55">{reason || 'Starting over: unpinned choices are cleared.'}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {result.unfilled.length > 0 && (
          <section>
            <h3 className={ADMIN_TEXT.sectionHeading}>Still unfilled ({result.unfilled.length})</h3>
            <ul className="staff-roster-list mt-2">
              {result.unfilled.map(item => (
                <li key={`${item.sessionId}:${item.slotKey}`} className="staff-roster-row">
                  <div className="min-w-0">
                    <p className="font-body text-sm text-xert-offwhite">{sessionLabel(session(item.sessionId))}</p>
                    <p className="font-body text-xs text-status-warning-200">{item.reason}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {result.pinned.length > 0 && <p className="font-body text-xs text-xert-pale/55">{result.pinned.length} pinned {result.pinned.length === 1 ? 'choice was' : 'choices were'} left exactly as they are.</p>}
      </div>
    </AdminDrawer>
  );
}
