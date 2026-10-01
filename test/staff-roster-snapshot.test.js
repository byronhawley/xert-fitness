import assert from 'node:assert/strict';
import test from 'node:test';

import { checkAssignment } from '../src/lib/staffRoster/validate.js';
import { needsAttention, planningContext, publishImpact, submissionProgress } from '../src/lib/staffRoster/snapshot.js';
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
