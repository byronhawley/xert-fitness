# XERT Roster — migrate, enable, operate, roll back

Nothing here has been run against the live XERT database. Each production
step needs the owner's separate go-ahead.

## What ships

| Piece | Where |
| --- | --- |
| Schema, rules, permissions | `supabase/migrations/20261001010000_staff_roster.sql` (additive; one file) |
| Manager screens | Command Centre → Classes → **Coach roster** (`/admin/roster`) |
| Coach screens | `/coaching` (website and the app's web views; staff link, no membership needed) |
| Release gate | `staff_roster` added to `schemaCapabilities.js`, `src/supabase/release_readiness_check.sql`, `codemagic.yaml` |
| Full removal script | `docs/staff-roster/rollback.sql` (manual, not a migration) |

The migration does not change bookings, waitlists, attendance, payments,
FitBox or any existing row. It adds two nullable columns to
`class_sessions` (`series_id`, `series_occurrence_date`) for repeating
classes, and one after-update trigger that only queues roster notices when the
feature is on.

## 1. Apply the migration (needs approval)

1. Take a database backup, or confirm point-in-time recovery is on.
2. Apply `20261001010000_staff_roster.sql` the same way earlier migrations were
   applied (Supabase CLI `supabase db push` or the SQL editor).
3. Check: `select * from public.xert_schema_capabilities where capability = 'staff_roster';`
   returns one row, and `select enabled from public.staff_roster_settings;`
   returns `false`.
4. Run `src/supabase/release_readiness_check.sql`. `staff_roster` must show as
   installed.

**Order matters for releases.** The web build and the Codemagic gate now
require `staff_roster`. Apply the migration **before** the next web deploy or
app build that includes this branch, or the gate will (correctly) fail.

Until it is switched on, the feature is invisible to coaches and sends nothing.

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

## 4. Switch off (safe, reversible)

Settings → **Switch off** (or
`update public.staff_roster_settings set enabled = false;`).

- Coach screens show "Coach roster isn't switched on yet". Drafts, private
  notes and stale data are never shown.
- Class changes stop queueing roster notices.
- All data stays. Switching back on resumes where it was.
- Public coach names already written to classes stay as ordinary class text.
  Edit them in the Class calendar if needed. (To remove the names the roster
  wrote, switch off **Show the lead coach on the public timetable** first.)

## 5. Roll back

| Situation | Do this |
| --- | --- |
| Roster misbehaving | Switch off (section 4). Nothing else changes. |
| Web/app release must be reverted | Revert the release. The schema is additive, so older app code ignores it. |
| Remove the schema entirely | Back up, then run `docs/staff-roster/rollback.sql`. **Deletes all roster data and its audit trail.** Classes, bookings and payments are untouched. Then ship a release without the `staff_roster` gate. |

`test/staff-roster-rollback.test.js` runs migrate → publish → full removal →
re-migrate and checks that classes are byte-for-byte unchanged and that no
roster object is left behind.

## 6. Local checks

```bash
npm run lint
npm test                      # includes PGlite tests over the real migration
npm run build
npm run sql:check
node test/staff-roster-performance.mjs        # synthetic timing, not in npm test
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
  node test/staff-roster.browser.mjs --screenshots=./roster-shots
```

All fixtures are synthetic (`*.example.invalid` / `example.test` addresses,
email notices off). They cannot message real staff.
