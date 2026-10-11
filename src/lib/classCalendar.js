// Month-grid calendar maths and the reusable class bank (template) rules.
// Everything here is pure so the admin calendar, public calendar and node
// tests share one behaviour for dates, grouping and template validation.

import { gymDateKey } from './gymTime.js';

const CLASS_TYPES = new Set(['XERT Foundation', 'XERT Strength', 'XERT Engine', 'XERT Hybrid', 'XERT Event Prep', 'XERT Team']);
const BOOKING_MODES = new Set(['interest_only', 'request_to_book', 'instant_book']);
const INTENSITY_LEVELS = new Set(['Low', 'Moderate', 'High', 'Very high']);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLASS_START_MINUTE = 6 * 60; // XERT day shifts start at 06:00

export const WEEKDAY_LABELS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

const pad = number => String(number).padStart(2, '0');

export function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day);
  return localDateKey(date) === key ? date : null;
}

export function monthLabel(year, monthIndex) {
  return new Date(year, monthIndex, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

export function shiftMonth({ year, monthIndex }, delta) {
  const date = new Date(year, monthIndex + delta, 1);
  return { year: date.getFullYear(), monthIndex: date.getMonth() };
}

export function monthOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  return { year: date.getFullYear(), monthIndex: date.getMonth() };
}

// Monday-first grid of full weeks covering the month. Leading/trailing cells
// belong to the neighbouring months and are flagged with inMonth: false.
export function monthGrid(year, monthIndex, { now = new Date() } = {}) {
  const first = new Date(year, monthIndex, 1);
  const leadingDays = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const totalCells = Math.ceil((leadingDays + daysInMonth) / 7) * 7;
  // "Today" means today at the gym, so a UTC process (CI, a server render) or a
  // viewer on another clock still highlights the same cell the owner sees.
  const currentKey = gymDateKey(now) || localDateKey(now);

  const days = Array.from({ length: totalCells }, (_, index) => {
    const date = new Date(year, monthIndex, 1 - leadingDays + index);
    const key = localDateKey(date);
    return {
      key,
      date,
      dayOfMonth: date.getDate(),
      inMonth: date.getMonth() === monthIndex && date.getFullYear() === year,
      isToday: key === currentKey,
    };
  });

  const weeks = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  return { year, monthIndex, label: monthLabel(year, monthIndex), weeks };
}

function startTimestamp(session) {
  const ms = new Date(session?.start_time || NaN).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Plain object of local day key -> sessions sorted by start time.
// Sessions without a usable start time are collected under the `undated` list.
export function groupSessionsByDay(sessions = []) {
  const byDay = {};
  const undated = [];
  for (const session of sessions) {
    const ms = startTimestamp(session);
    if (ms === null) {
      undated.push(session);
      continue;
    }
    // Bucket by the gym's calendar day, not the viewer's: a 6:00 am Brisbane
    // class belongs to that morning for everyone looking at the timetable.
    const key = gymDateKey(new Date(ms)) || localDateKey(new Date(ms));
    (byDay[key] ||= []).push(session);
  }
  for (const key of Object.keys(byDay)) {
    byDay[key].sort((a, b) => startTimestamp(a) - startTimestamp(b));
  }
  return { byDay, undated };
}

export function monthSessionStats(byDay, year, monthIndex) {
  const prefix = `${year}-${pad(monthIndex + 1)}-`;
  let total = 0;
  let published = 0;
  for (const [key, sessions] of Object.entries(byDay)) {
    if (!key.startsWith(prefix)) continue;
    total += sessions.length;
    published += sessions.filter(session => ['published', 'full'].includes(session.status)).length;
  }
  return { total, published };
}

export function minutesFromTimeInput(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
}

export function timeInputFromMinutes(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '';
  const value = Number(minutes);
  if (!Number.isInteger(value) || value < 0 || value > 1439) return '';
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

export function formatStartMinute(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return 'Flexible time';
  const value = Number(minutes);
  if (!Number.isInteger(value) || value < 0 || value > 1439) return 'Flexible time';
  return new Date(2026, 0, 1, Math.floor(value / 60), value % 60)
    .toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

// ─── Class bank templates ─────────────────────────────────────────────────────

export function classTemplateEditorForm(template = {}) {
  const numberOrDefault = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  return {
    name: String(template.name || ''),
    class_type: CLASS_TYPES.has(template.class_type) ? template.class_type : 'XERT Foundation',
    title: String(template.title || ''),
    description: String(template.description || ''),
    coach_name: String(template.coach_name || ''),
    duration_minutes: numberOrDefault(template.duration_minutes, 60),
    capacity: numberOrDefault(template.capacity, 8),
    location_zone: String(template.location_zone || 'Main floor'),
    beginner_friendly: Boolean(template.beginner_friendly),
    intensity_level: INTENSITY_LEVELS.has(template.intensity_level) ? template.intensity_level : 'Moderate',
    booking_mode: BOOKING_MODES.has(template.booking_mode) ? template.booking_mode : 'instant_book',
    default_start: typeof template.default_start === 'string'
      ? template.default_start
      : timeInputFromMinutes(template.default_start_minute),
    notes: String(template.notes || ''),
  };
}

export function classTemplateEditorIsDirty(form, template) {
  return JSON.stringify(classTemplateEditorForm(form))
    !== JSON.stringify(classTemplateEditorForm(template));
}

function optionalText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeClassTemplate(template = {}) {
  const name = String(template.name || '').trim();
  if (!name) throw new Error('The bank entry needs a name.');
  if (name.length > 80) throw new Error('Keep the bank entry name under 80 characters.');
  if (!CLASS_TYPES.has(template.class_type)) throw new Error('Choose a valid class type.');
  if (!BOOKING_MODES.has(template.booking_mode)) throw new Error('Choose a valid booking mode.');
  if (!INTENSITY_LEVELS.has(template.intensity_level)) throw new Error('Choose a valid intensity level.');

  const capacity = Number(template.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Capacity must be a whole number of at least 1.');
  const duration = Number(template.duration_minutes);
  if (!Number.isInteger(duration) || duration < 1) throw new Error('Duration must be a whole number of at least 1 minute.');

  let defaultStartMinute = null;
  const rawStart = template.default_start ?? (template.default_start_minute === null || template.default_start_minute === undefined
    ? ''
    : timeInputFromMinutes(template.default_start_minute));
  if (String(rawStart || '').trim()) {
    defaultStartMinute = minutesFromTimeInput(rawStart);
    if (defaultStartMinute === null) throw new Error('The usual start time must be a valid time of day.');
  }

  const title = String(template.title || '').trim();
  return {
    name,
    class_type: template.class_type,
    title: title || name,
    description: optionalText(template.description),
    coach_name: optionalText(template.coach_name),
    duration_minutes: duration,
    capacity,
    location_zone: optionalText(template.location_zone),
    beginner_friendly: Boolean(template.beginner_friendly),
    intensity_level: template.intensity_level,
    booking_mode: template.booking_mode,
    default_start_minute: defaultStartMinute,
    notes: optionalText(template.notes),
  };
}

export function classTemplateValidationError(template) {
  try {
    normalizeClassTemplate(template);
    return null;
  } catch (error) {
    return error.message;
  }
}

// Turn a saved class into a bank entry so a good class can be reused in one tap.
export function classTemplateFromSession(session = {}, name) {
  const start = startTimestamp(session);
  const startDate = start === null ? null : new Date(start);
  return normalizeClassTemplate({
    name: String(name || session.title || '').trim(),
    class_type: session.class_type,
    title: session.title,
    description: session.description,
    coach_name: session.coach_name,
    duration_minutes: session.duration_minutes,
    capacity: session.capacity,
    location_zone: session.location_zone,
    beginner_friendly: session.beginner_friendly,
    intensity_level: session.intensity_level,
    booking_mode: session.booking_mode,
    default_start: startDate ? `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}` : '',
    notes: session.notes,
  });
}

// Place a bank entry on a pressed calendar date. Returns a class session shaped
// for normalizeClassSession / createClassSession.
export function classSessionFromTemplate(template, dateKey, { startTime = null, publish = false } = {}) {
  const day = dateFromKey(dateKey);
  if (!day) throw new Error('Pick a valid calendar date for this class.');

  const startMinute = startTime !== null && String(startTime).trim() !== ''
    ? minutesFromTimeInput(startTime)
    : (Number.isInteger(template?.default_start_minute) ? template.default_start_minute : DEFAULT_CLASS_START_MINUTE);
  if (startMinute === null) throw new Error('The class start time must be a valid time of day.');

  const duration = Number(template?.duration_minutes);
  if (!Number.isInteger(duration) || duration < 1) throw new Error('This bank entry has an invalid duration.');

  const startMs = day.getTime() + startMinute * 60 * 1000;
  return {
    class_type: template.class_type,
    title: template.title || template.name,
    description: template.description || '',
    coach_name: template.coach_name || '',
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(startMs + duration * 60 * 1000).toISOString(),
    duration_minutes: duration,
    capacity: template.capacity,
    location_zone: template.location_zone || '',
    beginner_friendly: Boolean(template.beginner_friendly),
    intensity_level: template.intensity_level,
    booking_mode: template.booking_mode,
    status: publish ? 'published' : 'draft',
    public_visible: Boolean(publish),
    notes: template.notes || '',
  };
}

// Prefill for the custom class editor when the admin presses an empty date.
export function classSessionSeedForDate(dateKey, { startMinute = DEFAULT_CLASS_START_MINUTE, durationMinutes = 60 } = {}) {
  const day = dateFromKey(dateKey);
  if (!day) return null;
  const startMs = day.getTime() + startMinute * 60 * 1000;
  return {
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(startMs + durationMinutes * 60 * 1000).toISOString(),
    duration_minutes: durationMinutes,
  };
}

export function upcomingDayKeys(byDay, { now = new Date(), limit = 3 } = {}) {
  const todayKey = gymDateKey(now) || localDateKey(now);
  return Object.keys(byDay)
    .filter(key => key >= todayKey)
    .sort()
    .slice(0, limit);
}

/**
 * Moves a day key by whole days, staying on civil dates. Used by the calendar
 * grid's arrow-key navigation, so the whole month is one tab stop rather than
 * forty-two.
 */
export function shiftDayKey(dateKey, days) {
  const day = dateFromKey(dateKey);
  if (!day || !Number.isInteger(days)) return null;
  return localDateKey(new Date(day.getFullYear(), day.getMonth(), day.getDate() + days));
}

export function isPastDayKey(dateKey, now = new Date()) {
  const day = dateFromKey(dateKey);
  if (!day) return false;
  return day.getTime() + DAY_MS <= now.getTime();
}

const CLOCK_TIME = String.raw`\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?`;

/**
 * The calendar chip already leads with the time, and class names often carry
 * it too ("5:15am training session", "Group class/ open gym 2:30pm"), which
 * read as "5:15 am 5:15am trai…". Drops a time at either end of the name.
 */
export function chipTitle(title) {
  const trimmed = String(title || '')
    .replace(new RegExp(`^\\s*${CLOCK_TIME}\\s*[-–—:]?\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*[-–—]?\\s*${CLOCK_TIME}\\s*$`, 'i'), '')
    .trim();
  if (!trimmed) return String(title || '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
