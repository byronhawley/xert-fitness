// Day-first availability against the REAL roster migrations in PGlite.
// SYNTHETIC DATA ONLY: fictional coaches and classes; email notices are off.
import assert from 'node:assert/strict';
import test from 'node:test';

import { monthClassSessions } from '../src/lib/staffRoster/availabilityEditor.js';
import { setClassStatus, setDay, setDayRange, toggleWeekday } from '../src/lib/staffRoster/dayAvailability.js';
import { datesOfMonth, gymInstantIso, weekdayOf } from '../src/lib/staffRoster/time.js';
import { addSession, ids, MONTH, MONTH_DATE, rid, rpc, submit, world } from './helpers/staff-roster-world.mjs';

const EMPTY = { weekly: [], exceptions: [], noAvailability: false };
const datesOn = weekday => datesOfMonth(MONTH).filter(date => weekdayOf(date) === weekday);

async function monthClasses(db, uid) {
  return monthClassSessions(await rpc(db, uid, 'select public.staff_roster_month_classes($1)', [MONTH_DATE]));
}

test('a day-first answer is accepted by the real submit, and the manager’s matrix shows each class’s answer', async () => {
  const { db, staff } = await world();
  // Synthetic staffing: Engine classes have 10 minutes of setup, so back-to-back duties share time.
  await rpc(db, ids.owner, 'select public.staff_roster_set_staffing($1, $2, $3::jsonb, 0, $4)', ['class_type', 'XERT Engine',
    JSON.stringify({ slots: [{ key: 'lead', role: 'lead' }], prep_minutes: 10, wrap_minutes: 0, allow_block: true }), rid()]);
  const [tue, tue2] = datesOn(2);
  const [wed] = datesOn(3);
  const [thu] = datesOn(4);
  const [mon] = datesOn(1);
  const [sun] = datesOn(0);
  const id = {
    tue515: await addSession(db, tue, 315, 45),
    tue615: await addSession(db, tue, 375, 45, { classType: 'XERT Engine' }),
    tue2_515: await addSession(db, tue2, 315, 45),
    wedStrength: await addSession(db, wed, 1050, 60),
    wedMobility: await addSession(db, wed, 1050, 60, { classType: 'XERT Mobility' }),
    wedEngine: await addSession(db, wed, 1110, 45, { classType: 'XERT Engine' }),
    thu930: await addSession(db, thu, 570, 60),
    mon515: await addSession(db, mon, 315, 45),
  };
  const sessions = await monthClasses(db, ids.ava);
  assert.equal(sessions.length, Object.keys(id).length);

  let answer = toggleWeekday(EMPTY, MONTH, sessions, 2, 'available');
  answer = setClassStatus(answer, MONTH, sessions, tue, id.tue615, 'PREFERRED');
  answer = setDay(answer, MONTH, sessions, tue2, 'away');
  answer = setDay(answer, MONTH, sessions, wed, 'available');
  // Strength and Mobility run at the same time; the Engine's setup starts during them.
  answer = setClassStatus(answer, MONTH, sessions, wed, id.wedMobility, 'UNAVAILABLE');
  answer = setClassStatus(answer, MONTH, sessions, thu, id.thu930, 'PREFERRED');
  answer = setDay(answer, MONTH, sessions, sun, 'available');
  answer = setDayRange(answer, MONTH, sun, 960, 1260);
  assert.deepEqual(answer.weekly, []);

  const result = await submit(db, ids.ava, answer);
  assert.equal(result.version, 1, 'the real staff_roster_submit_availability accepts it (no EXCEPTION_CONTRADICTION)');
  const { rows: [stored] } = await db.query('select payload from public.staff_availability_submissions where staff_id = $1', [staff.ava]);
  assert.deepEqual(stored.payload.exceptions.length, answer.exceptions.length);

  const snapshot = await rpc(db, ids.owner, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE]);
  const status = sessionId => snapshot.availability.find(item => item.staff_id === staff.ava && item.session_id === sessionId)?.status || 'UNKNOWN';
  assert.deepEqual(Object.fromEntries(Object.entries(id).map(([key, sessionId]) => [key, status(sessionId)])), {
    tue515: 'AVAILABLE',
    tue615: 'PREFERRED',
    tue2_515: 'UNAVAILABLE',
    wedStrength: 'UNAVAILABLE',
    wedMobility: 'UNAVAILABLE',
    wedEngine: 'UNAVAILABLE',
    thu930: 'PREFERRED',
    mon515: 'UNKNOWN',
  }, 'can’t wins shared duty time; blank Monday stays unanswered');
  // Ben never answered: unanswered everywhere, never available.
  assert.ok(Object.values(id).every(sessionId => (snapshot.availability.find(item => item.staff_id === staff.ben && item.session_id === sessionId)?.status || 'UNKNOWN') === 'UNKNOWN'));

  // The free Sunday is stored as a 4–9 pm window the server expands like any other.
  const { rows } = await db.query(`select lower(w.during) as s, upper(w.during) as e from public.staff_availability_windows w
    where w.staff_id = $1 and w.status = 'AVAILABLE' and lower(w.during) >= $2 and upper(w.during) <= $3`, [staff.ava, gymInstantIso(sun, 0), gymInstantIso(sun, 1440)]);
  assert.deepEqual(rows.map(row => [new Date(row.s).toISOString(), new Date(row.e).toISOString()]), [[gymInstantIso(sun, 960), gymInstantIso(sun, 1260)]]);
});

test('a month answered day by day can be resubmitted after changing one class, and the matrix follows', async () => {
  const { db, staff } = await world();
  const [tue] = datesOn(2);
  const early = await addSession(db, tue, 315, 45);
  const late = await addSession(db, tue, 1050, 60);
  const sessions = await monthClasses(db, ids.ava);
  let answer = setDay(EMPTY, MONTH, sessions, tue, 'available');
  await submit(db, ids.ava, answer);
  answer = setClassStatus(answer, MONTH, sessions, tue, late, 'UNAVAILABLE');
  const second = await submit(db, ids.ava, answer);
  assert.equal(second.version, 2);
  const { rows } = await db.query('select session_id, status from public.staff_roster_availability($1, $2)', [[staff.ava], [early, late]]);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.session_id, row.status])), { [early]: 'AVAILABLE', [late]: 'UNAVAILABLE' });
});
