import assert from 'node:assert/strict';
import test from 'node:test';

import { filterPublicClasses, publicTimetableFilterOptions } from '../src/lib/publicTimetableFilters.js';

const sessions = [
  { id: 'morning', title: 'Foundation Strength', class_type: 'XERT Foundation', coach_name: 'Chez', location_zone: 'Main floor', start_time: '2026-11-13T00:30:00.000Z', capacity: 12 },
  { id: 'afternoon', title: 'Engine Session', class_type: 'XERT Engine', coach_name: 'Taleha', location_zone: 'Main floor', start_time: '2026-11-13T06:30:00.000Z', capacity: 12 },
  { id: 'evening', title: 'Team Conditioning', class_type: 'XERT Team', coach_name: 'Chez', location_zone: 'Studio', start_time: '2026-11-13T08:30:00.000Z', capacity: 30 },
];

test('search matches class, coach and location without changing source order', () => {
  assert.deepEqual(filterPublicClasses(sessions, { query: 'chez' }).map(row => row.id), ['morning', 'evening']);
  assert.deepEqual(filterPublicClasses(sessions, { query: 'studio' }).map(row => row.id), ['evening']);
  assert.deepEqual(filterPublicClasses(sessions, { query: 'FOUNDATION' }).map(row => row.id), ['morning']);
});

test('coach and class type filters compose with search', () => {
  assert.deepEqual(filterPublicClasses(sessions, { coach: 'Chez', classType: 'XERT Team', query: 'conditioning' }).map(row => row.id), ['evening']);
  assert.deepEqual(filterPublicClasses(sessions, { coach: 'Missing' }), []);
});

test('time-of-day filters use Brisbane local time rather than the browser timezone', () => {
  assert.deepEqual(filterPublicClasses(sessions, { timeOfDay: 'morning' }).map(row => row.id), ['morning']);
  assert.deepEqual(filterPublicClasses(sessions, { timeOfDay: 'afternoon' }).map(row => row.id), ['afternoon']);
  assert.deepEqual(filterPublicClasses(sessions, { timeOfDay: 'evening' }).map(row => row.id), ['evening']);
});

test('available-only requires a confirmed positive availability count', () => {
  const availability = {
    morning: { spots_left: 3 },
    afternoon: { spots_left: 0 },
    evening: { spots_left: '12' },
  };
  assert.deepEqual(filterPublicClasses(sessions, { availableOnly: true }, availability).map(row => row.id), ['morning']);
  assert.deepEqual(filterPublicClasses(sessions, { availableOnly: true }), []);
});

test('filter option lists are unique, sorted and ignore missing values', () => {
  assert.deepEqual(publicTimetableFilterOptions([...sessions, { id: 'invalid' }]), {
    coaches: ['Chez', 'Taleha'],
    classTypes: ['XERT Engine', 'XERT Foundation', 'XERT Team'],
  });
});

test('malformed sessions and invalid dates fail safely', () => {
  assert.deepEqual(filterPublicClasses(null), []);
  assert.deepEqual(filterPublicClasses([null, {}, { id: 'bad', start_time: 'not-a-date' }], { timeOfDay: 'morning' }), []);
});
