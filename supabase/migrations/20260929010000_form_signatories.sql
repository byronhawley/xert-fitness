-- Byron Hawley signs every copy of the independent contractor agreement for
-- XERT Fitness, and the form builder can put his signature on any form.
--
-- A signature field can now be signed in advance: `"signed_by": "<key>"` on
-- the question names somebody in xert_form_signatories. The person filling the
-- form in is shown it already signed and is not asked for it; on submission
-- this function writes the signatory's own signature into the response, as the
-- answer to that field. It is then an ordinary stored signature, which is what
-- makes it reach every copy with nothing else changed: the admin record, the
-- printed record, the iOS record, the PDF and the emailed copy all render the
-- signatures a response holds.
--
-- Responses already submitted are locked (xert_preserve_form_response_record),
-- so agreements signed before this keep exactly what they had.

create table if not exists public.xert_form_signatories (
  key text primary key
    check (char_length(key) between 1 and 64 and key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  role text not null default '' check (char_length(role) <= 160),
  signature text not null
    check (signature like 'data:image/png;base64,%' and public.xert_valid_form_signature(signature)),
  updated_at timestamptz not null default now()
);

comment on table public.xert_form_signatories is
  'People who sign forms in advance for XERT Fitness. Read only by submit_xert_form_response_v2, which writes the signature into each response.';

-- Nobody reads or changes this from the browser. The form shows the same
-- picture from the site's own assets; only the submit function reads the row.
alter table public.xert_form_signatories enable row level security;
revoke all on public.xert_form_signatories from public, anon, authenticated;

insert into public.xert_form_signatories (key, name, role, signature)
values (
  'byron-hawley', 'Byron Hawley', 'Owner, XERT Fitness',
  'data:image/png;base64,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'
    || 'I='
)
on conflict (key) do update
  set name = excluded.name, role = excluded.role, signature = excluded.signature, updated_at = now();

-- The submit function below is the live definition with four changes: a
-- sign-off must name somebody on record, nobody may answer one, it is never
-- required of them, and it is written in from the record before the insert.

CREATE OR REPLACE FUNCTION public.submit_xert_form_response_v2(p_slug text, p_answers jsonb, p_form_updated_at timestamp with time zone, p_respondent_name text DEFAULT NULL::text, p_respondent_email text DEFAULT NULL::text, p_respondent_phone text DEFAULT NULL::text, p_time_taken_seconds integer DEFAULT 0, p_source_url text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_form public.xert_forms%rowtype;
  v_id uuid;
  v_email text := nullif(lower(btrim(coalesce(p_respondent_email, ''))), '');
  v_question jsonb;
  v_question_id text;
  v_question_type text;
  v_question_position integer;
  v_question_count integer;
  v_known_ids text[] := array[]::text[];
  v_skipped_ids text[] := array[]::text[];
  v_answer_key text;
  v_answer jsonb;
  v_answer_text text;
  v_answer_number numeric;
  v_skip_rule jsonb;
  v_skip_target_text text;
  v_skip_target_number numeric;
  v_skip_target integer;
  v_skip_step integer;
  v_options jsonb;
  v_allow_other boolean;
  v_scale_min_text text;
  v_scale_max_text text;
  v_scale_min integer;
  v_scale_max integer;
begin
  select * into v_form
  from public.xert_forms
  where slug = lower(btrim(p_slug)) and is_active = true and archived_at is null
  for update;

  if not found then
    raise exception 'This form is not available.' using errcode = 'P0002';
  end if;
  if p_form_updated_at is null or v_form.updated_at is distinct from p_form_updated_at then
    raise exception 'This form changed while you were completing it. Refresh and review the latest wording before submitting.'
      using errcode = '40001';
  end if;
  if jsonb_typeof(p_answers) is distinct from 'object'
    or jsonb_array_length(jsonb_path_query_array(p_answers, '$.*')) > 100
    or octet_length(p_answers::text) > 524288 then
    raise exception 'The submitted answers are invalid.' using errcode = '22023';
  end if;
  if v_form.collect_name_required and nullif(btrim(coalesce(p_respondent_name, '')), '') is null then
    raise exception 'Name is required.' using errcode = '22023';
  end if;
  if v_form.collect_email_required and v_email is null then
    raise exception 'Email is required.' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if v_form.collect_phone_required and nullif(btrim(coalesce(p_respondent_phone, '')), '') is null then
    raise exception 'Phone is required.' using errcode = '22023';
  end if;

  v_question_count := jsonb_array_length(v_form.questions);

  -- Fail closed on a malformed published definition. Besides protecting the
  -- validator, unique stable IDs are essential to the immutable response
  -- snapshot: duplicate or missing IDs could relabel a historical answer.
  for v_question, v_question_position in
    select item.value, item.ordinality::integer
    from jsonb_array_elements(v_form.questions) with ordinality as item(value, ordinality)
  loop
    if jsonb_typeof(v_question) is distinct from 'object' then
      raise exception 'This form is not configured correctly.' using errcode = '22023';
    end if;

    v_question_id := btrim(coalesce(v_question ->> 'id', ''));
    v_question_type := coalesce(v_question ->> 'type', '');
    if char_length(v_question_id) not between 1 and 128
      or v_question_id = any(v_known_ids) then
      raise exception 'This form is not configured correctly.' using errcode = '22023';
    end if;
    v_known_ids := array_append(v_known_ids, v_question_id);

    if v_question_type not in (
      'short_text', 'long_text', 'number', 'email', 'phone', 'url',
      'single_choice', 'multiple_choice', 'dropdown', 'yes_no',
      'star_rating', 'linear_scale', 'nps', 'date', 'time', 'datetime',
      'file_upload', 'signature', 'address', 'name_fields',
      'section_break', 'statement'
    ) then
      raise exception 'This form is not configured correctly.' using errcode = '22023';
    end if;
    if (v_question ? 'hidden' and jsonb_typeof(v_question -> 'hidden') is distinct from 'boolean')
      or (v_question ? 'required' and jsonb_typeof(v_question -> 'required') is distinct from 'boolean')
      or (v_question ? 'allow_other' and jsonb_typeof(v_question -> 'allow_other') is distinct from 'boolean')
      or (v_question ? 'allow_already_provided' and jsonb_typeof(v_question -> 'allow_already_provided') is distinct from 'boolean') then
      raise exception 'This form is not configured correctly.' using errcode = '22023';
    end if;
    -- A signature given in advance must be on a signature field and name
    -- somebody on record to sign it.
    if v_question ? 'signed_by' and jsonb_typeof(v_question -> 'signed_by') <> 'null' and (
      v_question_type <> 'signature'
      or jsonb_typeof(v_question -> 'signed_by') is distinct from 'string'
      or not exists (
        select 1 from public.xert_form_signatories signatory
        where signatory.key = v_question ->> 'signed_by'
      )
    ) then
      raise exception 'This form is not configured correctly.' using errcode = '22023';
    end if;

    if v_question_type in ('single_choice', 'multiple_choice', 'dropdown') then
      v_options := v_question -> 'options';
      if jsonb_typeof(v_options) is distinct from 'array' then
        raise exception 'This form is not configured correctly.' using errcode = '22023';
      end if;
      if jsonb_array_length(v_options) > 100 or exists (
          select 1 from jsonb_array_elements(v_options) as configured(value)
          where jsonb_typeof(configured.value) is distinct from 'string'
            or btrim(configured.value #>> '{}') = ''
        )
        or exists (
          select 1
          from jsonb_array_elements(v_options) as configured(value)
          group by configured.value
          having count(*) > 1
        ) then
        raise exception 'This form is not configured correctly.' using errcode = '22023';
      end if;
    end if;

    if v_question_type in ('single_choice', 'multiple_choice', 'dropdown', 'yes_no')
      and v_question ? 'skip_rules' then
      if jsonb_typeof(v_question -> 'skip_rules') is distinct from 'array' then
        raise exception 'This form is not configured correctly.' using errcode = '22023';
      end if;
      if jsonb_array_length(v_question -> 'skip_rules') > 100 then
        raise exception 'This form is not configured correctly.' using errcode = '22023';
      end if;
    end if;

    if v_question_type = 'linear_scale' then
      v_scale_min_text := btrim(coalesce(v_question ->> 'scale_min', '1'));
      v_scale_max_text := btrim(coalesce(v_question ->> 'scale_max', '10'));
      if v_scale_min_text !~ '^-?[0-9]{1,9}$'
        or v_scale_max_text !~ '^-?[0-9]{1,9}$' then
        raise exception 'This form is not configured correctly.' using errcode = '22023';
      end if;
      v_scale_min := v_scale_min_text::integer;
      v_scale_max := v_scale_max_text::integer;
      if v_scale_min > v_scale_max or v_scale_max - v_scale_min > 100 then
        raise exception 'This form is not configured correctly.' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- Match src/lib/formBranching.js: skip_to is a one-based destination, only
  -- forward jumps are honoured, the destination remains visible, and a jump
  -- past the final item is capped at the end of the complete builder sequence
  -- (including statements and section breaks).
  for v_question, v_question_position in
    select item.value, item.ordinality::integer
    from jsonb_array_elements(v_form.questions) with ordinality as item(value, ordinality)
  loop
    v_question_type := v_question ->> 'type';
    if (v_question ->> 'id') = any(v_skipped_ids) then
      continue;
    end if;
    if v_question_type not in ('single_choice', 'multiple_choice', 'dropdown', 'yes_no') then
      continue;
    end if;

    v_answer := p_answers -> (v_question ->> 'id');
    v_skip_rule := null;
    select rule.value into v_skip_rule
    from jsonb_array_elements(
      case when jsonb_typeof(v_question -> 'skip_rules') = 'array'
        then v_question -> 'skip_rules'
        else '[]'::jsonb
      end
    ) with ordinality as rule(value, ordinality)
    where jsonb_typeof(rule.value) = 'object'
      and jsonb_typeof(rule.value -> 'option') = 'string'
      and case
        when v_question_type = 'multiple_choice' then
          case when jsonb_typeof(v_answer) = 'array' then
            jsonb_array_length(v_answer) = 1
              and jsonb_typeof(v_answer -> 0) = 'string'
              and v_answer ->> 0 = rule.value ->> 'option'
          else false end
        else
          jsonb_typeof(v_answer) = 'string'
            and v_answer #>> '{}' = rule.value ->> 'option'
      end
    order by rule.ordinality
    limit 1;

    v_skip_target_text := btrim(coalesce(v_skip_rule ->> 'skip_to', ''));
    if v_skip_rule is not null and v_skip_target_text ~ '^[0-9]+$'
      and char_length(v_skip_target_text) <= 32 then
      v_skip_target_number := v_skip_target_text::numeric;
      if v_skip_target_number > v_question_position + 1 then
        v_skip_target := least(v_skip_target_number, v_question_count + 1)::integer;
        -- Re-check after capping at the end. For a rule on the final item,
        -- an oversized target caps back to its immediate successor and there
        -- is no intervening range to traverse.
        if v_skip_target >= v_question_position + 2 then
          for v_skip_step in (v_question_position + 1)..(v_skip_target - 1)
          loop
            v_question_id := v_form.questions -> (v_skip_step - 1) ->> 'id';
            if not (v_question_id = any(v_skipped_ids)) then
              v_skipped_ids := array_append(v_skipped_ids, v_question_id);
            end if;
          end loop;
        end if;
      end if;
    end if;
  end loop;

  -- Every supplied key must identify a visible input the respondent actually
  -- saw. Null is accepted as an omitted optional answer; any non-null value is
  -- then validated against the exact JSON representation produced by the app.
  for v_answer_key, v_answer in select key, value from jsonb_each(p_answers)
  loop
    v_question := null;
    select item.value into v_question
    from jsonb_array_elements(v_form.questions) as item(value)
    where item.value ->> 'id' = v_answer_key
    limit 1;

    if v_question is null then
      raise exception 'The submission contains an unknown answer.' using errcode = '22023';
    end if;
    v_question_type := v_question ->> 'type';
    if coalesce((v_question ->> 'hidden')::boolean, false)
      or v_question_type in ('section_break', 'statement')
      or nullif(v_question ->> 'signed_by', '') is not null
      or v_answer_key = any(v_skipped_ids) then
      raise exception 'The submission contains an answer for a field that was not presented.' using errcode = '22023';
    end if;
    if jsonb_typeof(v_answer) = 'null' then continue; end if;

    if v_question_type in ('short_text', 'long_text', 'email', 'phone', 'url', 'date', 'time', 'datetime', 'signature') then
      if jsonb_typeof(v_answer) is distinct from 'string' then
        raise exception 'One or more answers have the wrong type.' using errcode = '22023';
      end if;
    elsif v_question_type in ('number', 'star_rating', 'linear_scale', 'nps') then
      if jsonb_typeof(v_answer) is distinct from 'number' then
        raise exception 'One or more answers have the wrong type.' using errcode = '22023';
      end if;
    elsif v_question_type in ('single_choice', 'dropdown', 'yes_no') then
      if jsonb_typeof(v_answer) is distinct from 'string' then
        raise exception 'One or more answers have the wrong type.' using errcode = '22023';
      end if;
    elsif v_question_type = 'multiple_choice' then
      if jsonb_typeof(v_answer) is distinct from 'array' then
        raise exception 'One or more answers have the wrong type.' using errcode = '22023';
      end if;
    elsif v_question_type in ('address', 'name_fields', 'file_upload') then
      if jsonb_typeof(v_answer) is distinct from 'object' then
        raise exception 'One or more answers have the wrong type.' using errcode = '22023';
      end if;
    end if;

    v_answer_text := case when jsonb_typeof(v_answer) = 'string' then v_answer #>> '{}' else null end;
    v_allow_other := coalesce((v_question ->> 'allow_other')::boolean, false);

    if v_question_type = 'short_text' and char_length(v_answer_text) > 1000 then
      raise exception 'One or more answers are too long.' using errcode = '22023';
    elsif v_question_type = 'long_text' and char_length(v_answer_text) > 20000 then
      raise exception 'One or more answers are too long.' using errcode = '22023';
    elsif v_question_type = 'email' and public.xert_form_answer_is_present(v_answer)
      and not public.xert_form_answer_is_already_provided(v_question, v_answer) and (
      char_length(v_answer_text) > 320
      or v_answer_text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    ) then
      raise exception 'One or more answers are invalid.' using errcode = '22023';
    elsif v_question_type = 'phone' and char_length(v_answer_text) > 60 then
      raise exception 'One or more answers are too long.' using errcode = '22023';
    elsif v_question_type = 'url' and char_length(v_answer_text) > 2048 then
      raise exception 'One or more answers are too long.' using errcode = '22023';
    elsif v_question_type in ('date', 'time', 'datetime') and char_length(v_answer_text) > 40 then
      raise exception 'One or more answers are invalid.' using errcode = '22023';
    elsif v_question_type in ('single_choice', 'dropdown') and public.xert_form_answer_is_present(v_answer) then
      v_options := v_question -> 'options';
      if char_length(v_answer_text) > 500
        or (not v_allow_other and not exists (
          select 1 from jsonb_array_elements_text(v_options) as configured(value)
          where configured.value = v_answer_text
        )) then
        raise exception 'One or more choice answers are invalid.' using errcode = '22023';
      end if;
    elsif v_question_type = 'yes_no' and public.xert_form_answer_is_present(v_answer)
      and v_answer_text not in ('Yes', 'No') then
      raise exception 'One or more choice answers are invalid.' using errcode = '22023';
    elsif v_question_type = 'multiple_choice' and jsonb_array_length(v_answer) > 0 then
      v_options := v_question -> 'options';
      if jsonb_array_length(v_answer) > 100
        or exists (
          select 1 from jsonb_array_elements(v_answer) as selected(value)
          where jsonb_typeof(selected.value) is distinct from 'string'
            or btrim(selected.value #>> '{}') = ''
            or char_length(selected.value #>> '{}') > 500
        )
        or exists (
          select 1
          from jsonb_array_elements(v_answer) as selected(value)
          group by selected.value
          having count(*) > 1
        )
        or (not v_allow_other and exists (
          select 1 from jsonb_array_elements_text(v_answer) as selected(value)
          where not exists (
            select 1 from jsonb_array_elements_text(v_options) as configured(value)
            where configured.value = selected.value
          )
        ))
        or (v_allow_other and (
          select count(*)
          from jsonb_array_elements_text(v_answer) as selected(value)
          where not exists (
            select 1 from jsonb_array_elements_text(v_options) as configured(value)
            where configured.value = selected.value
          )
        ) > 1) then
        raise exception 'One or more choice answers are invalid.' using errcode = '22023';
      end if;
    elsif v_question_type in ('star_rating', 'linear_scale', 'nps') then
      v_answer_number := (v_answer #>> '{}')::numeric;
      if v_answer_number <> trunc(v_answer_number) then
        raise exception 'One or more rating answers are invalid.' using errcode = '22023';
      end if;
      if v_question_type = 'star_rating' and v_answer_number not between 1 and 5 then
        raise exception 'One or more rating answers are invalid.' using errcode = '22023';
      elsif v_question_type = 'nps' and v_answer_number not between 0 and 10 then
        raise exception 'One or more rating answers are invalid.' using errcode = '22023';
      elsif v_question_type = 'linear_scale' then
        v_scale_min := coalesce((v_question ->> 'scale_min')::integer, 1);
        v_scale_max := coalesce((v_question ->> 'scale_max')::integer, 10);
        if v_answer_number not between v_scale_min and v_scale_max then
          raise exception 'One or more rating answers are invalid.' using errcode = '22023';
        end if;
      end if;
    elsif v_question_type = 'signature' and public.xert_form_answer_is_present(v_answer) then
      if not public.xert_valid_form_signature(v_answer_text) then
        raise exception 'The submitted signature is invalid.' using errcode = '22023';
      end if;
    elsif v_question_type in ('address', 'name_fields') then
      if exists (
        select 1 from jsonb_each(v_answer) as part(key, value)
        where (v_question_type = 'address' and part.key not in ('street', 'suburb', 'state', 'postcode', 'country'))
          or (v_question_type = 'name_fields' and part.key not in ('first', 'last'))
          or jsonb_typeof(part.value) is distinct from 'string'
          or char_length(part.value #>> '{}') > 500
      ) then
        raise exception 'One or more compound answers are invalid.' using errcode = '22023';
      end if;
    elsif v_question_type = 'file_upload' and public.xert_form_answer_is_present(v_answer) then
      if exists (
        select 1 from jsonb_object_keys(v_answer) as part(key)
        where part.key not in ('name', 'size', 'type')
      )
        or jsonb_typeof(v_answer -> 'name') is distinct from 'string'
        or nullif(btrim(v_answer ->> 'name'), '') is null
        or char_length(v_answer ->> 'name') > 180
        or jsonb_typeof(v_answer -> 'size') is distinct from 'number'
        or jsonb_typeof(v_answer -> 'type') is distinct from 'string'
        or char_length(v_answer ->> 'type') > 100 then
        raise exception 'The submitted file details are invalid.' using errcode = '22023';
      end if;
      v_answer_number := (v_answer ->> 'size')::numeric;
      if v_answer_number < 0 or v_answer_number <> trunc(v_answer_number) then
        raise exception 'The submitted file details are invalid.' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- Required validation happens after branch calculation. A required field
  -- skipped by a legitimate forward rule was never presented and is therefore
  -- not required; a visible compound value must contain real content.
  for v_question in select value from jsonb_array_elements(v_form.questions)
  loop
    v_question_id := v_question ->> 'id';
    v_question_type := v_question ->> 'type';
    if coalesce((v_question ->> 'hidden')::boolean, false)
      or v_question_type in ('section_break', 'statement')
      or nullif(v_question ->> 'signed_by', '') is not null
      or v_question_id = any(v_skipped_ids) then
      continue;
    end if;
    if coalesce((v_question ->> 'required')::boolean, false) then
      v_answer := p_answers -> v_question_id;
      if not coalesce(public.xert_form_answer_is_present(v_answer), false)
        or (v_question_type = 'file_upload' and nullif(btrim(v_answer ->> 'name'), '') is null) then
        raise exception 'Please complete every required question.' using errcode = '22023';
      end if;
    end if;
  end loop;

  if v_form.one_response_per_email then
    if v_email is null then
      raise exception 'Email is required for this form.' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.xert_form_responses r
      where r.form_id = v_form.id and lower(r.respondent_email) = v_email and r.archived_at is null
    ) then
      raise exception 'A response has already been submitted for this email.' using errcode = '23505';
    end if;
  end if;

  -- A signature given in advance goes into every response that reached it:
  -- not a hidden field, and not one a branch skipped (a declined agreement is
  -- not countersigned). It comes from the signatory's record, never from
  -- anything the browser sent, and is stored like any other signature, so the
  -- record, the PDF, the iOS record and the emailed copy all carry it.
  for v_question in select value from jsonb_array_elements(v_form.questions)
  loop
    if nullif(v_question ->> 'signed_by', '') is null
      or coalesce((v_question ->> 'hidden')::boolean, false)
      or (v_question ->> 'id') = any(v_skipped_ids) then
      continue;
    end if;
    v_answer_text := (
      select signatory.signature from public.xert_form_signatories signatory
      where signatory.key = v_question ->> 'signed_by'
    );
    if v_answer_text is not null then
      p_answers := p_answers || jsonb_build_object(v_question ->> 'id', v_answer_text);
    end if;
  end loop;

  insert into public.xert_form_responses (
    form_id, answers, respondent_name, respondent_email, respondent_phone,
    time_taken_seconds, source_url, created_by
  ) values (
    v_form.id,
    p_answers,
    nullif(left(btrim(coalesce(p_respondent_name, '')), 160), ''),
    v_email,
    nullif(left(btrim(coalesce(p_respondent_phone, '')), 60), ''),
    least(greatest(coalesce(p_time_taken_seconds, 0), 0), 43200),
    nullif(left(coalesce(p_source_url, ''), 2048), ''),
    auth.uid()
  ) returning id into v_id;

  update public.xert_forms set response_count = response_count + 1 where id = v_form.id;
  return v_id;
end;
$function$;

-- The contractor agreement's owner line becomes Byron's signature, signed in
-- advance. Only that question's settings change; its wording is brought up to
-- date only where it still reads as first written, so an owner's own edits
-- stay as they are.
update public.xert_forms form
set questions = (
  select jsonb_agg(
    case
      when item.question ->> 'id' = 'ic-98-owner-signature' and item.question ->> 'type' = 'signature' then
        item.question
          || jsonb_build_object('signed_by', 'byron-hawley', 'required', false)
          || case when item.question ->> 'question' = 'Owner / witness signature'
            then jsonb_build_object('question', 'Signed for XERT Fitness') else '{}'::jsonb end
          || case when item.question ->> 'description' = 'Signed by Byron Hawley, or a XERT Fitness representative witnessing this agreement.'
            then jsonb_build_object('description', 'Byron Hawley, Owner. His signature is on every copy of this agreement.') else '{}'::jsonb end
      when item.question ->> 'id' = 'ic-96-owner'
        and item.question ->> 'description' = 'Completed by the owner or witness at the club.' then
        item.question || jsonb_build_object('description', 'Signed by the owner for XERT Fitness.')
      when item.question ->> 'id' = 'ic-97-owner-details'
        and item.question ->> 'content' = 'Owner / Witness: Byron Hawley. Phone 0431 676 053. Email info@xertfitness.com.au.' then
        item.question || jsonb_build_object('content', 'Byron Hawley, Owner. Phone 0431 676 053. Email info@xertfitness.com.au.')
      else item.question
    end
    order by item.position)
  from jsonb_array_elements(form.questions) with ordinality as item(question, position)
)
where form.archived_at is null
  and form.questions @> '[{"id": "ic-98-owner-signature", "type": "signature"}]'::jsonb;

-- Proof, rolled back with everything above if any of it fails.
do $$
begin
  if not exists (
    select 1 from public.xert_form_signatories
    where key = 'byron-hawley' and public.xert_valid_form_signature(signature)
  ) then
    raise exception 'Byron Hawley''s signature must be on record and valid';
  end if;
  if exists (
    select 1 from public.xert_forms form
    cross join lateral jsonb_array_elements(form.questions) as item(question)
    where form.archived_at is null
      and item.question ->> 'id' = 'ic-98-owner-signature'
      and (item.question ->> 'signed_by' is distinct from 'byron-hawley'
        or coalesce((item.question ->> 'required')::boolean, false))
  ) then
    raise exception 'the contractor agreement must be signed in advance by Byron Hawley';
  end if;
end;
$$;
