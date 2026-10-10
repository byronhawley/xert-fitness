import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from '@/components/ui/use-toast';
import AdminLoadError from '@/components/admin/AdminLoadError';
import AdminConfirmDialog from '@/components/admin/AdminConfirmDialog';
import { AdminButton, AdminPageHeader, AdminSegmented, AdminSkeleton, ADMIN_PAGE } from '@/components/admin/ui';
import { gymDateKey } from '@/lib/gymTime';
import { addMonths, gymDateOf, isDateKey, monthKeyOf } from '@/lib/staffRoster/time';
import { monthLabel } from './rosterFormat';
import { Notice } from './rosterBits';
import { useRosterMonth } from './useRosterMonth';
import RosterBoard from './RosterBoard';
import AvailabilityPanel from './AvailabilityPanel';
import RequestsPanel from './RequestsPanel';
import CoachesPanel from './CoachesPanel';
import SettingsPanel from './SettingsPanel';
import ActivityPanel from './ActivityPanel';
import MonthGuide from './MonthGuide';
import './staffRoster.css';

const TABS = [
  { value: 'roster', label: 'Roster' },
  { value: 'availability', label: 'Availability' },
  { value: 'requests', label: 'Requests' },
  { value: 'coaches', label: 'Coaches' },
  { value: 'settings', label: 'Settings' },
];
// Older links name the Activity tab; it now lives at the foot of Settings.
const TAB_ALIASES = { activity: 'settings' };
// Workspace state lives in the URL (prefixed so it never collides with
// another workspace's filters), so a refresh or shared link opens the same view.
const PARAMS = { month: 'rosterMonth', tab: 'rosterTab', view: 'rosterView', date: 'rosterDate', coach: 'rosterCoach', gapsOnly: 'rosterGaps', session: 'rosterSession', focus: 'rosterFocus' };

export default function StaffRosterWorkspace({ client = null }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const today = gymDateKey(new Date());
  const filters = useMemo(() => Object.fromEntries(Object.entries(PARAMS).map(([key, name]) => [key, params.get(name) || ''])), [params]);
  const month = /^\d{4}-\d{2}$/.test(filters.month) ? filters.month : addMonths(monthKeyOf(today), 1);
  const named = TAB_ALIASES[filters.tab] || filters.tab;
  const tab = TABS.some(item => item.value === named) ? named : 'roster';
  const setFilters = useCallback(patch => {
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (value === '' || value === null || value === undefined) next.delete(PARAMS[key]);
        else next.set(PARAMS[key], value);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const data = useRosterMonth(month, { client });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // A one-shot request from the month guide ("open Suggest", "open Add a
  // coach"), handed to the panel it opens and cleared once it has acted.
  const [intent, setIntent] = useState(null);
  const clearIntent = useCallback(() => setIntent(null), []);

  const { mutate, client: rpcClient, reload: reloadMonth } = data;

  // Texts are sent by the server only when a manager's screen asks, so the
  // roster asks once each time it opens if any are still waiting (a send cut
  // short, a temporary Twilio failure). No scheduler or extra secret needed.
  const textsChecked = useRef(false);
  useEffect(() => {
    if (!rpcClient || textsChecked.current || typeof rpcClient.smsStatus !== 'function') return;
    textsChecked.current = true;
    (async () => {
      try {
        const status = await rpcClient.smsStatus(null);
        if (!status?.enabled || !status?.due) return;
        const sent = await rpcClient.sendTexts();
        if (sent?.sent) toast({ title: `${sent.sent} roster ${sent.sent === 1 ? 'text' : 'texts'} sent`, description: 'They were waiting from an earlier publish.' });
      } catch { /* the publish dialog and next open try again */ }
    })();
  }, [rpcClient]);
  // `failTitle` lets a read say what failed instead of "Not saved".
  const onMutate = useCallback(async (action, message, { reload = true, failTitle = 'Not saved' } = {}) => {
    try {
      const result = reload ? await mutate(action) : await action(rpcClient);
      if (message) toast({ title: message });
      return result ?? true;
    } catch (failure) {
      toast({ title: failure.code === 'STALE_VERSION' ? 'Refreshed with newer changes' : failTitle, description: failure.message, variant: 'destructive' });
      return null;
    }
  }, [mutate, rpcClient]);

  const onApply = useCallback((changes, message) => onMutate(rpc => rpc.applyChanges(month, data.snapshot?.draft?.version ?? 0, changes), message), [onMutate, month, data.snapshot]);
  const onSaveStaffing = useCallback((scope, key, staffing, version) => onMutate(rpc => rpc.setStaffing(scope, key, staffing, version), 'Coaches needed saved'), [onMutate]);
  const onPublish = useCallback(async reason => {
    const result = await onMutate(rpc => rpc.publish(month, data.snapshot?.draft?.version ?? 0, reason), null);
    if (result?.ok) {
      const affected = result.affected_staff?.length || 0;
      toast({ title: `${monthLabel(month)} roster published`, description: data.snapshot?.settings?.enabled === false ? 'Coach screens are off, so coaches can’t see it until you switch them on.' : affected ? `${affected} ${affected === 1 ? 'coach has' : 'coaches have'} a notice in their coach inbox.` : 'No coach’s classes changed, so nobody was notified.' });
    } else if (result?.reason === 'HARD_CONFLICTS') {
      toast({ title: 'Not published', description: 'Some assignments break a rule now. Fix them and try again.', variant: 'destructive' });
      await reloadMonth();
    }
    return result;
  }, [onMutate, month, data.snapshot, reloadMonth]);

  const navigateTarget = useCallback((target, at) => {
    if (target.type === 'session') {
      const date = at ? gymDateOf(at) : filters.date;
      setFilters({ tab: 'roster', view: 'day', date, month: date ? date.slice(0, 7) : month, session: target.id });
    } else if (target.type === 'absence' || target.type === 'cover') {
      setFilters({ tab: 'requests', focus: target.id });
    } else if (target.type === 'staff') {
      setFilters({ tab: 'availability', focus: target.id });
    }
  }, [filters.date, month, setFilters]);

  useEffect(() => {
    const id = filters.session ? `roster-session-${filters.session}` : filters.focus ? `roster-staff-${filters.focus}` : null;
    if (!id || !data.snapshot) return;
    const node = document.getElementById(id);
    if (node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); node.querySelector('button')?.focus({ preventScroll: true }); }
  }, [filters.session, filters.focus, data.snapshot, tab]);

  const snapshot = data.snapshot;
  const ready = snapshot && data.draftCtx;
  // The Requests tab says how many decisions are waiting, so they're seen
  // from any tab.
  const waiting = snapshot ? (snapshot.absences || []).filter(item => ['requested', 'reported'].includes(item.status)).length
    + (snapshot.cover_requests || []).filter(item => item.status === 'offered' && item.current).length : 0;
  const tabOptions = useMemo(() => TABS.map(item => (item.value === 'requests' && waiting ? { ...item, label: `Requests (${waiting})` } : item)), [waiting]);
  const onGuideAction = useCallback(kind => {
    const go = (nextTab, nextIntent = null) => { setFilters({ tab: nextTab, focus: '' }); setIntent(nextIntent); };
    if (kind === 'add-coach') go('coaches', 'add-coach');
    else if (kind === 'coaches') go('coaches');
    else if (kind === 'availability') go('availability');
    else if (kind === 'roster') go('roster');
    else if (kind === 'suggest') go('roster', 'suggest');
    else if (kind === 'publish') go('roster', 'publish');
    else if (kind === 'calendar') navigate('/admin/calendar');
    else if (kind === 'switch-on') onMutate(rpc => rpc.updateSettings({ enabled: true }, snapshot.settings.version), 'Coach screens switched on. Coaches can now sign in and see their roster pages.');
  }, [setFilters, onMutate, snapshot, navigate]);
  return (
    <div className={`${ADMIN_PAGE} space-y-5`}>
      <AdminPageHeader eyebrow="Classes" title="Coach roster" description="Coaches say when they can work, you pick who coaches each class, then publish so they can see it.">
        <div className="flex items-center gap-1" role="group" aria-label="Roster month">
          <AdminButton variant="ghost" aria-label="Previous month" onClick={() => setFilters({ month: addMonths(month, -1), date: '', session: '' })}>‹</AdminButton>
          <span className="font-body text-sm font-semibold text-xert-offwhite min-w-[9rem] text-center" aria-live="polite">{monthLabel(month)}</span>
          <AdminButton variant="ghost" aria-label="Next month" onClick={() => setFilters({ month: addMonths(month, 1), date: '', session: '' })}>›</AdminButton>
        </div>
      </AdminPageHeader>

      {ready && <MonthGuide snapshot={snapshot} ctx={data.draftCtx} today={today} month={month} busy={data.busy} onAction={onGuideAction} />}

      <AdminSegmented label="Roster sections" value={tab} onValueChange={value => setFilters({ tab: value, focus: '' })} options={tabOptions} />

      {data.error && !snapshot && <AdminLoadError message={data.error.message} onRetry={data.reload} />}
      {data.error && snapshot && <Notice tone="danger" title="Couldn’t refresh" action={<AdminButton variant="ghost" onClick={data.reload}>Try again</AdminButton>}>{data.error.message} Showing the last loaded version.</Notice>}
      {!ready && !data.error && <div className="space-y-3"><AdminSkeleton variant="metric" label="Loading roster" /><AdminSkeleton variant="editor" decorative /></div>}

      {ready && tab === 'roster' && <RosterBoard key={month} month={month} today={today} data={data} settings={snapshot.settings} filters={{ ...filters, date: isDateKey(filters.date) ? filters.date : '' }} setFilters={setFilters}
        onApply={onApply} onSaveStaffing={onSaveStaffing} onPublish={onPublish} onDiscard={() => setConfirmDiscard(true)} onNavigateTarget={navigateTarget} intent={intent} onIntentDone={clearIntent} />}
      {ready && tab === 'availability' && <AvailabilityPanel key={month} month={month} today={today} data={data} settings={snapshot.settings} focusStaffId={filters.focus} onMutate={onMutate} onAddCoach={() => onGuideAction('add-coach')} />}
      {ready && tab === 'requests' && <RequestsPanel key={month} data={data} focus={filters.focus} onMutate={onMutate}
        onShowSession={session => navigateTarget({ type: 'session', id: session.id }, session.start)} />}
      {ready && tab === 'coaches' && <CoachesPanel key={month} data={data} focusStaffId={filters.focus} onMutate={onMutate} intent={intent} onIntentDone={clearIntent} />}
      {ready && tab === 'settings' && <>
        <SettingsPanel key={month} data={data} month={month} today={today} onMutate={onMutate} onSaveStaffing={onSaveStaffing} />
        <details className="staff-roster-more" open={filters.tab === 'activity' || undefined}>
          <summary><span className="font-body text-base font-semibold text-xert-offwhite">History</span><span className="font-body text-xs text-xert-pale/60">Every change to this month’s roster, and which notices and texts went out.</span></summary>
          <ActivityPanel month={month} data={data} onMutate={onMutate} />
        </details>
      </>}

      <AdminConfirmDialog open={confirmDiscard} onOpenChange={setConfirmDiscard} busy={data.busy}
        title="Discard this draft?" description={snapshot?.published ? 'The roster coaches can see stays exactly as it is.' : 'Nothing has been published for this month, so the roster will be empty again.'}
        warning="Every change since the last publish will be lost." confirmLabel="Discard draft" cancelLabel="Keep draft"
        onConfirm={async () => { await onMutate(rpc => rpc.discardDraft(month, snapshot.draft.version), 'Draft discarded'); setConfirmDiscard(false); }} />
    </div>
  );
}
