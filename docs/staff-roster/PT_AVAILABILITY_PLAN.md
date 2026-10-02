# PT availability and booking: how it would extend the staff model

Status: **plan only.** No PT schema ships with the coach invites work. PT
booking is being built separately; this note records how it fits the staff
roster so the two do not collide.

## What exists today

- `staff_members`: one row per person who works at XERT (today: hired coaches
  who run group classes). It is linked to a sign-in (`profile_id`, by hand or
  through an invite link) and optionally to a website profile (`coach_id`).
- Roster **availability** (`staff_weekly_patterns`, `staff_availability_*`):
  a coach's *willingness to be rostered onto group classes* in a month. It is
  read by the manager's planning tools. It is **not** a promise to the public,
  and members never see it.
- `staff_capabilities`: what a person is qualified for (`first_aid`, a class
  type, …), with validity dates.
- Invite links (`staff_roster_invites`) onboard any staff member. Nothing in
  them is group-class specific.

## What PT booking needs that roster availability is not

Bookable PT time is a public offer: a member picks a slot and it is theirs.
Roster availability is internal and can be overruled by the manager. Mixing
them would let a planning answer ("I could do Tuesdays") turn into a booking.
So PT gets its own tables, keyed to the same `staff_members` row:

| Table (sketch) | Purpose |
| --- | --- |
| `staff_services` | What a trainer sells: `staff_id`, name, service type (`pt_1on1`, `pt_small_group`, …), **session length**, **price**, **packages** (e.g. 5 or 10 sessions at a set price), active flag. **Each coach sets their own prices, packages and session lengths**; the manager can see and switch off any service. |
| `staff_bookable_slots` | Times a trainer offers to the public: `staff_id`, `starts_at`, `ends_at` (or a weekly rule plus exceptions), which services fit, capacity (1 for 1-on-1). |
| `pt_bookings` | A member's booking of a slot for a service: member, slot, service, price snapshot, status, payment reference. Payments reuse the existing checkout/Stripe paths. |
| `pt_clients` (or a view) | "My clients" for a trainer: members with bookings with them, with only what a trainer needs. |

Rules that keep the two worlds apart:

1. A bookable slot must not overlap a published roster duty for the same
   person. The roster's single rule function (`staff_roster_assignment_problems`)
   would gain one check ("booked PT session"), and slot creation would check
   published assignments the other way round.
2. Roster availability answers never create or remove bookable slots, and
   bookable slots never count as roster availability.
3. Who may offer PT is a `staff_capabilities` row (e.g. `personal_training`)
   or a role, not a separate person table, so one person can coach classes
   and train clients.
4. Everything stays behind security-definer functions with direct table
   access revoked, like the roster.

## What the coach dashboard would gain

A **PT** tab on `/coaching` for staff with the PT capability: my services and
prices, my bookable times, my clients and upcoming sessions. The Home tab's
checklist would add "Set your PT prices" and "Publish your PT times". The
public side would be a booking page per trainer.

## Decisions for later

- Whether trainers' prices need manager approval before going live.
- Cancellation and refund windows for PT sessions.
- Whether the native app shows PT bookings (Dene: the app is for running the
  gym, not public, so the public booking flow is web-first).
