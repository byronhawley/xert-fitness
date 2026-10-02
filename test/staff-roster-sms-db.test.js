// Roster text messages (20261002050000_staff_roster_sms.sql) against the real
// migrations in PGlite. SYNTHETIC DATA ONLY: fictional coaches, fictional
// numbers in the 0400 000 xxx range, and nothing here can send a text: the
// database only queues, and these tests never call the sender.
//
// MONTH is two months ahead, so every class is in the future whatever day the
// tests run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { BASE_SCHEMA, MIGRATION_URLS, as } from './helpers/staff-roster-db.mjs';
import {
  MONTH, MONTH_DATE, TODAY, addSession, allWeek, apply, day, ids, publish, rejects, rid, rpc, submit, world,
} from './helpers/staff-roster-world.mjs';
import { addDays, gymInstantIso } from '../src/lib/staffRoster/time.js';
import { buildRosterSms } from '../src/lib/staffRoster/sms.js';

const SMS_URL = MIGRATION_URLS.find(url => url.pathname.endsWith('20261002050000_staff_roster_sms.sql'));
const SMS = await readFile(SMS_URL, 'utf8');
const statements = sql => sql.replace(/--[^\n]*/g, '').split(/;\s*\n/).map(part => part.trim()).filter(Boolean);

const more = {
  dee: '00000000-0000-4000-8000-0000000000d1',
  eve: '00000000-0000-4000-8000-0000000000e1',
};

/**
 * Ava: valid mobile. Ben: no phone. Dee: valid mobile but texts turned off.
 * Eve: a landline. Texting switched on unless `sms: false`.
 */
async function smsWorld({ sms = true, startsOn = null } = {}) {
  const { db, staff } = await world({ openPeriod: !startsOn });
  await db.query(`insert into public.profiles (id, full_name, email, phone) values ($1, 'Dee Synthetic', 'dee@example.test', '0400 000 004'),
    ($2, 'Eve Synthetic', 'eve@example.test', '07 4000 0005')`, [more.dee, more.eve]);
  await db.query(`update public.profiles set phone = '0400 000 001' where id = $1`, [ids.ava]);
  for (const [key, name] of [['dee', 'Dee Lane'], ['eve', 'Eve']]) {
    const row = await rpc(db, ids.owner, 'select public.staff_roster_upsert_staff($1::jsonb, null, $2)', [JSON.stringify({ display_name: name, profile_id: more[key], roles: ['lead'] }), rid()]);
    staff[key] = row.id;
  }
  if (startsOn) {
    await rpc(db, ids.owner, 'select public.staff_roster_open_part_month($1, $2, $3, $4, $5)', [MONTH_DATE, startsOn, TODAY, addDays(startsOn, -1), rid()]);
  }
  for (const uid of [ids.ava, ids.ben, more.dee, more.eve]) await submit(db, uid, allWeek(0, 1440));
  await rpc(db, more.dee, 'select public.staff_roster_set_sms_preference(false)');
  if (sms) await setSms(db, true);
  return { db, staff };
}

async function setSms(db, enabled) {
  const { rows } = await db.query('select version from public.staff_roster_settings where id = 1');
  return rpc(db, ids.owner, 'select public.staff_roster_sms_set_enabled($1, $2)', [enabled, rows[0].version]);
}

const messages = async (db, where = 'true', params = []) => (await db.query(
  `select m.*, s.display_name as name, r.number from public.staff_roster_sms_messages m
   join public.staff_members s on s.id = m.staff_id join public.staff_roster_revisions r on r.id = m.revision_id
   where ${where} order by r.number, s.display_name`, params)).rows;
const byName = rows => Object.fromEntries(rows.map(row => [row.name, row]));
const assign = (session, staffId) => ({ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staffId });
const assignmentId = async (db, session) => (await db.query(
  `select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
   where r.month = $1 and r.state = 'draft' and a.session_id = $2`, [MONTH_DATE, session])).rows[0].id;
const newDraft = db => rpc(db, ids.owner, 'select public.staff_roster_draft($1)', [MONTH_DATE]);
const claim = (db, limit = 20) => rpc(db, null, `select public.staff_roster_sms_claim($1, 'test-worker')`, [limit]);
const record = (db, row, ok, { retryable = false, error = null, body = 'XERT: test' } = {}) =>
  rpc(db, null, 'select public.staff_roster_sms_record($1, $2, $3, $4, $5, $6, $7)', [row.id, row.lease_token, ok, ok ? 'SM-synthetic' : null, error, retryable, body]);

async function firstPublish() {
  const env = await smsWorld();
  const { db, staff } = env;
  const s = {
    engine: await addSession(db, day(13), 315, 60, { title: 'Engine' }),
    strength: await addSession(db, day(15), 375, 60, { title: 'Strength' }),
    ben: await addSession(db, day(16), 375, 60, { title: 'Hyrox' }),
    dee: await addSession(db, day(17), 375, 60, { title: 'Mobility' }),
    eve: await addSession(db, day(18), 375, 60, { title: 'Boxing' }),
    spare: await addSession(db, day(20), 420, 60, { title: 'Engine' }),
  };
  await apply(db, [assign(s.engine, staff.ava), assign(s.strength, staff.ava), assign(s.ben, staff.ben), assign(s.dee, staff.dee), assign(s.eve, staff.eve)]);
  const result = await publish(db, 'Synthetic gaps');
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...env, s, result };
}

test('the migration starts with a scoped lock timeout, records its capability last and pins search paths', () => {
  const parts = statements(SMS);
  assert.equal(parts[0], "set local lock_timeout = '5s'");
  assert.match(parts.at(-1), /^insert into public\.xert_schema_capabilities \(capability\) values \('staff_roster_sms'\) on conflict \(capability\) do nothing;?$/);
  assert.equal(SMS.match(/xert_schema_capabilities/g).length, 1);
  for (const fn of SMS.matchAll(/create or replace function public\.(\w+)[\s\S]*?\$\$;/g)) {
    assert.match(fn[0], /set search_path = public/, `${fn[1]} pins its search_path`);
  }
  assert.doesNotMatch(SMS, /\bdrop\s+(?:table|function|column)\b/i, 'nothing existing is dropped');
  assert.doesNotMatch(SMS, /create or replace function public\.staff_roster_(publish|approve_cover|notify|update_settings)\(/, 'publish and its neighbours are not copied');
});

test('ships switched off: publishing queues no texts until the owner turns texting on', async () => {
  const { db, staff } = await smsWorld({ sms: false });
  const { rows } = await db.query('select sms_enabled from public.staff_roster_settings');
  assert.deepEqual(rows, [{ sms_enabled: false }]);
  const session = await addSession(db, day(13), 315, 60, { title: 'Engine' });
  await apply(db, [assign(session, staff.ava)]);
  assert.equal((await publish(db, 'Synthetic gaps')).ok, true);
  assert.deepEqual(await messages(db), []);
  const status = await rpc(db, ids.owner, 'select public.staff_roster_sms_status($1)', [MONTH_DATE]);
  assert.equal(status.enabled, false);
  assert.equal(status.due, false);
});

test('first publish: one "published" text per coach listing every class, with a recorded reason for each coach who cannot get one', async () => {
  const { db, staff, result } = await firstPublish();
  const rows = byName(await messages(db));
  assert.deepEqual(Object.keys(rows).sort(), ['Ava', 'Ben', 'Dee Lane', 'Eve']);
  for (const row of Object.values(rows)) {
    assert.equal(row.kind, 'published');
    assert.equal(row.revision_id, result.revision_id);
    assert.equal(new Date(row.month).toISOString().slice(0, 10), MONTH_DATE);
  }
  assert.deepEqual([rows.Ava.status, rows.Ava.reason, rows.Ava.phone, rows.Ava.attempts], ['pending', null, '+61400000001', 0]);
  assert.deepEqual([rows.Ben.status, rows.Ben.reason, rows.Ben.phone], ['skipped', 'NO_MOBILE', null]);
  assert.deepEqual([rows['Dee Lane'].status, rows['Dee Lane'].reason], ['skipped', 'OPTED_OUT']);
  assert.deepEqual([rows.Eve.status, rows.Eve.reason, rows.Eve.phone], ['skipped', 'MOBILE_INVALID', null]);
  assert.equal(rows['Dee Lane'].details.first_name, 'Dee');
  const lines = rows.Ava.details.lines;
  assert.deepEqual(lines.map(line => [line.title, new Date(line.start).toISOString(), line.role]), [
    ['Engine', gymInstantIso(day(13), 315), 'lead'], ['Strength', gymInstantIso(day(15), 375), 'lead']]);
  assert.equal(rows.Ava.details.starts_on, null);
  assert.equal(staff.ava, rows.Ava.staff_id);

  const status = await rpc(db, ids.owner, 'select public.staff_roster_sms_status($1)', [MONTH_DATE]);
  assert.deepEqual(status.counts, { sent: 0, pending: 1, failed: 0, skipped: 3 });
  assert.equal(status.due, true);
  assert.equal(status.retryable, 2, 'no mobile and wrong mobile can be retried once fixed; opting out cannot');
  const mobile = Object.fromEntries(status.coaches.map(item => [item.staff_id, item.mobile]));
  assert.deepEqual([mobile[staff.ava], mobile[staff.ben], mobile[staff.eve], mobile[staff.cam]], ['ok', 'missing', 'invalid', 'missing']);
  const body = buildRosterSms(rows.Ava);
  assert.match(body, /^XERT: Hi Ava, your \w+ classes: \w{3} 13 \w{3} 5:15am Engine; \w{3} 15 \w{3} 6:15am Strength\. See all: https:\/\/www\.xertfitness\.com\.au\/coaching\?tab=roster$/);
});

// A coach is told about the latest version relative to their last text that
// went out. Ava's first text has gone, so an unchanged republish has nothing
// to tell her. Ben, Dee and Eve were never texted (no mobile, opted out, a
// landline), so each version records why they still were not: a 'skipped' row
// for the version the manager is looking at, never a text.
test('a republish with no changes queues nothing; a replayed publish request queues nothing twice', async () => {
  const { db, s, staff } = await firstPublish();
  for (const row of await claim(db)) await record(db, row, true);
  await newDraft(db);
  const unchanged = await publish(db, 'Synthetic gaps');
  assert.equal(unchanged.ok, true);
  const again = await messages(db, 'm.revision_id = $1', [unchanged.revision_id]);
  assert.deepEqual(again.map(row => [row.name, row.status, row.reason]),
    [['Ben', 'skipped', 'NO_MOBILE'], ['Dee Lane', 'skipped', 'OPTED_OUT'], ['Eve', 'skipped', 'MOBILE_INVALID']], 'nothing to text: Ava’s classes did not change');

  // The same request id again: publish answers from its replay store and the revision is untouched.
  await apply(db, [assign(s.spare, staff.ben)]);
  const requestId = rid();
  const first = await publish(db, 'Synthetic gaps', requestId);
  const count = (await messages(db)).length;
  const replay = await rpc(db, ids.owner, 'select public.staff_roster_publish($1, $2, $3, $4)', [MONTH_DATE, 1, null, requestId]);
  assert.deepEqual(replay, first);
  assert.equal((await messages(db)).length, count);
  // Queueing the same revision again (a retried trigger) adds nothing either.
  assert.equal(await rpc(db, null, 'select public.staff_roster_sms_queue($1)', [first.revision_id]), 0);
  assert.equal((await messages(db)).length, count);
  const { rows } = await db.query('select revision_id, staff_id, count(*)::int as n from public.staff_roster_sms_messages group by 1, 2 having count(*) > 1');
  assert.deepEqual(rows, []);
});

test('a later publish texts only the coaches whose classes changed, listing just the changes', async () => {
  const { db, s, staff } = await firstPublish();
  // Ava's first text went out.
  const [leased] = await claim(db);
  await record(db, leased, true);
  // Ava loses Strength and gains the spare Engine; Engine moves 30 minutes; Ben is untouched.
  await db.query('update public.class_sessions set start_time = $2, end_time = $3 where id = $1',
    [s.engine, gymInstantIso(day(13), 345), gymInstantIso(day(13), 405)]);
  await newDraft(db);
  await apply(db, [{ op: 'unassign', assignment_id: await assignmentId(db, s.strength) }, assign(s.spare, staff.ava)]);
  const second = await publish(db, 'Synthetic gaps');
  const all = await messages(db, 'm.revision_id = $1', [second.revision_id]);
  // Coaches never texted are recorded again with why (they have nothing sent to count changes from).
  assert.deepEqual(all.map(row => [row.name, row.kind, row.status, row.reason]), [
    ['Ava', 'changed', 'pending', null], ['Ben', 'published', 'skipped', 'NO_MOBILE'],
    ['Dee Lane', 'published', 'skipped', 'OPTED_OUT'], ['Eve', 'published', 'skipped', 'MOBILE_INVALID']]);
  const queued = all.filter(row => row.status === 'pending');
  const lines = queued[0].details.lines;
  assert.deepEqual(lines.map(line => [line.change, line.title, new Date(line.start).toISOString()]), [
    ['added', 'Engine', gymInstantIso(day(20), 420)],
    ['removed', 'Strength', gymInstantIso(day(15), 375)],
    ['moved', 'Engine', gymInstantIso(day(13), 345)],
  ]);
  assert.equal(new Date(lines[2].was).toISOString(), gymInstantIso(day(13), 315));
  const body = buildRosterSms(queued[0]);
  assert.match(body, /your \w+ roster changed: added \w{3} 20 \w{3} 7:00am Engine; removed \w{3} 15 \w{3} 6:15am Strength; moved \w{3} 13 \w{3} 5:15am Engine to \w{3} 13 \w{3} 5:45am\. See all: /);
});

test('a coach made inactive is not texted (a waiting text is skipped as inactive); a coach whose earlier text never went gets the full list', async () => {
  const { db, s, staff } = await firstPublish();
  const ben = (await db.query('select version from public.staff_members where id = $1', [staff.ben])).rows[0];
  await rpc(db, ids.owner, 'select public.staff_roster_set_staff_status($1, $2, $3, $4, $5)', [staff.ben, 'inactive', ben.version, 'Synthetic leave', rid()]);
  // Eve fixes her number; she was skipped before, so her next text is the whole month.
  await db.query(`update public.profiles set phone = '0400 000 005' where id = $1`, [more.eve]);
  await newDraft(db);
  await apply(db, [{ op: 'unassign', assignment_id: await assignmentId(db, s.ben) }, assign(s.spare, staff.eve)]);
  const second = await publish(db, 'Synthetic gaps');
  const rows = byName(await messages(db, 'm.revision_id = $1', [second.revision_id]));
  // Ben is inactive and was never sent anything: no row. Ava's first text is
  // still waiting, so this version's text for her is her whole list again.
  assert.deepEqual(Object.keys(rows).sort(), ['Ava', 'Dee Lane', 'Eve']);
  assert.deepEqual([rows.Ava.kind, rows.Ava.status], ['published', 'pending']);
  assert.deepEqual([rows.Eve.kind, rows.Eve.status, rows.Eve.phone], ['published', 'pending', '+61400000005']);
  assert.deepEqual(rows.Eve.details.lines.map(line => line.title), ['Boxing', 'Engine']);
  const old = byName(await messages(db, 'm.revision_id <> $1', [second.revision_id]));
  assert.deepEqual([old.Eve.status, old.Eve.reason], ['skipped', 'REPLACED_BY_NEWER']);
  assert.deepEqual([old.Ava.status, old.Ava.reason], ['skipped', 'REPLACED_BY_NEWER'], 'the waiting first-version text is out of date');
  // Eve is made inactive while her text waits: the claim skips it as inactive.
  const eve = (await db.query('select version from public.staff_members where id = $1', [staff.eve])).rows[0];
  await rpc(db, ids.owner, 'select public.staff_roster_set_staff_status($1, $2, $3, $4, $5)', [staff.eve, 'inactive', eve.version, 'Synthetic leave', rid()]);
  assert.deepEqual((await claim(db)).map(row => row.staff_id), [staff.ava]);
  const after = byName(await messages(db, 'm.revision_id = $1', [second.revision_id]));
  assert.deepEqual([after.Eve.status, after.Eve.reason], ['skipped', 'INACTIVE']);
});

test('claim leases due texts once, record needs the lease, temporary failures retry up to three attempts', async () => {
  const { db } = await firstPublish();
  const [row, ...rest] = await claim(db);
  assert.equal(rest.length, 0, 'only Ava can be texted');
  assert.equal(row.phone, '+61400000001');
  assert.equal(row.attempt, 1);
  assert.equal(row.kind, 'published');
  assert.deepEqual(await claim(db), [], 'a leased text is not leased again');

  assert.deepEqual(await rpc(db, null, 'select public.staff_roster_sms_record($1, $2, true, null, null)', [row.id, '00000000-0000-4000-8000-000000000000']),
    { recorded: false, status: null }, 'another lease cannot record it');
  assert.deepEqual(await record(db, row, false, { retryable: true, error: 'TWILIO_503: busy' }), { recorded: true, status: 'pending' });
  let [stored] = await messages(db, `s.display_name = 'Ava'`);
  assert.deepEqual([stored.status, stored.reason, stored.attempts, stored.lease_token], ['pending', 'TWILIO_503: busy', 1, null]);
  assert.ok(new Date(stored.next_attempt_at) > new Date(stored.updated_at), 'waits before the next try');
  assert.deepEqual(await claim(db), [], 'not due yet');

  for (const attempt of [2, 3]) {
    await db.query('update public.staff_roster_sms_messages set next_attempt_at = now() - interval \'1 second\'');
    const [again] = await claim(db);
    assert.equal(again.attempt, attempt);
    await record(db, again, false, { retryable: true, error: 'NETWORK: reset' });
  }
  [stored] = await messages(db, `s.display_name = 'Ava'`);
  assert.deepEqual([stored.status, stored.reason, stored.attempts], ['failed', 'RETRIES_EXHAUSTED:NETWORK: reset', 3]);
  await db.query('update public.staff_roster_sms_messages set next_attempt_at = now() - interval \'1 second\'');
  assert.deepEqual(await claim(db), [], 'never a fourth attempt');

  // The manager resends: a fresh three attempts, then success with the body recorded.
  const retried = await rpc(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE]);
  assert.deepEqual(retried, { queued: 1, still_skipped: 2 });
  const [fresh] = await claim(db);
  assert.equal(fresh.attempt, 1);
  assert.deepEqual(await record(db, fresh, true, { body: 'XERT: Hi Ava' }), { recorded: true, status: 'sent' });
  [stored] = await messages(db, `s.display_name = 'Ava'`);
  assert.deepEqual([stored.status, stored.body, stored.provider_id, stored.reason], ['sent', 'XERT: Hi Ava', 'SM-synthetic', null]);
  assert.ok(stored.sent_at);
});

test('a permanent failure is not retried; an expired lease goes back to the queue', async () => {
  const { db } = await firstPublish();
  const [row] = await claim(db);
  await db.query(`update public.staff_roster_sms_messages set lease_expires_at = now() - interval '1 second' where id = $1`, [row.id]);
  const [again] = await claim(db);
  assert.equal(again.id, row.id);
  assert.equal(again.attempt, 2, 'the lost attempt counts');
  assert.notEqual(again.lease_token, row.lease_token);
  assert.deepEqual(await record(db, again, false, { error: 'TWILIO_400:21211: invalid To' }), { recorded: true, status: 'failed' });
  await db.query('update public.staff_roster_sms_messages set next_attempt_at = now() - interval \'1 second\'');
  assert.deepEqual(await claim(db), []);
  const status = await rpc(db, ids.owner, 'select public.staff_roster_sms_status($1)', [MONTH_DATE]);
  assert.equal(status.counts.failed, 1);
  assert.equal(status.due, false, 'nothing left to send automatically');
});

test('claim re-checks each coach: opted out, unlinked or switched off since queueing means no text', async () => {
  const { db, staff } = await firstPublish();
  await rpc(db, ids.ava, 'select public.staff_roster_set_sms_preference(false)');
  let [ava] = await messages(db, `s.display_name = 'Ava'`);
  assert.deepEqual([ava.status, ava.reason], ['skipped', 'OPTED_OUT'], 'turning texts off stops a waiting text');
  const prefs = await rpc(db, ids.ava, 'select public.staff_roster_set_sms_preference(true)');
  assert.deepEqual([prefs.sms, prefs.sms_available, prefs.mobile_state, prefs.mobile_ending, prefs.email, prefs.push], [true, true, 'ok', '001', true, true]);

  await db.query(`update public.staff_roster_sms_messages set status = 'pending', reason = null, next_attempt_at = now() where staff_id = $1`, [staff.ava]);
  await db.query('update public.staff_members set profile_id = null where id = $1', [staff.ava]);
  assert.deepEqual(await claim(db), []);
  [ava] = await messages(db, `s.display_name = 'Ava'`);
  assert.deepEqual([ava.status, ava.reason], ['skipped', 'NO_ACCOUNT']);

  await db.query(`update public.staff_roster_sms_messages set status = 'pending', reason = null where staff_id = $1`, [staff.ava]);
  await setSms(db, false);
  [ava] = await messages(db, `s.display_name = 'Ava'`);
  assert.deepEqual([ava.status, ava.reason], ['skipped', 'SMS_SWITCHED_OFF']);
  await db.query(`update public.staff_roster_sms_messages set status = 'pending', reason = null where staff_id = $1`, [staff.ava]);
  assert.deepEqual(await claim(db), [], 'nothing is leased while texting is off');
  await rejects(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE], /SMS_DISABLED/);
});

test('part-month: classes before the roster starts are never listed, and the text says when it starts', async () => {
  const startsOn = day(15);
  const { db, staff } = await smsWorld({ startsOn });
  const before = await addSession(db, day(10), 315, 60, { title: 'Early Engine' });
  const after = await addSession(db, day(16), 315, 60, { title: 'Engine' });
  await apply(db, [assign(after, staff.ava)]);
  await db.query(`update public.profiles set phone = '0400 000 002' where id = $1`, [ids.ben]);
  const published = await publish(db, 'Synthetic gaps');
  assert.equal(published.ok, true, JSON.stringify(published));
  // The roster refuses a coach on a class before the start, but one can be
  // there from before the period was opened. Put Ben on one directly
  // and queue the same revision again from scratch.
  await db.query(`insert into public.staff_assignments (revision_id, session_id, slot_key, role, staff_id) values ($1, $2, 'lead', 'lead', $3)`,
    [published.revision_id, before, staff.ben]);
  await db.query('delete from public.staff_roster_sms_messages');
  assert.equal(await rpc(db, null, 'select public.staff_roster_sms_queue($1)', [published.revision_id]), 1);
  const rows = byName(await messages(db));
  assert.deepEqual(Object.keys(rows), ['Ava'], 'Ben’s only class is before the start, so he has nothing to be told');
  assert.deepEqual(rows.Ava.details.lines.map(line => line.title), ['Engine']);
  assert.equal(rows.Ava.details.starts_on, startsOn);
  assert.match(buildRosterSms(rows.Ava), new RegExp(`your \\w+ classes \\(from ${Number(startsOn.slice(8))} \\w{3}\\): `));
});

test('approving cover publishes a new version and texts the two coaches it changes', async () => {
  const { db, s, staff } = await firstPublish();
  for (const row of await claim(db)) await record(db, row, true);
  await db.query(`update public.profiles set phone = '0400 000 002' where id = $1`, [ids.ben]);
  const assignment = (await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
    where r.state = 'published' and a.session_id = $1`, [s.engine])).rows[0].id;
  const cover = await rpc(db, ids.ava, 'select public.staff_roster_request_cover($1, $2, $3)', [assignment, 'Synthetic reason', rid()]);
  await rpc(db, ids.ben, 'select public.staff_roster_offer_cover($1, $2)', [cover.id, rid()]);
  const offer = (await db.query('select id from public.staff_cover_offers where request_id = $1', [cover.id])).rows[0];
  const coverRow = (await db.query('select version from public.staff_cover_requests where id = $1', [cover.id])).rows[0];
  const approved = await rpc(db, ids.owner, 'select public.staff_roster_approve_cover($1, $2, $3, $4)', [cover.id, offer.id, coverRow.version, rid()]);
  assert.equal(approved.ok, true);
  const rows = byName(await messages(db, 'm.revision_id = $1', [approved.revision_id]));
  // Dee (opted out) and Eve (landline) were never texted: recorded again with why.
  assert.deepEqual(Object.keys(rows).sort(), ['Ava', 'Ben', 'Dee Lane', 'Eve']);
  assert.deepEqual([rows['Dee Lane'].status, rows.Eve.status], ['skipped', 'skipped']);
  assert.deepEqual([rows.Ava.kind, rows.Ava.details.lines.map(line => line.change)], ['changed', ['removed']]);
  assert.deepEqual([rows.Ben.kind, rows.Ben.status], ['published', 'pending'], 'Ben was never texted before, so he gets his whole month');
});

test('grants: claim and record are for the service role only; signed-in users cannot read the outbox; anon gets nothing', async () => {
  const { db } = await firstPublish();
  const { rows } = await db.query(`
    select p.proname,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
      has_function_privilege('service_role', p.oid, 'execute') as service
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'staff\\_roster\\_sms%' or p.proname in ('staff_roster_set_sms_preference', 'staff_roster_my_notice_preferences'))
    order by p.proname`);
  const grants = Object.fromEntries(rows.map(row => [row.proname, [row.anon, row.authenticated, row.service]]));
  assert.deepEqual(grants.staff_roster_sms_claim, [false, false, true]);
  assert.deepEqual(grants.staff_roster_sms_record, [false, false, true]);
  for (const name of ['staff_roster_sms_status', 'staff_roster_sms_set_enabled', 'staff_roster_sms_retry', 'staff_roster_set_sms_preference', 'staff_roster_my_notice_preferences']) {
    assert.deepEqual(grants[name].slice(0, 2), [false, true], `${name}: signed-in users only`);
  }
  for (const name of ['staff_roster_sms_queue', 'staff_roster_sms_on_publish', 'staff_roster_sms_lines', 'staff_roster_sms_changes', 'staff_roster_sms_block_reason', 'staff_roster_sms_phone']) {
    assert.deepEqual(grants[name].slice(0, 2), [false, false], `${name} is internal`);
  }
  const table = (await db.query(`select relrowsecurity as rls,
      has_table_privilege('authenticated', 'public.staff_roster_sms_messages', 'select') as auth_select,
      has_table_privilege('anon', 'public.staff_roster_sms_messages', 'select') as anon_select
    from pg_class where relname = 'staff_roster_sms_messages'`)).rows[0];
  assert.deepEqual(table, { rls: true, auth_select: false, anon_select: false });

  // Even through the manager entry points, a coach is turned away.
  await rejects(db, ids.ava, 'select public.staff_roster_sms_status($1)', [MONTH_DATE], /MANAGER_ONLY/);
  await rejects(db, ids.ava, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE], /MANAGER_ONLY/);
  await rejects(db, ids.member, 'select public.staff_roster_set_sms_preference(false)', [], /NOT_STAFF/);
  await as(db, ids.owner);
});

test('the phone rule matches the server and the browser', async () => {
  const { db } = await smsWorld({ sms: false });
  const { e164AUMobile } = await import('../api/admin-publish-announcement.js');
  for (const value of ['0400 000 001', '+61 400 000 001', '61400000001', '(04) 0000-0001', '07 4162 1234', '+64211234567', '', null, '04000000011', '+61+400000001']) {
    const { rows } = await db.query('select public.staff_roster_sms_phone($1) as phone', [value]);
    assert.equal(rows[0].phone, e164AUMobile(value), `same answer for ${value}`);
  }
});

test('re-running the migration changes nothing; a failure part-way leaves no table and no capability', async () => {
  const { db } = await firstPublish();
  const shape = async () => (await db.query(`select
    (select count(*)::int from public.staff_roster_sms_messages) as messages,
    (select sms_enabled from public.staff_roster_settings) as enabled,
    (select count(*)::int from pg_trigger where tgname = 'staff_roster_revisions_sms') as triggers,
    (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_sms') as capability`)).rows[0];
  const once = await shape();
  await db.exec(SMS);
  assert.deepEqual(await shape(), once);
  assert.deepEqual([once.enabled, once.triggers, once.capability], [true, 1, 1]);

  const fresh = new PGlite();
  await fresh.exec(BASE_SCHEMA);
  for (const url of MIGRATION_URLS.slice(0, MIGRATION_URLS.indexOf(SMS_URL))) await fresh.exec(await readFile(url, 'utf8'));
  const marker = 'insert into public.xert_schema_capabilities';
  await assert.rejects(() => fresh.exec(`begin;\n${SMS.replace(marker, `select 1 / 0;\n${marker}`)}\ncommit;`), /division by zero/);
  await fresh.exec('rollback');
  const { rows } = await fresh.query(`select
    (select count(*)::int from pg_class where relname = 'staff_roster_sms_messages') as tables,
    (select count(*)::int from information_schema.columns where table_name = 'staff_roster_settings' and column_name = 'sms_enabled') as columns,
    (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_sms') as capability`);
  assert.deepEqual(rows, [{ tables: 0, columns: 0, capability: 0 }]);
});

// ─── Convergence: each coach ends up with a correct text for the latest version ─

const titles = row => row.details.lines.map(line => line.change ? `${line.change} ${line.title}` : line.title);
const unassign = async (db, session) => ({ op: 'unassign', assignment_id: await assignmentId(db, session) });
const sendAll = async db => {
  const sent = [];
  for (;;) {
    const batch = await claim(db);
    if (!batch.length) return sent;
    for (const row of batch) { await record(db, row, true); sent.push(row); }
  }
};
async function noDuplicates(db) {
  const { rows } = await db.query('select revision_id, staff_id, count(*)::int as n from public.staff_roster_sms_messages group by 1, 2 having count(*) > 1');
  assert.deepEqual(rows, [], 'at most one row per (revision, coach)');
}
/** Publishes once with the texts queue swapped for one that raises `errcode`, as a cancel or lock timeout at commit would. */
async function publishWithQueueFailing(db, errcode, message) {
  const queue = (await db.query(`select pg_get_functiondef('public.staff_roster_sms_queue(uuid)'::regprocedure) as def`)).rows[0].def;
  await db.exec(`create or replace function public.staff_roster_sms_queue(p_revision uuid) returns integer language plpgsql set search_path = public as $$
    begin raise exception '${message}' using errcode = '${errcode}'; end; $$;`);
  try {
    const result = await publish(db, 'Synthetic gaps');
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  } finally {
    await db.exec(queue);
  }
}

/**
 * D1 from the replica proof. One = Ava, Two = Ben (given a mobile), Three =
 * Eve (a landline), Five = Dee (opted out). Version 3's queueing is cancelled
 * at commit and version 4's times out on the texts lock.
 */
async function d1World({ sendFirst = false } = {}) {
  const env = await smsWorld();
  const { db, staff } = env;
  await db.query(`update public.profiles set phone = '0400 000 002' where id = $1`, [ids.ben]);
  const s = {
    oct9: await addSession(db, day(9), 315, 60, { title: 'Nine' }),
    oct12: await addSession(db, day(12), 315, 60, { title: 'Twelve' }),
    oct14: await addSession(db, day(14), 315, 60, { title: 'Fourteen' }),
    oct16: await addSession(db, day(16), 315, 60, { title: 'Sixteen' }),
    oct18: await addSession(db, day(18), 315, 60, { title: 'Eighteen' }),
    oct20: await addSession(db, day(20), 315, 60, { title: 'Twenty' }),
  };
  // Version 1: One has Oct 9, 12 and 20.
  await apply(db, [assign(s.oct9, staff.ava), assign(s.oct12, staff.ava), assign(s.oct20, staff.ava), assign(s.oct14, staff.eve), assign(s.oct18, staff.dee)]);
  const v1 = await publish(db, 'Synthetic gaps');
  assert.equal(v1.ok, true, JSON.stringify(v1));
  const first = byName(await messages(db, 'm.revision_id = $1', [v1.revision_id]));
  assert.deepEqual([first.Ava.kind, first.Ava.status, titles(first.Ava)], ['published', 'pending', ['Nine', 'Twelve', 'Twenty']]);
  if (sendFirst) assert.deepEqual((await sendAll(db)).map(row => row.staff_id), [staff.ava]);
  // Version 2: One loses Oct 20; Two takes Oct 16.
  await newDraft(db);
  await apply(db, [await unassign(db, s.oct20), assign(s.oct16, staff.ben)]);
  const v2 = await publish(db, 'Synthetic gaps');
  // Version 3, queueing cancelled at commit: Three's Oct 14 goes to Two.
  await newDraft(db);
  await apply(db, [await unassign(db, s.oct14), assign(s.oct14, staff.ben)]);
  const v3 = await publishWithQueueFailing(db, 'query_canceled', 'canceling statement due to user request');
  // Version 4, queueing timed out on the texts lock: Five's Oct 18 is unassigned.
  await newDraft(db);
  await apply(db, [await unassign(db, s.oct18)]);
  const v4 = await publishWithQueueFailing(db, 'lock_not_available', 'canceling statement due to lock timeout');
  assert.deepEqual(await messages(db, 'm.revision_id in ($1, $2)', [v3.revision_id, v4.revision_id]), [], 'versions 3 and 4 queued nothing');
  return { ...env, s, v1, v2, v3, v4 };
}

test('D1: after a cancelled and a timed-out queue, the claim sends One his current list and Two his full list; nothing more after', async () => {
  const { db, staff, v2, v4 } = await d1World();
  const atV2 = byName(await messages(db, 'm.revision_id = $1', [v2.revision_id]));
  assert.deepEqual([atV2.Ava.kind, titles(atV2.Ava)], ['published', ['Nine', 'Twelve']], 'v1 never went, so v2 is One’s whole list, not “removed Oct 20”');
  assert.deepEqual([atV2.Ben.kind, titles(atV2.Ben)], ['published', ['Sixteen']]);

  const sent = await sendAll(db);
  assert.deepEqual(sent.map(row => [row.staff_id, row.kind, row.details.revision, titles(row)]).sort(), [
    [staff.ava, 'published', 4, ['Nine', 'Twelve']],
    [staff.ben, 'published', 4, ['Fourteen', 'Sixteen']],
  ].sort());
  const rows = await messages(db, `s.display_name in ('Ava', 'Ben')`);
  assert.deepEqual(rows.map(row => [row.number, row.name, row.status, row.reason]), [
    [1, 'Ava', 'skipped', 'REPLACED_BY_NEWER'],
    [2, 'Ava', 'skipped', 'REPLACED_BY_NEWER'],
    [2, 'Ben', 'skipped', 'REPLACED_BY_NEWER'],
    [4, 'Ava', 'sent', null],
    [4, 'Ben', 'sent', null],
  ]);
  const latest = byName(await messages(db, 'm.revision_id = $1', [v4.revision_id]));
  assert.deepEqual(Object.keys(latest).sort(), ['Ava', 'Ben'], 'Three and Five have no classes left and were never texted');

  // Resend and further claims change nothing and send nothing.
  const count = (await messages(db)).length;
  assert.deepEqual(await rpc(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE]), { queued: 0, still_skipped: 0 });
  assert.deepEqual(await claim(db), []);
  assert.equal(await rpc(db, null, 'select public.staff_roster_sms_queue($1)', [v4.revision_id]), 0);
  assert.equal((await messages(db)).length, count);
  const status = await rpc(db, ids.owner, 'select public.staff_roster_sms_status($1)', [MONTH_DATE]);
  assert.deepEqual([status.counts.sent, status.counts.pending, status.retryable, status.due], [2, 0, 0, false]);
  await noDuplicates(db);
});

test('D1 with One’s first text sent: he is told only what changed since it; "Resend failed texts" alone also recovers', async () => {
  const { db, staff, v4 } = await d1World({ sendFirst: true });
  // Before any claim, the manager sees the coaches the cancelled queues missed.
  let status = await rpc(db, ids.owner, 'select public.staff_roster_sms_status($1)', [MONTH_DATE]);
  assert.equal(status.retryable, 2, 'One and Two still need a text for the published version');
  const retried = await rpc(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE]);
  assert.equal(retried.queued, 2);
  const latest = byName(await messages(db, 'm.revision_id = $1', [v4.revision_id]));
  assert.deepEqual([latest.Ava.kind, titles(latest.Ava)], ['changed', ['removed Twenty']]);
  assert.deepEqual([latest.Ben.kind, titles(latest.Ben)], ['published', ['Fourteen', 'Sixteen']]);
  const sent = await sendAll(db);
  assert.deepEqual(sent.map(row => row.staff_id).sort(), [staff.ava, staff.ben].sort());
  assert.deepEqual(await rpc(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE]), { queued: 0, still_skipped: 0 });
  assert.deepEqual(await claim(db), []);
  status = await rpc(db, ids.owner, 'select public.staff_roster_sms_status($1)', [MONTH_DATE]);
  assert.equal(status.retryable, 0);
  await noDuplicates(db);
});

test('a sent basis, then two quick publishes: one "changed" text covering both', async () => {
  const { db, s, staff } = await firstPublish();
  await sendAll(db);
  await newDraft(db);
  await apply(db, [assign(s.spare, staff.ava)]);
  const v2 = await publish(db, 'Synthetic gaps');
  await newDraft(db);
  await apply(db, [await unassign(db, s.strength)]);
  const v3 = await publish(db, 'Synthetic gaps');
  const pending = await messages(db, `s.display_name = 'Ava' and m.status = 'pending'`);
  assert.deepEqual(pending.map(row => [row.revision_id, row.kind, titles(row)]), [[v3.revision_id, 'changed', ['added Engine', 'removed Strength']]]);
  const [old] = await messages(db, `s.display_name = 'Ava' and m.revision_id = $1`, [v2.revision_id]);
  assert.deepEqual([old.status, old.reason], ['skipped', 'REPLACED_BY_NEWER']);
  const sent = await sendAll(db);
  assert.deepEqual(sent.map(row => [row.staff_id, row.details.revision, titles(row)]), [[staff.ava, 3, ['added Engine', 'removed Strength']]]);
  assert.deepEqual(await claim(db), []);
  await noDuplicates(db);
});

test('a coach taken off every class after a sent text is told what was removed', async () => {
  const { db, s, staff } = await firstPublish();
  await sendAll(db);
  await newDraft(db);
  await apply(db, [await unassign(db, s.engine), await unassign(db, s.strength)]);
  const v2 = await publish(db, 'Synthetic gaps');
  const [ava] = await messages(db, `s.display_name = 'Ava' and m.revision_id = $1`, [v2.revision_id]);
  assert.deepEqual([ava.kind, ava.status, titles(ava)], ['changed', 'pending', ['removed Engine', 'removed Strength']]);
  assert.match(buildRosterSms(ava), /roster changed: removed .* Engine; removed .* Strength\./);
  const sent = await sendAll(db);
  assert.deepEqual(sent.map(row => row.staff_id), [staff.ava]);
  // Nothing left to tell Ava: retry and claim queue nothing further (Ben and
  // Eve are still skipped for their mobiles).
  assert.deepEqual(await rpc(db, ids.owner, 'select public.staff_roster_sms_retry($1)', [MONTH_DATE]), { queued: 0, still_skipped: 2 });
  assert.deepEqual(await claim(db), []);
  await noDuplicates(db);
});

test('a text already sending is never changed; the next one waits for it and counts from it', async () => {
  const { db, s, staff } = await firstPublish();
  const [leased] = await claim(db);
  await newDraft(db);
  await apply(db, [assign(s.spare, staff.ava)]);
  const v2 = await publish(db, 'Synthetic gaps');
  const [first] = await messages(db, 'm.id = $1', [leased.id]);
  assert.deepEqual([first.status, first.lease_token, first.kind, titles(first)], ['sending', leased.lease_token, 'published', ['Engine', 'Strength']]);
  const [next] = await messages(db, `s.display_name = 'Ava' and m.revision_id = $1`, [v2.revision_id]);
  assert.deepEqual([next.kind, next.status, titles(next)], ['changed', 'pending', ['added Engine']], 'counted from the text going out');
  assert.deepEqual(await claim(db), [], 'waits until the earlier text is done');
  assert.deepEqual(await record(db, leased, true), { recorded: true, status: 'sent' });
  const [again] = await claim(db);
  assert.deepEqual([again.id, again.kind, titles(again)], [next.id, 'changed', ['added Engine']]);
  await noDuplicates(db);
});

test('a text that may have gone (no answer from the SMS service) counts as sent: the next text is just the changes', async () => {
  const { db, s, staff } = await firstPublish();
  const [leased] = await claim(db);
  assert.deepEqual(await record(db, leased, false, { error: 'UNCONFIRMED TIMEOUT: aborted' }), { recorded: true, status: 'failed' });
  await newDraft(db);
  await apply(db, [assign(s.spare, staff.ava)]);
  const v2 = await publish(db, 'Synthetic gaps');
  const [next] = await messages(db, `s.display_name = 'Ava' and m.revision_id = $1`, [v2.revision_id]);
  assert.deepEqual([next.kind, titles(next)], ['changed', ['added Engine']]);
  const [kept] = await messages(db, 'm.id = $1', [leased.id]);
  assert.deepEqual([kept.status, kept.reason], ['failed', 'UNCONFIRMED TIMEOUT: aborted'], 'left as it is');
  await noDuplicates(db);
});

test('MONTH is ahead of today, so these tests never depend on the date they run', () => {
  assert.ok(MONTH_DATE > TODAY);
});
