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
  STARTS_ON_INVALID: 'Choose a start day later in the month, after today.',
  ASSIGNMENTS_BEFORE_START: 'Some coaches are already rostered on classes before that start day. Remove them on the Roster tab, or choose an earlier start day.',
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
  STAFF_ALREADY_LINKED: 'This coach already has a sign-in linked.',
  EMAIL_INVALID: 'Enter a valid email address.',
  INVITE_NOT_FOUND: 'That invite no longer exists.',
  INVITE_USED: 'That invite has already been used.',
  INVITE_INVALID: 'That invite link does not work.',
  INVITE_EXPIRED: 'That invite has expired.',
  INVITE_REVOKED: 'That invite was cancelled.',
  TOO_MANY_ATTEMPTS: 'Too many tries. Wait 15 minutes and try again.',
  PROFILE_NOT_READY: 'Your account is still being set up. Try again in a moment.',
  PROFILE_INVALID: 'Something in the profile could not be saved. Check it and try again.',
  PROFILE_NAME_REQUIRED: 'Add the name to show on the Coaches page before sending it for approval.',
  PROFILE_NOT_SUBMITTED: 'That profile is not waiting for approval any more.',
  PHOTO_INVALID: 'Upload the photo here rather than linking to another site.',
  LINK_INVALID: 'Links must start with https://',
  CERTIFICATE_INVALID: 'Check the certificate type and dates (expiry can’t be before issue).',
  CERTIFICATE_NOT_FOUND: 'That certificate no longer exists.',
  FILE_INVALID: 'That file can’t be attached. Upload it again.',
  NOT_ON_CLASS: 'Only coaches rostered on this class can see its details.',
  SESSION_NOT_FOUND: 'That class no longer exists.',
  NOTE_TOO_LONG: 'Session notes can be up to 4,000 characters.',
  PREFERENCES_INVALID: 'Choose on or off for each notice type.',
  SMS_DISABLED: 'Texting coaches is switched off. Turn on “Text coaches when you publish” in Settings first.',
  // Not database codes: set by rosterError below for errors that carry none.
  NOT_INSTALLED: 'This part of the coach roster isn’t installed on the database yet. Ask whoever looks after the website to apply the latest roster update.',
  ID_INVALID: 'That item couldn’t be found. Refresh the page and try again.',
});

const CODE_PATTERN = /\b([A-Z][A-Z0-9_]{3,})\b/;

function parseDetail(detail) {
  if (!detail) return null;
  try { return JSON.parse(detail); } catch { return null; }
}

// Table rules the database enforces directly (no roster error code of their own).
const CONSTRAINT_MESSAGES = Object.freeze({
  staff_roster_periods_order: 'Check the dates: availability must open on or before it is due, be due before the month (or its roster) starts, and the publish-by date must be on or after the due date.',
  staff_roster_periods_starts_on: 'Check the dates: the roster must start on a later day of the same month, after the publish-by date.',
  // Re-assigning a coach to the position they already hold (see the 060000 proposal).
  staff_assignments_slot: 'That position already has a coach in the draft. Refresh to see the latest roster.',
  staff_assignments_person: 'That coach already has a position in this class.',
});
const CONSTRAINT_PATTERN = /violates (?:check|unique) constraint "([a-z0-9_]+)"/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Errors with no roster code of their own. PostgREST answers PGRST202 when an
 * entry point does not exist (its migration is not applied yet), and Postgres
 * 22P02 when a malformed id reaches a uuid parameter.
 */
function uncodedProblem(error, raw) {
  const sqlState = String(error?.code || '');
  if (sqlState === 'PGRST202' || /Could not find the function/i.test(raw)) return 'NOT_INSTALLED';
  if (sqlState === '22P02' || /invalid input syntax for type uuid/i.test(raw)) return 'ID_INVALID';
  return null;
}

/** Turns a PostgREST/Postgres error into a readable Error with `code` and `detail`. */
export function rosterError(error) {
  const raw = String(error?.message || error || '');
  const constraint = raw.match(CONSTRAINT_PATTERN)?.[1] || null;
  const uncoded = constraint ? null : uncodedProblem(error, raw);
  const matched = constraint || uncoded ? null : raw.match(CODE_PATTERN)?.[1] || null;
  const code = uncoded || matched;
  const detail = parseDetail(error?.details || error?.detail);
  let message = (code && ROSTER_ERROR_MESSAGES[code]) || (constraint && CONSTRAINT_MESSAGES[constraint]) || null;
  if (code === 'ASSIGNMENT_BLOCKED' && detail?.problems?.length) {
    message = detail.problems.map(item => PROBLEM_MESSAGES[item] || item).join(' ');
  }
  return Object.assign(new Error(message || 'The roster could not be updated. Try again.'), { code, detail, cause: error });
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
 * @param [options.notifyPush] called, fire-and-forget, after an action that
 * creates roster notices, so the server can also push them to phones. The
 * in-app notice is already saved; a push failure never fails the action.
 * `options.sendTexts`, when given, asks the server to send roster texts that
 * are due (managers only); it resolves to the server's counts or
 * `{ requested: false }`.
 */
export function createStaffRosterClient(rpc, { notifyPush = null, sendTexts = null } = {}) {
  const call = async (name, params = {}) => {
    const { data, error } = await rpc(`staff_roster_${name}`, params);
    if (error) throw rosterError(error);
    return data;
  };
  const rid = () => newRequestId();
  const refuse = code => Promise.reject(rosterError({ message: code }));
  const nudge = () => {
    if (!notifyPush) return;
    try { Promise.resolve(notifyPush()).catch(() => {}); } catch { /* best effort */ }
  };
  // Pushes after a successful call; a publish blocked by rules created nothing.
  const pushing = promise => promise.then(result => {
    if (result?.ok !== false) nudge();
    return result;
  });

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
    publish: (month, version, gapReason, requestId = rid()) => pushing(call('publish', {
      p_month: monthParam(month), p_expected_version: version, p_gap_reason: gapReason || null, p_request_id: requestId,
    })),
    upsertStaff: (staff, version) => call('upsert_staff', { p_staff: staff, p_expected_version: version ?? null, p_request_id: rid() }),
    setStaffStatus: (staffId, status, version, reason) => call('set_staff_status', { p_staff_id: staffId, p_status: status, p_expected_version: version, p_reason: reason || null, p_request_id: rid() }),
    setCapabilities: (staffId, capabilities) => call('set_capabilities', { p_staff_id: staffId, p_capabilities: capabilities, p_request_id: rid() }),
    linkCandidates: query => call('link_candidates', { p_query: query }),
    openPeriod: (month, { opensOn, dueOn, publishTargetOn, shortened }) => call('open_period', {
      p_month: monthParam(month), p_opens_on: opensOn, p_due_on: dueOn, p_publish_target_on: publishTargetOn, p_shortened: Boolean(shortened), p_request_id: rid(),
    }),
    // Part of a month that has started: classes from `startsOn`, coaches asked today.
    openPartMonth: (month, { startsOn, dueOn, publishTargetOn }) => call('open_part_month', {
      p_month: monthParam(month), p_starts_on: startsOn, p_due_on: dueOn, p_publish_target_on: publishTargetOn, p_request_id: rid(),
    }),
    updatePeriod: (month, { dueOn, publishTargetOn }, version) => call('update_period', { p_month: monthParam(month), p_due_on: dueOn, p_publish_target_on: publishTargetOn, p_expected_version: version }),
    reopenSubmission: (month, staffId, reason) => pushing(call('reopen_submission', { p_month: monthParam(month), p_staff_id: staffId, p_reason: reason, p_request_id: rid() })),
    setStaffing: (scope, key, staffing, version) => call('set_staffing', { p_scope: scope, p_key: key, p_staffing: staffing, p_expected_version: version ?? null, p_request_id: rid() }),
    saveSeries: (series, version) => call('save_series', { p_series: series, p_expected_version: version ?? null, p_request_id: rid() }),
    previewSeries: (seriesId, from, until) => call('preview_series', { p_series_id: seriesId, p_from: from, p_until: until }),
    generateSeries: (seriesId, from, until) => call('generate_series', { p_series_id: seriesId, p_from: from, p_until: until, p_request_id: rid() }),
    changeSeriesFrom: (seriesId, from, changes, apply, version) => call('change_series_from', {
      p_series_id: seriesId, p_from: from, p_changes: changes, p_apply: Boolean(apply), p_expected_version: version, p_request_id: rid(),
    }),
    decideAbsence: (absenceId, decision, version) => pushing(call('decide_absence', { p_absence_id: absenceId, p_decision: decision, p_expected_version: version, p_request_id: rid() })),
    recordAbsence: (staffId, startsAt, endsAt, reason) => call('record_absence', { p_staff_id: staffId, p_starts: startsAt, p_ends: endsAt, p_reason: reason || null, p_request_id: rid() }),
    // Approved cover publishes a new version, which can queue texts for the two coaches.
    approveCover: (coverId, offerId, version) => pushing(call('approve_cover', { p_cover_id: coverId, p_offer_id: offerId, p_expected_version: version, p_request_id: rid() }))
      .then(result => { if (result?.ok !== false && sendTexts) { try { Promise.resolve(sendTexts()).catch(() => {}); } catch { /* best effort */ } } return result; }),
    rejectCover: (coverId, version) => pushing(call('reject_cover', { p_cover_id: coverId, p_expected_version: version, p_request_id: rid() })),
    notificationLog: (month, limit = 100) => call('notification_log', { p_month: month ? monthParam(month) : null, p_limit: limit }),
    auditLog: (month, limit = 100) => call('audit_log', { p_month: month ? monthParam(month) : null, p_limit: limit }),
    // Availability reminders, then certificate expiry reminders; the count is both.
    runReminders: () => pushing(call('run_reminders', {}).then(async sent => {
      const certificates = await call('run_certificate_reminders', {});
      return typeof sent === 'number' ? sent + (Number(certificates) || 0) : sent;
    })),
    profileReviews: () => call('profile_reviews'),
    reviewProfile: (staffId, decision, note, version) => pushing(call('review_profile', { p_staff_id: staffId, p_decision: decision, p_note: note || null, p_expected_version: version })),
    certificatesOverview: () => call('certificates_overview'),
    // Invite links. The token comes back once, from createInvite only.
    createInvite: (staffId, email) => call('invite_create', { p_staff_id: staffId, p_email: email || null }),
    revokeInvite: inviteId => call('invite_revoke', { p_invite_id: inviteId }),
    listInvites: () => call('invite_list'),
    // Roster texts. Queued by the database when a roster is published; sent by the server.
    smsStatus: month => call('sms_status', { p_month: month ? monthParam(month) : null }),
    setSmsEnabled: (enabled, version) => call('sms_set_enabled', { p_enabled: Boolean(enabled), p_expected_version: version }),
    retryTexts: month => call('sms_retry', { p_month: monthParam(month) }),
    sendTexts: async () => (sendTexts ? sendTexts() : { requested: false }),

    // ── Joining (any signed-in account holding an invite link) ──
    // Token problems come back as { ok: false, code }, not as errors.
    previewInvite: token => call('invite_preview', { p_token: token }),
    acceptInvite: token => call('invite_accept', { p_token: token }),

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
    myDashboard: () => call('my_dashboard'),
    myHours: () => call('my_hours'),
    myProfile: () => call('my_profile'),
    saveProfile: (profile, submit, version) => (submit ? pushing : value => value)(call('save_profile', { p_profile: profile, p_submit: Boolean(submit), p_expected_version: version ?? null })),
    myCertificates: () => call('my_certificates'),
    // A malformed id (an old link, a tampered form) is refused here in plain
    // words; the database would answer with a raw uuid parse error.
    saveCertificate: certificate => (certificate?.id && !UUID_PATTERN.test(String(certificate.id))
      ? refuse('CERTIFICATE_NOT_FOUND') : call('save_certificate', { p_certificate: certificate })),
    removeCertificate: certificateId => (!UUID_PATTERN.test(String(certificateId ?? ''))
      ? refuse('CERTIFICATE_NOT_FOUND') : call('remove_certificate', { p_certificate_id: certificateId })),
    classDetail: sessionId => (!UUID_PATTERN.test(String(sessionId ?? '')) ? refuse('SESSION_NOT_FOUND') : call('class_detail', { p_session_id: sessionId })),
    saveSessionNote: (sessionId, body, expectedNoteId) => call('save_session_note', { p_session_id: sessionId, p_body: body, p_expected_note_id: expectedNoteId ?? null }),
    myNoticePreferences: () => call('my_notice_preferences'),
    setNoticePreferences: (email, push) => call('set_notice_preferences', { p_email: Boolean(email), p_push: Boolean(push) }),
    setSmsPreference: sms => call('set_sms_preference', { p_sms: Boolean(sms) }),
  };
}

let defaultClient = null;

/** The app's client, bound to the signed-in Supabase session. */
export async function staffRoster() {
  if (!defaultClient) {
    const { supabase } = await import('./supabase.js');
    defaultClient = createStaffRosterClient((name, params) => supabase.rpc(name, params), {
      notifyPush: () => requestRosterPush(() => supabase.auth.getSession()),
      sendTexts: () => requestRosterTexts(() => supabase.auth.getSession()),
    });
  }
  return defaultClient;
}

/**
 * Asks the server to push due roster notices to phones. Best effort: it
 * reports what happened and never throws. The server checks the session and
 * holds every credential; nothing private is sent from here.
 */
export async function requestRosterPush(getSession, fetcher = globalThis.fetch) {
  try {
    const { data } = await getSession();
    const token = data?.session?.access_token;
    if (!token || typeof fetcher !== 'function') return { requested: false };
    const response = await fetcher('/api/push-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'staff_roster_push' }),
      keepalive: true,
    });
    return { requested: true, ok: Boolean(response?.ok), status: response?.status ?? null };
  } catch {
    return { requested: false };
  }
}

/**
 * Asks the server to send the roster texts that are due (managers only).
 * Never throws: resolves to `{ requested: true, ok, ...counts }` or
 * `{ requested: false }`, with `error` in plain words when it did not work.
 * The server checks the session and holds the Twilio credentials.
 */
export async function requestRosterTexts(getSession, fetcher = globalThis.fetch) {
  try {
    const { data } = await getSession();
    const token = data?.session?.access_token;
    if (!token || typeof fetcher !== 'function') return { requested: false, error: 'Please sign in again.' };
    const response = await fetcher('/api/admin-publish-announcement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'send_roster_sms' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { requested: true, ok: false, error: payload?.error || 'Texts could not be sent just now.' };
    return { requested: true, ok: true, ...payload };
  } catch {
    return { requested: false, error: 'Texts could not be sent just now. Check the connection.' };
  }
}
