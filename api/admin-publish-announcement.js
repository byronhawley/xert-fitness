import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { requestHeader, requestJson, sendJson } from '../src/lib/serverHttp.js';
import { sendMemberAnnouncementPushes } from './apns.js';
import { buildRosterSms } from '../src/lib/staffRoster/sms.js';

export const config = { maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TONES = new Set(['info', 'action', 'urgent']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value) {
  return String(value || '').trim();
}

export function normalizeAnnouncementPublish(body, now = new Date()) {
  const id = clean(body?.id) || null;
  const requestId = clean(body?.request_id) || null;
  const expectedUpdatedAt = clean(body?.expected_updated_at) || null;
  const input = body?.announcement || {};
  const title = clean(input.title);
  const announcementBody = clean(input.body);
  const tone = clean(input.tone || 'info');
  const ctaLabel = clean(input.cta_label) || null;
  const ctaUrl = clean(input.cta_url) || null;
  const expiresAt = clean(input.expires_at) || null;
  if (id && !UUID.test(id)) throw new Error('ANNOUNCEMENT_ID_INVALID');
  if (requestId && !UUID.test(requestId)) throw new Error('ANNOUNCEMENT_REQUEST_ID_INVALID');
  if (id && (!expectedUpdatedAt || !Number.isFinite(new Date(expectedUpdatedAt).getTime()))) {
    throw new Error('ANNOUNCEMENT_VERSION_INVALID');
  }
  if (!title || title.length > 120 || !announcementBody || announcementBody.length > 2000 || !TONES.has(tone)) {
    throw new Error('ANNOUNCEMENT_INVALID');
  }
  if ((ctaLabel && !ctaUrl) || (!ctaLabel && ctaUrl) || (ctaLabel && ctaLabel.length > 40)) {
    throw new Error('ANNOUNCEMENT_ACTION_INVALID');
  }
  if (ctaUrl && !(ctaUrl.startsWith('/') || /^https:\/\//i.test(ctaUrl))) throw new Error('ANNOUNCEMENT_ACTION_INVALID');
  if (expiresAt && (!Number.isFinite(new Date(expiresAt).getTime()) || new Date(expiresAt) <= now)) {
    throw new Error('ANNOUNCEMENT_EXPIRY_INVALID');
  }
  return {
    id,
    requestId,
    expectedUpdatedAt,
    announcement: {
      title,
      body: announcementBody,
      tone,
      cta_label: ctaLabel,
      cta_url: ctaUrl,
      expires_at: expiresAt,
    },
  };
}

export function summarizePreviousClassAlertPushes(rows = []) {
  const delivered = rows.filter(row => row.status === 'delivered').length;
  return {
    configured: true,
    already_attempted: rows.length > 0,
    attempted: rows.length,
    delivered,
    failed: rows.length - delivered,
  };
}

// ─── SMS campaigns (action: 'send_sms') ──────────────────────────────────────
// Twilio credentials are server-only environment variables. They are never
// committed and never VITE_-prefixed, which would bake them into the browser.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const SMS_MAX_MESSAGE_LENGTH = 1600;
const SMS_MAX_RECIPIENTS = 500;
const SMS_SEND_CONCURRENCY = 5;

export function e164AUMobile(value) {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  const bare = digits.startsWith('+') ? digits.slice(1) : digits;
  if (/^614\d{8}$/.test(bare)) return `+${bare}`;
  if (/^04\d{8}$/.test(bare)) return `+61${bare.slice(1)}`;
  return null;
}

/** Validates an SMS send request; throws SMS_* codes mapped to 400s below. */
export function normalizeSmsSendRequest(body) {
  const message = String(body?.message || '').trim();
  if (!message) throw new Error('SMS_MESSAGE_REQUIRED');
  if (message.length > SMS_MAX_MESSAGE_LENGTH) throw new Error('SMS_MESSAGE_TOO_LONG');

  const rawRecipients = Array.isArray(body?.recipients) ? body.recipients : [];
  if (rawRecipients.length === 0) throw new Error('SMS_RECIPIENTS_REQUIRED');
  if (rawRecipients.length > SMS_MAX_RECIPIENTS) throw new Error('SMS_TOO_MANY_RECIPIENTS');

  const seen = new Set();
  const recipients = [];
  for (const entry of rawRecipients) {
    const phone = e164AUMobile(entry?.phone);
    if (!phone) throw new Error('SMS_RECIPIENT_PHONE_INVALID');
    if (seen.has(phone)) continue; // silently collapse duplicates
    seen.add(phone);
    recipients.push({ phone, name: String(entry?.name || '').trim().slice(0, 120) || phone });
  }
  return { message, recipients };
}

/**
 * One Twilio send. Never throws: returns `{ ok, sid, status }` or
 * `{ ok: false, error, retryable }`. Rate limits (429), Twilio outages (5xx),
 * timeouts and network errors are temporary; everything else (a bad number,
 * a recipient who replied STOP) is permanent and must not be retried.
 */
export async function twilioSendSms({ to, body, credentials, fetcher = globalThis.fetch, timeoutMs = 10000 }) {
  const { accountSid, authToken, fromNumber } = credentials || {};
  const params = new URLSearchParams({ To: to, From: fromNumber, Body: body });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  try {
    const response = await fetcher(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = payload?.code ? `:${payload.code}` : '';
      const prefix = Number(payload?.code) === 21610 ? 'RECIPIENT_UNSUBSCRIBED ' : '';
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        error: `${prefix}TWILIO_${response.status}${code}: ${String(payload?.message || 'Twilio rejected the message.').slice(0, 200)}`,
        message: payload?.message || `Twilio rejected the message (${response.status}).`,
      };
    }
    return { ok: true, sid: payload?.sid || null, status: payload?.status || 'queued' };
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 200);
    // Only a request that provably never reached Twilio (no connection was
    // made) is safe to send again. A timeout or a dropped connection may
    // come after Twilio accepted the text, so it is not retried: a second
    // attempt could text the coach twice. Same rule as roster push
    // ('uncertain' is never resent).
    if (smsNeverLeft(error)) return { ok: false, retryable: true, error: `NETWORK: ${detail}`, message: error?.message || String(error) };
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { ok: false, retryable: false, error: `UNCONFIRMED ${timedOut ? 'TIMEOUT' : 'NETWORK'}: ${detail}`, message: error?.message || String(error) };
  }
}

// Connection errors that happen before any byte of the request is sent.
const SMS_NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

/** True when a fetch failure means the request never reached the provider. */
export function smsNeverLeft(error) {
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth += 1) {
    if (SMS_NOT_SENT_CODES.has(cause.code)) return true;
  }
  return false;
}

async function sendOneSms(recipient, message) {
  const result = await twilioSendSms({
    to: recipient.phone,
    body: message,
    credentials: { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, fromNumber: TWILIO_FROM_NUMBER },
  });
  if (!result.ok) return { phone: recipient.phone, name: recipient.name, ok: false, error: result.message };
  return { phone: recipient.phone, name: recipient.name, ok: true, sid: result.sid, status: result.status };
}

async function sendSmsCampaign(body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error('SMS_NOT_CONFIGURED');
  }
  const { message, recipients } = normalizeSmsSendRequest(body);
  const results = [];
  for (let index = 0; index < recipients.length; index += SMS_SEND_CONCURRENCY) {
    const batch = recipients.slice(index, index + SMS_SEND_CONCURRENCY);
    results.push(...await Promise.all(batch.map(recipient => sendOneSms(recipient, message))));
  }
  const sent = results.filter(result => result.ok).length;
  return { sent, failed: results.length - sent, total: results.length, results };
}


// ─── Roster texts (action: 'send_roster_sms') ────────────────────────────────
// The database queues one text per coach when a roster is published
// (supabase/migrations/20261002050000_staff_roster_sms.sql). This sends what
// is due: lease a batch (service role only), build each text with the shared
// wording (src/lib/staffRoster/sms.js), send through Twilio, record each
// outcome against its lease. Temporary failures go back to the queue and are
// tried again in this run after a short wait, at most 3 attempts in all.
const ROSTER_SMS_BATCH = 25;
const ROSTER_SMS_MAX_ROUNDS = 8;
const ROSTER_SMS_TIME_BUDGET_MS = 40000;

export function twilioCredentialsFromEnv(env = process.env) {
  const credentials = { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber: env.TWILIO_FROM_NUMBER };
  return credentials.accountSid && credentials.authToken && credentials.fromNumber ? credentials : null;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function recordRosterSms(admin, row, outcome) {
  const params = {
    p_id: row.id,
    p_lease_token: row.lease_token,
    p_ok: outcome.ok,
    p_provider_id: outcome.sid || null,
    p_error: outcome.ok ? null : outcome.error,
    p_retryable: !outcome.ok && Boolean(outcome.retryable),
    p_body: outcome.body || null,
  };
  // One retry: a send that is not recorded would be sent again once its lease expires.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await admin.rpc('staff_roster_sms_record', params);
    if (!error) return data || { recorded: false };
  }
  return { recorded: false, error: true };
}

async function sendOneRosterSms(admin, row, { credentials, fetcher, baseUrl, timeoutMs = 10000 }) {
  let body;
  try {
    body = buildRosterSms(row, { baseUrl });
  } catch {
    return recordRosterSms(admin, row, { ok: false, retryable: false, error: 'MESSAGE_INVALID' });
  }
  if (!row.phone || e164AUMobile(row.phone) !== row.phone) {
    return recordRosterSms(admin, row, { ok: false, retryable: false, error: 'MOBILE_INVALID', body });
  }
  const result = await twilioSendSms({ to: row.phone, body, credentials, fetcher, timeoutMs });
  return recordRosterSms(admin, row, { ...result, body });
}

// Twilio's own wait per text; the run's time budget below keeps every
// started send (and its record) inside the function's 60 s limit.
const ROSTER_SMS_SEND_TIMEOUT_MS = 10000;

/**
 * Sends the roster texts that are due. Returns counts for this run:
 * `sent`, `failed` (permanent, or out of attempts), `retrying` (still queued
 * for a later attempt), `unrecorded` (sent or failed but the result could not
 * be saved). Without Twilio credentials it claims nothing.
 */
export async function sendRosterSms(admin, {
  credentials = twilioCredentialsFromEnv(),
  fetcher = globalThis.fetch,
  baseUrl = process.env.APP_BASE_URL || '',
  worker = `api-${randomUUID().slice(0, 8)}`,
  sleep = wait,
  now = Date.now,
} = {}) {
  const totals = { configured: Boolean(credentials), attempted: 0, sent: 0, failed: 0, retrying: 0, unrecorded: 0 };
  if (!credentials) return totals;
  // Last outcome per text: a text retried and then sent counts once, as sent.
  const final = new Map();
  const started = now();
  let retryWait = 0;
  for (let round = 0; round < ROSTER_SMS_MAX_ROUNDS && now() - started < ROSTER_SMS_TIME_BUDGET_MS; round += 1) {
    if (retryWait) await sleep(retryWait);
    const { data, error } = await admin.rpc('staff_roster_sms_claim', { p_limit: ROSTER_SMS_BATCH, p_worker: worker });
    if (error) throw new Error('ROSTER_SMS_CLAIM_FAILED', { cause: error });
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) break;
    retryWait = 0;
    for (let index = 0; index < rows.length; index += SMS_SEND_CONCURRENCY) {
      const batch = rows.slice(index, index + SMS_SEND_CONCURRENCY);
      // Out of time: hand the rest back unsent instead of starting a send the
      // platform might cut off after Twilio accepted it (that text would be
      // unrecorded, then sent again when its lease ran out).
      if (now() - started >= ROSTER_SMS_TIME_BUDGET_MS) {
        for (const row of rows.slice(index)) {
          const outcome = await recordRosterSms(admin, row, { ok: false, retryable: true, error: 'NOT_SENT:OUT_OF_TIME' });
          final.set(row.id, outcome?.recorded ? outcome.status : 'unrecorded');
        }
        break;
      }
      const outcomes = await Promise.all(batch.map(row => sendOneRosterSms(admin, row, { credentials, fetcher, baseUrl, timeoutMs: ROSTER_SMS_SEND_TIMEOUT_MS })));
      outcomes.forEach((outcome, offset) => {
        totals.attempted += 1;
        const status = outcome?.recorded ? outcome.status : 'unrecorded';
        final.set(batch[offset].id, status);
        // The database waits 2 s × attempts before a retry is due.
        if (status === 'pending') retryWait = Math.max(retryWait, 2000 * Number(batch[offset].attempt || 1) + 500);
      });
    }
    if (!retryWait && rows.length < ROSTER_SMS_BATCH) break;
  }
  for (const status of final.values()) {
    if (status === 'sent') totals.sent += 1;
    else if (status === 'pending') totals.retrying += 1;
    else if (status === 'unrecorded') totals.unrecorded += 1;
    else totals.failed += 1;
  }
  return totals;
}

const SMS_ERROR_STATUS = {
  SMS_MESSAGE_REQUIRED: [400, 'Write the message to send.'],
  SMS_MESSAGE_TOO_LONG: [400, `SMS messages are limited to ${SMS_MAX_MESSAGE_LENGTH} characters.`],
  SMS_RECIPIENTS_REQUIRED: [400, 'Choose at least one recipient.'],
  SMS_TOO_MANY_RECIPIENTS: [400, `Send to at most ${SMS_MAX_RECIPIENTS} people per campaign.`],
  SMS_RECIPIENT_PHONE_INVALID: [400, 'Every recipient needs a valid Australian mobile number.'],
  SMS_NOT_CONFIGURED: [503, 'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER in Vercel, then redeploy.'],
};

async function findAnnouncementPublishReplay(admin, requestId, ownerId) {
  const result = await admin
    .from('member_announcements')
    .select('*')
    .eq('id', requestId)
    .eq('created_by', ownerId)
    .eq('audience', 'all')
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;

  const previous = await admin
    .from('push_notification_deliveries')
    .select('status')
    .eq('announcement_id', result.data.id);
  if (previous.error) throw previous.error;
  return {
    announcement: result.data,
    push: summarizePreviousClassAlertPushes(previous.data || []),
    replayed: true,
  };
}

export async function notifyClassCancellation(admin, sessionId) {
  if (!UUID.test(sessionId)) throw new Error('CLASS_NOTICE_SESSION_INVALID');
  const { data: announcement, error: announcementError } = await admin
    .from('member_announcements')
    .select('id,title,body,cta_url,expires_at')
    .eq('audience', 'targeted')
    .eq('source_kind', 'class_cancellation')
    .eq('source_id', sessionId)
    .maybeSingle();
  if (announcementError) throw announcementError;
  if (!announcement) throw new Error('CLASS_NOTICE_NOT_FOUND');

  const [{ data: targets, error: targetError }, { data: previous, error: previousError }] = await Promise.all([
    admin.from('member_announcement_targets').select('user_id').eq('announcement_id', announcement.id),
    admin.from('push_notification_deliveries').select('status').eq('announcement_id', announcement.id),
  ]);
  if (targetError) throw targetError;
  if (previousError) throw previousError;
  const userIds = [...new Set((targets || []).map(target => target.user_id).filter(Boolean))];
  if ((previous || []).length > 0) {
    return { announcement_id: announcement.id, recipients: userIds.length, push: summarizePreviousClassAlertPushes(previous) };
  }

  const push = await sendMemberAnnouncementPushes({
    admin,
    announcement,
    targetUserIds: userIds,
  });
  return { announcement_id: announcement.id, recipients: userIds.length, push };
}

export async function notifyTargetedAnnouncement(admin, announcementId) {
  if (!UUID.test(announcementId)) throw new Error('TARGETED_NOTICE_ID_INVALID');
  const { data: announcement, error: announcementError } = await admin
    .from('member_announcements')
    .select('id,title,body,cta_url,expires_at')
    .eq('id', announcementId)
    .eq('audience', 'targeted')
    .in('source_kind', ['member_direct', 'waitlist_promotion', 'booking_decision', 'staff_booking'])
    .maybeSingle();
  if (announcementError) throw announcementError;
  if (!announcement) throw new Error('TARGETED_NOTICE_NOT_FOUND');

  const [{ data: targets, error: targetError }, { data: previous, error: previousError }] = await Promise.all([
    admin.from('member_announcement_targets').select('user_id').eq('announcement_id', announcement.id),
    admin.from('push_notification_deliveries').select('status').eq('announcement_id', announcement.id),
  ]);
  if (targetError) throw targetError;
  if (previousError) throw previousError;
  const userIds = [...new Set((targets || []).map(target => target.user_id).filter(Boolean))];
  if (userIds.length !== 1) throw new Error('TARGETED_NOTICE_RECIPIENT_INVALID');
  if ((previous || []).length > 0) {
    return { announcement_id: announcement.id, recipients: 1, push: summarizePreviousClassAlertPushes(previous) };
  }
  const push = await sendMemberAnnouncementPushes({ admin, announcement, targetUserIds: userIds });
  return { announcement_id: announcement.id, recipients: 1, push };
}

export async function sendOwnerPushSmokeTest(
  admin,
  ownerId,
  {
    requestId = randomUUID(),
    now = new Date(),
    sendPushes = sendMemberAnnouncementPushes,
  } = {},
) {
  if (!UUID.test(ownerId) || !UUID.test(requestId)) throw new Error('PUSH_SMOKE_TEST_INVALID');
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const push = await sendPushes({
    admin,
    announcement: {
      id: requestId,
      title: 'XERT launch test',
      body: 'Production notifications are reaching this owner device.',
      push_kind: 'owner_launch_test',
      expires_at: expiresAt,
    },
    targetUserIds: [ownerId],
    targetEnvironments: ['production'],
    maximumSubscriptions: 5,
    deliveryAnnouncementId: null,
    deliveryReasonPrefix: 'OWNER_LAUNCH_TEST',
  });
  return {
    request_id: requestId,
    configured: push.configured === true,
    attempted: Number(push.attempted || 0),
    delivered: Number(push.delivered || 0),
    failed: Number(push.failed || 0),
  };
}

export default async function handler(request, response) {
  const json = (body, status = 200) => sendJson(response, body, status);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = requestHeader(request, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json({ error: 'Not authenticated.' }, 401);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'Announcement publishing is not configured.' }, 500);

  try {
    const body = await requestJson(request);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return json({ error: 'Invalid or expired session.' }, 401);
    const { data: profile, error: profileError } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profileError) return json({ error: 'Could not verify admin access.' }, 500);
    if (profile?.role !== 'admin') return json({ error: 'Admin access required.' }, 403);

    if (body?.action === 'test_owner_push') {
      try {
        return json(await sendOwnerPushSmokeTest(admin, user.id));
      } catch (error) {
        if (error.message === 'PUSH_SMOKE_TEST_INVALID') throw error;
        throw new Error('PUSH_SMOKE_TEST_FAILED', { cause: error });
      }
    }

    if (body?.action === 'send_sms') {
      return json(await sendSmsCampaign(body));
    }

    if (body?.action === 'send_roster_sms') {
      try {
        return json(await sendRosterSms(admin));
      } catch (error) {
        throw new Error('ROSTER_SMS_FAILED', { cause: error });
      }
    }

    if (body?.action === 'notify_class_cancellation') {
      try {
        return json(await notifyClassCancellation(admin, String(body?.session_id || '').trim()));
      } catch (error) {
        if (error.message?.startsWith('CLASS_NOTICE_')) throw error;
        throw new Error('CLASS_NOTICE_DELIVERY_FAILED', { cause: error });
      }
    }

    if (body?.action === 'notify_targeted_announcement') {
      try {
        return json(await notifyTargetedAnnouncement(admin, String(body?.announcement_id || '').trim()));
      } catch (error) {
        if (error.message?.startsWith('TARGETED_NOTICE_')) throw error;
        throw new Error('TARGETED_NOTICE_DELIVERY_FAILED', { cause: error });
      }
    }

    const publish = normalizeAnnouncementPublish(body);

    let existing = null;
    if (publish.id) {
      const result = await admin.from('member_announcements').select('id,published_at,archived_at,updated_at').eq('id', publish.id).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) return json({ error: 'Announcement not found.' }, 404);
      existing = result.data;
    } else if (publish.requestId) {
      const replay = await findAnnouncementPublishReplay(admin, publish.requestId, user.id);
      if (replay) return json(replay);
    }
    if (existing?.archived_at) return json({ error: 'Restore this announcement before publishing it.' }, 409);
    const publishedAt = existing?.published_at || new Date().toISOString();
    const mutation = { ...publish.announcement, published_at: publishedAt, last_changed_by: user.id };
    let result = publish.id
      ? await admin.from('member_announcements').update(mutation).eq('id', publish.id).eq('updated_at', publish.expectedUpdatedAt).select('*').maybeSingle()
      : await admin.from('member_announcements').insert({
          id: publish.requestId || randomUUID(),
          ...mutation,
          created_by: user.id,
        }).select('*').single();
    if (result.error?.code === '23505' && publish.requestId && !publish.id) {
      const replay = await findAnnouncementPublishReplay(admin, publish.requestId, user.id);
      if (replay) return json(replay);
    }
    if (result.error) throw result.error;
    if (publish.id && !result.data) {
      return json({ error: 'This announcement changed since you opened it. Refresh the admin view and review the latest version.' }, 409);
    }

    let push = { configured: true, attempted: 0, delivered: 0, failed: 0 };
    if (!existing?.published_at) {
      try {
        push = await sendMemberAnnouncementPushes({ admin, announcement: result.data });
      } catch {
        push = { configured: true, attempted: 0, delivered: 0, failed: 1 };
      }
    }
    return json({ announcement: result.data, push });
  } catch (error) {
    const smsError = SMS_ERROR_STATUS[error.message];
    if (smsError) return json({ error: smsError[1] }, smsError[0]);
    if (error.message === 'CLASS_NOTICE_SESSION_INVALID') return json({ error: 'A valid class session is required.' }, 400);
    if (error.message === 'CLASS_NOTICE_NOT_FOUND') return json({ error: 'No member-account cancellation notice was created for this class.' }, 404);
    if (error.message === 'TARGETED_NOTICE_ID_INVALID') return json({ error: 'A valid private notice is required.' }, 400);
    if (error.message === 'TARGETED_NOTICE_NOT_FOUND') return json({ error: 'Private member notice not found.' }, 404);
    if (error.message === 'TARGETED_NOTICE_RECIPIENT_INVALID') return json({ error: 'Private member notice recipient is invalid.' }, 409);
    if (error.message === 'PUSH_SMOKE_TEST_INVALID') return json({ error: 'Push test identity is invalid.' }, 400);
    if (error.message?.startsWith('ANNOUNCEMENT_')) return json({ error: 'Announcement details are invalid.' }, 400);
    if (error.message?.startsWith('CLASS_NOTICE_')) return json({ error: 'The cancellation notice was saved, but push delivery could not be completed.' }, 500);
    if (error.message?.startsWith('TARGETED_NOTICE_')) return json({ error: 'The private notice was saved, but push delivery could not be completed.' }, 500);
    if (error.message === 'ROSTER_SMS_FAILED') return json({ error: 'Roster texts could not be sent just now. They stay queued and go when the roster is next opened.' }, 500);
    if (error.message === 'PUSH_SMOKE_TEST_FAILED') return json({ error: 'The owner push test could not be completed.' }, 500);
    return json({ error: 'Announcement could not be published.' }, 500);
  }
}
