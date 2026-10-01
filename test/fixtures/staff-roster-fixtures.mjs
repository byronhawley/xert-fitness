// SYNTHETIC TEST FIXTURES — fictional coaches and classes for the staff roster.
// Durations, capacities and staffing here are example values for tests only;
// the product reads them from the real timetable and configuration.
import { expandAvailability, effectiveAvailability } from '../../src/lib/staffRoster/availability.js';
import { dutyInterval } from '../../src/lib/staffRoster/duty.js';
import { gymInstant } from '../../src/lib/staffRoster/time.js';
import { withIndexes } from '../../src/lib/staffRoster/coverage.js';

export const SYNTHETIC_PRESETS = Object.freeze([
  { minute: 5 * 60 + 15, label: '5:15 am' },
  { minute: 6 * 60 + 15, label: '6:15 am' },
  { minute: 9 * 60 + 30, label: '9:30 am' },
  { minute: 16 * 60 + 30, label: '4:30 pm' },
  { minute: 17 * 60 + 30, label: '5:30 pm' },
]);

export function session(id, date, minute, durationMinutes, extra = {}) {
  const start = gymInstant(date, minute);
  return {
    id,
    title: extra.title || `Synthetic class ${id}`,
    classType: extra.classType || 'XERT Strength',
    status: extra.status || 'published',
    start,
    end: start + durationMinutes * 60000,
    staffing: extra.staffing,
    addedSinceSubmission: extra.addedSinceSubmission,
  };
}

export function coach(id, extra = {}) {
  return {
    id,
    name: extra.name || `Synthetic Coach ${id}`,
    status: extra.status || 'active',
    roles: extra.roles || ['lead', 'assistant'],
    capabilities: extra.capabilities || [],
    limits: extra.limits || {},
    targets: extra.targets || {},
  };
}

/**
 * Builds a planning context. `availability` maps staffId → submission payload
 * for `month`; `absences` maps staffId → [{ start, end }] instants.
 */
export function planningContext({ sessions, staff, month, availability = {}, absences = {}, responses = {}, assignments = [], now = 0, options = {} }) {
  const windows = new Map(Object.entries(availability).map(([staffId, submission]) => [staffId, expandAvailability(submission, month)]));
  const sessionMap = new Map(sessions.map(item => [item.id, item]));
  const answer = (staffId, sessionId) => {
    const item = sessionMap.get(sessionId);
    if (!item) return { status: 'UNKNOWN' };
    const duty = dutyInterval(item);
    return effectiveAvailability({
      absences: absences[staffId] || [],
      response: responses[`${staffId}:${sessionId}`] || null,
      windows: windows.get(staffId) || [],
      start: duty.start,
      end: duty.end,
    });
  };
  return withIndexes({
    now,
    sessions: sessionMap,
    staff: new Map(staff.map(item => [item.id, item])),
    assignments,
    availability: answer,
    options,
  });
}

/** A whole weekday window for every day of the week. */
export function everyDay(start, end, status = 'AVAILABLE') {
  return { weekly: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start, end, status })), exceptions: [], noAvailability: false };
}
