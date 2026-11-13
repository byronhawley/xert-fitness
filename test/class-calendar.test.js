import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classSessionFromTemplate,
  classSessionSeedForDate,
  classTemplateEditorForm,
  classTemplateEditorIsDirty,
  classTemplateFromSession,
  classTemplateValidationError,
  dateFromKey,
  formatStartMinute,
  groupSessionsByDay,
  isPastDayKey,
  localDateKey,
  minutesFromTimeInput,
  monthGrid,
  monthSessionStats,
  normalizeClassTemplate,
  shiftMonth,
  timeInputFromMinutes,
  upcomingDayKeys,
  reconcileSelectedDayKey,
} from '../src/lib/classCalendar.js';

const validTemplate = {
  name: 'Morning Engine',
  class_type: 'XERT Engine',
  title: 'Engine Builder',
  description: 'Aerobic intervals',
  coach_name: 'Sam',
  duration_minutes: 45,
  capacity: 12,
  location_zone: 'Main floor',
  beginner_friendly: true,
  intensity_level: 'High',
  booking_mode: 'request_to_book',
  default_start: '06:00',
  notes: 'Bring a towel',
};

test('local date keys round-trip and reject malformed keys', () => {
  const date = new Date(2026, 8, 5, 14, 30);
  assert.equal(localDateKey(date), '2026-09-05');
  assert.equal(dateFromKey('2026-09-05').getTime(), new Date(2026, 8, 5).getTime());
  assert.equal(dateFromKey('2026-02-30'), null);
  assert.equal(dateFromKey('not-a-date'), null);
  assert.equal(localDateKey('garbage'), null);
});

test('month grid starts on Monday and pads with neighbouring months', () => {
  // September 2026: the 1st is a Tuesday, the 30th a Wednesday.
  const grid = monthGrid(2026, 8, { now: new Date(2026, 8, 10) });
  assert.equal(grid.label, 'September 2026');
  assert.equal(grid.weeks.length, 5);
  assert.ok(grid.weeks.every(week => week.length === 7));

  const [firstCell] = grid.weeks[0];
  assert.equal(firstCell.key, '2026-08-31');
  assert.equal(firstCell.inMonth, false);
  assert.equal(grid.weeks[0][1].key, '2026-09-01');
  assert.equal(grid.weeks[0][1].inMonth, true);

  const lastWeek = grid.weeks[grid.weeks.length - 1];
  assert.equal(lastWeek[2].key, '2026-09-30');
  assert.equal(lastWeek[3].key, '2026-10-01');
  assert.equal(lastWeek[3].inMonth, false);

  const today = grid.weeks.flat().find(cell => cell.isToday);
  assert.equal(today?.key, '2026-09-10');
});

test('month grid handles a Monday-starting month without a leading pad row', () => {
  // June 2026 starts on a Monday and has 30 days.
  const grid = monthGrid(2026, 5, { now: new Date(2026, 0, 1) });
  assert.equal(grid.weeks[0][0].key, '2026-06-01');
  assert.equal(grid.weeks.length, 5);
  assert.equal(grid.weeks.flat().some(cell => cell.isToday), false);
});

test('shiftMonth wraps across year boundaries', () => {
  assert.deepEqual(shiftMonth({ year: 2026, monthIndex: 11 }, 1), { year: 2027, monthIndex: 0 });
  assert.deepEqual(shiftMonth({ year: 2026, monthIndex: 0 }, -1), { year: 2025, monthIndex: 11 });
});

test('sessions group by the gym day, sort by start time, and isolate undated drafts', () => {
  // Brisbane is UTC+10 all year, so these are 5:00 pm and 6:00 am on the 5th,
  // and 6:00 am on the 6th, at the gym — regardless of the machine's own clock.
  const sessions = [
    { id: 'b', title: 'Later', start_time: '2026-09-05T07:00:00Z' },
    { id: 'a', title: 'Earlier', start_time: '2026-09-04T20:00:00Z' },
    { id: 'c', title: 'Other day', start_time: '2026-09-05T20:00:00Z' },
    { id: 'd', title: 'No time yet', start_time: null },
  ];
  const { byDay, undated } = groupSessionsByDay(sessions);
  assert.deepEqual(byDay['2026-09-05'].map(s => s.id), ['a', 'b']);
  assert.deepEqual(byDay['2026-09-06'].map(s => s.id), ['c']);
  assert.deepEqual(undated.map(s => s.id), ['d']);

  // The whole point: a UTC process files the 6:00 am class under the 4th if it
  // uses the machine clock. The gym's morning class belongs to the gym's day.
  assert.equal(new Date('2026-09-04T20:00:00Z').toISOString().slice(0, 10), '2026-09-04');
  assert.ok(byDay['2026-09-04'] === undefined);

  const stats = monthSessionStats({
    '2026-09-05': [{ status: 'published' }, { status: 'draft' }],
    '2026-09-06': [{ status: 'full' }],
    '2026-10-01': [{ status: 'published' }],
  }, 2026, 8);
  assert.deepEqual(stats, { total: 3, published: 2 });
});

test('time-of-day conversion is strict in both directions', () => {
  assert.equal(minutesFromTimeInput('06:30'), 390);
  assert.equal(minutesFromTimeInput('24:00'), null);
  assert.equal(minutesFromTimeInput('9:15'), null);
  assert.equal(timeInputFromMinutes(390), '06:30');
  assert.equal(timeInputFromMinutes(1440), '');
  assert.equal(timeInputFromMinutes(null), '');
  assert.equal(formatStartMinute(390), new Date(2026, 0, 1, 6, 30).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }));
  assert.equal(formatStartMinute(null), 'Flexible time');
});

test('normalizeClassTemplate validates and defaults the title to the bank name', () => {
  const normalized = normalizeClassTemplate({ ...validTemplate, title: '  ' });
  assert.equal(normalized.title, 'Morning Engine');
  assert.equal(normalized.default_start_minute, 360);
  assert.equal(normalized.description, 'Aerobic intervals');

  assert.equal(classTemplateValidationError(validTemplate), null);
  assert.match(classTemplateValidationError({ ...validTemplate, name: ' ' }), /needs a name/);
  assert.match(classTemplateValidationError({ ...validTemplate, class_type: 'Yoga' }), /class type/);
  assert.match(classTemplateValidationError({ ...validTemplate, capacity: 0 }), /Capacity/);
  assert.match(classTemplateValidationError({ ...validTemplate, duration_minutes: 2.5 }), /Duration/);
  assert.match(classTemplateValidationError({ ...validTemplate, default_start: '25:99' }), /start time/);

  // A flexible-time entry is allowed.
  assert.equal(normalizeClassTemplate({ ...validTemplate, default_start: '' }).default_start_minute, null);
});

test('template editor form is stable and dirty-tracking matches the session editor pattern', () => {
  const form = classTemplateEditorForm(normalizeClassTemplate(validTemplate));
  assert.equal(form.default_start, '06:00');
  assert.equal(classTemplateEditorIsDirty(form, normalizeClassTemplate(validTemplate)), false);
  assert.equal(classTemplateEditorIsDirty({ ...form, capacity: 10 }, normalizeClassTemplate(validTemplate)), true);
});

test('a saved class becomes a bank entry with its usual start time captured', () => {
  const session = {
    title: 'Engine Builder',
    class_type: 'XERT Engine',
    description: 'Aerobic intervals',
    coach_name: 'Sam',
    duration_minutes: 45,
    capacity: 12,
    location_zone: 'Main floor',
    beginner_friendly: false,
    intensity_level: 'High',
    booking_mode: 'instant_book',
    start_time: new Date(2026, 8, 5, 17, 30).toISOString(),
    notes: null,
  };
  const template = classTemplateFromSession(session, 'PM Engine');
  assert.equal(template.name, 'PM Engine');
  assert.equal(template.default_start_minute, 17 * 60 + 30);
  assert.equal(template.booking_mode, 'instant_book');

  const undatedTemplate = classTemplateFromSession({ ...session, start_time: null }, 'Anytime Engine');
  assert.equal(undatedTemplate.default_start_minute, null);
});

test('placing a bank entry on a pressed date builds a valid class session draft', () => {
  const template = normalizeClassTemplate(validTemplate);
  const draft = classSessionFromTemplate(template, '2026-09-12');
  assert.equal(new Date(draft.start_time).getTime(), new Date(2026, 8, 12, 6, 0).getTime());
  assert.equal(new Date(draft.end_time).getTime(), new Date(2026, 8, 12, 6, 45).getTime());
  assert.equal(draft.status, 'draft');
  assert.equal(draft.public_visible, false);
  assert.equal(draft.title, 'Engine Builder');

  const published = classSessionFromTemplate(template, '2026-09-12', { startTime: '17:15', publish: true });
  assert.equal(new Date(published.start_time).getTime(), new Date(2026, 8, 12, 17, 15).getTime());
  assert.equal(published.status, 'published');
  assert.equal(published.public_visible, true);

  const flexible = classSessionFromTemplate({ ...template, default_start_minute: null }, '2026-09-12');
  assert.equal(new Date(flexible.start_time).getTime(), new Date(2026, 8, 12, 6, 0).getTime());

  assert.throws(() => classSessionFromTemplate(template, 'nope'), /valid calendar date/);
  assert.throws(() => classSessionFromTemplate(template, '2026-09-12', { startTime: '99:00' }), /start time/);
  assert.throws(() => classSessionFromTemplate({ ...template, duration_minutes: 0 }, '2026-09-12'), /duration/);
});

test('pressing an empty date seeds the custom class editor with that day', () => {
  const seed = classSessionSeedForDate('2026-09-12');
  assert.equal(new Date(seed.start_time).getTime(), new Date(2026, 8, 12, 6, 0).getTime());
  assert.equal(new Date(seed.end_time).getTime(), new Date(2026, 8, 12, 7, 0).getTime());
  assert.equal(seed.duration_minutes, 60);
  assert.equal(classSessionSeedForDate('bad-key'), null);
});

test('upcoming day keys and past-day checks respect the local day boundary', () => {
  const byDay = {
    '2026-09-01': [{}],
    '2026-09-10': [{}],
    '2026-09-11': [{}],
    '2026-09-20': [{}],
  };
  const now = new Date(2026, 8, 10, 12, 0);
  assert.deepEqual(upcomingDayKeys(byDay, { now, limit: 2 }), ['2026-09-10', '2026-09-11']);
  assert.equal(isPastDayKey('2026-09-09', now), true);
  assert.equal(isPastDayKey('2026-09-10', now), false);
  assert.equal(isPastDayKey('2026-09-11', now), false);
});

test('filtered calendar selection moves off an empty day without overriding a matching day', () => {
  const byDay = {
    '2026-11-17': [{ id: 'one' }],
    '2026-11-18': [{ id: 'two' }],
  };
  assert.equal(reconcileSelectedDayKey('2026-11-17', byDay, ['2026-11-17', '2026-11-18']), '2026-11-17');
  assert.equal(reconcileSelectedDayKey('2026-11-13', byDay, ['2026-11-17', '2026-11-18']), '2026-11-17');
  assert.equal(reconcileSelectedDayKey('2026-11-13', {}, []), '2026-11-13');
});
