import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createRequestTrace, requestHeader, requestJson } from '../src/lib/serverHttp.js';
import {
  FITBOX_EVENT_TYPES,
  fitboxIntegrationEnvironment,
  fitboxEventEnvironment,
  fitboxGetUserDispatchPayload,
  fitboxGetUserEnvironment,
  fitboxProspectDispatchPayload,
  normalizeFitboxCallback,
  normalizeFitboxEvent,
  normalizeFitboxLeadID,
  prospectForFitbox,
  publicFitboxJob,
} from '../src/lib/fitboxIntegration.js';
import {
  FITBOX_MCP_ACTIONS,
  FITBOX_MCP_FEEDS,
  ZAPIER_ENUM_TOOL,
  ZAPIER_INSPECT_TOOL,
  gatewayCapabilities,
  ZAPIER_READ_TOOL,
  ZAPIER_WRITE_TOOL,
  extractToolPayload,
  fitboxActionArguments,
  fitboxMcpEnvironment,
  fitboxRegisterArguments,
  matchProfilesToFitboxUsers,
  mcpToolCallRequest,
  normalizeFitboxAttendance,
  normalizeFitboxClasses,
  normalizeFitboxFeed,
  normalizeFitboxPush,
  normalizeFitboxUser,
  parseMcpResponseText,
  summarizeFitboxMirror,
  toolResultRows,
} from '../src/lib/fitboxMcp.js';
import { handleXertosDispatch } from '../src/lib/xertosSync.js';
import { client0OperatorHealthSnapshot } from '../src/lib/xertosOperatorHealth.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_REQUEST_BYTES = 8_192;
const DISPATCH_TIMEOUT_MS = 12_000;
const EVENT_REQUEST_BYTES = 16_384;
const EVENT_PAGE_LIMIT = 50;
const MCP_TIMEOUT_MS = 45_000;
const FITBOX_SYNC_FEEDS = new Set([...Object.keys(FITBOX_MCP_FEEDS), 'classes']);
const MIRROR_MISSING_CODES = new Set(['42P01', 'PGRST205']);
const FITBOX_EVENT_STATES = new Set(['needs_review', 'reviewed', 'ignored']);
const FITBOX_EVENT_SELECT = 'id, event_type, fitbox_gym_id, fitbox_user_id, fitbox_booking_id, fitbox_session_id, fitbox_subscription_id, provider_event_id, delivery_id, provider_status, provider_occurred_at, provider_updated_at, processing_state, review_reason, reviewed_at, received_at';
const XERT_LEAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function callbackTokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeHashMatch(receivedHash, expectedHash) {
  const received = Buffer.from(String(receivedHash || ''), 'utf8');
  const expected = Buffer.from(String(expectedHash || ''), 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function callbackErrorCode(message, jobType = 'register_prospect') {
  const normalized = String(message || '').toUpperCase();
  if (jobType === 'get_user') {
    if (/NOT FOUND|NOTHING COULD BE FOUND|NO USER/.test(normalized)) return 'FITBOX_USER_NOT_FOUND';
    if (/INVALID|REQUIRED|MISSING/.test(normalized)) return 'FITBOX_PROFILE_REFRESH_INVALID';
    return 'FITBOX_PROFILE_REFRESH_REJECTED';
  }
  if (/DUPLICATE/.test(normalized)) return 'FITBOX_DUPLICATE_REVIEW';
  if (/INVALID|REQUIRED|MISSING/.test(normalized)) return 'FITBOX_PROSPECT_INVALID';
  return 'FITBOX_PROVIDER_REJECTED';
}

function requestService(request) {
  return request.query?.service ?? new URL(request.url || '', 'https://xert.invalid').searchParams.get('service');
}

function zapierDataEnvelope(body) {
  if (body?.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data;
  return body;
}

async function handleFitboxCallback(request, admin, trace) {
  const { json } = trace;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let callback;
  try {
    const body = await requestJson(request);
    if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > 16_384) throw new Error('REQUEST_TOO_LARGE');
    callback = normalizeFitboxCallback(zapierDataEnvelope(body));
  } catch {
    return json({ error: 'Invalid callback.' }, 400);
  }

  try {
    const { data: job, error: jobError } = await admin.from('fitbox_integration_jobs')
      .select('id, job_type, callback_token_hash, fitbox_gym_id, fitbox_user_id, status, expires_at')
      .eq('id', callback.jobId).maybeSingle();
    if (jobError) throw jobError;
    const receivedHash = callbackTokenHash(callback.callbackToken);
    if (!job || !safeHashMatch(receivedHash, job.callback_token_hash) || job.fitbox_gym_id !== callback.gymId) {
      return json({ error: 'Callback was not accepted.' }, 401);
    }
    if (new Date(job.expires_at).getTime() <= Date.now() && job.status !== 'completed') {
      await admin.rpc('fail_fitbox_prospect_job', {
        p_job_id: callback.jobId,
        p_callback_token_hash: receivedHash,
        p_error_code: 'FITBOX_CALLBACK_EXPIRED',
      });
      return json({ error: 'Callback expired.' }, 410);
    }
    if (callback.failed) {
      const { data, error } = await admin.rpc('fail_fitbox_prospect_job', {
        p_job_id: callback.jobId,
        p_callback_token_hash: receivedHash,
        p_error_code: callbackErrorCode(callback.message, job.job_type),
      });
      if (error) throw error;
      console.warn('FitBox Zapier job returned a provider failure.', { requestId: trace.requestId, jobId: callback.jobId, jobType: job.job_type, errorCode: data?.last_error_code });
      return json({ received: true, status: 'failed' });
    }
    if (job.job_type === 'get_user') {
      if (!callback.status || !callback.profile?.email) {
        await admin.rpc('fail_fitbox_prospect_job', {
          p_job_id: callback.jobId,
          p_callback_token_hash: receivedHash,
          p_error_code: 'FITBOX_PROFILE_REFRESH_INVALID',
        });
        return json({ error: 'FitBox returned an incomplete profile result.' }, 422);
      }
      const { data, error } = await admin.rpc('complete_fitbox_get_user_job', {
        p_job_id: callback.jobId,
        p_callback_token_hash: receivedHash,
        p_fitbox_gym_id: callback.gymId,
        p_fitbox_user_id: callback.userId,
        p_fitbox_status: callback.status,
        p_profile_first_name: callback.profile?.firstName || null,
        p_profile_last_name: callback.profile?.lastName || null,
        p_profile_email: callback.profile?.email || null,
        p_profile_phone: callback.profile?.phone || null,
      });
      if (error) {
        if (/FITBOX_LOOKUP_IDENTITY_MISMATCH/.test(error.message || '')) {
          await admin.rpc('fail_fitbox_prospect_job', {
            p_job_id: callback.jobId,
            p_callback_token_hash: receivedHash,
            p_error_code: 'FITBOX_LOOKUP_IDENTITY_MISMATCH',
          });
          return json({ error: 'FitBox profile identity requires operator review.' }, 409);
        }
        throw error;
      }
      console.info('FitBox read-only profile refresh completed.', { requestId: trace.requestId, jobId: callback.jobId });
      return json({ received: true, status: data?.status || 'completed' });
    }
    const { data, error } = await admin.rpc('complete_fitbox_prospect_job', {
      p_job_id: callback.jobId,
      p_callback_token_hash: receivedHash,
      p_fitbox_gym_id: callback.gymId,
      p_fitbox_user_id: callback.userId,
      p_fitbox_status: callback.status,
    });
    if (error) {
      if (/FITBOX_IDENTITY_CONFLICT/.test(error.message || '')) {
        await admin.rpc('fail_fitbox_prospect_job', {
          p_job_id: callback.jobId,
          p_callback_token_hash: receivedHash,
          p_error_code: 'FITBOX_IDENTITY_CONFLICT',
        });
        return json({ error: 'FitBox identity requires operator review.' }, 409);
      }
      throw error;
    }
    console.info('FitBox prospect handoff completed.', { requestId: trace.requestId, jobId: callback.jobId });
    return json({ received: true, status: data?.status || 'completed' });
  } catch (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return json({ error: 'FitBox callback storage is unavailable.' }, 503);
    if (/FITBOX_CALLBACK_(?:REJECTED|CONFLICT)|FITBOX_JOB_NOT_ACTIVE|FITBOX_JOB_TYPE_MISMATCH|FITBOX_GYM_MISMATCH/.test(error.message || '')) {
      return json({ error: 'Callback was not accepted.' }, 409);
    }
    return json({ error: 'Callback could not be processed.' }, 500);
  }
}

async function handleFitboxEvent(request, admin, trace) {
  const { json } = trace;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const config = fitboxEventEnvironment(process.env);
  if (!config.ready) return json({ error: 'FitBox event ingress is unavailable.' }, 503);
  const receivedSecret = requestHeader(request, 'x-xert-fitbox-secret');
  if (!safeHashMatch(callbackTokenHash(receivedSecret), callbackTokenHash(config.secret))) {
    return json({ error: 'Event was not accepted.' }, 401);
  }

  let event;
  let envelope;
  try {
    const body = await requestJson(request);
    if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > EVENT_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
    envelope = zapierDataEnvelope(body);
    event = normalizeFitboxEvent(envelope);
  } catch {
    return json({ error: 'Invalid FitBox event.' }, 400);
  }
  if (event.gymId !== config.gymId) return json({ error: 'Event was not accepted.' }, 401);

  try {
    const { data, error } = await admin.from('fitbox_integration_events').insert({
      event_type: event.eventType,
      fitbox_gym_id: event.gymId,
      fitbox_user_id: event.userId,
      fitbox_booking_id: event.bookingId,
      fitbox_session_id: event.sessionId,
      fitbox_subscription_id: event.subscriptionId,
      provider_event_id: event.providerEventId,
      delivery_id: event.deliveryId,
      provider_status: event.status,
      provider_occurred_at: event.providerOccurredAt,
      provider_updated_at: event.providerUpdatedAt,
      processing_state: 'needs_review',
      review_reason: event.providerEventId && (event.providerOccurredAt || event.providerUpdatedAt)
        ? 'PROVIDER_CONTRACT_UNVERIFIED'
        : 'MISSING_STABLE_EVENT_IDENTITY',
    }).select('id, processing_state, received_at').single();
    if (error?.code === '23505' && event.deliveryId) return json({ received: true, duplicate: true }, 200);
    if (error) throw error;
    // When the Zap also maps the bounded mirror fields, keep the mirror fresh.
    // This only ever touches the FitBox mirror, never an XERT record.
    let mirrored = false;
    const push = normalizeFitboxPush(event.eventType, envelope, config.gymId);
    if (push) {
      try {
        await storeFitboxFeed(admin, push.feed, [push.row]);
        mirrored = true;
      } catch (mirrorError) {
        if (!MIRROR_MISSING_CODES.has(mirrorError?.code)) console.warn('FitBox push could not update the mirror.', { requestId: trace.requestId, feed: push.feed });
      }
    }
    console.info('FitBox event stored for read-only reconciliation.', {
      requestId: trace.requestId,
      eventId: data.id,
      eventType: event.eventType,
      mirrored,
    });
    return json({ received: true, event_id: data.id, processing_state: data.processing_state, mirrored }, 202);
  } catch (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return json({ error: 'FitBox event storage is unavailable.' }, 503);
    return json({ error: 'FitBox event could not be stored.' }, 500);
  }
}

async function requireAdmin(request, admin) {
  const authHeader = requestHeader(request, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { error: 'Not authenticated.', status: 401 };
  const { data: { user }, error: userError } = await admin.auth.getUser(token);
  if (userError || !user) return { error: 'Invalid or expired session.', status: 401 };
  const { data: profile, error: profileError } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profileError) return { error: 'Could not verify admin access.', status: 500 };
  if (profile?.role !== 'admin') return { error: 'Admin access required.', status: 403 };
  return { user };
}

function requestLeadID(request) {
  const value = request.query?.lead_id ?? new URL(request.url, 'https://xert.invalid').searchParams.get('lead_id');
  return normalizeFitboxLeadID(value);
}

function requestQuery(request, key) {
  return request.query?.[key] ?? new URL(request.url, 'https://xert.invalid').searchParams.get(key);
}

/**
 * Read-only, session-authenticated Client-0 health. This branch deliberately
 * has no feature flag of its own: authentication and admin role are the gate,
 * and the returned snapshot never arms or invokes either calendar direction.
 */
export async function handleXertosHealth(request, response, admin, trace = createRequestTrace(response)) {
  const { json } = trace;
  const access = await requireAdmin(request, admin);
  if (access.error) return json({ error: access.error }, access.status);
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  return json({ ok: true, health: client0OperatorHealthSnapshot(process.env) }, 200);
}

function normalizeFitboxEventID(value) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('INVALID_FITBOX_EVENT_ID');
  }
  return id;
}

function fitboxEventState(value) {
  const state = String(value || 'needs_review').trim().toLowerCase();
  if (!FITBOX_EVENT_STATES.has(state)) throw new Error('INVALID_FITBOX_EVENT_STATE');
  return state;
}

function publicFitboxEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    event_type: event.event_type,
    fitbox_gym_id: event.fitbox_gym_id,
    fitbox_user_id: event.fitbox_user_id,
    fitbox_booking_id: event.fitbox_booking_id,
    fitbox_session_id: event.fitbox_session_id,
    fitbox_subscription_id: event.fitbox_subscription_id,
    provider_event_id: event.provider_event_id,
    delivery_id: event.delivery_id,
    provider_status: event.provider_status,
    provider_occurred_at: event.provider_occurred_at,
    provider_updated_at: event.provider_updated_at,
    processing_state: event.processing_state,
    review_reason: event.review_reason,
    reviewed_at: event.reviewed_at,
    received_at: event.received_at,
  };
}

async function fitboxReconciliationEvents(admin, state) {
  const [{ data, error }, linkIntegrity] = await Promise.all([
    admin.from('fitbox_integration_events')
    .select(FITBOX_EVENT_SELECT)
    .eq('processing_state', state)
    .order('received_at', { ascending: false })
    .limit(EVENT_PAGE_LIMIT),
    fitboxLinkIntegrity(admin),
  ]);
  if (error) throw error;
  return { events: (data || []).map(publicFitboxEvent), state, limit: EVENT_PAGE_LIMIT, link_integrity: linkIntegrity };
}

async function reviewFitboxEvent(admin, eventId, reviewerId) {
  const reviewedAt = new Date().toISOString();
  const { data, error } = await admin.from('fitbox_integration_events')
    .update({ processing_state: 'reviewed', reviewed_by: reviewerId, reviewed_at: reviewedAt })
    .eq('id', eventId)
    .eq('processing_state', 'needs_review')
    .select(FITBOX_EVENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  if (data) return { event: publicFitboxEvent(data), already_reviewed: false };

  const { data: existing, error: existingError } = await admin.from('fitbox_integration_events')
    .select(FITBOX_EVENT_SELECT).eq('id', eventId).maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw new Error('FITBOX_EVENT_NOT_FOUND');
  if (existing.processing_state !== 'reviewed') throw new Error('FITBOX_EVENT_NOT_REVIEWABLE');
  return { event: publicFitboxEvent(existing), already_reviewed: true };
}

async function leadIntegrationState(admin, leadId) {
  const { error: expiryError } = await admin.from('fitbox_integration_jobs').update({
    status: 'expired',
    last_error_code: 'FITBOX_PROFILE_REFRESH_EXPIRED',
    updated_at: new Date().toISOString(),
  }).eq('job_type', 'get_user')
    .eq('lead_type', 'member_interest')
    .eq('lead_id', leadId)
    .in('status', ['queued', 'dispatched', 'dispatch_unknown'])
    .lt('expires_at', new Date().toISOString());
  if (expiryError) throw expiryError;
  const [linkResult, jobsResult] = await Promise.all([
    admin.from('fitbox_member_links')
      .select('id, fitbox_gym_id, fitbox_user_id, fitbox_status, profile_first_name, profile_last_name, profile_email, profile_phone, profile_synced_at, linked_at, last_verified_at')
      .eq('lead_type', 'member_interest').eq('lead_id', leadId).maybeSingle(),
    admin.from('fitbox_integration_jobs')
      .select('id, job_type, status, fitbox_user_id, fitbox_status, last_error_code, dispatched_at, completed_at, created_at')
      .eq('lead_type', 'member_interest').eq('lead_id', leadId)
      .order('created_at', { ascending: false }).limit(5),
  ]);
  if (linkResult.error) throw linkResult.error;
  if (jobsResult.error) throw jobsResult.error;
  return {
    link: linkResult.data || null,
    current_job: publicFitboxJob(jobsResult.data?.[0]),
    recent_jobs: (jobsResult.data || []).map(publicFitboxJob),
  };
}

async function fitboxLinkIntegrity(admin) {
  const { data: links, error: linkError } = await admin.from('fitbox_member_links')
    .select('lead_id')
    .eq('lead_type', 'member_interest')
    .limit(200);
  if (linkError) throw linkError;
  const leadIds = [...new Set((links || []).map(link => link.lead_id).filter(Boolean))];
  if (!leadIds.length) return { checked: 0, orphaned: 0 };
  // Historical FitBox links were not guaranteed to use XERT UUIDs. Treat
  // those references as orphaned evidence rather than sending invalid IDs to
  // PostgreSQL and taking the owner review screen down.
  const validLeadIds = leadIds.filter(leadId => XERT_LEAD_ID_PATTERN.test(leadId));
  const invalidLeadIds = leadIds.filter(leadId => !XERT_LEAD_ID_PATTERN.test(leadId));
  if (!validLeadIds.length) return { checked: leadIds.length, orphaned: invalidLeadIds.length };
  const { data: leads, error: leadError } = await admin.from('member_interest').select('id').in('id', validLeadIds);
  if (leadError) throw leadError;
  const found = new Set((leads || []).map(lead => lead.id));
  return { checked: leadIds.length, orphaned: invalidLeadIds.length + validLeadIds.filter(id => !found.has(id)).length };
}

async function integrationHealth(admin) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
  const [completed, failed, profileRefreshes, profileRefreshFailures, profileRefreshReviews, allTimeProspectCompletions, allTimeProfileRefreshes, active, stale, latest, eventTypes, linkIntegrity] = await Promise.all([
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).eq('status', 'completed').gte('updated_at', since),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('updated_at', since),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).eq('job_type', 'get_user').eq('status', 'completed').gte('updated_at', since),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).eq('job_type', 'get_user').eq('status', 'failed').gte('updated_at', since),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).eq('job_type', 'get_user').eq('status', 'failed')
      .in('last_error_code', ['FITBOX_USER_NOT_FOUND', 'FITBOX_LOOKUP_IDENTITY_MISMATCH']),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).eq('job_type', 'register_prospect').eq('status', 'completed'),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).eq('job_type', 'get_user').eq('status', 'completed'),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'dispatched', 'dispatch_unknown']),
    admin.from('fitbox_integration_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'dispatched', 'dispatch_unknown']).lt('updated_at', staleBefore),
    admin.from('fitbox_integration_jobs').select('status, fitbox_user_id, last_error_code, updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    Promise.all(FITBOX_EVENT_TYPES.map(async eventType => {
      const [recent, reviews, latestEvent] = await Promise.all([
        admin.from('fitbox_integration_events').select('id', { count: 'exact', head: true })
          .eq('event_type', eventType).gte('received_at', since),
        admin.from('fitbox_integration_events').select('id', { count: 'exact', head: true })
          .eq('event_type', eventType).eq('processing_state', 'needs_review'),
        admin.from('fitbox_integration_events')
          .select('processing_state, review_reason, received_at')
          .eq('event_type', eventType).order('received_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      for (const result of [recent, reviews, latestEvent]) if (result.error) throw result.error;
      return {
        event_type: eventType,
        events_24h: Number(recent.count || 0),
        needs_review: Number(reviews.count || 0),
        last_received_at: latestEvent.data?.received_at || null,
        latest_processing_state: latestEvent.data?.processing_state || null,
        latest_review_reason: latestEvent.data?.review_reason || null,
      };
    })),
    fitboxLinkIntegrity(admin),
  ]);
  for (const result of [completed, failed, profileRefreshes, profileRefreshFailures, profileRefreshReviews, allTimeProspectCompletions, allTimeProfileRefreshes, active, stale, latest]) if (result.error) throw result.error;
  const events = eventTypes.reduce((sum, event) => sum + event.events_24h, 0);
  const reviews = eventTypes.reduce((sum, event) => sum + event.needs_review, 0);
  const lastEvent = eventTypes
    .filter(event => event.last_received_at)
    .sort((left, right) => Date.parse(right.last_received_at) - Date.parse(left.last_received_at))[0] || null;
  const environment = fitboxIntegrationEnvironment(process.env);
  const getUserEnvironment = fitboxGetUserEnvironment(process.env);
  const eventEnvironment = fitboxEventEnvironment(process.env);
  const gateway = fitboxMcpEnvironment(process.env);
  // Either outbound path is enough: the live gateway or the two catch-hook Zaps.
  const outboundReady = gateway.ready || (environment.ready && getUserEnvironment.ready);
  const outboundMissing = gateway.ready ? [] : [...new Set([...environment.missing, ...getUserEnvironment.missing])];
  const reconciliation = reviews + Number(profileRefreshReviews.count || 0);
  return {
    ready: outboundReady && eventEnvironment.ready && Number(failed.count || 0) === 0 && Number(stale.count || 0) === 0 && linkIntegrity.orphaned === 0,
    environment: {
      ready: outboundReady && eventEnvironment.ready,
      missing: [...new Set([...outboundMissing, ...eventEnvironment.missing])],
    },
    gateway: { ready: gateway.ready, missing: gateway.missing },
    jobs_24h: { completed: Number(completed.count || 0), failed: Number(failed.count || 0) },
    profile_refreshes_24h: { completed: Number(profileRefreshes.count || 0), failed: Number(profileRefreshFailures.count || 0) },
    launch_validation: {
      prospect_registration_completed: Number(allTimeProspectCompletions.count || 0),
      read_only_profile_completed: Number(allTimeProfileRefreshes.count || 0),
    },
    active: Number(active.count || 0),
    stale: Number(stale.count || 0),
    last_job: latest.data || null,
    events_24h: events,
    reconciliation,
    link_integrity: linkIntegrity,
    event_types: eventTypes,
    last_event: lastEvent ? {
      event_type: lastEvent.event_type,
      processing_state: lastEvent.latest_processing_state,
      review_reason: lastEvent.latest_review_reason,
      received_at: lastEvent.last_received_at,
    } : null,
  };
}

async function dispatchProspect(config, payload, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(config.hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'XERT-FitBox-Bridge/1.0' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('ZAPIER_DISPATCH_REJECTED');
  } finally {
    clearTimeout(timeout);
  }
}

async function startGetUserRefresh({ admin, access, leadId }) {
  const config = fitboxGetUserEnvironment(process.env);
  if (!config.ready) throw new Error('FITBOX_GET_USER_NOT_CONFIGURED');
  const existing = await leadIntegrationState(admin, leadId);
  if (!existing.link) throw new Error('FITBOX_LINK_REQUIRED');
  if (['queued', 'dispatched', 'dispatch_unknown'].includes(existing.current_job?.status)) {
    throw new Error('FITBOX_JOB_IN_PROGRESS');
  }

  const callbackToken = randomBytes(32).toString('base64url');
  const { data: job, error: jobError } = await admin.from('fitbox_integration_jobs').insert({
    job_type: 'get_user',
    lead_type: 'member_interest',
    lead_id: leadId,
    status: 'queued',
    callback_token_hash: callbackTokenHash(callbackToken),
    fitbox_gym_id: existing.link.fitbox_gym_id,
    fitbox_user_id: existing.link.fitbox_user_id,
    created_by: access.user.id,
  }).select('id, job_type, status, fitbox_user_id, fitbox_status, last_error_code, dispatched_at, completed_at, created_at').single();
  if (jobError) {
    if (jobError.code === '23505') throw new Error('FITBOX_JOB_IN_PROGRESS');
    throw jobError;
  }

  const payload = fitboxGetUserDispatchPayload({
    jobId: job.id,
    callbackToken,
    fitboxUserId: existing.link.fitbox_user_id,
    environment: process.env,
  });
  try {
    await dispatchProspect(config, payload);
  } catch {
    // Get User is read-only, so a dispatch failure is safe to retry and cannot
    // create a second member or mutate provider state.
    await admin.from('fitbox_integration_jobs').update({
      status: 'failed',
      last_error_code: 'ZAPIER_PROFILE_REFRESH_FAILED',
      attempt_count: 1,
      updated_at: new Date().toISOString(),
    }).eq('id', job.id).eq('status', 'queued');
    throw new Error('FITBOX_PROFILE_REFRESH_DISPATCH_FAILED');
  }

  const { data: dispatched, error: dispatchError } = await admin.from('fitbox_integration_jobs').update({
    status: 'dispatched',
    dispatched_at: new Date().toISOString(),
    attempt_count: 1,
    updated_at: new Date().toISOString(),
  }).eq('id', job.id).eq('status', 'queued')
    .select('id, job_type, status, fitbox_user_id, fitbox_status, last_error_code, dispatched_at, completed_at, created_at').maybeSingle();
  if (dispatchError) throw dispatchError;
  if (dispatched) return { job: publicFitboxJob(dispatched), link: existing.link };
  return leadIntegrationState(admin, leadId);
}


// ─── Zapier MCP gateway ──────────────────────────────────────────────────────
// Synchronous FitBox calls. The server URL and optional bearer token live only
// in Vercel; the browser and iOS app never see them. Nothing here logs a
// provider payload, member field or token.

let gatewayToolCache = { url: null, at: 0, names: [] };
const GATEWAY_TOOL_CACHE_MS = 5 * 60_000;

async function mcpPost(config, body, id, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'XERT-FitBox-Gateway/1.0',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403 || response.status === 404) throw new Error('MCP_UNAUTHORIZED');
    if (!response.ok) throw new Error(`MCP_HTTP_${response.status}`);
    return parseMcpResponseText(text, id);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('MCP_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callZapierMcp(config, { tool, arguments: toolArguments }, fetchImpl = fetch) {
  const id = randomUUID();
  const body = mcpToolCallRequest({ id, tool, arguments: toolArguments });
  return extractToolPayload(await mcpPost(config, body, id, fetchImpl));
}

/** Which tools the configured server exposes; cached briefly per function instance. */
async function gatewayTools(config, fetchImpl = fetch) {
  const now = Date.now();
  if (gatewayToolCache.url === config.url && now - gatewayToolCache.at < GATEWAY_TOOL_CACHE_MS) return gatewayToolCache.names;
  const id = randomUUID();
  const result = await mcpPost(config, { jsonrpc: '2.0', id, method: 'tools/list', params: {} }, id, fetchImpl);
  const names = (Array.isArray(result?.tools) ? result.tools : []).map(tool => String(tool?.name || '')).filter(Boolean);
  gatewayToolCache = { url: config.url, at: now, names };
  return names;
}

async function gatewayMode(config) {
  return gatewayCapabilities(await gatewayTools(config));
}

function numericGym(gymId) {
  return /^\d+$/.test(String(gymId)) ? Number(gymId) : gymId;
}

async function fitboxAction(config, { action, tool, kind, params = {}, feed = false }) {
  const args = fitboxActionArguments({ action, tool, params, gymId: config.gymId });
  const capabilities = await gatewayMode(config);
  if (capabilities.mode === 'dynamic') {
    return callZapierMcp(config, { tool: kind === 'write' ? ZAPIER_WRITE_TOOL : ZAPIER_READ_TOOL, arguments: args });
  }
  // Static servers expose one tool per enabled action; a trigger feed is only
  // there when Zapier let the owner enable it on that server.
  if (!capabilities.tools.includes(tool)) throw new Error(feed ? 'FITBOX_FEED_UNAVAILABLE' : 'FITBOX_GATEWAY_TOOL_UNAVAILABLE');
  return callZapierMcp(config, { tool, arguments: { ...args.params, gym_id: numericGym(config.gymId) } });
}

async function fitboxClassCatalogue(config) {
  const capabilities = await gatewayMode(config);
  if (capabilities.mode === 'dynamic') {
    const payload = await callZapierMcp(config, {
      tool: ZAPIER_INSPECT_TOOL,
      arguments: { tool_name: FITBOX_MCP_FEEDS.bookings.tool, enum_property: 'class_id', params: { gym_id: config.gymId } },
    });
    const apps = Array.isArray(payload) ? payload : [payload];
    const values = [];
    for (const app of apps) {
      for (const action of Array.isArray(app?.actions) ? app.actions : []) {
        for (const param of Array.isArray(action?.params) ? action.params : []) {
          if (param?.key === 'class_id' && Array.isArray(param.dynamic_enum_values)) values.push(...param.dynamic_enum_values);
        }
      }
    }
    return normalizeFitboxClasses(values);
  }
  // On a static server the class list hangs off the booking trigger tool.
  const names = await gatewayTools(config);
  if (!names.includes(ZAPIER_ENUM_TOOL) || !capabilities.tools.includes(FITBOX_MCP_FEEDS.bookings.tool)) throw new Error('FITBOX_FEED_UNAVAILABLE');
  const payload = await callZapierMcp(config, {
    tool: ZAPIER_ENUM_TOOL,
    arguments: { tool_name: FITBOX_MCP_FEEDS.bookings.tool, property_name: 'class_id', tool_arguments: { gym_id: numericGym(config.gymId) } },
  });
  return normalizeFitboxClasses(Array.isArray(payload?.values) ? payload.values : []);
}

function gatewayErrorCode(error) {
  const message = String(error?.message || '');
  if (message === 'MCP_TIMEOUT') return 'FITBOX_GATEWAY_TIMEOUT';
  if (message === 'MCP_UNAUTHORIZED') return 'FITBOX_GATEWAY_UNAUTHORIZED';
  if (message === 'FITBOX_FEED_UNAVAILABLE') return 'FITBOX_FEED_UNAVAILABLE';
  if (message === 'FITBOX_GATEWAY_TOOL_UNAVAILABLE') return 'FITBOX_GATEWAY_TOOL_UNAVAILABLE';
  if (/^MCP_HTTP_/.test(message)) return 'FITBOX_GATEWAY_HTTP_ERROR';
  if (/^MCP_ERROR/.test(message)) return 'FITBOX_GATEWAY_REJECTED';
  if (/^FITBOX_ACTION_FAILED/.test(message)) {
    if (/DUPLICATE|ALREADY EXISTS/i.test(message)) return 'FITBOX_DUPLICATE_REVIEW';
    if (/NOT FOUND|NOTHING COULD BE FOUND|NO USER/i.test(message)) return 'FITBOX_USER_NOT_FOUND';
    if (/INVALID|REQUIRED|MISSING/i.test(message)) return 'FITBOX_PROSPECT_INVALID';
    return 'FITBOX_PROVIDER_REJECTED';
  }
  if (/^(MCP_RESULT|MCP_RESPONSE|EMPTY_MCP)/.test(message)) return 'FITBOX_GATEWAY_RESPONSE_INVALID';
  if (MIRROR_MISSING_CODES.has(error?.code)) return 'FITBOX_MIRROR_NOT_INSTALLED';
  return 'FITBOX_GATEWAY_FAILED';
}

function withSyncTimestamp(rows) {
  const syncedAt = new Date().toISOString();
  return rows.map(row => ({ ...row, synced_at: syncedAt }));
}

async function storeFitboxFeed(admin, feed, rows) {
  if (!rows.length) return;
  const stamped = withSyncTimestamp(rows);
  const upsert = (table, onConflict) => admin.from(table).upsert(stamped, { onConflict, ignoreDuplicates: false });
  let result;
  if (feed === 'users' || feed === 'statuses') result = await upsert('fitbox_users', 'fitbox_gym_id,fitbox_user_id');
  else if (feed === 'subscriptions') result = await upsert('fitbox_subscriptions', 'fitbox_gym_id,fitbox_subscription_id');
  else result = await upsert('fitbox_attendance', 'fitbox_gym_id,fitbox_attendance_id');
  if (result.error) throw result.error;
}

async function linkVerifiedProfiles(admin, access, users, gymId) {
  const emails = [...new Set(users.map(user => user.email).filter(Boolean))];
  if (!emails.length) return 0;
  const { data: profiles, error } = await admin.from('profiles').select('id, email').in('email', emails);
  if (error) throw error;
  const matches = matchProfilesToFitboxUsers(users, profiles || []);
  let linked = 0;
  for (const match of matches) {
    const status = users.find(user => user.fitbox_user_id === match.fitbox_user_id)?.status || null;
    const { error: insertError } = await admin.from('fitbox_member_links').insert({
      fitbox_gym_id: gymId,
      fitbox_user_id: match.fitbox_user_id,
      lead_type: 'member_profile',
      lead_id: match.profile_id,
      fitbox_status: status,
      profile_email: match.email,
      profile_synced_at: new Date().toISOString(),
      link_method: 'verified_email',
      linked_by: access.user.id,
    });
    if (insertError && insertError.code !== '23505') throw insertError;
    if (!insertError) linked += 1;
  }
  return linked;
}

async function recordSyncRun(admin, { gymId, feed, actorId }) {
  const { data, error } = await admin.from('fitbox_sync_runs')
    .insert({ fitbox_gym_id: gymId, feed, status: 'running', started_by: actorId })
    .select('id, feed, status, started_at').single();
  if (error) throw error;
  return data;
}

async function finishSyncRun(admin, runId, patch) {
  const { data, error } = await admin.from('fitbox_sync_runs')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', runId)
    .select('id, feed, status, accepted, rejected, linked, error_code, started_at, finished_at').maybeSingle();
  if (error) throw error;
  return data;
}

async function runFitboxSync({ admin, access, feed }) {
  const config = fitboxMcpEnvironment(process.env);
  if (!config.ready) throw new Error('FITBOX_MCP_NOT_CONFIGURED');
  if (!FITBOX_SYNC_FEEDS.has(feed)) throw new Error('INVALID_FITBOX_FEED');
  const run = await recordSyncRun(admin, { gymId: config.gymId, feed, actorId: access.user.id });
  try {
    let accepted = 0;
    let rejected = 0;
    let linked = 0;
    if (feed === 'classes') {
      const classes = await fitboxClassCatalogue(config);
      if (classes.length) {
        const { error } = await admin.from('fitbox_classes')
          .upsert(withSyncTimestamp(classes.map(item => ({ ...item, fitbox_gym_id: config.gymId }))), { onConflict: 'fitbox_gym_id,fitbox_class_id' });
        if (error) throw error;
      }
      accepted = classes.length;
    } else {
      const payload = await fitboxAction(config, { ...FITBOX_MCP_FEEDS[feed], kind: 'read', feed: true });
      const normalized = normalizeFitboxFeed(feed, toolResultRows(payload), config.gymId);
      await storeFitboxFeed(admin, feed, normalized.accepted);
      if (feed === 'users' || feed === 'statuses') linked = await linkVerifiedProfiles(admin, access, normalized.accepted, config.gymId);
      accepted = normalized.accepted.length;
      rejected = normalized.rejected;
    }
    const finished = await finishSyncRun(admin, run.id, { status: 'completed', accepted, rejected, linked });
    console.info('FitBox gateway sync completed.', { feed, accepted, rejected, linked, actorId: access.user.id });
    return { run: finished, feed, accepted, rejected, linked };
  } catch (error) {
    const errorCode = gatewayErrorCode(error);
    await finishSyncRun(admin, run.id, { status: 'failed', error_code: errorCode }).catch(() => null);
    console.warn('FitBox gateway sync failed.', { feed, errorCode });
    const failure = new Error(errorCode);
    failure.gatewayCode = errorCode;
    throw failure;
  }
}

function extractFitboxUserRecord(payload) {
  const rows = toolResultRows(payload);
  return rows.find(row => row && (row.id !== undefined || row.user_id !== undefined || row.userId !== undefined)) || null;
}

async function lookupFitbox({ admin, access, email, fitboxUserId }) {
  const config = fitboxMcpEnvironment(process.env);
  if (!config.ready) throw new Error('FITBOX_MCP_NOT_CONFIGURED');
  const lookupKey = fitboxUserId || email;
  if (!lookupKey) throw new Error('FITBOX_LOOKUP_KEY_REQUIRED');
  const run = await recordSyncRun(admin, { gymId: config.gymId, feed: 'lookup', actorId: access.user.id });
  try {
    const payload = await fitboxAction(config, { ...FITBOX_MCP_ACTIONS.get_user, params: { user_id: lookupKey } });
    const record = extractFitboxUserRecord(payload);
    if (!record) {
      await finishSyncRun(admin, run.id, { status: 'completed', accepted: 0 });
      return { found: false, user: null, next_session: null, linked: 0 };
    }
    const user = normalizeFitboxUser(record, config.gymId);
    await storeFitboxFeed(admin, 'users', [user]);
    const linked = await linkVerifiedProfiles(admin, access, [user], config.gymId);
    let nextSession = null;
    try {
      const sessionPayload = await fitboxAction(config, { ...FITBOX_MCP_ACTIONS.next_session, params: { user_id: user.fitbox_user_id } });
      const sessionRow = toolResultRows(sessionPayload)[0];
      if (sessionRow) {
        nextSession = normalizeFitboxAttendance(sessionRow, config.gymId, 'next_session');
        await storeFitboxFeed(admin, 'bookings', [nextSession]);
      }
    } catch (sessionError) {
      // The profile is still valid without a session; report why separately.
      nextSession = { unavailable: gatewayErrorCode(sessionError) };
    }
    await finishSyncRun(admin, run.id, { status: 'completed', accepted: 1, linked });
    return { found: true, user, next_session: nextSession, linked };
  } catch (error) {
    const errorCode = gatewayErrorCode(error);
    await finishSyncRun(admin, run.id, { status: 'failed', error_code: errorCode }).catch(() => null);
    const failure = new Error(errorCode);
    failure.gatewayCode = errorCode;
    throw failure;
  }
}

async function registerProspectViaGateway({ admin, access, leadId, lead, config }) {
  const args = fitboxRegisterArguments(lead);
  const callbackToken = randomBytes(32).toString('base64url');
  const tokenHash = callbackTokenHash(callbackToken);
  const { data: job, error: jobError } = await admin.from('fitbox_integration_jobs').insert({
    job_type: 'register_prospect',
    lead_type: 'member_interest',
    lead_id: leadId,
    status: 'dispatched',
    callback_token_hash: tokenHash,
    fitbox_gym_id: config.gymId,
    created_by: access.user.id,
    dispatched_at: new Date().toISOString(),
    attempt_count: 1,
  }).select('id').single();
  if (jobError) {
    if (jobError.code === '23505') throw new Error('FITBOX_JOB_IN_PROGRESS');
    throw jobError;
  }
  let record;
  try {
    const payload = await fitboxAction(config, { ...FITBOX_MCP_ACTIONS.register_user, params: args });
    record = extractFitboxUserRecord(payload);
  } catch (error) {
    const code = gatewayErrorCode(error);
    // A timeout cannot prove FitBox did not create the prospect; block blind retries.
    const status = code === 'FITBOX_GATEWAY_TIMEOUT' ? 'dispatch_unknown' : 'failed';
    await admin.from('fitbox_integration_jobs').update({
      status, last_error_code: status === 'dispatch_unknown' ? 'ZAPIER_DISPATCH_OUTCOME_UNKNOWN' : code, updated_at: new Date().toISOString(),
    }).eq('id', job.id);
    const failure = new Error(code);
    failure.gatewayCode = code;
    failure.jobStatus = status;
    throw failure;
  }
  let user;
  try {
    user = normalizeFitboxUser(record || {}, config.gymId);
  } catch {
    await admin.rpc('fail_fitbox_prospect_job', { p_job_id: job.id, p_callback_token_hash: tokenHash, p_error_code: 'FITBOX_PROSPECT_INVALID' });
    const failure = new Error('FITBOX_PROSPECT_INVALID');
    failure.gatewayCode = 'FITBOX_PROSPECT_INVALID';
    throw failure;
  }
  const { error: completeError } = await admin.rpc('complete_fitbox_prospect_job', {
    p_job_id: job.id,
    p_callback_token_hash: tokenHash,
    p_fitbox_gym_id: config.gymId,
    p_fitbox_user_id: user.fitbox_user_id,
    p_fitbox_status: user.status || 'prospect',
  });
  if (completeError) {
    const code = /FITBOX_IDENTITY_CONFLICT/.test(completeError.message || '') ? 'FITBOX_IDENTITY_CONFLICT' : 'FITBOX_PROVIDER_REJECTED';
    await admin.rpc('fail_fitbox_prospect_job', { p_job_id: job.id, p_callback_token_hash: tokenHash, p_error_code: code });
    const failure = new Error(code);
    failure.gatewayCode = code;
    throw failure;
  }
  await storeFitboxFeed(admin, 'users', [user]).catch(() => null);
  try {
    await admin.from('fitbox_member_links').update({ link_method: 'zapier_mcp_register' })
      .eq('lead_type', 'member_interest').eq('lead_id', leadId).eq('link_method', 'zapier_register_prospect');
  } catch {
    // The link is already recorded; the method label is informational only.
  }
  console.info('FitBox prospect registered through the gateway.', { jobId: job.id, actorId: access.user.id });
  return leadIntegrationState(admin, leadId);
}

async function refreshUserViaGateway({ admin, access, leadId, config }) {
  const existing = await leadIntegrationState(admin, leadId);
  if (!existing.link) throw new Error('FITBOX_LINK_REQUIRED');
  if (['queued', 'dispatched', 'dispatch_unknown'].includes(existing.current_job?.status)) throw new Error('FITBOX_JOB_IN_PROGRESS');
  const callbackToken = randomBytes(32).toString('base64url');
  const tokenHash = callbackTokenHash(callbackToken);
  const { data: job, error: jobError } = await admin.from('fitbox_integration_jobs').insert({
    job_type: 'get_user',
    lead_type: 'member_interest',
    lead_id: leadId,
    status: 'dispatched',
    callback_token_hash: tokenHash,
    fitbox_gym_id: existing.link.fitbox_gym_id,
    fitbox_user_id: existing.link.fitbox_user_id,
    created_by: access.user.id,
    dispatched_at: new Date().toISOString(),
    attempt_count: 1,
  }).select('id').single();
  if (jobError) {
    if (jobError.code === '23505') throw new Error('FITBOX_JOB_IN_PROGRESS');
    throw jobError;
  }
  let user;
  try {
    const payload = await fitboxAction(config, { ...FITBOX_MCP_ACTIONS.get_user, params: { user_id: existing.link.fitbox_user_id } });
    const record = extractFitboxUserRecord(payload);
    if (!record) throw new Error('FITBOX_ACTION_FAILED: user not found');
    user = normalizeFitboxUser(record, config.gymId);
  } catch (error) {
    const code = gatewayErrorCode(error);
    await admin.rpc('fail_fitbox_prospect_job', { p_job_id: job.id, p_callback_token_hash: tokenHash, p_error_code: code === 'FITBOX_USER_NOT_FOUND' ? code : 'FITBOX_PROFILE_REFRESH_REJECTED' });
    const failure = new Error(code);
    failure.gatewayCode = code;
    throw failure;
  }
  if (user.fitbox_user_id !== existing.link.fitbox_user_id) {
    await admin.rpc('fail_fitbox_prospect_job', { p_job_id: job.id, p_callback_token_hash: tokenHash, p_error_code: 'FITBOX_LOOKUP_IDENTITY_MISMATCH' });
    const failure = new Error('FITBOX_LOOKUP_IDENTITY_MISMATCH');
    failure.gatewayCode = 'FITBOX_LOOKUP_IDENTITY_MISMATCH';
    throw failure;
  }
  const { error: completeError } = await admin.rpc('complete_fitbox_get_user_job', {
    p_job_id: job.id,
    p_callback_token_hash: tokenHash,
    p_fitbox_gym_id: config.gymId,
    p_fitbox_user_id: user.fitbox_user_id,
    p_fitbox_status: user.status,
    p_profile_first_name: user.first_name,
    p_profile_last_name: user.last_name,
    p_profile_email: user.email,
    p_profile_phone: user.phone,
  });
  if (completeError) {
    await admin.rpc('fail_fitbox_prospect_job', { p_job_id: job.id, p_callback_token_hash: tokenHash, p_error_code: 'FITBOX_PROFILE_REFRESH_REJECTED' });
    const failure = new Error('FITBOX_PROFILE_REFRESH_REJECTED');
    failure.gatewayCode = 'FITBOX_PROFILE_REFRESH_REJECTED';
    throw failure;
  }
  await storeFitboxFeed(admin, 'users', [user]).catch(() => null);
  console.info('FitBox read-only profile refreshed through the gateway.', { jobId: job.id, actorId: access.user.id });
  return leadIntegrationState(admin, leadId);
}

async function mirrorInstalled(admin) {
  const { error } = await admin.from('fitbox_sync_runs').select('id', { count: 'exact', head: true });
  if (!error) return true;
  if (MIRROR_MISSING_CODES.has(error.code)) return false;
  throw error;
}

async function fitboxOverview(admin) {
  const gateway = fitboxMcpEnvironment(process.env);
  const hooks = fitboxIntegrationEnvironment(process.env);
  const getUserHooks = fitboxGetUserEnvironment(process.env);
  const events = fitboxEventEnvironment(process.env);
  const installed = await mirrorInstalled(admin);
  let gatewayState = { ready: gateway.ready, missing: gateway.missing, mode: null, tools: [], feeds_available: false, error_code: null };
  if (gateway.ready) {
    try {
      const capabilities = await gatewayMode(gateway);
      gatewayState = { ...gatewayState, mode: capabilities.mode, tools: capabilities.tools, feeds_available: capabilities.feeds_available, actions: capabilities.actions };
    } catch (error) {
      gatewayState = { ...gatewayState, ready: false, mode: 'unreachable', error_code: gatewayErrorCode(error) };
    }
  }
  const base = {
    gym_id: gateway.gymId || events.gymId || null,
    gateway: gatewayState,
    hooks: { ready: hooks.ready && getUserHooks.ready, missing: [...new Set([...hooks.missing, ...getUserHooks.missing])] },
    events: { ready: events.ready, missing: events.missing },
    mirror_installed: installed,
  };
  if (!installed) return { ...base, summary: null, classes: [], recent_runs: [], last_completed_sync: null, review_queue: 0 };
  const [users, subscriptions, attendance, classes, runs, reviews, links, latestEvent, eventsToday] = await Promise.all([
    admin.from('fitbox_users').select('status, role').limit(5000),
    admin.from('fitbox_subscriptions').select('status, price_in_cents').limit(5000),
    admin.from('fitbox_attendance').select('status, feed, session_start_time, fitbox_class_id, class_name').limit(5000),
    admin.from('fitbox_classes').select('fitbox_class_id, name').order('name'),
    admin.from('fitbox_sync_runs').select('id, feed, status, accepted, rejected, linked, error_code, started_at, finished_at').order('started_at', { ascending: false }).limit(20),
    admin.from('fitbox_integration_events').select('id', { count: 'exact', head: true }).eq('processing_state', 'needs_review'),
    admin.from('fitbox_member_links').select('id', { count: 'exact', head: true }),
    admin.from('fitbox_integration_events').select('event_type, received_at').order('received_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('fitbox_integration_events').select('id', { count: 'exact', head: true }).gte('received_at', new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
  ]);
  for (const result of [users, subscriptions, attendance, classes, runs, reviews, links, latestEvent, eventsToday]) if (result.error) throw result.error;
  const summary = summarizeFitboxMirror({ users: users.data || [], subscriptions: subscriptions.data || [], attendance: attendance.data || [] });
  const recentRuns = runs.data || [];
  // Without a class catalogue feed, the classes seen in bookings are the catalogue.
  const knownClasses = classes.data?.length
    ? classes.data
    : [...new Map((attendance.data || []).filter(row => row.fitbox_class_id && row.class_name).map(row => [row.fitbox_class_id, { fitbox_class_id: row.fitbox_class_id, name: row.class_name }])).values()];
  return {
    ...base,
    summary: { ...summary, links: Number(links.count || 0) },
    classes: knownClasses,
    recent_runs: recentRuns,
    last_completed_sync: recentRuns.find(run => run.status === 'completed' && run.feed !== 'lookup')?.finished_at || null,
    last_event_at: latestEvent.data?.received_at || null,
    last_event_type: latestEvent.data?.event_type || null,
    events_24h: Number(eventsToday.count || 0),
    review_queue: Number(reviews.count || 0),
  };
}

function gatewayFailureResponse(json, error) {
  const code = error.gatewayCode || error.message;
  const messages = {
    FITBOX_MCP_NOT_CONFIGURED: ['FitBox gateway is not configured. Add the Zapier MCP server URL in Vercel and redeploy.', 503],
    FITBOX_GATEWAY_TIMEOUT: ['FitBox did not answer in time. Check FitBox before retrying anything that creates a record.', 504],
    FITBOX_GATEWAY_UNAUTHORIZED: ['Zapier rejected the gateway credentials. Rotate the MCP server URL or token in Vercel.', 502],
    FITBOX_GATEWAY_HTTP_ERROR: ['Zapier returned an error. Retry shortly; nothing was changed.', 502],
    FITBOX_GATEWAY_REJECTED: ['Zapier rejected the request. Check the FitBox connection in Zapier.', 502],
    FITBOX_FEED_UNAVAILABLE: ['This Zapier server exposes FitBox actions only. Bulk feeds need the dynamic server; lookups and registration still work.', 409],
    FITBOX_GATEWAY_TOOL_UNAVAILABLE: ['That FitBox action is not enabled on the Zapier server. Add it under the server\'s tools.', 409],
    FITBOX_GATEWAY_RESPONSE_INVALID: ['Zapier returned an unexpected response. Nothing was changed.', 502],
    FITBOX_MIRROR_NOT_INSTALLED: ['FitBox mirror tables are not installed. Apply the live-mirror migration first.', 503],
    FITBOX_USER_NOT_FOUND: ['FitBox could not find that user.', 404],
    FITBOX_DUPLICATE_REVIEW: ['FitBox reported a possible duplicate. Review it in FitBox before sending again.', 409],
    FITBOX_PROSPECT_INVALID: ['FitBox reported missing or invalid prospect details.', 422],
    FITBOX_PROVIDER_REJECTED: ['FitBox rejected the request.', 502],
    FITBOX_IDENTITY_CONFLICT: ['This FitBox identity conflicts with an existing XERT link.', 409],
    FITBOX_LOOKUP_IDENTITY_MISMATCH: ['FitBox returned a different user identity. The XERT link was not changed.', 409],
    FITBOX_PROFILE_REFRESH_REJECTED: ['FitBox rejected the read-only profile refresh.', 502],
    FITBOX_LOOKUP_KEY_REQUIRED: ['Enter an email address or FitBox user ID to look up.', 400],
    INVALID_FITBOX_FEED: ['FitBox sync feed is invalid.', 400],
    FITBOX_LINK_REQUIRED: ['Link this lead to a verified FitBox user before refreshing its profile.', 409],
    FITBOX_JOB_IN_PROGRESS: ['This lead already has a FitBox job in progress.', 409],
    FITBOX_GATEWAY_FAILED: ['The FitBox gateway request could not be completed.', 502],
  };
  const [message, status] = messages[code] || messages.FITBOX_GATEWAY_FAILED;
  return json({ error: message, error_code: code }, status);
}

export default async function handler(request, response) {
  const trace = createRequestTrace(response);
  const { json } = trace;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'FitBox integration service is unavailable.' }, 503);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  if (requestService(request) === 'callback') return handleFitboxCallback(request, admin, trace);
  if (requestService(request) === 'event') return handleFitboxEvent(request, admin, trace);
  if (requestService(request) === 'xertos_health') return handleXertosHealth(request, response, admin, trace);
  // The exact-byte /api/xertos-webhook route now owns signed calendar edits.
  // This legacy route cannot prove the original target/body bytes for the
  // receipt fingerprint, so it must fail closed rather than bypass enforcement.
  if (requestService(request) === 'xertos_edit') {
    return json({ error: { code: 'ROUTE_RETIRED', message: 'Use /api/xertos-webhook for XertOS calendar edits.' } }, 410);
  }
  if (requestService(request) === 'xertos_dispatch') return handleXertosDispatch(request, admin, trace);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  const access = await requireAdmin(request, admin);
  if (access.error) return json({ error: access.error }, access.status);

  if (request.method === 'GET') {
    const wantsHealth = requestQuery(request, 'health') === '1';
    const wantsEvents = requestQuery(request, 'events') === '1';
    const wantsOverview = requestQuery(request, 'overview') === '1';
    try {
      if (wantsOverview) return json(await fitboxOverview(admin));
      if (wantsHealth) return json(await integrationHealth(admin));
      if (wantsEvents) return json(await fitboxReconciliationEvents(admin, fitboxEventState(requestQuery(request, 'state'))));
      const leadId = requestLeadID(request);
      const state = await leadIntegrationState(admin, leadId);
      const environment = fitboxIntegrationEnvironment(process.env);
      const getUserEnvironment = fitboxGetUserEnvironment(process.env);
      const gateway = fitboxMcpEnvironment(process.env);
      return json({
        ...state,
        gateway_ready: gateway.ready,
        ready: environment.ready || gateway.ready,
        configuration_issue: environment.ready || gateway.ready ? null : 'FitBox Zapier handoff is not configured.',
        profile_refresh_ready: getUserEnvironment.ready || gateway.ready,
        profile_refresh_issue: getUserEnvironment.ready || gateway.ready ? null : 'FitBox read-only profile refresh is not configured.',
      });
    } catch (error) {
      // Keep production diagnostics useful without writing provider payloads,
      // member data, or raw database messages to the function log.
      console.error('FitBox admin read failed.', {
        requestId: trace.requestId,
        operation: wantsOverview ? 'overview' : wantsHealth ? 'health' : wantsEvents ? 'events' : 'lead_state',
        errorCode: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'UNKNOWN',
      });
      if (error.message === 'INVALID_FITBOX_EVENT_STATE') return json({ error: 'FitBox event state is invalid.' }, 400);
      if (error.message === 'INVALID_FITBOX_LEAD_ID') return json({ error: 'Lead selection is invalid.' }, 400);
      if (['42P01', 'PGRST205'].includes(error.code)) return json({ error: 'FitBox integration storage is not installed.' }, 503);
      return json({ error: 'FitBox status could not be loaded.' }, 500);
    }
  }

  let body;
  try {
    body = await requestJson(request);
    if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
  } catch {
    return json({ error: 'FitBox request is invalid.' }, 400);
  }
  if (!['register_prospect', 'refresh_user', 'review_event', 'sync_fitbox', 'lookup_fitbox'].includes(body?.action)) return json({ error: 'FitBox request is invalid.' }, 400);

  if (body.action === 'sync_fitbox') {
    const feed = String(body.feed || '').trim().toLowerCase();
    try {
      return json(await runFitboxSync({ admin, access, feed }));
    } catch (error) {
      if (MIRROR_MISSING_CODES.has(error.code)) return json({ error: 'FitBox mirror tables are not installed. Apply the live-mirror migration first.', error_code: 'FITBOX_MIRROR_NOT_INSTALLED' }, 503);
      return gatewayFailureResponse(json, error);
    }
  }

  if (body.action === 'lookup_fitbox') {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 320);
    const fitboxUserId = String(body.fitbox_user_id || '').trim().slice(0, 128);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
    if (fitboxUserId && !/^[A-Za-z0-9_-]{1,128}$/.test(fitboxUserId)) return json({ error: 'FitBox user ID is invalid.' }, 400);
    try {
      return json(await lookupFitbox({ admin, access, email, fitboxUserId }));
    } catch (error) {
      if (MIRROR_MISSING_CODES.has(error.code)) return json({ error: 'FitBox mirror tables are not installed. Apply the live-mirror migration first.', error_code: 'FITBOX_MIRROR_NOT_INSTALLED' }, 503);
      return gatewayFailureResponse(json, error);
    }
  }

  if (body.action === 'review_event') {
    try {
      const eventId = normalizeFitboxEventID(body.event_id);
      const result = await reviewFitboxEvent(admin, eventId, access.user.id);
      console.info('FitBox review-only event acknowledged.', {
        requestId: trace.requestId,
        eventId,
        actorId: access.user.id,
        alreadyReviewed: result.already_reviewed,
      });
      return json(result);
    } catch (error) {
      if (error.message === 'INVALID_FITBOX_EVENT_ID') return json({ error: 'FitBox event selection is invalid.' }, 400);
      if (error.message === 'FITBOX_EVENT_NOT_FOUND') return json({ error: 'This FitBox event no longer exists. Refresh the queue.' }, 404);
      if (error.message === 'FITBOX_EVENT_NOT_REVIEWABLE') return json({ error: 'This FitBox event cannot be acknowledged from the queue.' }, 409);
      if (['42P01', 'PGRST205'].includes(error.code)) return json({ error: 'FitBox reconciliation storage is unavailable.' }, 503);
      return json({ error: 'The FitBox event could not be acknowledged.' }, 500);
    }
  }

  let leadId;
  try {
    leadId = normalizeFitboxLeadID(body.lead_id);
  } catch {
    return json({ error: 'Lead selection is invalid.' }, 400);
  }

  if (body.action === 'refresh_user') {
    const gateway = fitboxMcpEnvironment(process.env);
    if (gateway.ready) {
      try {
        return json(await refreshUserViaGateway({ admin, access, leadId, config: gateway }), 200);
      } catch (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return json({ error: 'FitBox profile refresh storage is not installed.' }, 503);
        return gatewayFailureResponse(json, error);
      }
    }
    try {
      return json(await startGetUserRefresh({ admin, access, leadId }), 202);
    } catch (error) {
      if (error.message === 'FITBOX_GET_USER_NOT_CONFIGURED') return json({ error: 'FitBox read-only profile refresh is not configured.' }, 503);
      if (error.message === 'FITBOX_LINK_REQUIRED') return json({ error: 'Link this lead to a verified FitBox user before refreshing its profile.' }, 409);
      if (error.message === 'FITBOX_JOB_IN_PROGRESS') return json({ error: 'This lead already has a FitBox job in progress.' }, 409);
      if (error.message === 'FITBOX_PROFILE_REFRESH_DISPATCH_FAILED') return json({ error: 'Zapier could not start the read-only FitBox profile refresh. It is safe to retry.' }, 502);
      if (['42P01', 'PGRST205'].includes(error.code)) return json({ error: 'FitBox profile refresh storage is not installed.' }, 503);
      return json({ error: 'The FitBox profile refresh could not be started.' }, 500);
    }
  }

  const config = fitboxIntegrationEnvironment(process.env);
  if (!config.ready && !fitboxMcpEnvironment(process.env).ready) return json({ error: 'FitBox Zapier handoff is not configured.' }, 503);

  try {
    const existing = await leadIntegrationState(admin, leadId);
    if (existing.link) return json({ error: 'This lead is already linked to FitBox.', ...existing }, 409);
    if (['queued', 'dispatched', 'dispatch_unknown'].includes(existing.current_job?.status)) {
      return json({ error: 'This lead already has a FitBox handoff in progress.', ...existing }, 409);
    }

    const { data: lead, error: leadError } = await admin.from('member_interest')
      .select('id, full_name, email, phone, suburb_town')
      .eq('id', leadId).maybeSingle();
    if (leadError) throw leadError;
    if (!lead) return json({ error: 'This lead no longer exists. Refresh the list.' }, 404);
    prospectForFitbox(lead);

    const gateway = fitboxMcpEnvironment(process.env);
    if (gateway.ready) {
      try {
        const state = await registerProspectViaGateway({ admin, access, leadId, lead, config: gateway });
        return json(state, state.link ? 200 : 202);
      } catch (error) {
        if (error.gatewayCode) return gatewayFailureResponse(json, error);
        throw error;
      }
    }

    const callbackToken = randomBytes(32).toString('base64url');
    const { data: job, error: jobError } = await admin.from('fitbox_integration_jobs').insert({
      job_type: 'register_prospect',
      lead_type: 'member_interest',
      lead_id: leadId,
      status: 'queued',
      callback_token_hash: callbackTokenHash(callbackToken),
      fitbox_gym_id: config.gymId,
      created_by: access.user.id,
    }).select('id, status, fitbox_user_id, fitbox_status, last_error_code, dispatched_at, completed_at, created_at').single();
    if (jobError) {
      if (jobError.code === '23505') return json({ error: 'This lead already has a FitBox handoff in progress.' }, 409);
      throw jobError;
    }

    const payload = fitboxProspectDispatchPayload({ jobId: job.id, callbackToken, lead, environment: process.env });
    try {
      await dispatchProspect(config, payload);
    } catch {
      // A network timeout cannot prove Zapier rejected the request: FitBox may
      // already have created the prospect. Block blind retries until the
      // operator reconciles this job or the authenticated callback arrives.
      await admin.from('fitbox_integration_jobs').update({
        status: 'dispatch_unknown', last_error_code: 'ZAPIER_DISPATCH_OUTCOME_UNKNOWN', attempt_count: 1, updated_at: new Date().toISOString(),
      }).eq('id', job.id).eq('status', 'queued');
      return json({ error: 'Zapier did not confirm the handoff outcome. Do not retry yet—check FitBox for this email and reconcile the lead first.' }, 502);
    }

    const { data: dispatched, error: dispatchError } = await admin.from('fitbox_integration_jobs').update({
      status: 'dispatched', dispatched_at: new Date().toISOString(), attempt_count: 1, updated_at: new Date().toISOString(),
    }).eq('id', job.id).eq('status', 'queued')
      .select('id, status, fitbox_user_id, fitbox_status, last_error_code, dispatched_at, completed_at, created_at').maybeSingle();
    if (dispatchError) throw dispatchError;

    console.info('FitBox prospect handoff accepted by Zapier.', { requestId: trace.requestId, jobId: job.id, actorId: access.user.id });
    if (dispatched) return json({ job: publicFitboxJob(dispatched), link: null }, 202);
    const completedState = await leadIntegrationState(admin, leadId);
    return json(completedState, completedState.link ? 200 : 202);
  } catch (error) {
    if (error.message === 'FITBOX_FULL_NAME_REQUIRED') return json({ error: 'Add the lead’s first and last name before sending them to FitBox.' }, 400);
    if (error.message === 'FITBOX_EMAIL_REQUIRED') return json({ error: 'Add a valid lead email before sending them to FitBox.' }, 400);
    if (error.message === 'FITBOX_PHONE_REQUIRED') return json({ error: 'Add the lead’s phone number before sending them to FitBox.' }, 400);
    if (['42P01', 'PGRST205'].includes(error.code)) return json({ error: 'FitBox integration storage is not installed.' }, 503);
    return json({ error: 'The FitBox handoff could not be started.' }, 500);
  }
}
