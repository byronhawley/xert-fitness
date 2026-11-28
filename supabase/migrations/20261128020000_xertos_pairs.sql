-- The Pairs competition, reachable from XertOS.
--
-- Byron wants to run Pairs from the XertOS app too, and members to enter
-- there. XertOS already receives every form response here once, through the
-- forms sync, but only once: an entry archived here afterwards would still
-- show in XertOS, and a form with no entries yet never reaches it at all. So
-- XertOS reads the Pairs form and its entries live, and writes entries and
-- removals back, through these -- called only by this site's signed XertOS
-- webhook with the service key (src/lib/xertosPairs.js).
--
-- They work on a form tagged 'pairs' and nothing else, so the XertOS channel
-- cannot be used to read or write any other form. An entry from XertOS goes
-- through submit_xert_form_response_v2 like one from /pairs: the same
-- required questions, options, one entry per email, and the form switched on.

create or replace function public.xertos_pairs_form(p_slug text)
returns public.xert_forms
language sql
stable
security definer
set search_path to ''
as $$
  select f.* from public.xert_forms f
   where f.slug = p_slug and f.archived_at is null and f.tags @> '["pairs"]'::jsonb
   limit 1;
$$;

-- The live form and every entry on it, archived ones marked.
create or replace function public.xertos_pairs_board(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_form public.xert_forms;
begin
  v_form := public.xertos_pairs_form(p_slug);
  if v_form.id is null then raise exception 'PAIRS_FORM_NOT_FOUND'; end if;
  return jsonb_build_object(
    'form', jsonb_build_object(
      'id', v_form.id, 'slug', v_form.slug, 'title', v_form.title, 'description', v_form.description,
      'isActive', v_form.is_active, 'updatedAt', v_form.updated_at, 'questions', v_form.questions),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'answers', r.answers, 'name', r.respondent_name, 'email', r.respondent_email,
        'phone', r.respondent_phone, 'enteredAt', coalesce(r.completed_at, r.created_at),
        'archivedAt', r.archived_at) order by r.created_at, r.id)
        from public.xert_form_responses r where r.form_id = v_form.id
    ), '[]'::jsonb));
end;
$$;

-- An entry made in XertOS. The entrant must have exactly one XERT account
-- with that email -- the same rule XertOS bookings follow -- and the entry is
-- recorded as theirs, so /pairs shows them as entered too.
create or replace function public.xertos_pairs_enter(
  p_slug text, p_email text, p_name text, p_phone text, p_answers jsonb
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_form public.xert_forms;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_matches integer;
  v_profile uuid;
begin
  v_form := public.xertos_pairs_form(p_slug);
  if v_form.id is null then raise exception 'PAIRS_FORM_NOT_FOUND'; end if;
  select count(*), min(p.id::text)::uuid into v_matches, v_profile
    from public.profiles p where lower(btrim(p.email)) = v_email;
  if v_matches = 0 then raise exception 'NO_XERT_ACCOUNT'; end if;
  if v_matches > 1 then raise exception 'XERT_ACCOUNT_AMBIGUOUS'; end if;
  -- Entered as that member, so the entry is recorded against their account.
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', v_profile, 'role', 'authenticated')::text, true);
  return public.submit_xert_form_response_v2(
    v_form.slug, coalesce(p_answers, '{}'::jsonb), v_form.updated_at,
    nullif(btrim(coalesce(p_name, '')), ''), v_email, nullif(btrim(coalesce(p_phone, '')), ''),
    0, 'xertos');
end;
$$;

-- Remove an entry (archive it, never delete) or restore one, from XertOS --
-- the same as Remove entry on the admin board. Restoring is refused while the
-- same email has another entry in, so one entry per email still holds.
create or replace function public.xertos_pairs_set_archived(p_slug text, p_response_id uuid, p_archived boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_form public.xert_forms;
  v_row public.xert_form_responses;
begin
  v_form := public.xertos_pairs_form(p_slug);
  if v_form.id is null then raise exception 'PAIRS_FORM_NOT_FOUND'; end if;
  select * into v_row from public.xert_form_responses
   where id = p_response_id and form_id = v_form.id for update;
  if v_row.id is null then raise exception 'PAIRS_ENTRY_NOT_FOUND'; end if;
  if not coalesce(p_archived, true) and v_row.archived_at is not null and v_form.one_response_per_email and exists (
    select 1 from public.xert_form_responses r
     where r.form_id = v_form.id and r.id <> v_row.id and r.archived_at is null
       and lower(r.respondent_email) = lower(v_row.respondent_email)
  ) then
    raise exception 'ALREADY_ENTERED';
  end if;
  if coalesce(p_archived, true) is distinct from (v_row.archived_at is not null) then
    update public.xert_form_responses
       set archived_at = case when p_archived then now() else null end,
           archived_by = null
     where id = v_row.id
    returning * into v_row;
    update public.xert_forms f set response_count = (
      select count(*)::integer from public.xert_form_responses r
       where r.form_id = f.id and r.archived_at is null
    ) where f.id = v_form.id;
  end if;
  return jsonb_build_object('id', v_row.id, 'archivedAt', v_row.archived_at);
end;
$$;

revoke all on function public.xertos_pairs_form(text) from public, anon, authenticated;
revoke all on function public.xertos_pairs_board(text) from public, anon, authenticated;
revoke all on function public.xertos_pairs_enter(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.xertos_pairs_set_archived(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.xertos_pairs_board(text) to service_role;
grant execute on function public.xertos_pairs_enter(text, text, text, text, jsonb) to service_role;
grant execute on function public.xertos_pairs_set_archived(text, uuid, boolean) to service_role;
