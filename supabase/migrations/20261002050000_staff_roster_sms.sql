-- Fail fast instead of queueing behind live traffic for a lock. Safe to re-run
-- if it times out: every statement below is idempotent. `local` keeps the
-- setting to this run's transaction (the SQL editor sends the file as one
-- implicit transaction), so it does not linger on the editor's connection.
set local lock_timeout = '5s';

-- ============================================================================
-- XERT Roster: text coaches their classes when a roster is published
-- ============================================================================
-- Forward migration on top of 20261001010000_staff_roster.sql,
-- 20261002010000_staff_roster_push_reliability.sql,
-- 20261002020000_staff_roster_coach_dashboard.sql and
-- 20261002040000_staff_roster_part_month.sql (none edited). Additive and
-- idempotent. It changes no existing row, class, booking, notice or
-- assignment, sends nothing by itself, and ships switched OFF
-- (`staff_roster_settings.sms_enabled = false`).
--
-- How it works:
--   * Publishing a roster (staff_roster_publish) or approving cover
--     (staff_roster_approve_cover) makes a revision 'published'. A deferred
--     trigger on staff_roster_revisions runs once at commit, after the
--     publish has written everything, and queues at most one text per coach
--     for that revision in staff_roster_sms_messages. Neither function is
--     copied or replaced. A replayed publish request returns before touching
--     the revision, and (revision_id, staff_id) is unique, so nothing is
--     queued twice.
--   * One rule: each coach converges to a correct text for the month's
--     latest published version. A coach's text is counted from their basis,
--     the version of their last text this month that went out (or is going,
--     or may have gone). No basis: 'published', all their classes from the
--     roster's start day. Otherwise 'changed': just what changed since the
--     basis (added, removed, moved to a new time, or a new role); nothing
--     changed means no text. Waiting texts for older versions are closed as
--     REPLACED_BY_NEWER, and every claim and "Resend failed texts" re-runs
--     the queue, so a version whose queueing was cancelled or timed out at
--     commit is caught up. Texts already sending or sent are never changed.
--   * A coach who opted out, has no linked account, no valid Australian
--     mobile (profiles.phone), or is inactive gets a 'skipped' row with the
--     reason, so the manager can see why and fix it.
--   * Sending is done by the server (api/admin-publish-announcement.js,
--     action 'send_roster_sms', managers only) with the existing Twilio
--     credentials: it leases pending rows with staff_roster_sms_claim, builds
--     the text (src/lib/staffRoster/sms.js is the single source of the
--     wording), sends, and records the outcome with staff_roster_sms_record.
--     Temporary failures are retried, up to 3 attempts. Both functions are
--     for the service role only. The admin roster calls the server right
--     after a publish and again whenever the roster opens with texts still
--     due, so no scheduler or extra secret is needed.
--
-- Rollback: docs/staff-roster/rollback.sql drops the table, the functions
-- (staff_roster_% loop) and removes the capability; the two new columns go
-- with their tables.
-- ============================================================================


-- ─── Switches and preferences ───────────────────────────────────────────────

-- Off until the owner turns it on in Coach roster → Settings.
alter table public.staff_roster_settings add column if not exists sms_enabled boolean not null default false;
-- Absent preference row, or sms = true, means the coach gets texts.
alter table public.staff_notice_preferences add column if not exists sms boolean not null default true;


-- ─── The outbox ─────────────────────────────────────────────────────────────

-- One row per coach per published revision. `details` holds the classes to
-- list (built here, from the gym's clock); `body` is the exact text that was
-- sent, recorded by the sender. `phone` is the E.164 mobile at queue time,
-- refreshed when the row is leased, or null when there is none.
create table if not exists public.staff_roster_sms_messages (
  id uuid primary key default gen_random_uuid(),
  month date not null,
  revision_id uuid not null references public.staff_roster_revisions(id) on delete cascade,
  staff_id uuid not null references public.staff_members(id),
  profile_id uuid references public.profiles(id) on delete set null,
  phone text,
  kind text not null,
  details jsonb not null default '{}'::jsonb,
  body text,
  status text not null default 'pending',
  reason text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed_by text,
  provider_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint staff_roster_sms_once unique (revision_id, staff_id),
  constraint staff_roster_sms_kind check (kind in ('published', 'changed')),
  constraint staff_roster_sms_status check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  constraint staff_roster_sms_phone check (phone is null or phone ~ '^\+614[0-9]{8}$'),
  constraint staff_roster_sms_attempts check (attempts between 0 and 10),
  constraint staff_roster_sms_body check (body is null or char_length(body) <= 1600),
  constraint staff_roster_sms_reason check (reason is null or char_length(reason) <= 300),
  constraint staff_roster_sms_month check (extract(day from month) = 1)
);
create index if not exists staff_roster_sms_due on public.staff_roster_sms_messages (next_attempt_at) where status in ('pending', 'sending');
create index if not exists staff_roster_sms_staff_month on public.staff_roster_sms_messages (staff_id, month, created_at desc);
create index if not exists staff_roster_sms_revision on public.staff_roster_sms_messages (revision_id);

-- Same lockdown as every other staff table: only the functions below.
alter table public.staff_roster_sms_messages enable row level security;
revoke all on table public.staff_roster_sms_messages from public, anon, authenticated;


-- ─── Helpers ────────────────────────────────────────────────────────────────

-- An Australian mobile as E.164, or null. The same rule as e164AUMobile in
-- api/admin-publish-announcement.js and normalizeAUMobile in smsCampaigns.js.
create or replace function public.staff_roster_sms_phone(p_value text)
returns text language sql immutable set search_path = public as $$
  with d as (select regexp_replace(coalesce(p_value, ''), '[^0-9+]', '', 'g') as digits),
  b as (select case when left(digits, 1) = '+' then substr(digits, 2) else digits end as bare from d)
  select case
    when bare ~ '^614[0-9]{8}$' then '+' || bare
    when bare ~ '^04[0-9]{8}$' then '+61' || substr(bare, 2)
  end
  from b;
$$;

-- Where a coach's texts would go: 'ok', 'no_account', 'missing' or 'invalid'.
create or replace function public.staff_roster_sms_mobile_state(p_staff uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_profile uuid;
  v_raw text;
begin
  select profile_id into v_profile from public.staff_members where id = p_staff;
  if v_profile is null then return 'no_account'; end if;
  select phone into v_raw from public.profiles where id = v_profile;
  if nullif(btrim(coalesce(v_raw, '')), '') is null then return 'missing'; end if;
  if public.staff_roster_sms_phone(v_raw) is null then return 'invalid'; end if;
  return 'ok';
end;
$$;

-- Why a coach cannot be texted right now, or null when they can.
create or replace function public.staff_roster_sms_block_reason(p_staff uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_member public.staff_members;
  v_state text;
begin
  select * into v_member from public.staff_members where id = p_staff;
  if v_member.id is null then return 'NO_ACCOUNT'; end if;
  if v_member.status <> 'active' then return 'INACTIVE'; end if;
  if v_member.profile_id is null then return 'NO_ACCOUNT'; end if;
  if exists (select 1 from public.staff_notice_preferences where profile_id = v_member.profile_id and not sms) then return 'OPTED_OUT'; end if;
  v_state := public.staff_roster_sms_mobile_state(p_staff);
  if v_state = 'missing' then return 'NO_MOBILE'; end if;
  if v_state = 'invalid' then return 'MOBILE_INVALID'; end if;
  return null;
end;
$$;

-- The coach's mobile as E.164, or null.
create or replace function public.staff_roster_sms_staff_phone(p_staff uuid)
returns text language sql stable security definer set search_path = public as $$
  select public.staff_roster_sms_phone(p.phone)
  from public.staff_members m join public.profiles p on p.id = m.profile_id
  where m.id = p_staff;
$$;

-- Upcoming, still-running classes of one revision, from `p_from`. Times and
-- titles come from the class itself (what the coach will turn up to);
-- `was_at` is the time recorded when that revision was published.
create or replace function public.staff_roster_sms_lines(p_revision uuid, p_from timestamptz)
returns table (staff_id uuid, session_id uuid, role text, starts_at timestamptz, was_at timestamptz, title text)
language sql stable security definer set search_path = public as $$
  select a.staff_id, a.session_id, a.role, s.starts_at, a.session_start,
    coalesce(nullif(btrim(s.title), ''), nullif(btrim(s.class_type), ''), 'Class')
  from public.staff_assignments a
  join public.staff_roster_sessions(null, null, array(
    select x.session_id from public.staff_assignments x where x.revision_id = p_revision and x.session_id is not null)) s
    on s.session_id = a.session_id
  where a.revision_id = p_revision and s.status in ('draft', 'published', 'full') and s.starts_at >= p_from;
$$;

-- Every upcoming class of one coach in a revision, in time order.
create or replace function public.staff_roster_sms_current(p_staff uuid, p_revision uuid, p_from timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('start', l.starts_at, 'title', l.title, 'role', l.role) order by l.starts_at, l.session_id), '[]'::jsonb)
  from public.staff_roster_sms_lines(p_revision, p_from) l where l.staff_id = p_staff;
$$;

-- What changed for one coach between two revisions: classes added, removed,
-- moved to a new time, or the same class in a new role.
create or replace function public.staff_roster_sms_changes(p_staff uuid, p_base uuid, p_revision uuid, p_from timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with cur as (select * from public.staff_roster_sms_lines(p_revision, p_from) where staff_id = p_staff),
  base as (select * from public.staff_roster_sms_lines(p_base, p_from) where staff_id = p_staff),
  changes as (
    select 1 as rank, 'added' as change, c.starts_at, c.title, c.role, null::timestamptz as was
    from cur c where not exists (select 1 from base b where b.session_id = c.session_id)
    union all
    select 2, 'removed', b.starts_at, b.title, b.role, null
    from base b where not exists (select 1 from cur c where c.session_id = b.session_id)
    union all
    select 3, 'moved', c.starts_at, c.title, c.role, b.was_at
    from cur c join base b on b.session_id = c.session_id where b.was_at is not null and b.was_at <> c.starts_at
    union all
    select 4, 'role', c.starts_at, c.title, c.role, null
    from cur c join base b on b.session_id = c.session_id
    where b.role <> c.role and not (b.was_at is not null and b.was_at <> c.starts_at)
  )
  select coalesce(jsonb_agg(jsonb_build_object('change', change, 'start', starts_at, 'title', title, 'role', role)
      || case when was is null then '{}'::jsonb else jsonb_build_object('was', was) end
    order by rank, starts_at), '[]'::jsonb)
  from changes;
$$;


-- ─── What each coach should be told ─────────────────────────────────────────
--
-- One rule: each coach converges to a correct text for the month's latest
-- published version. A coach's next text is counted from their BASIS: the
-- version of their last text this month that went out, is going out, or may
-- have gone (no answer from the SMS service). With no basis their next text is
-- the full list; with a basis it is just what changed since. Changes made in a
-- version whose queueing was cancelled are never lost, because nothing is
-- counted from a version the coach was not texted about.

-- Where a month's lists start: now, or the part-month start if later.
create or replace function public.staff_roster_sms_from(p_month date)
returns timestamptz language sql stable security definer set search_path = public as $$
  select greatest(now(), coalesce((select public.staff_roster_local(p.starts_on, 0)
    from public.staff_roster_periods p where p.month = p_month), now()));
$$;

-- The version of the coach's last text this month that went out, is going
-- out ('sending') or may have gone ('failed' with no answer: UNCONFIRMED).
-- Null when none did.
create or replace function public.staff_roster_sms_basis(p_staff uuid, p_month date)
returns uuid language sql stable security definer set search_path = public as $$
  select m.revision_id from public.staff_roster_sms_messages m
  join public.staff_roster_revisions r on r.id = m.revision_id
  where m.staff_id = p_staff and m.month = p_month
    and (m.status in ('sending', 'sent') or (m.status = 'failed' and m.reason like 'UNCONFIRMED%'))
  order by r.number desc, m.created_at desc, m.id desc limit 1;
$$;

-- The text a coach should get for a published version, counted from their
-- basis: {kind, lines}, or null when there is nothing to tell (no basis and no
-- classes, or no change since the basis).
create or replace function public.staff_roster_sms_plan(p_staff uuid, p_revision uuid, p_month date, p_from timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_base uuid;
  v_lines jsonb;
begin
  v_base := public.staff_roster_sms_basis(p_staff, p_month);
  if v_base is null then
    v_lines := public.staff_roster_sms_current(p_staff, p_revision, p_from);
    if jsonb_array_length(v_lines) = 0 then return null; end if;
    return jsonb_build_object('kind', 'published', 'lines', v_lines);
  end if;
  v_lines := public.staff_roster_sms_changes(p_staff, v_base, p_revision, p_from);
  if jsonb_array_length(v_lines) = 0 then return null; end if;
  return jsonb_build_object('kind', 'changed', 'lines', v_lines);
end;
$$;

-- The active coaches a published version may concern: those with classes in
-- it, and those with a text this month that went out (or is going or waiting),
-- who may have lost classes since.
create or replace function public.staff_roster_sms_coaches(p_revision uuid, p_from timestamptz)
returns table (staff_id uuid) language sql stable security definer set search_path = public as $$
  select distinct x.staff_id from (
    select l.staff_id from public.staff_roster_sms_lines(p_revision, p_from) l
    union all
    select m.staff_id from public.staff_roster_sms_messages m
    join public.staff_roster_revisions r on r.id = p_revision and r.month = m.month
    where m.status in ('pending', 'sending', 'sent') or (m.status = 'failed' and m.reason like 'UNCONFIRMED%')
  ) x join public.staff_members s on s.id = x.staff_id
  where s.status = 'active';
$$;

-- How many coaches still need a text for a published version that has no row
-- for them (its queueing was cancelled or timed out). "Resend failed texts"
-- queues them.
create or replace function public.staff_roster_sms_unqueued(p_revision uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.staff_roster_revisions r
  cross join lateral public.staff_roster_sms_coaches(r.id, public.staff_roster_sms_from(r.month)) c
  where r.id = p_revision and r.state = 'published'
    and not exists (select 1 from public.staff_roster_sms_messages m where m.revision_id = r.id and m.staff_id = c.staff_id)
    and public.staff_roster_sms_plan(c.staff_id, r.id, r.month, public.staff_roster_sms_from(r.month)) is not null;
$$;


-- ─── Queueing on publish ────────────────────────────────────────────────────

-- Brings one month's texts up to date with its published version. Never
-- sends. Run by the publish trigger, by "Resend failed texts" and by every
-- claim, so a version whose queueing was cancelled is caught up later.
--   (a) Waiting texts for earlier versions are out of date: closed as
--       skipped / REPLACED_BY_NEWER.
--   (b) For each coach it may concern: a waiting text for this version is
--       recounted from the coach's basis (rewritten if it changed, closed as
--       REPLACED_BY_NEWER if nothing is left to tell); a coach with no row for
--       this version who needs a text gets one ('skipped' with the reason
--       when they cannot be texted). Rows already sending, sent, failed or
--       skipped for this version are kept as they are.
-- Idempotent: (revision_id, staff_id) is unique and an up-to-date row is left
-- alone. Waits at most 2 s for the texts lock (it runs at the publish's
-- commit); a lock timeout is caught by staff_roster_sms_on_publish. Lock
-- order is always the roster lock (when held) then the texts lock.
create or replace function public.staff_roster_sms_queue(p_revision uuid)
returns integer language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_rev public.staff_roster_revisions;
  v_settings public.staff_roster_settings;
  v_starts_on date;
  v_from timestamptz;
  v_staff record;
  v_row public.staff_roster_sms_messages;
  v_member public.staff_members;
  v_plan jsonb;
  v_reason text;
  v_id uuid;
  v_queued integer := 0;
begin
  select * into v_rev from public.staff_roster_revisions where id = p_revision;
  if v_rev.id is null or v_rev.state <> 'published' then return 0; end if;
  select * into v_settings from public.staff_roster_settings where id = 1;
  -- Texting off, or the coach screens off (the link would not open): nothing.
  if not (coalesce(v_settings.sms_enabled, false) and coalesce(v_settings.enabled, false)) then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('xert_staff_roster_sms', 0));

  -- Part-month rosters start on starts_on; earlier classes are never listed.
  select p.starts_on into v_starts_on from public.staff_roster_periods p where p.month = v_rev.month;
  v_from := public.staff_roster_sms_from(v_rev.month);

  -- (a) Waiting texts for earlier versions never go: what they say is out of date.
  update public.staff_roster_sms_messages set status = 'skipped', reason = 'REPLACED_BY_NEWER', lease_token = null,
    lease_expires_at = null, next_attempt_at = null, updated_at = now()
  where month = v_rev.month and revision_id <> v_rev.id and status = 'pending';

  -- (b) Each coach this version may concern.
  for v_staff in select c.staff_id from public.staff_roster_sms_coaches(v_rev.id, v_from) c order by c.staff_id loop
    select * into v_row from public.staff_roster_sms_messages where revision_id = v_rev.id and staff_id = v_staff.staff_id;
    -- Sending, sent, failed or skipped for this version: kept as it is.
    if v_row.id is not null and v_row.status <> 'pending' then continue; end if;
    v_plan := public.staff_roster_sms_plan(v_staff.staff_id, v_rev.id, v_rev.month, v_from);

    if v_row.id is not null then
      -- A waiting text for this version: recount it from the coach's basis.
      if v_plan is null then
        update public.staff_roster_sms_messages set status = 'skipped', reason = 'REPLACED_BY_NEWER', lease_token = null,
          lease_expires_at = null, next_attempt_at = null, updated_at = now()
        where id = v_row.id;
      elsif v_row.kind is distinct from v_plan->>'kind' or v_row.details->'lines' is distinct from v_plan->'lines' then
        update public.staff_roster_sms_messages set kind = v_plan->>'kind',
          details = v_row.details || jsonb_build_object('lines', v_plan->'lines'), updated_at = now()
        where id = v_row.id;
      end if;
      continue;
    end if;
    if v_plan is null then continue; end if;

    select * into v_member from public.staff_members where id = v_staff.staff_id;
    v_reason := public.staff_roster_sms_block_reason(v_staff.staff_id);
    -- Older texts that never went out are now out of date (one that may have
    -- gone, UNCONFIRMED, is kept: it is the coach's basis).
    update public.staff_roster_sms_messages set status = 'skipped', reason = 'REPLACED_BY_NEWER', lease_token = null,
      lease_expires_at = null, next_attempt_at = null, updated_at = now()
    where month = v_rev.month and staff_id = v_staff.staff_id and revision_id <> v_rev.id
      and (status = 'skipped' or (status = 'failed' and coalesce(reason, '') not like 'UNCONFIRMED%'))
      and coalesce(reason, '') <> 'REPLACED_BY_NEWER';
    insert into public.staff_roster_sms_messages (month, revision_id, staff_id, profile_id, phone, kind, details, status, reason, next_attempt_at)
    values (v_rev.month, v_rev.id, v_staff.staff_id, v_member.profile_id,
      public.staff_roster_sms_staff_phone(v_staff.staff_id), v_plan->>'kind',
      jsonb_build_object('first_name', split_part(btrim(v_member.display_name), ' ', 1), 'month', v_rev.month,
        'starts_on', v_starts_on, 'revision', v_rev.number, 'lines', v_plan->'lines'),
      case when v_reason is null then 'pending' else 'skipped' end, v_reason,
      case when v_reason is null then now() end)
    on conflict (revision_id, staff_id) do nothing
    returning id into v_id;
    if v_id is not null and v_reason is null then v_queued := v_queued + 1; end if;
  end loop;
  return v_queued;
end;
$$;

-- Runs at commit (deferred), after the publish or cover approval has written
-- the revision's assignments. A problem here never undoes the publish: a
-- cancel or statement timeout that lands while texts are queued is caught too
-- (`others` does not cover query_canceled). Texts it did not queue are
-- caught up by the next claim (every send run, e.g. right after the next
-- publish) or by "Resend failed texts", both of which re-run the queue for the
-- month's published version.
create or replace function public.staff_roster_sms_on_publish()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.staff_roster_sms_queue(new.id);
  exception when query_canceled or others then
    raise warning 'roster texts for revision % not queued: % (%)', new.id, sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists staff_roster_revisions_sms on public.staff_roster_revisions;
create constraint trigger staff_roster_revisions_sms
  after insert or update of state on public.staff_roster_revisions
  deferrable initially deferred
  for each row when (new.state = 'published')
  execute function public.staff_roster_sms_on_publish();


-- ─── Sending (service role only) ────────────────────────────────────────────

-- Leases up to `p_limit` texts that are due. Before leasing it (1) returns
-- expired leases to pending (or failed after the last attempt), (2) brings
-- each month that has texts up to date with its published version
-- (staff_roster_sms_queue: out-of-date waiting texts closed as
-- REPLACED_BY_NEWER, the version's own text recounted from each coach's last
-- text that went out, and any coach who needs a text and has none queued),
-- and (3) re-checks each pending coach (opted out since, deactivated, mobile
-- removed) and refreshes the number. A coach's later text waits until their
-- earlier one is done, so texts arrive in order. Returns [] while texting is
-- switched off. It takes only the texts lock (never the roster lock), the
-- same order a publish uses: roster lock, then texts lock.
create or replace function public.staff_roster_sms_claim(p_limit integer default 20, p_worker text default 'api')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_token uuid := gen_random_uuid();
  v_settings public.staff_roster_settings;
  v_row record;
  v_reason text;
  v_rows jsonb;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9:._-]{1,80}$' then raise exception 'WORKER_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xert_staff_roster_sms', 0));

  -- (1) Expired leases. The lease token is kept so a late answer from that
  -- same send can still record 'sent' and stop a second text.
  update public.staff_roster_sms_messages set
    status = case when attempts >= 3 then 'failed' else 'pending' end,
    reason = case when attempts >= 3 then 'RETRIES_EXHAUSTED:LEASE_EXPIRED' else 'LEASE_EXPIRED' end,
    lease_expires_at = null, next_attempt_at = case when attempts >= 3 then null else now() end, updated_at = now()
  where status = 'sending' and lease_expires_at <= now();

  select * into v_settings from public.staff_roster_settings where id = 1;
  if not (coalesce(v_settings.sms_enabled, false) and coalesce(v_settings.enabled, false)) then return '[]'::jsonb; end if;
  if coalesce(p_limit, 0) <= 0 then return '[]'::jsonb; end if;

  -- (2) Each month with texts, up to date with its published version. Months
  -- that never had a text (published while texting was off) are left alone;
  -- "Resend failed texts" covers those. Past months are skipped once they
  -- have nothing waiting.
  for v_row in
    select r.id from public.staff_roster_revisions r
    where r.state = 'published'
      and exists (select 1 from public.staff_roster_sms_messages m where m.month = r.month)
      and (r.month + interval '1 month 1 day' > now()
        or exists (select 1 from public.staff_roster_sms_messages m where m.month = r.month and m.status = 'pending'))
    order by r.month
  loop
    perform public.staff_roster_sms_queue(v_row.id);
  end loop;

  -- (3) Re-check who is still textable, with today's number.
  for v_row in select id, staff_id from public.staff_roster_sms_messages where status = 'pending' loop
    v_reason := public.staff_roster_sms_block_reason(v_row.staff_id);
    if v_reason is not null then
      update public.staff_roster_sms_messages set status = 'skipped', reason = v_reason, lease_token = null, next_attempt_at = null, updated_at = now()
      where id = v_row.id;
    else
      update public.staff_roster_sms_messages set phone = public.staff_roster_sms_staff_phone(v_row.staff_id)
      where id = v_row.id and phone is distinct from public.staff_roster_sms_staff_phone(v_row.staff_id);
    end if;
  end loop;
  update public.staff_roster_sms_messages set status = 'failed', reason = left('RETRIES_EXHAUSTED:' || coalesce(reason, 'UNKNOWN'), 300),
    lease_token = null, next_attempt_at = null, updated_at = now()
  where status = 'pending' and attempts >= 3;

  -- (4) Lease what is due.
  with picked as (
    select m.id from public.staff_roster_sms_messages m
    where m.status = 'pending' and coalesce(m.next_attempt_at, m.created_at) <= now() and m.attempts < 3 and m.phone is not null
      and not exists (select 1 from public.staff_roster_sms_messages o
        where o.staff_id = m.staff_id and o.month = m.month and o.created_at < m.created_at and o.status in ('pending', 'sending'))
    order by m.created_at, m.id
    limit least(greatest(p_limit, 1), 100)
    for update of m skip locked
  ),
  leased as (
    update public.staff_roster_sms_messages m set status = 'sending', lease_token = v_token,
      lease_expires_at = now() + interval '120 seconds', claimed_by = left(p_worker, 80), attempts = m.attempts + 1, updated_at = now()
    from picked where m.id = picked.id
    returning m.id, m.staff_id, m.month, m.phone, m.kind, m.details, m.attempts, m.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'lease_token', v_token, 'staff_id', l.staff_id, 'month', l.month,
      'phone', l.phone, 'kind', l.kind, 'details', l.details, 'attempt', l.attempts) order by l.created_at, l.id), '[]'::jsonb)
    into v_rows
  from leased l;
  return v_rows;
end;
$$;

-- Records one send. Only the lease that owns the row can record it. A
-- temporary failure (`p_retryable`) goes back to pending after a short wait,
-- until the third attempt, then 'failed'. `p_body` is the exact text sent.
create or replace function public.staff_roster_sms_record(
  p_id uuid, p_lease_token uuid, p_ok boolean, p_provider_id text, p_error text,
  p_retryable boolean default false, p_body text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  if p_id is null or p_lease_token is null or p_ok is null then raise exception 'RESULT_INVALID'; end if;
  update public.staff_roster_sms_messages m set
    status = case when p_ok then 'sent' when coalesce(p_retryable, false) and m.attempts < 3 then 'pending' else 'failed' end,
    reason = case
      when p_ok then null
      when coalesce(p_retryable, false) and m.attempts < 3 then left(coalesce(p_error, 'TEMPORARY_FAILURE'), 300)
      when coalesce(p_retryable, false) then left('RETRIES_EXHAUSTED:' || coalesce(p_error, 'TEMPORARY_FAILURE'), 300)
      else left(coalesce(p_error, 'FAILED'), 300) end,
    provider_id = case when p_ok then left(p_provider_id, 64) else m.provider_id end,
    body = coalesce(left(p_body, 1600), m.body),
    sent_at = case when p_ok then now() else m.sent_at end,
    next_attempt_at = case when not p_ok and coalesce(p_retryable, false) and m.attempts < 3
      then now() + make_interval(secs => 2 * m.attempts) else null end,
    lease_token = case when p_ok then m.lease_token else null end,
    lease_expires_at = null,
    updated_at = now()
  where m.id = p_id and m.lease_token = p_lease_token
    and (m.status = 'sending' or (m.status = 'pending' and p_ok))
  returning m.status into v_status;
  return jsonb_build_object('recorded', v_status is not null, 'status', v_status);
end;
$$;


-- ─── Manager screens ────────────────────────────────────────────────────────

-- Texting state for the roster screens. With a month: the texts for its
-- current published version. Always: each coach's mobile state, and whether
-- any text anywhere is still waiting to go (`due`).
create or replace function public.staff_roster_sms_status(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_settings public.staff_roster_settings;
  v_rev public.staff_roster_revisions;
begin
  perform public.staff_roster_require_manager();
  select * into v_settings from public.staff_roster_settings where id = 1;
  if p_month is not null then
    select * into v_rev from public.staff_roster_revisions where month = p_month and state = 'published';
  end if;
  return jsonb_build_object(
    'enabled', coalesce(v_settings.sms_enabled, false),
    'roster_enabled', coalesce(v_settings.enabled, false),
    'due', exists (select 1 from public.staff_roster_sms_messages
      where (status = 'pending' and attempts < 3) or (status = 'sending' and lease_expires_at <= now())),
    'revision', case when v_rev.id is null then null else jsonb_build_object('id', v_rev.id, 'number', v_rev.number, 'published_at', v_rev.published_at) end,
    'counts', (select jsonb_build_object(
        'sent', count(*) filter (where status = 'sent'), 'pending', count(*) filter (where status in ('pending', 'sending')),
        'failed', count(*) filter (where status = 'failed'), 'skipped', count(*) filter (where status = 'skipped'))
      from public.staff_roster_sms_messages where revision_id = v_rev.id),
    -- Texts for the published version that failed or were skipped for a
    -- missing or wrong mobile, plus coaches it never queued a text for.
    'retryable', (select count(*) from public.staff_roster_sms_messages m
      where m.revision_id = v_rev.id and (m.status = 'failed' or (m.status = 'skipped' and m.reason in ('NO_MOBILE', 'MOBILE_INVALID', 'NO_ACCOUNT'))))
      + case when coalesce(v_settings.sms_enabled and v_settings.enabled, false) and v_rev.id is not null
          then public.staff_roster_sms_unqueued(v_rev.id) else 0 end,
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'staff_id', m.staff_id, 'name', s.display_name, 'kind', m.kind,
        'status', m.status, 'reason', m.reason, 'attempts', m.attempts, 'sent_at', m.sent_at, 'updated_at', m.updated_at)
        order by s.display_name, m.id), '[]'::jsonb)
      from public.staff_roster_sms_messages m join public.staff_members s on s.id = m.staff_id where m.revision_id = v_rev.id),
    'coaches', (select coalesce(jsonb_agg(jsonb_build_object('staff_id', s.id, 'mobile', public.staff_roster_sms_mobile_state(s.id)) order by s.display_name, s.id), '[]'::jsonb)
      from public.staff_members s)
  );
end;
$$;

-- The "Text coaches when you publish" switch. Switching it off also stops
-- texts still waiting to go.
create or replace function public.staff_roster_sms_set_enabled(p_enabled boolean, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_before public.staff_roster_settings;
  v_after public.staff_roster_settings;
  v_stopped integer := 0;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  if p_enabled is null then raise exception 'PREFERENCES_INVALID'; end if;
  select * into v_before from public.staff_roster_settings where id = 1 for update;
  if v_before.version <> p_expected_version then raise exception 'STALE_VERSION'; end if;
  update public.staff_roster_settings set sms_enabled = p_enabled, version = version + 1, updated_by = auth.uid(), updated_at = now()
  where id = 1 returning * into v_after;
  if not p_enabled then
    update public.staff_roster_sms_messages set status = 'skipped', reason = 'SMS_SWITCHED_OFF', lease_token = null,
      next_attempt_at = null, updated_at = now()
    where status = 'pending';
    get diagnostics v_stopped = row_count;
  end if;
  perform public.staff_roster_audit(case when p_enabled then 'sms_switched_on' else 'sms_switched_off' end, 'settings', '1', null,
    jsonb_build_object('sms_enabled', v_before.sms_enabled), jsonb_build_object('sms_enabled', v_after.sms_enabled, 'stopped', v_stopped));
  return to_jsonb(v_after) - 'updated_by';
end;
$$;

-- "Resend failed texts": first re-run the queue for the month's published
-- version (staff_roster_sms_queue), so every coach whose last text is out of
-- date, or who was never texted, gets one counted from what they were last
-- sent; then each text for that version that failed, or was skipped for a
-- missing or wrong mobile, is checked again (with the coach's number as it is
-- now) and queued. Sending happens on the next run.
create or replace function public.staff_roster_sms_retry(p_month date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_rev uuid;
  v_row record;
  v_reason text;
  v_queued integer := 0;
  v_still integer := 0;
begin
  perform public.staff_roster_require_manager();
  perform public.staff_roster_lock();
  perform public.staff_roster_month_param(p_month);
  if not coalesce((select sms_enabled and enabled from public.staff_roster_settings where id = 1), false) then raise exception 'SMS_DISABLED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xert_staff_roster_sms', 0));
  select id into v_rev from public.staff_roster_revisions where month = p_month and state = 'published';
  if v_rev is not null then v_queued := public.staff_roster_sms_queue(v_rev); end if;
  for v_row in
    select m.id, m.staff_id from public.staff_roster_sms_messages m
    where m.revision_id = v_rev and (m.status = 'failed' or (m.status = 'skipped' and m.reason in ('NO_MOBILE', 'MOBILE_INVALID', 'NO_ACCOUNT')))
    order by m.created_at, m.id
  loop
    v_reason := public.staff_roster_sms_block_reason(v_row.staff_id);
    if v_reason is null then
      update public.staff_roster_sms_messages set status = 'pending', reason = null, attempts = 0, next_attempt_at = now(),
        phone = public.staff_roster_sms_staff_phone(v_row.staff_id), lease_token = null, lease_expires_at = null, updated_at = now()
      where id = v_row.id;
      v_queued := v_queued + 1;
    else
      update public.staff_roster_sms_messages set status = 'skipped', reason = v_reason, updated_at = now() where id = v_row.id;
      v_still := v_still + 1;
    end if;
  end loop;
  perform public.staff_roster_audit('sms_retried', 'month', p_month::text, p_month, null, jsonb_build_object('queued', v_queued, 'still_skipped', v_still));
  return jsonb_build_object('queued', v_queued, 'still_skipped', v_still);
end;
$$;


-- ─── Coach preferences ──────────────────────────────────────────────────────

-- Same as 20261002020000's version, plus text messages: the coach's choice,
-- whether the gym has texting on, and where texts would go (last 3 digits).
create or replace function public.staff_roster_my_notice_preferences()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff public.staff_members;
  v_phone text;
begin
  v_staff := public.staff_roster_current_staff();
  v_phone := public.staff_roster_sms_staff_phone(v_staff.id);
  return jsonb_build_object(
    'in_app', true,
    'email', coalesce((select email from public.staff_notice_preferences where profile_id = auth.uid()), true),
    'push', coalesce((select push from public.staff_notice_preferences where profile_id = auth.uid()), true),
    'sms', coalesce((select sms from public.staff_notice_preferences where profile_id = auth.uid()), true),
    'email_available', coalesce((select email_notices_enabled from public.staff_roster_settings where id = 1), false),
    'sms_available', coalesce((select sms_enabled from public.staff_roster_settings where id = 1), false),
    'mobile_state', public.staff_roster_sms_mobile_state(v_staff.id),
    'mobile_ending', case when v_phone is null then null else right(v_phone, 3) end,
    'account_email', (select email from public.profiles where id = auth.uid()));
end;
$$;

-- Texts on or off for the signed-in coach. Off also stops texts still waiting.
create or replace function public.staff_roster_set_sms_preference(p_sms boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.staff_roster_current_staff();
  if p_sms is null then raise exception 'PREFERENCES_INVALID'; end if;
  insert into public.staff_notice_preferences (profile_id, sms) values (auth.uid(), p_sms)
  on conflict (profile_id) do update set sms = excluded.sms, updated_at = now();
  if not p_sms then
    update public.staff_roster_sms_messages set status = 'skipped', reason = 'OPTED_OUT', lease_token = null, next_attempt_at = null, updated_at = now()
    where staff_id = v_staff.id and status = 'pending';
  end if;
  return public.staff_roster_my_notice_preferences();
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
    where n.nspname = 'public' and (p.proname like 'staff\_roster\_sms\_%'
      or p.proname in ('staff_roster_my_notice_preferences', 'staff_roster_set_sms_preference'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn.signature);
    if v_fn.proname in ('staff_roster_sms_status', 'staff_roster_sms_set_enabled', 'staff_roster_sms_retry',
                        'staff_roster_my_notice_preferences', 'staff_roster_set_sms_preference') then
      execute format('grant execute on function %s to authenticated', v_fn.signature);
    elsif v_fn.proname in ('staff_roster_sms_claim', 'staff_roster_sms_record') then
      execute format('grant execute on function %s to service_role', v_fn.signature);
    end if;
  end loop;
end;
$grants$;

-- Last statement, so a partial run can never look complete.
insert into public.xert_schema_capabilities (capability) values ('staff_roster_sms') on conflict (capability) do nothing;
