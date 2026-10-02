/**
 * PT booking API client. Every call goes through a database entry point
 * (`pt_*`); the PT tables are never read directly, and the database checks
 * permissions, open times and conflicts again on every call.
 *
 * Mutations carry a request id so a retried tap returns the first result
 * instead of booking or saving twice.
 */
import { gymDateKey, gymMinutesOfDay } from './gymTime.js';

export const PT_ERROR_MESSAGES = Object.freeze({
  PT_DISABLED: 'Personal training bookings are not open yet.',
  SIGN_IN_REQUIRED: 'Please sign in again.',
  NOT_STAFF: 'This account is not linked to a coach. Ask the manager to link it.',
  STAFF_INACTIVE: 'This coach is inactive.',
  MANAGER_ONLY: 'Only managers can do this.',
  STALE_VERSION: 'Someone else changed this since you opened it. Refresh and try again.',
  REQUEST_ID_REUSED: 'Something went wrong preparing the request. Try again.',
  REQUEST_ID_REQUIRED: 'Something went wrong preparing the request. Try again.',
  SERVICE_NOT_FOUND: 'That session type is no longer offered.',
  SERVICE_INVALID: 'Check the name, length (15 to 240 minutes, in 5s) and price.',
  PACKAGE_NOT_FOUND: 'That package is no longer available.',
  PACKAGE_INVALID: 'Check the package name, number of sessions (2 to 100) and price.',
  HOURS_INVALID: 'Each block needs a start before its end, on 5-minute marks.',
  HOURS_OVERLAP: 'Two blocks on the same day overlap.',
  TIME_OFF_INVALID: 'Choose a start and an end in the future, up to 120 days apart.',
  SLOT_UNAVAILABLE: 'That time has just been taken or is no longer free. Pick another time.',
  DETAILS_INVALID: 'Check your name, email and phone.',
  TOO_MANY_BOOKINGS: 'You already have the most upcoming sessions allowed with this coach. Contact them to book more.',
  BOOKING_NOT_FOUND: 'We couldn’t find that booking.',
  CANCEL_TOO_LATE: 'It’s too close to the session to cancel online. Please contact your coach.',
  BOOKING_NOT_PENDING: 'That request has already been answered.',
  BOOKING_NOT_ACTIVE: 'That session is no longer booked.',
  BOOKING_STARTED: 'That session has already started.',
  BOOKING_NOT_STARTED: 'You can mark this once the session has started.',
  PAID_BY_PACKAGE: 'This session comes out of a package. Mark the package paid instead.',
  CLIENT_NOT_FOUND: 'That client is no longer on your list.',
  DECISION_INVALID: 'That change is not supported.',
  RANGE_INVALID: 'Choose a valid date range.',
  SETTINGS_INVALID: 'One of the settings is outside the allowed range.',
});

const CODE_PATTERN = /\b([A-Z][A-Z0-9_]{3,})\b/;

/** Turns a PostgREST/Postgres error into a readable Error with a `code`. */
export function ptError(error) {
  const raw = String(error?.message || error || '');
  const code = raw.match(CODE_PATTERN)?.[1] || null;
  const message = (code && PT_ERROR_MESSAGES[code]) || 'Something went wrong. Try again.';
  return Object.assign(new Error(message), { code, cause: error });
}

export function newRequestId() {
  return globalThis.crypto.randomUUID();
}

/**
 * @param rpc `(name, params) => Promise<{ data, error }>`: supabase.rpc in the
 * app, a local database in tests.
 */
export function createPtClient(rpc) {
  const call = async (name, params = {}) => {
    const { data, error } = await rpc(`pt_${name}`, params);
    if (error) throw ptError(error);
    return data;
  };
  const rid = () => newRequestId();
  return {
    // ── Public ──
    coaches: () => call('public_coaches'),
    slots: (serviceId, fromDate, days = 7) => call('public_slots', { p_service_id: serviceId, p_from: fromDate, p_days: days }),
    book: (booking, requestId = rid()) => call('public_book', { p_booking: booking, p_request_id: requestId }),
    booking: token => call('public_booking', { p_token: token }),
    cancel: token => call('public_cancel', { p_token: token }),
    // ── Coach ──
    overview: () => call('coach_overview'),
    saveService: service => call('coach_save_service', { p_service: service, p_request_id: rid() }),
    savePackage: pack => call('coach_save_package', { p_package: pack, p_request_id: rid() }),
    saveHours: (hours, bufferMinutes, version) => call('coach_save_hours', { p_hours: hours, p_buffer_minutes: bufferMinutes, p_expected_version: version }),
    addTimeOff: (startsAt, endsAt, note) => call('coach_add_time_off', { p_starts_at: startsAt, p_ends_at: endsAt, p_note: note || null, p_request_id: rid() }),
    removeTimeOff: id => call('coach_remove_time_off', { p_id: id }),
    updateBooking: (bookingId, action, note = null) => call('coach_update_booking', { p_booking_id: bookingId, p_action: action, p_note: note, p_request_id: rid() }),
    coachBook: booking => call('coach_book', { p_booking: booking, p_request_id: rid() }),
    clients: () => call('coach_clients'),
    clientHistory: clientId => call('coach_client_history', { p_client_id: clientId }),
    updateClient: (clientId, note) => call('coach_update_client', { p_client_id: clientId, p_note: note }),
    clientPackage: change => call('coach_client_package', { p_change: change, p_request_id: rid() }),
    // ── Manager ──
    adminOverview: (fromDate, toDate) => call('admin_overview', { p_from: fromDate, p_to: toDate }),
    adminUpdateSettings: (patch, version) => call('admin_update_settings', { p_patch: patch, p_expected_version: version }),
  };
}

let defaultClient = null;

export async function ptClient() {
  if (!defaultClient) {
    const { supabase } = await import('./supabase.js');
    defaultClient = createPtClient((name, params) => supabase.rpc(name, params));
  }
  return defaultClient;
}

// ── Presentation helpers (pure) ────────────────────────────────────────────

export function formatPrice(cents) {
  const value = Number(cents) || 0;
  return value % 100 === 0 ? `$${value / 100}` : `$${(value / 100).toFixed(2)}`;
}

/** Whole dollars or dollars and cents typed by a coach → cents, or null. */
export function parsePrice(text) {
  const cleaned = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function formatDuration(minutes) {
  const value = Number(minutes) || 0;
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** Package saving against booking the same number of single sessions. */
export function packageSaving(servicePriceCents, pack) {
  const singles = (Number(servicePriceCents) || 0) * (Number(pack?.sessions_count) || 0);
  const saving = singles - (Number(pack?.price_cents) || 0);
  return saving > 0 ? saving : 0;
}

/** Open slot instants grouped by gym date, keeping order. */
export function groupSlotsByDay(slots) {
  const days = new Map();
  for (const value of slots || []) {
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) continue;
    const key = gymDateKey(ms);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push({ iso: new Date(ms).toISOString(), minute: gymMinutesOfDay(ms) });
  }
  return [...days.entries()].map(([date, times]) => ({ date, times }));
}

export const BOOKING_STATUS_WORDS = Object.freeze({
  requested: 'Waiting for coach',
  confirmed: 'Booked',
  declined: 'Declined',
  cancelled: 'Cancelled',
  completed: 'Done',
  no_show: 'No-show',
});

export const PAYMENT_WORDS = Object.freeze({
  unpaid: 'Not paid yet',
  paid: 'Paid',
  package: 'From package',
  waived: 'No charge',
});

/** Validates the public booking form; returns an error message or ''. */
export function bookingDetailsError({ full_name: name, email, phone }) {
  if (!String(name || '').trim()) return 'Enter your name.';
  if (String(name).trim().length > 120) return 'That name is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())) return 'Enter a valid email so we can send your confirmation.';
  if (String(phone || '').trim().length > 40) return 'That phone number is too long.';
  return '';
}
