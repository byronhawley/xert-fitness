// Coach vs manager notification destinations, end to end over the real
// migrations with APNs mocked. SYNTHETIC DATA ONLY.
//
// Contract: the push carries `audience` ('coach' | 'manager') and `open_path`.
// Coach notices open My Coaching (`/open/coaching/<tab>[?month=]`); manager
// notices open the web manager console (`/admin/roster?rosterTab=…[&rosterMonth=…]`)
// because My Coaching is coach-only. The destination never carries record ids,
// and the server checks the role again: when the push is sent and when the
// page loads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchStaffRosterPushes } from '../src/lib/staffRosterPush.js';
import { authPathWithNext, safeAuthReturnPath } from '../src/lib/authRedirect.js';
import { MONTH, MONTH_DATE, rejects, rid, rpc } from './helpers/staff-roster-world.mjs';
import { APNS_ENV, deliveries, fakeAPNs, ids, pgAdmin, pushWorld, token } from './helpers/staff-roster-push-kit.mjs';

const dispatch = (db, apns) => dispatchStaffRosterPushes({ admin: pgAdmin(db), environment: APNS_ENV, connect: apns.connect });
const to = (apns, deviceToken) => apns.sent.filter(item => item.headers[':path'].endsWith(deviceToken)).map(item => item.body);
const askForTimeAway = (db, uid) => rpc(db, uid, 'select public.staff_roster_request_absence($1, $2, $3, $4, $5)', [
  new Date(Date.now() + 40 * 86400000).toISOString(), new Date(Date.now() + 41 * 86400000).toISOString(), 'planned', 'Synthetic private reason', rid()]);

test('an active coach’s personal notice opens My Coaching', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs();
  await dispatch(db, apns);
  const [body] = to(apns, token('a'));
  assert.equal(body.audience, 'coach');
  assert.equal(body.open_path, `/open/coaching/roster?month=${MONTH}`);
});

test('an admin who is not a coach gets a manager request in the web console', async () => {
  const { db } = await pushWorld();
  await db.query('update public.staff_notifications set read_at = now()');
  await askForTimeAway(db, ids.ava);
  const apns = fakeAPNs();
  await dispatch(db, apns);
  const [body] = to(apns, token('e'));
  assert.equal(body.audience, 'manager');
  assert.match(body.open_path, /^\/admin\/roster\?rosterTab=requests&rosterMonth=\d{4}-\d{2}$/);
  assert.doesNotMatch(JSON.stringify(body), /rosterFocus|Synthetic private reason|Ava/);
  assert.equal(safeAuthReturnPath(body.open_path), body.open_path, 'a same-origin path the sign-in return accepts unchanged');
});

test('an admin who is also a coach: manager requests go to the console, their own roster notices to My Coaching', async () => {
  const { db, staff } = await pushWorld();
  await db.query(`update public.profiles set role = 'admin' where id = $1`, [ids.ben]);
  await db.query('update public.staff_notifications set read_at = now()');
  await askForTimeAway(db, ids.ava);
  // Ben's own coaching notice.
  await db.query(`insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link, month) values
    ($1, 'cover_approved', 'synthetic:ben-cover', 'Cover approved', 'You are covering', '/coaching?tab=roster&month=${MONTH}', $2)`, [ids.ben, MONTH_DATE]);
  const apns = fakeAPNs();
  await dispatch(db, apns);
  const bodies = to(apns, token('d'));
  assert.deepEqual(bodies.map(body => [body.audience, body.open_path.split('?')[0]]).sort(), [
    ['coach', '/open/coaching/roster'],
    ['manager', '/admin/roster'],
  ]);
  assert.ok(staff.ben);
});

test('a signed-out recipient keeps the destination through sign-in, with no open redirect', () => {
  // The web console renders its sign-in form in place at the same URL
  // (AdminRoute), so /admin/roster?rosterTab=…&rosterMonth=… is still the URL
  // after signing in (proved in the browser workflow). Coach links go
  // through /login?next=…, which only accepts same-origin paths.
  const manager = '/admin/roster?rosterTab=requests&rosterMonth=2026-12';
  assert.equal(safeAuthReturnPath(manager), manager);
  assert.equal(authPathWithNext('/login', '/coaching?tab=requests&month=2026-12'), '/login?next=%2Fcoaching%3Ftab%3Drequests%26month%3D2026-12');
  for (const hostile of ['//evil.example/admin/roster', 'https://evil.example/admin/roster', '/\\evil.example', '/..//evil.example']) {
    assert.equal(safeAuthReturnPath(hostile), '/', hostile);
  }
});

test('permission revoked after the notice was written: no push, and the console refuses', async () => {
  const { db } = await pushWorld();
  await db.query('update public.staff_notifications set read_at = now()');
  await askForTimeAway(db, ids.ava);
  await db.query(`update public.profiles set role = 'member' where id = $1`, [ids.owner]);
  const apns = fakeAPNs();
  await dispatch(db, apns);
  assert.deepEqual(to(apns, token('e')), [], 'a former manager gets no manager push');
  assert.deepEqual((await deliveries(db, 'd.recipient_profile_id = $1', [ids.owner])).map(row => [row.status, row.reason]), [['skipped', 'RECIPIENT_NOT_MANAGER']]);
  // Opening the link anyway: every manager RPC behind the page refuses.
  await rejects(db, ids.owner, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE], /MANAGER_ONLY/);
  await rejects(db, ids.owner, 'select public.staff_roster_notification_log($1, 10)', [MONTH_DATE], /MANAGER_ONLY/);

  // A coach switched to inactive: their pending coach notice is not pushed either.
  const { db: db2, staff } = await pushWorld();
  await db2.query(`update public.staff_members set status = 'inactive' where id = $1`, [staff.ava]);
  const apns2 = fakeAPNs();
  await dispatch(db2, apns2);
  assert.deepEqual(to(apns2, token('a')), []);
  await rejects(db2, ids.ava, 'select public.staff_roster_me()', [], /STAFF_INACTIVE/);
});
