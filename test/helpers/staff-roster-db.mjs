// Runs the real staff roster migration inside PGlite (PostgreSQL in WASM)
// over a minimal stand-in for the XERT tables it builds on. SYNTHETIC DATA.
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL('../../supabase/migrations/20261001010000_staff_roster.sql', import.meta.url);

export const BASE_SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid
  $$;
  create table public.profiles (
    id uuid primary key, full_name text, email text, role text not null default 'member',
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  $$;
  create table public.coaches (id uuid primary key default gen_random_uuid(), name text not null);
  create table public.class_templates (id uuid primary key default gen_random_uuid(), name text, class_type text, title text,
    duration_minutes integer, capacity integer, default_start_minute integer);
  create table public.class_sessions (
    id uuid primary key default gen_random_uuid(),
    class_type text not null default 'XERT Strength', title text not null default 'Synthetic class',
    description text, coach_name text,
    start_time timestamptz, end_time timestamptz, duration_minutes integer not null default 60,
    capacity integer not null default 8, location_zone text, beginner_friendly boolean not null default false,
    intensity_level text not null default 'Moderate', status text not null default 'published',
    public_visible boolean not null default true, booking_mode text not null default 'instant_book', notes text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table public.xert_schema_capabilities (capability text primary key, installed_at timestamptz not null default now());
`;

export async function migratedDatabase({ extraSql = '' } = {}) {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(extraSql);
  await db.exec(await readFile(migrationUrl, 'utf8'));
  return db;
}

export async function as(db, uid) {
  await db.query(`select set_config('test.uid', $1, false)`, [uid || '']);
}
