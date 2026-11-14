import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const ENVIRONMENT_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLIENT0_SYNC_ENABLED',
  'CLIENT0_CALENDAR_WRITES_ENABLED',
  'CLIENT0_BOOKING_WRITES_ENABLED',
  'XERTOS_WRITE_SECRET',
  'XERTOS_WRITE_SECRET_VERSION',
  'XERTOS_PREVIOUS_WRITE_SECRET',
  'XERTOS_PREVIOUS_WRITE_SECRET_VERSION',
  'XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT',
  'XERTOS_SITE_SECRET',
];

const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
);
const originalFetch = globalThis.fetch;

function signedRequest(action, secret, version) {
  const body = JSON.stringify({
    action,
    externalId: '00000000-0000-4000-8000-00000000b001',
    requestId: `route-contract:${action}`,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return {
    method: 'POST',
    query: { provider: 'xertos' },
    url: '/api/stripe-webhook?provider=xertos',
    headers: {
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': `v1,k${version}=${signature}`,
      'x-xertos-site': 'xert_fitness',
    },
    async text() {
      return body;
    },
  };
}

function mockResponse() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test.after(() => {
  for (const key of ENVIRONMENT_KEYS) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  globalThis.fetch = originalFetch;
});

test('the actual API route forwards only a versioned, signed refresh to its RPC adapter', async () => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://xert-contract.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-not-a-credential',
    CLIENT0_SYNC_ENABLED: 'true',
    CLIENT0_CALENDAR_WRITES_ENABLED: 'true',
    CLIENT0_BOOKING_WRITES_ENABLED: 'true',
    XERTOS_WRITE_SECRET: 'current-write-key',
    XERTOS_WRITE_SECRET_VERSION: '7',
    XERTOS_PREVIOUS_WRITE_SECRET: 'previous-write-key',
    XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '6',
    XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT: '2099-01-01T00:00:00Z',
    XERTOS_SITE_SECRET: '',
  });

  const rpcCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    rpcCalls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      ok: true,
      status: 'queued',
      externalId: '00000000-0000-4000-8000-00000000b001',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  // Import after setting the environment: the API adapter intentionally captures
  // its Supabase URL and service role at module initialisation.
  const { default: route } = await import('../api/stripe-webhook.js');

  const refresh = mockResponse();
  await route(signedRequest('refreshBookings', 'previous-write-key', 6), refresh);
  assert.equal(refresh.statusCode, 200);
  assert.deepEqual(refresh.body, {
    ok: true,
    status: 'queued',
    externalId: '00000000-0000-4000-8000-00000000b001',
  });
  assert.equal(rpcCalls.length, 1);
  assert.match(rpcCalls[0].url, /\/rest\/v1\/rpc\/xertos_sync_refresh_bookings$/);
  assert.equal(JSON.parse(rpcCalls[0].init.body).p_edit.action, 'refreshBookings');

  // Versioned HMAC verification alone must not grant the legacy edit exemption.
  // The real API adapter must pass verifiedRefresh only for refreshBookings.
  for (const action of ['create', 'update', 'cancel', 'book', 'cancelBooking']) {
    const response = mockResponse();
    await route(signedRequest(action, 'current-write-key', 7), response);
    assert.equal(response.statusCode, 409, action);
    assert.equal(response.body.error.code, 'SYNC_OFF', action);
  }
  assert.equal(rpcCalls.length, 1, 'non-refresh actions never reach the RPC');
});
