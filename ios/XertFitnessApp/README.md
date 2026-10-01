# XERT Fitness SwiftUI App

This folder contains the SwiftUI iOS companion app for the Vercel/Supabase XERT Fitness web app. It uses Supabase REST/Auth directly with `URLSession`, so there is no extra SDK requirement.

## Setup

1. On a Mac with Xcode 15+ installed, install XcodeGen once: `brew install xcodegen`.
2. Copy `Config.example.xcconfig` to `Config.xcconfig` and fill in your Supabase and Vercel values.
   Keep the `https:/$()/` URL style in the xcconfig file; Xcode expands it to `https://` without treating the value as a comment.
3. From this directory, run `xcodegen generate`, then open `XertFitness.xcodeproj` in Xcode.
4. Choose your Apple development team and a unique bundle identifier before running on a device. The generated project targets iOS 16+.

`project.yml` wires the application target, test target, `Config.xcconfig`, and the bundled `Info.plist`; no manual file-target assembly is needed.

The included `Info.plist` already contains these xcconfig substitutions:

```xml
<key>SUPABASE_URL</key>
<string>$(SUPABASE_URL)</string>
<key>SUPABASE_ANON_KEY</key>
<string>$(SUPABASE_ANON_KEY)</string>
<key>VERCEL_BASE_URL</key>
<string>$(VERCEL_BASE_URL)</string>
```

## Included

- Native SwiftUI tab app: Home, Book, Events, Explore, Account.
- Explore mirrors the public website's CMS-backed About copy, FAQ and contact
  details, published coaches and practitioners, functional training guide, and
  native foundation-member, trainer and allied-health partner interest forms.
  All three applications validate locally and enter the same protected Supabase
  CRM pipelines as their desktop equivalents. Home hero imagery and copy plus
  the booking introduction also update from the shared owner-managed CMS.
- Admin-only native Command Centre tab with owner business metrics, today's
  class desk, FIFO waitlist promotion, searchable member directory, retention
  follow-up logging, finance visibility, and optimistic-locked live platform
  controls, native PT request management, and immediate member notice publishing
  to web, in-app inboxes, and APNs. Supabase role checks and every admin RPC
  remain enforced server-side. Native operations health reports the complete
  migration contract alongside authenticated Stripe and APNs readiness.
  Its live operational priority queue consolidates release-health issues,
  booking and PT requests, roll calls, waitlists, retention follow-ups, and
  checkout reconciliation into count-aware one-tap workspaces.
  The phone-first owner overview also exposes direct tools for member lookup,
  class creation, notice publishing, and private session-pack drafts. Every
  dashboard value carries current, last-snapshot, loading, or unavailable state;
  failed health feeds cannot display green readiness or enable Stripe recovery
  actions, and platform settings become read-only until a safe refresh succeeds.
  The native audit ledger merges recent access, credit, request, notice, lead,
  schedule, content, and booking changes into one searchable owner timeline.
  Owners can also edit live session-pack names, descriptions, prices, credit
  counts, validity, ordering, sale state, featured state, and Stripe Price IDs.
  Updates use the same optimistic-locked Supabase RPC and catalogue as the web
  command centre, so native changes flow directly into member checkout.
  The event command centre provides native event creation, editing, visibility,
  deletion, Queensland date handling, member training-goal counts, and contactable
  training-group rosters from the same calendar shown on the website and member app.
  Native team-directory controls create, edit, order, publish, hide, and remove
  coaches and practitioners, including bios, experience, training goals, imagery,
  and social links with the same optimistic locking used by the desktop manager.
  The native class desk opens live member rosters, resolves requested bookings,
  manages waitlist removals and cancellations, provides direct member contact,
  records complete attended/no-show roll calls atomically, and exports a
  timestamped launch-day CSV only from a verified roster. The export distinguishes
  saved booking state from unsaved roll-call marks and warns owners to remove the
  member-contact file after reconciliation. Interrupted roll calls recover for up
  to 12 hours using owner-scoped booking IDs and attendance marks only; a refreshed
  server attendance decision always overrides the local draft. Credit release,
  capacity checks, FIFO promotion, and class completion remain server enforced.
  A searchable full-timetable manager creates and edits class metadata, booking
  modes, capacity, visibility and delivery details; duplicates classes as future
  drafts; and uses the dedicated cancellation workflow to return credits and
  request member push notification. Terminal classes cannot be reopened.
  Native availability and blackout controls create, edit and remove private
  planning windows with optimistic locking. Blackout conflict guards prevent
  owners from silently overlapping published classes, matching desktop safety.
  Native member records expose account value, direct contact, audited idempotent
  credit grants, protected admin-role changes, and an archiveable staff-note
  timeline. A safe-area action dock keeps private notice, credit and staff-note
  actions reachable on compact iPhones and scrolls the note editor clear of the
  keyboard. Final-admin and self-demotion safeguards remain server enforced.
  The Orders workspace searches the full native order ledger, exposes Stripe
  identifiers and reconciliation audit details, safely recovers unresolved paid
  checkouts, and performs explicitly confirmed full refunds. Refunds use the same
  server workflow as desktop to revoke unused credits and cancel future bookings.
  The native CRM manages member leads, trainer applicants, and partner enquiries
  with complete paging, search and status filters, direct contact, application
  details, internal notes, and up-to-100-record bulk transitions. Individual and
  bulk changes use the same immutable lead-audit RPCs as the desktop workspace.
  Native campaign attribution reads the complete member-interest history and
  matches the desktop 30-day, 90-day, and all-time Queensland reporting ranges.
  Owners can compare sources, channels, campaign names and daily lead volume,
  then export a privacy-safe CSV that contains attribution rather than member PII.
  The native Site Content workspace edits the same homepage hero, booking intro,
  About copy, contact details and FAQs as desktop. Structured validation protects
  public URLs and complete FAQ pairs; section drafts survive navigation locally;
  stale edits are rejected by Supabase optimistic locking; and hero photos upload
  to the shared public `site-images` bucket with the same 5 MB limit as the web CMS.
  A unified native booking inbox merges enquiry-form and member-credit requests,
  with age/source/status filters, direct contact, class context, workload totals,
  staff notes, guarded decisions, and bulk updates. Credit-backed transitions keep
  the server's capacity, FIFO waitlist, and credit-return protections intact.
- Supabase password auth, sign-up, reset, and signed-in password updates.
- Password recovery that sends members to the existing web reset page.
- Secure token persistence in Keychain.
- Face ID, Touch ID, or device-passcode privacy lock that hides all signed-in tabs whenever the app leaves the foreground. Owner tools require this protection: opening the Command Centre enables the lock after verifying device-authentication support, and backgrounding places an opaque, interaction-blocking shield above the still-mounted owner workflow so unfinished edits survive Control Centre, app switching, and other brief interruptions until authentication succeeds.
- Typed exact-task navigation across deep links, Universal Links, privacy-safe Handoff, scene restoration, Back/Forward history, and Home Screen quick actions for booking, upcoming bookings, and the event calendar. Each primary workspace independently remembers its last exact task, including across scene restoration, so dock taps, swipes, keyboard commands and the Quick Switcher return members to their work instead of flattening state to a tab root; private memory is stripped before signed-out restoration. Live navigation priorities put unresolved purchases first, then the member's next timed class, and open that exact booking from either the dock or Quick Switcher; its identity is erased from navigation context on sign-out. The Quick Switcher makes that architecture visible through an adaptive workspace map in the member's chosen order, showing the exact remembered task, current state and saved pins for all five workspaces while replacing protected memory with safe roots when signed out. The same allowlisted member routes are published as App Intents for Siri, Spotlight, Shortcuts, and supported system controls. All 20 role-gated owner workspaces are also typed, searchable, scene-restored destinations: an authorized owner command or allowlisted link can open Finance, Operations Health, Members, Timetable, or another exact business tool directly on iPhone and iPad. Protected owner links can additionally resolve an exact member, Stripe order, session pack, or calendar event by UUID after authentication, including exact member lookup beyond the first directory page. Owner routes are never exposed through Handoff or public indexing. iPadOS also exposes scene-level menu and hardware-keyboard commands for all five member workspaces, exact-task history, refresh, the quick switcher, and owner operations.
- Owner member, order, session-pack and event records share one bounded, versioned route timeline whether opened from a workspace, a Stripe launch blocker, or a protected link. Back/Forward and scene restoration preserve the exact record, while an account identity guard clears protected route state before another administrator can inherit it. The owner command switcher searches workspaces alongside bounded exact member, order, session-pack and event results; member lookup uses separate paged server state so it cannot replace the Members workspace directory.
- Member contact-detail viewing and editing, matching the web account workflow.
- Product, class session, booking, credit, and event loading.
- Searchable class discovery with Queensland-aware today/7-day windows, open-spot and beginner-friendly filters.
- Source-level offline and partial-refresh notices, with cached public data kept usable when individual services fail. Active upcoming bookings also survive a signed-in relaunch for up to seven days in an account-scoped, bounded local snapshot; saved status is timestamped and remains read-only until the server refreshes it.
- Coalesced, generation-guarded refreshes that cannot restore private member data after sign-out or an account change.
- Semantic, rate-limited haptics use prepared generators across navigation,
  booking, checkout, account, and owner workflows, with an Account preference
  for members who prefer no touch feedback.
- CMS photography is memory-bounded and downsampled off the main actor; the Home
  carousel pauses in the background, under Reduce Motion, and in Low Power Mode.
- Booking mutations refresh only the timetable, credits, and bookings they can
  change, while foreground refreshes are freshness-bounded and silent notice
  pushes reload only the member inbox.
- Bounded API timeouts with clear offline, timeout, service reachability and secure-connection errors.
- Upcoming-event filtering in the XERT/Queensland calendar, plus event detail links when an admin supplies one.
- Booking RPC support through `book_session`.
- Instant booking, staff-confirmed booking requests, waitlist visibility, and member cancellation or waitlist withdrawal.
- Self-service joining for full-class waitlists without consuming a class credit.
- Live FIFO waitlist positions with atomic next-member promotion enforced by the shared backend.
- Staff booking approvals, waitlisting, declines and cancellations create a durable private member notice atomically, then request targeted Apple push delivery without rolling back a safe booking decision if APNs is unavailable.
- Member-notice composition recovers unsaved owner edits for 12 hours after interruption, scoped to the authenticated owner and exact notice. Recovery is rejected when the server notice has changed, and local copy is erased after save, publish, deletion, explicit discard, sign-out, or account removal.
- Class, session-pack, event and coach editors recover bounded unsaved owner work for 24 hours after app termination. Drafts are isolated by owner, record and exact server baseline, rejected when the live catalogue changed, and erased after successful save, deletion, explicit discard, sign-out or account removal.
- Member-controlled device reminders before future confirmed classes; permission is requested only when enabled, reminders are removed when disabled, cancelled, or signed out, and tapping one opens the matching booking even after a cold launch or privacy unlock.
- Interest-only class handoff to the live XERT timetable/registration form.
- Vercel checkout launch through `/api/checkout`, with a user-bound 24-hour
  pending-purchase baseline so cold launches, sign-in recovery and delayed
  Stripe webhooks keep reconciling credits and purchase history safely.
- Native purchase history includes reconciled refund dates and amounts from the shared Stripe audit workflow.
- Live member notices authored in the admin command centre, with priority, automatic expiry, member dismissal, and aggregate reach shared across web and iOS.
- Seven-day credit-expiry warnings for members, backed by an admin follow-up queue for proactive retention.
- Privacy-minimised member readiness backed by a protected emergency contact,
  immutable acknowledgement versions and server-timestamped acceptance receipts.
  Owner directory status never includes the raw emergency contact; opening it
  requires a deliberate admin-only reveal that writes an access audit event.
- Refresh-token renewal on launch and focused decoding tests for the Supabase data contract.

Members can enable the privacy lock under **Account → Account Security**. The preference stays on the device; biometric and passcode results are evaluated by iOS and are never sent to XERT or Supabase.

The app expects the same Supabase schema used by the web app in `src/supabase/booking_schema.sql`. Apply
`src/supabase/booking_modes_upgrade.sql` to the deployed project before using request-to-book classes in either app.
Apply `src/supabase/member_onboarding_upgrade.sql` before enabling the native
member-readiness experience. The foundation intentionally stores no screening
answers, date of birth, diagnoses, injuries, free-text safety notes, waiver or
clearance outcome.

## Codemagic

The repository-root `codemagic.yaml` has two macOS workflows:

- `ios-verify` runs on every push to `main`; it generates the XcodeGen project and executes the Swift unit tests on an available iPhone simulator without code signing.
- `ios-testflight` is a manual, signed TestFlight release workflow. It runs the same tests, increments the App Store build number, creates an IPA, and uploads it to TestFlight.

Both workflows use `ci/run-swift-tests.sh`, which explicitly boots the selected iPhone simulator and bounds simulator startup and test execution. A stalled test host now fails with a clear timeout instead of consuming the full build duration.

The independent **GitHub Quality workflow** also runs on pushes and pull requests
to `main`. It executes the locked web lint, typecheck, test and production-build
contracts on Linux, then generates the native project and runs the same unsigned
Swift test harness on a GitHub macOS runner. Swift result bundles and Xcode logs
are retained for seven days even when the job fails. This provides a visible
source-control check when a Codemagic team webhook is delayed or disconnected;
Codemagic remains the only workflow that signs or publishes the app.

After the unit tests, the same GitHub job runs the **My Coaching XCUITests**
(`XertFitnessUITests`, via `ci/run-swift-ui-tests.sh`) on the same simulator.
They launch a Debug build with `-XertRosterFixtures`, a DEBUG-only fixture mode
(`StaffRoster/StaffRosterFixtures.swift`) that signs in a fixture coach without
Supabase, answers every `staff_roster_*` call from memory, refuses all network
requests and records (instead of opening) manager-console browser links. The
`.xcresult` bundle and exported screenshots are kept for fourteen days. Release
builds contain none of this code. Real-device universal links, APNs receipt and
TestFlight are not covered by these tests.

Create the XERT-specific Codemagic environment group named `xert_env` and add these variables to it. The same group is loaded by both workflows:

```text
SUPABASE_URL       # Supabase project URL
SUPABASE_ANON_KEY  # Supabase anon/public client key
VERCEL_BASE_URL    # deployed Vercel https:// URL
```

`ios-verify` can run without these variables: it uses compile-only placeholders and never makes a service request. `ios-testflight` requires the real values and stops with a clear setup error when one is absent.

Codemagic discovers the repository configuration from the root-level `codemagic.yaml` filename. A separate `config.yaml` is not a Codemagic workflow file and is intentionally not used.

Automatic verification also requires the shared-team app webhook. A Codemagic
team admin must open **XERT Fitness > App settings > Webhooks**, choose
**Update webhook**, and confirm that a push to `main` appears under recent
deliveries. The repository workflow deliberately matches the pushed `main`
source branch; it does not rely on a pull-request target event. If GitHub shows
the Vercel status but no Codemagic build after a push, repair this webhook before
interpreting the missing check as a Swift result.

The signed release workflow also loads the shared `appstore` group. It expects the secure `CERTIFICATE_PRIVATE_KEY` supplied by the team (with compatible legacy fallback names) and reuses that key to fetch the existing App Store distribution certificate rather than creating another certificate.

Create or use the shared App Store Connect integration named `codemagic`, then enable **Push Notifications** for `com.xertfitness.app` in Apple Developer and fetch its App Store provisioning profile. The release guard verifies the bundle identifier, complete iPad orientation metadata, export-compliance declaration, `aps-environment`, `application-identifier`, and the bundled `PrivacyInfo.xcprivacy` in the signed IPA before TestFlight upload. It intentionally fails when the App ID/profile is missing the push capability or Apple-required bundle metadata is absent.

### Universal-link activation

The production site serves `/.well-known/apple-app-site-association` for Apple team `25R438YK9F`, bundle `com.xertfitness.app`, and only the canonical `/open/*` task-link namespace. Confirm the XERT App ID belongs to that same Apple team, enable **Associated Domains** for the XERT App ID, and regenerate the App Store provisioning profile. Then add `ENABLE_UNIVERSAL_LINKS=true` to the Codemagic `xert_env` group. CI verifies the live AASA file, injects `applinks:xert-fitness.vercel.app` before project generation, and requires the entitlement in the signed IPA. Until that switch is explicitly enabled, CI removes the entitlement so the current profile keeps building safely.

Before starting a signed build, run `src/supabase/release_readiness_check.sql` in the production Supabase SQL editor. All 44 rows must show `installed = true` and `release_ready = true`; otherwise the service-contract preflight stops before signing and names the missing capability. The member booking-switch guard makes **Member App Controls → Bookings enabled** authoritative for website and iOS clients at the database boundary.

Remote member notices also require these server-only Vercel variables. Never place them in `xert_env`, the app bundle, or a `VITE_` variable:

```text
APNS_KEY_ID       # Apple Push Notification authentication key ID
APNS_TEAM_ID      # Apple Developer Team ID
APNS_PRIVATE_KEY  # complete .p8 private key, stored as a Vercel secret
APNS_BUNDLE_ID    # com.xertfitness.app
```

The APNs authentication key is team-wide and reusable across apps, so keep one stable key rather than creating per-build certificates. Codemagic reports Stripe and APNs readiness as warnings while those Vercel services are being configured unless `REQUIRE_PRODUCTION_SERVICES=true` is set in `xert_env`. Regardless of that build-time setting, the protected runtime launch gate requires Stripe readiness, a production owner push device, and a successful private owner push test from the last 24 hours before launch switches can be certified. Signing, schema, entitlements, privacy, and Apple bundle validation remain hard release gates.
