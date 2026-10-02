import assert from 'node:assert/strict';
import test from 'node:test';

import { MONTH_DATE, day, addSession, apply, publish } from './helpers/staff-roster-world.mjs';
import { ptWorld, setUpAva, slots, book, details, ids, rid, rpc, rejects, inDays, at, DIANA } from './helpers/pt-booking-world.mjs';
import { as } from './helpers/staff-roster-db.mjs';

// SYNTHETIC DATA ONLY: fictional coaches and clients. No email can be sent.

const iso = (date, minute) => new Date(at(date, minute)).toISOString();

test('PT tables are closed; only the public entry points are open to visitors', async () => {
  const { db } = await ptWorld();
  const tables = await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pt\\_%'
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')
        or has_table_privilege('authenticated', c.oid, 'insert'))`);
  assert.deepEqual(tables.rows, []);
  const fns = await db.query(`
    select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'pt\\_%'`);
  const anon = fns.rows.filter(row => row.anon).map(row => row.proname).sort();
  assert.deepEqual(anon, ['pt_public_book', 'pt_public_booking', 'pt_public_cancel', 'pt_public_coaches', 'pt_public_slots']);
  for (const internal of ['pt_staff_conflict', 'pt_open_slots', 'pt_upsert_client', 'pt_replay', 'pt_send_email']) {
    assert.equal(fns.rows.find(row => row.proname === internal).auth, false, `${internal} is internal`);
  }
});

test('switched off: the public sees no coaches and cannot book; coaches cannot open PT', async () => {
  const { db } = await ptWorld({ enabled: false });
  assert.deepEqual(await rpc(db, null, 'select public.pt_public_coaches()'), { enabled: false, coaches: [] });
  await rejects(db, null, 'select public.pt_public_slots($1, $2, 7)', ['00000000-0000-4000-8000-000000000999', inDays(2)], /PT_DISABLED/);
  await rejects(db, null, 'select public.pt_public_book($1::jsonb, $2)', ['{}', rid()], /PT_DISABLED/);
  await rejects(db, ids.ava, 'select public.pt_coach_overview()', [], /PT_DISABLED/);
});

test('PT works with the roster switched off, and only for linked, active coaches', async () => {
  const { db } = await ptWorld({ rosterEnabled: false });
  const { service } = await setUpAva(db);
  await rejects(db, ids.member, 'select public.pt_coach_overview()', [], /NOT_STAFF/);
  await rejects(db, null, 'select public.pt_coach_overview()', [], /SIGN_IN_REQUIRED/);
  await rejects(db, ids.ben, 'select public.pt_coach_save_service($1::jsonb, $2)',
    [JSON.stringify({ id: service.id, version: service.version, name: 'Hijack', duration_minutes: 30, price_cents: 1 }), rid()], /SERVICE_NOT_FOUND/);
  const coaches = await rpc(db, null, 'select public.pt_public_coaches()');
  assert.equal(coaches.coaches.length, 1, 'Ben has no services or hours, so only Ava is listed');
  assert.equal(coaches.coaches[0].name, 'Ava');
  assert.equal(coaches.coaches[0].services[0].price_cents, 9000);
  assert.equal(coaches.coaches[0].services[0].packages[0].sessions_count, 5);
  await db.query(`update public.staff_members set status = 'inactive' where display_name = 'Ava'`);
  assert.equal((await rpc(db, null, 'select public.pt_public_coaches()')).coaches.length, 0);
  await rejects(db, ids.ava, 'select public.pt_coach_overview()', [], /STAFF_INACTIVE/);
});

test('each coach sets their own prices and lengths; bad values are refused', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  await rejects(db, ids.ava, 'select public.pt_coach_save_service($1::jsonb, $2)',
    [JSON.stringify({ name: 'Too long', duration_minutes: 600, price_cents: 100 }), rid()], /SERVICE_INVALID/);
  await rejects(db, ids.ava, 'select public.pt_coach_save_service($1::jsonb, $2)',
    [JSON.stringify({ id: service.id, version: service.version + 5, name: 'X', duration_minutes: 30, price_cents: 100 }), rid()], /STALE_VERSION/);
  const edited = await rpc(db, ids.ava, 'select public.pt_coach_save_service($1::jsonb, $2)',
    [JSON.stringify({ id: service.id, version: service.version, name: 'Strength 45', duration_minutes: 45, price_cents: 7500, booking_mode: 'instant' }), rid()]);
  assert.equal(edited.duration_minutes, 45);
  assert.equal(edited.version, service.version + 1);
  await rejects(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, 0, $2)',
    [JSON.stringify([{ weekday: 1, start: 360, end: 600 }, { weekday: 1, start: 540, end: 660 }]), 1], /HOURS_OVERLAP/);
  await rejects(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, 0, $2)', ['[]', 0], /STALE_VERSION/);
});

test('open times follow the coach’s hours and the notice period; a booked time disappears', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  const date = inDays(3);
  const open = await slots(db, service.id, date);
  assert.equal(open.length, 11, '6:00 to 11:00 in 30-minute steps for a 60-minute session');
  assert.equal(open[0], iso(date, 360));
  assert.deepEqual(await slots(db, service.id, inDays(0)).then(list => list.filter(value => new Date(value) < new Date(Date.now() + 12 * 3600000))), [],
    'nothing inside the 12-hour notice period');

  const booked = await book(db, service.id, iso(date, 480));
  assert.equal(booked.status, 'confirmed');
  assert.equal(booked.coach_name, 'Ava');
  assert.ok(booked.token);
  const after = await slots(db, service.id, date);
  for (const gone of [450, 480, 510]) assert.ok(!after.includes(iso(date, gone)), `${gone} overlaps the booking`);
  assert.ok(after.includes(iso(date, 420)) && after.includes(iso(date, 540)));

  await rejects(db, null, 'select public.pt_public_book($1::jsonb, $2)', [JSON.stringify({ service_id: service.id, starts_at: iso(date, 510), ...details({ email: 'other@example.test' }) }), rid()], /SLOT_UNAVAILABLE/);
  await rejects(db, null, 'select public.pt_public_book($1::jsonb, $2)', [JSON.stringify({ service_id: service.id, starts_at: iso(date, 545), ...details() }), rid()], /SLOT_UNAVAILABLE/,
    'off-grid times are refused');
  await rejects(db, null, 'select public.pt_public_book($1::jsonb, $2)', [JSON.stringify({ service_id: service.id, starts_at: iso(date, 840), ...details() }), rid()], /SLOT_UNAVAILABLE/,
    'outside the coach’s hours');
});

test('a retried submit returns the first booking instead of booking twice', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  const requestId = rid();
  const first = await book(db, service.id, iso(inDays(4), 360), {}, null, requestId);
  const again = await book(db, service.id, iso(inDays(4), 360), {}, null, requestId);
  assert.deepEqual(again, first);
  assert.equal((await db.query('select count(*)::int as n from public.pt_bookings')).rows[0].n, 1);
});

test('the coach’s buffer keeps a gap around every PT session', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db, { buffer: 15 });
  const date = inDays(3);
  await book(db, service.id, iso(date, 480));
  const open = await slots(db, service.id, date);
  assert.ok(!open.includes(iso(date, 420)), '7:00 ends at 8:00, inside the 15-minute buffer');
  assert.ok(!open.includes(iso(date, 540)), '9:00 starts inside the buffer after 9:00');
  assert.ok(open.includes(iso(date, 390)) && open.includes(iso(date, 570)));
});

test('request-to-book: the coach confirms or declines; the client can cancel by link until the cut-off', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db, { mode: 'request' });
  const date = inDays(5);
  const pending = await book(db, service.id, iso(date, 360));
  assert.equal(pending.status, 'requested');
  assert.ok(!(await slots(db, service.id, date)).includes(iso(date, 360)), 'a request holds the time');
  const overview = await rpc(db, ids.ava, 'select public.pt_coach_overview()');
  assert.equal(overview.requested, 1);
  const bookingId = overview.bookings[0].id;
  assert.equal(overview.bookings[0].client_email, 'casey@example.test');
  await rejects(db, ids.ben, 'select public.pt_coach_update_booking($1, $2, null, $3)', [bookingId, 'confirm', rid()], /BOOKING_NOT_FOUND/);
  const confirmed = await rpc(db, ids.ava, 'select public.pt_coach_update_booking($1, $2, null, $3)', [bookingId, 'confirm', rid()]);
  assert.equal(confirmed.status, 'confirmed');
  await rejects(db, ids.ava, 'select public.pt_coach_update_booking($1, $2, null, $3)', [bookingId, 'complete', rid()], /BOOKING_NOT_STARTED/);

  const viewed = await rpc(db, null, 'select public.pt_public_booking($1)', [pending.token]);
  assert.equal(viewed.status, 'confirmed');
  assert.equal(viewed.can_cancel, true);
  assert.equal(viewed.first_name, 'Casey');
  assert.equal(JSON.stringify(viewed).includes('casey@example.test'), false, 'the link page does not show contact details');
  const cancelled = await rpc(db, null, 'select public.pt_public_cancel($1)', [pending.token]);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled_by, 'client');
  assert.ok((await slots(db, service.id, date)).includes(iso(date, 360)), 'the time opens again');

  const second = await book(db, service.id, iso(date, 480));
  const id2 = (await db.query('select id from public.pt_bookings where cancel_token = $1', [second.token])).rows[0].id;
  const declined = await rpc(db, ids.ava, 'select public.pt_coach_update_booking($1, $2, $3, $4)', [id2, 'decline', 'Away that week', rid()]);
  assert.equal(declined.status, 'declined');
  assert.equal(declined.coach_note, 'Away that week');
});

test('late cancellations go to the coach, not the link', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  const date = inDays(3);
  const booked = await book(db, service.id, iso(date, 360));
  await db.query(`update public.pt_bookings set starts_at = now() + interval '5 hours', ends_at = now() + interval '6 hours'`);
  const viewed = await rpc(db, null, 'select public.pt_public_booking($1)', [booked.token]);
  assert.equal(viewed.can_cancel, false);
  await rejects(db, null, 'select public.pt_public_cancel($1)', [booked.token], /CANCEL_TOO_LATE/);
  await rejects(db, null, 'select public.pt_public_booking($1)', ['00000000-0000-4000-8000-00000000beef'], /BOOKING_NOT_FOUND/);
});

test('packages: taking one up uses a session; cancelling gives it back; a signed-in client’s package is used automatically', async () => {
  const { db } = await ptWorld();
  const { service, packageId } = await setUpAva(db);
  const date = inDays(3);
  const first = await book(db, service.id, iso(date, 360), { package_id: packageId, email: 'diana@example.test', full_name: 'Diana Synthetic' }, DIANA);
  assert.equal(first.payment_status, 'package');
  assert.equal(first.package.remaining, 4);
  assert.equal(first.package.sessions_total, 5);

  const second = await book(db, service.id, iso(date, 480), { email: 'diana@example.test', full_name: 'Diana Synthetic' }, DIANA);
  assert.equal(second.payment_status, 'package', 'her own package is used without asking again');
  assert.equal(second.package.remaining, 3);

  const stranger = await book(db, service.id, iso(date, 600), { email: 'diana@example.test', full_name: 'Not Diana' });
  assert.equal(stranger.payment_status, 'unpaid', 'someone typing her email while signed out does not spend her package');

  const clients = await rpc(db, ids.ava, 'select public.pt_coach_clients()');
  const diana = clients.find(client => client.email === 'diana@example.test');
  assert.equal(diana.is_member, true);
  assert.equal(diana.upcoming, 3);
  assert.equal(diana.packages[0].remaining, 3);
  assert.equal(diana.packages[0].paid, false);

  const secondId = (await db.query('select id from public.pt_bookings where cancel_token = $1', [second.token])).rows[0].id;
  await rpc(db, ids.ava, 'select public.pt_coach_update_booking($1, $2, null, $3)', [secondId, 'cancel', rid()]);
  await rejects(db, ids.ava, 'select public.pt_coach_update_booking($1, $2, null, $3)', [secondId, 'mark_paid', rid()], /PAID_BY_PACKAGE/);
  const paid = await rpc(db, ids.ava, 'select public.pt_coach_client_package($1::jsonb, $2)', [JSON.stringify({ client_package_id: diana.packages[0].id, action: 'mark_paid' }), rid()]);
  assert.equal(paid.paid, true);
  assert.equal(paid.remaining, 4, 'the cancelled session went back on the package');
});

test('a coach can sell a package in person and book a client in themselves', async () => {
  const { db } = await ptWorld();
  const { service, packageId } = await setUpAva(db);
  const booked = await rpc(db, ids.ava, 'select public.pt_coach_book($1::jsonb, $2)', [JSON.stringify({
    service_id: service.id, starts_at: iso(inDays(2), 900), full_name: 'Evan Walkin', email: 'evan@example.test' }), rid()]);
  assert.equal(booked.status, 'confirmed', 'coaches can book outside their public hours');
  assert.equal(booked.source, 'coach');
  const given = await rpc(db, ids.ava, 'select public.pt_coach_client_package($1::jsonb, $2)', [JSON.stringify({ client_id: booked.client_id, package_id: packageId, paid: true }), rid()]);
  assert.equal(given.remaining, 5);
  const next = await rpc(db, ids.ava, 'select public.pt_coach_book($1::jsonb, $2)', [JSON.stringify({
    service_id: service.id, starts_at: iso(inDays(3), 900), client_id: booked.client_id, client_package_id: given.id }), rid()]);
  assert.equal(next.payment_status, 'package');
  await rejects(db, ids.ava, 'select public.pt_coach_book($1::jsonb, $2)', [JSON.stringify({
    service_id: service.id, starts_at: iso(inDays(3), 930), client_id: booked.client_id }), rid()], /SLOT_UNAVAILABLE/);
  await rejects(db, ids.ben, 'select public.pt_coach_book($1::jsonb, $2)', [JSON.stringify({
    service_id: service.id, starts_at: iso(inDays(4), 900), client_id: booked.client_id }), rid()], /SERVICE_NOT_FOUND/);
});

test('time off, roster absences and blackouts close PT times', async () => {
  const { db, staff } = await ptWorld();
  const { service } = await setUpAva(db);
  const date = inDays(6);
  await rpc(db, ids.ava, 'select public.pt_coach_add_time_off($1, $2, $3, $4)', [at(date, 360), at(date, 480), 'Dentist', rid()]);
  let open = await slots(db, service.id, date);
  assert.equal(open[0], iso(date, 480));
  await db.query(`insert into public.staff_absences (staff_id, starts_at, ends_at, kind, status) values ($1, $2, $3, 'planned', 'approved')`, [staff.ava, at(date, 540), at(date, 600)]);
  open = await slots(db, service.id, date);
  assert.ok(!open.includes(iso(date, 540)) && !open.includes(iso(date, 510)));
  await db.query(`insert into public.blackout_periods (start_time, end_time, affects) values ($1, $2, 'pt_only')`, [at(date, 600), at(date, 720)]);
  open = await slots(db, service.id, date);
  assert.deepEqual(open, [iso(date, 480)]);
  await db.query(`insert into public.blackout_periods (start_time, end_time, affects) values ($1, $2, 'group_classes')`, [at(inDays(7), 0), at(inDays(8), 0)]);
  assert.equal((await slots(db, service.id, inDays(7))).length, 11, 'a group-class blackout leaves PT open');
});

test('a published class duty (with its prep time) blocks PT, but a draft roster does not', async () => {
  const { db, staff } = await ptWorld();
  const { service } = await setUpAva(db);
  const date = day(10);
  const session = await addSession(db, date, 540, 60);
  await db.query(`insert into public.staff_session_staffing (session_id, slots, prep_minutes, wrap_minutes) values ($1, $2::jsonb, 30, 0)`,
    [session, JSON.stringify([{ key: 'lead', role: 'lead', required: true, capabilities: [] }])]);
  await rpc(db, ids.ava, 'select public.staff_roster_submit_availability($1, $2::jsonb, $3)', [MONTH_DATE, JSON.stringify({ weekly: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: 0, end: 1440, status: 'AVAILABLE' })), exceptions: [] }), rid()]);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await slots(db, service.id, date)).length, 11, 'a draft assignment is not a commitment yet');
  await publish(db);
  const open = await slots(db, service.id, date);
  for (const gone of [480, 510, 540, 570]) assert.ok(!open.includes(iso(date, gone)), `${gone} clashes with the 8:30 to 10:00 duty`);
  assert.ok(open.includes(iso(date, 450)) && open.includes(iso(date, 600)), 'touching the duty is fine');
});

test('a client can only hold a few upcoming sessions with one coach', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  await db.query('update public.pt_settings set max_upcoming_per_client = 2');
  await book(db, service.id, iso(inDays(3), 360));
  await book(db, service.id, iso(inDays(3), 480));
  await rejects(db, null, 'select public.pt_public_book($1::jsonb, $2)', [JSON.stringify({ service_id: service.id, starts_at: iso(inDays(3), 600), ...details() }), rid()], /TOO_MANY_BOOKINGS/);
  await rejects(db, null, 'select public.pt_public_book($1::jsonb, $2)', [JSON.stringify({ service_id: service.id, starts_at: iso(inDays(3), 600), ...details({ email: 'not-an-email' }) }), rid()], /DETAILS_INVALID/);
});

test('after the session the coach records attendance and payment', async () => {
  const { db } = await ptWorld();
  const { service } = await setUpAva(db);
  const booked = await book(db, service.id, iso(inDays(3), 360));
  await db.query(`update public.pt_bookings set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'`);
  const id = (await db.query('select id from public.pt_bookings')).rows[0].id;
  assert.equal((await rpc(db, ids.ava, 'select public.pt_coach_overview()')).to_mark, 1);
  const done = await rpc(db, ids.ava, 'select public.pt_coach_update_booking($1, $2, null, $3)', [id, 'complete', rid()]);
  assert.equal(done.status, 'completed');
  assert.equal((await rpc(db, ids.ava, 'select public.pt_coach_clients()'))[0].unpaid, 1);
  const paid = await rpc(db, ids.ava, 'select public.pt_coach_update_booking($1, $2, null, $3)', [id, 'mark_paid', rid()]);
  assert.equal(paid.payment_status, 'paid');
  assert.equal((await rpc(db, ids.ava, 'select public.pt_coach_clients()'))[0].completed, 1);
  assert.equal((await rpc(db, null, 'select public.pt_public_booking($1)', [booked.token])).can_cancel, false);
});

test('only managers change PT settings, with a version check', async () => {
  const { db } = await ptWorld({ enabled: false });
  await rejects(db, ids.ava, 'select public.pt_admin_update_settings($1::jsonb, 1)', ['{"enabled":true}'], /MANAGER_ONLY/);
  await rejects(db, ids.owner, 'select public.pt_admin_update_settings($1::jsonb, 99)', ['{"enabled":true}'], /STALE_VERSION/);
  const version = (await db.query('select version from public.pt_settings')).rows[0].version;
  await rejects(db, ids.owner, 'select public.pt_admin_update_settings($1::jsonb, $2)', ['{"slot_step_minutes":7}', version], /SETTINGS_INVALID/);
  const updated = await rpc(db, ids.owner, 'select public.pt_admin_update_settings($1::jsonb, $2)', ['{"enabled":true,"cancel_cutoff_hours":12}', version]);
  assert.equal(updated.enabled, true);
  assert.equal(updated.cancel_cutoff_hours, 12);
  const overview = await rpc(db, ids.owner, 'select public.pt_admin_overview($1, $2)', [inDays(0), inDays(30)]);
  assert.equal(overview.coaches.length, 3);
  await as(db, null);
});
