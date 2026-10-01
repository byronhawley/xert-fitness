# XERT Roster — discovery, authority map and delivery plan

Written 1 October 2026 against `byronhawley/xert-fitness` `main` at
`9225068` (merge of PR #20, 30 Sept 2026). Feature branch:
`claude/xert-roster-tanrur`.

This is the coach/staff roster ("XERT Roster"). It is deliberately named
**staff roster** everywhere in code, data and APIs so it never collides with
the existing **member attendee roster** (`admin_session_roster`,
`ClassSignupRoster`, the calendar "roster" view of who booked a class).

---

## 1. Source of truth verification

| Check | Result |
| --- | --- |
| Canonical remote | `https://github.com/byronhawley/xert-fitness` (origin), default branch `main` |
| Latest source | `9225068` 2026-09-30 13:29 +1000 |
| Not XERTOS / GymLoop | Confirmed: Vite/React + Supabase + SwiftUI app; no XERTOS code involved |
| Live database | **Not inspected.** The Supabase connector in this session reaches two unrelated projects, not the XERT project `ugmkwoapjcpiucsrxwzt`. All findings are from checked-in source. |
| Baseline checks | `npm run lint` pass · `npm test` 1417/1417 pass · `npm run build` pass · `npm run sql:check` 149 files pass · `npm run typecheck` **fails on main already** (6 pre-existing errors in `BookingRequestForm.jsx`, `xertForms.js`, `SoftLaunchTimetable.jsx`) |

## 2. Authority map (who owns what)

| Domain | Authority | Edit path | Notes |
| --- | --- | --- | --- |
| Dated class sessions | **XERT Supabase `public.class_sessions`** | Command Centre → Classes → Class calendar (insert under admin RLS; `admin_update_class_session`; `admin_cancel_class_session`; roll call RPCs) | Guards: blackout triggers, optimistic locking (`updated_at`), booking time-conflict and capacity guards, terminal-state immutability |
| Class presets | `public.class_templates` ("Class bank") | `ClassBankManager.jsx` | Holds class type, title, duration, capacity, booking mode, `default_start_minute`. Not a recurrence. |
| Recurrence | **None today.** "Repeat" (`repeatedClassSessionCopies`) makes independent copies; no series record, no idempotency key | — | Added by this feature (§5) |
| Member bookings, waitlist, attendance, credits, Stripe | XERT Supabase booking tables and RPCs | unchanged | The roster never writes any of them |
| FitBox | Memberships, subscriptions, billing, FitBox booking outcomes | FitBox itself | Zapier connector has **no timetable/session list or write action** (`docs/FITBOX_ZAPIER_PRODUCTION_RUNBOOK.md`). `fitbox_classes` mirrors class *names* only; `fitbox_attendance.fitbox_event_id` identifies FitBox sessions only via member attendance. |
| Staff identity | `public.profiles` (`role` is `member` or `admin`; `is_admin()`) | Members manager, `admin_set_user_role` | There is **no coach account concept** today |
| Public coach directory | `public.coaches` (CMS: name, bio, photo, published) | Website & forms → Coaches page | Not linked to any login |
| Public coach label on a class | `class_sessions.coach_name` (free text) | Class editor | Shown on timetable, booking, account, Today |
| PT/admin availability & closures | `availability_blocks` (`coach_name` text), `blackout_periods` | Classes → Opening hours | Admin-only; text names, no identity |
| Member notices | `member_announcements` + targets, APNs via `api/apns.js` | Communications | Member-facing; not reused for private staff content |
| Email | `queue_email()` → Resend via pg_net, `email_log` (queued/sent/failed/skipped), master switch in `email_settings` | Communications → Email | Durable, retryable (`admin_retry_failed_emails`), reconciled by pg_cron |
| Time | `src/lib/gymTime.js` (`Australia/Brisbane`, no DST) | — | Reused for every roster date/time |
| Tenancy | Single gym, single database; no tenant column anywhere | — | No multi-location architecture added |
| Release gate | `REQUIRED_SCHEMA_CAPABILITIES` blocks TestFlight until every listed migration is applied | — | Roster capability is registered as **optional** so it cannot block an unrelated release |

### Authority decision

Roster assignments attach to **`class_sessions.id`**, the only session record
XERT owns and can edit. If the gym's operative member timetable is in FitBox,
the existing Class calendar remains the place XERT's copy is maintained; the
connector offers no session list or session write, so a FitBox `eventId`
mapping **cannot** be built or kept current. This is reported as a missing
capability, not worked around. No competing session store is created.

## 3. Real file map

Existing (read, integrated with, not rewritten):

- `src/pages/AdminCommandCentre.jsx` — section router; a `roster` section is added.
- `src/lib/adminWorkspaces.js`, `src/lib/adminNavigation.js` — hub IA; **Coach roster** is added under the *Classes* hub (no new top-level menu).
- `src/components/admin/ClassCalendarAdmin.jsx` / `ClassCalendarBoard.jsx` / `ClassCalendarEditors.jsx` — unchanged behaviour; class edits keep their guards.
- `src/components/admin/ClassBankManager.jsx`, `src/lib/classCalendar.js` — class bank templates feed recurring series.
- `src/lib/scheduling.js` — class/session validation reused (`sessionEndTime`).
- `src/lib/gymTime.js` — gym-time formatting.
- `src/lib/adminData.js` — untouched; roster data lives in its own module.
- `src/lib/schemaCapabilities.js` — optional capability list added.
- `src/App.jsx` — `/coaching` route for coaches.
- `supabase/migrations/20260903010000_email_notifications.sql` — `queue_email` reused (opt-in).

New:

- `docs/staff-roster/DISCOVERY_AND_PLAN.md` (this file), `docs/staff-roster/RUNBOOK.md`
- `supabase/migrations/20261001010000_staff_roster.sql` — additive schema, RLS, RPCs
- `src/lib/staffRoster/*.js` — pure, UI-free engine (time, cycle, availability, duty, validation, coverage, suggestion solver)
- `src/lib/staffRosterData.js` — Supabase RPC client
- `src/components/admin/staffRoster/*` — manager workspace
- `src/pages/Coaching.jsx` + `src/components/coaching/*` — coach phone workflow (My Roster / Availability / Requests)
- `test/staff-roster-*.test.js` — engine and database tests (PGlite runs the real migration)

## 4. Interfaces

### Database (all `security definer`, `set search_path = public`, granted to `authenticated` only)

Manager (require `is_admin()`):
`staff_roster_get_settings` (coaches may read too), `staff_roster_update_settings`,
`staff_roster_upsert_staff`, `staff_roster_set_staff_status`,
`staff_roster_set_capabilities`, `staff_roster_link_candidates`,
`staff_roster_open_period`, `staff_roster_update_period`,
`staff_roster_reopen_submission`, `staff_roster_set_staffing`,
`staff_roster_save_series`, `staff_roster_preview_series`,
`staff_roster_generate_series`, `staff_roster_change_series_from`,
`staff_roster_planning_snapshot`, `staff_roster_check_assignment`,
`staff_roster_apply_changes`, `staff_roster_discard_draft`,
`staff_roster_publish`, `staff_roster_decide_absence`,
`staff_roster_record_absence`, `staff_roster_approve_cover`,
`staff_roster_reject_cover`, `staff_roster_run_reminders`,
`staff_roster_notification_log`, `staff_roster_audit_log`.

Coach (require an active linked staff record for `auth.uid()`; no membership needed):
`staff_roster_me`, `staff_roster_month_classes`, `staff_roster_save_usual_week`,
`staff_roster_save_availability_draft`, `staff_roster_submit_availability`,
`staff_roster_request_change`, `staff_roster_confirm_session`,
`staff_roster_my_roster`, `staff_roster_acknowledge`,
`staff_roster_request_absence`, `staff_roster_withdraw`,
`staff_roster_request_cover`, `staff_roster_cover_board`,
`staff_roster_offer_cover`, `staff_roster_my_requests`,
`staff_roster_my_notifications`, `staff_roster_mark_notifications_read`.

Internal only (not executable by signed-in users): the checker
`staff_roster_assignment_problems`, notify/audit/idempotency helpers, and
`staff_roster_project_public_names` (opt-in public coach names, called by
publish, cover approval and switching the option on) and
`staff_roster_withdraw_public_names` (called when it is switched off).

Service role only (called by `api/staff-roster-push.js`):
`staff_roster_claim_push_deliveries`, `staff_roster_record_push_results`.

Every mutation takes a client `request_id` (idempotency) and, where it edits a
versioned record, an expected version. A stale version raises
`STALE_VERSION` (mapped to "Someone else changed this. Refresh and retry.").

### Engine (`src/lib/staffRoster`)

- `time.js` — gym-local wall clock ⇄ instants, month keys, half-open intervals.
- `cycle.js` — default and configured open/due/publish dates per roster month.
- `availability.js` — weekly pattern + exceptions → effective windows; status of a duty interval; contradiction checks.
- `duty.js` — duty interval per session (prep/wrap), coaching blocks, union minutes.
- `validate.js` — hard-constraint evaluation with plain-language reasons (preview/explanations; the database is authoritative).
- `coverage.js` — slot demand, eligible pools, joint shortage (bipartite matching), single-person dependencies.
- `suggest.js` — deterministic constrained search with bounded backtracking.

## 5. Schema (additive; names follow repo conventions)

| Logical record | Table |
| --- | --- |
| Feature settings, presets, cycle defaults, reminder timing | `staff_roster_settings` (singleton, versioned, `enabled` default **false**) |
| Staff coaching settings | `staff_members` (links `profiles.id`, optional `coaches.id`, legacy label, roles, workload targets/limits, status, version) |
| Capabilities | `staff_capabilities` (name, valid from/until) |
| Usual week (editable template) | `staff_weekly_patterns` |
| Monthly draft | `staff_availability_drafts` (autosaved, versioned) |
| Versioned monthly submissions | `staff_availability_submissions` + materialised `staff_availability_windows` |
| Session-specific confirmations | `staff_session_responses` (bound to duty-range and exception fingerprint) |
| Roster periods | `staff_roster_periods` (+ per-coach reopenings in `staff_roster_reopenings`) |
| Recurring schedule | `class_schedule_series` + nullable `class_sessions.series_id`, `class_sessions.series_occurrence_date` (unique together) |
| Session staffing | `staff_session_staffing` (per session) and `staff_class_type_staffing` (defaults) |
| Revisions | `staff_roster_revisions` (draft / published / superseded / discarded; one draft per month) |
| Assignments | `staff_assignments` (revision, session, slot, staff, pinned, source, publish-time session snapshot) |
| Absences | `staff_absences` |
| Cover | `staff_cover_requests`, `staff_cover_offers` |
| Acknowledgements | `staff_roster_acknowledgements` |
| Audit | `staff_roster_audit_events` (append-only) |
| Notifications | `staff_notifications` (outbox + in-app inbox; dedupe key unique) |
| Idempotency | `staff_roster_requests` |

## 6. Ordered implementation tasks

Milestone A — usable manual roster
1. Engine: time, cycle, availability, duty, validation (+ tests first).
2. Migration: settings, staff, capabilities, patterns, drafts, submissions/windows, periods, staffing, series, revisions, assignments, absences, audit, notifications, idempotency; RLS; RPCs; session-change trigger.
3. PGlite database tests for permissions, submissions, validation, publish, idempotency, races, absences, session changes.
4. Data client; manager workspace (week/month/day, drawer, Needs Attention, availability progress, staff settings, settings); coach `/coaching`.
5. Browser verification + screenshots with synthetic data.

Milestone B — assistance and cover
6. Coverage bottlenecks (joint matching), copy-week suggestions, pins.
7. Suggest Draft solver (bounded backtracking, deterministic) + preview/diff + accept through the authoritative apply RPC.
8. Cover request → volunteer → approve with revision binding and race safety.

Milestone C — native and hardening
9. iOS coach screens over the same RPCs.
10. Accessibility, stress fixture (200 sessions × 20 coaches), feature-disabled/rollback checks.

## 7. Acceptance test map

See [ACCEPTANCE.md](ACCEPTANCE.md) for each mandatory scenario, the tests
that cover it and its verification level. Operations are in
[RUNBOOK.md](RUNBOOK.md).
