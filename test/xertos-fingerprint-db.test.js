// Real PostgreSQL (PGlite) tests for the durable XertOS receipt fingerprint.
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
  set search_path = public as $$ select false $$;
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
    public_visible boolean not null default true, booking_mode text not null default 'request_to_book',
    notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table public.session_bookings (
    id uuid primary key default gen_random_uuid(), class_session_id uuid, status text,
    credit_batch_id uuid, cancelled_at timestamptz, created_at timestamptz not null default now()
  );
  create table public.credit_batches (id uuid primary key, remaining integer not null default 0);
  create function public.class_places_held(p_session_id uuid)
  returns table(held bigint) language sql stable as $$
    select count(*)::bigint from public.session_bookings
    where class_session_id = p_session_id and status in ('requested', 'confirmed')
  $$;
  create function public.create_class_cancellation_notice(p_session_id uuid)
  returns integer language plpgsql as $$ begin return 0; end $$;
  create table public.xert_schema_capabilities (capability text primary key, installed_at timestamptz not null default now());
`;

async function database() {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(await readFile(new URL('../supabase/migrations/20261004010000_xertos_class_sync.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261009010000_xertos_receipt_fingerprint.sql', import.meta.url), 'utf8'));
  await db.query(`insert into public.class_templates (class_type, title, capacity) values ('XERT Strength', 'Strength', 8)`);
  await db.query(`
    insert into public.class_sessions (
      id, class_type, title, start_time, end_time, duration_minutes, capacity, updated_at
    ) values (
      '00000000-0000-4000-8000-00000000d1a5', 'XERT Strength', 'Strength',
      '2026-10-10T05:15:00Z', '2026-10-10T06:15:00Z', 60, 8, '2026-10-09T00:00:00Z'
    )
  `);
  await db.query(`update public.xertos_sync_settings set enabled = true`);
  return { db, sessionId: '00000000-0000-4000-8000-00000000d1a5' };
}

const target = '/api/stripe-webhook?provider=xertos';
const edit = (changes, requestId = 'req-durable') => JSON.stringify({
  action: 'update', externalId: '00000000-0000-4000-8000-00000000d1a5',
  expectedUpdatedAt: '2026-10-09T00:00:00.000Z', changes, requestId,
});
const fingerprint = (body, requestId = 'req-durable') => xertosRequestFingerprint({ method: 'POST', target, rawBody: body });

async function apply(db, body, sentFingerprint = fingerprint(body), requestId = 'req-durable') {
  const payload = JSON.parse(body);
  payload.externalId = '00000000-0000-4000-8000-00000000d1a5';
  return db.query('select public.xertos_sync_apply_edit($1::jsonb, $2::text) as answer', [
    JSON.stringify(payload), sentFingerprint,
  ]);
}

test('durable fingerprints replay the original answer and refuse a changed body', async () => {
  const { db, sessionId } = await database();
  const body = edit({ capacity: 10 });
  const first = await apply(db, body);
  assert.equal(first.rows[0].answer.class.capacity, 10);
  const stored = await db.query(`select request_fingerprint from public.xertos_edit_receipts where request_id = 'req-durable'`);
  assert.equal(stored.rows[0].request_fingerprint, fingerprint(body));

  // A later owner-side change must not rewrite the original replay answer.
  await db.query(`update public.class_sessions set capacity = 12 where id = $1`, [sessionId]);
  const replay = await apply(db, body);
  assert.equal(replay.rows[0].answer.class.capacity, 10);

  const changed = edit({ capacity: 13 });
  await assert.rejects(() => apply(db, changed), /IDEMPOTENCY_KEY_REUSED/);
  const after = await db.query(`select capacity from public.class_sessions where id = $1`, [sessionId]);
  assert.equal(after.rows[0].capacity, 12);
  assert.equal((await db.query(`select count(*)::int as n from public.xertos_edit_receipts where request_id = 'req-durable'`)).rows[0].n, 1);
});

test('equivalent JSON bytes do not collide, and malformed or legacy fingerprints fail closed', async () => {
  const { db } = await database();
  const compact = edit({ capacity: 10 }, 'req-bytes');
  const spaced = edit({ capacity: 10 }, 'req-bytes').replace('"capacity":10', '"capacity": 10');
  assert.notEqual(compact, spaced);
  await apply(db, compact);
  await assert.rejects(() => apply(db, spaced), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(
    () => apply(db, edit({ capacity: 11 }, 'req-invalid'), 'xertos-calendar-request-v1\nPOST\n/api\nbad'),
    /INVALID_REQUEST_FINGERPRINT/,
  );

  const legacyId = 'legacy-receipt';
  await db.query(`
    insert into public.xertos_edit_receipts (request_id, action, answer)
    values ($1, 'update', '{"class":{"externalId":"legacy"}}')
  `, [legacyId]);
  // The retained two-argument execution path must reject null legacy evidence;
  // the retired one-argument overload is only a separate fail-closed guard.
  await assert.rejects(
    () => db.query('select public.xertos_sync_apply_edit($1::jsonb, $2::text) as answer', [
      JSON.stringify({
        action: 'update', externalId: '00000000-0000-4000-8000-00000000d1a5',
        expectedUpdatedAt: '2026-10-09T00:00:00Z', requestId: legacyId,
      }),
      fingerprint(edit({ capacity: 10 }, legacyId)),
    ]),
    /IDEMPOTENCY_RECEIPT_UNVERIFIABLE/,
  );
  const unchanged = await db.query(`select capacity from public.class_sessions where id = '00000000-0000-4000-8000-00000000d1a5'`);
  assert.equal(unchanged.rows[0].capacity, 10, 'legacy rejection leaves the owner class at its current state');
  const evidence = await db.query(`select request_fingerprint from public.xertos_edit_receipts where request_id = $1`, [legacyId]);
  assert.equal(evidence.rows[0].request_fingerprint, null);
});
