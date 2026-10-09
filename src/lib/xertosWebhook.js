import { createHmac, timingSafeEqual } from 'node:crypto';

import { requestText, sendJson } from './serverHttp.js';

export const XERTOS_PROVIDER = 'xert_fitness';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const CLIENT0_WRITABLE_ACTIONS = new Set(['create', 'update', 'cancel']);

function strictPositiveVersion(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const version = Number(text);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function configuredSecrets(environment) {
  const secrets = [];
  const current = String(environment.XERTOS_WRITE_SECRET || '').trim();
  const currentVersion = strictPositiveVersion(environment.XERTOS_WRITE_SECRET_VERSION);
  if (current && currentVersion !== null) secrets.push({ version: currentVersion, secret: current });

  const previous = String(environment.XERTOS_PREVIOUS_WRITE_SECRET || '').trim();
  const previousVersion = strictPositiveVersion(environment.XERTOS_PREVIOUS_WRITE_SECRET_VERSION);
  if (previous && previousVersion !== null) {
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
  return String(environment.CLIENT0_SYNC_ENABLED || '').trim().toLowerCase() === 'true'
    && String(environment.CLIENT0_CALENDAR_WRITES_ENABLED || '').trim().toLowerCase() === 'true';
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
      const secret = configuredSecrets(environment).find(candidate => candidate.version === Number(match[1]));
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

  const secrets = configuredSecrets(environment);
  return null;
}

export default async function xertosWebhookHandler(request, response, { runEdit } = {}) {
  if (request.method !== 'POST') return sendJson(response, { error: 'Method not allowed' }, 405);

  const configError = xertosWebhookConfigError(process.env);
  if (configError) return sendJson(response, { error: { code: 'NOT_CONFIGURED', message: configError } }, 500);

  // Signature verification needs the exact bytes as sent. Do not let framework
  // body parsing reorder or reserialize the JSON before HMAC verification.
  let rawBody;
  if (typeof request.text === 'function') {
    rawBody = await request.text();
  } else {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    rawBody = Buffer.concat(chunks).toString('utf8');
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

  // Unknown verbs never reach the database. The first write slice is exactly
  // create/update/cancel through the site's existing booking guards.
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
    text: async () => rawBody,
  };
  return runEdit(replayRequest, response, { now: Math.floor(Date.now() / 1000) });
}
