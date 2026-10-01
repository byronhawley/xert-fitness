import assert from 'node:assert/strict';
import test from 'node:test';

import { migratedDatabase, as } from './helpers/staff-roster-db.mjs';
import { addMonths, gymInstantIso, monthKeyOf, weekdayOf, gymInstant, dateInMonth } from '../src/lib/staffRoster/time.js';
import { expandAvailability } from '../src/lib/staffRoster/availability.js';
import { gymDateKey } from '../src/lib/gymTime.js';

// SYNTHETIC DATA ONLY: fictional coaches, a fictional owner and fictional
// classes. Email notices stay off, so nothing here can message a real person.

const TODAY = gymDateKey(new Date());
const MONTH = addMonths(monthKeyOf(TODAY), 2);
const MONTH_DATE = `${MONTH}-01`;
const NEXT = addMonths(MONTH, 1);
const day = n => dateInMonth(MONTH, n);
const ids = {
  owner: '00000000-0000-4000-8000-000000000001',
  member: '00000000-0000-4000-8000-000000000002',
  ava: '00000000-0000-4000-8000-0000000000a1',
  ben: '00000000-0000-4000-8000-0000000000b1',
  cam: '00000000-0000-4000-8000-0000000000c1',
};
let requestCounter = 0;
const rid = () => `10000000-0000-4000-8000-${String(++requestCounter).padStart(12, '0')}`;

const STUB_CLASS_UPDATE = `
  create function public.admin_update_class_session(p_session_id uuid, p_session jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
  begin
    if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
    update public.class_sessions set start_time = (p_session->>'start_time')::timestamptz, end_time = (p_session->>'end_time')::timestamptz,
      duration_minutes = (p_session->>'duration_minutes')::integer, title = p_session->>'title', updated_at = now() where id = p_session_id;
    return p_session_id;
  end; $$;
`;

async function rpc(db, uid, sql, params = []) {
  await as(db, uid);
  const { rows } = await db.query(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

async function rejects(db, uid, sql, params, pattern) {
  await as(db, uid);
  await assert.rejects(() => db.query(sql, params), error => pattern.test(error.message) || pattern.test(String(error.detail)));
}

async function world({ enabled = true } = {}) {
  const db = await migratedDatabase({ extraSql: STUB_CLASS_UPDATE });
  await db.exec(`
    insert into public.profiles (id, full_name, email, role) values
      ('${ids.owner}', 'Synthetic Owner', 'owner@example.test', 'admin'),
      ('${ids.member}', 'Synthetic Member', 'member@example.test', 'member'),
      ('${ids.ava}', 'Ava Synthetic', 'ava@example.test', 'member'),
      ('${ids.ben}', 'Ben Synthetic', 'ben@example.test', 'member'),
      ('${ids.cam}', 'Cam Synthetic', 'cam@example.test', 'member');
    update public.staff_roster_settings set enabled = ${enabled};
  `);
  const staff = {};
  for (const [key, name, roles] of [['ava', 'Ava', ['lead', 'assistant']], ['ben', 'Ben', ['lead', 'assistant']], ['cam', 'Cam', ['shadow']]]) {
    const row = await rpc(db, ids.owner, 'select public.staff_roster_upsert_staff($1::jsonb, null, $2)', [
      JSON.stringify({ display_name: name, profile_id: ids[key], roles }), rid()]);
    staff[key] = row.id;
  }
  await rpc(db, ids.owner, 'select public.staff_roster_open_period($1, $2, $3, $4, false, $5)', [MONTH_DATE, TODAY, dateInMonth(addMonths(MONTH, -1), 5), dateInMonth(addMonths(MONTH, -1), 10), rid()]);
  return { db, staff };
}

async function addSession(db, date, minute, duration, extra = {}) {
  const { rows } = await db.query(
    `insert into public.class_sessions (start_time, end_time, duration_minutes, title, status, class_type)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [gymInstantIso(date, minute), new Date(gymInstant(date, minute) + duration * 60000).toISOString(), duration,
      extra.title || 'Synthetic class', extra.status || 'published', extra.classType || 'XERT Strength']);
  return rows[0].id;
}

const allWeek = (start, end, status = 'AVAILABLE') => ({ weekly: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start, end, status })), exceptions: [] });

async function submit(db, uid, payload, month = MONTH_DATE) {
  return rpc(db, uid, 'select public.staff_roster_submit_availability($1, $2::jsonb, $3)', [month, JSON.stringify(payload), rid()]);
}

async function draftVersion(db, month = MONTH_DATE) {
  const { rows } = await db.query(`select version from public.staff_roster_revisions where month = $1 and state = 'draft'`, [month]);
  return rows[0]?.version ?? 0;
}

async function apply(db, changes, month = MONTH_DATE) {
  return rpc(db, ids.owner, 'select public.staff_roster_apply_changes($1, $2, $3::jsonb, $4)', [month, await draftVersion(db, month), JSON.stringify(changes), rid()]);
}

async function applyRejects(db, changes, pattern) {
  await rejects(db, ids.owner, 'select public.staff_roster_apply_changes($1, $2, $3::jsonb, $4)', [MONTH_DATE, await draftVersion(db), JSON.stringify(changes), rid()], pattern);
}

async function publish(db, reason = null, requestId = rid(), month = MONTH_DATE) {
  return rpc(db, ids.owner, 'select public.staff_roster_publish($1, $2, $3, $4)', [month, await draftVersion(db, month), reason, requestId]);
}

// ── Scenario 14 / 20: permissions and the feature switch ───────────────────

test('direct table access is revoked; only entry-point functions are executable by signed-in users', async () => {
  const { db } = await world();
  const { rows } = await db.query(`
    select c.relname, has_table_privilege('authenticated', c.oid, 'select') as auth_select, has_table_privilege('anon', c.oid, 'select') as anon_select
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'staff_%' or c.relname = 'class_schedule_series')`);
  assert.ok(rows.length >= 20);
  assert.deepEqual(rows.filter(row => row.auth_select || row.anon_select), []);
  const fns = await db.query(`select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_exec,
      has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'staff_roster%'`);
  assert.deepEqual(fns.rows.filter(row => row.anon_exec).map(row => row.proname), []);
  const internal = fns.rows.filter(row => ['staff_roster_assignment_problems', 'staff_roster_notify', 'staff_roster_lock', 'staff_roster_draft'].includes(row.proname));
  assert.ok(internal.every(row => !row.auth_exec), 'internal helpers are not callable from the API');
});

test('members and non-staff cannot use staff APIs; managers-only functions reject coaches', async () => {
  const { db } = await world();
  await rejects(db, ids.member, 'select public.staff_roster_me()', [], /NOT_STAFF/);
  await rejects(db, ids.member, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE], /MANAGER_ONLY/);
  await rejects(db, ids.ava, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE], /MANAGER_ONLY/);
  await rejects(db, null, 'select public.staff_roster_me()', [], /SIGN_IN_REQUIRED/);
  const me = await rpc(db, ids.ava, 'select public.staff_roster_me()');
  assert.equal(me.staff.display_name, 'Ava');
  assert.equal(me.periods.length, 1, 'no paid membership is needed to reach staff screens');
});

test('feature disabled: coach screens see nothing and session changes send nothing', async () => {
  const { db } = await world({ enabled: false });
  await rejects(db, ids.ava, 'select public.staff_roster_me()', [], /ROSTER_DISABLED/);
  await rejects(db, ids.ava, 'select public.staff_roster_my_roster($1, $2)', [day(1), day(28)], /ROSTER_DISABLED/);
  const session = await addSession(db, day(10), 375, 60);
  await db.query(`update public.class_sessions set status = 'cancelled' where id = $1`, [session]);
  assert.equal((await db.query('select count(*)::int as n from public.staff_notifications')).rows[0].n, 0);
});

test('coaches cannot read another coach’s private absence reasons; cover board hides reasons', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  await submit(db, ids.ben, allWeek(0, 1440));
  const session = await addSession(db, day(10), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  await publish(db);
  await rpc(db, ids.ava, 'select public.staff_roster_request_absence($1, $2, $3, $4, $5)', [gymInstantIso(day(20), 0), gymInstantIso(day(21), 0), 'planned', 'private family matter', rid()]);
  const { rows } = await db.query('select id from public.staff_assignments limit 1');
  await rpc(db, ids.ava, 'select public.staff_roster_request_cover($1, $2, $3)', [rows[0].id, 'private medical appointment', rid()]);
  const benRequests = await rpc(db, ids.ben, 'select public.staff_roster_my_requests()');
  assert.equal(benRequests.absences.length, 0);
  const board = await rpc(db, ids.ben, 'select public.staff_roster_cover_board()');
  assert.equal(board.length, 1);
  assert.equal(JSON.stringify(board).includes('private'), false);
  const benInbox = await rpc(db, ids.ben, 'select public.staff_roster_my_notifications(50)');
  assert.equal(JSON.stringify(benInbox).includes('private'), false);
  const ownerInbox = await rpc(db, ids.owner, 'select public.staff_roster_my_notifications(50)');
  assert.ok(ownerInbox.length >= 2);
  assert.equal(JSON.stringify(ownerInbox).includes('private'), false, 'reasons never appear in notification text');
  const snapshot = await rpc(db, ids.owner, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE]);
  assert.equal(snapshot.absences[0].reason, 'private family matter', 'the manager sees the reason in the workspace');
});

// ── Scenario 3: submissions, versions and save failures ────────────────────

test('drafts autosave without changing effective availability; a failed resubmission keeps the previous version', async () => {
  const { db, staff } = await world();
  const session = await addSession(db, day(10), 375, 60);
  const first = await submit(db, ids.ava, allWeek(300, 480));
  assert.equal(first.version, 1);
  const status = async () => (await db.query('select status from public.staff_roster_availability($1, $2)', [[staff.ava], [session]])).rows[0].status;
  assert.equal(await status(), 'AVAILABLE');
  await rpc(db, ids.ava, 'select public.staff_roster_save_availability_draft($1, $2::jsonb, 0)', [MONTH_DATE, JSON.stringify({ noAvailability: true })]);
  assert.equal(await status(), 'AVAILABLE', 'a draft is not effective');
  await rejects(db, ids.ava, 'select public.staff_roster_save_availability_draft($1, $2::jsonb, 0)', [MONTH_DATE, '{}'], /STALE_VERSION/);
  await rejects(db, ids.ava, 'select public.staff_roster_submit_availability($1, $2::jsonb, $3)', [MONTH_DATE, JSON.stringify({ weekly: [
    { weekday: 1, start: 300, end: 420, status: 'AVAILABLE' }, { weekday: 1, start: 360, end: 480, status: 'UNAVAILABLE' }] }), rid()], /AVAILABILITY_INVALID/);
  assert.equal(await status(), 'AVAILABLE', 'previous submission still effective after a failed submit');
  const none = await submit(db, ids.ava, { noAvailability: true });
  assert.equal(none.version, 2);
  assert.equal(await status(), 'UNAVAILABLE', 'explicit no availability is not the same as silence');
  assert.equal((await db.query('select count(*)::int as n from public.staff_availability_drafts')).rows[0].n, 0, 'submitting clears the draft');
});

test('changing the usual week never alters a submitted snapshot', async () => {
  const { db, staff } = await world();
  const session = await addSession(db, day(10), 375, 60);
  await submit(db, ids.ava, allWeek(300, 480));
  await rpc(db, ids.ava, 'select public.staff_roster_save_usual_week($1::jsonb, 0)', [JSON.stringify([{ weekday: 1, start: 600, end: 700, status: 'PREFERRED' }])]);
  const { rows } = await db.query('select status from public.staff_roster_availability($1, $2)', [[staff.ava], [session]]);
  assert.equal(rows[0].status, 'AVAILABLE');
});

test('after the deadline a coach must ask; a manager reopening allows a late, audited resubmission', async () => {
  const { db } = await world();
  await db.query(`update public.staff_roster_periods set opens_on = $2, due_on = $2, publish_target_on = $2 where month = $1`, [MONTH_DATE, dateInMonth(monthKeyOf(TODAY), 1) < TODAY ? dateInMonth(monthKeyOf(TODAY), 1) : '2026-01-01']);
  await rejects(db, ids.ava, 'select public.staff_roster_submit_availability($1, $2::jsonb, $3)', [MONTH_DATE, JSON.stringify(allWeek(300, 480)), rid()], /DEADLINE_PASSED/);
  await rpc(db, ids.ava, 'select public.staff_roster_request_change($1, $2, $3)', [MONTH_DATE, 'Started a new day job', rid()]);
  const { rows } = await db.query('select id from public.staff_members where display_name = $1', ['Ava']);
  await rpc(db, ids.owner, 'select public.staff_roster_reopen_submission($1, $2, $3, $4)', [MONTH_DATE, rows[0].id, 'Agreed by phone', rid()]);
  const late = await submit(db, ids.ava, allWeek(300, 480));
  assert.equal(late.late, true);
  const audit = await rpc(db, ids.owner, 'select public.staff_roster_audit_log($1, 50)', [MONTH_DATE]);
  assert.ok(audit.some(event => event.action === 'submission_reopened'));
  assert.ok(audit.some(event => event.action === 'availability_submitted' && event.after.late === true));
});

test('the database expands availability exactly like the browser engine', async () => {
  const { db, staff } = await world();
  const payload = {
    weekly: [{ weekday: weekdayOf(day(8)), start: 300, end: 600, status: 'AVAILABLE' }, { weekday: weekdayOf(day(9)), start: 960, end: 1140, status: 'IF_NEEDED' }],
    exceptions: [{ date: day(8), start: 360, end: 420, status: 'UNAVAILABLE' }, { date: day(15), start: 0, end: 1440, status: 'PREFERRED' }],
  };
  await submit(db, ids.ava, payload);
  const { rows } = await db.query(`select lower(during) as s, upper(during) as e, status from public.staff_availability_windows where staff_id = $1 order by lower(during), status`, [staff.ava]);
  const fromDb = rows.map(row => [new Date(row.s).getTime(), new Date(row.e).getTime(), row.status]);
  const fromJs = expandAvailability(payload, MONTH).map(item => [item.start, item.end, item.status]).sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]));
  assert.deepEqual(fromDb, fromJs);
});

// ── Scenario 4 / 6 / 7: the authoritative rules ────────────────────────────

test('UNKNOWN, partial coverage, approved absence and expired capabilities cannot be assigned', async () => {
  const { db, staff } = await world();
  const session = await addSession(db, day(12), 375, 60);
  await applyRejects(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }], /AVAILABILITY_UNKNOWN/);
  await submit(db, ids.ava, allWeek(300, 420));
  await applyRejects(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }], /AVAILABILITY_PARTIAL/);
  await submit(db, ids.ava, allWeek(0, 1440));
  await rpc(db, ids.owner, 'select public.staff_roster_set_staffing($1, $2, $3::jsonb, 0, $4)', ['session', session, JSON.stringify({ slots: [{ key: 'lead', role: 'lead', capabilities: ['first_aid'] }] }), rid()]);
  await rpc(db, ids.owner, 'select public.staff_roster_set_capabilities($1, $2::jsonb, $3)', [staff.ava, JSON.stringify([{ capability: 'first_aid', valid_until: gymInstantIso(day(1), 0) }]), rid()]);
  await applyRejects(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }], /CAPABILITY_EXPIRED:first_aid/);
  await rpc(db, ids.owner, 'select public.staff_roster_set_capabilities($1, $2::jsonb, $3)', [staff.ava, JSON.stringify([{ capability: 'first_aid' }]), rid()]);
  await rpc(db, ids.owner, 'select public.staff_roster_record_absence($1, $2, $3, $4, $5)', [staff.ava, gymInstantIso(day(12), 0), gymInstantIso(day(13), 0), null, rid()]);
  await applyRejects(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }], /ABSENT/);
});

test('multi-coach staffing: one coach cannot hold two positions, a shadow cannot lead', async () => {
  const { db, staff } = await world();
  for (const uid of [ids.ava, ids.ben, ids.cam]) await submit(db, uid, allWeek(0, 1440));
  const session = await addSession(db, day(14), 375, 60);
  await rpc(db, ids.owner, 'select public.staff_roster_set_staffing($1, $2, $3::jsonb, 0, $4)', ['session', session,
    JSON.stringify({ slots: [{ key: 'lead', role: 'lead' }, { key: 'assist', role: 'assistant' }, { key: 'shadow', role: 'shadow', required: true }] }), rid()]);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  await applyRejects(db, [{ op: 'assign', session_id: session, slot_key: 'assist', staff_id: staff.ava }], /SAME_SESSION_DUPLICATE/);
  await applyRejects(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.cam }], /SLOT_TAKEN|ROLE_NOT_AUTHORISED/);
  await applyRejects(db, [{ op: 'assign', session_id: session, slot_key: 'assist', staff_id: staff.cam }], /ROLE_NOT_AUTHORISED/);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'shadow', staff_id: staff.cam }, { op: 'assign', session_id: session, slot_key: 'assist', staff_id: staff.ben }]);
  const gaps = await db.query(`select * from public.staff_roster_gaps((select id from public.staff_roster_revisions where state = 'draft'), $1)`, [MONTH_DATE]);
  assert.equal(gaps.rows.length, 0, 'a shadow position is never required demand');
});

test('overlapping classes and disallowed buffers fail, including across the month boundary', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  await db.query(`insert into public.staff_roster_periods (month, opens_on, due_on, publish_target_on) values ($1, $2, $2, $2)`, [`${NEXT}-01`, TODAY]);
  const lastDay = dateInMonth(MONTH, 31);
  const late = await addSession(db, lastDay, 23 * 60, 90);
  const a = await addSession(db, day(16), 375, 60);
  const b = await addSession(db, day(16), 405, 60);
  const c = await addSession(db, day(16), 435, 60);
  await apply(db, [{ op: 'assign', session_id: a, slot_key: 'lead', staff_id: staff.ava }]);
  await applyRejects(db, [{ op: 'assign', session_id: b, slot_key: 'lead', staff_id: staff.ava }], /CLASS_OVERLAP/);
  await rpc(db, ids.owner, 'select public.staff_roster_set_staffing($1, $2, $3::jsonb, 0, $4)', ['session', c, JSON.stringify({ prep_minutes: 10, allow_block: false }), rid()]);
  await applyRejects(db, [{ op: 'assign', session_id: c, slot_key: 'lead', staff_id: staff.ava }], /DUTY_BUFFER_OVERLAP/);
  await rpc(db, ids.owner, 'select public.staff_roster_set_staffing($1, $2, $3::jsonb, 1, $4)', ['session', c, JSON.stringify({ prep_minutes: 10, allow_block: true }), rid()]);
  await apply(db, [{ op: 'assign', session_id: c, slot_key: 'lead', staff_id: staff.ava }]);
  // 11 pm to 12:30 am crosses into next month: next month's answer is needed too.
  await applyRejects(db, [{ op: 'assign', session_id: late, slot_key: 'lead', staff_id: staff.ava }], /AVAILABILITY_PARTIAL/);
  await submit(db, ids.ava, allWeek(0, 1440), `${NEXT}-01`);
  await apply(db, [{ op: 'assign', session_id: late, slot_key: 'lead', staff_id: staff.ava }]);
  await publish(db, 'Synthetic gaps acknowledged');
  // Next month: a class just after midnight on the 1st overlaps the published 11 pm class.
  const early = await addSession(db, dateInMonth(NEXT, 1), 0, 30);
  await rejects(db, ids.owner, 'select public.staff_roster_apply_changes($1, 0, $2::jsonb, $3)', [`${NEXT}-01`,
    JSON.stringify([{ op: 'assign', session_id: early, slot_key: 'lead', staff_id: staff.ava }]), rid()], /CLASS_OVERLAP/);
});

test('configured hard limits apply in the database too', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  const row = (await db.query('select version from public.staff_members where id = $1', [staff.ava])).rows[0];
  await rpc(db, ids.owner, 'select public.staff_roster_upsert_staff($1::jsonb, $2, $3)', [JSON.stringify({ id: staff.ava, display_name: 'Ava', profile_id: ids.ava, roles: ['lead'], max_duty_minutes_per_day: 90 }), row.version, rid()]);
  const a = await addSession(db, day(18), 315, 60);
  const b = await addSession(db, day(18), 960, 60);
  await apply(db, [{ op: 'assign', session_id: a, slot_key: 'lead', staff_id: staff.ava }]);
  await applyRejects(db, [{ op: 'assign', session_id: b, slot_key: 'lead', staff_id: staff.ava }], /LIMIT_DAILY_DUTY/);
});

// ── Scenario 9 / 10 / 11: revisions, publication, idempotency ──────────────

test('draft v2 never changes published v1; stale edits and stale publishes are rejected', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  await submit(db, ids.ben, allWeek(0, 1440));
  const session = await addSession(db, day(20), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  const v1 = await publish(db);
  assert.equal(v1.ok, true);
  assert.equal(v1.number, 1);
  const draftAssignment = async () => (await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'draft'`)).rows[0]?.id;
  // The first edit creates draft v2 as a copy of v1.
  await apply(db, [{ op: 'pin', assignment_id: (await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'published'`)).rows[0].id }])
    .catch(error => assert.match(error.message, /ASSIGNMENT_NOT_IN_DRAFT/));
  await apply(db, [{ op: 'assign', session_id: await addSession(db, day(21), 375, 60), slot_key: 'lead', staff_id: staff.ben }]);
  await apply(db, [{ op: 'unassign', assignment_id: await draftAssignment() }, { op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ben }]);
  const draftNumber = (await db.query(`select number from public.staff_roster_revisions where state = 'draft'`)).rows[0].number;
  assert.equal(draftNumber, 2);
  const published = await db.query(`select a.staff_id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'published'`);
  assert.deepEqual(published.rows.map(row => row.staff_id), [staff.ava], 'v1 still shows Ava');
  await rejects(db, ids.owner, 'select public.staff_roster_apply_changes($1, $2, $3::jsonb, $4)', [MONTH_DATE, 999, JSON.stringify([{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ben }]), rid()], /STALE_VERSION/);
  await rejects(db, ids.owner, 'select public.staff_roster_publish($1, $2, null, $3)', [MONTH_DATE, 999, rid()], /STALE_VERSION/);
});

test('publishing with gaps needs a reason, and the published revision stays visibly incomplete', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  const covered = await addSession(db, day(21), 375, 60);
  await addSession(db, day(22), 375, 60);
  await apply(db, [{ op: 'assign', session_id: covered, slot_key: 'lead', staff_id: staff.ava }]);
  const blocked = await publish(db);
  assert.deepEqual([blocked.ok, blocked.reason, blocked.gaps], [false, 'GAPS_NEED_ACKNOWLEDGEMENT', 1]);
  assert.equal((await db.query(`select count(*)::int as n from public.staff_roster_revisions where state = 'published'`)).rows[0].n, 0);
  const done = await publish(db, 'Owner will cover the 22nd personally');
  assert.equal(done.gaps, 1);
  const { rows } = await db.query(`select gap_count, gap_reason from public.staff_roster_revisions where state = 'published'`);
  assert.deepEqual(rows[0], { gap_count: 1, gap_reason: 'Owner will cover the 22nd personally' });
});

test('hard conflicts block publication, e.g. a coach whose availability changed after assignment', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(23), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  await submit(db, ids.ava, { noAvailability: true });
  const result = await publish(db);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'HARD_CONFLICTS');
  assert.deepEqual(result.blocked[0].problems, ['AVAILABILITY_UNAVAILABLE']);
});

test('a duplicate publish returns the first result, one mutation and one notice per affected coach', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(24), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  const requestId = rid();
  const version = await draftVersion(db);
  const first = await rpc(db, ids.owner, 'select public.staff_roster_publish($1, $2, null, $3)', [MONTH_DATE, version, requestId]);
  const again = await rpc(db, ids.owner, 'select public.staff_roster_publish($1, $2, null, $3)', [MONTH_DATE, version, requestId]);
  assert.deepEqual(again, first);
  assert.equal((await db.query(`select count(*)::int as n from public.staff_roster_revisions where state in ('published', 'superseded')`)).rows[0].n, 1);
  assert.equal((await db.query(`select count(*)::int as n from public.staff_notifications where kind = 'roster_published'`)).rows[0].n, 1);
  const notice = (await db.query(`select email_status, read_at from public.staff_notifications where kind = 'roster_published'`)).rows[0];
  assert.deepEqual(notice, { email_status: 'not_requested', read_at: null }, 'queued in-app only; not shown as read or emailed');
});

// ── Scenario 16: acknowledgements ──────────────────────────────────────────

test('a new publication resets acknowledgement only for coaches whose lines changed', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  await submit(db, ids.ben, allWeek(0, 1440));
  const s1 = await addSession(db, day(25), 375, 60);
  const s2 = await addSession(db, day(26), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s1, slot_key: 'lead', staff_id: staff.ava }, { op: 'assign', session_id: s2, slot_key: 'lead', staff_id: staff.ben }]);
  const v1 = await publish(db);
  await rpc(db, ids.ava, 'select public.staff_roster_acknowledge($1)', [v1.revision_id]);
  await rpc(db, ids.ben, 'select public.staff_roster_acknowledge($1)', [v1.revision_id]);
  const s3 = await addSession(db, day(27), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s3, slot_key: 'lead', staff_id: staff.ben }]);
  const v2 = await publish(db);
  assert.deepEqual(v2.affected_staff, [staff.ben]);
  const ava = await rpc(db, ids.ava, 'select public.staff_roster_me()');
  const ben = await rpc(db, ids.ben, 'select public.staff_roster_me()');
  assert.equal(ava.pending_acknowledgements.length, 0);
  assert.equal(ben.pending_acknowledgements.length, 1);
  await rpc(db, ids.ben, 'select public.staff_roster_my_notifications(10)');
  const stillPending = await rpc(db, ids.ben, 'select public.staff_roster_me()');
  assert.equal(stillPending.pending_acknowledgements.length, 1, 'opening notices is not acknowledgement');
});

// ── Scenario 5 / 12: session changes, absence, deactivation ────────────────

test('moving a class invalidates its old session confirmation; cancellation notifies and keeps history', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, { weekly: [{ weekday: weekdayOf(day(9)), start: 300, end: 480, status: 'AVAILABLE' }] });
  const session = await addSession(db, day(9), 600, 60);
  const status = async () => (await db.query('select status from public.staff_roster_availability($1, $2)', [[staff.ava], [session]])).rows[0].status;
  assert.equal(await status(), 'UNKNOWN', 'added class outside submitted windows is not assumed');
  await rpc(db, ids.ava, 'select public.staff_roster_confirm_session($1, $2, $3)', [session, 'AVAILABLE', rid()]);
  assert.equal(await status(), 'AVAILABLE');
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  await publish(db);
  await db.query(`update public.class_sessions set start_time = $2, end_time = $3 where id = $1`, [session, gymInstantIso(day(9), 660), gymInstantIso(day(9), 720)]);
  assert.equal(await status(), 'UNKNOWN', 'old confirmation no longer counts after the move');
  const notices = await rpc(db, ids.ava, 'select public.staff_roster_my_notifications(10)');
  assert.ok(notices.some(item => item.kind === 'session_retimed' && /now runs/.test(item.body)));
  const roster = await rpc(db, ids.ava, 'select public.staff_roster_my_roster($1, $2)', [day(1), day(28)]);
  assert.equal(roster.assignments[0].changed_since_publish, true);
  await db.query(`update public.class_sessions set status = 'cancelled' where id = $1`, [session]);
  const after = await rpc(db, ids.ava, 'select public.staff_roster_my_roster($1, $2)', [day(1), day(28)]);
  assert.equal(after.assignments[0].status, 'cancelled', 'current cancellation shows, not the published snapshot');
  const gaps = await db.query(`select * from public.staff_roster_gaps((select id from public.staff_roster_revisions where state = 'published'), $1)`, [MONTH_DATE]);
  assert.equal(gaps.rows.length, 0, 'a cancelled class has no staffing demand');
});

test('urgent absence blocks at once; deactivation blocks future publication without deleting history', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(11), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  await rpc(db, ids.ava, 'select public.staff_roster_request_absence($1, $2, $3, $4, $5)', [gymInstantIso(day(11), 0), gymInstantIso(day(12), 0), 'urgent', null, rid()]);
  const blocked = await publish(db);
  assert.deepEqual(blocked.blocked[0].problems, ['ABSENT']);
  await db.query(`update public.staff_absences set status = 'rejected'`);
  const row = (await db.query('select version from public.staff_members where id = $1', [staff.ava])).rows[0];
  await rpc(db, ids.owner, 'select public.staff_roster_set_staff_status($1, $2, $3, $4, $5)', [staff.ava, 'inactive', row.version, 'Left the gym', rid()]);
  const inactive = await publish(db);
  assert.ok(inactive.blocked[0].problems.includes('STAFF_INACTIVE'));
  await assert.rejects(() => db.query('delete from public.staff_members where id = $1', [staff.ava]), /STAFF_ARCHIVE_INSTEAD/);
});

// ── Scenario 13: cover ─────────────────────────────────────────────────────

test('two volunteers racing for cover produce one approved replacement; superseded requests cannot change a newer roster', async () => {
  const { db, staff } = await world();
  await rpc(db, ids.owner, 'select public.staff_roster_upsert_staff($1::jsonb, null, $2)', [JSON.stringify({ display_name: 'Dee', profile_id: ids.member, roles: ['lead'] }), rid()]);
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(13), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  await publish(db);
  const assignment = (await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'published'`)).rows[0].id;
  const cover = await rpc(db, ids.ava, 'select public.staff_roster_request_cover($1, $2, $3)', [assignment, null, rid()]);
  assert.equal(cover.status, 'open');
  // Ben never submitted for this month: he may still volunteer explicitly.
  await rpc(db, ids.ben, 'select public.staff_roster_offer_cover($1, $2)', [cover.id, rid()]);
  await rpc(db, ids.member, 'select public.staff_roster_offer_cover($1, $2)', [cover.id, rid()]);
  const requestRow = async () => (await db.query('select status, version from public.staff_cover_requests where id = $1', [cover.id])).rows[0];
  assert.equal((await requestRow()).status, 'offered', 'request accepted by volunteers, not yet replaced');
  const stillAva = await db.query(`select a.staff_id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'published'`);
  assert.deepEqual(stillAva.rows.map(item => item.staff_id), [staff.ava], 'an ordinary request does not replace the assignment');
  const offers = (await db.query('select id, staff_id from public.staff_cover_offers where request_id = $1 order by created_at', [cover.id])).rows;
  const version = (await requestRow()).version;
  const approved = await rpc(db, ids.owner, 'select public.staff_roster_approve_cover($1, $2, $3, $4)', [cover.id, offers[0].id, version, rid()]);
  assert.equal(approved.ok, true);
  await rejects(db, ids.owner, 'select public.staff_roster_approve_cover($1, $2, $3, $4)', [cover.id, offers[1].id, version, rid()], /STALE_VERSION|COVER_NOT_AWAITING_APPROVAL/);
  await rejects(db, ids.owner, 'select public.staff_roster_approve_cover($1, $2, $3, $4)', [cover.id, offers[1].id, version + 1, rid()], /COVER_NOT_AWAITING_APPROVAL/);
  const now = await db.query(`select a.staff_id, a.source from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'published'`);
  assert.deepEqual(now.rows, [{ staff_id: offers[0].staff_id, source: 'cover' }]);
  const history = await db.query(`select number, state from public.staff_roster_revisions order by number`);
  assert.deepEqual(history.rows.map(item => item.state), ['superseded', 'published'], 'history kept as revisions');

  // A request made against an older revision is superseded, never applied.
  const newAssignment = (await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'published'`)).rows[0].id;
  const coverUid = offers[0].staff_id === staff.ben ? ids.ben : ids.member;
  const second = await rpc(db, coverUid, 'select public.staff_roster_request_cover($1, $2, $3)', [newAssignment, null, rid()]);
  await rpc(db, ids.ava, 'select public.staff_roster_offer_cover($1, $2)', [second.id, rid()]);
  const s2 = await addSession(db, day(14), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s2, slot_key: 'lead', staff_id: staff.ava }]);
  await publish(db);
  const offer = (await db.query('select id from public.staff_cover_offers where request_id = $1', [second.id])).rows[0].id;
  const v = (await db.query('select version from public.staff_cover_requests where id = $1', [second.id])).rows[0].version;
  const superseded = await rpc(db, ids.owner, 'select public.staff_roster_approve_cover($1, $2, $3, $4)', [second.id, offer, v, rid()]);
  assert.deepEqual(superseded, { ok: false, reason: 'SUPERSEDED' });
});

test('an approved absence still prevents a volunteer’s approval', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(15), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  await publish(db);
  const assignment = (await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'published'`)).rows[0].id;
  const cover = await rpc(db, ids.ava, 'select public.staff_roster_request_cover($1, $2, $3)', [assignment, null, rid()]);
  await rpc(db, ids.ben, 'select public.staff_roster_offer_cover($1, $2)', [cover.id, rid()]);
  await rpc(db, ids.owner, 'select public.staff_roster_record_absence($1, $2, $3, $4, $5)', [staff.ben, gymInstantIso(day(15), 0), gymInstantIso(day(16), 0), null, rid()]);
  const offer = (await db.query('select id from public.staff_cover_offers')).rows[0].id;
  const v = (await db.query('select version from public.staff_cover_requests')).rows[0].version;
  const result = await rpc(db, ids.owner, 'select public.staff_roster_approve_cover($1, $2, $3, $4)', [cover.id, offer, v, rid()]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['ABSENT']);
});

// ── Scenario 1 / 2: presets and schedule generation ────────────────────────

test('a sixth class-time preset is configuration, and series generation is idempotent', async () => {
  const { db } = await world();
  const settings = await rpc(db, ids.owner, 'select public.staff_roster_get_settings()');
  assert.deepEqual(settings.class_time_presets.map(item => item.minute), [315, 375, 570, 990, 1050]);
  const updated = await rpc(db, ids.owner, 'select public.staff_roster_update_settings($1::jsonb, $2)', [JSON.stringify({ class_time_presets: [...settings.class_time_presets, { minute: 1110 }] }), settings.version]);
  assert.equal(updated.class_time_presets.length, 6);
  await rejects(db, ids.owner, 'select public.staff_roster_update_settings($1::jsonb, $2)', [JSON.stringify({ class_time_presets: [{ minute: 315 }, { minute: 315 }] }), updated.version], /PRESETS_INVALID/);
  const series = await rpc(db, ids.owner, 'select public.staff_roster_save_series($1::jsonb, null, $2)', [JSON.stringify({
    class_type: 'XERT Engine', title: 'Synthetic Engine', duration_minutes: 45, capacity: 12, weekdays: [weekdayOf(day(1)), weekdayOf(day(3))],
    start_minute: 1110, effective_from: day(1), effective_until: day(28) }), rid()]);
  const first = await rpc(db, ids.owner, 'select public.staff_roster_generate_series($1, $2, $3, $4)', [series.id, day(1), day(28), rid()]);
  const second = await rpc(db, ids.owner, 'select public.staff_roster_generate_series($1, $2, $3, $4)', [series.id, day(1), day(28), rid()]);
  assert.ok(first.created >= 7);
  assert.deepEqual([second.created, second.existing], [0, first.created]);
  const { rows } = await db.query(`select distinct duration_minutes, capacity, status, extract(hour from start_time at time zone 'Australia/Brisbane')::int as h from public.class_sessions where series_id = $1`, [series.id]);
  assert.deepEqual(rows, [{ duration_minutes: 45, capacity: 12, status: 'draft', h: 18 }], 'duration and capacity come from the schedule, created as drafts');
});

test('“this and future” previews, keeps history and moves only future occurrences', async () => {
  const { db, staff } = await world();
  const series = await rpc(db, ids.owner, 'select public.staff_roster_save_series($1::jsonb, null, $2)', [JSON.stringify({
    class_type: 'XERT Strength', title: 'Synthetic Strength', duration_minutes: 60, capacity: 10, weekdays: [0, 1, 2, 3, 4, 5, 6],
    start_minute: 315, effective_from: day(1), effective_until: day(10) }), rid()]);
  await rpc(db, ids.owner, 'select public.staff_roster_generate_series($1, $2, $3, $4)', [series.id, day(1), day(10), rid()]);
  await submit(db, ids.ava, allWeek(0, 1440));
  const target = (await db.query('select id from public.class_sessions where series_occurrence_date = $1', [day(8)])).rows[0].id;
  await db.query(`update public.class_sessions set status = 'published'`);
  await apply(db, [{ op: 'assign', session_id: target, slot_key: 'lead', staff_id: staff.ava }]);
  const preview = await rpc(db, ids.owner, 'select public.staff_roster_change_series_from($1, $2, $3::jsonb, false, 1, $4)', [series.id, day(6), JSON.stringify({ start_minute: 375 }), rid()]);
  assert.equal(preview.preview.length, 5);
  assert.equal(preview.preview.find(item => item.session_id === target).staff_assignments, 1, 'preview shows affected staffing');
  const applied = await rpc(db, ids.owner, 'select public.staff_roster_change_series_from($1, $2, $3::jsonb, true, 1, $4)', [series.id, day(6), JSON.stringify({ start_minute: 375 }), rid()]);
  assert.deepEqual(applied.failures, []);
  const { rows } = await db.query(`select series_occurrence_date::text as d, extract(hour from start_time at time zone 'Australia/Brisbane')::int * 60 + extract(minute from start_time at time zone 'Australia/Brisbane')::int as m from public.class_sessions order by series_occurrence_date`);
  assert.ok(rows.filter(row => row.d < day(6)).every(row => row.m === 315), 'earlier occurrences untouched');
  assert.ok(rows.filter(row => row.d >= day(6)).every(row => row.m === 375), 'future occurrences moved');
  const again = await rpc(db, ids.owner, 'select public.staff_roster_generate_series($1, $2, $3, $4)', [applied.new_series_id, day(1), day(10), rid()]);
  assert.equal(again.created, 0, 'no duplicates after the split');
});

// ── Reminders ──────────────────────────────────────────────────────────────

test('reminders are deduplicated, daytime, skip submitted coaches and never predate opening', async () => {
  const { db } = await world();
  await submit(db, ids.ben, { noAvailability: true });
  const beforeOpenDay = new Date(gymInstant(TODAY, 8 * 60)).toISOString();
  const atNine = new Date(gymInstant(TODAY, 9 * 60 + 1)).toISOString();
  assert.equal(await rpc(db, ids.owner, 'select public.staff_roster_run_reminders($1)', [beforeOpenDay]), 0, 'nothing before 9 am');
  const first = await rpc(db, ids.owner, 'select public.staff_roster_run_reminders($1)', [atNine]);
  const second = await rpc(db, ids.owner, 'select public.staff_roster_run_reminders($1)', [atNine]);
  assert.equal(first, 2, 'Ava and Cam; Ben explicitly answered');
  assert.equal(second, 0);
});
