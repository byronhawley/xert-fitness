import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const SUPABASE_URL = 'https://operator-health.supabase.test';
const SERVICE_ROLE_KEY = 'test-only-service-role-key-not-real';
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { default: handler, handleXertosHealth } = await import('../api/admin-fitbox-integration.js');
const {
  CLIENT0_EXACT_WRITE_ENDPOINT,
  client0OperatorHealthSnapshot,
} = await import('../src/lib/xertosOperatorHealth.js');

const FULL_ENV = {
  CLIENT0_SYNC_ENABLED: 'true',
  CLIENT0_CALENDAR_WRITES_ENABLED: 'true',
  XERTOS_API_URL: 'https://api.xertos.test/',
  XERTOS_CLIENT_ID: 'test-client-id',
  XERTOS_CLIENT_SECRET: 'test-only-client-secret',
  XERTOS_SYNC_DISPATCH_SECRET: 'd'.repeat(32),
  XERTOS_SITE_SECRET: 'test-only-site-secret-value',
  XERTOS_WRITE_SECRET: 'test-only-write-secret',
  XERTOS_WRITE_SECRET_VERSION: '7',
};

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return { body, status: this.statusCode };
    },
  };
}

function adminWithProfile(role) {
  const calls = [];
  return {
    calls,
    auth: {
      getUser: async (token) => {
        calls.push({ op: 'getUser', token });
        if (token === 'operator-session-token') {
          return { data: { user: { id: '11111111-1111-4111-8111-111111111111' } }, error: null };
        }
        return { data: { user: null }, error: { message: 'invalid token' } };
      },
    },
    from(table) {
      calls.push({ op: 'from', table });
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: { role }, error: null }),
              };
            },
          };
        },
      };
    },
  };
}

function healthRequest({ method = 'GET', authorization = 'Bearer operator-session-token' } = {}) {
  return {
    method,
    url: '/api/xertos/operator-health',
    query: { service: 'xertos_health' },
    headers: authorization ? { authorization } : {},
  };
}

test('operator health defaults every activation gate to fail-closed', () => {
  const health = client0OperatorHealthSnapshot({});
  assert.equal(health.surface, 'read_only');
  assert.equal(health.provider, 'xert_fitness');
  assert.equal(health.providerCalls, false);
  assert.equal(health.providerMutation, false);
  assert.equal(health.flags.syncEnabled, false);
  assert.equal(health.flags.calendarWritesEnabled, false);
  assert.equal(health.flags.bothEnabled, false);
  assert.equal(health.calendar.mutationPathReady, false);
  assert.equal(health.exactWriteEndpoint, '/api/xertos-webhook');
});

test('operator health reports readiness without credential values', () => {
  const health = client0OperatorHealthSnapshot(FULL_ENV);
  assert.deepEqual(health.flags, {
    syncEnabled: true,
    calendarWritesEnabled: true,
    bothEnabled: true,
  });
  assert.equal(health.outbound.push.ready, true);
  assert.equal(health.inbound.calendarEdit.configured, true);
  assert.equal(health.inbound.calendarEdit.writeSecretVersion, 7);
  assert.equal(health.calendar.mutationPathReady, true);

  const serialized = JSON.stringify(health);
  for (const value of [
    FULL_ENV.XERTOS_CLIENT_ID,
    FULL_ENV.XERTOS_CLIENT_SECRET,
    FULL_ENV.XERTOS_SYNC_DISPATCH_SECRET,
    FULL_ENV.XERTOS_SITE_SECRET,
    FULL_ENV.XERTOS_WRITE_SECRET,
  ]) {
    assert.ok(!serialized.includes(value));
  }
});

test('equivalent-looking flags and malformed configuration remain fail-closed', () => {
  const health = client0OperatorHealthSnapshot({
    ...FULL_ENV,
    CLIENT0_SYNC_ENABLED: ' TRUE ',
    CLIENT0_CALENDAR_WRITES_ENABLED: '1',
    XERTOS_API_URL: 'http://api.xertos.test',
    XERTOS_SYNC_DISPATCH_SECRET: 'short',
    XERTOS_WRITE_SECRET_VERSION: 'zero',
  });
  assert.deepEqual(health.flags, {
    syncEnabled: false,
    calendarWritesEnabled: false,
    bothEnabled: false,
  });
  assert.equal(health.outbound.push.ready, false);
  assert.equal(health.inbound.calendarEdit.webhookTransportReady, false);
  assert.equal(health.inbound.calendarEdit.writeSecretVersion, null);
  assert.equal(health.calendar.mutationPathReady, false);
});

test('previous write-secret version is represented without exposing the secret', () => {
  const current = client0OperatorHealthSnapshot({
    ...FULL_ENV,
    XERTOS_PREVIOUS_WRITE_SECRET: 'test-only-previous-secret',
    XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '6',
  });
  assert.equal(current.inbound.calendarEdit.previousWriteSecretConfigured, true);
  assert.equal(current.inbound.calendarEdit.previousWriteSecretVersion, 6);
  assert.equal(current.inbound.calendarEdit.previousWriteSecretPairConfigured, true);
  assert.ok(!JSON.stringify(current).includes('test-only-previous-secret'));

  const collision = client0OperatorHealthSnapshot({
    ...FULL_ENV,
    XERTOS_PREVIOUS_WRITE_SECRET: 'test-only-previous-secret',
    XERTOS_PREVIOUS_WRITE_SECRET_VERSION: '7',
  });
  assert.equal(collision.inbound.calendarEdit.previousWriteSecretPairConfigured, false);
  assert.equal(collision.inbound.calendarEdit.webhookTransportReady, false);
  assert.equal(collision.calendar.mutationPathReady, false);

  const malformedPrevious = client0OperatorHealthSnapshot({
    ...FULL_ENV,
    XERTOS_PREVIOUS_WRITE_SECRET: 'test-only-previous-secret',
    XERTOS_PREVIOUS_WRITE_SECRET_VERSION: 'six',
  });
  assert.equal(malformedPrevious.inbound.calendarEdit.previousWriteSecretPairConfigured, false);
  assert.equal(malformedPrevious.inbound.calendarEdit.webhookTransportReady, false);
  assert.equal(malformedPrevious.calendar.mutationPathReady, false);
});

test('health branch requires an authenticated XERT admin and stays GET-only', async () => {
  const unauthenticatedResponse = response();
  const unauthenticatedAdmin = adminWithProfile('admin');
  await handleXertosHealth(healthRequest({ authorization: '' }), unauthenticatedResponse, unauthenticatedAdmin);
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.deepEqual(unauthenticatedAdmin.calls.filter(call => call.op === 'from'), []);

  const invalidResponse = response();
  const invalidAdmin = adminWithProfile('admin');
  await handleXertosHealth(healthRequest({ authorization: 'Bearer invalid' }), invalidResponse, invalidAdmin);
  assert.equal(invalidResponse.statusCode, 401);

  const forbiddenResponse = response();
  const forbiddenAdmin = adminWithProfile('member');
  await handleXertosHealth(healthRequest(), forbiddenResponse, forbiddenAdmin);
  assert.equal(forbiddenResponse.statusCode, 403);

  const methodResponse = response();
  const methodAdmin = adminWithProfile('admin');
  await handleXertosHealth(healthRequest({ method: 'POST' }), methodResponse, methodAdmin);
  assert.equal(methodResponse.statusCode, 405);
  assert.deepEqual(methodAdmin.calls.filter(call => call.op === 'from').map(call => call.table), ['profiles']);

  const okResponse = response();
  const okAdmin = adminWithProfile('admin');
  await handleXertosHealth(healthRequest(), okResponse, okAdmin);
  assert.equal(okResponse.statusCode, 200);
  assert.equal(okResponse.body.ok, true);
  assert.equal(okResponse.body.health.surface, 'read_only');
  assert.equal(okResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.deepEqual(
    okAdmin.calls.filter(call => call.op === 'from').map(call => call.table),
    ['profiles'],
  );
});

test('default handler routes only after the dedicated health handler and keeps auth first', async () => {
  const source = await readFile(new URL('../api/admin-fitbox-integration.js', import.meta.url), 'utf8');
  const healthCall = source.indexOf("requestService(request) === 'xertos_health'");
  const legacyEdit = source.indexOf("requestService(request) === 'xertos_edit'");
  const healthHandler = source.slice(
    source.indexOf('export async function handleXertosHealth'),
  );
  const adminCheck = healthHandler.indexOf('await requireAdmin(request, admin);');
  const snapshotCall = healthHandler.indexOf('client0OperatorHealthSnapshot(process.env)');
  assert.ok(healthCall > 0);
  assert.ok(legacyEdit > healthCall);
  assert.ok(adminCheck >= 0);
  assert.ok(snapshotCall > adminCheck);
});

test('operator health uses the existing integration function and makes no provider call', async () => {
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    vercel.rewrites.find(({ source }) => source === '/api/xertos/operator-health'),
    {
      source: '/api/xertos/operator-health',
      destination: '/api/admin-fitbox-integration?service=xertos_health',
    },
  );

  const handlerSource = await readFile(new URL('../api/admin-fitbox-integration.js', import.meta.url), 'utf8');
  const healthSource = await readFile(new URL('../src/lib/xertosOperatorHealth.js', import.meta.url), 'utf8');
  assert.match(handlerSource, /requestService\(request\) === 'xertos_health'/);
  assert.doesNotMatch(healthSource, /\bfetch\s*\(/);
  assert.doesNotMatch(healthSource, /signed\s+ping|action["']?\s*:\s*["']ping/);
  assert.equal(CLIENT0_EXACT_WRITE_ENDPOINT, '/api/xertos-webhook');
});
