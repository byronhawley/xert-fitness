// The forward migration 20261002010000_staff_roster_push_reliability.sql:
// additive, idempotent, all-or-nothing, and honest about rows written by the
// first release. SYNTHETIC DATA.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { BASE_SCHEMA, MIGRATION_URLS } from './helpers/staff-roster-db.mjs';
import { PUSH_TABLE, deliveries, fakeAPNs, pgAdmin, APNS_ENV } from './helpers/staff-roster-push-kit.mjs';
import { dispatchStaffRosterPushes } from '../src/lib/staffRosterPush.js';
import { ids } from './helpers/staff-roster-world.mjs';

const [FIRST, FORWARD] = await Promise.all(MIGRATION_URLS.map(url => readFile(url, 'utf8')));

async function firstReleaseOnly() {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(PUSH_TABLE);
  await db.exec(FIRST);
  return db;
}

const statements = sql => sql.replace(/--[^\n]*/g, '').split(/;\s*\n/).map(part => part.trim()).filter(Boolean);

test('it starts with a lock timeout and records its capability as the very last statement', () => {
  const parts = statements(FORWARD);
  assert.equal(parts[0], "set lock_timeout = '5s'");
  assert.match(parts.at(-1), /^insert into public\.xert_schema_capabilities \(capability\) values \('staff_roster_push_reliability'\) on conflict \(capability\) do nothing;?$/);
  assert.equal(FORWARD.match(/xert_schema_capabilities/g).length, 1);
  assert.doesNotMatch(FORWARD, /cron\.schedule|net\.http_post|vault\./, 'the scheduler is a separate, not-applied file');
});

test('a failure part-way through leaves nothing behind and no capability (one implicit transaction)', async () => {
  const db = await firstReleaseOnly();
  const marker = 'insert into public.xert_schema_capabilities';
  const broken = FORWARD.replace(marker, `select 1 / 0;\n${marker}`);
  await assert.rejects(() => db.exec(broken), /division by zero/);
  const { rows } = await db.query(`select
      (select count(*)::int from public.xert_schema_capabilities where capability = 'staff_roster_push_reliability') as capability,
      (select count(*)::int from information_schema.columns where table_name = 'staff_notification_push_deliveries' and column_name = 'lease_token') as lease_column,
      (select count(*)::int from pg_proc where proname = 'staff_roster_push_claim') as claim_fn,
      (select count(*)::int from pg_trigger where tgname = 'staff_notifications_push_enqueue') as enqueue_trigger`);
  assert.deepEqual(rows, [{ capability: 0, lease_column: 0, claim_fn: 0, enqueue_trigger: 0 }]);
  await db.exec(FORWARD);
  assert.equal((await db.query(`select count(*)::int as n from public.xert_schema_capabilities where capability = 'staff_roster_push_reliability'`)).rows[0].n, 1);
});

test('applying it twice changes nothing the second time', async () => {
  const db = await firstReleaseOnly();
  await db.exec(FORWARD);
  const snapshot = async () => (await db.query(`select
      (select string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, ''), ',' order by column_name) from information_schema.columns where table_name = 'staff_notification_push_deliveries') as columns,
      (select string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname) from pg_constraint where conrelid = 'public.staff_notification_push_deliveries'::regclass) as constraints,
      (select string_agg(proname, ',' order by proname) from pg_proc where proname like 'staff_roster_push%') as functions,
      (select count(*)::int from pg_trigger where tgname = 'staff_notifications_push_enqueue') as triggers,
      (select count(*)::int from public.xert_schema_capabilities) as capabilities`)).rows[0];
  const once = await snapshot();
  await db.exec(FORWARD);
  assert.deepEqual(await snapshot(), once);
});

test('rows the first release left in "sending" are recovered as uncertain, never resent; its old failures stay as they were', async () => {
  const db = await firstReleaseOnly();
  await db.exec(`
    insert into public.profiles (id, full_name, email, role) values ('${ids.owner}', 'Owner', 'o@example.test', 'admin');
    update public.staff_roster_settings set enabled = true;`);
  await db.query(`insert into public.push_subscriptions (user_id, device_token, environment) values ($1, $2, 'production'), ($1, $3, 'production')`, [ids.owner, 'a'.repeat(64), 'b'.repeat(64)]);
  await db.query(`insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link) values ($1, 'overdue_summary', 'synthetic:legacy', 'T', 'B', '/admin/roster?rosterTab=availability')`, [ids.owner]);
  // The first release claimed both devices; one was recorded as failed, one never recorded.
  const claimed = (await db.query('select public.staff_roster_claim_push_deliveries($1, 10) as r', [ids.owner])).rows[0].r;
  await db.query('select public.staff_roster_record_push_results($1::jsonb)', [JSON.stringify([{ delivery_id: claimed[0].delivery_id, status: 'failed', reason: 'InternalServerError' }])]);
  await db.query(`update public.staff_notification_push_deliveries set claimed_at = now() - interval '11 minutes' where status = 'sending'`);

  await db.exec(FORWARD);
  const apns = fakeAPNs();
  await dispatchStaffRosterPushes({ admin: pgAdmin(db), environment: APNS_ENV, connect: apns.connect });
  assert.equal(apns.sent.length, 0);
  assert.deepEqual((await deliveries(db)).map(row => [row.status, row.reason]).sort(), [['failed', 'InternalServerError'], ['uncertain', 'LEASE_EXPIRED_AFTER_SEND']]);
});
