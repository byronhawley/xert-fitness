// Real PostgreSQL (PGlite) tests for two-way bookings with XertOS.
// SYNTHETIC DATA ONLY: no provider traffic, credential or production data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { xertosRequestFingerprint } from '../src/lib/xertosSync.js';

const BASE_SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid
  $$;
  create table public.profiles (
    id uuid primary key, full_name text, email text, phone text,
    role text not null default 'member', created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create function public.is_admin() returns boolean language sql stable security definer
  set search_path = public as $$ select coalesce(current_setting('test.admin', true) = 'yes', false) $$;
  create table public.class_templates (
    id uuid primary key default gen_random_uuid(), class_type text unique, title text,
    description text, coach_name text, duration_minutes integer default 60, capacity integer default 8,
    location_zone text, beginner_friendly boolean default false, intensity_level text default 'Moderate',
    booking_mode text default 'request_to_book', notes text, updated_at timestamptz not null default now()
  );
  create table public.class_sessions (
    id uuid primary key default gen_random_uuid(), class_type text not null default 'XERT Strength',
    title text not null default 'Synthetic class', description text, coach_name text,
    start_time timestamptz, end_time timestamptz, duration_minutes integer not null default 60,
    capacity integer not null default 8, location_zone text, beginner_friendly boolean not null default false,
    intensity_level text not null default 'Moderate', status text not null default 'published',
    public_visible boolean not null default true, booking_mode text not null default 'instant_book',
    notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table public.credit_batches (
    id uuid primary key, total integer not null default 10, remaining integer not null default 0,
    expires_at timestamptz
  );
  create table public.session_bookings (
    id uuid primary key default gen_random_uuid(), user_id uuid, class_session_id uuid, status text,
    credit_batch_id uuid, entitlement_id uuid, cancelled_at timestamptz,
    created_at timestamptz not null default now()
  );
  create table public.class_bookings (
    id uuid primary key default gen_random_uuid(), class_session_id uuid, full_name text, email text,
    phone text, status text, created_at timestamptz not null default now()
  );
  create table public.member_announcements (
    id uuid primary key, title text, body text, tone text, cta_label text, cta_url text, audience text,
    source_kind text, source_id uuid, published_at timestamptz, expires_at timestamptz,
    created_by uuid, last_changed_by uuid
  );
  create table public.member_announcement_targets (announcement_id uuid, user_id uuid);
  create table public.admin_staff_booking_receipts (
    request_id uuid primary key, booking_id uuid not null, session_id uuid not null, member_id uuid not null,
    booking_status text not null, credit_batch_id uuid, announcement_id uuid, created_by uuid,
    created_at timestamptz not null default now()
  );
  create function public.class_places_held(p_session_id uuid)
  returns table(held integer, waiting integer) language sql stable as $$
    select
      ((select count(*) from public.session_bookings
         where class_session_id = p_session_id and status in ('requested', 'confirmed'))
       + (select count(*) from public.class_bookings
         where class_session_id = p_session_id and status = 'confirmed'))::integer,
      (select count(*) from public.session_bookings
        where class_session_id = p_session_id and status = 'waitlisted')::integer
  $$;
  create function public.create_class_cancellation_notice(p_session_id uuid)
  returns integer language plpgsql as $$ begin return 0; end $$;
  create table public.xert_schema_capabilities (capability text primary key, installed_at timestamptz not null default now());
`;

const SESSION = '00000000-0000-4000-8000-00000000b001';
const JESS = '00000000-0000-4000-8000-0000000000a1';
const SAM = '00000000-0000-4000-8000-0000000000a2';
const target = '/api/admin-fitbox-integration?service=xertos_edit';
const refreshTarget = '/api/stripe-webhook?provider=xertos';

// The front desk's function body before this change, to prove the split keeps it.
async function frontDeskFunction() {
  const source = await readFile(new URL('../supabase/migrations/20260908020000_bookings_without_credits.sql', import.meta.url), 'utf8');
  const start = source.indexOf('create or replace function public.admin_book_member_into_class(');
  return source.slice(start, source.indexOf('$function$;', start) + '$function$;'.length);
}

async function database({ capacity = 2 } = {}) {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(await frontDeskFunction());
  for (const file of [
    '20261004010000_xertos_class_sync.sql',
    '20261009010000_xertos_receipt_fingerprint.sql',
    '20261010010000_xertos_two_way_bookings.sql',
    '20261011010000_xertos_guest_signups.sql',
    '20261012010000_xertos_signup_waitlist.sql',
    '20261113010000_xertos_site_booking_refresh.sql',
  ]) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await db.query(`
    insert into public.profiles (id, full_name, email, role) values
      ($1, 'Jess Member', 'Jess@Example.com', 'member'),
      ($2, 'Sam Member', 'sam@example.com', 'member'),
      (gen_random_uuid(), 'Twin One', 'twins@example.com', 'member'),
      (gen_random_uuid(), 'Twin Two', 'twins@example.com', 'member'),
      (gen_random_uuid(), 'Coach', 'coach@example.com', 'admin')
  `, [JESS, SAM]);
  await db.query(`
    insert into public.class_sessions (id, start_time, end_time, capacity, updated_at)
    values ($1, now() + interval '2 days', now() + interval '2 days 1 hour', $2, '2026-10-09T00:00:00Z')
  `, [SESSION, capacity]);
  await db.query('update public.xertos_sync_settings set enabled = true, share_bookings = true');
  return db;
}

const book = (email, requestId, extra = {}) => JSON.stringify({
  action: 'book', externalId: SESSION, member: { email, name: 'Someone', personId: 'per_x' },
  waitlistIfFull: true, by: 'member', requestId, ...extra,
});
const cancel = (bookingExternalId, requestId, by = 'member') => JSON.stringify({
  action: 'cancelBooking', externalId: SESSION, bookingExternalId, reason: null, by, requestId,
});
async function apply(db, body) {
  const fingerprint = xertosRequestFingerprint({ method: 'POST', target, rawBody: body });
  const result = await db.query('select public.xertos_sync_apply_booking($1::jsonb, $2::text) as answer', [body, fingerprint]);
  return result.rows[0].answer;
}

const refreshBookings = (requestId, externalId = SESSION) => JSON.stringify({
  action: 'refreshBookings', externalId, requestId,
});

async function refresh(db, body) {
  const fingerprint = xertosRequestFingerprint({ method: 'POST', target: refreshTarget, rawBody: body });
  const result = await db.query(
    'select public.xertos_sync_refresh_bookings($1::jsonb, $2::text) as answer',
    [body, fingerprint],
  );
  return result.rows[0].answer;
}

test('every class sent to XertOS carries its bookings once sharing is on', async () => {
  const db = await database();
  await db.query(`insert into public.session_bookings (user_id, class_session_id, status) values ($1, $2, 'confirmed')`, [JESS, SESSION]);
  await db.query(`insert into public.session_bookings (user_id, class_session_id, status) values ($1, $2, 'cancelled')`, [SAM, SESSION]);
  await db.query(`insert into public.class_bookings (class_session_id, full_name, email, status) values ($1, 'Walk In', 'WALK@in.example ', 'confirmed')`, [SESSION]);
  await db.query(`insert into public.class_bookings (class_session_id, full_name, email, status) values ($1, 'Enquiry', 'ask@in.example', 'requested')`, [SESSION]);

  const payload = (await db.query('select public.xertos_class_payload($1) as item', [SESSION])).rows[0].item;
  assert.equal(payload.bookedCount, 2);
  assert.deepEqual(payload.bookings.map((b) => [b.externalId.split(':')[0], b.status, b.name, b.email]), [
    ['member', 'confirmed', 'Jess Member', 'jess@example.com'],
    ['signup', 'confirmed', 'Walk In', 'walk@in.example'],
  ]);
  assert.match(payload.bookingsAsOf, /^\d{4}-\d\d-\d\dT/);

  const window = (await db.query('select public.xertos_sync_window(28) as w')).rows[0].w;
  assert.equal(window.classes[0].bookings.length, 2);

  await db.query('update public.xertos_sync_settings set share_bookings = false');
  const before = (await db.query('select public.xertos_class_payload($1) as item', [SESSION])).rows[0].item;
  assert.equal('bookings' in before, false, 'off: classes go exactly as before');
  await assert.rejects(() => apply(db, book('sam@example.com', 'req-off')), /BOOKINGS_OFF/);
});

test('a booking from XertOS goes through the front desk rules, once', async () => {
  const db = await database({ capacity: 1 });
  const first = await apply(db, book(' JESS@example.com', 'req-1'));
  assert.equal(first.booking.status, 'confirmed');
  assert.match(first.booking.externalId, /^member:/);
  assert.equal(first.class.bookedCount, 1);
  assert.equal(first.class.bookings[0].externalId, first.booking.externalId);
  const notice = await db.query('select title from public.member_announcements');
  assert.deepEqual(notice.rows.map((r) => r.title), ['XERT booked your class']);

  // The same request again is answered from its receipt; nothing is booked twice.
  assert.deepEqual(await apply(db, book(' JESS@example.com', 'req-1')), first);
  // A new request for someone already on the class answers with their booking.
  const again = await apply(db, book('jess@example.com', 'req-2'));
  assert.equal(again.booking.externalId, first.booking.externalId);
  const count = await db.query(`select count(*)::int as n from public.session_bookings where user_id = $1`, [JESS]);
  assert.equal(count.rows[0].n, 1);

  // Full: waitlisted, or refused when XertOS asked not to queue them.
  await assert.rejects(() => apply(db, book('sam@example.com', 'req-3', { waitlistIfFull: false })), /CLASS_FULL/);
  const queued = await apply(db, book('sam@example.com', 'req-4'));
  assert.equal(queued.booking.status, 'waitlisted');
});

test('someone two XERT accounts share is refused', async () => {
  const db = await database();
  await assert.rejects(() => apply(db, book('twins@example.com', 'req-b')), /SITE_ACCOUNT_AMBIGUOUS/);
  const count = await db.query('select (select count(*) from public.session_bookings) + (select count(*) from public.class_bookings) as n');
  assert.equal(Number(count.rows[0].n), 0);
});

test('someone with no XERT member account is booked as a sign-up', async () => {
  const db = await database({ capacity: 2 });
  const guest = (email, requestId, extra = {}) => JSON.stringify({
    action: 'book', externalId: SESSION, member: { email, name: 'Casual Visitor', phone: '+61 400 000 000' },
    waitlistIfFull: true, by: 'member', requestId, ...extra,
  });

  // Nobody here, and a staff (admin) account: both become sign-ups.
  const first = await apply(db, guest(' Visitor@Example.com', 'req-g1'));
  assert.equal(first.booking.status, 'confirmed');
  assert.match(first.booking.externalId, /^signup:/);
  const row = await db.query('select full_name, email, phone, status from public.class_bookings');
  assert.deepEqual(row.rows, [{ full_name: 'Casual Visitor', email: 'visitor@example.com', phone: '+61 400 000 000', status: 'confirmed' }]);
  assert.equal(first.class.bookings.find((b) => b.externalId === first.booking.externalId)?.email, 'visitor@example.com');
  const coach = await apply(db, guest('coach@example.com', 'req-g2'));
  assert.match(coach.booking.externalId, /^signup:/);
  assert.equal(coach.booking.status, 'confirmed');
  const members = await db.query('select count(*)::int as n from public.session_bookings');
  assert.equal(members.rows[0].n, 0, 'no member booking is made for them');

  // Asking again answers with the same sign-up.
  assert.equal((await apply(db, guest('visitor@example.com', 'req-g3'))).booking.externalId, first.booking.externalId);

  // Full: waitlisted, or refused when XertOS asked not to queue them.
  await assert.rejects(() => apply(db, guest('late@example.com', 'req-g4', { waitlistIfFull: false })), /CLASS_FULL/);
  assert.equal((await apply(db, guest('late@example.com', 'req-g5'))).booking.status, 'waitlisted');

  // A phone that isn't one is dropped, not stored; a name is required.
  await apply(db, JSON.stringify({ action: 'book', externalId: SESSION, member: { email: 'odd@example.com', name: 'Odd Phone', phone: 'call me' }, waitlistIfFull: true, by: 'member', requestId: 'req-g6' }));
  assert.equal((await db.query(`select phone from public.class_bookings where email = 'odd@example.com'`)).rows[0].phone, null);
  await assert.rejects(() => apply(db, JSON.stringify({ action: 'book', externalId: SESSION, member: { email: 'anon@example.com', name: ' ' }, waitlistIfFull: true, by: 'member', requestId: 'req-g7' })), /INVALID_EDIT/);

  // XertOS cancels it like any other sign-up.
  const cancelled = await apply(db, cancel(first.booking.externalId, 'req-g8'));
  assert.equal(cancelled.booking.status, 'cancelled');

  // A class that has finished takes nobody.
  await db.query(`update public.class_sessions set start_time = now() - interval '2 hours', end_time = now() - interval '1 hour'`);
  await assert.rejects(() => apply(db, guest('after@example.com', 'req-g9')), /SESSION_FINISHED/);
});

test('a sign-up waiting for a place stays visible to XertOS and can be taken off the list', async () => {
  const db = await database({ capacity: 1 });
  const guest = (email, requestId) => JSON.stringify({
    action: 'book', externalId: SESSION, member: { email, name: 'Casual Visitor' },
    waitlistIfFull: true, by: 'member', requestId,
  });
  await apply(db, guest('first@example.com', 'req-w1'));
  const waiting = await apply(db, guest('second@example.com', 'req-w2'));
  assert.equal(waiting.booking.status, 'waitlisted');
  // The class XertOS receives lists them as waiting, so its next push keeps them.
  assert.deepEqual(
    waiting.class.bookings.map((b) => [b.externalId === waiting.booking.externalId, b.status]),
    [[false, 'confirmed'], [true, 'waitlisted']],
  );
  // A public "tell me if a place frees up" is listed the same way.
  await db.query(`insert into public.class_bookings (class_session_id, full_name, email, status)
    values ($1, 'Public Queue', 'queue@in.example', 'waitlisted')`, [SESSION]);
  const payload = (await db.query('select public.xertos_class_payload($1) as item', [SESSION])).rows[0].item;
  assert.equal(payload.bookings.filter((b) => b.status === 'waitlisted').length, 2);
  assert.equal(payload.bookedCount, 1, 'waiting holds no place');

  // Leaving the list from XertOS really takes them off it on XERT.
  const left = await apply(db, cancel(waiting.booking.externalId, 'req-w3'));
  assert.equal(left.booking.status, 'cancelled');
  const row = await db.query('select status from public.class_bookings where id = $1', [waiting.booking.externalId.split(':')[1]]);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.equal(left.class.bookings.some((b) => b.externalId === waiting.booking.externalId), false);
});

test('a cancellation from XertOS frees the place on XERT', async () => {
  const db = await database();
  const booked = await apply(db, book('jess@example.com', 'req-1'));
  const cancelled = await apply(db, cancel(booked.booking.externalId, 'req-2'));
  assert.deepEqual(cancelled.booking, { externalId: booked.booking.externalId, status: 'cancelled' });
  assert.equal(cancelled.class.bookedCount, 0);
  assert.deepEqual(cancelled.class.bookings, []);
  // Cancelling again is harmless.
  assert.equal((await apply(db, cancel(booked.booking.externalId, 'req-3'))).booking.status, 'cancelled');

  const signup = (await db.query(`insert into public.class_bookings (class_session_id, full_name, email, status)
    values ($1, 'Walk In', 'walk@in.example', 'confirmed') returning id`, [SESSION])).rows[0].id;
  await apply(db, cancel(`signup:${signup}`, 'req-4', 'staff'));
  const after = await db.query('select status from public.class_bookings where id = $1', [signup]);
  assert.equal(after.rows[0].status, 'cancelled');

  await assert.rejects(() => apply(db, cancel('member:not-a-uuid', 'req-5')), /BOOKING_NOT_FOUND/);
  await assert.rejects(() => apply(db, cancel(`member:${JESS}`, 'req-6')), /BOOKING_NOT_FOUND/);
});

test('the front desk still books exactly as before, and only for admins', async () => {
  const db = await database();
  await assert.rejects(
    () => db.query(`select * from public.admin_book_member_into_class($1, $2, gen_random_uuid())`, [SESSION, SAM]),
    /ADMIN_ONLY/,
  );
  await db.query(`select set_config('test.admin', 'yes', false), set_config('test.uid', $1, false)`, [JESS]);
  const row = (await db.query(`select * from public.admin_book_member_into_class($1, $2, gen_random_uuid())`, [SESSION, SAM])).rows[0];
  assert.equal(row.booking_status, 'confirmed');
  const receipt = await db.query('select created_by from public.admin_staff_booking_receipts');
  assert.equal(receipt.rows[0].created_by, JESS);
});

test('a post-match refresh queues the current class snapshot without changing booking or capacity authority', async () => {
  const db = await database({ capacity: 3 });
  await db.query(`insert into public.session_bookings (user_id, class_session_id, status)
    values ($1, $2, 'confirmed')`, [JESS, SESSION]);
  await db.query(`insert into public.class_bookings (class_session_id, full_name, email, status)
    values ($1, 'Public Guest', 'guest@example.com', 'confirmed')`, [SESSION]);
  const before = (await db.query(`
    select s.capacity,
      (select count(*)::int from public.session_bookings where class_session_id = s.id) as member_rows,
      (select count(*)::int from public.class_bookings where class_session_id = s.id) as public_rows,
      places.held, places.waiting
    from public.class_sessions s
    cross join lateral public.class_places_held(s.id) as places
    where s.id = $1
  `, [SESSION])).rows[0];

  // The initial site booking has already been mirrored to XertOS. Move the
  // synthetic outbox receipt past the cooldown so this request represents a
  // later staff match, not a duplicate of the original booking push.
  const initialClaim = (await db.query('select public.xertos_sync_claim(1) as claim')).rows[0].claim;
  assert.ok(initialClaim.lease);
  await db.query('select public.xertos_sync_settle($1, true, null, null, null)', [initialClaim.lease]);
  await db.query(`update public.xertos_class_outbox
    set sent_at = clock_timestamp() - interval '31 seconds'
    where session_id = $1`, [SESSION]);

  const body = refreshBookings('site-booking-match:sbk_123');
  const answer = await refresh(db, body);
  assert.deepEqual(answer, { ok: true, status: 'queued', externalId: SESSION });
  const queued = (await db.query(`select changed_at, sent_changed_at, attempts, lease_id
    from public.xertos_class_outbox where session_id = $1`, [SESSION])).rows[0];
  assert.ok(queued.changed_at);
  assert.notEqual(queued.sent_changed_at.toISOString(), queued.changed_at.toISOString(),
    'the refreshed snapshot is due after the earlier booking snapshot was sent');
  assert.equal(queued.attempts, 0);
  assert.equal(queued.lease_id, null);

  const after = (await db.query(`
    select s.capacity,
      (select count(*)::int from public.session_bookings where class_session_id = s.id) as member_rows,
      (select count(*)::int from public.class_bookings where class_session_id = s.id) as public_rows,
      places.held, places.waiting
    from public.class_sessions s
    cross join lateral public.class_places_held(s.id) as places
    where s.id = $1
  `, [SESSION])).rows[0];
  assert.deepEqual(after, before, 'refresh only queues the snapshot; it does not book, cancel, attend or change capacity');

  const replay = await refresh(db, body);
  assert.deepEqual(replay, answer, 'the same request ID replays the durable receipt');
  const replayedOutbox = (await db.query('select changed_at from public.xertos_class_outbox where session_id = $1', [SESSION])).rows[0];
  assert.equal(replayedOutbox.changed_at.toISOString(), queued.changed_at.toISOString());
  await assert.rejects(
    () => refresh(db, refreshBookings('site-booking-match:sbk_123', '00000000-0000-4000-8000-00000000b002')),
    /IDEMPOTENCY_KEY_REUSED/,
  );
});

test('an active class-push lease is followed by a second snapshot after the current send settles', async () => {
  const db = await database();
  await db.query('select public.xertos_queue_class($1)', [SESSION]);
  const claimed = (await db.query('select public.xertos_sync_claim(1) as claim')).rows[0].claim;
  assert.ok(claimed.lease);
  const before = (await db.query('select changed_at, claimed_changed_at, lease_id from public.xertos_class_outbox where session_id = $1', [SESSION])).rows[0];

  const answer = await refresh(db, refreshBookings('site-booking-match:sbk_lease'));
  assert.deepEqual(answer, { ok: true, status: 'queued', externalId: SESSION });
  const during = (await db.query('select changed_at, claimed_changed_at, lease_id from public.xertos_class_outbox where session_id = $1', [SESSION])).rows[0];
  assert.notEqual(during.changed_at.toISOString(), before.claimed_changed_at.toISOString());
  assert.equal(during.lease_id, claimed.lease, 'the current lease is not stolen or cleared');

  await db.query('select public.xertos_sync_settle($1, true, null, null, null)', [claimed.lease]);
  assert.equal((await db.query('select public.xertos_sync_due() as due')).rows[0].due, true,
    'settling the older payload leaves the newer booking snapshot due');
});

test('an already-pending class refresh reuses its retry schedule instead of resetting backoff', async () => {
  const db = await database();
  await db.query('select public.xertos_queue_class($1)', [SESSION]);
  await db.query(`update public.xertos_class_outbox
    set attempts = 4, next_attempt_at = now() + interval '5 minutes', last_error = 'transient'
    where session_id = $1`, [SESSION]);
  const before = (await db.query('select changed_at, attempts, next_attempt_at, last_error from public.xertos_class_outbox where session_id = $1', [SESSION])).rows[0];
  const answer = await refresh(db, refreshBookings('site-booking-match:sbk_pending'));
  assert.deepEqual(answer, { ok: true, status: 'already_pending', externalId: SESSION });
  const after = (await db.query('select changed_at, attempts, next_attempt_at, last_error from public.xertos_class_outbox where session_id = $1', [SESSION])).rows[0];
  assert.deepEqual(after, before);
});

test('recently sent classes are rate-limited, then become refreshable after the cooldown', async () => {
  const db = await database();
  await db.query('select public.xertos_queue_class($1)', [SESSION]);
  const claimed = (await db.query('select public.xertos_sync_claim(1) as claim')).rows[0].claim;
  await db.query('select public.xertos_sync_settle($1, true, null, null, null)', [claimed.lease]);
  await assert.rejects(() => refresh(db, refreshBookings('site-booking-match:sbk_rate_1')), /REFRESH_RATE_LIMITED/);
  assert.equal((await db.query("select count(*)::int as n from public.xertos_edit_receipts where request_id = 'site-booking-match:sbk_rate_1'")).rows[0].n, 0,
    'a rate-limited attempt does not consume its request ID');

  await db.query(`update public.xertos_class_outbox set sent_at = clock_timestamp() - interval '31 seconds' where session_id = $1`, [SESSION]);
  const allowed = await refresh(db, refreshBookings('site-booking-match:sbk_rate_1'));
  assert.deepEqual(allowed, { ok: true, status: 'queued', externalId: SESSION });
});

test('post-match refresh fails closed when sync or booking sharing is disabled or the class is missing', async () => {
  const db = await database();
  await db.query('update public.xertos_sync_settings set share_bookings = false');
  await assert.rejects(() => refresh(db, refreshBookings('site-booking-match:sbk_off')), /BOOKINGS_OFF/);
  await db.query('update public.xertos_sync_settings set share_bookings = true, enabled = false');
  await assert.rejects(() => refresh(db, refreshBookings('site-booking-match:sbk_sync_off')), /SYNC_OFF/);
  await db.query('update public.xertos_sync_settings set enabled = true');
  await assert.rejects(() => refresh(db, refreshBookings('site-booking-match:sbk_missing', '00000000-0000-4000-8000-00000000b099')), /SESSION_NOT_FOUND/);
  assert.equal((await db.query('select count(*)::int as n from public.xertos_class_outbox')).rows[0].n, 0);
});

test('post-match refresh is callable only by the service role, never anonymous or authenticated browsers', async () => {
  const db = await database();
  const grants = (await db.query(`
    select
      has_function_privilege('anon', 'public.xertos_sync_refresh_bookings(jsonb,text)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.xertos_sync_refresh_bookings(jsonb,text)', 'EXECUTE') as member,
      has_function_privilege('service_role', 'public.xertos_sync_refresh_bookings(jsonb,text)', 'EXECUTE') as service
  `)).rows[0];
  assert.deepEqual(grants, { anon: false, member: false, service: true });
});
