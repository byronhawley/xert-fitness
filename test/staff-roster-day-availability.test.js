import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAvailability } from '../src/lib/staffRoster/availability.js';
import { availabilitySummary, monthClassSessions, reviewClasses } from '../src/lib/staffRoster/availabilityEditor.js';
import {
  classesByDate, dateWindows, dayCounts, dayStates, encodeClassDay, fillFromPattern, hasSharedDuty, materialize, periodDates, setClassStatus, setDay, setDayRange,
  toggleWeekday, weekPatternOf,
} from '../src/lib/staffRoster/dayAvailability.js';
import { datesOfMonth, gymInstantIso, weekdayOf } from '../src/lib/staffRoster/time.js';

// SYNTHETIC DATA ONLY: fictional classes in a fictional month.

const MONTH = '2026-12';
const EMPTY = Object.freeze({ weekly: [], exceptions: [], noAvailability: false });
const row = (id, date, minute, minutes, prep = 0, wrap = 0) => ({
  id, title: `Synthetic ${id}`, class_type: 'Synthetic',
  start: gymInstantIso(date, minute), end: gymInstantIso(date, minute + minutes),
  duty_start: gymInstantIso(date, minute - prep), duty_end: gymInstantIso(date, minute + minutes + wrap),
});
// Tue 1 Dec: 5:15 (setup 5:00) and 6:15 (setup 6:05); Wed 2 Dec: 5:30 pm. Thu 3 Dec has no classes.
const CLASSES = monthClassSessions([
  row('t515', '2026-12-01', 315, 45, 15), row('t615', '2026-12-01', 375, 45, 10), row('w530', '2026-12-02', 1050, 60),
]);
const valid = payload => assert.deepEqual(validateAvailability(payload, MONTH).errors, []);

test('marking a class day "can work" makes every class Can do with one merged window', () => {
  const answer = setDay(EMPTY, MONTH, CLASSES, '2026-12-01', 'available');
  valid(answer);
  // 5:00–6:00 and 6:05–7:00 do not touch, so two windows.
  assert.deepEqual(answer.exceptions, [
    { date: '2026-12-01', start: 300, end: 360, status: 'AVAILABLE' },
    { date: '2026-12-01', start: 365, end: 420, status: 'AVAILABLE' },
  ]);
  const review = reviewClasses(answer, MONTH, CLASSES);
  assert.deepEqual(review.rows.map(item => item.status), ['AVAILABLE', 'AVAILABLE', 'UNKNOWN'], 'the unmarked Wednesday stays not stated');
  assert.equal(dayStates(answer, MONTH, CLASSES).get('2026-12-01').state, 'available');
});

test('each class gets its own answer; Prefer and Can’t read back exactly', () => {
  let answer = setDay(EMPTY, MONTH, CLASSES, '2026-12-01', 'available');
  answer = setClassStatus(answer, MONTH, CLASSES, '2026-12-01', 't515', 'UNAVAILABLE');
  answer = setClassStatus(answer, MONTH, CLASSES, '2026-12-01', 't615', 'PREFERRED');
  valid(answer);
  const day = dayStates(answer, MONTH, CLASSES).get('2026-12-01');
  assert.deepEqual(day.classes.map(item => item.status), ['UNAVAILABLE', 'PREFERRED']);
  assert.deepEqual(reviewClasses(answer, MONTH, CLASSES).rows.slice(0, 2).map(item => item.status), ['UNAVAILABLE', 'PREFERRED']);
});

test('answering a class on an unmarked day marks the day and defaults the others to Can do', () => {
  const answer = setClassStatus(EMPTY, MONTH, CLASSES, '2026-12-01', 't615', 'UNAVAILABLE');
  assert.deepEqual(dayStates(answer, MONTH, CLASSES).get('2026-12-01').classes.map(item => item.status), ['AVAILABLE', 'UNAVAILABLE']);
});

test('adjacent windows with the same answer merge into one exception', () => {
  const back = monthClassSessions([row('a', '2026-12-01', 300, 60), row('b', '2026-12-01', 360, 60), row('c', '2026-12-01', 420, 60)]);
  const answer = setDay(EMPTY, MONTH, back, '2026-12-01', 'available');
  assert.deepEqual(answer.exceptions, [{ date: '2026-12-01', start: 300, end: 480, status: 'AVAILABLE' }]);
  const split = setClassStatus(answer, MONTH, back, '2026-12-01', 'b', 'UNAVAILABLE');
  assert.deepEqual(split.exceptions.map(item => [item.start, item.end, item.status]), [[300, 360, 'AVAILABLE'], [360, 420, 'UNAVAILABLE'], [420, 480, 'AVAILABLE']]);
  valid(split);
});

test('overlapping duties with different answers never contradict: Can’t wins the shared time', () => {
  // Two classes at the same time (shared duty) and one whose setup overlaps the first's pack-down.
  const clash = monthClassSessions([row('x', '2026-12-01', 1050, 60), row('y', '2026-12-01', 1050, 60), row('z', '2026-12-01', 1110, 60, 15)]);
  const day = classesByDate(clash).get('2026-12-01');
  assert.equal(hasSharedDuty(day), true);
  const windows = encodeClassDay(day.map(item => ({ ...item, status: { x: 'UNAVAILABLE', y: 'AVAILABLE', z: 'PREFERRED' }[item.session.id] })));
  assert.deepEqual(windows, [
    { start: 1050, end: 1110, status: 'UNAVAILABLE' },
    { start: 1110, end: 1170, status: 'PREFERRED' },
  ]);
  const payload = { ...EMPTY, exceptions: windows.map(item => ({ date: '2026-12-01', ...item })) };
  valid(payload);
  const statuses = Object.fromEntries(reviewClasses(payload, MONTH, clash).rows.map(item => [item.session.id, item.status]));
  assert.deepEqual(statuses, { x: 'UNAVAILABLE', y: 'UNAVAILABLE', z: 'UNAVAILABLE' }, 'any class touching a can’t is read as can’t (conservative)');

  // Between two positive answers the stronger covers the shared setup, so each class keeps its own answer.
  const positive = monthClassSessions([row('p', '2026-12-01', 315, 45, 0, 10), row('q', '2026-12-01', 365, 45, 10)]);
  const both = encodeClassDay(classesByDate(positive).get('2026-12-01').map(item => ({ ...item, status: item.session.id === 'p' ? 'AVAILABLE' : 'PREFERRED' })));
  const bothPayload = { ...EMPTY, exceptions: both.map(item => ({ date: '2026-12-01', ...item })) };
  valid(bothPayload);
  assert.deepEqual(reviewClasses(bothPayload, MONTH, positive).rows.map(item => item.status), ['AVAILABLE', 'PREFERRED']);
});

test('a can-work day with no classes is a free-time range, All day by default', () => {
  let answer = setDay(EMPTY, MONTH, CLASSES, '2026-12-03', 'available');
  assert.deepEqual(answer.exceptions, [{ date: '2026-12-03', start: 0, end: 1440, status: 'AVAILABLE' }]);
  answer = setDayRange(answer, MONTH, '2026-12-03', 960, 1260);
  assert.deepEqual(answer.exceptions, [{ date: '2026-12-03', start: 960, end: 1260, status: 'AVAILABLE' }]);
  assert.equal(setDayRange(answer, MONTH, '2026-12-03', 600, 500), answer, 'an end before the start is ignored');
  const day = dayStates(answer, MONTH, CLASSES).get('2026-12-03');
  assert.deepEqual([day.state, day.range.start, day.range.end], ['available', 960, 1260]);
  assert.deepEqual(dayCounts(answer, MONTH, CLASSES), { available: 1, availableNoClasses: 1, away: 0, unanswered: 30 });
});

test('away is a whole-day can’t; clearing a day leaves it not stated', () => {
  let answer = setDay(EMPTY, MONTH, CLASSES, '2026-12-01', 'available');
  answer = setDay(answer, MONTH, CLASSES, '2026-12-01', 'away');
  assert.deepEqual(answer.exceptions, [{ date: '2026-12-01', start: 0, end: 1440, status: 'UNAVAILABLE' }]);
  assert.equal(dayStates(answer, MONTH, CLASSES).get('2026-12-01').state, 'away');
  answer = setDay(answer, MONTH, CLASSES, '2026-12-01', null);
  assert.deepEqual(answer.exceptions, []);
  assert.equal(dayStates(answer, MONTH, CLASSES).get('2026-12-01').state, null);
  assert.deepEqual(reviewClasses(answer, MONTH, CLASSES).rows.map(item => item.status), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN'], 'blank is never available');
});

test('Every Tuesday marks every Tuesday, and tapping it again clears them', () => {
  const tuesdays = datesOfMonth(MONTH).filter(date => weekdayOf(date) === 2);
  const marked = toggleWeekday(EMPTY, MONTH, CLASSES, 2, 'available');
  const states = dayStates(marked, MONTH, CLASSES);
  assert.ok(tuesdays.every(date => states.get(date).state === 'available'));
  assert.equal(states.get('2026-12-08').range.start, 0, 'Tuesdays without classes are free all day');
  valid(marked);
  assert.deepEqual(toggleWeekday(marked, MONTH, CLASSES, 2, 'available').exceptions, []);
});

test('older weekly answers still read sensibly and turn into equivalent dates on the first change', () => {
  const legacy = {
    weekly: [{ weekday: 2, start: 300, end: 480, status: 'AVAILABLE' }, { weekday: 3, start: 1000, end: 1200, status: 'PREFERRED' }],
    exceptions: [{ date: '2026-12-08', start: 0, end: 1440, status: 'UNAVAILABLE' }],
    noAvailability: false,
  };
  const states = dayStates(legacy, MONTH, CLASSES);
  assert.equal(states.get('2026-12-01').state, 'available');
  assert.deepEqual(states.get('2026-12-01').classes.map(item => item.status), ['AVAILABLE', 'AVAILABLE']);
  assert.equal(states.get('2026-12-02').classes[0].status, 'PREFERRED');
  assert.equal(states.get('2026-12-08').state, 'away');
  assert.equal(states.get('2026-12-03').state, null);
  const flat = materialize(legacy, MONTH);
  assert.deepEqual(flat.weekly, []);
  valid(flat);
  assert.deepEqual(reviewClasses(flat, MONTH, CLASSES).rows, reviewClasses(legacy, MONTH, CLASSES).rows, 'same reading by the server engine');
  assert.deepEqual([...dateWindows(flat, MONTH)], [...dateWindows(legacy, MONTH)]);
  // Editing one class keeps the rest of that day's usual-week time (7:00–8:00 here).
  const edited = setClassStatus(legacy, MONTH, CLASSES, '2026-12-01', 't515', 'UNAVAILABLE');
  assert.deepEqual(edited.exceptions.filter(item => item.date === '2026-12-01').map(item => [item.start, item.end, item.status]),
    [[300, 360, 'UNAVAILABLE'], [360, 480, 'AVAILABLE']]);
  assert.equal(edited.exceptions.filter(item => item.date === '2026-12-15').length, 1, 'other Tuesdays keep their window');
  valid(edited);
});

test('usual week: read back from a month, and used to pre-fill one without touching days away', () => {
  let answer = toggleWeekday(EMPTY, MONTH, CLASSES, 4, 'available');
  answer = setDayRange(answer, MONTH, '2026-12-03', 960, 1260);
  answer = setDayRange(answer, MONTH, '2026-12-10', 960, 1260);
  answer = setDay(answer, MONTH, CLASSES, '2026-12-17', 'away');
  const pattern = weekPatternOf(answer, MONTH);
  assert.deepEqual(pattern, [{ weekday: 4, start: 960, end: 1260, status: 'AVAILABLE' }], 'the most common Thursday answer');
  const prefilled = fillFromPattern(setDay(EMPTY, MONTH, CLASSES, '2026-12-24', 'away'), MONTH, pattern);
  const states = dayStates(prefilled, MONTH, CLASSES);
  assert.equal(states.get('2026-12-24').state, 'away');
  assert.equal(states.get('2026-12-31').range.start, 960);
  valid(prefilled);
});

test('summary counts classes, days away and free days with no classes', () => {
  let answer = setDay(EMPTY, MONTH, CLASSES, '2026-12-01', 'available');
  answer = setClassStatus(answer, MONTH, CLASSES, '2026-12-01', 't615', 'PREFERRED');
  answer = setDay(answer, MONTH, CLASSES, '2026-12-02', 'away');
  answer = setDay(answer, MONTH, CLASSES, '2026-12-03', 'available');
  const summary = availabilitySummary(answer, MONTH, CLASSES);
  assert.equal(summary.sentence, 'You can do 2 classes of 3, prefer 1, can’t do 1, away 1 day, free on 1 day with no classes.');
  const noClasses = availabilitySummary(setDay(setDay(EMPTY, MONTH, [], '2026-12-05', 'away'), MONTH, [], '2026-12-04', 'available'), MONTH, []);
  assert.equal(noClasses.sentence, 'There are no classes on the timetable for this month yet. You’re free on 1 day, away 1 day.');
});

test('a busy month answered class by class stays far under the 400-exception limit', () => {
  // Eight classes a day, every day, alternating answers: the worst case for merging.
  const rows = datesOfMonth(MONTH).flatMap(date => Array.from({ length: 8 }, (_, index) => row(`${date}-${index}`, date, 300 + index * 120, 60, 10, 5)));
  const busy = monthClassSessions(rows);
  let answer = EMPTY;
  for (const date of datesOfMonth(MONTH)) {
    answer = setDay(answer, MONTH, busy, date, 'available');
    for (let index = 0; index < 8; index += 2) answer = setClassStatus(answer, MONTH, busy, date, `${date}-${index}`, 'UNAVAILABLE');
  }
  assert.equal(answer.exceptions.length, 31 * 8);
  valid(answer);
  const tooMany = { ...EMPTY, exceptions: Array.from({ length: 401 }, (_, index) => ({ date: '2026-12-01', start: index, end: index + 1, status: 'AVAILABLE' })) };
  assert.match(validateAvailability(tooMany, MONTH).errors.join(' '), /over 400/);
});

test('a part-month period (starts_on) never marks or writes days before it starts', () => {
  // Synthetic period: classes from Thu 10 Dec to the end of the month.
  const scope = { startsOn: '2026-12-10' };
  const late = monthClassSessions([row('early', '2026-12-01', 315, 45), row('late', '2026-12-15', 315, 45)]);
  assert.deepEqual(periodDates(MONTH, scope.startsOn).slice(0, 2), ['2026-12-10', '2026-12-11']);
  assert.equal(periodDates(MONTH, scope.startsOn).length, 22);
  assert.equal(periodDates(MONTH).length, 31, 'null means the whole month');
  const states = dayStates(EMPTY, MONTH, late, scope);
  assert.equal(states.get('2026-12-09').outside, true);
  assert.equal(states.get('2026-12-10').outside, false);
  assert.equal(setDay(EMPTY, MONTH, late, '2026-12-01', 'available', scope), EMPTY, 'an earlier day can’t be marked available');
  assert.equal(setDay(EMPTY, MONTH, late, '2026-12-01', 'away', scope), EMPTY, 'or away');
  assert.equal(setClassStatus(EMPTY, MONTH, late, '2026-12-01', 'early', 'AVAILABLE', scope), EMPTY);
  assert.equal(setDayRange(EMPTY, MONTH, '2026-12-02', 960, 1260, scope), EMPTY);
  const tuesdays = toggleWeekday(EMPTY, MONTH, late, 2, 'available', scope);
  assert.deepEqual([...new Set(tuesdays.exceptions.map(item => item.date))], ['2026-12-15', '2026-12-22', '2026-12-29'], 'Every Tuesday skips 1 and 8 Dec');
  const filled = fillFromPattern(EMPTY, MONTH, [{ weekday: 2, start: 300, end: 480, status: 'AVAILABLE' }], scope);
  assert.ok(filled.exceptions.every(item => item.date >= scope.startsOn), 'the usual week only fills days in the period');
  // An older weekly answer turns into dates only from starts_on onwards on the first change.
  const legacy = { weekly: [{ weekday: 2, start: 300, end: 480, status: 'AVAILABLE' }], exceptions: [], noAvailability: false };
  const edited = setDay(legacy, MONTH, late, '2026-12-22', 'away', scope);
  assert.ok(edited.exceptions.every(item => item.date >= scope.startsOn));
  valid(edited);
  assert.equal(dayCounts(edited, MONTH, late, scope).unanswered + dayCounts(edited, MONTH, late, scope).available + dayCounts(edited, MONTH, late, scope).away, 22);
  assert.equal(availabilitySummary(tuesdays, MONTH, late, scope).days.available, 3);
});
