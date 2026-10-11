-- =============================================================================
-- XertOS two-way bookings: class bookings shared with XertOS, both ways.
--
-- XERT Fitness stays in charge of its classes and bookings (owner decision,
-- 10 Oct 2026: calendar and bookings two-way for XERT only, because members
-- book here). With this on:
--
--   - Every class sent to XertOS carries its bookings: everyone holding or
--     waiting for a place, with their name and email so XertOS can match them
--     to its members (only on a unique email; it never creates or merges
--     anyone). The booking triggers from 20261004010000 already queue a class
--     when one of its bookings changes, so nothing new is queued here.
--   - XertOS sends a booking, a cancellation or a waitlist exit made there to
--     the same signed endpoint as class edits (actions `book` and
--     `cancelBooking`). They are applied by xertos_sync_apply_booking through
--     the same rules the front desk uses, and answered with the class as it
--     now stands.
--
-- Off until xertos_sync_settings.share_bookings is turned on in the SQL
-- editor, after XertOS has migration 0040. While off, classes are sent exactly
-- as before and XertOS's booking requests are refused.
--
-- admin_book_member_into_class is split into an admin check and a core that
-- both the front desk and XertOS use. The core body is copied unchanged from
-- 20260908020000_bookings_without_credits.sql, with auth.uid() passed in as
-- p_actor (null for XertOS).
-- =============================================================================

alter table public.xertos_sync_settings
  add column if not exists share_bookings boolean not null default false;

-- ── 1. The bookings XertOS reads with each class ───────────────────────────

-- Member bookings holding or waiting for a place, and confirmed public
-- sign-ups (the same places class_places_held counts). Ids are prefixed by
-- kind so a booking and a sign-up never collide.
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
               'status', 'confirmed',
               'name', left(coalesce(nullif(btrim(signup.full_name), ''), ''), 200),
               'email', nullif(lower(btrim(coalesce(signup.email, ''))), '')
             )
        from public.class_bookings signup
       where signup.class_session_id = p_session_id
         and signup.status = 'confirmed'
    ) item;
$$;

-- Unchanged from 20261004010000 apart from the bookings at the end.
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
  ) || case
    when not p_removed
     and coalesce((select share_bookings from public.xertos_sync_settings where id), false)
    then jsonb_build_object(
      'bookings', public.xertos_class_bookings(p_session.id),
      -- When this list was read: XertOS never lets an older list overwrite a newer one.
      'bookingsAsOf', public.xertos_iso(clock_timestamp())
    )
    else '{}'::jsonb
  end;
$$;

-- ── 2. One copy of the front desk's booking rules ──────────────────────────

create or replace function public.staff_book_member_core(
  p_session_id uuid, p_member_id uuid, p_request_id uuid, p_actor uuid
)
returns table(
  request_id uuid, booking_id uuid, session_id uuid, member_id uuid,
  booking_status text, credit_batch_id uuid, announcement_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_receipt public.admin_staff_booking_receipts%rowtype;
  v_capacity integer;
  v_start timestamptz;
  v_end timestamptz;
  v_session_status text;
  v_booking_mode text;
  v_title text;
  v_location text;
  v_active_count integer;
  v_has_waitlist boolean;
  v_booking_status text;
  v_booking_id uuid;
  v_announcement_id uuid := gen_random_uuid();
  v_when text;
  v_notice_body text;
begin
  if p_session_id is null or p_member_id is null or p_request_id is null then
    raise exception 'STAFF_BOOKING_REQUEST_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  select receipt.* into v_receipt
    from public.admin_staff_booking_receipts receipt
   where receipt.request_id = p_request_id;
  if found then
    if v_receipt.session_id is distinct from p_session_id
       or v_receipt.member_id is distinct from p_member_id then
      raise exception 'STAFF_BOOKING_REQUEST_CONFLICT';
    end if;
    return query
    select receipt.request_id, receipt.booking_id, receipt.session_id,
      receipt.member_id, receipt.booking_status, receipt.credit_batch_id,
      receipt.announcement_id, receipt.created_at
      from public.admin_staff_booking_receipts receipt
     where receipt.request_id = p_request_id;
    return;
  end if;

  select session.capacity, session.start_time, session.end_time, session.status,
         coalesce(session.booking_mode, 'instant_book'), session.title,
         session.location_zone
    into v_capacity, v_start, v_end, v_session_status, v_booking_mode, v_title,
         v_location
    from public.class_sessions session
   where session.id = p_session_id
   for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session_status not in ('published', 'full') then
    raise exception 'SESSION_NOT_BOOKABLE';
  end if;
  if coalesce(v_end, v_start + interval '3 hours') <= now() then
    raise exception 'SESSION_FINISHED';
  end if;
  if v_booking_mode = 'interest_only' then
    raise exception 'SESSION_INTEREST_ONLY';
  end if;
  if v_capacity is null or v_capacity < 1 then
    raise exception 'CLASS_CAPACITY_INVALID';
  end if;

  perform 1 from public.profiles profile
   where profile.id = p_member_id
     and profile.role = 'member'
   for share;
  if not found then raise exception 'MEMBER_NOT_BOOKABLE'; end if;

  if exists (
    select 1 from public.session_bookings booking
     where booking.user_id = p_member_id
       and booking.class_session_id = p_session_id
       and booking.status in ('requested', 'confirmed', 'waitlisted', 'attended', 'no_show')
  ) then
    raise exception 'MEMBER_ALREADY_ON_ROSTER';
  end if;

  -- Counts confirmed public sign-ups as well as member bookings, so the front
  -- desk waitlists rather than overselling a class the public already filled.
  select places.held, places.waiting > 0
    into v_active_count, v_has_waitlist
    from public.class_places_held(p_session_id) as places;

  -- Capacity alone decides the place. Credits are retired, so nothing is
  -- reserved and nobody is refused for holding none.
  if v_session_status = 'full'
     or v_active_count >= v_capacity
     or v_has_waitlist then
    v_booking_status := 'waitlisted';
  else
    v_booking_status := 'confirmed';
  end if;

  insert into public.session_bookings (
    user_id, class_session_id, credit_batch_id, status
  ) values (
    p_member_id, p_session_id, null, v_booking_status
  )
  returning id into v_booking_id;

  v_when := to_char(
    v_start at time zone 'Australia/Brisbane',
    'Dy DD Mon, FMHH12:MI AM'
  );
  if v_booking_status = 'confirmed' then
    v_notice_body := format(
      'XERT has booked you into %s on %s%s. Your place is held.',
      coalesce(nullif(btrim(v_title), ''), 'your class'),
      v_when,
      case when nullif(btrim(v_location), '') is null
        then '' else ' at ' || btrim(v_location) end
    );
  else
    v_notice_body := format(
      'XERT has added you to the FIFO waitlist for %s on %s%s. XERT will let you know as soon as a place opens up.',
      coalesce(nullif(btrim(v_title), ''), 'your class'),
      v_when,
      case when nullif(btrim(v_location), '') is null
        then '' else ' at ' || btrim(v_location) end
    );
  end if;

  insert into public.member_announcements (
    id, title, body, tone, cta_label, cta_url, audience, source_kind, source_id,
    published_at, expires_at, created_by, last_changed_by
  ) values (
    v_announcement_id,
    case when v_booking_status = 'confirmed'
      then 'XERT booked your class'
      else 'XERT added you to a waitlist'
    end,
    v_notice_body,
    'info',
    'View bookings',
    '/account',
    'targeted',
    'staff_booking',
    v_booking_id,
    now(),
    least(
      greatest(now() + interval '30 days', v_start + interval '1 day'),
      now() + interval '1 year'
    ),
    p_actor,
    p_actor
  );

  insert into public.member_announcement_targets (announcement_id, user_id)
  values (v_announcement_id, p_member_id);

  insert into public.admin_staff_booking_receipts (
    request_id, booking_id, session_id, member_id, booking_status,
    credit_batch_id, announcement_id, created_by
  ) values (
    p_request_id, v_booking_id, p_session_id, p_member_id, v_booking_status,
    null, v_announcement_id, p_actor
  );

  return query
  select receipt.request_id, receipt.booking_id, receipt.session_id,
    receipt.member_id, receipt.booking_status, receipt.credit_batch_id,
    receipt.announcement_id, receipt.created_at
    from public.admin_staff_booking_receipts receipt
   where receipt.request_id = p_request_id;
end;
$function$;
create or replace function public.admin_book_member_into_class(
  p_session_id uuid, p_member_id uuid, p_request_id uuid
)
returns table(
  request_id uuid, booking_id uuid, session_id uuid, member_id uuid,
  booking_status text, credit_batch_id uuid, announcement_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
  return query
  select * from public.staff_book_member_core(p_session_id, p_member_id, p_request_id, auth.uid());
end;
$function$;

-- ── 3. Bookings sent from XertOS ───────────────────────────────────────────

-- Applies one `book` or `cancelBooking` from XertOS, once per request id (the
-- receipt and fingerprint rules of 20261009010000), and answers with the class
-- as it now stands and the booking the request was about.
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
    if v_matches = 0 then raise exception 'NO_SITE_ACCOUNT'; end if;
    if v_matches > 1 then raise exception 'SITE_ACCOUNT_AMBIGUOUS'; end if;

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
      if v_status in ('requested', 'confirmed') then
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

-- ── 4. Who may call what ───────────────────────────────────────────────────

revoke all on function public.xertos_class_bookings(uuid) from public, anon, authenticated;
revoke all on function public.staff_book_member_core(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.xertos_sync_apply_booking(jsonb, text) from public, anon, authenticated;
grant execute on function public.xertos_sync_apply_booking(jsonb, text) to service_role;
