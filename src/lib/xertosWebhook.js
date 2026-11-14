import { createHmac, timingSafeEqual } from 'node:crypto';

import { requestText, sendJson } from './serverHttp.js';

export const XERTOS_PROVIDER = 'xert_fitness';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const CLIENT0_WRITABLE_ACTIONS = new Set(['create', 'update', 'cancel']);
// Bookings made in XertOS for XERT classes (owner decision 2026-10-10: class
// bookings are two-way for XERT Fitness). Gated on their own switch.
const CLIENT0_BOOKING_ACTIONS = new Set(['book', 'cancelBooking']);
// A refresh only queues the site's current snapshot; it never writes a booking.
// It needs the global connection gate, while the database independently checks
// that booking sharing is enabled. Do not couple it to inbound booking writes.
const CLIENT0_REFRESH_ACTIONS = new Set(['refreshBookings']);

function strictPositiveVersion(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const version = Number(text);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

/**
 * When the previous key stops being accepted: XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT,
 * an ISO 8601 instant with an explicit zone (for example 2026-12-01T00:00:00Z).
 * XertOS stops signing with its previous key at previous_write_secret_until; set
 * this to that instant so the receiver closes the same overlap. Missing or
 * unreadable, the previous key is not accepted at all (fail closed); the current
 * key is unaffected.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

export function previousSecretExpiresAt(environment = process.env) {
  const text = String(environment.XERTOS_PREVIOUS_WRITE_SECRET_EXPIRES_AT ?? '').trim();
  const match = ISO_INSTANT.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Date.parse normalises impossible dates (for example February 31) into a
  // later month. Validate the calendar and clock fields before trusting it.
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
  ) return null;

  if (match[9]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    // ISO 8601 offsets do not exceed 14:00. -00:00 means an unknown offset,
    // not a proven instant, so it cannot safely define a key-expiry boundary.
    if (
      offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
      || (match[9] === '-' && offsetHour === 0 && offsetMinute === 0)
    ) return null;
  }

  const ms = Date.parse(text);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function configuredSecrets(environment, now = Math.floor(Date.now() / 1000)) {
  const secrets = [];
  const current = String(environment.XERTOS_WRITE_SECRET || '').trim();
  const currentVersion = strictPositiveVersion(environment.XERTOS_WRITE_SECRET_VERSION);
  if (current && currentVersion !== null) secrets.push({ version: currentVersion, secret: current });

  const previous = String(environment.XERTOS_PREVIOUS_WRITE_SECRET || '').trim();
  const previousVersion = strictPositiveVersion(environment.XERTOS_PREVIOUS_WRITE_SECRET_VERSION);
  const previousUntil = previousSecretExpiresAt(environment);
  if (previous && previousVersion !== null && previousUntil !== null && now < previousUntil) {
    secrets.push({ version: previousVersion, secret: previous });
  }
  const seen = new Set();
  return secrets.filter(secret => {
    if (seen.has(secret.version)) return false;
    seen.add(secret.version);
    return true;
  });
}

function signaturePayload(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Keep the authenticated bytes lossless. A fatal decoder rejects invalid UTF-8;
 * re-encoding catches any platform decoder that silently alters input.
 */
function exactAuthenticatedText(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('NON_LOSSLESS_UTF8');
  }
  return text;
}

function equalHex(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function xertosSecretsAreConfigured(environment = process.env) {
  return configuredSecrets(environment).length > 0;
}

/** Client-0 calendar edits stay inert unless both explicit gates are true. */
export function client0CalendarWritesEnabled(environment = process.env) {
  return environment.CLIENT0_SYNC_ENABLED === 'true'
    && environment.CLIENT0_CALENDAR_WRITES_ENABLED === 'true';
}

export function client0SyncEnabled(environment = process.env) {
  return environment.CLIENT0_SYNC_ENABLED === 'true';
}

/** Bookings from XertOS stay inert unless sync and their own gate are both true. */
export function client0BookingWritesEnabled(environment = process.env) {
  return environment.CLIENT0_SYNC_ENABLED === 'true'
    && environment.CLIENT0_BOOKING_WRITES_ENABLED === 'true';
}

export function verifyXertosSignature({
  signatureHeader = '',
  timestampHeader = '',
  rawBody = '',
  environment = process.env,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
} = {}) {
  const timestampText = String(timestampHeader ?? '');
  if (!/^\d+$/.test(timestampText)) return false;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > toleranceSeconds) return false;

  return String(signatureHeader || '')
    .split(/\s+/)
    .filter(Boolean)
    .some(part => {
      const match = /^v1,k(\d+)=([0-9a-f]{64})$/.exec(part);
      if (!match) return false;
      const secret = configuredSecrets(environment, now).find(candidate => candidate.version === Number(match[1]));
      if (!secret) return false;
      return equalHex(match[2], signaturePayload(secret.secret, timestamp, rawBody));
    });
}

export function xertosWebhookConfigError(environment = process.env) {
  if (!String(environment.XERTOS_WRITE_SECRET ?? '').trim()) return 'XERTOS_WRITE_SECRET is not configured';
  if (strictPositiveVersion(environment.XERTOS_WRITE_SECRET_VERSION) === null) {
    return 'XERTOS_WRITE_SECRET_VERSION must be a positive safe integer';
  }

  const previous = String(environment.XERTOS_PREVIOUS_WRITE_SECRET ?? '').trim();
  if (previous && strictPositiveVersion(environment.XERTOS_PREVIOUS_WRITE_SECRET_VERSION) === null) {
    return 'XERTOS_PREVIOUS_WRITE_SECRET_VERSION must be a positive safe integer when XERTOS_PREVIOUS_WRITE_SECRET is configured';
  }

  const currentVersion = strictPositiveVersion(environment.XERTOS_WRITE_SECRET_VERSION);
  const previousVersion = strictPositiveVersion(environment.XERTOS_PREVIOUS_WRITE_SECRET_VERSION);
  if (previous && currentVersion === previousVersion) {
    return 'XERTOS_WRITE_SECRET_VERSION and XERTOS_PREVIOUS_WRITE_SECRET_VERSION must not match';
  }
  return null;
}

export default async function xertosWebhookHandler(request, response, { runEdit } = {}) {
  if (request.method !== 'POST') return sendJson(response, { error: 'Method not allowed' }, 405);

  const configError = xertosWebhookConfigError(process.env);
  if (configError) return sendJson(response, { error: { code: 'NOT_CONFIGURED', message: configError } }, 500);

  // Signature verification needs the exact bytes as sent. Do not let framework
  // body parsing reorder or reserialize the JSON before HMAC verification.
  let rawBody;
  try {
    if (typeof request.text === 'function') {
      rawBody = exactAuthenticatedText(await request.text());
    } else {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      rawBody = exactAuthenticatedText(Buffer.concat(chunks));
    }
  } catch {
    return sendJson(response, { error: { code: 'INVALID_ENCODING', message: 'Request body must be lossless UTF-8.' } }, 400);
  }

  const timestamp = request.headers['x-webhook-timestamp'] || '';
  const signature = request.headers['x-webhook-signature'] || '';
  if (!verifyXertosSignature({ signatureHeader: signature, timestampHeader: timestamp, rawBody })) {
    return sendJson(response, { error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed.' } }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return sendJson(response, { error: { code: 'INVALID_JSON', message: 'Request body must be JSON.' } }, 400);
  }

  if (request.headers['x-xertos-site'] && request.headers['x-xertos-site'] !== XERTOS_PROVIDER) {
    return sendJson(response, { error: { code: 'UNKNOWN_SITE', message: 'This endpoint serves xert_fitness only.' } }, 404);
  }

  if (payload?.action === 'ping') return sendJson(response, { ok: true });

  if (CLIENT0_REFRESH_ACTIONS.has(payload?.action)) {
    // A deliberate off switch is a definite refusal (409, as the RPC's own
    // SYNC_OFF), never a 5xx that XertOS would keep retrying as an outage.
    if (!client0SyncEnabled(process.env)) {
      return sendJson(response, {
        error: {
          code: 'SYNC_OFF',
          message: "XERT Fitness isn't sharing bookings with XertOS right now. Refresh the class on XERT Fitness.",
        },
      }, 409);
    }
    if (typeof runEdit !== 'function') {
      return sendJson(response, {
        error: {
          code: 'ACTION_NOT_READY',
          message: 'XERT Fitness booking sharing is not enabled yet. Refresh the class on XERT Fitness.',
        },
      }, 501);
    }
    // Only this branch, for this action, vouches that the versioned HMAC above
    // covered the request; every other action keeps its own legacy checks.
    return runEdit({
      method: request.method,
      headers: request.headers,
      target: request.url,
      text: async () => rawBody,
    }, response, { now: Math.floor(Date.now() / 1000), verifiedRefresh: true });
  }

  // Unknown verbs never reach the database. Writes are exactly create/update/
  // cancel of a class, and book/cancelBooking, through the site's own guards.
  if (CLIENT0_BOOKING_ACTIONS.has(payload?.action)) {
    if (!client0BookingWritesEnabled(process.env) || typeof runEdit !== 'function') {
      return sendJson(response, {
        error: {
          code: 'ACTION_NOT_READY',
          message: 'XERT Fitness is not taking bookings from XertOS yet. Book on XERT Fitness.',
        },
      }, 501);
    }
    return runEdit({
      method: request.method,
      headers: request.headers,
      target: request.url,
      text: async () => rawBody,
    }, response, { now: Math.floor(Date.now() / 1000) });
  }
  if (!CLIENT0_WRITABLE_ACTIONS.has(payload?.action)) {
    return sendJson(response, {
      error: {
        code: 'ACTION_NOT_READY',
        message: 'XertOS class edits are not enabled on this endpoint yet.',
      },
    }, 501);
  }

  // The calendar adapter remains fail-closed unless both deployment gates are
  // explicitly true and the API route supplies its own guarded write handler.
  if (!client0CalendarWritesEnabled(process.env) || typeof runEdit !== 'function') {
    return sendJson(response, {
      error: {
        code: 'ACTION_NOT_READY',
        message: 'XertOS class edits are not enabled on this endpoint yet.',
      },
    }, 501);
  }

  // requestText already consumed the stream to authenticate exact bytes. Give
  // the write handler the same authenticated text without re-reading or
  // framework re-serialization.
  const replayRequest = {
    method: request.method,
    headers: request.headers,
    target: request.url,
    text: async () => rawBody,
  };
  return runEdit(replayRequest, response, { now: Math.floor(Date.now() / 1000) });
}
