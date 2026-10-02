import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Dumbbell } from 'lucide-react';
import { gymDateTimeLabel } from '@/lib/gymTime';
import { BOOKING_STATUS_WORDS, formatPrice, ptClient } from '@/lib/ptBookingData';

const BUTTON = 'xert-btn-primary inline-flex min-h-11 items-center justify-center px-4 font-display text-sm uppercase tracking-wide';

/**
 * A signed-in member's own PT on their account page: upcoming sessions with
 * their private manage link, packages with sessions left, and a way to book.
 * Shows nothing while PT booking is off and the member has nothing booked.
 */
export default function MemberPT({ client: injected = null }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    (injected ? Promise.resolve(injected) : ptClient())
      .then(client => client.memberOverview())
      .then(value => { if (live) setData(value); })
      .catch(() => { if (live) setData({ enabled: false, bookings: [], packages: [] }); });
    return () => { live = false; };
  }, [injected]);

  if (!data || (!data.enabled && !data.bookings.length && !data.packages.length)) return null;
  return (
    <section className="mb-10" aria-labelledby="member-pt-heading">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 id="member-pt-heading" className="font-display text-2xl uppercase text-xert-pale/85">Personal training</h2>
        {data.enabled && <Link to="/pt" className={BUTTON}>Book PT</Link>}
      </div>
      {data.bookings.length === 0 && data.packages.length === 0 ? (
        <div className="xert-card p-6 flex flex-wrap items-center gap-4">
          <span className="xert-icon-tile"><Dumbbell className="w-5 h-5" /></span>
          <p className="font-body text-sm flex-1 min-w-[12rem] text-xert-pale/60">
            No PT booked. Pick a coach, see their prices and choose a time that suits you.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.packages.map(pack => (
            <div key={pack.id} className="xert-card p-5 flex flex-wrap items-center gap-4">
              <span className="xert-icon-tile"><Dumbbell className="w-5 h-5" /></span>
              <div className="flex-1 min-w-[12rem]">
                <p className="font-display text-xl uppercase leading-tight text-xert-offwhite">{pack.name}</p>
                <p className="font-body text-sm mt-1 text-xert-pale/60">
                  With {pack.coach_name} · {pack.remaining} of {pack.sessions_total} left{pack.expires_on ? ` · use by ${pack.expires_on}` : ''}
                </p>
              </div>
              <span className="xert-chip">{pack.paid ? 'Paid' : `${formatPrice(pack.price_cents)} to pay your coach`}</span>
            </div>
          ))}
          {data.bookings.map(booking => (
            <div key={booking.id} className="xert-card p-5 flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-[12rem]">
                <p className="font-display text-xl uppercase leading-tight text-xert-offwhite">{booking.service_name} with {booking.coach_name}</p>
                <p className="font-body text-sm mt-1 text-xert-pale/60">{gymDateTimeLabel(booking.starts_at)}</p>
              </div>
              <span className="xert-chip">{BOOKING_STATUS_WORDS[booking.status] || booking.status}</span>
              <Link to={`/pt/booking?token=${booking.token}`} className="font-body text-sm underline text-xert-steel">View or cancel</Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
