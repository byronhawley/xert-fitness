# Design verification

The design overhaul lives on `feat/design-overhaul`. Its source specification is
[DESIGN_OVERHAUL_PLAN.md](DESIGN_OVERHAUL_PLAN.md). A passing web build does not
prove the native app compiles or that a screen works with VoiceOver.

## Automated gates

```sh
npm test
npm run lint
npm run build
```

The build first checks that the generated CSS, Tailwind and Swift artifacts match
`design/tokens.json`. Edit the source tokens and run `npm run tokens:build`; do not
edit the generated outputs.

## Isolated browser checks

`scripts/verify-design.mjs` starts its own loopback Vite server and a separate,
headless browser. It does not attach to an existing browser profile. Fictional
sessions and network responses live in `test/fixtures/design-data.mjs`, outside
the application bundle. All remote data traffic and local `/api/` mutations are
blocked; unauthenticated Google Fonts requests are permitted for accurate type.
The app's real authentication provider, route guards and components still run.

The runner requires Playwright, installed independently of production dependencies.
When it is not in the repository's module search path, set `PLAYWRIGHT_MODULE` to
the installed package's absolute `index.mjs` path. Set `BROWSER_CHANNEL=chrome`
to use an installed Chrome binary instead of Playwright's bundled Chromium.

```sh
node scripts/verify-design.mjs --tag=after-nav
node scripts/verify-design.mjs --tag=nav --routes=/ --navigation --announcement
node scripts/verify-design.mjs --tag=motion --motion=default --quick
node scripts/verify-design.mjs --tag=panels --routes=/admin,/admin/calendar,/admin/forms
node scripts/verify-design.mjs --tag=owner --routes=/admin --shell --commands --recovery
node scripts/verify-design.mjs --tag=kit --kit-only
node scripts/verify-design.mjs --tag=kit-motion --kit-only --motion=default --quick
node scripts/verify-design.mjs --tag=visitor-settings --routes=/admin/settings --visitor-prices
node scripts/verify-design.mjs --tag=visitor-payments --routes=/casual,/3daypass,/10pack,/3months --public-visitor-prices
```

The full matrix uses 390×844, 768×1024, 1440×900 and 1920×1080. It captures resting,
scrolled, signed-in/signed-out menu and 200% text states, checks horizontal overflow,
keyboard containment and Escape focus restoration, records runtime errors, and
exports a real 1024px branded QR PNG. `--quick` uses the phone and desktop sizes.
`--navigation` additionally verifies the collapse heights, active underline,
next-class and account content, failed availability/retry, breakpoint cleanup,
and real touch gestures (finger tracking, dismissal and non-dismissal while the
content is scrolled). `--announcement` uses a long fictional announcement to
check that the full banner clears the header and hero at both text sizes.
Interaction results are reported separately so an unrelated page overflow does
not hide the navigation test outcomes.
`--visitor-prices` exercises all three real Settings price controls using unsaved
fictional drafts: valid discounts, lowering the base below a running discount,
invalid intermediate amounts, clearing a discount and discarding changes. It
asserts no settings or payment activation mutation was requested.
`--public-visitor-prices` supplies fictional settings reads to each payment page
and verifies active, disabled and invalid discounts, including enlarged text.
`--membership-paperwork` verifies the repaired `/3months` handoff: prerequisite
return parameters, missing or mismatched agreement markers, declined terms,
actual rendered agreement acceptance and signature capture, both saved response
IDs in the checkout request, changed purchaser identity, and recovery from a
server proof rejection. It uses fictional form submissions and blocked payments.
Device markers guide navigation only; they cannot establish signed-record validity.
`test/three-month-paperwork-sql.test.mjs` separately runs the actual migration SQL
in isolated PGlite PostgreSQL, including signatures, saved snapshot shapes,
identity matching, role permissions, and the real Node handler with Stripe
network I/O stubbed. Original submitted records remain unchanged. The repair
preserves existing guardian/signature-format policy and does not establish
medical clearance or independently verified legal identity.
Real casual checkout handler tests separately verify server-configured charge
amounts and failure paths before an injected Stripe client. No isolated browser
check proves a live payment, activation email or signed record.
`--calendar-search` additionally preserves the selected Past period when an
upcoming attendee result is opened through the selected-session exception.
`--shell` checks persistent density, pointer-independent sidebar resizing, an icon
rail, fuzzy results, manual-activation tabs, shortcuts and preservation of an
actual unsaved editor draft when navigation is cancelled. `--commands` enables an
explicit in-memory fixture for five reviewed command flows: confirmation,
attendee addition, attendance correction/Undo, form publication and SMS preview.
Only that fixture can simulate successful writes; all real destinations remain
blocked, including the SMS endpoint. Failure/retry and duplicate-submit checks
assert exact fixture receipts. Add attendee checks both confirmed and waitlisted
receipts; missing or unknown outcomes must show an error, never success, and keep
the same request ID on retry. The command review is also checked at 200% text.
`--recovery` deliberately fails one local workspace chunk download and verifies
that the shell survives and explicitly chosen reload recovery preserves URL
parameters. A browser-cached module failure needs a fresh document, distinct
from the local region retry offered for ordinary render errors.
`--kit` adds an isolated entry that imports the real shared Command Centre controls;
`--kit-only` runs just that entry. Its 320 fictional records exercise measured
virtualization, whole-filter selection, outside-filter selection retention,
numeric sorting, URL filters and browser Back/Forward, full-results keyboard
access, focus preservation during recycling, density changes and 200% text.
At desktop width the fixture also narrows its containing column without resizing
the viewport. Drawer checks cover modal focus, Escape/restore and field
label/helper/error/ref/event composition. Loading, error/retry, empty states,
segmented keyboard controls, timeline dates and reduced-motion skeletons are
checked separately. This fixture is not a production route or an auth bypass.
The kit run also composes the real authentication provider, admin route,
Command Centre controller and content editor beside the filter bar. It changes
URL filters while the editor has an unsaved draft, then verifies that cancelled
workspace navigation and filter reset retain that draft. Short-label segmented
buttons are measured in both dimensions, not just their height.

`--header` checks actual visible workspace-heading text against header action
hitboxes at normal and 200% text. This detects overlaps that a page-width check
cannot catch; intentionally clipped text is excluded from the visible ranges.
`--compact` sets compact density through the actual shell control before admin
screenshots and assertions; the normal run starts with comfortable density.

`--form-data --forms-before --routes=/admin/forms` loads three fictional forms and
503 responses across two server pages. The baseline exercises editor draft
protection, complete CSV export, preserved versus reconstructed historical
records, archived answers and response navigation. This is read-only fixture
work; form mutations and all live APIs remain blocked. `--forms` additionally
checks original-record heading contrast against the rendered, composited
background. Do not combine it with
`--commands`, which owns a separate in-memory form mutation fixture.

`--calendar-data` supplies read-only fictional calendar data: member bookings,
public sign-ups, a FIFO waitlist candidate and a past class with a pending member
request. It is deliberately incompatible with the separate `--commands`
mutation fixture. Use it for the calendar's before/after screenshots:

```sh
node scripts/verify-design.mjs --tag=calendar --routes=/admin/calendar --calendar-data
```
Add `--calendar` to exercise the actual roster, FIFO promotion review, editor
discard cancellation, both attendance sources, pending-member blocker and
waitlist failure/retry. These checks cancel before any mutation. They also
verify that New Class opens and that consumed deep-link intents retain unrelated
URL parameters. `--calendar-before` captures the pre-conversion baseline using
an existing class editor; it deliberately omits those two known-broken legacy
assertions and must not be used as the final conversion gate.
The final calendar pass measures date buttons in both dimensions at200% text,
uses Tab/Enter to select the last weekday column and checks that any horizontal
scrolling stays inside the date grid. It also checks whole attendance action
words, a fixed384px containing column and explicitly selected rosters outside
the current filters.

`--lead-data` supplies read-only, server-paginated member, trainer and partner
enquiries. It exposes exact result counts through the same CORS header the
Supabase client reads, applies search/status/projection/range and returns a
disabled provider handoff state. `--leads-before` exercises current pagination,
selection reset, detail viewing, filters, complete CSV export and error/retry;
`--leads` adds shared-density inheritance/persistence, page-scoped select-all,
dirty dismissal, failed-save draft retention,44px controls and fixed narrow-column
checks. Both use the same blocked-mutation fixture; neither supports successful lead
updates or provider dispatches.

`--form-data --forms` covers503fictional submissions across two server pages,
complete CSV export, draft discard/rejected-save retention, original captured
terms versus a clearly labelled reconstructed record, archived hidden/unmatched
answers, actual respondent/date/duration metadata, readable contrast and44px
reachable controls at200% text. Printable A4 PDFs are saved alongside screen
captures after checking paper color and hidden interactive controls. Inspect
the rendered PDF separately; producing a file alone is not print-layout approval.
`--forms-before` records preserved legacy flows without asserting new-kit behavior.
`--forms-loading` holds real list/analytics/full-record reads at the isolated
network boundary. It inspects composed placeholders, no fake controls and each
fragment's actual bounds inside a384px column at200% text.

`--qr` checks the existing QR component on the requested route, including an
actual PNG download with a1024px square image, opaque white canvas corner and
reachable download control at200% text. Use it on Orders without first visiting
Forms to catch accidental dependencies on the Forms lazy-loaded stylesheet.
This verifies export and layout, not QR decoding or live payment processing.

`--member-data --members-before` supplies112fictional accounts through the actual
server-paged RPC interface, with role/credit/search filters, activation snapshot,
manual follow-up queues and a detailed record. It exercises page2, archived note
visibility, unsent private-notice discard/rejected-send recovery, grant validation,
role-confirm cancellation, full112-record CSV and read-error recovery. Only scoped
read RPCs are fulfilled; no roles, credits, notes or notices are changed. Do not
combine this read-only dataset with `--commands` mutation fixtures.
`--member-geometry` adds an actual center-hit check for the enlarged notice Send
control; bounding rectangles alone can miss an overlapping sticky header.
`--members` adds native drawer keyboard containment, note/notice/grant/follow-up
keep-or-discard protection, rejected-write retention, a held notice submission,
stale-record mutation blocking, stable credit-grant retry IDs, narrow compact
layout and an off-page member intent that preserves filters and unrelated context.
It also focuses real native drawer and nested confirmation buttons and verifies
that Ctrl-K, shortcut help and navigation sequences stay paused inside them.
`--member-filters` isolates immediate search/role/credit changes with actual RPC
payload diagnostics. `--members-loading` holds the directory, activation metrics,
both queues and member-detail reads to inspect composed placeholders and each
fragment's bounds at384px/200% text. All mutation attempts remain locally rejected.

`--order-data --orders-before` supplies503 fictional orders through500+3-row
server reads and61 separate visitor sales. It checks mixed-currency suppression,
pagination, immutable purchased terms, all503 CSV records, filters and rejected
local refund/reconciliation requests. `--orders-error` adds the requirement that
a visitor-ledger read outage must appear visibly rather than look like no sales.
`--today-data --today-before` supplies two fictional classes with separate public
and member occupancy and five nonempty decision queues. It verifies the real
five queue destinations and four quick-action routes. `--today-error` asserts
that unavailable metric reads never become a false caught-up state; `--today`
adds that requirement plus enlarged-control checks to the final conversion run.
It never approves or reaches a real financial endpoint. Member and order datasets
are intentionally separate, as are read-only orders and command mutation fixtures.
`--today-data` supplies separate fictional public/member booking counts, the
ordered decision queues and two classes through the normal read interfaces.
This standalone dataset cannot be combined with the other rich fixtures.

Results and images are written under `.superpowers/design-proof/<tag>/` (local,
git-excluded proof). Keep the result JSON alongside screenshots: a screenshot alone
is not a passing assertion. Read the fixture request logs to distinguish a genuine
empty state from an endpoint the fixture has not implemented.

These are UI checks with controlled I/O, not end-to-end production transaction
tests. They never confirm a real booking, send a message or take a payment.

## Integration regression checks

Use `--calendar-data --calendar-search` with `/admin/calendar` to verify whole-timetable member/public-signup lookup, selected rosters outside retained filters, truthful lookup errors, recovery and enlarged-text results. The fictional search adapter enforces the real query/date/limit shape and never forwards requests.

The forms workflow also checks the merged one-person-per-row written-answer view, including first/last answer pairing and enlarged-text card indexes. `--qr` on `/admin/orders` downloads all three distinct visitor-pass PNGs and checks each displayed payment-page destination. These checks do not take payments or send receipts.

## Native verification

The existing **XERT iOS Verify** Codemagic workflow can be manually run against
`feat/design-overhaul`. Check the selected commit before starting. It generates
the Xcode project and runs the Swift unit tests on a Mac simulator. This workflow
does not publish a TestFlight build. Keep its build URL and exact SHA as evidence.

Use **XERT iOS Verify**, not **XERT iOS TestFlight**, for design checks. The manual
build dialog selects the branch and workflow separately; confirm both and then
confirm the resulting build overview names the intended SHA. Keep SSH/VNC off.

The verification workflow opts into XCTest attachment export. Its artifacts
include `build/test-results.xcresult` and exported PNG/JSON files under
`build/test-attachments/`. The test runner preserves Xcode's original result even
if attachment export fails. A successful build with no images is compilation/test
evidence only, not visual approval. A failed compile means the new tests did not
run, even when the workflow still produces a result bundle.

For each native change, record the following separately:

1. Exact commit and successful Xcode build/test result.
2. The real test fixture or workspace rendered, text size and simulator/device.
3. Retrieved screenshots inspected for wrapping, clipping, contrast and hierarchy.
4. Interaction checks for touch targets, selection, disabled/loading states and
   focus. A larger outer frame or a taller screenshot does not prove a hit area.
5. VoiceOver reading order, labels, values and actions on an actual simulator or
   device, plus Reduce Motion and Reduce Transparency behavior.

Native design-kit fixtures run inside the test target with fictional state and
no production screen, account or network requests. Their screenshots cover the
primitives, not owner workspaces that have not yet been converted. Never add an
authentication bypass to production screens to obtain screenshots. If a browser
blocks an artifact download, do not bypass its protections; report the missing
evidence and request the artifact through the normal user download flow.

Native visual evidence must cover the converted screens at default and
accessibility text sizes. A separate VoiceOver pass remains necessary; neither
source-pattern tests nor a compile-only result establishes that pass.
