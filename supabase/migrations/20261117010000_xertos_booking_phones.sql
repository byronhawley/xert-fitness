-- XertOS: one member list with XERT Fitness (owner, 17 Nov 2026).
--
-- XertOS now puts every booking XERT Fitness sends on a XertOS person, so
-- the coach's roll call shows website bookers like anyone else. It matches
-- by email first; a member whose XERT email differs from the one XertOS has
-- (a new address, a work one) is found by mobile instead, where the name
-- also agrees. So each booking now carries the booker's mobile as well.
--
-- Only xertos_class_bookings changes (replaced whole, as in
-- 20261012010000): the same rows, the same order, one more field. XertOS
-- before this change ignores the field.

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
               'email', nullif(lower(btrim(coalesce(profile.email, ''))), ''),
               'phone', nullif(left(btrim(coalesce(profile.phone, '')), 40), '')
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
               'email', nullif(lower(btrim(coalesce(signup.email, ''))), ''),
               'phone', nullif(left(btrim(coalesce(signup.phone, '')), 40), '')
             )
        from public.class_bookings signup
       where signup.class_session_id = p_session_id
         and signup.status in ('confirmed', 'waitlisted')
    ) item;
$$;

revoke all on function public.xertos_class_bookings(uuid) from public, anon, authenticated;
