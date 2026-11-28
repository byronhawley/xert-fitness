-- Whether the signed-in account has an entry on a form that still stands.
--
-- The /pairs page remembered "entered" on the phone, so once someone had
-- entered it showed "You're in" for good -- even after staff archived the
-- entry to let them enter again, which is exactly what happened to Byron's
-- test entry. The page now asks this instead, and only falls back to the
-- phone's memory if the question cannot be answered.
--
-- It answers yes or no about the caller's own account and nothing else: no
-- entry, no answers, nobody else's details.
create or replace function public.xert_my_form_entry_exists(p_slug text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select auth.uid() is not null and exists (
    select 1
      from public.xert_form_responses r
      join public.xert_forms f on f.id = r.form_id
     where f.slug = p_slug
       and f.archived_at is null
       and r.archived_at is null
       and (
         r.created_by = auth.uid()
         or lower(btrim(r.respondent_email)) = (
           select lower(btrim(u.email)) from auth.users u where u.id = auth.uid()
         )
       )
  );
$$;

revoke all on function public.xert_my_form_entry_exists(text) from public, anon;
grant execute on function public.xert_my_form_entry_exists(text) to authenticated;
