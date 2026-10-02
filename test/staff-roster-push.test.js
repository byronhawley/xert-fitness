// Phone push for coach roster notices. SYNTHETIC DATA ONLY: fictional
// coaches and fake device tokens; APNs is a local mock, so nothing here can
// reach a real device or service.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STAFF_PUSH_TITLE, buildStaffRosterPush, dispatchStaffRosterPushes, isSchedulerToken, staffPushAudience, staffPushBody, staffPushOpenPath,
  staffRosterPushHandler as handler,
} from '../src/lib/staffRosterPush.js';
import pushSubscriptionHandler from '../api/push-subscription.js';
import { createStaffRosterClient, requestRosterPush } from '../src/lib/staffRosterData.js';
import { MONTH, ids, rid, rpc } from './helpers/staff-roster-world.mjs';
import { as } from './helpers/staff-roster-db.mjs';
import { APNS_ENV, fakeAPNs, pushWorld } from './helpers/staff-roster-push-kit.mjs';

const NOTICE = '3a9791d6-d79b-4eeb-9ad0-d8a6a66bff45';

// ── Payload contract shared with the native app ────────────────────────────

test('the roster push payload follows the native contract and says nothing private', () => {
  const payload = buildStaffRosterPush({
    notification_id: NOTICE.toUpperCase(), kind: 'absence_rejected',
    link: '/coaching?tab=requests', title: 'Absence rejected', body: 'Ava asked for time off: hospital appointment',
  });
  assert.deepEqual(payload, {
    aps: {
      alert: { title: 'XERT coaching', body: 'One of your requests has an update. Open the app to see it.' },
      sound: 'default', category: 'xert.staff-roster', 'thread-id': 'xert-staff-roster',
    },
    staff_notification_id: NOTICE,
    audience: 'coach',
    open_path: '/open/coaching/requests',
  });
  assert.equal(STAFF_PUSH_TITLE, 'XERT coaching');
  assert.throws(() => buildStaffRosterPush({ notification_id: 'not-a-uuid', kind: 'roster_published' }), /STAFF_PUSH_INVALID/);

  const kinds = ['roster_published', 'cover_approved', 'cover_rejected', 'session_retimed', 'session_cancelled', 'availability_reminder',
    'availability_reopened', 'absence_approved', 'absence_rejected', 'absence_request', 'urgent_absence', 'cover_requested', 'cover_offered',
    'availability_change_request', 'overdue_summary', 'something_new'];
  for (const kind of kinds) {
    const text = staffPushBody(kind);
    assert.match(text, /^[A-Z][a-z ]+\. Open the app to see it\.$/, kind);
    assert.doesNotMatch(text, /Ava|Ben|hospital|reason|note|am|pm|\d/, `${kind} stays generic`);
  }
  assert.equal(staffPushBody('roster_published'), 'Your roster has an update. Open the app to see it.');
  assert.equal(staffPushBody('something_new'), staffPushBody('roster_published'));
  assert.equal(staffPushBody('cover_offered'), 'A roster request needs your attention. Open the app to see it.');
  assert.equal(staffPushBody('session_cancelled'), 'A class on your roster has changed. Open the app to see it.');
});

test('coach notices open My Coaching: tab and a valid month only', () => {
  const cases = [
    ['/coaching?tab=roster&month=2026-12', '/open/coaching/roster?month=2026-12'],
    ['/coaching?tab=availability&month=2027-01', '/open/coaching/availability?month=2027-01'],
    ['/coaching?tab=requests', '/open/coaching/requests'],
    ['/coaching?tab=roster', '/open/coaching/roster'],
    ['/coaching', '/open/coaching/roster'],
    ['/coaching?tab=inbox', '/open/coaching/roster'],
    ['/coaching?tab=roster&month=2026-13', '/open/coaching/roster'],
    ['/coaching?tab=roster&month=2026-12&month=2027-01', '/open/coaching/roster'],
    ['https://elsewhere.example/coaching?tab=requests', '/open/coaching/requests'],
    ['/account?tab=requests', '/open/coaching/roster'],
    [null, '/open/coaching/roster'],
    ['', '/open/coaching/roster'],
  ];
  for (const [link, expected] of cases) {
    assert.equal(staffPushOpenPath(link), expected, String(link));
    assert.equal(staffPushAudience(link), 'coach', String(link));
    assert.doesNotMatch(staffPushOpenPath(link), /elsewhere|admin/);
  }
});

test('manager notices open the web manager console, never My Coaching, with no ids in the URL', () => {
  const cases = [
    ['/admin/roster?rosterTab=requests&rosterMonth=2026-12&rosterFocus=00000000-0000-4000-8000-000000000001', '/admin/roster?rosterTab=requests&rosterMonth=2026-12'],
    ['/admin/roster?rosterTab=availability&rosterMonth=2026-12', '/admin/roster?rosterTab=availability&rosterMonth=2026-12'],
    ['/admin/roster?rosterTab=requests&rosterFocus=00000000-0000-4000-8000-000000000001', '/admin/roster?rosterTab=requests'],
    ['/admin/roster?rosterTab=activity', '/admin/roster?rosterTab=activity'],
    ['/admin/roster?rosterTab=evil&rosterMonth=2026-1', '/admin/roster?rosterTab=roster'],
    ['/admin/roster?rosterTab=requests&rosterMonth=2026-12&rosterMonth=2027-01', '/admin/roster?rosterTab=requests'],
    ['/admin/members?member=00000000-0000-4000-8000-000000000001', '/admin/roster?rosterTab=roster'],
    ['/admin', '/admin/roster?rosterTab=roster'],
  ];
  for (const [link, expected] of cases) {
    assert.equal(staffPushAudience(link), 'manager', link);
    assert.equal(staffPushOpenPath(link), expected, link);
    assert.doesNotMatch(staffPushOpenPath(link), /rosterFocus|0000-4000|\/\/|open\/coaching/);
  }
  assert.equal(staffPushAudience('/administer'), 'coach', 'only the /admin/ console counts');
  const payload = buildStaffRosterPush({ notification_id: NOTICE, kind: 'cover_offered', link: '/admin/roster?rosterTab=requests&rosterMonth=2026-12&rosterFocus=x' });
  assert.equal(payload.audience, 'manager');
  assert.equal(payload.open_path, '/admin/roster?rosterTab=requests&rosterMonth=2026-12');
  assert.equal(payload.aps.alert.body, 'A roster request needs your attention. Open the app to see it.');
});

// ── Dedupe and claiming in the real migration ──────────────────────────────

const claim = async (db, caller = null, limit = 200) => {
  await as(db, null);
  const { rows } = await db.query(`select public.staff_roster_push_claim('test-worker', $2, 180, $1) as result`, [caller, limit]);
  return rows[0].result;
};

test('each due notice is leased once per enabled device; read, old, scheduled and other people’s notices are not', async () => {
  const { db, subs } = await pushWorld();
  const avaNotice = (await db.query(`select id, link from public.staff_notifications where recipient_profile_id = $1 and kind = 'roster_published'`, [ids.ava])).rows[0];
  // Ben has a read notice, an old one, and one scheduled for later.
  await db.query(`insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link, read_at, created_at, deliver_after) values
    ($1, 'roster_published', 'synthetic:read', 'Read', 'Read already', '/coaching?tab=roster', now(), now(), now()),
    ($1, 'cover_rejected', 'synthetic:old', 'Old', 'From last week', '/coaching?tab=requests', null, now() - interval '3 days', now() - interval '3 days'),
    ($1, 'availability_reminder', 'synthetic:later', 'Later', 'Not yet', '/coaching?tab=availability', null, now(), now() + interval '2 hours')`, [ids.ben]);

  const first = await claim(db, ids.ava);
  const avaDevices = subs.filter(row => row.user_id === ids.ava && row.enabled).map(row => row.id).sort();
  assert.deepEqual(first.map(row => row.notification_id), [avaNotice.id, avaNotice.id], 'one notice, two enabled devices');
  assert.deepEqual(first.map(row => row.subscription_id).sort(), avaDevices);
  assert.deepEqual(first.map(row => row.link), [avaNotice.link, avaNotice.link]);
  assert.ok(first.every(row => row.device_token && row.delivery_id && row.lease_token && row.attempt === 1 && ['production', 'sandbox'].includes(row.environment)));
  assert.equal(new Set(first.map(row => row.lease_token)).size, 1);
  assert.equal(JSON.stringify(first).includes('Roster updated'), false, 'titles and bodies are not handed to the sender');

  assert.deepEqual(await claim(db, ids.owner), [], 'a second sweep, by anyone, takes nothing that is leased');
  const { rows: state } = await db.query(`select n.dedupe_key, d.status, d.reason from public.staff_notification_push_deliveries d
    join public.staff_notifications n on n.id = d.notification_id order by n.dedupe_key, d.status`);
  const ben = state.filter(row => row.dedupe_key.startsWith('synthetic:'));
  assert.deepEqual(ben.map(row => [row.dedupe_key, row.status, row.reason]), [
    ['synthetic:later', 'pending', null],
    ['synthetic:old', 'expired', 'TOO_OLD'],
    ['synthetic:read', 'skipped', 'READ_IN_APP'],
  ], 'every work item says honestly why it was or was not sent');
  assert.deepEqual(state.filter(row => !row.dedupe_key.startsWith('synthetic:')).map(row => row.status), ['sending', 'sending'], 'leased, not yet sent, never called delivered');
});

test('the lease limit is honoured, and a limit of 0 only checks the switch', async () => {
  const { db } = await pushWorld();
  assert.deepEqual(await claim(db, ids.ava, 0), []);
  assert.equal((await db.query(`select count(*)::int as n from public.staff_notification_push_deliveries where status = 'sending'`)).rows[0].n, 0);
  assert.equal((await claim(db, ids.ava, 1)).length, 1);
  assert.equal((await claim(db, ids.ava, 1)).length, 1);
  assert.equal((await claim(db, ids.ava, 1)).length, 0);
});

test('only the server can lease; a nudge needs a manager or active coach; nothing while the roster is off', async () => {
  const { db, staff } = await pushWorld();
  await as(db, null);
  await assert.rejects(() => db.query(`select public.staff_roster_push_claim('w', 10, 180, $1)`, [ids.member]), /NOT_STAFF/);
  await db.query(`update public.staff_members set status = 'inactive' where id = $1`, [staff.ben]);
  await assert.rejects(() => db.query(`select public.staff_roster_push_claim('w', 10, 180, $1)`, [ids.ben]), /NOT_STAFF/);
  await assert.rejects(() => db.query(`select public.staff_roster_push_claim('bad worker name!', 10)`), /WORKER_INVALID/);
  await db.query('update public.staff_roster_settings set enabled = false');
  await assert.rejects(() => db.query(`select public.staff_roster_push_claim('w', 10)`), /ROSTER_DISABLED/);
  await assert.rejects(() => db.query(`select public.staff_roster_push_claim('w', 10, 180, $1)`, [ids.owner]), /ROSTER_DISABLED/);

  const { rows } = await db.query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec, has_function_privilege('service_role', p.oid, 'execute') as service_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'staff_roster_push%' or p.proname in ('staff_roster_claim_push_deliveries', 'staff_roster_record_push_results'))
    order by p.proname`);
  const serviceOnly = ['staff_roster_claim_push_deliveries', 'staff_roster_push_begin', 'staff_roster_push_claim', 'staff_roster_push_due',
    'staff_roster_push_record', 'staff_roster_record_push_results'];
  assert.deepEqual(rows.map(row => [row.proname, row.auth_exec, row.anon_exec, row.service_exec]), [
    ['staff_roster_claim_push_deliveries', false, false, true],
    ['staff_roster_push_begin', false, false, true],
    ['staff_roster_push_claim', false, false, true],
    ['staff_roster_push_due', false, false, true],
    ['staff_roster_push_enqueue', false, false, false],
    ['staff_roster_push_expires_at', false, false, false],
    // Trigger function from the coach-dashboard migration (switching phone pushes off closes pending ones); nobody calls it directly.
    ['staff_roster_push_off_closes_pending', false, false, false],
    ['staff_roster_push_policy', false, false, false],
    // Trigger function from the roster fixes migration (push off stops leased and retried pushes); nobody calls it directly.
    ['staff_roster_push_preference_on_update', false, false, false],
    ['staff_roster_push_record', false, false, true],
    ['staff_roster_push_stale_reason', false, false, false],
    ['staff_roster_record_push_results', false, false, true],
  ]);
  assert.equal(serviceOnly.length, 6);
  const table = await db.query(`select relrowsecurity, has_table_privilege('authenticated', oid, 'select') as auth_select,
      has_table_privilege('anon', oid, 'select') as anon_select from pg_class where relname = 'staff_notification_push_deliveries'`);
  assert.deepEqual(table.rows, [{ relrowsecurity: true, auth_select: false, anon_select: false }]);
});

test('the first release’s claim and record functions are retired: same checks, but they lease and record nothing', async () => {
  const { db } = await pushWorld();
  await as(db, null);
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries(null, 10)'), /NOT_STAFF/);
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries($1, 10)', [ids.member]), /NOT_STAFF/);
  assert.deepEqual((await db.query('select public.staff_roster_claim_push_deliveries($1, 10) as r', [ids.owner])).rows[0].r, []);
  const { rows } = await db.query(`select status from public.staff_notification_push_deliveries`);
  assert.deepEqual(rows.map(row => row.status), ['pending', 'pending'], 'nothing claimed the old way');
  const any = (await db.query(`select id from public.staff_notification_push_deliveries limit 1`)).rows[0].id;
  assert.deepEqual((await db.query(`select public.staff_roster_record_push_results($1::jsonb) as r`, [JSON.stringify([{ delivery_id: any, status: 'accepted' }])])).rows[0].r,
    { recorded: 0, disabled_tokens: 0 });
  await db.query('update public.staff_roster_settings set enabled = false');
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries($1, 10)', [ids.owner]), /ROSTER_DISABLED/);
});

test('results are recorded once, by the owning lease; invalid tokens are switched off; the log shows push separately from read', async () => {
  const { db } = await pushWorld();
  const claimed = await claim(db, ids.ava);
  const [prod, sandbox] = [claimed.find(row => row.environment === 'production'), claimed.find(row => row.environment === 'sandbox')];
  const record = async results => (await db.query('select public.staff_roster_push_record($1::jsonb) as r', [JSON.stringify(results)])).rows[0].r;
  assert.deepEqual(await record([
    { delivery_id: prod.delivery_id, lease_token: prod.lease_token, outcome: 'accepted', reason: null },
    { delivery_id: sandbox.delivery_id, lease_token: sandbox.lease_token, outcome: 'invalid_token', reason: 'Unregistered' },
  ]), { recorded: 2, retrying: 0, disabled_tokens: 1, ignored: 0 });
  assert.deepEqual(await record([{ delivery_id: prod.delivery_id, lease_token: prod.lease_token, outcome: 'failed', reason: 'late retry' }]),
    { recorded: 0, retrying: 0, disabled_tokens: 0, ignored: 1 }, 'a recorded result is never overwritten');
  assert.deepEqual(await record([{ delivery_id: rid(), lease_token: rid(), outcome: 'delivered', reason: null }]), { recorded: 0, retrying: 0, disabled_tokens: 0, ignored: 1 });
  const { rows } = await db.query('select subscription_id, status, reason, attempted_at is not null as attempted from public.staff_notification_push_deliveries order by status');
  assert.deepEqual(rows.map(row => [row.status, row.reason, row.attempted]), [['accepted', null, true], ['invalid_token', 'Unregistered', true]]);
  const sub = await db.query('select enabled from public.push_subscriptions where id = $1', [sandbox.subscription_id]);
  assert.equal(sub.rows[0].enabled, false);
  await assert.rejects(() => db.query(`select public.staff_roster_push_record('{}'::jsonb)`), /RESULTS_INVALID/);

  const notice = (await db.query(`select read_at from public.staff_notifications where id = $1`, [prod.notification_id])).rows[0];
  assert.equal(notice.read_at, null, 'a push never marks the notice read');
  const log = await rpc(db, ids.owner, 'select public.staff_roster_notification_log($1, 50)', [`${MONTH}-01`]);
  const line = log.find(row => row.id === prod.notification_id);
  assert.deepEqual(line.push, { accepted: 1, failed: 1, sending: 0, pending: 0, uncertain: 0, not_sent: 0 });
  assert.equal(line.read_at, null);
});

// ── Sending, with APNs and Supabase mocked ─────────────────────────────────

function fakeAdmin(claimed, { claimError = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, params) => {
      calls.push({ name, params });
      if (name === 'staff_roster_push_claim') return claimError ? { data: null, error: claimError } : { data: params.p_limit === 0 ? [] : claimed, error: null };
      if (name === 'staff_roster_push_begin') return { data: params.p_leases.map(item => item.delivery_id), error: null };
      if (name === 'staff_roster_push_record') return { data: { recorded: params.p_results.length }, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  };
}

const LEASE = '00000000-0000-4000-a000-00000000000f';
const row = (n, environment, extra = {}) => ({
  delivery_id: `00000000-0000-4000-8000-00000000000${n}`, lease_token: LEASE, attempt: 1, notification_id: NOTICE, subscription_id: `00000000-0000-4000-9000-00000000000${n}`,
  environment, device_token: String(n).repeat(64), kind: 'roster_published', link: '/coaching?tab=roster&month=2026-12',
  expires_at: '2026-10-01T12:00:00.000Z', ...extra,
});

test('sending pushes the generic payload to each leased device and records each outcome with its lease', async () => {
  const claimed = [row(1, 'production'), row(2, 'production', { kind: 'cover_offered', link: '/admin/roster?rosterTab=requests&rosterFocus=abc' }), row(3, 'sandbox')];
  const admin = fakeAdmin(claimed);
  const apns = fakeAPNs({ ['2'.repeat(64)]: [410, 'Unregistered'], ['3'.repeat(64)]: [500, 'InternalServerError'] });
  const result = await dispatchStaffRosterPushes({ admin, callerId: ids.owner, environment: APNS_ENV, connect: apns.connect, clock: () => new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(result, { configured: true, enabled: true, claimed: 3, attempted: 3, accepted: 1, retrying: 1, failed: 0, invalid_token: 1, uncertain: 0, not_owned: 0 });
  assert.equal(admin.calls[0].name, 'staff_roster_push_claim');
  assert.deepEqual({ ...admin.calls[0].params, p_worker: admin.calls[0].params.p_worker.replace(/-[0-9a-f]{8}$/, '') }, { p_worker: 'nudge', p_limit: 100, p_lease_seconds: 180, p_caller: ids.owner });
  const records = admin.calls.filter(call => call.name === 'staff_roster_push_record').flatMap(call => call.params.p_results);
  assert.deepEqual(records, [
    { delivery_id: claimed[0].delivery_id, lease_token: LEASE, outcome: 'accepted', reason: null, retry_after_seconds: null },
    { delivery_id: claimed[1].delivery_id, lease_token: LEASE, outcome: 'invalid_token', reason: 'Unregistered', retry_after_seconds: null },
    { delivery_id: claimed[2].delivery_id, lease_token: LEASE, outcome: 'retry', reason: 'InternalServerError', retry_after_seconds: 900 },
  ]);
  assert.deepEqual(apns.hosts, ['https://api.push.apple.com', 'https://api.sandbox.push.apple.com']);
  assert.equal(apns.sent.length, 3);
  assert.deepEqual(apns.sent[0].body, buildStaffRosterPush(claimed[0]));
  assert.equal(apns.sent[0].body.open_path, '/open/coaching/roster?month=2026-12');
  assert.equal(apns.sent[1].body.audience, 'manager');
  assert.equal(apns.sent[1].body.open_path, '/admin/roster?rosterTab=requests');
  assert.equal(apns.sent[0].headers['apns-collapse-id'], `staff-notice-${NOTICE}`);
  assert.equal(apns.sent[0].headers['apns-id'], claimed[0].delivery_id);
  assert.equal(apns.sent[0].headers['apns-topic'], 'com.xertfitness.app');
  assert.equal(apns.sent[0].headers['apns-expiration'], String(Date.parse('2026-10-01T12:00:00Z') / 1000));
});

test('rows the lease no longer owns are not sent', async () => {
  const claimed = [row(1, 'production'), row(2, 'production')];
  const admin = fakeAdmin(claimed);
  const begin = admin.rpc;
  admin.rpc = async (name, params) => (name === 'staff_roster_push_begin' ? { data: [claimed[1].delivery_id], error: null } : begin(name, params));
  const apns = fakeAPNs();
  const result = await dispatchStaffRosterPushes({ admin, environment: APNS_ENV, connect: apns.connect });
  assert.equal(result.not_owned, 1);
  assert.deepEqual(apns.sent.map(item => item.headers['apns-id']), [claimed[1].delivery_id]);
});

test('without APNs configured nothing is leased or sent, and the status says so', async () => {
  const admin = fakeAdmin([row(1, 'production')]);
  const apns = fakeAPNs();
  const result = await dispatchStaffRosterPushes({ admin, callerId: ids.ava, environment: {}, connect: apns.connect });
  assert.equal(result.configured, false);
  assert.deepEqual(result.missing, ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY']);
  assert.deepEqual(admin.calls.map(call => [call.name, call.params.p_limit]), [['staff_roster_push_claim', 0]], 'only the switch and caller checks run');
  assert.equal(apns.sent.length, 0);
});

test('a switched-off roster sends nothing; a non-staff caller is refused', async () => {
  const off = await dispatchStaffRosterPushes({ admin: fakeAdmin([], { claimError: { message: 'ROSTER_DISABLED' } }), callerId: ids.ava, environment: APNS_ENV, connect: fakeAPNs().connect });
  assert.equal(off.enabled, false);
  assert.equal(off.claimed, 0);
  await assert.rejects(() => dispatchStaffRosterPushes({ admin: fakeAdmin([], { claimError: { message: 'NOT_STAFF' } }), callerId: ids.member, environment: APNS_ENV }), /NOT_STAFF/);
});

test('the provider token is reused within a half-hour window (Apple: refresh at most every 20 minutes)', async () => {
  const tokens = [];
  for (const at of ['2026-10-01T00:01:00Z', '2026-10-01T00:29:00Z', '2026-10-01T00:31:00Z']) {
    const apns = fakeAPNs();
    await dispatchStaffRosterPushes({ admin: fakeAdmin([row(1, 'production')]), environment: APNS_ENV, connect: apns.connect, clock: () => new Date(at) });
    const jwt = apns.sent[0].headers.authorization.split(' ')[1];
    tokens.push(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).iat);
  }
  assert.equal(tokens[0], tokens[1]);
  assert.equal(tokens[2] - tokens[0], 1800);
});

// ── The HTTP route: authentication first ───────────────────────────────────

const ENV = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value' };
const request = (headers = {}, method = 'POST') => ({ method, headers, body: {} });
const read = async response => ({ status: response.status, body: await response.json() });

test('the route rejects missing, invalid and non-staff callers before doing anything', async () => {
  let sends = 0;
  const send = async ({ callerId }) => { sends++; if (callerId === 'member-id') throw new Error('NOT_STAFF'); return { configured: true, attempted: 0 }; };
  const createAdmin = () => ({ auth: { getUser: async token => (token === 'good' ? { data: { user: { id: 'coach-id' } }, error: null }
    : token === 'member' ? { data: { user: { id: 'member-id' } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }) } });

  assert.deepEqual(await read(await handler(request({}, 'PUT'), undefined, { createAdmin, send, env: ENV })), { status: 405, body: { error: 'Method not allowed' } });
  assert.equal((await read(await handler(request({ authorization: 'Bearer good' }, 'GET'), undefined, { createAdmin, send, env: ENV }))).status, 401, 'a session cannot use the cron GET');
  assert.equal((await read(await handler(request({}), undefined, { createAdmin, send, env: ENV }))).status, 401);
  assert.equal((await read(await handler(request({ authorization: 'Basic abc' }), undefined, { createAdmin, send, env: ENV }))).status, 401);
  assert.equal((await read(await handler(request({ authorization: 'Bearer forged' }), undefined, { createAdmin, send, env: ENV }))).status, 401);
  assert.equal(sends, 0, 'nothing is claimed or sent for an unauthenticated caller');
  assert.equal((await read(await handler(request({ authorization: 'Bearer member' }), undefined, { createAdmin, send, env: ENV }))).status, 403);
  const ok = await read(await handler(request({ authorization: 'Bearer good' }), undefined, { createAdmin, send, env: ENV }));
  assert.deepEqual(ok, { status: 200, body: { configured: true, attempted: 0 } });
  const unconfigured = await read(await handler(request({ authorization: 'Bearer good' }), undefined, { createAdmin, send, env: {} }));
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.configured, false);
});

test('the scheduler authenticates with its own secret, never a person’s token', async () => {
  const SECRET = 'scheduler-secret-'.padEnd(48, 'x');
  const env = { ...ENV, CRON_SECRET: SECRET };
  const seen = [];
  const send = async options => { seen.push({ callerId: options.callerId, worker: options.worker }); return { configured: true, claimed: 0 }; };
  let lookups = 0;
  const createAdmin = () => ({ auth: { getUser: async () => { lookups++; return { data: { user: null }, error: { message: 'invalid JWT' } }; } } });

  const ok = await read(await handler(request({ authorization: `Bearer ${SECRET}` }), undefined, { createAdmin, send, env }));
  assert.equal(ok.status, 200);
  const cron = await read(await handler(request({ authorization: `Bearer ${SECRET}` }, 'GET'), undefined, { createAdmin, send, env }));
  assert.equal(cron.status, 200, 'Vercel Cron sends GET with Authorization: Bearer <CRON_SECRET>');
  assert.deepEqual(seen, [{ callerId: null, worker: 'scheduler' }, { callerId: null, worker: 'scheduler' }]);
  assert.equal(lookups, 0, 'the secret is not a user session');

  assert.equal((await read(await handler(request({ authorization: `Bearer ${SECRET}x` }), undefined, { createAdmin, send, env }))).status, 401);
  assert.equal((await read(await handler(request({ authorization: 'Bearer user-session' }, 'GET'), undefined, { createAdmin, send, env }))).status, 401, 'GET is for the scheduler only');
  assert.equal((await read(await handler(request({}, 'GET'), undefined, { createAdmin, send, env }))).status, 401);
  assert.equal(seen.length, 2);
  // A short or missing secret never enables the scheduler path.
  assert.equal(isSchedulerToken('short', { CRON_SECRET: 'short' }), false);
  assert.equal(isSchedulerToken('', { CRON_SECRET: SECRET }), false);
  assert.equal(isSchedulerToken(SECRET, {}), false);
  assert.equal(isSchedulerToken(SECRET, { STAFF_PUSH_DISPATCH_SECRET: SECRET, CRON_SECRET: 'other'.padEnd(40, 'y') }), true);
});

test('the existing push endpoint serves roster pushes, so no new serverless function is added', async () => {
  const viaPushEndpoint = await read(await pushSubscriptionHandler({ method: 'POST', headers: {}, body: { action: 'staff_roster_push' } }));
  assert.equal(viaPushEndpoint.status, 401, 'routed to the roster push handler, which needs a session first');
  assert.deepEqual(viaPushEndpoint.body, { error: 'Not authenticated.' });
  const cron = await read(await pushSubscriptionHandler({ method: 'GET', headers: {}, query: { action: 'staff_roster_push' }, url: '/api/push-subscription?action=staff_roster_push' }));
  assert.equal(cron.status, 401, 'a cron GET reaches the roster handler and needs the secret');
  const otherGet = await read(await pushSubscriptionHandler({ method: 'GET', headers: {}, url: '/api/push-subscription' }));
  assert.equal(otherGet.status, 405);
  const registration = await read(await pushSubscriptionHandler({ method: 'POST', headers: {}, body: { action: 'register' } }));
  assert.notEqual(registration.body.error, undefined, 'device registration still goes its own way');
  const { readdir } = await import('node:fs/promises');
  const functions = (await readdir(new URL('../api/', import.meta.url))).filter(name => name.endsWith('.js'));
  assert.ok(functions.length <= 12, `Vercel Hobby allows 12 functions; found ${functions.length}`);
});

// ── The web client asks for a push only after actions that create notices ──

test('roster actions ask for a push after they succeed, and a push failure never fails the action', async () => {
  let pushes = 0;
  const results = { staff_roster_publish: { ok: true }, staff_roster_approve_cover: { ok: true }, staff_roster_reject_cover: { ok: true },
    staff_roster_decide_absence: { id: 'x' }, staff_roster_run_reminders: { sent: 0 }, staff_roster_reopen_submission: { id: 'y' },
    staff_roster_apply_changes: { version: 2 }, staff_roster_my_notifications: [] };
  const client = createStaffRosterClient(async name => ({ data: results[name], error: null }), {
    notifyPush: () => { pushes++; return Promise.reject(new Error('offline')); },
  });
  await client.publish('2026-12', 1, null);
  await client.approveCover('c', 'o', 1);
  await client.rejectCover('c', 1);
  await client.decideAbsence('a', 'approved', 1);
  await client.runReminders();
  await client.reopenSubmission('2026-12', 's', 'reason');
  assert.equal(pushes, 6);
  await client.applyChanges('2026-12', 1, [{ op: 'unassign', assignment_id: 'z' }]);
  await client.myNotifications();
  assert.equal(pushes, 6, 'draft edits and reads create no notices, so no push');

  const blocked = createStaffRosterClient(async () => ({ data: { ok: false, reason: 'HARD_CONFLICTS' }, error: null }), { notifyPush: () => { pushes++; } });
  assert.equal((await blocked.publish('2026-12', 1, null)).ok, false);
  const failing = createStaffRosterClient(async () => ({ data: null, error: { message: 'STALE_VERSION' } }), { notifyPush: () => { pushes++; } });
  await assert.rejects(() => failing.approveCover('c', 'o', 1), /Refresh/);
  const throwing = createStaffRosterClient(async () => ({ data: { ok: true }, error: null }), { notifyPush: () => { throw new Error('sync failure'); } });
  assert.deepEqual(await throwing.publish('2026-12', 1, null), { ok: true });
  assert.equal(pushes, 6, 'nothing is pushed for a blocked or failed action');
});

test('the push request carries only the session token, and reports instead of throwing', async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; };
  const session = async () => ({ data: { session: { access_token: 'session-token' } } });
  assert.deepEqual(await requestRosterPush(session, fetcher), { requested: true, ok: true, status: 200 });
  assert.equal(seen[0].url, '/api/push-subscription');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer session-token');
  assert.equal(seen[0].init.body, JSON.stringify({ action: 'staff_roster_push' }), 'no roster detail is sent');
  assert.deepEqual(await requestRosterPush(async () => ({ data: { session: null } }), fetcher), { requested: false });
  assert.deepEqual(await requestRosterPush(session, async () => { throw new Error('offline'); }), { requested: false });
  assert.deepEqual(await requestRosterPush(async () => { throw new Error('no auth'); }, fetcher), { requested: false });
  assert.equal(seen.length, 1);
});
