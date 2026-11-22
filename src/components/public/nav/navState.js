import { classSignupState, spotsLabel } from '../../../lib/classSignup.js';
import { gymDateKey } from '../../../lib/gymTime.js';

const future = (rows, now) => (rows || []).filter(row => Date.parse(row.start_time) > now.getTime()).sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
const published = rows => (rows || []).filter(row => row.public_visible !== false && ['published', 'full'].includes(row.status));

export function nextPublicClass(rows, now = new Date()) {
  return future(published(rows), now)[0] || null;
}

export function nextClassAction(session, availability, options = {}, now = new Date()) {
  const state = classSignupState({ session, availability, ...options, now });
  return {
    label: state.actionable ? state.label : 'View timetable',
    to: `/timetable?session=${encodeURIComponent(session.id)}`,
    spots: options.fitbox?.blocked ? 'Availability to be confirmed'
      : options.fitbox?.active ? 'Check availability in FitBox'
        : spotsLabel(availability) || 'Availability to be confirmed',
  };
}

export function accountSummary(user, profile, bookings, now = new Date()) {
  if (!user) return { signedIn: false, name: null, nextBooking: null };
  return {
    signedIn: true,
    name: profile?.full_name?.trim() || user.user_metadata?.full_name?.trim() || 'Your account',
    nextBooking: future((bookings || []).filter(row => ['confirmed', 'requested', 'waitlisted'].includes(row.status)), now)[0] || null,
  };
}

export function todayStatus(rows, now = new Date()) {
  const count = future(published(rows), now).filter(row => gymDateKey(row.start_time) === gymDateKey(now)).length;
  return count ? `${count} upcoming class${count === 1 ? '' : 'es'} today · Visits by booking` : 'No more published classes today · Check the timetable';
}
