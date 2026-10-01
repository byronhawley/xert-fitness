import http2 from 'node:http2';
import { createSign } from 'node:crypto';

const INVALID_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);
const DELIVERY_BATCH_SIZE = 25;
const TARGET_USER_BATCH_SIZE = 100;
export const APNS_REQUEST_TIMEOUT_MS = 8_000;

function clean(value) {
  return String(value || '').trim();
}

export function inspectAPNsEnvironment(environment = {}) {
  const values = {
    keyId: clean(environment.APNS_KEY_ID),
    teamId: clean(environment.APNS_TEAM_ID),
    bundleId: clean(environment.APNS_BUNDLE_ID || 'com.xertfitness.app'),
    privateKey: clean(environment.APNS_PRIVATE_KEY).replace(/\\n/g, '\n'),
  };
  const missing = [];
  if (!values.keyId) missing.push('APNS_KEY_ID');
  if (!values.teamId) missing.push('APNS_TEAM_ID');
  if (!values.bundleId) missing.push('APNS_BUNDLE_ID');
  if (!values.privateKey.includes('BEGIN PRIVATE KEY')) missing.push('APNS_PRIVATE_KEY');
  return { ready: missing.length === 0, missing, ...values };
}

export function createAPNsProviderToken(config, now = new Date()) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: Math.floor(now.getTime() / 1000) })).toString('base64url');
  const input = `${header}.${claims}`;
  const signer = createSign('SHA256');
  signer.update(input);
  signer.end();
  const signature = signer.sign({ key: config.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${input}.${signature}`;
}

export function buildAnnouncementPush(announcement) {
  const title = clean(announcement?.title).slice(0, 120);
  const body = clean(announcement?.body).slice(0, 500);
  if (!title || !body) throw new Error('ANNOUNCEMENT_PUSH_INVALID');
  const isOwnerLaunchTest = announcement?.push_kind === 'owner_launch_test';
  if (isOwnerLaunchTest) {
    return {
      aps: {
        alert: { title, body },
        sound: 'default',
        category: 'xert.owner-launch-test',
        'thread-id': 'xert-owner-launch-tests',
      },
      xert_push_test: 'owner_launch',
    };
  }
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      category: 'xert.member-notice',
      'thread-id': 'xert-member-notices',
    },
    announcement_id: announcement.id,
    cta_url: clean(announcement.cta_url) || undefined,
  };
}

export function apnsHost(environment) {
  return environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
}

export function sendNotification(
  client,
  subscription,
  announcement,
  config,
  providerToken,
  timeoutMs = APNS_REQUEST_TIMEOUT_MS,
) {
  return sendAPNsAlert(client, subscription, {
    collapseId: `notice-${announcement.id}`,
    expiresAt: announcement.expires_at,
    payload: () => buildAnnouncementPush(announcement),
  }, config, providerToken, timeoutMs);
}

/**
 * Posts one alert to APNs. `payload` is built lazily so a bad payload is an
 * auditable failed result, never a throw. Status 'delivered' means APNs
 * accepted the request (HTTP 200); it is not proof the device showed it.
 */
export async function sendAPNsAlert(
  client,
  subscription,
  options,
  config,
  providerToken,
  timeoutMs = APNS_REQUEST_TIMEOUT_MS,
) {
  const result = await postAPNsAlert(client, subscription.device_token, options, config, providerToken, timeoutMs);
  return { subscription, status: result.status, reason: result.reason };
}

// Errors that mean the request never reached Apple (no connection was made),
// so sending it again cannot duplicate anything.
const NOT_SENT_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_HTTP2_INVALID_SESSION',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/**
 * The same request as sendAPNsAlert, with what a retry policy needs to know:
 *   transport 'response'     APNs answered; httpStatus and reason say what
 *   transport 'not_sent'     the request never left (no connection, or the
 *                            client refused it), so a retry cannot duplicate
 *   transport 'no_response'  the request may have reached Apple but no answer
 *                            came back (timeout, reset): the outcome is unknown
 * `apnsId` (a canonical UUID) is sent as the apns-id header when given.
 */
export function postAPNsAlert(
  client,
  deviceToken,
  { collapseId, expiresAt = null, apnsId = null, payload },
  config,
  providerToken,
  timeoutMs = APNS_REQUEST_TIMEOUT_MS,
) {
  return new Promise(resolve => {
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': collapseId,
    };
    if (apnsId) headers['apns-id'] = String(apnsId).toLowerCase();
    if (expiresAt) {
      const expiresAtSeconds = Math.floor(new Date(expiresAt).getTime() / 1000);
      if (Number.isFinite(expiresAtSeconds)) headers['apns-expiration'] = String(Math.max(0, expiresAtSeconds));
    }
    let statusCode = 0;
    let responseBody = '';
    let settled = false;
    let timeoutId;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };
    const failure = (error, transport) => ({
      status: 'failed',
      reason: clean(error?.message) || 'APNS_NETWORK_ERROR',
      httpStatus: 0,
      transport,
      errorCode: clean(error?.code) || null,
    });
    let request;
    try {
      request = client.request(headers);
    } catch (error) {
      finish(failure(error, 'not_sent'));
      return;
    }
    request.setEncoding('utf8');
    request.on('response', responseHeaders => { statusCode = Number(responseHeaders[':status'] || 0); });
    request.on('data', chunk => { responseBody += chunk; });
    request.on('error', error => {
      const neverConnected = client.connecting === true || NOT_SENT_ERROR_CODES.has(clean(error?.code));
      finish(failure(error, statusCode === 0 && neverConnected ? 'not_sent' : 'no_response'));
    });
    request.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(responseBody || '{}').reason || ''; } catch { reason = ''; }
      finish({
        status: statusCode === 200 ? 'delivered' : INVALID_TOKEN_REASONS.has(reason) ? 'invalid_token' : 'failed',
        reason: reason || (statusCode === 200 ? null : `APNS_HTTP_${statusCode || 'UNKNOWN'}`),
        httpStatus: statusCode,
        transport: statusCode ? 'response' : 'no_response',
        errorCode: null,
      });
    });
    timeoutId = setTimeout(() => {
      finish({ status: 'failed', reason: 'APNS_REQUEST_TIMEOUT', httpStatus: 0, transport: 'no_response', errorCode: null });
      try { request.close(http2.constants.NGHTTP2_CANCEL); } catch { /* stream already closed */ }
    }, Math.max(1, Number(timeoutMs) || APNS_REQUEST_TIMEOUT_MS));
    try {
      request.end(JSON.stringify(typeof payload === 'function' ? payload() : payload));
    } catch (error) {
      // Building the payload or writing the stream failed before anything was sent.
      finish(failure(error, 'not_sent'));
      try { request.close(http2.constants.NGHTTP2_CANCEL); } catch { /* stream already closed */ }
    }
  });
}

export async function loadSubscriptions(admin, targetUserIds = null) {
  const rows = [];
  const pageSize = 500;
  const userIds = Array.isArray(targetUserIds)
    ? [...new Set(targetUserIds.filter(Boolean))]
    : null;
  if (userIds && userIds.length === 0) return rows;

  const userBatches = userIds
    ? Array.from({ length: Math.ceil(userIds.length / TARGET_USER_BATCH_SIZE) }, (_, index) =>
        userIds.slice(index * TARGET_USER_BATCH_SIZE, (index + 1) * TARGET_USER_BATCH_SIZE))
    : [null];
  for (const userBatch of userBatches) {
    for (let from = 0; ; from += pageSize) {
      let query = admin
        .from('push_subscriptions')
        .select('id,user_id,device_token,environment')
        .eq('enabled', true)
        .order('id')
        .range(from, from + pageSize - 1);
      if (userBatch) query = query.in('user_id', userBatch);
      const { data, error } = await query;
      if (error) throw error;
      rows.push(...(data || []));
      if ((data || []).length < pageSize) break;
    }
  }
  return rows;
}

async function saveDeliveryResults(admin, announcementId, results, deliveryReasonPrefix = null) {
  const deliveries = results.map(result => ({
    announcement_id: announcementId,
    subscription_id: result.subscription.id,
    user_id: result.subscription.user_id,
    environment: result.subscription.environment,
    status: result.status,
    reason: deliveryReasonPrefix
      ? `${deliveryReasonPrefix}:${result.reason || result.status.toUpperCase()}`.slice(0, 200)
      : result.reason,
  }));
  for (let index = 0; index < deliveries.length; index += 500) {
    const { error } = await admin.from('push_notification_deliveries').insert(deliveries.slice(index, index + 500));
    if (error) throw error;
  }
  const invalidIds = results.filter(result => result.status === 'invalid_token').map(result => result.subscription.id);
  for (let index = 0; index < invalidIds.length; index += 500) {
    const { error } = await admin.from('push_subscriptions').update({ enabled: false }).in('id', invalidIds.slice(index, index + 500));
    if (error) throw error;
  }
}

export async function sendMemberAnnouncementPushes({
  admin,
  announcement,
  targetUserIds = null,
  environment = process.env,
  targetEnvironments = ['production', 'sandbox'],
  maximumSubscriptions = Number.POSITIVE_INFINITY,
  deliveryAnnouncementId = announcement?.id ?? null,
  deliveryReasonPrefix = null,
}) {
  const config = inspectAPNsEnvironment(environment);
  if (!config.ready) return { configured: false, missing: config.missing, attempted: 0, delivered: 0, failed: 0 };
  const allowedEnvironments = new Set(targetEnvironments);
  const subscriptions = (await loadSubscriptions(admin, targetUserIds))
    .filter(subscription => allowedEnvironments.has(subscription.environment))
    .slice(0, Math.max(0, Number(maximumSubscriptions) || 0));
  if (subscriptions.length === 0) return { configured: true, attempted: 0, delivered: 0, failed: 0 };
  const providerToken = createAPNsProviderToken(config);
  const results = [];

  for (const targetEnvironment of targetEnvironments) {
    const targets = subscriptions.filter(subscription => subscription.environment === targetEnvironment);
    if (targets.length === 0) continue;
    const client = http2.connect(apnsHost(targetEnvironment));
    client.on('error', () => {});
    try {
      for (let index = 0; index < targets.length; index += DELIVERY_BATCH_SIZE) {
        results.push(...await Promise.all(
          targets.slice(index, index + DELIVERY_BATCH_SIZE)
            .map(subscription => sendNotification(client, subscription, announcement, config, providerToken))
        ));
      }
    } finally {
      client.close();
    }
  }

  await saveDeliveryResults(admin, deliveryAnnouncementId, results, deliveryReasonPrefix);
  const delivered = results.filter(result => result.status === 'delivered').length;
  return {
    configured: true,
    attempted: results.length,
    delivered,
    failed: results.length - delivered,
  };
}
