import { supabase } from './supabase';
import { XERT_2026_EVENTS } from './eventCalendar';
import { assertAdminMutation, assertAdminMutationVersion, assertSupabaseResponses } from './supabaseResults';
import { adminLeadSelect, leadMutationError, normalizeLeadPage, normalizeLeadSearch, normalizeLeadUpdate, validateLeadMutation } from './adminLeads';
import {
  filterMembers, normalizeMemberDirectoryQuery, normalizeMemberNote,
  normalizeMemberNoteArchive, normalizeRoleChange, normalizeTargetedMemberNotice
} from './memberAdmin';
import { summarizeSchemaCapabilities } from './schemaCapabilities';
import { DEFAULT_TARGET_LAUNCH_DATE } from './launchSettings';
import { blackoutPeriodMutationError, classSessionUpdateGuardError, classSessionUpdateRpcError, normalizeClassSession } from './scheduling';
import { normalizeClassTemplate } from './classCalendar';
import {
  normalizeBookingStatusMutation,
  normalizeLegacyBookingNotes,
  normalizePTRequestMutation,
  normalizeSessionAttendanceMutation,
  normalizeSessionPromotion,
} from './adminRequests';
import { dashboardMetricsFromSettled } from './adminMetrics';
import { normalizePTRequestFilters } from './ptRequestAnalytics';
import { collectAdminBatches, collectAdminPages } from './adminPagination.js';
import { adminAuditRangeStart } from './adminAudit.js';
import { apiErrorMessage } from './apiError.js';
import { providerOperationsHealth } from './platformProvider.js';

// ─── Leads ────────────────────────────────────────────────────────────────────

async function getLeadPage(table, filters = {}) {
  const pagination = normalizeLeadPage(filters.page, filters.pageSize);
  let query = supabase.from(table).select(adminLeadSelect(table), { count: 'exact' }).order('created_at', { ascending: false });
  if (filters.status) query = query.eq('status', filters.status);
  const search = normalizeLeadSearch(filters.search);
  if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  const { data, count, error } = await query.range(pagination.from, pagination.to);
  if (error) throw new Error(error.message);
  return { rows: data || [], total: count || 0, page: pagination.page, pageSize: pagination.pageSize };
}

export async function getMemberLeads(filters = {}) {
  return getLeadPage('member_interest', filters);
}

export async function getTrainerLeads(filters = {}) {
  return getLeadPage('trainer_interest', filters);
}

export async function getPartnerLeads(filters = {}) {
  return getLeadPage('partner_interest', filters);
}

export async function getCampaignAttributionRows() {
  const pageSize = 500;
  return collectAdminPages(async page => {
    const from = (page - 1) * pageSize;
    const { data, count, error } = await supabase
      .from('member_interest')
      .select('id, utm_source, utm_medium, utm_campaign, source, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return { rows: data || [], total: count || 0 };
  });
}

export async function updateLeadStatus(table, id, status) {
  const mutation = validateLeadMutation(table, status, [id]);
  const { data, error } = await supabase.rpc('admin_update_lead_statuses', {
    p_lead_type: mutation.table,
    p_lead_ids: mutation.ids,
    p_status: mutation.status,
  });
  if (error) throw leadMutationError(error, 'Lead status update failed.');
  if (Number(data) !== 1) throw new Error('Lead status update was not acknowledged. Refresh and try again.');
}

export async function updateLead(table, id, updates) {
  const mutation = normalizeLeadUpdate(table, updates);
  const validatedId = validateLeadMutation(table, mutation.updates.status, [id]).ids[0];
  const { data, error } = await supabase.rpc('admin_update_lead', {
    p_lead_type: mutation.table,
    p_lead_id: validatedId,
    p_status: mutation.updates.status,
    p_admin_notes: mutation.updates.admin_notes,
  });
  if (error) throw leadMutationError(error);
  if (Number(data) !== 1) throw new Error('Lead update was not acknowledged. Refresh and try again.');
}

export async function updateLeadStatuses(table, ids, status) {
  if (!ids?.length) return;
  const mutation = validateLeadMutation(table, status, ids);
  const { data, error } = await supabase.rpc('admin_update_lead_statuses', {
    p_lead_type: mutation.table,
    p_lead_ids: mutation.ids,
    p_status: mutation.status,
  });
  if (error) throw leadMutationError(error, 'Bulk lead status update failed.');
  if (Number(data) !== mutation.ids.length) {
    throw new Error('Bulk lead update was not fully acknowledged. Refresh and try again.');
  }
}

export async function getFitboxLeadState(leadId) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch(`/api/admin-fitbox-integration?lead_id=${encodeURIComponent(String(leadId || ''))}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox status could not be loaded.'));
  return body;
}

export async function sendLeadToFitbox(leadId) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-fitbox-integration', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'register_prospect', lead_id: String(leadId || '') }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox handoff could not be started.'));
  return body;
}

export async function refreshFitboxUser(leadId) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-fitbox-integration', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'refresh_user', lead_id: String(leadId || '') }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox profile refresh could not be started.'));
  return body;
}

// ─── Transactional email (Resend via database triggers) ─────────────────────
// Emails are sent by the database itself (pg_net + Vault), so the browser only
// ever reads settings and the log, and asks for a test send through an RPC.

export const EMAIL_TYPE_LABELS = Object.freeze({
  booking_decisions: 'Booking confirmed, waitlisted or declined',
  booking_cancellations: 'Booking cancelled',
  class_cancellations: 'Class cancelled by XERT',
  pt_decisions: 'Personal training request updates',
  enquiry_acknowledgements: 'Thanks-for-enquiring reply to new leads',
  welcome: 'Welcome email for new member accounts',
  owner_alerts: 'Alert the owner about new enquiries and requests',
  campaign: 'Emails you write and send to a group',
});

export async function getEmailSettings() {
  const { data, error } = await supabase.rpc('admin_get_email_settings');
  if (error) {
    if (missingFitboxMirror(error) || error.code === 'PGRST202') return { installed: false, settings: null };
    throw new Error(error.message);
  }
  return { installed: true, settings: data || null };
}

export async function saveEmailSettings(patch) {
  const { data, error } = await supabase.rpc('admin_update_email_settings', { p_patch: patch || {} });
  if (error) throw new Error(error.message);
  return data;
}

export async function sendTestEmail(to) {
  const { data, error } = await supabase.rpc('admin_send_test_email', { p_to: String(to || '').trim() });
  if (error) throw new Error(error.message);
  return data;
}

/** Send one owner-written email to a list of people. The database builds the
 *  branded message, applies the same switches as every other email and logs
 *  each send under the campaign id. */
export async function sendBulkEmail(payload) {
  const { data, error } = await supabase.rpc('admin_send_bulk_email', { p_campaign_id: null, ...payload });
  if (error) {
    const message = error.message || '';
    if (error.code === 'PGRST202' || /admin_send_bulk_email.*(?:not found|schema cache|does not exist)/i.test(message)) {
      throw new Error('Apply supabase/migrations/20260903010000_email_notifications.sql before emailing a group.');
    }
    if (/EMAIL_RECIPIENTS_TOO_MANY/i.test(message)) throw new Error('Send to at most 500 people per email.');
    if (/EMAIL_CTA_URL_INVALID/i.test(message)) throw new Error('The button link must start with https://.');
    throw new Error(message);
  }
  return data;
}

/** Email everyone already confirmed for an upcoming class who has not had a
 *  confirmation email yet (decisions made before email was switched on). */
export async function emailConfirmedBookings(sessionId = null) {
  const { data, error } = await supabase.rpc('admin_email_confirmed_bookings', { p_session_id: sessionId || null, p_limit: 40 });
  if (error) {
    if (error.code === 'PGRST202' || /admin_email_confirmed_bookings.*(?:not found|schema cache|does not exist)/i.test(error.message || '')) {
      throw new Error('Apply the latest supabase/migrations/20260903010000_email_notifications.sql first.');
    }
    throw new Error(error.message);
  }
  return data;
}

/** Re-send emails that failed on a provider rate limit or outage, a few at a time. */
export async function retryFailedEmails() {
  const { data, error } = await supabase.rpc('admin_retry_failed_emails', { p_limit: 8 });
  if (error) throw new Error(error.message);
  return data;
}

export async function listEmailCampaigns({ limit = 20 } = {}) {
  const { data, error } = await supabase.from('email_campaigns')
    .select('id, subject, audience, recipient_count, queued_count, skipped_count, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 100));
  if (error) {
    if (missingFitboxMirror(error)) return { installed: false, rows: [] };
    throw new Error(error.message);
  }
  return { installed: true, rows: data || [] };
}

export async function listEmailLog({ limit = 100 } = {}) {
  const reconcile = await supabase.rpc('admin_reconcile_email_log');
  if (reconcile.error && !missingFitboxMirror(reconcile.error) && reconcile.error.code !== 'PGRST202') throw new Error(reconcile.error.message);
  const { data, error } = await supabase.from('email_log')
    .select('id, email_type, recipient, subject, status, error, related_table, related_id, created_at, sent_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  if (error) {
    if (missingFitboxMirror(error)) return { installed: false, rows: [] };
    throw new Error(error.message);
  }
  return { installed: true, rows: data || [] };
}

// ─── FitBox live mirror (Zapier MCP gateway) ────────────────────────────────
// Reads come straight from the admin-readable mirror tables; anything that
// talks to FitBox goes through the server so no Zapier credential reaches the
// browser.

async function adminApiToken() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  return session.access_token;
}

function missingFitboxMirror(error) {
  return ['42P01', 'PGRST205'].includes(error?.code);
}

export const FITBOX_SYNC_FEEDS = Object.freeze(['users', 'statuses', 'subscriptions', 'bookings', 'cancellations', 'first_sessions', 'classes']);

export async function getFitboxOverview() {
  const token = await adminApiToken();
  const response = await fetch('/api/admin-fitbox-integration?overview=1', { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox overview could not be loaded.'));
  return body;
}

export async function runFitboxSync(feed) {
  if (!FITBOX_SYNC_FEEDS.includes(feed)) throw new Error('FitBox sync feed is invalid.');
  const token = await adminApiToken();
  const response = await fetch('/api/admin-fitbox-integration', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'sync_fitbox', feed }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, `FitBox ${feed} sync failed.`));
  return body;
}

export async function lookupFitboxUser({ email = '', fitboxUserId = '' } = {}) {
  const token = await adminApiToken();
  const response = await fetch('/api/admin-fitbox-integration', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'lookup_fitbox', email: String(email || '').trim(), fitbox_user_id: String(fitboxUserId || '').trim() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox lookup failed.'));
  return body;
}

async function fitboxMirrorRows(table, build) {
  const { data, error } = await build(supabase.from(table));
  if (error) {
    if (missingFitboxMirror(error)) return { rows: [], installed: false };
    throw error;
  }
  return { rows: data || [], installed: true };
}

export function listFitboxUsers({ search = '', status = 'all', limit = 200 } = {}) {
  return fitboxMirrorRows('fitbox_users', query => {
    let request = query
      .select('id, fitbox_gym_id, fitbox_user_id, first_name, last_name, email, phone, city, state, status, role, anniversary_date, provider_updated_at, synced_at')
      .order('synced_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));
    const term = String(search || '').trim();
    if (term) {
      const safe = term.replace(/[%,()]/g, ' ').trim();
      request = request.or(`email.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,fitbox_user_id.eq.${safe.replace(/[^A-Za-z0-9_-]/g, '')}`);
    }
    if (status && status !== 'all') request = request.eq('status', status);
    return request;
  });
}

export function listFitboxSubscriptions({ status = 'all', limit = 200 } = {}) {
  return fitboxMirrorRows('fitbox_subscriptions', query => {
    let request = query
      .select('id, fitbox_subscription_id, fitbox_user_id, email, product_id, product_name, status, payment_gateway, price_in_cents, setup_price_in_cents, discount_percentage, start_date, expiration_date, sessions_count, sessions_count_last_reset, provider_updated_at, synced_at')
      .order('provider_updated_at', { ascending: false, nullsFirst: false })
      .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));
    if (status && status !== 'all') request = request.eq('status', status);
    return request;
  });
}

export function listFitboxAttendance({ range = 'upcoming', limit = 200 } = {}) {
  return fitboxMirrorRows('fitbox_attendance', query => {
    let request = query
      .select('id, fitbox_attendance_id, fitbox_event_id, fitbox_class_id, class_name, fitbox_user_id, session_start_time, status, feed, synced_at')
      .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));
    const nowIso = new Date().toISOString();
    if (range === 'upcoming') request = request.gte('session_start_time', nowIso).order('session_start_time', { ascending: true });
    else request = request.order('session_start_time', { ascending: false, nullsFirst: false });
    return request;
  });
}

export function listFitboxClasses() {
  return fitboxMirrorRows('fitbox_classes', query => query.select('id, fitbox_class_id, name, synced_at').order('name'));
}

export function listFitboxSyncRuns({ limit = 30 } = {}) {
  return fitboxMirrorRows('fitbox_sync_runs', query => query
    .select('id, feed, status, accepted, rejected, linked, error_code, started_at, finished_at')
    .order('started_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 30, 1), 100)));
}

export function listFitboxMemberLinks() {
  return fitboxMirrorRows('fitbox_member_links', query => query
    .select('id, fitbox_gym_id, fitbox_user_id, lead_type, lead_id, fitbox_status, link_method, linked_at, last_verified_at, profile_synced_at')
    .order('linked_at', { ascending: false })
    .limit(500));
}

const FITBOX_RECONCILIATION_STATES = new Set(['needs_review', 'reviewed', 'ignored']);

function normalizeFitboxReconciliationEventId(value) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('FitBox event selection is invalid.');
  }
  return id;
}

export async function getFitboxReconciliationEvents(state = 'needs_review') {
  const safeState = String(state || '').trim().toLowerCase();
  if (!FITBOX_RECONCILIATION_STATES.has(safeState)) throw new Error('FitBox event state is invalid.');
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch(`/api/admin-fitbox-integration?events=1&state=${encodeURIComponent(safeState)}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox reconciliation queue could not be loaded.'));
  return body;
}

export async function acknowledgeFitboxReconciliationEvent(eventId) {
  const id = normalizeFitboxReconciliationEventId(eventId);
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-fitbox-integration', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'review_event', event_id: id }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox event could not be acknowledged.'));
  return body;
}

export async function updateLegacyBookingNotes(id, adminNotes) {
  const mutation = normalizeLegacyBookingNotes(id, adminNotes);
  const { error } = await supabase.rpc('admin_update_request', {
    p_request_type: 'class_booking',
    p_request_id: mutation.id,
    p_status: null,
    p_admin_notes: mutation.admin_notes,
    p_update_admin_notes: true,
  });
  if (error) throw new Error(error.message);
}

// ─── Classes ──────────────────────────────────────────────────────────────────

/**
 * `publicOnly` is the timetable's view of the world, so it matches what the
 * member RPC already did: classes that are open to the public, still to come,
 * and including the ones the owner has marked full so their card can say so.
 * Without the time bound the List view opened on the oldest class in the
 * database and the month counter included classes that had long since run.
 *
 * `since` widens that bound back into the past. The public calendar keeps the
 * classes that have already run on their days (the owner asked that a class
 * never vanish once it has happened); it still stops somewhere, so a year of
 * history can't push next week's classes past the API's row limit.
 */
export async function getClassSessions(publicOnly = false, { now = new Date(), since = null } = {}) {
  let query = supabase.from('class_sessions').select('*').order('start_time', { ascending: true });
  if (publicOnly) {
    query = query
      .eq('public_visible', true)
      .in('status', ['published', 'full'])
      .gt('start_time', new Date(since ?? now).toISOString());
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createClassSession(sessionData) {
  const payload = normalizeClassSession(sessionData);
  const { data, error } = await supabase.from('class_sessions').insert([payload]).select().single();
  if (error) throw new Error(classSessionUpdateRpcError(error.message));
  return data;
}

export async function createClassSessions(sessionData) {
  if (!Array.isArray(sessionData) || sessionData.length === 0) throw new Error('Create at least one class session.');
  const payload = sessionData.map(item => normalizeClassSession(item));
  const { data, error } = await supabase.from('class_sessions').insert(payload).select();
  if (error) throw new Error(classSessionUpdateRpcError(error.message));
  return data || [];
}

export async function updateClassSession(id, updates) {
  // An edit to a class that has already started is ordinary business (a coach
  // name, a note, the capacity for a walk-in); only creating one in the past is
  // a mistake worth blocking.
  const payload = normalizeClassSession(updates, { allowPastStart: true });
  const guarded = await supabase.rpc('admin_update_class_session', {
    p_session_id: id,
    p_session: payload,
  });
  if (!guarded.error) return guarded.data;

  const guardUnavailable = ['42883', 'PGRST202'].includes(guarded.error.code)
    || /admin_update_class_session.*(?:not found|schema cache|does not exist)/i.test(guarded.error.message || '');
  if (!guardUnavailable) throw new Error(classSessionUpdateRpcError(guarded.error.message));

  // Compatibility path for projects awaiting the class session guard migration.
  // The migration makes this check transactional; the preflight still blocks
  // unsafe edits immediately on older installations.
  const [current, active] = await Promise.all([
    supabase.from('class_sessions').select('status').eq('id', id).single(),
    supabase.from('session_bookings').select('id', { count: 'exact', head: true })
      .eq('class_session_id', id).in('status', ['requested', 'confirmed']),
  ]);
  if (current.error) throw new Error(current.error.message);
  if (active.error) throw new Error(active.error.message);
  const integrityError = classSessionUpdateGuardError({
    currentStatus: current.data?.status,
    nextStatus: payload.status,
    capacity: payload.capacity,
    activeBookings: active.count || 0,
  });
  if (integrityError) throw new Error(integrityError);

  const result = await supabase
    .from('class_sessions')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
  assertAdminMutation(result, 'Class session update');
}

export async function cancelClassSession(id) {
  const { data, error } = await supabase.rpc('admin_cancel_class_session', {
    p_session_id: id
  });
  if (error) throw new Error(error.message);
  return data || 0;
}

export async function notifyClassCancellation(id) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) throw new Error('Your admin session has expired. Sign in again.');
  const response = await fetch('/api/admin-publish-announcement', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action: 'notify_class_cancellation', session_id: id }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Member push delivery could not be completed.');
  return body;
}

export async function duplicateClassSession(session) {
  return createClassSession({
    ...session,
    status: 'draft',
    public_visible: false,
    title: `${session.title} (copy)`
  });
}

// ─── Class template bank ──────────────────────────────────────────────────────

function classTemplatesUnavailable(error) {
  return ['42P01', 'PGRST205', 'PGRST202'].includes(error.code)
    || /class_templates.*(?:not found|schema cache|does not exist)/i.test(error.message || '');
}

export async function getClassTemplates() {
  const { data, error } = await supabase
    .from('class_templates')
    .select('*')
    .order('name', { ascending: true })
    .order('created_at', { ascending: true });
  if (!error) return { rows: data || [], available: true };
  if (classTemplatesUnavailable(error)) return { rows: [], available: false };
  throw new Error(error.message);
}

export async function createClassTemplate(template) {
  const payload = normalizeClassTemplate(template);
  const { data, error } = await supabase.from('class_templates').insert([payload]).select().single();
  if (error) {
    if (classTemplatesUnavailable(error)) throw new Error('The class bank becomes available after class_template_bank.sql is applied.');
    throw new Error(error.message);
  }
  return data;
}

export async function updateClassTemplate(id, template) {
  const payload = normalizeClassTemplate(template);
  const { data, error } = await supabase.from('class_templates').update(payload).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteClassTemplate(id) {
  const { error } = await supabase.from('class_templates').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ─── Bookings ─────────────────────────────────────────────────────────────────

export async function getClassBookings(filters = {}) {
  const pageSize = 500;
  return collectAdminPages(async page => {
    const from = (page - 1) * pageSize;
    let query = supabase
      .from('class_bookings')
      .select('id, full_name, email, phone, training_level, notes, status, admin_notes, created_at, class_session_id, guest_visit, class_sessions(title, start_time, coach_name, location_zone, capacity, booking_mode)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (filters.class_session_id) query = query.eq('class_session_id', filters.class_session_id);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, count, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return { rows: data || [], total: count || 0 };
  });
}

/**
 * Confirming a request now takes a place in the room, so the database refuses
 * one that would oversell. `allowOverbook` is the owner deciding to squeeze
 * someone in anyway — a real and reasonable thing at a gym, but a decision
 * rather than an accident.
 *
 * Returns the audit id, or null when nothing changed, so the caller can say
 * "already confirmed" instead of reporting a change it did not make.
 */
export async function updateBookingStatus(id, status, { allowOverbook = false } = {}) {
  const mutation = normalizeBookingStatusMutation(id, status);
  const { data, error } = await supabase.rpc('admin_update_request', {
    p_request_type: 'class_booking',
    p_request_id: mutation.id,
    p_status: mutation.status,
    p_admin_notes: null,
    p_update_admin_notes: false,
    p_allow_overbook: allowOverbook === true,
  });
  if (!error) return { changed: Boolean(data), auditId: data || null };

  // A database still on the previous signature does not know the flag.
  const signatureUnknown = ['42883', 'PGRST202'].includes(error.code)
    || /admin_update_request.*(?:not found|schema cache|does not exist)/i.test(error.message || '');
  if (signatureUnknown) {
    const legacy = await supabase.rpc('admin_update_request', {
      p_request_type: 'class_booking',
      p_request_id: mutation.id,
      p_status: mutation.status,
      p_admin_notes: null,
      p_update_admin_notes: false,
    });
    if (legacy.error) throw new Error(bookingRequestError(legacy.error.message));
    return { changed: Boolean(legacy.data), auditId: legacy.data || null };
  }
  throw new Error(bookingRequestError(error.message));
}

/** Database codes the requests queue can act on, in the owner's words. */
export function bookingRequestError(message) {
  const raw = String(message || '');
  if (/CLASS_FULL/i.test(raw)) return 'CLASS_FULL: this class is already full.';
  if (/CLASS_WAITLISTED/i.test(raw)) return 'CLASS_WAITLISTED: someone is queued for this class ahead of them.';
  if (/REQUEST_NOT_FOUND/i.test(raw)) return 'That request no longer exists. Refresh the queue.';
  if (/ADMIN_REQUIRED/i.test(raw)) return 'Sign in as an admin to change bookings.';
  if (/SESSION_NOT_STARTED/i.test(raw)) return 'That class has not started yet, so it cannot be marked off.';
  return raw;
}

// Authenticated member bookings are a separate, credit-backed workflow from
// pre-launch enquiry forms. The admin queue presents both together.
export async function getMemberBookingRequests(filters = {}) {
  const pageSize = 500;
  const rows = await collectAdminPages(async page => {
    const from = (page - 1) * pageSize;
    let query = supabase
      .from('session_bookings')
      .select('id, user_id, status, created_at, credit_batch_id, class_session_id, class_sessions(title, start_time, coach_name, location_zone, capacity, booking_mode)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (filters.status) query = query.eq('status', filters.status);
    const { data, count, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return { rows: data || [], total: count || 0 };
  });
  const memberIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))];
  if (memberIds.length === 0) return [];

  const profiles = [];
  for (let index = 0; index < memberIds.length; index += 100) {
    const ids = memberIds.slice(index, index + 100);
    const { data, error } = await supabase.from('profiles').select('id, full_name, email, phone').in('id', ids);
    if (error) throw new Error(error.message);
    profiles.push(...(data || []));
  }

  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  return rows.map(row => ({
    ...row,
    profile: profileById.get(row.user_id) || null
  }));
}

/**
 * Book a member into a class from the Command Centre — the front desk adding
 * someone who turned up, or a name taken over the phone. The database does it
 * atomically: it takes a credit, respects capacity and the waitlist order, and
 * writes a private notice for the member, so a staff booking is exactly a
 * member booking made by somebody else.
 */
/**
 * Casual visits paid at the door, on the visitor's own phone. Kept apart from
 * orders because nothing is fulfilled: no account, no credits, just entry paid
 * for. Returns installed:false until the migration is applied so the screen can
 * say so instead of failing.
 */
export async function listCasualVisits({ limit = 200 } = {}) {
  const columns = 'id, full_name, email, phone, amount_cents, currency, status, created_at, stripe_payment_intent_id';
  const load = fields => supabase.from('casual_visit_payments')
    .select(fields)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));
  let { data, error } = await load(`${columns}, pass_kind`);
  // During rollout the legacy table still supports casual takings. Only the
  // missing additive column permits a retry; other failures stay visible.
  if (error?.code === '42703' && /pass_kind/.test(error.message || '')) {
    ({ data, error } = await load(columns));
  }
  if (error) {
    if (missingFitboxMirror(error) || error.code === 'PGRST205') return { installed: false, rows: [] };
    throw new Error(error.message);
  }
  return { installed: true, rows: data || [] };
}

/**
 * A request id for one booking decision, so a retry settles once instead of
 * twice. Built here rather than in a default parameter: the minifier lowers
 * `globalThis.crypto?.randomUUID?.()` in that position into code that reads a
 * variable which is no longer in scope, and the whole call dies with
 * "Can't find variable: a" in front of whoever pressed the button.
 */
function newDecisionRequestID() {
  return globalThis.crypto?.randomUUID?.();
}

export async function staffBookMemberIntoClass(sessionId, memberId, requestId) {
  requestId = requestId || newDecisionRequestID();
  if (!sessionId || !memberId) throw new Error('Choose a class and a member first.');
  if (!requestId) throw new Error('A secure booking request ID could not be created. Refresh and try again.');
  const { data, error } = await supabase.rpc('admin_book_member_into_class', {
    p_session_id: sessionId,
    p_member_id: memberId,
    p_request_id: requestId,
  });
  if (error) {
    const message = error.message || '';
    if (error.code === 'PGRST202' || /admin_book_member_into_class.*(?:not found|schema cache|does not exist)/i.test(message)) {
      throw new Error('Apply the staff-assisted booking migration before adding members to a class.');
    }
    // Class credits are retired, so this should no longer reach staff. It is
    // kept as a safety net for any older path that still raises it.
    if (/NO_CREDITS/i.test(message)) throw new Error('That member could not be added. Refresh the roster and try again.');
    if (/SESSION_FULL/i.test(message)) throw new Error('That class is full. The member can join the waitlist from their account.');
    if (/ALREADY_BOOKED/i.test(message)) throw new Error('That member already has a place in this class.');
    if (/SESSION_IN_PAST|SESSION_NOT_BOOKABLE/i.test(message)) throw new Error('That class is not open for bookings.');
    throw new Error(message);
  }
  const receipt = Array.isArray(data) ? data[0] : data;
  if (!receipt || receipt.request_id !== requestId || receipt.session_id !== sessionId || receipt.member_id !== memberId) {
    throw new Error('The booking completed without a verifiable receipt. Refresh the roster before continuing.');
  }
  if (!receipt.announcement_id) return { ...receipt, push: null, warning: null };
  const delivery = await notifyTargetedAnnouncementPush(receipt.announcement_id);
  return { ...receipt, push: delivery.push, warning: delivery.warning || null };
}

export async function updateMemberBookingStatus(id, status) {
  return adminSetBookingStatus(id, status);
}

// ─── PT Requests ──────────────────────────────────────────────────────────────

export async function getPTRequests(filters = {}) {
  const normalized = normalizePTRequestFilters(filters);
  const applyFilters = (query, status = normalized.status) => {
    let filtered = query;
    if (status) filtered = filtered.eq('status', status);
    if (normalized.sessionType) filtered = filtered.eq('requested_session_type', normalized.sessionType);
    if (normalized.cutoff) filtered = filtered.gte('created_at', normalized.cutoff);
    if (normalized.search) {
      const term = `%${normalized.search}%`;
      filtered = filtered.or([
        'full_name', 'email', 'phone', 'requested_session_type', 'preferred_day',
        'preferred_time', 'training_goal', 'experience_level', 'admin_notes'
      ].map(column => `${column}.ilike.${term}`).join(','));
    }
    return filtered;
  };

  const pageQuery = applyFilters(
    supabase.from('private_session_requests').select(
      'id, full_name, email, phone, requested_session_type, preferred_day, preferred_time, training_goal, experience_level, notes, status, admin_notes, created_at',
      { count: 'exact' }
    ).order('created_at', { ascending: false })
  ).range(normalized.from, normalized.to);
  const statusCount = status => applyFilters(
    supabase.from('private_session_requests').select('id', { count: 'exact', head: true }),
    status
  );
  if (filters.includeSummary === false) {
    const pageResult = await pageQuery;
    assertSupabaseResponses([pageResult]);
    return { rows: pageResult.data || [], total: pageResult.count || 0, page: normalized.page, pageSize: normalized.pageSize, summary: null };
  }
  const [pageResult, requested, approved, completed] = await Promise.all([
    pageQuery,
    statusCount('requested'),
    statusCount('approved'),
    statusCount('completed')
  ]);
  assertSupabaseResponses([pageResult, requested, approved, completed]);
  return {
    rows: pageResult.data || [],
    total: pageResult.count || 0,
    page: normalized.page,
    pageSize: normalized.pageSize,
    summary: {
      total: pageResult.count || 0,
      requested: normalized.status && normalized.status !== 'requested' ? 0 : requested.count || 0,
      approved: normalized.status && normalized.status !== 'approved' ? 0 : approved.count || 0,
      completed: normalized.status && normalized.status !== 'completed' ? 0 : completed.count || 0
    }
  };
}

export async function updatePTRequestStatus(id, status, admin_notes) {
  const mutation = normalizePTRequestMutation(id, status, admin_notes);
  const updatesNotes = Object.hasOwn(mutation.updates, 'admin_notes');
  const { error } = await supabase.rpc('admin_update_request', {
    p_request_type: 'private_session',
    p_request_id: mutation.id,
    p_status: mutation.updates.status,
    p_admin_notes: updatesNotes ? mutation.updates.admin_notes : null,
    p_update_admin_notes: updatesNotes,
  });
  if (error) throw new Error(error.message);
}

// ─── Availability / Blackouts ─────────────────────────────────────────────────

export async function getAvailabilityBlocks() {
  const { data, error } = await supabase.from('availability_blocks').select('*').order('start_time', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createAvailabilityBlock(blockData) {
  const { error } = await supabase.from('availability_blocks').insert([blockData]);
  if (error) throw new Error(error.message);
}

export async function updateAvailabilityBlock(id, blockData, expectedUpdatedAt) {
  let query = supabase.from('availability_blocks').update(blockData).eq('id', id);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const result = await query.select('id');
  assertAdminMutationVersion(result, 'Availability update');
}

export async function deleteAvailabilityBlock(id, expectedUpdatedAt) {
  let query = supabase.from('availability_blocks').delete().eq('id', id);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const result = await query.select('id');
  assertAdminMutationVersion(result, 'Availability deletion');
}

export async function getBlackoutPeriods() {
  const { data, error } = await supabase.from('blackout_periods').select('*').order('start_time', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createBlackoutPeriod(periodData) {
  const { error } = await supabase.from('blackout_periods').insert([periodData]);
  if (error) throw new Error(blackoutPeriodMutationError(error.message));
}

export async function updateBlackoutPeriod(id, periodData, expectedUpdatedAt) {
  let query = supabase.from('blackout_periods').update(periodData).eq('id', id);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const result = await query.select('id');
  if (result.error) throw new Error(blackoutPeriodMutationError(result.error.message));
  assertAdminMutationVersion(result, 'Blackout update');
}

export async function deleteBlackoutPeriod(id, expectedUpdatedAt) {
  let query = supabase.from('blackout_periods').delete().eq('id', id);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const result = await query.select('id');
  assertAdminMutationVersion(result, 'Blackout deletion');
}

// ─── Admin Settings ───────────────────────────────────────────────────────────

export async function getSoftLaunchSettings() {
  const { data, error } = await supabase.from('admin_settings').select('*').limit(2);
  if (error) throw new Error(error.message);
  if ((data || []).length > 1) {
    throw new Error('Platform settings integrity check failed. Checkout remains paused until the duplicate settings are repaired.');
  }
  return data?.[0] || getDefaultSettings();
}

export function getDefaultSettings() {
  return {
    soft_launch_mode: true,
    target_launch_date: DEFAULT_TARGET_LAUNCH_DATE,
    countdown_enabled: true,
    max_soft_launch_class_capacity: 12,
    bookings_enabled: false,
    prices_coming_soon: true,
    default_booking_mode: 'instant_book',
    show_limited_capacity_badge: true,
    show_opening_in_stages_message: true,
    memberships_enabled: false,
    payments_enabled: false,
    fitbox_enabled: false,
    fitbox_booking_url: null,
    announcement_banner_text: null,
    announcement_banner_enabled: false
  };
}

export async function updateSoftLaunchSettings(updates, baseline) {
  if (baseline?.id) {
    const nextSettings = { ...baseline, ...updates };
    if (nextSettings.payments_enabled === true && nextSettings.bookings_enabled !== true) {
      throw new Error('Open member bookings before enabling session-pack payments.');
    }
    let query = supabase
      .from('admin_settings')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', baseline.id);
    if (baseline.updated_at) query = query.eq('updated_at', baseline.updated_at);
    const result = await query.select('*');
    return assertAdminMutationVersion(result, 'Launch settings update')[0];
  }

  const current = await getSoftLaunchSettings();
  const nextSettings = { ...current, ...updates };
  if (nextSettings.payments_enabled === true && nextSettings.bookings_enabled !== true) {
    throw new Error('Open member bookings before enabling session-pack payments.');
  }
  if (current?.id) {
    throw new Error('Launch settings changed since you opened them. Refresh the admin view and review the latest version.');
  }
  const { data, error } = await supabase
    .from('admin_settings')
    .insert([nextSettings])
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function activateSessionPackPayments(settings, baseline) {
  if (!baseline?.id || !baseline?.updated_at) {
    throw new Error('Save the platform settings once before enabling payments.');
  }
  if (baseline.payments_enabled !== false) {
    throw new Error('Pause payments and save the latest platform settings before activating checkout.');
  }
  if (settings?.payments_enabled !== true) {
    throw new Error('Payment activation requires an explicit enabled setting.');
  }
  if (settings?.fitbox_enabled === true) {
    throw new Error('XERT payments cannot be enabled while FitBox is selected.');
  }
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-commerce-health', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'activate_payments',
      confirmation: 'ENABLE PAYMENTS',
      settings_id: baseline.id,
      expected_updated_at: baseline.updated_at,
      settings,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Payment activation failed. Payments remain paused.'));
  if (body?.payments_enabled !== true || body?.id !== baseline.id || !body?.updated_at) {
    throw new Error('Payment activation could not be confirmed. Payments remain paused.');
  }
  return body;
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

export async function getDashboardStats() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoIso = weekAgo.toISOString();
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const monthAgoIso = monthAgo.toISOString();

  const results = await Promise.allSettled([
    supabase.from('member_interest').select('id, status, preferred_training_times, main_training_goals, interested_in_pt, interested_in_event_prep', {
      count: 'exact'
    }).range(0, 999),
    supabase.from('trainer_interest').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    supabase.from('partner_interest').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    supabase.from('member_interest').select('id', { count: 'exact', head: true }).gte('created_at', weekAgoIso),
    supabase.from('member_interest').select('id', { count: 'exact', head: true }).eq('interested_in_pt', true),
    supabase.from('member_interest').select('id', { count: 'exact', head: true }).eq('interested_in_event_prep', true),
    supabase.from('class_bookings').select('id', { count: 'exact', head: true }).eq('status', 'requested'),
    supabase.from('session_bookings').select('id', { count: 'exact', head: true }).eq('status', 'requested'),
    supabase.from('class_bookings').select('id', { count: 'exact', head: true }).eq('status', 'waitlisted'),
    supabase.from('session_bookings').select('id', { count: 'exact', head: true }).eq('status', 'waitlisted'),
    supabase.from('private_session_requests').select('id', { count: 'exact', head: true }).eq('status', 'requested'),
    supabase.from('session_bookings').select('id', { count: 'exact', head: true }).eq('status', 'attended').gte('attendance_marked_at', monthAgoIso),
    supabase.from('session_bookings').select('id', { count: 'exact', head: true }).eq('status', 'no_show').gte('attendance_marked_at', monthAgoIso)
  ]);
  return dashboardMetricsFromSettled(results);
}

// ─── Coaches (admin CRUD) ───────────────────────────────────────────────────

export async function getAllCoaches() {
  const { data, error } = await supabase.from('coaches').select('*').order('sort_order', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createCoach(coach) {
  const { error } = await supabase.from('coaches').insert([coach]);
  if (error) throw new Error(error.message);
}

export async function updateCoach(id, updates, expectedUpdatedAt) {
  if (!expectedUpdatedAt) throw new Error('Coach version is missing. Refresh the admin view and try again.');
  const result = await supabase
    .from('coaches')
    .update(updates)
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id');
  assertAdminMutationVersion(result, 'Coach update');
}

export async function deleteCoach(id, expectedUpdatedAt) {
  if (!expectedUpdatedAt) throw new Error('Coach version is missing. Refresh the admin view and try again.');
  const result = await supabase
    .from('coaches')
    .delete()
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id');
  assertAdminMutationVersion(result, 'Coach deletion');
}

// ─── Events (admin CRUD) ────────────────────────────────────────────────────

export async function getAllEvents() {
  const { data, error } = await supabase.from('events').select('*').order('event_date', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getEventGoalCounts() {
  const { data, error } = await supabase.from('member_event_goals').select('event_id');
  if (error) throw new Error(error.message);
  return (data || []).reduce((counts, goal) => {
    counts[goal.event_id] = (counts[goal.event_id] || 0) + 1;
    return counts;
  }, {});
}

export async function getEventGoalMembers(eventId) {
  if (!eventId) throw new Error('An event is required to load its training group.');
  const { data, error } = await supabase.rpc('admin_event_goal_members', {
    p_event_id: eventId
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createEvent(event) {
  const { error } = await supabase.from('events').insert([event]);
  if (error) throw new Error(error.message);
}

export async function updateEvent(id, updates, expectedUpdatedAt) {
  if (!expectedUpdatedAt) throw new Error('Event version is missing. Refresh the admin view and try again.');
  const result = await supabase
    .from('events')
    .update(updates)
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id');
  assertAdminMutationVersion(result, 'Event update');
}

export async function deleteEvent(id, expectedUpdatedAt) {
  if (!expectedUpdatedAt) throw new Error('Event version is missing. Refresh the admin view and try again.');
  const result = await supabase
    .from('events')
    .delete()
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id');
  assertAdminMutationVersion(result, 'Event deletion');
}

// ─── Member announcements ───────────────────────────────────────────────────

export async function getAllMemberAnnouncements() {
  const [announcementResult, metricResult, pushMetricResult] = await Promise.all([
    supabase.from('member_announcements').select('*').eq('audience', 'all').order('created_at', { ascending: false }),
    supabase.rpc('admin_announcement_metrics'),
    supabase.rpc('admin_announcement_push_metrics'),
  ]);
  if (announcementResult.error) throw new Error(announcementResult.error.message);
  if (metricResult.error) throw new Error(metricResult.error.message);
  if (pushMetricResult.error) throw new Error(pushMetricResult.error.message);
  const metrics = new Map((metricResult.data || []).map(item => [item.announcement_id, item]));
  const pushMetrics = new Map((pushMetricResult.data || []).map(item => [item.announcement_id, item]));
  return (announcementResult.data || []).map(item => ({
    ...item,
    read_count: Number(metrics.get(item.id)?.read_count) || 0,
    dismissed_count: Number(metrics.get(item.id)?.dismissed_count) || 0,
    push_delivered_count: Number(pushMetrics.get(item.id)?.delivered_count) || 0,
    push_failed_count: (Number(pushMetrics.get(item.id)?.failed_count) || 0) + (Number(pushMetrics.get(item.id)?.invalid_token_count) || 0),
    push_last_attempted_at: pushMetrics.get(item.id)?.last_attempted_at || null,
  }));
}

export async function publishMemberAnnouncement(id, announcement, expectedUpdatedAt) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) throw new Error('Your admin session has expired. Sign in again.');
  const response = await fetch('/api/admin-publish-announcement', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ id: id || null, announcement, expected_updated_at: expectedUpdatedAt || null }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Announcement could not be published.');
  return body;
}

export async function createMemberAnnouncement(announcement) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('Your admin session has expired. Sign in again.');
  const { data, error } = await supabase
    .from('member_announcements')
    .insert({ ...announcement, created_by: user.id })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateMemberAnnouncement(id, updates, expectedUpdatedAt) {
  let query = supabase
    .from('member_announcements')
    .update(updates)
    .eq('id', id);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const result = await query.select('*');
  return assertAdminMutationVersion(result, 'Announcement update')[0];
}

export async function deleteMemberAnnouncement(id, expectedUpdatedAt) {
  let query = supabase.from('member_announcements').delete().eq('id', id);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const result = await query.select('id');
  if (/ANNOUNCEMENT_ARCHIVE_REQUIRED/i.test(result.error?.message || '')) {
    throw new Error('Published notices must be archived so their member and delivery history stays intact.');
  }
  assertAdminMutationVersion(result, 'Announcement deletion');
}

export async function setMemberAnnouncementArchived(id, archived, expectedUpdatedAt) {
  const { error } = await supabase.rpc('admin_archive_member_announcement', {
    p_announcement_id: id,
    p_archived: Boolean(archived),
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (/ANNOUNCEMENT_STALE/i.test(error?.message || '')) {
    throw new Error('Announcement archive was not applied because this notice changed since you opened it. Refresh the admin view and review the latest version.');
  }
  if (error) throw new Error(error.message);
}

export async function seedXertEventCalendar() {
  const { data: existing, error: existingError } = await supabase.from('events').select('name,event_date');
  if (existingError) throw new Error(existingError.message);

  const existingKeys = new Set((existing || []).map(event => `${event.name}|${event.event_date}`));
  const missing = XERT_2026_EVENTS.filter(event => !existingKeys.has(`${event.name}|${event.event_date}`));

  if (missing.length === 0) {
    return { inserted: 0, total: existing?.length || 0 };
  }

  const payload = missing.map(event => ({
    name: event.name,
    category: event.category,
    event_date: event.event_date,
    end_date: event.end_date,
    location: event.location,
    region: event.region,
    sort_order: event.sort_order,
    published: true,
    url: /** @type {{ url?: string }} */ (event).url || null
  }));

  const { error } = await supabase.from('events').insert(payload);
  if (error) throw new Error(error.message);
  return {
    inserted: missing.length,
    total: (existing?.length || 0) + missing.length
  };
}

// ─── Members (admin) ─────────────────────────────────────────────────────────

export async function adminListMembers() {
  return collectAdminBatches(async (page, pageSize) => {
    const from = (page - 1) * pageSize;
    const { data, error } = await supabase
      .rpc('admin_list_members')
      .order('joined_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return data || [];
  });
}

export async function adminSearchMembers(search, limit = 12) {
  const normalizedSearch = normalizeLeadSearch(search);
  if (normalizedSearch.length < 2) return [];
  const normalizedLimit = Math.max(1, Math.min(20, Number.parseInt(String(limit), 10) || 12));

  const primary = await supabase.rpc('admin_search_members', {
    p_search: normalizedSearch,
    p_limit: normalizedLimit
  });
  if (!primary.error) return primary.data || [];

  const functionUnavailable = ['42883', 'PGRST202'].includes(primary.error.code)
    || /admin_search_members.*(?:not found|schema cache|does not exist)/i.test(primary.error.message || '');
  if (!functionUnavailable) throw new Error(primary.error.message);

  const term = `%${normalizedSearch}%`;
  const { data, error } = await supabase
    .rpc('admin_list_members')
    .or(['full_name', 'email', 'phone'].map(column => `${column}.ilike.${term}`).join(','))
    .order('joined_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(normalizedLimit);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function adminListMembersPage(filters = {}) {
  const query = normalizeMemberDirectoryQuery(filters);
  const response = await supabase.rpc('admin_list_members_page', {
    p_search: query.search || null,
    p_role: query.role,
    p_credit: query.credit,
    p_limit: query.pageSize,
    p_offset: query.offset,
    p_user_id: query.memberId
  });

  if (!response.error) {
    const rows = (response.data || []).map(({ total_count: _totalCount, ...member }) => member);
    return {
      rows,
      total: Number(response.data?.[0]?.total_count || 0),
      page: query.page,
      pageSize: query.pageSize,
      serverPaged: true
    };
  }

  const functionUnavailable = ['42883', 'PGRST202'].includes(response.error.code)
    || /admin_list_members_page.*(?:not found|schema cache|does not exist)/i.test(response.error.message || '');
  if (!functionUnavailable) throw new Error(response.error.message);

  const allMembers = await adminListMembers();
  const filtered = filterMembers(
    query.memberId ? allMembers.filter(member => member.id === query.memberId) : allMembers,
    query
  );
  return {
    rows: filtered.slice(query.offset, query.offset + query.pageSize),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    serverPaged: false
  };
}

export async function adminExportMembers(filters = {}) {
  const query = normalizeMemberDirectoryQuery({ ...filters, page: 1, pageSize: 100, memberId: null });
  const first = await adminListMembersPage(query);
  if (!first.serverPaged) {
    return filterMembers(await adminListMembers(), query);
  }
  return collectAdminPages(page => (
    page === 1 ? first : adminListMembersPage({ ...query, page })
  ));
}

export async function adminRecentMembers(limit = 6) {
  const safeLimit = Math.max(1, Math.min(20, Number.parseInt(String(limit), 10) || 6));
  const { data, error } = await supabase
    .rpc('admin_list_members')
    .order('joined_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(safeLimit);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function adminGrantCredits(userId, sessions, validityDays, requestId, note) {
  const { error } = await supabase.rpc('admin_grant_credits_v2', {
    p_user_id: userId,
    p_sessions: sessions,
    p_validity_days: validityDays ?? null,
    p_request_id: requestId,
    p_note: note
  });
  if (error) {
    if (/admin_grant_credits_v2|schema cache|function.*not found/i.test(error.message || '')) {
      throw new Error('Apply credit_grant_audit_upgrade.sql before issuing manual credits.');
    }
    throw new Error(error.message);
  }
}

export async function adminSetRole(userId, role) {
  const change = normalizeRoleChange(userId, role);
  const { error } = await supabase.rpc('admin_set_role', {
    p_user_id: change.userId,
    p_role: change.role
  });
  if (error) {
    if (/CANNOT_DEMOTE_LAST_ADMIN/i.test(error.message || '')) {
      throw new Error('Promote another administrator before removing the final admin.');
    }
    throw new Error(error.message);
  }
}

export async function adminListMemberNotes(userId, includeArchived = false) {
  const member = normalizeMemberDirectoryQuery({ memberId: userId, pageSize: 1 });
  const { data, error } = await supabase.rpc('admin_list_member_notes', {
    p_user_id: member.memberId,
    p_include_archived: Boolean(includeArchived)
  });
  if (!error) return { rows: data || [], available: true };
  const functionUnavailable = ['42883', 'PGRST202'].includes(error.code)
    || /admin_list_member_notes.*(?:not found|schema cache|does not exist)/i.test(error.message || '');
  if (functionUnavailable) return { rows: [], available: false };
  throw new Error(error.message);
}

export async function adminAddMemberNote(userId, category, body) {
  const note = normalizeMemberNote(userId, category, body);
  const { data, error } = await supabase.rpc('admin_add_member_note', {
    p_user_id: note.userId,
    p_category: note.category,
    p_body: note.body
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function adminSetMemberNoteArchived(noteId, archived) {
  const note = normalizeMemberNoteArchive(noteId, archived);
  const { error } = await supabase.rpc('admin_set_member_note_archived', {
    p_note_id: note.noteId,
    p_archived: note.archived
  });
  if (error) throw new Error(error.message);
}

export async function adminListMemberNotices(userId) {
  const member = normalizeMemberDirectoryQuery({ memberId: userId });
  const { data, error } = await supabase.rpc('admin_list_member_notices', {
    p_user_id: member.memberId,
  });
  const missing = error?.code === 'PGRST202'
    || /admin_list_member_notices.*(?:not found|schema cache|does not exist)/i.test(error?.message || '');
  if (missing) return { rows: [], available: false };
  if (error) throw new Error(error.message);
  return { rows: data || [], available: true };
}

export async function adminSendMemberNotice(userId, notice) {
  const mutation = normalizeTargetedMemberNotice(userId, notice);
  const { data: announcementId, error } = await supabase.rpc('admin_send_member_notice', {
    p_user_id: mutation.userId,
    p_title: mutation.title,
    p_body: mutation.body,
    p_tone: mutation.tone,
    p_cta_label: mutation.ctaLabel,
    p_cta_url: mutation.ctaUrl,
    p_expires_at: mutation.expiresAt,
  });
  if (error) throw new Error(error.message);

  return notifyTargetedAnnouncementPush(announcementId);
}

async function notifyTargetedAnnouncementPush(announcementId) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) {
    return { announcement_id: announcementId, push: null, warning: 'The notice was saved, but push delivery needs a fresh admin sign-in.' };
  }
  try {
    const response = await fetch('/api/admin-publish-announcement', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'notify_targeted_announcement', announcement_id: announcementId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { announcement_id: announcementId, push: null, warning: body.error || 'The notice was saved, but push delivery could not be completed.' };
    }
    return body;
  } catch {
    return { announcement_id: announcementId, push: null, warning: 'The notice was saved, but push delivery could not be completed.' };
  }
}

export async function adminListMemberFollowUps(limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(String(limit), 10) || 20));
  const { data, error } = await supabase.rpc('admin_member_follow_up_queue', { p_limit: safeLimit });
  if (!error) return { rows: data || [], available: true };
  const functionUnavailable = ['42883', 'PGRST202'].includes(error.code)
    || /admin_member_follow_up_queue.*(?:not found|schema cache|does not exist)/i.test(error.message || '');
  if (functionUnavailable) return { rows: [], available: false };
  throw new Error(error.message);
}

function memberActivationUnavailable(error, functionName) {
  return ['42883', 'PGRST202'].includes(error?.code)
    || new RegExp(`${functionName}.*(?:not found|schema cache|does not exist)`, 'i').test(error?.message || '');
}

export async function adminMemberActivationOverview(cohortDays = 30) {
  const safeDays = Math.max(1, Math.min(3650, Number.parseInt(String(cohortDays), 10) || 30));
  const { data, error } = await supabase.rpc('admin_member_activation_overview', {
    p_cohort_days: safeDays,
  });
  if (!error) {
    const row = data?.[0];
    const countFields = [
      'accounts_created', 'readiness_complete', 'training_access',
      'first_booking', 'first_attended', 'returned',
    ];
    const counts = countFields.map(field => Number(row?.[field]));
    const countsAreValid = counts.every((count, index) => row?.[countFields[index]] !== null
      && row?.[countFields[index]] !== undefined
      && Number.isSafeInteger(count)
      && count >= 0
      && (index === 0 || count <= counts[index - 1]));
    if (!row || !row.as_of || Number(row.cohort_days) !== safeDays || !countsAreValid) {
      throw new Error('Member activation returned an incomplete cohort summary.');
    }
    return {
      available: true,
      as_of: row.as_of,
      cohort_days: Number(row.cohort_days),
      accounts_created: Number(row.accounts_created),
      readiness_complete: Number(row.readiness_complete),
      training_access: Number(row.training_access),
      first_booking: Number(row.first_booking),
      first_attended: Number(row.first_attended),
      returned: Number(row.returned),
    };
  }
  if (memberActivationUnavailable(error, 'admin_member_activation_overview')) {
    return {
      available: false,
      as_of: null,
      cohort_days: safeDays,
      accounts_created: null,
      readiness_complete: null,
      training_access: null,
      first_booking: null,
      first_attended: null,
      returned: null,
    };
  }
  throw new Error(error.message);
}

export async function adminListMemberActivationQueue(limit = 12) {
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(String(limit), 10) || 12));
  const { data, error } = await supabase.rpc('admin_member_activation_queue', { p_limit: safeLimit });
  if (!error) {
    const rows = data || [];
    const allowedReasons = new Set([
      'setup_incomplete', 'readiness_incomplete', 'no_training_access', 'no_first_booking', 'no_first_attendance',
    ]);
    if (rows.some(row => !row.id
      || row.role !== 'member'
      || !row.joined_at
      || !allowedReasons.has(row.reason)
      || typeof row.has_training_access !== 'boolean'
      || !['credits_remaining', 'bookings_count', 'total_spent_cents']
        .every(field => Number.isSafeInteger(Number(row[field])) && Number(row[field]) >= 0))) {
      throw new Error('Member activation returned an incomplete action queue.');
    }
    return { rows, available: true };
  }
  if (memberActivationUnavailable(error, 'admin_member_activation_queue')) {
    return { rows: [], available: false };
  }
  throw new Error(error.message);
}

async function getAuditProfiles(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const profiles = [];
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', uniqueIds.slice(index, index + 100));
    if (error) throw new Error(error.message);
    profiles.push(...(data || []));
  }
  return profiles;
}

export async function getAdminAuditRecords(days = '30') {
  const cutoffIso = adminAuditRangeStart(days);
  const loadTable = (table, columns) => collectAdminBatches(async (page, pageSize) => {
    const from = (page - 1) * pageSize;
    let query = supabase
      .from(table)
      .select(columns)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (cutoffIso) query = query.gte('created_at', cutoffIso);
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return data || [];
  });

  const sources = await Promise.allSettled([
    loadTable('admin_role_changes', 'id, target_user_id, changed_by, previous_role, new_role, created_at'),
    loadTable('admin_credit_grants', 'id, user_id, granted_by, sessions, validity_days, note, created_at'),
    loadTable('admin_request_status_changes', 'id, request_type, request_id, changed_by, previous_status, new_status, previous_admin_notes, new_admin_notes, subject_label, subject_email, created_at'),
    loadTable('member_announcement_admin_events', 'id, announcement_id, announcement_title, action, actor_id, previous_published_at, new_published_at, previous_archived_at, new_archived_at, created_at'),
    loadTable('admin_lead_changes', 'id, lead_type, lead_id, changed_by, previous_status, new_status, previous_admin_notes, new_admin_notes, subject_label, subject_email, created_at'),
    loadTable('admin_schedule_changes', 'id, resource_type, resource_id, action, changed_by, subject_label, previous_snapshot, new_snapshot, created_at'),
    loadTable('admin_content_changes', 'id, resource_type, resource_id, action, changed_by, subject_label, previous_snapshot, new_snapshot, created_at'),
    loadTable('session_booking_changes', 'id, booking_id, class_session_id, member_id, changed_by, actor_role, action, class_label, previous_snapshot, new_snapshot, created_at'),
  ]);
  const warnings = [];
  const sourceValue = (index, label) => {
    if (sources[index].status === 'fulfilled') return sources[index].value;
    warnings.push(`${label}: ${sources[index].reason?.message || 'unavailable'}`);
    return [];
  };
  const roleChanges = sourceValue(0, 'Role changes');
  const creditGrants = sourceValue(1, 'Credit grants');
  const requestChanges = sourceValue(2, 'Request changes');
  const announcementEvents = sourceValue(3, 'Announcement changes');
  const leadChanges = sourceValue(4, 'Lead changes');
  const scheduleChanges = sourceValue(5, 'Schedule changes');
  const contentChanges = sourceValue(6, 'Content changes');
  const bookingChanges = sourceValue(7, 'Booking changes');
  if (sources.every(result => result.status === 'rejected')) {
    throw new Error(warnings.join(' | '));
  }

  const ids = [
    ...roleChanges.flatMap(row => [row.target_user_id, row.changed_by]),
    ...creditGrants.flatMap(row => [row.user_id, row.granted_by]),
    ...requestChanges.map(row => row.changed_by),
    ...announcementEvents.map(row => row.actor_id),
    ...leadChanges.map(row => row.changed_by),
    ...scheduleChanges.map(row => row.changed_by),
    ...contentChanges.map(row => row.changed_by),
    ...bookingChanges.flatMap(row => [row.member_id, row.changed_by]),
  ];
  let profiles = [];
  try {
    profiles = await getAuditProfiles(ids);
  } catch (error) {
    warnings.push(`User identities: ${error.message || 'unavailable'}`);
  }
  return { roleChanges, creditGrants, requestChanges, announcementEvents, leadChanges, scheduleChanges, contentChanges, bookingChanges, profiles, warnings };
}

// ─── Class rosters (credit-based bookings) ───────────────────────────────────

/**
 * Find one person across the whole timetable, without opening classes one at a
 * time. There are two ways into a class — a public sign-up and a member
 * booking — and this searches both, so the answer is never half the story.
 *
 * The database does the matching and the bounds; this only refuses to ask on a
 * query too short to be worth asking about.
 */
export async function searchClassAttendees(query, { from = null, to = null, limit = 100 } = {}) {
  const term = String(query || '').trim();
  if (term.length < 2) return [];
  const { data, error } = await supabase.rpc('admin_search_class_attendees', {
    p_query: term,
    p_from: from ? new Date(from).toISOString() : null,
    p_to: to ? new Date(to).toISOString() : null,
    p_limit: limit,
  });
  if (error) {
    if (/admin_search_class_attendees|schema cache|function.*not found/i.test(error.message || '')) {
      throw new Error('Apply the attendee search migration before searching the timetable.');
    }
    throw new Error(error.message);
  }
  return data || [];
}

export async function adminSessionRoster(sessionId) {
  const { data, error } = await supabase.rpc('admin_session_roster', {
    p_session_id: sessionId
  });
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * How full every current class actually is, counting both doors into the room:
 * member credit bookings and confirmed public sign-ups. Without this the
 * Command Centre counted class_bookings only, so a class filled by members read
 * as empty and a class filled from the timetable read as empty to every member
 * path — and staff had no way to see whether confirming a request would
 * oversell. Returns an empty map on a database that has not taken the
 * migration yet, so the calendar still renders.
 */
export async function adminClassCapacity() {
  const { data, error } = await supabase.rpc('admin_class_capacity');
  if (error) {
    const functionUnavailable = ['42883', 'PGRST202'].includes(error.code)
      || /admin_class_capacity.*(?:not found|schema cache|does not exist)/i.test(error.message || '');
    if (functionUnavailable) return { byId: {}, available: false };
    throw new Error(error.message);
  }
  const byId = {};
  for (const row of data || []) {
    if (!row?.class_session_id) continue;
    byId[row.class_session_id] = {
      taken: Number(row.taken) || 0,
      waiting: Number(row.waiting) || 0,
      pending: Number(row.pending) || 0,
      capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
      spotsLeft: row.spots_left === null || row.spots_left === undefined ? null : Number(row.spots_left),
      bookingMode: row.booking_mode || 'request_to_book',
    };
  }
  return { byId, available: true };
}

export async function adminWaitlistOverview(limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(String(limit), 10) || 20));
  const { data, error } = await supabase.rpc('admin_waitlist_overview', { p_limit: safeLimit });
  if (!error) return { rows: data || [], available: true };
  const functionUnavailable = ['42883', 'PGRST202'].includes(error.code)
    || /admin_waitlist_overview.*(?:not found|schema cache|does not exist)/i.test(error.message || '');
  if (functionUnavailable) return { rows: [], available: false };
  throw new Error(error.message);
}

export async function getAdminDailyOperations() {
  const { data, error } = await supabase.rpc('admin_daily_operations');
  if (!error) return { rows: data || [], available: true };
  const functionUnavailable = ['42883', 'PGRST202'].includes(error.code)
    || /admin_daily_operations.*(?:not found|schema cache|does not exist)/i.test(error.message || '');
  if (functionUnavailable) return { rows: [], available: false };
  throw new Error(error.message);
}

export async function adminSetBookingStatus(bookingId, status, requestId) {
  requestId = requestId || newDecisionRequestID();
  const mutation = normalizeBookingStatusMutation(bookingId, status);
  if (!requestId) throw new Error('A secure booking decision request ID could not be created. Refresh and try again.');
  const { data, error } = await supabase.rpc('admin_set_booking_status_with_notice', {
    p_booking_id: mutation.id,
    p_status: mutation.status,
    p_request_id: requestId,
  });
  if (!error) {
    const decision = Array.isArray(data) ? data[0] : data;
    if (!decision || decision.booking_id !== mutation.id || decision.new_status !== mutation.status) {
      throw new Error('The booking decision completed without a verifiable receipt. Refresh before continuing.');
    }
    if (!decision.announcement_id) return { ...decision, push: null, warning: null };
    const delivery = await notifyTargetedAnnouncementPush(decision.announcement_id);
    return { ...decision, push: delivery.push, warning: delivery.warning || null };
  }

  const message = error.message || '';
  if (error.code === 'PGRST202' || /admin_set_booking_status_with_notice.*(?:not found|schema cache|does not exist)/i.test(message)) {
    throw new Error('Apply the booking decision notifications migration before changing member bookings.');
  }
  if (/BOOKING_DECISION_REQUEST_CONFLICT/i.test(message)) {
    throw new Error('This booking decision request was already used for another change. Refresh and try again.');
  }
  if (/WAITLIST_ORDER_REQUIRED|WAITLIST_PRIORITY/i.test(message)) {
      throw new Error('Promote the next waitlisted member before reopening another booking.');
  }
  if (/BOOKING_TIME_CONFLICT/i.test(message)) {
    throw new Error('This member already has another active class at the same time. Resolve that booking before confirming this place.');
  }
  throw new Error(message);
}

export async function adminPromoteNextWaitlisted(sessionId, expectedBookingId, requestId) {
  requestId = requestId || newDecisionRequestID();
  const mutation = normalizeSessionPromotion(sessionId, expectedBookingId, requestId);
  const { data, error } = await supabase.rpc('admin_promote_next_waitlisted_with_notice', {
    p_session_id: mutation.sessionId,
    p_expected_booking_id: mutation.expectedBookingId,
    p_request_id: mutation.requestId,
  });
  if (!error) {
    const promotion = Array.isArray(data) ? data[0] : data;
    if (!promotion?.announcement_id || promotion.booking_id !== mutation.expectedBookingId) {
      throw new Error('The promotion completed without a verifiable member notice receipt. Refresh the waitlist before continuing.');
    }
    const delivery = await notifyTargetedAnnouncementPush(promotion.announcement_id);
    return { ...promotion, push: delivery.push, warning: delivery.warning || null };
  }
  const message = error.message || '';
  if (error.code === 'PGRST202' || /admin_promote_next_waitlisted_with_notice.*(?:not found|schema cache|does not exist)/i.test(message)) {
    throw new Error('Apply the waitlist promotion notifications migration before promoting members.');
  }
  if (/WAITLIST_EMPTY/i.test(message)) throw new Error('No members are waiting for this class.');
  if (/WAITLIST_CHANGED|WAITLIST_PROMOTION_REQUEST_CONFLICT/i.test(message)) {
    throw new Error('The queue changed before confirmation. Refresh and review the next member.');
  }
  if (/WAITLIST_MEMBER_NO_CREDITS|NO_CREDITS/i.test(message)) {
    throw new Error('The next member could not be confirmed. Refresh the roster and try again.');
  }
  if (/SESSION_FULL/i.test(message)) throw new Error('This class is still full. Refresh the roster before promoting anyone.');
  if (/BOOKING_TIME_CONFLICT/i.test(message)) {
    throw new Error('The next member already has another active class at the same time. Contact them before changing the queue.');
  }
  throw new Error(message);
}

export async function adminRecordSessionAttendance(sessionId, attendance) {
  const mutation = normalizeSessionAttendanceMutation(sessionId, attendance);
  const { data, error } = await supabase.rpc('admin_record_session_attendance', {
    p_session_id: mutation.sessionId,
    p_attended_ids: mutation.attendedIds,
    p_no_show_ids: mutation.noShowIds,
  });
  if (error) throw new Error(error.message);
  return Number(data || 0);
}

// ─── Orders (admin) ──────────────────────────────────────────────────────────

export async function getAllOrders() {
  const pageSize = 500;
  return collectAdminPages(async page => {
    const from = (page - 1) * pageSize;
    const { data, count, error } = await supabase
      .from('orders')
      .select('*, products(name), stripe_refunds(refund_id, amount_cents, credits_revoked, credits_consumed, bookings_cancelled, refunded_at)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return { rows: data || [], total: count || 0 };
  });
}

export async function getRecentOrders(limit = 6) {
  const safeLimit = Math.max(1, Math.min(20, Number.parseInt(String(limit), 10) || 6));
  const { data, error } = await supabase.from('orders').select('*, products(name)').order('created_at', { ascending: false }).limit(safeLimit);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function refundOrder(orderId, reason, confirmation) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) throw new Error('Your admin session has expired. Sign in again.');
  const response = await fetch('/api/admin-refund-order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ order_id: orderId, reason, confirmation }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Refund could not be completed.'));
  return body;
}

export async function reconcileOrder(orderId) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) throw new Error('Your admin session has expired. Sign in again.');
  const response = await fetch('/api/admin-reconcile-order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ order_id: orderId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Payment could not be reconciled.'));
  return body;
}

// ─── Products (admin) ────────────────────────────────────────────────────────

export async function getAllProducts() {
  const { data, error } = await supabase.from('products').select('*').order('sort_order', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createProduct(product) {
  const { slug, ...draft } = product;
  const created = await supabase.rpc('admin_create_product', {
    p_slug: slug,
    p_product: draft,
  });
  if (!created.error) return Array.isArray(created.data) ? created.data[0] : created.data;
  if (/products_slug_key|duplicate key/i.test(created.error.message || '')) {
    throw new Error('That permanent pack ID is already in use. Choose another one.');
  }
  const unavailable = ['42883', 'PGRST202'].includes(created.error.code)
    || /admin_create_product.*(?:not found|schema cache|does not exist)/i.test(created.error.message || '');
  if (unavailable) throw new Error('Install the commercial terms guard migration before creating session packs.');
  if (/INVALID_PRODUCT_PAYLOAD/i.test(created.error.message || '')) {
    throw new Error('Check the pack name, description, price, currency, sessions, validity and display order.');
  }
  throw new Error(created.error.message);
}

export async function updateProduct(id, updates, expectedUpdatedAt) {
  if (!expectedUpdatedAt) throw new Error('Session pack version is missing. Refresh the admin view and try again.');
  if (updates.active) {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) throw new Error('Your admin session has expired. Sign in again.');
    const response = await fetch('/api/admin-commerce-health', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        action: 'activate_product',
        product_id: id,
        product: updates,
        expected_updated_at: expectedUpdatedAt,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiErrorMessage(body, 'The pack could not be activated safely. It remains private.'));
    return body;
  }
  const guarded = await supabase.rpc('admin_update_product', {
    p_product_id: id,
    p_product: updates,
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (!guarded.error) return guarded.data;

  const guardUnavailable = ['42883', 'PGRST202'].includes(guarded.error.code)
    || /admin_update_product.*(?:not found|schema cache|does not exist)/i.test(guarded.error.message || '');
  if (!guardUnavailable) {
    if (/PRODUCT_STALE/i.test(guarded.error.message || '')) {
      throw new Error('Session pack update was not applied because this pack changed since you opened it. Refresh the admin view and review the latest version.');
    }
    if (/STRIPE_PRICE_REFRESH_REQUIRED/i.test(guarded.error.message || '')) {
      throw new Error('Replace or clear the Stripe Price ID before changing this pack\'s price, currency, sessions or validity.');
    }
    if (/ACTIVE_PRODUCT_REQUIRES_STRIPE_PRICE/i.test(guarded.error.message || '')) {
      throw new Error('Add a Stripe Price ID before making this pack active and purchasable.');
    }
    if (/PRODUCT_ACTIVATION_VERIFICATION_REQUIRED/i.test(guarded.error.message || '')) {
      throw new Error('Stripe must verify this Price before the pack can become active. Save again from the current Command Centre.');
    }
    if (/INVALID_PRODUCT_PAYLOAD/i.test(guarded.error.message || '')) {
      throw new Error('Check the pack name, description, price, currency, sessions, validity and display order.');
    }
    throw new Error(guarded.error.message);
  }
  throw new Error('Install the catalog optimistic-locking migration before editing session packs.');
}

export async function provisionProductPrice(id, expectedUpdatedAt, confirmation) {
  if (!expectedUpdatedAt) throw new Error('Session pack version is missing. Refresh pricing and try again.');
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) throw new Error('Your admin session has expired. Sign in again.');
  const response = await fetch('/api/admin-commerce-health', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      action: 'provision_product_price',
      confirmation,
      product_id: id,
      expected_updated_at: expectedUpdatedAt,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Stripe could not prepare this draft price.'));
  return body;
}

// ─── Business stats (admin overview) ─────────────────────────────────────────

export async function getBusinessStats() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  const pageSize = 500;
  const paidOrders = collectAdminPages(async page => {
    const from = (page - 1) * pageSize;
    const { data, count, error } = await supabase
      .from('orders')
      .select('id, amount_cents, paid_at, created_at', { count: 'exact' })
      .eq('status', 'paid')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return { rows: data || [], total: count || 0 };
  });
  const creditBatches = collectAdminPages(async page => {
    const from = (page - 1) * pageSize;
    const { data, count, error } = await supabase
      .from('credit_batches')
      .select('id, remaining, expires_at', { count: 'exact' })
      .gt('remaining', 0)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    return { rows: data || [], total: count || 0 };
  });
  const [paid, members, credits, upcoming] = await Promise.all([
    paidOrders,
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    creditBatches,
    supabase.from('class_sessions').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('start_time', nowIso)
  ]);
  assertSupabaseResponses([members, upcoming]);

  const monthPaid = paid.filter(o => new Date(o.paid_at || o.created_at) >= monthStart);
  const activeCredits = credits.filter(c => !c.expires_at || new Date(c.expires_at) > new Date()).reduce((s, c) => s + (c.remaining || 0), 0);

  return {
    totalRevenueCents: paid.reduce((s, o) => s + (o.amount_cents || 0), 0),
    monthRevenueCents: monthPaid.reduce((s, o) => s + (o.amount_cents || 0), 0),
    paidOrders: paid.length,
    memberCount: members.count || 0,
    activeCredits,
    upcomingClasses: upcoming.count || 0
  };
}

// ─── Sidebar badge counts (things needing attention) ─────────────────────────

export async function getAdminBadgeCounts() {
  const [newLeads, pendingLegacyBookings, pendingMemberBookings, pendingPT, formResponses, fitboxEvents] = await Promise.all([
    supabase.from('member_interest').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    supabase.from('class_bookings').select('id', { count: 'exact', head: true }).eq('status', 'requested'),
    supabase.from('session_bookings').select('id', { count: 'exact', head: true }).eq('status', 'requested'),
    supabase.from('private_session_requests').select('id', { count: 'exact', head: true }).eq('status', 'requested'),
    supabase.from('xert_form_responses').select('id', { count: 'exact', head: true }).eq('status', 'new').is('archived_at', null),
    supabase.from('fitbox_integration_events').select('id', { count: 'exact', head: true }).eq('processing_state', 'needs_review'),
  ]);
  assertSupabaseResponses([newLeads, pendingLegacyBookings, pendingMemberBookings, pendingPT]);
  if (formResponses.error && formResponses.error.code !== '42P01') {
    assertSupabaseResponses([formResponses]);
  }
  if (fitboxEvents.error && !['42P01', 'PGRST205'].includes(fitboxEvents.error.code)) {
    assertSupabaseResponses([fitboxEvents]);
  }
  return {
    members: newLeads.count || 0,
    bookings: (pendingLegacyBookings.count || 0) + (pendingMemberBookings.count || 0),
    'pt-requests': pendingPT.count || 0,
    forms: formResponses.error ? 0 : formResponses.count || 0,
    fitbox: fitboxEvents.error ? 0 : fitboxEvents.count || 0,
  };
}

// ─── Operations health (admin readiness checklist) ──────────────────────────

async function healthCheck(key, label, fn) {
  try {
    const result = await fn();
    return {
      key,
      label,
      status: result.status || 'ok',
      detail: result.detail || 'Ready',
      action: result.action || null,
      count: result.count ?? null,
      incidents: Array.isArray(result.incidents) ? result.incidents.slice(0, 10) : [],
      phase: result.phase || null,
      metadata: result.metadata || null,
      launchReady: result.launchReady === true,
    };
  } catch (error) {
    return {
      key,
      label,
      status: 'error',
      detail: error.message || 'Check failed',
      action: 'Check Supabase schema, RLS policies, and admin permissions.',
      count: null,
      incidents: []
    };
  }
}

export async function getCommerceConfigurationHealth() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-commerce-health', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Commerce health check failed.'));
  return body;
}

export async function resolveStripeOperatorReview(eventId, errorCode) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-commerce-health', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'resolve_stripe_review',
      confirmation: 'MARK HANDLED',
      event_id: eventId,
      error_code: errorCode,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Stripe incident resolution failed.'));
  return body;
}

export async function retryStripeWebhookEvent(eventId) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-commerce-health', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'retry_stripe_event',
      confirmation: 'RETRY EVENT',
      event_id: eventId,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Stripe event retry failed.'));
  return body;
}

async function getPushConfigurationHealth() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-push-health', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Notification health check failed.');
  return body;
}

async function getFitboxIntegrationHealth() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-fitbox-integration?health=1', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'FitBox integration health could not be loaded.'));
  return body;
}

export async function sendOwnerPushSmokeTest() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Admin session is unavailable.');
  const response = await fetch('/api/admin-publish-announcement', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'test_owner_push' }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(body, 'Owner push test failed.'));
  return body;
}

export async function getOperationsHealth() {
  const nowIso = new Date().toISOString();
  const platformSettings = getSoftLaunchSettings();

  return Promise.all([
    healthCheck('supabase', 'Supabase connection', async () => {
      const { error } = await supabase.from('admin_settings').select('id', { count: 'exact', head: true });
      if (error) throw error;
      return { detail: 'Admin settings table is reachable.' };
    }),

    healthCheck('admins', 'Admin access', async () => {
      const { count, error } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
      if (error) throw error;
      return count > 0
        ? {
            count,
            detail: `${count} admin account${count === 1 ? '' : 's'} configured.`
          }
        : {
            status: 'attention',
            count: 0,
            detail: 'No admin profile found.',
            action: 'Promote an owner account in Supabase profiles.role.'
          };
    }),

    healthCheck('platform-controls', 'Member launch switches', async () => {
      const settings = await platformSettings;
      const bookingsEnabled = settings.bookings_enabled === true;
      const paymentsEnabled = settings.payments_enabled === true;
      if (!bookingsEnabled && !paymentsEnabled) {
        return {
          phase: 'preflight',
          detail: 'Member bookings and session-pack checkout are safely paused for preflight.',
        };
      }
      if (bookingsEnabled && !paymentsEnabled) {
        return {
          phase: 'bookings-open',
          detail: 'Member bookings are open while session-pack checkout remains safely paused.',
          action: 'Complete the booking smoke test, then activate session-pack payments.',
        };
      }
      if (bookingsEnabled && paymentsEnabled) {
        return {
          phase: 'live',
          detail: 'Member bookings and session-pack checkout are enabled.',
        };
      }
      return {
        status: 'attention',
        detail: 'Session-pack checkout is enabled while member bookings are paused.',
        phase: 'unsafe',
        action: 'Pause payments or open bookings before allowing checkout.',
      };
    }),

    healthCheck('products', 'Session packs', async () => {
      const { data, error } = await supabase.from('products').select('slug, active, stripe_price_id').eq('active', true);
      if (error) throw error;
      const products = data || [];
      const missingStripePrices = products.filter(p => !p.stripe_price_id).length;
      if (products.length === 0) {
        return {
          status: 'attention',
          count: 0,
          detail: 'No active session packs.',
          action: 'Activate products in Session Packs.'
        };
      }
      return {
        status: missingStripePrices > 0 ? 'attention' : 'ok',
        count: products.length,
        detail: missingStripePrices > 0 ? `${products.length} active pack${products.length === 1 ? '' : 's'}; ${missingStripePrices} block live checkout until linked to a Stripe Price.` : `${products.length} active pack${products.length === 1 ? '' : 's'} with Stripe price IDs.`,
        action: missingStripePrices > 0 ? 'Add live Stripe Price IDs in Session Packs before production cutover.' : null
      };
    }),

    healthCheck('commerce-config', 'Stripe checkout', async () => {
      const result = await getCommerceConfigurationHealth();
      if (!result.ready) {
        const missing = result.environment?.missing || [];
        const issueReasons = [...new Set((result.issues || [])
          .map(issue => String(issue.reason || '').trim())
          .filter(Boolean))];
        const problems = [
          missing.length > 0 ? `Missing server settings: ${missing.join(', ')}.` : '',
          issueReasons.slice(0, 3).join(' '),
        ].filter(Boolean);
        return {
          status: 'attention',
          count: result.active_product_count,
          detail: problems.join(' ') || 'No active checkout products are configured.',
          incidents: result.webhook_delivery?.incidents || [],
          action: missing.length > 0
            ? 'Set the missing values in Vercel, redeploy, then refresh this check.'
            : 'Resolve each item in Stripe and Session Packs, redeploy if settings changed, then refresh this check.'
        };
      }
      const paymentState = String(result.payment_switch?.state || 'unknown').toUpperCase();
      const activationProof = result.activation_receipt?.required
        ? `immutable activation receipt verified${result.activation_receipt.activated_at
          ? ` at ${new Date(result.activation_receipt.activated_at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}`
          : ''}`
        : 'activation receipt required when enabled';
      return {
        count: result.active_product_count,
        detail: `${String(result.mode || 'unknown').toUpperCase()} mode: payments ${paymentState}; ${activationProof}. ${result.stripe_price_count} Stripe-linked pack${result.stripe_price_count === 1 ? '' : 's'}, webhook and payouts verified.`,
        incidents: result.webhook_delivery?.incidents || []
      };
    }),

    healthCheck('booking-provider', 'Booking provider', async () => (
      providerOperationsHealth(await platformSettings)
    )),

    healthCheck('fitbox-integration', 'FitBox prospect handoff', async () => {
      const result = await getFitboxIntegrationHealth();
      const completed = Number(result.jobs_24h?.completed || 0);
      const failed = Number(result.jobs_24h?.failed || 0);
      const active = Number(result.active || 0);
      const stale = Number(result.stale || 0);
      const events = Number(result.events_24h || 0);
      const reconciliation = Number(result.reconciliation || 0);
      const orphanedLinks = Number(result.link_integrity?.orphaned || 0);
      const profileRefreshes = Number(result.profile_refreshes_24h?.completed || 0);
      const profileRefreshResults = Number(result.launch_validation?.read_only_profile_completed || 0);
      if (!result.environment?.ready) {
        return {
          status: 'attention',
          detail: `FitBox Zapier handoff is not configured${result.environment?.missing?.length ? `: ${result.environment.missing.join(', ')}` : '.'}`,
          action: 'Add the Zapier MCP server URL (ZAPIER_MCP_URL) or the catch-hook settings in Vercel, redeploy, then refresh.',
        };
      }
      if (failed > 0 || stale > 0 || orphanedLinks > 0 || profileRefreshResults === 0) {
        return {
          status: 'attention',
          count: failed + stale + orphanedLinks + (profileRefreshResults === 0 ? 1 : 0),
          detail: `${completed} completed, ${failed} failed, ${stale} stale and ${orphanedLinks} link${orphanedLinks === 1 ? '' : 's'} without an XERT lead; ${profileRefreshes} read-only profile refresh${profileRefreshes === 1 ? '' : 'es'} in 24 hours and ${profileRefreshResults} recorded successful read-only profile result${profileRefreshResults === 1 ? '' : 's'}; ${events} FitBox event${events === 1 ? '' : 's'} received and ${reconciliation} awaiting review.`,
          action: orphanedLinks > 0
            ? 'Open FitBox Review, preserve the orphaned evidence and investigate the deleted XERT source before any provider action.'
            : profileRefreshResults === 0
              ? 'Complete one read-only FitBox profile refresh against an approved synthetic pair before treating the bridge as launch-validated.'
            : 'Open Member Leads, review the affected lead and retry only after correcting its details or provider issue.',
        };
      }
      return {
        count: reconciliation || completed,
        status: reconciliation > 0 ? 'attention' : 'ok',
        detail: `Zapier bridge is ready; ${completed} total job${completed === 1 ? '' : 's'} completed, including ${profileRefreshes} read-only profile refresh${profileRefreshes === 1 ? '' : 'es'}; ${active} in progress, ${events} FitBox event${events === 1 ? '' : 's'} received and ${reconciliation} awaiting review.`,
        action: reconciliation > 0 ? 'Review the FitBox reconciliation queue before treating provider changes as authoritative.' : null,
      };
    }),

    healthCheck('push-notifications', 'Member notifications', async () => {
      const result = await getPushConfigurationHealth();
      const productionDevices = Number(result.subscriptions?.production || 0);
      const sandboxDevices = Number(result.subscriptions?.sandbox || 0);
      const delivered = Number(result.deliveries_24h?.delivered || 0);
      const failed = Number(result.deliveries_24h?.failed || 0);
      const invalid = Number(result.deliveries_24h?.invalid_token || 0);
      const deliveryProblems = failed + invalid;
      const ownerSmokeTest = result.owner_smoke_test || null;
      const smokeTestAge = ownerSmokeTest?.attempted_at
        ? Date.now() - new Date(ownerSmokeTest.attempted_at).getTime()
        : Number.POSITIVE_INFINITY;
      const ownerSmokeReady = ownerSmokeTest?.status === 'delivered'
        && smokeTestAge >= -5 * 60 * 1000
        && smokeTestAge <= 24 * 60 * 60 * 1000;
      const metadata = {
        canTest: result.ready === true && productionDevices > 0,
        productionDevices,
        ownerSmokeTest,
        ownerSmokeReady,
      };
      if (!result.ready) {
        const missing = result.environment?.missing || [];
        return {
          status: 'attention',
          count: productionDevices,
          detail: `Production push delivery is not configured${missing.length ? `: ${missing.join(', ')}` : '.'}`,
          action: 'Set the missing APNs values in the production Vercel project, redeploy, then refresh this check.',
          metadata,
          launchReady: false,
        };
      }
      if (productionDevices === 0) {
        return {
          status: 'attention',
          count: 0,
          detail: `APNs is configured; ${sandboxDevices} sandbox device${sandboxDevices === 1 ? '' : 's'} and no production devices are registered.`,
          action: 'Install the TestFlight build and enable Member notice notifications in Account.',
          metadata,
          launchReady: false,
        };
      }
      if (!ownerSmokeReady) {
        return {
          status: 'attention',
          count: productionDevices,
          detail: `${productionDevices} production device${productionDevices === 1 ? '' : 's'} registered; a successful owner smoke test from the last 24 hours is required.`,
          action: 'Send the private owner push test, confirm the TestFlight device receives it, then refresh launch readiness.',
          metadata,
          launchReady: false,
        };
      }
      return {
        status: deliveryProblems > 0 ? 'attention' : 'ok',
        count: productionDevices,
        detail: `${productionDevices} production device${productionDevices === 1 ? '' : 's'} registered; owner smoke test delivered, ${delivered} accepted and ${deliveryProblems} failed in the last 24 hours.`,
        action: deliveryProblems > 0 ? 'Review recent delivery results in Member Notices and refresh after invalid devices are retired.' : null,
        metadata,
        launchReady: true,
      };
    }),

    healthCheck('classes', 'Bookable launch classes', async () => {
      const { data, error } = await supabase.from('class_sessions')
        .select('id, booking_mode, capacity')
        .eq('status', 'published')
        .eq('public_visible', true)
        .gte('start_time', nowIso);
      if (error) throw error;
      const sessions = data || [];
      const actionable = sessions.filter(session => (
        ['instant_book', 'request_to_book'].includes(session.booking_mode || 'instant_book')
        && Number.isInteger(session.capacity)
        && session.capacity > 0
      ));
      return actionable.length > 0
        ? {
            count: actionable.length,
            detail: `${actionable.length} upcoming member-bookable class${actionable.length === 1 ? '' : 'es'} available.`
          }
        : {
            status: 'attention',
            count: 0,
            detail: sessions.length > 0
              ? 'Upcoming public classes are interest-only or have invalid capacity.'
              : 'No upcoming public classes.',
            action: 'Publish at least one instant-book or request-to-book class with a valid capacity in Class Calendar.'
          };
    }),

    healthCheck('coaches', 'Published coaches', async () => {
      const { count, error } = await supabase.from('coaches').select('id', { count: 'exact', head: true }).eq('published', true);
      if (error) throw error;
      return count > 0
        ? {
            count,
            detail: `${count} published team profile${count === 1 ? '' : 's'}.`
          }
        : {
            status: 'attention',
            count: 0,
            detail: 'No published team profiles.',
            action: 'Add coaches, nutritionists, physios, or massage partners.'
          };
    }),

    healthCheck('events', 'Published events', async () => {
      const { count, error } = await supabase.from('events').select('id', { count: 'exact', head: true }).eq('published', true);
      if (error) throw error;
      return count > 0
        ? {
            count,
            detail: `${count} public event${count === 1 ? '' : 's'} in the calendar.`
          }
        : {
            status: 'attention',
            count: 0,
            detail: 'No published events.',
            action: 'Seed or add the 2026 SEQ event calendar.'
          };
    }),

    healthCheck('cms', 'Site CMS content', async () => {
      const { count, error } = await supabase.from('site_content').select('key', { count: 'exact', head: true });
      if (error) throw error;
      return count > 0
        ? {
            count,
            detail: `${count} editable content block${count === 1 ? '' : 's'} saved.`
          }
        : {
            status: 'attention',
            count: 0,
            detail: 'Using built-in content defaults.',
            action: 'Review and save content in Site Content.'
          };
    }),

    healthCheck('orders', 'Commerce activity', async () => {
      const { count, error } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'paid');
      if (error) throw error;
      return count > 0
        ? {
            count,
            detail: `${count} paid order${count === 1 ? '' : 's'} recorded.`
          }
        : {
            status: 'attention',
            count: 0,
            detail: 'No paid orders recorded yet.',
            action: 'Run a Stripe test purchase after deployment.'
          };
    }),

    healthCheck('credit-audit', 'Audited credit grants', async () => {
      const { count, error } = await supabase.from('admin_credit_grants').select('id', { count: 'exact', head: true });
      if (error) {
        return {
          status: 'attention',
          detail: 'Manual credit grant auditing is not installed.',
          action: 'Apply src/supabase/credit_grant_audit_upgrade.sql in Supabase.'
        };
      }
      return { count, detail: `${count || 0} audited manual credit grant${count === 1 ? '' : 's'} recorded.` };
    }),

    healthCheck('schema-contract', 'Database release contract', async () => {
      const { data, error } = await supabase.rpc('xert_public_capabilities');
      if (error) {
        return {
          status: 'attention',
          detail: 'Database capability reporting is not installed.',
          action: 'Apply the required upgrade SQL files listed in src/lib/schemaCapabilities.js.'
        };
      }
      const summary = summarizeSchemaCapabilities(data);
      return summary.ready
        ? {
            count: summary.installed.length,
            detail: 'Required booking, waitlist, attendance, PT tracking, and admin safety migrations are installed.'
          }
        : {
            status: 'attention',
            count: summary.installed.length,
            detail: `Missing database capabilities: ${summary.missing.join(', ')}.`,
            action: summary.actions.join(' ')
          };
    })
  ]);
}

// ─── Member detail (admin drawer) ────────────────────────────────────────────

export async function adminMemberDetail(userId) {
  const [credits, bookings, orders, grants, notes, notices] = await Promise.all([supabase.from('credit_batches').select('*').eq('user_id', userId).order('created_at', { ascending: false }), supabase.from('session_bookings').select('*, class_sessions(title, class_type, start_time)').eq('user_id', userId).order('created_at', { ascending: false }).limit(20), supabase.from('orders').select('*, products(name)').eq('user_id', userId).order('created_at', { ascending: false }), supabase.from('admin_credit_grants').select('*').eq('user_id', userId).order('created_at', { ascending: false }), adminListMemberNotes(userId, true), adminListMemberNotices(userId)]);
  for (const r of [credits, bookings, orders]) {
    if (r.error) throw new Error(r.error.message);
  }
  return {
    memberId: userId,
    credits: credits.data || [],
    bookings: bookings.data || [],
    orders: orders.data || [],
    grants: grants.error ? [] : grants.data || [],
    creditAuditAvailable: !grants.error,
    notes: notes.rows,
    memberNotesAvailable: notes.available,
    notices: notices.rows,
    memberNoticesAvailable: notices.available
  };
}

// ─── Site content (CMS) ──────────────────────────────────────────────────────

export async function getAllSiteContent() {
  const { data, error } = await supabase.from('site_content').select('*');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function saveSiteContent(key, contentData, expectedUpdatedAt) {
  const mutation = { data: contentData, updated_at: new Date().toISOString() };
  if (expectedUpdatedAt) {
    const result = await supabase
      .from('site_content')
      .update(mutation)
      .eq('key', key)
      .eq('updated_at', expectedUpdatedAt)
      .select('*');
    return assertAdminMutationVersion(result, 'Site content update')[0];
  }

  const { data, error } = await supabase
    .from('site_content')
    .insert({ key, ...mutation })
    .select('*')
    .single();
  if (error?.code === '23505') {
    throw new Error('Site content changed since you opened it. Refresh the admin view and review the latest version.');
  }
  if (error) throw new Error(error.message);
  return data;
}

// ─── Workout of the day ───────────────────────────────────────────────────────

/** Recent and upcoming workouts for the admin list (drafts included). */
export async function getAdminWorkouts(limit = 21) {
  const { data, error } = await supabase
    .from('workouts_of_the_day')
    .select('workout_date,title,body,published_at,updated_at')
    .order('workout_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

/** Single day's workout for editing, draft or published. */
export async function getAdminWorkout(workoutDate) {
  const { data, error } = await supabase
    .from('workouts_of_the_day')
    .select('workout_date,title,body,published_at,updated_at')
    .eq('workout_date', workoutDate)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Creates or replaces the workout for a day. workout_date is the primary key,
 * so the upsert structurally guarantees one workout per day — the operating
 * model the gym runs on.
 */
export async function saveWorkoutOfTheDay(input) {
  const { data: userData } = await supabase.auth.getUser();
  const actorId = userData?.user?.id || null;
  const row = {
    workout_date: input.workout_date,
    title: input.title,
    body: input.body,
    published_at: input.published ? new Date().toISOString() : null,
    last_changed_by: actorId,
  };
  const existing = await getAdminWorkout(input.workout_date);
  if (!existing) row.created_by = actorId;
  // Keep the original publish timestamp so re-editing a live workout does not
  // look like it was published again.
  if (existing?.published_at && input.published) row.published_at = existing.published_at;

  const { data, error } = await supabase
    .from('workouts_of_the_day')
    .upsert(row, { onConflict: 'workout_date' })
    .select('workout_date,title,body,published_at,updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Removes a day's workout entirely. */
export async function deleteWorkoutOfTheDay(workoutDate) {
  const { error } = await supabase
    .from('workouts_of_the_day')
    .delete()
    .eq('workout_date', workoutDate);
  if (error) throw new Error(error.message);
}
