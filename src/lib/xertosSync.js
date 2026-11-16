// XertOS class sync, server side only (served by api/admin-fitbox-integration).
//
// XERT Fitness is in charge of its class timetable; XertOS keeps a mirror.
// - The dispatcher, called by pg_cron, sends changed classes to XertOS and,
//   once a day, the next four weeks as a complete list (retried hourly until
//   XertOS takes it). One class XertOS can't take never holds up the rest.
// - XertOS sends staff's edits here, signed. They are applied through the same
//   checks the admin calendar uses, and the class as it now stands is the
//   answer. A refusal is worded for the staff member who made the edit.
// The contract is XertOS docs/api/connected-sites.md.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { requestHeader, requestText } from './serverHttp.js';
import { classSessionUpdateRpcError } from './scheduling.js';

export const XERTOS_PROVIDER = 'xert_fitness';
export const XERTOS_SIGNATURE_TOLERANCE_SECONDS = 300;
export const XERTOS_FINGERPRINT_VERSION = 'xertos-calendar-request-v1';
const EDIT_REQUEST_BYTES = 32_768;
const XERTOS_TIMEOUT_MS = 20_000;
const CLAIM_LIMIT = 200;
const PUSH_ROUNDS = 3;
const FORM_CLAIM_LIMIT = 10;
const FORM_ROUNDS = 3;

export function xertosSyncEnvironment(env = {}) {
  const apiUrl = String(env.XERTOS_API_URL || '').trim().replace(/\/+$/, '');
  const config = {
    apiUrl,
    clientId: String(env.XERTOS_CLIENT_ID || '').trim(),
    clientSecret: String(env.XERTOS_CLIENT_SECRET || '').trim(),
    siteSecret: String(env.XERTOS_SITE_SECRET || '').trim(),
    dispatchSecret: String(env.XERTOS_SYNC_DISPATCH_SECRET || '').trim(),
    provider: String(env.XERTOS_SITE_PROVIDER || XERTOS_PROVIDER).trim(),
  };
  return {
    ...config,
    sendReady: /^https:\/\//.test(apiUrl) && Boolean(config.clientId && config.clientSecret) && config.dispatchSecret.length >= 32,
    editReady: config.siteSecret.length >= 16,
  };
}

/** Collapse only URL routing aliases; query order and bytes stay significant. */
export function canonicalXertosRequestTarget(target) {
  const value = String(target || '').trim();
  if (!value) throw new Error('INVALID_REQUEST_FINGERPRINT');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://xert-fitness.invalid${value.startsWith('/') ? '' : '/'}${value}`);
  return `${url.pathname}${url.search}`;
}

/**
 * Commit to the exact authenticated HTTP request. Node decoded the captured
 * bytes as UTF-8 for the HMAC boundary; no JSON reserialization occurs.
 */
export function xertosRequestFingerprint({ method, target, rawBody }) {
  const normalizedMethod = String(method || '').trim().toUpperCase();
  if (normalizedMethod !== 'POST') throw new Error('INVALID_REQUEST_FINGERPRINT');
  const bodyHash = createHash('sha256').update(String(rawBody || ''), 'utf8').digest('hex');
  return [
    XERTOS_FINGERPRINT_VERSION,
    normalizedMethod,
    canonicalXertosRequestTarget(target),
    bodyHash,
  ].join('\n');
}

function hashMatch(received, expected) {
  const a = createHash('sha256').update(String(received || '')).digest();
  const b = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(a, b);
}

/**
 * X-Webhook-Signature: `v1,k<version>=<hex HMAC-SHA256(secret, timestamp + "." + body)>`,
 * several separated by spaces while XertOS rotates the secret.
 */
export function verifyXertosSignature(header, secret, timestamp, body, nowSeconds = Math.floor(Date.now() / 1000)) {
  const ts = Number(timestamp);
  if (!secret || !Number.isInteger(ts)) return false;
  if (Math.abs(nowSeconds - ts) > XERTOS_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'));
  for (const part of String(header || '').split(/\s+/)) {
    const match = /^v1,k\d+=([0-9a-f]{64})$/.exec(part);
    if (!match) continue;
    const got = Buffer.from(match[1]);
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** What XertOS shows staff when XERT says no. Messages are shown word for word. */
export function xertosEditRefusal(error) {
  const message = String(error?.message || '');
  const code = /^[A-Z_]+/.exec(message)?.[0] || '';
  const refuse = (status, errorCode, text) => ({ status, code: errorCode, message: text });
  if (code === 'STALE_CLASS') {
    return refuse(409, code, 'This class was changed on XERT Fitness after XertOS last saw it. Refresh to see the latest, then try again.');
  }
  if (code === 'SYNC_OFF') {
    return refuse(409, code, "XERT Fitness isn't taking changes from XertOS right now. Make this change on XERT Fitness.");
  }
  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    return refuse(409, code, 'This request id was already used for a different change. Use a new id; do not retry the changed payload.');
  }
  if (code === 'IDEMPOTENCY_RECEIPT_UNVERIFIABLE') {
    return refuse(409, code, 'XERT Fitness cannot prove what this earlier request id changed. Reconcile the previous outcome, then use a new id.');
  }
  if (code === 'INVALID_REQUEST_FINGERPRINT') {
    return refuse(422, code, 'XERT Fitness could not prove the exact request identity, so nothing changed.');
  }
  if (code === 'SESSION_NOT_FOUND') return refuse(409, code, 'This class no longer exists on XERT Fitness.');
  if (code === 'BOOKINGS_OFF') {
    return refuse(409, code, "XERT Fitness isn't taking bookings from XertOS right now. Book on XERT Fitness.");
  }
  if (code === 'NO_SITE_ACCOUNT') {
    return refuse(422, code, 'No XERT Fitness member account uses this email. They need to sign up on XERT Fitness first, with the same email.');
  }
  if (code === 'SITE_ACCOUNT_AMBIGUOUS') {
    return refuse(422, code, 'More than one XERT Fitness account uses this email, so XERT Fitness cannot tell who to book. Book them on XERT Fitness.');
  }
  if (code === 'CLASS_FULL') return refuse(409, code, 'This class is full on XERT Fitness.');
  if (code === 'SESSION_NOT_BOOKABLE') return refuse(409, code, "This class isn't open for bookings on XERT Fitness.");
  if (code === 'SESSION_FINISHED') return refuse(409, code, 'This class has already finished.');
  if (code === 'SESSION_INTEREST_ONLY') {
    return refuse(409, code, 'This class takes expressions of interest only. Members register interest on XERT Fitness.');
  }
  if (code === 'CLASS_CAPACITY_INVALID') return refuse(409, code, "This class has no places set on XERT Fitness, so it can't be booked.");
  if (code === 'MEMBER_NOT_BOOKABLE') return refuse(422, code, "This XERT Fitness account isn't a member account, so it can't be booked into classes.");
  if (code === 'MEMBER_ALREADY_ON_ROSTER') return refuse(409, code, 'They are already booked into this class on XERT Fitness.');
  if (code === 'BOOKING_NOT_FOUND') return refuse(409, code, 'This booking no longer exists on XERT Fitness.');
  if (code === 'NOT_CANCELLABLE') return refuse(409, code, "This booking can't be cancelled any more on XERT Fitness (it may already be marked attended).");
  if (code === 'SESSION_ALREADY_COMPLETED') {
    return refuse(409, code, 'This class has already been completed on XERT Fitness, so it cannot be cancelled.');
  }
  if (['CAPACITY_BELOW_ACTIVE', 'USE_CANCELLATION_WORKFLOW', 'USE_ATTENDANCE_WORKFLOW', 'TERMINAL_SESSION_IMMUTABLE',
    'SESSION_TIME_CONFLICTS_WITH_MEMBER_BOOKING', 'SESSION_OVERLAPS_BLACKOUT'].includes(code)) {
    return refuse(409, code, classSessionUpdateRpcError(message));
  }
  if (code === 'INVALID_TIMES') return refuse(422, code, 'The class has to finish after it starts.');
  if (error?.code === '23514') {
    return refuse(422, 'INVALID_CLASS', 'XERT Fitness only runs its own class types (Foundation, Strength, Engine, Hybrid, Event Prep and Team), with sensible times and capacity.');
  }
  if (['INVALID_EDIT', 'INVALID_SESSION_PAYLOAD', 'REQUEST_ID_REUSED'].includes(code) || ['22P02', '22007', '22008'].includes(error?.code)) {
    return refuse(422, code || 'INVALID_EDIT', 'XERT Fitness could not read this change, so nothing changed.');
  }
  return null;
}

/**
 * XertOS → XERT: one staff edit, signed with the secret XertOS issued.
 *
 * `signatureVerified` is set by /api/xertos-webhook, which has already checked
 * the exact bytes against the versioned write secrets (XERTOS_WRITE_SECRET and,
 * during a rotation, XERTOS_PREVIOUS_WRITE_SECRET). Checking again here with
 * XERTOS_SITE_SECRET made every rotation need two Vercel values changed in
 * step; one missed and every XertOS edit answered 401 although the outer check
 * passed. Called without it, the old single-secret check still applies.
 */
export async function handleXertosEdit(request, admin, trace, env = process.env, nowSeconds = Math.floor(Date.now() / 1000), { signatureVerified = false } = {}) {
  const { json } = trace;
  if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  const config = xertosSyncEnvironment(env);
  if (!signatureVerified && !config.editReady) {
    return json({ error: { code: 'SYNC_OFF', message: "XERT Fitness isn't taking changes from XertOS right now. Make this change on XERT Fitness." } }, 409);
  }

  // Vercel hands over the parsed JSON; XertOS signs JSON.stringify of the
  // same object, which serialises back to the identical bytes.
  const body = await requestText(request);
  if (Buffer.byteLength(body) > EDIT_REQUEST_BYTES) return json({ error: { code: 'TOO_LARGE', message: 'Change too large.' } }, 413);
  const siteHeader = requestHeader(request, 'x-xertos-site');
  if ((siteHeader || !signatureVerified) && siteHeader !== config.provider) {
    return json({ error: { code: 'UNSIGNED', message: 'Change was not accepted.' } }, 401);
  }
  if (!signatureVerified && !verifyXertosSignature(requestHeader(request, 'x-webhook-signature'), config.siteSecret,
    requestHeader(request, 'x-webhook-timestamp'), body, nowSeconds)) {
    return json({ error: { code: 'UNSIGNED', message: 'Change was not accepted.' } }, 401);
  }

  let edit;
  try {
    edit = JSON.parse(body);
  } catch {
    return json({ error: { code: 'INVALID_EDIT', message: 'XERT Fitness could not read this change, so nothing changed.' } }, 422);
  }
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    return json({ error: { code: 'INVALID_EDIT', message: 'XERT Fitness could not read this change, so nothing changed.' } }, 422);
  }
  // XertOS's connection test: the signature checked out, nothing to change.
  if (edit.action === 'ping') return json({ ok: true, provider: config.provider }, 200);
  // The idempotency key must be inside the signed body. An unsigned transport
  // header must never choose which durable receipt a write mutates or replays.
  if (typeof edit.requestId !== 'string' || !edit.requestId.trim()) {
    return json({ error: { code: 'INVALID_EDIT', message: 'XERT Fitness could not read this change, so nothing changed.' } }, 422);
  }

  let fingerprint;
  try {
    fingerprint = xertosRequestFingerprint({
      method: request.method,
      target: request.target,
      rawBody: body,
    });
  } catch {
    return json({ error: { code: 'INVALID_REQUEST_FINGERPRINT', message: 'XERT Fitness could not prove the exact request identity, so nothing changed.' } }, 422);
  }

  const bookingAction = edit.action === 'book' || edit.action === 'cancelBooking';
  const { data, error } = await admin.rpc(bookingAction ? 'xertos_sync_apply_booking' : 'xertos_sync_apply_edit', {
    p_edit: edit,
    p_request_fingerprint: fingerprint,
  });
  if (error) {
    const refusal = xertosEditRefusal(error);
    if (refusal) return json({ error: { code: refusal.code, message: refusal.message } }, refusal.status);
    console.error('XertOS edit failed.', {
      requestId: trace.requestId,
      action: typeof edit.action === 'string' ? edit.action.slice(0, 16) : 'unknown',
      errorCode: typeof error.code === 'string' ? error.code.slice(0, 16) : 'UNKNOWN',
    });
    return json({ error: { code: 'SITE_ERROR', message: 'XERT Fitness could not make this change. Nothing changed.' } }, 500);
  }
  return json(data, 200);
}

async function xertosFetch(fetchImpl, url, init) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(XERTOS_TIMEOUT_MS) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { ok: response.ok, status: response.status, body: parsed };
}

function xertosProblem(result) {
  const problem = result.body?.error || result.body;
  const code = typeof problem?.code === 'string' ? problem.code : `HTTP_${result.status}`;
  const detail = typeof problem?.message === 'string' ? problem.message : typeof problem?.detail === 'string' ? problem.detail : '';
  return `${code}${detail ? `: ${detail}` : ''}`.slice(0, 500);
}

export async function xertosAccessToken(config, fetchImpl = fetch) {
  const result = await xertosFetch(fetchImpl, `${config.apiUrl}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantType: 'client_credentials', clientId: config.clientId, clientSecret: config.clientSecret }),
  });
  if (!result.ok || typeof result.body?.accessToken !== 'string') throw new Error(`XERTOS_TOKEN ${xertosProblem(result)}`);
  return result.body.accessToken;
}

export async function sendClassesToXertos(config, token, payload, idempotencyKey, fetchImpl = fetch) {
  return xertosFetch(fetchImpl, `${config.apiUrl}/v1/connected-sites/${encodeURIComponent(config.provider)}/classes/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

/** Forms signed here (a PEQ, the terms), sent so XertOS's forms list stays whole. */
export async function sendFormsToXertos(config, token, payload, idempotencyKey, fetchImpl = fetch) {
  return xertosFetch(fetchImpl, `${config.apiUrl}/v1/connected-sites/${encodeURIComponent(config.provider)}/forms/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Sends every form response XertOS hasn't confirmed, oldest first, a few at a
 * time (each carries a signature image). XertOS writes a response once only,
 * so a repeat is harmless. Returns null when there was nothing to do, or the
 * database isn't set up for it yet.
 */
export async function pushFormsToXertos(admin, config, token, trace, fetchImpl = fetch) {
  const totals = { sent: 0, failed: 0, outcomes: {} };
  for (let round = 0; round < FORM_ROUNDS; round += 1) {
    const claim = await admin.rpc('xertos_forms_claim', { p_limit: FORM_CLAIM_LIMIT });
    if (!claim || claim.error) {
      if (claim?.error && !['42883', 'PGRST202'].includes(claim.error.code)) {
        console.error('XertOS forms queue could not be read.', { requestId: trace.requestId, errorCode: String(claim.error.code || 'UNKNOWN').slice(0, 64) });
      }
      break;
    }
    const responses = Array.isArray(claim.data?.responses) ? claim.data.responses : [];
    if (responses.length === 0) break;
    const forms = Array.isArray(claim.data?.forms) ? claim.data.forms : [];
    const key = `xert-forms-${createHash('sha256').update(responses.map(item => item.id).join(',')).digest('hex').slice(0, 40)}`;
    const result = await sendFormsToXertos(config, token, { forms, responses }, key, fetchImpl)
      .catch(error => ({ ok: false, status: 0, body: { error: { code: 'UNREACHABLE', message: error.message } } }));
    if (!result.ok) {
      const problem = xertosProblem(result);
      await admin.rpc('xertos_forms_settle', { p_ok: false, p_results: [], p_error: problem });
      console.error('XertOS forms push refused.', { requestId: trace.requestId, problem });
      totals.failed += responses.length;
      break;
    }
    const results = (Array.isArray(result.body?.results) ? result.body.results : [])
      .filter(item => typeof item?.id === 'string')
      .map(item => ({ id: item.id, outcome: typeof item.outcome === 'string' ? item.outcome : 'unknown' }));
    await admin.rpc('xertos_forms_settle', { p_ok: true, p_results: results, p_error: null });
    for (const item of results) totals.outcomes[item.outcome] = (totals.outcomes[item.outcome] || 0) + 1;
    totals.sent += results.length;
    // XertOS answered for fewer than it was sent: stop rather than loop on the same ones.
    if (results.length < responses.length || responses.length < FORM_CLAIM_LIMIT) break;
  }
  return totals.sent || totals.failed ? totals : null;
}

/** How many classes XertOS answered each way, for the log and the scheduler. */
export function summarizeXertosOutcomes(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.reduce((counts, result) => {
    const outcome = typeof result?.outcome === 'string' ? result.outcome : 'unknown';
    counts[outcome] = (counts[outcome] || 0) + 1;
    return counts;
  }, {});
}

/** Classes XertOS answered `rejected`, with its reason, for the queue to keep. */
export function rejectedClasses(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter(result => result?.outcome === 'rejected' && typeof result.externalId === 'string')
    .map(result => ({ externalId: result.externalId, problem: typeof result.problem === 'string' ? result.problem.slice(0, 500) : null }));
}

/**
 * The classes a refused push names (`errors[].path` like `classes.3.title`),
 * so only those wait and the rest go again. Empty when it names none.
 */
export function refusedClassIds(result, classes) {
  if (![400, 422].includes(result?.status)) return [];
  const errors = Array.isArray(result.body?.errors) ? result.body.errors : [];
  const ids = new Set();
  for (const error of errors) {
    const match = /^classes\.(\d+)(\.|$)/.exec(String(error?.path || ''));
    const id = match ? classes[Number(match[1])]?.externalId : null;
    if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
}

async function sendWindow(admin, config, token, trace, fetchImpl) {
  const { data, error } = await admin.rpc('xertos_sync_window', {});
  if (error) return { ok: false, status: 500, body: { error: 'Could not read the timetable.' } };
  if (!data) return { ok: true, status: 200, body: { action: 'window', sent: 0, off: true } };
  const result = await sendClassesToXertos(config, token, data, `xert-window-${randomUUID()}`, fetchImpl).catch(error => ({ ok: false, status: 0, body: { error: { code: 'UNREACHABLE', message: error.message } } }));
  await admin.rpc('xertos_sync_window_mark', { p_ok: result.ok });
  if (!result.ok) {
    console.error('XertOS window push refused.', { requestId: trace.requestId, problem: xertosProblem(result) });
    return { ok: false, status: 502, body: { error: 'XertOS did not take the timetable.', problem: xertosProblem(result) } };
  }
  const rejected = rejectedClasses(result.body);
  if (rejected.length) console.warn('XertOS rejected classes.', { requestId: trace.requestId, rejected });
  return { ok: true, status: 200, body: { action: 'window', sent: data.classes?.length || 0, outcomes: summarizeXertosOutcomes(result.body) } };
}

/** XERT → XertOS: pg_cron calls this with `Authorization: Bearer <XERTOS_SYNC_DISPATCH_SECRET>`. */
export async function handleXertosDispatch(request, admin, trace, env = process.env, fetchImpl = fetch) {
  const { json } = trace;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const config = xertosSyncEnvironment(env);
  if (!config.sendReady) return json({ error: 'XertOS sync is not configured.' }, 503);
  const auth = requestHeader(request, 'authorization');
  if (!auth.startsWith('Bearer ') || !hashMatch(auth.slice(7), config.dispatchSecret)) {
    return json({ error: 'Not authorised.' }, 401);
  }
  let action = 'push';
  try {
    const body = JSON.parse((await requestText(request)) || '{}');
    if (body?.action === 'window') action = 'window';
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  let token;
  try {
    token = await xertosAccessToken(config, fetchImpl);
  } catch (error) {
    console.error('XertOS sync could not sign in.', { requestId: trace.requestId, reason: String(error.message).slice(0, 200) });
    return json({ error: 'Could not reach XertOS.' }, 502);
  }

  if (action === 'window') {
    const sent = await sendWindow(admin, config, token, trace, fetchImpl);
    return json(sent.body, sent.status);
  }

  const totals = { action, sent: 0, failed: 0, outcomes: {} };
  for (let round = 0; round < PUSH_ROUNDS; round += 1) {
    const { data: claim, error } = await admin.rpc('xertos_sync_claim', { p_limit: CLAIM_LIMIT });
    if (error) return json({ ...totals, error: 'Could not read the queue.' }, 500);
    if (!claim?.lease) break;
    const classes = Array.isArray(claim.classes) ? claim.classes : [];
    let ok = true;
    let problem = null;
    let rejected = [];
    let failedIds = [];
    if (classes.length > 0) {
      const result = await sendClassesToXertos(config, token, { classes }, `xert-push-${claim.lease}`, fetchImpl)
        .catch(error => ({ ok: false, status: 0, body: { error: { code: 'UNREACHABLE', message: error.message } } }));
      ok = result.ok;
      if (ok) {
        for (const [outcome, count] of Object.entries(summarizeXertosOutcomes(result.body))) {
          totals.outcomes[outcome] = (totals.outcomes[outcome] || 0) + count;
        }
        rejected = rejectedClasses(result.body);
      } else {
        problem = xertosProblem(result);
        failedIds = refusedClassIds(result, classes);
      }
    }
    await admin.rpc('xertos_sync_settle', {
      p_lease: claim.lease,
      p_ok: ok,
      p_error: problem,
      ...(rejected.length ? { p_rejected: rejected } : {}),
      ...(failedIds.length ? { p_failed: failedIds } : {}),
    });
    if (rejected.length) console.warn('XertOS rejected classes.', { requestId: trace.requestId, rejected });
    if (!ok) {
      totals.failed += failedIds.length || classes.length;
      console.error('XertOS push refused.', { requestId: trace.requestId, problem });
      // Only the named classes wait; the rest go again in the next round.
      if (failedIds.length && failedIds.length < classes.length) continue;
      break;
    }
    totals.sent += classes.length;
    if (classes.length < CLAIM_LIMIT) break;
  }

  // Forms signed on the site since the last run.
  const forms = await pushFormsToXertos(admin, config, token, trace, fetchImpl);
  if (forms) {
    totals.forms = forms;
    totals.failed += forms.failed;
  }

  // A daily window that didn't reach XertOS is tried again here, hourly.
  const windowDue = await admin.rpc('xertos_sync_window_due', {});
  if (windowDue?.data === true) {
    const sent = await sendWindow(admin, config, token, trace, fetchImpl);
    totals.window = sent.ok ? sent.body.outcomes || {} : { failed: true };
  }
  return json(totals, totals.failed ? 502 : 200);
}

// ---------------------------------------------------------------------------
// How the link is doing, for the owner's operations health page
// ---------------------------------------------------------------------------

/** XertOS's own view of this connection (GET /v1/connected-sites/{provider}/status). */
export async function xertosConnectionStatus(config, fetchImpl = fetch) {
  let token;
  try {
    token = await xertosAccessToken(config, fetchImpl);
  } catch (error) {
    return { reachable: false, problem: String(error?.message || error).replace(/^XERTOS_TOKEN /, '').slice(0, 300) };
  }
  const result = await xertosFetch(fetchImpl, `${config.apiUrl}/v1/connected-sites/${encodeURIComponent(config.provider)}/status`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(error => ({ ok: false, status: 0, body: { error: { code: 'UNREACHABLE', message: error.message } } }));
  if (!result.ok) return { reachable: true, problem: xertosProblem(result) };
  const site = result.body || {};
  return {
    reachable: true,
    status: site.status ?? null,
    health: site.health ?? null,
    lastReceivedAt: site.lastReceivedAt ?? null,
    lastWindowAt: site.lastWindowAt ?? null,
    lastWriteAt: site.lastWriteAt ?? null,
    lastError: site.lastError ?? null,
    writeSecretVersion: site.writeSecretVersion ?? null,
    previousSecretUntil: site.previousSecretUntil ?? null,
  };
}

const QUEUE_STUCK_MS = 15 * 60 * 1000;

/** This side of the link: the switch, the daily window, and what is waiting to go. */
export async function xertosLocalSyncState(admin, now = Date.now()) {
  const [settings, outbox] = await Promise.all([
    admin.from('xertos_sync_settings').select('enabled, window_sent_at, window_tried_at').maybeSingle(),
    admin.from('xertos_class_outbox').select('changed_at, sent_changed_at, last_error').order('changed_at', { ascending: true }).limit(1000),
  ]);
  if (settings.error) throw settings.error;
  if (outbox.error) throw outbox.error;
  const waiting = (outbox.data || []).filter(row => !row.sent_changed_at
    || new Date(row.sent_changed_at).getTime() !== new Date(row.changed_at).getTime());
  const oldest = waiting[0]?.changed_at || null;
  return {
    enabled: settings.data?.enabled === true,
    windowSentAt: settings.data?.window_sent_at || null,
    windowTriedAt: settings.data?.window_tried_at || null,
    waiting: waiting.length,
    stuck: oldest ? now - new Date(oldest).getTime() > QUEUE_STUCK_MS : false,
    oldestWaitingAt: oldest,
    lastError: waiting.find(row => row.last_error)?.last_error?.slice(0, 300) || null,
  };
}

/**
 * One verdict for the owner: both sides of the link, the problem in words and
 * what to do about it. `ok` only when XertOS says it is in step and nothing
 * has waited here longer than a quarter of an hour.
 */
export async function xertosSyncHealth(admin, env = process.env, fetchImpl = fetch, now = Date.now()) {
  const config = xertosSyncEnvironment(env);
  const local = await xertosLocalSyncState(admin, now);
  if (!local.enabled) {
    return { status: 'ok', local, remote: null, detail: 'XertOS class sync is switched off here, so nothing is sent.', action: null };
  }
  if (!config.sendReady) {
    return {
      status: 'attention', local, remote: null,
      detail: 'XertOS class sync is on but its Vercel settings are incomplete (XERTOS_API_URL, XERTOS_CLIENT_ID, XERTOS_CLIENT_SECRET, XERTOS_SYNC_DISPATCH_SECRET).',
      action: 'Add the missing values in Vercel and redeploy.',
    };
  }
  const remote = await xertosConnectionStatus(config, fetchImpl);
  const queue = local.waiting
    ? `${local.waiting} class change${local.waiting === 1 ? '' : 's'} waiting to send${local.lastError ? ` (last error: ${local.lastError})` : ''}`
    : 'nothing waiting to send';
  if (!remote.reachable || remote.problem) {
    return {
      status: 'attention', local, remote,
      detail: `XERT can't check in with XertOS: ${remote.problem || 'no answer'}. Here: ${queue}.`,
      action: /INVALID_CLIENT|CREDENTIAL_|CLIENT_SUSPENDED|401|403/.test(remote.problem || '')
        ? 'The XertOS credential in Vercel (XERTOS_CLIENT_ID / XERTOS_CLIENT_SECRET) was refused. Issue a new one in XertOS (Developer → Credentials, Connected site preset), update Vercel and redeploy.'
        : 'Try again in a few minutes. If it keeps failing, check XERTOS_API_URL in Vercel.',
    };
  }
  const state = remote.health?.state || 'unknown';
  const note = remote.health?.note || '';
  if (state !== 'ok' || local.stuck) {
    return {
      status: 'attention', local, remote,
      detail: `XertOS says: ${note || state}. Here: ${queue}.`,
      action: local.stuck
        ? 'Class changes have waited over 15 minutes. Check the xertos-class-sync cron job and that the vault secret xertos_sync_dispatch_secret matches XERTOS_SYNC_DISPATCH_SECRET in Vercel.'
        : state === 'failing'
          ? 'XertOS could not reach this site with an edit. Check XERTOS_WRITE_SECRET matches the secret XertOS issued, then run the connection test in XertOS.'
          : state === 'behind'
            ? 'The daily timetable window has not reached XertOS. Check the xertos-class-sync-window cron job.'
            : 'Open Connected sites in XertOS to see why.',
    };
  }
  return { status: 'ok', local, remote, detail: `In step with XertOS: ${note} Here: ${queue}.`, action: null };
}
