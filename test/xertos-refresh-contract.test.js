import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import handler, {
  previousSecretExpiresAt,
  verifyXertosSignature,
} from '../src/lib/xertosWebhook.js';
import { handleXertosEdit } from '../src/lib/xertosSync.js';

/**
 * Three contract fixes on top of the post-match refresh (#45):
 * 1. a deliberately disabled refresh is a definite 409 SYNC_OFF, never a 5xx
 *    that XertOS retries as an outage;
 * 2. the verified-refresh exemption is scoped to refreshBookings: every other
 *    action still fails closed on the editReady gate;
 * 3. the previous signing key is accepted only until an explicit expiry.
 * No secret value appears in any response.
 */

const KEYS = [
  'CLIENT0_SYNC_ENABLED', 'CLIENT0_CALENDAR_WRITES_ENABLED', 'CLIENT0_BOOKING_WRITES_ENABLED',
  'XERTOS_WRITE_SECRET', 'XERTOS_WRITE_SECRET_VERSION', 'XERTOS_PREVIOUS_WRITE_SECRET',
  'XERTOS_PREVIOUS_WRITE_SECRET_VERSION', 'XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT', 'XERTOS_SITE_SECRET',
];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
test.afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const WRITE = {
  XERTOS_WRITE_SECRET: 'current-write-key',
  XERTOS_WRITE_SECRET_VERSION: '7',
  XERTOS_PREVIOUS_WRITE_SECRET: 'previous-write-key',
  XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '6',
};
const FAR = '2099-01-01T00:00:00Z';

function signed(rawBody, secret, version, timestamp = Math.floor(Date.now() / 1000)) {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-signature': `v1,k${version}=${hex}`,
    'x-xertos-site': 'xert_fitness',
  };
}
function response() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
function request(rawBody, headers) {
  return {
    method: 'POST',
    url: 'https://xert.test/api/stripe-webhook?provider=xertos',
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(rawBody); },
  };
}
const EXTERNAL_ID = '00000000-0000-4000-8000-00000000b001';
const refreshBody = JSON.stringify({ action: 'refreshBookings', externalId: EXTERNAL_ID, requestId: 'xos_refresh_job_1' });
function leaksNothing(body) {
  const text = JSON.stringify(body);
  for (const secret of [WRITE.XERTOS_WRITE_SECRET, WRITE.XERTOS_PREVIOUS_WRITE_SECRET]) {
    assert.equal(text.includes(secret), false, 'no secret value in the response');
  }
}

// 1. Disabled refresh is terminal.

test('a refresh with the connection switched off is 409 SYNC_OFF and reaches nothing', async () => {
  Object.assign(process.env, WRITE, { XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: FAR, CLIENT0_SYNC_ENABLED: 'false' });
  let reached = false;
  const res = response();
  await handler(request(refreshBody, signed(refreshBody, WRITE.XERTOS_WRITE_SECRET, 7)), res, {
    runEdit: () => { reached = true; },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'SYNC_OFF');
  assert.equal(reached, false);
  // XertOS's classifyBookingsRefreshReply treats any 4xx other than 429 as terminal.
  assert.ok(res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429);
  leaksNothing(res.body);
});

test('the same signed refresh is accepted once the connection is switched back on', async () => {
  Object.assign(process.env, WRITE, { XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: FAR, CLIENT0_SYNC_ENABLED: 'false' });
  const headers = signed(refreshBody, WRITE.XERTOS_WRITE_SECRET, 7);
  const off = response();
  await handler(request(refreshBody, headers), off, { runEdit: () => assert.fail('must not run while off') });
  assert.equal(off.statusCode, 409);

  process.env.CLIENT0_SYNC_ENABLED = 'true';
  let context;
  const on = response();
  await handler(request(refreshBody, headers), on, {
    runEdit: (replay, res, ctx) => {
      context = ctx;
      return res.status(200).json({ ok: true, status: 'queued', externalId: EXTERNAL_ID });
    },
  });
  assert.equal(on.statusCode, 200);
  assert.equal(on.body.status, 'queued');
  assert.equal(context.verifiedRefresh, true, 'only the refresh branch vouches for the versioned HMAC');
});

test('a refresh with no write handler wired is still a server-side 501', async () => {
  Object.assign(process.env, WRITE, { XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: FAR, CLIENT0_SYNC_ENABLED: 'true' });
  const res = response();
  await handler(request(refreshBody, signed(refreshBody, WRITE.XERTOS_WRITE_SECRET, 7)), res);
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.error.code, 'ACTION_NOT_READY');
});

// 2. The verified-refresh exemption is refreshBookings only.

const OTHER_ACTIONS = ['create', 'update', 'cancel', 'book', 'cancelBooking'];

test('other actions never receive the verified-refresh context from the webhook', async () => {
  Object.assign(process.env, WRITE, {
    XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: FAR,
    CLIENT0_SYNC_ENABLED: 'true',
    CLIENT0_CALENDAR_WRITES_ENABLED: 'true',
    CLIENT0_BOOKING_WRITES_ENABLED: 'true',
  });
  for (const action of OTHER_ACTIONS) {
    const rawBody = JSON.stringify({ action, externalId: 'class-1', requestId: 'route-' + action });
    let context;
    const res = response();
    await handler(request(rawBody, signed(rawBody, WRITE.XERTOS_WRITE_SECRET, 7)), res, {
      runEdit: (replay, r, ctx) => { context = ctx; return r.status(200).json({ ok: true }); },
    });
    assert.equal(res.statusCode, 200, action);
    assert.equal(context.verifiedRefresh, undefined, action + ' is not vouched for as a refresh');
  }
});

const SYNC_ENV = {
  XERTOS_API_URL: 'https://api.xertos.test/',
  XERTOS_CLIENT_ID: 'scr_1',
  XERTOS_CLIENT_SECRET: 'client-secret-123456',
  XERTOS_SITE_SECRET: '',
};
const NOW = 1_790_000_000;
function editRequest(body) {
  return {
    method: 'POST',
    target: '/api/stripe-webhook?provider=xertos',
    headers: { 'x-xertos-site': 'xert_fitness', 'x-webhook-timestamp': String(NOW), 'x-webhook-signature': 'v1,k7=00' },
    body,
  };
}
function trace() {
  return { requestId: 'trace-1', json: (body, status = 200) => ({ status, body }) };
}
function admin() {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true, status: 'queued', externalId: EXTERNAL_ID }, error: null });
    },
  };
}

test('with no site secret, every non-refresh action is 409 SYNC_OFF even when passed verifiedRefresh', async () => {
  for (const action of OTHER_ACTIONS) {
    const db = admin();
    const edit = JSON.stringify({ action, externalId: 'class-1', requestId: 'missing-secret-' + action });
    const result = await handleXertosEdit(editRequest(edit), db, trace(), SYNC_ENV, NOW, { verifiedRefresh: true });
    assert.equal(result.status, 409, action);
    assert.equal(result.body.error.code, 'SYNC_OFF', action);
    assert.equal(db.calls.length, 0, action + ' reaches no RPC');
  }
});

test('with no site secret and no exemption, actions fail closed as before', async () => {
  const db = admin();
  const edit = JSON.stringify({ action: 'book', externalId: 'class-1', requestId: 'missing-secret-plain' });
  const result = await handleXertosEdit(editRequest(edit), db, trace(), SYNC_ENV, NOW);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'SYNC_OFF');
  assert.equal(db.calls.length, 0);
});

test('a verified refresh still works with no legacy site secret', async () => {
  const db = admin();
  const result = await handleXertosEdit(editRequest(refreshBody), db, trace(), SYNC_ENV, NOW, { verifiedRefresh: true });
  assert.equal(result.status, 200);
  assert.equal(db.calls[0].name, 'xertos_sync_refresh_bookings');
});

// 3. The previous key expires.

const pingBody = '{"action":"ping","requestId":"rotation"}';
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
function verify(environment, secret, version, now) {
  const headers = signed(pingBody, secret, version, now);
  return verifyXertosSignature({
    signatureHeader: headers['x-webhook-signature'],
    timestampHeader: headers['x-webhook-timestamp'],
    rawBody: pingBody,
    environment,
    now,
  });
}

test('the previous key is accepted only before its expiry; the current key throughout', () => {
  const environment = { ...WRITE, XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: '2026-12-01T00:00:00Z' };
  const before = at('2026-11-30T23:59:59Z');
  const after = at('2026-12-01T00:00:00Z');
  assert.equal(verify(environment, WRITE.XERTOS_PREVIOUS_WRITE_SECRET, 6, before), true, 'overlap kept');
  assert.equal(verify(environment, WRITE.XERTOS_PREVIOUS_WRITE_SECRET, 6, after), false, 'expired at the instant');
  assert.equal(verify(environment, WRITE.XERTOS_PREVIOUS_WRITE_SECRET, 6, after + 86_400 * 365), false);
  assert.equal(verify(environment, WRITE.XERTOS_WRITE_SECRET, 7, before), true);
  assert.equal(verify(environment, WRITE.XERTOS_WRITE_SECRET, 7, after), true);
});

test('a missing or unreadable expiry refuses the previous key and leaves the current one working', () => {
  const now = at('2026-11-14T00:00:00Z');
  const expiries = [
    undefined,
    '',
    'never',
    '2026-12-01',
    '2026-12-01 00:00:00',
    '2026-12-01T00:00:00',
    '1793577600',
    '2026-13-45T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-12-01T24:00:00Z',
    '2026-12-01T00:60:00Z',
    '2026-12-01T00:00:60Z',
    '2026-12-01T00:00:00+14:01',
    '2026-12-01T00:00:00+15:00',
    '2026-12-01T00:00:00-00:00',
  ];
  for (const expiry of expiries) {
    const environment = { ...WRITE };
    if (expiry !== undefined) environment.XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT = expiry;
    assert.equal(previousSecretExpiresAt(environment), null, String(expiry));
    assert.equal(verify(environment, WRITE.XERTOS_PREVIOUS_WRITE_SECRET, 6, now), false, 'previous refused for ' + expiry);
    assert.equal(verify(environment, WRITE.XERTOS_WRITE_SECRET, 7, now), true, 'current kept for ' + expiry);
  }
});

test('a real leap-day expiry is accepted without date rollover', () => {
  const expiry = '2024-02-29T23:59:59.123456789+14:00';
  assert.equal(
    previousSecretExpiresAt({ XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: expiry }),
    Math.floor(Date.parse(expiry) / 1000),
  );
});

test('an expiry with an explicit offset is read as that instant', () => {
  assert.equal(
    previousSecretExpiresAt({ XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: '2026-12-01T10:00:00+10:00' }),
    at('2026-12-01T00:00:00Z'),
  );
});

test('an expired previous key is refused end to end, without echoing any key', async () => {
  Object.assign(process.env, WRITE, { XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: '2020-01-01T00:00:00Z', CLIENT0_SYNC_ENABLED: 'true' });
  const res = response();
  await handler(request(refreshBody, signed(refreshBody, WRITE.XERTOS_PREVIOUS_WRITE_SECRET, 6)), res, {
    runEdit: () => assert.fail('an expired key must not reach the write handler'),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'INVALID_SIGNATURE');
  leaksNothing(res.body);
});
