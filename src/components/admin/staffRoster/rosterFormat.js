import { addDays, gymDateOf, gymMinuteOf, minuteLabel, parseDateKey, weekStartOf } from '@/lib/staffRoster/time';
import { STATUS_LABELS } from '@/lib/staffRoster/availability';
import { ROLE_LABELS } from '@/lib/staffRoster/duty';

export { STATUS_LABELS, ROLE_LABELS };

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

/** `Tue 8 Dec` for a gym date key. */
export function dayLabel(dateKey, { weekday = true } = {}) {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day));
  const short = MONTHS[month - 1].slice(0, 3);
  return weekday ? `${WEEKDAY_SHORT[date.getUTCDay()]} ${day} ${short}` : `${day} ${short}`;
}

export function timeLabel(instant) {
  return minuteLabel(gymMinuteOf(instant));
}

export function sessionLabel(session) {
  if (!session) return 'A class';
  return `${session.title} · ${dayLabel(gymDateOf(session.start))} ${timeLabel(session.start)}`;
}

export function weekDates(dateKey) {
  const start = weekStartOf(dateKey);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function staffName(ctx, staffId) {
  return ctx?.staff.get(staffId)?.name || 'Unknown coach';
}

/** Tone for an availability answer, used by badges and the matrix. */
export const STATUS_TONE = Object.freeze({
  PREFERRED: 'success', AVAILABLE: 'success', IF_NEEDED: 'warning', UNAVAILABLE: 'danger', UNKNOWN: 'neutral', PARTIAL: 'warning', ABSENT: 'danger',
});

export const SUBMISSION_LABELS = Object.freeze({
  submitted: 'Submitted',
  submitted_none: 'Unavailable all month',
  reopened: 'Reopened',
  not_open: 'Not open yet',
  overdue: 'Overdue',
  draft: 'Draft started',
  not_submitted: 'Not submitted',
  no_account: 'No sign-in linked',
});

export const SUBMISSION_TONE = Object.freeze({
  submitted: 'success', submitted_none: 'info', reopened: 'warning', not_open: 'neutral', overdue: 'danger', draft: 'warning', not_submitted: 'warning', no_account: 'neutral',
});
