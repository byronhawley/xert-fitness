import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shiftDayKey } from '../src/lib/classCalendar.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('arrow keys move a day at a time across month and year boundaries', () => {
  assert.equal(shiftDayKey('2026-09-15', 1), '2026-09-16');
  assert.equal(shiftDayKey('2026-09-15', -7), '2026-09-08');
  assert.equal(shiftDayKey('2026-09-30', 1), '2026-10-01');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDayKey('2026-09-15', 0), '2026-09-15');
  assert.equal(shiftDayKey('not-a-day', 1), null);
  assert.equal(shiftDayKey('2026-09-15', 1.5), null);
});

test('the month grid is one tab stop with arrow keys inside it', async () => {
  const calendar = await read('../src/components/public/PublicClassCalendar.jsx');
  assert.match(calendar, /tabIndex=\{cell\.key === selectedDayKey \? 0 : -1\}/);
  assert.match(calendar, /onKeyDown=\{onGridKeyDown\}/);
  assert.match(calendar, /ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7/);
  // Weekday names are the grid's column headers, not a separate strip above it.
  assert.match(calendar, /role="row"[\s\S]{0,200}role="columnheader"/);
  // The card list is no longer a live region; a short status line is.
  assert.match(calendar, /<p className="sr-only" role="status" aria-live="polite">\{selectedStatus\}<\/p>/);
  assert.doesNotMatch(calendar, /ref=\{detailRef\}[^>]*aria-live/);
});

test('a full class offers the waitlist rather than a dead disabled button', async () => {
  const card = await read('../src/components/public/ClassSessionCard.jsx');
  assert.match(card, /signup\.kind === 'request' \|\| signup\.kind === 'interest' \|\| signup\.kind === 'waitlist'/);
  assert.doesNotMatch(card, /signup\.kind === 'full'/);
  // "Spots left 8 / 8" above "no spot is held yet" read as a bookable class.
  assert.match(card, /\{signup\.takesSpot \? 'Spots left' : 'Capacity'\}/);
});

test('a spot taken through the timetable can be handed back', async () => {
  const [forms, page, app, timetable] = await Promise.all([
    read('../src/lib/submitForms.js'),
    read('../src/pages/ReleaseClassSpot.jsx'),
    read('../src/App.jsx'),
    read('../src/pages/SoftLaunchTimetable.jsx'),
  ]);
  assert.match(forms, /supabase\.rpc\('cancel_class_signup', \{ p_token: trimmed \}\)/);
  assert.match(app, /<Route path="\/timetable\/release" element=\{<ReleaseClassSpot \/>\} \/>/);
  assert.match(page, /cancelClassSignup\(token\)/);
  assert.match(timetable, /successCopy\.cancelToken/);
  // And the anonymous side door into class_bookings is closed.
  assert.doesNotMatch(forms, /requestClassBooking/);
  assert.match(forms, /p_join_waitlist: formData\.join_waitlist === true/);
});

test('the timetable keeps its counts and its context current', async () => {
  const timetable = await read('../src/pages/SoftLaunchTimetable.jsx');
  // Stale counts sent people into a sign-up that was already doomed.
  assert.match(timetable, /document\.addEventListener\('visibilitychange', onFocus\)/);
  assert.match(timetable, /onRejected=\{refreshAvailability\}/);
  // A link to one class lands on that class, not the top of the page.
  assert.match(timetable, /searchParams\.get\('session'\)/);
  assert.match(timetable, /initialDayKey=\{deepLinkedSession \? gymDateKey\(deepLinkedSession\.start_time\) : null\}/);
  // And the sticky button no longer pulls phone visitors off the one page
  // where they can actually sign up.
  assert.doesNotMatch(timetable, /StickyMobileCTA/);
});

test('the booking page offers the same calendar as the timetable', async () => {
  const [booking, calendar] = await Promise.all([
    read('../src/pages/Booking.jsx'),
    read('../src/components/public/PublicClassCalendar.jsx'),
  ]);
  // "Book your first session" lands here; it used to be a list starting at
  // whichever day was next, with no way to pick another day.
  assert.match(booking, /<PublicClassCalendar[\s\S]{0,200}renderSession=\{renderSessionRow\}/);
  assert.match(booking, /useState\('calendar'\)/);
  // A link to one class opens the calendar on that class's day.
  assert.match(booking, /initialDayKey=\{targetSession \? gymDateKey\(targetSession\.start_time\) : null\}/);
  assert.match(calendar, /renderSession \? renderSession\(session\) :/);
});

test('a calendar chip does not repeat the time a class name already carries', async () => {
  const { chipTitle } = await import('../src/lib/classCalendar.js');
  assert.equal(chipTitle('5:15am training session'), 'Training session');
  assert.equal(chipTitle('6:15am Training session'), 'Training session');
  assert.equal(chipTitle('Group class/ open gym 2:30pm'), 'Group class/ open gym');
  assert.equal(chipTitle('8:00 am group class'), 'Group class');
  assert.equal(chipTitle('Strength'), 'Strength');
  assert.equal(chipTitle('HIIT 45'), 'HIIT 45');
  // A name that is only a time is kept rather than shown blank.
  assert.equal(chipTitle('6am'), '6am');
});

test('classes that have run stay on the timetable calendar', async () => {
  const [timetable, data] = await Promise.all([
    read('../src/pages/SoftLaunchTimetable.jsx'),
    read('../src/lib/adminData.js'),
  ]);
  assert.match(timetable, /getClassSessions\(true, \{ since: /);
  // The list view is still only what's coming up.
  assert.match(timetable, /upcomingSessions\.map\(/);
  assert.match(data, /\.gt\('start_time', new Date\(since \?\? now\)\.toISOString\(\)\)/);
});
