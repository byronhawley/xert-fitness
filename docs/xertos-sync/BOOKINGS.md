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
