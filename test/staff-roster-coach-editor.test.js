import assert from 'node:assert/strict';
import test from 'node:test';

import { monthClassSessions, periodPhase, presetShortcuts, reviewClasses, setShortcut, shortcutStatus, startingPoint } from '../src/lib/staffRoster/availabilityEditor.js';
import { createStaffRosterClient, monthParam, rosterError } from '../src/lib/staffRosterData.js';
import { gymInstantIso } from '../src/lib/staffRoster/time.js';

// SYNTHETIC DATA ONLY.

const MONTH = '2026-12';
const row = (id, date, minute, minutes, prep = 0, wrap = 0) => ({
  id, title: `Synthetic ${id}`, class_type: 'Synthetic',
  start: gymInstantIso(date, minute), end: gymInstantIso(date, minute + minutes),
  duty_start: gymInstantIso(date, minute - prep), duty_end: gymInstantIso(date, minute + minutes + wrap),
});

test('a class-time shortcut covers the whole duty, so ticking it never leaves a coach short', () => {
  const sessions = monthClassSessions([row('a', '2026-12-01', 315, 45, 15, 10), row('b', '2026-12-08', 315, 60, 15, 0)]);
  const [shortcut] = presetShortcuts(sessions, [{ minute: 315 }]);
  assert.equal(shortcut.weekday, 2, 'Tuesday');
  assert.equal(shortcut.start, 300, 'starts at the earliest setup');
  assert.equal(shortcut.end, 375, 'ends after the longest class');
  const answer = setShortcut({ weekly: [], exceptions: [], noAvailability: false }, shortcut, 'AVAILABLE');
  assert.equal(shortcutStatus(answer, shortcut), 'AVAILABLE');
  const review = reviewClasses(answer, MONTH, sessions);
  assert.equal(review.considered, 2);
  assert.equal(setShortcut(answer, shortcut, null).weekly.length, 0, 'tapping again clears it');
});

test('the review step calls out partial and unanswered classes instead of counting them as available', () => {
  const sessions = monthClassSessions([row('a', '2026-12-01', 315, 60, 15), row('b', '2026-12-02', 990, 60)]);
  const review = reviewClasses({ weekly: [{ weekday: 2, start: 315, end: 400, status: 'AVAILABLE' }], exceptions: [], noAvailability: false }, MONTH, sessions);
  assert.deepEqual([review.considered, review.partial, review.unknown], [0, 1, 1]);
});

test('a new month starts from the draft, then the submission, then the usual week — never last month’s dates', () => {
  const usual = { pattern: [{ weekday: 1, start: 300, end: 600, status: 'AVAILABLE' }] };
  assert.equal(startingPoint({ draft: { payload: { weekly: [], exceptions: [], noAvailability: true } } }, usual).source, 'draft');
  assert.equal(startingPoint({ submission: { payload: { weekly: [], exceptions: [] }, no_availability: true } }, usual).payload.noAvailability, true);
  const fresh = startingPoint({}, usual);
  assert.equal(fresh.source, 'usual_week');
  assert.deepEqual(fresh.payload.exceptions, []);
  assert.equal(periodPhase({ is_open: true, deadline_passed: true, reopened: false }), 'closed');
  assert.equal(periodPhase({ is_open: true, deadline_passed: true, reopened: true }), 'open');
});

test('client maps database errors to plain words and sends the parameters the database expects', async () => {
  const blocked = rosterError({ message: 'ASSIGNMENT_BLOCKED', details: JSON.stringify({ problems: ['ABSENT', 'CLASS_OVERLAP'] }) });
  assert.equal(blocked.code, 'ASSIGNMENT_BLOCKED');
  assert.match(blocked.message, /absence/i);
  assert.match(rosterError({ message: 'STALE_VERSION' }).message, /Refresh/);
  assert.equal(monthParam('2026-12'), '2026-12-01');

  const calls = [];
  const client = createStaffRosterClient(async (name, params) => { calls.push([name, params]); return { data: { ok: true }, error: null }; });
  await client.publish('2026-12', 3, '');
  await client.publish('2026-12', 3, 'reason', 'fixed-id');
  assert.equal(calls[0][0], 'staff_roster_publish');
  assert.equal(calls[0][1].p_month, '2026-12-01');
  assert.equal(calls[0][1].p_gap_reason, null);
  assert.match(calls[0][1].p_request_id, /^[0-9a-f-]{36}$/);
  assert.equal(calls[1][1].p_request_id, 'fixed-id', 'a retry can reuse its request id');
  const failing = createStaffRosterClient(async () => ({ data: null, error: { message: 'DEADLINE_PASSED' } }));
  await assert.rejects(() => failing.submitAvailability('2026-12', {}), error => error.code === 'DEADLINE_PASSED' && /reopen/.test(error.message));
});
