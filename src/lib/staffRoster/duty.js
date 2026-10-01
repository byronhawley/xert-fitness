/**
 * Class time versus rostered duty time.
 *
 * A class runs [start, end). A coach's duty for it also includes any
 * configured preparation before and wrap-up after. Nothing here assumes a
 * class is an hour or that a class equals a paid hour: durations come from
 * the session, buffers from its staffing configuration (default none).
 *
 * Back-to-back classes form one coaching block only when both sessions allow
 * it; then the buffers between them merge and are counted once. Classes whose
 * own times overlap are always a conflict, block or not.
 */
import { MINUTE, gymDateOf, mergeIntervals, overlaps } from './time.js';

export const DEFAULT_STAFFING = Object.freeze({
  slots: Object.freeze([Object.freeze({ key: 'lead', role: 'lead', required: true, capabilities: Object.freeze([]) })]),
  prepMinutes: 0,
  wrapMinutes: 0,
  allowBlock: true,
});

export const STAFF_ROLES = Object.freeze(['lead', 'assistant', 'shadow']);
export const ROLE_LABELS = Object.freeze({ lead: 'Lead coach', assistant: 'Assistant', shadow: 'Shadow' });

export function normalizeStaffing(staffing) {
  const source = staffing || DEFAULT_STAFFING;
  const slots = Array.isArray(source.slots) && source.slots.length ? source.slots : DEFAULT_STAFFING.slots;
  const seen = new Set();
  const clean = [];
  for (const slot of slots) {
    const key = String(slot.key || '').trim();
    const role = STAFF_ROLES.includes(slot.role) ? slot.role : null;
    if (!key || !role || seen.has(key)) continue;
    seen.add(key);
    clean.push({
      key,
      role,
      // A shadow coach is never required demand: they cannot cover a class.
      required: role === 'shadow' ? false : slot.required !== false,
      capabilities: [...new Set((slot.capabilities || []).map(String).filter(Boolean))].sort(),
    });
  }
  const minutes = value => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 240 ? number : 0;
  };
  return {
    slots: clean.length ? clean : DEFAULT_STAFFING.slots.map(slot => ({ ...slot, capabilities: [] })),
    prepMinutes: minutes(source.prepMinutes),
    wrapMinutes: minutes(source.wrapMinutes),
    allowBlock: source.allowBlock !== false,
  };
}

export function dutyInterval(session) {
  const staffing = normalizeStaffing(session.staffing);
  return { start: session.start - staffing.prepMinutes * MINUTE, end: session.end + staffing.wrapMinutes * MINUTE };
}

/** Why one coach cannot do both sessions, or null when they can. */
export function dutyConflict(a, b) {
  if (a.id === b.id) return null;
  if (overlaps(a.start, a.end, b.start, b.end)) return 'CLASS_OVERLAP';
  const dutyA = dutyInterval(a);
  const dutyB = dutyInterval(b);
  if (!overlaps(dutyA.start, dutyA.end, dutyB.start, dutyB.end)) return null;
  const allowA = normalizeStaffing(a.staffing).allowBlock;
  const allowB = normalizeStaffing(b.staffing).allowBlock;
  return allowA && allowB ? null : 'DUTY_BUFFER_OVERLAP';
}

/** Total duty minutes for a coach's sessions, never double-counting shared buffer time. */
export function dutyMinutes(sessions) {
  return mergeIntervals(sessions.map(dutyInterval)).reduce((total, item) => total + (item.end - item.start) / MINUTE, 0);
}

export function classMinutes(sessions) {
  return sessions.reduce((total, session) => total + (session.end - session.start) / MINUTE, 0);
}

/**
 * Coaching blocks for display: consecutive sessions whose duty runs straight
 * on from the previous one (and both allow it). Assignments stay per session.
 */
export function coachingBlocks(sessions) {
  const sorted = [...sessions].sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
  const blocks = [];
  for (const session of sorted) {
    const duty = dutyInterval(session);
    const last = blocks[blocks.length - 1];
    const lastSession = last?.sessions[last.sessions.length - 1];
    if (last && duty.start <= last.end && normalizeStaffing(session.staffing).allowBlock
      && normalizeStaffing(lastSession.staffing).allowBlock && session.start >= lastSession.end) {
      last.sessions.push(session);
      last.end = Math.max(last.end, duty.end);
    } else {
      blocks.push({ start: duty.start, end: duty.end, sessions: [session], date: gymDateOf(session.start) });
    }
  }
  return blocks.map(block => ({ ...block, minutes: (block.end - block.start) / MINUTE }));
}
