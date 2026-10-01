// Claim recovery, leases, retries and outcome classification for roster push.
// SYNTHETIC DATA ONLY: fictional coaches, fake device tokens, APNs mocked,
// PGlite running both real roster migrations.
import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchStaffRosterPushes, guardSuspectConfig, staffRosterOutcome } from '../src/lib/staffRosterPush.js';
import {
  APNS_ENV, deliveries, expireLeases, fakeAPNs, ids, makeRetriesDue, pgAdmin, pushWorld, token,
} from './helpers/staff-roster-push-kit.mjs';

const run = (db, apns, extra = {}) => dispatchStaffRosterPushes({ admin: extra.admin || pgAdmin(db), environment: APNS_ENV, connect: apns.connect, ...extra });
const claimDirect = async (db, worker = 'crashing-worker', limit = 100) => (await pgAdmin(db).rpc('staff_roster_push_claim', { p_worker: worker, p_limit: limit })).data;
const beginDirect = async (db, rows) => (await pgAdmin(db).rpc('staff_roster_push_begin', { p_leases: rows.map(row => ({ delivery_id: row.delivery_id, lease_token: row.lease_token })) })).data;
const recordDirect = async (db, results) => (await pgAdmin(db).rpc('staff_roster_push_record', { p_results: results })).data;
const enabled = async (db, deviceToken) => (await db.query('select enabled from public.push_subscriptions where device_token = $1', [deviceToken])).rows[0].enabled;

test('a temporary provider failure is retried with backoff, with the same collapse id and apns-id', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs({ [token('a')]: [503, 'ServiceUnavailable'] });
  const first = await run(db, apns);
  assert.equal(first.retrying, 1);
  assert.equal(first.accepted, 1);
  const [row] = await deliveries(db, 's.device_token = $1', [token('a')]);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.reason, 'ServiceUnavailable');
  const wait = (row.next_attempt_at.getTime() - Date.now()) / 1000;
  assert.ok(wait > 14 * 60 && wait <= 15 * 60, `Apple asks for 15 minutes before retrying a 5xx (got ${wait}s)`);
  assert.equal(await enabled(db, token('a')), true, 'a temporary failure never switches a device off');

  const notYet = await run(db, apns);
  assert.equal(notYet.claimed, 0, 'not retried before the backoff');
  await makeRetriesDue(db);
  const later = fakeAPNs();
  await run(db, later);
  const [after] = await deliveries(db, 's.device_token = $1', [token('a')]);
  assert.deepEqual([after.status, after.attempts], ['accepted', 2]);
  const attempts = [...apns.sent, ...later.sent].filter(item => item.headers[':path'].endsWith(token('a')));
  assert.equal(attempts.length, 2);
  assert.deepEqual(new Set(attempts.map(item => item.headers['apns-collapse-id'])).size, 1, 'a repeat replaces, never adds, on the phone');
  assert.deepEqual(attempts.map(item => item.headers['apns-id']), [row.id, row.id]);
});

test('backoff doubles per attempt and retries are bounded', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs({ [token('a')]: [429, 'TooManyRequests'] });
  const waits = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    await makeRetriesDue(db);
    await run(db, apns);
    const [row] = await deliveries(db, 's.device_token = $1', [token('a')]);
    if (row.status === 'pending') waits.push(Math.round((row.next_attempt_at.getTime() - Date.now()) / 60000));
    else assert.deepEqual([attempt, row.status, row.reason], [5, 'failed', 'RETRIES_EXHAUSTED:TooManyRequests']);
  }
  assert.deepEqual(waits, [1, 2, 4, 8]);
  await makeRetriesDue(db);
  const sentBefore = apns.sent.length;
  await run(db, apns);
  assert.equal(apns.sent.length, sentBefore, 'nothing after the last attempt');
  assert.equal(apns.sent.filter(item => item.headers[':path'].endsWith(token('a'))).length, 5);
  assert.equal(await enabled(db, token('a')), true);
});

test('a crash after the claim but before the send: the work is recovered and sent once', async () => {
  const { db } = await pushWorld();
  const leased = await claimDirect(db);
  assert.equal(leased.length, 2);
  // The worker dies here. Before its lease runs out, nobody else can take the work.
  const apns = fakeAPNs();
  assert.equal((await run(db, apns)).claimed, 0);
  await expireLeases(db);
  const result = await run(db, apns);
  assert.equal(result.accepted, 2);
  assert.equal(apns.sent.length, 2);
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.attempts]), [['accepted', 2], ['accepted', 2]]);
});

test('a crash after Apple accepted but before recording: uncertain, not resent; a late answer from that lease still records the truth', async () => {
  const { db } = await pushWorld();
  const leased = await claimDirect(db);
  assert.equal((await beginDirect(db, leased)).length, 2, 'the send started');
  // ... Apple accepted both, then the worker died before recording.
  await expireLeases(db);
  const apns = fakeAPNs();
  await run(db, apns);
  assert.equal(apns.sent.length, 0, 'never resent: at most one alert from us');
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.reason]),
    [['uncertain', 'LEASE_EXPIRED_AFTER_SEND'], ['uncertain', 'LEASE_EXPIRED_AFTER_SEND']]);
  const late = await recordDirect(db, [{ delivery_id: leased[0].delivery_id, lease_token: leased[0].lease_token, outcome: 'accepted', reason: null }]);
  assert.equal(late.recorded, 1);
  assert.deepEqual((await deliveries(db, 'd.id = $1', [leased[0].delivery_id])).map(row => row.status), ['accepted']);
});

test('a result-recording failure: the send is not repeated and the row ends uncertain', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs();
  const flaky = pgAdmin(db, { fail: { staff_roster_push_record: 1 } });
  const ok = await run(db, apns, { admin: flaky });
  assert.equal(ok.accepted, 2, 'one failed record call is retried once');

  const { db: db2 } = await pushWorld();
  const apns2 = fakeAPNs();
  const broken = pgAdmin(db2, { fail: { staff_roster_push_record: 2 } });
  await assert.rejects(() => run(db2, apns2, { admin: broken }), /STAFF_PUSH_RECORD_FAILED/);
  // The run stops at the first batch it cannot record: the production phone
  // was sent to, the sandbox phone was never started.
  assert.deepEqual(apns2.sent.map(item => item.headers[':path'].split('/').at(-1)), [token('a')]);
  assert.deepEqual((await deliveries(db2)).map(row => [row.device_token, row.status, row.send_started_at !== null]).sort(),
    [[token('a'), 'sending', true], [token('b'), 'sending', false]]);
  await expireLeases(db2);
  await run(db2, apns2);
  assert.deepEqual(apns2.sent.map(item => item.headers[':path'].split('/').at(-1)), [token('a'), token('b')], 'the started send is not repeated; the unstarted one goes');
  assert.deepEqual((await deliveries(db2)).map(row => [row.device_token, row.status]).sort(), [[token('a'), 'uncertain'], [token('b'), 'accepted']]);
});

test('two workers on the same work never send the same item twice', async () => {
  const { db } = await pushWorld();
  await db.query(`insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link) values
    ($1, 'cover_rejected', 'synthetic:two', 'T', 'B', '/coaching?tab=requests'), ($2, 'overdue_summary', 'synthetic:three', 'T', 'B', '/admin/roster?rosterTab=availability')`, [ids.ava, ids.owner]);
  const apns = fakeAPNs();
  const [a, b] = await Promise.all([run(db, apns, { worker: 'worker-a', limit: 2 }), run(db, apns, { worker: 'worker-b', limit: 2 })]);
  const third = await run(db, apns, { worker: 'worker-c' });
  assert.equal(a.claimed + b.claimed + third.claimed, 5);
  const paths = apns.sent.map(item => `${item.headers[':path']}|${item.body.staff_notification_id}`);
  assert.equal(new Set(paths).size, paths.length, 'no notice reached a device twice');
  assert.equal(paths.length, 5);
});

test('an expired lease followed by a late answer from the old worker does not overwrite the newer attempt', async () => {
  const { db } = await pushWorld();
  const old = await claimDirect(db, 'slow-worker');
  await expireLeases(db);
  const apns = fakeAPNs();
  await run(db, apns, { worker: 'new-worker' });
  assert.deepEqual((await deliveries(db)).map(row => row.status), ['accepted', 'accepted']);
  // The slow worker wakes up: it may not start a send, and its result is ignored.
  assert.deepEqual(await beginDirect(db, old), []);
  const late = await recordDirect(db, old.map(row => ({ delivery_id: row.delivery_id, lease_token: row.lease_token, outcome: 'failed', reason: 'late' })));
  assert.deepEqual(late, { recorded: 0, retrying: 0, disabled_tokens: 0, ignored: 2 });
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.reason]), [['accepted', null], ['accepted', null]]);
  const forged = await recordDirect(db, old.map(row => ({ delivery_id: row.delivery_id, lease_token: null, outcome: 'invalid_token', reason: 'x' })));
  assert.equal(forged.recorded, 0, 'no lease, no write');
});

test('a permanently invalid token switches off only that device; payload and auth problems never switch devices off', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs({ [token('a')]: [410, 'Unregistered'], [token('b')]: [403, 'InvalidProviderToken'] });
  const result = await run(db, apns);
  assert.equal(result.invalid_token, 1);
  assert.equal(result.retrying, 1);
  assert.equal(await enabled(db, token('a')), false);
  assert.equal(await enabled(db, token('b')), true, 'an auth/config problem keeps the device');
  const rows = await deliveries(db);
  assert.deepEqual(rows.map(row => [row.device_token === token('a') ? 'a' : 'b', row.status, row.reason]).sort(),
    [['a', 'invalid_token', 'Unregistered'], ['b', 'pending', 'InvalidProviderToken']]);

  const { db: db2 } = await pushWorld();
  await run(db2, fakeAPNs({ [token('a')]: [413, 'PayloadTooLarge'], [token('b')]: [403, 'Forbidden'] }));
  assert.deepEqual((await deliveries(db2)).map(row => [row.status, row.reason]).sort(), [['failed', 'Forbidden'], ['failed', 'PayloadTooLarge']]);
  assert.equal(await enabled(db2, token('a')), true);
  assert.equal(await enabled(db2, token('b')), true);
  await makeRetriesDue(db2);
  const apns2 = fakeAPNs();
  await run(db2, apns2);
  assert.equal(apns2.sent.length, 0, 'permanent failures are not retried');
});

test('network outcomes: never sent is retried; sent without an answer is uncertain and not resent', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs({ [token('a')]: ['refused'], [token('b')]: ['reset'] });
  await run(db, apns);
  const rows = await deliveries(db);
  const byToken = Object.fromEntries(rows.map(row => [row.device_token, [row.status, row.reason]]));
  assert.deepEqual(byToken[token('a')], ['pending', 'NOT_SENT:ECONNREFUSED']);
  assert.deepEqual(byToken[token('b')], ['uncertain', 'stream reset']);
  await makeRetriesDue(db);
  const apns2 = fakeAPNs();
  await run(db, apns2);
  assert.deepEqual(apns2.sent.map(item => item.headers[':path'].split('/').at(-1)), [token('a')]);
});

test('a request that hangs is uncertain after the per-request deadline', async () => {
  const { db } = await pushWorld();
  const apns = fakeAPNs({ [token('a')]: ['hang'] });
  const started = Date.now();
  // The sender's own 8-second deadline applies; keep the test quick by
  // checking the classification of that result directly as well.
  assert.deepEqual(staffRosterOutcome({ transport: 'no_response', reason: 'APNS_REQUEST_TIMEOUT', httpStatus: 0 }),
    { outcome: 'uncertain', reason: 'APNS_REQUEST_TIMEOUT', retry_after_seconds: null });
  await run(db, apns);
  assert.ok(Date.now() - started < 12_000);
  const [row] = await deliveries(db, 's.device_token = $1', [token('a')]);
  assert.deepEqual([row.status, row.reason], ['uncertain', 'APNS_REQUEST_TIMEOUT']);
});

test('missing provider configuration consumes nothing', async () => {
  const { db } = await pushWorld();
  const partial = { APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM123' };
  const apns = fakeAPNs();
  const result = await dispatchStaffRosterPushes({ admin: pgAdmin(db), environment: partial, connect: apns.connect });
  assert.equal(result.configured, false);
  assert.deepEqual(result.missing, ['APNS_PRIVATE_KEY']);
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.attempts]), [['pending', 0], ['pending', 0]]);
  assert.deepEqual(apns.hosts, []);
});

test('the roster switched off while work is leased: nothing is sent and the attempt is given back', async () => {
  const { db } = await pushWorld();
  const leased = await claimDirect(db);
  await db.query('update public.staff_roster_settings set enabled = false');
  assert.deepEqual(await beginDirect(db, leased), []);
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.attempts, row.reason]),
    [['pending', 0, 'ROSTER_DISABLED_BEFORE_SEND'], ['pending', 0, 'ROSTER_DISABLED_BEFORE_SEND']]);
  const apns = fakeAPNs();
  assert.equal((await run(db, apns)).enabled, false);
  assert.equal(apns.sent.length, 0);
});

test('a whole run of "token not for topic" is treated as configuration, not as dead devices', async () => {
  const { db } = await pushWorld();
  await db.query(`update public.staff_notifications set read_at = null`);
  await db.query(`insert into public.push_subscriptions (user_id, device_token, environment) values ($1, $2, 'production'), ($1, $3, 'production')`, [ids.ava, token('7'), token('8')]);
  const wrongTopic = Object.fromEntries([token('a'), token('7'), token('8')].map(value => [value, [400, 'DeviceTokenNotForTopic']]));
  await run(db, fakeAPNs(wrongTopic));
  for (const value of [token('a'), token('7'), token('8')]) assert.equal(await enabled(db, value), true, 'no device switched off');
  const production = (await deliveries(db)).filter(row => row.environment === 'production');
  assert.ok(production.every(row => row.status === 'pending' && row.reason === 'SUSPECT_CONFIG:DeviceTokenNotForTopic'));

  const mixed = guardSuspectConfig([
    { environment: 'production', httpStatus: 400, result: { outcome: 'invalid_token', reason: 'BadDeviceToken' } },
    { environment: 'production', httpStatus: 200, result: { outcome: 'accepted', reason: null } },
  ]);
  assert.equal(mixed[0].result.outcome, 'invalid_token', 'one bad token among good ones is a bad token');
});

test('outcome classification follows Apple’s APNs response table', () => {
  const answer = (httpStatus, reason) => staffRosterOutcome({ transport: 'response', httpStatus, reason });
  const cases = [
    [200, null, 'accepted'],
    [400, 'BadDeviceToken', 'invalid_token'], [400, 'DeviceTokenNotForTopic', 'invalid_token'],
    [410, 'Unregistered', 'invalid_token'], [410, 'ExpiredToken', 'invalid_token'],
    [400, 'BadCollapseId', 'failed'], [400, 'BadExpirationDate', 'failed'], [400, 'BadMessageId', 'failed'], [400, 'BadPriority', 'failed'],
    [400, 'BadTopic', 'failed'], [400, 'DuplicateHeaders', 'failed'], [400, 'InvalidPushType', 'failed'], [400, 'MissingDeviceToken', 'failed'],
    [400, 'MissingTopic', 'failed'], [400, 'PayloadEmpty', 'failed'], [400, 'TopicDisallowed', 'failed'], [400, 'IdleTimeout', 'retry'],
    [403, 'BadCertificate', 'retry'], [403, 'BadCertificateEnvironment', 'retry'], [403, 'ExpiredProviderToken', 'retry'],
    [403, 'InvalidProviderToken', 'retry'], [403, 'MissingProviderToken', 'retry'], [403, 'UnrelatedKeyIdInToken', 'retry'],
    [403, 'BadEnvironmentKeyIdInToken', 'retry'], [403, 'Forbidden', 'failed'],
    [404, 'BadPath', 'failed'], [405, 'MethodNotAllowed', 'failed'], [413, 'PayloadTooLarge', 'failed'],
    [429, 'TooManyProviderTokenUpdates', 'retry'], [429, 'TooManyRequests', 'retry'],
    [500, 'InternalServerError', 'retry'], [503, 'ServiceUnavailable', 'retry'], [503, 'Shutdown', 'retry'], [502, null, 'retry'],
  ];
  for (const [status, reason, outcome] of cases) assert.equal(answer(status, reason).outcome, outcome, `${status} ${reason}`);
  assert.equal(answer(500, 'InternalServerError').retry_after_seconds, 900);
  assert.equal(answer(429, 'TooManyProviderTokenUpdates').retry_after_seconds, 1200);
  assert.equal(staffRosterOutcome({ transport: 'not_sent', errorCode: 'ENOTFOUND' }).outcome, 'retry');
  assert.equal(staffRosterOutcome({ transport: 'no_response', reason: 'stream reset' }).outcome, 'uncertain');
});
