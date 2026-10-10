/**
 * Plain-language PT hours. Coaches pick parts of the day on a weekly grid;
 * the database stores exact windows ({ weekday, start, end } in gym minutes).
 * Pure helpers so the grid, the exact-times editor and the summary agree.
 */

export const DAY_PARTS = Object.freeze([
  { key: 'early', label: 'Early', detail: '5–8 am', start: 300, end: 480 },
  { key: 'morning', label: 'Morning', detail: '8–12', start: 480, end: 720 },
  { key: 'afternoon', label: 'Afternoon', detail: '12–4 pm', start: 720, end: 960 },
  { key: 'evening', label: 'Evening', detail: '4–8 pm', start: 960, end: 1200 },
]);

/** Monday first, the way people read a week. Sunday is 0. */
export const WEEK_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const isStart = block => block.kind === 'start';

/** Split saved hours into time windows and exact start times. */
export function splitHours(hours) {
  return { windows: (hours || []).filter(block => !isStart(block)), starts: (hours || []).filter(isStart) };
}

/**
 * Merge touching or overlapping windows within each day and drop repeated
 * start times, sorted by day and time with a window before a start time at
 * the same minute (the order the database returns).
 */
export function normalizeHours(hours) {
  const { windows, starts } = splitHours(hours);
  const byDay = new Map();
  for (const block of windows) {
    if (!byDay.has(block.weekday)) byDay.set(block.weekday, []);
    byDay.get(block.weekday).push({ start: block.start, end: block.end });
  }
  const result = [];
  for (const weekday of [...byDay.keys()].sort((a, b) => a - b)) {
    const blocks = byDay.get(weekday).sort((a, b) => a.start - b.start);
    let current = null;
    for (const block of blocks) {
      if (current && block.start <= current.end) current.end = Math.max(current.end, block.end);
      else { if (current) result.push(current); current = { weekday, start: block.start, end: block.end }; }
    }
    if (current) result.push(current);
  }
  const seen = new Set();
  for (const block of starts) {
    const key = `${block.weekday}:${block.start}`;
    if (!seen.has(key)) { seen.add(key); result.push({ weekday: block.weekday, start: block.start, kind: 'start' }); }
  }
  return result.sort((a, b) => a.weekday - b.weekday || a.start - b.start || (isStart(a) ? 1 : 0) - (isStart(b) ? 1 : 0));
}

/** Exact start times as { [weekday]: [minute, …] }, sorted. */
export function startsByDay(hours) {
  const days = Object.fromEntries(WEEK_ORDER.map(day => [day, []]));
  for (const block of normalizeHours(splitHours(hours).starts)) days[block.weekday].push(block.start);
  return days;
}

export function hoursFromStarts(days) {
  return Object.entries(days).flatMap(([weekday, minutes]) => minutes.map(start => ({ weekday: Number(weekday), start, kind: 'start' })));
}

/** Hours → { [weekday]: Set(partKey) }, and whether the hours fit the grid exactly. */
export function gridFromHours(hours) {
  const grid = Object.fromEntries(WEEK_ORDER.map(day => [day, new Set()]));
  const { windows } = splitHours(hours);
  for (const block of normalizeHours(windows)) {
    for (const part of DAY_PARTS) {
      if (part.start >= block.start && part.end <= block.end) grid[block.weekday].add(part.key);
    }
  }
  const exact = JSON.stringify(normalizeHours(hoursFromGrid(grid))) === JSON.stringify(normalizeHours(windows));
  return { grid, exact };
}

export function hoursFromGrid(grid) {
  const blocks = [];
  for (const [weekday, parts] of Object.entries(grid)) {
    for (const part of DAY_PARTS) if (parts.has(part.key)) blocks.push({ weekday: Number(weekday), start: part.start, end: part.end });
  }
  return normalizeHours(blocks);
}

export function clockWords(minute) {
  const value = ((minute % 1440) + 1440) % 1440;
  if (minute === 1440) return 'midnight';
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  const display = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? 'am' : 'pm';
  if (value === 720) return '12 pm';
  return minutes ? `${display}:${String(minutes).padStart(2, '0')} ${suffix}` : `${display} ${suffix}`;
}

function dayList(days) {
  const ordered = WEEK_ORDER.filter(day => days.includes(day));
  if (ordered.length === 7) return 'Every day';
  // Collapse runs like Mon–Fri.
  const runs = [];
  for (const day of ordered) {
    const index = WEEK_ORDER.indexOf(day);
    const last = runs.at(-1);
    if (last && WEEK_ORDER.indexOf(last.at(-1)) === index - 1) last.push(day);
    else runs.push([day]);
  }
  const parts = runs.map(run => run.length >= 3 ? `${SHORT_DAYS[run[0]]}–${SHORT_DAYS[run.at(-1)]}` : run.map(day => SHORT_DAYS[day]).join(', '));
  return parts.join(', ');
}

/** e.g. "Mon–Fri 6 am–12 pm · Sat sessions at 8 am, 9 am", or '' when no hours. */
export function describeHours(hours) {
  const normalized = normalizeHours(hours);
  const byDay = new Map();
  for (const day of WEEK_ORDER) {
    const blocks = normalized.filter(block => block.weekday === day);
    const windows = blocks.filter(block => !isStart(block)).map(block => `${clockWords(block.start)}–${clockWords(block.end)}`);
    const starts = blocks.filter(isStart).map(block => clockWords(block.start));
    const parts = [...windows, ...(starts.length ? [`sessions at ${starts.join(', ')}`] : [])];
    if (parts.length) byDay.set(day, parts.join(', '));
  }
  const groups = new Map();
  for (const [day, text] of byDay) groups.set(text, [...(groups.get(text) || []), day]);
  return [...groups.entries()].map(([times, days]) => `${dayList(days)} ${times}`).join(' · ');
}
