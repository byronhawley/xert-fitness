# XertOS two-way bookings

Class bookings are shared with XertOS for XERT Fitness only (owner decision,
10 Oct 2026). XERT stays in charge of its classes and bookings: members keep
booking here, and XertOS mirrors them. A booking or cancellation made in
XertOS is sent here first and only lands in XertOS once XERT accepts it,
through the same rules the front desk uses.

Migration `20261010010000_xertos_two_way_bookings.sql` changes nothing until
both switches are on.

## Switching it on

Do this only after XertOS has migration 0040 and the calendar sync is working.

1. Send bookings with each class (Supabase SQL editor):

   ```sql
   update public.xertos_sync_settings set share_bookings = true;
   ```

   Every class XertOS receives from then on carries its bookings: name, email
   and whether the person holds a place or is waiting. XertOS matches people
   by email only, and only when exactly one XertOS person has that email.

2. Accept bookings from XertOS by setting `CLIENT0_BOOKING_WRITES_ENABLED=true`
   in Vercel, next to `CLIENT0_SYNC_ENABLED=true`, then redeploy.

To switch off, reverse either step. With step 1 off, XertOS goes back to
saying "book on XERT Fitness" for these classes.

## What XertOS can ask

- `book`: books the XERT member with that email into the class, or puts them
  on its waitlist. Refused when no XERT member account has the email, or when
  more than one does.
- `cancelBooking`: cancels a member booking or a public sign-up on the class.
- `refreshBookings`: after staff match a website booking to an existing XertOS
  person, asks XERT to send the current class-and-bookings snapshot through the
  existing class outbox. It does not create a booking or change class,
  capacity, attendance or the site's booking authority. An already-pending
  snapshot is reused; a refresh racing an in-flight send schedules a follow-up
  snapshot. A class sent within the last 30 seconds returns a retryable 429.
  This action needs the global `CLIENT0_SYNC_ENABLED` connection gate and the
  database `share_bookings` switch; it does not require XertOS-originated
  booking writes to be enabled. Send the signed request to
  `/api/xertos-webhook`; Vercel rewrites it to the existing webhook function,
  whose canonical fingerprint target is `/api/stripe-webhook?provider=xertos`.
  On 429, no receipt is consumed: wait for `retryAfterSeconds` and retry the
  exact same signed body with the same `requestId`. A 200 `already_pending`
  means the existing outbox already owns the next current snapshot; it is not
  a second booking and must not be converted into another booking request.
  The endpoint validates the versioned `XERTOS_WRITE_SECRET` (including an
  explicitly configured previous version during key rotation), an exact-byte
  HMAC, a five-minute timestamp window and the `xert_fitness` site identity
  before its internal refresh callback can queue anything. The refresh does
  **not** depend on the older unversioned `XERTOS_SITE_SECRET`; other existing
  calendar and booking write actions retain their prior checks.
  With `CLIENT0_SYNC_ENABLED` off, a refresh is refused with **409
  `SYNC_OFF`**, the same answer as the database switch, so XertOS treats a
  deliberate off switch as final rather than retrying it as an outage. Switching
  the gate back on accepts the same signed request; a 501 `ACTION_NOT_READY`
  now only means the deployment has no write handler wired. Only the refresh
  branch tells the write handler the versioned HMAC covered the request
  (`verifiedRefresh`); create, update, cancel, book and cancelBooking still
  answer 409 `SYNC_OFF` without a legacy `XERTOS_SITE_SECRET`.

### Rotating the XertOS write key

| Variable | Meaning |
| --- | --- |
| `XERTOS_WRITE_SECRET` / `XERTOS_WRITE_SECRET_VERSION` | The current key and its positive integer version, matching XertOS's `write_secret_version`. |
| `XERTOS_PREVIOUS_WRITE_SECRET` / `XERTOS_PREVIOUS_WRITE_SECRET_VERSION` | The key being retired and its version, during the overlap only. |
| `XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT` | **Required for the previous key to be accepted.** An ISO 8601 instant with an explicit zone, e.g. `2026-12-01T00:00:00Z`. Set it to XertOS's `previous_write_secret_until` for the connection. |

The previous key is accepted only while now is before the expiry. A missing,
date-only, zone-less or otherwise unreadable expiry means the previous key is
not accepted at all; the current key is unaffected. After the expiry, remove
both previous variables. No response ever includes a key value.

