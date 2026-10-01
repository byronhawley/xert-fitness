// Server-side dispatch of roster pushes, independent of any roster screen.
// SYNTHETIC DATA ONLY: fictional coaches, fake device tokens, APNs mocked.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ids, rpc, world, addSession, allWeek, submit, apply, publish, day } from './helpers/staff-roster-world.mjs';
import { as } from './helpers/staff-roster-db.mjs';
import { gymInstantIso } from '../src/lib/staffRoster/time.js';

const PUSH_TABLE = `
  create table public.push_subscriptions (
    id uuid primary key default gen_random_uuid(), user_id uuid not null, device_token text not null,
    environment text not null, enabled boolean not null default true
  );`;

// REPRODUCTION (written against the first release, before the fix): a class
// is retimed through the normal Class calendar update path, the coach's notice
// is created, and nobody opens a roster screen afterwards.
test('reproduction: a Class-calendar retime creates a notice that nothing ever pushes', async () => {
  const { db, staff } = await world();
  await db.exec(PUSH_TABLE);
  await db.query(`insert into public.push_subscriptions (user_id, device_token, environment) values ($1, $2, 'production')`, [ids.ava, 'a'.repeat(64)]);
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(12), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);

  // Normal admin class update (the Class calendar's RPC), not a roster action.
  await rpc(db, ids.owner, 'select public.admin_update_class_session($1, $2::jsonb)', [session, JSON.stringify({
    start_time: gymInstantIso(day(12), 405), end_time: gymInstantIso(day(12), 465), duration_minutes: 60, title: 'Synthetic class' })]);
  const notice = (await db.query(`select id from public.staff_notifications where kind = 'session_retimed' and recipient_profile_id = $1`, [ids.ava])).rows[0];
  assert.ok(notice, 'the in-app notice is created');

  // What happens to push: nothing. No work item exists ...
  const rows = async () => (await db.query('select status from public.staff_notification_push_deliveries where notification_id = $1', [notice.id])).rows;
  assert.deepEqual(await rows(), [], 'no push work exists for the retime notice');
  // ... and the only claimer needs a signed-in manager or coach: a scheduler has no identity to run it with.
  await as(db, null);
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries(null, 200)'), /NOT_STAFF/);
  // A day later, even the next roster action's sweep no longer picks it up.
  await db.query(`update public.staff_notifications set created_at = created_at - interval '25 hours', deliver_after = deliver_after - interval '25 hours' where id = $1`, [notice.id]);
  const late = (await db.query('select public.staff_roster_claim_push_deliveries($1, 200) as r', [ids.owner])).rows[0].r;
  assert.equal(late.some(row => row.notification_id === notice.id), false, 'aged out of the one-day window, never pushed');
  assert.deepEqual(await rows(), []);
});
