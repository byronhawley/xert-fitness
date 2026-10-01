import assert from 'node:assert/strict';
import test from 'node:test';

import { checkAssignment } from '../src/lib/staffRoster/validate.js';
import { coverageReport } from '../src/lib/staffRoster/coverage.js';
import { suggestDraft } from '../src/lib/staffRoster/suggest.js';
import { needsAttention, planningContext, publishImpact, submissionProgress } from '../src/lib/staffRoster/snapshot.js';
import { gymInstantIso, weekdayOf } from '../src/lib/staffRoster/time.js';
import { MONTH_DATE, TODAY, day, ids, rid, rpc, world, addSession, allWeek, submit, apply, publish } from './helpers/staff-roster-world.mjs';

// SYNTHETIC DATA ONLY. The manager screen previews rules in the browser from
// the planning snapshot; the database stays the authority. These tests feed a
// real snapshot from the real migration into the browser engine and check the
// two agree, so a preview never says "fine" where the server says "blocked".

async function snapshot(db) {
  return rpc(db, ids.owner, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE]);
}

async function scenario() {
  const { db, staff } = await world();
  const early = await addSession(db, day(8), 315, 60, { title: 'Synthetic early' });
  const overlap = await addSession(db, day(8), 345, 60, { title: 'Synthetic overlap' });
  const evening = await addSession(db, day(9), 1050, 45, { title: 'Synthetic evening' });
  const cancelled = await addSession(db, day(10), 570, 60, { title: 'Synthetic cancelled', status: 'cancelled' });
  const spare = await addSession(db, day(12), 570, 60, { title: 'Synthetic spare' });
  await submit(db, ids.ava, allWeek(300, 1200, 'AVAILABLE'));
  await submit(db, ids.ben, { ...allWeek(300, 600, 'IF_NEEDED'), exceptions: [{ date: day(9), start: 1000, end: 1200, status: 'PREFERRED' }] });
  return { db, staff, sessions: { early, overlap, evening, cancelled, spare } };
}

test('browser preview agrees with the database on every coach × class × position', async () => {
  const { db, staff, sessions } = await scenario();
  await apply(db, [{ op: 'assign', session_id: sessions.early, slot_key: 'lead', staff_id: staff.ava }]);
  const snap = await snapshot(db);
  const ctx = planningContext(snap, { view: 'draft', now: Date.now() });
  let compared = 0;
  for (const session of snap.sessions.filter(row => row.in_month)) {
    for (const slot of session.slots) {
      for (const member of snap.staff) {
        const server = await rpc(db, ids.owner, 'select public.staff_roster_check_assignment($1, $2, $3, $4)', [MONTH_DATE, session.id, slot.key, member.id]);
        const existing = ctx.assignments.filter(item => item.sessionId === session.id && item.slotKey === slot.key).map(item => item.id);
        const browser = checkAssignment(ctx, { sessionId: session.id, slotKey: slot.key, staffId: member.id }, { ignoreAssignmentIds: existing });
        assert.deepEqual(browser.hard.map(item => item.code).sort(), [...server].sort(), `${session.title} / ${slot.key} / ${member.display_name}`);
        compared++;
      }
    }
  }
  assert.ok(compared >= 9);
});

test('needs attention, submission progress and publish impact read the snapshot correctly', async () => {
  const { db, staff, sessions } = await scenario();
  let snap = await snapshot(db);
  const progress = submissionProgress(snap, TODAY);
  assert.deepEqual(progress.rows.map(row => [row.name, row.state]), [['Ava', 'submitted'], ['Ben', 'submitted'], ['Cam', 'not_submitted']]);
  assert.equal(progress.missing, 1);

  let items = needsAttention(snap, { today: TODAY, now: Date.now() });
  const uncovered = items.filter(item => item.kind === 'uncovered').map(item => item.target.id).sort();
  assert.deepEqual(uncovered, [sessions.early, sessions.overlap, sessions.evening, sessions.spare].sort(), 'cancelled classes create no demand');
  assert.ok(items.some(item => item.kind === 'missing_submission' && item.target.id === staff.cam));

  await apply(db, [
    { op: 'assign', session_id: sessions.early, slot_key: 'lead', staff_id: staff.ava },
    { op: 'assign', session_id: sessions.evening, slot_key: 'lead', staff_id: staff.ben },
  ]);
  const published = await publish(db, 'Synthetic: one class still open', rid());
  assert.equal(published.ok, true);
  await apply(db, [{ op: 'assign', session_id: sessions.spare, slot_key: 'lead', staff_id: staff.ava }]);
  await apply(db, [{ op: 'unassign', assignment_id: (await snapshot(db)).draft_assignments.find(row => row.staff_id === staff.ben).id }]);
  snap = await snapshot(db);
  const impact = publishImpact(snap);
  const lines = impact.map(row => [row.staffId, row.added.length, row.removed.length]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(lines, [[staff.ava, 1, 0], [staff.ben, 0, 1]].sort((a, b) => a[0].localeCompare(b[0])), 'unchanged lines are not listed');

  items = needsAttention(snap, { today: TODAY, now: Date.now() });
  assert.ok(items.filter(item => item.kind === 'unacknowledged').length >= 2, 'published coaches have not confirmed yet');
  assert.deepEqual(items.filter(item => item.kind === 'uncovered').map(item => item.target.id).sort(), [sessions.overlap, sessions.evening].sort(), 'the draft is what is being planned');

  // A class moved after publication is flagged on the published roster.
  await db.query(`update public.class_sessions set start_time = start_time + interval '30 minutes', end_time = end_time + interval '30 minutes' where id = $1`, [sessions.early]);
  snap = await snapshot(db);
  items = needsAttention(snap, { today: TODAY, now: Date.now() });
  assert.ok(items.some(item => item.kind === 'changed_since_publish' && item.target.id === sessions.early));
});

// ── Scenario 5: extending a class after availability was submitted ─────────

test('extending a class past the submitted window is never covered by the earlier review', async () => {
  const { db, staff } = await world();
  // Ava's submitted window is 5:00–8:00 am; Ben is only free that evening but
  // confirmed this exact class on its own.
  await submit(db, ids.ava, { weekly: [{ weekday: weekdayOf(day(14)), start: 300, end: 480, status: 'AVAILABLE' }], exceptions: [] });
  await submit(db, ids.ben, { weekly: [{ weekday: weekdayOf(day(14)), start: 1000, end: 1200, status: 'AVAILABLE' }], exceptions: [] });
  const session = await addSession(db, day(14), 375, 60, { title: 'Synthetic extended' });
  await rpc(db, ids.ben, 'select public.staff_roster_confirm_session($1, $2, $3)', [session, 'AVAILABLE', rid()]);
  // Ava resubmits so this class is part of what her submission reviewed.
  await submit(db, ids.ava, { weekly: [{ weekday: weekdayOf(day(14)), start: 300, end: 480, status: 'AVAILABLE' }], exceptions: [] });
  const status = async staffId => (await db.query('select status from public.staff_roster_availability($1, $2)', [[staffId], [session]])).rows[0].status;
  assert.equal(await status(staff.ava), 'AVAILABLE');
  assert.equal(await status(staff.ben), 'AVAILABLE');
  let snap = await snapshot(db);
  assert.equal(planningContext(snap).sessions.get(session).addedSinceSubmission.has(staff.ava), false, 'reviewed at this exact duty');
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);

  // The class now runs 6:15–8:45 am, past Ava's 8:00 am window.
  await db.query(`update public.class_sessions set end_time = $2, duration_minutes = 150 where id = $1`, [session, gymInstantIso(day(14), 525)]);
  assert.equal(await status(staff.ava), 'PARTIAL', 'the submitted window no longer covers the whole duty');
  assert.equal(await status(staff.ben), 'UNKNOWN', 'a confirmation for the shorter duty does not carry over');

  const server = await rpc(db, ids.owner, 'select public.staff_roster_check_assignment($1, $2, $3, $4)', [MONTH_DATE, session, 'lead', staff.ava]);
  assert.ok(server.includes('AVAILABILITY_PARTIAL'), server.join(','));
  const benServer = await rpc(db, ids.owner, 'select public.staff_roster_check_assignment($1, $2, $3, $4)', [MONTH_DATE, session, 'lead', staff.ben]);
  assert.ok(benServer.includes('AVAILABILITY_UNKNOWN'), benServer.join(','));

  snap = await snapshot(db);
  const ctx = planningContext(snap, { view: 'published', now: Date.now() });
  assert.deepEqual([...ctx.sessions.get(session).addedSinceSubmission].sort(), [staff.ava, staff.ben].sort(), 'the review no longer matches this duty');
  const existing = ctx.assignments.filter(item => item.sessionId === session).map(item => item.id);
  for (const [member, expected] of [[staff.ava, 'AVAILABILITY_PARTIAL'], [staff.ben, 'AVAILABILITY_UNKNOWN']]) {
    const browser = checkAssignment(ctx, { sessionId: session, slotKey: 'lead', staffId: member }, { ignoreAssignmentIds: existing });
    assert.ok(browser.hard.some(item => item.code === expected), `${member}: ${browser.hard.map(item => item.code)}`);
  }
  const items = needsAttention(snap, { today: TODAY, now: Date.now() });
  assert.ok(items.some(item => item.kind === 'invalid_published' && item.target.id === session), 'published line flagged');

  const coverage = coverageReport(ctx, [session]);
  assert.equal(coverage.bySession[session].status, 'gap', 'the stale assignment is not counted as cover');
  assert.equal(coverage.totals.filledPositions, 0);
  assert.deepEqual(coverage.invalid.map(item => [item.staffId, item.problems.includes('AVAILABILITY_PARTIAL')]), [[staff.ava, true]]);
  assert.deepEqual(coverage.gaps.map(item => [item.sessionId, item.candidates, item.invalidAssignment]), [[session, 0, true]]);
  const suggestion = suggestDraft(planningContext(snap, { view: 'draft', now: Date.now() }), { sessionIds: [session], mode: 'keep' });
  assert.equal(suggestion.kept.length, 0, 'the old assignment is not silently kept');
  assert.equal(suggestion.added.length, 0, 'nobody is suggested for a duty no-one covers');
  assert.deepEqual(suggestion.unfilled.map(item => item.sessionId), [session]);

  // A draft built on the published roster cannot republish the stale line.
  const spare = await addSession(db, day(21), 375, 60);
  await apply(db, [{ op: 'assign', session_id: spare, slot_key: 'lead', staff_id: staff.ava }]);
  const blocked = await publish(db);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocked.some(item => item.session_id === session && item.problems.includes('AVAILABILITY_PARTIAL')));
});
