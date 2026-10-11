-- Sign-ups waiting for a place, seen and released from XertOS.
--
-- A sign-up can wait for a place: the public timetable's "let me know if a
-- place frees up", and since 20261011010000 a XertOS booking for someone
-- with no member account when the class is full. Two gaps followed:
--
--   - The bookings sent with each class listed confirmed sign-ups only, so
--     XertOS told the person they were waiting, then dropped them on the
--     next push while XERT kept them in its queue.
--   - A cancelBooking from XertOS for a waiting sign-up answered 'cancelled'
--     but left the row waiting, so they stayed in XERT's queue.
--
-- Waiting sign-ups are now listed as 'waitlisted' (they still hold no place;
-- class_places_held is unchanged), and cancelBooking takes them off the list.
-- Both functions are replaced whole; nothing else changes.

create or replace function public.xertos_class_bookings(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(item.booking order by item.at, item.id), '[]'::jsonb)
    from (
      select booking.created_at as at, booking.id,
             jsonb_build_object(
               'externalId', 'member:' || booking.id::text,
               'status', case when booking.status = 'waitlisted' then 'waitlisted' else 'confirmed' end,
               'name', left(coalesce(nullif(btrim(profile.full_name), ''), ''), 200),
               'email', nullif(lower(btrim(coalesce(profile.email, ''))), '')
             ) as booking
        from public.session_bookings booking
        left join public.profiles profile on profile.id = booking.user_id
       where booking.class_session_id = p_session_id
         and booking.status in ('requested', 'confirmed', 'waitlisted', 'attended', 'no_show')
      union all
      select signup.created_at, signup.id,
             jsonb_build_object(
               'externalId', 'signup:' || signup.id::text,
               'status', case when signup.status = 'waitlisted' then 'waitlisted' else 'confirmed' end,
               'name', left(coalesce(nullif(btrim(signup.full_name), ''), ''), 200),
               'email', nullif(lower(btrim(coalesce(signup.email, ''))), '')
             )
        from public.class_bookings signup
       where signup.class_session_id = p_session_id
         and signup.status in ('confirmed', 'waitlisted')
    ) item;
$$;

create or replace function public.xertos_sync_apply_booking(
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
  v_id uuid;
  v_email text;
  v_member uuid;
  v_matches integer;
  v_booking_id uuid;
  v_booking_status text;
  v_booking_ref text;
  v_kind text;
  v_ref uuid;
  v_status text;
  v_batch uuid;
  v_held integer;
  v_waiting boolean;
  v_answer jsonb;
  v_name text;
  v_phone text;
begin
  if not coalesce((select enabled from public.xertos_sync_settings where id), false) then
    raise exception 'SYNC_OFF';
  end if;
  if not coalesce((select share_bookings from public.xertos_sync_settings where id), false) then
    raise exception 'BOOKINGS_OFF';
  end if;
  if v_action is null or v_action not in ('book', 'cancelBooking') then raise exception 'INVALID_EDIT'; end if;
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

  perform pg_advisory_xact_lock(hashtextextended('xertos-edit:' || v_request, 0));
  select * into v_receipt from public.xertos_edit_receipts where request_id = v_request;
  if found then
    if v_receipt.request_fingerprint is null then raise exception 'IDEMPOTENCY_RECEIPT_UNVERIFIABLE'; end if;
    if v_receipt.request_fingerprint <> v_fingerprint then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    return v_receipt.answer;
  end if;

  begin
    v_id := (p_edit ->> 'externalId')::uuid;
  exception when invalid_text_representation then
    raise exception 'SESSION_NOT_FOUND';
  end;
  select * into v_session from public.class_sessions where id = v_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;

  if v_action = 'book' then
    v_email := lower(btrim(coalesce(p_edit -> 'member' ->> 'email', '')));
    if v_email = '' then raise exception 'INVALID_EDIT'; end if;
    select count(*), min(profile.id::text)::uuid into v_matches, v_member
      from public.profiles profile
     where lower(btrim(coalesce(profile.email, ''))) = v_email
       and profile.role = 'member';
    if v_matches > 1 then raise exception 'SITE_ACCOUNT_AMBIGUOUS'; end if;
  end if;

  -- No member account on that email (staff, owners, casual visitors, people
  -- who never signed up here): book them the way the public timetable does,
  -- as a sign-up by name, email and phone. XertOS cancels it as 'signup:'.
  if v_action = 'book' and v_matches = 0 then
    v_name := left(btrim(coalesce(p_edit -> 'member' ->> 'name', '')), 100);
    if char_length(v_name) < 2 then raise exception 'INVALID_EDIT'; end if;
    v_phone := nullif(btrim(coalesce(p_edit -> 'member' ->> 'phone', '')), '');
    if v_phone is not null
       and (char_length(v_phone) not between 6 and 32 or v_phone !~ '^\+?[0-9 ()-]+$') then
      v_phone := null;
    end if;

    -- The same checks the front desk makes before it books a member.
    if v_session.status not in ('published', 'full') then raise exception 'SESSION_NOT_BOOKABLE'; end if;
    if coalesce(v_session.end_time, v_session.start_time + interval '3 hours') <= now() then
      raise exception 'SESSION_FINISHED';
    end if;
    if coalesce(v_session.booking_mode, 'instant_book') = 'interest_only' then
      raise exception 'SESSION_INTEREST_ONLY';
    end if;
    if v_session.capacity is null or v_session.capacity < 1 then raise exception 'CLASS_CAPACITY_INVALID'; end if;

    -- Already signed up for this class: that sign-up is the answer.
    select signup.id, signup.status into v_booking_id, v_booking_status
      from public.class_bookings signup
     where signup.class_session_id = v_id
       and lower(btrim(coalesce(signup.email, ''))) = v_email
       and signup.status in ('requested', 'confirmed', 'waitlisted', 'attended', 'no_show')
     order by signup.created_at desc
     limit 1;
    if v_booking_id is null then
      select places.held, places.waiting > 0 into v_held, v_waiting
        from public.class_places_held(v_id) as places;
      if v_session.status = 'full' or v_held >= v_session.capacity or v_waiting then
        if p_edit ->> 'waitlistIfFull' = 'false' then raise exception 'CLASS_FULL'; end if;
        v_booking_status := 'waitlisted';
      else
        v_booking_status := 'confirmed';
      end if;
      insert into public.class_bookings (class_session_id, full_name, email, phone, status)
      values (v_id, v_name, v_email, v_phone, v_booking_status)
      returning id into v_booking_id;
    end if;
    v_booking_ref := 'signup:' || v_booking_id::text;
    v_booking_status := case when v_booking_status = 'waitlisted' then 'waitlisted' else 'confirmed' end;

  elsif v_action = 'book' then
    -- Already on the class: that booking is the answer.
    select booking.id, booking.status into v_booking_id, v_booking_status
      from public.session_bookings booking
     where booking.user_id = v_member
       and booking.class_session_id = v_id
       and booking.status in ('requested', 'confirmed', 'waitlisted', 'attended', 'no_show')
     order by booking.created_at desc
     limit 1;
    if v_booking_id is null then
      -- Asked not to be waitlisted: say the class is full rather than queue them.
      if p_edit ->> 'waitlistIfFull' = 'false' then
        select places.held, places.waiting > 0 into v_held, v_waiting
          from public.class_places_held(v_id) as places;
        if v_session.status = 'full' or v_held >= coalesce(v_session.capacity, 0) or v_waiting then
          raise exception 'CLASS_FULL';
        end if;
      end if;
      select core.booking_id, core.booking_status into v_booking_id, v_booking_status
        from public.staff_book_member_core(v_id, v_member, md5('xertos:' || v_request)::uuid, null) core;
    end if;
    v_booking_ref := 'member:' || v_booking_id::text;
    v_booking_status := case when v_booking_status = 'waitlisted' then 'waitlisted' else 'confirmed' end;

  else
    v_booking_ref := coalesce(p_edit ->> 'bookingExternalId', '');
    v_kind := split_part(v_booking_ref, ':', 1);
    begin
      v_ref := nullif(split_part(v_booking_ref, ':', 2), '')::uuid;
    exception when invalid_text_representation then
      raise exception 'BOOKING_NOT_FOUND';
    end;
    if v_ref is null or v_kind not in ('member', 'signup') then raise exception 'BOOKING_NOT_FOUND'; end if;

    if v_kind = 'member' then
      select booking.status, booking.credit_batch_id into v_status, v_batch
        from public.session_bookings booking
       where booking.id = v_ref and booking.class_session_id = v_id
       for update;
      if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
      if v_status in ('requested', 'confirmed', 'waitlisted') then
        update public.session_bookings
           set status = 'cancelled', cancelled_at = now()
         where id = v_ref;
        -- A legacy booking that still holds a credit gives it back, as the
        -- front desk's cancel does; a member's own late cancel keeps it.
        if v_status in ('requested', 'confirmed') and v_batch is not null
           and (p_edit ->> 'by' is distinct from 'member'
                or v_status = 'requested'
                or v_session.start_time - now() > interval '12 hours') then
          update public.credit_batches
             set remaining = least(total, remaining + 1)
           where id = v_batch and remaining < total;
        end if;
      elsif v_status not in ('cancelled', 'declined') then
        raise exception 'NOT_CANCELLABLE';
      end if;
    else
      select signup.status into v_status
        from public.class_bookings signup
       where signup.id = v_ref and signup.class_session_id = v_id
       for update;
      if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
      if v_status in ('requested', 'confirmed', 'waitlisted') then
        update public.class_bookings set status = 'cancelled' where id = v_ref;
      end if;
    end if;
    v_booking_status := 'cancelled';
  end if;

  v_answer := jsonb_build_object(
    'class', public.xertos_class_payload(v_id),
    'booking', jsonb_build_object('externalId', v_booking_ref, 'status', v_booking_status)
  );
  insert into public.xertos_edit_receipts (request_id, action, session_id, answer, request_fingerprint)
  values (v_request, v_action, v_id, v_answer, v_fingerprint);
  return v_answer;
end;
$$;

revoke all on function public.xertos_sync_apply_booking(jsonb, text) from public, anon, authenticated;
grant execute on function public.xertos_sync_apply_booking(jsonb, text) to service_role;

revoke all on function public.xertos_class_bookings(uuid) from public, anon, authenticated;
