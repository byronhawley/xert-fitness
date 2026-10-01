// Phone push for coach roster notices. SYNTHETIC DATA ONLY: fictional
// coaches and fake device tokens; APNs is a local mock, so nothing here can
// reach a real device or service.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import handler, {
  STAFF_PUSH_TITLE, buildStaffRosterPush, recordedPushStatus, sendStaffRosterPushes, staffPushBody, staffPushOpenPath,
} from '../api/staff-roster-push.js';
import { createStaffRosterClient, requestRosterPush } from '../src/lib/staffRosterData.js';
import { MONTH, ids, rid, rpc, world, addSession, allWeek, submit, apply, publish, day } from './helpers/staff-roster-world.mjs';
import { as } from './helpers/staff-roster-db.mjs';

const NOTICE = '3a9791d6-d79b-4eeb-9ad0-d8a6a66bff45';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const APNS_ENV = {
  APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM123', APNS_BUNDLE_ID: 'com.xertfitness.app',
  APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

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

test('the open path comes from the stored notice link: tab and a valid month only', () => {
  const cases = [
    ['/coaching?tab=roster&month=2026-12', '/open/coaching/roster?month=2026-12'],
    ['/coaching?tab=availability&month=2027-01', '/open/coaching/availability?month=2027-01'],
    ['/coaching?tab=requests', '/open/coaching/requests'],
    ['/coaching?tab=roster', '/open/coaching/roster'],
    ['/coaching', '/open/coaching/roster'],
    ['/coaching?tab=inbox', '/open/coaching/roster'],
    ['/coaching?tab=roster&month=2026-13', '/open/coaching/roster'],
    ['/coaching?tab=roster&month=2026-12&month=2027-01', '/open/coaching/roster'],
    ['/admin/roster?rosterTab=requests&rosterMonth=2026-12&rosterFocus=00000000-0000-4000-8000-000000000001', '/open/coaching/requests?month=2026-12'],
    ['/admin/roster?rosterTab=availability&rosterMonth=2026-12', '/open/coaching/availability?month=2026-12'],
    ['/admin/roster?rosterTab=requests&rosterFocus=00000000-0000-4000-8000-000000000001', '/open/coaching/requests'],
    ['https://elsewhere.example/coaching?tab=requests', '/open/coaching/requests'],
    ['/account?tab=requests', '/open/coaching/roster'],
    [null, '/open/coaching/roster'],
    ['', '/open/coaching/roster'],
  ];
  for (const [link, expected] of cases) assert.equal(staffPushOpenPath(link), expected, String(link));
  for (const [link] of cases) assert.doesNotMatch(staffPushOpenPath(link), /rosterFocus|0000-4000|elsewhere/);
});

test('APNs acceptance is recorded as accepted, never as delivered or read', () => {
  assert.equal(recordedPushStatus('delivered'), 'accepted');
  assert.equal(recordedPushStatus('invalid_token'), 'invalid_token');
  assert.equal(recordedPushStatus('failed'), 'failed');
  assert.equal(recordedPushStatus('anything else'), 'failed');
});

// ── Dedupe and claiming in the real migration ──────────────────────────────

const PUSH_TABLE = `
  create table public.push_subscriptions (
    id uuid primary key default gen_random_uuid(), user_id uuid not null, device_token text not null,
    environment text not null, enabled boolean not null default true
  );
  create table if not exists public.email_log (id uuid primary key, status text);`;

async function pushWorld() {
  const { db, staff } = await world();
  await db.exec(PUSH_TABLE);
  const token = n => String(n).repeat(64).slice(0, 64);
  const { rows: subs } = await db.query(`insert into public.push_subscriptions (user_id, device_token, environment, enabled) values
    ($1, $4, 'production', true), ($1, $5, 'sandbox', true), ($1, $6, 'production', false), ($2, $7, 'production', true), ($3, $8, 'production', true)
    returning id, user_id, environment, enabled`, [ids.ava, ids.ben, ids.owner, token('a'), token('b'), token('c'), token('d'), token('e')]);
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(12), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  return { db, staff, subs, session };
}

const claim = async (db, caller, limit = 200) => {
  await as(db, null);
  const { rows } = await db.query('select public.staff_roster_claim_push_deliveries($1, $2) as result', [caller, limit]);
  return rows[0].result;
};

test('each due notice is claimed once per enabled device; read, old, scheduled and other people’s notices are not', async () => {
  const { db, subs } = await pushWorld();
  const avaNotice = (await db.query(`select id, link from public.staff_notifications where recipient_profile_id = $1 and kind = 'roster_published'`, [ids.ava])).rows[0];
  // Ben has a read notice, an old one, and one scheduled for later.
  await db.query(`insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link, read_at, created_at, deliver_after) values
    ($1, 'roster_published', 'synthetic:read', 'Read', 'Read already', '/coaching?tab=roster', now(), now(), now()),
    ($1, 'roster_published', 'synthetic:old', 'Old', 'From last week', '/coaching?tab=roster', null, now() - interval '3 days', now() - interval '3 days'),
    ($1, 'availability_reminder', 'synthetic:later', 'Later', 'Not yet', '/coaching?tab=availability', null, now(), now() + interval '2 hours')`, [ids.ben]);

  const first = await claim(db, ids.ava);
  const avaDevices = subs.filter(row => row.user_id === ids.ava && row.enabled).map(row => row.id).sort();
  assert.deepEqual(first.map(row => row.notification_id), [avaNotice.id, avaNotice.id], 'one notice, two enabled devices');
  assert.deepEqual(first.map(row => row.subscription_id).sort(), avaDevices);
  assert.deepEqual(first.map(row => row.link), [avaNotice.link, avaNotice.link]);
  assert.ok(first.every(row => row.device_token && row.delivery_id && ['production', 'sandbox'].includes(row.environment)));
  assert.equal(JSON.stringify(first).includes('Roster updated'), false, 'titles and bodies are not handed to the sender');

  assert.deepEqual(await claim(db, ids.owner), [], 'a second sweep, by anyone, claims nothing again');
  const { rows: state } = await db.query('select status, attempted_at from public.staff_notification_push_deliveries');
  assert.deepEqual(state.map(row => row.status), ['sending', 'sending'], 'claimed, not yet sent, and never called delivered');

  // A newly registered phone gets a recent notice it has not had.
  await db.query(`insert into public.push_subscriptions (user_id, device_token, environment) values ($1, $2, 'production')`, [ids.ava, 'f'.repeat(64)]);
  const later = await claim(db, ids.ava);
  assert.equal(later.length, 1);
  assert.equal(later[0].notification_id, avaNotice.id);
});

test('the claim limit is honoured, and a limit of 0 only checks the caller', async () => {
  const { db } = await pushWorld();
  assert.deepEqual(await claim(db, ids.ava, 0), []);
  assert.equal((await db.query('select count(*)::int as n from public.staff_notification_push_deliveries')).rows[0].n, 0);
  assert.equal((await claim(db, ids.ava, 1)).length, 1);
  assert.equal((await claim(db, ids.ava, 1)).length, 1);
  assert.equal((await claim(db, ids.ava, 1)).length, 0);
});

test('only managers and active coaches can trigger a send, and only while the roster is on', async () => {
  const { db, staff } = await pushWorld();
  await as(db, null);
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries($1, 10)', [ids.member]), /NOT_STAFF/);
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries(null, 10)'), /NOT_STAFF/);
  await db.query(`update public.staff_members set status = 'inactive' where id = $1`, [staff.ben]);
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries($1, 10)', [ids.ben]), /NOT_STAFF/);
  await db.query('update public.staff_roster_settings set enabled = false');
  await assert.rejects(() => db.query('select public.staff_roster_claim_push_deliveries($1, 10)', [ids.owner]), /ROSTER_DISABLED/);

  const { rows } = await db.query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec, has_function_privilege('service_role', p.oid, 'execute') as service_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('staff_roster_claim_push_deliveries', 'staff_roster_record_push_results') order by p.proname`);
  assert.deepEqual(rows, [
    { proname: 'staff_roster_claim_push_deliveries', auth_exec: false, anon_exec: false, service_exec: true },
    { proname: 'staff_roster_record_push_results', auth_exec: false, anon_exec: false, service_exec: true },
  ]);
  const table = await db.query(`select relrowsecurity, has_table_privilege('authenticated', oid, 'select') as auth_select,
      has_table_privilege('anon', oid, 'select') as anon_select from pg_class where relname = 'staff_notification_push_deliveries'`);
  assert.deepEqual(table.rows, [{ relrowsecurity: true, auth_select: false, anon_select: false }]);
});

test('results are recorded once, honestly; invalid tokens are switched off; the log shows push separately from read', async () => {
  const { db } = await pushWorld();
  const claimed = await claim(db, ids.ava);
  const [prod, sandbox] = [claimed.find(row => row.environment === 'production'), claimed.find(row => row.environment === 'sandbox')];
  const record = async results => (await db.query('select public.staff_roster_record_push_results($1::jsonb) as r', [JSON.stringify(results)])).rows[0].r;
  assert.deepEqual(await record([
    { delivery_id: prod.delivery_id, status: 'accepted', reason: null },
    { delivery_id: sandbox.delivery_id, status: 'invalid_token', reason: 'Unregistered' },
  ]), { recorded: 2, disabled_tokens: 1 });
  assert.deepEqual(await record([{ delivery_id: prod.delivery_id, status: 'failed', reason: 'late retry' }]), { recorded: 0, disabled_tokens: 0 }, 'a recorded result is never overwritten');
  assert.deepEqual(await record([{ delivery_id: rid(), status: 'delivered', reason: null }]), { recorded: 0, disabled_tokens: 0 });
  const { rows } = await db.query('select subscription_id, status, reason, attempted_at is not null as attempted from public.staff_notification_push_deliveries order by status');
  assert.deepEqual(rows.map(row => [row.status, row.reason, row.attempted]), [['accepted', null, true], ['invalid_token', 'Unregistered', true]]);
  const sub = await db.query('select enabled from public.push_subscriptions where id = $1', [sandbox.subscription_id]);
  assert.equal(sub.rows[0].enabled, false);
  await assert.rejects(() => db.query(`select public.staff_roster_record_push_results('{}'::jsonb)`), /RESULTS_INVALID/);

  const notice = (await db.query(`select read_at from public.staff_notifications where id = $1`, [prod.notification_id])).rows[0];
  assert.equal(notice.read_at, null, 'a push never marks the notice read');
  const log = await rpc(db, ids.owner, 'select public.staff_roster_notification_log($1, 50)', [`${MONTH}-01`]);
  const line = log.find(row => row.id === prod.notification_id);
  assert.deepEqual(line.push, { accepted: 1, failed: 1, sending: 0 });
  assert.equal(line.read_at, null);
});

// ── Sending, with APNs and Supabase mocked ─────────────────────────────────

class FakeStream extends EventEmitter {
  constructor(status, reason, sink) { super(); this.status = status; this.reason = reason; this.sink = sink; }
  setEncoding() {}
  end(body) {
    this.sink.push({ headers: this.headers, body: JSON.parse(body) });
    queueMicrotask(() => {
      this.emit('response', { ':status': this.status });
      if (this.reason) this.emit('data', JSON.stringify({ reason: this.reason }));
      this.emit('end');
    });
  }
  close() {}
}

function fakeAPNs(outcomes = {}) {
  const sent = [];
  const hosts = [];
  const connect = host => {
    hosts.push(host);
    return {
      on() {},
      close() {},
      request(headers) {
        const token = headers[':path'].split('/').at(-1);
        const [status, reason] = outcomes[token] || [200, null];
        const stream = new FakeStream(status, reason, sent);
        stream.headers = headers;
        return stream;
      },
    };
  };
  return { connect, sent, hosts };
}

function fakeAdmin(claimed, { claimError = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, params) => {
      calls.push({ name, params });
      if (name === 'staff_roster_claim_push_deliveries') return claimError ? { data: null, error: claimError } : { data: params.p_limit === 0 ? [] : claimed, error: null };
      if (name === 'staff_roster_record_push_results') return { data: { recorded: params.p_results.length }, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  };
}

const row = (n, environment, extra = {}) => ({
  delivery_id: `00000000-0000-4000-8000-00000000000${n}`, notification_id: NOTICE, subscription_id: `00000000-0000-4000-9000-00000000000${n}`,
  environment, device_token: String(n).repeat(64), kind: 'roster_published', link: '/coaching?tab=roster&month=2026-12', ...extra,
});

test('sending pushes the generic payload to each claimed device and records accepted vs failed', async () => {
  const claimed = [row(1, 'production'), row(2, 'production', { kind: 'cover_offered', link: '/admin/roster?rosterTab=requests&rosterFocus=abc' }), row(3, 'sandbox')];
  const admin = fakeAdmin(claimed);
  const apns = fakeAPNs({ ['2'.repeat(64)]: [410, 'Unregistered'], ['3'.repeat(64)]: [500, 'InternalServerError'] });
  const result = await sendStaffRosterPushes({ admin, callerId: ids.owner, environment: APNS_ENV, connect: apns.connect, now: new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(result, { configured: true, enabled: true, claimed: 3, attempted: 3, accepted: 1, failed: 2 });
  assert.deepEqual(admin.calls[0], { name: 'staff_roster_claim_push_deliveries', params: { p_caller: ids.owner, p_limit: 200 } });
  assert.deepEqual(admin.calls[1].params.p_results, [
    { delivery_id: claimed[0].delivery_id, status: 'accepted', reason: null },
    { delivery_id: claimed[1].delivery_id, status: 'invalid_token', reason: 'Unregistered' },
    { delivery_id: claimed[2].delivery_id, status: 'failed', reason: 'InternalServerError' },
  ]);
  assert.deepEqual(apns.hosts, ['https://api.push.apple.com', 'https://api.sandbox.push.apple.com']);
  assert.equal(apns.sent.length, 3);
  assert.deepEqual(apns.sent[0].body, buildStaffRosterPush(claimed[0]));
  assert.equal(apns.sent[0].body.open_path, '/open/coaching/roster?month=2026-12');
  assert.equal(apns.sent[1].body.open_path, '/open/coaching/requests');
  assert.equal(apns.sent[1].body.aps.alert.body, 'A roster request needs your attention. Open the app to see it.');
  assert.equal(apns.sent[0].headers['apns-collapse-id'], `staff-notice-${NOTICE}`);
  assert.equal(apns.sent[0].headers['apns-topic'], 'com.xertfitness.app');
  assert.equal(apns.sent[0].headers['apns-expiration'], String(Date.parse('2026-10-02T00:00:00Z') / 1000));
});

test('without APNs configured nothing is claimed or sent, and the status says so', async () => {
  const admin = fakeAdmin([row(1, 'production')]);
  const apns = fakeAPNs();
  const result = await sendStaffRosterPushes({ admin, callerId: ids.ava, environment: {}, connect: apns.connect });
  assert.deepEqual(result, { configured: false, missing: ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY'], enabled: true, claimed: 0, attempted: 0, accepted: 0, failed: 0 });
  assert.deepEqual(admin.calls.map(call => [call.name, call.params.p_limit]), [['staff_roster_claim_push_deliveries', 0]], 'only the caller check runs');
  assert.equal(apns.sent.length, 0);
});

test('a switched-off roster sends nothing; a non-staff caller is refused', async () => {
  const off = await sendStaffRosterPushes({ admin: fakeAdmin([], { claimError: { message: 'ROSTER_DISABLED' } }), callerId: ids.ava, environment: APNS_ENV, connect: fakeAPNs().connect });
  assert.deepEqual(off, { configured: true, enabled: false, claimed: 0, attempted: 0, accepted: 0, failed: 0 });
  await assert.rejects(() => sendStaffRosterPushes({ admin: fakeAdmin([], { claimError: { message: 'NOT_STAFF' } }), callerId: ids.member, environment: APNS_ENV }), /NOT_STAFF/);
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

  assert.deepEqual(await read(await handler(request({}, 'GET'), undefined, { createAdmin, send, env: ENV })), { status: 405, body: { error: 'Method not allowed' } });
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
  assert.equal(seen[0].url, '/api/staff-roster-push');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer session-token');
  assert.equal(seen[0].init.body, '{}', 'no roster detail is sent');
  assert.deepEqual(await requestRosterPush(async () => ({ data: { session: null } }), fetcher), { requested: false });
  assert.deepEqual(await requestRosterPush(session, async () => { throw new Error('offline'); }), { requested: false });
  assert.deepEqual(await requestRosterPush(async () => { throw new Error('no auth'); }, fetcher), { requested: false });
  assert.equal(seen.length, 1);
});
