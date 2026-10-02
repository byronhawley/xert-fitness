/**
 * Day-first availability: the coach marks days on a month calendar as
 * "can work" or "away", then answers each class on the days they can work.
 * Days with no classes get a simple free-time range instead.
 *
 * There is no new storage. Every answer is written as date exceptions in the
 * existing payload `{ weekly, exceptions, noAvailability }`, which the server
 * already validates and expands:
 *
 *   - away day                → one whole-day UNAVAILABLE exception (0–1440)
 *   - can-work day, classes   → one exception per class duty window
 *                               (setup to pack-down, gym minutes) with that
 *                               class's answer; touching or overlapping
 *                               windows with the same answer are merged
 *   - can-work day, no class  → one AVAILABLE exception for the chosen range
 *   - day not answered        → nothing for that date ("not stated")
 *
 * When two classes' duties overlap (shared setup time) and the answers
 * differ, the shared minutes are resolved so the payload never contradicts
 * itself: "can't" wins outright (conservative: the other class then reads
 * "can't" too), and between two positive answers the stronger one covers the
 * shared minutes, so each class still reads as its own answer.
 *
 * A part-month period (`startsOn`, a `YYYY-MM-DD` date or null for the
 * whole month) only covers classes from that date: earlier days can't be
 * marked, and no exception is ever written for them. Every function that
 * writes takes it as an optional last `{ startsOn }` argument.
 *
 * Older answers made with the usual-week grid (weekly windows plus
 * exceptions) are read through `expandAvailability`, exactly as the server
 * reads them. The first change on this screen turns the weekly windows into
 * the same per-date exceptions (an equivalent answer), so a day can be
 * cleared back to "not stated" without a weekly window still covering it.
 */
import { expandAvailability, intervalAvailability, startFromPattern } from './availability.js';
import { datesOfMonth, gymDateOf, gymInstant, mergeIntervals, overlaps, subtractIntervals, weekdayOf } from './time.js';

export const DAY_RANGES = Object.freeze([
  Object.freeze({ key: 'morning', label: 'Morning', start: 300, end: 720 }),
  Object.freeze({ key: 'midday', label: 'Midday', start: 660, end: 840 }),
  Object.freeze({ key: 'evening', label: 'Evening', start: 960, end: 1260 }),
  Object.freeze({ key: 'all', label: 'All day', start: 0, end: 1440 }),
]);
export const ALL_DAY = DAY_RANGES[3];

/** The answers a coach can give a class on a day they can work. */
export const CLASS_CHOICES = Object.freeze([
  Object.freeze({ status: 'AVAILABLE', label: 'Can do', symbol: '✓' }),
  Object.freeze({ status: 'PREFERRED', label: 'Prefer', symbol: '★' }),
  Object.freeze({ status: 'UNAVAILABLE', label: 'Can’t', symbol: '✕' }),
]);

const POSITIVE_RANK = Object.freeze({ IF_NEEDED: 1, AVAILABLE: 2, PREFERRED: 3 });
const MAX_EXCEPTIONS = 400;

/** Is `date` inside the period? Null `startsOn` means the whole month. */
export function inPeriod(date, startsOn = null) {
  return !startsOn || date >= startsOn;
}

/** The dates a period covers: the whole month, or from `startsOn` to the month's end. */
export function periodDates(monthKey, startsOn = null) {
  return datesOfMonth(monthKey).filter(date => inPeriod(date, startsOn));
}

const clampMinute = minute => Math.max(0, Math.min(1440, minute));
const minutesFrom = (date, ms) => Math.round((ms - gymInstant(date, 0)) / 60000);

/** A class's duty (setup to pack-down) as gym minutes on the date it starts, clamped to that day. */
export function dutyOnDay(session) {
  const date = gymDateOf(session.start);
  const start = clampMinute(minutesFrom(date, session.dutyStart ?? session.start));
  const end = clampMinute(minutesFrom(date, session.dutyEnd ?? session.end));
  return { date, start, end: Math.max(end, start + 1) };
}

/** The month's live classes grouped by gym date, each with its duty in minutes. */
export function classesByDate(sessions = []) {
  const byDate = new Map();
  for (const session of sessions) {
    if (session.status === 'cancelled') continue;
    const duty = dutyOnDay(session);
    if (!byDate.has(duty.date)) byDate.set(duty.date, []);
    byDate.get(duty.date).push({ session, start: duty.start, end: duty.end });
  }
  for (const list of byDate.values()) list.sort((a, b) => a.start - b.start || a.end - b.end || String(a.session.id).localeCompare(String(b.session.id)));
  return byDate;
}

/** Merges each status's windows (touching or overlapping) and sorts by time. */
function normalize(windows) {
  const out = [];
  for (const status of ['PREFERRED', 'AVAILABLE', 'IF_NEEDED', 'UNAVAILABLE']) {
    for (const piece of mergeIntervals(windows.filter(item => item.status === status))) out.push({ start: piece.start, end: piece.end, status });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || a.status.localeCompare(b.status));
}

/**
 * How the server reads this payload, per date, as minute windows. A payload
 * marked "can't coach this month" has no per-date answers.
 */
export function dateWindows(payload, monthKey) {
  const byDate = new Map();
  if (!payload || payload.noAvailability) return byDate;
  for (const window of expandAvailability(payload, monthKey)) {
    if (!byDate.has(window.date)) byDate.set(window.date, []);
    byDate.get(window.date).push({ start: minutesFrom(window.date, window.start), end: minutesFrom(window.date, window.end), status: window.status });
  }
  for (const [date, list] of byDate) byDate.set(date, normalize(list));
  return byDate;
}

/**
 * Turns weekly windows into the equivalent per-date exceptions. Answers that
 * are already date-only come back unchanged.
 */
export function materialize(payload, monthKey, { startsOn = null } = {}) {
  const base = { weekly: [], exceptions: [], noAvailability: false, ...payload };
  if (base.noAvailability) return base;
  if (!base.weekly?.length) return { ...base, weekly: [], exceptions: (base.exceptions || []).filter(item => inPeriod(item.date, startsOn)) };
  const exceptions = [];
  for (const [date, windows] of dateWindows(base, monthKey)) {
    if (!inPeriod(date, startsOn)) continue;
    for (const window of windows) exceptions.push({ date, ...window });
  }
  return { weekly: [], exceptions: exceptions.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start), noAvailability: false };
}

/**
 * The windows for one can-work day with classes. Each class covers its duty
 * with its answer (null leaves it unanswered); `extras` are other answered
 * times that day outside every class duty, kept as they were.
 */
export function encodeClassDay(classes, extras = []) {
  const answered = classes.filter(item => item.status);
  const cuts = [...new Set(answered.flatMap(item => [item.start, item.end]))].sort((a, b) => a - b);
  const pieces = [];
  for (let index = 0; index < cuts.length - 1; index++) {
    const start = cuts[index];
    const end = cuts[index + 1];
    const covering = answered.filter(item => item.start <= start && item.end >= end);
    if (!covering.length) continue;
    const status = covering.some(item => item.status === 'UNAVAILABLE') ? 'UNAVAILABLE'
      : covering.reduce((best, item) => ((POSITIVE_RANK[item.status] || 0) > (POSITIVE_RANK[best] || 0) ? item.status : best), covering[0].status);
    pieces.push({ start, end, status });
  }
  const duties = mergeIntervals(classes.map(item => ({ start: item.start, end: item.end })));
  const kept = extras.flatMap(window => subtractIntervals([{ start: window.start, end: window.end }], duties).map(piece => ({ ...piece, status: window.status })));
  return normalize([...pieces, ...kept]);
}

const coversWholeDay = windows => {
  const merged = mergeIntervals(windows);
  return merged.length === 1 && merged[0].start <= 0 && merged[0].end >= 1440;
};

/** One date's state, read from its windows and its classes. */
export function decodeDay(windows = [], dayClasses = []) {
  if (!windows.length) return { state: null, classes: dayClasses.map(item => ({ ...item, status: null, read: 'UNKNOWN' })), range: null, extras: [] };
  if (windows.every(item => item.status === 'UNAVAILABLE') && coversWholeDay(windows)) {
    return { state: 'away', classes: dayClasses.map(item => ({ ...item, status: 'UNAVAILABLE', read: 'UNAVAILABLE' })), range: null, extras: [] };
  }
  const positive = mergeIntervals(windows.filter(item => item.status !== 'UNAVAILABLE'));
  // Only "can't" times and no classes: nothing here says the coach is free.
  if (!positive.length && !dayClasses.length) return { state: null, classes: [], range: null, extras: windows };
  const classes = dayClasses.map(item => {
    const read = intervalAvailability(windows, item.start, item.end);
    return { ...item, status: read === 'PARTIAL' || read === 'UNKNOWN' ? null : read, read };
  });
  const duties = mergeIntervals(dayClasses.map(item => ({ start: item.start, end: item.end })));
  const extras = windows.flatMap(window => subtractIntervals([{ start: window.start, end: window.end }], duties).map(piece => ({ ...piece, status: window.status })));
  const range = positive.length ? { start: positive[0].start, end: positive[positive.length - 1].end, pieces: positive.length } : null;
  return { state: 'available', classes, range, extras };
}

/** Every date of the month with its state, classes and free-time range. */
export function dayStates(payload, monthKey, sessions = [], { startsOn = null } = {}) {
  const windows = dateWindows(payload, monthKey);
  const classes = classesByDate(sessions);
  const states = new Map();
  for (const date of datesOfMonth(monthKey)) {
    states.set(date, inPeriod(date, startsOn)
      ? { date, outside: false, ...decodeDay(windows.get(date), classes.get(date) || []) }
      : { date, outside: true, state: null, classes: [], range: null, extras: [] });
  }
  return states;
}

/** True when two classes on the day share duty time (setup or pack-down). */
export function hasSharedDuty(dayClasses = []) {
  return dayClasses.some((a, index) => dayClasses.slice(index + 1).some(b => overlaps(a.start, a.end, b.start, b.end)));
}

function replaceDate(payload, monthKey, date, windows, options = {}) {
  if (!inPeriod(date, options.startsOn)) return payload;
  const base = materialize(payload, monthKey, options);
  const others = base.exceptions.filter(item => item.date !== date);
  const exceptions = [...others, ...windows.map(window => ({ date, start: window.start, end: window.end, status: window.status }))]
    .sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.end - b.end);
  return { weekly: [], exceptions, noAvailability: false };
}

/**
 * Marks a date "available" (can work), "away", or null (not answered).
 * Marking a day available that was not already defaults every class to
 * "Can do", or the whole day free when it has no classes.
 */
export function setDay(payload, monthKey, sessions, date, state, options = {}) {
  const day = dayStates(payload, monthKey, sessions, options).get(date);
  if (!day || day.outside || day.state === state) return payload;
  if (state === 'away') return replaceDate(payload, monthKey, date, [{ start: 0, end: 1440, status: 'UNAVAILABLE' }], options);
  if (!state) return replaceDate(payload, monthKey, date, [], options);
  if (!day.classes.length) return replaceDate(payload, monthKey, date, [{ start: ALL_DAY.start, end: ALL_DAY.end, status: 'AVAILABLE' }], options);
  return replaceDate(payload, monthKey, date, encodeClassDay(day.classes.map(item => ({ ...item, status: 'AVAILABLE' }))), options);
}

/** Sets one class's answer on a date (null clears it); the day becomes a can-work day. */
export function setClassStatus(payload, monthKey, sessions, date, sessionId, status, options = {}) {
  const day = dayStates(payload, monthKey, sessions, options).get(date);
  if (!day || day.outside || !day.classes.some(item => item.session.id === sessionId)) return payload;
  const fresh = day.state !== 'available';
  const classes = day.classes.map(item => ({ ...item, status: item.session.id === sessionId ? status : (fresh ? 'AVAILABLE' : item.status) }));
  return replaceDate(payload, monthKey, date, encodeClassDay(classes, fresh ? [] : day.extras), options);
}

/** The free-time range on a can-work day with no classes. */
export function setDayRange(payload, monthKey, date, start, end, options = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start) return payload;
  return replaceDate(payload, monthKey, date, [{ start, end, status: 'AVAILABLE' }], options);
}

/** Every date of the period on `weekday` (0 = Sunday). */
export function datesOnWeekday(monthKey, weekday, { startsOn = null } = {}) {
  return datesOfMonth(monthKey).filter(date => weekdayOf(date) === weekday && inPeriod(date, startsOn));
}

/** "Every Monday": marks every such date, or clears them when they all already have that state. */
export function toggleWeekday(payload, monthKey, sessions, weekday, state, options = {}) {
  const states = dayStates(payload, monthKey, sessions, options);
  const dates = datesOnWeekday(monthKey, weekday, options);
  if (!dates.length) return payload;
  const target = dates.every(date => states.get(date).state === state) ? null : state;
  return dates.reduce((next, date) => setDay(next, monthKey, sessions, date, target, options), payload);
}

/**
 * A usual week read back out of a month's answer: for each weekday, the
 * answer most of its can-work days share (days away and unanswered days
 * don't count). Works for day-first and older weekly answers alike.
 */
export function weekPatternOf(payload, monthKey) {
  if (!payload || payload.noAvailability) return [];
  const windows = dateWindows(payload, monthKey);
  const pattern = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const counts = new Map();
    for (const date of datesOnWeekday(monthKey, weekday)) {
      const list = windows.get(date) || [];
      if (!list.length || (list.every(item => item.status === 'UNAVAILABLE') && coversWholeDay(list))) continue;
      const key = JSON.stringify(list.map(item => [item.start, item.end, item.status]));
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = null;
    for (const [key, count] of counts) if (!best || count > best.count) best = { key, count };
    if (best) for (const [start, end, status] of JSON.parse(best.key)) pattern.push({ weekday, start, end, status });
  }
  return pattern;
}

/**
 * Pre-fills the month from a usual week. Days already marked away stay away;
 * every other day takes the usual week's answer.
 */
export function fillFromPattern(payload, monthKey, pattern = [], options = {}) {
  const current = dayStates(payload, monthKey, [], options);
  const away = [...current.values()].filter(day => day.state === 'away').map(day => day.date);
  const filled = materialize(startFromPattern(pattern), monthKey, options);
  const exceptions = [
    ...filled.exceptions.filter(item => !away.includes(item.date)),
    ...away.map(date => ({ date, start: 0, end: 1440, status: 'UNAVAILABLE' })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  return { weekly: [], exceptions, noAvailability: false };
}

/** Day counts for the summary: can-work days, can-work days with no classes, away days. */
export function dayCounts(payload, monthKey, sessions = [], options = {}) {
  const counts = { available: 0, availableNoClasses: 0, away: 0, unanswered: 0 };
  if (!payload || payload.noAvailability) return counts;
  for (const day of dayStates(payload, monthKey, sessions, options).values()) {
    if (day.outside) continue;
    if (day.state === 'available') { counts.available++; if (!day.classes.length) counts.availableNoClasses++; }
    else if (day.state === 'away') counts.away++;
    else counts.unanswered++;
  }
  return counts;
}

export { MAX_EXCEPTIONS };
