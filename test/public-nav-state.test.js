import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/components/public/nav/navState.js';
import * as navTokens from '../src/components/public/nav/navTokens.js';
const now = new Date('2026-09-09T00:00:00Z');
const upcoming = { id: 'next', title: 'Strength', start_time: '2026-09-09T02:00:00Z', status: 'published', public_visible: true, booking_mode: 'request_to_book', coach_name: 'Sam' };

test('next class ignores private, draft, cancelled and past rows and sorts by start', () => {
  assert.equal(typeof model.nextPublicClass, 'function');
  assert.equal(model.nextPublicClass([
    { ...upcoming, id: 'later', start_time: '2026-09-10T02:00:00Z' },
    { ...upcoming, id: 'private', public_visible: false },
    { ...upcoming, id: 'draft', status: 'draft' },
    { ...upcoming, id: 'cancelled', status: 'cancelled' },
    { ...upcoming, id: 'past', start_time: '2026-09-08T02:00:00Z' }, upcoming,
  ], now)?.id, 'next');
  assert.equal(model.nextPublicClass([], now), null);
});

test('next class action uses request, waitlist, pause and provider rules without booking directly', () => {
  assert.equal(typeof model.nextClassAction, 'function');
  const availability = { spots_left: 2, bookings_open: true, capacity: 8 };
  assert.deepEqual(model.nextClassAction(upcoming, availability, { bookingsEnabled: true }, now), { label: 'Request spot', to: '/timetable?session=next', spots: '2 spots left' });
  assert.equal(model.nextClassAction(upcoming, { ...availability, waiting: 1 }, { bookingsEnabled: true }, now).label, 'Join the waitlist');
  assert.equal(model.nextClassAction(upcoming, { ...availability, bookings_open: false }, {}, now).label, 'Register interest');
  assert.equal(model.nextClassAction(upcoming, availability, { fitbox: { blocked: true } }, now).label, 'View timetable');
  assert.equal(model.nextClassAction(upcoming, null, { bookingsEnabled: true }, now).spots, 'Availability to be confirmed');
});

test('account strip retains pending and waitlisted status, excludes cancellations and never invents a name', () => {
  assert.equal(typeof model.accountSummary, 'function');
  const bookings = [{ ...upcoming, status: 'cancelled' }, { ...upcoming, id: 'wait', status: 'waitlisted', session_title: 'Strength' }];
  assert.deepEqual(model.accountSummary(null, null, bookings, now), { signedIn: false, name: null, nextBooking: null });
  const result = model.accountSummary({ id: 'u' }, { full_name: 'Alex Morgan' }, bookings, now);
  assert.equal(result.name, 'Alex Morgan');
  assert.equal(result.nextBooking.status, 'waitlisted');
  assert.equal(model.accountSummary({ id: 'u' }, null, [], now).name, 'Your account');
});

test('provider-controlled classes do not promise places from native availability', () => {
  const availability = { spots_left: 2, bookings_open: true, capacity: 8 };
  assert.equal(model.nextClassAction(upcoming, availability, { fitbox: { active: true } }, now).spots, 'Check availability in FitBox');
  assert.equal(model.nextClassAction(upcoming, availability, { fitbox: { blocked: true } }, now).spots, 'Availability to be confirmed');
});

test('today status uses gym date and makes no unsupported opening-hours claim', () => {
  assert.equal(typeof model.todayStatus, 'function');
  assert.equal(model.todayStatus([upcoming], now), '1 upcoming class today · Visits by booking');
  assert.equal(model.todayStatus([], now), 'No more published classes today · Check the timetable');
});

test('desktop cleanup and layout can share a media query from the current generated breakpoint', () => {
  assert.equal(typeof navTokens.navDesktopMediaQuery, 'function');
  assert.equal(navTokens.navDesktopMediaQuery({ getPropertyValue: key => key === '--nav-breakpoint-desktop' ? ' 72rem ' : '' }), '(min-width: 72rem)');
});
