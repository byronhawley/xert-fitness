-- Bring-a-friend is the last Saturday of the month, and only then.
--
-- The sign-up form offered "I am a guest of a member (bring a friend)" on
-- every class, so a non-member could tick it on any day and hold a place with
-- nothing to pay. The form now shows the box only on bring-a-friend day; this
-- makes the database agree, so a guest sign-up for any other day is refused
-- whatever sent it -- including a phone still running an old copy of the site.
--
-- A check on the sign-ups table rather than another rewrite of
-- submit_class_signup: it holds however that function is changed, and for any
-- other way a sign-up is written. It applies to new guest sign-ups and to a
-- sign-up being marked as a guest. Guests already booked are left alone.

-- The last Saturday on the gym's calendar: a Saturday whose next Saturday is
-- in the following month. Matches isBringAFriendDay in src/lib/gymTime.js.
create or replace function public.xert_is_bring_a_friend_day(p_at timestamptz)
returns boolean
language sql
immutable
set search_path to ''
as $$
  select p_at is not null
    and extract(isodow from (p_at at time zone 'Australia/Brisbane')::date) = 6
    and extract(month from (p_at at time zone 'Australia/Brisbane')::date + 7)
        <> extract(month from (p_at at time zone 'Australia/Brisbane')::date);
$$;

create or replace function public.guard_guest_visit_day()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_start timestamptz;
begin
  if not coalesce(new.guest_visit, false) then return new; end if;
  -- An update that leaves an existing guest as a guest is not a new claim.
  if tg_op = 'UPDATE' and coalesce(old.guest_visit, false)
     and new.class_session_id is not distinct from old.class_session_id then
    return new;
  end if;
  select s.start_time into v_start from public.class_sessions s where s.id = new.class_session_id;
  if not public.xert_is_bring_a_friend_day(v_start) then
    raise exception 'GUEST_VISIT_NOT_AVAILABLE'
      using hint = 'Bring-a-friend is only on the last Saturday of the month.';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_guest_visit_day() from public, anon, authenticated;

drop trigger if exists class_bookings_guest_visit_day on public.class_bookings;
create trigger class_bookings_guest_visit_day
  before insert or update of guest_visit, class_session_id on public.class_bookings
  for each row execute function public.guard_guest_visit_day();

do $$
begin
  if not public.xert_is_bring_a_friend_day('2026-11-28 08:00+10'::timestamptz)
     or public.xert_is_bring_a_friend_day('2026-11-21 08:00+10'::timestamptz)
     or not public.xert_is_bring_a_friend_day('2026-11-27 22:30+00'::timestamptz)
     or public.xert_is_bring_a_friend_day('2026-11-27 08:00+10'::timestamptz) then
    raise exception 'bring-a-friend day rule is wrong';
  end if;
end;
$$;
