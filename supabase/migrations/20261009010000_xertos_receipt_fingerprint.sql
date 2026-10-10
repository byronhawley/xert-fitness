-- =============================================================================
-- XertOS receipt fingerprints: prove that a replay is the same signed request.
--
-- PR36 made the public calendar edit endpoint inert unless explicitly enabled,
-- but its durable receipt still compared only the action. This migration adds
-- one nullable fingerprint to the existing receipt so a repeated request_id can
-- prove that it carries the same method, target and exact body. Existing
-- receipts stay nullable and become explicitly unverifiable; they are never
-- backfilled from the class state or the next caller.
--
-- Fingerprint encoding (xertos-calendar-request-v1):
--   xertos-calendar-request-v1\nPOST\n<path>?<query>\n<sha256 hex>
--
-- The application hashes the exact text it authenticated. JSON is not
-- re-serialized for hashing. A mismatched body, method or target refuses with
-- IDEMPOTENCY_KEY_REUSED before domain mutation. A retained receipt without a
-- fingerprint refuses with IDEMPOTENCY_RECEIPT_UNVERIFIABLE.
--
-- Rollout: apply this migration, then deploy the application that sends
-- p_request_fingerprint. The old one-argument signature deliberately remains
-- service-role-callable only as a fail-closed rejection, so an old application
-- cannot bypass enforcement. Rollback must not restore action-only acceptance.
-- =============================================================================

alter table public.xertos_edit_receipts
  add column if not exists request_fingerprint text;

alter table public.xertos_edit_receipts
  drop constraint if exists xertos_edit_receipts_fingerprint_format;

alter table public.xertos_edit_receipts
  add constraint xertos_edit_receipts_fingerprint_format
  check (
    request_fingerprint is null
    or (
      request_fingerprint like E'xertos-calendar-request-v1\nPOST\n%'
      and char_length(request_fingerprint) between 96 and 2048
    )
  );

-- The new signature is the only execution path. The two arguments are bound in
-- one transaction after the per-request lock, so all uses of one request_id
-- serialize together whether they target the same class or different classes.
create or replace function public.xertos_sync_apply_edit(
  p_edit jsonb,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text := p_edit ->> 'action';
  v_request text := nullif(btrim(coalesce(p_edit ->> 'requestId', '')), '');
  v_fingerprint text := nullif(coalesce(p_request_fingerprint, ''), '');
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
  if v_fingerprint is null
     or char_length(v_fingerprint) > 2048
     or array_length(string_to_array(v_fingerprint, E'\n'), 1) <> 4
     or (string_to_array(v_fingerprint, E'\n'))[1] <> 'xertos-calendar-request-v1'
     or (string_to_array(v_fingerprint, E'\n'))[2] <> 'POST'
     or btrim(coalesce((string_to_array(v_fingerprint, E'\n'))[3], '')) = ''
     or coalesce((string_to_array(v_fingerprint, E'\n'))[4], '') !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST_FINGERPRINT';
  end if;

  -- The lock and authoritative receipt comparison are in this one transaction.
  perform pg_advisory_xact_lock(hashtextextended('xertos-edit:' || v_request, 0));
  select * into v_receipt from public.xertos_edit_receipts where request_id = v_request;
  if found then
    if v_receipt.request_fingerprint is null then
      raise exception 'IDEMPOTENCY_RECEIPT_UNVERIFIABLE';
    end if;
    if v_receipt.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;
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
      'start_time', case when v_changes ? 'startsAt' then (v_changes ->> 'startsAt')::timestamptz else v_session.start_time end,
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
  insert into public.xertos_edit_receipts (request_id, action, session_id, answer, request_fingerprint)
  values (v_request, v_action, v_id, v_answer, v_fingerprint);
  return v_answer;
end;
$$;

-- During application rollout, the previous application cannot bypass the new
-- guard. Its one-argument call remains service-role-visible only to return a
-- clear fail-closed error. Never replace this body with action-only replay.
create or replace function public.xertos_sync_apply_edit(p_edit jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'IDEMPOTENCY_RECEIPT_UNVERIFIABLE';
end;
$$;

revoke all on function public.xertos_sync_apply_edit(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.xertos_sync_apply_edit(jsonb)
  from public, anon, authenticated;
grant execute on function public.xertos_sync_apply_edit(jsonb, text) to service_role;
grant execute on function public.xertos_sync_apply_edit(jsonb) to service_role;
