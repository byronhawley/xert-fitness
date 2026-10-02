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
      <AdminDrawer open={open} onOpenChange={onOpenChange} title="Suggested coaches" description={`For ${scopeLabel}.`} closeLabel="Close suggested coaches">
        <p className="font-body text-sm text-xert-pale/70" role="status">Working out who fits best…</p>
      </AdminDrawer>
    );
  }
  const changes = [
    ...removals.map(item => ({ op: 'unassign', assignment_id: item.id })),
    ...result.added.map(item => ({ op: 'assign', session_id: item.sessionId, slot_key: item.slotKey, staff_id: item.staffId, source: 'suggested' })),
  ];
  const session = id => ctx.sessions.get(id);

  return (
    <AdminDrawer open={open} onOpenChange={onOpenChange} title="Suggested coaches" description={`For ${scopeLabel}. Check it first. Nothing changes until you add it, and coaches see nothing until you publish.`}
      closeLabel="Close suggested coaches"
      footer={<>
        <AdminButton disabled={busy || changes.length === 0} onClick={() => onApply(changes)}>{changes.length ? `Add ${result.added.length} to the roster draft${removals.length ? `, remove ${removals.length}` : ''}` : 'Nothing to change'}</AdminButton>
        <AdminButton variant="ghost" onClick={() => onOpenChange(false)}>Don’t use this</AdminButton>
      </>}>
      <div className="space-y-5">
        <AdminSegmented label="Starting point" value={mode} onValueChange={setMode} options={[
          { value: 'keep', label: 'Keep my choices, fill empty spots' },
          { value: 'fresh', label: 'Start over (keep pinned coaches)' },
        ]} />
        <Notice tone={result.limitReached || result.unfilled.length ? 'warning' : 'info'}
          title={`${result.added.length} ${result.added.length === 1 ? 'coach' : 'coaches'} suggested. ${result.unfilled.length ? `${result.unfilled.length} ${result.unfilled.length === 1 ? 'spot stays' : 'spots stay'} empty — nobody free can take ${result.unfilled.length === 1 ? 'it' : 'them'}.` : 'Every spot is filled.'}`}>
          <span className="block text-xs text-xert-pale/55">{result.summary}</span>
          {result.limitReached ? 'Try a smaller range, or pin the classes you are sure about and run it again.' : `Worked out in ${elapsed} ms. Coaches’ preferred times and a fair share of classes come first; “if needed” answers only when nobody else can.`}
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
                      <p className="font-body text-xs text-xert-pale/55">{reason || 'Starting over: choices you didn’t pin are cleared.'}</p>
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
