// XertOS class sync, server side only (served by api/admin-fitbox-integration).
//
// XERT Fitness is in charge of its class timetable; XertOS keeps a mirror.
// - The dispatcher, called by pg_cron, sends changed classes to XertOS and,
//   once a day, the next four weeks as a complete list.
// - XertOS sends staff's edits here, signed. They are applied through the same
//   checks the admin calendar uses, and the class as it now stands is the
//   answer. A refusal is worded for the staff member who made the edit.
// The contract is XertOS docs/api/connected-sites.md.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { requestHeader, requestText } from './serverHttp.js';
import { classSessionUpdateRpcError } from './scheduling.js';

export const XERTOS_PROVIDER = 'xert_fitness';
export const XERTOS_SIGNATURE_TOLERANCE_SECONDS = 300;
const EDIT_REQUEST_BYTES = 32_768;
const XERTOS_TIMEOUT_MS = 20_000;
const CLAIM_LIMIT = 200;
const PUSH_ROUNDS = 3;

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
  if (code === 'SESSION_NOT_FOUND') return refuse(409, code, 'This class no longer exists on XERT Fitness.');
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

/** XertOS → XERT: one staff edit, signed with the secret XertOS issued. */
export async function handleXertosEdit(request, admin, trace, env = process.env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const { json } = trace;
  if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  const config = xertosSyncEnvironment(env);
  if (!config.editReady) {
    return json({ error: { code: 'SYNC_OFF', message: "XERT Fitness isn't taking changes from XertOS right now. Make this change on XERT Fitness." } }, 409);
  }

  // Vercel hands over the parsed JSON; XertOS signs JSON.stringify of the
  // same object, which serialises back to the identical bytes.
  const body = await requestText(request);
  if (Buffer.byteLength(body) > EDIT_REQUEST_BYTES) return json({ error: { code: 'TOO_LARGE', message: 'Change too large.' } }, 413);
  if (requestHeader(request, 'x-xertos-site') !== config.provider
    || !verifyXertosSignature(requestHeader(request, 'x-webhook-signature'), config.siteSecret,
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
  if (!edit.requestId) edit.requestId = requestHeader(request, 'x-xertos-request-id');

  const { data, error } = await admin.rpc('xertos_sync_apply_edit', { p_edit: edit });
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

/** How many classes XertOS answered each way, for the log and the scheduler. */
export function summarizeXertosOutcomes(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.reduce((counts, result) => {
    const outcome = typeof result?.outcome === 'string' ? result.outcome : 'unknown';
    counts[outcome] = (counts[outcome] || 0) + 1;
    return counts;
  }, {});
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
    const { data, error } = await admin.rpc('xertos_sync_window', {});
    if (error) return json({ error: 'Could not read the timetable.' }, 500);
    if (!data) return json({ action, sent: 0, off: true });
    const result = await sendClassesToXertos(config, token, data, `xert-window-${randomUUID()}`, fetchImpl).catch(error => ({ ok: false, status: 0, body: { error: { code: 'UNREACHABLE', message: error.message } } }));
    if (!result.ok) {
      console.error('XertOS window push refused.', { requestId: trace.requestId, problem: xertosProblem(result) });
      return json({ error: 'XertOS did not take the timetable.', problem: xertosProblem(result) }, 502);
    }
    return json({ action, sent: data.classes?.length || 0, outcomes: summarizeXertosOutcomes(result.body) });
  }

  const totals = { action, sent: 0, failed: 0, outcomes: {} };
  for (let round = 0; round < PUSH_ROUNDS; round += 1) {
    const { data: claim, error } = await admin.rpc('xertos_sync_claim', { p_limit: CLAIM_LIMIT });
    if (error) return json({ ...totals, error: 'Could not read the queue.' }, 500);
    if (!claim?.lease) break;
    const classes = Array.isArray(claim.classes) ? claim.classes : [];
    let ok = true;
    let problem = null;
    if (classes.length > 0) {
      const result = await sendClassesToXertos(config, token, { classes }, `xert-push-${claim.lease}`, fetchImpl)
        .catch(error => ({ ok: false, status: 0, body: { error: { code: 'UNREACHABLE', message: error.message } } }));
      ok = result.ok;
      if (ok) {
        for (const [outcome, count] of Object.entries(summarizeXertosOutcomes(result.body))) {
          totals.outcomes[outcome] = (totals.outcomes[outcome] || 0) + count;
        }
      } else {
        problem = xertosProblem(result);
      }
    }
    await admin.rpc('xertos_sync_settle', { p_lease: claim.lease, p_ok: ok, p_error: problem });
    if (!ok) {
      totals.failed += classes.length;
      console.error('XertOS push refused.', { requestId: trace.requestId, problem });
      break;
    }
    totals.sent += classes.length;
    if (classes.length < CLAIM_LIMIT) break;
  }
  return json(totals, totals.failed ? 502 : 200);
}
