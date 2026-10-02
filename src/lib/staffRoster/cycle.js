/**
 * The monthly planning cycle: when coaches can start giving availability for a
 * roster month, when it is due, and when the owner aims to publish.
 *
 * Defaults for roster month M: open on day 1 of M−2, due on day 20 of M−2,
 * publish target day 1 of M−1. December 2026 therefore opens 1 October, is due
 * 20 October and targets publication on 1 November, giving coaches a full
 * calendar month of notice. Publication is always a manager action; the target
 * date is a reminder, never an automatic deadline action.
 */
import { addDays, addMonths, compareDateKeys, dateInMonth, gymInstant, isDateKey, parseMonthKey } from './time.js';

export const DEFAULT_CYCLE = Object.freeze({
  openMonthsBefore: 2,
  openDay: 1,
  dueMonthsBefore: 2,
  dueDay: 20,
  publishMonthsBefore: 1,
  publishDay: 1,
});

export const DEFAULT_REMINDERS = Object.freeze({
  onOpen: true,
  daysBeforeDue: [3],
  onDue: true,
  overdueSummary: true,
  // Routine notices go out in local daytime, 9:00 am at the gym.
  sendMinute: 9 * 60,
});

function wholeNumber(value, fallback, { min = 0, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

export function normalizeCycle(cycle = {}) {
  return {
    openMonthsBefore: wholeNumber(cycle.openMonthsBefore, DEFAULT_CYCLE.openMonthsBefore, { min: 0, max: 12 }),
    openDay: wholeNumber(cycle.openDay, DEFAULT_CYCLE.openDay, { min: 1, max: 31 }),
    dueMonthsBefore: wholeNumber(cycle.dueMonthsBefore, DEFAULT_CYCLE.dueMonthsBefore, { min: 0, max: 12 }),
    dueDay: wholeNumber(cycle.dueDay, DEFAULT_CYCLE.dueDay, { min: 1, max: 31 }),
    publishMonthsBefore: wholeNumber(cycle.publishMonthsBefore, DEFAULT_CYCLE.publishMonthsBefore, { min: 0, max: 12 }),
    publishDay: wholeNumber(cycle.publishDay, DEFAULT_CYCLE.publishDay, { min: 1, max: 31 }),
  };
}

/** The configured (unshortened) dates for roster month `monthKey`. */
export function defaultPeriodDates(monthKey, cycle = DEFAULT_CYCLE) {
  parseMonthKey(monthKey);
  const config = normalizeCycle(cycle);
  const opensOn = dateInMonth(addMonths(monthKey, -config.openMonthsBefore), config.openDay);
  const dueOn = dateInMonth(addMonths(monthKey, -config.dueMonthsBefore), config.dueDay);
  const publishTargetOn = dateInMonth(addMonths(monthKey, -config.publishMonthsBefore), config.publishDay);
  if (compareDateKeys(dueOn, opensOn) < 0) throw new Error('The availability due date must be on or after it opens.');
  if (compareDateKeys(publishTargetOn, dueOn) < 0) throw new Error('The publish target must be on or after availability is due.');
  return { month: monthKey, opensOn, dueOn, publishTargetOn };
}

/**
 * Dates for actually opening `monthKey` on `today`. Opening late produces a
 * clearly labelled shortened cycle starting today; nothing is backdated and no
 * reminder is generated for a time before the period was opened. When the
 * default due date has already passed the manager must choose one.
 * @param {string} monthKey
 * @param {{ today?: string, cycle?: object, dueOn?: string | null, publishTargetOn?: string | null }} [options]
 */
export function planPeriodOpening(monthKey, { today, cycle = DEFAULT_CYCLE, dueOn: chosenDue = null, publishTargetOn: chosenPublish = null } = {}) {
  if (!isDateKey(today)) throw new Error('Opening a roster month needs today’s gym date.');
  const defaults = defaultPeriodDates(monthKey, cycle);
  const firstOfMonth = dateInMonth(monthKey, 1);
  if (compareDateKeys(today, firstOfMonth) >= 0) {
    throw new Error('This roster month has already started. Roster coaches for the rest of the month from a later date instead.');
  }
  const shortened = compareDateKeys(today, defaults.opensOn) > 0;
  const opensOn = shortened ? today : defaults.opensOn;
  let dueOn = chosenDue || defaults.dueOn;
  if (compareDateKeys(dueOn, opensOn) < 0) {
    if (!chosenDue) {
      // The default publish target belongs to the passed default cycle; it is
      // chosen again once the manager picks a due date.
      return { ...defaults, opensOn, dueOn: null, publishTargetOn: null, shortened, needsDueDate: true };
    }
    throw new Error('The due date cannot be before availability opens.');
  }
  if (compareDateKeys(dueOn, firstOfMonth) >= 0) throw new Error('Availability must be due before the roster month starts.');
  let publishTargetOn = chosenPublish || defaults.publishTargetOn;
  if (compareDateKeys(publishTargetOn, dueOn) < 0) publishTargetOn = dueOn;
  if (compareDateKeys(publishTargetOn, firstOfMonth) >= 0) publishTargetOn = addDays(firstOfMonth, -1);
  return { month: monthKey, opensOn, dueOn, publishTargetOn, shortened, needsDueDate: false };
}

/**
 * The start dates a part-month period can take for `monthKey` on `today`: a
 * later day of the same month, after both the 1st and today. `suggested` is a
 * week from today (or the month's last day), so coaches get some notice.
 * Null when no day is left to roster.
 * @param {string} monthKey
 * @param {string} today
 * @returns {{ min: string, max: string, suggested: string } | null}
 */
export function partMonthStartRange(monthKey, today) {
  parseMonthKey(monthKey);
  if (!isDateKey(today)) throw new Error('Opening a roster month needs today’s gym date.');
  const first = dateInMonth(monthKey, 1);
  const last = dateInMonth(monthKey, 31);
  const min = addDays(compareDateKeys(today, first) > 0 ? today : first, 1);
  if (compareDateKeys(min, last) > 0) return null;
  let suggested = addDays(today, 7);
  if (compareDateKeys(suggested, min) < 0) suggested = min;
  if (compareDateKeys(suggested, last) > 0) suggested = last;
  return { min, max: last, suggested };
}

/**
 * Dates for a part-month period: `monthKey` rostered from `startsOn`, asked
 * from today. Same rules as `staff_roster_open_part_month` and the
 * staff_roster_periods checks: the start is a later day of the month after
 * the 1st and after today; answers are due from today and before the start;
 * the publish target is on or after the due date and before the start.
 * Defaults: due three days before the start (never before today), publish
 * target the day before the start.
 * @param {string} monthKey
 * @param {{ today?: string, startsOn?: string, dueOn?: string | null, publishTargetOn?: string | null }} [options]
 */
export function planPartMonthOpening(monthKey, { today, startsOn, dueOn: chosenDue = null, publishTargetOn: chosenPublish = null } = {}) {
  if (!isDateKey(today)) throw new Error('Opening a roster month needs today’s gym date.');
  const range = partMonthStartRange(monthKey, today);
  if (!range) throw new Error('This roster month has no days left to roster.');
  if (!isDateKey(startsOn)) throw new Error('Choose the first day to roster coaches.');
  if (compareDateKeys(startsOn, range.min) < 0 || compareDateKeys(startsOn, range.max) > 0) {
    throw new Error(`Roster coaches from a day between ${range.min} and ${range.max}.`);
  }
  const dayBefore = addDays(startsOn, -1);
  let dueOn = chosenDue;
  if (!dueOn) {
    dueOn = addDays(startsOn, -3);
    if (compareDateKeys(dueOn, today) < 0) dueOn = today;
  }
  if (!isDateKey(dueOn)) throw new Error('Choose a valid due date.');
  if (compareDateKeys(dueOn, today) < 0) throw new Error('The due date cannot be in the past.');
  if (compareDateKeys(dueOn, startsOn) >= 0) throw new Error('Answers must be due before the roster starts.');
  let publishTargetOn = chosenPublish || dayBefore;
  if (compareDateKeys(publishTargetOn, dueOn) < 0) publishTargetOn = dueOn;
  if (compareDateKeys(publishTargetOn, startsOn) >= 0) publishTargetOn = dayBefore;
  return { month: monthKey, startsOn, opensOn: today, dueOn, publishTargetOn, shortened: true, partMonth: true, needsDueDate: false };
}

export function normalizeReminders(reminders = {}) {
  const days = Array.isArray(reminders.daysBeforeDue) ? reminders.daysBeforeDue : DEFAULT_REMINDERS.daysBeforeDue;
  return {
    onOpen: reminders.onOpen ?? DEFAULT_REMINDERS.onOpen,
    daysBeforeDue: [...new Set(days.map(Number).filter(day => Number.isInteger(day) && day > 0 && day <= 31))].sort((a, b) => b - a),
    onDue: reminders.onDue ?? DEFAULT_REMINDERS.onDue,
    overdueSummary: reminders.overdueSummary ?? DEFAULT_REMINDERS.overdueSummary,
    sendMinute: wholeNumber(reminders.sendMinute, DEFAULT_REMINDERS.sendMinute, { min: 6 * 60, max: 20 * 60 }),
  };
}

/**
 * Every reminder a period would produce, each with a stable key so queueing it
 * twice is a no-op. Reminders dated before the period opened are dropped.
 */
export function reminderPlan(period, reminders = DEFAULT_REMINDERS) {
  const config = normalizeReminders(reminders);
  const plan = [];
  const add = (kind, date, audience) => {
    if (!date || compareDateKeys(date, period.opensOn) < 0) return;
    plan.push({ kind, date, audience, sendAt: gymInstant(date, config.sendMinute), key: `${period.month}:${kind}` });
  };
  if (config.onOpen) add('opened', period.opensOn, 'coaches');
  for (const days of config.daysBeforeDue) {
    const date = addDays(period.dueOn, -days);
    if (compareDateKeys(date, period.opensOn) > 0) add(`due_in_${days}`, date, 'coaches');
  }
  if (config.onDue) add('due_today', period.dueOn, 'coaches');
  if (config.overdueSummary) add('overdue_summary', addDays(period.dueOn, 1), 'managers');
  return plan.sort((a, b) => a.sendAt - b.sendAt || a.kind.localeCompare(b.kind));
}

/**
 * Coaches still to chase for a reminder. Anyone who submitted — including an
 * explicit "unavailable all month" — is not chased.
 */
export function coachesToRemind(staff, submissions, monthKey) {
  const answered = new Set(submissions.filter(item => item.month === monthKey).map(item => item.staffId));
  return staff.filter(member => member.status === 'active' && member.rosterable !== false && !answered.has(member.id));
}

/** Reminders from `plan` that are due at `nowMs` and not yet sent. */
export function remindersDue(plan, nowMs, sentKeys = new Set()) {
  return plan.filter(item => item.sendAt <= nowMs && !sentKeys.has(item.key));
}

/** Submission state for one coach in one period. */
export function submissionState({ period, submission, draft, reopening, today }) {
  if (submission?.noAvailability) return { state: 'submitted_none', late: Boolean(submission.late) };
  if (submission) {
    const draftNewer = draft && draft.updatedAt && submission.submittedAt && draft.updatedAt > submission.submittedAt && draft.dirty;
    return { state: reopening ? 'reopened' : 'submitted', late: Boolean(submission.late), draftNewer: Boolean(draftNewer) };
  }
  if (!period || compareDateKeys(today, period.opensOn) < 0) return { state: 'not_open' };
  const overdue = compareDateKeys(today, period.dueOn) > 0 && !reopening;
  return { state: draft ? 'draft' : 'not_submitted', overdue };
}
