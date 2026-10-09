import { sendJson } from '../src/lib/serverHttp.js';
import {
  XERTOS_PROVIDER,
  verifyXertosSignature,
  xertosWebhookConfigError,
} from '../src/lib/xertosWebhook.js';

export default async function handler(request, response) {
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

  // Ping-only is the first fail-closed adapter slice. The next slice adds
  // update/create/cancel through the site's existing booking guards, without
  // bypassing active booking or cancellation rules.
  return sendJson(response, {
    error: {
      code: 'ACTION_NOT_READY',
      message: 'XertOS class edits are not enabled on this endpoint yet.',
    },
  }, 501);
}
