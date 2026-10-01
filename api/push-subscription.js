import { createClient } from '@supabase/supabase-js';
import { requestHeader, requestJson, sendJson } from '../src/lib/serverHttp.js';
import { STAFF_ROSTER_PUSH_ACTION, staffRosterPushHandler } from '../src/lib/staffRosterPush.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function normalizePushSubscription(body) {
  const action = String(body?.action || 'register').trim().toLowerCase();
  const deviceToken = String(body?.device_token || '').trim().toLowerCase();
  const environment = String(body?.environment || '').trim().toLowerCase();
  if (!['register', 'unregister'].includes(action)) throw new Error('PUSH_ACTION_INVALID');
  if (!/^[0-9a-f]{64,200}$/.test(deviceToken)) throw new Error('PUSH_TOKEN_INVALID');
  if (!['sandbox', 'production'].includes(environment)) throw new Error('PUSH_ENVIRONMENT_INVALID');
  return { action, deviceToken, environment };
}

export function pushSubscriptionClaim(existing, userId) {
  if (!existing) return 'insert';
  if (existing.user_id === userId) return 'refresh';
  if (existing.enabled === false) return 'reassign';
  throw new Error('PUSH_TOKEN_OWNED');
}

export default async function handler(request, response) {
  const json = (body, status = 200) => sendJson(response, body, status);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body = null;
  let bodyError = null;
  try { body = await requestJson(request); } catch (error) { bodyError = error; }
  // Coach roster notices reuse this push endpoint (see src/lib/staffRosterPush.js).
  if (String(body?.action || '').trim().toLowerCase() === STAFF_ROSTER_PUSH_ACTION) return staffRosterPushHandler(request, response);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'Push registration is not configured.' }, 500);

  try {
    const authHeader = requestHeader(request, 'authorization');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return json({ error: 'Not authenticated.' }, 401);
    if (bodyError) throw bodyError;
    const subscription = normalizePushSubscription(body);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return json({ error: 'Invalid or expired session.' }, 401);

    if (subscription.action === 'unregister') {
      const { error } = await admin
        .from('push_subscriptions')
        .update({ enabled: false, last_seen_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('device_token', subscription.deviceToken)
        .eq('environment', subscription.environment);
      if (error) throw error;
      return json({ registered: false });
    }

    const { data: existing, error: existingError } = await admin
      .from('push_subscriptions')
      .select('id,user_id,enabled')
      .eq('device_token', subscription.deviceToken)
      .eq('environment', subscription.environment)
      .maybeSingle();
    if (existingError) throw existingError;

    const claim = pushSubscriptionClaim(existing, user.id);
    const now = new Date().toISOString();
    if (claim === 'insert') {
      const { error } = await admin.from('push_subscriptions').insert({
        user_id: user.id,
        device_token: subscription.deviceToken,
        environment: subscription.environment,
        enabled: true,
        last_seen_at: now,
      });
      if (error?.code === '23505') throw new Error('PUSH_TOKEN_OWNED');
      if (error) throw error;
    } else {
      let update = admin
        .from('push_subscriptions')
        .update({ user_id: user.id, enabled: true, last_seen_at: now })
        .eq('id', existing.id);
      update = claim === 'refresh'
        ? update.eq('user_id', user.id)
        : update.eq('enabled', false);
      const { data: updated, error } = await update.select('id').maybeSingle();
      if (error) throw error;
      if (!updated) throw new Error('PUSH_TOKEN_OWNED');
    }
    return json({ registered: true });
  } catch (error) {
    if (['PUSH_ACTION_INVALID', 'PUSH_TOKEN_INVALID', 'PUSH_ENVIRONMENT_INVALID'].includes(error.message)) {
      return json({ error: 'Push subscription is invalid.' }, 400);
    }
    if (error.message === 'PUSH_TOKEN_OWNED') {
      return json({
        error: 'This device is still linked to another XERT account. Sign out of that account on this device, then try again.',
      }, 409);
    }
    return json({ error: 'Push subscription could not be updated.' }, 500);
  }
}
