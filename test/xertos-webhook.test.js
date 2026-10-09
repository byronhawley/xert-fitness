import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import handler, {
  client0CalendarWritesEnabled,
  verifyXertosSignature,
  xertosWebhookConfigError,
} from '../src/lib/xertosWebhook.js';
import stripeWebhookHandler from '../api/stripe-webhook.js';

const environment = {
  XERTOS_WRITE_SECRET: 'current-secret',
  XERTOS_WRITE_SECRET_VERSION: '7',
  XERTOS_PREVIOUS_WRITE_SECRET: 'old-secret',
  XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '6',
};

Object.assign(process.env, environment);

function signedHeaders(rawBody, secret = 'current-secret', version = 7, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-signature': `v1,k${version}=${signature}`,
  };
}

function mockResponse() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request({ method = 'POST', rawBody = '', headers = {}, query, url } = {}) {
  return {
    method,
    query,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (rawBody) yield Buffer.from(rawBody);
    },
  };
}

test('verifies the current and previous XertOS signing versions within tolerance', () => {
  const body = '{"action":"ping","requestId":"req-1"}';
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyXertosSignature({
    signatureHeader: signedHeaders(body, 'current-secret', 7, now)['x-webhook-signature'],
    timestampHeader: signedHeaders(body, 'current-secret', 7, now)['x-webhook-timestamp'],
    rawBody: body,
    environment,
    now,
  }), true);
  assert.equal(verifyXertosSignature({
    signatureHeader: signedHeaders(body, 'old-secret', 6, now)['x-webhook-signature'],
    timestampHeader: signedHeaders(body, 'old-secret', 6, now)['x-webhook-timestamp'],
    rawBody: body,
    environment,
    now,
  }), true);
});

test('rejects stale, unknown-version, and mismatched signatures', () => {
  const body = '{"action":"ping","requestId":"req-1"}';
  const headers = signedHeaders(body);
  assert.equal(verifyXertosSignature({
    signatureHeader: headers['x-webhook-signature'],
    timestampHeader: headers['x-webhook-timestamp'],
    rawBody: body,
    environment,
    now: 1900000400,
  }), false);
  assert.equal(verifyXertosSignature({
    signatureHeader: 'v1,k99=bad',
    timestampHeader: headers['x-webhook-timestamp'],
    rawBody: body,
    environment,
    now: 1900000000,
  }), false);
});

test('configuration fails closed without the current secret', () => {
  assert.equal(xertosWebhookConfigError({}), 'XERTOS_WRITE_SECRET is not configured');
  assert.equal(xertosWebhookConfigError(environment), null);
});

test('rotation configuration fails closed instead of inheriting or guessing versions', () => {
  const cases = [
    ['previous only', {
      XERTOS_PREVIOUS_WRITE_SECRET: 'old-secret',
      XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '6',
    }, 'XERTOS_WRITE_SECRET is not configured'],
    ['current without version', {
      XERTOS_WRITE_SECRET: 'current-secret',
    }, 'XERTOS_WRITE_SECRET_VERSION must be a positive safe integer'],
    ['malformed current version', {
      XERTOS_WRITE_SECRET: 'current-secret',
      XERTOS_WRITE_SECRET_VERSION: 'abc',
    }, 'XERTOS_WRITE_SECRET_VERSION must be a positive safe integer'],
    ['zero current version', {
      XERTOS_WRITE_SECRET: 'current-secret',
      XERTOS_WRITE_SECRET_VERSION: '0',
    }, 'XERTOS_WRITE_SECRET_VERSION must be a positive safe integer'],
    ['unsafe current version', {
      XERTOS_WRITE_SECRET: 'current-secret',
      XERTOS_WRITE_SECRET_VERSION: '99999999999999999999',
    }, 'XERTOS_WRITE_SECRET_VERSION must be a positive safe integer'],
    ['previous without version', {
      ...environment,
      XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '',
    }, 'XERTOS_PREVIOUS_WRITE_SECRET_VERSION must be a positive safe integer when XERTOS_PREVIOUS_WRITE_SECRET is configured'],
    ['malformed previous version', {
      ...environment,
      XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '6junk',
    }, 'XERTOS_PREVIOUS_WRITE_SECRET_VERSION must be a positive safe integer when XERTOS_PREVIOUS_WRITE_SECRET is configured'],
    ['duplicate versions', {
      XERTOS_WRITE_SECRET: 'current-secret',
      XERTOS_WRITE_SECRET_VERSION: '7',
      XERTOS_PREVIOUS_WRITE_SECRET: 'old-secret',
      XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '7',
    }, 'XERTOS_WRITE_SECRET_VERSION and XERTOS_PREVIOUS_WRITE_SECRET_VERSION must not match'],
  ];
  for (const [label, env, expected] of cases) {
    assert.equal(xertosWebhookConfigError(env), expected, label);
  }
});

test('previous-only configuration cannot authenticate requests', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, {
      XERTOS_WRITE_SECRET: '',
      XERTOS_PREVIOUS_WRITE_SECRET: 'old-secret',
      XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '6',
    });
    const ping = JSON.stringify({ action: 'ping', requestId: 'previous-only' });
    const res = mockResponse();
    await handler(request({ rawBody: ping, headers: signedHeaders(ping, 'old-secret', 6) }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, 'NOT_CONFIGURED');
  } finally {
    Object.assign(process.env, original);
  }
});

test('XertOS rides the existing webhook function within the Hobby ceiling', () => {
  const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    vercelConfig.rewrites.find(rewrite => rewrite.source === '/api/xertos-webhook'),
    { source: '/api/xertos-webhook', destination: '/api/stripe-webhook?provider=xertos' },
  );
});

test('the shared webhook handler routes provider=xertos before Stripe setup', async () => {
  const ping = JSON.stringify({ action: 'ping', requestId: 'rewrite-1' });
  const res = mockResponse();
  await stripeWebhookHandler(
    request({ rawBody: ping, headers: signedHeaders(ping), query: { provider: 'xertos' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('answers a signed ping and refuses unsafe methods', async () => {
  const ping = JSON.stringify({ action: 'ping', requestId: 'req-1' });
  let res = mockResponse();
  await handler(request({ rawBody: ping, headers: signedHeaders(ping) }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  res = mockResponse();
  await handler(request({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
});

test('security matrix rejects every unsigned, stale, malformed, or altered request', async () => {
  const ping = '{ "action": "ping", "requestId": "req-2" }';
  const now = Math.floor(Date.now() / 1000);
  const valid = signedHeaders(ping, 'current-secret', 7, now);
  const cases = [
    ['wrong secret', signedHeaders(ping, 'wrong-secret', 7, now), ping],
    ['missing signature', { 'x-webhook-timestamp': String(now) }, ping],
    ['malformed signature', { 'x-webhook-timestamp': String(now), 'x-webhook-signature': 'v1,k7=zz' }, ping],
    ['missing timestamp', { 'x-webhook-signature': valid['x-webhook-signature'] }, ping],
    ['invalid timestamp', { ...valid, 'x-webhook-timestamp': 'not-a-time' }, ping],
    ['timestamp with trailing junk', { ...valid, 'x-webhook-timestamp': `${now}junk` }, ping],
    ['timestamp with leading junk', { ...valid, 'x-webhook-timestamp': ` ${now}` }, ping],
    ['timestamp too old', signedHeaders(ping, 'current-secret', 7, now - 301), ping],
    ['timestamp too new', signedHeaders(ping, 'current-secret', 7, now + 301), ping],
    ['raw body mutated', valid, JSON.stringify({ action: 'ping', requestId: 'req-2', extra: true })],
    ['raw body re-encoded', valid, JSON.stringify(JSON.parse(ping))],
  ];

  for (const [label, headers, rawBody] of cases) {
    const res = mockResponse();
    await handler(request({ rawBody, headers }), res);
    assert.equal(res.statusCode, 401, label);
    assert.equal(res.body.error.code, 'INVALID_SIGNATURE', label);
}
});

test('raw request bytes are authenticated before any parsed body is considered', async () => {
  const ping = JSON.stringify({ action: 'ping', requestId: 'req-4' });
  const maliciousParsedBody = JSON.stringify({ action: 'cancel', externalId: 'class-1' });
  const req = request({ rawBody: ping, headers: signedHeaders(ping) });
  req.body = JSON.parse(maliciousParsedBody);
  const res = mockResponse();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('create, update, and cancel remain deterministic 501 no-op responses', async () => {
  const actions = [
    { action: 'create', class: {}, requestId: 'create-1' },
    { action: 'update', externalId: 'class-1', requestId: 'update-1' },
    { action: 'cancel', externalId: 'class-1', requestId: 'cancel-1' },
  ];
  for (const payload of actions) {
    const rawBody = JSON.stringify(payload);
    const res = mockResponse();
    await handler(request({ rawBody, headers: signedHeaders(rawBody) }), res);
    assert.equal(res.statusCode, 501, payload.action);
    assert.deepEqual(res.body, {
      error: {
        code: 'ACTION_NOT_READY',
        message: 'XertOS class edits are not enabled on this endpoint yet.',
      },
    }, payload.action);
  }
});

test('Client-0 calendar write gates cannot be partially enabled', () => {
  assert.equal(client0CalendarWritesEnabled({}), false);
  assert.equal(client0CalendarWritesEnabled({
    CLIENT0_SYNC_ENABLED: 'true',
    CLIENT0_CALENDAR_WRITES_ENABLED: 'false',
  }), false);
  assert.equal(client0CalendarWritesEnabled({
    CLIENT0_SYNC_ENABLED: 'TRUE',
    CLIENT0_CALENDAR_WRITES_ENABLED: 'True',
  }), false);
  assert.equal(client0CalendarWritesEnabled({
    CLIENT0_SYNC_ENABLED: ' true ',
    CLIENT0_CALENDAR_WRITES_ENABLED: 'true ',
  }), false);
  assert.equal(client0CalendarWritesEnabled({
    CLIENT0_SYNC_ENABLED: '1',
    CLIENT0_CALENDAR_WRITES_ENABLED: 'yes',
  }), false);
});

test('signed calendar edits stay fail-closed without both write gates and route handler', async () => {
  const rawBody = JSON.stringify({ action: 'update', externalId: 'class-1', requestId: 'disabled-edit' });
  let called = false;
  const res = mockResponse();
  await handler(
    request({ rawBody, headers: { ...signedHeaders(rawBody), 'x-xertos-site': 'xert_fitness' } }),
    res,
    { runEdit: () => { called = true; } },
  );
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.error.code, 'ACTION_NOT_READY');
  assert.equal(called, false);
});

test('both write gates forward the exact authenticated bytes to the guarded edit handler', async () => {
  const original = { ...process.env };
  const rawBody = JSON.stringify({
    action: 'update',
    externalId: 'class-1',
    expectedUpdatedAt: '2026-10-09T01:02:03.000Z',
    changes: { capacity: 10 },
    requestId: 'enabled-edit',
  });
  try {
    Object.assign(process.env, {
      CLIENT0_SYNC_ENABLED: 'true',
      CLIENT0_CALENDAR_WRITES_ENABLED: 'true',
    });
    let received;
    const res = mockResponse();
    await handler(
      request({ rawBody, url: 'https://xert.test/api/stripe-webhook?provider=xertos', headers: { ...signedHeaders(rawBody), 'x-xertos-site': 'xert_fitness' } }),
      res,
      {
        runEdit: async (replayRequest, response, context) => {
          received = {
            method: replayRequest.method,
            target: replayRequest.target,
            body: await replayRequest.text(),
            provider: replayRequest.headers['x-xertos-site'],
            nowType: typeof context.now,
          };
          return response.status(200).json({ class: { externalId: 'class-1' } });
        },
      },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { class: { externalId: 'class-1' } });
    assert.equal(received.method, 'POST');
    assert.equal(received.target, 'https://xert.test/api/stripe-webhook?provider=xertos');
    assert.equal(received.body, rawBody);
    assert.equal(received.provider, 'xert_fitness');
    assert.equal(received.nowType, 'number');
  } finally {
    for (const key of ['CLIENT0_SYNC_ENABLED', 'CLIENT0_CALENDAR_WRITES_ENABLED']) {
      if (Object.hasOwn(original, key)) process.env[key] = original[key];
      else delete process.env[key];
    }
  }
});

test('the shared handler does not supply production calendar writes by default', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, {
      CLIENT0_SYNC_ENABLED: 'true',
      CLIENT0_CALENDAR_WRITES_ENABLED: 'true',
    });
    const rawBody = JSON.stringify({ action: 'update', externalId: 'class-1', requestId: 'route-no-handler' });
    const res = mockResponse();
    await handler(
      request({ rawBody, headers: { ...signedHeaders(rawBody), 'x-xertos-site': 'xert_fitness' } }),
      res,
    );
    assert.equal(res.statusCode, 501);
    assert.equal(res.body.error.code, 'ACTION_NOT_READY');
  } finally {
    for (const key of ['CLIENT0_SYNC_ENABLED', 'CLIENT0_CALENDAR_WRITES_ENABLED']) {
      if (Object.hasOwn(original, key)) process.env[key] = original[key];
      else delete process.env[key];
    }
  }
});

test('error responses expose neither signing secrets nor signature material', async () => {
  const rawBody = JSON.stringify({ action: 'update', requestId: 'secret-safety' });
  const headers = signedHeaders(rawBody, 'wrong-secret');
  const res = mockResponse();
  await handler(request({ rawBody, headers }), res);
  const serialized = JSON.stringify(res.body);
  for (const forbidden of ['current-secret', 'old-secret', headers['x-webhook-signature']]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
