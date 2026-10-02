/**
 * Coach availability: a usual week plus date exceptions, turned into concrete
 * time windows for one roster month, and the rules for reading a duty against
 * them.
 *
 * Precedence for a duty interval:
 *   1. An approved (or reported urgent) absence blocks outright.
 *   2. A current, explicit session-specific response comes next.
 *   3. Date exceptions override the overlapping part of the weekly pattern.
 *   4. Anything not stated is UNKNOWN — never "available".
 *
 * A duty is only eligible when submitted windows explicitly cover the whole
 * interval. A morning window that covers 5:15 but stops before the 6:15 class
 * finishes is PARTIAL, not available.
 */
import { datesOfMonth, gymInstant, isDateKey, mergeIntervals, monthKeyOf, overlaps, subtractIntervals, weekdayOf, covers } from './time.js';

export const AVAILABILITY_STATUSES = Object.freeze(['PREFERRED', 'AVAILABLE', 'IF_NEEDED', 'UNAVAILABLE']);
export const POSITIVE_STATUSES = Object.freeze(['PREFERRED', 'AVAILABLE', 'IF_NEEDED']);
const RANK = Object.freeze({ IF_NEEDED: 1, AVAILABLE: 2, PREFERRED: 3 });

export const STATUS_LABELS = Object.freeze({
  PREFERRED: 'Preferred',
  AVAILABLE: 'Available',
  IF_NEEDED: 'If needed',
  UNAVAILABLE: 'Unavailable',
  UNKNOWN: 'Not stated',
  PARTIAL: 'Only part of this time',
  ABSENT: 'Approved absence',
});

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function validWindowMinutes(window) {
  return Number.isInteger(window.start) && Number.isInteger(window.end)
    && window.start >= 0 && window.end <= 1440 && window.end > window.start;
}

function windowLabel(window) {
  const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return `${clock(window.start)}–${clock(window.end)}`;
}

function contradictions(windows, groupKey, describe) {
  const errors = [];
  const groups = new Map();
  for (const window of windows) {
    const key = groupKey(window);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(window);
  }
  for (const [, group] of groups) {
    const sorted = [...group].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
        if (sorted[i].status !== sorted[j].status) {
          errors.push(`${describe(sorted[i])}: ${windowLabel(sorted[i])} is ${STATUS_LABELS[sorted[i].status].toLowerCase()} but ${windowLabel(sorted[j])} is ${STATUS_LABELS[sorted[j].status].toLowerCase()}. Pick one.`);
        }
      }
    }
  }
  return errors;
}

/** Normalises a submission payload; throws nothing, returns `{ value, errors }`. */
export function validateAvailability(submission = {}, monthKey) {
  const errors = [];
  const weekly = Array.isArray(submission.weekly) ? submission.weekly : [];
  const exceptions = Array.isArray(submission.exceptions) ? submission.exceptions : [];
  const noAvailability = Boolean(submission.noAvailability);

  const cleanWeekly = [];
  for (const window of weekly) {
    const item = { weekday: Number(window.weekday), start: Number(window.start), end: Number(window.end), status: window.status };
    if (!Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6) { errors.push('A usual-week time has no valid weekday.'); continue; }
    if (!AVAILABILITY_STATUSES.includes(item.status)) { errors.push(`${WEEKDAY_NAMES[item.weekday]}: choose Preferred, Available, If needed or Unavailable.`); continue; }
    if (!validWindowMinutes(item)) { errors.push(`${WEEKDAY_NAMES[item.weekday]}: a time must end after it starts, within the day.`); continue; }
    cleanWeekly.push(item);
  }
  const cleanExceptions = [];
  for (const window of exceptions) {
    const item = { date: String(window.date || ''), start: Number(window.start), end: Number(window.end), status: window.status };
    if (!isDateKey(item.date) || (monthKey && monthKeyOf(item.date) !== monthKey)) { errors.push(`${item.date || 'A date'} is not in this roster month.`); continue; }
    if (!AVAILABILITY_STATUSES.includes(item.status)) { errors.push(`${item.date}: choose Preferred, Available, If needed or Unavailable.`); continue; }
    if (!validWindowMinutes(item)) { errors.push(`${item.date}: a time must end after it starts, within the day.`); continue; }
    cleanExceptions.push(item);
  }
  // The server refuses more than 200 usual-week times or 400 date times outright.
  if (weekly.length > 200) errors.push('Too many usual-week times (over 200). Combine some of them.');
  if (exceptions.length > 400) errors.push('Too many separate times this month (over 400). Mark fewer days, or answer whole days instead of single classes.');
  errors.push(...contradictions(cleanWeekly, window => window.weekday, window => WEEKDAY_NAMES[window.weekday]));
  errors.push(...contradictions(cleanExceptions, window => window.date, window => window.date));
  if (noAvailability && (cleanWeekly.some(item => item.status !== 'UNAVAILABLE') || cleanExceptions.some(item => item.status !== 'UNAVAILABLE'))) {
    errors.push('You marked the whole month unavailable but also gave available times. Clear those times or untick “Unavailable for the whole month”.');
  }
  if (!noAvailability && cleanWeekly.length === 0 && cleanExceptions.length === 0) {
    errors.push('Add at least one time, or choose “Unavailable for the whole month”.');
  }
  const sortWeekly = (a, b) => a.weekday - b.weekday || a.start - b.start || a.end - b.end || a.status.localeCompare(b.status);
  const sortExceptions = (a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.end - b.end || a.status.localeCompare(b.status);
  return {
    value: {
      weekly: noAvailability ? [] : cleanWeekly.sort(sortWeekly),
      exceptions: noAvailability ? [] : cleanExceptions.sort(sortExceptions),
      noAvailability,
    },
    errors,
  };
}

/**
 * Concrete windows for every gym date in the month. Exceptions replace the
 * overlapping part of that day's weekly pattern; the rest of the pattern stays.
 */
export function expandAvailability(submission, monthKey) {
  const { value } = validateAvailability(submission, monthKey);
  const dates = datesOfMonth(monthKey);
  if (value.noAvailability) {
    return [{ date: dates[0], start: gymInstant(dates[0], 0), end: gymInstant(dates[dates.length - 1], 1440), status: 'UNAVAILABLE', source: 'month' }];
  }
  const windows = [];
  for (const date of dates) {
    const weekday = weekdayOf(date);
    const dayExceptions = value.exceptions.filter(item => item.date === date)
      .map(item => ({ start: gymInstant(date, item.start), end: gymInstant(date, item.end), status: item.status }));
    const cuts = mergeIntervals(dayExceptions);
    for (const status of AVAILABILITY_STATUSES) {
      const weekly = mergeIntervals(value.weekly.filter(item => item.weekday === weekday && item.status === status)
        .map(item => ({ start: gymInstant(date, item.start), end: gymInstant(date, item.end) })));
      for (const piece of subtractIntervals(weekly, cuts)) windows.push({ date, start: piece.start, end: piece.end, status, source: 'weekly' });
      for (const piece of mergeIntervals(dayExceptions.filter(item => item.status === status))) {
        windows.push({ date, start: piece.start, end: piece.end, status, source: 'exception' });
      }
    }
  }
  return windows.sort((a, b) => a.start - b.start || a.end - b.end || a.status.localeCompare(b.status));
}

/** How submitted windows answer [start, end): a positive status, UNAVAILABLE, PARTIAL or UNKNOWN. */
export function intervalAvailability(windows, start, end) {
  const touching = windows.filter(window => overlaps(window.start, window.end, start, end));
  if (touching.some(window => window.status === 'UNAVAILABLE')) return 'UNAVAILABLE';
  const positive = touching.filter(window => RANK[window.status]);
  if (positive.length === 0) return 'UNKNOWN';
  if (!covers(positive, start, end)) return 'PARTIAL';
  return positive.reduce((worst, window) => (RANK[window.status] < RANK[worst] ? window.status : worst), 'PREFERRED');
}

/**
 * The effective answer for one coach and one duty, applying precedence.
 * `response` is a session-specific answer the server has already checked is
 * current for this duty and exception version.
 */
export function effectiveAvailability({ absences = [], response = null, windows = [], start, end }) {
  if (absences.some(absence => absence.blocking !== false && overlaps(absence.start, absence.end, start, end))) {
    return { status: 'ABSENT', source: 'absence' };
  }
  if (response && response.current !== false && AVAILABILITY_STATUSES.includes(response.status)) {
    return { status: response.status, source: 'session' };
  }
  const status = intervalAvailability(windows, start, end);
  return { status, source: status === 'UNKNOWN' ? 'none' : 'submission' };
}

export function isEligibleStatus(status, { allowIfNeeded = true } = {}) {
  return status === 'PREFERRED' || status === 'AVAILABLE' || (allowIfNeeded && status === 'IF_NEEDED');
}

/** A new month starts from the usual week only; date exceptions never carry over. */
export function startFromPattern(pattern = []) {
  return { weekly: pattern.map(item => ({ weekday: item.weekday, start: item.start, end: item.end, status: item.status })), exceptions: [], noAvailability: false };
}

/** Last month's weekly answers as this month's starting point (never assignments or confirmations). */
export function copyPreviousMonth(previous) {
  if (!previous || previous.noAvailability) return { weekly: [], exceptions: [], noAvailability: false };
  return startFromPattern(previous.weekly || []);
}

/**
 * Class-slot shortcuts for the availability editor. Each shortcut spans the
 * real duty interval (preparation and wrap-up included) of the classes that
 * start at a preset on that weekday this month, so ticking "5:15" cannot leave
 * a coach short of the end of their duty. Presets with no class that weekday
 * produce no shortcut instead of a guessed duration.
 */
export function slotShortcuts(sessions, presets, { gymDate, gymMinute, dutyOf }) {
  const shortcuts = [];
  for (const preset of presets) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const matches = sessions.filter(session => session.status !== 'cancelled'
        && gymMinute(session.start) === preset.minute && weekdayOf(gymDate(session.start)) === weekday);
      if (!matches.length) continue;
      let start = Infinity;
      let end = -Infinity;
      for (const session of matches) {
        const duty = dutyOf(session);
        const dayStart = gymInstant(gymDate(session.start), 0);
        start = Math.min(start, Math.round((duty.start - dayStart) / 60000));
        end = Math.max(end, Math.round((duty.end - dayStart) / 60000));
      }
      shortcuts.push({ weekday, presetMinute: preset.minute, label: preset.label, start: Math.max(0, start), end: Math.min(1440, end), sessions: matches.length });
    }
  }
  return shortcuts;
}
