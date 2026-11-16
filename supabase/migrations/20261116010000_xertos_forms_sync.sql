-- Forms signed here go to XertOS by themselves.
--
-- XertOS was given a copy of every form response once, by hand, on
-- 10 October. Nothing kept sending, so a PEQ or the terms signed on this site
-- afterwards never reached XertOS, and its "who still owes a form" list
-- drifted. From here on the class sync's dispatcher (the same minute job)
-- also sends every response XertOS hasn't confirmed:
--
--   - xertos_form_sent records each response XertOS has answered for. A
--     response with no row there is still to send, so a new one goes within
--     a minute and anything missed heals itself: there is no separate sweep
--     to keep in step.
--   - xertos_forms_claim() hands the dispatcher the oldest unsent responses
--     with the forms they answer, in the shape XertOS reads
--     (POST /v1/connected-sites/{provider}/forms/sync).
--   - xertos_forms_settle() records what XertOS said. A failed push waits
--     five minutes before the next try, so an outage isn't hammered.
--   - xertos_sync_due() now also says yes when a form is waiting, which is
--     what makes the existing minute job call the dispatcher.
--
-- XertOS writes a response once only (by its id here), so sending one twice
-- is harmless. Nothing here changes a form or a response.

create table if not exists public.xertos_form_sent (
  response_id uuid primary key references public.xert_form_responses(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  outcome     text not null default 'imported'
);
alter table public.xertos_form_sent enable row level security;
revoke all on table public.xertos_form_sent from anon, authenticated;
grant select, insert, update, delete on table public.xertos_form_sent to service_role;

alter table public.xertos_sync_settings
  add column if not exists forms_next_attempt_at timestamptz,
  add column if not exists forms_last_error text,
  add column if not exists forms_last_sent_at timestamptz;

create or replace function public.xertos_forms_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select enabled from public.xertos_sync_settings where id), false)
     and coalesce((select forms_next_attempt_at from public.xertos_sync_settings where id), now()) <= now()
     and exists (
       select 1 from public.xert_form_responses r
        where not exists (select 1 from public.xertos_form_sent s where s.response_id = r.id)
     );
$$;

-- The oldest unsent responses and the forms they answer.
create or replace function public.xertos_forms_claim(p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select r.*
      from public.xert_form_responses r
     where coalesce((select enabled from public.xertos_sync_settings where id), false)
       and not exists (select 1 from public.xertos_form_sent s where s.response_id = r.id)
     order by r.created_at, r.id
     limit greatest(1, least(coalesce(p_limit, 10), 25))
  )
  select jsonb_build_object(
    'forms', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.created_at)
        from public.xert_forms f
       where f.id in (select form_id from due)
    ), '[]'::jsonb),
    'responses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'form_id', d.form_id, 'answers', d.answers,
        'respondent_name', d.respondent_name, 'respondent_email', d.respondent_email,
        'respondent_phone', d.respondent_phone, 'status', d.status,
        'completed_at', d.completed_at, 'created_at', d.created_at,
        'time_taken_seconds', d.time_taken_seconds, 'archived_at', d.archived_at,
        'form_snapshot', d.form_snapshot
      ) order by d.created_at, d.id)
        from due d
    ), '[]'::jsonb)
  );
$$;

-- What XertOS said about a push. p_results is its answer's `results` list
-- ([{ id, outcome }]); on a failure p_error says why and the next try waits.
create or replace function public.xertos_forms_settle(p_ok boolean, p_results jsonb default '[]'::jsonb, p_error text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_ok then
    insert into public.xertos_form_sent (response_id, outcome)
    select (item->>'id')::uuid, left(coalesce(item->>'outcome', 'imported'), 60)
      from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) item
     where (item->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.xert_form_responses r where r.id = (item->>'id')::uuid)
    on conflict (response_id) do nothing;
    get diagnostics v_count = row_count;
    update public.xertos_sync_settings
       set forms_next_attempt_at = null, forms_last_error = null, forms_last_sent_at = now()
     where id;
  else
    update public.xertos_sync_settings
       set forms_next_attempt_at = now() + interval '5 minutes',
           forms_last_error = left(coalesce(p_error, 'unknown'), 300)
     where id;
  end if;
  return v_count;
end;
$$;

create or replace function public.xertos_sync_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select enabled from public.xertos_sync_settings where id), false)
     and (
       exists (
         select 1 from public.xertos_class_outbox
          where sent_changed_at is distinct from changed_at
            and next_attempt_at <= now()
            and (leased_until is null or leased_until < now())
       )
       or public.xertos_sync_window_due()
       or public.xertos_forms_due()
     );
$$;

do $grants$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.xertos_forms_due()',
    'public.xertos_forms_claim(integer)',
    'public.xertos_forms_settle(boolean, jsonb, text)',
    'public.xertos_sync_due()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$grants$;
