// Part-month roster periods (20261002040000_staff_roster_part_month.sql)
// against the real migrations in PGlite. SYNTHETIC DATA ONLY: fictional
// coaches and classes; email notices stay off.
//
// MONTH is two months ahead, so every class here is still in the future and
// the tests do not depend on the day they run: opening a part-month period is
// not limited to a month that has started.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { BASE_SCHEMA, MIGRATION_URLS } from './helpers/staff-roster-db.mjs';
import {
  MONTH, MONTH_DATE, NEXT, TODAY, addSession, allWeek, apply, applyRejects, day, draftVersion, ids, publish, rejects, rid, rpc, submit, world,
} from './helpers/staff-roster-world.mjs';
import { checkAssignment } from '../src/lib/staffRoster/validate.js';
import { planningContext } from '../src/lib/staffRoster/snapshot.js';
import { addDays, dateInMonth, gymInstantIso, monthKeyOf } from '../src/lib/staffRoster/time.js';

const PART_MONTH_URL = MIGRATION_URLS.find(url => url.pathname.endsWith('20261002040000_staff_roster_part_month.sql'));
const PART_MONTH = await readFile(PART_MONTH_URL, 'utf8');
const FIRST = await readFile(MIGRATION_URLS[0], 'utf8');
// Every other migration after the first (later ones too), PT booking included (it is not part of the roster harness).
const LATER = await Promise.all([...MIGRATION_URLS.slice(1).filter(url => url !== PART_MONTH_URL), new URL('../supabase/migrations/20261002030000_pt_booking.sql', import.meta.url)]
  .map(url => readFile(url, 'utf8')));

const START = day(15);
const OPEN = 'select public.staff_roster_open_part_month($1, $2, $3, $4, $5)';
const open = (db, { month = MONTH_DATE, startsOn = START, dueOn = TODAY, publishTargetOn = addDays(START, -1), requestId = rid(), uid = ids.owner } = {}) =>
  rpc(db, uid, OPEN, [month, startsOn, dueOn, publishTargetOn, requestId]);
const openRejects = (db, values, pattern, uid = ids.owner) => rejects(db, uid, OPEN,
  [values.month ?? MONTH_DATE, values.startsOn === undefined ? START : values.startsOn, values.dueOn ?? TODAY, values.publishTargetOn ?? addDays(START, -1), rid()], pattern);
const statements = sql => sql.replace(/--[^\n]*/g, '').split(/;\s*\n/).map(part => part.trim()).filter(Boolean);
const period = async db => (await db.query('select to_jsonb(p) as row from public.staff_roster_periods p where month = $1', [MONTH_DATE])).rows[0]?.row;

test('the migration starts with a scoped lock timeout and records its capability last', () => {
  const parts = statements(PART_MONTH);
  assert.equal(parts[0], "set local lock_timeout = '5s'");
  assert.match(parts.at(-1), /^insert into public\.xert_schema_capabilities \(capability\) values \('staff_roster_part_month'\) on conflict \(capability\) do nothing;?$/);
  assert.equal(PART_MONTH.match(/xert_schema_capabilities/g).length, 1);
  for (const fn of PART_MONTH.matchAll(/create or replace function public\.(\w+)[\s\S]*?\$\$;/g)) {
    assert.match(fn[0], /set search_path = public/, `${fn[1]} pins its search_path`);
  }
  assert.doesNotMatch(PART_MONTH, /\bdrop\s+(?:table|function)\b/i, 'nothing is dropped but the two checks it re-adds');
});

// The four replaced functions must stay copies of their source definitions
// plus the marked lines, so a later fix to the source is not silently lost.
test('drift guard: each replaced function is its source definition plus only the lines marked part-month', () => {
  const definition = (sql, name) => {
    const found = [...sql.matchAll(new RegExp(`^create or replace function public\\.${name}\\([\\s\\S]*?^\\$\\$;$`, 'gm'))].map(match => match[0]);
    return found;
  };
  for (const name of ['staff_roster_gaps', 'staff_roster_month_classes', 'staff_roster_assignment_problems', 'staff_roster_me']) {
    for (const later of LATER) assert.deepEqual(definition(later, name), [], `${name} is not replaced by a later applied migration`);
    const [source, ...extraSource] = definition(FIRST, name);
    const [copy, ...extraCopy] = definition(PART_MONTH, name);
    assert.ok(source && copy && !extraSource.length && !extraCopy.length, `${name} is defined once in each file`);
    const added = copy.split('\n').filter(line => line.includes('-- part-month'));
    assert.ok(added.length >= 1 && added.length <= 3, `${name} adds one predicate`);
    assert.equal(copy.split('\n').filter(line => !line.includes('-- part-month')).join('\n'), source, `${name} is otherwise verbatim`);
  }
});

test('opening a part-month period: from today, shortened, audited, replayable; a second open is refused', async () => {
  const { db } = await world({ openPeriod: false });
  const requestId = rid();
  const row = await open(db, { dueOn: day(10), publishTargetOn: day(12), requestId });
  assert.deepEqual([row.month, row.starts_on, row.opens_on, row.due_on, row.publish_target_on, row.shortened],
    [MONTH_DATE, START, TODAY, day(10), day(12), true]);
  assert.deepEqual(await open(db, { dueOn: day(10), publishTargetOn: day(12), requestId }), row, 'a retried tap returns the first result');
  const audit = await db.query(`select action, after->>'starts_on' as starts_on from public.staff_roster_audit_events where action = 'period_opened' and month = $1`, [MONTH_DATE]);
  assert.deepEqual(audit.rows, [{ action: 'period_opened', starts_on: START }]);
  await openRejects(db, {}, /PERIOD_EXISTS/);
  await rejects(db, ids.owner, 'select public.staff_roster_open_period($1, $2, $3, $4, false, $5)', [MONTH_DATE, TODAY, TODAY, TODAY, rid()], /PERIOD_EXISTS/);
  const snap = await rpc(db, ids.owner, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE]);
  assert.equal(snap.period.starts_on, START, 'the manager snapshot carries the start day');
});

test('each invalid input is refused, and nothing is written', async () => {
  const { db } = await world({ openPeriod: false });
  const thisMonth = `${monthKeyOf(TODAY)}-01`;
  await openRejects(db, { startsOn: MONTH_DATE }, /STARTS_ON_INVALID/);
  await openRejects(db, { startsOn: `${NEXT}-02` }, /STARTS_ON_INVALID/);
  await openRejects(db, { startsOn: null }, /STARTS_ON_INVALID/);
  await openRejects(db, { month: thisMonth, startsOn: TODAY, publishTargetOn: TODAY }, /STARTS_ON_INVALID/);
  await openRejects(db, { month: `${MONTH}-02` }, /MONTH_INVALID/);
  await openRejects(db, { dueOn: addDays(TODAY, -1) }, /NO_BACKDATING/);
  await openRejects(db, { dueOn: START, publishTargetOn: START }, /staff_roster_periods_order/);
  await openRejects(db, { dueOn: day(10), publishTargetOn: day(9) }, /staff_roster_periods_order/);
  await openRejects(db, { dueOn: day(10), publishTargetOn: START }, /staff_roster_periods_starts_on/);
  await openRejects(db, {}, /MANAGER_ONLY/, ids.ava);
  await openRejects(db, {}, /MANAGER_ONLY/, null);
  const { rows } = await db.query('select count(*)::int as n from public.staff_roster_periods');
  assert.equal(rows[0].n, 0);
});

test('the table checks hold whoever writes: start inside the month, after the publish target', async () => {
  const { db } = await world({ openPeriod: false });
  const insert = (startsOn, due = TODAY, target = addDays(START, -1)) => db.query(
    `insert into public.staff_roster_periods (month, opens_on, due_on, publish_target_on, starts_on) values ($1, $2, $3, $4, $5)`,
    [MONTH_DATE, TODAY, due, target, startsOn]);
  await assert.rejects(() => insert(`${NEXT}-01`), /staff_roster_periods_starts_on/);
  await assert.rejects(() => insert(MONTH_DATE, TODAY, TODAY), /staff_roster_periods_starts_on/);
  await assert.rejects(() => insert(START, START, START), /staff_roster_periods_order|staff_roster_periods_starts_on/);
  await insert(null, TODAY, addDays(MONTH_DATE, -1));
  assert.equal((await period(db)).starts_on, null, 'a whole-month period still works exactly as before');
});

test('privileges: authenticated can open a part-month period, anon and the public cannot; replaced functions keep theirs', async () => {
  const { db } = await world({ openPeriod: false });
  const can = async (role, signature) => (await db.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, signature])).rows[0].ok;
  const fn = 'public.staff_roster_open_part_month(date, date, date, date, uuid)';
  assert.equal(await can('authenticated', fn), true);
  assert.equal(await can('anon', fn), false);
  const acl = (await db.query(`select proacl::text as acl from pg_proc where proname = 'staff_roster_open_part_month'`)).rows[0].acl;
  assert.doesNotMatch(acl, /(?:^|[{,])=X/, 'no PUBLIC execute');
  for (const name of ['staff_roster_me()', 'staff_roster_month_classes(date)']) {
    assert.equal(await can('authenticated', `public.${name}`), true, name);
    assert.equal(await can('anon', `public.${name}`), false, name);
  }
  for (const name of ['staff_roster_gaps(uuid, date)', 'staff_roster_assignment_problems(uuid, uuid, text, uuid, uuid[], boolean)']) {
    assert.equal(await can('authenticated', `public.${name}`), false, `${name} stays internal`);
    assert.equal(await can('anon', `public.${name}`), false, `${name} stays internal`);
  }
  const counts = await db.query(`select proname, count(*)::int as n from pg_proc where proname in
    ('staff_roster_gaps', 'staff_roster_month_classes', 'staff_roster_assignment_problems', 'staff_roster_me') group by proname order by proname`);
  assert.ok(counts.rows.every(row => row.n === 1), 'no second overload was created');
});

test('coaches only see classes from the start day; the manager board marks earlier ones and the two agree', async () => {
  const { db, staff } = await world({ openPeriod: false });
  const early = await addSession(db, day(10), 315, 60, { title: 'Synthetic day 10' });
  const lateNight = await addSession(db, day(14), 23 * 60, 45, { title: 'Synthetic day 14 late' });
  const firstMinute = await addSession(db, START, 0, 45, { title: 'Synthetic start midnight' });
  const later = await addSession(db, day(20), 315, 60, { title: 'Synthetic day 20' });
  await open(db);
  const classes = await rpc(db, ids.ava, 'select public.staff_roster_month_classes($1)', [MONTH_DATE]);
  assert.deepEqual(classes.map(row => row.id), [firstMinute, later]);
  const me = await rpc(db, ids.ava, 'select public.staff_roster_me()');
  assert.equal(me.periods.find(item => item.month === MONTH_DATE).starts_on, START);

  await submit(db, ids.ava, allWeek(0, 1440));
  await submit(db, ids.ben, allWeek(0, 1440));
  // The server checks against the month's draft, so make one.
  await apply(db, [{ op: 'assign', session_id: later, slot_key: 'lead', staff_id: staff.ava }]);
  const snap = await rpc(db, ids.owner, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE]);
  const ctx = planningContext(snap, { now: Date.now() });
  assert.deepEqual([early, lateNight, firstMinute, later].map(id => [ctx.sessions.get(id).inMonth, ctx.sessions.get(id).beforeRosterStart]),
    [[false, true], [false, true], [true, false], [true, false]]);
  for (const sessionId of [early, lateNight, firstMinute, later]) {
    for (const staffId of [staff.ava, staff.ben, staff.cam]) {
      const server = await rpc(db, ids.owner, 'select public.staff_roster_check_assignment($1, $2, $3, $4)', [MONTH_DATE, sessionId, 'lead', staffId]);
      const existing = ctx.assignments.filter(item => item.sessionId === sessionId && item.slotKey === 'lead').map(item => item.id);
      const browser = checkAssignment(ctx, { sessionId, slotKey: 'lead', staffId }, { ignoreAssignmentIds: existing });
      assert.deepEqual(browser.hard.map(item => item.code).sort(), [...server].sort(), `${sessionId} / ${staffId}`);
    }
  }
});

test('assigning before the start is refused; from the start is allowed; publishing counts gaps only from the start', async () => {
  const { db, staff } = await world({ openPeriod: false });
  const early = await addSession(db, day(10), 315, 60, { title: 'Synthetic day 10' });
  const later = await addSession(db, day(20), 315, 60, { title: 'Synthetic day 20' });
  await open(db);
  await submit(db, ids.ava, allWeek(0, 1440));
  await applyRejects(db, [{ op: 'assign', session_id: early, slot_key: 'lead', staff_id: staff.ava }], /SESSION_BEFORE_ROSTER_START/);
  await apply(db, [{ op: 'assign', session_id: later, slot_key: 'lead', staff_id: staff.ava }]);
  const draft = (await db.query(`select id from public.staff_roster_revisions where month = $1 and state = 'draft'`, [MONTH_DATE])).rows[0].id;
  const gaps = await db.query('select session_id from public.staff_roster_gaps($1, $2)', [draft, MONTH_DATE]);
  assert.deepEqual(gaps.rows, [], 'the day-10 class is not a gap');
  const result = await publish(db);
  assert.equal(result.ok, true);
  assert.equal(result.gaps, 0);
});

test('classes before the start are left byte-for-byte alone by publishing, with public names on', async () => {
  const { db, staff } = await world({ openPeriod: false });
  const typed = await addSession(db, day(9), 315, 60, { title: 'Synthetic typed' });
  const blank = await addSession(db, day(10), 315, 60, { title: 'Synthetic blank' });
  const later = await addSession(db, day(20), 315, 60, { title: 'Synthetic day 20' });
  await db.query(`update public.class_sessions set coach_name = 'Hand Typed Coach' where id = $1`, [typed]);
  await db.query('update public.staff_roster_settings set public_coach_names_enabled = true');
  const coach = (await db.query(`insert into public.coaches (name) values ('Ava Website') returning id`)).rows[0].id;
  await db.query('update public.staff_members set coach_id = $1 where id = $2', [coach, staff.ava]);
  await open(db);
  await submit(db, ids.ava, allWeek(0, 1440));
  const rows = async () => (await db.query('select id, to_jsonb(s)::text as row from public.class_sessions s where id = any($1) order by id', [[typed, blank]])).rows;
  const before = await rows();
  await apply(db, [{ op: 'assign', session_id: later, slot_key: 'lead', staff_id: staff.ava }]);
  const result = await publish(db);
  assert.equal(result.ok, true);
  assert.deepEqual(await rows(), before);
  const names = await db.query('select session_id from public.staff_roster_public_names');
  assert.deepEqual(names.rows, [{ session_id: later }], 'only the rostered class gets a public name');
  assert.equal((await db.query('select coach_name from public.class_sessions where id = $1', [later])).rows[0].coach_name, 'Ava Website');
});

test('a coach already rostered before the start day blocks opening until it is sorted out', async () => {
  const { db, staff } = await world({ openPeriod: false });
  const early = await addSession(db, day(10), 315, 60, { title: 'Synthetic day 10' });
  const later = await addSession(db, day(20), 315, 60, { title: 'Synthetic day 20' });
  // No period, so no answers: a correction is the only way onto a class.
  await rpc(db, ids.owner, 'select public.staff_roster_apply_changes($1, $2, $3::jsonb, $4, $5)', [MONTH_DATE, 0,
    JSON.stringify([{ op: 'assign', session_id: early, slot_key: 'lead', staff_id: staff.ava }, { op: 'assign', session_id: later, slot_key: 'lead', staff_id: staff.ben }]),
    rid(), 'Synthetic correction']);
  await openRejects(db, {}, /ASSIGNMENTS_BEFORE_START/);
  await openRejects(db, { startsOn: day(11), publishTargetOn: day(10) }, /ASSIGNMENTS_BEFORE_START/);
  // Discarded drafts are history and do not block.
  await rpc(db, ids.owner, 'select public.staff_roster_discard_draft($1, $2, $3)', [MONTH_DATE, await draftVersion(db), rid()]);
  const row = await open(db);
  assert.equal(row.starts_on, START);
  assert.equal((await period(db)).starts_on, START);
});

test('a part-month start between rostered classes is fine when nothing is before it', async () => {
  const { db, staff } = await world({ openPeriod: false });
  const later = await addSession(db, day(20), 315, 60, { title: 'Synthetic day 20' });
  await rpc(db, ids.owner, 'select public.staff_roster_apply_changes($1, $2, $3::jsonb, $4, $5)', [MONTH_DATE, 0,
    JSON.stringify([{ op: 'assign', session_id: later, slot_key: 'lead', staff_id: staff.ben }]), rid(), 'Synthetic correction']);
  assert.equal((await open(db)).starts_on, START);
});

test('changing the dates keeps answers due before the start', async () => {
  const { db } = await world({ openPeriod: false });
  await open(db, { dueOn: day(10), publishTargetOn: day(12) });
  const version = (await period(db)).version;
  await rejects(db, ids.owner, 'select public.staff_roster_update_period($1, $2, $3, $4)', [MONTH_DATE, START, START, version], /staff_roster_periods_order/);
  await rejects(db, ids.owner, 'select public.staff_roster_update_period($1, $2, $3, $4)', [MONTH_DATE, day(11), START, version], /staff_roster_periods_starts_on/);
  const ok = await rpc(db, ids.owner, 'select public.staff_roster_update_period($1, $2, $3, $4)', [MONTH_DATE, day(13), day(14), version]);
  assert.deepEqual([ok.due_on, ok.publish_target_on, ok.starts_on], [day(13), day(14), START]);
});

test('reminders queue the opened notice for every coach who can sign in', async () => {
  const { db } = await world({ openPeriod: false });
  await open(db, { dueOn: day(10), publishTargetOn: day(12) });
  const queued = await rpc(db, ids.owner, 'select public.staff_roster_run_reminders($1)', [gymInstantIso(TODAY, 23 * 60)]);
  assert.ok(queued >= 3);
  const { rows } = await db.query(`select n.recipient_profile_id as profile, n.title from public.staff_notifications n
    where n.dedupe_key like $1 order by n.recipient_profile_id`, [`reminder:${MONTH_DATE}:opened:%`]);
  assert.deepEqual(rows.map(row => row.profile), [ids.ava, ids.ben, ids.cam].sort());
  assert.ok(rows.every(row => /Availability open for/.test(row.title)));
  assert.equal(await rpc(db, ids.owner, 'select public.staff_roster_run_reminders($1)', [gymInstantIso(TODAY, 23 * 60)]), 0, 'running again queues nothing new');
});

test('running the migration twice is idempotent, keeps data, and still accepts whole-month periods', async () => {
  const { db } = await world();
  await open(db, { month: `${NEXT}-01`, startsOn: dateInMonth(NEXT, 5), dueOn: TODAY, publishTargetOn: dateInMonth(NEXT, 4) });
  const shape = async () => (await db.query(`select
      (select string_agg(conname || ':' || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.staff_roster_periods'::regclass) as checks,
      (select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'staff_roster_periods') as columns,
      (select string_agg(proname || ':' || coalesce(proacl::text, ''), ',' order by proname) from pg_proc where proname like 'staff\\_roster\\_%') as functions,
      (select string_agg(month::text || '/' || coalesce(starts_on::text, '-'), ',' order by month) from public.staff_roster_periods) as periods,
      (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_part_month') as capability`)).rows[0];
  const once = await shape();
  await db.exec(PART_MONTH);
  assert.deepEqual(await shape(), once);
  assert.equal(once.capability, 1);
  assert.match(once.periods, new RegExp(`${MONTH_DATE}/-`));
  assert.match(once.periods, new RegExp(`${NEXT}-01/${dateInMonth(NEXT, 5)}`));
});

test('a failure part-way leaves no column and no capability', async () => {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  for (const url of MIGRATION_URLS.slice(0, MIGRATION_URLS.indexOf(PART_MONTH_URL))) await db.exec(await readFile(url, 'utf8'));
  const marker = 'insert into public.xert_schema_capabilities';
  await assert.rejects(() => db.exec(PART_MONTH.replace(marker, `select 1 / 0;\n${marker}`)), /division by zero/);
  const { rows } = await db.query(`select
    (select count(*)::int from information_schema.columns where table_name = 'staff_roster_periods' and column_name = 'starts_on') as columns,
    (select count(*)::int from pg_proc where proname = 'staff_roster_open_part_month') as functions,
    (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_part_month') as capability`);
  assert.deepEqual(rows, [{ columns: 0, functions: 0, capability: 0 }]);
});
