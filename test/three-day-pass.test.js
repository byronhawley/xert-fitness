import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as visits from '../src/lib/casualVisit.js';
import * as checkout from '../api/checkout.js';
import { processStripeEvent } from '../api/stripe-webhook.js';
import { returnPathAfterForm } from '../src/lib/formPrerequisites.js';
import { metadataForPath } from '../src/lib/pageMetadata.js';

const visitor = { first_name: 'Casey', last_name: 'Example', email: 'casey@example.test', phone: '0400111222' };
const responseID = '11111111-1111-4111-8111-111111111111';
const request = { action: 'three_day_pass', ...visitor, questionnaire_response_id: responseID };
const returnURLs = {
  success: 'https://xertfitness.com.au/3daypass?paid=1',
  cancel: 'https://xertfitness.com.au/3daypass?cancelled=1',
};

function paidSession(overrides = {}) {
  return {
    id: 'cs_test_three_day', mode: 'payment', payment_status: 'paid',
    amount_total: 3900, currency: 'aud', customer_email: visitor.email,
    payment_intent: 'pi_test_three_day',
    metadata: {
      xert_casual_visit: 'true', xert_pass_kind: 'three_day_pass', xert_amount_cents: '3900',
      casual_visit_name: 'Casey Example', casual_visit_email: visitor.email,
      casual_visit_phone: '+61400111222', questionnaire_response_id: responseID,
    },
    ...overrides,
  };
}

test('three-day checkout charges the club\'s price in AUD and describes the purchased pass', () => {
  const parameters = visits.casualVisitCheckoutParameters({
    visitor: visits.normalizeCasualVisitor(visitor), passKind: 'three_day_pass',
    priceCents: 3900, currency: 'aud', questionnaireResponseId: responseID, returnURLs,
  });
  assert.equal(parameters.line_items[0].price_data.unit_amount, 3900);
  // The approved amount travels with the session so the webhook can check it.
  assert.equal(parameters.metadata.xert_amount_cents, '3900');
  assert.equal(parameters.line_items[0].price_data.currency, 'aud');
  assert.equal(parameters.line_items[0].price_data.product_data.name, 'XERT Fitness Three Day Pass');
  assert.equal(parameters.line_items[0].price_data.product_data.description, 'Three Day Pass — show your receipt to the XERT team.');
  assert.equal(parameters.metadata.xert_pass_kind, 'three_day_pass');
  assert.equal(parameters.metadata.questionnaire_response_id, responseID);
  assert.equal(parameters.payment_intent_data.metadata.xert_pass_kind, 'three_day_pass');
  assert.equal(parameters.payment_intent_data.description, 'Three Day Pass — Casey Example');
  assert.equal(parameters.metadata.user_id, undefined);
  assert.equal(parameters.metadata.sessions_count, undefined);
});

test('unknown pass variants cannot silently become a casual purchase', () => {
  assert.throws(() => visits.casualVisitCheckoutParameters({
    visitor: visits.normalizeCasualVisitor(visitor), passKind: 'unlimited', priceCents: 1560, returnURLs,
  }), /pass/i);
});

test('paid three-day sessions persist a distinct kind and legacy casual sessions retain their shape', () => {
  const row = visits.casualVisitPaymentFromCheckout(paidSession());
  assert.equal(row.pass_kind, 'three_day_pass');
  assert.equal(row.amount_cents, 3900);
  assert.equal(row.stripe_checkout_session_id, 'cs_test_three_day');
  assert.equal(row.user_id, undefined);
  assert.equal(row.credits, undefined);
  const legacy = paidSession({ metadata: { xert_casual_visit: 'true', casual_visit_name: 'Casey Example' }, amount_total: 1560 });
  assert.equal(visits.casualVisitPaymentFromCheckout(legacy).pass_kind, undefined);
  assert.equal(visits.casualVisitPaymentFromCheckout(legacy).amount_cents, 1560);
  assert.equal(typeof visits.visitorPassLabel, 'function');
  assert.equal(visits.visitorPassLabel(undefined), 'Casual visit');
  assert.equal(visits.visitorPassLabel('three_day_pass'), 'Three Day Pass');
});

test('unpaid or mismatched three-day sessions cannot be recorded as paid passes', () => {
  assert.equal(visits.casualVisitPaymentFromCheckout(paidSession({ payment_status: 'unpaid' })), null);
  for (const change of [
    { amount_total: 1560 }, { currency: 'usd' }, { mode: 'subscription' },
    { metadata: { ...paidSession().metadata, casual_visit_email: '' } },
    { metadata: { ...paidSession().metadata, questionnaire_response_id: '' } },
    { metadata: { ...paidSession().metadata, xert_pass_kind: 'unlimited' } },
  ]) assert.throws(() => visits.casualVisitPaymentFromCheckout(paidSession(change)), /pass|payment|questionnaire/i);
});

test('a different Stripe payer email does not replace the verified three-day participant', () => {
  const payment = visits.casualVisitPaymentFromCheckout(paidSession({
    customer_email: 'payer@example.test',
    customer_details: { email: 'payer@example.test', name: 'Payment Cardholder' },
  }));
  assert.equal(payment.email, visitor.email);
  assert.equal(payment.full_name, 'Casey Example');
  assert.equal(payment.phone, '+61400111222');
  assert.equal(payment.pass_kind, 'three_day_pass');
});

function checkoutDependencies({ proof = true, onFile = true, enabled = true, installed = true } = {}) {
  const created = [];
  const proofCalls = [];
  const lookupCalls = [];
  const admin = {
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; }, limit() { return query; },
        async maybeSingle() {
          if (table === 'admin_settings') return { data: { casual_payments_enabled: enabled }, error: null };
          assert.equal(table, 'xert_schema_capabilities');
          return { data: installed ? { capability: 'three_day_visitor_pass' } : null, error: null };
        },
      };
      return query;
    },
    async rpc(name, payload) {
      if (name === 'xert_visitor_questionnaire_signed') {
        lookupCalls.push(payload);
        return { data: onFile, error: null };
      }
      assert.equal(name, 'xert_visitor_questionnaire_completed');
      proofCalls.push(payload);
      return { data: proof, error: null };
    },
  };
  const stripe = { checkout: { sessions: { async create(parameters, options) {
    created.push({ parameters, options });
    return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
  } } } };
  return { admin, stripe, created, proofCalls, lookupCalls };
}

const declaredRequest = { action: 'three_day_pass', ...visitor, already_signed: true };

test('a repeat visitor who already signed pays without filling the questionnaire in again', async () => {
  const deps = checkoutDependencies();
  const result = await checkout.startThreeDayPassCheckout({
    ...deps, payload: declaredRequest, origin: 'https://xertfitness.com.au', now: 1_800_000_000_000,
  });
  // Their browser forgot the response id long ago, so the server looks the
  // record up by email instead of sending them back through the form.
  assert.deepEqual(deps.lookupCalls, [{ p_email: visitor.email }]);
  assert.deepEqual(deps.proofCalls, []);
  assert.equal(deps.created.length, 1);
  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_new');
  const { parameters } = deps.created[0];
  assert.equal(parameters.metadata.xert_paperwork_verified, 'true');
  assert.equal(parameters.metadata.questionnaire_response_id, undefined);
});

test('a claim with nothing signed on file sends them to the questionnaire instead of selling the pass', async () => {
  const deps = checkoutDependencies({ onFile: false });
  const error = await checkout.startThreeDayPassCheckout({
    ...deps, payload: declaredRequest, origin: 'https://xertfitness.com.au', now: 1_800_000_000_000,
  }).then(() => null, caught => caught);
  assert.ok(error, 'an unscreened visitor must not reach Stripe');
  assert.equal(deps.created.length, 0);
  const failure = checkout.publicCheckoutFailure(error);
  assert.equal(failure.status, 409);
  assert.equal(failure.code, checkout.QUESTIONNAIRE_NOT_ON_FILE);
  assert.match(failure.message, /questionnaire/);
});

test('the three-day page opens the questionnaire when the claim is not on file', () => {
  const page = readFileSync(new URL('../src/pages/CasualVisit.jsx', import.meta.url), 'utf8');
  assert.match(page, /response\.status === 409 && body\.code === QUESTIONNAIRE_NOT_ON_FILE/);
  assert.match(page, /const passReturnKey = threeMonth \? null : threeDayPass \? '3daypass' : tenSessionPack \? '10pack' : 'casual';/);
  assert.match(page, /navigate\(`\/forms\/\$\{CASUAL_PEQ_SLUG\}\?return=\$\{passReturnKey\}`\)/);
});

test('a failed paperwork lookup stops before Stripe instead of guessing', async () => {
  const deps = checkoutDependencies();
  deps.admin.rpc = async () => ({ data: null, error: { message: 'down' } });
  await assert.rejects(checkout.startThreeDayPassCheckout({
    ...deps, payload: declaredRequest, origin: 'https://xertfitness.com.au',
  }));
  assert.equal(deps.created.length, 0);
});

test('a lookup that is not deployed yet flags the sale instead of refusing it', async () => {
  const deps = checkoutDependencies();
  deps.admin.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
  await checkout.startThreeDayPassCheckout({
    ...deps, payload: declaredRequest, origin: 'https://xertfitness.com.au', now: 1_800_000_000_000,
  });
  assert.equal(deps.created.length, 1);
  assert.equal(deps.created[0].parameters.metadata.xert_paperwork_verified, 'false');
});

test('a declared claim is recorded on the paid pass, and only a real one is trusted', () => {
  const declared = { ...paidSession().metadata, xert_paperwork_verified: 'false' };
  delete declared.questionnaire_response_id;
  const row = visits.casualVisitPaymentFromCheckout(paidSession({ metadata: declared }));
  assert.equal(row.pass_kind, 'three_day_pass');
  assert.equal(row.paperwork_verified, false);
  assert.equal(visits.casualVisitPaymentFromCheckout(
    paidSession({ metadata: { ...declared, xert_paperwork_verified: 'true' } }),
  ).paperwork_verified, true);
  // A pass carrying neither a response id nor a checked claim is still refused.
  const unscreened = { ...declared };
  delete unscreened.xert_paperwork_verified;
  assert.throws(() => visits.casualVisitPaymentFromCheckout(paidSession({ metadata: unscreened })),
    /questionnaire/i);
});

test('the three-day page treats "already completed" as an answer, not a detour', () => {
  const page = readFileSync(new URL('../src/pages/CasualVisit.jsx', import.meta.url), 'utf8');
  // The old rule demanded a response id from this browsing session, so a
  // returning visitor was sent back through a form they had already signed.
  assert.match(page, /const needsThreeDayQuestionnaire = threeDayPass && questionnaire !== 'done';/);
  assert.match(page, /threeDayAlreadySigned[\s\S]*?already_signed: true/);
});

test('the paperwork lookup ships as a service-only migration with signature evidence', () => {
  const sql = readFileSync(
    new URL('../supabase/migrations/20260914020000_visitor_pass_already_signed.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.xert_visitor_questionnaire_signed\(p_email text\)/);
  assert.match(sql, /revoke all on function public\.xert_visitor_questionnaire_signed\(text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.xert_visitor_questionnaire_signed\(text\) to service_role/);
  // An existing row is not enough: it has to carry a real signature.
  assert.match(sql, /xert_valid_form_signature/);
  assert.match(sql, /set search_path = ''/);
});

test('the server checks exact signed questionnaire proof before creating an anonymous pass checkout', async () => {
  assert.equal(typeof checkout.startThreeDayPassCheckout, 'function');
  const deps = checkoutDependencies();
  const result = await checkout.startThreeDayPassCheckout({
    ...deps, payload: { ...request, priceCents: 1, currency: 'usd', pass_kind: 'casual' },
    origin: 'https://xertfitness.com.au', now: 1_800_000_000_000,
  });
  assert.deepEqual(deps.proofCalls, [{
    p_response_id: responseID, p_name: 'Casey Example', p_email: visitor.email, p_phone: '+61400111222',
  }]);
  assert.equal(deps.created.length, 1);
  const { parameters, options } = deps.created[0];
  assert.equal(parameters.line_items[0].price_data.unit_amount, 3900);
  assert.equal(parameters.success_url, returnURLs.success);
  assert.equal(parameters.cancel_url, returnURLs.cancel);
  assert.match(options.idempotencyKey, /^three-day-/);
  assert.equal(result.amount_cents, 3900);
  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_new');
});

test('missing proof, rejected signature, absent migration and disabled visitor payments stop before Stripe', async () => {
  assert.equal(typeof checkout.startThreeDayPassCheckout, 'function');
  for (const scenario of [
    { payload: { ...request, questionnaire_response_id: undefined } },
    { payload: { ...request, action: 'unlimited' } },
    { proof: false }, { enabled: false }, { installed: false },
  ]) {
    const deps = checkoutDependencies(scenario);
    await assert.rejects(checkout.startThreeDayPassCheckout({
      ...deps, payload: scenario.payload || request, origin: 'https://xertfitness.com.au',
    }));
    assert.equal(deps.created.length, 0);
  }
});

test('three-day checkout retries keep the same Stripe parameters and key throughout the minute', async () => {
  const deps = checkoutDependencies();
  for (const now of [1_800_000_001_000, 1_800_000_058_000]) {
    await checkout.startThreeDayPassCheckout({ ...deps, payload: request, origin: 'https://xertfitness.com.au', now });
  }
  assert.deepEqual(deps.created[0], deps.created[1]);
});

test('three-day checkout parameter changes never reuse an idempotency key', async () => {
  const deps = checkoutDependencies();
  for (const change of [
    {},
    { payload: { ...request, first_name: 'CASEY' } },
    { payload: { ...request, phone: '0400111333' } },
    { origin: 'https://www.xertfitness.com.au' },
    { now: 1_800_000_061_000 },
  ]) {
    await checkout.startThreeDayPassCheckout({ ...deps, payload: request, origin: 'https://xertfitness.com.au', now: 1_800_000_001_000, ...change });
  }
  assert.equal(new Set(deps.created.map(value => value.options.idempotencyKey)).size, deps.created.length);
});

test('questionnaire return stays on the three-day route and the route has the right page title', () => {
  assert.equal(returnPathAfterForm('?return=3daypass'), '/3daypass');
  assert.equal(returnPathAfterForm('?return=casual'), '/casual');
  assert.equal(returnPathAfterForm('?return=https://evil.example'), null);
  assert.equal(metadataForPath('/3daypass').title, 'Three Day Pass | XERT Fitness');
  assert.equal(metadataForPath('/3daypass').indexable, false);
});

test('visitor input failures stay actionable while provider errors stay private', async () => {
  const deps = checkoutDependencies();
  try {
    await checkout.startThreeDayPassCheckout({ ...deps, payload: { ...request, questionnaire_response_id: '' }, origin: 'https://xertfitness.com.au' });
    assert.fail('missing proof should stop checkout');
  } catch (error) {
    const result = checkout.publicCheckoutFailure(error);
    assert.equal(result.status, 400);
    assert.match(result.message, /questionnaire/);
  }
  assert.equal(checkout.publicCheckoutFailure(new Error('private Stripe transport detail')).message, 'Checkout could not be started. Please try again.');
});

test('paid pass webhook replays settle once and finish their delivery ledger without member fulfilment', async () => {
  const rows = new Map();
  const finished = new Set();
  const calls = [];
  const admin = {
    async rpc(name, payload) {
      calls.push(name);
      if (name === 'begin_stripe_webhook_event') return { data: [{ already_finished: finished.has(payload.p_event_id), attempt_count: 1 }], error: null };
      assert.equal(name, 'finish_stripe_webhook_event', 'no member fulfilment RPC may be called');
      assert.equal(payload.p_status, 'processed');
      finished.add(payload.p_event_id);
      return { error: null };
    },
    from(table) {
      assert.equal(table, 'casual_visit_payments');
      return { async upsert(row, options) {
        assert.equal(options.onConflict, 'stripe_checkout_session_id');
        assert.equal(options.ignoreDuplicates, true, 'replayed payments must not overwrite a refund or an existing receipt');
        if (!rows.has(row.stripe_checkout_session_id)) rows.set(row.stripe_checkout_session_id, row);
        return { error: null };
      } };
    },
  };
  const event = { id: 'evt_three_day', type: 'checkout.session.completed', livemode: false, data: { object: paidSession() } };
  const opts = { secretKey: 'sk_test_fixture' };
  assert.equal((await processStripeEvent(admin, event, opts)).handled, true);
  assert.equal((await processStripeEvent(admin, event, opts)).duplicate, true);
  await processStripeEvent(admin, { ...event, id: 'evt_three_day_retry' }, opts);
  assert.equal(rows.size, 1);
  assert.equal(rows.get('cs_test_three_day').pass_kind, 'three_day_pass');
  assert.equal(finished.size, 2);
});
