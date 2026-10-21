-- Coaches, and any staff member an admin allows, can add people to a class.
--
-- Until now only the two admin accounts could: admin_book_member_into_class
-- refused everyone else, and a coach could see who was booked into their class
-- but not add anyone. And nobody, admin included, could add somebody without
-- an account -- the desk had to turn a walk-in away or sign them up later.
--
-- Who may add people (staff_can_book_members):
--   * admins, as before;
--   * active lead coaches, always;
--   * any other active staff member an admin has ticked "Can add people to
--     classes" for (staff_members.can_book_members).
--
-- What they can add, to any upcoming class:
--   * a registered member, picked from a search -- booked through the very same
--     staff_book_member_core the admins use, so capacity, the waitlist, the
--     member's in-app notice and the double-booking guard are identical;
--   * a walk-in by name, with an optional phone and email, as a sign-up on the
--     class the same way a website sign-up is stored.
--
-- Coaches see less of the member directory than admins do: a name and a
-- partly hidden email, enough to tell two people apart, and no phone number.

alter table public.staff_members
  add column if not exists can_book_members boolean not null default false;

comment on column public.staff_members.can_book_members is
  'Allowed to add people to classes. Lead coaches always are; this lets an admin allow anyone else.';

create or replace function public.staff_can_book_members()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_admin() or exists (
    select 1 from public.staff_members s
     where s.profile_id = auth.uid()
       and s.status = 'active'
       and ('lead' = any(s.roles) or s.can_book_members)
  );
$$;

revoke all on function public.staff_can_book_members() from public, anon;
grant execute on function public.staff_can_book_members() to authenticated;

create or replace function public.staff_roster_require_booker()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if not public.staff_can_book_members() then raise exception 'NOT_ALLOWED_TO_BOOK'; end if;
end;
$$;

revoke all on function public.staff_roster_require_booker() from public, anon, authenticated;

-- One class a coach can add to: still to finish, live, and taking bookings.
create or replace function public.staff_roster_bookable_session(p_session_id uuid)
returns public.class_sessions
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_session public.class_sessions;
begin
  select * into v_session from public.class_sessions where id = p_session_id;
  if v_session.id is null then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status not in ('published', 'full') then raise exception 'SESSION_NOT_BOOKABLE'; end if;
  if coalesce(v_session.end_time, v_session.start_time + interval '3 hours') <= now() then raise exception 'SESSION_FINISHED'; end if;
  if coalesce(v_session.booking_mode, 'instant_book') = 'interest_only' then raise exception 'SESSION_INTEREST_ONLY'; end if;
  return v_session;
end;
$$;

revoke all on function public.staff_roster_bookable_session(uuid) from public, anon, authenticated;

-- The classes there are to add people to: the next fortnight by default.
create or replace function public.staff_roster_upcoming_classes(p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 14), 1), 31);
begin
  perform public.staff_roster_require_booker();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'title', s.title, 'start', s.start_time, 'end', s.end_time,
      'location', s.location_zone, 'status', s.status, 'capacity', s.capacity,
      'held', places.held, 'waiting', places.waiting
    ) order by s.start_time, s.id)
    from public.class_sessions s
    cross join lateral public.class_places_held(s.id) as places
    where s.status in ('published', 'full')
      and coalesce(s.booking_mode, 'instant_book') <> 'interest_only'
      and coalesce(s.end_time, s.start_time + interval '3 hours') > now()
      and s.start_time < now() + make_interval(days => v_days)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.staff_roster_upcoming_classes(integer) from public, anon;
grant execute on function public.staff_roster_upcoming_classes(integer) to authenticated;

-- Registered members to pick from. A name and a partly hidden email -- enough
-- to tell two Sarahs apart -- and never a phone number.
create or replace function public.staff_roster_search_members(p_search text, p_limit integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_term text := btrim(coalesce(p_search, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 20);
begin
  perform public.staff_roster_require_booker();
  if char_length(v_term) < 2 then return '[]'::jsonb; end if;
  v_term := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name, 'email_hint', m.email_hint) order by m.full_name, m.id)
    from (
      select p.id, nullif(btrim(p.full_name), '') as full_name,
        case
          when position('@' in coalesce(p.email, '')) > 1 then
            left(p.email, 2) || repeat('*', greatest(position('@' in p.email) - 3, 1))
            || substr(p.email, position('@' in p.email))
          else null
        end as email_hint
      from public.profiles p
      where p.role = 'member'
        and (p.full_name ilike v_term or p.email ilike v_term)
      order by p.full_name nulls last, p.id
      limit v_limit
    ) m
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.staff_roster_search_members(text, integer) from public, anon;
grant execute on function public.staff_roster_search_members(text, integer) to authenticated;

-- Book a registered member in, exactly as an admin would.
create or replace function public.staff_roster_book_member(p_session_id uuid, p_member_id uuid, p_request_id uuid)
returns table(request_id uuid, booking_id uuid, session_id uuid, member_id uuid, booking_status text,
  credit_batch_id uuid, announcement_id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform public.staff_roster_require_booker();
  -- Tells the booking identity guard this is a vetted staff booking for
  -- somebody else (enforce_member_booking_switch), for this call only.
  perform pg_catalog.set_config('xert.staff_booking', 'on', true);
  return query
  select * from public.staff_book_member_core(p_session_id, p_member_id, p_request_id, auth.uid());
  perform pg_catalog.set_config('xert.staff_booking', '', true);
end;
$$;

revoke all on function public.staff_roster_book_member(uuid, uuid, uuid) from public, anon;
grant execute on function public.staff_roster_book_member(uuid, uuid, uuid) to authenticated;

-- Add somebody with no account. Stored as a sign-up on the class, the way the
-- website stores one, so the roster, attendance and the class count all see
-- them. With an email they get the usual booking confirmation.
create or replace function public.staff_roster_add_walk_in(
  p_session_id uuid,
  p_full_name text,
  p_phone text default null,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_session public.class_sessions;
  v_name text := regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_held integer;
  v_waiting integer;
  v_status text;
  v_id uuid;
  v_by text;
begin
  perform public.staff_roster_require_booker();
  if char_length(v_name) < 2 or char_length(v_name) > 120 then raise exception 'WALK_IN_NAME_INVALID'; end if;
  if v_email is not null and (v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 320) then
    raise exception 'WALK_IN_EMAIL_INVALID';
  end if;
  if v_phone is not null and char_length(v_phone) > 40 then raise exception 'WALK_IN_PHONE_INVALID'; end if;

  -- Serialise adds to one class, so two taps -- or two staff -- cannot both
  -- take the last place, and the duplicate check below sees the first add.
  perform pg_advisory_xact_lock(hashtextextended('class_walk_in:' || p_session_id::text, 0));
  v_session := public.staff_roster_bookable_session(p_session_id);

  if exists (
    select 1 from public.class_bookings b
     where b.class_session_id = p_session_id
       and b.status in ('requested', 'confirmed', 'waitlisted', 'attended')
       and (
         (v_email is not null and lower(btrim(b.email)) = v_email)
         or (v_email is null and lower(regexp_replace(btrim(b.full_name), '\s+', ' ', 'g')) = lower(v_name))
       )
  ) then
    raise exception 'ALREADY_ON_CLASS';
  end if;

  select places.held, places.waiting into v_held, v_waiting from public.class_places_held(p_session_id) as places;
  v_status := case
    when v_session.status = 'full' or v_held >= v_session.capacity or v_waiting > 0 then 'waitlisted'
    else 'confirmed'
  end;

  select coalesce(
    (select display_name from public.staff_members where profile_id = auth.uid()),
    (select nullif(btrim(full_name), '') from public.profiles where id = auth.uid()),
    'staff'
  ) into v_by;

  insert into public.class_bookings (class_session_id, full_name, email, phone, consent_to_contact, status, admin_notes)
  values (p_session_id, v_name, v_email, v_phone, false, v_status,
    'Added at the desk by ' || v_by || ' on ' || to_char(now() at time zone 'Australia/Brisbane', 'DD Mon YYYY, FMHH12:MI AM'))
  returning id into v_id;

  return jsonb_build_object('booking_id', v_id, 'status', v_status, 'session_id', p_session_id, 'full_name', v_name);
end;
$$;

revoke all on function public.staff_roster_add_walk_in(uuid, text, text, text) from public, anon;
grant execute on function public.staff_roster_add_walk_in(uuid, text, text, text) to authenticated;

-- An admin allows (or stops allowing) a staff member to add people.
create or replace function public.staff_roster_set_can_book_members(p_staff_id uuid, p_allowed boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.staff_members;
begin
  perform public.staff_roster_require_manager();
  update public.staff_members set can_book_members = coalesce(p_allowed, false)
   where id = p_staff_id
  returning * into v_row;
  if v_row.id is null then raise exception 'STAFF_NOT_FOUND'; end if;
  return jsonb_build_object('id', v_row.id, 'can_book_members', v_row.can_book_members);
end;
$$;

revoke all on function public.staff_roster_set_can_book_members(uuid, boolean) from public, anon;
grant execute on function public.staff_roster_set_can_book_members(uuid, boolean) to authenticated;

-- The booking identity guard lets a vetted staff booking through, and
-- nothing else new.
CREATE OR REPLACE FUNCTION public.enforce_member_booking_switch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_bookings_enabled boolean := false;
begin
  if auth.role() = 'service_role'
     or public.is_admin() then
    return new;
  end if;

  -- A booking made for somebody else through staff_roster_book_member, by a
  -- coach or staff member allowed to add people. The marker is set only by
  -- that function, for the length of its own call, and a client cannot set
  -- it; it still has to be somebody allowed to book. Members booking
  -- themselves are unaffected and checked as before.
  if pg_catalog.current_setting('xert.staff_booking', true) = 'on'
     and public.staff_can_book_members() then
    return new;
  end if;

  if new.user_id is distinct from v_actor then
    raise exception 'BOOKING_ACCOUNT_MISMATCH';
  end if;

  select coalesce(bool_or(settings.bookings_enabled), false)
    into v_bookings_enabled
    from public.admin_settings as settings;

  if not v_bookings_enabled then
    raise exception 'BOOKINGS_PAUSED';
  end if;

  return new;
end;
$function$;

-- The manager's staff list carries the setting, so the tick box shows it.
CREATE OR REPLACE FUNCTION public.staff_roster_planning_snapshot(p_month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'roles', m.roles, 'status', m.status, 'version', m.version, 'manager_note', m.manager_note, 'can_book_members', m.can_book_members,
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
$function$;

-- A coach's own summary says whether they can add people, so the app knows to
-- show them the way in.
CREATE OR REPLACE FUNCTION public.staff_roster_me()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff public.staff_members;
  v_today date := public.staff_roster_today();
begin
  v_staff := public.staff_roster_current_staff();
  return jsonb_build_object(
    'staff', jsonb_build_object('id', v_staff.id, 'display_name', v_staff.display_name, 'roles', v_staff.roles, 'status', v_staff.status,
      'can_book_members', public.staff_can_book_members()),
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
$function$;

do $$
begin
  if pg_catalog.has_function_privilege('anon', 'public.staff_roster_add_walk_in(uuid, text, text, text)', 'execute')
    or pg_catalog.has_function_privilege('anon', 'public.staff_roster_search_members(text, integer)', 'execute')
    or pg_catalog.has_function_privilege('anon', 'public.staff_roster_book_member(uuid, uuid, uuid)', 'execute') then
    raise exception 'Adding people to classes must not be open to anon.';
  end if;
end;
$$;
