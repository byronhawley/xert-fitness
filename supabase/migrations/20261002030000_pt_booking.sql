-- PT booking: coaches sell their own personal training.
--
-- Each coach (an active row in public.staff_members, from the staff roster)
-- sets their own PT services with their own price and session length, their
-- own packages of sessions, and the weekly hours the public can book. The
-- public books an open time on the website; the coach confirms (or the
-- service confirms instantly), sees their clients, and marks sessions and
-- packages paid.
--
-- Money: clients pay their coach directly. Nothing here takes a card payment
-- or touches orders, credits or Stripe. The gym's July 2026 audit
-- (docs/requirements/03-coach-facility-rent.md) warns against the gym
-- collecting independent coaches' PT fees, so prices are shown and recorded,
-- and the coach records what was paid.
--
-- Availability: PT bookable hours are their own table, separate from the
-- roster's monthly class availability. A time is only offered when the coach
-- is free: no other PT booking (plus their buffer), no time off, no approved
-- or reported roster absence, no published class duty (prep and wrap
-- included) and no blackout that closes PT.
--
-- Ships switched off (pt_settings.enabled = false). Additive only: no
-- existing table or function changes. Every table is closed to direct
-- access; the website goes through the pt_* functions below.

-- ============================================================================
-- Tables
-- ============================================================================

create table if not exists public.pt_settings (
  id smallint primary key default 1,
  enabled boolean not null default false,
  min_notice_minutes integer not null default 720,
  max_days_ahead integer not null default 42,
  slot_step_minutes integer not null default 30,
  cancel_cutoff_hours integer not null default 24,
  max_upcoming_per_client integer not null default 4,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint pt_settings_singleton check (id = 1),
  constraint pt_settings_notice check (min_notice_minutes between 0 and 10080),
  constraint pt_settings_ahead check (max_days_ahead between 1 and 180),
  constraint pt_settings_step check (slot_step_minutes in (10, 15, 20, 30, 60)),
  constraint pt_settings_cutoff check (cancel_cutoff_hours between 0 and 168),
  constraint pt_settings_upcoming check (max_upcoming_per_client between 1 and 50)
);
insert into public.pt_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.pt_services (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  name text not null,
  description text,
  duration_minutes integer not null,
  price_cents integer not null,
  booking_mode text not null default 'request',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint pt_services_name check (char_length(btrim(name)) between 1 and 80),
  constraint pt_services_description check (coalesce(char_length(description), 0) <= 600),
  constraint pt_services_duration check (duration_minutes between 15 and 240 and duration_minutes % 5 = 0),
  constraint pt_services_price check (price_cents between 0 and 100000),
  constraint pt_services_mode check (booking_mode in ('instant', 'request'))
);
create index if not exists pt_services_staff on public.pt_services (staff_id, sort_order);

create table if not exists public.pt_packages (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.pt_services(id) on delete cascade,
  name text not null,
  sessions_count integer not null,
  price_cents integer not null,
  valid_days integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint pt_packages_name check (char_length(btrim(name)) between 1 and 80),
  constraint pt_packages_sessions check (sessions_count between 2 and 100),
  constraint pt_packages_price check (price_cents between 0 and 1000000),
  constraint pt_packages_valid check (valid_days is null or valid_days between 7 and 730)
);
create index if not exists pt_packages_service on public.pt_packages (service_id);

-- The hours a coach takes PT bookings, as a repeating week. Each window is
-- {"weekday": 0-6 (Sunday = 0), "start": minute, "end": minute} in gym time.
create table if not exists public.pt_weekly_hours (
  staff_id uuid primary key references public.staff_members(id) on delete cascade,
  hours jsonb not null default '[]'::jsonb,
  buffer_minutes integer not null default 0,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint pt_weekly_hours_array check (jsonb_typeof(hours) = 'array' and jsonb_array_length(hours) <= 60),
  constraint pt_weekly_hours_buffer check (buffer_minutes between 0 and 60)
);

create table if not exists public.pt_time_off (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text,
  created_at timestamptz not null default now(),
  constraint pt_time_off_range check (ends_at > starts_at and ends_at - starts_at <= interval '120 days'),
  constraint pt_time_off_note check (coalesce(char_length(note), 0) <= 200)
);
create index if not exists pt_time_off_lookup on public.pt_time_off (staff_id, starts_at);

-- A coach's client. One row per coach and email address.
create table if not exists public.pt_clients (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  profile_id uuid references public.profiles(id) on delete set null,
  coach_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pt_clients_name check (char_length(btrim(full_name)) between 1 and 120),
  constraint pt_clients_email check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and char_length(email) <= 254),
  constraint pt_clients_phone check (phone is null or char_length(phone) <= 40),
  constraint pt_clients_note check (coalesce(char_length(coach_note), 0) <= 2000)
);
create unique index if not exists pt_clients_staff_email on public.pt_clients (staff_id, lower(email));

-- A package a client has taken up. The price and size are copied from the
-- offer so a later price change never rewrites what the client agreed to.
create table if not exists public.pt_client_packages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.pt_clients(id) on delete cascade,
  package_id uuid references public.pt_packages(id) on delete set null,
  service_id uuid not null references public.pt_services(id) on delete cascade,
  name text not null,
  sessions_total integer not null,
  price_cents integer not null,
  paid boolean not null default false,
  expires_on date,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pt_client_packages_sessions check (sessions_total between 1 and 100),
  constraint pt_client_packages_price check (price_cents between 0 and 1000000),
  constraint pt_client_packages_status check (status in ('active', 'cancelled'))
);
create index if not exists pt_client_packages_client on public.pt_client_packages (client_id);

create table if not exists public.pt_bookings (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  service_id uuid not null references public.pt_services(id) on delete restrict,
  client_id uuid not null references public.pt_clients(id) on delete cascade,
  client_package_id uuid references public.pt_client_packages(id) on delete set null,
  service_name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null,
  price_cents integer not null,
  payment_status text not null default 'unpaid',
  client_notes text,
  coach_note text,
  source text not null default 'public',
  cancel_token uuid not null unique default gen_random_uuid(),
  cancelled_by text,
  decided_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pt_bookings_range check (ends_at > starts_at),
  constraint pt_bookings_status check (status in ('requested', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show')),
  constraint pt_bookings_payment check (payment_status in ('unpaid', 'paid', 'package', 'waived')),
  constraint pt_bookings_price check (price_cents between 0 and 100000),
  constraint pt_bookings_notes check (coalesce(char_length(client_notes), 0) <= 1000 and coalesce(char_length(coach_note), 0) <= 1000),
  constraint pt_bookings_source check (source in ('public', 'coach')),
  constraint pt_bookings_cancelled_by check (cancelled_by is null or cancelled_by in ('client', 'coach'))
);
create index if not exists pt_bookings_staff_time on public.pt_bookings (staff_id, starts_at);
create index if not exists pt_bookings_client on public.pt_bookings (client_id, starts_at);
create index if not exists pt_bookings_package on public.pt_bookings (client_package_id) where client_package_id is not null;

create table if not exists public.pt_booking_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.pt_bookings(id) on delete cascade,
  actor uuid,
  action text not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists pt_booking_events_booking on public.pt_booking_events (booking_id, created_at);

-- A retried tap or form submit returns the first result instead of acting twice.
create table if not exists public.pt_requests (
  request_id uuid primary key,
  actor uuid,
  action text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

do $lockdown$
declare
  v_table text;
  v_sequence text;
begin
  foreach v_table in array array[
    'pt_settings', 'pt_services', 'pt_packages', 'pt_weekly_hours', 'pt_time_off', 'pt_clients',
    'pt_client_packages', 'pt_bookings', 'pt_booking_events', 'pt_requests'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    for v_sequence in
      select pg_get_serial_sequence(format('public.%I', v_table), a.attname)
      from pg_attribute a
      where a.attrelid = format('public.%I', v_table)::regclass and a.attnum > 0 and not a.attisdropped
        and pg_get_serial_sequence(format('public.%I', v_table), a.attname) is not null
    loop
      execute format('revoke all on sequence %s from public, anon, authenticated', v_sequence);
    end loop;
  end loop;
end;
$lockdown$;

-- ============================================================================
-- Helpers (internal)
-- ============================================================================

create or replace function public.pt_settings_row()
returns public.pt_settings language sql stable security definer set search_path = public as $$
  select * from public.pt_settings where id = 1;
$$;

create or replace function public.pt_require_enabled()
returns public.pt_settings language plpgsql stable security definer set search_path = public as $$
declare
  v_settings public.pt_settings;
begin
  v_settings := public.pt_settings_row();
  if not coalesce(v_settings.enabled, false) then raise exception 'PT_DISABLED'; end if;
  return v_settings;
end;
$$;

-- The signed-in coach. Uses the roster's staff identity but not the roster's
-- switch: PT has its own.
create or replace function public.pt_current_staff()
returns public.staff_members language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  perform public.pt_require_enabled();
  select * into v_staff from public.staff_members where profile_id = auth.uid();
  if v_staff.id is null then raise exception 'NOT_STAFF'; end if;
  if v_staff.status <> 'active' then raise exception 'STAFF_INACTIVE'; end if;
  return v_staff;
end;
$$;

create or replace function public.pt_require_manager()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'MANAGER_ONLY'; end if;
end;
$$;

create or replace function public.pt_lock_staff(p_staff uuid)
returns void language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtextextended('xert_pt:' || p_staff::text, 0));
$$;

create or replace function public.pt_replay(p_request_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.pt_requests;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  select * into v_row from public.pt_requests where request_id = p_request_id;
  if v_row.request_id is null then return null; end if;
  if v_row.action <> p_action or v_row.actor is distinct from auth.uid() then raise exception 'REQUEST_ID_REUSED'; end if;
  return v_row.result;
end;
$$;

create or replace function public.pt_remember(p_request_id uuid, p_action text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  insert into public.pt_requests (request_id, actor, action, result) values (p_request_id, auth.uid(), p_action, p_result);
  return p_result;
end;
$$;

create or replace function public.pt_log(p_booking uuid, p_action text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.pt_booking_events (booking_id, actor, action, note) values (p_booking, auth.uid(), p_action, left(p_note, 500));
end;
$$;

create or replace function public.pt_gym_now_date()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'Australia/Brisbane')::date;
$$;

create or replace function public.pt_local(p_date date, p_minute integer)
returns timestamptz language sql immutable set search_path = public as $$
  select (p_date::timestamp + make_interval(mins => p_minute)) at time zone 'Australia/Brisbane';
$$;

create or replace function public.pt_coach_name(p_staff uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(case when c.published then c.name end, m.display_name)
  from public.staff_members m left join public.coaches c on c.id = m.coach_id
  where m.id = p_staff;
$$;

-- Sessions still to be drawn from a client's package.
create or replace function public.pt_package_remaining(p_client_package uuid)
returns integer language sql stable security definer set search_path = public as $$
  select greatest(cp.sessions_total - (
    select count(*)::integer from public.pt_bookings b
    where b.client_package_id = cp.id and b.status in ('requested', 'confirmed', 'completed', 'no_show')), 0)
  from public.pt_client_packages cp where cp.id = p_client_package;
$$;

create or replace function public.pt_package_json(p_client_package uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', cp.id, 'name', cp.name, 'service_id', cp.service_id, 'sessions_total', cp.sessions_total,
    'remaining', public.pt_package_remaining(cp.id), 'price_cents', cp.price_cents, 'paid', cp.paid,
    'expires_on', cp.expires_on, 'status', cp.status,
    'expired', cp.expires_on is not null and cp.expires_on < public.pt_gym_now_date(),
    'created_at', cp.created_at)
  from public.pt_client_packages cp where cp.id = p_client_package;
$$;

-- Why a coach can't take PT over p_range, or null when they are free.
-- p_range should already include the coach's buffer.
create or replace function public.pt_staff_conflict(p_staff uuid, p_range tstzrange, p_ignore_booking uuid default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_buffer integer;
begin
  select coalesce(buffer_minutes, 0) into v_buffer from public.pt_weekly_hours where staff_id = p_staff;
  v_buffer := coalesce(v_buffer, 0);
  if exists (
    select 1 from public.pt_bookings b
    where b.staff_id = p_staff and b.status in ('requested', 'confirmed')
      and b.id is distinct from p_ignore_booking
      and tstzrange(b.starts_at - make_interval(mins => v_buffer), b.ends_at + make_interval(mins => v_buffer), '[)') && p_range
  ) then return 'PT_BOOKING'; end if;
  if exists (
    select 1 from public.pt_time_off t
    where t.staff_id = p_staff and tstzrange(t.starts_at, t.ends_at, '[)') && p_range
  ) then return 'TIME_OFF'; end if;
  if exists (
    select 1 from public.staff_absences a
    where a.staff_id = p_staff and a.status in ('approved', 'reported')
      and tstzrange(a.starts_at, a.ends_at, '[)') && p_range
  ) then return 'AWAY'; end if;
  -- Published class duties only (drafts are not promises), prep and wrap included.
  if exists (
    select 1
    from public.staff_assignments a
    join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published'
    join public.staff_roster_sessions(lower(p_range) - interval '1 day', upper(p_range) + interval '1 day') s on s.session_id = a.session_id
    where a.staff_id = p_staff and coalesce(s.status, '') <> 'cancelled' and s.duty && p_range
  ) then return 'CLASS'; end if;
  if exists (
    select 1 from public.blackout_periods o
    where o.affects in ('all', 'pt_only', 'facility_only')
      and tstzrange(o.start_time, o.end_time, '[)') && p_range
  ) then return 'CLOSED'; end if;
  return null;
end;
$$;

-- Validated, sorted weekly windows.
create or replace function public.pt_normalize_hours(p_hours jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  v_item jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_prev jsonb;
  v_weekday integer;
  v_start integer;
  v_end integer;
begin
  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 60 then raise exception 'HOURS_INVALID'; end if;
  for v_item in select value from jsonb_array_elements(p_hours) loop
    begin
      v_weekday := (v_item->>'weekday')::integer;
      v_start := (v_item->>'start')::integer;
      v_end := (v_item->>'end')::integer;
    exception when others then
      raise exception 'HOURS_INVALID';
    end;
    if v_weekday is null or v_weekday not between 0 and 6 or v_start is null or v_end is null
      or v_start < 0 or v_end > 1440 or v_start >= v_end or v_start % 5 <> 0 or v_end % 5 <> 0 then
      raise exception 'HOURS_INVALID';
    end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('weekday', v_weekday, 'start', v_start, 'end', v_end));
  end loop;
  select coalesce(jsonb_agg(x order by (x->>'weekday')::integer, (x->>'start')::integer), '[]'::jsonb) into v_rows
    from jsonb_array_elements(v_rows) x;
  for v_item in select value from jsonb_array_elements(v_rows) loop
    if v_prev is not null and (v_prev->>'weekday') = (v_item->>'weekday') and (v_item->>'start')::integer < (v_prev->>'end')::integer then
      raise exception 'HOURS_OVERLAP';
    end if;
    v_prev := v_item;
  end loop;
  return v_rows;
end;
$$;

-- Open start times for a service between two gym dates (inclusive). Applies
-- the coach's hours, notice and horizon, and every conflict above.
create or replace function public.pt_open_slots(p_service uuid, p_from date, p_to date)
returns setof timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  v_settings public.pt_settings;
  v_service public.pt_services;
  v_hours public.pt_weekly_hours;
  v_day date;
  v_window jsonb;
  v_minute integer;
  v_start timestamptz;
  v_end timestamptz;
  v_earliest timestamptz;
  v_latest timestamptz;
  v_buffer interval;
begin
  v_settings := public.pt_settings_row();
  select * into v_service from public.pt_services where id = p_service;
  if v_service.id is null or not v_service.active then return; end if;
  if not exists (select 1 from public.staff_members where id = v_service.staff_id and status = 'active') then return; end if;
  select * into v_hours from public.pt_weekly_hours where staff_id = v_service.staff_id;
  if v_hours.staff_id is null then return; end if;
  v_buffer := make_interval(mins => v_hours.buffer_minutes);
  v_earliest := now() + make_interval(mins => v_settings.min_notice_minutes);
  v_latest := public.pt_local(public.pt_gym_now_date() + v_settings.max_days_ahead + 1, 0);
  v_day := greatest(p_from, public.pt_gym_now_date());
  while v_day <= p_to loop
    for v_window in select value from jsonb_array_elements(v_hours.hours)
      where (value->>'weekday')::integer = extract(dow from v_day)::integer
    loop
      v_minute := (v_window->>'start')::integer;
      while v_minute + v_service.duration_minutes <= (v_window->>'end')::integer loop
        v_start := public.pt_local(v_day, v_minute);
        v_end := v_start + make_interval(mins => v_service.duration_minutes);
        if v_start >= v_earliest and v_start < v_latest
          and public.pt_staff_conflict(v_service.staff_id, tstzrange(v_start - v_buffer, v_end + v_buffer, '[)')) is null then
          return next v_start;
        end if;
        v_minute := v_minute + v_settings.slot_step_minutes;
      end loop;
    end loop;
    v_day := v_day + 1;
  end loop;
end;
$$;

create or replace function public.pt_service_json(p_service uuid, p_public boolean default true)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'staff_id', s.staff_id, 'name', s.name, 'description', s.description,
    'duration_minutes', s.duration_minutes, 'price_cents', s.price_cents, 'booking_mode', s.booking_mode,
    'active', s.active, 'sort_order', s.sort_order, 'version', s.version,
    'packages', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'sessions_count', p.sessions_count, 'price_cents', p.price_cents,
        'valid_days', p.valid_days, 'active', p.active, 'version', p.version) order by p.sessions_count, p.created_at), '[]'::jsonb)
      from public.pt_packages p where p.service_id = s.id and (p.active or not p_public)))
  from public.pt_services s where s.id = p_service;
$$;

create or replace function public.pt_booking_json(p_booking uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', b.id, 'staff_id', b.staff_id, 'coach_name', public.pt_coach_name(b.staff_id),
    'service_id', b.service_id, 'service_name', b.service_name,
    'starts_at', b.starts_at, 'ends_at', b.ends_at, 'status', b.status,
    'price_cents', b.price_cents, 'payment_status', b.payment_status,
    'client_id', b.client_id, 'client_name', c.full_name, 'client_email', c.email, 'client_phone', c.phone,
    'client_notes', b.client_notes, 'coach_note', b.coach_note, 'source', b.source,
    'cancelled_by', b.cancelled_by, 'created_at', b.created_at,
    'package', case when b.client_package_id is null then null else public.pt_package_json(b.client_package_id) end)
  from public.pt_bookings b join public.pt_clients c on c.id = b.client_id
  where b.id = p_booking;
$$;

-- What the person who booked sees through their private link.
create or replace function public.pt_booking_public_json(p_booking uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'coach_name', public.pt_coach_name(b.staff_id), 'service_name', b.service_name,
    'starts_at', b.starts_at, 'ends_at', b.ends_at, 'status', b.status,
    'price_cents', b.price_cents, 'payment_status', b.payment_status, 'cancelled_by', b.cancelled_by,
    'first_name', split_part(btrim(c.full_name), ' ', 1),
    'can_cancel', b.status = 'requested'
      or (b.status = 'confirmed' and b.starts_at - now() >= make_interval(hours => (select cancel_cutoff_hours from public.pt_settings where id = 1))),
    'cancel_cutoff_hours', (select cancel_cutoff_hours from public.pt_settings where id = 1),
    'package', case when b.client_package_id is null then null else
      (select jsonb_build_object('name', cp.name, 'remaining', public.pt_package_remaining(cp.id), 'sessions_total', cp.sessions_total)
        from public.pt_client_packages cp where cp.id = b.client_package_id) end)
  from public.pt_bookings b join public.pt_clients c on c.id = b.client_id
  where b.id = p_booking;
$$;

-- Find or add the coach's client by email; keeps the latest name and phone.
create or replace function public.pt_upsert_client(p_staff uuid, p_name text, p_email text, p_phone text)
returns public.pt_clients language plpgsql security definer set search_path = public as $$
declare
  v_client public.pt_clients;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_profile uuid;
begin
  if char_length(v_name) not between 1 and 120 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 254
    or coalesce(char_length(v_phone), 0) > 40 then
    raise exception 'DETAILS_INVALID';
  end if;
  -- Link a signed-in member only when the email is their own.
  if auth.uid() is not null then
    select id into v_profile from public.profiles where id = auth.uid() and lower(email) = v_email;
  end if;
  insert into public.pt_clients (staff_id, full_name, email, phone, profile_id)
  values (p_staff, v_name, v_email, v_phone, v_profile)
  on conflict (staff_id, lower(email)) do update set
    full_name = excluded.full_name,
    phone = coalesce(excluded.phone, pt_clients.phone),
    profile_id = coalesce(pt_clients.profile_id, excluded.profile_id),
    updated_at = now()
  returning * into v_client;
  return v_client;
end;
$$;

-- ============================================================================
-- Emails (best effort; never fails a booking)
-- ============================================================================

create or replace function public.pt_send_email(p_to text, p_subject text, p_title text, p_body_html text, p_cta_label text, p_cta_url text, p_booking uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_html text;
begin
  if p_to is null then return; end if;
  begin
    if to_regprocedure('public.email_layout(text,text,text,text)') is not null then
      execute 'select public.email_layout($1, $2, $3, $4)' into v_html using p_title, p_body_html, p_cta_label, p_cta_url;
    else
      v_html := p_body_html;
    end if;
    if to_regprocedure('public.queue_email(text,text,text,text,text,text,text,jsonb)') is not null then
      execute 'select public.queue_email($1, $2, $3, $4, $5, $6, $7, $8)'
        using 'pt_decisions', p_to, p_subject, v_html, null::text, 'pt_bookings', p_booking::text, null::jsonb;
    elsif to_regprocedure('public.queue_email(text,text,text,text,text,text,text)') is not null then
      execute 'select public.queue_email($1, $2, $3, $4, $5, $6, $7)'
        using 'pt_decisions', p_to, p_subject, v_html, null::text, 'pt_bookings', p_booking::text;
    end if;
  exception when others then
    raise notice 'pt email skipped: %', sqlerrm;
  end;
end;
$$;

create or replace function public.pt_escape(p_text text)
returns text language sql immutable set search_path = public as $$
  select replace(replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
$$;

create or replace function public.pt_when_text(p_at timestamptz)
returns text language sql immutable set search_path = public as $$
  select to_char(p_at at time zone 'Australia/Brisbane', 'FMDay FMDD FMMonth, FMHH12:MI am');
$$;

create or replace function public.email_on_pt_booking_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_client public.pt_clients;
  v_coach_email text;
  v_coach text;
  v_when text;
  v_link text;
  v_line text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  select * into v_client from public.pt_clients where id = new.client_id;
  select p.email into v_coach_email from public.staff_members m join public.profiles p on p.id = m.profile_id where m.id = new.staff_id;
  v_coach := public.pt_escape(public.pt_coach_name(new.staff_id));
  v_when := public.pt_when_text(new.starts_at);
  v_link := 'https://xertfitness.com.au/pt/booking?token=' || new.cancel_token::text;
  v_line := '<p><strong>' || public.pt_escape(new.service_name) || '</strong> with ' || v_coach || '<br>' || v_when || '</p>';

  if new.status = 'confirmed' then
    perform public.pt_send_email(v_client.email, 'PT booked: ' || v_when, 'You’re booked in',
      '<p>Hi ' || public.pt_escape(split_part(btrim(v_client.full_name), ' ', 1)) || ',</p>' || v_line
        || '<p>Pay your coach directly. If you need to cancel, use the link below.</p>',
      'View or cancel', v_link, new.id);
  elsif new.status = 'requested' then
    perform public.pt_send_email(v_client.email, 'PT request sent: ' || v_when, 'Request sent',
      '<p>Hi ' || public.pt_escape(split_part(btrim(v_client.full_name), ' ', 1)) || ',</p>' || v_line
        || '<p>Your coach will confirm shortly. We’ll email you when they do.</p>',
      'View or cancel', v_link, new.id);
  elsif new.status = 'declined' then
    perform public.pt_send_email(v_client.email, 'PT time not available: ' || v_when, 'That time didn’t work',
      v_line || '<p>Your coach couldn’t take this time. Pick another time on the website.</p>',
      'Choose another time', 'https://xertfitness.com.au/pt', new.id);
  elsif new.status = 'cancelled' and new.cancelled_by = 'coach' then
    perform public.pt_send_email(v_client.email, 'PT session cancelled: ' || v_when, 'Session cancelled',
      v_line || '<p>Your coach has cancelled this session. Book another time whenever suits.</p>',
      'Choose another time', 'https://xertfitness.com.au/pt', new.id);
  end if;

  -- Tell the coach about what the client did.
  if new.source = 'public' and tg_op = 'INSERT' then
    perform public.pt_send_email(v_coach_email,
      case when new.status = 'requested' then 'New PT request: ' else 'New PT booking: ' end || v_when,
      case when new.status = 'requested' then 'New PT request' else 'New PT booking' end,
      '<p>' || public.pt_escape(v_client.full_name) || ' (' || public.pt_escape(v_client.email)
        || coalesce(', ' || public.pt_escape(v_client.phone), '') || ')</p>' || v_line
        || case when new.status = 'requested' then '<p>Confirm or decline it in your coach screens.</p>' else '' end,
      'Open coach screens', 'https://xertfitness.com.au/coaching?tab=pt', new.id);
  elsif new.status = 'cancelled' and new.cancelled_by = 'client' then
    perform public.pt_send_email(v_coach_email, 'PT cancelled by client: ' || v_when, 'Client cancelled',
      '<p>' || public.pt_escape(v_client.full_name) || ' cancelled.</p>' || v_line,
      'Open coach screens', 'https://xertfitness.com.au/coaching?tab=pt', new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists email_on_pt_booking_change on public.pt_bookings;
create trigger email_on_pt_booking_change
  after insert or update of status on public.pt_bookings
  for each row execute function public.email_on_pt_booking_change();

-- ============================================================================
-- Public (website, signed in or not)
-- ============================================================================

-- Coaches who take PT bookings, with their services and packages.
create or replace function public.pt_public_coaches()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_settings public.pt_settings;
begin
  v_settings := public.pt_settings_row();
  if not coalesce(v_settings.enabled, false) then
    return jsonb_build_object('enabled', false, 'coaches', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'enabled', true,
    'cancel_cutoff_hours', v_settings.cancel_cutoff_hours,
    'coaches', (select coalesce(jsonb_agg(jsonb_build_object(
        'staff_id', m.id,
        'name', public.pt_coach_name(m.id),
        'coach_id', case when c.published then c.id end,
        'role', case when c.published then c.role end,
        'bio', case when c.published then c.bio end,
        'photo_url', case when c.published then c.photo_url end,
        'services', (select coalesce(jsonb_agg(public.pt_service_json(s.id, true) order by s.sort_order, s.name), '[]'::jsonb)
          from public.pt_services s where s.staff_id = m.id and s.active)
      ) order by coalesce(c.sort_order, 1000), public.pt_coach_name(m.id)), '[]'::jsonb)
      from public.staff_members m
      left join public.coaches c on c.id = m.coach_id
      where m.status = 'active'
        and exists (select 1 from public.pt_services s where s.staff_id = m.id and s.active)
        and exists (select 1 from public.pt_weekly_hours h where h.staff_id = m.id and jsonb_array_length(h.hours) > 0)));
end;
$$;

-- Open times for one service, up to 14 days from p_from.
create or replace function public.pt_public_slots(p_service_id uuid, p_from date, p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 7), 1), 14);
begin
  perform public.pt_require_enabled();
  if p_from is null then raise exception 'RANGE_INVALID'; end if;
  if not exists (select 1 from public.pt_services where id = p_service_id and active) then raise exception 'SERVICE_NOT_FOUND'; end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_from + v_days - 1,
    'slots', (select coalesce(jsonb_agg(slot order by slot), '[]'::jsonb) from public.pt_open_slots(p_service_id, p_from, p_from + v_days - 1) slot));
end;
$$;

-- Book an open time. p_booking: service_id, starts_at, full_name, email,
-- phone, notes, and optionally package_id to take up one of the coach's
-- packages with this first session.
create or replace function public.pt_public_book(p_booking jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_settings public.pt_settings;
  v_replay jsonb;
  v_service public.pt_services;
  v_package public.pt_packages;
  v_client public.pt_clients;
  v_client_package uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_notes text := nullif(btrim(coalesce(p_booking->>'notes', '')), '');
  v_id uuid;
  v_status text;
  v_payment text := 'unpaid';
  v_result jsonb;
begin
  v_settings := public.pt_require_enabled();
  v_replay := public.pt_replay(p_request_id, 'book');
  if v_replay is not null then return v_replay; end if;
  begin
    v_start := (p_booking->>'starts_at')::timestamptz;
  exception when others then
    raise exception 'SLOT_UNAVAILABLE';
  end;
  select * into v_service from public.pt_services where id = (p_booking->>'service_id')::uuid and active;
  if v_service.id is null then raise exception 'SERVICE_NOT_FOUND'; end if;
  if coalesce(char_length(v_notes), 0) > 1000 then raise exception 'DETAILS_INVALID'; end if;
  perform public.pt_lock_staff(v_service.staff_id);
  if v_start is null or not exists (
    select 1 from public.pt_open_slots(v_service.id, (v_start at time zone 'Australia/Brisbane')::date, (v_start at time zone 'Australia/Brisbane')::date) slot
    where slot = v_start
  ) then raise exception 'SLOT_UNAVAILABLE'; end if;
  v_end := v_start + make_interval(mins => v_service.duration_minutes);

  v_client := public.pt_upsert_client(v_service.staff_id, p_booking->>'full_name', p_booking->>'email', p_booking->>'phone');
  if (select count(*) from public.pt_bookings b where b.client_id = v_client.id and b.status in ('requested', 'confirmed') and b.ends_at > now())
      >= v_settings.max_upcoming_per_client then
    raise exception 'TOO_MANY_BOOKINGS';
  end if;

  if nullif(p_booking->>'package_id', '') is not null then
    select * into v_package from public.pt_packages where id = (p_booking->>'package_id')::uuid and service_id = v_service.id and active;
    if v_package.id is null then raise exception 'PACKAGE_NOT_FOUND'; end if;
    insert into public.pt_client_packages (client_id, package_id, service_id, name, sessions_total, price_cents, expires_on)
    values (v_client.id, v_package.id, v_service.id, v_package.name, v_package.sessions_count, v_package.price_cents,
      case when v_package.valid_days is null then null else public.pt_gym_now_date() + v_package.valid_days end)
    returning id into v_client_package;
  elsif auth.uid() is not null and v_client.profile_id = auth.uid() then
    -- A signed-in client's own package for this service is used automatically.
    select cp.id into v_client_package from public.pt_client_packages cp
    where cp.client_id = v_client.id and cp.service_id = v_service.id and cp.status = 'active'
      and (cp.expires_on is null or cp.expires_on >= (v_start at time zone 'Australia/Brisbane')::date)
      and public.pt_package_remaining(cp.id) > 0
    order by cp.expires_on nulls last, cp.created_at
    limit 1;
  end if;
  if v_client_package is not null then v_payment := 'package'; end if;

  v_status := case when v_service.booking_mode = 'instant' then 'confirmed' else 'requested' end;
  insert into public.pt_bookings (staff_id, service_id, client_id, client_package_id, service_name, starts_at, ends_at, status,
    price_cents, payment_status, client_notes, source, created_by, decided_at)
  values (v_service.staff_id, v_service.id, v_client.id, v_client_package, v_service.name, v_start, v_end, v_status,
    v_service.price_cents, v_payment, v_notes, 'public', auth.uid(), case when v_status = 'confirmed' then now() end)
  returning id into v_id;
  perform public.pt_log(v_id, 'booked', v_status);

  select public.pt_booking_public_json(v_id) || jsonb_build_object('token', b.cancel_token) into v_result
    from public.pt_bookings b where b.id = v_id;
  return public.pt_remember(p_request_id, 'book', v_result);
end;
$$;

create or replace function public.pt_public_booking(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
begin
  select id into v_id from public.pt_bookings where cancel_token = p_token;
  if v_id is null then raise exception 'BOOKING_NOT_FOUND'; end if;
  return public.pt_booking_public_json(v_id);
end;
$$;

create or replace function public.pt_public_cancel(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.pt_bookings;
  v_cutoff integer;
begin
  select * into v_booking from public.pt_bookings where cancel_token = p_token for update;
  if v_booking.id is null then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status not in ('requested', 'confirmed') then
    return public.pt_booking_public_json(v_booking.id);
  end if;
  select cancel_cutoff_hours into v_cutoff from public.pt_settings where id = 1;
  if v_booking.status = 'confirmed' and v_booking.starts_at - now() < make_interval(hours => v_cutoff) then
    raise exception 'CANCEL_TOO_LATE';
  end if;
  update public.pt_bookings set status = 'cancelled', cancelled_by = 'client', cancelled_at = now(), updated_at = now()
    where id = v_booking.id;
  perform public.pt_log(v_booking.id, 'cancelled_by_client');
  return public.pt_booking_public_json(v_booking.id);
end;
$$;

-- ============================================================================
-- Coach (signed in, linked staff record, PT switched on)
-- ============================================================================

create or replace function public.pt_coach_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_settings public.pt_settings;
begin
  v_staff := public.pt_current_staff();
  v_settings := public.pt_settings_row();
  return jsonb_build_object(
    'staff', jsonb_build_object('id', v_staff.id, 'display_name', v_staff.display_name, 'public_name', public.pt_coach_name(v_staff.id)),
    'settings', jsonb_build_object('min_notice_minutes', v_settings.min_notice_minutes, 'max_days_ahead', v_settings.max_days_ahead,
      'slot_step_minutes', v_settings.slot_step_minutes, 'cancel_cutoff_hours', v_settings.cancel_cutoff_hours),
    'services', (select coalesce(jsonb_agg(public.pt_service_json(s.id, false) order by s.sort_order, s.created_at), '[]'::jsonb)
      from public.pt_services s where s.staff_id = v_staff.id),
    'hours', coalesce((select jsonb_build_object('hours', h.hours, 'buffer_minutes', h.buffer_minutes, 'version', h.version)
      from public.pt_weekly_hours h where h.staff_id = v_staff.id), jsonb_build_object('hours', '[]'::jsonb, 'buffer_minutes', 0, 'version', 0)),
    'time_off', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'starts_at', t.starts_at, 'ends_at', t.ends_at, 'note', t.note) order by t.starts_at), '[]'::jsonb)
      from public.pt_time_off t where t.staff_id = v_staff.id and t.ends_at > now()),
    'bookings', (select coalesce(jsonb_agg(public.pt_booking_json(b.id) order by b.starts_at), '[]'::jsonb)
      from public.pt_bookings b where b.staff_id = v_staff.id and b.starts_at > now() - interval '14 days'),
    'requested', (select count(*) from public.pt_bookings b where b.staff_id = v_staff.id and b.status = 'requested' and b.starts_at > now()),
    'to_mark', (select count(*) from public.pt_bookings b where b.staff_id = v_staff.id and b.status = 'confirmed' and b.ends_at <= now())
  );
end;
$$;

-- Create or edit one of my services. p_service: id (to edit), version,
-- name, description, duration_minutes, price_cents, booking_mode, active, sort_order.
create or replace function public.pt_coach_save_service(p_service jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_replay jsonb;
  v_existing public.pt_services;
  v_id uuid;
begin
  v_staff := public.pt_current_staff();
  v_replay := public.pt_replay(p_request_id, 'save_service');
  if v_replay is not null then return v_replay; end if;
  begin
    if nullif(p_service->>'id', '') is null then
      insert into public.pt_services (staff_id, name, description, duration_minutes, price_cents, booking_mode, active, sort_order)
      values (v_staff.id, btrim(p_service->>'name'), nullif(btrim(coalesce(p_service->>'description', '')), ''),
        (p_service->>'duration_minutes')::integer, (p_service->>'price_cents')::integer,
        coalesce(p_service->>'booking_mode', 'request'), coalesce((p_service->>'active')::boolean, true),
        coalesce((p_service->>'sort_order')::integer, 0))
      returning id into v_id;
    else
      select * into v_existing from public.pt_services where id = (p_service->>'id')::uuid and staff_id = v_staff.id for update;
      if v_existing.id is null then raise exception 'SERVICE_NOT_FOUND'; end if;
      if (p_service->>'version')::integer is distinct from v_existing.version then raise exception 'STALE_VERSION'; end if;
      update public.pt_services set
        name = btrim(p_service->>'name'),
        description = nullif(btrim(coalesce(p_service->>'description', '')), ''),
        duration_minutes = (p_service->>'duration_minutes')::integer,
        price_cents = (p_service->>'price_cents')::integer,
        booking_mode = coalesce(p_service->>'booking_mode', v_existing.booking_mode),
        active = coalesce((p_service->>'active')::boolean, v_existing.active),
        sort_order = coalesce((p_service->>'sort_order')::integer, v_existing.sort_order),
        version = version + 1, updated_at = now()
      where id = v_existing.id
      returning id into v_id;
    end if;
  exception
    when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
      raise exception 'SERVICE_INVALID';
  end;
  return public.pt_remember(p_request_id, 'save_service', public.pt_service_json(v_id, false));
end;
$$;

-- Create or edit a package on one of my services. p_package: id (to edit),
-- version, service_id, name, sessions_count, price_cents, valid_days, active.
create or replace function public.pt_coach_save_package(p_package jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_replay jsonb;
  v_existing public.pt_packages;
  v_service uuid;
begin
  v_staff := public.pt_current_staff();
  v_replay := public.pt_replay(p_request_id, 'save_package');
  if v_replay is not null then return v_replay; end if;
  begin
    if nullif(p_package->>'id', '') is null then
      select id into v_service from public.pt_services where id = (p_package->>'service_id')::uuid and staff_id = v_staff.id;
      if v_service is null then raise exception 'SERVICE_NOT_FOUND'; end if;
      insert into public.pt_packages (service_id, name, sessions_count, price_cents, valid_days, active)
      values (v_service, btrim(p_package->>'name'), (p_package->>'sessions_count')::integer, (p_package->>'price_cents')::integer,
        nullif(p_package->>'valid_days', '')::integer, coalesce((p_package->>'active')::boolean, true));
    else
      select p.* into v_existing from public.pt_packages p join public.pt_services s on s.id = p.service_id
        where p.id = (p_package->>'id')::uuid and s.staff_id = v_staff.id for update of p;
      if v_existing.id is null then raise exception 'PACKAGE_NOT_FOUND'; end if;
      if (p_package->>'version')::integer is distinct from v_existing.version then raise exception 'STALE_VERSION'; end if;
      v_service := v_existing.service_id;
      update public.pt_packages set
        name = btrim(p_package->>'name'),
        sessions_count = (p_package->>'sessions_count')::integer,
        price_cents = (p_package->>'price_cents')::integer,
        valid_days = nullif(p_package->>'valid_days', '')::integer,
        active = coalesce((p_package->>'active')::boolean, v_existing.active),
        version = version + 1, updated_at = now()
      where id = v_existing.id;
    end if;
  exception
    when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
      raise exception 'PACKAGE_INVALID';
  end;
  return public.pt_remember(p_request_id, 'save_package', public.pt_service_json(v_service, false));
end;
$$;

create or replace function public.pt_coach_save_hours(p_hours jsonb, p_buffer_minutes integer, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_hours jsonb;
  v_row public.pt_weekly_hours;
begin
  v_staff := public.pt_current_staff();
  v_hours := public.pt_normalize_hours(p_hours);
  if p_buffer_minutes is null or p_buffer_minutes not between 0 and 60 then raise exception 'HOURS_INVALID'; end if;
  select * into v_row from public.pt_weekly_hours where staff_id = v_staff.id for update;
  if coalesce(v_row.version, 0) is distinct from coalesce(p_expected_version, 0) then raise exception 'STALE_VERSION'; end if;
  insert into public.pt_weekly_hours (staff_id, hours, buffer_minutes) values (v_staff.id, v_hours, p_buffer_minutes)
  on conflict (staff_id) do update set hours = excluded.hours, buffer_minutes = excluded.buffer_minutes,
    version = pt_weekly_hours.version + 1, updated_at = now()
  returning * into v_row;
  -- Existing bookings stand: changing hours only changes what is offered next.
  return jsonb_build_object('hours', v_row.hours, 'buffer_minutes', v_row.buffer_minutes, 'version', v_row.version);
end;
$$;

create or replace function public.pt_coach_add_time_off(p_starts_at timestamptz, p_ends_at timestamptz, p_note text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_replay jsonb;
  v_id uuid;
begin
  v_staff := public.pt_current_staff();
  v_replay := public.pt_replay(p_request_id, 'add_time_off');
  if v_replay is not null then return v_replay; end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at or p_ends_at <= now()
    or p_ends_at - p_starts_at > interval '120 days' or coalesce(char_length(p_note), 0) > 200 then
    raise exception 'TIME_OFF_INVALID';
  end if;
  insert into public.pt_time_off (staff_id, starts_at, ends_at, note)
  values (v_staff.id, p_starts_at, p_ends_at, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  -- Bookings already in that time are not cancelled automatically; the coach
  -- sees them listed so they can talk to the client first.
  return public.pt_remember(p_request_id, 'add_time_off', jsonb_build_object('id', v_id,
    'clashes', (select coalesce(jsonb_agg(public.pt_booking_json(b.id) order by b.starts_at), '[]'::jsonb)
      from public.pt_bookings b where b.staff_id = v_staff.id and b.status in ('requested', 'confirmed')
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)'))));
end;
$$;

create or replace function public.pt_coach_remove_time_off(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.pt_current_staff();
  delete from public.pt_time_off where id = p_id and staff_id = v_staff.id;
  return jsonb_build_object('removed', found);
end;
$$;

-- confirm | decline | cancel | complete | no_show | mark_paid | mark_unpaid | waive | note
create or replace function public.pt_coach_update_booking(p_booking_id uuid, p_action text, p_note text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_replay jsonb;
  v_booking public.pt_bookings;
  v_buffer interval;
begin
  v_staff := public.pt_current_staff();
  v_replay := public.pt_replay(p_request_id, 'update_booking');
  if v_replay is not null then return v_replay; end if;
  if coalesce(char_length(p_note), 0) > 1000 then raise exception 'DETAILS_INVALID'; end if;
  perform public.pt_lock_staff(v_staff.id);
  select * into v_booking from public.pt_bookings where id = p_booking_id and staff_id = v_staff.id for update;
  if v_booking.id is null then raise exception 'BOOKING_NOT_FOUND'; end if;

  if p_action = 'confirm' then
    if v_booking.status <> 'requested' then raise exception 'BOOKING_NOT_PENDING'; end if;
    if v_booking.starts_at <= now() then raise exception 'BOOKING_STARTED'; end if;
    select make_interval(mins => coalesce(buffer_minutes, 0)) into v_buffer from public.pt_weekly_hours where staff_id = v_staff.id;
    v_buffer := coalesce(v_buffer, interval '0');
    if public.pt_staff_conflict(v_staff.id, tstzrange(v_booking.starts_at - v_buffer, v_booking.ends_at + v_buffer, '[)'), v_booking.id) is not null then
      raise exception 'SLOT_UNAVAILABLE';
    end if;
    update public.pt_bookings set status = 'confirmed', decided_at = now(), updated_at = now() where id = v_booking.id;
  elsif p_action = 'decline' then
    if v_booking.status <> 'requested' then raise exception 'BOOKING_NOT_PENDING'; end if;
    update public.pt_bookings set status = 'declined', decided_at = now(), updated_at = now() where id = v_booking.id;
  elsif p_action = 'cancel' then
    if v_booking.status not in ('requested', 'confirmed') then raise exception 'BOOKING_NOT_ACTIVE'; end if;
    update public.pt_bookings set status = 'cancelled', cancelled_by = 'coach', cancelled_at = now(), updated_at = now() where id = v_booking.id;
  elsif p_action in ('complete', 'no_show') then
    if v_booking.status not in ('confirmed', 'completed', 'no_show') then raise exception 'BOOKING_NOT_ACTIVE'; end if;
    if v_booking.starts_at > now() then raise exception 'BOOKING_NOT_STARTED'; end if;
    update public.pt_bookings set status = case when p_action = 'complete' then 'completed' else 'no_show' end, updated_at = now() where id = v_booking.id;
  elsif p_action in ('mark_paid', 'mark_unpaid', 'waive') then
    if v_booking.payment_status = 'package' then raise exception 'PAID_BY_PACKAGE'; end if;
    update public.pt_bookings set payment_status = case p_action when 'mark_paid' then 'paid' when 'waive' then 'waived' else 'unpaid' end,
      updated_at = now() where id = v_booking.id;
  elsif p_action = 'note' then
    null;
  else
    raise exception 'DECISION_INVALID';
  end if;
  if p_note is not null then
    update public.pt_bookings set coach_note = nullif(btrim(p_note), ''), updated_at = now() where id = v_booking.id;
  end if;
  perform public.pt_log(v_booking.id, p_action, p_note);
  return public.pt_remember(p_request_id, 'update_booking', public.pt_booking_json(v_booking.id));
end;
$$;

-- Book a client in myself (for example a regular, or someone who called).
-- Checks conflicts but not my published hours or the public notice period.
-- p_booking: service_id, starts_at, client_id or full_name/email/phone,
-- client_package_id (optional, one of theirs), notes.
create or replace function public.pt_coach_book(p_booking jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_replay jsonb;
  v_service public.pt_services;
  v_client public.pt_clients;
  v_package uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_buffer interval;
  v_id uuid;
begin
  v_staff := public.pt_current_staff();
  v_replay := public.pt_replay(p_request_id, 'coach_book');
  if v_replay is not null then return v_replay; end if;
  select * into v_service from public.pt_services where id = (p_booking->>'service_id')::uuid and staff_id = v_staff.id;
  if v_service.id is null then raise exception 'SERVICE_NOT_FOUND'; end if;
  begin
    v_start := (p_booking->>'starts_at')::timestamptz;
  exception when others then
    raise exception 'SLOT_UNAVAILABLE';
  end;
  if v_start is null or v_start <= now() then raise exception 'SLOT_UNAVAILABLE'; end if;
  v_end := v_start + make_interval(mins => v_service.duration_minutes);
  if nullif(p_booking->>'client_id', '') is not null then
    select * into v_client from public.pt_clients where id = (p_booking->>'client_id')::uuid and staff_id = v_staff.id;
    if v_client.id is null then raise exception 'CLIENT_NOT_FOUND'; end if;
  else
    v_client := public.pt_upsert_client(v_staff.id, p_booking->>'full_name', p_booking->>'email', p_booking->>'phone');
  end if;
  if nullif(p_booking->>'client_package_id', '') is not null then
    select cp.id into v_package from public.pt_client_packages cp
      where cp.id = (p_booking->>'client_package_id')::uuid and cp.client_id = v_client.id and cp.service_id = v_service.id
        and cp.status = 'active' and public.pt_package_remaining(cp.id) > 0;
    if v_package is null then raise exception 'PACKAGE_NOT_FOUND'; end if;
  end if;
  perform public.pt_lock_staff(v_staff.id);
  select make_interval(mins => coalesce(buffer_minutes, 0)) into v_buffer from public.pt_weekly_hours where staff_id = v_staff.id;
  v_buffer := coalesce(v_buffer, interval '0');
  if public.pt_staff_conflict(v_staff.id, tstzrange(v_start - v_buffer, v_end + v_buffer, '[)')) is not null then
    raise exception 'SLOT_UNAVAILABLE';
  end if;
  insert into public.pt_bookings (staff_id, service_id, client_id, client_package_id, service_name, starts_at, ends_at, status,
    price_cents, payment_status, client_notes, source, created_by, decided_at)
  values (v_staff.id, v_service.id, v_client.id, v_package, v_service.name, v_start, v_end, 'confirmed',
    v_service.price_cents, case when v_package is null then 'unpaid' else 'package' end,
    nullif(btrim(coalesce(p_booking->>'notes', '')), ''), 'coach', auth.uid(), now())
  returning id into v_id;
  perform public.pt_log(v_id, 'booked_by_coach');
  return public.pt_remember(p_request_id, 'coach_book', public.pt_booking_json(v_id));
end;
$$;

-- My clients: contact, what they've had, what's next, and their packages.
create or replace function public.pt_coach_clients()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.pt_current_staff();
  return (select coalesce(jsonb_agg(row order by (row->>'next_at') nulls last, row->>'full_name'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', c.id, 'full_name', c.full_name, 'email', c.email, 'phone', c.phone, 'coach_note', c.coach_note,
      'is_member', c.profile_id is not null, 'since', c.created_at,
      'completed', (select count(*) from public.pt_bookings b where b.client_id = c.id and b.status = 'completed'),
      'no_shows', (select count(*) from public.pt_bookings b where b.client_id = c.id and b.status = 'no_show'),
      'last_at', (select max(b.starts_at) from public.pt_bookings b where b.client_id = c.id and b.status in ('completed', 'no_show')),
      'next_at', (select min(b.starts_at) from public.pt_bookings b where b.client_id = c.id and b.status in ('requested', 'confirmed') and b.starts_at > now()),
      'upcoming', (select count(*) from public.pt_bookings b where b.client_id = c.id and b.status in ('requested', 'confirmed') and b.starts_at > now()),
      'unpaid', (select count(*) from public.pt_bookings b where b.client_id = c.id and b.status in ('completed', 'no_show') and b.payment_status = 'unpaid'),
      'packages', (select coalesce(jsonb_agg(public.pt_package_json(cp.id) order by cp.created_at desc), '[]'::jsonb)
        from public.pt_client_packages cp where cp.client_id = c.id and cp.status = 'active')
    ) as row
    from public.pt_clients c where c.staff_id = v_staff.id
  ) rows);
end;
$$;

create or replace function public.pt_coach_client_history(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.pt_current_staff();
  if not exists (select 1 from public.pt_clients where id = p_client_id and staff_id = v_staff.id) then raise exception 'CLIENT_NOT_FOUND'; end if;
  return (select coalesce(jsonb_agg(public.pt_booking_json(b.id) order by b.starts_at desc), '[]'::jsonb)
    from (select id, starts_at from public.pt_bookings where client_id = p_client_id order by starts_at desc limit 200) b);
end;
$$;

create or replace function public.pt_coach_update_client(p_client_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.pt_current_staff();
  if coalesce(char_length(p_note), 0) > 2000 then raise exception 'DETAILS_INVALID'; end if;
  update public.pt_clients set coach_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
    where id = p_client_id and staff_id = v_staff.id;
  if not found then raise exception 'CLIENT_NOT_FOUND'; end if;
  return jsonb_build_object('id', p_client_id);
end;
$$;

-- Give a client a package (sold in person), or mark one paid / unpaid / cancelled.
-- p_change: client_package_id + action (mark_paid | mark_unpaid | cancel),
-- or client_id + package_id + paid to add one.
create or replace function public.pt_coach_client_package(p_change jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_replay jsonb;
  v_id uuid;
  v_package public.pt_packages;
  v_client uuid;
begin
  v_staff := public.pt_current_staff();
  v_replay := public.pt_replay(p_request_id, 'client_package');
  if v_replay is not null then return v_replay; end if;
  if nullif(p_change->>'client_package_id', '') is not null then
    select cp.id into v_id from public.pt_client_packages cp join public.pt_clients c on c.id = cp.client_id
      where cp.id = (p_change->>'client_package_id')::uuid and c.staff_id = v_staff.id for update of cp;
    if v_id is null then raise exception 'PACKAGE_NOT_FOUND'; end if;
    if p_change->>'action' = 'mark_paid' then
      update public.pt_client_packages set paid = true, updated_at = now() where id = v_id;
    elsif p_change->>'action' = 'mark_unpaid' then
      update public.pt_client_packages set paid = false, updated_at = now() where id = v_id;
    elsif p_change->>'action' = 'cancel' then
      -- Upcoming sessions on it stay booked but become sessions to pay for.
      update public.pt_client_packages set status = 'cancelled', updated_at = now() where id = v_id;
      update public.pt_bookings set client_package_id = null, payment_status = 'unpaid', updated_at = now()
        where client_package_id = v_id and status in ('requested', 'confirmed');
    else
      raise exception 'DECISION_INVALID';
    end if;
  else
    select id into v_client from public.pt_clients where id = (p_change->>'client_id')::uuid and staff_id = v_staff.id;
    if v_client is null then raise exception 'CLIENT_NOT_FOUND'; end if;
    select p.* into v_package from public.pt_packages p join public.pt_services s on s.id = p.service_id
      where p.id = (p_change->>'package_id')::uuid and s.staff_id = v_staff.id;
    if v_package.id is null then raise exception 'PACKAGE_NOT_FOUND'; end if;
    insert into public.pt_client_packages (client_id, package_id, service_id, name, sessions_total, price_cents, paid, expires_on)
    values (v_client, v_package.id, v_package.service_id, v_package.name, v_package.sessions_count, v_package.price_cents,
      coalesce((p_change->>'paid')::boolean, false),
      case when v_package.valid_days is null then null else public.pt_gym_now_date() + v_package.valid_days end)
    returning id into v_id;
  end if;
  return public.pt_remember(p_request_id, 'client_package', public.pt_package_json(v_id));
end;
$$;

-- ============================================================================
-- Manager
-- ============================================================================

create or replace function public.pt_admin_overview(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_settings public.pt_settings;
begin
  perform public.pt_require_manager();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then raise exception 'RANGE_INVALID'; end if;
  v_settings := public.pt_settings_row();
  return jsonb_build_object(
    'settings', to_jsonb(v_settings),
    'coaches', (select coalesce(jsonb_agg(jsonb_build_object(
        'staff_id', m.id, 'name', public.pt_coach_name(m.id), 'status', m.status, 'linked', m.profile_id is not null,
        'services', (select count(*) from public.pt_services s where s.staff_id = m.id and s.active),
        'has_hours', exists (select 1 from public.pt_weekly_hours h where h.staff_id = m.id and jsonb_array_length(h.hours) > 0),
        'upcoming', (select count(*) from public.pt_bookings b where b.staff_id = m.id and b.status in ('requested', 'confirmed') and b.starts_at > now()),
        'clients', (select count(*) from public.pt_clients c where c.staff_id = m.id)
      ) order by m.display_name), '[]'::jsonb) from public.staff_members m),
    'bookings', (select coalesce(jsonb_agg(public.pt_booking_json(b.id) order by b.starts_at), '[]'::jsonb)
      from public.pt_bookings b
      where b.starts_at >= public.pt_local(p_from, 0) and b.starts_at < public.pt_local(p_to + 1, 0))
  );
end;
$$;

create or replace function public.pt_admin_update_settings(p_patch jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.pt_settings;
begin
  perform public.pt_require_manager();
  select * into v_row from public.pt_settings where id = 1 for update;
  if v_row.version is distinct from p_expected_version then raise exception 'STALE_VERSION'; end if;
  begin
    update public.pt_settings set
      enabled = coalesce((p_patch->>'enabled')::boolean, enabled),
      min_notice_minutes = coalesce((p_patch->>'min_notice_minutes')::integer, min_notice_minutes),
      max_days_ahead = coalesce((p_patch->>'max_days_ahead')::integer, max_days_ahead),
      slot_step_minutes = coalesce((p_patch->>'slot_step_minutes')::integer, slot_step_minutes),
      cancel_cutoff_hours = coalesce((p_patch->>'cancel_cutoff_hours')::integer, cancel_cutoff_hours),
      max_upcoming_per_client = coalesce((p_patch->>'max_upcoming_per_client')::integer, max_upcoming_per_client),
      version = version + 1, updated_at = now(), updated_by = auth.uid()
    where id = 1
    returning * into v_row;
  exception
    when check_violation or invalid_text_representation or numeric_value_out_of_range then
      raise exception 'SETTINGS_INVALID';
  end;
  return to_jsonb(v_row);
end;
$$;

-- ============================================================================
-- Grants
-- ============================================================================

do $grants$
declare
  v_fn record;
  v_public text[] := array['pt_public_coaches', 'pt_public_slots', 'pt_public_book', 'pt_public_booking', 'pt_public_cancel'];
  v_signed_in text[] := array[
    'pt_coach_overview', 'pt_coach_save_service', 'pt_coach_save_package', 'pt_coach_save_hours',
    'pt_coach_add_time_off', 'pt_coach_remove_time_off', 'pt_coach_update_booking', 'pt_coach_book',
    'pt_coach_clients', 'pt_coach_client_history', 'pt_coach_update_client', 'pt_coach_client_package',
    'pt_admin_overview', 'pt_admin_update_settings'
  ];
begin
  for v_fn in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'pt\_%' or p.proname = 'email_on_pt_booking_change')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn.signature);
    if v_fn.proname = any(v_public) then
      execute format('grant execute on function %s to anon, authenticated', v_fn.signature);
    elsif v_fn.proname = any(v_signed_in) then
      execute format('grant execute on function %s to authenticated', v_fn.signature);
    end if;
  end loop;
end;
$grants$;

insert into public.xert_schema_capabilities (capability) values ('pt_booking') on conflict (capability) do nothing;
