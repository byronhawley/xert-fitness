// Part-month roster periods in the browser: the dates offered, the planning
// context, the rules, the month guide, the API client and the manager
// screens. SYNTHETIC DATA ONLY. The database side is in
// staff-roster-part-month-db.test.js.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import { partMonthStartRange, planPartMonthOpening, planPeriodOpening, reminderPlan } from '../src/lib/staffRoster/cycle.js';
import { monthSteps, openSpots } from '../src/lib/staffRoster/monthSteps.js';
import { needsAttention, planningContext } from '../src/lib/staffRoster/snapshot.js';
import { coverageReport } from '../src/lib/staffRoster/coverage.js';
import { checkAssignment, PROBLEM_MESSAGES } from '../src/lib/staffRoster/validate.js';
import { createStaffRosterClient, rosterError } from '../src/lib/staffRosterData.js';
import { gymInstant, gymInstantIso } from '../src/lib/staffRoster/time.js';

const MONTH = '2026-10';
const TODAY = '2026-10-02';
const NOW = gymInstant(TODAY, 9 * 60);
const PERIOD = { month: '2026-10-01', starts_on: '2026-10-09', opens_on: TODAY, due_on: '2026-10-06', publish_target_on: '2026-10-08', shortened: true, version: 1 };
const coachRow = id => ({ id, display_name: `Coach ${id}`, status: 'active', profile_id: `p-${id}`, roles: ['lead'] });
const sessionRow = (id, date, minute) => ({ id, title: `Class ${id}`, class_type: 'Synthetic', status: 'published', in_month: true,
  start: gymInstantIso(date, minute), end: gymInstantIso(date, minute + 45), slots: [{ key: 'lead', role: 'lead', required: true }] });

function snapshot(patch = {}) {
  return {
    settings: { enabled: true, version: 1 }, staff: [coachRow('a')], period: PERIOD, submissions: [{ staff_id: 'a', version: 1, reviewed: [] }],
    drafts_in_progress: [], reopenings: [], change_requests: [], acknowledgements: [], absences: [], cover_requests: [],
    sessions: [sessionRow('s5', '2026-10-05', 315), sessionRow('s8', '2026-10-08', 1380), sessionRow('s9', '2026-10-09', 0), sessionRow('s20', '2026-10-20', 315)],
    draft: null, published: null, draft_assignments: [], published_assignments: [],
    availability: ['s5', 's8', 's9', 's20'].map(id => ({ staff_id: 'a', session_id: id, status: 'AVAILABLE', source: 'submission' })), ...patch,
  };
}

// ── Dates ──────────────────────────────────────────────────────────────────

test('part-month start days: after today and the 1st, within the month; a week from today is suggested', () => {
  assert.deepEqual(partMonthStartRange(MONTH, TODAY), { min: '2026-10-03', max: '2026-10-31', suggested: '2026-10-09' });
  assert.deepEqual(partMonthStartRange(MONTH, '2026-10-28'), { min: '2026-10-29', max: '2026-10-31', suggested: '2026-10-31' });
  assert.equal(partMonthStartRange(MONTH, '2026-10-31'), null, 'nothing left on the last day');
  assert.deepEqual(partMonthStartRange('2026-12', TODAY), { min: '2026-12-02', max: '2026-12-31', suggested: '2026-12-02' }, 'a future month starts after its 1st');
  assert.throws(() => partMonthStartRange(MONTH, 'not a date'), /today/);
});

test('the owner’s plan: October classes from the 9th, asked today, due the 6th, publish by the 8th', () => {
  assert.deepEqual(planPartMonthOpening(MONTH, { today: TODAY, startsOn: '2026-10-09' }), {
    month: MONTH, startsOn: '2026-10-09', opensOn: TODAY, dueOn: '2026-10-06', publishTargetOn: '2026-10-08', shortened: true, partMonth: true, needsDueDate: false,
  });
  const tomorrow = planPartMonthOpening(MONTH, { today: TODAY, startsOn: '2026-10-03' });
  assert.deepEqual([tomorrow.dueOn, tomorrow.publishTargetOn], [TODAY, TODAY], 'due never before today');
  const chosen = planPartMonthOpening(MONTH, { today: TODAY, startsOn: '2026-10-09', dueOn: '2026-10-04', publishTargetOn: '2026-10-03' });
  assert.equal(chosen.publishTargetOn, '2026-10-04', 'a publish target before the due date moves up to it');
  assert.equal(planPartMonthOpening(MONTH, { today: TODAY, startsOn: '2026-10-09', publishTargetOn: '2026-10-20' }).publishTargetOn, '2026-10-08', 'never on or after the start');
  assert.equal(planPartMonthOpening(MONTH, { today: TODAY, startsOn: '2026-10-09', dueOn: '2026-10-05', publishTargetOn: '2026-10-07' }).publishTargetOn, '2026-10-07');
});

test('part-month dates the database would refuse are refused here first', () => {
  const plan = values => planPartMonthOpening(MONTH, { today: TODAY, startsOn: '2026-10-09', ...values });
  assert.throws(() => plan({ startsOn: TODAY }), /between 2026-10-03 and 2026-10-31/);
  assert.throws(() => plan({ startsOn: '2026-10-01' }), /between/);
  assert.throws(() => plan({ startsOn: '2026-11-02' }), /between/);
  assert.throws(() => plan({ startsOn: null }), /first day to roster/);
  assert.throws(() => plan({ dueOn: '2026-10-01' }), /past/);
  assert.throws(() => plan({ dueOn: '2026-10-09' }), /due before the roster starts/);
  assert.throws(() => planPartMonthOpening(MONTH, { today: '2026-10-31', startsOn: '2026-10-31' }), /no days left/);
  assert.throws(() => planPartMonthOpening(MONTH, { startsOn: '2026-10-09' }), /today/);
});

test('a whole month that has started points at the part-month option, and its reminders start today', () => {
  assert.throws(() => planPeriodOpening(MONTH, { today: TODAY }), /already started\. Roster coaches for the rest of the month from a later date instead\./);
  const plan = planPartMonthOpening(MONTH, { today: TODAY, startsOn: '2026-10-09' });
  assert.deepEqual(reminderPlan(plan).map(item => [item.kind, item.date]),
    [['opened', TODAY], ['due_in_3', '2026-10-03'], ['due_today', '2026-10-06'], ['overdue_summary', '2026-10-07']]);
});

// ── Planning context and rules ─────────────────────────────────────────────

test('classes before the start are out of the month: not planned, not counted, not needing attention', () => {
  const snap = snapshot();
  const ctx = planningContext(snap, { now: NOW });
  const flags = id => [ctx.sessions.get(id).inMonth, ctx.sessions.get(id).beforeRosterStart];
  assert.deepEqual(['s5', 's8', 's9', 's20'].map(flags), [[false, true], [false, true], [true, false], [true, false]]);
  assert.deepEqual(openSpots(ctx), { required: 2, filled: 0, open: 2, classes: 2, assigned: 0 });
  const monthIds = [...ctx.sessions.values()].filter(session => session.inMonth).map(session => session.id);
  assert.deepEqual(Object.keys(coverageReport(ctx, monthIds).bySession).sort(), ['s20', 's9']);
  const uncovered = needsAttention(snap, { today: TODAY, now: NOW }).filter(item => item.kind === 'uncovered').map(item => item.target.id).sort();
  assert.deepEqual(uncovered, ['s20', 's9']);
  const added = needsAttention(snap, { today: TODAY, now: NOW }).filter(item => item.kind === 'added_since_submission').map(item => item.target.id).sort();
  assert.deepEqual(added, ['s20', 's9'], 'not asked about classes before the start, so none are "added since"');
});

test('a whole-month period and a next month’s neighbours are unchanged', () => {
  const whole = planningContext(snapshot({ period: { ...PERIOD, starts_on: null } }), { now: NOW });
  assert.ok([...whole.sessions.values()].every(session => session.inMonth && !session.beforeRosterStart));
  const none = planningContext(snapshot({ period: null }), { now: NOW });
  assert.ok([...none.sessions.values()].every(session => session.inMonth && !session.beforeRosterStart));
  const neighbour = planningContext(snapshot({ sessions: [{ ...sessionRow('n', '2026-09-30', 315), in_month: false }] }), { now: NOW });
  assert.deepEqual([neighbour.sessions.get('n').inMonth, neighbour.sessions.get('n').beforeRosterStart], [false, false]);
});

test('assigning before the start is a hard problem with plain words; from the start it is fine', () => {
  const ctx = planningContext(snapshot(), { now: NOW });
  const early = checkAssignment(ctx, { sessionId: 's8', slotKey: 'lead', staffId: 'a' });
  assert.equal(early.ok, false);
  assert.deepEqual(early.hard.map(item => item.code), ['SESSION_BEFORE_ROSTER_START']);
  assert.equal(early.hard[0].message, 'Before this month’s roster starts; this class stays with its current coach.');
  assert.equal(checkAssignment(ctx, { sessionId: 's9', slotKey: 'lead', staffId: 'a' }).ok, true);
  assert.equal(PROBLEM_MESSAGES.SESSION_OUTSIDE_MONTH, 'This class belongs to another month’s roster.');
});

// ── Month guide ────────────────────────────────────────────────────────────

const steps = snap => monthSteps({ snapshot: snap, ctx: planningContext(snap, { now: NOW }), today: TODAY, month: MONTH });
const step = (result, key) => result.steps.find(item => item.key === key);

test('guide: a started month with no period offers the rest of the month; a part-month period says when it starts', () => {
  const asking = steps(snapshot({ period: null, submissions: [] }));
  assert.equal(asking.current, 'ask');
  assert.deepEqual(step(asking, 'ask').action, { kind: 'availability', label: 'Ask coaches for the rest of October' });
  assert.match(step(asking, 'ask').summary, /^October has started\. You can still ask coaches about the classes from a later day, such as 2026-10-09\./);
  const asked = steps(snapshot());
  assert.equal(step(asked, 'ask').summary, 'Asked. Roster starts 2026-10-09. Due by 2026-10-06; aim to publish by 2026-10-08.');
  assert.equal(step(asked, 'build').spots.classes, 2, 'only classes from the start need coaches');
  const whole = steps(snapshot({ period: { ...PERIOD, starts_on: null } }));
  assert.doesNotMatch(step(whole, 'ask').summary, /Roster starts/);
});

// ── API client ─────────────────────────────────────────────────────────────

test('client: openPartMonth sends what the database expects; its refusals read as plain words', async () => {
  const calls = [];
  const client = createStaffRosterClient(async (name, params) => { calls.push([name, params]); return { data: { month: '2026-10-01' }, error: null }; });
  await client.openPartMonth(MONTH, { startsOn: '2026-10-09', dueOn: '2026-10-06', publishTargetOn: '2026-10-08' });
  assert.equal(calls[0][0], 'staff_roster_open_part_month');
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['p_due_on', 'p_month', 'p_publish_target_on', 'p_request_id', 'p_starts_on']);
  assert.deepEqual([calls[0][1].p_month, calls[0][1].p_starts_on, calls[0][1].p_due_on, calls[0][1].p_publish_target_on],
    ['2026-10-01', '2026-10-09', '2026-10-06', '2026-10-08']);
  assert.match(calls[0][1].p_request_id, /^[0-9a-f-]{36}$/);

  assert.match(rosterError({ message: 'STARTS_ON_INVALID' }).message, /later in the month, after today/);
  assert.match(rosterError({ message: 'ASSIGNMENTS_BEFORE_START' }).message, /already rostered on classes before that start day/);
  const startsOn = rosterError({ message: 'new row for relation "staff_roster_periods" violates check constraint "staff_roster_periods_starts_on"' });
  assert.equal(startsOn.code, null);
  assert.match(startsOn.message, /start on a later day of the same month, after the publish-by date/);
  const order = rosterError({ message: 'new row for relation "staff_roster_periods" violates check constraint "staff_roster_periods_order"' });
  assert.match(order.message, /publish-by date must be on or after the due date/);
  assert.match(order.message, /before the month \(or its roster\) starts/);
  const blocked = rosterError({ message: 'ASSIGNMENT_BLOCKED', details: JSON.stringify({ problems: ['SESSION_BEFORE_ROSTER_START'] }) });
  assert.equal(blocked.message, PROBLEM_MESSAGES.SESSION_BEFORE_ROSTER_START);
});

// ── Manager screens ────────────────────────────────────────────────────────

const server = await createServer({ configFile: false, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' });
after(() => server.close());

const panel = async snap => {
  const { default: AvailabilityPanel } = await server.ssrLoadModule('/src/components/admin/staffRoster/AvailabilityPanel.jsx');
  return renderToStaticMarkup(React.createElement(AvailabilityPanel, {
    month: MONTH, today: TODAY, data: { snapshot: snap, draftCtx: planningContext(snap, { now: NOW }), busy: false }, settings: snap.settings, onMutate: async () => null,
  }));
};

test('availability tab: a started month asks which day to roster from, with sensible limits and dates', async () => {
  const html = await panel(snapshot({ period: null, submissions: [] }));
  assert.match(html, /Ask coaches for the rest of October/);
  assert.match(html, /Roster coaches from/);
  assert.match(html, /<input type="date" min="2026-10-03" max="2026-10-31"[^>]*value="2026-10-09"/);
  assert.match(html, /Classes before that day keep the coach they have now/);
  assert.match(html, /Ask coaches about classes from Fri 9 Oct/);
  assert.match(html, /Tue 6 Oct/, 'due three days before the start');
  assert.match(html, /Thu 8 Oct/, 'publish by the day before');
  assert.doesNotMatch(html, /too late to ask/);
});

test('availability tab: a part-month period shows where it starts and keeps the due date before it', async () => {
  const html = await panel(snapshot());
  assert.match(html, /Classes from Fri 9 Oct\./);
  assert.match(html, /<input type="date" min="2026-10-02" max="2026-10-08"[^>]*value="2026-10-06"/);
  assert.match(html, /Can take 2 of 2 classes/, 'only classes from the start are counted');
});

test('publish dialog: the server’s gap count is a number, and the screen shows it', async () => {
  const { gapCount } = await server.ssrLoadModule('/src/components/admin/staffRoster/PublishDialog.jsx');
  const preview = { gaps: [{}, {}] };
  assert.equal(gapCount(null, preview), 2);
  assert.equal(gapCount({ ok: false, reason: 'GAPS_NEED_ACKNOWLEDGEMENT', gaps: 3 }, preview), 3);
  assert.equal(gapCount({ ok: false, reason: 'GAPS_NEED_ACKNOWLEDGEMENT', gaps: 0 }, preview), 0);
  assert.equal(gapCount({ ok: false, reason: 'GAPS_NEED_ACKNOWLEDGEMENT', gaps: [{}] }, preview), 1);
  assert.equal(gapCount({ ok: false, reason: 'HARD_CONFLICTS', blocked: [] }, preview), 2);
});

test('roster board: classes before the start say why they can’t be changed here', async () => {
  const { default: RosterBoard } = await server.ssrLoadModule('/src/components/admin/staffRoster/RosterBoard.jsx');
  const snap = snapshot();
  const html = renderToStaticMarkup(React.createElement(RosterBoard, {
    month: MONTH, today: TODAY, data: { snapshot: snap, draftCtx: planningContext(snap, { now: NOW }), busy: false }, settings: snap.settings,
    filters: { view: 'week', date: '2026-10-05' }, setFilters: () => {}, onApply: () => {}, onSaveStaffing: () => {}, onPublish: () => {}, onDiscard: () => {}, onNavigateTarget: () => {},
  }));
  assert.equal(html.match(/Before this roster starts on Fri 9 Oct; it stays with the current coach\./g)?.length, 2, 'the 5th and the 8th');
  assert.match(html, /Choose a coach|Choose coach/, 'classes from the 9th can still be filled');
});
