// Coach invite links (20261002020000_staff_roster_coach_dashboard.sql) against
// the real migrations in PGlite. SYNTHETIC DATA ONLY: fictional coaches and
// accounts; the email path is a local stub that records calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { BASE_SCHEMA, MIGRATION_URLS, as } from './helpers/staff-roster-db.mjs';
import { ids, rid, rpc, rejects, world } from './helpers/staff-roster-world.mjs';

const INVITES = await readFile(MIGRATION_URLS[2], 'utf8');
const dan = '00000000-0000-4000-8000-0000000000d1';
const eve = '00000000-0000-4000-8000-0000000000e1';

async function inviteWorld(options) {
  const { db, staff } = await world(options);
  await db.exec(`insert into public.profiles (id, full_name, email, role) values
    ('${dan}', 'Dan Synthetic', 'dan@example.test', 'member'),
    ('${eve}', 'Eve Synthetic', 'eve@example.test', 'member')`);
  const row = await rpc(db, ids.owner, 'select public.staff_roster_upsert_staff($1::jsonb, null, $2)', [
    JSON.stringify({ display_name: 'Dana New', roles: ['lead'] }), rid()]);
  return { db, staff: { ...staff, dana: row.id } };
}

const create = (db, staffId, email = null) => rpc(db, ids.owner, 'select public.staff_roster_invite_create($1, $2)', [staffId, email]);
const accept = (db, uid, token) => rpc(db, uid, 'select public.staff_roster_invite_accept($1)', [token]);
const preview = (db, uid, token) => rpc(db, uid, 'select public.staff_roster_invite_preview($1)', [token]);
const linkedProfile = async (db, staffId) => (await db.query('select profile_id from public.staff_members where id = $1', [staffId])).rows[0].profile_id;
const statements = sql => sql.replace(/--[^\n]*/g, '').split(/;\s*\n/).map(part => part.trim()).filter(Boolean);

test('the migration starts with a scoped lock timeout and records its capability last', () => {
  const parts = statements(INVITES);
  assert.equal(parts[0], "set local lock_timeout = '5s'");
  assert.match(parts.at(-1), /^insert into public\.xert_schema_capabilities \(capability\) values \('staff_roster_coach_dashboard'\) on conflict \(capability\) do nothing;?$/);
  assert.equal(INVITES.match(/xert_schema_capabilities/g).length, 1);
  assert.match(INVITES, /set search_path = public/);
  for (const fn of INVITES.matchAll(/create or replace function public\.(\w+)[\s\S]*?\$\$;/g)) {
    assert.match(fn[0], /set search_path = public/, `${fn[1]} pins its search_path`);
  }
});

test('applying it twice changes nothing; a failure part-way leaves nothing and no capability', async () => {
  const [first, push] = await Promise.all(MIGRATION_URLS.slice(0, 2).map(url => readFile(url, 'utf8')));
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(first);
  await db.exec(push);
  const marker = 'insert into public.xert_schema_capabilities';
  await assert.rejects(() => db.exec(INVITES.replace(marker, `select 1 / 0;\n${marker}`)), /division by zero/);
  const empty = await db.query(`select (select count(*)::int from pg_tables where tablename like 'staff_roster_invite%') as tables,
    (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_coach_dashboard') as capability`);
  assert.deepEqual(empty.rows, [{ tables: 0, capability: 0 }]);
  await db.exec(INVITES);
  const snapshot = async () => (await db.query(`select
      (select string_agg(table_name || '.' || column_name, ',' order by table_name, column_name) from information_schema.columns where table_name like 'staff_roster_invite%') as columns,
      (select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename like 'staff_roster_invite%') as indexes,
      (select string_agg(proname, ',' order by proname) from pg_proc where proname like 'staff_roster_invite%') as functions,
      (select count(*)::int from public.xert_schema_capabilities) as capabilities`)).rows[0];
  const once = await snapshot();
  await db.exec(INVITES);
  assert.deepEqual(await snapshot(), once);
});

test('tables are closed to the API; anon can run nothing; signed-in users reach only the five entry points', async () => {
  const { db } = await inviteWorld();
  const tables = await db.query(`select c.relname, has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select') as readable,
      c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'staff_roster_invite%' and c.relkind = 'r'`);
  assert.deepEqual(tables.rows.map(row => [row.relname, row.readable, row.rls]).sort(),
    [['staff_roster_invite_attempts', false, true], ['staff_roster_invites', false, true]]);
  const fns = await db.query(`select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
      p.prosecdef as definer, array_to_string(p.proconfig, ',') as config
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'staff_roster_invite%'`);
  assert.deepEqual(fns.rows.filter(row => row.anon).map(row => row.proname), []);
  assert.deepEqual(fns.rows.filter(row => row.auth).map(row => row.proname).sort(),
    ['staff_roster_invite_accept', 'staff_roster_invite_create', 'staff_roster_invite_list', 'staff_roster_invite_preview', 'staff_roster_invite_revoke']);
  assert.ok(fns.rows.every(row => /search_path=public/.test(row.config || '')), 'every function pins search_path');
});

test('only managers create, list and revoke; signed-out callers are refused everywhere', async () => {
  const { db, staff } = await inviteWorld();
  for (const uid of [ids.member, ids.ava, dan]) {
    await rejects(db, uid, 'select public.staff_roster_invite_create($1, null)', [staff.dana], /MANAGER_ONLY/);
    await rejects(db, uid, 'select public.staff_roster_invite_list()', [], /MANAGER_ONLY/);
  }
  const { invite } = await create(db, staff.dana);
  await rejects(db, ids.ava, 'select public.staff_roster_invite_revoke($1)', [invite.id], /MANAGER_ONLY/);
  await rejects(db, null, 'select public.staff_roster_invite_create($1, null)', [staff.dana], /MANAGER_ONLY/);
  await rejects(db, null, 'select public.staff_roster_invite_accept($1)', ['a'.repeat(64)], /SIGN_IN_REQUIRED/);
  await rejects(db, null, 'select public.staff_roster_invite_preview($1)', ['a'.repeat(64)], /SIGN_IN_REQUIRED/);
});

test('creating returns the token once and stores only its SHA-256', async () => {
  const { db, staff } = await inviteWorld();
  const created = await create(db, staff.dana);
  assert.match(created.token, /^[0-9a-f]{64}$/);
  assert.equal(created.invite.status, 'pending');
  assert.equal(created.invite.created_by, 'Synthetic Owner');
  const days = (Date.parse(created.invite.expires_at) - Date.parse(created.invite.created_at)) / 86400000;
  assert.ok(Math.abs(days - 14) < 0.01, 'expires in 14 days');
  const { rows } = await db.query(`select encode(token_hash, 'hex') as hash, encode(sha256(convert_to($1, 'UTF8')), 'hex') as expected from public.staff_roster_invites`, [created.token]);
  assert.equal(rows[0].hash, rows[0].expected);
  const dump = JSON.stringify((await db.query(`select
      (select jsonb_agg(to_jsonb(i)) from public.staff_roster_invites i) as invites,
      (select jsonb_agg(to_jsonb(e)) from public.staff_roster_audit_events e) as audit,
      (select jsonb_agg(to_jsonb(r)) from public.staff_roster_requests r) as requests`)).rows);
  assert.equal(dump.includes(created.token), false, 'the token is never written anywhere');
  const list = await rpc(db, ids.owner, 'select public.staff_roster_invite_list()');
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes(created.token), false);
  assert.equal('token_hash' in list[0], false);
});

test('a signed-in coach previews (name only for a valid token), accepts, and is linked', async () => {
  const { db, staff } = await inviteWorld();
  const { token } = await create(db, staff.dana);
  const bad = await preview(db, dan, 'f'.repeat(64));
  assert.deepEqual(bad, { ok: false, code: 'INVITE_INVALID' }, 'nothing about any coach before a valid token');
  const seen = await preview(db, dan, token.toUpperCase());
  assert.equal(seen.ok, true);
  assert.equal(seen.display_name, 'Dana New');
  assert.equal(seen.account_already_staff, false);
  const result = await accept(db, dan, token);
  assert.deepEqual(result, { ok: true, already_accepted: false, roster_enabled: true, staff: { id: staff.dana, display_name: 'Dana New' } });
  assert.equal(await linkedProfile(db, staff.dana), dan);
  const me = await rpc(db, dan, 'select public.staff_roster_me()');
  assert.equal(me.staff.display_name, 'Dana New');
  const audit = await db.query(`select actor, action from public.staff_roster_audit_events where entity_id = $1 order by id`, [staff.dana]);
  assert.deepEqual(audit.rows.map(row => row.action), ['staff_created', 'invite_created', 'invite_accepted']);
  assert.equal(audit.rows[2].actor, dan);
  const [listed] = await rpc(db, ids.owner, 'select public.staff_roster_invite_list()');
  assert.equal(listed.status, 'accepted');
  assert.equal(listed.accepted_by, 'Dan Synthetic');
  assert.equal(listed.staff_linked, true);
  // Opening the same link again after joining is fine for the same person.
  assert.equal((await accept(db, dan, token)).already_accepted, true);
  assert.equal((await preview(db, dan, token)).linked_to_you, true);
});

test('a used link cannot be used by anyone else', async () => {
  const { db, staff } = await inviteWorld();
  const { token } = await create(db, staff.dana);
  await accept(db, dan, token);
  assert.deepEqual(await accept(db, eve, token), { ok: false, code: 'INVITE_USED' });
  assert.deepEqual(await preview(db, eve, token), { ok: false, code: 'INVITE_USED' });
  assert.equal(await linkedProfile(db, staff.dana), dan);
});

test('issuing again revokes the earlier link; revoking stops a link; both are honest about why', async () => {
  const { db, staff } = await inviteWorld();
  const first = await create(db, staff.dana);
  const second = await create(db, staff.dana, null);
  assert.notEqual(first.token, second.token);
  assert.deepEqual(await accept(db, dan, first.token), { ok: false, code: 'INVITE_REVOKED' });
  const { rows } = await db.query(`select revoked_reason from public.staff_roster_invites order by created_at`);
  assert.deepEqual(rows.map(row => row.revoked_reason), ['reissued', null]);
  const revoked = await rpc(db, ids.owner, 'select public.staff_roster_invite_revoke($1)', [second.invite.id]);
  assert.equal(revoked.status, 'revoked');
  assert.equal((await rpc(db, ids.owner, 'select public.staff_roster_invite_revoke($1)', [second.invite.id])).status, 'revoked', 'revoking twice is harmless');
  assert.deepEqual(await accept(db, dan, second.token), { ok: false, code: 'INVITE_REVOKED' });
  assert.equal(await linkedProfile(db, staff.dana), null);
  const [listed] = await rpc(db, ids.owner, 'select public.staff_roster_invite_list()');
  assert.equal(listed.id, second.invite.id, 'the list shows each coach’s latest invite');
  const third = await create(db, staff.dana);
  assert.equal((await accept(db, dan, third.token)).ok, true);
  await rejects(db, ids.owner, 'select public.staff_roster_invite_revoke($1)', [third.invite.id], /INVITE_USED/);
});

test('an expired link is refused and links nobody', async () => {
  const { db, staff } = await inviteWorld();
  const { token, invite } = await create(db, staff.dana);
  await db.query(`update public.staff_roster_invites set created_at = now() - interval '15 days', expires_at = now() - interval '1 day' where id = $1`, [invite.id]);
  assert.deepEqual(await preview(db, dan, token), { ok: false, code: 'INVITE_EXPIRED' });
  assert.deepEqual(await accept(db, dan, token), { ok: false, code: 'INVITE_EXPIRED' });
  assert.equal(await linkedProfile(db, staff.dana), null);
  assert.equal((await rpc(db, ids.owner, 'select public.staff_roster_invite_list()'))[0].status, 'expired');
});

test('an account already on the roster cannot take a second coach record', async () => {
  const { db, staff } = await inviteWorld();
  const { token } = await create(db, staff.dana);
  assert.equal((await preview(db, ids.ava, token)).account_already_staff, true);
  assert.deepEqual(await accept(db, ids.ava, token), { ok: false, code: 'ACCOUNT_ALREADY_LINKED' });
  assert.equal(await linkedProfile(db, staff.dana), null);
  assert.equal((await rpc(db, ids.owner, 'select public.staff_roster_invite_list()'))[0].status, 'pending', 'the link still works for the right person');
});

test('a coach linked by hand after the invite went out: the link is retired, not used', async () => {
  const { db, staff } = await inviteWorld();
  const { token } = await create(db, staff.dana);
  const { rows: [row] } = await db.query('select version from public.staff_members where id = $1', [staff.dana]);
  await rpc(db, ids.owner, 'select public.staff_roster_upsert_staff($1::jsonb, $2, $3)', [JSON.stringify({ id: staff.dana, display_name: 'Dana New', profile_id: eve, roles: ['lead'] }), row.version, rid()]);
  assert.deepEqual(await accept(db, dan, token), { ok: false, code: 'STAFF_ALREADY_LINKED' });
  assert.equal(await linkedProfile(db, staff.dana), eve);
  const { rows } = await db.query('select revoked_reason from public.staff_roster_invites');
  assert.equal(rows[0].revoked_reason, 'already_linked');
  await rejects(db, ids.owner, 'select public.staff_roster_invite_create($1, null)', [staff.dana], /STAFF_ALREADY_LINKED/);
});

test('inactive coaches and malformed emails are refused when creating', async () => {
  const { db, staff } = await inviteWorld();
  await rejects(db, ids.owner, 'select public.staff_roster_invite_create($1, $2)', [staff.dana, 'not-an-email'], /EMAIL_INVALID/);
  await rejects(db, ids.owner, 'select public.staff_roster_invite_create($1, null)', ['00000000-0000-4000-8000-00000000ffff'], /STAFF_NOT_FOUND/);
  const { token } = await create(db, staff.dana);
  const { rows: [row] } = await db.query('select version from public.staff_members where id = $1', [staff.dana]);
  await rpc(db, ids.owner, 'select public.staff_roster_set_staff_status($1, $2, $3, null, $4)', [staff.dana, 'inactive', row.version, rid()]);
  assert.deepEqual(await accept(db, dan, token), { ok: false, code: 'STAFF_INACTIVE' });
  await rejects(db, ids.owner, 'select public.staff_roster_invite_create($1, null)', [staff.dana], /STAFF_INACTIVE/);
});

test('failed attempts are throttled per account, even for a then-valid token', async () => {
  const { db, staff } = await inviteWorld();
  const { token } = await create(db, staff.dana);
  for (let i = 0; i < 10; i++) assert.equal((await accept(db, eve, `${String(i).padStart(2, '0')}${'0'.repeat(62)}`)).code, 'INVITE_INVALID');
  assert.deepEqual(await accept(db, eve, token), { ok: false, code: 'TOO_MANY_ATTEMPTS' });
  assert.deepEqual(await preview(db, eve, 'junk'), { ok: false, code: 'TOO_MANY_ATTEMPTS' });
  assert.equal(await linkedProfile(db, staff.dana), null);
  assert.equal((await accept(db, dan, token)).ok, true, 'other accounts are unaffected');
  const { rows } = await db.query('select count(*)::int as n from public.staff_roster_invite_attempts where profile_id = $1', [eve]);
  assert.equal(rows[0].n, 10);
});

test('the link can be emailed through queue_email; the address is validated and the outcome reported', async () => {
  const { db, staff } = await inviteWorld();
  const skipped = await create(db, staff.dana, 'dana@example.test');
  assert.equal(skipped.invite.email_status, 'skipped', 'no email service installed here: reported, not pretended');
  await db.exec(`
    create table public.synthetic_outbox (type text, recipient text, subject text, html text, body text, related_table text, related_id text);
    create function public.queue_email(p_type text, p_to text, p_subject text, p_html text, p_text text default null,
      p_related_table text default null, p_related_id text default null, p_attachments jsonb default null)
    returns uuid language plpgsql security definer set search_path = public as $$
    begin
      insert into public.synthetic_outbox values (p_type, p_to, p_subject, p_html, p_text, p_related_table, p_related_id);
      return gen_random_uuid();
    end; $$;`);
  const sent = await create(db, staff.dana, ' Dana@Example.test ');
  assert.equal(sent.invite.email_status, 'queued');
  assert.equal(sent.invite.email, 'dana@example.test');
  const { rows } = await db.query('select * from public.synthetic_outbox');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'staff_invite');
  assert.equal(rows[0].recipient, 'dana@example.test');
  assert.ok(rows[0].body.includes(`https://www.xertfitness.com.au/coach-invite#token=${sent.token}`));
  assert.ok(rows[0].html.includes(`#token=${sent.token}`));
  assert.equal(rows[0].related_id, sent.invite.id);
  assert.deepEqual(await accept(db, dan, skipped.token), { ok: false, code: 'INVITE_REVOKED' }, 'the emailed re-issue replaced the first link');
});

test('accepting works while the roster is switched off; coach screens still follow the switch', async () => {
  const { db, staff } = await inviteWorld({ enabled: false });
  const { token } = await create(db, staff.dana);
  const result = await accept(db, dan, token);
  assert.equal(result.ok, true);
  assert.equal(result.roster_enabled, false);
  await rejects(db, dan, 'select public.staff_roster_me()', [], /ROSTER_DISABLED/);
  await as(db, '');
});
