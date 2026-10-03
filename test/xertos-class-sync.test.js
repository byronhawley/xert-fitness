import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  handleXertosDispatch,
  handleXertosEdit,
  summarizeXertosOutcomes,
  verifyXertosSignature,
  xertosEditRefusal,
  xertosSyncEnvironment,
} from '../src/lib/xertosSync.js';

const SITE_SECRET = 'xsite_test_secret_value_1234567890';
const DISPATCH_SECRET = 'd'.repeat(40);
const ENV = {
  XERTOS_API_URL: 'https://api.xertos.test/',
  XERTOS_CLIENT_ID: 'scr_1',
  XERTOS_CLIENT_SECRET: 'client-secret-123456',
  XERTOS_SITE_SECRET: SITE_SECRET,
  XERTOS_SYNC_DISPATCH_SECRET: DISPATCH_SECRET,
};
const NOW = 1_790_000_000;

function sign(body, ts = NOW, secret = SITE_SECRET) {
  return `v1,k1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
}

function trace() {
  const sent = [];
  return { sent, requestId: 'req-1', json(body, status = 200) { sent.push({ body, status }); return { body, status }; } };
}

function request({ method = 'POST', body, headers = {} }) {
  return { method, body, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
}

function fakeAdmin(answers) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      const next = answers[name];
      return Promise.resolve(typeof next === 'function' ? next(args, calls) : next);
    },
  };
}

test('environment needs an https XertOS, a client and a long dispatch secret', () => {
  const env = xertosSyncEnvironment(ENV);
  assert.equal(env.apiUrl, 'https://api.xertos.test');
  assert.equal(env.provider, 'xert_fitness');
  assert.equal(env.sendReady, true);
  assert.equal(env.editReady, true);
  assert.equal(xertosSyncEnvironment({ ...ENV, XERTOS_API_URL: 'http://api.xertos.test' }).sendReady, false);
  assert.equal(xertosSyncEnvironment({ ...ENV, XERTOS_SYNC_DISPATCH_SECRET: 'short' }).sendReady, false);
  assert.equal(xertosSyncEnvironment({}).editReady, false);
});

test('signatures are XertOS webhook signatures, five minutes either way', () => {
  const body = '{"action":"cancel"}';
  assert.equal(verifyXertosSignature(sign(body), SITE_SECRET, String(NOW), body, NOW), true);
  assert.equal(verifyXertosSignature(`v1,k1=${'0'.repeat(64)} ${sign(body)}`, SITE_SECRET, NOW, body, NOW), true, 'rotation sends two');
  assert.equal(verifyXertosSignature(sign(body), SITE_SECRET, NOW, `${body} `, NOW), false);
  assert.equal(verifyXertosSignature(sign(body, NOW, 'another-secret-value'), SITE_SECRET, NOW, body, NOW), false);
  assert.equal(verifyXertosSignature(sign(body, NOW - 301), SITE_SECRET, NOW - 301, body, NOW), false);
  assert.equal(verifyXertosSignature('', SITE_SECRET, NOW, body, NOW), false);
});

test('refusals are worded for staff and keep XERT rules', () => {
  assert.deepEqual(xertosEditRefusal({ message: 'CAPACITY_BELOW_ACTIVE:3' }), {
    status: 409, code: 'CAPACITY_BELOW_ACTIVE', message: 'Capacity cannot be lower than the 3 active bookings.',
  });
  assert.equal(xertosEditRefusal({ message: 'STALE_CLASS' }).status, 409);
  assert.match(xertosEditRefusal({ message: 'SESSION_OVERLAPS_BLACKOUT' }).message, /blackout/);
  assert.match(xertosEditRefusal({ message: 'SYNC_OFF' }).message, /Make this change on XERT Fitness/);
  assert.equal(xertosEditRefusal({ message: 'new row violates check constraint', code: '23514' }).status, 422);
  assert.equal(xertosEditRefusal({ message: 'INVALID_EDIT' }).status, 422);
  assert.equal(xertosEditRefusal({ message: 'something unexpected', code: 'XX000' }), null);
});

test('a signed edit is applied and answered with the class as it now stands', async () => {
  const edit = { action: 'update', externalId: 'a', expectedUpdatedAt: '2026-10-04T01:02:03.000Z', changes: { capacity: 10 }, requestId: 'r1' };
  const body = JSON.stringify(edit);
  const answer = { class: { externalId: 'a', capacity: 10 } };
  const admin = fakeAdmin({ xertos_sync_apply_edit: { data: answer, error: null } });
  const t = trace();
  const result = await handleXertosEdit(
    // Vercel parses the JSON; the signature still matches.
    request({ body: JSON.parse(body), headers: { 'x-xertos-site': 'xert_fitness', 'x-webhook-timestamp': String(NOW), 'x-webhook-signature': sign(body) } }),
    admin, t, ENV, NOW,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, answer);
  assert.deepEqual(admin.calls, [{ name: 'xertos_sync_apply_edit', args: { p_edit: edit } }]);
});

test('an unsigned or wrongly addressed edit changes nothing', async () => {
  const body = JSON.stringify({ action: 'cancel', externalId: 'a', requestId: 'r1' });
  const admin = fakeAdmin({});
  const bad = await handleXertosEdit(
    request({ body, headers: { 'x-xertos-site': 'xert_fitness', 'x-webhook-timestamp': String(NOW), 'x-webhook-signature': sign(body, NOW, 'not-the-secret-at-all') } }),
    admin, trace(), ENV, NOW,
  );
  assert.equal(bad.status, 401);
  const otherSite = await handleXertosEdit(
    request({ body, headers: { 'x-xertos-site': 'someone_else', 'x-webhook-timestamp': String(NOW), 'x-webhook-signature': sign(body) } }),
    admin, trace(), ENV, NOW,
  );
  assert.equal(otherSite.status, 401);
  const off = await handleXertosEdit(request({ body }), admin, trace(), { ...ENV, XERTOS_SITE_SECRET: '' }, NOW);
  assert.equal(off.status, 409);
  assert.equal(off.body.error.code, 'SYNC_OFF');
  assert.equal(admin.calls.length, 0);
});

test('a refused edit comes back as XertOS shows it', async () => {
  const body = JSON.stringify({ action: 'update', externalId: 'a', changes: { capacity: 1 }, requestId: 'r2' });
  const admin = fakeAdmin({ xertos_sync_apply_edit: { data: null, error: { message: 'CAPACITY_BELOW_ACTIVE:2', code: 'P0001' } } });
  const result = await handleXertosEdit(
    request({ body, headers: { 'x-xertos-site': 'xert_fitness', 'x-webhook-timestamp': String(NOW), 'x-webhook-signature': sign(body) } }),
    admin, trace(), ENV, NOW,
  );
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.error, { code: 'CAPACITY_BELOW_ACTIVE', message: 'Capacity cannot be lower than the 2 active bookings.' });
});

function fakeXertos(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    return { ok: next.status < 300, status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { calls, fetchImpl };
}

const dispatchRequest = (body = { action: 'push' }, secret = DISPATCH_SECRET) =>
  request({ body: JSON.stringify(body), headers: { authorization: `Bearer ${secret}` } });

test('the dispatcher only answers the scheduler', async () => {
  const admin = fakeAdmin({});
  const { fetchImpl, calls } = fakeXertos([]);
  const result = await handleXertosDispatch(dispatchRequest(undefined, 'x'.repeat(40)), admin, trace(), ENV, fetchImpl);
  assert.equal(result.status, 401);
  assert.equal(calls.length, 0);
  const unset = await handleXertosDispatch(dispatchRequest(), admin, trace(), { ...ENV, XERTOS_CLIENT_SECRET: '' }, fetchImpl);
  assert.equal(unset.status, 503);
});

test('the dispatcher sends what is due and settles it', async () => {
  const classes = [{ externalId: 'a', updatedAt: '2026-10-04T01:02:03.000Z' }];
  const admin = fakeAdmin({
    xertos_sync_claim: { data: { lease: 'lease-1', classes }, error: null },
    xertos_sync_settle: { data: 1, error: null },
  });
  const { fetchImpl, calls } = fakeXertos([
    { status: 200, body: { accessToken: 'tok', tokenType: 'Bearer' } },
    { status: 200, body: { results: [{ externalId: 'a', outcome: 'updated' }] } },
  ]);
  const result = await handleXertosDispatch(dispatchRequest(), admin, trace(), ENV, fetchImpl);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { action: 'push', sent: 1, failed: 0, outcomes: { updated: 1 } });
  assert.equal(calls[0].url, 'https://api.xertos.test/v1/auth/token');
  assert.deepEqual(calls[0].body, { grantType: 'client_credentials', clientId: 'scr_1', clientSecret: 'client-secret-123456' });
  assert.equal(calls[1].url, 'https://api.xertos.test/v1/connected-sites/xert_fitness/classes/sync');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].init.headers['Idempotency-Key'], 'xert-push-lease-1');
  assert.deepEqual(calls[1].body, { classes });
  assert.deepEqual(admin.calls.at(-1), { name: 'xertos_sync_settle', args: { p_lease: 'lease-1', p_ok: true, p_error: null } });
});

test('a refused push is retried later with the reason kept', async () => {
  const admin = fakeAdmin({
    xertos_sync_claim: { data: { lease: 'lease-2', classes: [{ externalId: 'a' }] }, error: null },
    xertos_sync_settle: { data: 1, error: null },
  });
  const { fetchImpl } = fakeXertos([
    { status: 200, body: { accessToken: 'tok' } },
    { status: 409, body: { code: 'SITE_PAUSED', detail: 'The connection is paused.' } },
  ]);
  const result = await handleXertosDispatch(dispatchRequest(), admin, trace(), ENV, fetchImpl);
  assert.equal(result.status, 502);
  assert.deepEqual(admin.calls.at(-1), {
    name: 'xertos_sync_settle',
    args: { p_lease: 'lease-2', p_ok: false, p_error: 'SITE_PAUSED: The connection is paused.' },
  });
});

test('the daily run sends the window as one complete list', async () => {
  const window = { classes: [{ externalId: 'a' }, { externalId: 'b' }], window: { from: '2026-10-04T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' } };
  const admin = fakeAdmin({ xertos_sync_window: { data: window, error: null } });
  const { fetchImpl, calls } = fakeXertos([
    { status: 200, body: { accessToken: 'tok' } },
    { status: 200, body: { results: [{ outcome: 'unchanged' }, { outcome: 'created' }] } },
  ]);
  const result = await handleXertosDispatch(dispatchRequest({ action: 'window' }), admin, trace(), ENV, fetchImpl);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { action: 'window', sent: 2, outcomes: { unchanged: 1, created: 1 } });
  assert.deepEqual(calls[1].body, window);
  assert.match(calls[1].init.headers['Idempotency-Key'], /^xert-window-/);
});

test('outcome summary tolerates odd answers', () => {
  assert.deepEqual(summarizeXertosOutcomes(null), {});
  assert.deepEqual(summarizeXertosOutcomes({ results: [{ outcome: 'stale' }, {}] }), { stale: 1, unknown: 1 });
});

test('sync is served by an existing function, not a thirteenth', async () => {
  const vercel = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  const handler = await readFile(new URL('../api/admin-fitbox-integration.js', import.meta.url), 'utf8');
  assert.match(vercel, /"\/api\/xertos\/classes"[\s\S]*?admin-fitbox-integration\?service=xertos_edit/);
  assert.match(vercel, /"\/api\/xertos\/dispatch"[\s\S]*?admin-fitbox-integration\?service=xertos_dispatch/);
  // Both are routed before the admin sign-in check: XertOS and pg_cron have no member session.
  const adminCheck = handler.indexOf('await requireAdmin(request, admin)');
  assert.ok(handler.indexOf("=== 'xertos_edit'") > 0 && handler.indexOf("=== 'xertos_edit'") < adminCheck);
  assert.ok(handler.indexOf("=== 'xertos_dispatch'") > 0 && handler.indexOf("=== 'xertos_dispatch'") < adminCheck);
});

test('the migration keeps one copy of the admin calendar rules and stays off by default', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261004010000_xertos_class_sync.sql', import.meta.url), 'utf8');
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /function public\.admin_update_class_session[\s\S]*?is_admin\(\)[\s\S]*?class_session_update_core/);
  assert.match(sql, /function public\.admin_cancel_class_session[\s\S]*?is_admin\(\)[\s\S]*?class_session_cancel_core/);
  assert.match(sql, /'public\.xertos_sync_apply_edit\(jsonb\)'/);
  assert.doesNotMatch(sql, /grant execute on function public\.xertos_sync_apply_edit\(jsonb\) to authenticated/);
  assert.match(sql, /exception when others then\s+raise warning 'XertOS sync: class/);
});
