import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { authPathWithNext } from '@/lib/authRedirect';
import { gymDateKey } from '@/lib/gymTime';
import { staffRoster } from '@/lib/staffRosterData';
import { Banner, GHOST } from '@/components/coaching/coachingUi';
import CoachRoster from '@/components/coaching/CoachRoster';
import CoachAvailability from '@/components/coaching/CoachAvailability';
import CoachRequests from '@/components/coaching/CoachRequests';
import CoachInbox from '@/components/coaching/CoachInbox';
import CoachPT from '@/components/coaching/CoachPT';
import { ptClient } from '@/lib/ptBookingData';
import '@/components/coaching/coaching.css';

const TABS = [
  { key: 'roster', label: 'My classes' },
  { key: 'availability', label: 'Availability' },
  { key: 'requests', label: 'Requests' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'pt', label: 'PT', when: 'pt' },
];

const BLOCKED = {
  ROSTER_DISABLED: ['Coach roster isn’t switched on yet', 'The manager will let you know when it’s ready.'],
  NOT_STAFF: ['This account isn’t on the coach roster', 'If you coach at XERT, ask the manager to link this sign-in to you. No membership is needed.'],
  STAFF_INACTIVE: ['Your coach access is paused', 'Talk to the manager if this is a mistake.'],
};

function Shell({ children }) {
  return (
    <div className="relative min-h-screen bg-xert-navy">
      <PublicNav />
      <main id="main" className="relative max-w-2xl mx-auto px-4 sm:px-6 pt-28 pb-20">{children}</main>
      <PublicFooter />
    </div>
  );
}

/**
 * Coach screens on the website (and the app's web views): published classes,
 * monthly availability, time away and cover, and roster notices. Access is by
 * staff link, not membership; every call is checked on the server.
 */
export default function Coaching({ client: injected = null }) {
  const { session, loading: authLoading } = useSupabaseAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();
  const [client, setClient] = useState(injected);
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const today = gymDateKey(new Date());
  // PT has its own switch; its tab only appears once PT booking is on.
  const [ptOn, setPtOn] = useState(false);
  useEffect(() => { ptClient().then(pt => pt.coaches()).then(result => setPtOn(Boolean(result?.enabled))).catch(() => setPtOn(false)); }, []);
  const tabs = TABS.filter(item => !item.when || (item.when === 'pt' && ptOn));
  const tab = tabs.some(item => item.key === params.get('tab')) ? params.get('tab') : 'roster';

  useEffect(() => { if (!injected) staffRoster().then(setClient); }, [injected]);
  const loadMe = useCallback(async () => {
    if (!client) return;
    try { setMe(await client.me()); setError(null); } catch (failure) { setError(failure); }
  }, [client]);
  useEffect(() => { if (session || injected) loadMe(); }, [session, injected, loadMe]);

  const notify = useCallback((message, tone) => toast({ title: message, variant: tone === 'error' ? 'destructive' : undefined }), [toast]);
  const setParam = (key, value) => setParams(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: key !== 'tab' });

  if (authLoading && !injected) return <div className="min-h-screen flex items-center justify-center bg-xert-navy"><Loader2 className="w-6 h-6 animate-spin text-xert-steel" /></div>;
  if (!session && !injected) {
    return (
      <Shell>
        <div className="xert-card p-6 text-center space-y-4">
          <h1 className="font-display text-3xl uppercase text-xert-offwhite">Coach sign in</h1>
          <p className="font-body text-sm text-xert-pale/70">See your classes, give availability and ask for cover.</p>
          <Link to={authPathWithNext('/login', `${location.pathname}${location.search}`)} className="xert-btn-primary inline-flex min-h-[52px] items-center justify-center px-6 font-display text-base uppercase tracking-wide">Log in</Link>
        </div>
      </Shell>
    );
  }
  if (error) {
    const [title, detail] = BLOCKED[error.code] || ['Couldn’t open coach screens', error.message];
    return <Shell><Banner tone={BLOCKED[error.code] ? 'info' : 'danger'} title={title} action={BLOCKED[error.code] ? null : <button type="button" className={GHOST} onClick={loadMe}>Try again</button>}>{detail}</Banner></Shell>;
  }
  if (!me) return <Shell><p className="font-body text-sm text-xert-pale/60" role="status">Loading…</p></Shell>;

  const pendingAvailability = (me.periods || []).filter(period => period.is_open && !period.deadline_passed && !period.submission).length;
  const counts = { roster: me.pending_acknowledgements?.length || 0, availability: pendingAvailability, inbox: Number(me.unread_notifications) || 0 };

  return (
    <Shell>
      <header className="mb-5">
        <p className="font-body text-xs uppercase tracking-wider text-xert-pale/60">Coach</p>
        <h1 className="font-display text-4xl uppercase text-xert-offwhite">Hi {me.staff.display_name}</h1>
      </header>
      <div role="tablist" aria-label="Coach sections" className="coaching-tabs mb-5">
        {tabs.map(item => (
          <button key={item.key} type="button" role="tab" id={`coach-tab-${item.key}`} aria-selected={tab === item.key} aria-controls="coach-panel" onClick={() => setParam('tab', item.key)}>
            {item.label}{counts[item.key] ? <span className="coaching-count" aria-label={`, ${counts[item.key]} need you`}>{counts[item.key]}</span> : null}
          </button>
        ))}
      </div>
      <section id="coach-panel" role="tabpanel" aria-labelledby={`coach-tab-${tab}`}>
        {tab === 'roster' && <CoachRoster client={client} today={today} notify={notify} onChanged={loadMe} />}
        {tab === 'availability' && <CoachAvailability client={client} me={me} monthParam={params.get('month') || ''} setMonthParam={value => setParam('month', value)} notify={notify} onChanged={loadMe} />}
        {tab === 'requests' && <CoachRequests client={client} today={today} notify={notify} onChanged={loadMe} />}
        {tab === 'inbox' && <CoachInbox client={client} notify={notify} onChanged={loadMe} />}
        {tab === 'pt' && <CoachPT today={today} notify={notify} />}
      </section>
    </Shell>
  );
}
