-- PT booking, round two.
--  * Coaches can offer exact start times as well as time windows. An hours
--    entry is either a window {"weekday", "start", "end"} (a start time every
--    slot step that fits the session) or a fixed start
--    {"weekday", "start", "kind": "start"} offered as it is.
--  * Signed-in members can see their own PT sessions and packages.
-- Additive: replaces two PT functions and adds one. No table changes.

create or replace function public.pt_normalize_hours(p_hours jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  v_item jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_prev jsonb;
  v_kind text;
  v_weekday integer;
  v_start integer;
  v_end integer;
begin
  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 60 then raise exception 'HOURS_INVALID'; end if;
  for v_item in select value from jsonb_array_elements(p_hours) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'HOURS_INVALID'; end if;
    v_kind := coalesce(v_item->>'kind', 'window');
    begin
      v_weekday := (v_item->>'weekday')::integer;
      v_start := (v_item->>'start')::integer;
      v_end := case when v_kind = 'start' then v_start + 5 else (v_item->>'end')::integer end;
    exception when others then
      raise exception 'HOURS_INVALID';
    end;
    if v_kind not in ('window', 'start') or v_weekday is null or v_weekday not between 0 and 6 or v_start is null or v_end is null
      or v_start < 0 or v_end > 1440 or v_start >= v_end or v_start % 5 <> 0 or v_end % 5 <> 0 then
      raise exception 'HOURS_INVALID';
    end if;
    if v_kind = 'start' then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('weekday', v_weekday, 'start', v_start, 'kind', 'start'));
    else
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('weekday', v_weekday, 'start', v_start, 'end', v_end));
    end if;
  end loop;
  -- Sorted by day and time; repeated start times collapse to one.
  select coalesce(jsonb_agg(x order by (x->>'weekday')::integer, (x->>'start')::integer, x->>'kind' nulls first), '[]'::jsonb) into v_rows
    from (select distinct x from jsonb_array_elements(v_rows) x) d;
  -- Windows on the same day can't overlap. Start times may sit anywhere.
  for v_item in select value from jsonb_array_elements(v_rows) where value->>'kind' is null loop
    if v_prev is not null and (v_prev->>'weekday') = (v_item->>'weekday') and (v_item->>'start')::integer < (v_prev->>'end')::integer then
      raise exception 'HOURS_OVERLAP';
    end if;
    v_prev := v_item;
  end loop;
  return v_rows;
end;
$$;

-- Open start times for a service between two gym dates (inclusive). Applies
-- the coach's windows and start times, notice and horizon, and every conflict.
create or replace function public.pt_open_slots(p_service uuid, p_from date, p_to date)
returns setof timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  v_settings public.pt_settings;
  v_service public.pt_services;
  v_hours public.pt_weekly_hours;
  v_day date;
  v_window jsonb;
  v_minute integer;
  v_minutes integer[];
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
    v_minutes := '{}';
    for v_window in select value from jsonb_array_elements(v_hours.hours)
      where (value->>'weekday')::integer = extract(dow from v_day)::integer
    loop
      if v_window->>'kind' = 'start' then
        if (v_window->>'start')::integer + v_service.duration_minutes <= 1440 then
          v_minutes := v_minutes || (v_window->>'start')::integer;
        end if;
      else
        v_minute := (v_window->>'start')::integer;
        while v_minute + v_service.duration_minutes <= (v_window->>'end')::integer loop
          v_minutes := v_minutes || v_minute;
          v_minute := v_minute + v_settings.slot_step_minutes;
        end loop;
      end if;
    end loop;
    for v_minute in select distinct m from unnest(v_minutes) m order by m loop
      v_start := public.pt_local(v_day, v_minute);
      v_end := v_start + make_interval(mins => v_service.duration_minutes);
      if v_start >= v_earliest and v_start < v_latest
        and public.pt_staff_conflict(v_service.staff_id, tstzrange(v_start - v_buffer, v_end + v_buffer, '[)')) is null then
        return next v_start;
      end if;
    end loop;
    v_day := v_day + 1;
  end loop;
end;
$$;

-- A signed-in member's own PT: upcoming sessions (with their private manage
-- link) and packages, from bookings made while signed in with their email.
create or replace function public.pt_member_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  return jsonb_build_object(
    'enabled', coalesce((public.pt_settings_row()).enabled, false),
    'bookings', (select coalesce(jsonb_agg(public.pt_booking_public_json(b.id)
          || jsonb_build_object('id', b.id, 'token', b.cancel_token) order by b.starts_at), '[]'::jsonb)
      from public.pt_bookings b join public.pt_clients c on c.id = b.client_id
      where c.profile_id = v_uid and b.status in ('requested', 'confirmed') and b.ends_at > now()),
    'packages', (select coalesce(jsonb_agg(public.pt_package_json(cp.id)
          || jsonb_build_object('coach_name', public.pt_coach_name(c.staff_id)) order by cp.created_at desc), '[]'::jsonb)
      from public.pt_client_packages cp join public.pt_clients c on c.id = cp.client_id
      where c.profile_id = v_uid and cp.status = 'active'
        and (cp.expires_on is null or cp.expires_on >= public.pt_gym_now_date())
        and public.pt_package_remaining(cp.id) > 0));
end;
$$;

revoke all on function public.pt_member_overview() from public, anon, authenticated;
grant execute on function public.pt_member_overview() to authenticated;
revoke all on function public.pt_normalize_hours(jsonb) from public, anon, authenticated;
revoke all on function public.pt_open_slots(uuid, date, date) from public, anon, authenticated;

insert into public.xert_schema_capabilities (capability) values ('pt_start_times') on conflict (capability) do nothing;
