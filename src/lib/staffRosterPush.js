import http2 from 'node:http2';
import { createClient } from '@supabase/supabase-js';
import { requestHeader, sendJson } from './serverHttp.js';
import { apnsHost, createAPNsProviderToken, inspectAPNsEnvironment, sendAPNsAlert } from '../../api/apns.js';

// SERVER ONLY (Vercel function code; never imported by the browser bundle).
// Served by api/push-subscription.js as `{ action: 'staff_roster_push' }`, so
// the Hobby plan's twelve-function ceiling is kept.
//
// Phone push for coach roster notices. The durable notice is the in-app
// `staff_notifications` row the database already wrote; this only nudges the
// recipient's iPhone, at most once per notice and device. A signed-in manager
// or coach calls it (fire-and-forget) after a roster action; the service role
// then claims due notices, sends them, and records what APNs said.
//
// Lock-screen text is deliberately generic: no names, reasons, notes or
// class details ever leave the database in a push.

export const STAFF_ROSTER_PUSH_ACTION = 'staff_roster_push';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TABS = new Set(['roster', 'availability', 'requests']);
const SEND_BATCH_SIZE = 25;
const CLAIM_LIMIT = 200;
const PUSH_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const STAFF_PUSH_TITLE = 'XERT coaching';
const OPEN_THE_APP = 'Open the app to see it.';
const BODIES = {
  roster: `Your roster has an update. ${OPEN_THE_APP}`,
  class: `A class on your roster has changed. ${OPEN_THE_APP}`,
  availability: `Your availability needs a look. ${OPEN_THE_APP}`,
  request: `One of your requests has an update. ${OPEN_THE_APP}`,
  manager: `A roster request needs your attention. ${OPEN_THE_APP}`,
};
const KIND_BODIES = {
  roster_published: 'roster',
  cover_approved: 'roster',
  session_retimed: 'class',
  session_cancelled: 'class',
  availability_reminder: 'availability',
  availability_reopened: 'availability',
  absence_approved: 'request',
  absence_rejected: 'request',
  cover_rejected: 'request',
  absence_request: 'manager',
  urgent_absence: 'manager',
  cover_requested: 'manager',
  cover_offered: 'manager',
  availability_change_request: 'manager',
  overdue_summary: 'manager',
};

/** Generic lock-screen body for a notice kind. Unknown kinds get the roster text. */
export function staffPushBody(kind) {
  return BODIES[KIND_BODIES[kind] || 'roster'];
}

/**
 * The shared native link for a notice: `/open/coaching/<tab>[?month=YYYY-MM]`,
 * derived from the notice's stored in-app link (coach `/coaching?tab=…` or
 * manager `/admin/roster?rosterTab=…`). Anything else in the link — record
 * ids, focus targets — is dropped.
 */
export function staffPushOpenPath(link) {
  let url = null;
  try { url = new URL(String(link || ''), 'https://link.invalid'); } catch { url = null; }
  const path = url?.pathname.replace(/\/+$/, '') || '';
  const params = url?.searchParams;
  let tab = null;
  let month = null;
  if (path === '/coaching') {
    tab = params.get('tab');
    month = params.getAll('month');
  } else if (path === '/admin/roster') {
    tab = params.get('rosterTab');
    month = params.getAll('rosterMonth');
  }
  const safeTab = TABS.has(tab) ? tab : 'roster';
  const safeMonth = Array.isArray(month) && month.length === 1 && MONTH.test(month[0]) ? month[0] : null;
  return `/open/coaching/${safeTab}${safeMonth ? `?month=${safeMonth}` : ''}`;
}

/** The APNs payload contract shared with the native app. */
export function buildStaffRosterPush(notification) {
  const id = String(notification?.notification_id || notification?.id || '');
  if (!UUID.test(id)) throw new Error('STAFF_PUSH_INVALID');
  return {
    aps: {
      alert: { title: STAFF_PUSH_TITLE, body: staffPushBody(notification.kind) },
      sound: 'default',
      category: 'xert.staff-roster',
      'thread-id': 'xert-staff-roster',
    },
    staff_notification_id: id.toLowerCase(),
    open_path: staffPushOpenPath(notification.link),
  };
}

/** APNs says 'delivered' for HTTP 200; for staff notices that is recorded as accepted. */
export function recordedPushStatus(status) {
  return status === 'delivered' ? 'accepted' : status === 'invalid_token' ? 'invalid_token' : 'failed';
}

const ERROR_CODE = /\b([A-Z][A-Z0-9_]{3,})\b/;

/**
 * Claims, sends and records roster pushes. Injectable for tests: `admin` is a
 * service-role client (only `.rpc` is used) and `connect` opens an APNs
 * HTTP/2 session per environment.
 */
export async function sendStaffRosterPushes({
  admin,
  callerId,
  environment = process.env,
  connect = host => http2.connect(host),
  now = new Date(),
  limit = CLAIM_LIMIT,
}) {
  const apns = inspectAPNsEnvironment(environment);
  // Without APNs nothing is claimed (limit 0 only checks the caller), so the
  // notices can still be pushed once it is set up.
  const { data, error } = await admin.rpc('staff_roster_claim_push_deliveries', { p_caller: callerId, p_limit: apns.ready ? limit : 0 });
  if (error) {
    const code = String(error.message || '').match(ERROR_CODE)?.[1];
    if (code === 'ROSTER_DISABLED') return { configured: apns.ready, enabled: false, claimed: 0, attempted: 0, accepted: 0, failed: 0 };
    throw Object.assign(new Error(code || 'STAFF_PUSH_CLAIM_FAILED'), { cause: error });
  }
  if (!apns.ready) return { configured: false, missing: apns.missing, enabled: true, claimed: 0, attempted: 0, accepted: 0, failed: 0 };
  const claimed = Array.isArray(data) ? data : [];
  if (claimed.length === 0) return { configured: true, enabled: true, claimed: 0, attempted: 0, accepted: 0, failed: 0 };

  const providerToken = createAPNsProviderToken(apns, now);
  const expiresAt = new Date(now.getTime() + PUSH_LIFETIME_MS).toISOString();
  const results = [];
  for (const target of ['production', 'sandbox']) {
    const rows = claimed.filter(row => row.environment === target);
    if (rows.length === 0) continue;
    const client = connect(apnsHost(target));
    client.on?.('error', () => {});
    try {
      for (let index = 0; index < rows.length; index += SEND_BATCH_SIZE) {
        results.push(...await Promise.all(rows.slice(index, index + SEND_BATCH_SIZE).map(async row => {
          const sent = await sendAPNsAlert(client, { id: row.subscription_id, device_token: row.device_token }, {
            collapseId: `staff-notice-${row.notification_id}`,
            expiresAt,
            payload: () => buildStaffRosterPush(row),
          }, apns, providerToken);
          return { delivery_id: row.delivery_id, status: recordedPushStatus(sent.status), reason: sent.reason || null };
        })));
      }
    } finally {
      client.close?.();
    }
  }
  // Rows claimed for an environment we don't send to stay as they are ('sending').
  const recorded = await admin.rpc('staff_roster_record_push_results', { p_results: results });
  if (recorded.error) throw Object.assign(new Error('STAFF_PUSH_RECORD_FAILED'), { cause: recorded.error });
  const accepted = results.filter(result => result.status === 'accepted').length;
  return { configured: true, enabled: true, claimed: claimed.length, attempted: results.length, accepted, failed: results.length - accepted };
}

export async function staffRosterPushHandler(request, response, { createAdmin = createClient, send = sendStaffRosterPushes, env = process.env } = {}) {
  const json = (body, status = 200) => sendJson(response, body, status);
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = requestHeader(request, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return json({ error: 'Not authenticated.' }, 401);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ configured: false, error: 'Roster push is not configured.' }, 503);

  try {
    const admin = createAdmin(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: { user } = {}, error: userError } = await admin.auth.getUser(token);
    if (userError || !user?.id) return json({ error: 'Invalid or expired session.' }, 401);
    return json(await send({ admin, callerId: user.id, environment: env }));
  } catch (error) {
    if (error.message === 'NOT_STAFF') return json({ error: 'Only managers and coaches can send roster notices.' }, 403);
    return json({ error: 'Roster push could not be completed. The notices are still in the app.' }, 500);
  }
}
