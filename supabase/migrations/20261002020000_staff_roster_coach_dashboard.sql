-- Fail fast instead of queueing behind live traffic for a lock. Safe to re-run
-- if it times out: every statement below is idempotent. `local` keeps the
-- setting to this run's transaction (the SQL editor sends the file as one
-- implicit transaction), so it does not linger on the editor's connection.
set local lock_timeout = '5s';

-- ============================================================================
-- XERT Roster: coach invite links and the coach dashboard
-- ============================================================================
-- Forward migration on top of 20261001010000_staff_roster.sql and
-- 20261002010000_staff_roster_push_reliability.sql (both applied; never
-- edited). Additive and idempotent. It changes no existing row, class,
-- booking, notice or device, and the roster stays switched off.
--
-- A manager sends a coach (a staff_members row with no sign-in yet) a
-- single-use link. The coach opens it, signs in or creates an account, and
-- accepting links that account to the staff record: the same link a manager
-- can already make by hand in Coaches → Sign-in.
--
--   * Only the SHA-256 of the token is stored. The token itself is returned
--     once, to the manager who created it, and is never written to a table,
--     the audit log or the request-replay store.
--   * One live invite per coach: issuing again revokes the previous one.
--   * Invites expire after 14 days, can be revoked, and are used once.
--   * Before a valid token is presented nothing about any coach is revealed;
--     failed attempts are counted per account and throttled.
--   * Accepting does not need the roster switched on. Coach screens still
--     follow the switch (`staff_roster_current_staff`).
--
-- The second half (below) adds the coach dashboard's data: website profile
-- drafts with manager approval, certificates with expiry reminders, class
-- headcount and session plans for the coaches on a class, hours coached, and
-- per-person notice preferences honoured by the existing email and push paths.
--
-- Naming: "staff", not "coach-only", so the same link can onboard a personal
-- trainer later (docs/staff-roster/PT_AVAILABILITY_PLAN.md).
-- ============================================================================


-- ─── Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.staff_roster_invites (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  token_hash bytea not null,
  email text,
  email_status text,
  email_log_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text,
  accepted_at timestamptz,
  accepted_by uuid,
  constraint staff_roster_invites_hash_length check (octet_length(token_hash) = 32),
  constraint staff_roster_invites_expiry check (expires_at > created_at),
  constraint staff_roster_invites_email check (email is null or (char_length(email) <= 254 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  constraint staff_roster_invites_email_status check (email_status is null or email_status in ('queued', 'sent', 'failed', 'skipped', 'no_address')),
  constraint staff_roster_invites_revoked_reason check (revoked_reason is null or revoked_reason in ('revoked', 'reissued', 'already_linked')),
  constraint staff_roster_invites_one_outcome check (revoked_at is null or accepted_at is null),
  constraint staff_roster_invites_accepted_by check ((accepted_at is null) = (accepted_by is null))
);
create unique index if not exists staff_roster_invites_token on public.staff_roster_invites (token_hash);
create unique index if not exists staff_roster_invites_one_live on public.staff_roster_invites (staff_id)
  where accepted_at is null and revoked_at is null;
create index if not exists staff_roster_invites_staff on public.staff_roster_invites (staff_id, created_at desc);

-- Failed preview/accept attempts per signed-in account, for throttling only.
-- Holds no token, hash or coach.
create table if not exists public.staff_roster_invite_attempts (
  id bigint generated always as identity primary key,
  profile_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists staff_roster_invite_attempts_recent on public.staff_roster_invite_attempts (profile_id, at desc);

do $lockdown$
declare
  v_table text;
  v_sequence text;
begin
  foreach v_table in array array['staff_roster_invites', 'staff_roster_invite_attempts'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    for v_sequence in
      select pg_get_serial_sequence(format('public.%I', v_table), a.attname)
      from pg_attribute a
      where a.attrelid = format('public.%I', v_table)::regclass and a.attnum > 0 and not a.attisdropped
        and pg_get_serial_sequence(format('public.%I', v_table), a.attname) is not null
    loop
      execute format('revoke all on sequence %s from public, anon, authenticated', v_sequence);
    end loop;
  end loop;
end;
$lockdown$;


-- ─── Helpers (not callable from the API) ────────────────────────────────────

-- SHA-256 of a well-formed token (64 lowercase hex characters), else null.
-- Lookup is by this hash through a unique index, so response time does not
-- depend on how much of a guessed token is right.
create or replace function public.staff_roster_invite_hash(p_token text)
returns bytea language sql immutable set search_path = public as $$
  select case when lower(btrim(coalesce(p_token, ''))) ~ '^[0-9a-f]{64}$'
    then sha256(convert_to(lower(btrim(p_token)), 'UTF8')) end;
$$;

create or replace function public.staff_roster_invite_state(p_invite public.staff_roster_invites)
returns text language sql stable set search_path = public as $$
  select case
    when p_invite.accepted_at is not null then 'accepted'
    when p_invite.revoked_at is not null then 'revoked'
    when p_invite.expires_at <= now() then 'expired'
    else 'pending' end;
$$;

-- The manager's view of one invite. Never includes the hash. The email
-- outcome comes from the site's email log when there is one.
create or replace function public.staff_roster_invite_view(p_invite public.staff_roster_invites)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_email_status text := p_invite.email_status;
begin
  if p_invite.email_log_id is not null and to_regclass('public.email_log') is not null then
    execute 'select status from public.email_log where id = $1' into v_email_status using p_invite.email_log_id;
    v_email_status := coalesce(v_email_status, p_invite.email_status);
  end if;
  return jsonb_build_object(
    'id', p_invite.id, 'staff_id', p_invite.staff_id, 'status', public.staff_roster_invite_state(p_invite),
    'created_at', p_invite.created_at, 'expires_at', p_invite.expires_at,
    'created_by', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = p_invite.created_by),
    'email', p_invite.email, 'email_status', v_email_status,
    'revoked_at', p_invite.revoked_at, 'revoked_reason', p_invite.revoked_reason,
    'accepted_at', p_invite.accepted_at,
    'accepted_by', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = p_invite.accepted_by));
end;
$$;

-- More than 10 failed attempts in 15 minutes pauses this account's attempts.
create or replace function public.staff_roster_invite_throttled()
returns boolean language sql stable security definer set search_path = public as $$
  select count(*) >= 10 from public.staff_roster_invite_attempts
  where profile_id = auth.uid() and at > now() - interval '15 minutes';
$$;

-- Records a failed attempt and returns the outcome. Returned, not raised, so
-- the attempt row is kept.
create or replace function public.staff_roster_invite_failed(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from public.staff_roster_invite_attempts where profile_id = auth.uid() and at < now() - interval '1 day';
  insert into public.staff_roster_invite_attempts (profile_id) values (auth.uid());
  return jsonb_build_object('ok', false, 'code', p_code);
end;
$$;


-- ─── Manager ────────────────────────────────────────────────────────────────

-- Issues a new invite for a coach with no sign-in, revoking any earlier live
-- one. Returns the token once. When `p_email` is given, the link is also
-- queued through the site's email log (subject to Email settings).
create or replace function public.staff_roster_invite_create(p_staff_id uuid, p_email text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_invite public.staff_roster_invites;
  v_token text;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_link text;
  v_log uuid;
  v_html text;
  v_body text;
  v_revoked integer;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  select * into v_staff from public.staff_members where id = p_staff_id for update;
  if v_staff.id is null then raise exception 'STAFF_NOT_FOUND'; end if;
  if v_staff.profile_id is not null then raise exception 'STAFF_ALREADY_LINKED'; end if;
  if v_staff.status <> 'active' then raise exception 'STAFF_INACTIVE'; end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then raise exception 'EMAIL_INVALID'; end if;

  update public.staff_roster_invites set revoked_at = now(), revoked_by = auth.uid(), revoked_reason = 'reissued'
    where staff_id = p_staff_id and accepted_at is null and revoked_at is null;
  get diagnostics v_revoked = row_count;

  -- 244 random bits from two v4 UUIDs (gen_random_uuid uses the strong RNG).
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.staff_roster_invites (staff_id, token_hash, email, created_by, expires_at)
  values (p_staff_id, public.staff_roster_invite_hash(v_token), v_email, auth.uid(), now() + interval '14 days')
  returning * into v_invite;

  if v_email is not null then
    v_link := 'https://www.xertfitness.com.au/coach-invite#token=' || v_token;
    v_body := 'You have been invited to join the XERT coach roster as ' || v_staff.display_name || '. '
      || 'Open the link, sign in or create an account, and you can give your availability and see your classes. '
      || 'The link works once and expires in 14 days.';
    begin
      if to_regprocedure('public.queue_email(text,text,text,text,text,text,text,jsonb)') is null then
        v_invite.email_status := 'skipped';
      else
        if to_regprocedure('public.email_layout(text,text,text,text)') is not null and to_regprocedure('public.email_escape(text)') is not null then
          execute 'select public.email_layout($1, ''<p>'' || public.email_escape($2) || ''</p>'', $3, $4)'
            into v_html using 'Join the XERT coach roster', v_body, 'Accept invite', v_link;
        else
          v_html := '<p>' || replace(replace(v_body, '<', '&lt;'), '>', '&gt;') || '</p><p><a href="' || v_link || '">Accept invite</a></p>';
        end if;
        -- queue_email(type, to, subject, html, text, related_table, related_id, attachments)
        execute 'select public.queue_email($1, $2, $3, $4, $5, $6, $7, $8)'
          into v_log
          using 'staff_invite', v_email, 'Your XERT coach invite', v_html,
            v_body || E'\n\nAccept: ' || v_link, 'staff_roster_invites', v_invite.id::text, null::jsonb;
        v_invite.email_log_id := v_log;
        v_invite.email_status := case when v_log is null then 'no_address' else 'queued' end;
      end if;
    exception when others then
      v_invite.email_status := 'failed';
    end;
    update public.staff_roster_invites set email_status = v_invite.email_status, email_log_id = v_invite.email_log_id where id = v_invite.id;
  end if;

  perform public.staff_roster_audit('invite_created', 'staff', p_staff_id::text, null, null,
    jsonb_build_object('invite_id', v_invite.id, 'expires_at', v_invite.expires_at, 'emailed', v_email is not null, 'replaced', v_revoked));
  return jsonb_build_object('token', v_token, 'invite', public.staff_roster_invite_view(v_invite));
end;
$$;

create or replace function public.staff_roster_invite_revoke(p_invite_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_invite public.staff_roster_invites;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  select * into v_invite from public.staff_roster_invites where id = p_invite_id for update;
  if v_invite.id is null then raise exception 'INVITE_NOT_FOUND'; end if;
  if v_invite.accepted_at is not null then raise exception 'INVITE_USED'; end if;
  if v_invite.revoked_at is null then
    update public.staff_roster_invites set revoked_at = now(), revoked_by = auth.uid(), revoked_reason = 'revoked'
      where id = p_invite_id returning * into v_invite;
    perform public.staff_roster_audit('invite_revoked', 'staff', v_invite.staff_id::text, null, null, jsonb_build_object('invite_id', v_invite.id));
  end if;
  return public.staff_roster_invite_view(v_invite);
end;
$$;

-- The latest invite of every coach who has one.
create or replace function public.staff_roster_invite_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_roster_require_manager();
  return coalesce((
    select jsonb_agg(public.staff_roster_invite_view(i) || jsonb_build_object('staff_linked', m.profile_id is not null) order by i.created_at desc)
    from public.staff_roster_invites i
    join public.staff_members m on m.id = i.staff_id
    where i.id in (select distinct on (x.staff_id) x.id from public.staff_roster_invites x order by x.staff_id, x.created_at desc)
  ), '[]'::jsonb);
end;
$$;


-- ─── Coach (any signed-in account holding the link) ─────────────────────────

-- What the link is for, before the coach confirms. A coach name is shown only
-- for a valid, live token.
create or replace function public.staff_roster_invite_preview(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash bytea := public.staff_roster_invite_hash(p_token);
  v_invite public.staff_roster_invites;
  v_staff public.staff_members;
  v_state text;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if public.staff_roster_invite_throttled() then return jsonb_build_object('ok', false, 'code', 'TOO_MANY_ATTEMPTS'); end if;
  if v_hash is not null then select * into v_invite from public.staff_roster_invites where token_hash = v_hash; end if;
  if v_invite.id is null then return public.staff_roster_invite_failed('INVITE_INVALID'); end if;
  select * into v_staff from public.staff_members where id = v_invite.staff_id;
  v_state := public.staff_roster_invite_state(v_invite);
  if v_state = 'accepted' then
    if v_invite.accepted_by = auth.uid() and v_staff.profile_id = auth.uid() then
      return jsonb_build_object('ok', true, 'status', 'accepted', 'display_name', v_staff.display_name, 'linked_to_you', true);
    end if;
    return public.staff_roster_invite_failed('INVITE_USED');
  end if;
  if v_state = 'revoked' then return public.staff_roster_invite_failed('INVITE_REVOKED'); end if;
  if v_state = 'expired' then return public.staff_roster_invite_failed('INVITE_EXPIRED'); end if;
  return jsonb_build_object('ok', true, 'status', 'pending', 'display_name', v_staff.display_name, 'expires_at', v_invite.expires_at,
    'linked_to_you', false,
    'account_already_staff', exists (select 1 from public.staff_members where profile_id = auth.uid()));
end;
$$;

-- Links the caller's account to the invited staff record, once, atomically.
-- Token problems are returned as { ok: false, code } (so the attempt counts);
-- only a missing sign-in raises.
create or replace function public.staff_roster_invite_accept(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash bytea := public.staff_roster_invite_hash(p_token);
  v_invite public.staff_roster_invites;
  v_before public.staff_members;
  v_after public.staff_members;
  v_state text;
  v_enabled boolean;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  perform public.staff_roster_lock();
  if public.staff_roster_invite_throttled() then return jsonb_build_object('ok', false, 'code', 'TOO_MANY_ATTEMPTS'); end if;
  if v_hash is not null then select * into v_invite from public.staff_roster_invites where token_hash = v_hash for update; end if;
  if v_invite.id is null then return public.staff_roster_invite_failed('INVITE_INVALID'); end if;
  select * into v_before from public.staff_members where id = v_invite.staff_id for update;
  select enabled into v_enabled from public.staff_roster_settings where id = 1;
  v_state := public.staff_roster_invite_state(v_invite);

  if v_state = 'accepted' then
    -- Opening the same link again after joining is not an error.
    if v_invite.accepted_by = auth.uid() and v_before.profile_id = auth.uid() then
      return jsonb_build_object('ok', true, 'already_accepted', true, 'roster_enabled', coalesce(v_enabled, false),
        'staff', jsonb_build_object('id', v_before.id, 'display_name', v_before.display_name));
    end if;
    return public.staff_roster_invite_failed('INVITE_USED');
  end if;
  if v_state = 'revoked' then return public.staff_roster_invite_failed('INVITE_REVOKED'); end if;
  if v_state = 'expired' then return public.staff_roster_invite_failed('INVITE_EXPIRED'); end if;
  if v_before.status <> 'active' then return jsonb_build_object('ok', false, 'code', 'STAFF_INACTIVE'); end if;
  if v_before.profile_id is not null then
    -- Linked by hand (or another invite) since this one was sent.
    update public.staff_roster_invites set revoked_at = now(), revoked_reason = 'already_linked' where id = v_invite.id;
    return jsonb_build_object('ok', false, 'code', 'STAFF_ALREADY_LINKED');
  end if;
  if exists (select 1 from public.staff_members where profile_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_ALREADY_LINKED');
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    return jsonb_build_object('ok', false, 'code', 'PROFILE_NOT_READY');
  end if;

  update public.staff_members set profile_id = auth.uid(), version = version + 1, updated_at = now()
    where id = v_before.id returning * into v_after;
  update public.staff_roster_invites set accepted_at = now(), accepted_by = auth.uid() where id = v_invite.id;
  perform public.staff_roster_audit('invite_accepted', 'staff', v_after.id::text, null,
    jsonb_build_object('profile_id', v_before.profile_id), jsonb_build_object('profile_id', v_after.profile_id, 'invite_id', v_invite.id));
  return jsonb_build_object('ok', true, 'already_accepted', false, 'roster_enabled', coalesce(v_enabled, false),
    'staff', jsonb_build_object('id', v_after.id, 'display_name', v_after.display_name));
end;
$$;


-- ============================================================================
-- Coach dashboard: profile, certificates, class details, hours, notices
-- ============================================================================
-- Everything below is reachable only through security-definer functions;
-- direct table access is revoked. Coaches reach their own records and the
-- classes they are on in a published roster; managers (profiles.role =
-- 'admin', via is_admin) reach everything.


-- ─── Tables ─────────────────────────────────────────────────────────────────

-- A coach's proposed public profile. The public Coaches page reads
-- `public.coaches`, which has a `published` flag the manager controls, so a
-- coach never writes there: they edit this draft, submit it, and a manager
-- approves it onto the website profile.
create table if not exists public.staff_profile_drafts (
  staff_id uuid primary key references public.staff_members(id) on delete cascade,
  name text,
  role text,
  bio text,
  experience text,
  currently_training_for text,
  photo_url text,
  social_url text,
  status text not null default 'draft',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid,
  review_note text,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint staff_profile_drafts_status check (status in ('draft', 'submitted', 'approved', 'rejected')),
  constraint staff_profile_drafts_name check (name is null or char_length(btrim(name)) between 1 and 80),
  constraint staff_profile_drafts_role check (coalesce(char_length(role), 0) <= 80),
  constraint staff_profile_drafts_bio check (coalesce(char_length(bio), 0) <= 2000),
  constraint staff_profile_drafts_experience check (coalesce(char_length(experience), 0) <= 1000),
  constraint staff_profile_drafts_training check (coalesce(char_length(currently_training_for), 0) <= 200),
  constraint staff_profile_drafts_urls check (coalesce(char_length(photo_url), 0) <= 500 and coalesce(char_length(social_url), 0) <= 300),
  constraint staff_profile_drafts_note check (coalesce(char_length(review_note), 0) <= 500)
);

-- First aid, CPR and similar. The optional file lives in the private
-- `staff-certificates` storage bucket under "<coach's profile id>/…".
create table if not exists public.staff_certificates (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_members(id) on delete cascade,
  kind text not null,
  title text,
  number text,
  issued_on date,
  expires_on date,
  file_path text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint staff_certificates_kind check (kind in ('first_aid', 'cpr', 'coaching', 'working_with_children', 'other')),
  constraint staff_certificates_title check (coalesce(char_length(title), 0) <= 120),
  constraint staff_certificates_number check (coalesce(char_length(number), 0) <= 80),
  constraint staff_certificates_dates check (issued_on is null or expires_on is null or expires_on >= issued_on),
  constraint staff_certificates_file check (file_path is null or file_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$')
);
create index if not exists staff_certificates_staff on public.staff_certificates (staff_id) where archived_at is null;
create index if not exists staff_certificates_expiry on public.staff_certificates (expires_on) where archived_at is null;

-- A coach's plan or notes for a class they are rostered on. Append-only: the
-- newest row is current, earlier rows are the history.
create table if not exists public.staff_session_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  body text not null,
  author_profile_id uuid,
  author_staff_id uuid,
  created_at timestamptz not null default now(),
  constraint staff_session_notes_body check (char_length(body) <= 4000)
);
create index if not exists staff_session_notes_session on public.staff_session_notes (session_id, created_at desc);

-- How a person wants roster notices. In-app is always on. Absent row = both on.
-- The roster-wide switches (email in Settings, push configuration) still win.
create table if not exists public.staff_notice_preferences (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  email boolean not null default true,
  push boolean not null default true,
  updated_at timestamptz not null default now()
);

do $lockdown$
declare
  v_table text;
begin
  foreach v_table in array array['staff_profile_drafts', 'staff_certificates', 'staff_session_notes', 'staff_notice_preferences'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
  end loop;
end;
$lockdown$;


-- ─── Storage (skipped where there is no Supabase storage, e.g. local tests) ─

do $storage$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then return; end if;
  -- Private bucket for certificate files: 10 MB, PDFs and photos.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('staff-certificates', 'staff-certificates', false, 10485760,
    array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'])
  on conflict (id) do update set public = false;

  execute 'drop policy if exists "staff_certificates_owner_insert" on storage.objects';
  execute 'drop policy if exists "staff_certificates_owner_or_manager_read" on storage.objects';
  execute 'drop policy if exists "staff_certificates_owner_delete" on storage.objects';
  execute 'drop policy if exists "site_images_staff_profile_insert" on storage.objects';
  -- A coach uploads only into their own folder; only they and managers read.
  execute $p$create policy "staff_certificates_owner_insert" on storage.objects for insert to authenticated
    with check (bucket_id = 'staff-certificates' and (storage.foldername(name))[1] = (select auth.uid())::text
      and exists (select 1 from public.staff_members m where m.profile_id = (select auth.uid()) and m.status = 'active'))$p$;
  execute $p$create policy "staff_certificates_owner_or_manager_read" on storage.objects for select to authenticated
    using (bucket_id = 'staff-certificates' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()))$p$;
  execute $p$create policy "staff_certificates_owner_delete" on storage.objects for delete to authenticated
    using (bucket_id = 'staff-certificates' and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;
  -- Profile photos go to the existing public site-images bucket, but a coach
  -- may only add files under staff-profiles/<their profile id>/.
  execute $p$create policy "site_images_staff_profile_insert" on storage.objects for insert to authenticated
    with check (bucket_id = 'site-images' and (storage.foldername(name))[1] = 'staff-profiles'
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and exists (select 1 from public.staff_members m where m.profile_id = (select auth.uid()) and m.status = 'active'))$p$;
end;
$storage$;


-- ─── Notice preferences in the existing email and push paths ────────────────

-- Same as the first release, plus: no email to someone who switched email off.
create or replace function public.staff_roster_notify(
  p_profile uuid, p_kind text, p_dedupe text, p_title text, p_body text, p_link text, p_month date,
  p_deliver_after timestamptz default now()
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_email text;
  v_settings public.staff_roster_settings;
  v_log uuid;
begin
  if p_profile is null then return null; end if;
  insert into public.staff_notifications (recipient_profile_id, kind, dedupe_key, title, body, link, month, deliver_after)
  values (p_profile, p_kind, p_dedupe, left(p_title, 160), left(p_body, 600), p_link, p_month, p_deliver_after)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  select * into v_settings from public.staff_roster_settings where id = 1;
  if coalesce(v_settings.email_notices_enabled, false) and p_deliver_after <= now() then
    begin
      select email into v_email from public.profiles where id = p_profile;
      if exists (select 1 from public.staff_notice_preferences where profile_id = p_profile and not email) then
        update public.staff_notifications set email_status = 'skipped' where id = v_id;
      elsif v_email is null then
        update public.staff_notifications set email_status = 'no_address' where id = v_id;
      elsif to_regprocedure('public.queue_email(text,text,text,text,text,text,text,jsonb)') is not null then
        -- queue_email(type, to, subject, html, text, related_table, related_id, attachments)
        execute 'select public.queue_email($1, $2, $3, $4, $5, $6, $7, $8)'
          into v_log
          using 'staff_roster', v_email, left(p_title, 150),
            '<p>' || replace(replace(left(p_body, 600), '<', '&lt;'), '>', '&gt;') || '</p><p>Open XERT to see the details.</p>',
            left(p_body, 600) || E'\n\nOpen XERT to see the details.', 'staff_notifications', v_id::text, null::jsonb;
        update public.staff_notifications set email_status = case when v_log is null then 'no_address' else 'queued' end, email_log_id = v_log
          where id = v_id;
      else
        update public.staff_notifications set email_status = 'skipped' where id = v_id;
      end if;
    exception when others then
      update public.staff_notifications set email_status = 'failed' where id = v_id;
    end;
  end if;
  return v_id;
end;
$$;

-- Push work for someone who switched push off is recorded as skipped, never
-- sent. Catches every path that adds work (new notice, device added later).
create or replace function public.staff_roster_respect_push_preference()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' and exists (select 1 from public.staff_notice_preferences where profile_id = new.recipient_profile_id and not push) then
    new.status := 'skipped';
    new.reason := 'PUSH_OFF_BY_RECIPIENT';
    new.next_attempt_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists staff_notification_push_preferences on public.staff_notification_push_deliveries;
create trigger staff_notification_push_preferences before insert on public.staff_notification_push_deliveries
  for each row execute function public.staff_roster_respect_push_preference();

create or replace function public.staff_roster_my_notice_preferences()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.staff_roster_current_staff();
  return jsonb_build_object(
    'in_app', true,
    'email', coalesce((select email from public.staff_notice_preferences where profile_id = auth.uid()), true),
    'push', coalesce((select push from public.staff_notice_preferences where profile_id = auth.uid()), true),
    'email_available', coalesce((select email_notices_enabled from public.staff_roster_settings where id = 1), false),
    'account_email', (select email from public.profiles where id = auth.uid()));
end;
$$;

create or replace function public.staff_roster_set_notice_preferences(p_email boolean, p_push boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.staff_roster_current_staff();
  if p_email is null or p_push is null then raise exception 'PREFERENCES_INVALID'; end if;
  insert into public.staff_notice_preferences (profile_id, email, push) values (auth.uid(), p_email, p_push)
  on conflict (profile_id) do update set email = excluded.email, push = excluded.push, updated_at = now();
  return public.staff_roster_my_notice_preferences();
end;
$$;


-- ─── Coach profile (feeds the public Coaches page after manager approval) ───

create or replace function public.staff_roster_profile_json(p_staff public.staff_members)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'draft', (select to_jsonb(d) - 'reviewed_by' from public.staff_profile_drafts d where d.staff_id = p_staff.id),
    'public', (select jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'bio', c.bio, 'experience', c.experience,
        'currently_training_for', c.currently_training_for, 'photo_url', c.photo_url, 'social_url', c.social_url, 'published', c.published)
      from public.coaches c where c.id = p_staff.coach_id));
$$;

create or replace function public.staff_roster_my_profile()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return public.staff_roster_profile_json(public.staff_roster_current_staff());
end;
$$;

-- Saves the coach's draft; `p_submit` sends it to the managers for approval.
create or replace function public.staff_roster_save_profile(p_profile jsonb, p_submit boolean, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_current public.staff_profile_drafts;
  v_photo text := nullif(btrim(coalesce(p_profile->>'photo_url', '')), '');
  v_social text := nullif(btrim(coalesce(p_profile->>'social_url', '')), '');
begin
  v_staff := public.staff_roster_current_staff();
  if jsonb_typeof(p_profile) is distinct from 'object' then raise exception 'PROFILE_INVALID'; end if;
  -- Photos only from this site's own image storage; links only https.
  if v_photo is not null and v_photo !~ '^https://[A-Za-z0-9.-]+/storage/v1/object/public/site-images/[A-Za-z0-9._/-]+$' then raise exception 'PHOTO_INVALID'; end if;
  if v_social is not null and v_social !~ '^https://[^\s<>"]+$' then raise exception 'LINK_INVALID'; end if;
  if p_submit and nullif(btrim(coalesce(p_profile->>'name', '')), '') is null then raise exception 'PROFILE_NAME_REQUIRED'; end if;
  select * into v_current from public.staff_profile_drafts where staff_id = v_staff.id for update;
  if v_current.staff_id is not null and v_current.version <> coalesce(p_expected_version, -1) then raise exception 'STALE_VERSION'; end if;
  insert into public.staff_profile_drafts (staff_id, name, role, bio, experience, currently_training_for, photo_url, social_url, status, submitted_at)
  values (v_staff.id, nullif(btrim(p_profile->>'name'), ''), nullif(btrim(p_profile->>'role'), ''), nullif(btrim(p_profile->>'bio'), ''),
    nullif(btrim(p_profile->>'experience'), ''), nullif(btrim(p_profile->>'currently_training_for'), ''), v_photo, v_social,
    case when p_submit then 'submitted' else 'draft' end, case when p_submit then now() end)
  on conflict (staff_id) do update set name = excluded.name, role = excluded.role, bio = excluded.bio, experience = excluded.experience,
    currently_training_for = excluded.currently_training_for, photo_url = excluded.photo_url, social_url = excluded.social_url,
    status = excluded.status, submitted_at = excluded.submitted_at, review_note = null,
    version = staff_profile_drafts.version + 1, updated_at = now();
  if p_submit then
    perform public.staff_roster_audit('profile_submitted', 'staff', v_staff.id::text, null, null, null);
    perform public.staff_roster_notify_managers('profile_submitted', 'profile:' || v_staff.id::text || ':' || (select version from public.staff_profile_drafts where staff_id = v_staff.id),
      v_staff.display_name || ' updated their coach profile', 'Review it before it appears on the Coaches page.',
      '/admin/roster?rosterTab=coaches&rosterFocus=' || v_staff.id::text, null);
  end if;
  return public.staff_roster_profile_json(v_staff);
end;
$$;

-- Manager: profiles waiting for approval.
create or replace function public.staff_roster_profile_reviews()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_roster_require_manager();
  return coalesce((select jsonb_agg(jsonb_build_object('staff_id', m.id, 'display_name', m.display_name) || public.staff_roster_profile_json(m) order by d.submitted_at)
    from public.staff_profile_drafts d join public.staff_members m on m.id = d.staff_id where d.status = 'submitted'), '[]'::jsonb);
end;
$$;

-- Manager approves (copies the draft onto the website profile, creating and
-- linking one if the coach has none) or sends it back with a note. An
-- existing website profile keeps its own published/hidden setting.
create or replace function public.staff_roster_review_profile(p_staff_id uuid, p_decision text, p_note text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_draft public.staff_profile_drafts;
  v_coach uuid;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  if p_decision not in ('approve', 'reject') then raise exception 'DECISION_INVALID'; end if;
  select * into v_staff from public.staff_members where id = p_staff_id for update;
  if v_staff.id is null then raise exception 'STAFF_NOT_FOUND'; end if;
  select * into v_draft from public.staff_profile_drafts where staff_id = p_staff_id for update;
  if v_draft.staff_id is null or v_draft.status <> 'submitted' then raise exception 'PROFILE_NOT_SUBMITTED'; end if;
  if v_draft.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  if p_decision = 'approve' then
    v_coach := v_staff.coach_id;
    if v_coach is null then
      insert into public.coaches (name, published) values (v_draft.name, true) returning id into v_coach;
      update public.staff_members set coach_id = v_coach, version = version + 1, updated_at = now() where id = p_staff_id;
    end if;
    update public.coaches set name = v_draft.name, role = v_draft.role, bio = v_draft.bio, experience = v_draft.experience,
      currently_training_for = v_draft.currently_training_for, photo_url = v_draft.photo_url, social_url = v_draft.social_url
      where id = v_coach;
  end if;
  update public.staff_profile_drafts set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
    reviewed_at = now(), reviewed_by = auth.uid(), review_note = nullif(btrim(coalesce(p_note, '')), ''), version = version + 1, updated_at = now()
    where staff_id = p_staff_id;
  perform public.staff_roster_audit('profile_' || case when p_decision = 'approve' then 'approved' else 'returned' end, 'staff', p_staff_id::text, null, null,
    jsonb_build_object('coach_id', v_coach), p_note);
  perform public.staff_roster_notify(v_staff.profile_id, 'profile_reviewed', 'profile-review:' || p_staff_id::text || ':' || v_draft.version,
    case when p_decision = 'approve' then 'Your coach profile is approved' else 'Your coach profile needs a change' end,
    case when p_decision = 'approve' then 'The manager approved your profile for the Coaches page.' else 'The manager sent your profile back. Open it to see their note.' end,
    '/coaching?tab=profile', null);
  return public.staff_roster_profile_json((select m from public.staff_members m where m.id = p_staff_id));
end;
$$;


-- ─── Certificates ───────────────────────────────────────────────────────────

create or replace function public.staff_roster_certificate_json(p_cert public.staff_certificates, p_today date)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(p_cert) - 'created_by' - 'updated_by' || jsonb_build_object(
    'state', case when p_cert.expires_on is null then 'no_expiry' when p_cert.expires_on < p_today then 'expired'
      when p_cert.expires_on <= p_today + 30 then 'expiring' else 'current' end,
    'days_left', case when p_cert.expires_on is null then null else p_cert.expires_on - p_today end);
$$;

create or replace function public.staff_roster_my_certificates()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_today date := public.staff_roster_today();
begin
  v_staff := public.staff_roster_current_staff();
  return coalesce((select jsonb_agg(public.staff_roster_certificate_json(c, v_today) order by c.expires_on nulls last, c.created_at)
    from public.staff_certificates c where c.staff_id = v_staff.id and c.archived_at is null), '[]'::jsonb);
end;
$$;

-- Adds (no id) or updates the coach's own certificate.
create or replace function public.staff_roster_save_certificate(p_certificate jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_id uuid := nullif(p_certificate->>'id', '')::uuid;
  v_file text := nullif(btrim(coalesce(p_certificate->>'file_path', '')), '');
  v_row public.staff_certificates;
begin
  v_staff := public.staff_roster_current_staff();
  if v_file is not null and split_part(v_file, '/', 1) <> auth.uid()::text then raise exception 'FILE_INVALID'; end if;
  if v_id is null then
    insert into public.staff_certificates (staff_id, kind, title, number, issued_on, expires_on, file_path, created_by, updated_by)
    values (v_staff.id, p_certificate->>'kind', nullif(btrim(p_certificate->>'title'), ''), nullif(btrim(p_certificate->>'number'), ''),
      nullif(p_certificate->>'issued_on', '')::date, nullif(p_certificate->>'expires_on', '')::date, v_file, auth.uid(), auth.uid())
    returning * into v_row;
  else
    update public.staff_certificates set kind = p_certificate->>'kind', title = nullif(btrim(p_certificate->>'title'), ''),
      number = nullif(btrim(p_certificate->>'number'), ''), issued_on = nullif(p_certificate->>'issued_on', '')::date,
      expires_on = nullif(p_certificate->>'expires_on', '')::date, file_path = v_file, updated_by = auth.uid(), updated_at = now()
    where id = v_id and staff_id = v_staff.id and archived_at is null returning * into v_row;
    if v_row.id is null then raise exception 'CERTIFICATE_NOT_FOUND'; end if;
  end if;
  perform public.staff_roster_audit(case when v_id is null then 'certificate_added' else 'certificate_updated' end, 'staff', v_staff.id::text, null, null,
    jsonb_build_object('certificate_id', v_row.id, 'kind', v_row.kind, 'expires_on', v_row.expires_on));
  return public.staff_roster_certificate_json(v_row, public.staff_roster_today());
exception when check_violation then
  raise exception 'CERTIFICATE_INVALID';
end;
$$;

create or replace function public.staff_roster_remove_certificate(p_certificate_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_row public.staff_certificates;
begin
  v_staff := public.staff_roster_current_staff();
  update public.staff_certificates set archived_at = now(), updated_by = auth.uid(), updated_at = now()
    where id = p_certificate_id and staff_id = v_staff.id and archived_at is null returning * into v_row;
  if v_row.id is null then raise exception 'CERTIFICATE_NOT_FOUND'; end if;
  perform public.staff_roster_audit('certificate_removed', 'staff', v_staff.id::text, null, null, jsonb_build_object('certificate_id', v_row.id));
  return jsonb_build_object('id', v_row.id, 'file_path', v_row.file_path);
end;
$$;

-- Manager: every current certificate, soonest expiry first, plus active
-- coaches with no first aid or CPR on file.
create or replace function public.staff_roster_certificates_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := public.staff_roster_today();
begin
  perform public.staff_roster_require_manager();
  return jsonb_build_object(
    'certificates', coalesce((select jsonb_agg(public.staff_roster_certificate_json(c, v_today) || jsonb_build_object('display_name', m.display_name)
        order by c.expires_on nulls last, m.display_name)
      from public.staff_certificates c join public.staff_members m on m.id = c.staff_id where c.archived_at is null and m.status = 'active'), '[]'::jsonb),
    'missing_first_aid', coalesce((select jsonb_agg(jsonb_build_object('staff_id', m.id, 'display_name', m.display_name) order by m.display_name)
      from public.staff_members m where m.status = 'active' and not exists (
        select 1 from public.staff_certificates c where c.staff_id = m.id and c.archived_at is null and c.kind in ('first_aid', 'cpr')
          and (c.expires_on is null or c.expires_on >= v_today))), '[]'::jsonb));
end;
$$;

-- Expiry reminders: the coach at 60, 30 and 7 days before and on expiry
-- (one notice per step, never repeated), and managers one daily summary while
-- anything is expired or within 30 days. Daytime only (Settings send time).
-- Like the availability reminders it does nothing while the roster is off,
-- and runs from "Send due reminders now" or the optional schedule.
create or replace function public.staff_roster_run_certificate_reminders(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_settings public.staff_roster_settings;
  v_today date := (p_now at time zone 'Australia/Brisbane')::date;
  v_send_minute integer;
  v_queued integer := 0;
  v_row record;
  v_step integer;
  v_count integer;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'MANAGER_ONLY'; end if;
  select * into v_settings from public.staff_roster_settings where id = 1;
  if not coalesce(v_settings.enabled, false) then return 0; end if;
  v_send_minute := coalesce((v_settings.reminders->>'sendMinute')::integer, 540);
  if public.staff_roster_local(v_today, v_send_minute) > p_now then return 0; end if;
  for v_row in
    select c.id, c.kind, c.title, c.expires_on, m.profile_id, c.expires_on - v_today as days_left
    from public.staff_certificates c join public.staff_members m on m.id = c.staff_id
    where c.archived_at is null and m.status = 'active' and m.profile_id is not null
      and c.expires_on is not null and c.expires_on - v_today <= 60
    order by c.expires_on, c.id
  loop
    select min(step) into v_step from unnest(array[0, 7, 30, 60]) step where step >= greatest(v_row.days_left, 0);
    if public.staff_roster_notify(v_row.profile_id, 'certificate_expiring',
      'certificate:' || v_row.id::text || ':' || v_row.expires_on::text || ':' || v_step,
      case when v_row.days_left < 0 then 'Your ' || coalesce(v_row.title, replace(v_row.kind, '_', ' ')) || ' certificate has expired'
        when v_row.days_left = 0 then 'Your ' || coalesce(v_row.title, replace(v_row.kind, '_', ' ')) || ' certificate expires today'
        else 'Your ' || coalesce(v_row.title, replace(v_row.kind, '_', ' ')) || ' certificate expires in ' || v_row.days_left || ' days' end,
      'It expires on ' || to_char(v_row.expires_on, 'FMDD FMMonth YYYY') || '. Renew it and add the new certificate in XERT.',
      '/coaching?tab=profile', null) is not null then
      v_queued := v_queued + 1;
    end if;
  end loop;
  select count(*) into v_count from public.staff_certificates c join public.staff_members m on m.id = c.staff_id
    where c.archived_at is null and m.status = 'active' and c.expires_on is not null and c.expires_on <= v_today + 30;
  if v_count > 0 and not exists (select 1 from public.staff_notifications where dedupe_key like 'certificates:' || v_today::text || ':%') then
    perform public.staff_roster_notify_managers('certificate_summary', 'certificates:' || v_today::text,
      v_count || case when v_count = 1 then ' coach certificate needs' else ' coach certificates need' end || ' renewing',
      'Expired, or expiring within 30 days. See Coach roster → Coaches.', '/admin/roster?rosterTab=coaches', null);
    v_queued := v_queued + 1;
  end if;
  return v_queued;
end;
$$;


-- ─── Class details for the coaches on it ────────────────────────────────────

-- True when the caller is a manager, or an active coach on this class in a
-- published roster.
create or replace function public.staff_roster_on_class(p_session_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  if public.is_admin() then return true; end if;
  v_staff := public.staff_roster_current_staff();
  return exists (select 1 from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published'
    where a.session_id = p_session_id and a.staff_id = v_staff.id);
end;
$$;

-- "Ava S." from "Ava Smith"; one-word names stay as they are.
create or replace function public.staff_roster_short_name(p_full_name text)
returns text language sql immutable set search_path = public as $$
  select case
    when coalesce(btrim(p_full_name), '') = '' then 'Member'
    when btrim(p_full_name) !~ '\s' then btrim(p_full_name)
    else split_part(btrim(p_full_name), ' ', 1) || ' ' || upper(left(regexp_replace(btrim(p_full_name), '^.*\s', ''), 1)) || '.' end;
$$;

-- Headcount, who's booked (first name and last initial only: no contact or
-- health details), waitlist count and the session plan with its history.
create or replace function public.staff_roster_class_detail(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_session public.class_sessions;
  v_people jsonb;
  v_booked integer;
  v_pending integer;
  v_waiting integer;
begin
  if not public.staff_roster_on_class(p_session_id) then raise exception 'NOT_ON_CLASS'; end if;
  select * into v_session from public.class_sessions where id = p_session_id;
  if v_session.id is null then raise exception 'SESSION_NOT_FOUND'; end if;
  with people as (
    select public.staff_roster_short_name(p.full_name) as name, b.status, false as guest, b.created_at
    from public.session_bookings b left join public.profiles p on p.id = b.user_id
    where b.class_session_id = p_session_id and b.status in ('requested', 'confirmed', 'attended', 'no_show')
    union all
    select public.staff_roster_short_name(c.full_name), c.status, coalesce(c.guest_visit, false), c.created_at
    from public.class_bookings c
    where c.class_session_id = p_session_id and c.status in ('confirmed', 'attended', 'no_show')
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'status', status, 'guest', guest) order by created_at), '[]'::jsonb),
    count(*) filter (where status <> 'requested'), count(*) filter (where status = 'requested')
  into v_people, v_booked, v_pending from people;
  select (select count(*) from public.session_bookings where class_session_id = p_session_id and status = 'waitlisted')
    + (select count(*) from public.class_bookings where class_session_id = p_session_id and status = 'waitlisted')
  into v_waiting;
  return jsonb_build_object(
    'session', jsonb_build_object('id', v_session.id, 'title', v_session.title, 'start', v_session.start_time, 'status', v_session.status),
    'capacity', v_session.capacity, 'booked', v_booked, 'pending', v_pending, 'waitlist', v_waiting, 'people', v_people,
    'note', (select jsonb_build_object('id', n.id, 'body', n.body, 'at', n.created_at,
        'by', coalesce((select display_name from public.staff_members where id = n.author_staff_id), (select full_name from public.profiles where id = n.author_profile_id)))
      from public.staff_session_notes n where n.session_id = p_session_id order by n.created_at desc, n.id limit 1),
    'note_history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'body', h.body, 'at', h.created_at,
        'by', coalesce((select display_name from public.staff_members where id = h.author_staff_id), (select full_name from public.profiles where id = h.author_profile_id)))
        order by h.created_at desc)
      from (select * from public.staff_session_notes where session_id = p_session_id order by created_at desc, id offset 1 limit 20) h), '[]'::jsonb));
end;
$$;

-- Adds a new version of the class's plan. `p_expected_note_id` is the version
-- the screen showed (null for none), so two coaches never overwrite unseen.
create or replace function public.staff_roster_save_session_note(p_session_id uuid, p_body text, p_expected_note_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_latest uuid;
  v_staff uuid;
begin
  if not public.staff_roster_on_class(p_session_id) then raise exception 'NOT_ON_CLASS'; end if;
  if char_length(coalesce(p_body, '')) > 4000 then raise exception 'NOTE_TOO_LONG'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xert_session_note:' || p_session_id::text, 0));
  select id into v_latest from public.staff_session_notes where session_id = p_session_id order by created_at desc, id limit 1;
  if v_latest is distinct from p_expected_note_id then raise exception 'STALE_VERSION'; end if;
  select id into v_staff from public.staff_members where profile_id = auth.uid();
  insert into public.staff_session_notes (session_id, body, author_profile_id, author_staff_id) values (p_session_id, coalesce(p_body, ''), auth.uid(), v_staff);
  return public.staff_roster_class_detail(p_session_id);
end;
$$;


-- ─── Hours coached (a summary, not payroll) ─────────────────────────────────

-- This and last Brisbane month, from the published roster: classes, class
-- minutes and duty minutes (class plus set-up and pack-down), split into
-- done so far and still to come. Cancelled classes do not count.
create or replace function public.staff_roster_my_hours()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_this date := date_trunc('month', public.staff_roster_today())::date;
  v_from timestamptz;
  v_to timestamptz;
begin
  v_staff := public.staff_roster_current_staff(true);
  v_from := ((v_this - interval '1 month')::timestamp) at time zone 'Australia/Brisbane';
  v_to := ((v_this + interval '1 month')::timestamp) at time zone 'Australia/Brisbane';
  return coalesce((
    with mine as (
      select distinct s.session_id, s.starts_at, s.ends_at, s.duty
      from public.staff_assignments a
      join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published'
      join public.staff_roster_sessions(v_from, v_to) s on s.session_id = a.session_id
      where a.staff_id = v_staff.id and s.status in ('draft', 'published', 'full')
        and s.starts_at >= v_from and s.starts_at < v_to
    ), months as (
      select m::date as month from (values (v_this - interval '1 month'), (v_this::timestamp)) v(m)
    ), totals as (
      select months.month,
        count(mine.session_id) as classes,
        coalesce(sum(extract(epoch from mine.ends_at - mine.starts_at) / 60), 0)::integer as class_minutes,
        coalesce(sum(extract(epoch from upper(mine.duty) - lower(mine.duty)) / 60), 0)::integer as duty_minutes,
        count(mine.session_id) filter (where mine.ends_at <= now()) as done_classes,
        coalesce(sum(extract(epoch from upper(mine.duty) - lower(mine.duty)) / 60) filter (where mine.ends_at <= now()), 0)::integer as done_duty_minutes
      from months left join mine on public.staff_roster_month_of(mine.starts_at) = months.month
      group by months.month
    )
    select jsonb_agg(to_jsonb(totals) order by totals.month desc) from totals
  ), '[]'::jsonb);
end;
$$;

-- Everything the Home tab needs beyond staff_roster_me, in one call.
create or replace function public.staff_roster_my_dashboard()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_today date := public.staff_roster_today();
begin
  v_staff := public.staff_roster_current_staff();
  return jsonb_build_object(
    'hours', public.staff_roster_my_hours(),
    'certificates', (select jsonb_build_object(
        'count', count(*),
        'first_aid_current', count(*) filter (where kind in ('first_aid', 'cpr') and (expires_on is null or expires_on >= v_today)),
        'expiring', count(*) filter (where expires_on between v_today and v_today + 30),
        'expired', count(*) filter (where expires_on < v_today))
      from public.staff_certificates where staff_id = v_staff.id and archived_at is null),
    'profile', jsonb_build_object(
      'status', (select status from public.staff_profile_drafts where staff_id = v_staff.id),
      'on_website', v_staff.coach_id is not null));
end;
$$;


-- ─── Privileges for the dashboard functions ─────────────────────────────────

do $grants$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'staff_roster_notify', 'staff_roster_respect_push_preference', 'staff_roster_my_notice_preferences', 'staff_roster_set_notice_preferences',
      'staff_roster_profile_json', 'staff_roster_my_profile', 'staff_roster_save_profile', 'staff_roster_profile_reviews', 'staff_roster_review_profile',
      'staff_roster_certificate_json', 'staff_roster_my_certificates', 'staff_roster_save_certificate', 'staff_roster_remove_certificate',
      'staff_roster_certificates_overview', 'staff_roster_run_certificate_reminders', 'staff_roster_on_class', 'staff_roster_short_name',
      'staff_roster_class_detail', 'staff_roster_save_session_note', 'staff_roster_my_hours', 'staff_roster_my_dashboard')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn.signature);
    if v_fn.proname in ('staff_roster_my_notice_preferences', 'staff_roster_set_notice_preferences', 'staff_roster_my_profile',
        'staff_roster_save_profile', 'staff_roster_profile_reviews', 'staff_roster_review_profile', 'staff_roster_my_certificates',
        'staff_roster_save_certificate', 'staff_roster_remove_certificate', 'staff_roster_certificates_overview',
        'staff_roster_run_certificate_reminders', 'staff_roster_class_detail', 'staff_roster_save_session_note',
        'staff_roster_my_hours', 'staff_roster_my_dashboard') then
      execute format('grant execute on function %s to authenticated', v_fn.signature);
    end if;
  end loop;
end;
$grants$;

-- ─── Privileges for the invite functions ────────────────────────────────────

do $grants$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'staff\_roster\_invite\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn.signature);
    if v_fn.proname in ('staff_roster_invite_create', 'staff_roster_invite_revoke', 'staff_roster_invite_list',
                        'staff_roster_invite_preview', 'staff_roster_invite_accept') then
      execute format('grant execute on function %s to authenticated', v_fn.signature);
    end if;
  end loop;
end;
$grants$;

-- Last statement, so a partial run can never look complete.
insert into public.xert_schema_capabilities (capability) values ('staff_roster_coach_dashboard') on conflict (capability) do nothing;
