import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import { gymDayLabel, gymTimeLabel } from '@/lib/gymTime';
import { BOOKING_STATUS_WORDS, formatPrice, ptClient } from '@/lib/ptBookingData';

const BUTTON = 'xert-btn-primary inline-flex min-h-[52px] items-center justify-center px-6 font-display text-base uppercase tracking-wide disabled:opacity-50';
const GHOST = 'xert-btn-ghost inline-flex min-h-11 items-center justify-center gap-1.5 px-4 font-body text-xs uppercase tracking-wider disabled:opacity-50';

/** The private link in a PT booking email: see the booking and cancel it. */
export default function PTBookingManage({ client: injected = null }) {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [client, setClient] = useState(injected);
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!injected) ptClient().then(setClient); }, [injected]);
  useEffect(() => {
    if (!client) return;
    if (!/^[0-9a-f-]{36}$/i.test(token)) { setError('This link isn’t complete. Open it again from your email.'); return; }
    client.booking(token).then(setBooking).catch(failure => setError(failure.message));
  }, [client, token]);

  const cancel = async () => {
    setBusy(true);
    try { setBooking(await client.cancel(token)); setConfirming(false); setError(''); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };

  const active = booking && ['requested', 'confirmed'].includes(booking.status);
  return (
    <div className="min-h-screen bg-xert-navy">
      <PublicNav />
      <main id="main" className="max-w-xl mx-auto px-6 pt-32 pb-20">
        <p className="font-body text-xs uppercase tracking-[0.2em] text-xert-steel mb-2">Personal training</p>
        <h1 className="font-display text-4xl uppercase text-xert-offwhite mb-6">Your booking</h1>
        {!booking && !error && <p className="font-body text-sm text-xert-pale/60" role="status">Loading…</p>}
        {error && <p className="font-body text-sm mb-4" role="alert" style={{ color: 'var(--state-danger-text)' }}>{error}</p>}
        {booking && (
          <div className="xert-card p-5 space-y-3">
            <p className="font-body text-xs uppercase tracking-wider text-xert-steel">{BOOKING_STATUS_WORDS[booking.status] || booking.status}</p>
            <h2 className="font-display text-2xl uppercase text-xert-offwhite">{booking.service_name} with {booking.coach_name}</h2>
            <p className="font-body text-base text-xert-pale/80">{gymDayLabel(booking.starts_at)}, {gymTimeLabel(booking.starts_at)} to {gymTimeLabel(booking.ends_at)}</p>
            <p className="font-body text-sm text-xert-pale/70">
              {booking.package ? `From your ${booking.package.name} (${booking.package.remaining} of ${booking.package.sessions_total} left).` : `${formatPrice(booking.price_cents)}, paid to your coach.`}
            </p>
            {booking.status === 'cancelled' && <p className="font-body text-sm text-xert-pale/70">{booking.cancelled_by === 'coach' ? 'Your coach cancelled this session.' : 'You cancelled this session.'}</p>}
            {booking.status === 'declined' && <p className="font-body text-sm text-xert-pale/70">Your coach couldn’t take this time.</p>}
            {active && booking.can_cancel && !confirming && <button type="button" className={GHOST} onClick={() => setConfirming(true)}>Cancel this booking</button>}
            {active && booking.can_cancel && confirming && (
              <div className="flex flex-wrap gap-2 items-center">
                <button type="button" className={BUTTON} disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : 'Yes, cancel it'}</button>
                <button type="button" className={GHOST} onClick={() => setConfirming(false)}>Keep it</button>
              </div>
            )}
            {active && !booking.can_cancel && (
              <p className="font-body text-sm text-xert-pale/70">It’s within {booking.cancel_cutoff_hours} hours of the session, so please contact your coach to change it.</p>
            )}
          </div>
        )}
        <Link to="/pt" className={`${GHOST} mt-6`}>Book personal training</Link>
      </main>
      <PublicFooter />
    </div>
  );
}
