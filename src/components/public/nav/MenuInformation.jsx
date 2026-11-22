import React from 'react';
import { fitboxHandoff } from '@/lib/launchSettings';
import { gymTimeLabel, GYM_TIME_ZONE } from '@/lib/gymTime';
import { accountSummary, nextClassAction, nextPublicClass, todayStatus } from './navState';
import useMenuData from './useMenuData';
import { Link as NavLink } from 'react-router-dom';

function classTime(value) {
  return `${new Date(value).toLocaleDateString('en-AU', { timeZone: GYM_TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' })} · ${gymTimeLabel(value)}`;
}

export default function MenuInformation({ user, profile, close }) {
  const { data, retry } = useMenuData(user?.id);
  const [sessions, availability, settings] = data?.classes || [];
  const next = nextPublicClass(sessions);
  const action = next ? nextClassAction(next, availability[next.id], { bookingsEnabled: settings?.bookings_enabled, fitbox: fitboxHandoff(settings) }) : null;
  const account = accountSummary(user, profile, data?.bookings);
  const phone = typeof data?.contact?.phone === 'string' ? data.contact.phone.trim() : '';
  return <div className="public-menu-information">
    <section aria-label="Next class" className="public-menu-card" aria-busy={!data}>
      <h2 className="public-menu-eyebrow">Next class</h2>
      {!data ? <p role="status" className="public-menu-skeleton">Loading class information…</p> : !data.classes ? <>
        <p>Class information is unavailable.</p>
        <button type="button" onClick={retry} className="public-menu-text-action">Retry class information</button>
        <NavLink to="/timetable" onClick={close} className="public-menu-text-action">View timetable</NavLink>
      </> : next ? <>
        <p className="public-menu-class-title">{next.title}</p>
        <p>{classTime(next.start_time)}</p>
        <p>{next.coach_name || 'Coach to be confirmed'} · {action.spots}</p>
        <NavLink to={action.to} onClick={close} className="public-menu-text-action">{action.label}</NavLink>
      </> : <><p>No upcoming classes published.</p><NavLink to="/timetable" onClick={close} className="public-menu-text-action">View timetable</NavLink></>}
    </section>
    {account.signedIn && <section aria-label="Your account" className="public-menu-card">
        <h2 className="public-menu-account-name">{account.name}</h2>
        {!data ? <p role="status">Loading your next booking…</p> : data.bookings === null ? <>
          <p>Your bookings are unavailable.</p><button type="button" className="public-menu-text-action" onClick={retry}>Retry your bookings</button>
        </> : account.nextBooking ? <p>Next booking: {account.nextBooking.session_title || account.nextBooking.title || 'Class'} · {classTime(account.nextBooking.start_time)} · {account.nextBooking.status}</p> : <p>No upcoming bookings.</p>}
        <NavLink to="/account" onClick={close} className="public-menu-text-action">Account</NavLink>
    </section>}
    <div className="public-menu-contact">
      {phone ? <a href={`tel:${phone.replace(/\s+/g, '')}`} className="public-menu-text-action">Call the gym · {phone}</a> : <NavLink to="/contact" onClick={close} className="public-menu-text-action">Contact XERT</NavLink>}
      <p>{typeof data?.contact?.opening_hours === 'string' && data.contact.opening_hours.trim() ? data.contact.opening_hours : data?.classes ? todayStatus(sessions) : 'Check the timetable for today’s classes.'}</p>
    </div>
  </div>;
}
