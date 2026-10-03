-- =============================================================================
-- XertOS class sync: the class timetable kept in step with XertOS, both ways,
-- with this site in charge of it.
--
-- XERT Fitness stays the source of truth for classes and bookings. XertOS
-- keeps a mirror (see XertOS docs/api/connected-sites.md):
--
--   - Every change to a class here, and every booking that changes how many
--     places it holds, puts the class in xertos_class_outbox. A dispatcher
--     (api/admin-fitbox-integration?service=xertos, called by pg_cron) sends
--     what is due to XertOS and marks it sent. Once a day it also sends the
--     next four weeks as a complete list, so a missed send heals itself.
--   - A change made in XertOS comes to the same endpoint, signed, and is
--     applied here by xertos_sync_apply_edit through the same checks the admin
--     calendar uses (capacity under bookings, blackouts, members' other
--     bookings, cancelled classes stay cancelled). XertOS only changes its
--     mirror once this answers.
--
-- Off until it is turned on in the SQL editor (docs/xertos-sync/README.md).
-- While off, nothing is queued and XertOS's edits are refused, so this file
-- changes no behaviour by itself.
--
-- admin_update_class_session and admin_cancel_class_session are split into an
-- admin check and a core that both the admin calendar and XertOS use, so there
-- is one copy of the rules. The core bodies are copied unchanged from
-- 20260906010000_booking_integrity_overhaul.sql.
-- =============================================================================

-- ── 1. Settings and queue ──────────────────────────────────────────────────

create table if not exists public.xertos_sync_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  window_days integer not null default 28 check (window_days between 1 and 62),
  updated_at timestamptz not null default now()
);
insert into public.xertos_sync_settings (id) values (true) on conflict (id) do nothing;

-- One row per class: the latest change wins, so ten edits in a minute send once.
create table if not exists public.xertos_class_outbox (
  session_id uuid primary key,
  changed_at timestamptz not null default clock_timestamp(),
  sent_changed_at timestamptz,
  removed boolean not null default false,
  -- Only for a deleted class, which can no longer be read when it is sent.
  snapshot jsonb,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  leased_until timestamptz,
  claimed_changed_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  sent_at timestamptz
);
create index if not exists xertos_class_outbox_due_idx
  on public.xertos_class_outbox (next_attempt_at)
  where sent_changed_at is distinct from changed_at;

-- A change from XertOS is applied once per request id, however often it is retried.
create table if not exists public.xertos_edit_receipts (
  request_id text primary key check (char_length(request_id) between 1 and 200),
  action text not null,
  session_id uuid,
  answer jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.xertos_sync_settings enable row level security;
alter table public.xertos_class_outbox enable row level security;
alter table public.xertos_edit_receipts enable row level security;
revoke all on public.xertos_sync_settings, public.xertos_class_outbox, public.xertos_edit_receipts
  from public, anon, authenticated;

-- ── 2. The class as XertOS reads it ─────────────────────────────────────────

create or replace function public.xertos_iso(p_at timestamptz)
returns text
language sql
immutable
set search_path = public
as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Matches XertOS's SiteClass. bookedCount is everyone holding a place: member
-- bookings and confirmed public sign-ups, the same count capacity is checked
-- against.
create or replace function public.xertos_class_json(
  p_session public.class_sessions,
  p_booked integer,
  p_removed boolean
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'externalId', p_session.id::text,
    'updatedAt', public.xertos_iso(coalesce(p_session.updated_at, now())),
    'removed', p_removed,
    'classType', p_session.class_type,
    'title', p_session.title,
    'description', p_session.description,
    'startsAt', public.xertos_iso(p_session.start_time),
    'endsAt', public.xertos_iso(coalesce(
      p_session.end_time,
      p_session.start_time + make_interval(mins => coalesce(p_session.duration_minutes, 60))
    )),
    'capacity', greatest(coalesce(p_session.capacity, 0), 0),
    'status', p_session.status,
    'publicVisible', coalesce(p_session.public_visible, false),
    'coachName', p_session.coach_name,
    'locationZone', p_session.location_zone,
    'bookingMode', p_session.booking_mode,
    'bookedCount', greatest(coalesce(p_booked, 0), 0),
    'notes', p_session.notes
  );
$$;

create or replace function public.xertos_class_payload(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.class_sessions%rowtype;
  v_booked integer;
begin
  select * into v_session from public.class_sessions where id = p_session_id;
  if not found then return null; end if;
  select places.held into v_booked from public.class_places_held(p_session_id) as places;
  return public.xertos_class_json(v_session, v_booked, false);
end;
$$;

-- ── 3. Queue every change while the sync is on ─────────────────────────────

create or replace function public.xertos_queue_class(
  p_session_id uuid,
  p_removed boolean default false,
  p_snapshot jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_session_id is null then return; end if;
  if not coalesce((select enabled from public.xertos_sync_settings where id), false) then return; end if;
  -- Deleting a class deletes its bookings after it; their triggers must not
  -- overwrite the class's removal with a plain change.
  if not p_removed and not exists (select 1 from public.class_sessions where id = p_session_id) then return; end if;
  insert into public.xertos_class_outbox as box (session_id, changed_at, removed, snapshot, attempts, next_attempt_at, last_error)
  values (p_session_id, clock_timestamp(), p_removed, p_snapshot, 0, now(), null)
  on conflict (session_id) do update
    set changed_at = clock_timestamp(),
        removed = excluded.removed,
        snapshot = excluded.snapshot,
        attempts = 0,
        next_attempt_at = now(),
        last_error = null;
end;
$$;

create or replace function public.xertos_class_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The sync must never stop a class from being saved.
  begin
    if tg_op = 'DELETE' then
      perform public.xertos_queue_class(old.id, true, public.xertos_class_json(old, 0, true));
    else
      perform public.xertos_queue_class(new.id);
    end if;
  exception when others then
    raise warning 'XertOS sync: class % not queued: %', coalesce(new.id, old.id), sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists class_sessions_xertos_sync on public.class_sessions;
create trigger class_sessions_xertos_sync
  after insert or update or delete on public.class_sessions
  for each row execute function public.xertos_class_changed();

-- A booking changes the class's booked count, which XertOS shows.
create or replace function public.xertos_booking_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.xertos_queue_class(new.class_session_id);
    elsif tg_op = 'DELETE' then
      perform public.xertos_queue_class(old.class_session_id);
    else
      perform public.xertos_queue_class(old.class_session_id);
      if new.class_session_id is distinct from old.class_session_id then
        perform public.xertos_queue_class(new.class_session_id);
      end if;
    end if;
  exception when others then
    raise warning 'XertOS sync: booking change not queued: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists session_bookings_xertos_sync on public.session_bookings;
create trigger session_bookings_xertos_sync
  after insert or update of status, class_session_id or delete on public.session_bookings
  for each row execute function public.xertos_booking_changed();

do $class_bookings$
begin
  if to_regclass('public.class_bookings') is not null then
    execute 'drop trigger if exists class_bookings_xertos_sync on public.class_bookings';
    execute 'create trigger class_bookings_xertos_sync
      after insert or update of status, class_session_id or delete on public.class_bookings
      for each row execute function public.xertos_booking_changed()';
  end if;
end;
$class_bookings$;

-- ── 4. The dispatcher's side of the queue ──────────────────────────────────

-- Whether the scheduler has anything to send. Cheap; pg_cron calls it every minute.
create or replace function public.xertos_sync_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select enabled from public.xertos_sync_settings where id), false)
     and exists (
       select 1 from public.xertos_class_outbox
        where sent_changed_at is distinct from changed_at
          and next_attempt_at <= now()
          and (leased_until is null or leased_until < now())
     );
$$;

-- Takes up to p_limit due classes for two minutes, so two dispatchers never send the same one.
create or replace function public.xertos_sync_claim(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease uuid := gen_random_uuid();
  v_classes jsonb;
begin
  if not coalesce((select enabled from public.xertos_sync_settings where id), false) then
    return jsonb_build_object('lease', null, 'classes', '[]'::jsonb);
  end if;

  with due as (
    select session_id
      from public.xertos_class_outbox
     where sent_changed_at is distinct from changed_at
       and next_attempt_at <= now()
       and (leased_until is null or leased_until < now())
     order by changed_at
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
     for update skip locked
  ), claimed as (
    update public.xertos_class_outbox box
       set lease_id = v_lease,
           leased_until = now() + interval '2 minutes',
           claimed_changed_at = box.changed_at
      from due
     where box.session_id = due.session_id
     returning box.session_id, box.removed, box.snapshot
  )
  -- A class deleted while the sync was off has no copy left to send; it is
  -- claimed anyway so settling clears it.
  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_classes
    from (
      select case when claimed.removed then claimed.snapshot
                  else public.xertos_class_payload(claimed.session_id) end as item
        from claimed
    ) payloads
   where item is not null;

  return jsonb_build_object('lease', v_lease, 'classes', v_classes);
end;
$$;

-- Marks a claim sent, or due again later with the reason it wasn't.
create or replace function public.xertos_sync_settle(p_lease uuid, p_ok boolean, p_error text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_lease is null then return 0; end if;
  if p_ok then
    update public.xertos_class_outbox
       set sent_changed_at = claimed_changed_at,
           sent_at = now(),
           attempts = 0,
           last_error = null,
           lease_id = null,
           leased_until = null
     where lease_id = p_lease;
  else
    update public.xertos_class_outbox
       set attempts = attempts + 1,
           -- 1, 2, 4 … minutes, at most an hour.
           next_attempt_at = now() + least(interval '1 minute' * power(2, least(attempts, 6)), interval '1 hour'),
           last_error = left(coalesce(p_error, 'XertOS did not accept the classes.'), 1000),
           lease_id = null,
           leased_until = null
     where lease_id = p_lease;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Every class starting in the next window_days, as a complete list.
create or replace function public.xertos_sync_window(p_days integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := date_trunc('minute', now());
  v_to timestamptz;
  v_classes jsonb;
begin
  if not coalesce((select enabled from public.xertos_sync_settings where id), false) then return null; end if;
  v_to := v_from + make_interval(days => least(greatest(coalesce(
    p_days, (select window_days from public.xertos_sync_settings where id), 28), 1), 62));
  select coalesce(jsonb_agg(public.xertos_class_json(s, places.held, false) order by s.start_time, s.id), '[]'::jsonb)
    into v_classes
    from public.class_sessions s
    cross join lateral public.class_places_held(s.id) as places
   where s.start_time >= v_from and s.start_time < v_to;
  return jsonb_build_object(
    'classes', v_classes,
    'window', jsonb_build_object('from', public.xertos_iso(v_from), 'to', public.xertos_iso(v_to))
  );
end;
$$;

-- ── 5. One copy of the admin calendar's rules ──────────────────────────────

create or replace function public.class_session_update_core(
  p_session_id uuid,
  p_session jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_status text;
  v_active_bookings integer;
  v_update record;
begin
  if p_session_id is null then raise exception 'SESSION_REQUIRED'; end if;
  if p_session is null then raise exception 'SESSION_PAYLOAD_REQUIRED'; end if;

  select * into v_update
  from jsonb_to_record(p_session) as session_data(
    class_type text,
    title text,
    description text,
    coach_name text,
    start_time timestamptz,
    end_time timestamptz,
    duration_minutes integer,
    capacity integer,
    location_zone text,
    beginner_friendly boolean,
    intensity_level text,
    status text,
    public_visible boolean,
    booking_mode text,
    notes text
  );

  if v_update.title is null or btrim(v_update.title) = ''
     or v_update.status is null or v_update.capacity is null then
    raise exception 'INVALID_SESSION_PAYLOAD';
  end if;

  select status into v_current_status
  from public.class_sessions
  where id = p_session_id
  for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;

  if v_current_status in ('cancelled', 'completed')
     and v_update.status <> v_current_status then
    raise exception 'TERMINAL_SESSION_IMMUTABLE';
  end if;
  if v_update.status = 'cancelled' and v_current_status <> 'cancelled' then
    raise exception 'USE_CANCELLATION_WORKFLOW';
  end if;
  if v_update.status = 'completed' and v_current_status <> 'completed' then
    raise exception 'USE_ATTENDANCE_WORKFLOW';
  end if;

  perform 1
  from public.session_bookings
  where class_session_id = p_session_id
    and status in ('requested', 'confirmed')
  for update;

  -- Counts confirmed public sign-ups as well as member bookings, so capacity
  -- can never be cut below the number of people actually holding a place.
  select places.held into v_active_bookings
    from public.class_places_held(p_session_id) as places;

  if v_update.capacity < v_active_bookings then
    raise exception 'CAPACITY_BELOW_ACTIVE:%', v_active_bookings;
  end if;

  update public.class_sessions
  set class_type = v_update.class_type,
      title = btrim(v_update.title),
      description = v_update.description,
      coach_name = v_update.coach_name,
      start_time = v_update.start_time,
      end_time = v_update.end_time,
      duration_minutes = v_update.duration_minutes,
      capacity = v_update.capacity,
      location_zone = v_update.location_zone,
      beginner_friendly = v_update.beginner_friendly,
      intensity_level = v_update.intensity_level,
      status = v_update.status,
      public_visible = v_update.public_visible,
      booking_mode = v_update.booking_mode,
      notes = v_update.notes,
      updated_at = now()
  where id = p_session_id;

  return p_session_id;
end;
$$;

create or replace function public.admin_update_class_session(
  p_session_id uuid,
  p_session jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
  return public.class_session_update_core(p_session_id, p_session);
end;
$$;

create or replace function public.class_session_cancel_core(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_cancelled_count integer := 0;
  v_enquiry_cancelled_count integer := 0;
begin
  select status into v_status
    from public.class_sessions
    where id = p_session_id
    for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_status = 'completed' then raise exception 'SESSION_ALREADY_COMPLETED'; end if;

  perform public.create_class_cancellation_notice(p_session_id);

  -- Cancel the class BEFORE the bookings. The cancellation email fires from
  -- the class row's status change and looks for everyone still holding a place
  -- or a request; doing this last meant it always found an empty room, so the
  -- one email written for this moment reached nobody.
  update public.class_sessions
     set status = 'cancelled', updated_at = now()
   where id = p_session_id;

  with targets as (
    select id, credit_batch_id, status as previous_status
      from public.session_bookings
     where class_session_id = p_session_id
       and status in ('requested', 'confirmed', 'waitlisted')
     for update
  ), cancelled_bookings as (
    update public.session_bookings booking
       set status = 'cancelled', cancelled_at = now()
      from targets
     where booking.id = targets.id
     returning targets.credit_batch_id as credit_batch_id,
               targets.previous_status as previous_status
  ), restored_credits as (
    update public.credit_batches credits
       set remaining = credits.remaining + refunds.credit_count
      from (
        select credit_batch_id, count(*)::integer as credit_count
          from cancelled_bookings
         where previous_status in ('requested', 'confirmed')
           and credit_batch_id is not null
         group by credit_batch_id
      ) refunds
     where credits.id = refunds.credit_batch_id
     returning credits.id
  )
  select count(*) into v_cancelled_count from cancelled_bookings;

  if to_regclass('public.class_bookings') is not null then
    execute $query$
      update public.class_bookings
         set status = 'cancelled', cancelled_at = now()
       where class_session_id = $1
         and status in ('requested', 'confirmed', 'waitlisted')
    $query$ using p_session_id;
    get diagnostics v_enquiry_cancelled_count = row_count;
  end if;

  return v_cancelled_count + v_enquiry_cancelled_count;
end;
$$;

create or replace function public.admin_cancel_class_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
  return public.class_session_cancel_core(p_session_id);
end;
$$;

revoke all on function public.admin_update_class_session(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_class_session(uuid, jsonb) to authenticated;
revoke all on function public.admin_cancel_class_session(uuid) from public, anon;
grant execute on function public.admin_cancel_class_session(uuid) to authenticated;

-- ── 6. A change made in XertOS ─────────────────────────────────────────────
--
-- p_edit is the body XertOS signs (connected-sites.md):
--   {"action":"update","externalId":…,"expectedUpdatedAt":…,"changes":{…},"requestId":…}
--   {"action":"create","class":{…},"requestId":…}
--   {"action":"cancel","externalId":…,"expectedUpdatedAt":…,"reason":…,"requestId":…}
-- Returns {"class": <the class as it now stands>}. Refusals raise the same
-- codes the admin calendar's RPCs raise, plus STALE_CLASS and SYNC_OFF.
create or replace function public.xertos_sync_apply_edit(p_edit jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text := p_edit ->> 'action';
  v_request text := nullif(btrim(coalesce(p_edit ->> 'requestId', '')), '');
  v_receipt public.xertos_edit_receipts%rowtype;
  v_session public.class_sessions%rowtype;
  v_template public.class_templates%rowtype;
  v_changes jsonb;
  v_class jsonb;
  v_payload jsonb;
  v_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_answer jsonb;
begin
  if not coalesce((select enabled from public.xertos_sync_settings where id), false) then
    raise exception 'SYNC_OFF';
  end if;
  if v_action is null or v_action not in ('update', 'create', 'cancel') then
    raise exception 'INVALID_EDIT';
  end if;
  if v_request is null or char_length(v_request) > 200 then raise exception 'INVALID_EDIT'; end if;

  perform pg_advisory_xact_lock(hashtextextended('xertos-edit:' || v_request, 0));
  select * into v_receipt from public.xertos_edit_receipts where request_id = v_request;
  if found then
    if v_receipt.action <> v_action then raise exception 'REQUEST_ID_REUSED'; end if;
    return v_receipt.answer;
  end if;

  if v_action in ('update', 'cancel') then
    begin
      v_id := (p_edit ->> 'externalId')::uuid;
    exception when invalid_text_representation then
      raise exception 'SESSION_NOT_FOUND';
    end;
    select * into v_session from public.class_sessions where id = v_id for update;
    if not found then raise exception 'SESSION_NOT_FOUND'; end if;
    -- XertOS sends the copy it last saw. Anything newer here wins.
    if p_edit ? 'expectedUpdatedAt' and p_edit ->> 'expectedUpdatedAt' is not null
       and public.xertos_iso(v_session.updated_at)
           is distinct from public.xertos_iso((p_edit ->> 'expectedUpdatedAt')::timestamptz) then
      raise exception 'STALE_CLASS';
    end if;
  end if;

  if v_action = 'cancel' then
    if v_session.status <> 'cancelled' then
      perform public.class_session_cancel_core(v_id);
    end if;

  elsif v_action = 'update' then
    v_changes := coalesce(p_edit -> 'changes', '{}'::jsonb);
    if jsonb_typeof(v_changes) <> 'object' then raise exception 'INVALID_EDIT'; end if;
    v_start := coalesce((v_changes ->> 'startsAt')::timestamptz, v_session.start_time);
    v_end := case
      when v_changes ? 'endsAt' then (v_changes ->> 'endsAt')::timestamptz
      when v_changes ? 'startsAt' then v_start + coalesce(v_session.end_time - v_session.start_time,
        make_interval(mins => coalesce(v_session.duration_minutes, 60)))
      else v_session.end_time
    end;
    if v_end is not null and v_end <= v_start then raise exception 'INVALID_TIMES'; end if;
    v_payload := jsonb_build_object(
      'class_type', v_session.class_type,
      'title', case when v_changes ? 'title' then v_changes ->> 'title' else v_session.title end,
      'description', case when v_changes ? 'description' then v_changes ->> 'description' else v_session.description end,
      'coach_name', case when v_changes ? 'coachName' then v_changes ->> 'coachName' else v_session.coach_name end,
      'start_time', v_start,
      'end_time', v_end,
      'duration_minutes', case when v_end is null then v_session.duration_minutes
                               else (extract(epoch from (v_end - v_start)) / 60)::integer end,
      'capacity', case when v_changes ? 'capacity' then (v_changes ->> 'capacity')::integer else v_session.capacity end,
      'location_zone', v_session.location_zone,
      'beginner_friendly', v_session.beginner_friendly,
      'intensity_level', v_session.intensity_level,
      'status', v_session.status,
      'public_visible', case when v_changes ? 'publicVisible' then (v_changes ->> 'publicVisible')::boolean else v_session.public_visible end,
      'booking_mode', v_session.booking_mode,
      'notes', case when v_changes ? 'notes' then v_changes ->> 'notes' else v_session.notes end
    );
    perform public.class_session_update_core(v_id, v_payload);

  else
    v_class := p_edit -> 'class';
    if v_class is null or jsonb_typeof(v_class) <> 'object'
       or nullif(btrim(coalesce(v_class ->> 'title', '')), '') is null
       or v_class ->> 'startsAt' is null or v_class ->> 'endsAt' is null then
      raise exception 'INVALID_EDIT';
    end if;
    v_start := (v_class ->> 'startsAt')::timestamptz;
    v_end := (v_class ->> 'endsAt')::timestamptz;
    if v_end <= v_start then raise exception 'INVALID_TIMES'; end if;
    -- The owner's saved preset for this kind of class fills what XertOS doesn't know.
    select * into v_template
      from public.class_templates
     where class_type = v_class ->> 'classType'
     order by updated_at desc
     limit 1;
    insert into public.class_sessions (
      class_type, title, description, coach_name, start_time, end_time, duration_minutes,
      capacity, location_zone, beginner_friendly, intensity_level, status, public_visible,
      booking_mode, notes
    ) values (
      v_class ->> 'classType',
      btrim(v_class ->> 'title'),
      coalesce(v_class ->> 'description', v_template.description),
      coalesce(v_class ->> 'coachName', v_template.coach_name),
      v_start,
      v_end,
      (extract(epoch from (v_end - v_start)) / 60)::integer,
      coalesce((v_class ->> 'capacity')::integer, v_template.capacity, 8),
      v_template.location_zone,
      coalesce(v_template.beginner_friendly, false),
      coalesce(v_template.intensity_level, 'Moderate'),
      'published',
      coalesce((v_class ->> 'publicVisible')::boolean, true),
      coalesce(v_template.booking_mode, 'request_to_book'),
      coalesce(v_class ->> 'notes', v_template.notes)
    )
    returning id into v_id;
  end if;

  v_answer := jsonb_build_object('class', public.xertos_class_payload(v_id));
  insert into public.xertos_edit_receipts (request_id, action, session_id, answer)
  values (v_request, v_action, v_id, v_answer);
  return v_answer;
end;
$$;

-- ── 7. Who may call what ───────────────────────────────────────────────────
-- Everything here runs from the server with the service role. Nobody signed in
-- calls it directly; the admin wrappers above keep their own grants.

do $grants$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.xertos_iso(timestamptz)',
    'public.xertos_class_json(public.class_sessions, integer, boolean)',
    'public.xertos_class_payload(uuid)',
    'public.xertos_queue_class(uuid, boolean, jsonb)',
    'public.xertos_class_changed()',
    'public.xertos_booking_changed()',
    'public.xertos_sync_due()',
    'public.xertos_sync_claim(integer)',
    'public.xertos_sync_settle(uuid, boolean, text)',
    'public.xertos_sync_window(integer)',
    'public.xertos_sync_apply_edit(jsonb)',
    'public.class_session_update_core(uuid, jsonb)',
    'public.class_session_cancel_core(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
  end loop;
  foreach v_fn in array array[
    'public.xertos_class_payload(uuid)',
    'public.xertos_sync_due()',
    'public.xertos_sync_claim(integer)',
    'public.xertos_sync_settle(uuid, boolean, text)',
    'public.xertos_sync_window(integer)',
    'public.xertos_sync_apply_edit(jsonb)'
  ] loop
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$grants$;
