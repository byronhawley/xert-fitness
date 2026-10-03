import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { staffRoster } from '@/lib/staffRosterData';
import { planningContext } from '@/lib/staffRoster/snapshot';

/**
 * One month of planning data. The snapshot is the only read; every edit goes
 * to the database, which answers with the new draft version, and the screen
 * reloads so what it shows is always what the server holds.
 */
export function useRosterMonth(month, { client: injected = null } = {}) {
  const [client, setClient] = useState(injected);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (injected) { setClient(injected); return; }
    let live = true;
    staffRoster().then(value => { if (live) setClient(value); });
    return () => { live = false; };
  }, [injected]);

  const reload = useCallback(async () => {
    if (!client) return null;
    const ticket = ++generation.current;
    setLoading(true);
    try {
      const next = await client.snapshot(month);
      if (ticket === generation.current) { setSnapshot(next); setError(null); }
      return next;
    } catch (failure) {
      if (ticket === generation.current) setError(failure);
      return null;
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, [client, month]);

  useEffect(() => { reload(); }, [reload]);

  // While another month loads, the last month's snapshot must never be shown
  // (or edited) under the new month's name.
  const current = snapshot && (!snapshot.month || String(snapshot.month).slice(0, 7) === month) ? snapshot : null;
  const now = useMemo(() => Date.now(), [current]);
  const draftCtx = useMemo(() => (current ? planningContext(current, { view: 'draft', now }) : null), [current, now]);
  const publishedCtx = useMemo(() => (current ? planningContext(current, { view: 'published', now }) : null), [current, now]);

  /** Runs a mutation, then reloads. Stale versions reload and rethrow so the caller can say so. */
  const mutate = useCallback(async action => {
    setBusy(true);
    try {
      const result = await action(client);
      await reload();
      return result;
    } catch (failure) {
      if (failure.code === 'STALE_VERSION') await reload();
      throw failure;
    } finally {
      setBusy(false);
    }
  }, [client, reload]);

  return { client, snapshot: current, draftCtx, publishedCtx, error, loading, busy, reload, mutate, now };
}
