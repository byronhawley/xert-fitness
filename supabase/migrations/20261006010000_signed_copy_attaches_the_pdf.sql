-- The copy email now carries the whole signed document as a PDF.
--
-- Until now it listed the answers and showed the signatures, but not the
-- agreement itself: somebody signing the contractor agreement got their
-- details back and none of the clauses they had agreed to. What a person signs
-- has to be something they can keep.
--
-- The PDF is laid out from the response's own snapshot by the website's
-- server (src/lib/signedDocumentPdf.js), because a database cannot draw a PDF
-- with signatures in it. The flow, for a form with email_pdf_copy switched on:
--
--   1. The response is inserted. The trigger asks the server to render it
--      (pg_net, so the submission never waits on it).
--   2. The server reads the response through xert_signed_document_source, which
--      only answers for a fresh, unsent response on such a form, renders the
--      PDF, and calls send_signed_document_copy with it.
--   3. If any of that fails, send_overdue_signed_document_copies sends the
--      copy without the PDF a few minutes later. A failed render can delay a
--      copy; it can never lose one.
--
-- Forms without the setting are untouched: their copy still goes the moment
-- they are submitted, exactly as before.

alter table public.xert_forms
  add column if not exists email_pdf_copy boolean not null default false;

comment on column public.xert_forms.email_pdf_copy is
  'Attach the whole signed form as a PDF to the respondent''s copy email.';

-- Where the PDF is drawn. A function, so moving the site is a one-line change.
create or replace function public.signed_document_pdf_endpoint()
returns text
language sql
immutable
set search_path to ''
as $$
  select 'https://www.xertfitness.com.au/api/push-subscription?action=signed_document'::text;
$$;

revoke all on function public.signed_document_pdf_endpoint() from public, anon, authenticated;

-- What the server needs to draw one response, and the only door it has to it.
-- Returns null unless the response is fresh, not archived, on a form that
-- sends PDFs, and not yet emailed. That is what makes the endpoint safe to
-- leave without a secret: holding a response id lets you do nothing but send
-- its own respondent their copy, once.
create or replace function public.xert_signed_document_source(p_response_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'answers', r.answers,
    'form_snapshot', r.form_snapshot,
    'respondent_name', r.respondent_name,
    'respondent_email', r.respondent_email,
    'respondent_phone', r.respondent_phone,
    'completed_at', r.completed_at,
    'created_at', r.created_at
  )
  from public.xert_form_responses r
  join public.xert_forms f on f.id = r.form_id
  where r.id = p_response_id
    and r.archived_at is null
    and f.email_copy_to_respondent
    and f.email_pdf_copy
    and r.created_at > now() - interval '2 hours'
    and not exists (
      select 1 from public.email_log l
      where l.email_type = 'signed_documents' and l.related_id = r.id::text
    );
$$;

revoke all on function public.xert_signed_document_source(uuid) from public, anon, authenticated;
grant execute on function public.xert_signed_document_source(uuid) to service_role;

-- The one-argument version goes first, or a call with one argument would be
-- ambiguous between it and the new one with defaults.
drop function if exists public.send_signed_document_copy(uuid);

CREATE OR REPLACE FUNCTION public.send_signed_document_copy(
  p_response_id uuid,
  p_pdf_base64 text DEFAULT NULL,
  p_pdf_filename text DEFAULT NULL
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r public.xert_form_responses%rowtype;
  v_form public.xert_forms%rowtype;
  v_title text;
  v_email text;
  v_name text;
  v_when text;
  v_answers text;
  v_signatures text;
  v_body text;
  v_link text;
  v_cta text;
  v_attachments jsonb;
  v_pdf text := nullif(btrim(coalesce(p_pdf_base64, '')), '');
  v_pdf_name text;
begin
  -- One copy per response, however many callers race: the server with the
  -- PDF and the fallback without it can both arrive in the same instant.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signed_documents:' || p_response_id::text, 0));
  -- Only a real PDF, and not an absurd one. "JVBERi" is base64 for "%PDF".
  if v_pdf is not null and (v_pdf !~ '^JVBERi[A-Za-z0-9+/=]+$' or length(v_pdf) > 8000000) then
    v_pdf := null;
  end if;
  select * into r from public.xert_form_responses where id = p_response_id;
  if not found or r.archived_at is not null then return false; end if;

  select * into v_form from public.xert_forms where id = r.form_id;
  if not found or not v_form.email_copy_to_respondent then return false; end if;

  if exists (
    select 1 from public.email_log
    where email_type = 'signed_documents' and related_id = r.id::text
  ) then return false; end if;

  v_email := lower(btrim(coalesce(
    nullif(btrim(r.respondent_email), ''),
    r.answers ->> 'e4c4e161-43e3-5462-a865-f27c411ac809',
    ''
  )));
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return false; end if;

  v_title := coalesce(nullif(btrim(r.form_snapshot ->> 'title'), ''), v_form.title, 'XERT form');
  v_name := nullif(btrim(coalesce(
    nullif(btrim(r.respondent_name), ''),
    concat_ws(' ',
      r.answers #>> '{84703ad7-a28d-4904-9868-6c832ce38055,first}',
      r.answers #>> '{84703ad7-a28d-4904-9868-6c832ce38055,last}'
    ),
    ''
  )), '');
  v_when := to_char(coalesce(r.completed_at, r.created_at, now()) at time zone 'Australia/Brisbane',
                    'FMDay, FMDD FMMonth YYYY "at" FMHH12:MIam');
  v_answers := public.form_response_answers_html(r.id);
  v_signatures := public.form_response_signature_html(r.id);
  v_attachments := public.form_response_signatures(r.id);
  if v_pdf is not null then
    v_pdf_name := left(regexp_replace(coalesce(nullif(btrim(p_pdf_filename), ''), 'signed-copy.pdf'), '[^A-Za-z0-9._ -]+', '', 'g'), 150);
    if v_pdf_name !~* '\.pdf$' then v_pdf_name := v_pdf_name || '.pdf'; end if;
    -- First, so it is the attachment a mail client shows on top.
    v_attachments := jsonb_build_array(jsonb_build_object(
      'filename', v_pdf_name, 'content', v_pdf, 'content_type', 'application/pdf'
    )) || coalesce(v_attachments, '[]'::jsonb);
  end if;

  if v_form.slug = 'terms-and-conditions' then
    v_cta := 'Read the full terms';
    v_link := 'https://www.xertfitness.com.au/terms';
  else
    v_cta := null;
    v_link := null;
  end if;

  v_body :=
    '<p>' || case when v_name is null then 'Hello,' else 'Hello ' || public.email_escape(v_name) || ',' end || '</p>'
    || '<p>Here is your copy of the <strong>' || public.email_escape(v_title)
    || '</strong> you completed on ' || public.email_escape(v_when) || '. Keep this email for your records.</p>'
    || case when v_pdf is null then ''
       else '<p><strong>The full ' || public.email_escape(v_title) || ', as you signed it, is attached as a PDF</strong>'
            || ' &mdash; every section, your answers and the signatures. Save it with your records.</p>' end
    || case when v_answers = '' then ''
       else '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0">'
            || v_answers || '</table>' end
    || case when v_signatures = '' then ''
       else '<div style="border-top:1px solid #dbe3ea;margin:20px 0 0;padding:4px 0 0">'
            || '<div style="color:#5a6b7a;font-size:13px">Signed</div>'
            || v_signatures
            || '<p style="color:#5a6b7a;font-size:12px;margin:12px 0 0">Your signature is also attached to this'
            || ' email as an image, in case it does not display above.</p>'
            || '</div>' end
    || '<p style="color:#5a6b7a;font-size:13px">If anything above is wrong, reply to this email and the XERT team will correct it.</p>';

  begin
    perform public.queue_email(
      'signed_documents', v_email,
      'Your copy: ' || v_title,
      public.email_layout('Your signed copy', v_body, v_cta, v_link),
      null, 'xert_form_responses', r.id::text,
      case when jsonb_array_length(v_attachments) = 0 then null else v_attachments end
    );
  exception when others then
    raise notice 'signed document copy skipped: %', sqlerrm;
    return false;
  end;
  return true;
end;
$function$;

revoke all on function public.send_signed_document_copy(uuid, text, text) from public, anon, authenticated;
grant execute on function public.send_signed_document_copy(uuid, text, text) to service_role;

-- On insert: forms that send a PDF ask the server for it; everything else is
-- sent straight away, as it always was. A failure to even ask falls back to
-- sending at once, so no copy waits on a request that was never made.
create or replace function public.email_form_response_copy()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_sends_pdf boolean;
begin
  select f.email_copy_to_respondent and f.email_pdf_copy into v_sends_pdf
  from public.xert_forms f where f.id = new.form_id;

  if coalesce(v_sends_pdf, false) then
    begin
      perform net.http_post(
        url := public.signed_document_pdf_endpoint(),
        body := jsonb_build_object('response_id', new.id),
        headers := '{"Content-Type": "application/json"}'::jsonb,
        timeout_milliseconds := 30000
      );
      return new;
    exception when others then
      raise notice 'signed PDF request not made, sending the copy without it: %', sqlerrm;
    end;
  end if;

  perform public.send_signed_document_copy(new.id);
  return new;
end;
$$;

-- The safety net. Any PDF-form response still without a copy a few minutes on
-- gets one without the PDF. Two days back is enough to cover an outage over a
-- weekend without ever reaching into old history.
create or replace function public.send_overdue_signed_document_copies()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_id uuid;
  v_sent integer := 0;
begin
  for v_id in
    select r.id
    from public.xert_form_responses r
    join public.xert_forms f on f.id = r.form_id
    where f.email_copy_to_respondent
      and f.email_pdf_copy
      and r.archived_at is null
      and r.created_at < now() - interval '3 minutes'
      and r.created_at > now() - interval '2 days'
      and lower(btrim(coalesce(r.respondent_email, ''))) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
      and not exists (
        select 1 from public.email_log l
        where l.email_type = 'signed_documents' and l.related_id = r.id::text
      )
    order by r.created_at
    limit 25
  loop
    if public.send_signed_document_copy(v_id) then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end;
$$;

revoke all on function public.send_overdue_signed_document_copies() from public, anon, authenticated;

select cron.schedule(
  'send-overdue-signed-document-copies',
  '*/2 * * * *',
  $$select public.send_overdue_signed_document_copies()$$
);

do $$
begin
  if pg_catalog.has_function_privilege('anon', 'public.xert_signed_document_source(uuid)', 'execute')
    or pg_catalog.has_function_privilege('authenticated', 'public.xert_signed_document_source(uuid)', 'execute') then
    raise exception 'A signed response must not be readable without the service role.';
  end if;
  if not pg_catalog.has_function_privilege('service_role', 'public.send_signed_document_copy(uuid, text, text)', 'execute') then
    raise exception 'The PDF server must be able to send the copy.';
  end if;
  if pg_catalog.has_function_privilege('anon', 'public.send_signed_document_copy(uuid, text, text)', 'execute') then
    raise exception 'Sending a copy must not be open to anon.';
  end if;
end;
$$;
