/**
 * Decides what the public timetable offers for a single class.
 *
 * Every class carries its own `booking_mode`, which the public site used to
 * ignore entirely — every class showed "Request spot" and nothing ever took a
 * place. The owner now chooses per class:
 *
 *   interest_only    register interest, no spot is held
 *   request_to_book  a request staff confirm, no spot is held
 *   instant_book     sign-ups accepted: the first `capacity` people take a spot
 *
 * Remaining places come from `public_class_availability()`, which counts
 * confirmed public sign-ups alongside member bookings and reports a class as
 * having no places while a member is waitlisted for it. That function also
 * reports the owner's site-wide booking switch (`bookings_open`) and whether a
 * real spot can be taken right now (`can_take_spot`), so the button and the
 * database agree about what pressing it will do.
 *
 * The database is what actually enforces capacity; this module only decides
 * what to show, and fails safe to the non-committal option when availability is
 * unknown.
 */

export const BOOKING_MODES = ['interest_only', 'request_to_book', 'instant_book'];

export const BOOKING_MODE_LABELS = {
  interest_only: 'Register interest only',
  request_to_book: 'Request to book (staff confirm)',
  instant_book: 'Sign-ups accepted (takes a spot)',
};

export function normalizeBookingMode(mode) {
  return BOOKING_MODES.includes(mode) ? mode : 'request_to_book';
}

/** Remaining places for one class, or null when capacity is unlimited/unknown. */
export function spotsRemaining(availability) {
  const left = availability?.spots_left;
  if (left === null || left === undefined) return null;
  const value = Number(left);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

export function spotsLabel(availability) {
  const left = spotsRemaining(availability);
  if (left === null) return null;
  if (left === 0) return 'No spots left';
  return `${left} spot${left === 1 ? '' : 's'} left`;
}

/**
 * Unlimited capacity and "we could not load availability" both arrive as a null
 * remaining count, and they mean opposite things: the first is safe to offer a
 * spot on, the second is not. This tells them apart by whether the row exists.
 */
export function availabilityKnown(availability) {
  if (!availability || typeof availability !== 'object') return false;
  return 'spots_left' in availability || 'capacity' in availability || 'can_take_spot' in availability;
}

/** How many people are queued ahead of a new sign-up, when the view reports it. */
export function waitingCount(availability) {
  const waiting = Number(availability?.waiting);
  return Number.isFinite(waiting) ? Math.max(0, Math.trunc(waiting)) : 0;
}

/**
 * The owner's site-wide booking switch. `public_class_availability` carries it
 * per row so the timetable cannot show a bookable class from one source while
 * the switch that governs it came from another.
 */
function bookingsAreOpen(availability, bookingsEnabled) {
  if (availability && typeof availability.bookings_open === 'boolean') return availability.bookings_open;
  return Boolean(bookingsEnabled);
}

/**
 * @returns {{kind: string, label: string, detail: string|null, spotsLeft: number|null,
 *            takesSpot: boolean, actionable: boolean, joinWaitlist: boolean}}
 */
export function classSignupState({
  session = null,
  availability = null,
  bookingsEnabled = true,
  fitbox = null,
  now = new Date(),
} = {}) {
  if (fitbox?.blocked) {
    return {
      kind: 'provider-unavailable',
      label: 'Booking temporarily unavailable',
      detail: fitbox.blockedReason || 'The member portal needs attention. Please try again shortly.',
      spotsLeft: null,
      takesSpot: false,
      actionable: false,
      joinWaitlist: false,
    };
  }

  if (fitbox?.active) {
    return {
      kind: 'fitbox',
      label: 'Continue to FitBox booking',
      detail: null,
      spotsLeft: null,
      takesSpot: false,
      actionable: true,
      joinWaitlist: false,
    };
  }

  const start = session?.start_time ? new Date(session.start_time) : null;
  if (start && Number.isFinite(start.getTime()) && start.getTime() <= now.getTime()) {
    return {
      kind: 'past',
      label: 'Class has started',
      detail: null,
      spotsLeft: null,
      takesSpot: false,
      actionable: false,
      joinWaitlist: false,
    };
  }

  const mode = normalizeBookingMode(session?.booking_mode);
  const spotsLeft = spotsRemaining(availability);
  const known = availabilityKnown(availability);
  const bookingsOpen = bookingsAreOpen(availability, bookingsEnabled);
  const noPlacesLeft = known && (spotsLeft === 0 || waitingCount(availability) > 0);

  const waitlistState = detail => ({
    kind: 'waitlist',
    label: 'Join the waitlist',
    detail,
    spotsLeft: 0,
    takesSpot: false,
    actionable: true,
    joinWaitlist: true,
  });

  // A site-wide booking pause never blocks interest capture: the class can
  // still collect names, it just cannot hold a place. The database enforces the
  // same rule, so the promise on the button is the promise that is kept.
  if (!bookingsOpen) {
    return {
      kind: 'interest',
      label: 'Register interest',
      detail: 'Bookings open soon — register and we will let you know first.',
      spotsLeft,
      takesSpot: false,
      actionable: true,
      joinWaitlist: false,
    };
  }

  if (mode === 'interest_only') {
    return {
      kind: 'interest',
      label: 'Register interest',
      detail: 'This class is collecting interest — no spot is held yet.',
      spotsLeft,
      takesSpot: false,
      actionable: true,
      joinWaitlist: false,
    };
  }

  if (mode === 'instant_book') {
    // can_take_spot is the database's own answer, and it knows about the member
    // waitlist and the class start time as well as the count.
    const full = session?.status === 'full' || noPlacesLeft || availability?.can_take_spot === false;

    if (full) {
      // Never a dead end: the same form records "contact me if a place frees
      // up", which holds no spot and is what the copy has always promised.
      return waitlistState('Every spot is taken. Leave your details and we will contact you the moment one frees up.');
    }
    // Only promise a held spot when we actually know the class has room. When
    // the availability call failed there is no count to trust, so fall back to
    // the request the owner can accept or decline by hand.
    if (!known) {
      return {
        kind: 'request',
        label: 'Request spot',
        detail: 'Staff confirm this booking.',
        spotsLeft: null,
        takesSpot: false,
        actionable: true,
        joinWaitlist: false,
      };
    }
    return {
      kind: 'signup',
      label: 'Sign up',
      detail: spotsLabel(availability),
      spotsLeft,
      takesSpot: true,
      actionable: true,
      joinWaitlist: false,
    };
  }

  // request_to_book still consumes the same room, and staff cannot confirm a
  // request into a class that has no place for it — so offering "Request spot"
  // on a full class is a promise nobody can keep.
  if (noPlacesLeft) {
    return waitlistState('This class is full. Leave your details and we will contact you if a place frees up.');
  }

  return {
    kind: 'request',
    label: 'Request spot',
    detail: 'Staff confirm this booking.',
    spotsLeft,
    takesSpot: false,
    actionable: true,
    joinWaitlist: false,
  };
}

/** Confirmation copy shown after a successful submission. */
export function signupOutcomeMessage(result) {
  if (result?.took_spot) {
    const left = spotsRemaining(result);
    const tail = left === null ? '' : ` ${left} spot${left === 1 ? '' : 's'} remaining.`;
    return {
      title: "You're in",
      body: `Your spot is confirmed and we have your details.${tail}`,
      cancelToken: result?.cancel_token || null,
    };
  }
  if (result?.waitlisted) {
    return {
      title: "You're on the waitlist",
      body: 'This class is full. We have your details and will contact you the moment a spot frees up.',
    };
  }
  if (result?.bookings_open === false) {
    return {
      title: 'Interest registered',
      body: 'Bookings are not open yet, so no spot is held. We have your details and will contact you first when they open.',
    };
  }
  if (result?.booking_mode === 'interest_only') {
    return {
      title: 'Interest registered',
      body: 'Thanks — we have your details and will be in touch about this class.',
    };
  }
  return {
    title: 'Request received',
    body: 'Thanks — XERT will confirm your spot shortly.',
  };
}

/** Maps database errors to copy a member can act on. */
export const SIGNUP_ERRORS = {
  CLASS_FULL: 'That was the last spot — this class just filled up. Join the waitlist and we will contact you if one frees up.',
  CLASS_WAITLISTED: 'Someone is already waiting for a place in this class, so they go first. Join the waitlist to be next in line.',
  ALREADY_SIGNED_UP: 'That email is already signed up for this class.',
  ALREADY_BOOKED_AS_MEMBER: 'You already have a place in this class through your XERT account.',
  CLASS_STARTED: 'This class has already started.',
  CLASS_NOT_OPEN: 'This class is not open for sign-ups.',
  CLASS_NOT_FOUND: 'This class is no longer on the timetable.',
  CONSENT_REQUIRED: 'Please tick the consent box so we can contact you.',
  NAME_REQUIRED: 'Enter your full name.',
  EMAIL_REQUIRED: 'Enter a valid email address.',
  PHONE_REQUIRED: 'Enter a valid phone number.',
  NOTES_TOO_LONG: 'Please shorten your note.',
  SIGNUP_NOT_FOUND: 'We could not find that sign-up. It may already have been cancelled.',
  SIGNUP_ALREADY_MARKED: 'This class has already been marked off, so it can no longer be cancelled here.',
};

export function friendlySignupError(error) {
  const raw = String(error?.message || error || '');
  for (const [code, message] of Object.entries(SIGNUP_ERRORS)) {
    if (raw.includes(code)) return message;
  }
  return 'Sign-up failed. Please try again.';
}

/**
 * The technical reason behind a failure the form has no words for, short
 * enough to sit in small print under "Sign-up failed". A screenshot of the
 * form then says what went wrong, where "Please try again" said nothing.
 * Null for the failures that already have their own message.
 */
export function signupErrorDetail(error) {
  const raw = String((error && typeof error === 'object' ? error.message : error) || '').trim();
  if (!raw || Object.keys(SIGNUP_ERRORS).some(code => raw.includes(code))) return null;
  const code = String(error?.code || '').trim();
  const detail = `${code && !raw.startsWith(code) ? `${code}: ` : ''}${raw}`;
  return detail.length > 180 ? `${detail.slice(0, 179)}…` : detail;
}
