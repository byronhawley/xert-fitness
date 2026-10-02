import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import { monthSteps, openSpots, suggestedOpening } from '../src/lib/staffRoster/monthSteps.js';
import { planningContext } from '../src/lib/staffRoster/snapshot.js';
import {
  availabilityStatus, availabilitySummary, awayDates, classTimeShortcuts, monthClassSessions, presetShortcuts, setShortcuts, shortcutStatus, toggleAwayDate,
} from '../src/lib/staffRoster/availabilityEditor.js';
import { gymInstant, gymInstantIso } from '../src/lib/staffRoster/time.js';

// SYNTHETIC DATA ONLY.

const MONTH = '2026-12';
const TODAY = '2026-10-05';
const NOW = gymInstant(TODAY, 9 * 60);
const coachRow = (id, linked = true) => ({ id, display_name: `Coach ${id}`, status: 'active', profile_id: linked ? `p-${id}` : null, roles: ['lead'] });
const sessionRow = (id, date, minute) => ({ id, title: `Class ${id}`, class_type: 'Synthetic', status: 'published', in_month: true,
  start: gymInstantIso(date, minute), end: gymInstantIso(date, minute + 45), slots: [{ key: 'lead', role: 'lead', required: true }] });
const PERIOD = { month: `${MONTH}-01`, opens_on: '2026-10-01', due_on: '2026-10-20', publish_target_on: '2026-11-01', shortened: false };

function snapshot(patch = {}) {
  return {
    settings: { enabled: true, version: 1 }, staff: [], period: null, submissions: [], drafts_in_progress: [], reopenings: [],
    sessions: [sessionRow('s1', '2026-12-01', 315), sessionRow('s2', '2026-12-02', 315)],
    draft: null, published: null, draft_assignments: [], published_assignments: [], availability: [], ...patch,
  };
}
const steps = snap => monthSteps({ snapshot: snap, ctx: planningContext(snap, { now: NOW }), today: TODAY, month: MONTH });
const step = (result, key) => result.steps.find(item => item.key === key);

test('a brand-new gym starts at step 1 with "Add your first coach"', () => {
  const result = steps(snapshot());
  assert.equal(result.current, 'coaches');
  assert.deepEqual(result.steps.map(item => item.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(step(result, 'coaches').action, { kind: 'add-coach', label: 'Add your first coach' });
  assert.equal(step(result, 'coaches').status, 'current');
  assert.equal(step(result, 'publish').status, 'todo');
});

test('coaches without a sign-in point at the invite step; switched-off screens are step 2', () => {
  const noSignIn = steps(snapshot({ staff: [coachRow('a', false)] }));
  assert.equal(noSignIn.current, 'coaches');
  assert.equal(step(noSignIn, 'coaches').action.kind, 'coaches');
  const off = steps(snapshot({ staff: [coachRow('a')], settings: { enabled: false, version: 1 } }));
  assert.equal(off.current, 'ask');
  assert.equal(step(off, 'ask').action.kind, 'switch-on');
  assert.match(step(off, 'ask').summary, /switched off/);
});

test('asking comes next, with a due date already suggested', () => {
  const result = steps(snapshot({ staff: [coachRow('a'), coachRow('b', false)] }));
  assert.equal(result.current, 'ask');
  assert.equal(step(result, 'coaches').status, 'done');
  assert.match(step(result, 'coaches').summary, /1 coach ready, 1 still to sign in/);
  assert.deepEqual(step(result, 'ask').action, { kind: 'availability', label: 'Ask coaches for availability' });
  assert.match(step(result, 'ask').summary, /Suggested due date: 2026-10-20/);
});

test('waiting shows "x of y in" and is done when everyone has answered or the due date passed', () => {
  const staff = [coachRow('a'), coachRow('b'), coachRow('c', false)];
  const waiting = steps(snapshot({ staff, period: PERIOD, submissions: [{ staff_id: 'a', version: 1 }] }));
  assert.equal(waiting.current, 'answers');
  assert.equal(step(waiting, 'answers').summary, '1 of 2 in, due by 2026-10-20.');
  assert.deepEqual(step(waiting, 'answers').counts, { submitted: 1, total: 2 });
  const allIn = steps(snapshot({ staff, period: PERIOD, submissions: [{ staff_id: 'a', version: 1 }, { staff_id: 'b', version: 1, no_availability: true }] }));
  assert.equal(step(allIn, 'answers').status, 'done');
  assert.equal(allIn.current, 'build');
  const late = monthSteps({ snapshot: snapshot({ staff, period: PERIOD }), ctx: planningContext(snapshot({ staff, period: PERIOD }), { now: NOW }), today: '2026-10-25', month: MONTH });
  assert.equal(step(late, 'answers').status, 'done');
  assert.equal(step(late, 'answers').attention, true, 'overdue coaches are flagged');
  assert.match(step(late, 'answers').summary, /2 overdue/);
});

test('building offers Suggest, then "Fill N open spots"; publishing follows a draft', () => {
  const base = { staff: [coachRow('a')], period: PERIOD, submissions: [{ staff_id: 'a', version: 1 }] };
  const empty = steps(snapshot(base));
  assert.deepEqual(step(empty, 'build').action, { kind: 'suggest', label: 'Suggest a roster' });
  const half = snapshot({ ...base, draft: { id: 'd', number: 1, version: 2 }, draft_assignments: [{ id: 'x', session_id: 's1', slot_key: 'lead', staff_id: 'a' }] });
  const partly = steps(half);
  assert.deepEqual(step(partly, 'build').action, { kind: 'suggest', label: 'Fill 1 open spot' });
  assert.deepEqual(openSpots(planningContext(half, { now: NOW })), { required: 2, filled: 1, open: 1, classes: 2, assigned: 1 });
  assert.deepEqual(step(partly, 'publish').action, { kind: 'publish', label: 'Publish the roster' });
  assert.match(step(partly, 'publish').summary, /Aim to publish by 2026-11-01/);

  const full = [{ id: 'x', session_id: 's1', slot_key: 'lead', staff_id: 'a' }, { id: 'y', session_id: 's2', slot_key: 'lead', staff_id: 'a' }];
  const ready = steps(snapshot({ ...base, draft: { id: 'd', number: 1, version: 3 }, draft_assignments: full }));
  assert.equal(step(ready, 'build').status, 'done');
  assert.equal(ready.current, 'publish');
  const live = steps(snapshot({ ...base, published: { id: 'p', number: 1 }, published_assignments: full }));
  assert.equal(live.current, null, 'everything is done once the full roster is published with no draft');
  assert.ok(live.steps.every(item => item.status === 'done'));
});

test('a month that has already started skips asking instead of failing', () => {
  const result = monthSteps({ snapshot: snapshot({ staff: [coachRow('a')] }), ctx: planningContext(snapshot({ staff: [coachRow('a')] }), { now: NOW }), today: '2026-12-03', month: MONTH });
  assert.equal(step(result, 'ask').status, 'done');
  assert.equal(step(result, 'ask').action, null);
  assert.equal(step(result, 'answers').status, 'done');
});

test('suggested dates: the usual cycle, a week from today when that has passed, and a plain refusal once the month starts', () => {
  assert.deepEqual(suggestedOpening(MONTH, { today: TODAY }).plan.dueOn, '2026-10-20');
  const late = suggestedOpening(MONTH, { today: '2026-11-10' }).plan;
  assert.equal(late.dueOn, '2026-11-17');
  assert.equal(late.suggestedDue, true);
  assert.equal(late.shortened, true);
  assert.equal(suggestedOpening(MONTH, { today: '2026-11-28' }).plan.dueOn, '2026-11-30', 'never due inside the roster month');
  const started = suggestedOpening(MONTH, { today: '2026-12-02' });
  assert.equal(started.plan, null);
  assert.match(started.problem, /already started/);
});

// ── Coach availability: the tap grid, days away, the plain review, and status.

const classRow = (id, date, minute, minutes = 45, prep = 10) => ({ id, title: `Synthetic ${id}`, class_type: 'Synthetic',
  start: gymInstantIso(date, minute), end: gymInstantIso(date, minute + minutes), duty_start: gymInstantIso(date, minute - prep), duty_end: gymInstantIso(date, minute + minutes) });
// Tuesdays 1, 8, 15, 22, 29 Dec at 5:15 am; Wednesdays 2, 9 at 5:30 pm.
const CLASSES = monthClassSessions([
  ...['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29'].map((date, index) => classRow(`t${index}`, date, 315)),
  classRow('w0', '2026-12-02', 1050, 60), classRow('w1', '2026-12-09', 1050, 60),
]);
const EMPTY = { weekly: [], exceptions: [], noAvailability: false };

test('the grid shows every class time on the timetable, not only configured presets, and matches preset windows', () => {
  const grid = classTimeShortcuts(CLASSES, []);
  assert.deepEqual(grid.map(cell => `${cell.weekday}:${cell.label}`), ['2:5:15 am', '3:5:30 pm']);
  const [preset] = presetShortcuts(CLASSES, [{ minute: 315 }]);
  assert.deepEqual({ start: grid[0].start, end: grid[0].end }, { start: preset.start, end: preset.end }, 'same window, so old answers still show');
  const both = setShortcuts(EMPTY, grid, 'AVAILABLE');
  assert.deepEqual(grid.map(cell => shortcutStatus(both, cell)), ['AVAILABLE', 'AVAILABLE']);
  assert.deepEqual(setShortcuts(both, grid, null).weekly, [], 'clearing a whole day removes its cells');
});

test('days away toggle whole-day "can’t" entries and replace other answers for that date', () => {
  const withPartDay = { ...EMPTY, exceptions: [{ date: '2026-12-08', start: 300, end: 400, status: 'AVAILABLE' }] };
  const away = toggleAwayDate(withPartDay, '2026-12-08');
  assert.deepEqual(away.exceptions, [{ date: '2026-12-08', start: 0, end: 1440, status: 'UNAVAILABLE' }]);
  assert.deepEqual(awayDates(away), ['2026-12-08']);
  assert.deepEqual(toggleAwayDate(away, '2026-12-08').exceptions, [], 'tapping again undoes it');
});

test('the review reads "You can do N classes of M, prefer P, can’t do C, away D days"', () => {
  const [tuesday, wednesday] = classTimeShortcuts(CLASSES, []);
  let answer = setShortcuts(EMPTY, [tuesday], 'PREFERRED');
  answer = setShortcuts(answer, [wednesday], 'UNAVAILABLE');
  answer = toggleAwayDate(answer, '2026-12-15');
  answer = toggleAwayDate(answer, '2026-12-22');
  const summary = availabilitySummary(answer, MONTH, CLASSES);
  assert.deepEqual([summary.total, summary.canDo, summary.prefer, summary.cant, summary.away], [7, 3, 3, 4, 2]);
  assert.equal(summary.sentence, 'You can do 3 classes of 7, prefer 3, can’t do 4, away 2 days.');
  const none = availabilitySummary({ ...EMPTY, noAvailability: true }, MONTH, CLASSES);
  assert.equal(none.sentence, 'You can’t coach any classes in this month.');
  assert.equal(availabilitySummary(EMPTY, MONTH, []).sentence, 'There are no classes on the timetable for this month yet.');
});

test('availability status is always one of a few plain words', () => {
  const open = { is_open: true, deadline_passed: false, reopened: false };
  assert.equal(availabilityStatus(null).label, 'Not asked yet');
  assert.equal(availabilityStatus({ is_open: false }).label, 'Not open yet');
  assert.equal(availabilityStatus(open).label, 'Not started');
  assert.equal(availabilityStatus(open, { editedHere: true }).label, 'Draft saved');
  assert.equal(availabilityStatus({ ...open, draft: { version: 1 } }).label, 'Draft saved');
  assert.equal(availabilityStatus({ ...open, submission: { version: 1 } }).label, 'Submitted');
  assert.equal(availabilityStatus({ ...open, submission: { version: 1 } }, { editedHere: true }).label, 'Changes not submitted');
  assert.equal(availabilityStatus({ ...open, reopened: true, deadline_passed: true, submission: { version: 1 } }).label, 'Reopened');
  assert.equal(availabilityStatus({ is_open: true, deadline_passed: true, reopened: false }).label, 'Deadline passed');
  assert.equal(availabilityStatus({ is_open: true, deadline_passed: true, reopened: false, submission: { version: 1 } }).label, 'Submitted');
});

const server = await createServer({ configFile: false, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' });
after(() => server.close());

test('the guide writes each step’s status in words and gives the current step the one primary button', async () => {
  const { default: MonthGuide } = await server.ssrLoadModule('/src/components/admin/staffRoster/MonthGuide.jsx');
  const snap = snapshot({ staff: [coachRow('a'), coachRow('b')], period: PERIOD, submissions: [{ staff_id: 'a', version: 1 }] });
  const html = renderToStaticMarkup(React.createElement(MonthGuide, { snapshot: snap, ctx: planningContext(snap, { now: NOW }), today: TODAY, month: MONTH, busy: false, onAction: () => {} }));
  assert.match(html, /Step 3 of 5: Wait for answers/);
  assert.match(html, /aria-current="step"/);
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, />Done</);
  assert.match(html, />Next</);
  assert.match(html, />Later</);
  assert.match(html, /1 of 2 in, due by Tue 20 Oct\./);
  const primary = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*aria-label="([^"]*)"/g)];
  assert.ok(primary.some(([, , label]) => /^See who has answered/.test(label)));
});

test('the Coaches tab names each coach’s state and next step in words', async () => {
  const { coachRowState } = await server.ssrLoadModule('/src/components/admin/staffRoster/CoachesPanel.jsx');
  assert.equal(coachRowState({ status: 'active', profile_id: 'p', account_email: 'a@example.invalid' }).label, 'Ready');
  assert.equal(coachRowState({ status: 'active', profile_id: null }).label, 'Needs to sign in');
  assert.equal(coachRowState({ status: 'active', profile_id: null }, { status: 'pending' }).label, 'Invite sent');
  assert.equal(coachRowState({ status: 'active', profile_id: null }, { status: 'expired' }).label, 'Invite expired');
  assert.equal(coachRowState({ status: 'inactive', profile_id: 'p' }).label, 'Inactive');
});
