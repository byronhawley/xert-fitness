import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, gymDateOf, toMs } from '@/lib/staffRoster/time';
import { coachChecklist, hoursLabel, upcomingClasses } from '@/lib/staffRoster/coachHome';
import { headcountLine } from './CoachClassDetail';
import { at, Banner, dateName, GHOST, monthName, Pill } from './coachingUi';

const ROLE = { lead: 'Lead', assistant: 'Assistant', shadow: 'Shadow' };

export function tabHref(tab, month) {
  const params = new URLSearchParams({ tab });
  if (month) params.set('month', month);
  return `/coaching?${params}`;
}

function ChecklistRow({ row }) {
  return (
    <li className="coaching-card flex items-start justify-between gap-3" data-done={row.done === true}>
      <div className="min-w-0">
        <p className="font-body text-sm font-semibold text-xert-offwhite">
          <span aria-hidden="true" className="coaching-check" data-state={row.done === true ? 'done' : row.done === false ? 'todo' : 'none'}>{row.done === true ? '✓' : row.done === false ? '•' : '–'}</span>{' '}
          <span className="sr-only">{row.done === true ? 'Done: ' : row.done === false ? 'To do: ' : ''}</span>{row.label}
        </p>
        <p className="font-body text-xs text-xert-pale/65 mt-0.5">{row.detail}</p>
      </div>
      {row.tab && row.done === false && <Link className={`${GHOST} shrink-0 whitespace-nowrap`} to={tabHref(row.tab, row.month)} aria-label={`Open ${row.label}`}>Open</Link>}
    </li>
  );
}

/** Presentational Home tab; `upcoming` is null while loading. */
export function CoachHomeView({ me, today, upcoming, error = null, joined = null, onRetry = null, dashboard = null, nextDetail = null }) {
  const checklist = coachChecklist(me, { monthLabel: monthName, dateLabel: date => dateName(date), dashboard });
  // Only what needs the coach is shown; the rest folds away.
  const todo = checklist.filter(row => row.done === false);
  const rest = checklist.filter(row => row.done !== false);
  return (
    <div className="space-y-6">
      {joined && (
        <Banner tone="success" title={`Welcome to the XERT coach roster${typeof joined === 'string' ? `, ${joined}` : ''}`}>
          Your sign-in is linked. Start by giving your availability.
        </Banner>
      )}

      <section aria-labelledby="coach-home-checklist" className="space-y-2">
        <h2 id="coach-home-checklist" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">
          {todo.length ? `To do · ${todo.length}` : 'To do'}
        </h2>
        {todo.length === 0 && <div className="coaching-card"><p className="font-body text-sm text-xert-offwhite">You’re all set. Nothing needs you right now.</p></div>}
        <ul className="space-y-2">
          {todo.map(row => <ChecklistRow key={row.key} row={row} />)}
        </ul>
        {rest.length > 0 && (
          <details className="coaching-done">
            <summary className="font-body text-xs text-xert-pale/65 cursor-pointer">Done and up to date ({rest.length})</summary>
            <ul className="space-y-2 mt-2">
              {rest.map(row => <ChecklistRow key={row.key} row={row} />)}
            </ul>
          </details>
        )}
      </section>

      <section aria-labelledby="coach-home-next" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 id="coach-home-next" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">Your next classes</h2>
          <Link className="font-body text-xs text-xert-steel underline" to={tabHref('roster')}>All my classes</Link>
        </div>
        {error && <Banner tone="danger" title="Couldn’t load your classes" action={onRetry ? <button type="button" className={GHOST} onClick={onRetry}>Try again</button> : null}>{error.message}</Banner>}
        {!error && !upcoming && <p className="font-body text-sm text-xert-pale/60" role="status">Loading your classes…</p>}
        {!error && upcoming && upcoming.length === 0 && (
          <div className="coaching-card"><p className="font-body text-sm text-xert-pale/70">No published classes for you in the next two weeks.</p></div>
        )}
        {!error && upcoming?.map(item => {
          const date = gymDateOf(toMs(item.start));
          return (
            <article key={item.assignment_id} className="coaching-card flex flex-wrap items-start justify-between gap-x-3">
              <div className="min-w-0">
                <p className="font-body text-xs uppercase tracking-wider text-xert-pale/60">{date === today ? 'Today' : dateName(date)}</p>
                <p className="font-display text-xl text-xert-offwhite">{at(item.start)} <span className="text-xert-pale/50 text-base">– {at(item.end)}</span></p>
                <p className="font-body text-sm text-xert-offwhite">{item.title}</p>
                <p className="font-body text-xs text-xert-pale/60">{ROLE[item.role] || item.role}{item.colleagues?.length ? ` · with ${item.colleagues.map(colleague => colleague.display_name).join(', ')}` : ''}</p>
              </div>
              {item.changed_since_publish ? <Pill tone="warning">Changed</Pill> : item.cover ? <Pill tone="warning">Cover requested</Pill> : null}
              {nextDetail && nextDetail.session?.id === item.session_id && <p className="font-body text-xs text-xert-pale/75 mt-1 basis-full" data-testid="next-class-headcount">{headcountLine(nextDetail)}{nextDetail.note ? ' · plan written' : ''}</p>}
            </article>
          );
        })}
      </section>

      {dashboard?.hours?.length > 0 && (
        <section aria-labelledby="coach-home-hours" className="space-y-2">
          <h2 id="coach-home-hours" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">Hours coached</h2>
          <div className="coaching-stats">
            {dashboard.hours.map(row => (
              <div key={row.month} className="coaching-card">
                <p className="font-body text-xs text-xert-pale/60">{monthName(row.month)}</p>
                <p className="font-display text-2xl text-xert-offwhite">{hoursLabel(row.done_duty_minutes)}</p>
                <p className="font-body text-xs text-xert-pale/60">{row.done_classes} {row.done_classes === 1 ? 'class' : 'classes'} done{row.classes > row.done_classes ? ` · ${row.classes - row.done_classes} to come (${hoursLabel(row.duty_minutes - row.done_duty_minutes)})` : ''}</p>
              </div>
            ))}
          </div>
          <p className="font-body text-xs text-xert-pale/50">A summary from the published roster, including set-up and pack-down time. Not a timesheet or payroll record.</p>
        </section>
      )}

    </div>
  );
}

/** Home tab: next two weeks of published classes, the next class's headcount, hours and setup. */
export default function CoachHome({ client, me, today, joined }) {
  const [upcoming, setUpcoming] = useState(null);
  const [error, setError] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [nextDetail, setNextDetail] = useState(null);
  const load = useCallback(async () => {
    try {
      const data = await client.myRoster(today, addDays(today, 14));
      const next = upcomingClasses(data.assignments);
      setUpcoming(next);
      setError(null);
      if (next[0]) client.classDetail(next[0].session_id).then(setNextDetail).catch(() => setNextDetail(null));
    } catch (failure) { setError(failure); }
  }, [client, today]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { client.myDashboard().then(setDashboard).catch(() => setDashboard(null)); }, [client]);
  return <CoachHomeView me={me} today={today} upcoming={upcoming} error={error} joined={joined} onRetry={load} dashboard={dashboard} nextDetail={nextDetail} />;
}
