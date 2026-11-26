/**
 * XERT has one floor, in Kingaroy, on one clock. Every class time a member
 * reads, every day a class is filed under, and every date in a staff export
 * therefore means the same thing: the time at the gym.
 *
 * Browsers format dates in the viewer's own timezone and Node runs CI in UTC,
 * so without this module a 6:00 am Brisbane class reads "7:00 am" to a visitor
 * in Sydney during daylight saving and is filed under the previous day by any
 * UTC process — which is exactly how a roster CSV ended up named for the day
 * before the class it contains.
 */

export const GYM_TIME_ZONE = 'Australia/Brisbane';

const toDate = value => {
  // `new Date(null)` is the epoch and `new Date(undefined)` is Invalid Date;
  // neither is a class time, so reject anything that is not a real input.
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const formatter = options => new Intl.DateTimeFormat('en-AU', { timeZone: GYM_TIME_ZONE, ...options });

const partsOf = (date, options) => {
  const parts = formatter(options).formatToParts(date);
  return type => parts.find(part => part.type === type)?.value || '';
};

/** `YYYY-MM-DD` for the gym's calendar day, whatever clock the viewer is on. */
export function gymDateKey(value) {
  const date = toDate(value);
  if (!date) return null;
  const part = partsOf(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Bring-a-friend day: the last Saturday of the month, on the gym's calendar.
 * A Saturday is the last one when the Saturday a week later is in the next
 * month. The database applies the same rule (class_bookings_guest_visit_day).
 */
export function isBringAFriendDay(value) {
  const key = gymDateKey(value);
  if (!key) return false;
  const [year, month, day] = key.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return weekday === 6 && day + 7 > daysInMonth;
}

/** e.g. `6:00 am` — the time printed on the door. */
export function gymTimeLabel(value) {
  const date = toDate(value);
  if (!date) return '';
  const part = partsOf(date, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`;
}

/** e.g. `Sat 15 Mar` — Intl adds a comma after the weekday; the cards do not. */
export function gymShortDateLabel(value) {
  const date = toDate(value);
  if (!date) return '';
  const part = partsOf(date, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

/** e.g. `Saturday 15 March`. */
export function gymDayLabel(value) {
  const date = toDate(value);
  if (!date) return '';
  return formatter({ weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

/** e.g. `Sat 15 Mar, 6:00 am`. */
export function gymDateTimeLabel(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${gymShortDateLabel(date)}, ${gymTimeLabel(date)}`;
}

/** Minutes past midnight at the gym — used to sort and bucket a day's classes. */
export function gymMinutesOfDay(value) {
  const date = toDate(value);
  if (!date) return null;
  const part = partsOf(date, { hour: '2-digit', minute: '2-digit', hour12: false });
  const hour = Number(part('hour'));
  const minute = Number(part('minute'));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // Intl renders midnight as 24 in some engines.
  return (hour % 24) * 60 + minute;
}
