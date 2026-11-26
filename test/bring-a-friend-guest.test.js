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
  // A member ticking it in a previous answer, or a tick left over from a
  // bring-a-friend class, must not leak into the send.
  assert.match(form, /const asGuest = hasMembership === false && friendDay && guestVisit;/);
  assert.match(form, /guest_visit: asGuest,/);
  assert.doesNotMatch(form, /guest_visit: hasMembership === false && guestVisit/);
});

test('it is only offered on bring-a-friend day, the last Saturday of the month', async () => {
  const form = read('../src/components/public/BookingRequestForm.jsx');
  assert.match(form, /const friendDay = isBringAFriendDay\(session\?\.start_time\);/);
  assert.match(form, /\{friendDay && <label/);
  const { isBringAFriendDay } = await import('../src/lib/gymTime.js');
  for (const [at, expected] of [
    ['2026-11-28T08:00:00+10:00', true],   // last Saturday of November
    ['2026-11-21T08:00:00+10:00', false],  // a Saturday, not the last
    ['2026-11-27T08:00:00+10:00', false],  // the Friday before
    ['2026-10-31T08:00:00+10:00', true],   // last day of the month is the Saturday
    ['2027-01-30T08:00:00+10:00', true],
    ['2026-11-27T22:30:00Z', true],        // already Saturday morning in Kingaroy
    [null, false],
  ]) assert.equal(isBringAFriendDay(at), expected, String(at));
});

test('the database refuses a guest sign-up on any other day, whatever sent it', () => {
  const sql = read('../supabase/migrations/20261126010000_bring_a_friend_last_saturday.sql');
  assert.match(sql, /extract\(isodow from \(p_at at time zone 'Australia\/Brisbane'\)::date\) = 6/);
  assert.match(sql, /extract\(month from \(p_at at time zone 'Australia\/Brisbane'\)::date \+ 7\)\s*<> extract\(month/);
  assert.match(sql, /raise exception 'GUEST_VISIT_NOT_AVAILABLE'/);
  assert.match(sql, /before insert or update of guest_visit, class_session_id on public\.class_bookings/);
  // Somebody who ticks it on an old copy of the site is told why in words.
  assert.match(read('../src/lib/classSignup.js'), /GUEST_VISIT_NOT_AVAILABLE: 'Bring-a-friend is only on the last Saturday of the month\./);
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
