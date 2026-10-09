import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import handler, {
  verifyXertosSignature,
  xertosWebhookConfigError,
} from '../src/lib/xertosWebhook.js';

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

function request({ method = 'POST', rawBody = '', headers = {} } = {}) {
  return {
    method,
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

test('XertOS rides the existing webhook function within the Hobby ceiling', () => {
  const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    vercelConfig.rewrites.find(rewrite => rewrite.source === '/api/xertos-webhook'),
    { source: '/api/xertos-webhook', destination: '/api/stripe-webhook?provider=xertos' },
  );
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
