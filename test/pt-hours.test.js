import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHours, gridFromHours, hoursFromGrid, hoursFromStarts, normalizeHours, startsByDay } from '../src/lib/ptHours.js';

test('touching windows merge into one per day', () => {
  assert.deepEqual(normalizeHours([{ weekday: 1, start: 480, end: 720 }, { weekday: 1, start: 300, end: 480 }]),
    [{ weekday: 1, start: 300, end: 720 }]);
});

test('grid round-trips to exact windows', () => {
  const hours = [{ weekday: 1, start: 300, end: 720 }, { weekday: 6, start: 480, end: 720 }];
  const { grid, exact } = gridFromHours(hours);
  assert.equal(exact, true);
  assert.deepEqual([...grid[1]].sort(), ['early', 'morning']);
  assert.deepEqual(hoursFromGrid(grid), hours);
});

test('hours that do not fit the grid are flagged as not exact', () => {
  const { grid, exact } = gridFromHours([{ weekday: 2, start: 360, end: 600 }]);
  assert.equal(exact, false);
  assert.equal(grid[2].size, 0);
});

test('summary groups days and collapses runs', () => {
  const weekdays = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: 360, end: 720 }));
  assert.equal(describeHours([...weekdays, { weekday: 6, start: 480, end: 720 }]), 'Mon–Fri 6 am–12 pm · Sat 8 am–12 pm');
  assert.equal(describeHours([{ weekday: 1, start: 960, end: 1200 }, { weekday: 3, start: 960, end: 1200 }]), 'Mon, Wed 4 pm–8 pm');
  assert.equal(describeHours([0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: 300, end: 720 }))), 'Every day 5 am–12 pm');
  assert.equal(describeHours([]), '');
});

test('exact start times sit alongside windows', () => {
  const hours = [
    { weekday: 1, start: 1080, kind: 'start' }, { weekday: 1, start: 360, end: 720 },
    { weekday: 1, start: 1080, kind: 'start' }, { weekday: 1, start: 360, kind: 'start' },
  ];
  assert.deepEqual(normalizeHours(hours), [
    { weekday: 1, start: 360, end: 720 }, { weekday: 1, start: 360, kind: 'start' }, { weekday: 1, start: 1080, kind: 'start' },
  ]);
  const { grid, exact } = gridFromHours(hours);
  assert.equal(exact, false, '6 am–12 pm is not a whole number of grid parts');
  assert.equal(grid[1].size, 1);
  assert.deepEqual(startsByDay(hours)[1], [360, 1080]);
  assert.deepEqual(hoursFromStarts({ 2: [480] }), [{ weekday: 2, start: 480, kind: 'start' }]);
  assert.equal(describeHours([{ weekday: 6, start: 480, kind: 'start' }, { weekday: 6, start: 540, kind: 'start' }]), 'Sat sessions at 8 am, 9 am');
  assert.equal(describeHours([{ weekday: 1, start: 300, end: 480 }, { weekday: 1, start: 1080, kind: 'start' }]), 'Mon 5 am–8 am, sessions at 6 pm');
});
