-- Fail fast instead of queueing behind live traffic for a lock. Safe to re-run
-- if it times out: every statement below is idempotent.
set lock_timeout = '5s';

-- ============================================================================
-- XERT Roster: dependable phone push for staff notices
-- ============================================================================
-- Forward migration on top of 20261001010000_staff_roster.sql (which is
-- applied in production and is never edited). Additive and idempotent. It
-- changes no notice, class, booking or device registration, and the roster
-- stays switched off.
--
-- What it changes:
--   * Every staff notice gets a durable push work item per enabled device the
--     moment it is written ('pending'), whatever created it: a manager or coach
--     action on the web or in the app, a class retimed or cancelled in the
--     Class calendar, or a reminder run. Pushing no longer depends on somebody
--     opening a roster screen afterwards.
--   * Work is leased, not just claimed: lease token, expiry, worker name and
--     attempt count. A result is recorded only by the lease that owns the row,
--     so a late answer from an expired lease never overwrites a newer attempt.
--   * Retryable outcomes go back to 'pending' with bounded exponential backoff
--     (at most 5 attempts). Permanent outcomes stop. An outcome the sender
--     cannot know (the request left but no answer came back) is 'uncertain'
--     and is not resent.
--   * Staleness is decided here, separately from how often the dispatcher
--     runs: a notice is pushed only while it is still true and useful. Work
--     that is too old, superseded by a newer notice or class change, already
--     read in the app, or addressed to someone who lost the permission is
--     closed honestly as 'expired', 'superseded' or 'skipped', never 'accepted'.
--
-- Statuses (staff_notification_push_deliveries.status):
--   pending     waiting for its next attempt (next_attempt_at)
--   sending     leased by a dispatcher (processing)
--   accepted    Apple's push service accepted it (HTTP 200). Not "delivered"
--               and not "read": read_at on the notice stays the only read state.
--   failed      permanent failure for this payload, or retries used up
--   invalid_token  Apple said the device token is no longer valid; the device
--               registration is switched off
--   uncertain   the request may have reached Apple but no answer was recorded;
--               not resent, so the phone shows it at most once from us
--   expired     too old, or the class it is about has started; never sent
--   superseded  a newer notice or change made it untrue; never sent
--   skipped     already read in the app, recipient no longer allowed, or the
--               device was switched off; never sent
-- ============================================================================


-- ─── Work item columns ──────────────────────────────────────────────────────

alter table public.staff_notification_push_deliveries add column if not exists attempts integer not null default 0;
alter table public.staff_notification_push_deliveries add column if not exists next_attempt_at timestamptz;
alter table public.staff_notification_push_deliveries add column if not exists lease_token uuid;
alter table public.staff_notification_push_deliveries add column if not exists lease_expires_at timestamptz;
alter table public.staff_notification_push_deliveries add column if not exists claimed_by text;
alter table public.staff_notification_push_deliveries add column if not exists send_started_at timestamptz;
alter table public.staff_notification_push_deliveries add column if not exists updated_at timestamptz not null default now();
alter table public.staff_notification_push_deliveries alter column status set default 'pending';

alter table public.staff_notification_push_deliveries drop constraint if exists staff_notification_push_status;
alter table public.staff_notification_push_deliveries add constraint staff_notification_push_status
  check (status in ('pending', 'sending', 'accepted', 'failed', 'invalid_token', 'uncertain', 'expired', 'superseded', 'skipped'));
alter table public.staff_notification_push_deliveries drop constraint if exists staff_notification_push_attempts;
alter table public.staff_notification_push_deliveries add constraint staff_notification_push_attempts check (attempts between 0 and 50);

create index if not exists staff_notification_push_open_work
  on public.staff_notification_push_deliveries (status, next_attempt_at)
  where status in ('pending', 'sending');

-- ─── Policy ─────────────────────────────────────────────────────────────────

-- The push policy in one place. Staleness is about the notice, not about how
-- often the dispatcher runs: a dispatcher that is down for a day never sends
-- yesterday's instructions when it comes back.
create or replace function public.staff_roster_push_policy()
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'max_age_hours', 12,      -- never push a notice older than this
    'max_attempts', 5,        -- leases per notice and device, including the first
    'max_backoff_seconds', 3600,
    'legacy_lease_minutes', 10
  );
$$;

-- Why a notice should not be pushed now, or null when it still should.
-- Returns '<status>:<REASON>' with status expired, superseded or skipped.
create or replace function public.staff_roster_push_stale_reason(p_notice public.staff_notifications, p_now timestamptz default now())
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_max_age interval := make_interval(hours => (public.staff_roster_push_policy()->>'max_age_hours')::integer);
  v_session public.class_sessions;
  v_session_id uuid;
  v_start bigint;
  v_end bigint;
begin
  if p_notice.id is null then return 'skipped:NOTICE_MISSING'; end if;
  if p_notice.read_at is not null then return 'skipped:READ_IN_APP'; end if;
  -- Server checks stay authoritative: a manager notice goes only to a current
  -- manager, a coach notice only to a current active coach.
  if coalesce(p_notice.link, '') like '/admin/%' then
    if not exists (select 1 from public.profiles where id = p_notice.recipient_profile_id and role = 'admin') then
      return 'skipped:RECIPIENT_NOT_MANAGER';
    end if;
  elsif not exists (select 1 from public.staff_members where profile_id = p_notice.recipient_profile_id and status = 'active') then
    return 'skipped:RECIPIENT_NOT_ACTIVE_COACH';
  end if;
  if p_now - greatest(p_notice.created_at, p_notice.deliver_after) > v_max_age then return 'expired:TOO_OLD'; end if;

  if p_notice.kind in ('session_retimed', 'session_cancelled') then
    -- dedupe_key = session:<session id>:<kind>:<start epoch>:<end epoch>:<staff id>
    if p_notice.dedupe_key !~ '^session:[0-9a-f-]{36}:(retimed|cancelled):-?[0-9]+:-?[0-9]+:' then return null; end if;
    v_session_id := split_part(p_notice.dedupe_key, ':', 2)::uuid;
    v_start := split_part(p_notice.dedupe_key, ':', 4)::bigint;
    v_end := split_part(p_notice.dedupe_key, ':', 5)::bigint;
    select * into v_session from public.class_sessions where id = v_session_id;
    if v_session.id is null then return 'superseded:CLASS_REMOVED'; end if;
    if to_timestamp(v_start) <= p_now then return 'expired:CLASS_STARTED'; end if;
    if exists (select 1 from public.staff_notifications o
               where o.recipient_profile_id = p_notice.recipient_profile_id and o.id <> p_notice.id
                 and o.kind in ('session_retimed', 'session_cancelled')
                 and o.dedupe_key like 'session:' || v_session_id::text || ':%'
                 and (o.created_at, o.id) > (p_notice.created_at, p_notice.id)) then
      return 'superseded:NEWER_NOTICE';
    end if;
    if p_notice.kind = 'session_cancelled' then
      if v_session.status is distinct from 'cancelled' then return 'superseded:CLASS_RESTORED'; end if;
    elsif v_session.status = 'cancelled' then
      return 'superseded:CLASS_CANCELLED';
    elsif extract(epoch from v_session.start_time)::bigint <> v_start
       or extract(epoch from public.staff_roster_session_end(v_session.start_time, v_session.end_time, v_session.duration_minutes))::bigint <> v_end then
      return 'superseded:CLASS_CHANGED_AGAIN';
    end if;
    return null;
  end if;

  if p_notice.kind = 'availability_reminder' and p_notice.month is not null and exists (
       select 1 from public.staff_availability_submissions s join public.staff_members m on m.id = s.staff_id
       where m.profile_id = p_notice.recipient_profile_id and s.month = p_notice.month) then
    return 'superseded:ALREADY_SUBMITTED';
  end if;
  if p_notice.kind in ('roster_published', 'availability_reminder', 'overdue_summary') and exists (
       select 1 from public.staff_notifications o
       where o.recipient_profile_id = p_notice.recipient_profile_id and o.kind = p_notice.kind and o.id <> p_notice.id
         and o.month is not distinct from p_notice.month and o.deliver_after <= p_now
         and (o.created_at, o.id) > (p_notice.created_at, p_notice.id)) then
    return 'superseded:NEWER_NOTICE';
  end if;
  return null;
end;
$$;

-- When Apple should stop trying to deliver it (apns-expiration): the end of
-- the staleness window, or the class start for a class-change notice.
create or replace function public.staff_roster_push_expires_at(p_notice public.staff_notifications)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  v_limit timestamptz := greatest(p_notice.created_at, p_notice.deliver_after)
    + make_interval(hours => (public.staff_roster_push_policy()->>'max_age_hours')::integer);
begin
  if p_notice.kind in ('session_retimed', 'session_cancelled')
     and p_notice.dedupe_key ~ '^session:[0-9a-f-]{36}:(retimed|cancelled):-?[0-9]+:' then
    return least(v_limit, to_timestamp(split_part(p_notice.dedupe_key, ':', 4)::bigint));
  end if;
  return v_limit;
end;
$$;

-- ─── Durable pending work, written with the notice ──────────────────────────

-- Every new notice gets a 'pending' push row per enabled device of its
-- recipient, in the same transaction as the notice. Never blocks the notice.
create or replace function public.staff_roster_push_enqueue()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if to_regclass('public.push_subscriptions') is null then return new; end if;
  begin
    insert into public.staff_notification_push_deliveries (notification_id, subscription_id, recipient_profile_id, environment, status, next_attempt_at)
    select new.id, s.id, new.recipient_profile_id, s.environment, 'pending', new.deliver_after
    from public.push_subscriptions s
    where s.user_id = new.recipient_profile_id and s.enabled and s.environment in ('sandbox', 'production')
    on conflict (notification_id, subscription_id) do nothing;
  exception when others then
    raise warning 'staff roster push for notice % not queued: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists staff_notifications_push_enqueue on public.staff_notifications;
create trigger staff_notifications_push_enqueue after insert on public.staff_notifications
  for each row execute function public.staff_roster_push_enqueue();

-- ─── Lease ──────────────────────────────────────────────────────────────────

-- Leases due push work to one dispatcher run and returns what to send.
--   p_worker   a short name for the run (logged in claimed_by)
--   p_limit    0 only checks the switch (used while APNs is not configured, so
--              nothing is consumed)
--   p_caller   a signed-in user for the fire-and-forget nudge after a roster
--              action (must be a manager or active coach); null for the
--              scheduler, whose identity the API checked with its own secret
-- Before leasing it (1) recovers expired leases, (2) adds pending rows for
-- devices registered after a still-fresh notice, and (3) closes work that is
-- no longer worth sending. Raises ROSTER_DISABLED while the roster is off and
-- then changes nothing, so pending work waits for the switch.
create or replace function public.staff_roster_push_claim(p_worker text, p_limit integer default 100, p_lease_seconds integer default 180, p_caller uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean;
  v_token uuid := gen_random_uuid();
  v_policy jsonb := public.staff_roster_push_policy();
  v_max_age interval := make_interval(hours => (public.staff_roster_push_policy()->>'max_age_hours')::integer);
  v_lease interval := make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 900)));
  v_row record;
  v_reason text;
  v_rows jsonb;
begin
  if p_caller is not null and not (
    exists (select 1 from public.profiles where id = p_caller and role = 'admin')
    or exists (select 1 from public.staff_members where profile_id = p_caller and status = 'active')
  ) then
    raise exception 'NOT_STAFF';
  end if;
  select enabled into v_enabled from public.staff_roster_settings where id = 1;
  if not coalesce(v_enabled, false) then raise exception 'ROSTER_DISABLED'; end if;
  if coalesce(p_limit, 0) <= 0 or to_regclass('public.push_subscriptions') is null then return '[]'::jsonb; end if;
  if p_worker is null or p_worker !~ '^[A-Za-z0-9:._-]{1,80}$' then raise exception 'WORKER_INVALID'; end if;

  -- One sweep at a time; the lease below also skips rows another run holds.
  perform pg_advisory_xact_lock(hashtextextended('xert_staff_roster_push', 0));

  -- (1) Expired leases. If the send never started, nothing left the server:
  -- the work is pending again. If it started (or the row predates leases),
  -- Apple may have it: 'uncertain', not resent. The lease token is kept so a
  -- late answer from that same lease can still record the truth.
  update public.staff_notification_push_deliveries d set
    status = case when d.send_started_at is null and d.lease_token is not null then 'pending' else 'uncertain' end,
    reason = case when d.send_started_at is null and d.lease_token is not null then 'LEASE_EXPIRED_BEFORE_SEND' else 'LEASE_EXPIRED_AFTER_SEND' end,
    next_attempt_at = case when d.send_started_at is null and d.lease_token is not null then now() else d.next_attempt_at end,
    lease_token = case when d.send_started_at is null and d.lease_token is not null then null else d.lease_token end,
    lease_expires_at = null,
    updated_at = now()
  where d.status = 'sending'
    and coalesce(d.lease_expires_at, d.claimed_at + make_interval(mins => (v_policy->>'legacy_lease_minutes')::integer)) <= now();

  -- (2) Devices registered after a notice that is still fresh.
  insert into public.staff_notification_push_deliveries (notification_id, subscription_id, recipient_profile_id, environment, status, next_attempt_at)
  select n.id, s.id, n.recipient_profile_id, s.environment, 'pending', n.deliver_after
  from public.staff_notifications n
  join public.push_subscriptions s on s.user_id = n.recipient_profile_id and s.enabled and s.environment in ('sandbox', 'production')
  where n.read_at is null and n.deliver_after <= now() and greatest(n.created_at, n.deliver_after) > now() - v_max_age
    and not exists (select 1 from public.staff_notification_push_deliveries d where d.notification_id = n.id and d.subscription_id = s.id)
  on conflict (notification_id, subscription_id) do nothing;

  -- (3) Close work that should no longer be sent, honestly labelled.
  update public.staff_notification_push_deliveries d set status = 'skipped', reason = 'DEVICE_DISABLED', lease_token = null, updated_at = now()
  where d.status = 'pending' and not exists (select 1 from public.push_subscriptions s where s.id = d.subscription_id and s.enabled);
  update public.staff_notification_push_deliveries d set status = 'failed',
    reason = left('RETRIES_EXHAUSTED:' || coalesce(d.reason, 'UNKNOWN'), 200), lease_token = null, updated_at = now()
  where d.status = 'pending' and d.attempts >= (v_policy->>'max_attempts')::integer;
  for v_row in
    select d.id, n as notice from public.staff_notification_push_deliveries d
    join public.staff_notifications n on n.id = d.notification_id
    where d.status = 'pending' and n.deliver_after <= now()
  loop
    v_reason := public.staff_roster_push_stale_reason(v_row.notice);
    if v_reason is not null then
      update public.staff_notification_push_deliveries set status = split_part(v_reason, ':', 1), reason = split_part(v_reason, ':', 2),
        lease_token = null, updated_at = now()
      where id = v_row.id;
    end if;
  end loop;

  -- (4) Lease what is due.
  with picked as (
    select d.id from public.staff_notification_push_deliveries d
    join public.staff_notifications n on n.id = d.notification_id
    where d.status = 'pending' and coalesce(d.next_attempt_at, n.deliver_after) <= now() and n.deliver_after <= now()
      and d.attempts < (v_policy->>'max_attempts')::integer
    order by n.created_at, d.notification_id, d.subscription_id
    limit least(greatest(p_limit, 1), 500)
    for update of d skip locked
  ),
  leased as (
    update public.staff_notification_push_deliveries d set
      status = 'sending', lease_token = v_token, lease_expires_at = now() + v_lease, claimed_by = left(p_worker, 80),
      claimed_at = now(), attempts = d.attempts + 1, send_started_at = null, updated_at = now()
    from picked where d.id = picked.id
    returning d.id, d.notification_id, d.subscription_id, d.environment, d.attempts, d.lease_expires_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'delivery_id', l.id, 'lease_token', v_token, 'lease_expires_at', l.lease_expires_at, 'attempt', l.attempts,
      'notification_id', l.notification_id, 'subscription_id', l.subscription_id, 'environment', l.environment,
      'device_token', s.device_token, 'kind', n.kind, 'link', n.link, 'expires_at', public.staff_roster_push_expires_at(n)
    ) order by n.created_at, l.notification_id, l.subscription_id), '[]'::jsonb)
    into v_rows
  from leased l
  join public.staff_notifications n on n.id = l.notification_id
  join public.push_subscriptions s on s.id = l.subscription_id;
  return v_rows;
end;
$$;

-- Marks leased rows as "about to send", right before the request goes to
-- Apple, and returns the ids the caller still owns. The sender sends only
-- those. If the roster was switched off since the lease, the rows go back to
-- 'pending' unsent (the attempt is not counted) and nothing is returned.
create or replace function public.staff_roster_push_begin(p_leases jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ids jsonb;
begin
  if p_leases is null or jsonb_typeof(p_leases) <> 'array' then raise exception 'LEASES_INVALID'; end if;
  if not coalesce((select enabled from public.staff_roster_settings where id = 1), false) then
    update public.staff_notification_push_deliveries d set status = 'pending', reason = 'ROSTER_DISABLED_BEFORE_SEND',
      attempts = greatest(d.attempts - 1, 0), lease_token = null, lease_expires_at = null, next_attempt_at = now(), updated_at = now()
    from jsonb_to_recordset(p_leases) as r(delivery_id uuid, lease_token uuid)
    where d.id = r.delivery_id and d.lease_token = r.lease_token and d.status = 'sending' and d.send_started_at is null;
    return '[]'::jsonb;
  end if;
  with begun as (
    update public.staff_notification_push_deliveries d set send_started_at = now(), updated_at = now()
    from jsonb_to_recordset(p_leases) as r(delivery_id uuid, lease_token uuid)
    where d.id = r.delivery_id and d.lease_token = r.lease_token and d.status = 'sending'
      and d.lease_expires_at > now() and d.send_started_at is null
    returning d.id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_ids from begun;
  return v_ids;
end;
$$;

-- Records what happened to each send. Only the lease that owns a row can
-- record it (delivery_id + lease_token); anything else is ignored, so a late
-- answer from an expired lease never overwrites a newer attempt. A row the
-- lease recovery marked 'uncertain' still accepts a definite late answer from
-- that same lease.
--   outcome accepted       Apple accepted it (HTTP 200)
--   outcome invalid_token  the device token is invalid: the registration is switched off
--   outcome failed         permanent for this payload; the device is kept
--   outcome retry          temporary; pending again after a backoff, or
--                          'failed' with RETRIES_EXHAUSTED after the last attempt
--   outcome uncertain      the request left but no answer came back; not resent
-- `retry_after_seconds` is the sender's minimum delay for this kind of error;
-- the backoff doubles it per attempt, capped by the policy.
create or replace function public.staff_roster_push_record(p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_policy jsonb := public.staff_roster_push_policy();
  v_recorded integer := 0;
  v_retrying integer := 0;
  v_invalid uuid[];
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then raise exception 'RESULTS_INVALID'; end if;
  with input as (
    select r.delivery_id, r.lease_token, r.outcome, left(r.reason, 200) as reason,
      greatest(1, least(coalesce(r.retry_after_seconds, 60), 3600)) as retry_after
    from jsonb_to_recordset(p_results) as r(delivery_id uuid, lease_token uuid, outcome text, reason text, retry_after_seconds integer)
    where r.outcome in ('accepted', 'invalid_token', 'failed', 'retry', 'uncertain') and r.lease_token is not null
  ),
  updated as (
    update public.staff_notification_push_deliveries d set
      status = case
        when i.outcome = 'retry' and d.attempts >= (v_policy->>'max_attempts')::integer then 'failed'
        when i.outcome = 'retry' then 'pending'
        else i.outcome end,
      reason = case
        when i.outcome = 'retry' and d.attempts >= (v_policy->>'max_attempts')::integer then left('RETRIES_EXHAUSTED:' || coalesce(i.reason, 'UNKNOWN'), 200)
        else i.reason end,
      next_attempt_at = case when i.outcome = 'retry' then now() + make_interval(secs =>
        least(i.retry_after * power(2, greatest(d.attempts - 1, 0)), (v_policy->>'max_backoff_seconds')::integer)) else d.next_attempt_at end,
      lease_token = case when i.outcome = 'retry' then null else d.lease_token end,
      lease_expires_at = null,
      attempted_at = now(),
      updated_at = now()
    from input i
    where d.id = i.delivery_id and d.lease_token = i.lease_token
      and (d.status = 'sending' or (d.status = 'uncertain' and i.outcome in ('accepted', 'invalid_token', 'failed')))
    returning d.subscription_id, d.status
  )
  select count(*), count(*) filter (where status = 'pending'),
    coalesce(array_agg(subscription_id) filter (where status = 'invalid_token'), '{}')
    into v_recorded, v_retrying, v_invalid from updated;
  if cardinality(v_invalid) > 0 and to_regclass('public.push_subscriptions') is not null then
    update public.push_subscriptions set enabled = false where id = any(v_invalid);
  end if;
  return jsonb_build_object('recorded', v_recorded, 'retrying', v_retrying, 'disabled_tokens', cardinality(v_invalid),
    'ignored', jsonb_array_length(p_results) - v_recorded);
end;
$$;

-- Cheap check for the scheduler: is there anything a dispatcher run could
-- send or recover right now? False while the roster is off.
create or replace function public.staff_roster_push_due()
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_max_age interval := make_interval(hours => (public.staff_roster_push_policy()->>'max_age_hours')::integer);
begin
  if not coalesce((select enabled from public.staff_roster_settings where id = 1), false) then return false; end if;
  if to_regclass('public.push_subscriptions') is null then return false; end if;
  return exists (
      select 1 from public.staff_notification_push_deliveries d join public.staff_notifications n on n.id = d.notification_id
      where (d.status = 'pending' and coalesce(d.next_attempt_at, n.deliver_after) <= now() and n.deliver_after <= now())
         or (d.status = 'sending' and d.lease_expires_at <= now()))
    or exists (
      select 1 from public.staff_notifications n
      join public.push_subscriptions s on s.user_id = n.recipient_profile_id and s.enabled
      where n.read_at is null and n.deliver_after <= now() and greatest(n.created_at, n.deliver_after) > now() - v_max_age
        and not exists (select 1 from public.staff_notification_push_deliveries d where d.notification_id = n.id and d.subscription_id = s.id));
end;
$$;

-- ─── The first release's entry points ───────────────────────────────────────

-- The first release's sender claimed with "no row exists yet" and recorded
-- without a lease, so it could never retry or recover. Kept with the same
-- signatures (a deployment still running that code keeps working) but they
-- now claim nothing and record nothing: all sending goes through the leased
-- functions above. The caller and switch checks are unchanged.
create or replace function public.staff_roster_claim_push_deliveries(p_caller uuid, p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_roster_push_claim('retired-claim', 0, 180, coalesce(p_caller, '00000000-0000-0000-0000-000000000000'::uuid));
  return '[]'::jsonb;
end;
$$;

create or replace function public.staff_roster_record_push_results(p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then raise exception 'RESULTS_INVALID'; end if;
  return jsonb_build_object('recorded', 0, 'disabled_tokens', 0);
end;
$$;

-- Activity → Notices: push shown per state, separately from "opened in app".
create or replace function public.staff_roster_notification_log(p_month date default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_roster_require_manager();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'recipient', coalesce(p.full_name, p.email),
      'created_at', n.created_at, 'deliver_after', n.deliver_after, 'read_at', n.read_at,
      'email_status', case when n.email_log_id is not null then coalesce((select l.status from public.email_log l where l.id = n.email_log_id), n.email_status) else n.email_status end,
      'push', (select jsonb_build_object('accepted', count(*) filter (where d.status = 'accepted'),
          'failed', count(*) filter (where d.status in ('failed', 'invalid_token')), 'sending', count(*) filter (where d.status = 'sending'),
          'pending', count(*) filter (where d.status = 'pending'), 'uncertain', count(*) filter (where d.status = 'uncertain'),
          'not_sent', count(*) filter (where d.status in ('expired', 'superseded', 'skipped')))
        from public.staff_notification_push_deliveries d where d.notification_id = n.id)
    ) order by n.created_at desc)
    from (select * from public.staff_notifications where p_month is null or month = p_month order by created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) n
    left join public.profiles p on p.id = n.recipient_profile_id
  ), '[]'::jsonb);
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
    where n.nspname = 'public' and p.proname in (
      'staff_roster_push_policy', 'staff_roster_push_stale_reason', 'staff_roster_push_expires_at', 'staff_roster_push_enqueue',
      'staff_roster_push_claim', 'staff_roster_push_begin', 'staff_roster_push_record', 'staff_roster_push_due',
      'staff_roster_claim_push_deliveries', 'staff_roster_record_push_results')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn.signature);
    if v_fn.proname in ('staff_roster_push_claim', 'staff_roster_push_begin', 'staff_roster_push_record', 'staff_roster_push_due',
                        'staff_roster_claim_push_deliveries', 'staff_roster_record_push_results') then
      execute format('grant execute on function %s to service_role', v_fn.signature);
    end if;
  end loop;
end;
$grants$;

-- Last statement, so a partial run can never look complete.
insert into public.xert_schema_capabilities (capability) values ('staff_roster_push_reliability') on conflict (capability) do nothing;
