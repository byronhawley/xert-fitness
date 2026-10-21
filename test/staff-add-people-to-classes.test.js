import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createStaffRosterClient, rosterError } from '../src/lib/staffRosterData.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const MIGRATION = '../supabase/migrations/20261021010000_staff_add_people_to_classes.sql';

function fnBody(sql, name) {
  const start = sql.toLowerCase().indexOf(`function public.${name}(`);
  assert.ok(start >= 0, `${name} is missing`);
  // Bodies written here use $$; ones copied from the live database use $function$.
  const quote = sql.slice(start).match(/\bas (\$[a-z]*\$)/i)[1];
  const open = sql.indexOf(quote, start);
  return sql.slice(start, sql.indexOf(quote, open + quote.length));
}

test('who may add people: admins, active lead coaches, and staff an admin has ticked', async () => {
  const sql = await read(MIGRATION);
  const rule = fnBody(sql, 'staff_can_book_members');
  assert.match(rule, /public\.is_admin\(\) or exists/);
  assert.match(rule, /s\.status = 'active'/);
  assert.match(rule, /'lead' = any\(s\.roles\) or s\.can_book_members/);
  assert.match(sql, /add column if not exists can_book_members boolean not null default false/);
  // Only a manager can tick it, so nobody can let themselves in.
  assert.match(fnBody(sql, 'staff_roster_set_can_book_members'), /perform public\.staff_roster_require_manager\(\)/);
});

test('every entry point checks the rule before doing anything', async () => {
  const sql = await read(MIGRATION);
  for (const name of ['staff_roster_upcoming_classes', 'staff_roster_search_members', 'staff_roster_book_member', 'staff_roster_add_walk_in']) {
    const body = fnBody(sql, name);
    const begin = body.indexOf('\nbegin');
    assert.ok(begin >= 0, name);
    assert.match(body.slice(begin, begin + 80), /perform public\.staff_roster_require_booker\(\);/, `${name} must check first`);
  }
  // None of it is reachable signed out.
  assert.match(sql, /has_function_privilege\('anon', 'public\.staff_roster_add_walk_in/);
});

test('a coach books a member through exactly the path an admin uses', async () => {
  const body = fnBody(await read(MIGRATION), 'staff_roster_book_member');
  assert.match(body, /staff_book_member_core\(p_session_id, p_member_id, p_request_id, auth\.uid\(\)\)/);
  // The identity guard lets this through only while this call is running.
  assert.match(body, /set_config\('xert\.staff_booking', 'on', true\)[\s\S]*staff_book_member_core[\s\S]*set_config\('xert\.staff_booking', '', true\)/);
});

test('the booking guard still keeps members to their own bookings', async () => {
  const guard = fnBody(await read(MIGRATION), 'enforce_member_booking_switch');
  // The new way through needs both the marker and somebody allowed to book.
  assert.match(guard, /current_setting\('xert\.staff_booking', true\) = 'on'\s+and public\.staff_can_book_members\(\)/);
  // And everything that was there is still there, in the same order.
  const admin = guard.indexOf("auth.role() = 'service_role'");
  const staff = guard.indexOf("current_setting('xert.staff_booking'");
  const mismatch = guard.indexOf("raise exception 'BOOKING_ACCOUNT_MISMATCH'");
  const paused = guard.indexOf("raise exception 'BOOKINGS_PAUSED'");
  assert.ok(admin >= 0 && admin < staff && staff < mismatch && mismatch < paused);
});

test('coaches see a name and a partly hidden email, never a phone number', async () => {
  const search = fnBody(await read(MIGRATION), 'staff_roster_search_members');
  assert.match(search, /jsonb_build_object\('id', m\.id, 'full_name', m\.full_name, 'email_hint', m\.email_hint\)/);
  assert.doesNotMatch(search, /'phone'/);
  assert.match(search, /p\.role = 'member'/);
  // A search term is matched as text, so "%" or "_" cannot widen it.
  assert.match(search, /replace\(replace\(replace\(v_term/);
});

test('a walk-in is checked, de-duplicated and placed by the class’s own capacity', async () => {
  const body = fnBody(await read(MIGRATION), 'staff_roster_add_walk_in');
  assert.match(body, /raise exception 'WALK_IN_NAME_INVALID'/);
  assert.match(body, /raise exception 'WALK_IN_EMAIL_INVALID'/);
  assert.match(body, /raise exception 'ALREADY_ON_CLASS'/);
  assert.match(body, /pg_advisory_xact_lock\(hashtextextended\('class_walk_in:'/);
  assert.match(body, /staff_roster_bookable_session\(p_session_id\)/);
  assert.match(body, /class_places_held\(p_session_id\)/);
  assert.match(body, /then 'waitlisted'\s+else 'confirmed'/);
  assert.match(body, /'Added at the desk by '/);
});

test('the client calls the new entry points with the database’s parameter names', async () => {
  const calls = [];
  const client = createStaffRosterClient(async (name, params) => {
    calls.push({ name, params });
    return { data: name === 'staff_roster_book_member' ? [{ booking_status: 'confirmed' }] : [], error: null };
  });
  await client.upcomingClasses();
  assert.deepEqual(await client.searchMembers('a'), [], 'one letter does not search');
  await client.searchMembers('  jo  ');
  const receipt = await client.bookMember('s1', 'm1', 'r1');
  await client.addWalkIn('s1', { fullName: 'Pat Walker', phone: '', email: 'pat@example.com' });
  await client.setCanBookMembers('staff-1', 1);
  assert.deepEqual(receipt, { booking_status: 'confirmed' });
  assert.deepEqual(calls.map(call => [call.name, call.params]), [
    ['staff_roster_upcoming_classes', { p_days: 14 }],
    ['staff_roster_search_members', { p_search: 'jo', p_limit: 12 }],
    ['staff_roster_book_member', { p_session_id: 's1', p_member_id: 'm1', p_request_id: 'r1' }],
    ['staff_roster_add_walk_in', { p_session_id: 's1', p_full_name: 'Pat Walker', p_phone: null, p_email: 'pat@example.com' }],
    ['staff_roster_set_can_book_members', { p_staff_id: 'staff-1', p_allowed: true }],
  ]);
});

test('refusals read as sentences, not database codes', () => {
  for (const code of ['NOT_ALLOWED_TO_BOOK', 'MEMBER_ALREADY_ON_ROSTER', 'ALREADY_ON_CLASS', 'SESSION_FINISHED', 'WALK_IN_NAME_INVALID', 'BOOKING_TIME_CONFLICT']) {
    const error = rosterError({ message: code });
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /[A-Z]{3,}_[A-Z]/, `${code} should be worded`);
  }
});

test('the coach screen appears only for people the database lets in', async () => {
  const page = await read('../src/pages/Coaching.jsx');
  assert.match(page, /\{ key: 'add', label: 'Add to a class', when: 'booker' \}/);
  assert.match(page, /const canBook = me\?\.staff\?\.can_book_members === true;/);
  assert.match(page, /\{tab === 'add' && canBook && <CoachAddToClass/);
  const sql = await read(MIGRATION);
  assert.match(sql, /'can_book_members', public\.staff_can_book_members\(\)\)/, 'the coach summary says so');
});

test('admins tick the permission on the coach profile, and can add walk-ins too', async () => {
  const panel = await read('../src/components/admin/staffRoster/CoachesPanel.jsx');
  assert.match(panel, /checked=\{form\.roles\.includes\('lead'\) \|\| canBook\} disabled=\{form\.roles\.includes\('lead'\)\}/);
  assert.match(panel, /client\.setCanBookMembers\(saved\.id, canBook\)/);
  assert.match(await read(MIGRATION), /'can_book_members', m\.can_book_members,/, 'the staff list carries it');
  const calendar = await read('../src/components/admin/ClassCalendarAdmin.jsx');
  assert.match(calendar, /Not registered\? Add a walk-in/);
  assert.match(calendar, /await staffAddWalkIn\(session\.id, walkIn\)/);
  assert.doesNotMatch(calendar, /Members must have an account before they can be booked in/);
});
