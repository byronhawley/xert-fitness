import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleXertosEdit, xertosConnectionStatus, xertosSyncHealth } from '../src/lib/xertosSync.js';

const ENV = {
  XERTOS_API_URL: 'https://api.xertos.test',
  XERTOS_CLIENT_ID: 'scr_1',
  XERTOS_CLIENT_SECRET: 'client-secret-123456',
  XERTOS_SYNC_DISPATCH_SECRET: 'd'.repeat(40),
};
const NOW = Date.parse('2026-11-15T00:00:00Z');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeAdmin({ enabled = true, outbox = [] } = {}) {
  const query = (data) => {
    const chain = {
      select: () => chain, order: () => chain, limit: () => Promise.resolve({ data, error: null }),
      maybeSingle: () => Promise.resolve({ data, error: null }),
    };
    return chain;
  };
  return {
    from(table) {
      if (table === 'xertos_sync_settings') return query({ enabled, window_sent_at: '2026-11-14T17:10:05Z', window_tried_at: null });
      return query(outbox);
    },
  };
}

function xertos(status) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/auth/token')) return json(200, { accessToken: 'tok', expiresIn: 900 });
    return typeof status === 'function' ? status() : json(200, status);
  };
  return { fetchImpl, calls };
}

test('in step on both sides reads ok, with XertOS words', async () => {
  const api = xertos({ status: 'active', health: { state: 'ok', note: 'XERT Fitness is in step.' }, lastReceivedAt: '2026-11-14T17:10:05Z' });
  const result = await xertosSyncHealth(fakeAdmin(), ENV, api.fetchImpl, NOW);
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /XERT Fitness is in step\./);
  assert.match(result.detail, /nothing waiting to send/);
  assert.equal(api.calls[1].url, 'https://api.xertos.test/v1/connected-sites/xert_fitness/status');
  assert.equal(api.calls[1].init.headers.Authorization, 'Bearer tok');
});

test('a class change waiting over 15 minutes points at the cron job and the dispatch secret', async () => {
  const api = xertos({ health: { state: 'ok', note: 'In step.' } });
  const outbox = [{ changed_at: '2026-11-14T23:00:00Z', sent_changed_at: null, last_error: 'HTTP_401: Not authorised.' }];
  const result = await xertosSyncHealth(fakeAdmin({ outbox }), ENV, api.fetchImpl, NOW);
  assert.equal(result.status, 'attention');
  assert.equal(result.local.waiting, 1);
  assert.match(result.detail, /1 class change waiting to send \(last error: HTTP_401/);
  assert.match(result.action, /xertos_sync_dispatch_secret/);
});

test('a refused credential says which Vercel values to replace', async () => {
  const api = { fetchImpl: async () => json(401, { code: 'INVALID_CLIENT', title: 'Unauthenticated', detail: 'invalid client credentials' }) };
  const result = await xertosSyncHealth(fakeAdmin(), ENV, api.fetchImpl, NOW);
  assert.equal(result.status, 'attention');
  assert.match(result.detail, /INVALID_CLIENT/);
  assert.match(result.action, /XERTOS_CLIENT_SECRET/);
});

test('XertOS reporting failing or behind is passed on with what to check', async () => {
  const failing = await xertosSyncHealth(fakeAdmin(), ENV, xertos({ health: { state: 'failing', note: 'Signature refused.' } }).fetchImpl, NOW);
  assert.equal(failing.status, 'attention');
  assert.match(failing.action, /XERTOS_WRITE_SECRET/);
  const behind = await xertosSyncHealth(fakeAdmin(), ENV, xertos({ health: { state: 'behind', note: 'No window.' } }).fetchImpl, NOW);
  assert.match(behind.action, /xertos-class-sync-window/);
});

test('switched off here is fine and asks XertOS nothing; on without settings is not', async () => {
  const api = xertos({});
  assert.equal((await xertosSyncHealth(fakeAdmin({ enabled: false }), ENV, api.fetchImpl, NOW)).status, 'ok');
  assert.equal(api.calls.length, 0);
  const missing = await xertosSyncHealth(fakeAdmin(), { ...ENV, XERTOS_CLIENT_ID: '' }, api.fetchImpl, NOW);
  assert.equal(missing.status, 'attention');
});

test('status is reported unreachable when the token cannot be taken', async () => {
  const status = await xertosConnectionStatus({ apiUrl: 'https://api.xertos.test', clientId: 'a', clientSecret: 'b', provider: 'xert_fitness' },
    async () => { throw new TypeError('fetch failed'); });
  assert.equal(status.reachable, false);
});

test('an edit the webhook route already verified needs no second secret', async () => {
  const body = JSON.stringify({ action: 'cancel', externalId: 'a', expectedUpdatedAt: '2026-10-04T01:02:03.000Z', requestId: 'r1' });
  const admin = { rpc: async () => ({ data: { class: { externalId: 'a' } }, error: null }) };
  const sent = [];
  const trace = { requestId: 'q', json(b, s = 200) { sent.push(s); return { body: b, status: s }; } };
  const req = (headers) => ({ method: 'POST', target: '/api/xertos-webhook', headers, text: async () => body });

  // No XERTOS_SITE_SECRET at all: before, this answered SYNC_OFF / 401 although the signature had passed.
  const ok = await handleXertosEdit(req({ 'x-xertos-site': 'xert_fitness' }), admin, trace, ENV, 0, { signatureVerified: true });
  assert.equal(ok.status, 200);
  const otherSite = await handleXertosEdit(req({ 'x-xertos-site': 'someone_else' }), admin, trace, ENV, 0, { signatureVerified: true });
  assert.equal(otherSite.status, 401);
  // Without the flag the old single-secret check still holds.
  const unverified = await handleXertosEdit(req({ 'x-xertos-site': 'xert_fitness' }), admin, trace, ENV, 0);
  assert.equal(unverified.status, 409);

  const route = await readFile(new URL('../api/stripe-webhook.js', import.meta.url), 'utf8');
  assert.match(route, /handleXertosEdit\([\s\S]{0,160}\{ signatureVerified: true \}\)/);
});
