-- XERT Roster: FULL REMOVAL of the staff roster schema.
--
-- NOT A MIGRATION. Run by hand only after a backup, and only if switching the
-- feature off (staff_roster_settings.enabled = false) is not enough.
-- It permanently deletes coach records, availability, rosters, cover, notices
-- and the roster audit trail. Class sessions, bookings, payments, the website
-- Coaches page and class_sessions.coach_name are left untouched (names the
-- roster wrote onto classes stay as ordinary class text).
--
-- Covers all three roster migrations: 20261001010000_staff_roster.sql,
-- 20261002010000_staff_roster_push_reliability.sql (its functions are named
-- staff_roster_push_* and are dropped by the loop below; its trigger and
-- columns go with the staff_notifications and push-delivery tables) and
-- 20261002020000_staff_roster_coach_dashboard.sql (invites and the coach
-- dashboard: staff_roster_* functions, dropped by the loop; its tables are
-- listed below). It drops that migration's four storage policies
-- (staff_certificates_owner_insert / _owner_or_manager_read / _owner_delete and
-- site_images_staff_profile_insert) but leaves the private `staff-certificates`
-- bucket and its files: remove those in the Storage dashboard if wanted
-- (certificate files are personal records; export them first).
-- Website coach profiles approved from coach drafts stay in public.coaches.
--
-- Also covers 20261002040000_staff_roster_part_month.sql (part-month periods):
-- its staff_roster_periods.starts_on column and the staff_roster_periods_order
-- and staff_roster_periods_starts_on checks go with the staff_roster_periods
-- table, and its staff_roster_open_part_month function (and the four roster
-- functions it replaced) are dropped by the loop below.
--
-- Also covers 20261002050000_staff_roster_sms.sql (roster text messages): its
-- staff_roster_sms_messages table is dropped below (the record of texts sent;
-- export it first if you need it), its functions and the deferred
-- staff_roster_revisions_sms trigger go with the loop and the revisions table,
-- and the sms_enabled / sms columns go with their tables.
--
-- Refuses to run while PT booking (capability `pt_booking`) is installed: its
-- tables reference staff_members and would be broken by the cascade.
--
-- If the push dispatch schedule was ever activated
-- (docs/staff-roster/push-dispatch-schedule.sql), unschedule it FIRST:
--   select cron.unschedule('staff-roster-push-dispatch');
-- otherwise the job keeps calling a function that no longer exists.
--
-- After running it, also revert the app release that lists `staff_roster`,
-- `staff_roster_push_reliability`, `staff_roster_coach_dashboard`,
-- `staff_roster_part_month` and `staff_roster_sms` as required capabilities, or the release gate will
-- report them missing.

begin;

-- PT booking (pt_* tables) hangs off staff_members. Dropping the roster would
-- cascade into it and leave PT booking broken, so remove PT booking first with
-- its own rollback, then run this.
do $guard$
begin
  if to_regclass('public.xert_schema_capabilities') is not null
     and exists (select 1 from public.xert_schema_capabilities where capability = 'pt_booking') then
    raise exception 'PT booking is installed. Remove it with its own rollback before removing the roster.';
  end if;
end;
$guard$;

drop trigger if exists class_sessions_staff_roster_changes on public.class_sessions;

do $storage$
begin
  if to_regclass('storage.objects') is null then return; end if;
  execute 'drop policy if exists "staff_certificates_owner_insert" on storage.objects';
  execute 'drop policy if exists "staff_certificates_owner_or_manager_read" on storage.objects';
  execute 'drop policy if exists "staff_certificates_owner_delete" on storage.objects';
  execute 'drop policy if exists "site_images_staff_profile_insert" on storage.objects';
end;
$storage$;

do $rollback$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'staff_roster%' or p.proname = 'staff_members_prevent_delete')
  loop
    execute format('drop function if exists %s cascade', v_fn.signature);
  end loop;
end;
$rollback$;

drop index if exists public.class_sessions_series_occurrence_unique;
alter table public.class_sessions drop column if exists series_occurrence_date;
alter table public.class_sessions drop column if exists series_id;

drop table if exists
  public.staff_roster_sms_messages,
  public.staff_roster_invite_attempts, public.staff_roster_invites, public.staff_profile_drafts,
  public.staff_certificates, public.staff_session_notes, public.staff_notice_preferences,
  public.staff_notification_push_deliveries, public.staff_roster_public_names, public.staff_roster_change_requests, public.staff_roster_requests,
  public.staff_notifications, public.staff_roster_audit_events, public.staff_roster_acknowledgements,
  public.staff_cover_offers, public.staff_cover_requests, public.staff_absences, public.staff_assignments,
  public.staff_roster_revisions, public.class_schedule_series, public.staff_session_staffing,
  public.staff_class_type_staffing, public.staff_roster_reopenings, public.staff_roster_periods,
  public.staff_session_responses, public.staff_availability_windows, public.staff_availability_submissions,
  public.staff_availability_drafts, public.staff_weekly_patterns, public.staff_capabilities,
  public.staff_members, public.staff_roster_settings
cascade;

delete from public.xert_schema_capabilities where capability in ('staff_roster', 'staff_roster_push_reliability', 'staff_roster_coach_dashboard', 'staff_roster_part_month', 'staff_roster_sms');

commit;
