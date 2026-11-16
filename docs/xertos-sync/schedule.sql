-- XertOS class sync: turning it on.
--
-- NOT A MIGRATION, AND NOT APPLIED. Run by hand in the Supabase SQL editor
-- only with the owner's go-ahead, after:
--   1. 20261004010000_xertos_class_sync.sql is applied;
--   2. XertOS has XERT Fitness connected (PUT /v1/connected-sites/xert_fitness
--      with timetable "site", writeUrl https://www.xertfitness.com.au/api/xertos-webhook,
--      status "active"), which shows the write secret once;
--   3. Vercel has, for Production:
--        XERTOS_API_URL               the XertOS API, https://…
--        XERTOS_CLIENT_ID             a XertOS service credential from the
--                                     "Connected site" preset (sites.sync, schedule.read, training.read)
--        XERTOS_CLIENT_SECRET         and its secret
--        XERTOS_WRITE_SECRET          the write secret XertOS showed in step 2
--        XERTOS_WRITE_SECRET_VERSION  its version (writeSecretVersion in XertOS)
--      (XERTOS_SITE_SECRET is no longer needed: /api/xertos-webhook checks the
--      signature once, with the versioned write secrets, and during a rotation
--      XERTOS_PREVIOUS_WRITE_SECRET(_VERSION) keep the old one working.)
--        XERTOS_SYNC_DISPATCH_SECRET  a random value of at least 32 characters
--                                     (openssl rand -hex 32), the scheduler's only identity
--      and the release containing src/lib/xertosSync.js is live;
--   4. pg_cron and pg_net are enabled (they already are for the roster);
--   5. XertOS's connection test passes: POST /v1/connected-sites/xert_fitness/test
--      answers ok: true, which proves the write URL and secret match.
--
-- Checking on it: Admin → Operations health → "XertOS class sync" shows both
-- sides at once: XertOS's own view of the link (GET /v1/connected-sites/
-- xert_fitness/status) and what is waiting to send here, with what to fix.
--
-- What it does: every minute, only when xertos_sync_due() says a class has
-- changed, ONE HTTPS call sends the changes to XertOS. Once a day at 3:10 am
-- Brisbane time it sends the next four weeks as a complete list, so anything
-- missed heals itself; if that list doesn't reach XertOS, the minute job tries
-- again hourly until it does. XERT Fitness stays in charge: XertOS only mirrors.
--
-- Forms too (20261116010000_xertos_forms_sync.sql): the same minute job fires
-- when a form response hasn't been confirmed by XertOS, and the dispatcher
-- sends it (POST /v1/connected-sites/xert_fitness/forms/sync). Anything not
-- ticked off in xertos_form_sent goes again, so a missed one heals itself.
-- Check: select count(*) from public.xert_form_responses r where not exists
--   (select 1 from public.xertos_form_sent s where s.response_id = r.id);
--   select forms_last_sent_at, forms_next_attempt_at, forms_last_error from public.xertos_sync_settings;

-- ── Activate ────────────────────────────────────────────────────────────────

-- (a) Secrets in Vault. Replace the placeholders; never commit real values.
select vault.create_secret('<PASTE THE SAME VALUE AS XERTOS_SYNC_DISPATCH_SECRET>', 'xertos_sync_dispatch_secret',
  'Bearer secret for the XertOS class sync dispatcher (matches Vercel XERTOS_SYNC_DISPATCH_SECRET)');
select vault.create_secret('https://www.xertfitness.com.au/api/xertos/dispatch', 'xertos_sync_dispatch_url',
  'XertOS class sync dispatcher endpoint');

-- (b) Start queueing changes.
update public.xertos_sync_settings set enabled = true, updated_at = now() where id;

-- (c) Schedule it. Safe to run again: each replaces a job with the same name.
select cron.schedule(
  'xertos-class-sync',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'xertos_sync_dispatch_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'xertos_sync_dispatch_secret')
    ),
    body := '{"action":"push"}'::jsonb,
    timeout_milliseconds := 55000
  )
  where public.xertos_sync_due();
  $job$
);

select cron.schedule(
  'xertos-class-sync-window',
  '10 17 * * *', -- 17:10 UTC is 3:10 am in Brisbane
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'xertos_sync_dispatch_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'xertos_sync_dispatch_secret')
    ),
    body := '{"action":"window"}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);

-- (d) First fill: run the window job once now instead of waiting for 3 am.
-- select cron.alter_job((select jobid from cron.job where jobname = 'xertos-class-sync-window'), schedule := '* * * * *');
-- …wait a minute, check below, then put it back:
-- select cron.alter_job((select jobid from cron.job where jobname = 'xertos-class-sync-window'), schedule := '10 17 * * *');

-- ── Check ───────────────────────────────────────────────────────────────────

-- select enabled, window_sent_at, window_tried_at from public.xertos_sync_settings;
-- select count(*) filter (where sent_changed_at is distinct from changed_at) as waiting,
--        max(last_error) as last_error, max(sent_at) as last_sent
--   from public.xertos_class_outbox;
-- select id, status_code, left(content::text, 300) from net._http_response order by created desc limit 20;
-- select request_id, action, session_id, created_at from public.xertos_edit_receipts order by created_at desc limit 20;

-- ── Deactivate ──────────────────────────────────────────────────────────────

-- Stops sending and refuses XertOS's edits at once. Nothing is deleted, and the
-- XERT timetable is untouched.
-- update public.xertos_sync_settings set enabled = false, updated_at = now() where id;
-- select cron.unschedule('xertos-class-sync');
-- select cron.unschedule('xertos-class-sync-window');
