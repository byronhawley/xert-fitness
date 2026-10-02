import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHours, gridFromHours, hoursFromGrid, normalizeHours } from '../src/lib/ptHours.js';

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
