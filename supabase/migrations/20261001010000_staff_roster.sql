-- ============================================================================
-- XERT Roster — coach availability, staffing, revisions, absences and cover
-- ============================================================================
-- Additive and idempotent. Creates no class sessions, changes no booking,
-- waitlist, attendance, credit or payment record, and ships switched off
-- (`staff_roster_settings.enabled = false`).
--
-- Naming: everything here is the *staff* roster. The existing member attendee
-- roster (`admin_session_roster`, class sign-ups) is a different thing and is
-- not touched.
--
-- Authority:
--   * Sessions are `public.class_sessions` (the Class calendar). Assignments
--     reference `class_sessions.id`; the roster never moves or cancels a class.
--   * Hard assignment rules live in one function,
--     `staff_roster_assignment_problems`, called by every mutation: manual
--     changes, accepted suggestions, publication and cover approval.
--   * All roster mutations take one transaction-scoped advisory lock and are
--     idempotent by client request id.
--   * Tables are reachable only through these security-definer functions;
--     direct table access is revoked from anon and authenticated.
-- ============================================================================


-- ─── Settings ───────────────────────────────────────────────────────────────

create table if not exists public.staff_roster_settings (
  id smallint primary key default 1,
  enabled boolean not null default false,
  class_time_presets jsonb not null default '[{"minute":315},{"minute":375},{"minute":570},{"minute":990},{"minute":1050}]'::jsonb,
  cycle jsonb not null default '{"openMonthsBefore":2,"openDay":1,"dueMonthsBefore":2,"dueDay":20,"publishMonthsBefore":1,"publishDay":1}'::jsonb,
  reminders jsonb not null default '{"onOpen":true,"daysBeforeDue":[3],"onDue":true,"overdueSummary":true,"sendMinute":540}'::jsonb,
  allow_if_needed_fallback boolean not null default true,
  email_notices_enabled boolean not null default false,
  -- Off by default: when on, publishing writes the lead coach's public name
  -- onto the class (the existing class_sessions.coach_name the timetable shows).
  public_coach_names_enabled boolean not null default false,
  version integer not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint staff_roster_settings_singleton check (id = 1),
  constraint staff_roster_settings_presets_array check (jsonb_typeof(class_time_presets) = 'array' and jsonb_array_length(class_time_presets) <= 24)
);
insert into public.staff_roster_settings (id) values (1) on conflict (id) do nothing;

-- ─── Staff ──────────────────────────────────────────────────────────────────

create table if not exists public.staff_members (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete set null,
  coach_id uuid references public.coaches(id) on delete set null,
  display_name text not null,
  legacy_label text,
  roles text[] not null default array['lead']::text[],
  status text not null default 'active',
  target_classes_per_month integer,
  min_classes_per_month integer,
  max_classes_per_week integer,
  max_duty_minutes_per_day integer,
  min_rest_minutes integer,
  manager_note text,
  deactivated_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint staff_members_name_check check (char_length(btrim(display_name)) between 1 and 80),
  constraint staff_members_roles_check check (cardinality(roles) between 1 and 3 and roles <@ array['lead','assistant','shadow']::text[]),
  constraint staff_members_status_check check (status in ('active', 'inactive')),
  constraint staff_members_target_check check (target_classes_per_month is null or target_classes_per_month between 0 and 400),
  constraint staff_members_min_check check (min_classes_per_month is null or min_classes_per_month between 0 and 400),
  constraint staff_members_week_check check (max_classes_per_week is null or max_classes_per_week between 1 and 100),
  constraint staff_members_day_check check (max_duty_minutes_per_day is null or max_duty_minutes_per_day between 15 and 1440),
  constraint staff_members_rest_check check (min_rest_minutes is null or min_rest_minutes between 0 and 1440),
  constraint staff_members_note_check check (coalesce(char_length(manager_note), 0) <= 2000)
);
create unique index if not exists staff_members_profile_unique on public.staff_members (profile_id) where profile_id is not null;
create unique index if not exists staff_members_coach_unique on public.staff_members (coach_id) where coach_id is not null;

create table if not exists public.staff_capabilities (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  capability text not null,
  valid_from timestamptz,
  valid_until timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint staff_capabilities_name_check check (capability ~ '^[a-z0-9_]{1,40}$'),
  constraint staff_capabilities_range_check check (valid_from is null or valid_until is null or valid_until > valid_from)
);
create index if not exists staff_capabilities_staff_idx on public.staff_capabilities (staff_id, capability);

-- Staff are archived, never deleted: their history must survive.
create or replace function public.staff_members_prevent_delete()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'STAFF_ARCHIVE_INSTEAD';
end;
$$;
drop trigger if exists staff_members_no_delete on public.staff_members;
create trigger staff_members_no_delete before delete on public.staff_members
  for each row execute function public.staff_members_prevent_delete();

-- ─── Availability ───────────────────────────────────────────────────────────

-- The coach's editable "usual week". Never read by validation directly; only
-- a submitted monthly snapshot counts.
create table if not exists public.staff_weekly_patterns (
  staff_id uuid primary key references public.staff_members(id) on delete cascade,
  pattern jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint staff_weekly_patterns_array check (jsonb_typeof(pattern) = 'array' and jsonb_array_length(pattern) <= 200)
);

create table if not exists public.staff_availability_drafts (
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  month date not null,
  payload jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (staff_id, month),
  constraint staff_availability_drafts_month check (extract(day from month) = 1),
  constraint staff_availability_drafts_size check (octet_length(payload::text) <= 64000)
);

create table if not exists public.staff_availability_submissions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  month date not null,
  version integer not null,
  payload jsonb not null,
  no_availability boolean not null default false,
  late boolean not null default false,
  reviewed_sessions jsonb not null default '[]'::jsonb,
  submitted_by uuid,
  submitted_at timestamptz not null default now(),
  constraint staff_availability_submissions_month check (extract(day from month) = 1),
  constraint staff_availability_submissions_version unique (staff_id, month, version)
);

create table if not exists public.staff_availability_windows (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.staff_availability_submissions(id) on delete cascade,
  staff_id uuid not null,
  month date not null,
  during tstzrange not null,
  status text not null,
  source text not null,
  constraint staff_availability_windows_status check (status in ('PREFERRED', 'AVAILABLE', 'IF_NEEDED', 'UNAVAILABLE')),
  constraint staff_availability_windows_source check (source in ('weekly', 'exception', 'month')),
  constraint staff_availability_windows_nonempty check (not isempty(during))
);
create index if not exists staff_availability_windows_lookup on public.staff_availability_windows (staff_id, month, submission_id);

-- A session-specific answer counts only while the duty it answered and the
-- coach's date exceptions for that day are unchanged.
create table if not exists public.staff_session_responses (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  status text not null,
  duty tstzrange not null,
  exception_fingerprint text not null,
  source text not null default 'coach',
  created_at timestamptz not null default now(),
  constraint staff_session_responses_status check (status in ('PREFERRED', 'AVAILABLE', 'IF_NEEDED', 'UNAVAILABLE')),
  constraint staff_session_responses_source check (source in ('coach', 'cover_offer')),
  constraint staff_session_responses_unique unique (staff_id, session_id)
);

-- ─── Planning periods ───────────────────────────────────────────────────────

create table if not exists public.staff_roster_periods (
  month date primary key,
  opens_on date not null,
  due_on date not null,
  publish_target_on date not null,
  shortened boolean not null default false,
  opened_by uuid,
  opened_at timestamptz not null default now(),
  version integer not null default 1,
  constraint staff_roster_periods_month check (extract(day from month) = 1),
  constraint staff_roster_periods_order check (opens_on <= due_on and due_on <= publish_target_on and due_on < month)
);

create table if not exists public.staff_roster_reopenings (
  id uuid primary key default gen_random_uuid(),
  month date not null references public.staff_roster_periods(month) on delete cascade,
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  reason text not null,
  reopened_by uuid,
  reopened_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint staff_roster_reopenings_reason check (char_length(btrim(reason)) between 1 and 500)
);
create unique index if not exists staff_roster_reopenings_open on public.staff_roster_reopenings (month, staff_id) where closed_at is null;

-- ─── Staffing demand ────────────────────────────────────────────────────────

create table if not exists public.staff_class_type_staffing (
  class_type text primary key,
  slots jsonb not null,
  prep_minutes integer not null default 0,
  wrap_minutes integer not null default 0,
  allow_block boolean not null default true,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint staff_class_type_staffing_minutes check (prep_minutes between 0 and 240 and wrap_minutes between 0 and 240)
);

create table if not exists public.staff_session_staffing (
  session_id uuid primary key references public.class_sessions(id) on delete cascade,
  slots jsonb not null,
  prep_minutes integer not null default 0,
  wrap_minutes integer not null default 0,
  allow_block boolean not null default true,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint staff_session_staffing_minutes check (prep_minutes between 0 and 240 and wrap_minutes between 0 and 240)
);

-- ─── Recurring schedule (templates and dated sessions stay separate) ────────

create table if not exists public.class_schedule_series (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.class_templates(id) on delete set null,
  class_type text not null,
  title text not null,
  description text,
  duration_minutes integer not null,
  capacity integer not null,
  location_zone text,
  beginner_friendly boolean not null default false,
  intensity_level text not null default 'Moderate',
  booking_mode text not null default 'instant_book',
  weekdays integer[] not null,
  start_minute integer not null,
  time_zone text not null default 'Australia/Brisbane',
  effective_from date not null,
  effective_until date,
  skip_dates date[] not null default '{}'::date[],
  publish_generated boolean not null default false,
  status text not null default 'active',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint class_schedule_series_weekdays check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6]),
  constraint class_schedule_series_minute check (start_minute between 0 and 1439),
  constraint class_schedule_series_duration check (duration_minutes between 1 and 1440),
  constraint class_schedule_series_capacity check (capacity between 1 and 500),
  constraint class_schedule_series_range check (effective_until is null or effective_until >= effective_from),
  constraint class_schedule_series_status check (status in ('active', 'ended')),
  constraint class_schedule_series_title check (char_length(btrim(title)) between 1 and 160)
);

alter table public.class_sessions add column if not exists series_id uuid references public.class_schedule_series(id) on delete set null;
alter table public.class_sessions add column if not exists series_occurrence_date date;
create unique index if not exists class_sessions_series_occurrence_unique
  on public.class_sessions (series_id, series_occurrence_date) where series_id is not null;

-- ─── Revisions and assignments ──────────────────────────────────────────────

create table if not exists public.staff_roster_revisions (
  id uuid primary key default gen_random_uuid(),
  month date not null,
  number integer not null,
  state text not null default 'draft',
  based_on uuid references public.staff_roster_revisions(id) on delete set null,
  version integer not null default 1,
  gap_reason text,
  gap_count integer,
  created_by uuid,
  created_at timestamptz not null default now(),
  published_by uuid,
  published_at timestamptz,
  superseded_at timestamptz,
  constraint staff_roster_revisions_month check (extract(day from month) = 1),
  constraint staff_roster_revisions_state check (state in ('draft', 'published', 'superseded', 'discarded')),
  constraint staff_roster_revisions_number unique (month, number)
);
create unique index if not exists staff_roster_revisions_one_draft on public.staff_roster_revisions (month) where state = 'draft';
create unique index if not exists staff_roster_revisions_one_published on public.staff_roster_revisions (month) where state = 'published';

create table if not exists public.staff_assignments (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.staff_roster_revisions(id) on delete cascade,
  session_id uuid references public.class_sessions(id) on delete set null,
  slot_key text not null,
  role text not null,
  staff_id uuid not null references public.staff_members(id),
  pinned boolean not null default false,
  source text not null default 'manual',
  session_title text,
  session_start timestamptz,
  session_end timestamptz,
  session_status text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint staff_assignments_role check (role in ('lead', 'assistant', 'shadow')),
  constraint staff_assignments_source check (source in ('manual', 'suggested', 'copied', 'cover', 'carried')),
  constraint staff_assignments_slot unique (revision_id, session_id, slot_key),
  constraint staff_assignments_person unique (revision_id, session_id, staff_id)
);
create index if not exists staff_assignments_staff_idx on public.staff_assignments (staff_id, revision_id);
create index if not exists staff_assignments_session_idx on public.staff_assignments (session_id);

-- ─── Absences, cover, acknowledgements ──────────────────────────────────────

create table if not exists public.staff_absences (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null,
  status text not null,
  reason_private text,
  decided_by uuid,
  decided_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint staff_absences_range check (ends_at > starts_at),
  constraint staff_absences_kind check (kind in ('planned', 'urgent')),
  constraint staff_absences_status check (status in ('requested', 'reported', 'approved', 'rejected', 'withdrawn')),
  constraint staff_absences_reason check (coalesce(char_length(reason_private), 0) <= 500)
);
create index if not exists staff_absences_lookup on public.staff_absences (staff_id, starts_at);

create table if not exists public.staff_cover_requests (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.staff_assignments(id),
  revision_id uuid not null references public.staff_roster_revisions(id),
  session_id uuid references public.class_sessions(id) on delete set null,
  slot_key text not null,
  requester_staff_id uuid not null references public.staff_members(id),
  status text not null default 'open',
  approved_offer_id uuid,
  reason_private text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint staff_cover_requests_status check (status in ('open', 'offered', 'approved', 'rejected', 'withdrawn', 'cancelled', 'superseded')),
  constraint staff_cover_requests_reason check (coalesce(char_length(reason_private), 0) <= 500)
);
create unique index if not exists staff_cover_requests_one_open on public.staff_cover_requests (assignment_id) where status in ('open', 'offered');

create table if not exists public.staff_cover_offers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.staff_cover_requests(id) on delete cascade,
  staff_id uuid not null references public.staff_members(id),
  status text not null default 'offered',
  created_at timestamptz not null default now(),
  constraint staff_cover_offers_status check (status in ('offered', 'withdrawn', 'approved', 'declined')),
  constraint staff_cover_offers_unique unique (request_id, staff_id)
);

create table if not exists public.staff_roster_acknowledgements (
  staff_id uuid not null references public.staff_members(id),
  revision_id uuid not null references public.staff_roster_revisions(id) on delete cascade,
  month date not null,
  required_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  primary key (staff_id, revision_id)
);

-- ─── Audit, notifications, idempotency ──────────────────────────────────────

create table if not exists public.staff_roster_audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  month date,
  before jsonb,
  after jsonb,
  reason text
);
create index if not exists staff_roster_audit_recent on public.staff_roster_audit_events (at desc);

create or replace function public.staff_roster_audit_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'AUDIT_IMMUTABLE';
end;
$$;
drop trigger if exists staff_roster_audit_no_change on public.staff_roster_audit_events;
create trigger staff_roster_audit_no_change before update or delete on public.staff_roster_audit_events
  for each row execute function public.staff_roster_audit_immutable();

-- Outbox and in-app inbox in one. A row existing means the notice is
-- available in the app from `deliver_after`; `read_at` is set only by the
-- recipient explicitly. Email is a separate, honestly-reported transport.
create table if not exists public.staff_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  dedupe_key text not null,
  title text not null,
  body text not null,
  link text,
  month date,
  deliver_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  email_status text not null default 'not_requested',
  email_log_id uuid,
  constraint staff_notifications_dedupe unique (dedupe_key),
  constraint staff_notifications_kind check (kind ~ '^[a-z_]{1,40}$'),
  constraint staff_notifications_title check (char_length(title) between 1 and 160),
  constraint staff_notifications_body check (char_length(body) between 1 and 600),
  constraint staff_notifications_email check (email_status in ('not_requested', 'queued', 'sent', 'failed', 'skipped', 'no_address'))
);
create index if not exists staff_notifications_inbox on public.staff_notifications (recipient_profile_id, created_at desc);

create table if not exists public.staff_roster_requests (
  request_id uuid primary key,
  actor uuid,
  action text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

-- What the roster last wrote to class_sessions.coach_name, so a later publish
-- changes only names it wrote itself and never a name someone typed by hand.
create table if not exists public.staff_roster_public_names (
  session_id uuid primary key references public.class_sessions(id) on delete cascade,
  projected_name text not null,
  revision_id uuid references public.staff_roster_revisions(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ─── Lock down direct access ────────────────────────────────────────────────

do $lockdown$
declare
  v_table text;
begin
  foreach v_table in array array[
    'staff_roster_settings', 'staff_members', 'staff_capabilities', 'staff_weekly_patterns',
    'staff_availability_drafts', 'staff_availability_submissions', 'staff_availability_windows',
    'staff_session_responses', 'staff_roster_periods', 'staff_roster_reopenings',
    'staff_class_type_staffing', 'staff_session_staffing', 'class_schedule_series',
    'staff_roster_revisions', 'staff_assignments', 'staff_absences', 'staff_cover_requests',
    'staff_cover_offers', 'staff_roster_acknowledgements', 'staff_roster_audit_events',
    'staff_notifications', 'staff_roster_requests', 'staff_roster_public_names'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
  end loop;
end;
$lockdown$;

-- ============================================================================
-- Helpers
-- ============================================================================

create or replace function public.staff_roster_lock()
returns void language sql set search_path = public as $$
  select pg_advisory_xact_lock(hashtextextended('xert_staff_roster', 0));
$$;

create or replace function public.staff_roster_require_manager()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'MANAGER_ONLY'; end if;
end;
$$;

-- The caller's active staff record, or an exception. Members who are not
-- staff never reach any roster data, and no paid membership is required.
create or replace function public.staff_roster_current_staff(p_allow_inactive boolean default false)
returns public.staff_members language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_enabled boolean;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  select enabled into v_enabled from public.staff_roster_settings where id = 1;
  if not coalesce(v_enabled, false) then raise exception 'ROSTER_DISABLED'; end if;
  select * into v_staff from public.staff_members where profile_id = auth.uid();
  if v_staff.id is null then raise exception 'NOT_STAFF'; end if;
  if v_staff.status <> 'active' and not p_allow_inactive then raise exception 'STAFF_INACTIVE'; end if;
  return v_staff;
end;
$$;

create or replace function public.staff_roster_month_of(p_at timestamptz)
returns date language sql immutable set search_path = public as $$
  select date_trunc('month', p_at at time zone 'Australia/Brisbane')::date;
$$;

create or replace function public.staff_roster_today()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'Australia/Brisbane')::date;
$$;

create or replace function public.staff_roster_local(p_date date, p_minute integer)
returns timestamptz language sql immutable set search_path = public as $$
  select (p_date::timestamp + make_interval(mins => p_minute)) at time zone 'Australia/Brisbane';
$$;

create or replace function public.staff_roster_session_end(p_start timestamptz, p_end timestamptz, p_duration integer)
returns timestamptz language sql immutable set search_path = public as $$
  select case
    when p_end is not null and p_end > p_start then p_end
    else p_start + make_interval(mins => greatest(coalesce(p_duration, 60), 1))
  end;
$$;

create or replace function public.staff_roster_default_slots()
returns jsonb language sql immutable set search_path = public as $$
  select '[{"key":"lead","role":"lead","required":true,"capabilities":[]}]'::jsonb;
$$;

-- Clean, validated slot list. Shadows are never required demand.
create or replace function public.staff_roster_normalize_slots(p_slots jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  v_item jsonb;
  v_result jsonb := '[]'::jsonb;
  v_keys text[] := '{}';
  v_key text;
  v_role text;
  v_caps jsonb;
begin
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) = 0 then
    return public.staff_roster_default_slots();
  end if;
  if jsonb_array_length(p_slots) > 8 then raise exception 'TOO_MANY_SLOTS'; end if;
  for v_item in select value from jsonb_array_elements(p_slots) loop
    v_key := btrim(coalesce(v_item->>'key', ''));
    v_role := v_item->>'role';
    if v_key !~ '^[a-z0-9_-]{1,24}$' then raise exception 'SLOT_KEY_INVALID'; end if;
    if v_role is null or v_role not in ('lead', 'assistant', 'shadow') then raise exception 'SLOT_ROLE_INVALID'; end if;
    if v_key = any(v_keys) then raise exception 'SLOT_KEY_DUPLICATE'; end if;
    v_keys := v_keys || v_key;
    select coalesce(jsonb_agg(distinct cap order by cap), '[]'::jsonb) into v_caps
      from jsonb_array_elements_text(coalesce(v_item->'capabilities', '[]'::jsonb)) as cap
      where cap ~ '^[a-z0-9_]{1,40}$';
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'key', v_key, 'role', v_role,
      'required', case when v_role = 'shadow' then false else coalesce((v_item->>'required')::boolean, true) end,
      'capabilities', v_caps));
  end loop;
  return v_result;
end;
$$;

-- Every session with its effective staffing and duty interval, for a window.
create or replace function public.staff_roster_sessions(p_from timestamptz, p_to timestamptz, p_ids uuid[] default null)
returns table (
  session_id uuid, title text, class_type text, status text, starts_at timestamptz, ends_at timestamptz,
  slots jsonb, prep_minutes integer, wrap_minutes integer, allow_block boolean, duty tstzrange,
  series_id uuid, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select s.id, s.title, s.class_type, s.status, s.start_time,
    public.staff_roster_session_end(s.start_time, s.end_time, s.duration_minutes),
    coalesce(ss.slots, ct.slots, public.staff_roster_default_slots()),
    coalesce(ss.prep_minutes, ct.prep_minutes, 0),
    coalesce(ss.wrap_minutes, ct.wrap_minutes, 0),
    coalesce(ss.allow_block, ct.allow_block, true),
    tstzrange(
      s.start_time - make_interval(mins => coalesce(ss.prep_minutes, ct.prep_minutes, 0)),
      public.staff_roster_session_end(s.start_time, s.end_time, s.duration_minutes) + make_interval(mins => coalesce(ss.wrap_minutes, ct.wrap_minutes, 0)),
      '[)'),
    s.series_id,
    s.updated_at
  from public.class_sessions s
  left join public.staff_session_staffing ss on ss.session_id = s.id
  left join public.staff_class_type_staffing ct on ct.class_type = s.class_type
  where s.start_time is not null
    and (p_ids is null or s.id = any(p_ids))
    and (p_ids is not null or (s.start_time < p_to and public.staff_roster_session_end(s.start_time, s.end_time, s.duration_minutes) > p_from));
$$;

-- The effective submission per coach and month: the newest successful one.
create or replace function public.staff_roster_effective_submissions()
returns table (submission_id uuid, staff_id uuid, month date, version integer, no_availability boolean, submitted_at timestamptz, late boolean)
language sql stable security definer set search_path = public as $$
  select distinct on (staff_id, month) id, staff_id, month, version, no_availability, submitted_at, late
  from public.staff_availability_submissions
  order by staff_id, month, version desc;
$$;

-- Fingerprint of a coach's date exceptions on the gym days a duty touches.
create or replace function public.staff_roster_exception_fingerprint(p_staff uuid, p_duty tstzrange)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(md5(string_agg(w.status || ':' || lower(w.during)::text || ':' || upper(w.during)::text, '|' order by lower(w.during), w.status)), 'none')
  from public.staff_availability_windows w
  join public.staff_roster_effective_submissions() e on e.submission_id = w.submission_id
  where w.staff_id = p_staff
    and w.source in ('exception', 'month')
    and w.during && tstzrange(
      ((lower(p_duty) at time zone 'Australia/Brisbane')::date)::timestamp at time zone 'Australia/Brisbane',
      ((upper(p_duty) at time zone 'Australia/Brisbane')::date + 1)::timestamp at time zone 'Australia/Brisbane', '[)');
$$;

-- Effective availability for every (coach, session) pair requested.
-- ABSENT > current session answer > submitted windows > UNKNOWN.
create or replace function public.staff_roster_availability(p_staff uuid[], p_sessions uuid[])
returns table (staff_id uuid, session_id uuid, status text, source text)
language sql stable security definer set search_path = public as $$
  with sessions as (
    select s.session_id, s.duty from public.staff_roster_sessions(null, null, p_sessions) s
  ),
  pairs as (
    select m.id as staff_id, s.session_id, s.duty
    from public.staff_members m cross join sessions s
    where m.id = any(p_staff)
  ),
  effective as (select * from public.staff_roster_effective_submissions()),
  calc as (
    select p.staff_id, p.session_id, p.duty,
      exists (
        select 1 from public.staff_absences a
        where a.staff_id = p.staff_id and a.status in ('approved', 'reported')
          and tstzrange(a.starts_at, a.ends_at, '[)') && p.duty
      ) as absent,
      (select r.status from public.staff_session_responses r
        where r.staff_id = p.staff_id and r.session_id = p.session_id
          and r.duty = p.duty
          and r.exception_fingerprint = public.staff_roster_exception_fingerprint(p.staff_id, p.duty)) as response,
      bool_or(w.status = 'UNAVAILABLE') as unavailable,
      range_agg(w.during) filter (where w.status <> 'UNAVAILABLE') as positive,
      min(case w.status when 'IF_NEEDED' then 1 when 'AVAILABLE' then 2 when 'PREFERRED' then 3 end) as worst
    from pairs p
    left join (
      public.staff_availability_windows w join effective e on e.submission_id = w.submission_id
    ) on w.staff_id = p.staff_id and w.during && p.duty
    group by p.staff_id, p.session_id, p.duty
  )
  select c.staff_id, c.session_id,
    case
      when c.absent then 'ABSENT'
      when c.response is not null then c.response
      when coalesce(c.unavailable, false) then 'UNAVAILABLE'
      when c.positive is null then 'UNKNOWN'
      when not (c.positive @> c.duty) then 'PARTIAL'
      when c.worst = 1 then 'IF_NEEDED'
      when c.worst = 2 then 'AVAILABLE'
      else 'PREFERRED'
    end,
    case
      when c.absent then 'absence'
      when c.response is not null then 'session'
      when c.positive is null and not coalesce(c.unavailable, false) then 'none'
      else 'submission'
    end
  from calc c;
$$;

create or replace function public.staff_roster_audit(p_action text, p_entity text, p_entity_id text, p_month date, p_before jsonb, p_after jsonb, p_reason text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.staff_roster_audit_events (actor, action, entity, entity_id, month, before, after, reason)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_month, p_before, p_after, left(p_reason, 500));
$$;

-- Queue one in-app notice (deduplicated) and, only when switched on, an email
-- through the existing durable email log. Never raises into the caller.
create or replace function public.staff_roster_notify(
  p_profile uuid, p_kind text, p_dedupe text, p_title text, p_body text, p_link text, p_month date,
  p_deliver_after timestamptz default now()
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_email text;
  v_settings public.staff_roster_settings;
  v_log uuid;
begin
  if p_profile is null then return null; end if;
  insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link, month, deliver_after)
  values (p_profile, p_kind, p_dedupe, left(p_title, 160), left(p_body, 600), p_link, p_month, p_deliver_after)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  select * into v_settings from public.staff_roster_settings where id = 1;
  if coalesce(v_settings.email_notices_enabled, false) and p_deliver_after <= now() then
    begin
      select email into v_email from public.profiles where id = p_profile;
      if v_email is null then
        update public.staff_notifications set email_status = 'no_address' where id = v_id;
      elsif to_regprocedure('public.queue_email(text,text,text,text,text,text,text)') is not null then
        execute 'select public.queue_email($1, $2, $3, $4, $5, $6, $7)'
          into v_log
          using 'staff_roster', v_email, left(p_title, 150),
            '<p>' || replace(replace(left(p_body, 600), '<', '&lt;'), '>', '&gt;') || '</p><p>Open XERT to see the details.</p>',
            left(p_body, 600) || E'\n\nOpen XERT to see the details.', 'staff_notifications', v_id::text;
        update public.staff_notifications set email_status = 'queued', email_log_id = v_log where id = v_id;
      else
        update public.staff_notifications set email_status = 'skipped' where id = v_id;
      end if;
    exception when others then
      update public.staff_notifications set email_status = 'failed' where id = v_id;
    end;
  end if;
  return v_id;
end;
$$;

create or replace function public.staff_roster_notify_managers(p_kind text, p_dedupe text, p_title text, p_body text, p_link text, p_month date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_profile uuid;
begin
  for v_profile in select id from public.profiles where role = 'admin' order by id loop
    perform public.staff_roster_notify(v_profile, p_kind, p_dedupe || ':' || v_profile::text, p_title, p_body, p_link, p_month);
  end loop;
end;
$$;

-- Idempotency: a replayed request id returns the first result.
create or replace function public.staff_roster_replay(p_request_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.staff_roster_requests;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  select * into v_row from public.staff_roster_requests where request_id = p_request_id;
  if v_row.request_id is null then return null; end if;
  if v_row.action <> p_action or v_row.actor is distinct from auth.uid() then raise exception 'REQUEST_ID_REUSED'; end if;
  return v_row.result;
end;
$$;

create or replace function public.staff_roster_remember(p_request_id uuid, p_action text, p_result jsonb)
returns jsonb language sql security definer set search_path = public as $$
  insert into public.staff_roster_requests (request_id, actor, action, result) values (p_request_id, auth.uid(), p_action, p_result);
  select p_result;
$$;

-- ============================================================================
-- The authoritative assignment rules
-- ============================================================================

-- Assignments that make up the effective roster around `p_revision`: that
-- revision itself, plus the current published revision of every other month.
create or replace function public.staff_roster_effective_assignments(p_revision uuid)
returns table (assignment_id uuid, revision_id uuid, session_id uuid, slot_key text, staff_id uuid)
language sql stable security definer set search_path = public as $$
  select a.id, a.revision_id, a.session_id, a.slot_key, a.staff_id
  from public.staff_assignments a
  where a.revision_id = p_revision and a.session_id is not null
  union all
  select a.id, a.revision_id, a.session_id, a.slot_key, a.staff_id
  from public.staff_assignments a
  join public.staff_roster_revisions r on r.id = a.revision_id
  where r.state = 'published' and a.session_id is not null
    and r.month <> (select month from public.staff_roster_revisions where id = p_revision);
$$;

create or replace function public.staff_roster_assignment_problems(
  p_revision uuid, p_session uuid, p_slot text, p_staff uuid,
  p_ignore uuid[] default '{}', p_allow_if_needed boolean default null
) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  v_problems text[] := '{}';
  v_session record;
  v_slot jsonb;
  v_staff public.staff_members;
  v_status text;
  v_allow boolean;
  v_cap text;
  v_other record;
  v_day_minutes numeric;
  v_week_count integer;
  v_gap_before interval;
  v_gap_after interval;
  v_revision_month date;
begin
  select month into v_revision_month from public.staff_roster_revisions where id = p_revision;
  select * into v_session from public.staff_roster_sessions(null, null, array[p_session]);
  if not found then return array['SESSION_NOT_FOUND']; end if;
  select * into v_staff from public.staff_members where id = p_staff;
  if v_staff.id is null then return array['STAFF_UNKNOWN']; end if;

  if v_session.status not in ('draft', 'published', 'full') then v_problems := v_problems || 'SESSION_NOT_LIVE'::text;
  elsif v_session.starts_at <= now() then v_problems := v_problems || 'SESSION_STARTED'::text;
  end if;
  if v_revision_month is not null and public.staff_roster_month_of(v_session.starts_at) <> v_revision_month then
    v_problems := v_problems || 'SESSION_OUTSIDE_MONTH'::text;
  end if;

  select value into v_slot from jsonb_array_elements(public.staff_roster_normalize_slots(v_session.slots)) where value->>'key' = p_slot;
  if v_slot is null then v_problems := v_problems || 'SLOT_UNKNOWN'::text; end if;
  if v_staff.status <> 'active' then v_problems := v_problems || 'STAFF_INACTIVE'::text; end if;
  if v_slot is not null and not ((v_slot->>'role') = any(v_staff.roles)) then v_problems := v_problems || 'ROLE_NOT_AUTHORISED'::text; end if;
  if v_slot is not null then
    for v_cap in select jsonb_array_elements_text(v_slot->'capabilities') loop
      if not exists (select 1 from public.staff_capabilities c where c.staff_id = p_staff and c.capability = v_cap) then
        v_problems := v_problems || ('CAPABILITY_MISSING:' || v_cap);
      elsif not exists (
        select 1 from public.staff_capabilities c where c.staff_id = p_staff and c.capability = v_cap
          and (c.valid_from is null or c.valid_from <= v_session.starts_at)
          and (c.valid_until is null or c.valid_until >= v_session.ends_at)
      ) then
        v_problems := v_problems || ('CAPABILITY_EXPIRED:' || v_cap);
      end if;
    end loop;
  end if;

  if exists (select 1 from public.staff_assignments a where a.revision_id = p_revision and a.session_id = p_session
      and a.slot_key = p_slot and a.staff_id <> p_staff and not (a.id = any(p_ignore))) then
    v_problems := v_problems || 'SLOT_TAKEN'::text;
  end if;
  if exists (select 1 from public.staff_assignments a where a.revision_id = p_revision and a.session_id = p_session
      and a.staff_id = p_staff and a.slot_key <> p_slot and not (a.id = any(p_ignore))) then
    v_problems := v_problems || 'SAME_SESSION_DUPLICATE'::text;
  end if;

  select status into v_status from public.staff_roster_availability(array[p_staff], array[p_session]);
  select coalesce(p_allow_if_needed, allow_if_needed_fallback) into v_allow from public.staff_roster_settings where id = 1;
  v_problems := v_problems || case coalesce(v_status, 'UNKNOWN')
    when 'ABSENT' then array['ABSENT']
    when 'UNKNOWN' then array['AVAILABILITY_UNKNOWN']
    when 'PARTIAL' then array['AVAILABILITY_PARTIAL']
    when 'UNAVAILABLE' then array['AVAILABILITY_UNAVAILABLE']
    when 'IF_NEEDED' then case when coalesce(v_allow, true) then '{}'::text[] else array['AVAILABILITY_IF_NEEDED_BLOCKED'] end
    else '{}'::text[] end;

  -- Duty overlaps against everything this coach does in the effective roster.
  for v_other in
    select o.session_id, o.starts_at, o.ends_at, o.duty, o.allow_block
    from public.staff_roster_effective_assignments(p_revision) e
    join public.staff_roster_sessions(null, null, array(select ea.session_id from public.staff_roster_effective_assignments(p_revision) ea where ea.staff_id = p_staff)) o
      on o.session_id = e.session_id
    where e.staff_id = p_staff and e.session_id <> p_session and not (e.assignment_id = any(p_ignore))
      and o.status in ('draft', 'published', 'full')
  loop
    if tstzrange(v_other.starts_at, v_other.ends_at, '[)') && tstzrange(v_session.starts_at, v_session.ends_at, '[)') then
      v_problems := v_problems || 'CLASS_OVERLAP'::text;
    elsif v_other.duty && v_session.duty and not (v_other.allow_block and v_session.allow_block) then
      v_problems := v_problems || 'DUTY_BUFFER_OVERLAP'::text;
    end if;
  end loop;

  if v_staff.max_duty_minutes_per_day is not null or v_staff.max_classes_per_week is not null or v_staff.min_rest_minutes is not null then
    with mine as (
      select o.starts_at, o.duty
      from public.staff_roster_effective_assignments(p_revision) e
      join public.staff_roster_sessions(null, null, array(select ea.session_id from public.staff_roster_effective_assignments(p_revision) ea where ea.staff_id = p_staff)) o
        on o.session_id = e.session_id
      where e.staff_id = p_staff and e.session_id <> p_session and not (e.assignment_id = any(p_ignore))
        and o.status in ('draft', 'published', 'full')
      union all
      select v_session.starts_at, v_session.duty
    ),
    merged as (
      select unnest(range_agg(duty)) as block from mine
    ),
    day_blocks as (
      select unnest(range_agg(duty)) as block from mine
      where (starts_at at time zone 'Australia/Brisbane')::date = (v_session.starts_at at time zone 'Australia/Brisbane')::date
    )
    select
      (select coalesce(sum(extract(epoch from upper(block) - lower(block)) / 60), 0) from day_blocks),
      (select count(*) from mine where date_trunc('week', starts_at at time zone 'Australia/Brisbane') = date_trunc('week', v_session.starts_at at time zone 'Australia/Brisbane')),
      (select lower(v_session.duty) - max(upper(block)) from merged
        where upper(block) <= lower(v_session.duty)
          and (upper(block) at time zone 'Australia/Brisbane')::date <> (lower(v_session.duty) at time zone 'Australia/Brisbane')::date),
      (select min(lower(block)) - upper(v_session.duty) from merged
        where lower(block) >= upper(v_session.duty)
          and (lower(block) at time zone 'Australia/Brisbane')::date <> (upper(v_session.duty) at time zone 'Australia/Brisbane')::date)
    into v_day_minutes, v_week_count, v_gap_before, v_gap_after;
    if v_staff.max_duty_minutes_per_day is not null and v_day_minutes > v_staff.max_duty_minutes_per_day then
      v_problems := v_problems || 'LIMIT_DAILY_DUTY'::text;
    end if;
    if v_staff.max_classes_per_week is not null and v_week_count > v_staff.max_classes_per_week then
      v_problems := v_problems || 'LIMIT_WEEKLY_CLASSES'::text;
    end if;
    if v_staff.min_rest_minutes is not null and (
      (v_gap_before is not null and v_gap_before < make_interval(mins => v_staff.min_rest_minutes))
      or (v_gap_after is not null and v_gap_after < make_interval(mins => v_staff.min_rest_minutes))
    ) then
      v_problems := v_problems || 'LIMIT_REST'::text;
    end if;
  end if;

  return (select coalesce(array_agg(distinct problem order by problem), '{}') from unnest(v_problems) as problem);
end;
$$;

create table if not exists public.staff_roster_change_requests (
  id uuid primary key default gen_random_uuid(),
  month date not null,
  staff_id uuid not null references public.staff_members(id),
  message text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  constraint staff_roster_change_requests_status check (status in ('open', 'reopened', 'declined', 'withdrawn')),
  constraint staff_roster_change_requests_message check (char_length(btrim(message)) between 1 and 500)
);
alter table public.staff_roster_change_requests enable row level security;
revoke all on table public.staff_roster_change_requests from public, anon, authenticated;

-- ============================================================================
-- Revisions
-- ============================================================================

-- The month's working draft, created on first edit as a copy of the current
-- published revision. Published stays untouched while the draft changes.
create or replace function public.staff_roster_draft(p_month date)
returns public.staff_roster_revisions
language plpgsql security definer set search_path = public as $$
declare
  v_draft public.staff_roster_revisions;
  v_published public.staff_roster_revisions;
begin
  select * into v_draft from public.staff_roster_revisions where month = p_month and state = 'draft';
  if v_draft.id is not null then return v_draft; end if;
  select * into v_published from public.staff_roster_revisions where month = p_month and state = 'published';
  insert into public.staff_roster_revisions (month, number, state, based_on, created_by)
  values (p_month, coalesce((select max(number) from public.staff_roster_revisions where month = p_month), 0) + 1, 'draft', v_published.id, auth.uid())
  returning * into v_draft;
  if v_published.id is not null then
    insert into public.staff_assignments (revision_id, session_id, slot_key, role, staff_id, pinned, source,
      session_title, session_start, session_end, session_status, created_by)
    select v_draft.id, session_id, slot_key, role, staff_id, pinned, source,
      session_title, session_start, session_end, session_status, created_by
    from public.staff_assignments where revision_id = v_published.id;
  end if;
  return v_draft;
end;
$$;

create or replace function public.staff_roster_month_param(p_month date)
returns date language plpgsql immutable set search_path = public as $$
begin
  if p_month is null or extract(day from p_month) <> 1 then raise exception 'MONTH_INVALID'; end if;
  return p_month;
end;
$$;

-- ============================================================================
-- Manager: settings, staff, capabilities, periods, staffing
-- ============================================================================

create or replace function public.staff_roster_get_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() and not exists (select 1 from public.staff_members where profile_id = auth.uid() and status = 'active') then
    raise exception 'NOT_STAFF';
  end if;
  return (select to_jsonb(s) - 'updated_by' from public.staff_roster_settings s where id = 1);
end;
$$;

create or replace function public.staff_roster_update_settings(p_patch jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_before public.staff_roster_settings;
  v_after public.staff_roster_settings;
  v_presets jsonb;
  v_minutes integer[];
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  select * into v_before from public.staff_roster_settings where id = 1 for update;
  if v_before.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  v_presets := coalesce(p_patch->'class_time_presets', v_before.class_time_presets);
  if jsonb_typeof(v_presets) <> 'array' or jsonb_array_length(v_presets) > 24 then raise exception 'PRESETS_INVALID'; end if;
  select array_agg((value->>'minute')::integer order by (value->>'minute')::integer) into v_minutes from jsonb_array_elements(v_presets);
  if exists (select 1 from unnest(coalesce(v_minutes, '{}')) m where m is null or m < 0 or m > 1439)
     or cardinality(coalesce(v_minutes, '{}')) <> (select count(distinct m) from unnest(coalesce(v_minutes, '{}')) m) then
    raise exception 'PRESETS_INVALID';
  end if;
  update public.staff_roster_settings set
    enabled = coalesce((p_patch->>'enabled')::boolean, enabled),
    class_time_presets = (select coalesce(jsonb_agg(jsonb_build_object('minute', m) order by m), '[]'::jsonb) from unnest(coalesce(v_minutes, '{}')) m),
    cycle = coalesce(p_patch->'cycle', cycle),
    reminders = coalesce(p_patch->'reminders', reminders),
    allow_if_needed_fallback = coalesce((p_patch->>'allow_if_needed_fallback')::boolean, allow_if_needed_fallback),
    email_notices_enabled = coalesce((p_patch->>'email_notices_enabled')::boolean, email_notices_enabled),
    public_coach_names_enabled = coalesce((p_patch->>'public_coach_names_enabled')::boolean, public_coach_names_enabled),
    version = version + 1, updated_by = auth.uid(), updated_at = now()
  where id = 1 returning * into v_after;
  perform public.staff_roster_audit('settings_updated', 'settings', '1', null, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after) - 'updated_by';
end;
$$;

create or replace function public.staff_roster_upsert_staff(p_staff jsonb, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_before public.staff_members;
  v_after public.staff_members;
  v_id uuid := nullif(p_staff->>'id', '')::uuid;
  v_profile uuid := nullif(p_staff->>'profile_id', '')::uuid;
  v_roles text[];
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'upsert_staff');
  if v_replay is not null then return v_replay; end if;
  if v_profile is not null and not exists (select 1 from public.profiles where id = v_profile) then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  select coalesce(array_agg(value order by value), array['lead']) into v_roles
    from jsonb_array_elements_text(coalesce(p_staff->'roles', '["lead"]'::jsonb)) as value;
  if v_id is null then
    insert into public.staff_members (profile_id, coach_id, display_name, legacy_label, roles,
      target_classes_per_month, min_classes_per_month, max_classes_per_week, max_duty_minutes_per_day, min_rest_minutes, manager_note, created_by)
    values (v_profile, nullif(p_staff->>'coach_id', '')::uuid, btrim(p_staff->>'display_name'), nullif(btrim(p_staff->>'legacy_label'), ''), v_roles,
      (p_staff->>'target_classes_per_month')::integer, (p_staff->>'min_classes_per_month')::integer, (p_staff->>'max_classes_per_week')::integer,
      (p_staff->>'max_duty_minutes_per_day')::integer, (p_staff->>'min_rest_minutes')::integer, nullif(btrim(p_staff->>'manager_note'), ''), auth.uid())
    returning * into v_after;
  else
    select * into v_before from public.staff_members where id = v_id for update;
    if v_before.id is null then raise exception 'STAFF_NOT_FOUND'; end if;
    if v_before.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
    update public.staff_members set
      profile_id = v_profile, coach_id = nullif(p_staff->>'coach_id', '')::uuid,
      display_name = btrim(p_staff->>'display_name'), legacy_label = nullif(btrim(p_staff->>'legacy_label'), ''), roles = v_roles,
      target_classes_per_month = (p_staff->>'target_classes_per_month')::integer,
      min_classes_per_month = (p_staff->>'min_classes_per_month')::integer,
      max_classes_per_week = (p_staff->>'max_classes_per_week')::integer,
      max_duty_minutes_per_day = (p_staff->>'max_duty_minutes_per_day')::integer,
      min_rest_minutes = (p_staff->>'min_rest_minutes')::integer,
      manager_note = nullif(btrim(p_staff->>'manager_note'), ''),
      version = version + 1, updated_at = now()
    where id = v_id returning * into v_after;
  end if;
  perform public.staff_roster_audit(case when v_before.id is null then 'staff_created' else 'staff_updated' end, 'staff', v_after.id::text, null, to_jsonb(v_before), to_jsonb(v_after));
  return public.staff_roster_remember(p_request_id, 'upsert_staff', to_jsonb(v_after));
exception when unique_violation then
  raise exception 'ACCOUNT_ALREADY_LINKED';
end;
$$;

create or replace function public.staff_roster_set_staff_status(p_staff_id uuid, p_status text, p_expected_version integer, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_before public.staff_members;
  v_after public.staff_members;
  v_affected integer;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'set_staff_status');
  if v_replay is not null then return v_replay; end if;
  if p_status not in ('active', 'inactive') then raise exception 'STATUS_INVALID'; end if;
  select * into v_before from public.staff_members where id = p_staff_id for update;
  if v_before.id is null then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  update public.staff_members set status = p_status,
    deactivated_at = case when p_status = 'inactive' then now() else null end,
    version = version + 1, updated_at = now()
  where id = p_staff_id returning * into v_after;
  select count(*) into v_affected
    from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
    join public.class_sessions s on s.id = a.session_id
    where a.staff_id = p_staff_id and r.state in ('draft', 'published') and s.start_time > now() and s.status in ('draft', 'published', 'full');
  perform public.staff_roster_audit('staff_' || p_status, 'staff', p_staff_id::text, null, to_jsonb(v_before), to_jsonb(v_after), p_reason);
  return public.staff_roster_remember(p_request_id, 'set_staff_status', jsonb_build_object('staff', to_jsonb(v_after), 'future_assignments_to_review', v_affected));
end;
$$;

create or replace function public.staff_roster_set_capabilities(p_staff_id uuid, p_capabilities jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'set_capabilities');
  if v_replay is not null then return v_replay; end if;
  if not exists (select 1 from public.staff_members where id = p_staff_id) then raise exception 'STAFF_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(to_jsonb(c) order by capability, valid_from), '[]') into v_before from public.staff_capabilities c where staff_id = p_staff_id;
  delete from public.staff_capabilities where staff_id = p_staff_id;
  insert into public.staff_capabilities (staff_id, capability, valid_from, valid_until, created_by)
  select p_staff_id, lower(btrim(item->>'capability')), nullif(item->>'valid_from', '')::timestamptz, nullif(item->>'valid_until', '')::timestamptz, auth.uid()
  from jsonb_array_elements(coalesce(p_capabilities, '[]'::jsonb)) item;
  select coalesce(jsonb_agg(to_jsonb(c) order by capability, valid_from), '[]') into v_after from public.staff_capabilities c where staff_id = p_staff_id;
  perform public.staff_roster_audit('capabilities_set', 'staff', p_staff_id::text, null, v_before, v_after);
  return public.staff_roster_remember(p_request_id, 'set_capabilities', v_after);
end;
$$;

create or replace function public.staff_roster_link_candidates(p_query text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_roster_require_manager();
  if char_length(btrim(coalesce(p_query, ''))) < 2 then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email,
      'linked', exists (select 1 from public.staff_members m where m.profile_id = p.id)) order by p.full_name nulls last)
    from (
      select * from public.profiles
      where full_name ilike '%' || btrim(p_query) || '%' or email ilike '%' || btrim(p_query) || '%'
      order by full_name nulls last limit 20
    ) p
  ), '[]'::jsonb);
end;
$$;

create or replace function public.staff_roster_open_period(p_month date, p_opens_on date, p_due_on date, p_publish_target_on date, p_shortened boolean, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_row public.staff_roster_periods;
  v_profile uuid;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'open_period');
  if v_replay is not null then return v_replay; end if;
  perform public.staff_roster_month_param(p_month);
  if exists (select 1 from public.staff_roster_periods where month = p_month) then raise exception 'PERIOD_EXISTS'; end if;
  if p_opens_on < public.staff_roster_today() then raise exception 'NO_BACKDATING'; end if;
  insert into public.staff_roster_periods (month, opens_on, due_on, publish_target_on, shortened, opened_by)
  values (p_month, p_opens_on, p_due_on, p_publish_target_on, coalesce(p_shortened, false), auth.uid())
  returning * into v_row;
  perform public.staff_roster_audit('period_opened', 'period', p_month::text, p_month, null, to_jsonb(v_row));
  return public.staff_roster_remember(p_request_id, 'open_period', to_jsonb(v_row));
end;
$$;

create or replace function public.staff_roster_update_period(p_month date, p_due_on date, p_publish_target_on date, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_before public.staff_roster_periods;
  v_after public.staff_roster_periods;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  select * into v_before from public.staff_roster_periods where month = p_month for update;
  if v_before.month is null then raise exception 'PERIOD_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  update public.staff_roster_periods set due_on = p_due_on, publish_target_on = p_publish_target_on, version = version + 1
  where month = p_month returning * into v_after;
  perform public.staff_roster_audit('period_updated', 'period', p_month::text, p_month, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
end;
$$;

create or replace function public.staff_roster_reopen_submission(p_month date, p_staff_id uuid, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_row public.staff_roster_reopenings;
  v_profile uuid;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'reopen_submission');
  if v_replay is not null then return v_replay; end if;
  if not exists (select 1 from public.staff_roster_periods where month = p_month) then raise exception 'PERIOD_NOT_FOUND'; end if;
  insert into public.staff_roster_reopenings (month, staff_id, reason, reopened_by)
  values (p_month, p_staff_id, p_reason, auth.uid())
  on conflict (month, staff_id) where closed_at is null do update set reason = excluded.reason
  returning * into v_row;
  update public.staff_roster_change_requests set status = 'reopened', decided_by = auth.uid(), decided_at = now()
    where month = p_month and staff_id = p_staff_id and status = 'open';
  select profile_id into v_profile from public.staff_members where id = p_staff_id;
  perform public.staff_roster_notify(v_profile, 'availability_reopened', 'reopened:' || v_row.id::text,
    'Availability reopened', 'Your availability for ' || to_char(p_month, 'FMMonth YYYY') || ' is open again for changes.',
    '/coaching?tab=availability&month=' || to_char(p_month, 'YYYY-MM'), p_month);
  perform public.staff_roster_audit('submission_reopened', 'staff', p_staff_id::text, p_month, null, to_jsonb(v_row), p_reason);
  return public.staff_roster_remember(p_request_id, 'reopen_submission', to_jsonb(v_row));
end;
$$;

create or replace function public.staff_roster_set_staffing(p_scope text, p_key text, p_staffing jsonb, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_slots jsonb;
  v_prep integer := coalesce((p_staffing->>'prep_minutes')::integer, 0);
  v_wrap integer := coalesce((p_staffing->>'wrap_minutes')::integer, 0);
  v_block boolean := coalesce((p_staffing->>'allow_block')::boolean, true);
  v_version integer;
  v_before jsonb;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'set_staffing');
  if v_replay is not null then return v_replay; end if;
  if p_staffing is not null then v_slots := public.staff_roster_normalize_slots(p_staffing->'slots'); end if;
  if p_scope = 'session' then
    select version, to_jsonb(s) into v_version, v_before from public.staff_session_staffing s where session_id = p_key::uuid for update;
    if coalesce(v_version, 0) <> coalesce(p_expected_version, 0) then raise exception 'STALE_VERSION'; end if;
    -- A position cannot disappear while a draft or published assignment uses it.
    if exists (
      select 1 from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
      where a.session_id = p_key::uuid and r.state in ('draft', 'published')
        and not exists (select 1 from jsonb_array_elements(coalesce(v_slots, public.staff_roster_default_slots())) x where x->>'key' = a.slot_key)
    ) then raise exception 'SLOT_IN_USE'; end if;
    if p_staffing is null then
      delete from public.staff_session_staffing where session_id = p_key::uuid;
    else
      insert into public.staff_session_staffing (session_id, slots, prep_minutes, wrap_minutes, allow_block)
      values (p_key::uuid, v_slots, v_prep, v_wrap, v_block)
      on conflict (session_id) do update set slots = excluded.slots, prep_minutes = excluded.prep_minutes,
        wrap_minutes = excluded.wrap_minutes, allow_block = excluded.allow_block,
        version = staff_session_staffing.version + 1, updated_at = now();
    end if;
  elsif p_scope = 'class_type' then
    select version, to_jsonb(s) into v_version, v_before from public.staff_class_type_staffing s where class_type = p_key for update;
    if coalesce(v_version, 0) <> coalesce(p_expected_version, 0) then raise exception 'STALE_VERSION'; end if;
    if p_staffing is null then
      delete from public.staff_class_type_staffing where class_type = p_key;
    else
      insert into public.staff_class_type_staffing (class_type, slots, prep_minutes, wrap_minutes, allow_block)
      values (p_key, v_slots, v_prep, v_wrap, v_block)
      on conflict (class_type) do update set slots = excluded.slots, prep_minutes = excluded.prep_minutes,
        wrap_minutes = excluded.wrap_minutes, allow_block = excluded.allow_block,
        version = staff_class_type_staffing.version + 1, updated_at = now();
    end if;
  else
    raise exception 'SCOPE_INVALID';
  end if;
  perform public.staff_roster_audit('staffing_set', p_scope, p_key, null, v_before, p_staffing);
  return public.staff_roster_remember(p_request_id, 'set_staffing', jsonb_build_object('scope', p_scope, 'key', p_key, 'slots', v_slots));
end;
$$;

-- ============================================================================
-- Recurring schedule
-- ============================================================================

create or replace function public.staff_roster_save_series(p_series jsonb, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_id uuid := nullif(p_series->>'id', '')::uuid;
  v_before public.class_schedule_series;
  v_after public.class_schedule_series;
  v_weekdays integer[];
  v_skips date[];
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'save_series');
  if v_replay is not null then return v_replay; end if;
  select coalesce(array_agg(distinct value::integer order by value::integer), '{}') into v_weekdays from jsonb_array_elements_text(coalesce(p_series->'weekdays', '[]')) value;
  select coalesce(array_agg(distinct value::date order by value::date), '{}') into v_skips from jsonb_array_elements_text(coalesce(p_series->'skip_dates', '[]')) value;
  if v_id is null then
    insert into public.class_schedule_series (template_id, class_type, title, description, duration_minutes, capacity, location_zone,
      beginner_friendly, intensity_level, booking_mode, weekdays, start_minute, effective_from, effective_until, skip_dates, publish_generated, created_by)
    values (nullif(p_series->>'template_id', '')::uuid, p_series->>'class_type', btrim(p_series->>'title'), nullif(p_series->>'description', ''),
      (p_series->>'duration_minutes')::integer, (p_series->>'capacity')::integer, nullif(p_series->>'location_zone', ''),
      coalesce((p_series->>'beginner_friendly')::boolean, false), coalesce(p_series->>'intensity_level', 'Moderate'),
      coalesce(p_series->>'booking_mode', 'instant_book'), v_weekdays, (p_series->>'start_minute')::integer,
      (p_series->>'effective_from')::date, nullif(p_series->>'effective_until', '')::date, v_skips,
      coalesce((p_series->>'publish_generated')::boolean, false), auth.uid())
    returning * into v_after;
  else
    select * into v_before from public.class_schedule_series where id = v_id for update;
    if v_before.id is null then raise exception 'SERIES_NOT_FOUND'; end if;
    if v_before.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
    -- Changing when a series runs is done with "this and future", which keeps
    -- history. A plain save may only change what applies to future generation.
    if (p_series->>'start_minute')::integer is distinct from v_before.start_minute
       or (p_series->>'duration_minutes')::integer is distinct from v_before.duration_minutes then
      raise exception 'USE_THIS_AND_FUTURE';
    end if;
    update public.class_schedule_series set
      title = btrim(p_series->>'title'), description = nullif(p_series->>'description', ''),
      capacity = (p_series->>'capacity')::integer, location_zone = nullif(p_series->>'location_zone', ''),
      weekdays = v_weekdays, effective_until = nullif(p_series->>'effective_until', '')::date, skip_dates = v_skips,
      publish_generated = coalesce((p_series->>'publish_generated')::boolean, publish_generated),
      status = coalesce(p_series->>'status', status), version = version + 1, updated_at = now()
    where id = v_id returning * into v_after;
  end if;
  perform public.staff_roster_audit('series_saved', 'series', v_after.id::text, null, to_jsonb(v_before), to_jsonb(v_after));
  return public.staff_roster_remember(p_request_id, 'save_series', to_jsonb(v_after));
end;
$$;

-- Occurrence dates a series would produce in a window, and whether each
-- already exists. Pure preview; writes nothing.
create or replace function public.staff_roster_preview_series(p_series_id uuid, p_from date, p_until date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_series public.class_schedule_series;
begin
  perform public.staff_roster_require_manager();
  select * into v_series from public.class_schedule_series where id = p_series_id;
  if v_series.id is null then raise exception 'SERIES_NOT_FOUND'; end if;
  if p_until < p_from or p_until - p_from > 400 then raise exception 'RANGE_INVALID'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'date', d::date,
      'starts_at', (d::date::timestamp + make_interval(mins => v_series.start_minute)) at time zone v_series.time_zone,
      'session_id', s.id,
      'exists', s.id is not null,
      'skipped', d::date = any(v_series.skip_dates)
    ) order by d)
    from generate_series(greatest(p_from, v_series.effective_from), least(p_until, coalesce(v_series.effective_until, p_until)), interval '1 day') d
    left join public.class_sessions s on s.series_id = v_series.id and s.series_occurrence_date = d::date
    where extract(dow from d)::integer = any(v_series.weekdays)
  ), '[]'::jsonb);
end;
$$;

-- Creates missing occurrences only. Re-running is a no-op for dates that
-- exist (unique series_id + occurrence date), so retries never duplicate.
create or replace function public.staff_roster_generate_series(p_series_id uuid, p_from date, p_until date, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_series public.class_schedule_series;
  v_day date;
  v_start timestamptz;
  v_created integer := 0;
  v_existing integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_id uuid;
  v_status text;
  v_result jsonb;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'generate_series');
  if v_replay is not null then return v_replay; end if;
  select * into v_series from public.class_schedule_series where id = p_series_id for update;
  if v_series.id is null then raise exception 'SERIES_NOT_FOUND'; end if;
  if v_series.status <> 'active' then raise exception 'SERIES_ENDED'; end if;
  if p_until < p_from or p_until - p_from > 400 then raise exception 'RANGE_INVALID'; end if;
  for v_day in
    select d::date from generate_series(greatest(p_from, v_series.effective_from), least(p_until, coalesce(v_series.effective_until, p_until)), interval '1 day') d
    where extract(dow from d)::integer = any(v_series.weekdays)
    order by d
  loop
    if v_day = any(v_series.skip_dates) then
      v_skipped := v_skipped || jsonb_build_object('date', v_day, 'reason', 'skipped date');
      continue;
    end if;
    v_start := (v_day::timestamp + make_interval(mins => v_series.start_minute)) at time zone v_series.time_zone;
    if v_start <= now() then
      v_skipped := v_skipped || jsonb_build_object('date', v_day, 'reason', 'in the past');
      continue;
    end if;
    if exists (select 1 from public.class_sessions where series_id = v_series.id and series_occurrence_date = v_day) then
      v_existing := v_existing + 1;
      continue;
    end if;
    v_status := case when v_series.publish_generated then 'published' else 'draft' end;
    begin
      insert into public.class_sessions (class_type, title, description, start_time, end_time, duration_minutes, capacity,
        location_zone, beginner_friendly, intensity_level, status, public_visible, booking_mode, series_id, series_occurrence_date)
      values (v_series.class_type, v_series.title, v_series.description, v_start, v_start + make_interval(mins => v_series.duration_minutes),
        v_series.duration_minutes, v_series.capacity, v_series.location_zone, v_series.beginner_friendly, v_series.intensity_level,
        v_status, v_series.publish_generated, v_series.booking_mode, v_series.id, v_day)
      on conflict (series_id, series_occurrence_date) where series_id is not null do nothing
      returning id into v_id;
      if v_id is null then v_existing := v_existing + 1; else v_created := v_created + 1; end if;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('date', v_day, 'reason', sqlerrm);
    end;
  end loop;
  v_result := jsonb_build_object('created', v_created, 'existing', v_existing, 'skipped', v_skipped);
  perform public.staff_roster_audit('series_generated', 'series', p_series_id::text, null, null, v_result);
  return public.staff_roster_remember(p_request_id, 'generate_series', v_result);
end;
$$;

-- "This and future occurrences": preview, then (p_apply) end the old series
-- the day before, start a new one with the change, and move each future,
-- still-running occurrence through the normal guarded class update. History
-- and past occurrences are untouched; booking guards still apply per class.
create or replace function public.staff_roster_change_series_from(p_series_id uuid, p_from date, p_changes jsonb, p_apply boolean, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_series public.class_schedule_series;
  v_new public.class_schedule_series;
  v_minute integer;
  v_duration integer;
  v_session record;
  v_preview jsonb := '[]'::jsonb;
  v_failures jsonb := '[]'::jsonb;
  v_new_start timestamptz;
  v_result jsonb;
begin
  perform public.staff_roster_require_manager();
  if p_apply then
    perform public.staff_roster_lock();
    v_replay := public.staff_roster_replay(p_request_id, 'change_series_from');
    if v_replay is not null then return v_replay; end if;
  end if;
  select * into v_series from public.class_schedule_series where id = p_series_id;
  if v_series.id is null then raise exception 'SERIES_NOT_FOUND'; end if;
  if v_series.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  if p_from <= public.staff_roster_today() then raise exception 'FROM_MUST_BE_FUTURE'; end if;
  v_minute := coalesce((p_changes->>'start_minute')::integer, v_series.start_minute);
  v_duration := coalesce((p_changes->>'duration_minutes')::integer, v_series.duration_minutes);
  for v_session in
    select s.id, s.start_time, s.series_occurrence_date, s.status, s.updated_at,
      (select count(*) from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
        where a.session_id = s.id and r.state in ('draft', 'published')) as assignments
    from public.class_sessions s
    where s.series_id = p_series_id and s.series_occurrence_date >= p_from and s.status in ('draft', 'published', 'full')
    order by s.series_occurrence_date
  loop
    v_new_start := (v_session.series_occurrence_date::timestamp + make_interval(mins => v_minute)) at time zone v_series.time_zone;
    v_preview := v_preview || jsonb_build_object('session_id', v_session.id, 'date', v_session.series_occurrence_date,
      'from', v_session.start_time, 'to', v_new_start, 'duration_minutes', v_duration, 'staff_assignments', v_session.assignments);
  end loop;
  if not p_apply then return jsonb_build_object('preview', v_preview); end if;

  update public.class_schedule_series set effective_until = p_from - 1, version = version + 1, updated_at = now() where id = p_series_id;
  insert into public.class_schedule_series (template_id, class_type, title, description, duration_minutes, capacity, location_zone, beginner_friendly,
    intensity_level, booking_mode, weekdays, start_minute, time_zone, effective_from, effective_until, skip_dates, publish_generated, created_by)
  values (v_series.template_id, v_series.class_type, coalesce(p_changes->>'title', v_series.title), v_series.description, v_duration,
    coalesce((p_changes->>'capacity')::integer, v_series.capacity), v_series.location_zone, v_series.beginner_friendly, v_series.intensity_level,
    v_series.booking_mode, v_series.weekdays, v_minute, v_series.time_zone, p_from, v_series.effective_until, v_series.skip_dates,
    v_series.publish_generated, auth.uid())
  returning * into v_new;
  for v_session in
    select s.* from public.class_sessions s
    where s.series_id = p_series_id and s.series_occurrence_date >= p_from and s.status in ('draft', 'published', 'full')
    order by s.series_occurrence_date
  loop
    v_new_start := (v_session.series_occurrence_date::timestamp + make_interval(mins => v_minute)) at time zone v_series.time_zone;
    begin
      perform public.admin_update_class_session(v_session.id, jsonb_build_object(
        'class_type', v_session.class_type, 'title', coalesce(p_changes->>'title', v_session.title), 'description', v_session.description,
        'coach_name', v_session.coach_name, 'start_time', v_new_start, 'end_time', v_new_start + make_interval(mins => v_duration),
        'duration_minutes', v_duration, 'capacity', coalesce((p_changes->>'capacity')::integer, v_session.capacity),
        'location_zone', v_session.location_zone, 'beginner_friendly', v_session.beginner_friendly,
        'intensity_level', v_session.intensity_level, 'status', v_session.status, 'public_visible', v_session.public_visible,
        'booking_mode', v_session.booking_mode, 'notes', v_session.notes));
      update public.class_sessions set series_id = v_new.id where id = v_session.id;
    exception when others then
      v_failures := v_failures || jsonb_build_object('session_id', v_session.id, 'date', v_session.series_occurrence_date, 'reason', sqlerrm);
    end;
  end loop;
  v_result := jsonb_build_object('preview', v_preview, 'new_series_id', v_new.id, 'failures', v_failures);
  perform public.staff_roster_audit('series_changed_from', 'series', p_series_id::text, null, to_jsonb(v_series), v_result);
  return public.staff_roster_remember(p_request_id, 'change_series_from', v_result);
end;
$$;

-- ============================================================================
-- Manager: planning snapshot (one batched read per visible month)
-- ============================================================================

create or replace function public.staff_roster_assignment_json(p_revision uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'revision_id', a.revision_id, 'session_id', a.session_id, 'slot_key', a.slot_key, 'role', a.role,
    'staff_id', a.staff_id, 'pinned', a.pinned, 'source', a.source,
    'session_title', a.session_title, 'session_start', a.session_start, 'session_end', a.session_end, 'session_status', a.session_status
  ) order by a.session_start, a.slot_key), '[]'::jsonb)
  from public.staff_assignments a where a.revision_id = p_revision;
$$;

create or replace function public.staff_roster_planning_snapshot(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from timestamptz := (p_month::timestamp - interval '1 day') at time zone 'Australia/Brisbane';
  v_to timestamptz := ((p_month + interval '1 month')::timestamp + interval '1 day') at time zone 'Australia/Brisbane';
  v_draft public.staff_roster_revisions;
  v_published public.staff_roster_revisions;
  v_sessions jsonb;
  v_session_ids uuid[];
  v_staff_ids uuid[];
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_month_param(p_month);
  select * into v_draft from public.staff_roster_revisions where month = p_month and state = 'draft';
  select * into v_published from public.staff_roster_revisions where month = p_month and state = 'published';
  select array_agg(session_id), coalesce(jsonb_agg(jsonb_build_object(
      'id', session_id, 'title', title, 'class_type', class_type, 'status', status, 'start', starts_at, 'end', ends_at,
      'slots', public.staff_roster_normalize_slots(slots), 'prep_minutes', prep_minutes, 'wrap_minutes', wrap_minutes,
      'allow_block', allow_block, 'series_id', series_id, 'in_month', public.staff_roster_month_of(starts_at) = p_month
    ) order by starts_at, session_id), '[]'::jsonb)
    into v_session_ids, v_sessions
    from public.staff_roster_sessions(v_from, v_to);
  select array_agg(id order by display_name, id) into v_staff_ids from public.staff_members;

  return jsonb_build_object(
    'month', p_month,
    'generated_at', now(),
    'settings', (select to_jsonb(s) - 'updated_by' from public.staff_roster_settings s where id = 1),
    'period', (select to_jsonb(p) from public.staff_roster_periods p where month = p_month),
    'draft', case when v_draft.id is null then null else to_jsonb(v_draft) end,
    'published', case when v_published.id is null then null else to_jsonb(v_published) end,
    'revisions', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'state', state, 'published_at', published_at,
      'published_by', published_by, 'gap_count', gap_count, 'gap_reason', gap_reason) order by number desc), '[]') from public.staff_roster_revisions where month = p_month),
    'sessions', v_sessions,
    'staff', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'display_name', m.display_name, 'legacy_label', m.legacy_label, 'profile_id', m.profile_id, 'coach_id', m.coach_id,
        'roles', m.roles, 'status', m.status, 'version', m.version, 'manager_note', m.manager_note,
        'target_classes_per_month', m.target_classes_per_month, 'min_classes_per_month', m.min_classes_per_month,
        'max_classes_per_week', m.max_classes_per_week, 'max_duty_minutes_per_day', m.max_duty_minutes_per_day, 'min_rest_minutes', m.min_rest_minutes,
        'capabilities', (select coalesce(jsonb_agg(jsonb_build_object('capability', c.capability, 'valid_from', c.valid_from, 'valid_until', c.valid_until) order by c.capability), '[]')
          from public.staff_capabilities c where c.staff_id = m.id),
        'account_email', (select p.email from public.profiles p where p.id = m.profile_id)
      ) order by m.display_name, m.id), '[]') from public.staff_members m),
    'draft_assignments', case when v_draft.id is null then '[]'::jsonb else public.staff_roster_assignment_json(v_draft.id) end,
    'published_assignments', case when v_published.id is null then '[]'::jsonb else public.staff_roster_assignment_json(v_published.id) end,
    'neighbour_assignments', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'session_id', a.session_id, 'slot_key', a.slot_key, 'staff_id', a.staff_id) order by a.id), '[]')
      from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
      where r.state = 'published' and r.month <> p_month and a.session_id = any(coalesce(v_session_ids, '{}'))),
    'availability', (select coalesce(jsonb_agg(jsonb_build_object('staff_id', staff_id, 'session_id', session_id, 'status', status, 'source', source)), '[]')
      from public.staff_roster_availability(coalesce(v_staff_ids, '{}'), coalesce(v_session_ids, '{}'))
      where status <> 'UNKNOWN'),
    'submissions', (select coalesce(jsonb_agg(jsonb_build_object('staff_id', e.staff_id, 'version', e.version, 'no_availability', e.no_availability,
        'submitted_at', e.submitted_at, 'late', e.late,
        'reviewed_session_ids', (select coalesce(jsonb_agg(x->>'session_id'), '[]') from public.staff_availability_submissions s, jsonb_array_elements(s.reviewed_sessions) x where s.id = e.submission_id),
        'reviewed', (select s.reviewed_sessions from public.staff_availability_submissions s where s.id = e.submission_id)
      )), '[]') from public.staff_roster_effective_submissions() e where e.month = p_month),
    'drafts_in_progress', (select coalesce(jsonb_agg(jsonb_build_object('staff_id', staff_id, 'updated_at', updated_at)), '[]') from public.staff_availability_drafts where month = p_month),
    'reopenings', (select coalesce(jsonb_agg(jsonb_build_object('staff_id', staff_id, 'reason', reason, 'reopened_at', reopened_at)), '[]') from public.staff_roster_reopenings where month = p_month and closed_at is null),
    'change_requests', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'staff_id', staff_id, 'message', message, 'created_at', created_at) order by created_at), '[]') from public.staff_roster_change_requests where month = p_month and status = 'open'),
    'absences', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'staff_id', a.staff_id, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
        'kind', a.kind, 'status', a.status, 'reason', a.reason_private, 'version', a.version, 'created_at', a.created_at) order by a.starts_at), '[]')
      from public.staff_absences a where a.ends_at > v_from and a.starts_at < v_to),
    'cover_requests', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'assignment_id', c.assignment_id, 'session_id', c.session_id, 'slot_key', c.slot_key,
        'requester_staff_id', c.requester_staff_id, 'status', c.status, 'reason', c.reason_private, 'version', c.version, 'created_at', c.created_at,
        'revision_id', c.revision_id, 'current', c.revision_id = v_published.id,
        'offers', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'staff_id', o.staff_id, 'status', o.status, 'created_at', o.created_at) order by o.created_at), '[]')
          from public.staff_cover_offers o where o.request_id = c.id)
      ) order by c.created_at), '[]')
      from public.staff_cover_requests c join public.staff_roster_revisions r on r.id = c.revision_id where r.month = p_month),
    'acknowledgements', (select coalesce(jsonb_agg(jsonb_build_object('staff_id', k.staff_id, 'revision_id', k.revision_id, 'acknowledged_at', k.acknowledged_at, 'required_at', k.required_at)), '[]')
      from public.staff_roster_acknowledgements k where k.month = p_month),
    'class_type_staffing', (select coalesce(jsonb_agg(to_jsonb(t) order by class_type), '[]') from public.staff_class_type_staffing t),
    'session_staffing_versions', (select coalesce(jsonb_object_agg(session_id, version), '{}') from public.staff_session_staffing where session_id = any(coalesce(v_session_ids, '{}'))),
    'series', (select coalesce(jsonb_agg(to_jsonb(s) order by s.start_minute, s.title), '[]') from public.class_schedule_series s
      where s.effective_from < (p_month + interval '1 month')::date and (s.effective_until is null or s.effective_until >= p_month))
  );
end;
$$;

create or replace function public.staff_roster_check_assignment(p_month date, p_session uuid, p_slot text, p_staff uuid)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare
  v_revision uuid;
begin
  perform public.staff_roster_require_manager();
  select id into v_revision from public.staff_roster_revisions where month = p_month and state = 'draft';
  if v_revision is null then select id into v_revision from public.staff_roster_revisions where month = p_month and state = 'published'; end if;
  return public.staff_roster_assignment_problems(v_revision, p_session, p_slot, p_staff,
    array(select id from public.staff_assignments where revision_id = v_revision and session_id = p_session and slot_key = p_slot));
end;
$$;

-- ============================================================================
-- Manager: draft edits and publication
-- ============================================================================

-- Applies a batch of draft edits atomically. Every assign/move is checked by
-- the authoritative rules; any hard problem rejects the whole batch.
-- Ops: assign {session_id, slot_key, staff_id, pinned?, source?},
--      unassign {assignment_id}, pin {assignment_id, pinned},
--      move {assignment_id, session_id, slot_key, copy?}.
create or replace function public.staff_roster_apply_changes(p_month date, p_expected_version integer, p_changes jsonb, p_request_id uuid, p_correction_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_draft public.staff_roster_revisions;
  v_change jsonb;
  v_op text;
  v_assignment public.staff_assignments;
  v_session uuid;
  v_slot text;
  v_staff uuid;
  v_problems text[];
  v_role text;
  v_info record;
  v_index integer := 0;
  v_result jsonb;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'apply_changes');
  if v_replay is not null then return v_replay; end if;
  perform public.staff_roster_month_param(p_month);
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 or jsonb_array_length(p_changes) > 500 then
    raise exception 'CHANGES_INVALID';
  end if;
  select * into v_draft from public.staff_roster_revisions where month = p_month and state = 'draft' for update;
  if v_draft.id is null then
    if coalesce(p_expected_version, 0) <> 0 then raise exception 'STALE_VERSION'; end if;
    v_draft := public.staff_roster_draft(p_month);
  elsif v_draft.version <> p_expected_version then
    raise exception 'STALE_VERSION';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_index := v_index + 1;
    v_op := v_change->>'op';
    if v_op = 'unassign' or v_op = 'pin' or v_op = 'move' then
      select * into v_assignment from public.staff_assignments where id = (v_change->>'assignment_id')::uuid and revision_id = v_draft.id;
      if v_assignment.id is null then raise exception 'ASSIGNMENT_NOT_IN_DRAFT' using detail = jsonb_build_object('index', v_index)::text; end if;
      if v_op <> 'pin' and v_assignment.session_start <= now() and p_correction_reason is null then
        raise exception 'HISTORY_LOCKED' using detail = jsonb_build_object('index', v_index)::text;
      end if;
    end if;

    if v_op = 'unassign' then
      delete from public.staff_assignments where id = v_assignment.id;
      perform public.staff_roster_audit('assignment_removed', 'assignment', v_assignment.id::text, p_month, to_jsonb(v_assignment), null, p_correction_reason);
    elsif v_op = 'pin' then
      update public.staff_assignments set pinned = coalesce((v_change->>'pinned')::boolean, true) where id = v_assignment.id;
    elsif v_op in ('assign', 'move') then
      v_session := (v_change->>'session_id')::uuid;
      v_slot := v_change->>'slot_key';
      v_staff := case when v_op = 'move' then v_assignment.staff_id else (v_change->>'staff_id')::uuid end;
      v_problems := public.staff_roster_assignment_problems(v_draft.id, v_session, v_slot, v_staff,
        case when v_op = 'move' and not coalesce((v_change->>'copy')::boolean, false) then array[v_assignment.id] else '{}'::uuid[] end);
      if p_correction_reason is not null then
        v_problems := array(select p from unnest(v_problems) p where p not in ('SESSION_STARTED', 'AVAILABILITY_UNKNOWN', 'AVAILABILITY_PARTIAL'));
      end if;
      if cardinality(v_problems) > 0 then
        raise exception 'ASSIGNMENT_BLOCKED' using detail = jsonb_build_object('index', v_index, 'session_id', v_session, 'slot_key', v_slot, 'staff_id', v_staff, 'problems', to_jsonb(v_problems))::text;
      end if;
      select title, starts_at, ends_at, status, x->>'role' as role into v_info
        from public.staff_roster_sessions(null, null, array[v_session]) s,
        jsonb_array_elements(public.staff_roster_normalize_slots(s.slots)) x where x->>'key' = v_slot;
      if v_op = 'move' and not coalesce((v_change->>'copy')::boolean, false) then
        delete from public.staff_assignments where id = v_assignment.id;
      end if;
      insert into public.staff_assignments (revision_id, session_id, slot_key, role, staff_id, pinned, source,
        session_title, session_start, session_end, session_status, created_by)
      values (v_draft.id, v_session, v_slot, v_info.role, v_staff,
        coalesce((v_change->>'pinned')::boolean, case when v_op = 'move' then v_assignment.pinned else false end),
        coalesce(nullif(v_change->>'source', ''), case when v_op = 'move' then 'manual' else 'manual' end),
        v_info.title, v_info.starts_at, v_info.ends_at, v_info.status, auth.uid())
      returning * into v_assignment;
      perform public.staff_roster_audit(case when v_op = 'move' then 'assignment_moved' else 'assignment_added' end,
        'assignment', v_assignment.id::text, p_month, v_change, to_jsonb(v_assignment), p_correction_reason);
    else
      raise exception 'OP_INVALID' using detail = jsonb_build_object('index', v_index)::text;
    end if;
  end loop;

  update public.staff_roster_revisions set version = version + 1 where id = v_draft.id returning * into v_draft;
  v_result := jsonb_build_object('revision_id', v_draft.id, 'version', v_draft.version, 'number', v_draft.number,
    'assignments', public.staff_roster_assignment_json(v_draft.id));
  return public.staff_roster_remember(p_request_id, 'apply_changes', v_result);
end;
$$;

create or replace function public.staff_roster_discard_draft(p_month date, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_draft public.staff_roster_revisions;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'discard_draft');
  if v_replay is not null then return v_replay; end if;
  select * into v_draft from public.staff_roster_revisions where month = p_month and state = 'draft' for update;
  if v_draft.id is null then raise exception 'NO_DRAFT'; end if;
  if v_draft.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  update public.staff_roster_revisions set state = 'discarded' where id = v_draft.id;
  perform public.staff_roster_audit('draft_discarded', 'revision', v_draft.id::text, p_month, to_jsonb(v_draft), null);
  return public.staff_roster_remember(p_request_id, 'discard_draft', jsonb_build_object('discarded', v_draft.id));
end;
$$;

-- Required positions with nobody in them, for live future sessions in a month.
create or replace function public.staff_roster_gaps(p_revision uuid, p_month date)
returns table (session_id uuid, slot_key text, starts_at timestamptz, title text)
language sql stable security definer set search_path = public as $$
  select s.session_id, x->>'key', s.starts_at, s.title
  from public.staff_roster_sessions(
    (p_month::timestamp) at time zone 'Australia/Brisbane',
    ((p_month + interval '1 month')::timestamp) at time zone 'Australia/Brisbane') s
  cross join lateral jsonb_array_elements(public.staff_roster_normalize_slots(s.slots)) x
  where s.status in ('draft', 'published', 'full') and s.starts_at > now()
    and public.staff_roster_month_of(s.starts_at) = p_month
    and coalesce((x->>'required')::boolean, true)
    and not exists (select 1 from public.staff_assignments a where a.revision_id = p_revision and a.session_id = s.session_id and a.slot_key = x->>'key');
$$;

-- Publishes the month's draft atomically after re-validating every future
-- assignment against current sessions, availability, capabilities and other
-- months. Hard problems block; gaps need an explicit reason. Returns
-- {ok:false, ...} without changing anything when blocked.
-- Public coach names: only staff linked to a PUBLISHED website coach profile
-- are named publicly, and only by that profile's name. A name someone typed
-- on the class by hand is kept and counted, never overwritten.
create or replace function public.staff_roster_project_public_names(p_month date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_revision uuid;
  v_row record;
  v_written integer := 0;
  v_cleared integer := 0;
  v_kept integer := 0;
begin
  if not coalesce((select public_coach_names_enabled from public.staff_roster_settings where id = 1), false) then
    return jsonb_build_object('enabled', false);
  end if;
  select id into v_revision from public.staff_roster_revisions where month = p_month and state = 'published';
  if v_revision is null then return jsonb_build_object('enabled', true, 'written', 0, 'cleared', 0, 'kept_manual', 0); end if;
  for v_row in
    select s.id, nullif(btrim(s.coach_name), '') as current_name, p.projected_name as last_name,
      (select c.name from public.staff_assignments a
         join public.staff_members m on m.id = a.staff_id
         join public.coaches c on c.id = m.coach_id and c.published
       where a.revision_id = v_revision and a.session_id = s.id and a.role = 'lead'
       order by (a.slot_key = 'lead') desc, a.slot_key limit 1) as next_name
    from public.class_sessions s
    left join public.staff_roster_public_names p on p.session_id = s.id
    where s.start_time >= public.staff_roster_local(p_month, 0)
      and s.start_time < public.staff_roster_local((p_month + interval '1 month')::date, 0)
      and s.start_time > now() and s.status in ('draft', 'published', 'full')
  loop
    if v_row.current_name is not null and v_row.current_name is distinct from v_row.last_name then
      v_kept := v_kept + 1;
      continue;
    end if;
    if v_row.next_name is not distinct from v_row.current_name then
      if v_row.next_name is null then delete from public.staff_roster_public_names where session_id = v_row.id; end if;
      continue;
    end if;
    update public.class_sessions set coach_name = v_row.next_name where id = v_row.id;
    if v_row.next_name is null then
      delete from public.staff_roster_public_names where session_id = v_row.id;
      v_cleared := v_cleared + 1;
    else
      insert into public.staff_roster_public_names (session_id, projected_name, revision_id) values (v_row.id, v_row.next_name, v_revision)
      on conflict (session_id) do update set projected_name = excluded.projected_name, revision_id = excluded.revision_id, updated_at = now();
      v_written := v_written + 1;
    end if;
  end loop;
  return jsonb_build_object('enabled', true, 'written', v_written, 'cleared', v_cleared, 'kept_manual', v_kept);
end;
$$;

create or replace function public.staff_roster_publish(p_month date, p_expected_version integer, p_gap_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_draft public.staff_roster_revisions;
  v_previous public.staff_roster_revisions;
  v_assignment record;
  v_problems text[];
  v_blocked jsonb := '[]'::jsonb;
  v_gaps integer;
  v_affected uuid[];
  v_staff uuid;
  v_profile uuid;
  v_result jsonb;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'publish');
  if v_replay is not null then return v_replay; end if;
  select * into v_draft from public.staff_roster_revisions where month = p_month and state = 'draft' for update;
  if v_draft.id is null then raise exception 'NO_DRAFT'; end if;
  if v_draft.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;

  for v_assignment in
    select a.* from public.staff_assignments a join public.class_sessions s on s.id = a.session_id
    where a.revision_id = v_draft.id and s.start_time > now() and s.status in ('draft', 'published', 'full')
    order by s.start_time, a.slot_key
  loop
    v_problems := public.staff_roster_assignment_problems(v_draft.id, v_assignment.session_id, v_assignment.slot_key, v_assignment.staff_id, array[v_assignment.id]);
    if cardinality(v_problems) > 0 then
      v_blocked := v_blocked || jsonb_build_object('assignment_id', v_assignment.id, 'session_id', v_assignment.session_id,
        'slot_key', v_assignment.slot_key, 'staff_id', v_assignment.staff_id, 'problems', to_jsonb(v_problems));
    end if;
  end loop;
  if jsonb_array_length(v_blocked) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'HARD_CONFLICTS', 'blocked', v_blocked);
  end if;
  select count(*) into v_gaps from public.staff_roster_gaps(v_draft.id, p_month);
  if v_gaps > 0 and char_length(btrim(coalesce(p_gap_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'GAPS_NEED_ACKNOWLEDGEMENT', 'gaps', v_gaps);
  end if;

  select * into v_previous from public.staff_roster_revisions where month = p_month and state = 'published' for update;
  -- Coaches whose own published lines change: added, removed, or moved slot.
  select coalesce(array_agg(distinct staff_id), '{}') into v_affected from (
    (select session_id, slot_key, staff_id from public.staff_assignments where revision_id = v_draft.id
     except select session_id, slot_key, staff_id from public.staff_assignments where revision_id = v_previous.id)
    union
    (select session_id, slot_key, staff_id from public.staff_assignments where revision_id = v_previous.id
     except select session_id, slot_key, staff_id from public.staff_assignments where revision_id = v_draft.id)
  ) changed;

  if v_previous.id is not null then
    update public.staff_roster_revisions set state = 'superseded', superseded_at = now() where id = v_previous.id;
  end if;
  update public.staff_roster_revisions set state = 'published', published_at = now(), published_by = auth.uid(),
    gap_count = v_gaps, gap_reason = case when v_gaps > 0 then btrim(p_gap_reason) else null end
  where id = v_draft.id returning * into v_draft;
  update public.staff_assignments a set session_title = s.title, session_start = s.starts_at, session_end = s.ends_at, session_status = s.status
  from public.staff_roster_sessions(null, null, array(select session_id from public.staff_assignments where revision_id = v_draft.id and session_id is not null)) s
  where a.revision_id = v_draft.id and a.session_id = s.session_id;

  foreach v_staff in array v_affected loop
    insert into public.staff_roster_acknowledgements (staff_id, revision_id, month) values (v_staff, v_draft.id, p_month)
    on conflict do nothing;
    select profile_id into v_profile from public.staff_members where id = v_staff;
    perform public.staff_roster_notify(v_profile, 'roster_published', 'publish:' || v_draft.id::text || ':' || v_staff::text,
      'Roster updated for ' || to_char(p_month, 'FMMonth YYYY'),
      'Your coaching roster for ' || to_char(p_month, 'FMMonth YYYY') || ' has changed. Open My Roster to see your classes.',
      '/coaching?tab=roster&month=' || to_char(p_month, 'YYYY-MM'), p_month);
  end loop;
  perform public.staff_roster_audit('roster_published', 'revision', v_draft.id::text, p_month,
    case when v_previous.id is null then null else jsonb_build_object('revision', v_previous.number) end,
    jsonb_build_object('revision', v_draft.number, 'gaps', v_gaps, 'affected', to_jsonb(v_affected)), p_gap_reason);
  v_result := jsonb_build_object('ok', true, 'revision_id', v_draft.id, 'number', v_draft.number, 'gaps', v_gaps, 'affected_staff', to_jsonb(v_affected),
    'public_names', public.staff_roster_project_public_names(p_month));
  return public.staff_roster_remember(p_request_id, 'publish', v_result);
end;
$$;

-- ============================================================================
-- Manager: absences and cover
-- ============================================================================

create or replace function public.staff_roster_decide_absence(p_absence_id uuid, p_decision text, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_before public.staff_absences;
  v_after public.staff_absences;
  v_profile uuid;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'decide_absence');
  if v_replay is not null then return v_replay; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'DECISION_INVALID'; end if;
  select * into v_before from public.staff_absences where id = p_absence_id for update;
  if v_before.id is null then raise exception 'ABSENCE_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  if v_before.status not in ('requested', 'reported') then raise exception 'ABSENCE_ALREADY_DECIDED'; end if;
  update public.staff_absences set status = p_decision, decided_by = auth.uid(), decided_at = now(), version = version + 1
  where id = p_absence_id returning * into v_after;
  select profile_id into v_profile from public.staff_members where id = v_after.staff_id;
  perform public.staff_roster_notify(v_profile, 'absence_' || p_decision, 'absence:' || p_absence_id::text || ':' || p_decision,
    'Absence ' || p_decision, 'Your absence request has been ' || p_decision || '.', '/coaching?tab=requests', null);
  perform public.staff_roster_audit('absence_' || p_decision, 'absence', p_absence_id::text, null, to_jsonb(v_before) - 'reason_private', to_jsonb(v_after) - 'reason_private');
  return public.staff_roster_remember(p_request_id, 'decide_absence', to_jsonb(v_after) - 'reason_private');
end;
$$;

-- A manager records an absence a coach reported by phone or in person.
create or replace function public.staff_roster_record_absence(p_staff_id uuid, p_starts timestamptz, p_ends timestamptz, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_row public.staff_absences;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'record_absence');
  if v_replay is not null then return v_replay; end if;
  insert into public.staff_absences (staff_id, starts_at, ends_at, kind, status, reason_private, decided_by, decided_at, created_by)
  values (p_staff_id, p_starts, p_ends, 'planned', 'approved', nullif(btrim(p_reason), ''), auth.uid(), now(), auth.uid())
  returning * into v_row;
  perform public.staff_roster_audit('absence_recorded', 'absence', v_row.id::text, null, null, to_jsonb(v_row) - 'reason_private');
  return public.staff_roster_remember(p_request_id, 'record_absence', to_jsonb(v_row) - 'reason_private');
end;
$$;

-- Approves one volunteer. Revalidated now, bound to the published revision
-- the request was made against; a newer roster supersedes the request. The
-- lock plus status check means two approvals can never both win.
create or replace function public.staff_roster_approve_cover(p_cover_id uuid, p_offer_id uuid, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_cover public.staff_cover_requests;
  v_offer public.staff_cover_offers;
  v_published public.staff_roster_revisions;
  v_new public.staff_roster_revisions;
  v_draft public.staff_roster_revisions;
  v_assignment public.staff_assignments;
  v_problems text[];
  v_profile uuid;
  v_month date;
  v_result jsonb;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'approve_cover');
  if v_replay is not null then return v_replay; end if;
  select * into v_cover from public.staff_cover_requests where id = p_cover_id for update;
  if v_cover.id is null then raise exception 'COVER_NOT_FOUND'; end if;
  if v_cover.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  if v_cover.status <> 'offered' then raise exception 'COVER_NOT_AWAITING_APPROVAL'; end if;
  select * into v_offer from public.staff_cover_offers where id = p_offer_id and request_id = p_cover_id for update;
  if v_offer.id is null or v_offer.status <> 'offered' then raise exception 'OFFER_NOT_AVAILABLE'; end if;
  select month into v_month from public.staff_roster_revisions where id = v_cover.revision_id;
  select * into v_published from public.staff_roster_revisions where month = v_month and state = 'published' for update;
  select * into v_assignment from public.staff_assignments where id = v_cover.assignment_id;
  if v_published.id is distinct from v_cover.revision_id then
    update public.staff_cover_requests set status = 'superseded', version = version + 1 where id = p_cover_id;
    perform public.staff_roster_remember(p_request_id, 'approve_cover', jsonb_build_object('ok', false, 'reason', 'SUPERSEDED'));
    return jsonb_build_object('ok', false, 'reason', 'SUPERSEDED');
  end if;
  v_problems := public.staff_roster_assignment_problems(v_published.id, v_assignment.session_id, v_assignment.slot_key, v_offer.staff_id, array[v_assignment.id]);
  if cardinality(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'VOLUNTEER_NOT_ELIGIBLE', 'problems', to_jsonb(v_problems));
  end if;

  -- New published revision: the previous one, with this one slot changed.
  update public.staff_roster_revisions set state = 'superseded', superseded_at = now() where id = v_published.id;
  insert into public.staff_roster_revisions (month, number, state, based_on, created_by, published_by, published_at, gap_count, gap_reason, version)
  values (v_month, (select max(number) + 1 from public.staff_roster_revisions where month = v_month), 'published', v_published.id,
    auth.uid(), auth.uid(), now(), v_published.gap_count, v_published.gap_reason, 1)
  returning * into v_new;
  insert into public.staff_assignments (revision_id, session_id, slot_key, role, staff_id, pinned, source,
    session_title, session_start, session_end, session_status, created_by)
  select v_new.id, session_id, slot_key, role,
    case when id = v_assignment.id then v_offer.staff_id else staff_id end,
    pinned, case when id = v_assignment.id then 'cover' else source end,
    session_title, session_start, session_end, session_status, created_by
  from public.staff_assignments where revision_id = v_published.id;

  -- Keep an open draft consistent where it still has the same person there.
  select * into v_draft from public.staff_roster_revisions where month = v_month and state = 'draft' for update;
  if v_draft.id is not null then
    update public.staff_assignments set staff_id = v_offer.staff_id, source = 'cover'
    where revision_id = v_draft.id and session_id = v_assignment.session_id and slot_key = v_assignment.slot_key and staff_id = v_cover.requester_staff_id
      and not exists (select 1 from public.staff_assignments x where x.revision_id = v_draft.id and x.session_id = v_assignment.session_id and x.staff_id = v_offer.staff_id);
    update public.staff_roster_revisions set version = version + 1 where id = v_draft.id;
  end if;

  update public.staff_cover_offers set status = case when id = p_offer_id then 'approved' else 'declined' end
    where request_id = p_cover_id and status = 'offered';
  update public.staff_cover_requests set status = 'approved', approved_offer_id = p_offer_id, decided_by = auth.uid(), decided_at = now(), version = version + 1
    where id = p_cover_id;
  -- Other open requests bound to the replaced revision now point at a stale roster.
  update public.staff_cover_requests set revision_id = v_new.id,
    assignment_id = (select n.id from public.staff_assignments o join public.staff_assignments n on n.revision_id = v_new.id
      and n.session_id = o.session_id and n.slot_key = o.slot_key and n.staff_id = o.staff_id where o.id = staff_cover_requests.assignment_id)
    where revision_id = v_published.id and status in ('open', 'offered') and id <> p_cover_id;

  insert into public.staff_roster_acknowledgements (staff_id, revision_id, month)
  values (v_offer.staff_id, v_new.id, v_month), (v_cover.requester_staff_id, v_new.id, v_month) on conflict do nothing;
  select profile_id into v_profile from public.staff_members where id = v_offer.staff_id;
  perform public.staff_roster_notify(v_profile, 'cover_approved', 'cover-approved:' || p_cover_id::text || ':volunteer',
    'You are covering a class', 'Your offer to cover ' || coalesce(v_assignment.session_title, 'a class') || ' on '
      || to_char(v_assignment.session_start at time zone 'Australia/Brisbane', 'Dy DD Mon, FMHH12:MI am') || ' was approved.',
    '/coaching?tab=roster', v_month);
  select profile_id into v_profile from public.staff_members where id = v_cover.requester_staff_id;
  perform public.staff_roster_notify(v_profile, 'cover_approved', 'cover-approved:' || p_cover_id::text || ':requester',
    'Cover approved', 'A replacement for ' || coalesce(v_assignment.session_title, 'your class') || ' on '
      || to_char(v_assignment.session_start at time zone 'Australia/Brisbane', 'Dy DD Mon, FMHH12:MI am') || ' has been approved. You are no longer rostered for it.',
    '/coaching?tab=roster', v_month);
  perform public.staff_roster_audit('cover_approved', 'cover', p_cover_id::text, v_month,
    jsonb_build_object('staff_id', v_cover.requester_staff_id, 'revision', v_published.number),
    jsonb_build_object('staff_id', v_offer.staff_id, 'revision', v_new.number));
  v_result := jsonb_build_object('ok', true, 'revision_id', v_new.id, 'number', v_new.number,
    'public_names', public.staff_roster_project_public_names(v_month));
  return public.staff_roster_remember(p_request_id, 'approve_cover', v_result);
end;
$$;

create or replace function public.staff_roster_reject_cover(p_cover_id uuid, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_cover public.staff_cover_requests;
  v_profile uuid;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'reject_cover');
  if v_replay is not null then return v_replay; end if;
  select * into v_cover from public.staff_cover_requests where id = p_cover_id for update;
  if v_cover.id is null then raise exception 'COVER_NOT_FOUND'; end if;
  if v_cover.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  if v_cover.status not in ('open', 'offered') then raise exception 'COVER_ALREADY_DECIDED'; end if;
  update public.staff_cover_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), version = version + 1 where id = p_cover_id;
  update public.staff_cover_offers set status = 'declined' where request_id = p_cover_id and status = 'offered';
  select profile_id into v_profile from public.staff_members where id = v_cover.requester_staff_id;
  perform public.staff_roster_notify(v_profile, 'cover_rejected', 'cover-rejected:' || p_cover_id::text,
    'Cover request declined', 'Your cover request was declined. You are still rostered for this class.', '/coaching?tab=requests', null);
  perform public.staff_roster_audit('cover_rejected', 'cover', p_cover_id::text, null, null, null);
  return public.staff_roster_remember(p_request_id, 'reject_cover', jsonb_build_object('ok', true));
end;
$$;

-- ============================================================================
-- Manager: reminders, delivery state, audit
-- ============================================================================

-- Queues due availability reminders. Safe to run repeatedly (every notice is
-- keyed by period, reminder and recipient). Never reminds for a time before a
-- period was opened, never chases a coach who submitted (including "no
-- availability"), and sends at the configured local daytime minute.
create or replace function public.staff_roster_run_reminders(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_settings public.staff_roster_settings;
  v_period public.staff_roster_periods;
  v_send_minute integer;
  v_kind text;
  v_date date;
  v_days integer;
  v_queued integer := 0;
  v_staff record;
  v_missing integer;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'MANAGER_ONLY'; end if;
  select * into v_settings from public.staff_roster_settings where id = 1;
  if not coalesce(v_settings.enabled, false) then return 0; end if;
  v_send_minute := coalesce((v_settings.reminders->>'sendMinute')::integer, 540);
  for v_period in select * from public.staff_roster_periods where due_on >= (p_now at time zone 'Australia/Brisbane')::date - 7 loop
    for v_kind, v_date in
      select 'opened', v_period.opens_on where coalesce((v_settings.reminders->>'onOpen')::boolean, true)
      union all
      select 'due_in_' || d, v_period.due_on - d from jsonb_array_elements_text(coalesce(v_settings.reminders->'daysBeforeDue', '[3]')) as t(d_text),
        lateral (select d_text::integer as d) x where v_period.due_on - d > v_period.opens_on
      union all
      select 'due_today', v_period.due_on where coalesce((v_settings.reminders->>'onDue')::boolean, true)
    loop
      if v_date < v_period.opens_on or v_date < (v_period.opened_at at time zone 'Australia/Brisbane')::date then continue; end if;
      if public.staff_roster_local(v_date, v_send_minute) > p_now then continue; end if;
      if (p_now at time zone 'Australia/Brisbane')::date > v_date + 1 then continue; end if;
      for v_staff in
        select m.id, m.profile_id from public.staff_members m
        where m.status = 'active' and m.profile_id is not null
          and not exists (select 1 from public.staff_availability_submissions s where s.staff_id = m.id and s.month = v_period.month)
        order by m.id
      loop
        if public.staff_roster_notify(v_staff.profile_id, 'availability_reminder',
          'reminder:' || v_period.month::text || ':' || v_kind || ':' || v_staff.id::text,
          case v_kind when 'opened' then 'Availability open for ' || to_char(v_period.month, 'FMMonth YYYY')
            when 'due_today' then 'Availability due today'
            else 'Availability due ' || to_char(v_period.due_on, 'FMDay DD FMMonth') end,
          'Please submit your availability for ' || to_char(v_period.month, 'FMMonth YYYY') || ' by ' || to_char(v_period.due_on, 'FMDay DD FMMonth') || '.',
          '/coaching?tab=availability&month=' || to_char(v_period.month, 'YYYY-MM'), v_period.month,
          public.staff_roster_local(v_date, v_send_minute)) is not null then
          v_queued := v_queued + 1;
        end if;
      end loop;
    end loop;
    if coalesce((v_settings.reminders->>'overdueSummary')::boolean, true)
       and public.staff_roster_local(v_period.due_on + 1, v_send_minute) <= p_now
       and (p_now at time zone 'Australia/Brisbane')::date <= v_period.due_on + 2 then
      select count(*) into v_missing from public.staff_members m
        where m.status = 'active' and not exists (select 1 from public.staff_availability_submissions s where s.staff_id = m.id and s.month = v_period.month);
      if v_missing > 0 then
        perform public.staff_roster_notify_managers('overdue_summary', 'overdue:' || v_period.month::text,
          v_missing || ' coaches have not submitted availability',
          v_missing || ' active coaches have not submitted availability for ' || to_char(v_period.month, 'FMMonth YYYY') || ', which was due ' || to_char(v_period.due_on, 'FMDD FMMonth') || '.',
          '/admin/roster?rosterTab=availability&rosterMonth=' || to_char(v_period.month, 'YYYY-MM'), v_period.month);
        v_queued := v_queued + 1;
      end if;
    end if;
  end loop;
  return v_queued;
end;
$$;

create or replace function public.staff_roster_notification_log(p_month date default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_roster_require_manager();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'recipient', coalesce(p.full_name, p.email),
      'created_at', n.created_at, 'deliver_after', n.deliver_after, 'read_at', n.read_at,
      'email_status', case when n.email_log_id is not null then coalesce((select l.status from public.email_log l where l.id = n.email_log_id), n.email_status) else n.email_status end
    ) order by n.created_at desc)
    from (select * from public.staff_notifications where p_month is null or month = p_month order by created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) n
    left join public.profiles p on p.id = n.recipient_profile_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.staff_roster_audit_log(p_month date default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_roster_require_manager();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor', coalesce(p.full_name, p.email), 'action', e.action,
      'entity', e.entity, 'entity_id', e.entity_id, 'month', e.month, 'reason', e.reason, 'before', e.before, 'after', e.after) order by e.id desc)
    from (select * from public.staff_roster_audit_events where p_month is null or month = p_month order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) e
    left join public.profiles p on p.id = e.actor
  ), '[]'::jsonb);
end;
$$;

-- ============================================================================
-- Coach: availability
-- ============================================================================

-- Server-side validation of an availability payload for a month; mirrors
-- src/lib/staffRoster/availability.js `validateAvailability`.
create or replace function public.staff_roster_validate_availability(p_payload jsonb, p_month date)
returns text[] language plpgsql stable set search_path = public as $$
declare
  v_errors text[] := '{}';
  v_none boolean := coalesce((p_payload->>'noAvailability')::boolean, false);
  v_weekly jsonb := coalesce(p_payload->'weekly', '[]');
  v_exceptions jsonb := coalesce(p_payload->'exceptions', '[]');
begin
  if jsonb_typeof(v_weekly) <> 'array' or jsonb_typeof(v_exceptions) <> 'array'
     or jsonb_array_length(v_weekly) > 200 or jsonb_array_length(v_exceptions) > 400 then
    return array['PAYLOAD_INVALID'];
  end if;
  if exists (select 1 from jsonb_to_recordset(v_weekly) as w(weekday integer, start integer, "end" integer, status text)
      where weekday is null or weekday not between 0 and 6 or start is null or "end" is null
        or start < 0 or "end" > 1440 or "end" <= start
        or status is null or status not in ('PREFERRED', 'AVAILABLE', 'IF_NEEDED', 'UNAVAILABLE')) then
    v_errors := v_errors || 'WEEKLY_WINDOW_INVALID'::text;
  end if;
  if exists (select 1 from jsonb_to_recordset(v_exceptions) as e(date date, start integer, "end" integer, status text)
      where date is null or date_trunc('month', date)::date <> p_month or start is null or "end" is null
        or start < 0 or "end" > 1440 or "end" <= start
        or status is null or status not in ('PREFERRED', 'AVAILABLE', 'IF_NEEDED', 'UNAVAILABLE')) then
    v_errors := v_errors || 'EXCEPTION_WINDOW_INVALID'::text;
  end if;
  if cardinality(v_errors) > 0 then return v_errors; end if;
  if exists (select 1 from jsonb_to_recordset(v_weekly) as a(weekday integer, start integer, "end" integer, status text)
      join jsonb_to_recordset(v_weekly) as b(weekday integer, start integer, "end" integer, status text)
        on a.weekday = b.weekday and a.status <> b.status and a.start < b."end" and b.start < a."end") then
    v_errors := v_errors || 'WEEKLY_CONTRADICTION'::text;
  end if;
  if exists (select 1 from jsonb_to_recordset(v_exceptions) as a(date date, start integer, "end" integer, status text)
      join jsonb_to_recordset(v_exceptions) as b(date date, start integer, "end" integer, status text)
        on a.date = b.date and a.status <> b.status and a.start < b."end" and b.start < a."end") then
    v_errors := v_errors || 'EXCEPTION_CONTRADICTION'::text;
  end if;
  if v_none and (
    exists (select 1 from jsonb_to_recordset(v_weekly) as w(status text) where status <> 'UNAVAILABLE')
    or exists (select 1 from jsonb_to_recordset(v_exceptions) as e(status text) where status <> 'UNAVAILABLE')) then
    v_errors := v_errors || 'NO_AVAILABILITY_WITH_TIMES'::text;
  end if;
  if not v_none and jsonb_array_length(v_weekly) = 0 and jsonb_array_length(v_exceptions) = 0 then
    v_errors := v_errors || 'EMPTY_SUBMISSION'::text;
  end if;
  return v_errors;
end;
$$;

create or replace function public.staff_roster_me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_today date := public.staff_roster_today();
begin
  v_staff := public.staff_roster_current_staff();
  return jsonb_build_object(
    'staff', jsonb_build_object('id', v_staff.id, 'display_name', v_staff.display_name, 'roles', v_staff.roles, 'status', v_staff.status),
    'today', v_today,
    'settings', (select jsonb_build_object('class_time_presets', class_time_presets, 'cycle', cycle) from public.staff_roster_settings where id = 1),
    'usual_week', (select jsonb_build_object('pattern', pattern, 'version', version, 'updated_at', updated_at) from public.staff_weekly_patterns where staff_id = v_staff.id),
    'last_submission', (select jsonb_build_object('month', month, 'payload', payload, 'no_availability', no_availability)
      from public.staff_availability_submissions where staff_id = v_staff.id order by month desc, version desc limit 1),
    'periods', (select coalesce(jsonb_agg(jsonb_build_object(
        'month', p.month, 'opens_on', p.opens_on, 'due_on', p.due_on, 'publish_target_on', p.publish_target_on, 'shortened', p.shortened,
        'is_open', v_today >= p.opens_on,
        'deadline_passed', v_today > p.due_on,
        'reopened', exists (select 1 from public.staff_roster_reopenings r where r.month = p.month and r.staff_id = v_staff.id and r.closed_at is null),
        'change_request_open', exists (select 1 from public.staff_roster_change_requests c where c.month = p.month and c.staff_id = v_staff.id and c.status = 'open'),
        'draft', (select jsonb_build_object('payload', d.payload, 'version', d.version, 'updated_at', d.updated_at) from public.staff_availability_drafts d where d.staff_id = v_staff.id and d.month = p.month),
        'submission', (select jsonb_build_object('version', s.version, 'payload', s.payload, 'submitted_at', s.submitted_at, 'late', s.late, 'no_availability', s.no_availability)
          from public.staff_availability_submissions s where s.staff_id = v_staff.id and s.month = p.month order by s.version desc limit 1)
      ) order by p.month), '[]') from public.staff_roster_periods p where p.month >= date_trunc('month', v_today)::date - interval '1 month'),
    'unread_notifications', (select count(*) from public.staff_notifications where recipient_profile_id = auth.uid() and read_at is null and deliver_after <= now()),
    'pending_acknowledgements', (select coalesce(jsonb_agg(jsonb_build_object('month', k.month, 'revision_id', k.revision_id, 'number', r.number) order by k.month), '[]')
      from public.staff_roster_acknowledgements k join public.staff_roster_revisions r on r.id = k.revision_id
      where k.staff_id = v_staff.id and k.acknowledged_at is null and r.state = 'published')
  );
end;
$$;

-- Live classes in a month (times and duties only; no assignments or people),
-- for class-slot shortcuts and the review step.
create or replace function public.staff_roster_month_classes(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then perform public.staff_roster_current_staff(); end if;
  perform public.staff_roster_month_param(p_month);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', session_id, 'title', title, 'class_type', class_type, 'start', starts_at, 'end', ends_at,
      'duty_start', lower(duty), 'duty_end', upper(duty), 'prep_minutes', prep_minutes, 'wrap_minutes', wrap_minutes, 'allow_block', allow_block) order by starts_at)
    from public.staff_roster_sessions((p_month::timestamp) at time zone 'Australia/Brisbane', ((p_month + interval '1 month')::timestamp) at time zone 'Australia/Brisbane')
    where status in ('draft', 'published', 'full') and public.staff_roster_month_of(starts_at) = p_month
  ), '[]'::jsonb);
end;
$$;

create or replace function public.staff_roster_save_usual_week(p_pattern jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_row public.staff_weekly_patterns;
  v_errors text[];
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_errors := array(select e from unnest(public.staff_roster_validate_availability(jsonb_build_object('weekly', coalesce(p_pattern, '[]')), date_trunc('month', now())::date)) e where e <> 'EMPTY_SUBMISSION');
  if cardinality(v_errors) > 0 then raise exception 'AVAILABILITY_INVALID' using detail = to_jsonb(v_errors)::text; end if;
  select * into v_row from public.staff_weekly_patterns where staff_id = v_staff.id for update;
  if coalesce(v_row.version, 0) <> coalesce(p_expected_version, 0) then raise exception 'STALE_VERSION'; end if;
  insert into public.staff_weekly_patterns (staff_id, pattern) values (v_staff.id, coalesce(p_pattern, '[]'))
  on conflict (staff_id) do update set pattern = excluded.pattern, version = staff_weekly_patterns.version + 1, updated_at = now()
  returning * into v_row;
  return jsonb_build_object('version', v_row.version, 'updated_at', v_row.updated_at);
end;
$$;

-- Autosave. Never changes the effective (submitted) availability.
create or replace function public.staff_roster_save_availability_draft(p_month date, p_payload jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_row public.staff_availability_drafts;
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  perform public.staff_roster_month_param(p_month);
  if not exists (select 1 from public.staff_roster_periods where month = p_month) then raise exception 'PERIOD_NOT_OPEN'; end if;
  select * into v_row from public.staff_availability_drafts where staff_id = v_staff.id and month = p_month for update;
  if coalesce(v_row.version, 0) <> coalesce(p_expected_version, 0) then raise exception 'STALE_VERSION'; end if;
  insert into public.staff_availability_drafts (staff_id, month, payload) values (v_staff.id, p_month, p_payload)
  on conflict (staff_id, month) do update set payload = excluded.payload, version = staff_availability_drafts.version + 1, updated_at = now()
  returning * into v_row;
  return jsonb_build_object('version', v_row.version, 'updated_at', v_row.updated_at);
end;
$$;

-- Submit Month: a new versioned snapshot. The previous version stays
-- effective until this transaction commits.
create or replace function public.staff_roster_submit_availability(p_month date, p_payload jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_staff public.staff_members;
  v_period public.staff_roster_periods;
  v_today date := public.staff_roster_today();
  v_reopening uuid;
  v_errors text[];
  v_none boolean := coalesce((p_payload->>'noAvailability')::boolean, false);
  v_submission public.staff_availability_submissions;
  v_month_start timestamptz := (p_month::timestamp) at time zone 'Australia/Brisbane';
  v_month_end timestamptz := ((p_month + interval '1 month')::timestamp) at time zone 'Australia/Brisbane';
  v_result jsonb;
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'submit_availability');
  if v_replay is not null then return v_replay; end if;
  select * into v_period from public.staff_roster_periods where month = public.staff_roster_month_param(p_month);
  if v_period.month is null or v_today < v_period.opens_on then raise exception 'PERIOD_NOT_OPEN'; end if;
  select id into v_reopening from public.staff_roster_reopenings where month = p_month and staff_id = v_staff.id and closed_at is null;
  if v_today > v_period.due_on and v_reopening is null then raise exception 'DEADLINE_PASSED'; end if;
  v_errors := public.staff_roster_validate_availability(p_payload, p_month);
  if cardinality(v_errors) > 0 then raise exception 'AVAILABILITY_INVALID' using detail = to_jsonb(v_errors)::text; end if;

  insert into public.staff_availability_submissions (staff_id, month, version, payload, no_availability, late, reviewed_sessions, submitted_by)
  values (v_staff.id, p_month,
    coalesce((select max(version) from public.staff_availability_submissions where staff_id = v_staff.id and month = p_month), 0) + 1,
    jsonb_build_object('weekly', case when v_none then '[]'::jsonb else coalesce(p_payload->'weekly', '[]') end,
      'exceptions', case when v_none then '[]'::jsonb else coalesce(p_payload->'exceptions', '[]') end,
      'noAvailability', v_none),
    v_none, v_today > v_period.due_on,
    (select coalesce(jsonb_agg(jsonb_build_object('session_id', session_id, 'duty_start', lower(duty), 'duty_end', upper(duty)) order by starts_at), '[]')
      from public.staff_roster_sessions(v_month_start, v_month_end)
      where status in ('draft', 'published', 'full') and public.staff_roster_month_of(starts_at) = p_month),
    auth.uid())
  returning * into v_submission;

  if v_none then
    insert into public.staff_availability_windows (submission_id, staff_id, month, during, status, source)
    values (v_submission.id, v_staff.id, p_month, tstzrange(v_month_start, v_month_end, '[)'), 'UNAVAILABLE', 'month');
  else
    -- Weekly pattern for each gym date, minus that date's exceptions.
    insert into public.staff_availability_windows (submission_id, staff_id, month, during, status, source)
    select v_submission.id, v_staff.id, p_month, piece, w.status, 'weekly'
    from generate_series(p_month, (p_month + interval '1 month' - interval '1 day')::date, interval '1 day') as d(day)
    cross join lateral (
      select x.status, range_agg(tstzrange(public.staff_roster_local(d.day::date, x.start), public.staff_roster_local(d.day::date, x."end"), '[)')) as ranges
      from jsonb_to_recordset(coalesce(v_submission.payload->'weekly', '[]')) as x(weekday integer, start integer, "end" integer, status text)
      where x.weekday = extract(dow from d.day)::integer
      group by x.status
    ) w
    cross join lateral (
      select coalesce(range_agg(tstzrange(public.staff_roster_local(e.date, e.start), public.staff_roster_local(e.date, e."end"), '[)')), '{}'::tstzmultirange) as cuts
      from jsonb_to_recordset(coalesce(v_submission.payload->'exceptions', '[]')) as e(date date, start integer, "end" integer, status text)
      where e.date = d.day::date
    ) c
    cross join lateral unnest(w.ranges - c.cuts) as piece;
    insert into public.staff_availability_windows (submission_id, staff_id, month, during, status, source)
    select v_submission.id, v_staff.id, p_month, piece, e.status, 'exception'
    from (
      select x.status, range_agg(tstzrange(public.staff_roster_local(x.date, x.start), public.staff_roster_local(x.date, x."end"), '[)')) as ranges
      from jsonb_to_recordset(coalesce(v_submission.payload->'exceptions', '[]')) as x(date date, start integer, "end" integer, status text)
      group by x.status
    ) e
    cross join lateral unnest(e.ranges) as piece;
  end if;

  update public.staff_roster_reopenings set closed_at = now() where id = v_reopening;
  delete from public.staff_availability_drafts where staff_id = v_staff.id and month = p_month;
  perform public.staff_roster_audit('availability_submitted', 'submission', v_submission.id::text, p_month,
    null, jsonb_build_object('staff_id', v_staff.id, 'version', v_submission.version, 'no_availability', v_none, 'late', v_submission.late));
  v_result := jsonb_build_object('submission_id', v_submission.id, 'version', v_submission.version, 'late', v_submission.late, 'no_availability', v_none);
  return public.staff_roster_remember(p_request_id, 'submit_availability', v_result);
end;
$$;

-- After the deadline: ask the manager to reopen.
create or replace function public.staff_roster_request_change(p_month date, p_message text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_staff public.staff_members;
  v_row public.staff_roster_change_requests;
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'request_change');
  if v_replay is not null then return v_replay; end if;
  insert into public.staff_roster_change_requests (month, staff_id, message) values (p_month, v_staff.id, p_message) returning * into v_row;
  perform public.staff_roster_notify_managers('availability_change_request', 'change-request:' || v_row.id::text,
    'Availability change requested', v_staff.display_name || ' asked to change their availability for ' || to_char(p_month, 'FMMonth YYYY') || '.',
    '/admin/roster?rosterTab=availability&rosterMonth=' || to_char(p_month, 'YYYY-MM'), p_month);
  return public.staff_roster_remember(p_request_id, 'request_change', jsonb_build_object('id', v_row.id));
end;
$$;

-- An explicit answer for one class (reconfirming a moved class, or a class
-- added after submission). Bound to the current duty and exception version.
create or replace function public.staff_roster_confirm_session(p_session_id uuid, p_status text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_staff public.staff_members;
  v_session record;
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'confirm_session');
  if v_replay is not null then return v_replay; end if;
  if p_status not in ('PREFERRED', 'AVAILABLE', 'IF_NEEDED', 'UNAVAILABLE') then raise exception 'STATUS_INVALID'; end if;
  select * into v_session from public.staff_roster_sessions(null, null, array[p_session_id]);
  if not found or v_session.status not in ('draft', 'published', 'full') or v_session.starts_at <= now() then raise exception 'SESSION_NOT_LIVE'; end if;
  insert into public.staff_session_responses (staff_id, session_id, status, duty, exception_fingerprint, source)
  values (v_staff.id, p_session_id, p_status, v_session.duty, public.staff_roster_exception_fingerprint(v_staff.id, v_session.duty), 'coach')
  on conflict (staff_id, session_id) do update set status = excluded.status, duty = excluded.duty,
    exception_fingerprint = excluded.exception_fingerprint, source = 'coach', created_at = now();
  perform public.staff_roster_audit('session_confirmed', 'session', p_session_id::text, public.staff_roster_month_of(v_session.starts_at),
    null, jsonb_build_object('staff_id', v_staff.id, 'status', p_status));
  return public.staff_roster_remember(p_request_id, 'confirm_session', jsonb_build_object('ok', true, 'status', p_status));
end;
$$;

-- ============================================================================
-- Coach: roster, acknowledgement, absences, cover, notifications
-- ============================================================================

create or replace function public.staff_roster_my_roster(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.staff_roster_current_staff();
  if p_to < p_from or p_to - p_from > 100 then raise exception 'RANGE_INVALID'; end if;
  return jsonb_build_object(
    'assignments', (select coalesce(jsonb_agg(jsonb_build_object(
        'assignment_id', a.id, 'revision_id', a.revision_id, 'revision_number', r.number, 'month', r.month,
        'session_id', a.session_id, 'slot_key', a.slot_key, 'role', a.role,
        'title', coalesce(s.title, a.session_title), 'class_type', s.class_type,
        'start', coalesce(s.starts_at, a.session_start), 'end', coalesce(s.ends_at, a.session_end),
        'duty_start', lower(s.duty), 'duty_end', upper(s.duty),
        'status', coalesce(s.status, 'removed'),
        'published_start', a.session_start, 'published_end', a.session_end,
        'changed_since_publish', s.session_id is null or s.starts_at is distinct from a.session_start or s.ends_at is distinct from a.session_end or s.status is distinct from a.session_status,
        'colleagues', (select coalesce(jsonb_agg(jsonb_build_object('display_name', m.display_name, 'role', o.role) order by o.slot_key), '[]')
          from public.staff_assignments o join public.staff_members m on m.id = o.staff_id
          where o.revision_id = a.revision_id and o.session_id = a.session_id and o.staff_id <> v_staff.id),
        'acknowledged', exists (select 1 from public.staff_roster_acknowledgements k where k.staff_id = v_staff.id and k.revision_id = a.revision_id and k.acknowledged_at is not null)
          or not exists (select 1 from public.staff_roster_acknowledgements k where k.staff_id = v_staff.id and k.revision_id = a.revision_id),
        'cover', (select jsonb_build_object('id', c.id, 'status', c.status) from public.staff_cover_requests c where c.assignment_id = a.id and c.status in ('open', 'offered')),
        'availability', (select x.status from public.staff_roster_availability(array[v_staff.id], array[a.session_id]) x)
      ) order by coalesce(s.starts_at, a.session_start)), '[]')
      from public.staff_assignments a
      join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published'
      left join public.staff_roster_sessions(null, null,
        array(select x.session_id from public.staff_assignments x join public.staff_roster_revisions y on y.id = x.revision_id and y.state = 'published' where x.staff_id = v_staff.id)) s
        on s.session_id = a.session_id
      where a.staff_id = v_staff.id
        and coalesce(s.starts_at, a.session_start) >= (p_from::timestamp) at time zone 'Australia/Brisbane'
        and coalesce(s.starts_at, a.session_start) < ((p_to + 1)::timestamp) at time zone 'Australia/Brisbane'),
    'pending_acknowledgements', (select coalesce(jsonb_agg(jsonb_build_object('month', k.month, 'revision_id', k.revision_id, 'number', r.number) order by k.month), '[]')
      from public.staff_roster_acknowledgements k join public.staff_roster_revisions r on r.id = k.revision_id
      where k.staff_id = v_staff.id and k.acknowledged_at is null and r.state = 'published')
  );
end;
$$;

-- Optional "I've seen my roster". Records acknowledgement only; it never
-- creates or approves anything.
create or replace function public.staff_roster_acknowledge(p_revision_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_count integer;
begin
  v_staff := public.staff_roster_current_staff();
  update public.staff_roster_acknowledgements set acknowledged_at = now()
    where staff_id = v_staff.id and revision_id = p_revision_id and acknowledged_at is null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform public.staff_roster_audit('roster_acknowledged', 'revision', p_revision_id::text, null, null, jsonb_build_object('staff_id', v_staff.id));
  end if;
  return jsonb_build_object('ok', true, 'acknowledged', v_count > 0);
end;
$$;

-- Planned absences need approval; an urgent report is never blocked by a
-- deadline or lock, blocks eligibility at once and alerts managers.
create or replace function public.staff_roster_request_absence(p_starts timestamptz, p_ends timestamptz, p_kind text, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_staff public.staff_members;
  v_row public.staff_absences;
  v_affected integer;
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'request_absence');
  if v_replay is not null then return v_replay; end if;
  if p_kind not in ('planned', 'urgent') then raise exception 'KIND_INVALID'; end if;
  if p_ends <= p_starts then raise exception 'RANGE_INVALID'; end if;
  insert into public.staff_absences (staff_id, starts_at, ends_at, kind, status, reason_private, created_by)
  values (v_staff.id, p_starts, p_ends, p_kind, case when p_kind = 'urgent' then 'reported' else 'requested' end, nullif(btrim(p_reason), ''), auth.uid())
  returning * into v_row;
  select count(*) into v_affected from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
    where r.state = 'published' and a.staff_id = v_staff.id and a.session_start < p_ends and a.session_end > p_starts;
  perform public.staff_roster_notify_managers(case when p_kind = 'urgent' then 'urgent_absence' else 'absence_request' end,
    'absence:' || v_row.id::text,
    case when p_kind = 'urgent' then 'Urgent absence: ' || v_staff.display_name else 'Absence request: ' || v_staff.display_name end,
    v_staff.display_name || case when p_kind = 'urgent' then ' reported they cannot work ' else ' asked for time off ' end
      || to_char(p_starts at time zone 'Australia/Brisbane', 'Dy DD Mon FMHH12:MI am') || ' to ' || to_char(p_ends at time zone 'Australia/Brisbane', 'Dy DD Mon FMHH12:MI am')
      || case when v_affected > 0 then '. ' || v_affected || ' rostered ' || case when v_affected = 1 then 'class needs' else 'classes need' end || ' attention.' else '.' end,
    '/admin/roster?rosterTab=requests&rosterMonth=' || to_char(p_starts at time zone 'Australia/Brisbane', 'YYYY-MM') || '&rosterFocus=' || v_row.id::text, null);
  perform public.staff_roster_audit('absence_' || v_row.status, 'absence', v_row.id::text, null, null, to_jsonb(v_row) - 'reason_private');
  return public.staff_roster_remember(p_request_id, 'request_absence', jsonb_build_object('id', v_row.id, 'status', v_row.status, 'affected_classes', v_affected));
end;
$$;

create or replace function public.staff_roster_withdraw(p_kind text, p_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_staff public.staff_members;
  v_count integer;
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'withdraw');
  if v_replay is not null then return v_replay; end if;
  if p_kind = 'absence' then
    update public.staff_absences set status = 'withdrawn', version = version + 1
      where id = p_id and staff_id = v_staff.id and status in ('requested') returning 1 into v_count;
  elsif p_kind = 'cover' then
    update public.staff_cover_requests set status = 'withdrawn', version = version + 1
      where id = p_id and requester_staff_id = v_staff.id and status in ('open', 'offered') returning 1 into v_count;
    update public.staff_cover_offers set status = 'declined' where request_id = p_id and status = 'offered' and v_count is not null;
  elsif p_kind = 'offer' then
    update public.staff_cover_offers set status = 'withdrawn'
      where request_id = p_id and staff_id = v_staff.id and status = 'offered' returning 1 into v_count;
    update public.staff_cover_requests set status = 'open', version = version + 1
      where id = p_id and status = 'offered' and not exists (select 1 from public.staff_cover_offers where request_id = p_id and status = 'offered');
  else
    raise exception 'KIND_INVALID';
  end if;
  if v_count is null then raise exception 'NOTHING_TO_WITHDRAW'; end if;
  perform public.staff_roster_audit(p_kind || '_withdrawn', p_kind, p_id::text, null, null, jsonb_build_object('staff_id', v_staff.id));
  return public.staff_roster_remember(p_request_id, 'withdraw', jsonb_build_object('ok', true));
end;
$$;

create or replace function public.staff_roster_request_cover(p_assignment_id uuid, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_staff public.staff_members;
  v_assignment public.staff_assignments;
  v_revision public.staff_roster_revisions;
  v_row public.staff_cover_requests;
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'request_cover');
  if v_replay is not null then return v_replay; end if;
  select * into v_assignment from public.staff_assignments where id = p_assignment_id and staff_id = v_staff.id;
  if v_assignment.id is null then raise exception 'ASSIGNMENT_NOT_FOUND'; end if;
  select * into v_revision from public.staff_roster_revisions where id = v_assignment.revision_id;
  if v_revision.state <> 'published' then raise exception 'ASSIGNMENT_NOT_CURRENT'; end if;
  if v_assignment.session_start <= now() then raise exception 'SESSION_STARTED'; end if;
  insert into public.staff_cover_requests (assignment_id, revision_id, session_id, slot_key, requester_staff_id, reason_private)
  values (v_assignment.id, v_revision.id, v_assignment.session_id, v_assignment.slot_key, v_staff.id, nullif(btrim(p_reason), ''))
  returning * into v_row;
  perform public.staff_roster_notify_managers('cover_requested', 'cover-requested:' || v_row.id::text,
    'Cover requested', v_staff.display_name || ' asked for cover for ' || coalesce(v_assignment.session_title, 'a class') || ' on '
      || to_char(v_assignment.session_start at time zone 'Australia/Brisbane', 'Dy DD Mon, FMHH12:MI am') || '. They stay rostered until a replacement is approved.',
    '/admin/roster?rosterTab=requests&rosterMonth=' || to_char(v_revision.month, 'YYYY-MM') || '&rosterFocus=' || v_row.id::text, v_revision.month);
  perform public.staff_roster_audit('cover_requested', 'cover', v_row.id::text, v_revision.month, null, to_jsonb(v_row) - 'reason_private');
  return public.staff_roster_remember(p_request_id, 'request_cover', jsonb_build_object('id', v_row.id, 'status', v_row.status));
exception when unique_violation then
  raise exception 'COVER_ALREADY_REQUESTED';
end;
$$;

create or replace function public.staff_roster_cover_board()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.staff_roster_current_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'status', c.status, 'version', c.version, 'session_id', c.session_id, 'slot_key', c.slot_key,
      'title', a.session_title, 'start', a.session_start, 'end', a.session_end, 'role', a.role,
      'requested_by', m.display_name,
      'my_offer', (select o.status from public.staff_cover_offers o where o.request_id = c.id and o.staff_id = v_staff.id),
      'problems', to_jsonb(array(select p from unnest(public.staff_roster_assignment_problems(c.revision_id, c.session_id, c.slot_key, v_staff.id, array[c.assignment_id])) p
        where p not in ('AVAILABILITY_UNKNOWN', 'AVAILABILITY_PARTIAL', 'AVAILABILITY_UNAVAILABLE', 'AVAILABILITY_IF_NEEDED_BLOCKED')))
    ) order by a.session_start)
    from public.staff_cover_requests c
    join public.staff_assignments a on a.id = c.assignment_id
    join public.staff_members m on m.id = c.requester_staff_id
    join public.staff_roster_revisions r on r.id = c.revision_id and r.state = 'published'
    where c.status in ('open', 'offered') and c.requester_staff_id <> v_staff.id and a.session_start > now()
  ), '[]'::jsonb);
end;
$$;

-- Volunteering is an explicit availability answer for that one duty. A coach
-- without a monthly submission may volunteer only through this path. Absence
-- and other hard conflicts still block.
create or replace function public.staff_roster_offer_cover(p_cover_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_staff public.staff_members;
  v_cover public.staff_cover_requests;
  v_session record;
  v_problems text[];
begin
  v_staff := public.staff_roster_current_staff();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'offer_cover');
  if v_replay is not null then return v_replay; end if;
  select * into v_cover from public.staff_cover_requests where id = p_cover_id for update;
  if v_cover.id is null or v_cover.status not in ('open', 'offered') then raise exception 'COVER_NOT_OPEN'; end if;
  if v_cover.requester_staff_id = v_staff.id then raise exception 'OWN_REQUEST'; end if;
  if not exists (select 1 from public.staff_roster_revisions where id = v_cover.revision_id and state = 'published') then raise exception 'COVER_NOT_OPEN'; end if;
  v_problems := array(select p from unnest(public.staff_roster_assignment_problems(v_cover.revision_id, v_cover.session_id, v_cover.slot_key, v_staff.id, array[v_cover.assignment_id])) p
    where p not in ('AVAILABILITY_UNKNOWN', 'AVAILABILITY_PARTIAL', 'AVAILABILITY_UNAVAILABLE', 'AVAILABILITY_IF_NEEDED_BLOCKED'));
  if cardinality(v_problems) > 0 then raise exception 'CANNOT_COVER' using detail = to_jsonb(v_problems)::text; end if;
  select * into v_session from public.staff_roster_sessions(null, null, array[v_cover.session_id]);
  insert into public.staff_session_responses (staff_id, session_id, status, duty, exception_fingerprint, source)
  values (v_staff.id, v_cover.session_id, 'AVAILABLE', v_session.duty, public.staff_roster_exception_fingerprint(v_staff.id, v_session.duty), 'cover_offer')
  on conflict (staff_id, session_id) do update set status = 'AVAILABLE', duty = excluded.duty,
    exception_fingerprint = excluded.exception_fingerprint, source = 'cover_offer', created_at = now();
  insert into public.staff_cover_offers (request_id, staff_id) values (p_cover_id, v_staff.id)
  on conflict (request_id, staff_id) do update set status = 'offered', created_at = now();
  update public.staff_cover_requests set status = 'offered', version = version + 1 where id = p_cover_id;
  perform public.staff_roster_notify_managers('cover_offered', 'cover-offered:' || p_cover_id::text || ':' || v_staff.id::text,
    'Cover offered — needs your approval', v_staff.display_name || ' offered to cover a class. Approve it to change the roster.',
    '/admin/roster?rosterTab=requests&rosterFocus=' || p_cover_id::text, null);
  perform public.staff_roster_audit('cover_offered', 'cover', p_cover_id::text, null, null, jsonb_build_object('staff_id', v_staff.id));
  return public.staff_roster_remember(p_request_id, 'offer_cover', jsonb_build_object('ok', true, 'status', 'offered'));
end;
$$;

create or replace function public.staff_roster_my_requests()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.staff_roster_current_staff();
  return jsonb_build_object(
    'absences', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'starts_at', starts_at, 'ends_at', ends_at, 'kind', kind, 'status', status,
      'reason', reason_private, 'created_at', created_at) order by starts_at desc), '[]') from public.staff_absences where staff_id = v_staff.id and ends_at > now() - interval '60 days'),
    'cover_requests', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'title', a.session_title, 'start', a.session_start,
      'offers', (select count(*) from public.staff_cover_offers o where o.request_id = c.id and o.status = 'offered')) order by a.session_start desc), '[]')
      from public.staff_cover_requests c join public.staff_assignments a on a.id = c.assignment_id where c.requester_staff_id = v_staff.id and a.session_start > now() - interval '60 days'),
    'offers', (select coalesce(jsonb_agg(jsonb_build_object('request_id', o.request_id, 'status', o.status, 'title', a.session_title, 'start', a.session_start) order by a.session_start desc), '[]')
      from public.staff_cover_offers o join public.staff_cover_requests c on c.id = o.request_id join public.staff_assignments a on a.id = c.assignment_id
      where o.staff_id = v_staff.id and a.session_start > now() - interval '60 days'),
    'change_requests', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'month', month, 'status', status, 'message', message, 'created_at', created_at) order by created_at desc), '[]')
      from public.staff_roster_change_requests where staff_id = v_staff.id and created_at > now() - interval '120 days')
  );
end;
$$;

create or replace function public.staff_roster_my_notifications(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if not public.is_admin() then perform public.staff_roster_current_staff(true); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'body', body, 'link', link, 'created_at', created_at, 'read_at', read_at) order by created_at desc)
    from (select * from public.staff_notifications where recipient_profile_id = auth.uid() and deliver_after <= now()
      order by created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) n
  ), '[]'::jsonb);
end;
$$;

-- Read is an explicit act by the recipient; opening a notice list is not.
create or replace function public.staff_roster_mark_notifications_read(p_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  update public.staff_notifications set read_at = now()
    where recipient_profile_id = auth.uid() and id = any(coalesce(p_ids, '{}')) and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ============================================================================
-- Session changes made in the Class calendar
-- ============================================================================

-- When a rostered class is cancelled or retimed through the normal class
-- tools, tell the published coaches what actually changed. The published
-- snapshot is kept for audit; current state is never hidden behind it.
-- Never blocks the class change itself.
create or replace function public.staff_roster_session_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean;
  v_row record;
  v_kind text;
  v_new_end timestamptz;
begin
  select enabled into v_enabled from public.staff_roster_settings where id = 1;
  if not coalesce(v_enabled, false) then return new; end if;
  v_new_end := public.staff_roster_session_end(new.start_time, new.end_time, new.duration_minutes);
  if new.status in ('cancelled') and old.status is distinct from new.status then
    v_kind := 'cancelled';
  elsif new.start_time is distinct from old.start_time
     or v_new_end is distinct from public.staff_roster_session_end(old.start_time, old.end_time, old.duration_minutes) then
    v_kind := 'retimed';
  else
    return new;
  end if;
  begin
    for v_row in
      select distinct a.staff_id, m.profile_id, r.month from public.staff_assignments a
      join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published'
      join public.staff_members m on m.id = a.staff_id
      where a.session_id = new.id
    loop
      perform public.staff_roster_notify(v_row.profile_id, 'session_' || v_kind,
        'session:' || new.id::text || ':' || v_kind || ':' || extract(epoch from new.start_time)::bigint::text || ':' || extract(epoch from v_new_end)::bigint::text || ':' || v_row.staff_id::text,
        case v_kind when 'cancelled' then 'Class cancelled: ' || new.title else 'Class time changed: ' || new.title end,
        case v_kind
          when 'cancelled' then new.title || ' on ' || to_char(old.start_time at time zone 'Australia/Brisbane', 'Dy DD Mon, FMHH12:MI am') || ' is cancelled. You are no longer needed for it.'
          else new.title || ' now runs ' || to_char(new.start_time at time zone 'Australia/Brisbane', 'Dy DD Mon, FMHH12:MI am') || ' to '
            || to_char(v_new_end at time zone 'Australia/Brisbane', 'FMHH12:MI am') || ' (was ' || to_char(old.start_time at time zone 'Australia/Brisbane', 'Dy DD Mon, FMHH12:MI am') || '). Please check you can still do it.'
        end,
        '/coaching?tab=roster', v_row.month);
    end loop;
    perform public.staff_roster_audit('session_' || v_kind, 'session', new.id::text, public.staff_roster_month_of(new.start_time),
      jsonb_build_object('start', old.start_time, 'status', old.status), jsonb_build_object('start', new.start_time, 'end', v_new_end, 'status', new.status));
  exception when others then
    raise warning 'staff roster notice for session % not queued: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists class_sessions_staff_roster_changes on public.class_sessions;
create trigger class_sessions_staff_roster_changes
  after update of start_time, end_time, duration_minutes, status on public.class_sessions
  for each row execute function public.staff_roster_session_changed();

-- ============================================================================
-- Function privileges
-- ============================================================================

do $grants$
declare
  v_fn record;
  v_entry text[] := array[
    'staff_roster_get_settings', 'staff_roster_update_settings', 'staff_roster_upsert_staff', 'staff_roster_set_staff_status',
    'staff_roster_set_capabilities', 'staff_roster_link_candidates', 'staff_roster_open_period', 'staff_roster_update_period',
    'staff_roster_reopen_submission', 'staff_roster_set_staffing', 'staff_roster_save_series', 'staff_roster_preview_series',
    'staff_roster_generate_series', 'staff_roster_change_series_from', 'staff_roster_planning_snapshot', 'staff_roster_check_assignment',
    'staff_roster_apply_changes', 'staff_roster_discard_draft', 'staff_roster_publish', 'staff_roster_decide_absence',
    'staff_roster_record_absence', 'staff_roster_approve_cover', 'staff_roster_reject_cover', 'staff_roster_run_reminders',
    'staff_roster_notification_log', 'staff_roster_audit_log',
    'staff_roster_me', 'staff_roster_month_classes', 'staff_roster_save_usual_week', 'staff_roster_save_availability_draft',
    'staff_roster_submit_availability', 'staff_roster_request_change', 'staff_roster_confirm_session', 'staff_roster_my_roster',
    'staff_roster_acknowledge', 'staff_roster_request_absence', 'staff_roster_withdraw', 'staff_roster_request_cover',
    'staff_roster_cover_board', 'staff_roster_offer_cover', 'staff_roster_my_requests', 'staff_roster_my_notifications',
    'staff_roster_mark_notifications_read'
  ];
begin
  for v_fn in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'staff_roster%' or p.proname = 'staff_members_prevent_delete')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn.signature);
    if v_fn.proname = any(v_entry) then
      execute format('grant execute on function %s to authenticated', v_fn.signature);
    end if;
  end loop;
end;
$grants$;

insert into public.xert_schema_capabilities (capability) values ('staff_roster') on conflict (capability) do nothing;
