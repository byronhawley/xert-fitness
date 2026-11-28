import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import handler, { client0PairsEnabled } from '../src/lib/xertosWebhook.js';
import { PairsRefused, pairsEntryFromXertos, runPairsAction } from '../src/lib/xertosPairs.js';
import { PAIRS_FORM_SLUG, pairsFormDefinition } from '../src/lib/pairsCompetition.js';

Object.assign(process.env, { XERTOS_WRITE_SECRET: 'current-secret', XERTOS_WRITE_SECRET_VERSION: '7' });

function signedHeaders(rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', 'current-secret').update(`${timestamp}.${rawBody}`).digest('hex');
  return { 'x-webhook-timestamp': String(timestamp), 'x-webhook-signature': `v1,k7=${signature}` };
}
const mockResponse = () => ({
  statusCode: 0, body: null, setHeader() {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const request = (rawBody, headers) => ({ method: 'POST', headers, async *[Symbol.asyncIterator]() { yield Buffer.from(rawBody); } });

async function send(payload, runPairs, env = {}) {
  const keys = ['CLIENT0_SYNC_ENABLED', 'CLIENT0_PAIRS_ENABLED'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  try {
    const raw = JSON.stringify(payload);
    const response = mockResponse();
    await handler(request(raw, signedHeaders(raw)), response, { runPairs });
    return response;
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  }
}
const ON = { CLIENT0_SYNC_ENABLED: 'true', CLIENT0_PAIRS_ENABLED: 'true' };

const SUB = 'aacdf9ca-f8df-47ae-acc1-6a5931e574a2';
const definition = pairsFormDefinition();
const questions = [definition.questions[0], { id: SUB, type: 'single_choice', question: 'SUB category', options: ['MALE/MALE', 'FEMALE/FEMALE'], required: true }, ...definition.questions.slice(1)];
const liveBoard = {
  form: { id: 'f1', slug: PAIRS_FORM_SLUG, title: 'Pairs', isActive: true, updatedAt: '2026-11-27T00:00:00Z', questions },
  entries: [{ id: 'r1', name: 'Kirra', email: 'k@example.com', phone: null, enteredAt: '2026-11-27T01:00:00Z', archivedAt: null, answers: { 'pairs-category': 'Everyday', [SUB]: 'FEMALE/FEMALE' } }],
};

function fakeAdmin(answers) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      const answer = answers[name];
      return typeof answer === 'function' ? answer(args) : answer;
    },
  };
}

test('Pairs from XertOS is off until both switches are on', async () => {
  assert.equal(client0PairsEnabled({ CLIENT0_SYNC_ENABLED: 'true' }), false);
  assert.equal(client0PairsEnabled(ON), true);
  let ran = false;
  const off = await send({ action: 'pairsBoard' }, async () => { ran = true; }, { CLIENT0_SYNC_ENABLED: 'true' });
  assert.equal(off.statusCode, 501);
  assert.equal(off.body.error.code, 'ACTION_NOT_READY');
  assert.equal(ran, false, 'nothing reaches the database while it is off');
});

test('the board gives XertOS the live form, the divisions and every entry', async () => {
  const admin = fakeAdmin({ xertos_pairs_board: { data: liveBoard } });
  const { competition } = await runPairsAction(admin, { action: 'pairsBoard', slug: 'some-other-form' }, { now: new Date('2026-12-01T00:00:00Z') });
  assert.deepEqual(admin.calls, [['xertos_pairs_board', { p_slug: PAIRS_FORM_SLUG }]], 'always the Pairs form, whatever XertOS sends');
  assert.equal(competition.entriesOpen, true);
  assert.equal(competition.eventDate, '2026-12-19');
  assert.deepEqual(competition.divisions, {
    categoryQuestionId: 'pairs-category', categories: ['Everyday', 'Intermediate', 'Advanced'],
    splitQuestionId: SUB, splitLabel: 'SUB category', splitOptions: ['MALE/MALE', 'FEMALE/FEMALE'],
  });
  assert.equal(competition.form.questions.length, questions.length);
  assert.equal(competition.entries[0].email, 'k@example.com');

  const closed = await runPairsAction(fakeAdmin({ xertos_pairs_board: { data: liveBoard } }), { action: 'pairsBoard' }, { now: new Date('2026-12-19T14:00:00Z') });
  assert.equal(closed.competition.entriesOpen, false);
  const switchedOff = await runPairsAction(fakeAdmin({ xertos_pairs_board: { data: { ...liveBoard, form: { ...liveBoard.form, isActive: false } } } }), { action: 'pairsBoard' }, { now: new Date('2026-12-01T00:00:00Z') });
  assert.equal(switchedOff.competition.entriesOpen, false);
  assert.equal(switchedOff.competition.entriesSwitchedOff, true);
});

test('an entry from XertOS goes through the form as the member', async () => {
  const admin = fakeAdmin({ xertos_pairs_enter: { data: 'new-id' } });
  const result = await runPairsAction(admin, { action: 'pairsEnter', entry: { email: ' Kirra@Example.com ', name: 'Kirra', answers: { 'pairs-category': 'Everyday' } } }, { now: new Date('2026-12-01T00:00:00Z') });
  assert.deepEqual(result, { entryId: 'new-id' });
  assert.deepEqual(admin.calls[0], ['xertos_pairs_enter', { p_slug: PAIRS_FORM_SLUG, p_email: 'kirra@example.com', p_name: 'Kirra', p_phone: null, p_answers: { 'pairs-category': 'Everyday' } }]);

  await assert.rejects(runPairsAction(admin, { action: 'pairsEnter', entry: { email: 'k@example.com', answers: {} } }, { now: new Date('2026-12-19T14:00:00Z') }), { code: 'ENTRIES_CLOSED' });
  assert.throws(() => pairsEntryFromXertos({ entry: { email: 'nope', answers: {} } }), { code: 'INVALID_ENTRY' });
  assert.throws(() => pairsEntryFromXertos({ entry: { email: 'k@example.com' } }), { code: 'INVALID_ENTRY' });
});

test('refusals come back in words, with a code XertOS can act on', async () => {
  const when = { now: new Date('2026-12-01T00:00:00Z') };
  const entry = { email: 'k@example.com', answers: {} };
  const refuse = error => fakeAdmin({ xertos_pairs_enter: { error } });
  const cases = [
    [{ message: 'NO_XERT_ACCOUNT', code: 'P0001' }, 'NO_XERT_ACCOUNT', 422],
    [{ message: 'XERT_ACCOUNT_AMBIGUOUS', code: 'P0001' }, 'XERT_ACCOUNT_AMBIGUOUS', 422],
    [{ message: 'A response has already been submitted for this email.', code: '23505' }, 'ALREADY_ENTERED', 409],
    [{ message: 'This form is not available.', code: 'P0002' }, 'ENTRIES_CLOSED', 422],
    [{ message: 'Please complete every required question.', code: '22023' }, 'INVALID_ENTRY', 422],
    [{ message: 'PAIRS_FORM_NOT_FOUND', code: 'P0001' }, 'PAIRS_NOT_FOUND', 404],
  ];
  for (const [error, code, status] of cases) {
    await assert.rejects(runPairsAction(refuse(error), { action: 'pairsEnter', entry }, when), failure => failure instanceof PairsRefused && failure.code === code && failure.status === status);
  }
  const ok = await send({ action: 'pairsEnter', entry }, async () => { throw new PairsRefused('ALREADY_ENTERED', 'This email already has a pair entered.', 409); }, ON);
  assert.equal(ok.statusCode, 409);
  assert.deepEqual(ok.body, { error: { code: 'ALREADY_ENTERED', message: 'This email already has a pair entered.' } });
  const broken = await send({ action: 'pairsBoard' }, async () => { throw new Error('db down'); }, ON);
  assert.equal(broken.statusCode, 500);
  assert.equal(broken.body.error.code, 'PAIRS_FAILED');
});

test('removing and restoring from XertOS archives, never deletes', async () => {
  const admin = fakeAdmin({ xertos_pairs_set_archived: { data: { id: '00000000-0000-4000-8000-000000000001', archivedAt: '2026-12-01T00:00:00Z' } } });
  const result = await runPairsAction(admin, { action: 'pairsSetArchived', entryId: '00000000-0000-4000-8000-000000000001', archived: true });
  assert.deepEqual(result, { entryId: '00000000-0000-4000-8000-000000000001', archivedAt: '2026-12-01T00:00:00Z' });
  await assert.rejects(runPairsAction(admin, { action: 'pairsSetArchived', entryId: 'r1', archived: true }), { code: 'ENTRY_NOT_FOUND' });
  await assert.rejects(runPairsAction(admin, { action: 'pairsSetArchived', entryId: '00000000-0000-4000-8000-000000000001' }), { code: 'INVALID_REQUEST' });

  const ok = await send({ action: 'pairsSetArchived', entryId: 'x', archived: true }, async payload => ({ entryId: payload.entryId, archivedAt: null }), ON);
  assert.deepEqual(ok.body, { ok: true, entryId: 'x', archivedAt: null });
});

test('the database side only touches a Pairs form, for the service key only', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261128020000_xertos_pairs.sql', import.meta.url), 'utf8');
  assert.match(sql, /f\.tags @> '\["pairs"\]'::jsonb/);
  for (const fn of ['xertos_pairs_board(text)', 'xertos_pairs_enter(text, text, text, text, jsonb)', 'xertos_pairs_set_archived(text, uuid, boolean)']) {
    assert.ok(sql.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn);
    assert.ok(sql.includes(`grant execute on function public.${fn} to service_role;`), fn);
  }
  assert.match(sql, /submit_xert_form_response_v2\(/, 'entries go through the same form checks as /pairs');
  assert.doesNotMatch(sql, /delete from/i);
  const route = readFileSync(new URL('../api/stripe-webhook.js', import.meta.url), 'utf8');
  assert.match(route, /runPairs: runXertosPairs,/);
});
