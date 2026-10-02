// Coach dashboard data (profile, certificates, class details, session plans,
// hours, notice preferences) against the real migrations in PGlite.
// SYNTHETIC DATA ONLY: fictional coaches, members and classes; email is a
// local stub and push goes nowhere.
import assert from 'node:assert/strict';
import test from 'node:test';

import { addMonths, gymInstantIso, monthKeyOf } from '../src/lib/staffRoster/time.js';
import { gymDateKey } from '../src/lib/gymTime.js';
import { allWeek, apply, ids, publish, rid, rpc, rejects, submit, world } from './helpers/staff-roster-world.mjs';

const BOOKINGS = `
  create table public.session_bookings (id uuid primary key default gen_random_uuid(), user_id uuid not null, class_session_id uuid not null,
    status text not null default 'confirmed', created_at timestamptz not null default now());
  create table public.class_bookings (id uuid primary key default gen_random_uuid(), class_session_id uuid not null, full_name text, email text, phone text,
    status text not null default 'confirmed', guest_visit boolean not null default false, created_at timestamptz not null default now());
  create table public.push_subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid not null,
    device_token text not null, environment text not null, enabled boolean not null default true);
`;
const TODAY = gymDateKey(new Date());
const THIS_MONTH = monthKeyOf(TODAY);

async function addClass(db, isoStart, minutes, extra = {}) {
  const { rows } = await db.query(`insert into public.class_sessions (start_time, end_time, duration_minutes, title, status, capacity)
    values ($1, $2, $3, $4, $5, $6) returning id`, [isoStart, new Date(Date.parse(isoStart) + minutes * 60000).toISOString(), minutes,
    extra.title || 'Synthetic class', extra.status || 'published', extra.capacity || 8]);
  return rows[0].id;
}

/** Ava is published on one class (in two months' time); Ben is not on it. */
async function dashboardWorld() {
  const { db, staff } = await world();
  await db.exec(BOOKINGS);
  const { MONTH, day } = await import('./helpers/staff-roster-world.mjs');
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addClass(db, gymInstantIso(day(10), 375), 60, { title: 'Synthetic Engine', capacity: 6 });
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  return { db, staff, session, MONTH };
}

test('new tables are closed to the API and every new entry point is signed-in only', async () => {
  const { db } = await dashboardWorld();
  const tables = await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('staff_profile_drafts', 'staff_certificates', 'staff_session_notes', 'staff_notice_preferences')
      and (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select') or not c.relrowsecurity)`);
  assert.deepEqual(tables.rows, []);
  const fns = await db.query(`select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
      array_to_string(p.proconfig, ',') as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'staff\\_roster\\_%'`);
  assert.deepEqual(fns.rows.filter(row => row.anon).map(row => row.proname), []);
  const internal = ['staff_roster_on_class', 'staff_roster_short_name', 'staff_roster_profile_json', 'staff_roster_certificate_json',
    'staff_roster_respect_push_preference', 'staff_roster_push_off_closes_pending', 'staff_roster_notify'];
  assert.deepEqual(fns.rows.filter(row => internal.includes(row.proname) && row.auth).map(row => row.proname), [], 'helpers are not callable');
  assert.ok(fns.rows.every(row => /search_path=public/.test(row.config || '')), 'every roster function pins search_path');
});

// ── 1. Profile ──────────────────────────────────────────────────────────────

test('a coach drafts and submits a profile; a manager approves it onto the website profile', async () => {
  const { db, staff } = await dashboardWorld();
  const photo = 'https://example.supabase.co/storage/v1/object/public/site-images/staff-profiles/x/photo.jpg';
  await rejects(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, false, null)', [JSON.stringify({ name: 'Ava', photo_url: 'https://elsewhere.example/p.jpg' })], /PHOTO_INVALID/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, false, null)', [JSON.stringify({ name: 'Ava', social_url: 'javascript:alert(1)' })], /LINK_INVALID/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, true, null)', [JSON.stringify({ bio: 'No name' })], /PROFILE_NAME_REQUIRED/);
  const draft = await rpc(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, false, null)', [JSON.stringify({ name: 'Ava Synthetic', bio: 'Draft bio', photo_url: photo })]);
  assert.equal(draft.draft.status, 'draft');
  assert.equal(draft.public, null);
  await rejects(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, true, $2)', [JSON.stringify({ name: 'Ava Synthetic' }), 99], /STALE_VERSION/);
  const sent = await rpc(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, true, $2)', [JSON.stringify({ name: 'Ava Synthetic', role: 'Head coach', bio: 'Strength and engine.', photo_url: photo }), draft.draft.version]);
  assert.equal(sent.draft.status, 'submitted');
  assert.equal((await db.query('select count(*)::int as n from public.coaches')).rows[0].n, 0, 'nothing reaches the website before approval');
  const managerNotice = await db.query(`select title from public.staff_notifications where kind = 'profile_submitted'`);
  assert.equal(managerNotice.rows.length, 1);

  await rejects(db, ids.ben, 'select public.staff_roster_profile_reviews()', [], /MANAGER_ONLY/);
  await rejects(db, ids.ben, 'select public.staff_roster_review_profile($1, $2, null, $3)', [staff.ava, 'approve', sent.draft.version], /MANAGER_ONLY/);
  const reviews = await rpc(db, ids.owner, 'select public.staff_roster_profile_reviews()');
  assert.equal(reviews.length, 1);
  const approved = await rpc(db, ids.owner, 'select public.staff_roster_review_profile($1, $2, null, $3)', [staff.ava, 'approve', sent.draft.version]);
  assert.equal(approved.draft.status, 'approved');
  assert.deepEqual({ ...approved.public, id: undefined }, { id: undefined, name: 'Ava Synthetic', role: 'Head coach', bio: 'Strength and engine.', experience: null,
    currently_training_for: null, photo_url: photo, social_url: null, published: true });
  const { rows } = await db.query('select coach_id from public.staff_members where id = $1', [staff.ava]);
  assert.equal(rows[0].coach_id, approved.public.id, 'a new website profile is created and linked');
  const coachInbox = await rpc(db, ids.ava, 'select public.staff_roster_my_notifications(50)');
  assert.ok(coachInbox.some(item => item.title === 'Your coach profile is approved'));

  // A hidden website profile stays hidden after the next approval.
  await db.query('update public.coaches set published = false');
  const again = await rpc(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, true, $2)', [JSON.stringify({ name: 'Ava S.', bio: 'New bio' }), approved.draft.version]);
  const returned = await rpc(db, ids.owner, 'select public.staff_roster_review_profile($1, $2, $3, $4)', [staff.ava, 'reject', 'Please add a photo', again.draft.version]);
  assert.equal(returned.draft.status, 'rejected');
  assert.equal(returned.draft.review_note, 'Please add a photo');
  assert.equal(returned.public.bio, 'Strength and engine.', 'a returned draft changes nothing public');
  const third = await rpc(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, true, $2)', [JSON.stringify({ name: 'Ava S.', bio: 'New bio', photo_url: photo }), returned.draft.version]);
  const done = await rpc(db, ids.owner, 'select public.staff_roster_review_profile($1, $2, null, $3)', [staff.ava, 'approve', third.draft.version]);
  assert.equal(done.public.published, false);
  assert.equal(done.public.bio, 'New bio');
});

test('a coach only ever reaches their own profile', async () => {
  const { db } = await dashboardWorld();
  await rpc(db, ids.ava, 'select public.staff_roster_save_profile($1::jsonb, false, null)', [JSON.stringify({ name: 'Ava private draft' })]);
  const ben = await rpc(db, ids.ben, 'select public.staff_roster_my_profile()');
  assert.equal(ben.draft, null);
  assert.equal(JSON.stringify(ben).includes('Ava private draft'), false);
  await rejects(db, ids.member, 'select public.staff_roster_my_profile()', [], /NOT_STAFF/);
  await rejects(db, null, 'select public.staff_roster_my_profile()', [], /SIGN_IN_REQUIRED/);
});

// ── 2. Certificates ─────────────────────────────────────────────────────────

test('certificates: own only, files only in your own folder, managers see all and who has none', async () => {
  const { db, staff } = await dashboardWorld();
  const cert = await rpc(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({
    kind: 'first_aid', title: 'HLTAID011', number: 'SYN-1', issued_on: '2026-01-01', expires_on: '2029-01-01', file_path: `${ids.ava}/first-aid.pdf` })]);
  assert.equal(cert.state, 'current');
  await rejects(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ kind: 'cpr', file_path: `${ids.ben}/stolen.pdf` })], /FILE_INVALID/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ kind: 'cpr', file_path: `${ids.ava}/../x.pdf` })], /CERTIFICATE_INVALID/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ kind: 'juggling' })], /CERTIFICATE_INVALID/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ title: 'No kind' })], /CERTIFICATE_INVALID/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ kind: 'cpr', expires_on: 'soon' })], /CERTIFICATE_INVALID/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ kind: 'cpr', issued_on: '2026-05-01', expires_on: '2026-01-01' })], /CERTIFICATE_INVALID/);
  // Ben cannot see, edit or remove Ava's certificate.
  assert.deepEqual(await rpc(db, ids.ben, 'select public.staff_roster_my_certificates()'), []);
  await rejects(db, ids.ben, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ id: cert.id, kind: 'cpr' })], /CERTIFICATE_NOT_FOUND/);
  await rejects(db, ids.ben, 'select public.staff_roster_remove_certificate($1)', [cert.id], /CERTIFICATE_NOT_FOUND/);
  await rejects(db, ids.ben, 'select public.staff_roster_certificates_overview()', [], /MANAGER_ONLY/);
  const overview = await rpc(db, ids.owner, 'select public.staff_roster_certificates_overview()');
  assert.deepEqual(overview.certificates.map(item => [item.display_name, item.kind]), [['Ava', 'first_aid']]);
  assert.deepEqual(overview.missing_first_aid.map(item => item.display_name).sort(), ['Ben', 'Cam']);
  assert.equal(staff.ava.length, 36);
  const removed = await rpc(db, ids.ava, 'select public.staff_roster_remove_certificate($1)', [cert.id]);
  assert.equal(removed.file_path, `${ids.ava}/first-aid.pdf`, 'the screen is told which file to delete');
  assert.deepEqual(await rpc(db, ids.ava, 'select public.staff_roster_my_certificates()'), []);
});

test('expiry reminders at 60/30/7/0 days reach the coach once per step, with one manager summary a day', async () => {
  const { db } = await dashboardWorld();
  const now = new Date();
  const inDays = days => gymDateKey(new Date(now.getTime() + days * 86400000));
  for (const [kind, days] of [['first_aid', 45], ['cpr', 5], ['coaching', -3], ['other', 200]]) {
    await rpc(db, ids.ava, 'select public.staff_roster_save_certificate($1::jsonb)', [JSON.stringify({ kind, expires_on: inDays(days) })]);
  }
  await rejects(db, ids.ava, 'select public.staff_roster_run_certificate_reminders()', [], /MANAGER_ONLY/);
  const late = new Date(`${gymDateKey(now)}T23:00:00+10:00`).toISOString();
  const queued = await rpc(db, ids.owner, 'select public.staff_roster_run_certificate_reminders($1)', [late]);
  assert.equal(queued, 4, 'three coach notices (45, 5 and -3 days) and one manager summary');
  const keys = (await db.query(`select dedupe_key, title from public.staff_notifications where kind like 'certificate%' order by dedupe_key`)).rows;
  assert.deepEqual(keys.map(row => row.dedupe_key.split(':').at(-1)).filter(step => /^\d+$/.test(step)).sort(), ['0', '60', '7']);
  assert.ok(keys.some(row => /has expired/.test(row.title)));
  assert.ok(keys.some(row => /expires in 5 days/.test(row.title)));
  assert.equal(await rpc(db, ids.owner, 'select public.staff_roster_run_certificate_reminders($1)', [late]), 0, 'running again sends nothing new: coach steps and the daily summary are deduplicated');
  assert.equal((await db.query(`select count(*)::int as n from public.staff_notifications where kind like 'certificate%'`)).rows[0].n, 4);
  await db.query('update public.staff_roster_settings set enabled = false');
  assert.equal(await rpc(db, ids.owner, 'select public.staff_roster_run_certificate_reminders($1)', [late]), 0, 'nothing while the roster is off');
});

// ── 3 + 4. Class details and session plans ──────────────────────────────────

test('only coaches on a published class see who is booked: short names, counts, no contact details', async () => {
  const { db, session } = await dashboardWorld();
  await db.query(`insert into public.session_bookings (user_id, class_session_id, status) values ($1, $3, 'confirmed'), ($2, $3, 'requested')`, [ids.member, ids.cam, session]);
  await db.query(`insert into public.session_bookings (user_id, class_session_id, status) values ($1, $2, 'waitlisted'), ($1, $2, 'cancelled')`, [ids.ben, session]);
  await db.query(`insert into public.class_bookings (class_session_id, full_name, email, phone, status, guest_visit) values
    ($1, 'Pat Visitor', 'pat@example.test', '0400000000', 'confirmed', true), ($1, 'Wait Listed', 'w@example.test', null, 'waitlisted', false)`, [session]);
  const detail = await rpc(db, ids.ava, 'select public.staff_roster_class_detail($1)', [session]);
  assert.deepEqual([detail.capacity, detail.booked, detail.pending, detail.waitlist], [6, 2, 1, 2]);
  assert.deepEqual(detail.people.map(item => item.name).sort(), ['Cam S.', 'Pat V.', 'Synthetic M.']);
  assert.equal(detail.people.find(item => item.name === 'Pat V.').guest, true);
  const text = JSON.stringify(detail);
  for (const secret of ['example.test', '0400000000', 'Synthetic Member', ids.member]) assert.equal(text.includes(secret), false, `no ${secret}`);
  await rejects(db, ids.ben, 'select public.staff_roster_class_detail($1)', [session], /NOT_ON_CLASS/);
  await rejects(db, ids.member, 'select public.staff_roster_class_detail($1)', [session], /NOT_STAFF/);
  await rejects(db, null, 'select public.staff_roster_class_detail($1)', [session], /SIGN_IN_REQUIRED/);
  assert.equal((await rpc(db, ids.owner, 'select public.staff_roster_class_detail($1)', [session])).booked, 2, 'managers see it too');
});

test('a draft-only assignment does not open a class to a coach', async () => {
  const { db, staff } = await dashboardWorld();
  const { day } = await import('./helpers/staff-roster-world.mjs');
  const other = await addClass(db, gymInstantIso(day(12), 570), 60);
  await apply(db, [{ op: 'assign', session_id: other, slot_key: 'lead', staff_id: staff.ava }]);
  await rejects(db, ids.ava, 'select public.staff_roster_class_detail($1)', [other], /NOT_ON_CLASS/);
});

test('session plans: written by coaches on the class, seen by them and managers, history kept, no silent overwrite', async () => {
  const { db, session } = await dashboardWorld();
  await rejects(db, ids.ben, 'select public.staff_roster_save_session_note($1, $2, null)', [session, 'Ben was not here'], /NOT_ON_CLASS/);
  const first = await rpc(db, ids.ava, 'select public.staff_roster_save_session_note($1, $2, null)', [session, 'Warm-up: rower 5 min']);
  assert.equal(first.note.body, 'Warm-up: rower 5 min');
  assert.equal(first.note.by, 'Ava');
  await rejects(db, ids.ava, 'select public.staff_roster_save_session_note($1, $2, null)', [session, 'stale'], /STALE_VERSION/);
  const second = await rpc(db, ids.owner, 'select public.staff_roster_save_session_note($1, $2, $3)', [session, 'Warm-up: bike 5 min', first.note.id]);
  assert.equal(second.note.by, 'Synthetic Owner');
  assert.deepEqual(second.note_history.map(item => item.body), ['Warm-up: rower 5 min']);
  await rejects(db, ids.ben, 'select public.staff_roster_class_detail($1)', [session], /NOT_ON_CLASS/);
  await rejects(db, ids.ava, 'select public.staff_roster_save_session_note($1, $2, $3)', [session, 'x'.repeat(4001), second.note.id], /NOTE_TOO_LONG/);
});

// ── 5. Hours ────────────────────────────────────────────────────────────────

test('hours this and last month come from the published roster and skip cancelled classes', async () => {
  const { db, staff } = await world();
  await db.exec(BOOKINGS);
  await db.query(`update public.staff_class_type_staffing set prep_minutes = 0`).catch(() => {});
  const monthDate = `${THIS_MONTH}-01`;
  const lastMonth = addMonths(THIS_MONTH, -1);
  // Publish this month and last month directly (opening periods in the past is refused by design).
  const past = await addClass(db, new Date(Date.now() - 2 * 86400000).toISOString(), 60);
  const future = await addClass(db, new Date(Date.now() + 2 * 86400000).toISOString(), 45);
  const cancelled = await addClass(db, new Date(Date.now() + 3 * 86400000).toISOString(), 60, { status: 'cancelled' });
  const monthOf = async id => (await db.query(`select public.staff_roster_month_of(start_time)::text as m from public.class_sessions where id = $1`, [id])).rows[0].m;
  for (const id of [past, future, cancelled]) {
    const month = await monthOf(id);
    let { rows: [revision] } = await db.query(`select id from public.staff_roster_revisions where month = $1 and state = 'published'`, [month]);
    if (!revision) ({ rows: [revision] } = await db.query(`insert into public.staff_roster_revisions (month, state, number) values ($1, 'published', 1) returning id`, [month]));
    await db.query(`insert into public.staff_assignments (revision_id, session_id, slot_key, role, staff_id, session_start, session_end, session_status)
      select $1, s.id, 'lead', 'lead', $2, s.start_time, s.end_time, s.status from public.class_sessions s where s.id = $3`, [revision.id, staff.ava, id]);
  }
  const hours = await rpc(db, ids.ava, 'select public.staff_roster_my_hours()');
  assert.deepEqual(hours.map(row => row.month), [monthDate, `${lastMonth}-01`]);
  const total = hours.reduce((sum, row) => ({ classes: sum.classes + row.classes, minutes: sum.minutes + row.class_minutes, done: sum.done + row.done_classes }), { classes: 0, minutes: 0, done: 0 });
  assert.deepEqual(total, { classes: 2, minutes: 105, done: 1 }, 'cancelled classes never count');
  assert.deepEqual(await rpc(db, ids.ben, 'select public.staff_roster_my_hours()'), [
    { month: monthDate, classes: 0, class_minutes: 0, duty_minutes: 0, done_classes: 0, done_duty_minutes: 0 },
    { month: `${lastMonth}-01`, classes: 0, class_minutes: 0, duty_minutes: 0, done_classes: 0, done_duty_minutes: 0 }]);
  const dashboard = await rpc(db, ids.ava, 'select public.staff_roster_my_dashboard()');
  assert.equal(dashboard.hours.length, 2);
  assert.equal(dashboard.certificates.count, 0);
  assert.equal(dashboard.profile.on_website, false);
});

// ── 6. Notice preferences ───────────────────────────────────────────────────

test('notice preferences: email off skips email, push off records push as skipped, in-app always arrives', async () => {
  const { db, staff } = await dashboardWorld();
  await db.exec(`
    create table public.synthetic_outbox (recipient text, subject text);
    create function public.queue_email(p_type text, p_to text, p_subject text, p_html text, p_text text default null,
      p_related_table text default null, p_related_id text default null, p_attachments jsonb default null)
    returns uuid language plpgsql security definer set search_path = public as $$
    begin insert into public.synthetic_outbox values (p_to, p_subject); return gen_random_uuid(); end; $$;
    update public.staff_roster_settings set email_notices_enabled = true;`);
  await db.query(`insert into public.push_subscriptions (user_id, device_token, environment) values ($1, $2, 'production'), ($3, $4, 'production')`,
    [ids.ava, 'a'.repeat(64), ids.ben, 'b'.repeat(64)]);
  const defaults = await rpc(db, ids.ava, 'select public.staff_roster_my_notice_preferences()');
  assert.deepEqual([defaults.in_app, defaults.email, defaults.push, defaults.email_available], [true, true, true, true]);
  await rejects(db, ids.ava, 'select public.staff_roster_set_notice_preferences(null, true)', [], /PREFERENCES_INVALID/);
  await rejects(db, ids.member, 'select public.staff_roster_set_notice_preferences(false, false)', [], /NOT_STAFF/);
  const saved = await rpc(db, ids.ava, 'select public.staff_roster_set_notice_preferences(false, false)');
  assert.deepEqual([saved.email, saved.push], [false, false]);
  for (const profile of [ids.ava, ids.ben]) {
    await db.query(`select public.staff_roster_notify($1, 'synthetic_notice', $2, 'Synthetic title', 'Synthetic body', '/coaching?tab=roster', null)`, [profile, `synthetic:${profile}`]);
  }
  const notices = (await db.query(`select recipient_profile_id as who, email_status from public.staff_notifications where kind = 'synthetic_notice' order by who`)).rows;
  assert.deepEqual(notices.map(row => [row.who === ids.ava ? 'ava' : 'ben', row.email_status]).sort(), [['ava', 'skipped'], ['ben', 'queued']], 'both get the in-app notice');
  assert.deepEqual((await db.query('select recipient from public.synthetic_outbox')).rows, [{ recipient: 'ben@example.test' }]);
  const pushes = (await db.query(`select d.recipient_profile_id as who, d.status, d.reason from public.staff_notification_push_deliveries d
    join public.staff_notifications n on n.id = d.notification_id where n.kind = 'synthetic_notice'`)).rows;
  assert.deepEqual(pushes.map(row => [row.who === ids.ava ? 'ava' : 'ben', row.status, row.reason]).sort(),
    [['ava', 'skipped', 'PUSH_OFF_BY_RECIPIENT'], ['ben', 'pending', null]]);
  // Switching push off later also closes work already waiting for that coach.
  await rpc(db, ids.ben, 'select public.staff_roster_set_notice_preferences(true, false)');
  const after = (await db.query(`select d.status, d.reason from public.staff_notification_push_deliveries d
    join public.staff_notifications n on n.id = d.notification_id where n.kind = 'synthetic_notice' and n.recipient_profile_id = $1`, [ids.ben])).rows;
  assert.deepEqual(after, [{ status: 'skipped', reason: 'PUSH_OFF_BY_RECIPIENT' }]);
  assert.equal(staff.ava.length, 36);
});

test('storage policies ask a signed-in-only helper whether the caller is an active coach', async () => {
  const { db } = await dashboardWorld();
  assert.equal(await rpc(db, ids.ava, 'select public.staff_roster_is_active_staff()'), true);
  assert.equal(await rpc(db, ids.member, 'select public.staff_roster_is_active_staff()'), false);
  assert.equal(await rpc(db, ids.owner, 'select public.staff_roster_is_active_staff()'), false);
  const grants = (await db.query(`select has_function_privilege('anon', 'public.staff_roster_is_active_staff()', 'execute') as anon,
    has_function_privilege('authenticated', 'public.staff_roster_is_active_staff()', 'execute') as auth,
    has_function_privilege('authenticated', 'public.staff_roster_push_off_closes_pending()', 'execute') as trigger_fn`)).rows[0];
  assert.deepEqual(grants, { anon: false, auth: true, trigger_fn: false });
});
