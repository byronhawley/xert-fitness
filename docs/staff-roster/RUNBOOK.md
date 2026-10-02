# XERT Roster — migrate, enable, operate, roll back

`20261001010000_staff_roster.sql` was applied in production on 2026-10-01
(SQL editor, 20:46 UTC) and the roster is OFF. Nothing else here has been run
against the live XERT database. Each production step needs the owner's
separate go-ahead.

## What ships

| Piece | Where |
| --- | --- |
| Schema, rules, permissions | `supabase/migrations/20261001010000_staff_roster.sql` (additive; **applied in production 2026-10-01, never edit**) |
| Dependable phone push | `supabase/migrations/20261002010000_staff_roster_push_reliability.sql` (forward migration, additive, idempotent; applied in production 2026-10-02 01:46 UTC) |
| Coach invite links + coach dashboard | `supabase/migrations/20261002020000_staff_roster_coach_dashboard.sql` (forward migration, additive, idempotent; not yet applied) |
| Part-month roster periods | `supabase/migrations/20261002040000_staff_roster_part_month.sql` (forward migration, additive, idempotent; not yet applied) |
| Roster texts | `supabase/migrations/20261002050000_staff_roster_sms.sql` (forward migration, additive, idempotent; not yet applied) |
| Roster fixes | `supabase/migrations/20261002060000_staff_roster_fixes.sql` (forward migration, additive, idempotent; not yet applied; after 040000 and 050000) |
| Push scheduler (not a migration) | `docs/staff-roster/push-dispatch-schedule.sql` (pg_cron + pg_net + Vault; activate only with approval) |
| Manager screens | Command Centre → Classes → **Coach roster** (`/admin/roster`) |
| Coach screens | `/coaching` (website and the app's web views; staff link, no membership needed). Opens on **Home** (setup checklist, next classes, shortcuts); older `?tab=` links open the same tabs as before |
| Coach invite page | `/coach-invite#token=…` (public route; the token is in the URL fragment, so it never reaches a server log) |
| Release gate | `staff_roster`, `staff_roster_push_reliability`, `staff_roster_coach_dashboard`, `staff_roster_part_month`, `staff_roster_sms` and `staff_roster_fixes` in `schemaCapabilities.js`, `src/supabase/release_readiness_check.sql`, `codemagic.yaml` |
| Full removal script | `docs/staff-roster/rollback.sql` (manual, not a migration) |

The migration does not change bookings, waitlists, attendance, payments,
FitBox or any existing row. It adds two nullable columns to
`class_sessions` (`series_id`, `series_occurrence_date`) for repeating
classes, and one after-update trigger that only queues roster notices when the
feature is on.

## 1. Apply the migration (needs approval)

1. Take a database backup, or confirm point-in-time recovery is on.
2. Apply `20261001010000_staff_roster.sql` in the Supabase **SQL editor only**,
   pasting the whole file. Do **not** use `supabase db push`: production's
   migration ledger is missing about 50 of the repo's migrations, so a push
   would try to replay them. The file starts with
   `set lock_timeout = '5s';` so it fails fast rather than queueing behind
   live traffic for a lock on `class_sessions`; it is idempotent, so if it
   times out, run it again at a quieter moment. It needs `queue_email` with
   the 8-argument signature from `20260924010000` (already in production) only
   when roster emails are switched on.
3. Check: `select * from public.xert_schema_capabilities where capability = 'staff_roster';`
   returns one row, and `select enabled from public.staff_roster_settings;`
   returns `false`.
4. Run `src/supabase/release_readiness_check.sql`. `staff_roster` must show as
   installed.

### 1a. Apply the push reliability migration (needs approval)

`20261002010000_staff_roster_push_reliability.sql` goes on top of the applied
first release, the same way: SQL editor only, whole file, backup first. It
starts with `set local lock_timeout = '5s'` (scoped to the run, so it does
not linger on the editor's connection), is idempotent (safe to re-run after a
timeout), runs as one implicit transaction in the SQL editor (a failure part
way leaves nothing behind; run the whole file at once, never statement by
statement, or the lock timeout does not apply), and records `staff_roster_push_reliability` as its
**last** statement, so a partial run can never look installed. It adds columns
and a status check to `staff_notification_push_deliveries` (empty while the
roster is off), one after-insert trigger on `staff_notifications`, and
service-role-only functions. It touches no class, booking, device or notice.
Check: `select capability from public.xert_schema_capabilities where capability like 'staff_roster%';`
returns both rows.

**Order matters for releases.** The web build (Operations Health) and the
Codemagic gate require `staff_roster` **and** `staff_roster_push_reliability`.
Apply `20261002010000` **before** deploying the web release that contains it,
and before any app build from it, or the gates will (correctly) report it
missing. The release still deployed from `d4b10bc` keeps working after the
migration: its old push calls now claim nothing (it simply stops pushing),
and with the roster off it never got that far anyway.

Rollout with the feature OFF: (1) apply `20261002010000`; (2) deploy the web
release; (3) set `STAFF_PUSH_DISPATCH_SECRET` in Vercel; (4) with approval,
activate the schedule (`push-dispatch-schedule.sql`); (5) only then, with
approval, switch the roster on.

Until it is switched on, the feature is invisible to coaches and sends nothing.

### 1b. Apply the coach invites migration (needs approval)

`20261002020000_staff_roster_coach_dashboard.sql` goes on top of `20261002010000`,
the same way: SQL editor only, whole file at once, backup first. It starts with
`set local lock_timeout = '5s'`, is idempotent, and records
`staff_roster_coach_dashboard` as its **last** statement. It adds empty
tables (`staff_roster_invites`, `staff_roster_invite_attempts`,
`staff_profile_drafts`, `staff_certificates`, `staff_session_notes`,
`staff_notice_preferences`; RLS on, direct access revoked) and their
`staff_roster_*` functions; a private storage bucket `staff-certificates` with
owner/manager policies, and one insert policy on `site-images` limited to
`staff-profiles/<the coach's own id>/`. It replaces `staff_roster_notify` with
the same function plus the coach's email preference, and adds a before-insert
trigger on `staff_notification_push_deliveries` that records push as
`skipped` (`PUSH_OFF_BY_RECIPIENT`) for anyone who switched push off. It
changes no existing row. If the storage statements are refused in the SQL
editor (they need the usual Supabase owner rights), the whole file rolls back. Apply it **before** deploying the web release or building the app from
it: both gates require the capability.
Check: `select capability from public.xert_schema_capabilities where capability like 'staff_roster%';`
returns three rows.

### 1c. Apply the part-month migration (needs approval)

`20261002040000_staff_roster_part_month.sql` goes on top of `20261002020000`
(and independently of `20261002030000_pt_booking.sql`), the same way: SQL
editor only, whole file at once, backup first. It starts with
`set local lock_timeout = '5s'`, is idempotent, and records
`staff_roster_part_month` as its **last** statement. It adds a nullable
`staff_roster_periods.starts_on` (null for every existing period, which keeps
working exactly as before), re-adds the `staff_roster_periods_order` check so
answers are due before `coalesce(starts_on, month)`, adds the
`staff_roster_periods_starts_on` check, adds `staff_roster_open_part_month`
(managers only), and replaces `staff_roster_gaps`, `staff_roster_month_classes`,
`staff_roster_assignment_problems` and `staff_roster_me` with the same
functions plus one marked `-- part-month` line each, so classes before the
start day are not asked about, not gaps, and cannot be assigned
(`SESSION_BEFORE_ROSTER_START`).

In the app: open the month on the Availability tab. When the month has already
started and has no period, it asks which day to roster coaches from (a week
from today by default), due three days before it and publish-by the day
before. Classes before that day keep whatever coach they have now; publishing
never touches them.

### 1d. Apply the roster texts migration (needs approval)

`20261002050000_staff_roster_sms.sql` goes on top of `20261002040000`, the
same way: SQL editor only, whole file at once, backup first. It starts with
`set local lock_timeout = '5s'`, is idempotent, and records `staff_roster_sms`
as its **last** statement. It adds `staff_roster_settings.sms_enabled`
(**false**: nothing is texted until the owner turns it on),
`staff_notice_preferences.sms` (true), the `staff_roster_sms_messages` outbox
(RLS on, no direct access), a deferred trigger on `staff_roster_revisions`
that queues texts when a version is published (publish and cover approval are
not copied or changed), the service-role-only `staff_roster_sms_claim` /
`staff_roster_sms_record`, and the manager/coach entry points
`staff_roster_sms_status`, `staff_roster_sms_set_enabled`,
`staff_roster_sms_retry`, `staff_roster_set_sms_preference` (and
`staff_roster_my_notice_preferences` with the texting fields added).

Going live:

1. Apply the migration and check `staff_roster_sms` is in
   `xert_schema_capabilities`.
2. Deploy the app. Texts are sent by `api/admin-publish-announcement.js`
   (action `send_roster_sms`) with the existing `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`. No new function, secret or
   scheduler.
3. Coach roster → Coaches: any coach marked **No mobile** needs an Australian
   mobile (04…) on their XERT account (Account details, or Members).
4. Coach roster → Settings → **Text coaches when you publish**.
5. Publish. The publish dialog shows "Texts: N sent, …" and offers **Resend
   failed texts** when any failed or were skipped for a missing number.

Texts go out when a manager's screen asks: right after publishing, after
approving cover, and whenever the roster opens with texts still waiting.
Temporary Twilio failures are retried (3 attempts in all). Switching texting
off cancels texts still waiting. Coaches can turn texts off under
Profile → How you get notices.

Who gets what: each coach ends up with one correct text for the month's
latest published version, counted from the last text they were actually sent
(or that is going out, or that may have gone with no answer from Twilio). A
coach never sent anything gets their full list; otherwise just what changed
since that text, and nothing if nothing changed. A text still waiting when a
newer version is published is closed as "replaced by a newer text" and the
newer version's text takes its place. Texts already sending or sent are
never changed, and a coach's texts go one at a time, in order.

If a publish's commit is cancelled while texts are being queued (a statement
timeout, or the texts lock held for more than 2 s), the publish still goes
through. Nothing is lost: every send run (right after the next publish, or
when the roster opens with texts waiting) first brings each month that has
texts up to date with its published version, and **Resend failed texts**
does the same for the month on screen. The publish dialog counts coaches a
cancelled queue missed under **Resend failed texts**. A month published while
texting was off is never texted by itself; only a publish or **Resend failed
texts** for that month sends its texts.

### 1e. Apply the roster fixes migration (needs approval)

Apply order for the unapplied roster migrations, one at a time, each only
after the one before has succeeded:

1. `20261002040000_staff_roster_part_month.sql`
2. `20261002050000_staff_roster_sms.sql`
3. `20261002060000_staff_roster_fixes.sql`

`20261002060000_staff_roster_fixes.sql` goes on top of `20261002050000`, the
same way: SQL editor only, whole file at once, backup first. It starts with
`set local lock_timeout = '5s'`, is idempotent, and records
`staff_roster_fixes` as its **last** statement. It changes no row. It
replaces `staff_roster_apply_changes` (from `20261001010000`) and
`staff_roster_class_detail` (from `20261002020000`) with the same functions
plus lines marked `-- fix`, and adds a before-update trigger
(`staff_notification_push_preferences_update`, function
`staff_roster_push_preference_on_update`, no client access) on
`staff_notification_push_deliveries`:

- Editing a published month with no draft: the manager screen's published
  assignment ids now work for unassign, move and pin (the draft's copy is
  used). Re-assigning a coach to a position they already hold is a no-op;
  moving onto an occupied position is refused as `SLOT_TAKEN`.
- A coach's class detail counts public sign-up requests as requests.
- A coach who switches phone notifications off gets no further push, even one
  already claimed by the dispatcher.

Check `staff_roster_fixes` is in `xert_schema_capabilities`, then run
`src/supabase/release_readiness_check.sql`.

## 2. Set up and switch on

All in **Coach roster → Settings** and **Coaches**:

1. **Coaches** tab: add each coach. Link their sign-in (search by name or
   email); optionally link their website Coaches page profile. Set roles
   (lead / assistant / shadow) and any limits.
2. **Settings**:
   - Check class time presets (defaults 5:15, 6:15, 9:30, 4:30, 5:30 pm; add or
     remove freely).
   - Check the cycle (default: opens the 1st two months before, due the 20th
     two months before, aim to publish the 1st of the month before).
   - Set the positions each class type needs (default one lead).
   - Leave **Also email roster notices** off until in-app notices are trusted.
     When on, it uses the site's existing `queue_email`; the Activity tab shows
     each email's real status from `email_log`.
   - Leave **Show the lead coach on the public timetable** off unless wanted.
     When on, the lead's *website profile* name from the published roster is
     written into `class_sessions.coach_name` (at once for upcoming classes,
     then on every publish), only for coaches with a published profile, and
     never over a name typed by hand. `staff_roster_public_names` records each
     name the roster wrote and the value it replaced.
     Turning it off removes the names the roster wrote from upcoming classes
     (putting back what was there before) and leaves any name typed or edited
     by hand. Turning it back on derives names from the roster published now.
   - Press **Switch on** at the top of Settings.
3. **Availability** tab: open the month. Coaches get an inbox notice.

### What coaches get on /coaching

- **Home**: setup checklist (sign-in, availability, roster seen, notices,
  first aid/CPR on file, website profile), next classes with the next class's
  headcount, hours coached this and last month (from the published roster,
  including set-up and pack-down; labelled as a summary, not payroll), and
  shortcuts.
- **My classes → Who's booked & plan**: for classes they are on in a
  *published* roster only: booked / capacity, requests, waitlist, and booked
  members as first name + last initial (no contact or health details); a
  session plan that the coaches on that class and managers can read and edit,
  with every earlier version kept. Managers see the plan in the position
  drawer on the roster board.
- **Profile**: website profile draft → *Send for approval* → a manager
  approves it in **Coaches** (it is copied onto the linked website coach
  profile, or a new published one is created and linked; an existing hidden
  profile stays hidden). Certificates (type, number, dates, optional private
  file). Notice settings: in-app always; email and phone push can be switched
  off (the roster-wide email switch in Settings still wins).
- **Certificate reminders**: coaches get a notice 60, 30 and 7 days before and
  on expiry (once each); managers get one daily summary while anything is
  expired or within 30 days. They run with **Send due reminders now** and, if
  scheduled, with
  `select cron.schedule('staff-roster-certificate-reminders', '15 * * * *', $$select public.staff_roster_run_certificate_reminders()$$);`
  (needs approval; nothing is sent while the roster is off).
  **Coaches** shows expiring/expired certificates and active coaches with no
  current first aid or CPR.

### Onboarding a coach with an invite link

Instead of searching for their account, a manager can send the coach a link:

1. **Coaches** tab → **Invite** on a coach with no sign-in (add the coach
   first if needed). Optionally type an email address to send the link to.
2. **Create invite link**, then **Copy link** and send it however you like.
   The link is shown once: only its SHA-256 fingerprint is stored. If an
   email address was given, the link is queued through `queue_email`
   (type `staff_invite`), and the drawer says honestly whether it was queued
   or skipped (for example when email is switched off in Email settings).
3. The coach opens the link, logs in or creates an account (they come back to
   the invite automatically), checks the coach name and presses **Accept
   invite**. Their sign-in is linked to that coach and the coach dashboard
   opens on Home.

Rules: one live link per coach (making a new one cancels the old), 14-day
expiry, single use, **Cancel invite** stops it at once. A sign-in already on
the roster cannot take a second coach record. If the coach is linked by hand
in the meantime the link is retired. Ten failed tries in 15 minutes pause that
account's attempts. Accepting works while the roster is switched off; the
coach screens still say "not switched on yet" until it is on. Coach rows show
**Invite sent / Invite expired / Joined / Invite cancelled**, and the Activity
log records each invite created, cancelled and accepted (never the link).

## 3. Reminders

Reminders are deduplicated, daytime only (default 9:00 am Brisbane), and skip
coaches who have answered.

- **Without a schedule:** the manager presses **Send due reminders now** on the
  Availability tab. Pressing it twice sends nothing new.
- **With a schedule (optional, needs approval):** if `pg_cron` is enabled,
  ```sql
  select cron.schedule('staff-roster-reminders', '*/30 * * * *', $$select public.staff_roster_run_reminders()$$);
  ```
  It runs as the database owner, does nothing while the feature is off, and is
  removed with `select cron.unschedule('staff-roster-reminders');`.

## 3a. Phone push for roster notices

Every roster notice is first an in-app notice (`staff_notifications`). Writing
the notice also writes one **pending** push work item per enabled device of the
recipient (`staff_notification_push_deliveries`), in the same transaction,
whatever created it: a manager or coach action on the web or in the app, a
class retimed or cancelled in the Class calendar, or a reminder run. Nothing
depends on anyone opening a roster screen afterwards.

**Who sends it.** The dispatcher (`src/lib/staffRosterPush.js`, served by the
existing `POST /api/push-subscription` with `{ "action": "staff_roster_push" }`,
so the Hobby plan's twelve-function limit holds) runs from:

- **the scheduler** (the dependable path): Supabase `pg_cron` + `pg_net` call
  the endpoint every minute, but only when `staff_roster_push_due()` says
  there is work, with `Authorization: Bearer <STAFF_PUSH_DISPATCH_SECRET>`
  read from Vault. See `docs/staff-roster/push-dispatch-schedule.sql`
  (not applied; activation and deactivation steps are in the file). Expected
  delay from notice to push request: about 1–2 minutes. Dependencies: the
  roster on, APNs env set in Vercel, the secret in Vercel and Vault, pg_cron
  and pg_net enabled, the site reachable. Vercel Hobby crons run at most
  daily, so they are not used; a Pro-plan Vercel Cron could call
  `GET /api/push-subscription?action=staff_roster_push` instead (Vercel sends
  `Authorization: Bearer <CRON_SECRET>`);
- **a signed-in manager or coach**, fire-and-forget after a roster action on
  the web (publish, cover, absence decisions, reopen, **Send due reminders
  now**). This only makes the next push sooner. Without the scheduler,
  notices created with nobody acting on the roster afterwards (a class
  retimed in the Class calendar, a `pg_cron` reminder run) wait until the
  next such action and are dropped as `expired` after 12 hours.

The scheduler's identity is its own server secret, never a person's token;
the user path still verifies the session and requires a manager or active
coach. Neither weakens any public or API authentication.

**Leases and retries.** A run leases due work (lease token, expiry 3 min,
worker name, attempt count), marks each row "send started" just before the
request goes to Apple, and records each outcome with its lease. A result from
a lease that no longer owns the row is ignored, so a late answer never
overwrites a newer attempt.

| What happened | Status | Retried? | Device |
| --- | --- | --- | --- |
| 200 | `accepted` (by Apple; not delivered, not read) | no | kept |
| 410 Unregistered / ExpiredToken; 400 BadDeviceToken / DeviceTokenNotForTopic | `invalid_token` | no | **switched off** (unless a whole run says so: then treated as configuration and retried) |
| 403 provider token / certificate errors, 429, 5xx, 400 IdleTimeout | `pending` with backoff | yes, ≤ 5 attempts in all (5xx and 403 wait ≥ 15 min, 429 ≥ 1 min; doubles, ≤ 1 h) | kept |
| other 400s, 403 Forbidden, 404, 405, 413 | `failed` | no (Apple: fix first) | kept |
| network error before the request left | `pending` | yes | kept |
| request left, no answer (timeout, reset), or the dispatcher died after starting the send | `uncertain` | **no** | kept |
| dispatcher died before starting the send | `pending` again | yes | kept |
| roster switched off after the lease, before the send | `pending`, attempt given back | when back on | kept |

Uncertain outcomes are not resent: a phone shows a notice at most once from
us, and the in-app notice is always there. Every attempt of one notice uses
the same `apns-collapse-id` (`staff-notice-<notice id>`) so any repeat replaces
the earlier alert instead of adding one, and `apns-id` is the work item id.
Delivery is never claimed to be exactly once.

**Staleness (separate from cadence).** Before sending, work that is no longer
true or useful is closed, never sent: older than 12 hours (`expired:TOO_OLD`);
a class-change notice whose class has started (`expired:CLASS_STARTED`), was
changed again, cancelled or restored, or has a newer notice for the same class
(`superseded`); a reminder after the coach submitted, or a newer notice of the
same kind and month (`superseded`); already read in the app, a recipient who
is no longer a manager / active coach, or a device switched off (`skipped`).
`apns-expiration` is set to the same limit (the class start for class
changes), so Apple stops trying too.

**Not configured / off.** With APNs not configured (`APNS_KEY_ID`,
`APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`) nothing is leased and the
answer says `configured: false`; with the roster off nothing is leased either.
Work stays pending and is judged by the staleness policy when it can run.

**Payload.** Lock-screen text is generic (“XERT coaching” / “Your roster has
an update. Open the app to see it.” and similar) and never includes names,
reasons or notes. The payload carries `staff_notification_id`, `audience`
(`coach` | `manager`) and `open_path`:

- coach notices: `/open/coaching/<roster|availability|requests>[?month=YYYY-MM]` (My Coaching);
- manager notices (stored link under `/admin/`): `/admin/roster?rosterTab=<roster|availability|requests|coaches|settings|activity>[&rosterMonth=YYYY-MM]`,
  opened in the web manager console (My Coaching is coach-only). Record ids
  (`rosterFocus`) are dropped. Signed out, the console shows its sign-in form
  at that same URL, so the destination survives sign-in; the console and
  every manager RPC check the manager role again.

Activity → Notices shows push as accepted by Apple, waiting, sending, failed,
unconfirmed or not sent, separately from “Opened in app”, which stays the only
read state.

## 4. Turning things off: four different actions

They do different things. Pick the smallest that solves the problem.

### 4.1 Public coach names OFF (reversible, no data loss)

Settings → untick **Show the lead coach on the public timetable**.

- Removes every name the roster wrote on an **upcoming** class and puts back
  what was there before (`staff_roster_withdraw_public_names`).
- A name typed or edited by hand on a class is **kept** and becomes ordinary
  class text. Past, cancelled and completed classes are not changed.
- Works whether the roster is on or off. Turning it back on derives names from
  the roster published at that time.

### 4.2 Whole roster OFF (reversible, no data loss)

**First do 4.1** if public names are on. Settings enforces this: **Switch off**
is disabled while public names are on, and explains why. Switching the roster
off on its own does **not** withdraw any public name: names already written
stay on the timetable. If the roster was switched off another way (for
example `update public.staff_roster_settings set enabled = false;` in an
emergency), Settings shows a warning while names are still showing; untick
public names then (4.1 still works with the roster off).

Then Settings → **Switch off**.

- Coach screens show "Coach roster isn't switched on yet". Drafts, private
  notes and stale data are never shown.
- Class changes stop queueing roster notices. No push is sent: the dispatcher
  leases nothing, and work already leased is put back unsent. Pending work
  stays and is judged by the staleness policy if the roster comes back on.
- All data stays. Switching back on resumes where it was.
- To also stop the scheduler calling the endpoint at all:
  `select cron.unschedule('staff-roster-push-dispatch');` (see
  `push-dispatch-schedule.sql`). It is harmless to leave: it makes no call
  while the roster is off.

### 4.3 Application rollback (reversible)

Vercel → Deployments → the previous production deployment → **Instant
Rollback** (or promote it). The database objects stay and are harmless to
older code: the first release (`d4b10bc`) still works on the new schema, and
its old push functions now claim nothing. Do not run any SQL for an app
rollback. If the push schedule is active, unschedule it if the rolled-back
code has no dispatcher (calls would get an error answer, nothing else).
Native builds are rolled back separately in App Store Connect.

### 4.4 Destructive schema removal (NOT authorised; last resort)

`docs/staff-roster/rollback.sql` is **not** a rollback in the usual sense: it
permanently deletes every roster table, coach record, availability, roster,
cover request, notice, push work item and the roster audit trail (both
migrations). It needs a backup and the owner's explicit approval; it is never
part of a normal rollback. Unschedule the push job first. Classes, bookings,
payments, device registrations and `class_sessions.coach_name` are untouched
(do 4.1 first if roster-written names should not remain as class text). Then
ship a release without the `staff_roster` / `staff_roster_push_reliability`
gates.

`test/staff-roster-rollback.test.js` runs migrate → publish → full removal →
re-migrate and checks that classes and device registrations are unchanged and
that no roster object is left behind. `test/staff-roster-disable-order.test.js`
proves the 4.1-then-4.2 order and that hand-typed names survive.

## 5. Local checks

```bash
npm run lint
npm test                      # includes PGlite tests over both real migrations
npm run build
npm run sql:check
node test/staff-roster-performance.mjs        # synthetic timing, not in npm test
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
  node test/staff-roster.browser.mjs --screenshots=./roster-shots
```

All fixtures are synthetic (`*.example.invalid` / `example.test` addresses,
email notices off). They cannot message real staff.
