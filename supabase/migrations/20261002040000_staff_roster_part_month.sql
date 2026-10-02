-- Fail fast instead of queueing behind live traffic for a lock. Safe to re-run
-- if it times out: every statement below is idempotent. `local` keeps the
-- setting to this run's transaction (the SQL editor sends the file as one
-- implicit transaction), so it does not linger on the editor's connection.
set local lock_timeout = '5s';

-- ============================================================================
-- XERT Roster: part-month roster periods
-- ============================================================================
-- Forward migration on top of 20261001010000_staff_roster.sql,
-- 20261002010000_staff_roster_push_reliability.sql and
-- 20261002020000_staff_roster_coach_dashboard.sql (all applied; never edited).
-- Additive and idempotent. It changes no existing row, class, booking, notice
-- or assignment, and it leaves the roster switch exactly as it is.
--
-- Until now a roster period could only cover a whole month that had not
-- started: availability had to be due before the 1st. A part-month period
-- rosters coaches from a date inside the month instead ("October classes from
-- the 9th"):
--
--   * staff_roster_periods.starts_on: the first gym date the roster covers.
--     Null (every existing period) means the whole month, exactly as before.
--   * Answers are due, and the publish target falls, before starts_on.
--   * Classes before starts_on are not asked about, are not gaps, and cannot
--     be assigned (SESSION_BEFORE_ROSTER_START). They keep whatever coach they
--     have now; the roster never writes a name onto them.
--   * staff_roster_open_part_month opens one, from today, for managers only.
--
-- Rollback: docs/staff-roster/rollback.sql removes the whole roster; the
-- column and both checks go with the staff_roster_periods table.
-- ============================================================================


-- ─── The start date and its rules ───────────────────────────────────────────

alter table public.staff_roster_periods add column if not exists starts_on date;

-- Same name and rules as before, except that answers are due before the
-- roster starts (starts_on, or the 1st when there is none).
alter table public.staff_roster_periods drop constraint if exists staff_roster_periods_order;
alter table public.staff_roster_periods add constraint staff_roster_periods_order
  check (opens_on <= due_on and due_on <= publish_target_on and due_on < coalesce(starts_on, month));

-- A start date is a later day of the same month, after the publish target.
alter table public.staff_roster_periods drop constraint if exists staff_roster_periods_starts_on;
alter table public.staff_roster_periods add constraint staff_roster_periods_starts_on
  check (starts_on is null or (starts_on > month and starts_on < (month + interval '1 month')::date and publish_target_on < starts_on));


-- ─── Opening a part-month period ────────────────────────────────────────────

-- Opens `p_month` for classes from `p_starts_on`, asking coaches from today.
-- Modelled on staff_roster_open_period: managers only, one roster lock, a
-- replayed request id returns the first result. The month itself may be in
-- the future (that is not refused), but the start date must still be ahead.
create or replace function public.staff_roster_open_part_month(p_month date, p_starts_on date, p_due_on date, p_publish_target_on date, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_replay jsonb;
  v_row public.staff_roster_periods;
  v_today date := public.staff_roster_today();
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  v_replay := public.staff_roster_replay(p_request_id, 'open_part_month');
  if v_replay is not null then return v_replay; end if;
  perform public.staff_roster_month_param(p_month);
  if exists (select 1 from public.staff_roster_periods where month = p_month) then raise exception 'PERIOD_EXISTS'; end if;
  if p_starts_on is null or p_starts_on <= greatest(p_month, v_today) or p_starts_on >= (p_month + interval '1 month')::date then
    raise exception 'STARTS_ON_INVALID';
  end if;
  if p_due_on < v_today then raise exception 'NO_BACKDATING'; end if;
  -- A coach already rostered on a class before the start would be left on a
  -- class this roster no longer covers. Sort those out first.
  if exists (
    select 1 from public.staff_assignments a
    join public.staff_roster_revisions r on r.id = a.revision_id
    left join public.class_sessions s on s.id = a.session_id
    where r.month = p_month and r.state in ('draft', 'published')
      and coalesce(s.start_time, a.session_start) < public.staff_roster_local(p_starts_on, 0)
  ) then
    raise exception 'ASSIGNMENTS_BEFORE_START';
  end if;
  insert into public.staff_roster_periods (month, opens_on, due_on, publish_target_on, shortened, starts_on, opened_by)
  values (p_month, v_today, p_due_on, p_publish_target_on, true, p_starts_on, auth.uid())
  returning * into v_row;
  perform public.staff_roster_audit('period_opened', 'period', p_month::text, p_month, null, to_jsonb(v_row));
  return public.staff_roster_remember(p_request_id, 'open_part_month', to_jsonb(v_row));
end;
$$;

revoke all on function public.staff_roster_open_part_month(date, date, date, date, uuid) from public, anon, authenticated;
grant execute on function public.staff_roster_open_part_month(date, date, date, date, uuid) to authenticated;


-- ─── Classes before the start date stay out of the roster ───────────────────
-- Each function below is copied verbatim from 20261001010000_staff_roster.sql
-- (none was replaced by a later migration) with only the lines marked
-- `-- part-month` added. Same signatures, so existing grants carry over; they
-- are re-asserted at the end anyway. test/staff-roster-part-month-db.test.js
-- checks the copies have not drifted.

-- Only classes from the roster's start date count as gaps.
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
    and not exists (select 1 from public.staff_roster_periods p where p.month = p_month and s.starts_at < public.staff_roster_local(p.starts_on, 0)) -- part-month
    and coalesce((x->>'required')::boolean, true)
    and not exists (select 1 from public.staff_assignments a where a.revision_id = p_revision and a.session_id = s.session_id and a.slot_key = x->>'key');
$$;

-- Coaches are only asked about classes from the roster's start date.
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
      and not exists (select 1 from public.staff_roster_periods p where p.month = p_month and starts_at < public.staff_roster_local(p.starts_on, 0)) -- part-month
  ), '[]'::jsonb);
end;
$$;

-- A class before the roster's start date keeps its current coach and cannot
-- be assigned from this month's roster.
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
  if v_revision_month is not null and exists (select 1 from public.staff_roster_periods p where p.month = v_revision_month and v_session.starts_at < public.staff_roster_local(p.starts_on, 0)) then -- part-month
    v_problems := v_problems || 'SESSION_BEFORE_ROSTER_START'::text; -- part-month
  end if; -- part-month

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

-- Coach screens: each period says the date its roster starts (null = the 1st).
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
        'starts_on', p.starts_on, -- part-month
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

-- ─── Privileges ─────────────────────────────────────────────────────────────
-- Unchanged by `create or replace`; re-asserted so a partial earlier run can
-- never leave them open. Coach and manager screens call staff_roster_me and
-- staff_roster_month_classes; the other two are internal to the roster.

revoke all on function public.staff_roster_gaps(uuid, date) from public, anon, authenticated;
revoke all on function public.staff_roster_assignment_problems(uuid, uuid, text, uuid, uuid[], boolean) from public, anon, authenticated;
revoke all on function public.staff_roster_me() from public, anon, authenticated;
grant execute on function public.staff_roster_me() to authenticated;
revoke all on function public.staff_roster_month_classes(date) from public, anon, authenticated;
grant execute on function public.staff_roster_month_classes(date) to authenticated;

-- Last statement, so a partial run can never look complete.
insert into public.xert_schema_capabilities (capability) values ('staff_roster_part_month') on conflict (capability) do nothing;
