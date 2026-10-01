import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, GHOST, when } from './coachingUi';

/** Roster notices. Opening the list doesn't mark anything read; the coach does. */
export default function CoachInbox({ client, notify, onChanged }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try { setItems(await client.myNotifications(50)); setError(null); } catch (failure) { setError(failure); }
  }, [client]);
  useEffect(() => { load(); }, [load]);
  const markRead = async ids => {
    try { await client.markNotificationsRead(ids); await load(); onChanged?.(); } catch (failure) { notify(failure.message, 'error'); }
  };

  if (error) return <Banner tone="danger" title="Couldn’t load notices" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>;
  if (!items) return <p className="font-body text-sm text-xert-pale/60" role="status">Loading…</p>;
  const unread = items.filter(item => !item.read_at);
  return (
    <div className="space-y-3">
      {unread.length > 1 && <button type="button" className={GHOST} onClick={() => markRead(unread.map(item => item.id))}>Mark all {unread.length} as read</button>}
      {items.length === 0 && <p className="font-body text-sm text-xert-pale/60">No notices yet.</p>}
      <ul className="space-y-2">
        {items.map(item => (
          <li key={item.id} className="coaching-card space-y-1" data-changed={!item.read_at}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-body text-sm font-semibold text-xert-offwhite">{!item.read_at && <span className="sr-only">Unread: </span>}{item.title}</p>
              <span className="font-body text-xs text-xert-pale/50 shrink-0">{when(item.created_at)}</span>
            </div>
            {item.body && <p className="font-body text-sm text-xert-pale/75">{item.body}</p>}
            <div className="flex flex-wrap gap-2">
              {item.link && item.link.startsWith('/coaching') && <Link className={GHOST} to={item.link} onClick={() => !item.read_at && markRead([item.id])}>Open</Link>}
              {!item.read_at && <button type="button" className={GHOST} onClick={() => markRead([item.id])}>Mark read</button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
