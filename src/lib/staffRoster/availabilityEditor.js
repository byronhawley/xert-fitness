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

/**
 * The tap grid's rows: one cell per weekday and class start time on the
 * timetable this month (not only the configured presets), each spanning the
 * real duty of the classes that start then. Same shape as presetShortcuts,
 * so a cell and a preset shortcut at the same time write the same window.
 */
export function classTimeShortcuts(sessions, presets = []) {
  const minutes = new Set(presets.map(item => item.minute));
  for (const session of sessions) {
    if (session.status !== 'cancelled') minutes.add(gymMinuteOf(session.start));
  }
  return presetShortcuts(sessions, [...minutes].sort((a, b) => a - b).map(minute => ({ minute })))
    .sort((a, b) => a.weekday - b.weekday || a.start - b.start);
}

/** Applies one answer to many cells at once (a whole day); null clears them. */
export function setShortcuts(payload, shortcuts, status) {
  return shortcuts.reduce((next, shortcut) => setShortcut(next, shortcut, status), payload);
}

const WHOLE_DAY = item => item.start === 0 && item.end === 1440;

/** Dates marked "away all day" (a whole-day UNAVAILABLE exception). */
export function awayDates(payload) {
  return [...new Set((payload?.exceptions || []).filter(item => item.status === 'UNAVAILABLE' && WHOLE_DAY(item)).map(item => item.date))].sort();
}

/**
 * Toggles "I'm away" for a date. Marking a day away replaces any other answer
 * for that date (a part-day change would contradict it); un-marking removes
 * only the whole-day away entry.
 */
export function toggleAwayDate(payload, date) {
  const exceptions = payload.exceptions || [];
  if (awayDates(payload).includes(date)) {
    return { ...payload, exceptions: exceptions.filter(item => !(item.date === date && item.status === 'UNAVAILABLE' && WHOLE_DAY(item))) };
  }
  return { ...payload, noAvailability: false, exceptions: [...exceptions.filter(item => item.date !== date), { date, start: 0, end: 1440, status: 'UNAVAILABLE' }] };
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The plain review: how many of the month's classes this answer covers, in
 * the coach's words. "Can do" counts every class they could be rostered on
 * (preferred and if-needed included); "can't" counts classes they ruled out.
 */
export function availabilitySummary(payload, monthKey, sessions) {
  const review = reviewClasses(payload, monthKey, sessions);
  const count = status => review.rows.filter(row => row.status === status).length;
  const prefer = count('PREFERRED');
  const canDo = prefer + count('AVAILABLE') + review.ifNeeded;
  const away = payload?.noAvailability ? 0 : awayDates(payload).length;
  const total = review.rows.length;
  let sentence;
  if (payload?.noAvailability) sentence = `You can’t coach any classes in this month.`;
  else if (total === 0) sentence = 'There are no classes on the timetable for this month yet.';
  else {
    const parts = [`You can do ${plural(canDo, 'class', 'classes')} of ${total}`];
    if (prefer) parts.push(`prefer ${prefer}`);
    if (review.unavailable) parts.push(`can’t do ${review.unavailable}`);
    if (away) parts.push(`away ${plural(away, 'day')}`);
    sentence = `${parts.join(', ')}.`;
  }
  return { ...review, total, canDo, prefer, cant: review.unavailable, away, sentence };
}

/**
 * The coach's status for a month, always shown in words:
 * not_open · not_started · draft · submitted · changed · reopened · missed.
 * `editedHere` is true once the coach has changed something this visit
 * (the autosaved draft exists even if `period.draft` is from before).
 */
export function availabilityStatus(period, { editedHere = false } = {}) {
  const phase = periodPhase(period);
  if (phase === 'none') return { key: 'none', label: 'Not asked yet', tone: 'neutral' };
  if (phase === 'not_open') return { key: 'not_open', label: 'Not open yet', tone: 'neutral' };
  const draft = Boolean(period.draft) || editedHere;
  if (phase === 'closed') return period.submission ? { key: 'submitted', label: 'Submitted', tone: 'success' } : { key: 'missed', label: 'Deadline passed', tone: 'danger' };
  if (period.reopened) return { key: 'reopened', label: draft ? 'Reopened · draft saved' : 'Reopened', tone: 'warning' };
  if (period.submission && draft) return { key: 'changed', label: 'Changes not submitted', tone: 'warning' };
  if (period.submission) return { key: 'submitted', label: 'Submitted', tone: 'success' };
  if (draft) return { key: 'draft', label: 'Draft saved', tone: 'info' };
  return { key: 'not_started', label: 'Not started', tone: 'warning' };
}
