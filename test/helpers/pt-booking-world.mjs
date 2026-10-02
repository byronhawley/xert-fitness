// Synthetic world for the PT booking database tests: the real staff roster
// migrations plus the real PT booking migration, in PGlite.
// SYNTHETIC DATA ONLY: fictional coaches and clients; no email is ever sent
// (queue_email does not exist here, so PT emails are skipped).
import { readFile } from 'node:fs/promises';

import { world as rosterWorld, ids, rid, rpc, rejects } from './staff-roster-world.mjs';
import { addDays, gymInstantIso } from '../../src/lib/staffRoster/time.js';
import { gymDateKey } from '../../src/lib/gymTime.js';

export { ids, rid, rpc, rejects };

export const PT_MIGRATION_URL = new URL('../../supabase/migrations/20261002030000_pt_booking.sql', import.meta.url);
export const PT_MIGRATION_URLS = [PT_MIGRATION_URL,
  new URL('../../supabase/migrations/20261002080000_pt_start_times_and_members.sql', import.meta.url)];

/** Every PT migration, in order. */
export async function ptMigrationsSql() {
  return (await Promise.all(PT_MIGRATION_URLS.map(url => readFile(url, 'utf8')))).join('\n');
}

export const BLACKOUTS = `
  create table if not exists public.blackout_periods (
    id uuid primary key default gen_random_uuid(), start_time timestamptz not null, end_time timestamptz not null,
    affects text not null default 'all', reason text not null default 'maintenance'
  );
  alter table public.coaches add column if not exists role text, add column if not exists bio text,
    add column if not exists photo_url text, add column if not exists sort_order integer not null default 0;
`;

export const TODAY = gymDateKey(new Date());
/** A gym date `n` days from today. */
export const inDays = n => addDays(TODAY, n);
export const at = (date, minute) => gymInstantIso(date, minute);

export const DIANA = '00000000-0000-4000-8000-0000000000d1';

export async function ptWorld({ enabled = true, rosterEnabled = true } = {}) {
  const { db, staff } = await rosterWorld({ enabled: rosterEnabled });
  await db.exec(BLACKOUTS);
  await db.exec(await ptMigrationsSql());
  await db.exec(`
    insert into public.profiles (id, full_name, email, role) values ('${DIANA}', 'Diana Synthetic', 'diana@example.test', 'member');
    update public.pt_settings set enabled = ${enabled}, max_days_ahead = 120;
  `);
  return { db, staff };
}

/** Ava offers a 60-minute session from 6am to noon every day, 30-minute steps. */
export async function setUpAva(db, { mode = 'instant', buffer = 0, price = 9000 } = {}) {
  const service = await rpc(db, ids.ava, 'select public.pt_coach_save_service($1::jsonb, $2)', [JSON.stringify({
    name: 'One-on-one', duration_minutes: 60, price_cents: price, booking_mode: mode }), rid()]);
  const withPackage = await rpc(db, ids.ava, 'select public.pt_coach_save_package($1::jsonb, $2)', [JSON.stringify({
    service_id: service.id, name: '5 sessions', sessions_count: 5, price_cents: 40000, valid_days: 90 }), rid()]);
  await rpc(db, ids.ava, 'select public.pt_coach_save_hours($1::jsonb, $2, $3)', [
    JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: 360, end: 720 }))), buffer, 0]);
  return { service, packageId: withPackage.packages[0].id };
}

export async function slots(db, serviceId, from, days = 1, uid = null) {
  const result = await rpc(db, uid, 'select public.pt_public_slots($1, $2, $3)', [serviceId, from, days]);
  return result.slots.map(value => new Date(value).toISOString());
}

export function details(extra = {}) {
  return { full_name: 'Casey Client', email: 'casey@example.test', phone: '0400 000 000', ...extra };
}

export async function book(db, serviceId, startsAt, extra = {}, uid = null, requestId = rid()) {
  return rpc(db, uid, 'select public.pt_public_book($1::jsonb, $2)', [JSON.stringify({
    service_id: serviceId, starts_at: startsAt, ...details(extra) }), requestId]);
}
