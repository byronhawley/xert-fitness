-- XERT Roster: schedule for the phone-push dispatcher.
--
-- NOT A MIGRATION, AND NOT APPLIED. Run by hand in the Supabase SQL editor
-- only with the owner's go-ahead, after:
--   1. 20261001010000_staff_roster.sql and
--      20261002010000_staff_roster_push_reliability.sql are applied
--      (capability 'staff_roster_push_reliability' present);
--   2. the web release containing the leased dispatcher is live on Vercel;
--   3. Vercel has STAFF_PUSH_DISPATCH_SECRET set (or CRON_SECRET): a random
--      value of at least 32 characters, e.g. `openssl rand -hex 32`. It is the
--      scheduler's only identity. Never use a person's session token here;
--   4. the pg_cron and pg_net extensions are enabled (Database → Extensions).
--
-- What it does: every minute, inside the database, it checks
-- staff_roster_push_due() (false while the roster is off, or when nothing is
-- due) and only then makes ONE HTTPS call to
--   POST <site>/api/push-subscription  {"action":"staff_roster_push"}
-- with `Authorization: Bearer <secret>`. The secret and URL are read from
-- Supabase Vault, so they are not stored in the job text or in this repo.
-- Expected latency from a notice to the push request: about 1–2 minutes
-- while the roster is on. Staleness (what is still worth sending) is decided
-- by the database, not by this cadence.
--
-- Vercel Hobby crons run at most once a day, which is not a dependable
-- cadence for class changes; on a Pro plan a Vercel Cron could call
-- GET /api/push-subscription?action=staff_roster_push instead (it sends
-- `Authorization: Bearer <CRON_SECRET>` itself). Use one scheduler, not both
-- (two would be safe — leases stop double sends — just wasteful).

-- ── Activate ────────────────────────────────────────────────────────────────

-- (a) Store the secret and the endpoint in Vault. Replace both placeholders;
--     do not commit the real values anywhere.
select vault.create_secret('<PASTE THE SAME VALUE AS STAFF_PUSH_DISPATCH_SECRET>', 'staff_roster_push_dispatch_secret',
  'Bearer secret for the roster push dispatcher (matches Vercel STAFF_PUSH_DISPATCH_SECRET)');
select vault.create_secret('https://<production site host>/api/push-subscription', 'staff_roster_push_dispatch_url',
  'Roster push dispatcher endpoint');

-- (b) Schedule it. Safe to run again: it replaces a job with the same name.
select cron.schedule(
  'staff-roster-push-dispatch',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'staff_roster_push_dispatch_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'staff_roster_push_dispatch_secret')
    ),
    body := '{"action":"staff_roster_push"}'::jsonb,
    timeout_milliseconds := 55000
  )
  where public.staff_roster_push_due();
  $job$
);

-- Optional, separately approved: scheduled availability reminders (they only
-- write in-app notices; the dispatcher above pushes them).
-- select cron.schedule('staff-roster-reminders', '*/30 * * * *', $$select public.staff_roster_run_reminders()$$);

-- ── Check ───────────────────────────────────────────────────────────────────

-- select jobid, jobname, schedule, active from cron.job where jobname like 'staff-roster-%';
-- select status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'staff-roster-push-dispatch') order by start_time desc limit 20;
-- select id, status_code, left(content::text, 200) from net._http_response order by created desc limit 20;
-- select status, count(*) from public.staff_notification_push_deliveries group by status;

-- ── Deactivate ──────────────────────────────────────────────────────────────

-- Stops all scheduled pushes at once. Pending work stays pending (and is
-- expired by the staleness policy if it waits too long); nothing is deleted.
-- select cron.unschedule('staff-roster-push-dispatch');
-- Then, if retiring it for good, remove the secrets:
-- delete from vault.secrets where name in ('staff_roster_push_dispatch_secret', 'staff_roster_push_dispatch_url');
-- and rotate STAFF_PUSH_DISPATCH_SECRET in Vercel.
