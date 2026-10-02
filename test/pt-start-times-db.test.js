import assert from 'node:assert/strict';
import test from 'node:test';

import { ptWorld, setUpAva, slots, book, ids, rid, rpc, rejects, inDays, at, DIANA } from './helpers/pt-booking-world.mjs';

// SYNTHETIC DATA ONLY: fictional coaches and clients. No email can be sent.

const iso = (date, minute) => new Date(at(date, minute)).toISOString();
const saveHours = (db, hours, version) => rpc(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, 0, $2)', [JSON.stringify(hours), version]);

test('a coach can offer exact start times instead of, or as well as, a window', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  const date = inDays(3);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const saved = await saveHours(db, [
    { weekday, start: 1080, kind: 'start' }, { weekday, start: 360, kind: 'start' },
    { weekday, start: 360, kind: 'start' }, { weekday, start: 720, end: 840 },
  ], 1);
  assert.deepEqual(saved.hours, [
    { weekday, start: 360, kind: 'start' }, { weekday, start: 720, end: 840 }, { weekday, start: 1080, kind: 'start' },
  ], 'sorted, and the repeated 6:00 is kept once');
  assert.deepEqual(await slots(db, service.id, date), [iso(date, 360), iso(date, 720), iso(date, 750), iso(date, 780), iso(date, 1080)]);

  await book(db, service.id, iso(date, 1080));
  assert.ok(!(await slots(db, service.id, date)).includes(iso(date, 1080)), 'a booked start time is gone');
  await rejects(db, null, 'select public.pt_public_book($1::jsonb, $2)', [JSON.stringify({ service_id: service.id, starts_at: iso(date, 390),
    full_name: 'Casey Client', email: 'casey2@example.test' }), rid()], /SLOT_UNAVAILABLE/, 'only the set start time, not times after it');
  const coaches = await rpc(db, null, 'select public.pt_public_coaches()');
  assert.equal(coaches.coaches.length, 1, 'start times count as hours');
});

test('start times are checked like windows, and windows still cannot overlap', async () => {
  const { db } = await ptWorld();
  await setUpAva(db);
  await rejects(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, 0, 1)', [JSON.stringify([{ weekday: 1, start: 1440, kind: 'start' }])], /HOURS_INVALID/);
  await rejects(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, 0, 1)', [JSON.stringify([{ weekday: 1, start: 362, kind: 'start' }])], /HOURS_INVALID/);
  await rejects(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, 0, 1)', [JSON.stringify([{ weekday: 1, start: 360, kind: 'slot' }])], /HOURS_INVALID/);
  await rejects(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, 0, 1)', [JSON.stringify([{ weekday: 1, start: 360, end: 600 }, { weekday: 1, start: 540, end: 700 }])], /HOURS_OVERLAP/);
  const ok = await saveHours(db, [{ weekday: 1, start: 360, end: 600 }, { weekday: 1, start: 420, kind: 'start' }], 1);
  assert.equal(ok.hours.length, 2, 'a start time inside a window is allowed');
});

test('a late start time is only offered when the whole session fits the day', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  const date = inDays(3);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  await saveHours(db, [{ weekday, start: 1400, kind: 'start' }, { weekday, start: 1200, kind: 'start' }], 1);
  assert.deepEqual(await slots(db, service.id, date), [iso(date, 1200)]);
});

test('a signed-in member sees their own upcoming PT and packages, nobody else’s', async () => {
  const { db } = await ptWorld();
  const { service, packageId } = await setUpAva(db);
  const date = inDays(3);
  await book(db, service.id, iso(date, 360), { package_id: packageId, email: 'diana@example.test', full_name: 'Diana Synthetic' }, DIANA);
  await book(db, service.id, iso(date, 480), { email: 'casey@example.test' });
  await rejects(db, null, 'select public.pt_member_overview()', [], /SIGN_IN_REQUIRED|permission denied/);
  const mine = await rpc(db, DIANA, 'select public.pt_member_overview()');
  assert.equal(mine.enabled, true);
  assert.equal(mine.bookings.length, 1);
  assert.equal(mine.bookings[0].coach_name, 'Ava');
  assert.equal(mine.bookings[0].starts_at && new Date(mine.bookings[0].starts_at).toISOString(), iso(date, 360));
  assert.ok(mine.bookings[0].token);
  assert.equal(mine.packages.length, 1);
  assert.equal(mine.packages[0].remaining, 4);
  assert.equal(mine.packages[0].coach_name, 'Ava');
  const other = await rpc(db, ids.member, 'select public.pt_member_overview()');
  assert.deepEqual([other.bookings, other.packages], [[], []]);
});
