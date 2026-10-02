import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMonths, dateInMonth, daysInMonth, gymDateOf, gymInstant, gymMinuteOf, monthKeyOfInstant, monthRange, weekdayOf, covers,
} from '../src/lib/staffRoster/time.js';
import { defaultPeriodDates, planPeriodOpening, reminderPlan, coachesToRemind, remindersDue } from '../src/lib/staffRoster/cycle.js';
import {
  validateAvailability, expandAvailability, intervalAvailability, effectiveAvailability, copyPreviousMonth, slotShortcuts,
} from '../src/lib/staffRoster/availability.js';
import { dutyConflict, dutyInterval, dutyMinutes, coachingBlocks, normalizeStaffing } from '../src/lib/staffRoster/duty.js';
import { checkAssignment } from '../src/lib/staffRoster/validate.js';
import { coverageReport, candidatesFor } from '../src/lib/staffRoster/coverage.js';
import { suggestDraft, copyWeekSuggestions } from '../src/lib/staffRoster/suggest.js';
import { SYNTHETIC_PRESETS, coach, everyDay, planningContext, session } from './fixtures/staff-roster-fixtures.mjs';

const codes = result => result.hard.map(item => item.code);

// ── Scenario 15: dates, month and year boundaries ──────────────────────────

test('a 5:15 am Brisbane class stays on its Brisbane date whatever the process timezone', () => {
  const instant = gymInstant('2026-12-01', 5 * 60 + 15);
  assert.equal(new Date(instant).toISOString(), '2026-11-30T19:15:00.000Z', 'UTC is still the previous day');
  assert.equal(gymDateOf(instant), '2026-12-01');
  assert.equal(gymMinuteOf(instant), 315);
  assert.equal(monthKeyOfInstant(instant), '2026-12', 'filed under December, not November');
});

test('month lengths, leap years and year boundaries', () => {
  assert.equal(daysInMonth('2027-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(addMonths('2027-01', -2), '2026-11');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(dateInMonth('2026-11', 31), '2026-11-30', 'day 31 clamps in a 30-day month');
  const december = monthRange('2026-12');
  assert.equal(new Date(december.start).toISOString(), '2026-11-30T14:00:00.000Z');
  assert.equal(new Date(december.end).toISOString(), '2026-12-31T14:00:00.000Z');
  assert.equal(weekdayOf('2026-12-01'), 2, '1 December 2026 is a Tuesday');
});

test('half-open intervals: a duty ending at 6:15 does not overlap one starting at 6:15', () => {
  assert.equal(covers([{ start: 0, end: 10 }, { start: 10, end: 20 }], 0, 20), true);
  assert.equal(covers([{ start: 0, end: 10 }, { start: 11, end: 20 }], 0, 20), false);
  const a = session('a', '2026-12-01', 315, 60);
  const b = session('b', '2026-12-01', 375, 60);
  assert.equal(dutyConflict(a, b), null);
});

// ── Planning cycle ─────────────────────────────────────────────────────────

test('December 2026 opens 1 October, is due 20 October and targets publication 1 November', () => {
  assert.deepEqual(defaultPeriodDates('2026-12'), { month: '2026-12', opensOn: '2026-10-01', dueOn: '2026-10-20', publishTargetOn: '2026-11-01' });
});

test('deadline offsets cross the year boundary correctly', () => {
  assert.deepEqual(defaultPeriodDates('2027-01'), { month: '2027-01', opensOn: '2026-11-01', dueOn: '2026-11-20', publishTargetOn: '2026-12-01' });
  assert.deepEqual(defaultPeriodDates('2027-02'), { month: '2027-02', opensOn: '2026-12-01', dueOn: '2026-12-20', publishTargetOn: '2027-01-01' });
});

test('deadlines are configurable per cycle and clamp to short months', () => {
  const dates = defaultPeriodDates('2027-04', { dueDay: 31, openMonthsBefore: 2, dueMonthsBefore: 2 });
  assert.equal(dates.dueOn, '2027-02-28');
});

test('an incomplete first rollout is a labelled shortened cycle, never backdated', () => {
  const late = planPeriodOpening('2026-11', { today: '2026-10-01' });
  assert.equal(late.shortened, true);
  assert.equal(late.needsDueDate, true, 'default due (20 Sept) has passed, so the manager must choose');
  assert.equal(late.publishTargetOn, null, 'no stale default publish target (1 Oct) is offered before a due date is chosen');
  const chosen = planPeriodOpening('2026-11', { today: '2026-10-01', dueOn: '2026-10-10' });
  assert.equal(chosen.opensOn, '2026-10-01');
  assert.equal(chosen.dueOn, '2026-10-10');
  assert.equal(chosen.publishTargetOn, '2026-10-10', 'publish target cannot precede the due date');
  const plan = reminderPlan(chosen);
  assert.ok(plan.every(item => item.date >= '2026-10-01'), 'no reminders for a time before the period opened');
  assert.throws(() => planPeriodOpening('2026-10', { today: '2026-10-01' }), /already started/);
});

test('opening late: a publish-by date left before the chosen due date is moved up, never sent out of order', () => {
  // Reported 2026-10-02: November opened late, due 3 Oct, publish-by still the passed default 1 Oct; the database refused it.
  const sent = planPeriodOpening('2026-11', { today: '2026-10-02', dueOn: '2026-10-03', publishTargetOn: '2026-10-01' });
  assert.deepEqual([sent.opensOn, sent.dueOn, sent.publishTargetOn, sent.shortened], ['2026-10-02', '2026-10-03', '2026-10-03', true]);
  const later = planPeriodOpening('2026-11', { today: '2026-10-02', dueOn: '2026-10-15', publishTargetOn: '2026-10-25' });
  assert.equal(later.publishTargetOn, '2026-10-25', 'a valid later publish-by date is kept');
  assert.throws(() => planPeriodOpening('2026-11', { today: '2026-10-02', dueOn: '2026-11-02' }), /before the roster month starts/);
});

test('reminders: opening, three days before, due date, then a manager summary — deduplicated and daytime', () => {
  const plan = reminderPlan(defaultPeriodDates('2026-12'));
  assert.deepEqual(plan.map(item => [item.kind, item.date]), [
    ['opened', '2026-10-01'], ['due_in_3', '2026-10-17'], ['due_today', '2026-10-20'], ['overdue_summary', '2026-10-21'],
  ]);
  assert.equal(gymMinuteOf(plan[0].sendAt), 9 * 60, 'routine notices go out at 9:00 am gym time');
  const sent = new Set([plan[0].key]);
  assert.deepEqual(remindersDue(plan, plan[1].sendAt, sent).map(item => item.kind), ['due_in_3']);
  const staff = [coach('a'), coach('b'), coach('c'), coach('d', { status: 'inactive' })];
  const submissions = [{ staffId: 'a', month: '2026-12' }, { staffId: 'b', month: '2026-12', noAvailability: true }];
  assert.deepEqual(coachesToRemind(staff, submissions, '2026-12').map(item => item.id), ['c'], 'no chasing submitted, explicitly unavailable or inactive coaches');
});

// ── Scenario 3/4: availability meaning ─────────────────────────────────────

test('usual week plus a date exception: the exception replaces only the overlapping part', () => {
  const submission = {
    weekly: [{ weekday: 2, start: 300, end: 600, status: 'AVAILABLE' }],
    exceptions: [{ date: '2026-12-08', start: 360, end: 420, status: 'UNAVAILABLE' }],
  };
  const windows = expandAvailability(submission, '2026-12');
  const at = (date, start, end) => intervalAvailability(windows, gymInstant(date, start), gymInstant(date, end));
  assert.equal(at('2026-12-01', 315, 375), 'AVAILABLE');
  assert.equal(at('2026-12-08', 315, 355), 'AVAILABLE', 'untouched morning part still applies');
  assert.equal(at('2026-12-08', 375, 435), 'UNAVAILABLE');
  assert.equal(at('2026-12-02', 315, 375), 'UNKNOWN', 'nothing said about Wednesdays');
});

test('partial coverage is not availability: the whole duty must be covered', () => {
  const windows = expandAvailability({ weekly: [{ weekday: 2, start: 300, end: 360, status: 'PREFERRED' }] }, '2026-12');
  assert.equal(intervalAvailability(windows, gymInstant('2026-12-01', 315), gymInstant('2026-12-01', 375)), 'PARTIAL');
  const mixed = expandAvailability({ weekly: [
    { weekday: 2, start: 300, end: 340, status: 'PREFERRED' },
    { weekday: 2, start: 340, end: 400, status: 'IF_NEEDED' },
  ] }, '2026-12');
  assert.equal(intervalAvailability(mixed, gymInstant('2026-12-01', 315), gymInstant('2026-12-01', 375)), 'IF_NEEDED', 'the weakest covering answer wins');
});

test('contradictory overlapping answers at the same level are rejected', () => {
  const { errors } = validateAvailability({ weekly: [
    { weekday: 1, start: 300, end: 420, status: 'AVAILABLE' },
    { weekday: 1, start: 360, end: 480, status: 'UNAVAILABLE' },
  ] }, '2026-12');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Monday/);
  const exceptions = validateAvailability({ exceptions: [
    { date: '2026-12-03', start: 300, end: 420, status: 'PREFERRED' },
    { date: '2026-12-03', start: 400, end: 480, status: 'IF_NEEDED' },
  ] }, '2026-12');
  assert.equal(exceptions.errors.length, 1);
});

test('explicit “unavailable all month” is distinct from silence', () => {
  const none = validateAvailability({ noAvailability: true }, '2026-12');
  assert.deepEqual(none.errors, []);
  const windows = expandAvailability({ noAvailability: true }, '2026-12');
  assert.equal(intervalAvailability(windows, gymInstant('2026-12-15', 315), gymInstant('2026-12-15', 375)), 'UNAVAILABLE');
  assert.equal(intervalAvailability([], gymInstant('2026-12-15', 315), gymInstant('2026-12-15', 375)), 'UNKNOWN');
  assert.match(validateAvailability({}, '2026-12').errors[0], /at least one time/);
  assert.equal(validateAvailability({ noAvailability: true, weekly: [{ weekday: 1, start: 300, end: 400, status: 'AVAILABLE' }] }, '2026-12').errors.length, 1);
});

test('precedence: absence, then a current session answer, then the submission', () => {
  const windows = expandAvailability(everyDay(0, 1440), '2026-12');
  const start = gymInstant('2026-12-10', 315);
  const end = gymInstant('2026-12-10', 375);
  assert.equal(effectiveAvailability({ windows, start, end }).status, 'AVAILABLE');
  assert.equal(effectiveAvailability({ windows, start, end, response: { status: 'UNAVAILABLE', current: true } }).status, 'UNAVAILABLE');
  assert.equal(effectiveAvailability({ windows, start, end, response: { status: 'UNAVAILABLE', current: false } }).status, 'AVAILABLE', 'a stale answer is ignored');
  assert.equal(effectiveAvailability({ windows, start, end, response: { status: 'PREFERRED', current: true }, absences: [{ start, end: end + 1 }] }).status, 'ABSENT');
});

test('copying last month copies only the weekly pattern', () => {
  const copy = copyPreviousMonth({ weekly: [{ weekday: 1, start: 300, end: 400, status: 'AVAILABLE' }], exceptions: [{ date: '2026-11-03', start: 0, end: 1440, status: 'UNAVAILABLE' }] });
  assert.deepEqual(copy.exceptions, []);
  assert.equal(copy.weekly.length, 1);
  assert.equal(copy.noAvailability, false);
});

// ── Scenario 1: presets ────────────────────────────────────────────────────

test('class-slot shortcuts span the real duty, and a sixth preset needs no code change', () => {
  const sessions = [
    session('s1', '2026-12-01', 315, 45, { staffing: { prepMinutes: 10, wrapMinutes: 5 } }),
    session('s2', '2026-12-08', 315, 45, { staffing: { prepMinutes: 10, wrapMinutes: 5 } }),
    session('s3', '2026-12-01', 1110, 30),
  ];
  const presets = [...SYNTHETIC_PRESETS, { minute: 18 * 60 + 30, label: '6:30 pm' }];
  const shortcuts = slotShortcuts(sessions, presets, { gymDate: gymDateOf, gymMinute: gymMinuteOf, dutyOf: dutyInterval });
  const early = shortcuts.find(item => item.presetMinute === 315);
  assert.deepEqual([early.weekday, early.start, early.end, early.sessions], [2, 305, 365, 2]);
  const sixth = shortcuts.find(item => item.presetMinute === 1110);
  assert.deepEqual([sixth.start, sixth.end], [1110, 1140]);
  assert.equal(shortcuts.some(item => item.presetMinute === 570), false, 'no class at 9:30 means no guessed shortcut');
});

// ── Scenario 6: duty, blocks, overlaps ─────────────────────────────────────

test('back-to-back classes form one block when allowed and count shared buffers once', () => {
  const staffing = { prepMinutes: 10, wrapMinutes: 10, allowBlock: true };
  const a = session('a', '2026-12-01', 315, 60, { staffing });
  const b = session('b', '2026-12-01', 375, 60, { staffing });
  assert.equal(dutyConflict(a, b), null);
  assert.equal(dutyMinutes([a, b]), 140, '10 prep + 120 class + 10 wrap, buffers between merged');
  assert.equal(coachingBlocks([a, b]).length, 1);
  const strict = { prepMinutes: 10, wrapMinutes: 10, allowBlock: false };
  assert.equal(dutyConflict(session('c', '2026-12-01', 315, 60, { staffing: strict }), session('d', '2026-12-01', 375, 60, { staffing: strict })), 'DUTY_BUFFER_OVERLAP');
  assert.equal(dutyConflict(session('e', '2026-12-01', 315, 60), session('f', '2026-12-01', 345, 60)), 'CLASS_OVERLAP');
});

test('overlap checks cross the month boundary (cross-midnight duty on 31 December)', () => {
  const late = session('nye', '2026-12-31', 23 * 60, 90);
  const early = session('ny', '2027-01-01', 0, 30);
  assert.equal(dutyConflict(late, early), 'CLASS_OVERLAP');
  const staff = [coach('c1')];
  const ctx = planningContext({
    sessions: [late, early], staff, month: '2026-12',
    availability: { c1: everyDay(0, 1440) },
    assignments: [{ id: 'jan', sessionId: 'ny', slotKey: 'lead', staffId: 'c1' }],
  });
  assert.ok(codes(checkAssignment(ctx, { sessionId: 'nye', slotKey: 'lead', staffId: 'c1' })).includes('CLASS_OVERLAP'));
});

// ── Scenario 4/7: hard constraints ─────────────────────────────────────────

test('UNKNOWN, partial coverage, absence and an expired capability cannot be a normal assignment', () => {
  const s = session('s', '2026-12-10', 315, 60, { staffing: { slots: [{ key: 'lead', role: 'lead', capabilities: ['first_aid'] }] } });
  const staff = [
    coach('unknown', { capabilities: [{ name: 'first_aid' }] }),
    coach('partial', { capabilities: [{ name: 'first_aid' }] }),
    coach('absent', { capabilities: [{ name: 'first_aid' }] }),
    coach('expired', { capabilities: [{ name: 'first_aid', validUntil: gymInstant('2026-12-01', 0) }] }),
    coach('ok', { capabilities: [{ name: 'first_aid', validUntil: gymInstant('2027-06-01', 0) }] }),
  ];
  const ctx = planningContext({
    sessions: [s], staff, month: '2026-12',
    availability: {
      partial: everyDay(300, 350),
      absent: everyDay(0, 1440),
      expired: everyDay(0, 1440),
      ok: everyDay(0, 1440),
    },
    absences: { absent: [{ start: gymInstant('2026-12-10', 0), end: gymInstant('2026-12-11', 0) }] },
  });
  const check = id => codes(checkAssignment(ctx, { sessionId: 's', slotKey: 'lead', staffId: id }));
  assert.deepEqual(check('unknown'), ['AVAILABILITY_UNKNOWN']);
  assert.deepEqual(check('partial'), ['AVAILABILITY_PARTIAL']);
  assert.deepEqual(check('absent'), ['ABSENT']);
  assert.deepEqual(check('expired'), ['CAPABILITY_EXPIRED']);
  assert.deepEqual(check('ok'), []);
});

test('multi-coach roles: one coach cannot fill two positions, a shadow cannot be the lead', () => {
  const staffing = { slots: [{ key: 'lead', role: 'lead' }, { key: 'assist', role: 'assistant' }, { key: 'shadow', role: 'shadow' }] };
  assert.equal(normalizeStaffing(staffing).slots.find(slot => slot.key === 'shadow').required, false);
  const s = session('s', '2026-12-10', 315, 60, { staffing });
  const ctx = planningContext({
    sessions: [s], month: '2026-12',
    staff: [coach('lead'), coach('trainee', { roles: ['shadow'] })],
    availability: { lead: everyDay(0, 1440), trainee: everyDay(0, 1440) },
    assignments: [{ id: 'x', sessionId: 's', slotKey: 'lead', staffId: 'lead' }],
  });
  assert.ok(codes(checkAssignment(ctx, { sessionId: 's', slotKey: 'assist', staffId: 'lead' })).includes('SAME_SESSION_DUPLICATE'));
  assert.ok(codes(checkAssignment({ ...ctx, assignments: [] , byStaff: new Map(), bySession: new Map() }, { sessionId: 's', slotKey: 'lead', staffId: 'trainee' })).includes('ROLE_NOT_AUTHORISED'));
  assert.deepEqual(codes(checkAssignment(ctx, { sessionId: 's', slotKey: 'shadow', staffId: 'trainee' })), []);
});

test('configured workload and rest limits are hard; targets are soft', () => {
  const sessions = [
    session('evening', '2026-12-10', 19 * 60, 60),
    session('dawn', '2026-12-11', 5 * 60 + 15, 60),
  ];
  const ctx = planningContext({
    sessions, month: '2026-12',
    staff: [coach('c', { limits: { minRestMinutes: 11 * 60 }, targets: { classesPerMonth: 1 } })],
    availability: { c: everyDay(0, 1440) },
    assignments: [{ id: 'e', sessionId: 'evening', slotKey: 'lead', staffId: 'c' }],
  });
  const result = checkAssignment(ctx, { sessionId: 'dawn', slotKey: 'lead', staffId: 'c' });
  assert.deepEqual(codes(result), ['LIMIT_REST']);
  assert.ok(result.soft.some(item => item.code === 'ABOVE_TARGET'));
});

// ── Coverage ───────────────────────────────────────────────────────────────

test('three simultaneous classes sharing one coach are a joint shortage, not three covered classes', () => {
  const sessions = ['a', 'b', 'c'].map(id => session(id, '2026-12-10', 375, 60));
  const ctx = planningContext({ sessions, month: '2026-12', staff: [coach('solo')], availability: { solo: everyDay(0, 1440) } });
  const report = coverageReport(ctx, ['a', 'b', 'c']);
  assert.equal(report.shortages.length, 1);
  assert.deepEqual([report.shortages[0].demand, report.shortages[0].possible], [3, 1]);
  assert.ok(report.dependencies.length >= 1, 'single-person dependency flagged');
  const pool = candidatesFor(ctx, 'a', 'lead');
  assert.deepEqual(pool.eligible.map(item => item.staffId), ['solo']);
});

test('cancelled sessions carry no staffing demand', () => {
  const ctx = planningContext({ sessions: [session('x', '2026-12-10', 375, 60, { status: 'cancelled' })], month: '2026-12', staff: [] });
  const report = coverageReport(ctx, ['x']);
  assert.equal(report.bySession.x.status, 'cancelled');
  assert.equal(report.gaps.length, 0);
});

// ── Scenario 8/9: suggestions ──────────────────────────────────────────────

test('suggestions solve a constrained but feasible month where chronological greedy dead-ends', () => {
  // A (6:15) can be X or Y and X prefers it; B (also 6:15) can only be X.
  // Greedy by time would give A to X and strand B.
  const sessions = [session('A', '2026-12-10', 375, 60), session('B', '2026-12-10', 375, 60)];
  const ctx = planningContext({
    sessions, month: '2026-12', staff: [coach('X'), coach('Y')],
    availability: { X: everyDay(0, 1440, 'PREFERRED'), Y: { weekly: [{ weekday: weekdayOf('2026-12-10'), start: 300, end: 480, status: 'AVAILABLE' }] } },
  });
  // Make Y unable to do B: B needs a capability only X has.
  sessions[1].staffing = { slots: [{ key: 'lead', role: 'lead', capabilities: ['rowing'] }] };
  ctx.staff.get('X').capabilities = [{ name: 'rowing' }];
  const result = suggestDraft(ctx, { sessionIds: ['A', 'B'] });
  assert.deepEqual(result.unfilled, []);
  assert.deepEqual(result.added.map(item => `${item.sessionId}:${item.staffId}`).sort(), ['A:Y', 'B:X']);
});

test('backtracking finds a full matching when the most-constrained heuristic alone ties', () => {
  const day = '2026-12-10';
  const sessions = ['S1', 'S2', 'S3'].map(id => session(id, day, 375, 60, { staffing: { slots: [{ key: 'lead', role: 'lead', capabilities: [id] }] } }));
  const capabilities = { P: ['S1', 'S2'], Q: ['S2', 'S3'], R: ['S1', 'S3'] };
  const staff = Object.entries(capabilities).map(([id, caps]) => coach(id, { capabilities: caps.map(name => ({ name })) }));
  const ctx = planningContext({ sessions, staff, month: '2026-12', availability: Object.fromEntries(staff.map(item => [item.id, everyDay(0, 1440)])) });
  const result = suggestDraft(ctx, { sessionIds: ['S1', 'S2', 'S3'] });
  assert.equal(result.added.length, 3);
  assert.equal(new Set(result.added.map(item => item.staffId)).size, 3);
});

test('pins survive regeneration, suggestions never invent availability, infeasible demand stays visible', () => {
  const sessions = [session('p', '2026-12-10', 375, 60), session('q', '2026-12-11', 375, 60), session('r', '2026-12-12', 375, 60)];
  const ctx = planningContext({
    sessions, month: '2026-12',
    staff: [coach('pinned'), coach('free')],
    availability: { pinned: everyDay(0, 1440, 'IF_NEEDED'), free: { weekly: [{ weekday: weekdayOf('2026-12-11'), start: 0, end: 1440, status: 'AVAILABLE' }] } },
    assignments: [{ id: 'pin', sessionId: 'p', slotKey: 'lead', staffId: 'pinned', pinned: true }],
  });
  const result = suggestDraft(ctx, { sessionIds: ['p', 'q', 'r'], mode: 'fresh' });
  assert.deepEqual(result.pinned, [{ sessionId: 'p', slotKey: 'lead', staffId: 'pinned' }]);
  assert.deepEqual(result.added.find(item => item.sessionId === 'q').staffId, 'free', 'available beats if-needed');
  assert.equal(result.added.find(item => item.sessionId === 'r').staffId, 'pinned', 'if-needed used only when nobody else can');
  const strict = suggestDraft(ctx, { sessionIds: ['p', 'q', 'r'], allowIfNeeded: false });
  assert.deepEqual(strict.unfilled.map(item => item.sessionId), ['r']);
  assert.match(strict.unfilled[0].reason, /Nobody can take this/);
  assert.match(strict.unfilled[0].reason, /if-needed fallback is off/);
  const unknown = suggestDraft(planningContext({ sessions, month: '2026-12', staff: [coach('silent')] }), { sessionIds: ['p', 'q', 'r'] });
  assert.equal(unknown.added.length, 0, 'no availability, no assignment');
  assert.equal(unknown.unfilled.length, 3);
});

test('identical inputs give identical suggestions, and the search limit is reported honestly', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => session(`s${index}`, `2026-12-${String(10 + (index % 4)).padStart(2, '0')}`, 315 + 60 * Math.floor(index / 4), 45));
  const staff = ['a', 'b', 'c'].map(id => coach(id, { targets: { classesPerMonth: 4 } }));
  const make = () => planningContext({ sessions, staff, month: '2026-12', availability: Object.fromEntries(staff.map(item => [item.id, everyDay(0, 1440)])) });
  const ids = sessions.map(item => item.id);
  assert.deepEqual(suggestDraft(make(), { sessionIds: ids }), suggestDraft(make(), { sessionIds: ids }));
  const limited = suggestDraft(make(), { sessionIds: ids, nodeLimit: 3 });
  assert.equal(limited.limitReached, true);
  assert.match(limited.summary, /not a proven best/);
});

test('copy-week only proposes assignments that are still valid', () => {
  const lastWeek = session('old', '2026-12-03', 375, 60);
  const thisWeek = session('new', '2026-12-10', 375, 60);
  const ctx = planningContext({
    sessions: [lastWeek, thisWeek], month: '2026-12', staff: [coach('c')],
    availability: { c: { weekly: [{ weekday: weekdayOf('2026-12-03'), start: 0, end: 1440, status: 'AVAILABLE' }], exceptions: [{ date: '2026-12-10', start: 0, end: 1440, status: 'UNAVAILABLE' }] } },
    assignments: [{ id: 'a', sessionId: 'old', slotKey: 'lead', staffId: 'c' }],
  });
  const result = copyWeekSuggestions(ctx, { fromSessionIds: ['old'], toSessionIds: ['new'], offsetMs: 7 * 24 * 3600 * 1000 });
  assert.equal(result.proposals.length, 0);
  assert.match(result.skipped[0].reason, /unavailable/);
});
