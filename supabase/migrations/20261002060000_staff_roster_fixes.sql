-- Fail fast instead of queueing behind live traffic for a lock. Safe to re-run
-- if it times out: every statement below is idempotent. `local` keeps the
-- setting to this run's transaction (the SQL editor sends the file as one
-- implicit transaction), so it does not linger on the editor's connection.
set local lock_timeout = '5s';

-- ============================================================================
-- XERT Roster: roster editing, class detail and push-preference fixes
-- ============================================================================
-- Forward migration on top of 20261001010000_staff_roster.sql,
-- 20261002010000_staff_roster_push_reliability.sql and
-- 20261002020000_staff_roster_coach_dashboard.sql (all applied; never edited).
--
-- Prerequisites: apply AFTER 20261002040000_staff_roster_part_month.sql and
-- 20261002050000_staff_roster_sms.sql. Order: 040000 -> 050000 -> 060000.
--
-- Additive and idempotent. It changes no existing row, class, booking, notice
-- or assignment, and it leaves the roster switch exactly as it is.
--
--   * staff_roster_apply_changes: with no draft yet the manager screen shows
--     the published roster, so its first edit names a published assignment.
--     The draft made by that call is a copy of it, so the copy (same class,
--     position and coach) is used instead of ASSIGNMENT_NOT_IN_DRAFT.
--     Re-asserting an assignment the draft already has is a no-op (it used to
--     fail on the staff_assignments_slot unique constraint), and moving onto a
--     position held by another assignment, even the same coach's, is
--     SLOT_TAKEN (the rules only counted other coaches).
--   * staff_roster_class_detail: public sign-up requests (class_bookings with
--     status 'requested') show as requests, like member requests already do.
--   * staff_roster_push_preference_on_update: a BEFORE UPDATE trigger on
--     staff_notification_push_deliveries. A coach who switches phone
--     notifications off gets no further push, including one already leased
--     when they switched: a leased row is not begun (staff_roster_push_begin
--     does not return it, so nothing is sent), and push work going back to
--     'pending' (a retry, or a lease that ran out before the send began) is
--     closed as skipped (PUSH_OFF_BY_RECIPIENT). The dispatcher functions are
--     not copied.
--
-- The two replaced functions are copied verbatim from their latest
-- definitions (staff_roster_apply_changes from 20261001010000, never replaced
-- since; staff_roster_class_detail from 20261002020000) with only the lines
-- marked `-- fix` added. Same signatures, so existing grants carry over; they
-- are re-asserted at the end anyway. test/staff-roster-fixes-db.test.js checks
-- the copies have not drifted.
--
-- Rollback: docs/staff-roster/rollback.sql removes the whole roster; the new
-- function goes with its staff_roster_% loop and the trigger with the
-- staff_notification_push_deliveries table.
-- ============================================================================


-- ─── Editing a published month ──────────────────────────────────────────────

-- Applies a batch of draft edits atomically. Every assign/move is checked by
-- the authoritative rules; any hard problem rejects the whole batch.
-- Ops: assign {session_id, slot_key, staff_id, pinned?, source?},
--      unassign {assignment_id}, pin {assignment_id, pinned},
--      move {assignment_id, session_id, slot_key, copy?}.
-- An assignment_id may name the published copy while the draft is a copy of it.
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
      if v_assignment.id is null and v_draft.based_on is not null then -- fix: a published assignment id names its draft copy
        select d.* into v_assignment -- fix
        from public.staff_assignments p -- fix
        join public.staff_assignments d on d.revision_id = v_draft.id and d.session_id = p.session_id and d.slot_key = p.slot_key and d.staff_id = p.staff_id -- fix
        where p.id = (v_change->>'assignment_id')::uuid and p.revision_id = v_draft.based_on; -- fix
      end if; -- fix
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
    elsif v_op = 'assign' and exists (select 1 from public.staff_assignments x where x.revision_id = v_draft.id -- fix: re-asserting an identical assignment
        and x.session_id = (v_change->>'session_id')::uuid and x.slot_key = v_change->>'slot_key' and x.staff_id = (v_change->>'staff_id')::uuid) then -- fix
      null; -- fix: that coach already holds that position in the draft; nothing to add
    elsif v_op in ('assign', 'move') then
      v_session := (v_change->>'session_id')::uuid;
      v_slot := v_change->>'slot_key';
      v_staff := case when v_op = 'move' then v_assignment.staff_id else (v_change->>'staff_id')::uuid end;
      v_problems := public.staff_roster_assignment_problems(v_draft.id, v_session, v_slot, v_staff,
        case when v_op = 'move' and not coalesce((v_change->>'copy')::boolean, false) then array[v_assignment.id] else '{}'::uuid[] end);
      if p_correction_reason is not null then
        v_problems := array(select p from unnest(v_problems) p where p not in ('SESSION_STARTED', 'AVAILABILITY_UNKNOWN', 'AVAILABILITY_PARTIAL'));
      end if;
      if v_op = 'move' and exists (select 1 from public.staff_assignments x where x.revision_id = v_draft.id -- fix: a move onto an occupied position
          and x.session_id = v_session and x.slot_key = v_slot and x.id <> v_assignment.id) then -- fix
        v_problems := array(select distinct p from unnest(v_problems || array['SLOT_TAKEN']) p); -- fix
      end if; -- fix
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


-- ─── Class detail: public sign-up requests ──────────────────────────────────

-- Headcount, who's booked (first name and last initial only: no contact or
-- health details), waitlist count and the session plan with its history.
create or replace function public.staff_roster_class_detail(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_session public.class_sessions;
  v_people jsonb;
  v_booked integer;
  v_pending integer;
  v_waiting integer;
begin
  if not public.staff_roster_on_class(p_session_id) then raise exception 'NOT_ON_CLASS'; end if;
  select * into v_session from public.class_sessions where id = p_session_id;
  if v_session.id is null then raise exception 'SESSION_NOT_FOUND'; end if;
  with people as (
    select public.staff_roster_short_name(p.full_name) as name, b.status, false as guest, b.created_at
    from public.session_bookings b left join public.profiles p on p.id = b.user_id
    where b.class_session_id = p_session_id and b.status in ('requested', 'confirmed', 'attended', 'no_show')
    union all
    select public.staff_roster_short_name(c.full_name), c.status, coalesce(c.guest_visit, false), c.created_at
    from public.class_bookings c
    where c.class_session_id = p_session_id and c.status in ('confirmed', 'attended', 'no_show')
    union all -- fix: public sign-up requests count as requests too
    select public.staff_roster_short_name(c.full_name), c.status, coalesce(c.guest_visit, false), c.created_at -- fix
    from public.class_bookings c where c.class_session_id = p_session_id and c.status = 'requested' -- fix
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'status', status, 'guest', guest) order by created_at), '[]'::jsonb),
    count(*) filter (where status <> 'requested'), count(*) filter (where status = 'requested')
  into v_people, v_booked, v_pending from people;
  select (select count(*) from public.session_bookings where class_session_id = p_session_id and status = 'waitlisted')
    + (select count(*) from public.class_bookings where class_session_id = p_session_id and status = 'waitlisted')
  into v_waiting;
  return jsonb_build_object(
    'session', jsonb_build_object('id', v_session.id, 'title', v_session.title, 'start', v_session.start_time, 'status', v_session.status),
    'capacity', v_session.capacity, 'booked', v_booked, 'pending', v_pending, 'waitlist', v_waiting, 'people', v_people,
    'note', (select jsonb_build_object('id', n.id, 'body', n.body, 'at', n.created_at,
        'by', coalesce((select display_name from public.staff_members where id = n.author_staff_id), (select full_name from public.profiles where id = n.author_profile_id)))
      from public.staff_session_notes n where n.session_id = p_session_id order by n.created_at desc, n.id limit 1),
    'note_history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'body', h.body, 'at', h.created_at,
        'by', coalesce((select display_name from public.staff_members where id = h.author_staff_id), (select full_name from public.profiles where id = h.author_profile_id)))
        order by h.created_at desc)
      from (select * from public.staff_session_notes where session_id = p_session_id order by created_at desc, id offset 1 limit 20) h), '[]'::jsonb));
end;
$$;


-- ─── Push stops when a coach switches it off ────────────────────────────────

-- Runs before every update of a push delivery. Does nothing unless the
-- recipient has switched phone notifications off.
create or replace function public.staff_roster_push_preference_on_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.staff_notice_preferences where profile_id = new.recipient_profile_id and not push) then
    return new;
  end if;
  -- staff_roster_push_begin marking the send as started: do not start it.
  if new.status = 'sending' and old.send_started_at is null and new.send_started_at is not null then
    return null;
  end if;
  -- Back to pending for another attempt: close it instead.
  if new.status = 'pending' and old.status is distinct from 'pending' then
    new.status := 'skipped';
    new.reason := 'PUSH_OFF_BY_RECIPIENT';
    new.next_attempt_at := null;
    new.lease_token := null;
    new.lease_expires_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists staff_notification_push_preferences_update on public.staff_notification_push_deliveries;
create trigger staff_notification_push_preferences_update before update on public.staff_notification_push_deliveries
  for each row execute function public.staff_roster_push_preference_on_update();


-- ─── Privileges ─────────────────────────────────────────────────────────────
-- Unchanged by `create or replace`; re-asserted exactly as the source
-- migrations set them, so a partial earlier run can never leave them open.
-- Managers call staff_roster_apply_changes and coaches staff_roster_class_detail;
-- the trigger function is internal.

revoke all on function public.staff_roster_apply_changes(date, integer, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.staff_roster_apply_changes(date, integer, jsonb, uuid, text) to authenticated;
revoke all on function public.staff_roster_class_detail(uuid) from public, anon, authenticated;
grant execute on function public.staff_roster_class_detail(uuid) to authenticated;
revoke all on function public.staff_roster_push_preference_on_update() from public, anon, authenticated;

-- Last statement, so a partial run can never look complete.
insert into public.xert_schema_capabilities (capability) values ('staff_roster_fixes') on conflict (capability) do nothing;
