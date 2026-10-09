import { createClient } from '@supabase/supabase-js';
import { createRequestTrace, requestHeader, requestText, sendJson } from '../src/lib/serverHttp.js';
import {
  inspectCommerceRuntimeEnvironment,
  stripeModeForSecret,
} from '../src/lib/commerceRuntime.js';
import { createXertStripeClient } from '../src/lib/serverStripeClient.js';
import { casualVisitPaymentFromCheckout } from '../src/lib/casualVisit.js';
import xertosWebhookHandler from '../src/lib/xertosWebhook.js';
import { handleXertosEdit } from '../src/lib/xertosSync.js';

// Stripe calls this after a successful checkout. We verify the signature,
// record the paid order, and grant the member their session credits.

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FULFILLMENT_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);
const FULFILLABLE_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required']);
const FAILURE_EVENT_TYPES = new Set([
  'checkout.session.expired',
  'checkout.session.async_payment_failed',
]);
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function runXertosCalendarEdit(replayRequest, response, { now }) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return sendJson(response, {
      error: {
        code: 'NOT_CONFIGURED',
        message: 'XERT Fitness backend is not configured.',
      },
    }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  return handleXertosEdit(replayRequest, admin, createRequestTrace(response), process.env, now);
}

export function validStripeSignatureHeader(value) {
  const header = String(value || '').trim();
  if (!header || header.length > 4096) return false;
  const parts = header.split(',').map(part => part.trim());
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2);
  const signatures = parts
    .filter(part => part.startsWith('v1='))
    .map(part => part.slice(3));
  return /^\d+$/.test(timestamp || '')
    && signatures.some(signature => /^[a-f0-9]{16,}$/i.test(signature));
}

export function webhookRequestIssue({ contentType, signature, rawBody }) {
  if (!String(contentType || '').toLowerCase().startsWith('application/json')) {
    return { status: 415, message: 'Webhook content type must be application/json.' };
  }
  if (!validStripeSignatureHeader(signature)) {
    return { status: 400, message: 'Invalid webhook signature.' };
  }
  const bodyBytes = Buffer.byteLength(String(rawBody || ''), 'utf8');
  if (bodyBytes === 0) return { status: 400, message: 'Webhook body is required.' };
  if (bodyBytes > MAX_WEBHOOK_BODY_BYTES) {
    return { status: 413, message: 'Webhook body is too large.' };
  }
  return null;
}

export function webhookSigningSecrets(environment = {}) {
  return [
    String(environment.STRIPE_WEBHOOK_SECRET || ''),
    String(environment.STRIPE_WEBHOOK_SECRET_PREVIOUS || ''),
  ].filter(Boolean);
}

export async function constructVerifiedStripeEvent(webhooks, rawBody, signature, secrets) {
  let verificationError;
  for (const [index, secret] of secrets.slice(0, 2).entries()) {
    try {
      return {
        event: await webhooks.constructEventAsync(rawBody, signature, secret),
        usedPreviousSecret: index === 1,
      };
    } catch (error) {
      verificationError = error;
    }
  }
  throw verificationError || new Error('STRIPE_WEBHOOK_SECRET_UNAVAILABLE');
}

export { stripeModeForSecret };

export function assertStripeEventMode(event, secretKey) {
  const keyMode = stripeModeForSecret(secretKey);
  if (keyMode === 'unknown') {
    throw new Error('Stripe secret key mode could not be verified.');
  }
  if (typeof event?.livemode !== 'boolean') {
    throw new Error('Stripe event mode is missing.');
  }
  const eventMode = event.livemode ? 'live' : 'test';
  if (eventMode !== keyMode) {
    throw new Error(`Stripe ${eventMode} event does not match the ${keyMode} secret key.`);
  }
  return keyMode;
}

function parseNonNegativeInteger(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function hasXertCheckoutIdentity(metadata) {
  const attemptID = String(metadata?.xert_checkout_attempt_id || '').trim();
  if (!attemptID) return false;
  if (!UUID_PATTERN.test(attemptID)) {
    throw new Error('XERT checkout identity is invalid.');
  }
  return true;
}

/**
 * Returns the durable order and credit records for a Stripe event, or null
 * when the event does not represent a completed XERT payment.
 */
export function checkoutFulfillmentForEvent(event, now = new Date()) {
  if (!FULFILLMENT_EVENT_TYPES.has(event?.type)) return null;
  const eventCreatedAt = Number.isSafeInteger(event.created) && event.created > 0
    ? new Date(event.created * 1000)
    : now;
  return checkoutFulfillmentForSession(event.data?.object, eventCreatedAt);
}

/**
 * Builds the shared, idempotent order/credit payload from a verified Stripe
 * Checkout Session. Webhooks and explicit admin recovery both use this path.
 */
export function checkoutFulfillmentForSession(checkout, now = new Date()) {

  if (
    !checkout ||
    checkout.mode !== 'payment' ||
    !FULFILLABLE_PAYMENT_STATUSES.has(checkout.payment_status)
  ) {
    return null;
  }

  const metadata = checkout.metadata || {};
  if (!hasXertCheckoutIdentity(metadata)) return null;
  const sessions = parseNonNegativeInteger(metadata.sessions_count);
  const validityDays = parseNonNegativeInteger(metadata.validity_days);
  const latestCharge = typeof checkout.payment_intent === 'object'
    ? checkout.payment_intent?.latest_charge
    : null;
  const chargeCreated = typeof latestCharge === 'object' ? latestCharge?.created : null;
  const paidAt = Number.isSafeInteger(chargeCreated) && chargeCreated > 0
    ? new Date(chargeCreated * 1000)
    : now;

  if (
    !checkout.id ||
    !metadata.user_id ||
    !metadata.product_id ||
    !sessions ||
    validityDays === null ||
    !Number.isSafeInteger(checkout.amount_total) ||
    checkout.amount_total <= 0 ||
    String(checkout.currency || '').toLowerCase() !== 'aud'
  ) {
    throw new Error('Checkout metadata is incomplete or invalid.');
  }

  return {
    order: {
      user_id: metadata.user_id,
      product_id: metadata.product_id,
      email: checkout.customer_details?.email || checkout.customer_email || null,
      amount_cents: checkout.amount_total,
      currency: checkout.currency || 'aud',
      status: 'paid',
      stripe_checkout_session_id: checkout.id,
      stripe_payment_intent_id:
        typeof checkout.payment_intent === 'string'
          ? checkout.payment_intent
          : checkout.payment_intent?.id || null,
      paid_at: paidAt.toISOString(),
    },
    credit: {
      user_id: metadata.user_id,
      product_id: metadata.product_id,
      total: sessions,
      validity_days: validityDays,
      remaining: sessions,
      expires_at:
        validityDays > 0
          ? new Date(paidAt.getTime() + validityDays * 86400000).toISOString()
          : null,
    },
  };
}

export function stripeRefundForEvent(event, now = new Date()) {
  if (event?.type !== 'charge.refunded') return null;
  const charge = event.data?.object;
  const metadata = charge?.metadata || {};
  if (!hasXertCheckoutIdentity(metadata)) return null;
  const operatorReview = stripeOperatorReviewForEvent(event);
  if (operatorReview) {
    const error = new Error('A partial XERT refund requires operator review.');
    error.code = operatorReview.errorCode;
    throw error;
  }
  const paymentIntentId = typeof charge?.payment_intent === 'string'
    ? charge.payment_intent
    : charge?.payment_intent?.id;
  const refunds = charge?.refunds?.data || [];
  const refund = refunds
    .filter(item => item?.status === 'succeeded')
    .sort((left, right) => Number(right?.created || 0) - Number(left?.created || 0))[0];
  if (charge?.refunded !== true || charge?.amount_refunded !== charge?.amount) {
    throw new Error('Full refund status is incomplete or invalid.');
  }
  if (
    !event.id || !charge?.id
    || !Number.isSafeInteger(charge.amount) || charge.amount <= 0
    || !paymentIntentId || !refund?.id
    || !/^[a-z]{3}$/i.test(String(charge.currency || ''))
  ) {
    throw new Error('Full refund data is incomplete or invalid.');
  }
  return {
    p_refund_id: refund.id,
    p_event_id: event.id,
    p_payment_intent_id: paymentIntentId,
    p_charge_id: charge.id,
    p_amount_cents: charge.amount_refunded,
    p_currency: charge.currency,
    p_refunded_at: new Date((refund.created || event.created || Math.floor(now.getTime() / 1000)) * 1000).toISOString(),
  };
}

export function stripeOperatorReviewForEvent(event) {
  if (event?.type !== 'charge.refunded') return null;
  const charge = event.data?.object;
  if (!hasXertCheckoutIdentity(charge?.metadata)) return null;
  if (
    !Number.isSafeInteger(charge?.amount) || charge.amount <= 0
    || !Number.isSafeInteger(charge?.amount_refunded)
    || charge.amount_refunded < 0 || charge.amount_refunded > charge.amount
  ) {
    throw new Error('Refund amount data is incomplete or invalid.');
  }
  if (charge.amount_refunded === 0 || charge.amount_refunded === charge.amount) return null;

  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (!charge.id || !paymentIntentId || !/^[a-z]{3}$/i.test(String(charge.currency || ''))) {
    throw new Error('Partial refund data is incomplete or invalid.');
  }
  return {
    errorCode: 'PARTIAL_REFUND_REQUIRES_REVIEW',
    paymentIntentId,
  };
}

export function stripeDisputeReviewForEvent(event) {
  const isCreated = event?.type === 'charge.dispute.created';
  const isClosed = event?.type === 'charge.dispute.closed';
  if (!isCreated && !isClosed) return null;
  const dispute = event.data?.object;
  const paymentIntentId = typeof dispute?.payment_intent === 'string'
    ? dispute.payment_intent
    : dispute?.payment_intent?.id;
  const chargeId = typeof dispute?.charge === 'string'
    ? dispute.charge
    : dispute?.charge?.id;
  if (
    !event.id || !dispute?.id || !paymentIntentId || !chargeId
    || !Number.isSafeInteger(dispute.amount) || dispute.amount <= 0
    || !/^[a-z]{3}$/i.test(String(dispute.currency || ''))
  ) {
    throw new Error('Stripe dispute data is incomplete or invalid.');
  }
  if (isClosed) {
    if (['won', 'warning_closed'].includes(dispute.status)) return null;
    if (dispute.status !== 'lost') {
      throw new Error('Stripe closed dispute status is incomplete or invalid.');
    }
  }
  return {
    errorCode: isClosed
      ? 'PAYMENT_DISPUTE_LOST_REQUIRES_REVIEW'
      : 'PAYMENT_DISPUTE_REQUIRES_REVIEW',
    paymentIntentId,
  };
}

export async function findStripeOrderForReview(admin, paymentIntentId) {
  const { data, error } = await admin
    .from('orders')
    .select('id')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (error) throw error;
  if (data?.id && !UUID_PATTERN.test(data.id)) {
    throw new Error('Stripe order lookup returned an invalid result.');
  }
  return data?.id || null;
}

export async function recordStripeOperatorReview(admin, event, review, { requireLinkedOrder = false } = {}) {
  const orderId = await findStripeOrderForReview(admin, review.paymentIntentId);
  if (requireLinkedOrder && !orderId) return false;
  await finishStripeWebhookEvent(admin, {
    eventId: event.id,
    status: 'failed',
    orderId,
    errorCode: review.errorCode,
  });
  return true;
}

export async function persistStripeRefund(admin, refund) {
  const { data, error } = await admin.rpc('reconcile_stripe_order_refund', refund);
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export function stripeWebhookErrorCode(error) {
  for (const candidate of [error?.code, error?.type, error?.name]) {
    const value = String(candidate || '').trim();
    if (value.length > 0 && value.length <= 120 && /^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  }
  return 'WEBHOOK_PROCESSING_FAILED';
}

export async function beginStripeWebhookEvent(admin, event, receivedAt = new Date()) {
  const { data, error } = await admin.rpc('begin_stripe_webhook_event', {
    p_event_id: event?.id,
    p_event_type: event?.type,
    p_livemode: event?.livemode,
    p_received_at: receivedAt.toISOString(),
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (typeof result?.already_finished !== 'boolean' || !Number.isSafeInteger(result?.attempt_count)) {
    throw new Error('Stripe webhook ledger returned an invalid result.');
  }
  return result;
}

export async function finishStripeWebhookEvent(admin, {
  eventId, status, orderId = null, errorCode = null, finishedAt = new Date(),
}) {
  const { error } = await admin.rpc('finish_stripe_webhook_event', {
    p_event_id: eventId,
    p_status: status,
    p_order_id: orderId,
    p_error_code: errorCode,
    p_finished_at: finishedAt.toISOString(),
  });
  if (error) throw error;
}

/**
 * Both tables are keyed by Stripe/session order IDs. Retried or concurrent
 * webhook deliveries can safely resume a failed grant without duplicating it.
 */
export function checkoutFulfillmentRPCPayload(fulfillment) {
  return {
    p_checkout_session_id: fulfillment.order.stripe_checkout_session_id,
    p_user_id: fulfillment.order.user_id,
    p_product_id: fulfillment.order.product_id,
    p_email: fulfillment.order.email,
    p_amount_cents: fulfillment.order.amount_cents,
    p_currency: fulfillment.order.currency,
    p_payment_intent_id: fulfillment.order.stripe_payment_intent_id,
    p_paid_at: fulfillment.order.paid_at,
    p_credit_total: fulfillment.credit.total,
    p_credit_validity_days: fulfillment.credit.validity_days,
  };
}

export async function persistCheckoutFulfillment(admin, fulfillment) {
  const { data, error } = await admin.rpc(
    'fulfill_stripe_checkout',
    checkoutFulfillmentRPCPayload(fulfillment)
  );
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.fulfilled_order_id || !['paid', 'refunded'].includes(result.final_status)) {
    throw new Error('Stripe fulfillment transaction returned an invalid result.');
  }
  return result;
}

export function checkoutFailureForEvent(event) {
  if (!FAILURE_EVENT_TYPES.has(event?.type)) return null;
  const checkout = event.data?.object;
  if (!hasXertCheckoutIdentity(checkout?.metadata)) return null;
  if (!checkout?.id || checkout.mode !== 'payment') {
    throw new Error('Failed Checkout Session data is incomplete or invalid.');
  }
  return { stripeCheckoutSessionId: checkout.id };
}

export async function persistCheckoutFailure(admin, failure) {
  const { error } = await admin
    .from('orders')
    .update({ status: 'failed' })
    .eq('stripe_checkout_session_id', failure.stripeCheckoutSessionId)
    .eq('status', 'pending');
  if (error) throw error;
}

/**
 * Processes one Stripe event through XERT's durable, idempotent settlement path.
 * Signed webhook delivery and authenticated owner recovery both call this
 * function so retry behavior cannot drift from normal fulfillment.
 */
export async function processStripeEvent(admin, event, {
  secretKey = process.env.STRIPE_SECRET_KEY,
  receivedAt = new Date(),
} = {}) {
  let ledgerStarted = false;
  try {
    assertStripeEventMode(event, secretKey);
    const attempt = await beginStripeWebhookEvent(admin, event, receivedAt);
    ledgerStarted = true;
    if (attempt.already_finished) {
      return { duplicate: true, requiresReview: false, handled: false, orderId: null };
    }

    let handled = false;
    let orderId = null;

    // A casual visit is a door fee with no account, credit or order behind it.
    // It is recorded on its own, and never enters member fulfilment.
    if (FULFILLMENT_EVENT_TYPES.has(event?.type)) {
      const casualVisit = casualVisitPaymentFromCheckout(event.data?.object);
      if (casualVisit) {
        const { error } = await admin
          .from('casual_visit_payments')
          .upsert(casualVisit, { onConflict: 'stripe_checkout_session_id', ignoreDuplicates: true });
        if (error) throw new Error(`Casual visit payment could not be recorded: ${error.message}`);
        await finishStripeWebhookEvent(admin, { eventId: event.id, status: 'processed', orderId: null });
        return { duplicate: false, requiresReview: false, handled: true, orderId: null };
      }
    }

    const fulfillment = checkoutFulfillmentForEvent(event);
    if (fulfillment) {
      const settlement = await persistCheckoutFulfillment(admin, fulfillment);
      handled = true;
      orderId = settlement.fulfilled_order_id;
    }
    const failure = checkoutFailureForEvent(event);
    if (failure) {
      await persistCheckoutFailure(admin, failure);
      handled = true;
    }
    const disputeReview = stripeDisputeReviewForEvent(event);
    if (disputeReview && await recordStripeOperatorReview(
      admin, event, disputeReview, { requireLinkedOrder: true }
    )) {
      return { duplicate: false, requiresReview: true, handled: true, orderId: null };
    }
    const operatorReview = stripeOperatorReviewForEvent(event);
    if (operatorReview) {
      await recordStripeOperatorReview(admin, event, operatorReview);
      return { duplicate: false, requiresReview: true, handled: true, orderId: null };
    }
    const refund = stripeRefundForEvent(event);
    if (refund) {
      const settlement = await persistStripeRefund(admin, refund);
      handled = true;
      orderId = settlement?.order_id || orderId;
    }
    await finishStripeWebhookEvent(admin, {
      eventId: event.id,
      status: handled ? 'processed' : 'ignored',
      orderId,
    });
    return { duplicate: false, requiresReview: false, handled, orderId };
  } catch (error) {
    if (ledgerStarted) {
      await finishStripeWebhookEvent(admin, {
        eventId: event.id,
        status: 'failed',
        errorCode: stripeWebhookErrorCode(error),
      }).catch(() => {});
    }
    throw error;
  }
}

export default async function handler(request, response) {
  // XertOS rewrites /api/xertos-webhook here so the Hobby deployment keeps its
  // existing twelve-function ceiling. Branch before any Stripe environment or
  // payment client is touched.
  if (request.query?.provider === 'xertos') {
    return xertosWebhookHandler(request, response, { runEdit: runXertosCalendarEdit });
  }

  const trace = createRequestTrace(response);
  const { json, text } = trace;
  if (request.method !== 'POST') return text('Method not allowed', 405);

  if (!inspectCommerceRuntimeEnvironment(process.env, { requireWebhookSecret: true }).ready) {
    return text('Webhook service is unavailable.', 503);
  }

  const stripe = createXertStripeClient(process.env.STRIPE_SECRET_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const signature = requestHeader(request, 'stripe-signature');
  const rawBody = await requestText(request);
  const requestIssue = webhookRequestIssue({
    contentType: requestHeader(request, 'content-type'),
    signature,
    rawBody,
  });
  if (requestIssue) return text(requestIssue.message, requestIssue.status);

  let event;
  try {
    const verification = await constructVerifiedStripeEvent(
      stripe.webhooks,
      rawBody,
      signature,
      webhookSigningSecrets(process.env),
    );
    event = verification.event;
    if (verification.usedPreviousSecret) {
      console.warn('Stripe webhook verified with the previous signing secret.', {
        requestId: trace.requestId,
      });
    }
  } catch (e) {
    console.warn('Stripe webhook signature rejected.', {
      requestId: trace.requestId,
      name: String(e?.name || 'Error'),
      type: String(e?.type || ''),
      code: String(e?.code || ''),
    });
    return text('Invalid webhook signature.', 400);
  }

  try {
    const result = await processStripeEvent(admin, event);
    return json({
      received: true,
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(result.requiresReview ? { requires_review: true } : {}),
    });
  } catch (e) {
    console.error('Stripe webhook processing failed.', {
      requestId: trace.requestId,
      eventId: String(event?.id || ''),
      eventType: String(event?.type || ''),
      name: String(e?.name || 'Error'),
      code: String(e?.code || ''),
    });
    // A generic 500 makes Stripe retry without exposing provider or SQL details.
    return text('Webhook processing failed.', 500);
  }
}
