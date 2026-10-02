-- Fail fast instead of queueing behind live traffic for a lock. Safe to re-run
-- if it times out: every statement below is idempotent. `local` keeps the
-- setting to this run's transaction (the SQL editor sends the file as one
-- implicit transaction), so it does not linger on the editor's connection.
set local lock_timeout = '5s';

-- ============================================================================
-- XERT Roster: coach invite links
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


-- ─── Privileges ─────────────────────────────────────────────────────────────

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
insert into public.xert_schema_capabilities (capability) values ('staff_roster_coach_invites') on conflict (capability) do nothing;
