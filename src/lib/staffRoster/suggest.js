/**
 * Suggest Draft Roster: a deterministic, bounded constraint search.
 *
 * - Pinned assignments are never moved.
 * - Existing draft assignments that are still valid are kept by default, so
 *   re-running changes as little as possible.
 * - Open required positions are filled most-constrained first, trying
 *   PREFERRED/AVAILABLE coaches before IF_NEEDED ones (IF_NEEDED only when a
 *   position has nobody else and the fallback is on).
 * - Depth-first search with backtracking and a node budget, so an early pick
 *   cannot strand a later class when a better arrangement exists within the
 *   budget. When the budget runs out the best validated draft found so far is
 *   returned with `limitReached: true`; it is never described as optimal.
 * - Positions nobody can legitimately fill are left unfilled with reasons.
 *
 * Same inputs, same output: every ordering has a total, id-based tie-break.
 * It only proposes; the database validates again when a manager accepts.
 */
import { dutyInterval, normalizeStaffing } from './duty.js';
import { candidatesFor, withIndexes } from './coverage.js';
import { checkAssignment, indexBySession, indexByStaff, LIVE_SESSION_STATUSES, PROBLEM_MESSAGES } from './validate.js';
import { gymDateOf } from './time.js';

export const DEFAULT_NODE_LIMIT = 4000;

function compareIds(a, b) {
  return String(a).localeCompare(String(b));
}

function rebuild(ctx, assignments) {
  return { ...ctx, assignments, byStaff: indexByStaff(assignments), bySession: indexBySession(assignments) };
}

function monthCount(ctx, staffId, monthKey) {
  return (ctx.byStaff.get(staffId) || []).filter(item => {
    const session = ctx.sessions.get(item.sessionId);
    return session && gymDateOf(session.start).slice(0, 7) === monthKey;
  }).length;
}

function candidateScore(ctx, position, staffId, status, previous) {
  const member = ctx.staff.get(staffId);
  const session = position.session;
  const date = gymDateOf(session.start);
  let score = status === 'PREFERRED' ? 30 : status === 'AVAILABLE' ? 20 : 0;
  const count = monthCount(ctx, staffId, date.slice(0, 7));
  const target = member.targets?.classesPerMonth;
  score += target ? Math.max(-20, Math.min(20, (target - count) * 4)) : -count * 2;
  const duty = dutyInterval(session);
  const sameDay = (ctx.byStaff.get(staffId) || []).map(item => ctx.sessions.get(item.sessionId))
    .filter(other => other && gymDateOf(other.start) === date);
  if (sameDay.some(other => { const d = dutyInterval(other); return d.end >= duty.start && d.start <= duty.end; })) score += 10;
  else if (sameDay.length) score -= 8;
  if (previous?.get(`${session.id}:${position.slot.key}`) === staffId) score += 15;
  return score;
}

function rankedCandidates(ctx, position, previous, allowIfNeeded) {
  const options = [];
  for (const member of ctx.staff.values()) {
    const result = checkAssignment(ctx, { sessionId: position.session.id, slotKey: position.slot.key, staffId: member.id });
    if (!result.ok) continue;
    const status = ctx.availability(member.id, position.session.id)?.status;
    options.push({ staffId: member.id, status, score: candidateScore(ctx, position, member.id, status, previous) });
  }
  const strong = options.filter(item => item.status !== 'IF_NEEDED');
  const pool = strong.length || !allowIfNeeded ? strong : options;
  return pool.sort((a, b) => b.score - a.score || compareIds(a.staffId, b.staffId));
}

function reasonFor(ctx, choice) {
  const member = ctx.staff.get(choice.staffId);
  const session = ctx.sessions.get(choice.sessionId);
  const parts = [choice.status === 'PREFERRED' ? 'Preferred time' : choice.status === 'IF_NEEDED' ? 'Only if needed — nobody else could' : 'Available'];
  const count = monthCount(ctx, choice.staffId, gymDateOf(session.start).slice(0, 7));
  if (member.targets?.classesPerMonth) parts.push(`${count} of ${member.targets.classesPerMonth} target classes this month`);
  else parts.push(`${count} classes this month`);
  if (choice.alternatives === 0) parts.push('the only eligible coach');
  return parts.join(' · ');
}

function unfilledReason(ctx, sessionId, slotKey, allowIfNeeded) {
  const pool = candidatesFor(ctx, sessionId, slotKey);
  if (!pool.eligible.length && pool.ifNeeded.length && !allowIfNeeded) {
    return `Nobody can take this as a normal choice. ${pool.ifNeeded.length} ${pool.ifNeeded.length === 1 ? 'coach' : 'coaches'} said “if needed”, and the if-needed fallback is off.`;
  }
  if (pool.eligible.length || pool.ifNeeded.length) {
    return 'Eligible coaches exist but each is needed elsewhere at the same time, or the search limit was reached.';
  }
  const counts = new Map();
  for (const entry of pool.ineligible) {
    const code = entry.hard[0]?.code || 'UNKNOWN';
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${count} ${count === 1 ? 'coach' : 'coaches'}: ${(PROBLEM_MESSAGES[code] || code).replace(/\.$/, '').toLowerCase()}`);
  return parts.length ? `Nobody can take this. ${parts.join('; ')}.` : 'There are no active coaches.';
}

/**
 * @param ctx planning context (sessions, staff, availability, assignments = the current draft + other months' published)
 * @param options { sessionIds, mode: 'keep'|'fresh', allowIfNeeded, nodeLimit, previous: Map }
 */
export function suggestDraft(ctx, { sessionIds, mode = 'keep', allowIfNeeded = true, nodeLimit = DEFAULT_NODE_LIMIT, fillOptional = false } = {}) {
  const inScope = new Set(sessionIds);
  const now = ctx.now ?? Date.now();
  const fixedOutside = ctx.assignments.filter(item => !inScope.has(item.sessionId) || item.locked);
  const draft = ctx.assignments.filter(item => inScope.has(item.sessionId) && !item.locked)
    .sort((a, b) => compareIds(a.sessionId, b.sessionId) || compareIds(a.slotKey, b.slotKey));
  const previous = new Map(draft.map(item => [`${item.sessionId}:${item.slotKey}`, item.staffId]));

  // Pins first, then (keep mode) still-valid existing choices.
  let base = [...fixedOutside, ...draft.filter(item => item.pinned)];
  const removed = [];
  const kept = [];
  for (const item of draft.filter(entry => !entry.pinned)) {
    if (mode !== 'keep') continue;
    const trial = rebuild(ctx, base);
    const result = checkAssignment(trial, item);
    if (result.ok) { base = [...base, item]; kept.push(item); }
    else removed.push({ ...item, reason: result.hard.map(problem => problem.message).join(' ') });
  }

  const sessions = [...inScope].map(id => ctx.sessions.get(id)).filter(session => session
    && LIVE_SESSION_STATUSES.includes(session.status) && session.start > now);
  const openPositions = [];
  const filledKeys = new Set(base.map(item => `${item.sessionId}:${item.slotKey}`));
  for (const session of sessions.sort((a, b) => a.start - b.start || compareIds(a.id, b.id))) {
    for (const slot of normalizeStaffing(session.staffing).slots) {
      if (!slot.required && !fillOptional) continue;
      if (filledKeys.has(`${session.id}:${slot.key}`)) continue;
      openPositions.push({ session, slot, key: `${session.id}:${slot.key}` });
    }
  }

  let nodes = 0;
  let limitReached = false;
  let best = { chosen: [], filled: -1 };
  const chosen = [];
  let state = rebuild(ctx, base);

  const search = open => {
    nodes++;
    if (nodes > nodeLimit) { limitReached = true; return; }
    if (chosen.length + open.length <= best.filled) return;
    if (!open.length) {
      best = { chosen: chosen.map(item => ({ ...item })), filled: chosen.length };
      return;
    }
    // Most constrained position first.
    let pick = null;
    for (const position of open) {
      const ranked = rankedCandidates(state, position, previous, allowIfNeeded);
      if (!pick || ranked.length < pick.ranked.length
        || (ranked.length === pick.ranked.length && (position.session.start < pick.position.session.start
          || (position.session.start === pick.position.session.start && position.key < pick.position.key)))) {
        pick = { position, ranked };
      }
      if (ranked.length === 0) break;
    }
    const rest = open.filter(position => position !== pick.position);
    for (const candidate of pick.ranked) {
      const assignment = { id: `suggested:${pick.position.key}`, sessionId: pick.position.session.id, slotKey: pick.position.slot.key, staffId: candidate.staffId, source: 'suggested' };
      chosen.push({ ...assignment, status: candidate.status, alternatives: pick.ranked.length - 1 });
      const before = state;
      state = rebuild(ctx, [...state.assignments, assignment]);
      search(rest);
      state = before;
      chosen.pop();
      if (limitReached) return;
    }
    search(rest);
  };
  search(openPositions);
  if (best.filled < 0) best = { chosen: [], filled: 0 };

  const finalAssignments = [...base, ...best.chosen.map(({ status: _status, alternatives: _alternatives, ...item }) => item)];
  const finalCtx = withIndexes({ ...ctx, assignments: finalAssignments });
  const added = best.chosen.map(item => ({ sessionId: item.sessionId, slotKey: item.slotKey, staffId: item.staffId, reason: reasonFor(finalCtx, item) }));
  const addedKeys = new Set(added.map(item => `${item.sessionId}:${item.slotKey}`));
  const unfilled = openPositions.filter(position => !addedKeys.has(position.key))
    .map(position => ({ sessionId: position.session.id, slotKey: position.slot.key, reason: unfilledReason(finalCtx, position.session.id, position.slot.key, allowIfNeeded) }));

  return {
    added,
    kept: kept.map(item => ({ sessionId: item.sessionId, slotKey: item.slotKey, staffId: item.staffId })),
    removed: removed.map(item => ({ sessionId: item.sessionId, slotKey: item.slotKey, staffId: item.staffId, reason: item.reason })),
    pinned: draft.filter(item => item.pinned).map(item => ({ sessionId: item.sessionId, slotKey: item.slotKey, staffId: item.staffId })),
    unfilled,
    nodes: Math.min(nodes, nodeLimit),
    limitReached,
    summary: limitReached
      ? `Search limit reached after ${nodeLimit} steps. This is the best valid draft found, not a proven best.`
      : `Search finished in ${nodes} steps. ${unfilled.length ? `${unfilled.length} required ${unfilled.length === 1 ? 'position stays' : 'positions stay'} unfilled.` : 'Every required position is filled.'}`,
  };
}

/**
 * Copy last week's pattern onto this week as suggestions only: the same coach
 * in the same class time and position, kept only where every rule still holds
 * today. Nothing is copied that would invent availability.
 */
export function copyWeekSuggestions(ctx, { fromSessionIds, toSessionIds, offsetMs }) {
  const targets = toSessionIds.map(id => ctx.sessions.get(id)).filter(Boolean);
  const proposals = [];
  const skipped = [];
  let state = withIndexes(ctx);
  for (const source of fromSessionIds.map(id => ctx.sessions.get(id)).filter(Boolean).sort((a, b) => a.start - b.start || compareIds(a.id, b.id))) {
    const target = targets.find(session => session.start === source.start + offsetMs && session.classType === source.classType);
    if (!target) continue;
    for (const assignment of (state.bySession.get(source.id) || []).sort((a, b) => compareIds(a.slotKey, b.slotKey))) {
      if ((state.bySession.get(target.id) || []).some(item => item.slotKey === assignment.slotKey)) continue;
      const proposal = { id: `copy:${target.id}:${assignment.slotKey}`, sessionId: target.id, slotKey: assignment.slotKey, staffId: assignment.staffId, source: 'copied' };
      const result = checkAssignment(state, proposal);
      if (result.ok) {
        proposals.push(proposal);
        state = withIndexes({ ...state, assignments: [...state.assignments, proposal] });
      } else skipped.push({ ...proposal, reason: result.hard.map(item => item.message).join(' ') });
    }
  }
  return { proposals, skipped };
}
