import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import handler from '../api/xertos-webhook.js';
import { verifyXertosSignature, xertosWebhookConfigError } from '../src/lib/xertosWebhook.js';

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

test('rejects invalid signatures and does not claim class edit support yet', async () => {
  const ping = JSON.stringify({ action: 'ping', requestId: 'req-2' });
  let res = mockResponse();
  await handler(request({ rawBody: ping, headers: signedHeaders(ping, 'wrong-secret') }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'INVALID_SIGNATURE');

  const update = JSON.stringify({ action: 'update', requestId: 'req-3' });
  res = mockResponse();
  await handler(request({ rawBody: update, headers: signedHeaders(update) }), res);
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.error.code, 'ACTION_NOT_READY');
});
