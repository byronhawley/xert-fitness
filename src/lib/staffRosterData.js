/**
 * Staff roster API client. Every call goes through a database entry point
 * (`staff_roster_*`); tables are never read directly. The database checks
 * permissions and rules again on every call, so nothing here is trusted.
 *
 * Mutations carry a request id so a retried tap returns the first result
 * instead of acting twice, and most carry the version the screen last saw so
 * a stale screen is told to refresh instead of overwriting newer work.
 */
import { PROBLEM_MESSAGES } from './staffRoster/validate.js';

export const ROSTER_ERROR_MESSAGES = Object.freeze({
  SIGN_IN_REQUIRED: 'Please sign in again.',
  ROSTER_DISABLED: 'The coach roster is not switched on yet.',
  NOT_STAFF: 'This account is not linked to a coach on the roster. Ask the manager to link it.',
  STAFF_INACTIVE: 'This coach is inactive.',
  MANAGER_ONLY: 'Only managers can do this.',
  STALE_VERSION: 'Someone else changed this since you opened it. Refresh to see the latest version, then try again.',
  REQUEST_ID_REUSED: 'That request was already used for something else. Try again.',
  REQUEST_ID_REQUIRED: 'Something went wrong preparing the request. Try again.',
  MONTH_INVALID: 'Choose a valid month.',
  RANGE_INVALID: 'Choose a valid date range.',
  PERIOD_NOT_OPEN: 'Availability for this month is not open yet.',
  PERIOD_NOT_FOUND: 'Availability has not been opened for this month.',
  PERIOD_EXISTS: 'Availability is already open for this month.',
  NO_BACKDATING: 'Dates cannot be set in the past.',
  DEADLINE_PASSED: 'The deadline has passed. Ask the manager to reopen your availability.',
  AVAILABILITY_INVALID: 'Some answers need fixing before you can submit.',
  NO_DRAFT: 'There is no draft to change.',
  CHANGES_INVALID: 'Nothing to save.',
  OP_INVALID: 'That change is not supported.',
  ASSIGNMENT_BLOCKED: 'That assignment breaks a roster rule.',
  ASSIGNMENT_NOT_IN_DRAFT: 'That assignment is no longer in the draft. Refresh and try again.',
  ASSIGNMENT_NOT_FOUND: 'That assignment no longer exists.',
  ASSIGNMENT_NOT_CURRENT: 'That roster has been replaced by a newer version.',
  HISTORY_LOCKED: 'Past classes are history. Give a correction reason to change them.',
  SESSION_STARTED: PROBLEM_MESSAGES.SESSION_STARTED,
  SESSION_NOT_LIVE: PROBLEM_MESSAGES.SESSION_NOT_LIVE,
  SLOT_IN_USE: 'A coach is assigned to a position you removed. Unassign them first.',
  SLOT_KEY_INVALID: 'Position names may use lowercase letters, numbers and dashes.',
  SLOT_KEY_DUPLICATE: 'Two positions have the same name.',
  SLOT_ROLE_INVALID: 'Choose a valid role for each position.',
  TOO_MANY_SLOTS: 'A class can have at most eight positions.',
  SCOPE_INVALID: 'Choose where this staffing applies.',
  PRESETS_INVALID: 'Class-time presets must be valid, distinct times.',
  STAFF_NOT_FOUND: 'That coach no longer exists.',
  STAFF_ARCHIVE_INSTEAD: 'Coaches with history are deactivated, not deleted.',
  STATUS_INVALID: 'Choose a valid status.',
  ACCOUNT_NOT_FOUND: 'No account matches that sign-in.',
  ACCOUNT_ALREADY_LINKED: 'That account is already linked to another coach.',
  SERIES_NOT_FOUND: 'That repeating class no longer exists.',
  SERIES_ENDED: 'That repeating class has ended.',
  USE_THIS_AND_FUTURE: 'This series already has classes. Use “this and future” so past classes keep their history.',
  FROM_MUST_BE_FUTURE: 'Changes can only start from a future date.',
  ABSENCE_NOT_FOUND: 'That absence no longer exists.',
  ABSENCE_ALREADY_DECIDED: 'That absence has already been decided.',
  DECISION_INVALID: 'Choose approve or reject.',
  KIND_INVALID: 'Choose a valid type.',
  NOTHING_TO_WITHDRAW: 'There is nothing to withdraw.',
  COVER_NOT_FOUND: 'That cover request no longer exists.',
  COVER_NOT_OPEN: 'That cover request is closed.',
  COVER_ALREADY_REQUESTED: 'Cover is already requested for this class.',
  COVER_ALREADY_DECIDED: 'That cover request has already been decided.',
  COVER_NOT_AWAITING_APPROVAL: 'That cover request has no offer to approve.',
  OFFER_NOT_AVAILABLE: 'That offer was withdrawn.',
  OWN_REQUEST: 'You cannot cover your own class.',
  CANNOT_COVER: 'You cannot take this class.',
  VOLUNTEER_NOT_ELIGIBLE: 'This volunteer can no longer take the class.',
  SUPERSEDED: 'The roster changed after this request. It no longer applies.',
});

const CODE_PATTERN = /\b([A-Z][A-Z0-9_]{3,})\b/;

function parseDetail(detail) {
  if (!detail) return null;
  try { return JSON.parse(detail); } catch { return null; }
}

/** Turns a PostgREST/Postgres error into a readable Error with `code` and `detail`. */
export function rosterError(error) {
  const raw = String(error?.message || error || '');
  const code = raw.match(CODE_PATTERN)?.[1] || null;
  const detail = parseDetail(error?.details || error?.detail);
  let message = (code && ROSTER_ERROR_MESSAGES[code]) || null;
  if (code === 'ASSIGNMENT_BLOCKED' && detail?.problems?.length) {
    message = detail.problems.map(item => PROBLEM_MESSAGES[item] || item).join(' ');
  }
  const result = new Error(message || 'The roster could not be updated. Try again.');
  result.code = code;
  result.detail = detail;
  result.cause = error;
  return result;
}

export function newRequestId() {
  return globalThis.crypto.randomUUID();
}

export function monthParam(monthKey) {
  return /^\d{4}-\d{2}$/.test(monthKey) ? `${monthKey}-01` : monthKey;
}

/**
 * @param rpc `(name, params) => Promise<{ data, error }>` — supabase.rpc in
 * the app; a local database in tests and browser checks.
 */
export function createStaffRosterClient(rpc) {
  const call = async (name, params = {}) => {
    const { data, error } = await rpc(`staff_roster_${name}`, params);
    if (error) throw rosterError(error);
    return data;
  };
  const rid = () => newRequestId();

  return {
    // ── Manager ──
    settings: () => call('get_settings'),
    updateSettings: (patch, version) => call('update_settings', { p_patch: patch, p_expected_version: version }),
    snapshot: month => call('planning_snapshot', { p_month: monthParam(month) }),
    checkAssignment: (month, sessionId, slotKey, staffId) => call('check_assignment', { p_month: monthParam(month), p_session: sessionId, p_slot: slotKey, p_staff: staffId }),
    applyChanges: (month, version, changes, { correctionReason = null, requestId = rid() } = {}) => call('apply_changes', {
      p_month: monthParam(month), p_expected_version: version, p_changes: changes, p_request_id: requestId, p_correction_reason: correctionReason,
    }),
    discardDraft: (month, version) => call('discard_draft', { p_month: monthParam(month), p_expected_version: version, p_request_id: rid() }),
    publish: (month, version, gapReason, requestId = rid()) => call('publish', {
      p_month: monthParam(month), p_expected_version: version, p_gap_reason: gapReason || null, p_request_id: requestId,
    }),
    upsertStaff: (staff, version) => call('upsert_staff', { p_staff: staff, p_expected_version: version ?? null, p_request_id: rid() }),
    setStaffStatus: (staffId, status, version, reason) => call('set_staff_status', { p_staff_id: staffId, p_status: status, p_expected_version: version, p_reason: reason || null, p_request_id: rid() }),
    setCapabilities: (staffId, capabilities) => call('set_capabilities', { p_staff_id: staffId, p_capabilities: capabilities, p_request_id: rid() }),
    linkCandidates: query => call('link_candidates', { p_query: query }),
    openPeriod: (month, { opensOn, dueOn, publishTargetOn, shortened }) => call('open_period', {
      p_month: monthParam(month), p_opens_on: opensOn, p_due_on: dueOn, p_publish_target_on: publishTargetOn, p_shortened: Boolean(shortened), p_request_id: rid(),
    }),
    updatePeriod: (month, { dueOn, publishTargetOn }, version) => call('update_period', { p_month: monthParam(month), p_due_on: dueOn, p_publish_target_on: publishTargetOn, p_expected_version: version }),
    reopenSubmission: (month, staffId, reason) => call('reopen_submission', { p_month: monthParam(month), p_staff_id: staffId, p_reason: reason, p_request_id: rid() }),
    setStaffing: (scope, key, staffing, version) => call('set_staffing', { p_scope: scope, p_key: key, p_staffing: staffing, p_expected_version: version ?? null, p_request_id: rid() }),
    saveSeries: (series, version) => call('save_series', { p_series: series, p_expected_version: version ?? null, p_request_id: rid() }),
    previewSeries: (seriesId, from, until) => call('preview_series', { p_series_id: seriesId, p_from: from, p_until: until }),
    generateSeries: (seriesId, from, until) => call('generate_series', { p_series_id: seriesId, p_from: from, p_until: until, p_request_id: rid() }),
    changeSeriesFrom: (seriesId, from, changes, apply, version) => call('change_series_from', {
      p_series_id: seriesId, p_from: from, p_changes: changes, p_apply: Boolean(apply), p_expected_version: version, p_request_id: rid(),
    }),
    decideAbsence: (absenceId, decision, version) => call('decide_absence', { p_absence_id: absenceId, p_decision: decision, p_expected_version: version, p_request_id: rid() }),
    recordAbsence: (staffId, startsAt, endsAt, reason) => call('record_absence', { p_staff_id: staffId, p_starts: startsAt, p_ends: endsAt, p_reason: reason || null, p_request_id: rid() }),
    approveCover: (coverId, offerId, version) => call('approve_cover', { p_cover_id: coverId, p_offer_id: offerId, p_expected_version: version, p_request_id: rid() }),
    rejectCover: (coverId, version) => call('reject_cover', { p_cover_id: coverId, p_expected_version: version, p_request_id: rid() }),
    notificationLog: (month, limit = 100) => call('notification_log', { p_month: month ? monthParam(month) : null, p_limit: limit }),
    auditLog: (month, limit = 100) => call('audit_log', { p_month: month ? monthParam(month) : null, p_limit: limit }),
    runReminders: () => call('run_reminders', {}),

    // ── Coach ──
    me: () => call('me'),
    monthClasses: month => call('month_classes', { p_month: monthParam(month) }),
    saveUsualWeek: (pattern, version) => call('save_usual_week', { p_pattern: pattern, p_expected_version: version ?? null }),
    saveAvailabilityDraft: (month, payload, version) => call('save_availability_draft', { p_month: monthParam(month), p_payload: payload, p_expected_version: version ?? null }),
    submitAvailability: (month, payload, requestId = rid()) => call('submit_availability', { p_month: monthParam(month), p_payload: payload, p_request_id: requestId }),
    requestChange: (month, message) => call('request_change', { p_month: monthParam(month), p_message: message, p_request_id: rid() }),
    confirmSession: (sessionId, status) => call('confirm_session', { p_session_id: sessionId, p_status: status, p_request_id: rid() }),
    myRoster: (from, to) => call('my_roster', { p_from: from, p_to: to }),
    acknowledge: revisionId => call('acknowledge', { p_revision_id: revisionId }),
    requestAbsence: (startsAt, endsAt, kind, reason) => call('request_absence', { p_starts: startsAt, p_ends: endsAt, p_kind: kind, p_reason: reason || null, p_request_id: rid() }),
    withdraw: (kind, id) => call('withdraw', { p_kind: kind, p_id: id, p_request_id: rid() }),
    requestCover: (assignmentId, reason) => call('request_cover', { p_assignment_id: assignmentId, p_reason: reason || null, p_request_id: rid() }),
    coverBoard: () => call('cover_board'),
    offerCover: coverId => call('offer_cover', { p_cover_id: coverId, p_request_id: rid() }),
    myRequests: () => call('my_requests'),
    myNotifications: (limit = 50) => call('my_notifications', { p_limit: limit }),
    markNotificationsRead: ids => call('mark_notifications_read', { p_ids: ids }),
  };
}

let defaultClient = null;

/** The app's client, bound to the signed-in Supabase session. */
export async function staffRoster() {
  if (!defaultClient) {
    const { supabase } = await import('./supabase.js');
    defaultClient = createStaffRosterClient((name, params) => supabase.rpc(name, params));
  }
  return defaultClient;
}
