-- XERT Roster: FULL REMOVAL of the staff roster schema.
--
-- NOT A MIGRATION. Run by hand only after a backup, and only if switching the
-- feature off (staff_roster_settings.enabled = false) is not enough.
-- It permanently deletes coach records, availability, rosters, cover, notices
-- and the roster audit trail. Class sessions, bookings, payments, the website
-- Coaches page and class_sessions.coach_name are left untouched (names the
-- roster wrote onto classes stay as ordinary class text).
--
-- Covers both roster migrations: 20261001010000_staff_roster.sql and
-- 20261002010000_staff_roster_push_reliability.sql (its functions are named
-- staff_roster_push_* and are dropped by the loop below; its trigger and
-- columns go with the staff_notifications and push-delivery tables).
--
-- If the push dispatch schedule was ever activated
-- (docs/staff-roster/push-dispatch-schedule.sql), unschedule it FIRST:
--   select cron.unschedule('staff-roster-push-dispatch');
-- otherwise the job keeps calling a function that no longer exists.
--
-- After running it, also revert the app release that lists `staff_roster` and
-- `staff_roster_push_reliability` as required capabilities, or the release
-- gate will report them missing.

begin;

drop trigger if exists class_sessions_staff_roster_changes on public.class_sessions;

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
  public.staff_notification_push_deliveries, public.staff_roster_public_names, public.staff_roster_change_requests, public.staff_roster_requests,
  public.staff_notifications, public.staff_roster_audit_events, public.staff_roster_acknowledgements,
  public.staff_cover_offers, public.staff_cover_requests, public.staff_absences, public.staff_assignments,
  public.staff_roster_revisions, public.class_schedule_series, public.staff_session_staffing,
  public.staff_class_type_staffing, public.staff_roster_reopenings, public.staff_roster_periods,
  public.staff_session_responses, public.staff_availability_windows, public.staff_availability_submissions,
  public.staff_availability_drafts, public.staff_weekly_patterns, public.staff_capabilities,
  public.staff_members, public.staff_roster_settings
cascade;

delete from public.xert_schema_capabilities where capability in ('staff_roster', 'staff_roster_push_reliability');

commit;
