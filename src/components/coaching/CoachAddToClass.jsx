import React, { useCallback, useEffect, useState } from 'react';
import { Banner, BUTTON, GHOST, INPUT, LABEL, Pill, when } from '@/components/coaching/coachingUi';

// Adding somebody to a class from the coach screens: pick an upcoming class,
// then either find a registered member or type in a walk-in. Lead coaches can
// always do this; anyone else on the roster once the manager allows it. The
// database decides both, so this screen only appears for people it lets in.

const EMPTY_WALK_IN = { fullName: '', phone: '', email: '' };

function placesLabel(item) {
  const held = Number(item.held) || 0;
  const capacity = Number(item.capacity) || 0;
  if (item.status === 'full' || (capacity && held >= capacity)) {
    return { tone: 'warning', text: `Full${item.waiting ? ` · ${item.waiting} waiting` : ''}` };
  }
  return { tone: 'neutral', text: `${held} of ${capacity} booked` };
}

export default function CoachAddToClass({ client, notify }) {
  const [classes, setClasses] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [walkIn, setWalkIn] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setClasses(await client.upcomingClasses(14)); setLoadError(null); } catch (failure) { setLoadError(failure); }
  }, [client]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) { setResults([]); setSearching(false); return undefined; }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      client.searchMembers(term)
        .then(found => { if (active) setResults(found || []); })
        .catch(() => { if (active) setResults([]); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [client, search]);

  const choose = item => { setSelected(item); setSearch(''); setResults([]); setWalkIn(null); };

  const done = async message => {
    notify(message);
    setSearch(''); setResults([]); setWalkIn(null);
    // The class stays chosen and its count refreshes, so the next person is one tap away.
    await load();
  };

  const book = async member => {
    setBusy(true);
    try {
      const receipt = await client.bookMember(selected.id, member.id);
      await done(receipt?.booking_status === 'waitlisted'
        ? `${member.full_name || 'They'} added to the waitlist for ${selected.title}.`
        : `${member.full_name || 'They'} booked into ${selected.title}.`);
    } catch (failure) { notify(failure.message, 'error'); } finally { setBusy(false); }
  };

  const addWalkIn = async event => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await client.addWalkIn(selected.id, walkIn);
      await done(result?.status === 'waitlisted'
        ? `${result.full_name} added to the waitlist for ${selected.title}.`
        : `${result.full_name} added to ${selected.title}.`);
    } catch (failure) { notify(failure.message, 'error'); } finally { setBusy(false); }
  };

  if (loadError) {
    return <Banner tone="danger" title="Couldn’t load classes" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{loadError.message}</Banner>;
  }
  if (!classes) return <p className="font-body text-sm text-xert-pale/60" role="status">Loading classes…</p>;

  if (!selected) {
    return (
      <div className="space-y-3">
        <p className="font-body text-sm text-xert-pale/70">Choose the class to add someone to. Showing the next two weeks.</p>
        {classes.length === 0 && <p className="font-body text-sm text-xert-pale/60">No upcoming classes are taking bookings.</p>}
        <ul className="space-y-2">
          {classes.map(item => {
            const places = placesLabel(item);
            return (
              <li key={item.id}>
                <button type="button" onClick={() => choose(item)} className="w-full rounded-xl border border-xert-steel/25 px-4 py-3 text-left transition-colors hover:border-xert-steel/60" aria-label={`Add someone to ${item.title}, ${when(item.start)}`}>
                  <span className="block font-display text-lg uppercase text-xert-offwhite">{item.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 font-body text-xs text-xert-pale/70">{when(item.start)}{item.location ? ` · ${item.location}` : ''}<Pill tone={places.tone}>{places.text}</Pill></span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const current = classes.find(item => item.id === selected.id) || selected;
  const places = placesLabel(current);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-xl uppercase text-xert-offwhite">{current.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 font-body text-xs text-xert-pale/70">{when(current.start)}<Pill tone={places.tone}>{places.text}</Pill></p>
        </div>
        <button type="button" className={GHOST} onClick={() => setSelected(null)}>Change class</button>
      </div>

      {!walkIn && (
        <div>
          <label className={LABEL} htmlFor="coach-add-search">Find a registered member</label>
          <input id="coach-add-search" className={INPUT} value={search} onChange={event => setSearch(event.target.value)} placeholder="Type a name or email" autoComplete="off" enterKeyHint="search" />
          {searching && <p className="mt-2 font-body text-xs text-xert-pale/60" role="status">Searching…</p>}
          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-xert-steel/15 rounded-xl border border-xert-steel/25" aria-label="Matching members">
              {results.map(member => (
                <li key={member.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="min-w-0">
                    <span className="block truncate font-body text-sm text-xert-offwhite">{member.full_name || 'No name on account'}</span>
                    {member.email_hint && <span className="block truncate font-body text-xs text-xert-pale/60">{member.email_hint}</span>}
                  </span>
                  <button type="button" className={GHOST} disabled={busy} onClick={() => book(member)} aria-label={`Add ${member.full_name || member.email_hint} to ${current.title}`}>Add</button>
                </li>
              ))}
            </ul>
          )}
          {search.trim().length >= 2 && !searching && results.length === 0 && (
            <p className="mt-2 font-body text-xs text-xert-pale/60">No registered member matches “{search.trim()}”.</p>
          )}
          <button type="button" className={`${GHOST} mt-3`} onClick={() => setWalkIn({ ...EMPTY_WALK_IN, fullName: search.trim().includes('@') ? '' : search.trim() })}>
            Not registered? Add a walk-in
          </button>
        </div>
      )}

      {walkIn && (
        <form onSubmit={addWalkIn} className="space-y-3" aria-label="Add a walk-in">
          <p className="font-body text-sm text-xert-pale/70">For someone without an account. Add an email and they’ll get the usual booking confirmation.</p>
          <div>
            <label className={LABEL} htmlFor="coach-walk-in-name">Name</label>
            <input id="coach-walk-in-name" className={INPUT} value={walkIn.fullName} onChange={event => setWalkIn({ ...walkIn, fullName: event.target.value })} autoComplete="off" required minLength={2} maxLength={120} />
          </div>
          <div>
            <label className={LABEL} htmlFor="coach-walk-in-phone">Phone (optional)</label>
            <input id="coach-walk-in-phone" className={INPUT} type="tel" inputMode="tel" value={walkIn.phone} onChange={event => setWalkIn({ ...walkIn, phone: event.target.value })} autoComplete="off" maxLength={40} />
          </div>
          <div>
            <label className={LABEL} htmlFor="coach-walk-in-email">Email (optional)</label>
            <input id="coach-walk-in-email" className={INPUT} type="email" inputMode="email" autoCapitalize="none" value={walkIn.email} onChange={event => setWalkIn({ ...walkIn, email: event.target.value })} autoComplete="off" maxLength={320} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={BUTTON} disabled={busy || walkIn.fullName.trim().length < 2}>{busy ? 'Adding…' : 'Add to class'}</button>
            <button type="button" className={GHOST} onClick={() => setWalkIn(null)}>Back to search</button>
          </div>
        </form>
      )}
    </div>
  );
}
