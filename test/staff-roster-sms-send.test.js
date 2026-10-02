// Roster texts: the wording (src/lib/staffRoster/sms.js) and the sender
// (api/admin-publish-announcement.js, action 'send_roster_sms').
// SYNTHETIC DATA ONLY. Nothing here can send a real text: Twilio and Supabase
// are reached only through stubbed fetch functions, and the credentials are
// fake values set before the API module loads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRosterSms, rosterSmsLine, rosterSmsLink, rosterSmsReason, rosterSmsSummary, smsSafeText, smsWhen } from '../src/lib/staffRoster/sms.js';
import { smsSegments } from '../src/lib/smsCampaigns.js';
import { gymInstantIso } from '../src/lib/staffRoster/time.js';

const SUPABASE = 'https://synthetic-project.supabase.test';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-key',
  TWILIO_ACCOUNT_SID: 'ACsynthetic',
  TWILIO_AUTH_TOKEN: 'synthetic-token',
  TWILIO_FROM_NUMBER: '+61400000999',
  APP_BASE_URL: '',
});
const api = await import('../api/admin-publish-announcement.js');
const { sendRosterSms, twilioSendSms } = api;

const CREDENTIALS = { accountSid: 'ACsynthetic', authToken: 'synthetic-token', fromNumber: '+61400000999' };
const at = (date, minute) => gymInstantIso(date, minute);
const message = (overrides = {}) => ({
  id: '20000000-0000-4000-8000-000000000001',
  lease_token: '30000000-0000-4000-8000-000000000001',
  phone: '+61400000001',
  kind: 'published',
  attempt: 1,
  details: {
    first_name: 'Ava', month: '2026-10-01', starts_on: '2026-10-09',
    lines: [{ start: at('2026-10-13', 315), title: 'Engine', role: 'lead' }, { start: at('2026-10-15', 375), title: 'Strength', role: 'lead' }],
  },
  ...overrides,
});

// ─── Wording ────────────────────────────────────────────────────────────────

test('the first text lists the coach’s classes on the gym clock, from the roster start, with the link', () => {
  assert.equal(buildRosterSms(message()),
    'XERT: Hi Ava, your October classes (from 9 Oct): Tue 13 Oct 5:15am Engine; Thu 15 Oct 6:15am Strength. See all: https://www.xertfitness.com.au/coaching?tab=roster');
  assert.equal(buildRosterSms(message({ details: { ...message().details, starts_on: null } })).includes('(from'), false);
  // 5:15 am in Kingaroy is 19:15 UTC the day before: never the server's clock.
  assert.equal(smsWhen('2026-10-12T19:15:00Z'), 'Tue 13 Oct 5:15am');
  assert.equal(rosterSmsLine({ start: at('2026-10-13', 1050), title: 'Engine', role: 'assistant' }), 'Tue 13 Oct 5:30pm Engine (assistant)');
});

test('a change text lists only what changed: added, removed, moved, new role', () => {
  const body = buildRosterSms({
    kind: 'changed',
    details: {
      first_name: 'Ava', month: '2026-10-01', lines: [
        { change: 'added', start: at('2026-10-17', 420), title: 'Engine', role: 'lead' },
        { change: 'removed', start: at('2026-10-13', 315), title: 'Engine', role: 'lead' },
        { change: 'moved', start: at('2026-10-14', 360), was: at('2026-10-13', 315), title: 'Strength', role: 'lead' },
        { change: 'role', start: at('2026-10-20', 375), title: 'Hyrox', role: 'assistant' },
      ],
    },
  }, { baseUrl: 'https://xert.example.test/anything' });
  assert.equal(body, 'XERT: Hi Ava, your October roster changed: added Sat 17 Oct 7:00am Engine; removed Tue 13 Oct 5:15am Engine; '
    + 'moved Tue 13 Oct 5:15am Strength to Wed 14 Oct 6:00am; now assistant on Tue 20 Oct 6:15am Hyrox. See all: https://xert.example.test/coaching?tab=roster');
});

test('long lists stay within three segments and end "+N more, see the app"', () => {
  const lines = Array.from({ length: 40 }, (_, index) => ({ start: at(`2026-10-${String(1 + (index % 28)).padStart(2, '0')}`, 315 + index), title: 'XERT Strength & Conditioning', role: 'lead' }));
  const body = buildRosterSms(message({ details: { ...message().details, lines } }));
  const segments = smsSegments(body);
  assert.equal(segments.encoding, 'GSM-7');
  assert.ok(segments.segments <= 3, `${segments.segments} segments`);
  assert.ok(body.length <= 459);
  const shown = body.split('; ').length - 1;
  assert.match(body, new RegExp(`; \\+${40 - shown} more, see the app: https://www\\.xertfitness\\.com\\.au/coaching\\?tab=roster$`));
  assert.ok(shown >= 5, 'still lists a useful number of classes');
  // A one-segment budget still produces a valid text.
  const short = buildRosterSms(message({ details: { ...message().details, lines } }), { maxSegments: 1 });
  assert.ok(smsSegments(short).segments <= 1, short);
});

test('names and titles are made safe for SMS: no emoji or smart quotes forcing the costly encoding', () => {
  assert.equal(smsSafeText('Kirra’s “Engine” 💪 – AM'), 'Kirra\'s "Engine" - AM');
  const body = buildRosterSms(message({ details: { ...message().details, first_name: 'Zoë 🌟', lines: [{ start: at('2026-10-13', 315), title: '🔥 HIIT “Burn”', role: 'lead' }] } }));
  assert.equal(smsSegments(body).encoding, 'GSM-7');
  assert.match(body, /Hi Zoe, .* HIIT "Burn"\. See all/, 'an accent outside the SMS alphabet becomes the plain letter');
  assert.equal(smsSafeText('Renée Müller'), 'Renée Müller', 'letters the SMS alphabet has are kept');
  assert.equal(rosterSmsLink('http://insecure.example.test'), 'https://www.xertfitness.com.au/coaching?tab=roster', 'only an https origin is used');
  assert.equal(rosterSmsLink('not a url'), 'https://www.xertfitness.com.au/coaching?tab=roster');
});

test('the publish dialog summary reads plainly', () => {
  assert.equal(rosterSmsSummary([
    { name: 'Ava', status: 'sent' }, { name: 'Ben', status: 'sent' }, { name: 'Dee', status: 'sent' }, { name: 'Eve', status: 'sent' },
    { name: 'Cam', status: 'skipped', reason: 'NO_MOBILE' },
  ]), '4 sent, 1 no mobile number (Cam)');
  assert.equal(rosterSmsSummary([
    { name: 'Ava', status: 'pending' }, { name: 'Ben', status: 'failed', reason: 'TWILIO_400:21211: invalid' },
    { name: 'Dee', status: 'skipped', reason: 'OPTED_OUT' }, { name: 'Eve', status: 'failed', reason: 'RETRIES_EXHAUSTED:NETWORK: x' },
  ]), '1 sending, 1 failed, not delivered (Ben), 1 turned texts off (Dee), 1 failed, failed after 3 tries (Eve)');
  assert.equal(rosterSmsSummary([]), 'No texts for this version');
});

// ─── Sender ─────────────────────────────────────────────────────────────────

/** A stand-in for the service-role client: a scripted claim queue and a record log. */
function fakeAdmin(batches) {
  const queue = [...batches];
  const records = [];
  const claims = [];
  return {
    records, claims,
    rpc: async (name, params) => {
      if (name === 'staff_roster_sms_claim') { claims.push(params); return { data: queue.shift() || [], error: null }; }
      if (name === 'staff_roster_sms_record') {
        records.push(params);
        const status = params.p_ok ? 'sent' : params.p_retryable ? 'pending' : 'failed';
        return { data: { recorded: true, status }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

/** A stand-in for Twilio that answers from a script and records each request. */
function fakeTwilio(answers) {
  const calls = [];
  const fetcher = async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/ACsynthetic\/Messages\.json$/);
    calls.push({ url, init, params: Object.fromEntries(new URLSearchParams(init.body)) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body || {}), { status: answer.status || 201 });
  };
  return { calls, fetcher };
}

test('success: each due text is built, sent once through Twilio, and recorded with its lease and exact body', async () => {
  const second = message({ id: '20000000-0000-4000-8000-000000000002', phone: '+61400000002', details: { ...message().details, first_name: 'Ben' } });
  const admin = fakeAdmin([[message(), second]]);
  const twilio = fakeTwilio([{ body: { sid: 'SM1', status: 'queued' } }]);
  const result = await sendRosterSms(admin, { credentials: CREDENTIALS, fetcher: twilio.fetcher, sleep: async () => {} });
  assert.deepEqual(result, { configured: true, attempted: 2, sent: 2, failed: 0, retrying: 0, unrecorded: 0 });
  assert.deepEqual(twilio.calls.map(call => [call.params.To, call.params.From]), [['+61400000001', '+61400000999'], ['+61400000002', '+61400000999']]);
  assert.equal(twilio.calls[0].params.Body, buildRosterSms(message()));
  assert.equal(twilio.calls[0].init.headers.Authorization, `Basic ${Buffer.from('ACsynthetic:synthetic-token').toString('base64')}`);
  assert.deepEqual(admin.records[0], {
    p_id: message().id, p_lease_token: message().lease_token, p_ok: true, p_provider_id: 'SM1', p_error: null, p_retryable: false, p_body: buildRosterSms(message()),
  });
  assert.equal(admin.claims[0].p_limit, 25);
  assert.match(admin.claims[0].p_worker, /^api-[0-9a-f]{8}$/);
});

test('a temporary failure (Twilio 503) is recorded as retryable and tried again in the same run after a wait', async () => {
  const admin = fakeAdmin([[message()], [message({ attempt: 2, lease_token: '30000000-0000-4000-8000-000000000002' })]]);
  const twilio = fakeTwilio([{ status: 503, body: { code: 20500, message: 'Service unavailable' } }, { body: { sid: 'SM2' } }]);
  const waits = [];
  const result = await sendRosterSms(admin, { credentials: CREDENTIALS, fetcher: twilio.fetcher, sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(result, { configured: true, attempted: 2, sent: 1, failed: 0, retrying: 0, unrecorded: 0 });
  assert.equal(admin.records[0].p_ok, false);
  assert.equal(admin.records[0].p_retryable, true);
  assert.match(admin.records[0].p_error, /^TWILIO_503:20500: Service unavailable$/);
  assert.deepEqual(waits, [2500], 'waits past the database’s 2 s retry delay');
  assert.equal(admin.records[1].p_lease_token, '30000000-0000-4000-8000-000000000002');
  assert.equal(admin.records[1].p_ok, true);
});

test('a connection that never reached Twilio and rate limits are temporary; a text still waiting after the run is reported as retrying', async () => {
  const admin = fakeAdmin([[message()]]);
  const twilio = fakeTwilio([new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })]);
  const result = await sendRosterSms(admin, { credentials: CREDENTIALS, fetcher: twilio.fetcher, sleep: async () => {} });
  assert.deepEqual(result, { configured: true, attempted: 1, sent: 0, failed: 0, retrying: 1, unrecorded: 0 });
  assert.match(admin.records[0].p_error, /^NETWORK: fetch failed$/);
  const limited = await twilioSendSms({ to: '+61400000001', body: 'x', credentials: CREDENTIALS, fetcher: fakeTwilio([{ status: 429, body: { code: 20429, message: 'Too many' } }]).fetcher });
  assert.deepEqual([limited.ok, limited.retryable], [false, true]);
});

test('no answer from Twilio (timeout, dropped connection) may mean it was sent: recorded once as unconfirmed, never sent again', async () => {
  for (const failure of [
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }),
    new TypeError('fetch failed'),
  ]) {
    const admin = fakeAdmin([[message()], [message({ attempt: 2 })]]);
    const twilio = fakeTwilio([failure, { body: { sid: 'SM-second' } }]);
    const result = await sendRosterSms(admin, { credentials: CREDENTIALS, fetcher: twilio.fetcher, sleep: async () => { throw new Error('no retry wait'); } });
    assert.deepEqual(result, { configured: true, attempted: 1, sent: 0, failed: 1, retrying: 0, unrecorded: 0 }, failure.message);
    assert.equal(twilio.calls.length, 1, 'Twilio is asked once');
    assert.equal(admin.records[0].p_retryable, false);
    assert.match(admin.records[0].p_error, /^UNCONFIRMED (TIMEOUT|NETWORK): /);
  }
  assert.equal(rosterSmsReason('UNCONFIRMED TIMEOUT: aborted'), 'may have gone, no answer from the SMS service');
});

test('a run that is out of time hands unsent texts back instead of starting sends the platform could cut off', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => message({ id: `20000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`, phone: `+614000001${String(index).padStart(2, '0')}` }));
  const admin = fakeAdmin([rows]);
  const twilio = fakeTwilio([{ body: { sid: 'SM' } }]);
  // Five sends at a time, each adding 4 s to this clock, so a group takes 20 s; the budget is 40 s.
  let clock = 0;
  const slow = async (url, init) => { clock += 4000; return twilio.fetcher(url, init); };
  const result = await sendRosterSms(admin, { credentials: CREDENTIALS, fetcher: slow, sleep: async () => {}, now: () => clock });
  // Groups start at 0 s and 20 s; the last two texts are due at 40 s and are not started.
  assert.equal(twilio.calls.length, 10);
  const handedBack = admin.records.filter(record => record.p_error === 'NOT_SENT:OUT_OF_TIME');
  assert.equal(handedBack.length, 2);
  assert.ok(handedBack.every(record => record.p_retryable && !record.p_ok && record.p_body === null));
  assert.deepEqual(result, { configured: true, attempted: 10, sent: 10, failed: 0, retrying: 2, unrecorded: 0 });
  assert.equal(admin.claims.length, 1, 'no new batch is claimed once out of time');
});

test('a permanent failure (bad number, STOP) is recorded once and never retried', async () => {
  const admin = fakeAdmin([[message()], [message()]]);
  const twilio = fakeTwilio([{ status: 400, body: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } }]);
  const result = await sendRosterSms(admin, { credentials: CREDENTIALS, fetcher: twilio.fetcher, sleep: async () => { throw new Error('no wait for a permanent failure'); } });
  assert.deepEqual(result, { configured: true, attempted: 1, sent: 0, failed: 1, retrying: 0, unrecorded: 0 });
  assert.equal(admin.records[0].p_retryable, false);
  assert.match(admin.records[0].p_error, /^RECIPIENT_UNSUBSCRIBED TWILIO_400:21610: /);
  assert.equal(admin.claims.length, 1, 'a short batch with nothing to retry ends the run');
});

test('a number that is not an Australian mobile is refused without calling Twilio; no credentials means nothing is claimed', async () => {
  const admin = fakeAdmin([[message({ phone: '+64211234567' })]]);
  const twilio = fakeTwilio([{ body: { sid: 'never' } }]);
  const result = await sendRosterSms(admin, { credentials: CREDENTIALS, fetcher: twilio.fetcher, sleep: async () => {} });
  assert.equal(result.failed, 1);
  assert.equal(twilio.calls.length, 0);
  assert.equal(admin.records[0].p_error, 'MOBILE_INVALID');

  const idle = fakeAdmin([[message()]]);
  assert.deepEqual(await sendRosterSms(idle, { credentials: null, fetcher: twilio.fetcher }), { configured: false, attempted: 0, sent: 0, failed: 0, retrying: 0, unrecorded: 0 });
  assert.equal(idle.claims.length, 0);
});

// ─── The endpoint ───────────────────────────────────────────────────────────

/** Routes the handler's fetches: Supabase auth, profiles, RPCs, then Twilio. */
function stubNetwork({ role = 'admin', claim = [[message()]] } = {}) {
  const seen = [];
  const claims = [...claim];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    const method = init.method || input?.method || 'GET';
    seen.push(`${method} ${url.replace(SUPABASE, '')}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith(`${SUPABASE}/auth/v1/user`)) return json({ id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated' });
    if (url.startsWith(`${SUPABASE}/rest/v1/profiles`)) {
      const accept = new Headers(init.headers || {}).get('accept') || '';
      return json(accept.includes('vnd.pgrst.object') ? { role } : [{ role }]);
    }
    if (url === `${SUPABASE}/rest/v1/rpc/staff_roster_sms_claim`) return json(claims.shift() || []);
    if (url === `${SUPABASE}/rest/v1/rpc/staff_roster_sms_record`) {
      const body = JSON.parse(init.body);
      return json({ recorded: true, status: body.p_ok ? 'sent' : 'failed' });
    }
    if (url.startsWith('https://api.twilio.com/')) return json({ sid: 'SM-endpoint', status: 'queued' }, 201);
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

// The Vercel Node request shape: lower-case headers and an already-parsed body.
const post = (body, token = 'synthetic-session') => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body,
});

test('send_roster_sms needs a signed-in manager', async () => {
  const network = stubNetwork({ role: 'member' });
  try {
    const anonymous = await api.default(post({ action: 'send_roster_sms' }, null));
    assert.equal(anonymous.status, 401);
    const member = await api.default(post({ action: 'send_roster_sms' }));
    assert.equal(member.status, 403);
    assert.equal(network.seen.some(line => /rpc\/staff_roster_sms_claim|twilio/.test(line)), false, 'nothing is claimed or sent');
  } finally {
    network.restore();
  }
});

test('send_roster_sms for a manager claims, sends through Twilio and records', async () => {
  const network = stubNetwork();
  try {
    const response = await api.default(post({ action: 'send_roster_sms' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { configured: true, attempted: 1, sent: 1, failed: 0, retrying: 0, unrecorded: 0 });
    assert.deepEqual(network.seen.filter(line => /rpc|twilio/.test(line)), [
      'POST /rest/v1/rpc/staff_roster_sms_claim',
      'POST https://api.twilio.com/2010-04-01/Accounts/ACsynthetic/Messages.json',
      'POST /rest/v1/rpc/staff_roster_sms_record',
    ]);
  } finally {
    network.restore();
  }
});
