import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import './staffRoster.css';

const TABS = [
  { value: 'roster', label: 'Roster' },
  { value: 'availability', label: 'Availability' },
  { value: 'requests', label: 'Requests' },
  { value: 'coaches', label: 'Coaches' },
  { value: 'settings', label: 'Settings' },
  { value: 'activity', label: 'Activity' },
];
// Workspace state lives in the URL (prefixed so it never collides with
// another workspace's filters), so a refresh or shared link opens the same view.
const PARAMS = { month: 'rosterMonth', tab: 'rosterTab', view: 'rosterView', date: 'rosterDate', coach: 'rosterCoach', gapsOnly: 'rosterGaps', session: 'rosterSession', focus: 'rosterFocus' };

export default function StaffRosterWorkspace({ client = null }) {
  const [params, setParams] = useSearchParams();
  const today = gymDateKey(new Date());
  const filters = useMemo(() => Object.fromEntries(Object.entries(PARAMS).map(([key, name]) => [key, params.get(name) || ''])), [params]);
  const month = /^\d{4}-\d{2}$/.test(filters.month) ? filters.month : addMonths(monthKeyOf(today), 1);
  const tab = TABS.some(item => item.value === filters.tab) ? filters.tab : 'roster';
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

  const { mutate, client: rpcClient, reload: reloadMonth } = data;
  const onMutate = useCallback(async (action, message, { reload = true } = {}) => {
    try {
      const result = reload ? await mutate(action) : await action(rpcClient);
      if (message) toast({ title: message });
      return result ?? true;
    } catch (failure) {
      toast({ title: failure.code === 'STALE_VERSION' ? 'Refreshed with newer changes' : 'Not saved', description: failure.message, variant: 'destructive' });
      return null;
    }
  }, [mutate, rpcClient]);

  const onApply = useCallback((changes, message) => onMutate(rpc => rpc.applyChanges(month, data.snapshot?.draft?.version ?? 0, changes), message), [onMutate, month, data.snapshot]);
  const onSaveStaffing = useCallback((scope, key, staffing, version) => onMutate(rpc => rpc.setStaffing(scope, key, staffing, version), 'Positions saved'), [onMutate]);
  const onPublish = useCallback(async reason => {
    const result = await onMutate(rpc => rpc.publish(month, data.snapshot?.draft?.version ?? 0, reason), null);
    if (result?.ok) {
      const affected = result.affected_staff?.length || 0;
      toast({ title: `Version ${result.number} published`, description: affected ? `${affected} ${affected === 1 ? 'coach has' : 'coaches have'} a notice in their app inbox.` : 'No coach’s classes changed, so nobody was notified.' });
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
  return (
    <div className={`${ADMIN_PAGE} space-y-5`}>
      <AdminPageHeader eyebrow="Classes" title="Coach roster" description="Who is coaching each class. Coaches give availability; you build and publish the roster.">
        <div className="flex items-center gap-1" role="group" aria-label="Roster month">
          <AdminButton variant="ghost" aria-label="Previous month" onClick={() => setFilters({ month: addMonths(month, -1), date: '', session: '' })}>‹</AdminButton>
          <span className="font-body text-sm font-semibold text-xert-offwhite min-w-[9rem] text-center" aria-live="polite">{monthLabel(month)}</span>
          <AdminButton variant="ghost" aria-label="Next month" onClick={() => setFilters({ month: addMonths(month, 1), date: '', session: '' })}>›</AdminButton>
        </div>
      </AdminPageHeader>

      <AdminSegmented label="Roster sections" value={tab} onValueChange={value => setFilters({ tab: value, focus: '' })} options={TABS} />

      {snapshot && !snapshot.settings?.enabled && (
        <Notice tone="warning" title="Coaches can’t see the roster yet" action={tab !== 'settings' ? <AdminButton variant="ghost" onClick={() => setFilters({ tab: 'settings' })}>Settings</AdminButton> : null}>
          You can set things up and plan. Switch it on in Settings when you’re ready for coaches to give availability.
        </Notice>
      )}
      {data.error && !snapshot && <AdminLoadError message={data.error.message} onRetry={data.reload} />}
      {data.error && snapshot && <Notice tone="danger" title="Couldn’t refresh" action={<AdminButton variant="ghost" onClick={data.reload}>Try again</AdminButton>}>{data.error.message} Showing the last loaded version.</Notice>}
      {!ready && !data.error && <div className="space-y-3"><AdminSkeleton variant="metric" label="Loading roster" /><AdminSkeleton variant="editor" decorative /></div>}

      {ready && tab === 'roster' && <RosterBoard month={month} today={today} data={data} settings={snapshot.settings} filters={{ ...filters, date: isDateKey(filters.date) ? filters.date : '' }} setFilters={setFilters}
        onApply={onApply} onSaveStaffing={onSaveStaffing} onPublish={onPublish} onDiscard={() => setConfirmDiscard(true)} onNavigateTarget={navigateTarget} />}
      {ready && tab === 'availability' && <AvailabilityPanel month={month} today={today} data={data} settings={snapshot.settings} focusStaffId={filters.focus} onMutate={onMutate} />}
      {ready && tab === 'requests' && <RequestsPanel data={data} focus={filters.focus} onMutate={onMutate}
        onShowSession={session => navigateTarget({ type: 'session', id: session.id }, session.start)} />}
      {ready && tab === 'coaches' && <CoachesPanel data={data} focusStaffId={filters.focus} onMutate={onMutate} />}
      {ready && tab === 'settings' && <SettingsPanel data={data} month={month} today={today} onMutate={onMutate} onSaveStaffing={onSaveStaffing} />}
      {ready && tab === 'activity' && <ActivityPanel month={month} data={data} onMutate={onMutate} />}

      <AdminConfirmDialog open={confirmDiscard} onOpenChange={setConfirmDiscard} busy={data.busy}
        title="Discard this draft?" description={snapshot?.published ? `The published version ${snapshot.published.number} stays exactly as it is.` : 'Nothing has been published for this month, so the roster will be empty again.'}
        warning="Every change since the last publish will be lost." confirmLabel="Discard draft" cancelLabel="Keep draft"
        onConfirm={async () => { await onMutate(rpc => rpc.discardDraft(month, snapshot.draft.version), 'Draft discarded'); setConfirmDiscard(false); }} />
    </div>
  );
}
