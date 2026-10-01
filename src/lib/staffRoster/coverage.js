/**
 * Coverage: which staffing positions are filled, who could fill the rest, and
 * where demand cannot be met even in principle.
 *
 * Raw "available" counts are misleading. Three classes at 6:15 with one coach
 * available are not three covered classes, so shortages are measured per set
 * of simultaneous classes with a maximum matching of required positions to
 * distinct eligible coaches.
 */
import { normalizeStaffing } from './duty.js';
import { checkAssignment, indexBySession, indexByStaff, LIVE_SESSION_STATUSES } from './validate.js';

export function withIndexes(ctx) {
  return { ...ctx, byStaff: indexByStaff(ctx.assignments), bySession: indexBySession(ctx.assignments) };
}

export function positionsFor(ctx, session) {
  const staffing = normalizeStaffing(session.staffing);
  const filled = ctx.bySession?.get(session.id) || ctx.assignments.filter(item => item.sessionId === session.id);
  return staffing.slots.map(slot => ({ session, slot, assignment: filled.find(item => item.slotKey === slot.key) || null }));
}

/**
 * Everyone considered for one position, grouped for the assignment drawer:
 * eligible, eligible only if needed, and ineligible with reasons.
 */
export function candidatesFor(ctx, sessionId, slotKey, { ignoreAssignmentIds = [] } = {}) {
  const eligible = [];
  const ifNeeded = [];
  const ineligible = [];
  const staff = [...ctx.staff.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  for (const member of staff) {
    const result = checkAssignment(ctx, { sessionId, slotKey, staffId: member.id }, { ignoreAssignmentIds });
    const status = ctx.availability(member.id, sessionId)?.status || 'UNKNOWN';
    const entry = { staffId: member.id, name: member.name, status, hard: result.hard, soft: result.soft };
    if (!result.ok) ineligible.push(entry);
    else if (status === 'IF_NEEDED') ifNeeded.push(entry);
    else eligible.push(entry);
  }
  const preferredFirst = (a, b) => Number(b.status === 'PREFERRED') - Number(a.status === 'PREFERRED') || a.name.localeCompare(b.name);
  return { eligible: eligible.sort(preferredFirst), ifNeeded, ineligible };
}

/** Maximal sets of sessions sharing a moment of class time. */
export function simultaneousGroups(sessions) {
  const events = [];
  for (const session of sessions) {
    events.push({ at: session.start, type: 1, session });
    events.push({ at: session.end, type: 0, session });
  }
  // Half-open: an end at t happens before a start at t.
  events.sort((a, b) => a.at - b.at || a.type - b.type || String(a.session.id).localeCompare(String(b.session.id)));
  const active = new Map();
  const groups = [];
  let grew = false;
  for (const event of events) {
    if (event.type === 1) {
      active.set(event.session.id, event.session);
      grew = true;
    } else {
      if (grew && active.size > 1) groups.push([...active.values()]);
      grew = false;
      active.delete(event.session.id);
    }
  }
  return groups;
}

function maximumMatching(left, edges) {
  const owner = new Map();
  const tryAssign = (node, seen) => {
    for (const staffId of edges.get(node) || []) {
      if (seen.has(staffId)) continue;
      seen.add(staffId);
      const holder = owner.get(staffId);
      if (holder === undefined || tryAssign(holder, seen)) {
        owner.set(staffId, node);
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (const node of left) if (tryAssign(node, new Set())) size++;
  return size;
}

/**
 * Coverage for the sessions in view.
 * Returns per-session status, gaps (including positions whose assignment no
 * longer passes the rules, also listed in `invalid`), single-person
 * dependencies and joint shortages for simultaneous classes.
 */
export function coverageReport(ctx, sessionIds) {
  const indexed = ctx.byStaff ? ctx : withIndexes(ctx);
  const sessions = sessionIds.map(id => indexed.sessions.get(id)).filter(Boolean)
    .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
  const live = sessions.filter(session => LIVE_SESSION_STATUSES.includes(session.status));
  const bySession = {};
  const gaps = [];
  const dependencies = [];
  const invalid = [];
  const eligibleCache = new Map();

  for (const session of sessions) {
    if (!LIVE_SESSION_STATUSES.includes(session.status)) {
      bySession[session.id] = { status: session.status === 'cancelled' ? 'cancelled' : 'closed', required: 0, filled: 0 };
      continue;
    }
    const positions = positionsFor(indexed, session);
    let required = 0;
    let filled = 0;
    for (const position of positions) {
      if (!position.slot.required) continue;
      required++;
      const ignore = position.assignment ? [position.assignment.id] : [];
      const pool = candidatesFor(indexed, session.id, position.slot.key, { ignoreAssignmentIds: ignore });
      const options = [...pool.eligible, ...pool.ifNeeded].map(item => item.staffId);
      eligibleCache.set(`${session.id}:${position.slot.key}`, options);
      // An assignment counts as cover only while it still passes the rules
      // today: a class extended past the coach's submitted window, a new
      // absence or an expired capability turns it back into a gap.
      const stale = position.assignment && session.start > (indexed.now ?? -Infinity)
        ? checkAssignment(indexed, position.assignment, { ignoreAssignmentIds: [position.assignment.id] }).hard.map(problem => problem.code)
        : [];
      if (position.assignment && stale.length) {
        invalid.push({ sessionId: session.id, slotKey: position.slot.key, staffId: position.assignment.staffId, problems: stale });
        gaps.push({ sessionId: session.id, slotKey: position.slot.key, candidates: options.length, invalidAssignment: true });
        if (options.length === 1) dependencies.push({ sessionId: session.id, slotKey: position.slot.key, staffId: options[0], kind: 'only_option' });
      } else if (position.assignment) {
        filled++;
        if (!options.some(id => id !== position.assignment.staffId)) {
          dependencies.push({ sessionId: session.id, slotKey: position.slot.key, staffId: position.assignment.staffId, kind: 'no_backup' });
        }
      } else {
        gaps.push({ sessionId: session.id, slotKey: position.slot.key, candidates: options.length });
        if (options.length === 1) dependencies.push({ sessionId: session.id, slotKey: position.slot.key, staffId: options[0], kind: 'only_option' });
      }
    }
    bySession[session.id] = { status: filled >= required ? 'covered' : 'gap', required, filled };
  }

  const invalidKeys = new Set(invalid.map(item => `${item.sessionId}:${item.slotKey}`));
  const shortages = [];
  for (const group of simultaneousGroups(live)) {
    const nodes = [];
    const edges = new Map();
    for (const session of group) {
      for (const position of positionsFor(indexed, session)) {
        if (!position.slot.required) continue;
        const node = `${session.id}:${position.slot.key}`;
        nodes.push(node);
        const options = new Set(eligibleCache.get(node) || []);
        if (position.assignment && !invalidKeys.has(node)) options.add(position.assignment.staffId);
        edges.set(node, [...options].sort());
      }
    }
    const possible = maximumMatching(nodes, edges);
    if (possible < nodes.length) {
      shortages.push({ sessionIds: group.map(session => session.id), demand: nodes.length, possible, start: Math.max(...group.map(s => s.start)) });
    }
  }

  return {
    bySession,
    gaps,
    invalid,
    dependencies,
    shortages,
    totals: {
      sessions: live.length,
      covered: Object.values(bySession).filter(item => item.status === 'covered').length,
      requiredPositions: Object.values(bySession).reduce((sum, item) => sum + (item.required || 0), 0),
      filledPositions: Object.values(bySession).reduce((sum, item) => sum + (item.filled || 0), 0),
    },
  };
}
