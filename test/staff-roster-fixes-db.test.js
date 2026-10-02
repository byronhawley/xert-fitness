// Roster fixes (20261002060000_staff_roster_fixes.sql) and the hardening of
// the unapplied 20261002050000_staff_roster_sms.sql, against the real
// migrations in PGlite. SYNTHETIC DATA ONLY: fictional coaches, fake device
// tokens and fictional numbers in the 0400 000 xxx range. Nothing here can
// send a push or a text: the database only queues, and no sender is called.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { BASE_SCHEMA, MIGRATION_URLS, as } from './helpers/staff-roster-db.mjs';
import {
  MONTH_DATE, addSession, allWeek, apply, applyRejects, day, draftVersion, ids, publish, rid, rpc, submit, world,
} from './helpers/staff-roster-world.mjs';
import { pgAdmin, pushWorld } from './helpers/staff-roster-push-kit.mjs';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url);
const FIXES_URL = MIGRATION_URLS.find(url => url.pathname.endsWith('20261002060000_staff_roster_fixes.sql'));
const SMS_URL = MIGRATION_URLS.find(url => url.pathname.endsWith('20261002050000_staff_roster_sms.sql'));
const FIXES = await readFile(FIXES_URL, 'utf8');
const statements = sql => sql.replace(/--[^\n]*/g, '').split(/;\s*\n/).map(part => part.trim()).filter(Boolean);
const definitions = (sql, name) => [...sql.matchAll(new RegExp(`^create or replace function public\\.${name}\\([\\s\\S]*?^\\$\\$;$`, 'gm'))].map(match => match[0]);

// ─── The migration file ─────────────────────────────────────────────────────

test('the fixes migration starts with a scoped lock timeout, records its capability last and names its prerequisites', () => {
  const parts = statements(FIXES);
  assert.equal(parts[0], "set local lock_timeout = '5s'");
  assert.match(parts.at(-1), /^insert into public\.xert_schema_capabilities \(capability\) values \('staff_roster_fixes'\) on conflict \(capability\) do nothing;?$/);
  assert.equal(FIXES.match(/xert_schema_capabilities/g).length, 1);
  for (const fn of FIXES.matchAll(/create or replace function public\.(\w+)[\s\S]*?\$\$;/g)) {
    assert.match(fn[0], /set search_path = public/, `${fn[1]} pins its search_path`);
  }
  const header = FIXES.slice(0, FIXES.indexOf('-- ─── '));
  assert.match(header, /20261002040000_staff_roster_part_month\.sql/);
  assert.match(header, /20261002050000_staff_roster_sms\.sql/);
  assert.doesNotMatch(FIXES, /\bdrop\s+(?:table|function|column)\b/i, 'nothing existing is dropped');
  assert.ok(MIGRATION_URLS.indexOf(FIXES_URL) > MIGRATION_URLS.indexOf(SMS_URL), 'the harness applies it after the texts migration');
});

// Each replaced function must stay a copy of its latest definition plus the
// marked lines, so a later fix to the source is not silently lost.
test('drift guard: each replaced function is its latest source definition plus only the lines marked -- fix', async () => {
  const files = (await readdir(MIGRATIONS_DIR)).filter(name => name.endsWith('.sql')).sort();
  const before = files.filter(name => name.slice(0, 14) < '20261002060000');
  const after = files.filter(name => name.slice(0, 14) > '20261002060000');
  for (const [name, expectedSource, maxAdded] of [
    ['staff_roster_apply_changes', '20261001010000_staff_roster.sql', 13],
    ['staff_roster_class_detail', '20261002020000_staff_roster_coach_dashboard.sql', 3],
  ]) {
    const sources = [];
    for (const file of before) {
      const found = definitions(await readFile(new URL(file, MIGRATIONS_DIR), 'utf8'), name);
      if (found.length) sources.push([file, found]);
    }
    const [latestFile, [source, ...extraSource]] = sources.at(-1);
    assert.equal(latestFile, expectedSource, `${name}: the latest definition before 060000 is in ${expectedSource}`);
    for (const file of after) {
      assert.deepEqual(definitions(await readFile(new URL(file, MIGRATIONS_DIR), 'utf8'), name), [], `${name} is not replaced again by ${file}`);
    }
    const [copy, ...extraCopy] = definitions(FIXES, name);
    assert.ok(source && copy && !extraSource.length && !extraCopy.length, `${name} is defined once in each file`);
    const added = copy.split('\n').filter(line => line.includes('-- fix'));
    assert.ok(added.length >= 1 && added.length <= maxAdded, `${name} adds only the marked lines (${added.length})`);
    assert.equal(copy.split('\n').filter(line => !line.includes('-- fix')).join('\n'), source, `${name} is otherwise verbatim`);
  }
});

test('grants are as the source migrations set them; the new trigger function is internal', async () => {
  const { db } = await world();
  const { rows } = await db.query(`
    select p.proname,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('staff_roster_apply_changes', 'staff_roster_class_detail', 'staff_roster_push_preference_on_update')
    order by p.proname`);
  assert.deepEqual(rows.map(row => [row.proname, row.anon, row.authenticated]), [
    ['staff_roster_apply_changes', false, true],
    ['staff_roster_class_detail', false, true],
    ['staff_roster_push_preference_on_update', false, false],
  ]);
  const trigger = await db.query(`select tgname from pg_trigger where tgrelid = 'public.staff_notification_push_deliveries'::regclass and tgname = 'staff_notification_push_preferences_update'`);
  assert.equal(trigger.rows.length, 1);
});

test('re-running the fixes migration changes nothing; a failure part-way leaves no trigger and no capability', async () => {
  const { db } = await pushWorld();
  const shape = async () => (await db.query(`select
    (select count(*)::int from public.staff_assignments) as assignments,
    (select count(*)::int from public.staff_notification_push_deliveries) as deliveries,
    (select count(*)::int from pg_trigger where tgname = 'staff_notification_push_preferences_update') as triggers,
    (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_fixes') as capability`)).rows[0];
  const once = await shape();
  await db.exec(FIXES);
  assert.deepEqual(await shape(), once);
  assert.deepEqual([once.triggers, once.capability], [1, 1]);

  const fresh = new PGlite();
  await fresh.exec(BASE_SCHEMA);
  for (const url of MIGRATION_URLS.slice(0, MIGRATION_URLS.indexOf(FIXES_URL))) await fresh.exec(await readFile(url, 'utf8'));
  const marker = 'insert into public.xert_schema_capabilities';
  await assert.rejects(() => fresh.exec(`begin;\n${FIXES.replace(marker, `select 1 / 0;\n${marker}`)}\ncommit;`), /division by zero/);
  await fresh.exec('rollback');
  const { rows } = await fresh.query(`select
    (select count(*)::int from pg_trigger where tgname = 'staff_notification_push_preferences_update') as triggers,
    (select count(*)::int from pg_proc where proname = 'staff_roster_push_preference_on_update') as functions,
    (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_fixes') as capability`);
  assert.deepEqual(rows, [{ triggers: 0, functions: 0, capability: 0 }]);
});

// ─── (A) Editing a published month from the screen's published ids ─────────

const published = async db => (await db.query(`select a.id, a.session_id, a.slot_key, a.staff_id, a.pinned from public.staff_assignments a
  join public.staff_roster_revisions r on r.id = a.revision_id where r.month = $1 and r.state = 'published' order by a.session_start`, [MONTH_DATE])).rows;
const draft = async db => (await db.query(`select a.session_id, a.slot_key, a.staff_id, a.pinned from public.staff_assignments a
  join public.staff_roster_revisions r on r.id = a.revision_id where r.month = $1 and r.state = 'draft' order by a.session_start`, [MONTH_DATE])).rows;

/** Four classes, each lead filled (Ava, Ben, Ava, Ben), published: no gaps. */
async function staffedMonth() {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  await submit(db, ids.ben, allWeek(0, 1440));
  const s = [
    await addSession(db, day(12), 375, 60, { title: 'One' }),
    await addSession(db, day(13), 375, 60, { title: 'Two' }),
    await addSession(db, day(14), 375, 60, { title: 'Three' }),
    await addSession(db, day(15), 375, 60, { title: 'Four' }),
  ];
  const lead = (session, staffId) => ({ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staffId });
  await apply(db, [lead(s[0], staff.ava), lead(s[1], staff.ben), lead(s[2], staff.ava), lead(s[3], staff.ben)]);
  const result = await publish(db);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.gap_count ?? 0, 0, 'fully staffed');
  return { db, staff, s, lead };
}

test('a fully staffed published month can be edited from the published ids: unassign, replace, move, pin and re-assert', async () => {
  const { db, staff, s, lead } = await staffedMonth();
  // What the board shows with no draft: the published roster.
  const snapshot = await rpc(db, ids.owner, 'select public.staff_roster_planning_snapshot($1)', [MONTH_DATE]);
  assert.equal(snapshot.draft, null);
  const shown = Object.fromEntries(snapshot.published_assignments.map(row => [row.session_id, row]));
  assert.equal(Object.keys(shown).length, 4);
  assert.equal(await draftVersion(db), 0);

  // Unassign: the first edit makes the draft and removes the copy of that assignment.
  await apply(db, [{ op: 'unassign', assignment_id: shown[s[0]].id }]);
  assert.deepEqual((await draft(db)).map(row => row.session_id), [s[1], s[2], s[3]]);

  // Replace (the drawer's unassign + assign), still naming the published id the screen holds.
  await apply(db, [{ op: 'unassign', assignment_id: shown[s[1]].id }, lead(s[1], staff.ava)]);
  // Move onto an occupied position is refused, and nothing in the batch is applied.
  await applyRejects(db, [{ op: 'move', assignment_id: shown[s[3]].id, session_id: s[2], slot_key: 'lead' }], /SLOT_TAKEN/);
  // Move onto the position freed above.
  await apply(db, [{ op: 'move', assignment_id: shown[s[3]].id, session_id: s[0], slot_key: 'lead' }]);
  // Pin.
  await apply(db, [{ op: 'pin', assignment_id: shown[s[2]].id, pinned: true }]);
  // Re-assert an identical assignment: a no-op, not a unique-constraint error.
  const before = await draft(db);
  await apply(db, [lead(s[2], staff.ava)]);
  assert.deepEqual(await draft(db), before);

  assert.deepEqual((await draft(db)).map(row => [row.session_id, row.staff_id, row.pinned]), [
    [s[0], staff.ben, false],
    [s[1], staff.ava, false],
    [s[2], staff.ava, true],
  ]);
  const result = await publish(db, 'Synthetic gap');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await published(db)).map(row => [row.session_id, row.staff_id, row.pinned]), [
    [s[0], staff.ben, false],
    [s[1], staff.ava, false],
    [s[2], staff.ava, true],
  ]);
});

test('a published id that has no copy in the draft is still refused; history stays locked', async () => {
  const { db, s } = await staffedMonth();
  const shown = await published(db);
  await apply(db, [{ op: 'unassign', assignment_id: shown[0].id }]);
  await applyRejects(db, [{ op: 'unassign', assignment_id: shown[0].id }], /ASSIGNMENT_NOT_IN_DRAFT/);
  await applyRejects(db, [{ op: 'pin', assignment_id: rid() }], /ASSIGNMENT_NOT_IN_DRAFT/);
  await db.query(`update public.staff_assignments set session_start = now() - interval '1 hour' where session_id = $1`, [s[1]]);
  await applyRejects(db, [{ op: 'unassign', assignment_id: shown[1].id }], /HISTORY_LOCKED/);
});

// ─── (C) Push stops when a coach switches it off ────────────────────────────

test('push: a coach who turns push off while a push is leased gets nothing further', async () => {
  const { db } = await pushWorld();
  const admin = pgAdmin(db);
  const leased = (await admin.rpc('staff_roster_push_claim', { p_worker: 'fixes-test', p_limit: 100 })).data;
  const ava = leased.filter(row => row.device_token === 'a'.repeat(64));
  assert.ok(ava.length >= 1);
  await rpc(db, ids.ava, 'select public.staff_roster_set_notice_preferences(true, false)');
  const begun = (await admin.rpc('staff_roster_push_begin', { p_leases: ava.map(row => ({ delivery_id: row.delivery_id, lease_token: row.lease_token })) })).data;
  assert.deepEqual(begun, [], 'the leased push to the coach who switched off is not started');
  const other = leased.filter(row => row.device_token === 'b'.repeat(64));
  assert.ok(other.length >= 1);
  await admin.rpc('staff_roster_push_record', { p_results: other.map(row => ({ delivery_id: row.delivery_id, lease_token: row.lease_token, outcome: 'retry', reason: 'X', retry_after_seconds: 1 })) });
  const { rows } = await db.query('select status, reason from public.staff_notification_push_deliveries where id = $1', [other[0].delivery_id]);
  assert.deepEqual(rows[0], { status: 'skipped', reason: 'PUSH_OFF_BY_RECIPIENT' }, 'a retry closes instead of going back to pending');
});

test('push: a coach with push on is unaffected by the trigger', async () => {
  const { db } = await pushWorld();
  const admin = pgAdmin(db);
  const leased = (await admin.rpc('staff_roster_push_claim', { p_worker: 'fixes-test', p_limit: 100 })).data;
  const ava = leased.filter(row => row.device_token === 'a'.repeat(64));
  const begun = (await admin.rpc('staff_roster_push_begin', { p_leases: ava.map(row => ({ delivery_id: row.delivery_id, lease_token: row.lease_token })) })).data;
  assert.equal(begun.length, ava.length);
});

// ─── (D) Class detail counts public sign-up requests ────────────────────────

test('class detail counts public sign-up requests as requests', async () => {
  const { db, session } = await pushWorld();
  await db.exec(`create table public.session_bookings (id uuid primary key default gen_random_uuid(), user_id uuid, class_session_id uuid, status text, created_at timestamptz default now());
    create table public.class_bookings (id uuid primary key default gen_random_uuid(), class_session_id uuid, full_name text, status text, guest_visit boolean default false, created_at timestamptz default now());`);
  await db.query(`insert into public.class_bookings (class_session_id, full_name, status) values ($1, 'Pat Example', 'requested'), ($1, 'Lee Example', 'confirmed'), ($1, 'Kim Example', 'cancelled')`, [session]);
  await db.query(`insert into public.class_bookings (class_session_id, full_name, status) values (gen_random_uuid(), 'Other Example', 'requested')`);
  const detail = await rpc(db, ids.ava, 'select public.staff_roster_class_detail($1)', [session]);
  assert.equal(detail.booked, 1);
  assert.equal(detail.pending, 1, 'the public request shows as a request');
  assert.deepEqual(detail.people.map(person => [person.name, person.status]).sort(), [['Lee E.', 'confirmed'], ['Pat E.', 'requested']]);
});

// ─── (B) A cancel at commit never undoes a publish ──────────────────────────

test('texts: queueing waits at most 2 s for its lock, and the publish trigger also catches a cancel', async () => {
  const { db } = await world();
  const { rows } = await db.query(`select p.proname, p.proconfig, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('staff_roster_sms_queue', 'staff_roster_sms_on_publish') order by p.proname`);
  const fn = Object.fromEntries(rows.map(row => [row.proname, row]));
  assert.ok(fn.staff_roster_sms_queue.proconfig.includes('lock_timeout=2s'), JSON.stringify(fn.staff_roster_sms_queue.proconfig));
  assert.match(fn.staff_roster_sms_on_publish.prosrc, /exception when query_canceled or others then\s+raise warning/);
});

test('texts: a cancel while texts are queued at commit never undoes the publish (and would without the handler)', async () => {
  const { db, staff } = await pushWorld();
  await db.exec(`update public.staff_roster_settings set sms_enabled = true;
    create or replace function public.staff_roster_sms_queue(p_revision uuid) returns integer language plpgsql set search_path = public as $$
    begin raise exception 'canceling statement due to user request' using errcode = 'query_canceled'; end; $$;`);
  const second = await addSession(db, day(13), 375, 60);
  await apply(db, [{ op: 'assign', session_id: second, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  const { rows } = await db.query('select number, state from public.staff_roster_revisions order by number');
  assert.deepEqual(rows.map(row => `${row.number}:${row.state}`), ['1:superseded', '2:published']);

  // The same cancel with the old handler (`others` only) undoes the publish.
  await db.exec(`create or replace function public.staff_roster_sms_on_publish() returns trigger language plpgsql security definer set search_path = public as $$
    begin begin perform public.staff_roster_sms_queue(new.id); exception when others then raise warning 'not queued'; end; return null; end; $$;`);
  const third = await addSession(db, day(14), 375, 60);
  await apply(db, [{ op: 'assign', session_id: third, slot_key: 'lead', staff_id: staff.ava }]);
  const version = await draftVersion(db);
  // Each query runs in its own implicit transaction, so the deferred trigger fires at its commit.
  await as(db, ids.owner);
  await assert.rejects(() => db.query('select public.staff_roster_publish($1, $2, $3, $4)', [MONTH_DATE, version, null, rid()]), /canceling statement/);
  const after = await db.query('select number, state from public.staff_roster_revisions order by number');
  assert.equal(after.rows.find(row => row.number === 2).state, 'published', 'the cancelled publish rolled back');
});

// ─── (E) Out-of-date texts, and texts a cancelled publish never queued ──────

async function textWorld() {
  const env = await pushWorld();
  await env.db.exec(`update public.staff_roster_settings set sms_enabled = true; update public.profiles set phone = '0400 000 001' where id = '${ids.ava}';`);
  return env;
}
const texts = async db => (await db.query(`select m.status, m.reason, m.kind, r.number from public.staff_roster_sms_messages m
  join public.staff_roster_revisions r on r.id = m.revision_id order by r.number, m.created_at`)).rows;

test('texts: a text queued before a later publish that queued nothing for that coach is closed as out of date, not sent', async () => {
  const { db, staff } = await textWorld();
  const s2 = await addSession(db, day(14), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s2, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  assert.deepEqual((await texts(db)).map(row => row.status), ['pending']);
  // Published while the coach screens are off: nothing can be queued.
  await db.exec('update public.staff_roster_settings set enabled = false;');
  const s3 = await addSession(db, day(15), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s3, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  await db.exec('update public.staff_roster_settings set enabled = true;');
  const claimed = (await pgAdmin(db).rpc('staff_roster_sms_claim', { p_limit: 10, p_worker: 'fixes-test' })).data;
  assert.deepEqual(claimed, [], 'the out-of-date list is not sent');
  assert.deepEqual((await texts(db)).map(row => [row.number, row.status, row.reason]), [[2, 'skipped', 'REPLACED_BY_NEWER']]);
});

test('texts: a pending text the later publish did not change is still sent', async () => {
  const { db, staff } = await textWorld();
  const s2 = await addSession(db, day(14), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s2, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  // A republish that only changes Ben: Ava's text is still right.
  await submit(db, ids.ben, allWeek(0, 1440));
  const s3 = await addSession(db, day(15), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s3, slot_key: 'lead', staff_id: staff.ben }]);
  assert.equal((await publish(db)).ok, true);
  const claimed = (await pgAdmin(db).rpc('staff_roster_sms_claim', { p_limit: 10, p_worker: 'fixes-test' })).data;
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].staff_id, staff.ava);
});

test('texts: "Resend failed texts" queues what a cancelled publish never queued, once', async () => {
  const { db, staff } = await textWorld();
  const queue = (await db.query(`select pg_get_functiondef('public.staff_roster_sms_queue(uuid)'::regprocedure) as def`)).rows[0].def;
  await db.exec(`create or replace function public.staff_roster_sms_queue(p_revision uuid) returns integer language plpgsql set search_path = public as $$
    begin raise exception 'canceling statement due to user request' using errcode = 'query_canceled'; end; $$;`);
  const s2 = await addSession(db, day(14), 375, 60);
  await apply(db, [{ op: 'assign', session_id: s2, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  assert.deepEqual(await texts(db), [], 'the cancel queued nothing');
  await db.exec(queue);
  const retried = await rpc(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE]);
  assert.deepEqual(retried, { queued: 1, still_skipped: 0 });
  assert.deepEqual((await texts(db)).map(row => [row.number, row.status, row.kind]), [[2, 'pending', 'published']]);
  assert.deepEqual(await rpc(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE]), { queued: 0, still_skipped: 0 });
  assert.equal((await texts(db)).length, 1);
});
