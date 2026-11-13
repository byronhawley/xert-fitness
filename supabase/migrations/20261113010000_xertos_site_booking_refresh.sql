-- =============================================================================
-- XertOS → XERT: request a fresh booking snapshot after a site-booking match.
--
-- Matching a site booking in XertOS only links the existing site_bookings row
-- to a person and writes an audit record. It deliberately does not create an
-- XertOS booking or mutate XERT's booking/capacity authority. This signed,
-- idempotent action asks XERT to enqueue the current class snapshot so the
-- linked person can appear on the XertOS roll call without waiting for the
-- next daily full-window push.
--
-- The existing class outbox remains the only delivery path. This RPC never
-- changes a class, booking, capacity or attendance row. An active lease is
-- coalesced into a second post-lease push; an already-pending row is reused;
-- recently-sent rows are rate-limited so the caller can retry with backoff.
-- =============================================================================

create or replace function public.xertos_sync_refresh_bookings(
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
  v_settings record;
  v_receipt public.xertos_edit_receipts%rowtype;
  v_session_id uuid;
  v_session public.class_sessions%rowtype;
  v_outbox public.xertos_class_outbox%rowtype;
  v_answer jsonb;
  v_queued boolean := false;
begin
  select enabled, share_bookings into v_settings
    from public.xertos_sync_settings
   where id
   for share;
  if not found or not coalesce(v_settings.enabled, false) then
    raise exception 'SYNC_OFF';
  end if;
  if not coalesce(v_settings.share_bookings, false) then
    raise exception 'BOOKINGS_OFF';
  end if;
  if v_action is distinct from 'refreshBookings'
     or v_request is null
     or char_length(v_request) > 200 then
    raise exception 'INVALID_EDIT';
  end if;
  if v_fingerprint is null
     or char_length(v_fingerprint) > 2048
     or array_length(string_to_array(v_fingerprint, E'\n'), 1) <> 4
     or (string_to_array(v_fingerprint, E'\n'))[1] <> 'xertos-calendar-request-v1'
     or (string_to_array(v_fingerprint, E'\n'))[2] <> 'POST'
     or btrim(coalesce((string_to_array(v_fingerprint, E'\n'))[3], '')) = ''
     or coalesce((string_to_array(v_fingerprint, E'\n'))[4], '') !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST_FINGERPRINT';
  end if;

  -- One receipt per exact authenticated request, serialized across retries.
  perform pg_advisory_xact_lock(hashtextextended('xertos-edit:' || v_request, 0));
  select * into v_receipt
    from public.xertos_edit_receipts
   where request_id = v_request;
  if found then
    if v_receipt.request_fingerprint is null then
      raise exception 'IDEMPOTENCY_RECEIPT_UNVERIFIABLE';
    end if;
    if v_receipt.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_receipt.answer;
  end if;

  begin
    v_session_id := (p_edit ->> 'externalId')::uuid;
  exception when invalid_text_representation then
    raise exception 'SESSION_NOT_FOUND';
  end;
  if v_session_id is null then raise exception 'SESSION_NOT_FOUND'; end if;
  select * into v_session
    from public.class_sessions
   where id = v_session_id
   for share;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;

  -- A per-class lock keeps concurrent match requests from racing the same
  -- outbox row. The class row itself is never updated.
  perform pg_advisory_xact_lock(hashtextextended('xertos-refresh:' || v_session_id::text, 0));
  select * into v_outbox
    from public.xertos_class_outbox
   where session_id = v_session_id
   for update;

  if found and v_outbox.sent_changed_at is distinct from v_outbox.changed_at then
    if v_outbox.lease_id is not null and v_outbox.leased_until > clock_timestamp() then
      -- The current worker already captured a payload. Advance changed_at
      -- without clearing its lease so settle leaves a second send due.
      perform public.xertos_queue_class(v_session_id);
      v_queued := true;
    else
      -- The next claim will read the latest booking snapshot, including this
      -- match. Do not reset an existing retry/backoff schedule.
      v_queued := false;
    end if;
  elsif found and v_outbox.sent_at is not null
        and v_outbox.sent_at > clock_timestamp() - interval '30 seconds' then
    raise exception 'REFRESH_RATE_LIMITED';
  else
    perform public.xertos_queue_class(v_session_id);
    v_queued := true;
  end if;

  v_answer := jsonb_build_object(
    'ok', true,
    'status', case when v_queued then 'queued' else 'already_pending' end,
    'externalId', v_session_id::text
  );
  insert into public.xertos_edit_receipts (
    request_id, action, session_id, answer, request_fingerprint
  ) values (
    v_request, v_action, v_session_id, v_answer, v_fingerprint
  );
  return v_answer;
end;
$$;

revoke all on function public.xertos_sync_refresh_bookings(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.xertos_sync_refresh_bookings(jsonb, text)
  to service_role;
