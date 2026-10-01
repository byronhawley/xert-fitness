import http2 from 'node:http2';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { requestHeader, sendJson } from './serverHttp.js';
import { apnsHost, createAPNsProviderToken, inspectAPNsEnvironment, postAPNsAlert } from '../../api/apns.js';

// SERVER ONLY (Vercel function code; never imported by the browser bundle).
// Served by api/push-subscription.js as `{ action: 'staff_roster_push' }`, so
// the Hobby plan's twelve-function ceiling is kept.
//
// Phone push for staff roster notices. The durable notice is the in-app
// `staff_notifications` row; writing it also writes a 'pending' push work item
// per device (migration 20261002010000). This is the dispatcher that works
// that queue: it leases due items, sends them over APNs, and records each
// outcome with the lease that owns it. It runs from two places:
//   * the scheduler (Supabase pg_cron + pg_net, or a Vercel Cron), which
//     authenticates with its own server secret, never a person's token; this
//     is what makes pushing independent of anyone opening a roster screen;
//   * a signed-in manager or coach, fire-and-forget after a roster action,
//     which only makes the next push sooner.
// Delivery is at most once per lease and never claimed to be exactly once:
// see staffRosterOutcome for retry, permanent and uncertain outcomes.
//
// Lock-screen text is deliberately generic: no names, reasons, notes or
// class details ever leave the database in a push.

export const STAFF_ROSTER_PUSH_ACTION = 'staff_roster_push';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TABS = new Set(['roster', 'availability', 'requests']);
const MANAGER_TABS = new Set(['roster', 'availability', 'requests', 'coaches', 'settings', 'activity']);
const SEND_BATCH_SIZE = 25;
const CLAIM_LIMIT = 100;
const LEASE_SECONDS = 180;
// Stop starting new batches after this long, well inside the function limit
// and the lease, so a slow run never sends on a lease that has expired.
const RUN_BUDGET_MS = 40_000;
// Apple: refresh the provider token no more than once every 20 minutes, and
// never use one older than an hour. Tokens are issued for a fixed half-hour
// window, so frequent scheduler runs reuse the same `iat`.
const PROVIDER_TOKEN_WINDOW_MS = 30 * 60 * 1000;

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

/** 'manager' when the notice's stored link is a manager console link, else 'coach'. */
export function staffPushAudience(link) {
  return /^\/admin(\/|$|\?)/.test(String(link || '').trim()) ? 'manager' : 'coach';
}

function parseLink(link) {
  try { return new URL(String(link || ''), 'https://link.invalid'); } catch { return null; }
}

function singleMonth(values) {
  return Array.isArray(values) && values.length === 1 && MONTH.test(values[0]) ? values[0] : null;
}

/**
 * Where the notice opens.
 * Coach notices: the shared native link `/open/coaching/<tab>[?month=YYYY-MM]`.
 * Manager notices (stored link under /admin/): the web manager console,
 * `/admin/roster?rosterTab=<tab>[&rosterMonth=YYYY-MM]`, because My Coaching is
 * coach-only. Only an allowlisted tab and a well-formed month survive; record
 * ids and focus targets (rosterFocus) are dropped, so nothing sensitive is in
 * the URL. The console checks the manager role again when it opens.
 */
export function staffPushOpenPath(link) {
  const url = parseLink(link);
  const path = url?.pathname.replace(/\/+$/, '') || '';
  const params = url?.searchParams;
  if (staffPushAudience(link) === 'manager') {
    const tab = path === '/admin/roster' ? params.get('rosterTab') : null;
    const month = path === '/admin/roster' ? singleMonth(params.getAll('rosterMonth')) : null;
    const query = new URLSearchParams({ rosterTab: MANAGER_TABS.has(tab) ? tab : 'roster' });
    if (month) query.set('rosterMonth', month);
    return `/admin/roster?${query}`;
  }
  const tab = path === '/coaching' ? params.get('tab') : null;
  const month = path === '/coaching' ? singleMonth(params.getAll('month')) : null;
  return `/open/coaching/${TABS.has(tab) ? tab : 'roster'}${month ? `?month=${month}` : ''}`;
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
    audience: staffPushAudience(notification.link),
    open_path: staffPushOpenPath(notification.link),
  };
}

// ── Outcome policy (Apple: "Handling notification responses from APNs") ────

const TOKEN_INVALID_400 = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);
const RETRY_403 = new Set(['ExpiredProviderToken', 'InvalidProviderToken', 'MissingProviderToken', 'BadCertificate',
  'BadCertificateEnvironment', 'UnrelatedKeyIdInToken', 'BadEnvironmentKeyIdInToken']);
const MINUTE = 60;

/**
 * Maps one APNs attempt to what the queue should do with it:
 *   accepted       200. Accepted by Apple; not proof the phone showed it.
 *   invalid_token  410 Unregistered/ExpiredToken, 400 BadDeviceToken/
 *                  DeviceTokenNotForTopic: the device registration is switched off.
 *   failed         permanent for this payload (other 400s, 403 Forbidden, 404,
 *                  405, 413): not retried, the device is kept.
 *   retry          403 provider-token/certificate problems, 429, 5xx, 400
 *                  IdleTimeout, or a network error before the request left:
 *                  retried with backoff; the device is never switched off.
 *   uncertain      the request left but no answer came back: not resent, so
 *                  a phone sees it at most once from us.
 * `retry_after_seconds` is the minimum delay before the next attempt (Apple
 * asks for 15 minutes before retrying a 5xx, and at most one token refresh
 * per 20 minutes).
 */
export function staffRosterOutcome(result) {
  const reason = result?.reason || null;
  if (result?.transport === 'not_sent') return { outcome: 'retry', reason: `NOT_SENT:${result.errorCode || reason || 'NETWORK'}`.slice(0, 200), retry_after_seconds: MINUTE };
  if (result?.transport !== 'response') return { outcome: 'uncertain', reason: reason || 'APNS_NO_RESPONSE', retry_after_seconds: null };
  const status = Number(result.httpStatus);
  if (status === 200) return { outcome: 'accepted', reason: null, retry_after_seconds: null };
  if (status === 410) return { outcome: 'invalid_token', reason, retry_after_seconds: null };
  if (status === 400 && TOKEN_INVALID_400.has(reason)) return { outcome: 'invalid_token', reason, retry_after_seconds: null };
  if (status === 400 && reason === 'IdleTimeout') return { outcome: 'retry', reason, retry_after_seconds: MINUTE };
  if (status === 403 && RETRY_403.has(reason)) return { outcome: 'retry', reason, retry_after_seconds: 15 * MINUTE };
  if (status === 429) return { outcome: 'retry', reason, retry_after_seconds: reason === 'TooManyProviderTokenUpdates' ? 20 * MINUTE : MINUTE };
  if (status >= 500) return { outcome: 'retry', reason, retry_after_seconds: 15 * MINUTE };
  return { outcome: 'failed', reason, retry_after_seconds: null };
}

/**
 * Guard against a configuration problem disabling every device: when a whole
 * environment's answers in one run are "token not valid / not for topic" (at
 * least three, none accepted), the likelier cause is the wrong bundle id or
 * environment, so those are retried instead and no device is switched off.
 * 410 Unregistered is always device-specific and is not affected.
 */
export function guardSuspectConfig(outcomes) {
  const byEnvironment = new Map();
  for (const item of outcomes) {
    const tally = byEnvironment.get(item.environment) || { accepted: 0, tokenInvalid400: 0 };
    if (item.result.outcome === 'accepted') tally.accepted += 1;
    if (item.httpStatus === 400 && item.result.outcome === 'invalid_token') tally.tokenInvalid400 += 1;
    byEnvironment.set(item.environment, tally);
  }
  return outcomes.map(item => {
    const tally = byEnvironment.get(item.environment);
    if (item.httpStatus === 400 && item.result.outcome === 'invalid_token' && tally.accepted === 0 && tally.tokenInvalid400 >= 3) {
      return { ...item, result: { outcome: 'retry', reason: `SUSPECT_CONFIG:${item.result.reason}`, retry_after_seconds: 15 * MINUTE } };
    }
    return item;
  });
}

const ERROR_CODE = /\b([A-Z][A-Z0-9_]{3,})\b/;
const providerTokenTime = now => new Date(Math.floor(now.getTime() / PROVIDER_TOKEN_WINDOW_MS) * PROVIDER_TOKEN_WINDOW_MS);
const emptySummary = extra => ({ configured: true, enabled: true, claimed: 0, attempted: 0, accepted: 0, retrying: 0, failed: 0, invalid_token: 0, uncertain: 0, not_owned: 0, ...extra });

async function rpcWithOneRetry(admin, name, params) {
  const first = await admin.rpc(name, params);
  if (!first.error) return first;
  return admin.rpc(name, params);
}

/**
 * One dispatcher run: lease due work, send it, record each outcome with its
 * lease. Injectable for tests: `admin` is a service-role client (only `.rpc`
 * is used) and `connect` opens an APNs HTTP/2 session per environment.
 *   callerId  the signed-in user for a nudge after a roster action; null for
 *             the scheduler.
 * Without APNs configured, or with the roster off, nothing is leased: the
 * work stays pending.
 */
export async function dispatchStaffRosterPushes({
  admin,
  callerId = null,
  worker = callerId ? 'nudge' : 'scheduler',
  environment = process.env,
  connect = host => http2.connect(host),
  clock = () => new Date(),
  limit = CLAIM_LIMIT,
  leaseSeconds = LEASE_SECONDS,
  budgetMs = RUN_BUDGET_MS,
}) {
  const startedAt = clock();
  const apns = inspectAPNsEnvironment(environment);
  const runName = `${worker}-${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin.rpc('staff_roster_push_claim', {
    p_worker: runName, p_limit: apns.ready ? limit : 0, p_lease_seconds: leaseSeconds, p_caller: callerId,
  });
  if (error) {
    const code = String(error.message || '').match(ERROR_CODE)?.[1];
    if (code === 'ROSTER_DISABLED') return emptySummary({ configured: apns.ready, enabled: false });
    throw Object.assign(new Error(code || 'STAFF_PUSH_CLAIM_FAILED'), { cause: error });
  }
  if (!apns.ready) return emptySummary({ configured: false, missing: apns.missing });
  const claimed = Array.isArray(data) ? data : [];
  const summary = emptySummary({ claimed: claimed.length });
  if (claimed.length === 0) return summary;

  const providerToken = createAPNsProviderToken(apns, providerTokenTime(startedAt));
  const sentSoFar = [];
  for (const target of ['production', 'sandbox']) {
    const rows = claimed.filter(row => row.environment === target);
    if (rows.length === 0) continue;
    let client = null;
    try {
      for (let index = 0; index < rows.length; index += SEND_BATCH_SIZE) {
        // Rows not started before the budget runs out stay leased and unsent;
        // the next run finds the lease expired and makes them pending again.
        if (clock().getTime() - startedAt.getTime() > budgetMs) break;
        const batch = rows.slice(index, index + SEND_BATCH_SIZE);
        const begun = await admin.rpc('staff_roster_push_begin', {
          p_leases: batch.map(row => ({ delivery_id: row.delivery_id, lease_token: row.lease_token })),
        });
        if (begun.error) throw Object.assign(new Error('STAFF_PUSH_BEGIN_FAILED'), { cause: begun.error });
        const owned = new Set((Array.isArray(begun.data) ? begun.data : []).map(String));
        summary.not_owned += batch.length - owned.size;
        const sending = batch.filter(row => owned.has(String(row.delivery_id)));
        if (sending.length === 0) continue;
        if (!client) {
          client = connect(apnsHost(target));
          client.on?.('error', () => {});
        }
        const outcomes = await Promise.all(sending.map(async row => {
          let payload;
          try { payload = buildStaffRosterPush(row); } catch {
            return { row, environment: target, httpStatus: 0, result: { outcome: 'failed', reason: 'PAYLOAD_INVALID', retry_after_seconds: null } };
          }
          const sent = await postAPNsAlert(client, row.device_token, {
            // Same collapse id for every attempt of a notice, so a repeat
            // replaces the earlier alert on the phone instead of adding one.
            collapseId: `staff-notice-${String(row.notification_id).toLowerCase()}`,
            apnsId: row.delivery_id,
            expiresAt: row.expires_at,
            payload,
          }, apns, providerToken);
          return { row, environment: target, httpStatus: sent.httpStatus, result: staffRosterOutcome(sent) };
        }));
        sentSoFar.push(...outcomes);
        const guarded = guardSuspectConfig(sentSoFar).slice(sentSoFar.length - outcomes.length);
        const results = guarded.map(({ row, result }) => ({
          delivery_id: row.delivery_id, lease_token: row.lease_token, outcome: result.outcome, reason: result.reason,
          retry_after_seconds: result.retry_after_seconds,
        }));
        const recorded = await rpcWithOneRetry(admin, 'staff_roster_push_record', { p_results: results });
        // If recording fails twice the leases expire with the send started, and
        // the next run marks them 'uncertain' (never resent).
        if (recorded.error) throw Object.assign(new Error('STAFF_PUSH_RECORD_FAILED'), { cause: recorded.error });
        summary.attempted += results.length;
        for (const result of results) {
          if (result.outcome === 'retry') summary.retrying += 1;
          else summary[result.outcome] += 1;
        }
      }
    } finally {
      client?.close?.();
    }
  }
  return summary;
}

// ── HTTP route (served by api/push-subscription.js) ─────────────────────────

const digest = value => createHash('sha256').update(String(value)).digest();

/** The scheduler's own secret: STAFF_PUSH_DISPATCH_SECRET, else CRON_SECRET (what Vercel Cron sends). */
export function dispatchSecret(env = process.env) {
  const secret = String(env.STAFF_PUSH_DISPATCH_SECRET || env.CRON_SECRET || '').trim();
  return secret.length >= 32 ? secret : null;
}

export function isSchedulerToken(token, env = process.env) {
  const secret = dispatchSecret(env);
  if (!secret || !token) return false;
  return timingSafeEqual(digest(token), digest(secret));
}

export async function staffRosterPushHandler(request, response, { createAdmin = createClient, send = dispatchStaffRosterPushes, env = process.env } = {}) {
  const json = (body, status = 200) => sendJson(response, body, status);
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!['POST', 'GET'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);

  const authHeader = requestHeader(request, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return json({ error: 'Not authenticated.' }, 401);
  const scheduler = isSchedulerToken(token, env);
  // GET is only for a cron runner; people's sessions use POST.
  if (request.method === 'GET' && !scheduler) return json({ error: 'Not authenticated.' }, 401);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ configured: false, error: 'Roster push is not configured.' }, 503);

  try {
    const admin = createAdmin(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    if (scheduler) return json(await send({ admin, callerId: null, worker: 'scheduler', environment: env }));
    const { data: { user } = {}, error: userError } = await admin.auth.getUser(token);
    if (userError || !user?.id) return json({ error: 'Invalid or expired session.' }, 401);
    return json(await send({ admin, callerId: user.id, worker: 'nudge', environment: env }));
  } catch (error) {
    if (error.message === 'NOT_STAFF') return json({ error: 'Only managers and coaches can send roster notices.' }, 403);
    return json({ error: 'Roster push could not be completed. The notices are still in the app.' }, 500);
  }
}
