import React, { useEffect, useMemo, useState } from 'react';
import { AdminButton, AdminSegmented, ADMIN_INPUT_BARE, ADMIN_TEXT } from '@/components/admin/ui';
import { coverageReport } from '@/lib/staffRoster/coverage';
import { checkAssignment, LIVE_SESSION_STATUSES } from '@/lib/staffRoster/validate';
import { normalizeStaffing } from '@/lib/staffRoster/duty';
import { copyWeekSuggestions } from '@/lib/staffRoster/suggest';
import { needsAttention } from '@/lib/staffRoster/snapshot';
import { addDays, addMonths, dateInMonth, datesOfMonth, DAY_MS, gymDateOf, monthKeyOf, weekdayOf, weekStartOf } from '@/lib/staffRoster/time';
import { dayLabel, monthLabel, ROLE_LABELS, sessionLabel, staffName, timeLabel, weekDates } from './rosterFormat';
import { AvailabilityBadge, Notice, Tone } from './rosterBits';
import AssignmentDrawer from './AssignmentDrawer';
import SuggestDialog from './SuggestDialog';
import PublishDialog from './PublishDialog';

const HIGH = new Set(['urgent_absence', 'invalid_published', 'changed_since_publish']);

function SlotRow({ ctx, session, slot, assignment, moving, readOnly, onOpen, onDrop, onPlace }) {
  const [over, setOver] = useState(false);
  const check = assignment ? checkAssignment(ctx, assignment, { ignoreAssignmentIds: [assignment.id] }) : null;
  const status = assignment ? ctx.availability(assignment.staffId, session.id)?.status : null;
  const canDrop = !assignment && !readOnly;
  const label = `${ROLE_LABELS[slot.role]}${slot.required ? '' : ' (optional)'}`;
  return (
    <div className="staff-roster-slot" data-open={!assignment} data-required={slot.required} data-problem={Boolean(check && !check.ok)} data-drop-target={over}
      onDragOver={canDrop ? event => { event.preventDefault(); setOver(true); } : undefined}
      onDragLeave={canDrop ? () => setOver(false) : undefined}
      onDrop={canDrop ? event => { event.preventDefault(); setOver(false); onDrop(event.dataTransfer.getData('text/plain'), session, slot); } : undefined}>
      {assignment ? (
        <button type="button" className="staff-roster-chip" draggable={!readOnly} data-moving={moving?.id === assignment.id}
          onDragStart={event => { event.dataTransfer.setData('text/plain', assignment.id); event.dataTransfer.effectAllowed = 'move'; }}
          onClick={() => onOpen(session, slot)}
          aria-label={`${label}: ${staffName(ctx, assignment.staffId)}${check && !check.ok ? ', has a problem' : ''}. Open details`}>
          <span className="font-body text-sm break-words min-w-0">{staffName(ctx, assignment.staffId)}</span>
          {assignment.pinned && <span aria-hidden="true" title="Pinned">📌</span>}
          {check && !check.ok && <span className="font-body text-xs text-status-danger-200">⚠ {check.hard[0].message}</span>}
        </button>
      ) : moving && !readOnly ? (
        <button type="button" className="admin-kit-button font-body text-xs" onClick={() => onPlace(session, slot)}>Place {staffName(ctx, moving.staffId)} here</button>
      ) : (
        <button type="button" className="font-body text-sm text-xert-pale/70 hover:text-xert-offwhite text-start" onClick={() => onOpen(session, slot)} disabled={Boolean(readOnly) && !assignment}
          aria-label={`${label} open for ${sessionLabel(session)}. Choose a coach`}>
          {readOnly ? 'Unfilled' : 'Choose coach'}
        </button>
      )}
      <span className="font-body text-[11px] text-xert-pale/45">{label}</span>
      {assignment && status && status !== 'AVAILABLE' && <AvailabilityBadge status={status} />}
    </div>
  );
}

/** Why a class before a part-month roster's first day can't be changed here. */
function beforeStartLabel(startsOn) {
  return `Before this roster starts on ${dayLabel(startsOn)}; it stays with the current coach.`;
}

function SessionCard({ ctx, session, coverage, shortage, focused, selected, onToggleSelect, moving, onOpen, onDrop, onPlace, startsOn = null }) {
  const staffing = normalizeStaffing(session.staffing);
  const filled = ctx.bySession.get(session.id) || [];
  const past = session.start <= ctx.now;
  const live = LIVE_SESSION_STATUSES.includes(session.status);
  const readOnly = session.beforeRosterStart && startsOn ? beforeStartLabel(startsOn) : !session.inMonth ? `Belongs to the ${monthLabel(monthKeyOf(gymDateOf(session.start)))} roster.` : past ? 'This class has started; its roster is history.' : !live ? 'Cancelled — needs no coach.' : null;
  return (
    <article className="staff-roster-session" data-coverage={coverage?.status || (live ? 'gap' : 'cancelled')} data-shortage={shortage} data-focused={focused} data-past={past}
      id={`roster-session-${session.id}`} aria-label={sessionLabel(session)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-body text-xs text-xert-pale/55">{timeLabel(session.start)}–{timeLabel(session.end)}</p>
          <p className="font-body text-sm font-semibold text-xert-offwhite break-words">{session.title}</p>
        </div>
        {session.inMonth && live && !past && (
          <label className="min-h-11 min-w-11 inline-flex items-center justify-center">
            <input type="checkbox" checked={selected} onChange={() => onToggleSelect(session.id)} aria-label={`Select ${sessionLabel(session)}`} />
          </label>
        )}
      </div>
      {!live && <Tone tone="neutral">{session.status === 'cancelled' ? 'Cancelled' : session.status}</Tone>}
      {session.beforeRosterStart && startsOn && live && !past && <p className="font-body text-xs text-xert-pale/60">{beforeStartLabel(startsOn)}</p>}
      {live && !past && session.inMonth && coverage?.status === 'gap' && <Tone tone="danger">Needs a coach</Tone>}
      {shortage && live && !past && <Tone tone="warning">Not enough coaches free</Tone>}
      {session.addedSinceSubmission?.size > 0 && live && !past && <Tone tone="warning">Added after availability was given</Tone>}
      {live && staffing.slots.map(slot => (
        <SlotRow key={slot.key} ctx={ctx} session={session} slot={slot} assignment={filled.find(item => item.slotKey === slot.key) || null}
          moving={moving} readOnly={readOnly} onOpen={onOpen} onDrop={onDrop} onPlace={onPlace} />
      ))}
    </article>
  );
}

/**
 * The manager's roster: week (default), month or day, with coverage drawn on
 * every class, Needs Attention alongside, and every edit going to the draft.
 */
export default function RosterBoard({ month, today, data, settings, filters, setFilters, onApply, onSaveStaffing, onPublish, onDiscard, onNavigateTarget, intent = null, onIntentDone = () => {} }) {
  const { snapshot, draftCtx: ctx, busy } = data;
  const view = filters.view || 'week';
  const anchor = filters.date && filters.date.slice(0, 7) === month ? filters.date
    : (today.slice(0, 7) === month ? today : dateInMonth(month, 1));
  const [drawer, setDrawer] = useState(null);
  const [moving, setMoving] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [suggestOpen, setSuggestOpen] = useState(false);
  // The month guide's "Fill open spots" suggests for the whole month, whatever view is showing.
  const [suggestWholeMonth, setSuggestWholeMonth] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [copyPreview, setCopyPreview] = useState(null);

  useEffect(() => {
    if (!moving) return undefined;
    const cancel = event => { if (event.key === 'Escape') setMoving(null); };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [moving]);

  const dates = useMemo(() => (view === 'day' ? [anchor] : view === 'week' ? weekDates(anchor) : datesOfMonth(month)), [view, anchor, month]);
  const sessionsByDate = useMemo(() => {
    const map = new Map(dates.map(date => [date, []]));
    for (const session of ctx.sessions.values()) {
      const date = gymDateOf(session.start);
      if (map.has(date)) map.get(date).push(session);
    }
    for (const list of map.values()) list.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
    return map;
  }, [ctx, dates]);
  const coach = filters.coach || '';
  const visible = session => {
    if (filters.gapsOnly === '1' && coverage.bySession[session.id]?.status !== 'gap') return false;
    if (coach && !(ctx.bySession.get(session.id) || []).some(item => item.staffId === coach)) return false;
    return true;
  };
  const monthSessionIds = useMemo(() => [...ctx.sessions.values()].filter(session => session.inMonth).map(session => session.id), [ctx]);
  const coverage = useMemo(() => coverageReport(ctx, monthSessionIds), [ctx, monthSessionIds]);
  const shortageIds = useMemo(() => new Set(coverage.shortages.flatMap(item => item.sessionIds)), [coverage]);
  const attention = useMemo(() => needsAttention(snapshot, { today, now: ctx.now }), [snapshot, today, ctx.now]);
  const plannable = session => session.inMonth && session.start > ctx.now && LIVE_SESSION_STATUSES.includes(session.status);
  const viewSessionIds = dates.flatMap(date => sessionsByDate.get(date) || []).filter(plannable).map(session => session.id);
  const monthPlannableIds = useMemo(() => [...ctx.sessions.values()].filter(session => session.inMonth && session.start > ctx.now && LIVE_SESSION_STATUSES.includes(session.status)).map(session => session.id), [ctx]);
  const suggestIds = suggestWholeMonth ? monthPlannableIds : selected.size ? [...selected] : viewSessionIds;

  useEffect(() => {
    if (!intent) return;
    if (intent === 'suggest' && monthPlannableIds.length) { setSuggestWholeMonth(true); setSuggestOpen(true); }
    if (intent === 'publish' && snapshot.draft) setPublishOpen(true);
    onIntentDone();
  }, [intent, monthPlannableIds.length, snapshot.draft, onIntentDone]);

  const open = (session, slot) => setDrawer({ sessionId: session.id, slotKey: slot.key });
  const drop = (assignmentId, session, slot) => {
    const assignment = ctx.assignments.find(item => item.id === assignmentId && !item.locked);
    if (assignment) onApply([{ op: 'move', assignment_id: assignment.id, session_id: session.id, slot_key: slot.key }], 'Coach moved');
  };
  const place = (session, slot) => {
    const assignment = moving;
    setMoving(null);
    onApply([{ op: 'move', assignment_id: assignment.id, session_id: session.id, slot_key: slot.key }], 'Coach moved');
  };
  const step = direction => {
    const next = view === 'day' ? addDays(anchor, direction) : view === 'week' ? addDays(anchor, 7 * direction) : null;
    if (view === 'month') setFilters({ month: addMonths(month, direction), date: '' });
    else setFilters({ date: next, month: next.slice(0, 7) });
  };
  const runCopyWeek = () => {
    const thisWeek = weekDates(anchor);
    const previous = thisWeek.map(date => addDays(date, -7));
    const from = [...ctx.sessions.values()].filter(session => previous.includes(gymDateOf(session.start))).map(session => session.id);
    const to = thisWeek.flatMap(date => sessionsByDate.get(date) || []).filter(plannable).map(session => session.id);
    setCopyPreview(copyWeekSuggestions(ctx, { fromSessionIds: from, toSessionIds: to, offsetMs: 7 * DAY_MS }));
  };
  const drawerSession = drawer ? ctx.sessions.get(drawer.sessionId) : null;
  const drawerReadOnly = drawerSession && !plannable(drawerSession)
    ? (drawerSession.beforeRosterStart && snapshot.period?.starts_on ? beforeStartLabel(snapshot.period.starts_on)
      : !drawerSession.inMonth ? 'This class belongs to the neighbouring month’s roster. Open that month to change it.' : 'This class has started or is cancelled. Past rosters are kept as history.') : null;
  const draft = snapshot.draft;
  const published = snapshot.published;

  return (
    <div className="space-y-4">
      <Notice tone={draft ? 'warning' : published ? 'success' : 'info'}
        title={draft ? 'Draft — coaches can’t see these changes yet' : published ? 'Published — coaches can see this roster' : 'Nothing published for this month yet'}
        action={<div className="flex flex-wrap gap-2">
          {draft && <AdminButton variant="ghost" disabled={busy} onClick={onDiscard}>Discard draft</AdminButton>}
          <AdminButton disabled={busy || !draft} onClick={() => setPublishOpen(true)} aria-describedby={!draft ? 'roster-publish-why' : undefined}>Review & publish</AdminButton>
        </div>}>
        <span id="roster-publish-why">{draft ? (published ? 'Coaches still see the last published roster until you publish these changes.' : 'Choose coaches for each class (or use Suggest coaches), then publish so coaches can see it.') : published ? 'Any change you make is kept as a draft. Coaches keep seeing this roster until you publish again.' : 'Click “Choose coach” on a class, or use Suggest coaches to fill the month from coaches’ answers.'}</span>
        {published?.gap_count > 0 && <span className="block text-status-warning-200">Published with {published.gap_count} empty {published.gap_count === 1 ? 'spot' : 'spots'}{published.gap_reason ? `: “${published.gap_reason}”` : ''}.</span>}
      </Notice>

      <div className="staff-roster-toolbar">
        <AdminSegmented label="Roster view" value={view} onValueChange={value => setFilters({ view: value })} options={[
          { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'day', label: 'Day' },
        ]} />
        <div className="flex gap-1">
          <AdminButton variant="ghost" onClick={() => step(-1)} aria-label={`Previous ${view}`}>‹</AdminButton>
          <AdminButton variant="ghost" onClick={() => setFilters({ date: today, month: today.slice(0, 7) })}>Today</AdminButton>
          <AdminButton variant="ghost" onClick={() => step(1)} aria-label={`Next ${view}`}>›</AdminButton>
        </div>
        <select className={ADMIN_INPUT_BARE} aria-label="Show coach" value={coach} onChange={event => setFilters({ coach: event.target.value })}>
          <option value="">All coaches</option>
          {[...ctx.staff.values()].filter(member => member.status === 'active').sort((a, b) => a.name.localeCompare(b.name)).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
        <label className="flex items-center gap-2 font-body text-sm text-xert-pale min-h-11">
          <input type="checkbox" checked={filters.gapsOnly === '1'} onChange={event => setFilters({ gapsOnly: event.target.checked ? '1' : '' })} /> Only classes needing a coach
        </label>
        <div className="flex flex-wrap gap-2 ms-auto">
          {view === 'week' && <AdminButton variant="ghost" disabled={busy} onClick={runCopyWeek}>Copy last week</AdminButton>}
          <AdminButton variant="ghost" disabled={busy || suggestIds.length === 0} onClick={() => { setSuggestWholeMonth(false); setSuggestOpen(true); }}>Suggest coaches{selected.size ? ` (${selected.size} selected)` : ''}</AdminButton>
          {selected.size > 0 && <AdminButton variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</AdminButton>}
        </div>
      </div>

      {moving && <Notice tone="info" title={`Moving ${staffName(ctx, moving.staffId)}`} action={<AdminButton variant="ghost" onClick={() => setMoving(null)}>Cancel move</AdminButton>}>Choose “Place here” on any empty spot, or press Escape to cancel. Rules are checked when you place them.</Notice>}

      <div className="staff-roster-layout">
        <div className="min-w-0 space-y-3">
          <p className={ADMIN_TEXT.lede} aria-live="polite">
            {coverage.totals.filledPositions} of {coverage.totals.requiredPositions} coaching spots filled across {coverage.totals.sessions} classes in {monthLabel(month)}.
            {coverage.dependencies.length > 0 && ` ${coverage.dependencies.length} ${coverage.dependencies.length === 1 ? 'class has' : 'classes have'} only one coach who can take ${coverage.dependencies.length === 1 ? 'it' : 'them'}.`}
          </p>
          {coverage.shortages.length > 0 && (
            <Notice tone="warning" title={`${coverage.shortages.length} time${coverage.shortages.length === 1 ? '' : 's'} with more classes than available coaches`}>
              <ul>{coverage.shortages.slice(0, 5).map(item => <li key={item.sessionIds.join(',')}>{dayLabel(gymDateOf(item.start))} {timeLabel(item.start)}: {item.demand} spots, but only {item.possible} can be filled by the coaches who said they’re free.</li>)}</ul>
            </Notice>
          )}

          {view === 'month' ? (
            <div>
              <div className="staff-roster-month" aria-hidden="true">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(name => <p key={name} className="font-body text-xs text-xert-pale/50 text-center">{name}</p>)}</div>
              <div className="staff-roster-month mt-1" role="grid" aria-label={`${monthLabel(month)} coverage by day`}>
                {Array.from({ length: (weekdayOf(dates[0]) + 6) % 7 }, (_, index) => <div key={`pad-${index}`} className="staff-roster-month-cell" data-empty="true" aria-hidden="true" />)}
                {dates.map(date => {
                  const list = (sessionsByDate.get(date) || []).filter(session => session.inMonth && LIVE_SESSION_STATUSES.includes(session.status));
                  const gaps = list.filter(session => coverage.bySession[session.id]?.status === 'gap').length;
                  return (
                    <button key={date} type="button" role="gridcell" className="staff-roster-month-cell" data-gaps={gaps > 0} onClick={() => setFilters({ view: 'day', date })}
                      aria-label={`${dayLabel(date)}: ${list.length} classes${gaps ? `, ${gaps} need a coach` : ', all covered'}`}>
                      <span className="font-body text-xs text-xert-pale/60">{Number(date.slice(8))}</span>
                      {list.length > 0 && <span className="font-body text-xs">{list.length} class{list.length === 1 ? '' : 'es'}</span>}
                      {gaps > 0 && <span className="font-body text-xs text-status-danger-200">{gaps} open</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="staff-roster-week-frame"><div className="staff-roster-week" style={view === 'day' ? { gridTemplateColumns: 'minmax(0, 1fr)' } : undefined}>
              {dates.map(date => {
                const list = (sessionsByDate.get(date) || []).filter(visible);
                const other = date.slice(0, 7) !== month;
                return (
                  <section key={date} className="staff-roster-day" data-other-month={other} aria-label={dayLabel(date)}>
                    <div className="staff-roster-day-heading" data-today={date === today}>
                      <h3 className="font-body text-sm font-semibold text-xert-offwhite">{dayLabel(date)}</h3>
                      {view === 'week' && <button type="button" className="font-body text-xs text-xert-pale/60 underline min-h-11" onClick={() => setFilters({ view: 'day', date })}>Day</button>}
                    </div>
                    {other && <p className="font-body text-xs text-xert-pale/50">Part of {monthLabel(date.slice(0, 7))}. Switch month to plan it.</p>}
                    {!other && list.length === 0 && <p className="font-body text-xs text-xert-pale/45">No classes{filters.gapsOnly === '1' || coach ? ' match' : ''}.</p>}
                    {list.map(session => (
                      <SessionCard key={session.id} ctx={ctx} session={session} coverage={coverage.bySession[session.id]} shortage={shortageIds.has(session.id)}
                        focused={filters.session === session.id} selected={selected.has(session.id)}
                        onToggleSelect={id => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
                        moving={moving} onOpen={open} onDrop={drop} onPlace={place} startsOn={snapshot.period?.starts_on || null} />
                    ))}
                  </section>
                );
              })}
            </div></div>
          )}
        </div>

        <aside aria-labelledby="roster-attention" className="space-y-2">
          <h3 id="roster-attention" className={ADMIN_TEXT.sectionHeading}>Needs attention ({attention.length})</h3>
          {attention.length === 0 && <p className="font-body text-sm text-xert-pale/60">Nothing needs you for {monthLabel(month)}. Requests, gaps and missing answers show here.</p>}
          <ul className="space-y-2">
            {attention.slice(0, 40).map((item, index) => (
              <li key={`${item.kind}-${item.target.id}-${index}`}>
                <button type="button" className="staff-roster-attention-item" data-severity={HIGH.has(item.kind) ? 'high' : 'normal'} onClick={() => onNavigateTarget(item.target, item.at)}>
                  <span className="font-body text-sm block">{item.title}</span>
                  {item.detail && <span className="font-body text-xs text-xert-pale/60 block">{item.detail}</span>}
                  {item.at && <span className="font-body text-[11px] text-xert-pale/45 block">{dayLabel(gymDateOf(item.at))} {timeLabel(item.at)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <AssignmentDrawer open={Boolean(drawerSession)} onOpenChange={value => { if (!value) setDrawer(null); }} ctx={ctx} session={drawerSession} slotKey={drawer?.slotKey}
        readOnly={drawerReadOnly} busy={busy} client={data.client}
        staffingVersion={drawerSession ? snapshot.session_staffing_versions?.[drawerSession.id] ?? 0 : 0}
        onApply={async (changes, message) => { if (await onApply(changes, message)) setDrawer(null); }}
        onStartMove={assignment => { setMoving(assignment); setDrawer(null); }}
        onSaveStaffing={onSaveStaffing} />
      <SuggestDialog open={suggestOpen} onOpenChange={value => { setSuggestOpen(value); if (!value) setSuggestWholeMonth(false); }} ctx={ctx} sessionIds={suggestIds}
        scopeLabel={suggestWholeMonth ? `all of ${monthLabel(month)}` : selected.size ? `${selected.size} selected classes` : view === 'month' ? monthLabel(month) : view === 'week' ? `the week of ${dayLabel(weekStartOf(anchor))}` : dayLabel(anchor)}
        allowIfNeeded={settings?.allow_if_needed_fallback !== false} busy={busy}
        onApply={async changes => { if (await onApply(changes, 'Suggested coaches added to the draft. Check them, then publish.')) { setSuggestOpen(false); setSuggestWholeMonth(false); setSelected(new Set()); } }} />
      {publishOpen && <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} month={month} snapshot={snapshot} ctx={ctx} busy={busy}
        onPublish={async reason => { const result = await onPublish(reason); if (result?.ok) setPublishOpen(false); return result; }} />}
      {copyPreview && (
        <Notice tone="info" title={`Copy last week: ${copyPreview.proposals.length} can be copied, ${copyPreview.skipped.length} can’t`}
          action={<div className="flex gap-2">
            <AdminButton disabled={busy || copyPreview.proposals.length === 0} onClick={async () => { if (await onApply(copyPreview.proposals.map(item => ({ op: 'assign', session_id: item.sessionId, slot_key: item.slotKey, staff_id: item.staffId, source: 'copied' })), 'Last week copied into the draft')) setCopyPreview(null); }}>Add to draft</AdminButton>
            <AdminButton variant="ghost" onClick={() => setCopyPreview(null)}>Discard</AdminButton>
          </div>}>
          <ul>
            {copyPreview.proposals.slice(0, 8).map(item => <li key={item.id}>+ {staffName(ctx, item.staffId)} · {sessionLabel(ctx.sessions.get(item.sessionId))}</li>)}
            {copyPreview.skipped.slice(0, 8).map(item => <li key={item.id} className="text-status-warning-200">{staffName(ctx, item.staffId)} · {sessionLabel(ctx.sessions.get(item.sessionId))}: {item.reason}</li>)}
          </ul>
          Only the same coach in the same class time is copied, and only where they’re still available and free.
        </Notice>
      )}
    </div>
  );
}
