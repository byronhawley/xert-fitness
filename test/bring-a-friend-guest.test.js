import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldOfferVisitorPasses } from '../src/lib/visitorPassChoices.js';
import { bookingCsvRows } from '../src/lib/bookingAnalytics.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const sql = read('../supabase/migrations/20260923010000_bring_a_friend_guest_visit.sql');

test('a guest can say so when they book, and it sticks to the booking', () => {
  assert.match(sql, /add column if not exists guest_visit boolean not null default false/);
  assert.match(sql, /p_guest_visit boolean DEFAULT false\)/);
  assert.match(sql, /coalesce\(p_guest_visit, false\)/);
  // Defaulting to false matters: every booking already on file, and every
  // caller that does not pass it, stays exactly what it was.
  assert.match(sql, /'guest_visit', coalesce\(p_guest_visit, false\)/);
});

test('a guest with no account can still sign up, and the old signature is gone', () => {
  // The whole point is somebody with no account and no membership booking in.
  assert.match(sql, /grant execute on function public\.submit_class_signup\([^)]*\) to anon, authenticated/);
  assert.match(sql, /raise exception 'A guest with no account must still be able to sign up\.'/);
  // Two overloads would both exist and positional callers would hit the old
  // one, silently dropping the answer.
  assert.match(sql, /drop function if exists public\.submit_class_signup\(uuid, text, text, text, boolean, text, text, boolean\)/);
  assert.match(sql, /raise exception 'The previous sign-up signature is still installed\.'/);
});

test('a guest is never asked to pay for the class they were invited to', () => {
  // Following "your spot is held" with a price list is how a free invitation
  // stops feeling free.
  assert.equal(shouldOfferVisitorPasses({ has_membership: false, guest_visit: true }, {}), false);
  // Everybody else who is not a member still sees the ways to pay.
  assert.equal(shouldOfferVisitorPasses({ has_membership: false }, {}), true);
  assert.equal(shouldOfferVisitorPasses({ has_membership: false, guest_visit: false }, {}), true);
});

test('the form only offers it to somebody who is not a member', () => {
  const form = read('../src/components/public/BookingRequestForm.jsx');
  assert.match(form, /I am a guest of a member \(bring a friend\)/);
  assert.match(form, /hasMembership === false && \(/);
  // A member ticking it in a previous answer must not leak into the send.
  assert.match(form, /guest_visit: hasMembership === false && guestVisit/);
});

test('staff can see and export who came in free', () => {
  const table = read('../src/components/admin/BookingRequestsTable.jsx');
  assert.match(table, /\{b\.guest_visit && \(/);
  assert.match(table, />\s*Guest\s*</);
  assert.match(read('../src/lib/adminData.js'), /created_at, class_session_id, guest_visit,/,
    'the badge needs the column loaded or it never shows');

  const [row] = bookingCsvRows([{ full_name: 'A Friend', guest_visit: true }]);
  assert.equal(row.guest_visit, 'Yes');
  assert.equal(bookingCsvRows([{ full_name: 'A Payer' }])[0].guest_visit, 'No');
});

test('a bring-a-friend guest is sent to the casual pre-exercise questionnaire after booking', async () => {
  const { questionnairePromptAfterSignup, CASUAL_QUESTIONNAIRE_PATH } = await import('../src/lib/visitorPassChoices.js');
  assert.equal(CASUAL_QUESTIONNAIRE_PATH, '/forms/peq-casual');
  assert.deepEqual(questionnairePromptAfterSignup({ has_membership: false, guest_visit: true }),
    { path: '/forms/peq-casual', guest: true });
  // Any casual owes the questionnaire; members signed theirs when they joined.
  assert.deepEqual(questionnairePromptAfterSignup({ has_membership: false, guest_visit: false }),
    { path: '/forms/peq-casual', guest: false });
  assert.equal(questionnairePromptAfterSignup({ has_membership: true }), null);
  assert.equal(questionnairePromptAfterSignup(null), null);
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../src/pages/SoftLaunchTimetable.jsx', import.meta.url), 'utf8');
  assert.match(page, /questionnairePromptAfterSignup\(bookingSuccess\)/);
  assert.match(page, /<Link to=\{questionnairePrompt\.path\}/);
});
