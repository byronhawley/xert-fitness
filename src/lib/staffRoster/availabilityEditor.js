/**
 * Pure helpers behind the coach's availability screen: class-time shortcuts,
 * the review step, and the starting point for a new month. Kept out of the
 * component so the same rules are testable without a browser.
 */
import { expandAvailability, intervalAvailability, slotShortcuts, startFromPattern, validateAvailability } from './availability.js';
import { gymDateOf, gymMinuteOf, minuteLabel, toMs } from './time.js';

export const EMPTY_AVAILABILITY = Object.freeze({ weekly: [], exceptions: [], noAvailability: false });

/** Month classes (from `staff_roster_month_classes`) in engine shape. */
export function monthClassSessions(rows = []) {
  return rows.map(row => ({
    id: row.id, title: row.title, classType: row.class_type, status: 'published',
    start: toMs(row.start), end: toMs(row.end), dutyStart: toMs(row.duty_start), dutyEnd: toMs(row.duty_end),
  }));
}

/** Shortcuts for the configured presets; each spans the real duty of that weekday's classes. */
export function presetShortcuts(sessions, presets = []) {
  const labelled = presets.map(item => ({ minute: item.minute, label: minuteLabel(item.minute) }));
  return slotShortcuts(sessions, labelled, { gymDate: gymDateOf, gymMinute: gymMinuteOf, dutyOf: session => ({ start: session.dutyStart, end: session.dutyEnd }) });
}

/** Status a shortcut currently has in the usual week, or null when not set or only partly set. */
export function shortcutStatus(payload, shortcut) {
  const match = (payload.weekly || []).find(item => item.weekday === shortcut.weekday && item.start === shortcut.start && item.end === shortcut.end);
  return match ? match.status : null;
}

/** Sets (or clears, with status null) a shortcut's window in the usual week. */
export function setShortcut(payload, shortcut, status) {
  const weekly = (payload.weekly || []).filter(item => !(item.weekday === shortcut.weekday && item.start === shortcut.start && item.end === shortcut.end));
  if (status) weekly.push({ weekday: shortcut.weekday, start: shortcut.start, end: shortcut.end, status });
  return { ...payload, weekly, noAvailability: false };
}

/**
 * The review step: how the server will read this answer for every class in
 * the month. PARTIAL and UNKNOWN are called out because they are not
 * "available" — a coach is only considered for duties they fully cover.
 */
export function reviewClasses(payload, monthKey, sessions) {
  const { errors } = validateAvailability(payload, monthKey);
  const windows = errors.length ? [] : expandAvailability(payload, monthKey);
  const rows = sessions.map(session => ({ session, status: errors.length ? 'UNKNOWN' : intervalAvailability(windows, session.dutyStart, session.dutyEnd) }));
  const count = status => rows.filter(row => row.status === status).length;
  return {
    errors,
    rows,
    considered: count('PREFERRED') + count('AVAILABLE'),
    ifNeeded: count('IF_NEEDED'),
    partial: count('PARTIAL'),
    unknown: count('UNKNOWN'),
    unavailable: count('UNAVAILABLE'),
  };
}

/**
 * Where a month's answer starts: an existing draft, else the latest
 * submission for this month, else the usual week. Date exceptions and
 * whole-month answers never carry over from another month.
 */
export function startingPoint(period, usualWeek) {
  if (period?.draft?.payload) return { payload: period.draft.payload, source: 'draft' };
  if (period?.submission?.payload) return { payload: { ...EMPTY_AVAILABILITY, ...period.submission.payload, noAvailability: Boolean(period.submission.no_availability || period.submission.payload.noAvailability) }, source: 'submission' };
  if (usualWeek?.pattern?.length) return { payload: startFromPattern(usualWeek.pattern), source: 'usual_week' };
  return { payload: { ...EMPTY_AVAILABILITY }, source: 'blank' };
}

/** What a coach can do with a period today. */
export function periodPhase(period) {
  if (!period) return 'none';
  if (!period.is_open) return 'not_open';
  if (period.deadline_passed && !period.reopened) return 'closed';
  return 'open';
}
