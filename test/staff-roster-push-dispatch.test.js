// Server-side dispatch of roster pushes, independent of any roster screen.
// SYNTHETIC DATA ONLY: fictional coaches, fake device tokens, APNs mocked,
// PGlite running both real roster migrations.
//
// The reproduction this replaces (commit "reproduce a Class-calendar retime
// that is never pushed", run against the first release): the retime notice
// was created, no push work existed, the only claimer needed a signed-in
// staff caller, and after a day the notice aged out of the sweep for good.
import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchStaffRosterPushes } from '../src/lib/staffRosterPush.js';
import { MONTH_DATE, rpc, rid } from './helpers/staff-roster-world.mjs';
import {
  APNS_ENV, deliveries, fakeAPNs, ids, pgAdmin, pushWorld, retime, token,
} from './helpers/staff-roster-push-kit.mjs';

const scheduler = (db, apns, extra = {}) => dispatchStaffRosterPushes({ admin: pgAdmin(db), environment: APNS_ENV, connect: apns.connect, ...extra });
const retimeNotices = async db => (await db.query(`select id, created_at from public.staff_notifications where kind = 'session_retimed' and recipient_profile_id = $1 order by created_at, id`, [ids.ava])).rows;

test('a Class-calendar retime is pushed by the scheduler with nobody opening a roster screen', async () => {
  const { db, session } = await pushWorld();
  // Clear the publish notice so only the retime is in play.
  await db.query(`update public.staff_notifications set read_at = now() where kind = 'roster_published'`);
  await retime(db, session, 405);
  const [notice] = await retimeNotices(db);
  assert.ok(notice, 'the in-app notice is created');

  const pending = await deliveries(db, 'd.notification_id = $1', [notice.id]);
  assert.deepEqual(pending.map(row => [row.status, row.attempts]), [['pending', 0], ['pending', 0]], 'durable pending work, one per enabled device, written with the notice');

  const apns = fakeAPNs();
  const result = await scheduler(db, apns);
  assert.equal(result.claimed, 2);
  assert.equal(result.accepted, 2);
  assert.equal(apns.sent.length, 2);
  const [first] = apns.sent;
  assert.equal(first.body.staff_notification_id, notice.id);
  assert.equal(first.body.audience, 'coach');
  assert.equal(first.body.open_path, '/open/coaching/roster');
  assert.equal(first.body.aps.alert.body, 'A class on your roster has changed. Open the app to see it.');
  assert.equal(first.headers['apns-collapse-id'], `staff-notice-${notice.id}`);
  const rows = await deliveries(db, 'd.notification_id = $1', [notice.id]);
  assert.deepEqual(rows.map(row => row.status), ['accepted', 'accepted']);
  assert.deepEqual(apns.sent.map(item => item.headers['apns-id']).sort(), rows.map(row => row.id).sort(), 'apns-id is the work item id');
  const classStart = (await db.query('select start_time from public.class_sessions where id = $1', [session])).rows[0].start_time;
  for (const item of apns.sent) assert.ok(Number(item.headers['apns-expiration']) <= classStart.getTime() / 1000, 'Apple stops trying once the class starts');

  const again = await scheduler(db, apns);
  assert.equal(again.claimed, 0, 'a second run sends nothing again');
  assert.equal(apns.sent.length, 2);
});

test('obsolete instructions are closed honestly, never sent to empty the queue', async () => {
  const { db, session } = await pushWorld();
  await db.query(`update public.staff_notifications set read_at = now() where kind = 'roster_published'`);
  await retime(db, session, 405);
  await retime(db, session, 435);
  const [older, newer] = await retimeNotices(db);
  const apns = fakeAPNs();
  await scheduler(db, apns);
  assert.deepEqual(apns.sent.map(item => item.body.staff_notification_id), [newer.id, newer.id], 'only the current time is pushed');
  assert.deepEqual((await deliveries(db, 'd.notification_id = $1', [older.id])).map(row => [row.status, row.reason]),
    [['superseded', 'NEWER_NOTICE'], ['superseded', 'NEWER_NOTICE']]);

  // A class moved back, cancelled after a retime, or already started.
  const { db: db2, session: s2 } = await pushWorld();
  await db2.query(`update public.staff_notifications set read_at = now() where kind = 'roster_published'`);
  await retime(db2, s2, 405);
  await db2.query(`update public.staff_roster_settings set enabled = false`);
  await retime(db2, s2, 375); // changed back while notices were off: no new notice
  await db2.query(`update public.staff_roster_settings set enabled = true`);
  const apns2 = fakeAPNs();
  await scheduler(db2, apns2);
  assert.equal(apns2.sent.length, 0);
  assert.deepEqual((await deliveries(db2)).filter(row => row.kind === 'session_retimed').map(row => [row.status, row.reason]),
    [['superseded', 'CLASS_CHANGED_AGAIN'], ['superseded', 'CLASS_CHANGED_AGAIN']]);

  const { db: db3, session: s3 } = await pushWorld();
  await db3.query(`update public.staff_notifications set read_at = now() where kind = 'roster_published'`);
  await retime(db3, s3, 405);
  // The class has started by the time the dispatcher runs.
  await db3.query(`update public.staff_notifications set dedupe_key = regexp_replace(dedupe_key, ':retimed:[0-9]+:', ':retimed:' || extract(epoch from now() - interval '1 minute')::bigint || ':') where kind = 'session_retimed'`);
  const apns3 = fakeAPNs();
  await scheduler(db3, apns3);
  assert.equal(apns3.sent.length, 0);
  assert.deepEqual((await deliveries(db3)).filter(row => row.kind === 'session_retimed').map(row => row.status), ['expired', 'expired']);
});

test('staleness is separate from cadence: old, read, and no-longer-allowed notices are not pushed', async () => {
  const { db, staff } = await pushWorld();
  const apns = fakeAPNs();
  // The dispatcher was down for 13 hours: the publish notice is now too old.
  await db.query(`update public.staff_notifications set created_at = now() - interval '13 hours', deliver_after = now() - interval '13 hours'`);
  await scheduler(db, apns);
  assert.equal(apns.sent.length, 0);
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.reason]), [['expired', 'TOO_OLD'], ['expired', 'TOO_OLD']]);

  const { db: read } = await pushWorld();
  await read.query(`update public.staff_notifications set read_at = now()`);
  await scheduler(read, apns);
  assert.deepEqual((await deliveries(read)).map(row => [row.status, row.reason]), [['skipped', 'READ_IN_APP'], ['skipped', 'READ_IN_APP']]);

  const { db: gone, staff: goneStaff } = await pushWorld();
  await gone.query(`update public.staff_members set status = 'inactive' where id = $1`, [goneStaff.ava]);
  await scheduler(gone, apns);
  assert.deepEqual((await deliveries(gone)).map(row => [row.status, row.reason]), [['skipped', 'RECIPIENT_NOT_ACTIVE_COACH'], ['skipped', 'RECIPIENT_NOT_ACTIVE_COACH']]);
  assert.equal(apns.sent.length, 0);
  assert.ok(staff);
});

test('scheduled reminders wait for their time, then go; a coach who already answered is not reminded', async () => {
  const { db } = await pushWorld();
  await db.query(`update public.staff_notifications set read_at = now()`);
  await db.query(`insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link, month, deliver_after) values
    ($1, 'availability_reminder', 'synthetic:later', 'Later', 'Not yet', '/coaching?tab=availability', $2, now() + interval '2 hours'),
    ($3, 'availability_reminder', 'synthetic:ava', 'Reminder', 'Please answer', '/coaching?tab=availability', $2, now())`, [ids.ben, MONTH_DATE, ids.ava]);
  const apns = fakeAPNs();
  await scheduler(db, apns);
  assert.equal(apns.sent.length, 0, 'Ava already submitted; Ben’s reminder is not due');
  assert.deepEqual((await deliveries(db, `n.dedupe_key = 'synthetic:ava'`)).map(row => [row.status, row.reason]),
    [['superseded', 'ALREADY_SUBMITTED'], ['superseded', 'ALREADY_SUBMITTED']]);
  const later = await deliveries(db, `n.dedupe_key = 'synthetic:later'`);
  assert.deepEqual(later.map(row => [row.status, row.attempts]), [['pending', 0]]);
  await db.query(`update public.staff_notifications set deliver_after = now() - interval '1 minute' where dedupe_key = 'synthetic:later'`);
  await db.query(`update public.staff_notification_push_deliveries set next_attempt_at = now() - interval '1 minute' where status = 'pending'`);
  await scheduler(db, apns);
  assert.deepEqual(apns.sent.map(item => [item.body.audience, item.body.open_path]), [['coach', '/open/coaching/availability']]);
});

test('notices from coach and manager actions are dispatched too, to the right destination', async () => {
  const { db } = await pushWorld();
  await db.query(`update public.staff_notifications set read_at = now()`);
  // A coach asks for time away (native or web: the same RPC) -> manager notice.
  await rpc(db, ids.ava, 'select public.staff_roster_request_absence($1, $2, $3, $4, $5)', [
    new Date(Date.now() + 40 * 86400000).toISOString(), new Date(Date.now() + 41 * 86400000).toISOString(), 'planned', 'Synthetic reason', rid()]);
  const apns = fakeAPNs();
  await scheduler(db, apns);
  const toOwner = apns.sent.filter(item => item.headers[':path'].endsWith(token('e')));
  assert.equal(toOwner.length, 1);
  assert.equal(toOwner[0].body.audience, 'manager');
  assert.match(toOwner[0].body.open_path, /^\/admin\/roster\?rosterTab=requests(&rosterMonth=\d{4}-\d{2})?$/);
  assert.doesNotMatch(JSON.stringify(toOwner[0].body), /Synthetic reason|rosterFocus/);
});

test('roster off: pending work is left alone and sent once it is back on (if still fresh)', async () => {
  const { db } = await pushWorld();
  await db.query('update public.staff_roster_settings set enabled = false');
  const apns = fakeAPNs();
  const off = await scheduler(db, apns);
  assert.equal(off.enabled, false);
  assert.equal(off.claimed, 0);
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.attempts]), [['pending', 0], ['pending', 0]]);
  await db.query('update public.staff_roster_settings set enabled = true');
  const on = await scheduler(db, apns);
  assert.equal(on.accepted, 2);
});

test('without APNs configured nothing is leased: the work stays pending and unattempted', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs();
  const result = await dispatchStaffRosterPushes({ admin: pgAdmin(db), environment: {}, connect: apns.connect });
  assert.equal(result.configured, false);
  assert.deepEqual(result.missing, ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY']);
  assert.equal(apns.sent.length, 0);
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.attempts, row.lease_token]), [['pending', 0, null], ['pending', 0, null]]);
});

test('a phone registered after a still-fresh notice gets it; a stale one does not', async () => {
  const { db } = await pushWorld();
  await db.query(`insert into public.push_subscriptions (user_id, device_token, environment) values ($1, $2, 'production')`, [ids.ava, token('f')]);
  const apns = fakeAPNs();
  await scheduler(db, apns);
  assert.equal(apns.sent.length, 3);
  assert.equal(apns.sent.filter(item => item.headers[':path'].endsWith(token('f'))).length, 1);

  // Thirteen hours on, another new phone gets none of that history.
  await db.query(`update public.staff_notifications set created_at = now() - interval '13 hours', deliver_after = now() - interval '13 hours'`);
  await db.query(`insert into public.push_subscriptions (user_id, device_token, environment) values ($1, $2, 'production')`, [ids.ava, token('9')]);
  await scheduler(db, apns);
  assert.equal(apns.sent.length, 3);
  assert.equal((await deliveries(db, 's.device_token = $1', [token('9')])).length, 0);
});
