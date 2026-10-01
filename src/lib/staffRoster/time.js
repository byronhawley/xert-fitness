/**
 * Gym-local calendar arithmetic for the staff roster.
 *
 * Roster dates are the gym's dates: a 5:15 am class in Kingaroy is on the
 * Brisbane calendar day it starts, whatever clock the coach's phone is on.
 * Calendar maths (months, weekdays, day counts) is done on plain `YYYY-MM-DD`
 * keys with UTC arithmetic, which has no timezone; conversion to and from real
 * instants always goes through the gym's zone.
 *
 * Every interval here is half-open: [start, end). A class ending at 6:15 does
 * not overlap one starting at 6:15.
 */
import { GYM_TIME_ZONE, gymDateKey, gymMinutesOfDay } from '../gymTime.js';

export { GYM_TIME_ZONE };

const MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

const pad = value => String(value).padStart(2, '0');

export function parseDateKey(dateKey) {
  const match = DATE_KEY.exec(String(dateKey || ''));
  if (!match) throw new Error(`Invalid date ${dateKey}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`Invalid date ${dateKey}`);
  }
  return { year, month, day };
}

export function isDateKey(value) {
  try { parseDateKey(value); return true; } catch { return false; }
}

export function parseMonthKey(monthKey) {
  const match = MONTH_KEY.exec(String(monthKey || ''));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new Error(`Invalid month ${monthKey}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function monthKeyOf(dateKey) {
  const { year, month } = parseDateKey(dateKey);
  return `${year}-${pad(month)}`;
}

export function addMonths(monthKey, count) {
  const { year, month } = parseMonthKey(monthKey);
  const index = year * 12 + (month - 1) + count;
  return `${Math.floor(index / 12)}-${pad((index % 12 + 12) % 12 + 1)}`;
}

export function daysInMonth(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day `day` of the month, clamped to the month's last day (31 → 30 in November). */
export function dateInMonth(monthKey, day) {
  const { year, month } = parseMonthKey(monthKey);
  const clamped = Math.min(Math.max(1, Math.trunc(Number(day) || 1)), daysInMonth(monthKey));
  return `${year}-${pad(month)}-${pad(clamped)}`;
}

export function datesOfMonth(monthKey) {
  return Array.from({ length: daysInMonth(monthKey) }, (_, index) => dateInMonth(monthKey, index + 1));
}

export function addDays(dateKey, count) {
  const { year, month, day } = parseDateKey(dateKey);
  const next = new Date(Date.UTC(year, month - 1, day + count));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for the calendar date itself. */
export function weekdayOf(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function compareDateKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minutes the gym's zone is ahead of UTC at `instantMs`. */
function zoneOffsetMinutes(instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GYM_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const part = type => Number(parts.find(item => item.type === type)?.value);
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'));
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / MINUTE);
}

/**
 * The instant at which the gym's wall clock reads `minuteOfDay` on `dateKey`.
 * Minutes may run past 1440 for a duty that ends after midnight.
 */
export function gymInstant(dateKey, minuteOfDay = 0) {
  const { year, month, day } = parseDateKey(dateKey);
  const naive = Date.UTC(year, month - 1, day) + Number(minuteOfDay) * MINUTE;
  // Two passes settle the offset even on a zone with daylight saving.
  let instant = naive - zoneOffsetMinutes(naive) * MINUTE;
  instant = naive - zoneOffsetMinutes(instant) * MINUTE;
  return instant;
}

export function gymInstantIso(dateKey, minuteOfDay = 0) {
  return new Date(gymInstant(dateKey, minuteOfDay)).toISOString();
}

export function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Gym date of an instant (never the browser's date). */
export function gymDateOf(value) {
  return gymDateKey(toMs(value));
}

export function gymMinuteOf(value) {
  return gymMinutesOfDay(toMs(value));
}

export function monthKeyOfInstant(value) {
  const date = gymDateOf(value);
  return date ? monthKeyOf(date) : null;
}

/** [start, end) instants covering the whole gym month. */
export function monthRange(monthKey) {
  const first = dateInMonth(monthKey, 1);
  const next = dateInMonth(addMonths(monthKey, 1), 1);
  return { start: gymInstant(first, 0), end: gymInstant(next, 0) };
}

export function minuteLabel(minute) {
  const normalized = ((Number(minute) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const suffix = hours < 12 ? 'am' : 'pm';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${pad(minutes)} ${suffix}`;
}

/** `05:15` → 315. Accepts `H:MM` or `HH:MM`, 0–24h. */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

export function clockLabel(minute) {
  const value = Math.max(0, Math.min(1440, Number(minute)));
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** Sorted, merged union of [start, end) intervals. */
export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(item => item && item.end > item.start)
    .map(item => ({ start: item.start, end: item.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

export function intervalMinutes(intervals) {
  return mergeIntervals(intervals).reduce((total, item) => total + (item.end - item.start) / MINUTE, 0);
}

/** `intervals` minus `cuts`, both lists of [start, end). */
export function subtractIntervals(intervals, cuts) {
  let remaining = intervals.map(item => ({ ...item }));
  for (const cut of cuts) {
    const next = [];
    for (const item of remaining) {
      if (!overlaps(item.start, item.end, cut.start, cut.end)) { next.push(item); continue; }
      if (item.start < cut.start) next.push({ ...item, end: cut.start });
      if (cut.end < item.end) next.push({ ...item, start: cut.end });
    }
    remaining = next;
  }
  return remaining;
}

/** Does the union of `intervals` cover [start, end) entirely? */
export function covers(intervals, start, end) {
  let cursor = start;
  for (const item of mergeIntervals(intervals)) {
    if (item.end <= cursor) continue;
    if (item.start > cursor) return false;
    cursor = item.end;
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

/** Monday-based ISO-style week key for a gym date (`2026-12-07` for any date that week). */
export function weekStartOf(dateKey) {
  const weekday = weekdayOf(dateKey);
  return addDays(dateKey, -((weekday + 6) % 7));
}

export { MINUTE, DAY_MS };
