/**
 * Assignment rules, shared by manual assignment, copying, suggestions,
 * publication and cover approval in the browser.
 *
 * The database applies the same hard rules again inside every mutation
 * (`staff_roster_assignment_problems`), so this module is for instant
 * feedback, explanations and search — never the last word. Hard problems can
 * never be overridden; soft notes describe preferences a manager may relax.
 */
import { isEligibleStatus } from './availability.js';
import { dutyConflict, dutyInterval, normalizeStaffing } from './duty.js';
import { MINUTE, gymDateOf, mergeIntervals, weekStartOf } from './time.js';

export const LIVE_SESSION_STATUSES = Object.freeze(['draft', 'published', 'full']);

export const PROBLEM_MESSAGES = Object.freeze({
  SESSION_NOT_FOUND: 'This class no longer exists.',
  SESSION_NOT_LIVE: 'This class is cancelled or finished, so it needs no coach.',
  SESSION_STARTED: 'This class has already started. Past assignments are kept as history.',
  SESSION_OUTSIDE_MONTH: 'This class belongs to another month’s roster.',
  SESSION_BEFORE_ROSTER_START: 'Before this month’s roster starts; this class stays with its current coach.',
  SLOT_UNKNOWN: 'This class has no such staffing position.',
  SLOT_TAKEN: 'Someone else already fills this position.',
  STAFF_UNKNOWN: 'This coach is not on the roster.',
  STAFF_INACTIVE: 'This coach is inactive.',
  ROLE_NOT_AUTHORISED: 'This coach is not set up for this role.',
  CAPABILITY_MISSING: 'Missing a required capability',
  CAPABILITY_EXPIRED: 'A required capability is not valid on this date',
  SAME_SESSION_DUPLICATE: 'Already in another position in this class.',
  ABSENT: 'Has an absence covering this time.',
  AVAILABILITY_UNKNOWN: 'Has not said they are available for this time.',
  AVAILABILITY_PARTIAL: 'Only available for part of this duty.',
  AVAILABILITY_UNAVAILABLE: 'Said they are unavailable.',
  AVAILABILITY_IF_NEEDED_BLOCKED: 'Only available if needed, and if-needed fallback is off.',
  CLASS_OVERLAP: 'Already coaching a class at the same time',
  DUTY_BUFFER_OVERLAP: 'Preparation or wrap-up time overlaps another duty',
  LIMIT_DAILY_DUTY: 'Would exceed their daily duty limit',
  LIMIT_WEEKLY_CLASSES: 'Would exceed their weekly class limit',
  LIMIT_REST: 'Would leave less than their minimum rest between duties',
});

function problem(code, detail) {
  const message = PROBLEM_MESSAGES[code] || code;
  return { code, message: detail ? `${message}: ${detail}` : message };
}

/** Index of a staff member's assignments, `staffId → [assignment]`. */
export function indexByStaff(assignments) {
  const index = new Map();
  for (const assignment of assignments) {
    if (!index.has(assignment.staffId)) index.set(assignment.staffId, []);
    index.get(assignment.staffId).push(assignment);
  }
  return index;
}

export function indexBySession(assignments) {
  const index = new Map();
  for (const assignment of assignments) {
    if (!index.has(assignment.sessionId)) index.set(assignment.sessionId, []);
    index.get(assignment.sessionId).push(assignment);
  }
  return index;
}

function capabilityProblems(member, slot, session) {
  const problems = [];
  for (const name of slot.capabilities) {
    const records = (member.capabilities || []).filter(item => item.name === name);
    if (!records.length) { problems.push(problem('CAPABILITY_MISSING', name)); continue; }
    const valid = records.some(item => (item.validFrom == null || item.validFrom <= session.start)
      && (item.validUntil == null || item.validUntil >= session.end));
    if (!valid) problems.push(problem('CAPABILITY_EXPIRED', name));
  }
  return problems;
}

/**
 * Problems with putting `staffId` in `slotKey` of `sessionId` given the other
 * assignments in `ctx.assignments` (the effective proposed roster).
 *
 * ctx: { now, sessions: Map, staff: Map, assignments: [], availability(staffId, sessionId) → { status },
 *        options: { allowIfNeeded } , byStaff?, bySession? }
 */
export function checkAssignment(ctx, { sessionId, slotKey, staffId }, { ignoreAssignmentIds = [] } = {}) {
  const hard = [];
  const soft = [];
  const session = ctx.sessions.get(sessionId);
  const member = ctx.staff.get(staffId);
  if (!session) return { ok: false, hard: [problem('SESSION_NOT_FOUND')], soft };
  if (!member) return { ok: false, hard: [problem('STAFF_UNKNOWN')], soft };
  const staffing = normalizeStaffing(session.staffing);
  const slot = staffing.slots.find(item => item.key === slotKey);
  const ignore = new Set(ignoreAssignmentIds);
  const live = assignment => !ignore.has(assignment.id);

  if (!LIVE_SESSION_STATUSES.includes(session.status)) hard.push(problem('SESSION_NOT_LIVE'));
  else if (ctx.now != null && session.start <= ctx.now) hard.push(problem('SESSION_STARTED'));
  if (session.beforeRosterStart) hard.push(problem('SESSION_BEFORE_ROSTER_START'));
  if (!slot) hard.push(problem('SLOT_UNKNOWN'));
  if (member.status !== 'active') hard.push(problem('STAFF_INACTIVE'));
  if (slot && !(member.roles || []).includes(slot.role)) hard.push(problem('ROLE_NOT_AUTHORISED'));
  if (slot) hard.push(...capabilityProblems(member, slot, session));

  const sessionAssignments = (ctx.bySession?.get(sessionId) || ctx.assignments.filter(item => item.sessionId === sessionId)).filter(live);
  if (sessionAssignments.some(item => item.slotKey === slotKey && item.staffId !== staffId)) hard.push(problem('SLOT_TAKEN'));
  if (sessionAssignments.some(item => item.staffId === staffId && item.slotKey !== slotKey)) hard.push(problem('SAME_SESSION_DUPLICATE'));

  const answer = ctx.availability(staffId, sessionId) || { status: 'UNKNOWN' };
  const allowIfNeeded = ctx.options?.allowIfNeeded !== false;
  if (answer.status === 'ABSENT') hard.push(problem('ABSENT'));
  else if (answer.status === 'UNKNOWN') hard.push(problem('AVAILABILITY_UNKNOWN'));
  else if (answer.status === 'PARTIAL') hard.push(problem('AVAILABILITY_PARTIAL'));
  else if (answer.status === 'UNAVAILABLE') hard.push(problem('AVAILABILITY_UNAVAILABLE'));
  else if (!isEligibleStatus(answer.status, { allowIfNeeded })) hard.push(problem('AVAILABILITY_IF_NEEDED_BLOCKED'));
  else if (answer.status === 'IF_NEEDED') soft.push({ code: 'IF_NEEDED', message: 'Only available if needed.' });
  else if (answer.status === 'PREFERRED') soft.push({ code: 'PREFERRED', message: 'A preferred time.' });

  const theirs = (ctx.byStaff?.get(staffId) || ctx.assignments.filter(item => item.staffId === staffId))
    .filter(item => live(item) && item.sessionId !== sessionId)
    .map(item => ctx.sessions.get(item.sessionId))
    .filter(other => other && LIVE_SESSION_STATUSES.includes(other.status));

  for (const other of theirs) {
    const conflict = dutyConflict(session, other);
    if (conflict) hard.push(problem(conflict, other.title || 'another class'));
  }

  const limits = member.limits || {};
  const duty = dutyInterval(session);
  const date = gymDateOf(session.start);
  if (limits.maxDutyMinutesPerDay) {
    const sameDay = theirs.filter(other => gymDateOf(other.start) === date);
    const minutes = mergeIntervals([duty, ...sameDay.map(dutyInterval)]).reduce((sum, item) => sum + (item.end - item.start) / MINUTE, 0);
    if (minutes > limits.maxDutyMinutesPerDay) hard.push(problem('LIMIT_DAILY_DUTY', `${minutes} of ${limits.maxDutyMinutesPerDay} minutes`));
  }
  if (limits.maxClassesPerWeek) {
    const week = weekStartOf(date);
    const count = theirs.filter(other => weekStartOf(gymDateOf(other.start)) === week).length + 1;
    if (count > limits.maxClassesPerWeek) hard.push(problem('LIMIT_WEEKLY_CLASSES', `${count} of ${limits.maxClassesPerWeek}`));
  }
  if (limits.minRestMinutes) {
    const blocks = mergeIntervals([duty, ...theirs.map(dutyInterval)]);
    const index = blocks.findIndex(block => block.start <= duty.start && block.end >= duty.end);
    // Gaps inside one working day are split shifts, not rest; rest applies between days.
    const crossDay = (left, right) => gymDateOf(left.end - 1) !== gymDateOf(right.start);
    const restGaps = [];
    if (index > 0 && crossDay(blocks[index - 1], blocks[index])) restGaps.push((blocks[index].start - blocks[index - 1].end) / MINUTE);
    if (index >= 0 && index < blocks.length - 1 && crossDay(blocks[index], blocks[index + 1])) restGaps.push((blocks[index + 1].start - blocks[index].end) / MINUTE);
    const rest = Math.min(...restGaps, Infinity);
    if (rest < limits.minRestMinutes) hard.push(problem('LIMIT_REST', `${Math.round(rest)} of ${limits.minRestMinutes} minutes`));
  }

  const sameDayBlocks = mergeIntervals([duty, ...theirs.filter(other => gymDateOf(other.start) === date).map(dutyInterval)]);
  if (sameDayBlocks.length > 1) soft.push({ code: 'SPLIT_SHIFT', message: 'Creates a split shift that day.' });
  const targets = member.targets || {};
  if (targets.classesPerMonth) {
    const month = date.slice(0, 7);
    const count = theirs.filter(other => gymDateOf(other.start).slice(0, 7) === month).length + 1;
    if (count > targets.classesPerMonth) soft.push({ code: 'ABOVE_TARGET', message: `Above their target of ${targets.classesPerMonth} classes this month.` });
  }
  if (session.addedSinceSubmission?.has?.(staffId)) soft.push({ code: 'ADDED_SINCE_SUBMISSION', message: 'Class added after they submitted; covered by their submitted window.' });

  return { ok: hard.length === 0, hard, soft };
}

export function explainProblems(result) {
  return result.hard.map(item => item.message).join(' ');
}
