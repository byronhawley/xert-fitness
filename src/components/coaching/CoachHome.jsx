import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, gymDateOf, toMs } from '@/lib/staffRoster/time';
import { coachChecklist, upcomingClasses } from '@/lib/staffRoster/coachHome';
import { at, Banner, dateName, GHOST, monthName, Pill } from './coachingUi';

const ROLE = { lead: 'Lead', assistant: 'Assistant', shadow: 'Shadow' };
const SHORTCUTS = [
  { tab: 'availability', label: 'Give availability', countKey: 'availability' },
  { tab: 'roster', label: 'My classes', countKey: 'roster' },
  { tab: 'requests', label: 'Time away & cover', countKey: null },
  { tab: 'inbox', label: 'Inbox', countKey: 'inbox' },
];

export function tabHref(tab, month) {
  const params = new URLSearchParams({ tab });
  if (month) params.set('month', month);
  return `/coaching?${params}`;
}

/** Presentational Home tab; `upcoming` is null while loading. */
export function CoachHomeView({ me, today, upcoming, error = null, joined = null, counts = {}, onRetry = null }) {
  const checklist = coachChecklist(me, { monthLabel: monthName, dateLabel: date => dateName(date) });
  const left = checklist.filter(row => row.done === false).length;
  return (
    <div className="space-y-6">
      {joined && (
        <Banner tone="success" title={`Welcome to the XERT coach roster${typeof joined === 'string' ? `, ${joined}` : ''}`}>
          Your sign-in is linked. Start by giving your availability.
        </Banner>
      )}

      <section aria-labelledby="coach-home-checklist" className="space-y-2">
        <h2 id="coach-home-checklist" className="font-body text-xs font-semibold uppercase tracking-wider text-xert-pale/60">
          {left ? `Getting set up · ${left} to do` : 'Getting set up · all done'}
        </h2>
        <ul className="space-y-2">
          {checklist.map(row => (
            <li key={row.key} className="coaching-card flex items-start justify-between gap-3" data-done={row.done === true}>
              <div className="min-w-0">
                <p className="font-body text-sm font-semibold text-xert-offwhite">
                  <span aria-hidden="true" className="coaching-check" data-state={row.done === true ? 'done' : row.done === false ? 'todo' : 'none'}>{row.done === true ? '✓' : row.done === false ? '•' : '–'}</span>{' '}
                  <span className="sr-only">{row.done === true ? 'Done: ' : row.done === false ? 'To do: ' : ''}</span>{row.label}
                </p>
                <p className="font-body text-xs text-xert-pale/65 mt-0.5">{row.detail}</p>
              </div>
              {row.tab && row.done === false && <Link className={`${GHOST} shrink-0 whitespace-nowrap`} to={tabHref(row.tab, row.month)} aria-label={`Open ${row.label}`}>Open</Link>}
            </li>
          ))}
        </ul>
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
            <article key={item.assignment_id} className="coaching-card flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-body text-xs uppercase tracking-wider text-xert-pale/60">{date === today ? 'Today' : dateName(date)}</p>
                <p className="font-display text-xl text-xert-offwhite">{at(item.start)} <span className="text-xert-pale/50 text-base">– {at(item.end)}</span></p>
                <p className="font-body text-sm text-xert-offwhite">{item.title}</p>
                <p className="font-body text-xs text-xert-pale/60">{ROLE[item.role] || item.role}{item.colleagues?.length ? ` · with ${item.colleagues.map(colleague => colleague.display_name).join(', ')}` : ''}</p>
              </div>
              {item.changed_since_publish ? <Pill tone="warning">Changed</Pill> : item.cover ? <Pill tone="warning">Cover requested</Pill> : null}
            </article>
          );
        })}
      </section>

      <nav aria-label="Coach shortcuts" className="grid grid-cols-2 gap-2">
        {SHORTCUTS.map(item => (
          <Link key={item.tab} to={tabHref(item.tab)} className="coaching-card coaching-shortcut font-body text-sm font-semibold text-xert-offwhite">
            {item.label}{item.countKey && counts[item.countKey] ? <span className="coaching-count" aria-label={`, ${counts[item.countKey]} need you`}>{counts[item.countKey]}</span> : null}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Home tab: loads the next two weeks of published classes. */
export default function CoachHome({ client, me, today, joined, counts }) {
  const [upcoming, setUpcoming] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      const data = await client.myRoster(today, addDays(today, 14));
      setUpcoming(upcomingClasses(data.assignments));
      setError(null);
    } catch (failure) { setError(failure); }
  }, [client, today]);
  useEffect(() => { load(); }, [load]);
  return <CoachHomeView me={me} today={today} upcoming={upcoming} error={error} joined={joined} counts={counts} onRetry={load} />;
}
