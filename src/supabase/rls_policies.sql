-- ============================================================================
-- XERT Fitness — Row Level Security policies (hardened baseline)
-- ============================================================================
-- Run in the Supabase dashboard:  SQL Editor → New query → paste → Run.
--
-- Model:
--   • Public (anon) visitors may ONLY insert into the lead / booking / request
--     tables — exactly what the public forms do. They cannot read, update or
--     delete anything.
--   • Admin access requires public.is_admin() — a signed-in Supabase Auth user
--     whose public.profiles row has role = 'admin'. Ordinary signed-in members
--     get NO admin access to these tables.
--
-- This file is aligned with rls_hardening.sql: every admin-scope policy here
-- is identical to the hardened version, so running this file never downgrades
-- a hardened database back to "any authenticated user is an admin".
--
-- Idempotent for the policies it owns (each is dropped before being
-- recreated), but note the runtime dependency: public.is_admin() reads
-- public.profiles, which is created by booking_schema.sql. On a fresh
-- database run this file first, then booking_schema.sql (which also
-- recreates is_admin() with the same definition), then the remaining schema
-- files, and finish with rls_hardening.sql — see README.md. Until
-- booking_schema.sql has run, admin-scope queries will error (fail closed);
-- public form INSERTs are unaffected.
-- ============================================================================


-- ── Helper: role-gated admin check ───────────────────────────────────────────
-- Same definition as booking_schema.sql / used by rls_hardening.sql.
-- SECURITY DEFINER so the profiles lookup bypasses RLS (avoids policy
-- recursion). check_function_bodies is disabled while creating it because
-- public.profiles may not exist yet on a fresh database; the body is only
-- executed at query time, after booking_schema.sql has created the table.
-- ----------------------------------------------------------------------------
set check_function_bodies = off;

create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

reset check_function_bodies;


-- ── Tables that the PUBLIC forms insert into ─────────────────────────────────
-- member_interest, trainer_interest, partner_interest, class_bookings,
-- private_session_requests  → public INSERT + admin-only full access
-- ----------------------------------------------------------------------------

-- member_interest -----------------------------------------------------------
alter table public.member_interest enable row level security;
drop policy if exists "public_insert_member_interest" on public.member_interest;
drop policy if exists "admin_all_member_interest" on public.member_interest;
create policy "public_insert_member_interest" on public.member_interest
  for insert to anon, authenticated
  with check (status = 'new' and consent_to_contact is true);
create policy "admin_all_member_interest" on public.member_interest
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- trainer_interest ----------------------------------------------------------
alter table public.trainer_interest enable row level security;
drop policy if exists "public_insert_trainer_interest" on public.trainer_interest;
drop policy if exists "admin_all_trainer_interest" on public.trainer_interest;
create policy "public_insert_trainer_interest" on public.trainer_interest
  for insert to anon, authenticated
  with check (status = 'new' and consent_to_contact is true);
create policy "admin_all_trainer_interest" on public.trainer_interest
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- partner_interest ----------------------------------------------------------
alter table public.partner_interest enable row level security;
drop policy if exists "public_insert_partner_interest" on public.partner_interest;
drop policy if exists "admin_all_partner_interest" on public.partner_interest;
create policy "public_insert_partner_interest" on public.partner_interest
  for insert to anon, authenticated
  with check (status = 'new' and consent_to_contact is true);
create policy "admin_all_partner_interest" on public.partner_interest
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- class_bookings (legacy request-to-book) -------------------------------------
alter table public.class_bookings enable row level security;
drop policy if exists "public_insert_class_bookings" on public.class_bookings;
drop policy if exists "admin_all_class_bookings" on public.class_bookings;
create policy "public_insert_class_bookings" on public.class_bookings
  for insert to anon, authenticated
  with check (status = 'requested' and consent_to_contact is true);
create policy "admin_all_class_bookings" on public.class_bookings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- private_session_requests --------------------------------------------------
alter table public.private_session_requests
  add column if not exists user_id uuid references auth.users(id) on delete set null default auth.uid();
alter table public.private_session_requests enable row level security;
drop policy if exists "public_insert_private_session_requests" on public.private_session_requests;
drop policy if exists "admin_all_private_session_requests" on public.private_session_requests;
create policy "public_insert_private_session_requests" on public.private_session_requests
  for insert to anon, authenticated
  with check (
    status = 'requested'
    and consent_to_contact is true
    and (
      ((select auth.uid()) is null and user_id is null)
      or ((select auth.uid()) is not null and user_id = (select auth.uid()))
    )
  );
create policy "admin_all_private_session_requests" on public.private_session_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- ── class_sessions ──────────────────────────────────────────────────────────
-- The public site shows live, publicly-visible classes (getClassSessions with
-- publicOnly=true). So: public may READ only visible rows that are published
-- or full; admins get full access.
-- ----------------------------------------------------------------------------
alter table public.class_sessions enable row level security;
drop policy if exists "public_read_published_class_sessions" on public.class_sessions;
drop policy if exists "admin_all_class_sessions" on public.class_sessions;
-- 'full' is a live, listed class: the timetable offers its waitlist. Widened by
-- supabase/migrations/20260906030000_booking_repair_followups.sql; kept in step
-- here so re-running this file cannot quietly hide full classes again.
create policy "public_read_published_class_sessions" on public.class_sessions
  for select to anon, authenticated
  using (public_visible = true and status in ('published', 'full'));
create policy "admin_all_class_sessions" on public.class_sessions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- ── admin_settings ──────────────────────────────────────────────────────────
-- The public Home page reads soft-launch settings (countdown, banner, etc.),
-- so anon needs SELECT here; only admins may write.
-- ----------------------------------------------------------------------------
alter table public.admin_settings enable row level security;
drop policy if exists "public_read_admin_settings" on public.admin_settings;
drop policy if exists "admin_write_admin_settings" on public.admin_settings;
drop policy if exists "admin_update_admin_settings" on public.admin_settings;
drop policy if exists "admin_insert_admin_settings" on public.admin_settings;
create policy "public_read_admin_settings" on public.admin_settings
  for select to anon, authenticated using (true);
create policy "admin_update_admin_settings" on public.admin_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin_insert_admin_settings" on public.admin_settings
  for insert to authenticated with check (public.is_admin());


-- ============================================================================
-- Done. After running:
--   • Public forms still submit (anon INSERT allowed).
--   • Public site still shows the countdown/banner and published classes.
--   • Every admin read/edit requires a signed-in user with
--     profiles.role = 'admin' (public.is_admin()).
-- Still run rls_hardening.sql afterwards: it additionally protects
-- profiles-column privileges and the availability/blackout tables.
-- ============================================================================
