/**
 * Turns the server's planning snapshot (`staff_roster_planning_snapshot`)
 * into the engine's planning context, and derives the Needs Attention list.
 *
 * The snapshot is one batched read per month: sessions with their effective
 * staffing, coaches, the draft and published revisions, published neighbours
 * from adjacent months (for cross-month overlap), and the server-computed
 * availability answer for every coach × session. Nothing here fetches.
 */
import { checkAssignment, LIVE_SESSION_STATUSES } from './validate.js';
import { withIndexes } from './coverage.js';
import { toMs } from './time.js';

export function monthDate(monthKey) {
  return `${monthKey}-01`;
}

export function toSession(row) {
  return {
    id: row.id,
    title: row.title,
    classType: row.class_type,
    status: row.status,
    start: toMs(row.start),
    end: toMs(row.end),
    inMonth: row.in_month !== false,
    seriesId: row.series_id || null,
    staffing: {
      slots: (row.slots || []).map(slot => ({ key: slot.key, role: slot.role, required: slot.required !== false, capabilities: slot.capabilities || [] })),
      prepMinutes: row.prep_minutes || 0,
      wrapMinutes: row.wrap_minutes || 0,
      allowBlock: row.allow_block !== false,
    },
  };
}

export function toStaff(row) {
  return {
    id: row.id,
    name: row.display_name,
    legacyLabel: row.legacy_label || null,
    profileId: row.profile_id || null,
    coachId: row.coach_id || null,
    email: row.account_email || null,
    status: row.status,
    roles: row.roles || [],
    version: row.version,
    managerNote: row.manager_note || '',
    capabilities: (row.capabilities || []).map(item => ({ name: item.capability, validFrom: toMs(item.valid_from), validUntil: toMs(item.valid_until) })),
    limits: {
      maxDutyMinutesPerDay: row.max_duty_minutes_per_day || null,
      maxClassesPerWeek: row.max_classes_per_week || null,
      minRestMinutes: row.min_rest_minutes || null,
    },
    targets: { classesPerMonth: row.target_classes_per_month || null, minClassesPerMonth: row.min_classes_per_month || null },
    raw: row,
  };
}

function toAssignment(row, extra = {}) {
  return { id: row.id, sessionId: row.session_id, slotKey: row.slot_key, staffId: row.staff_id, pinned: Boolean(row.pinned), source: row.source, role: row.role, ...extra };
}

/**
 * @param snapshot server snapshot
 * @param options { view: 'draft' | 'published', now }
 */
export function planningContext(snapshot, { view = 'draft', now = Date.now() } = {}) {
  const sessions = (snapshot.sessions || []).map(toSession);
  const staff = (snapshot.staff || []).map(toStaff);
  const usingDraft = view === 'draft' && snapshot.draft;
  const own = (usingDraft ? snapshot.draft_assignments : snapshot.published_assignments) || [];
  const assignments = [
    ...own.filter(row => row.session_id).map(row => toAssignment(row)),
    ...(snapshot.neighbour_assignments || []).map(row => toAssignment(row, { locked: true })),
  ];
  const answers = new Map((snapshot.availability || []).map(row => [`${row.staff_id}:${row.session_id}`, { status: row.status, source: row.source }]));
  const added = addedSinceSubmission(snapshot, sessions);
  for (const session of sessions) session.addedSinceSubmission = added.get(session.id) || new Set();
  const settings = snapshot.settings || {};
  return withIndexes({
    now,
    sessions: new Map(sessions.map(session => [session.id, session])),
    staff: new Map(staff.map(member => [member.id, member])),
    assignments,
    availability: (staffId, sessionId) => answers.get(`${staffId}:${sessionId}`) || { status: 'UNKNOWN', source: 'none' },
    options: { allowIfNeeded: settings.allow_if_needed_fallback !== false },
  });
}

/** sessionId → Set(staffId) for classes added or moved after each coach submitted. */
export function addedSinceSubmission(snapshot, sessions) {
  const result = new Map();
  for (const submission of snapshot.submissions || []) {
    const reviewed = new Map((submission.reviewed || []).map(item => [item.session_id, `${toMs(item.duty_start)}:${toMs(item.duty_end)}`]));
    for (const session of sessions) {
      if (!session.inMonth || !LIVE_SESSION_STATUSES.includes(session.status)) continue;
      const previous = reviewed.get(session.id);
      const duty = `${session.start - session.staffing.prepMinutes * 60000}:${session.end + session.staffing.wrapMinutes * 60000}`;
      if (previous === undefined || previous !== duty) {
        if (!result.has(session.id)) result.set(session.id, new Set());
        result.get(session.id).add(submission.staff_id);
      }
    }
  }
  return result;
}

/** Submission state per active coach for the month. */
export function submissionProgress(snapshot, today) {
  const period = snapshot.period;
  const submissions = new Map((snapshot.submissions || []).map(item => [item.staff_id, item]));
  const drafts = new Set((snapshot.drafts_in_progress || []).map(item => item.staff_id));
  const reopened = new Set((snapshot.reopenings || []).map(item => item.staff_id));
  const rows = (snapshot.staff || []).filter(member => member.status === 'active').map(member => {
    const submission = submissions.get(member.id);
    let state;
    if (!member.profile_id) state = 'no_account';
    else if (submission?.no_availability) state = 'submitted_none';
    else if (submission) state = reopened.has(member.id) ? 'reopened' : 'submitted';
    else if (!period || today < period.opens_on) state = 'not_open';
    else if (reopened.has(member.id)) state = 'reopened';
    else if (today > period.due_on) state = 'overdue';
    else state = drafts.has(member.id) ? 'draft' : 'not_submitted';
    return { staffId: member.id, name: member.display_name, state, late: Boolean(submission?.late), version: submission?.version || 0, submittedAt: submission?.submitted_at || null };
  });
  const count = state => rows.filter(row => row.state === state).length;
  return {
    rows,
    submitted: count('submitted') + count('submitted_none'),
    total: rows.filter(row => row.state !== 'no_account').length,
    missing: count('not_submitted') + count('overdue') + count('draft'),
    overdue: count('overdue'),
  };
}

const ATTENTION_ORDER = ['urgent_absence', 'invalid_published', 'uncovered', 'changed_since_publish', 'cover_pending', 'absence_pending',
  'missing_submission', 'change_request', 'added_since_submission', 'unacknowledged', 'submitted_none'];

/**
 * Items the manager should look at, each pointing at its exact record.
 */
export function needsAttention(snapshot, { today, now = Date.now() } = {}) {
  const items = [];
  const published = planningContext(snapshot, { view: 'published', now });
  const draft = planningContext(snapshot, { view: 'draft', now });
  const name = id => published.staff.get(id)?.name || 'A coach';
  const sessionLabel = session => session ? `${session.title}` : 'A class';

  for (const absence of snapshot.absences || []) {
    if (absence.status === 'reported') items.push({ kind: 'urgent_absence', title: `${name(absence.staff_id)} reported an urgent absence`, target: { type: 'absence', id: absence.id }, at: toMs(absence.starts_at) });
    else if (absence.status === 'requested') items.push({ kind: 'absence_pending', title: `${name(absence.staff_id)} asked for time off`, target: { type: 'absence', id: absence.id }, at: toMs(absence.starts_at) });
  }

  if (snapshot.published) {
    const publishedRows = snapshot.published_assignments || [];
    for (const row of publishedRows) {
      const session = published.sessions.get(row.session_id);
      if (!session || session.start <= now) continue;
      if (session.status === 'cancelled') continue;
      if (toMs(row.session_start) !== session.start || toMs(row.session_end) !== session.end) {
        items.push({ kind: 'changed_since_publish', title: `${sessionLabel(session)} moved after publication`, detail: `${name(row.staff_id)} is rostered on the old time.`, target: { type: 'session', id: session.id }, at: session.start });
      }
      const result = checkAssignment(published, { sessionId: row.session_id, slotKey: row.slot_key, staffId: row.staff_id }, { ignoreAssignmentIds: [row.id] });
      const serious = result.hard.filter(problem => !['SESSION_STARTED'].includes(problem.code));
      if (serious.length) {
        items.push({ kind: 'invalid_published', title: `${name(row.staff_id)} can no longer take ${sessionLabel(session)}`, detail: serious.map(problem => problem.message).join(' '), target: { type: 'session', id: session.id }, at: session.start });
      }
    }
  }

  const view = snapshot.draft ? draft : published;
  for (const session of view.sessions.values()) {
    if (!session.inMonth || session.start <= now || !LIVE_SESSION_STATUSES.includes(session.status)) continue;
    const filled = view.bySession.get(session.id) || [];
    const open = session.staffing.slots.filter(slot => slot.required && !filled.some(item => item.slotKey === slot.key));
    if (open.length) items.push({ kind: 'uncovered', title: `${sessionLabel(session)} needs ${open.length === 1 ? 'a coach' : `${open.length} coaches`}`, target: { type: 'session', id: session.id }, at: session.start });
    if (session.addedSinceSubmission?.size && filled.length === 0) {
      items.push({ kind: 'added_since_submission', title: `${sessionLabel(session)} was added or moved after availability was submitted`, detail: 'Coaches were not asked about this exact time. Review before assigning.', target: { type: 'session', id: session.id }, at: session.start });
    }
  }

  for (const cover of snapshot.cover_requests || []) {
    if (!['open', 'offered'].includes(cover.status)) continue;
    const session = published.sessions.get(cover.session_id);
    items.push({ kind: 'cover_pending', title: cover.status === 'offered'
      ? `Cover offered for ${sessionLabel(session)} — needs approval`
      : `${name(cover.requester_staff_id)} needs cover for ${sessionLabel(session)}`, target: { type: 'cover', id: cover.id }, at: session?.start });
  }

  const progress = submissionProgress(snapshot, today);
  for (const row of progress.rows) {
    if (['not_submitted', 'overdue', 'draft'].includes(row.state)) {
      items.push({ kind: 'missing_submission', title: `${row.name} has not submitted availability`, detail: row.state === 'overdue' ? 'Overdue.' : row.state === 'draft' ? 'Draft started, not submitted.' : null, target: { type: 'staff', id: row.staffId } });
    }
    if (row.state === 'submitted_none') items.push({ kind: 'submitted_none', title: `${row.name} is unavailable all month`, detail: 'They answered; this is not a missing submission.', target: { type: 'staff', id: row.staffId } });
  }
  for (const request of snapshot.change_requests || []) {
    items.push({ kind: 'change_request', title: `${name(request.staff_id)} asked to change their availability`, detail: request.message, target: { type: 'staff', id: request.staff_id } });
  }
  const publishedId = snapshot.published?.id;
  for (const ack of snapshot.acknowledgements || []) {
    if (ack.revision_id === publishedId && !ack.acknowledged_at) {
      items.push({ kind: 'unacknowledged', title: `${name(ack.staff_id)} has not confirmed seeing the latest roster`, target: { type: 'staff', id: ack.staff_id } });
    }
  }
  return items.sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind) || (a.at ?? Infinity) - (b.at ?? Infinity) || a.title.localeCompare(b.title));
}

/** Coach-level impact of publishing the draft over the current published revision. */
export function publishImpact(snapshot) {
  const key = row => `${row.session_id}:${row.slot_key}:${row.staff_id}`;
  const before = new Map((snapshot.published_assignments || []).map(row => [key(row), row]));
  const after = new Map((snapshot.draft_assignments || []).map(row => [key(row), row]));
  const byStaff = new Map();
  const touch = (staffId, field, row) => {
    if (!byStaff.has(staffId)) byStaff.set(staffId, { staffId, added: [], removed: [] });
    byStaff.get(staffId)[field].push(row);
  };
  for (const [k, row] of after) if (!before.has(k)) touch(row.staff_id, 'added', row);
  for (const [k, row] of before) if (!after.has(k)) touch(row.staff_id, 'removed', row);
  return [...byStaff.values()];
}
