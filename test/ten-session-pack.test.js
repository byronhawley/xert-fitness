import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { createServer } from 'vite';
import * as visits from '../src/lib/casualVisit.js';
import * as checkout from '../api/checkout.js';
import { processStripeEvent } from '../api/stripe-webhook.js';
import { formPath, returnKeyAfterForm, returnPathAfterForm } from '../src/lib/formPrerequisites.js';
import { metadataForPath } from '../src/lib/pageMetadata.js';
import { VISITOR_PASS_CHOICES, visitorPassChoices, visitorPassURL } from '../src/lib/visitorPassChoices.js';
import {
  launchSettingsChanged, normalizeLaunchSettings, normalizeVisitorPricing,
  VISITOR_PRICE_FIELDS, visitorPriceFieldInstalled,
} from '../src/lib/launchSettings.js';

// The 10 Session Pack is sold exactly like the Three Day Pass: a visitor page
// at /10pack, the casual questionnaire first, a price the club sets, and a
// receipt the team arranges the sessions from. No account, no order, no
// member credits — the one thing it must never become is a member session
// pack, and the other thing it must never become is a casual visit.

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const visitor = { first_name: 'Casey', last_name: 'Example', email: 'casey@example.test', phone: '0400111222' };
const responseID = '11111111-1111-4111-8111-111111111111';
const request = { action: 'ten_session_pack', ...visitor, questionnaire_response_id: responseID };
const declaredRequest = { action: 'ten_session_pack', ...visitor, already_signed: true };
const origin = 'https://xertfitness.com.au';
const returnURLs = {
  success: 'https://xertfitness.com.au/10pack?paid=1',
  cancel: 'https://xertfitness.com.au/10pack?cancelled=1',
};

function paidSession(overrides = {}) {
  return {
    id: 'cs_test_ten_pack', mode: 'payment', payment_status: 'paid',
    amount_total: 12240, currency: 'aud', customer_email: visitor.email,
    payment_intent: 'pi_test_ten_pack',
    metadata: {
      xert_casual_visit: 'true', xert_pass_kind: 'ten_session_pack', xert_amount_cents: '12240',
      casual_visit_name: 'Casey Example', casual_visit_email: visitor.email,
      casual_visit_phone: '+61400111222', questionnaire_response_id: responseID,
    },
    ...overrides,
  };
}

// A fake database that answers the capability lookup only when it is asked
// for the 10 Session Pack's own capability, so a gate copied from the Three
// Day Pass ('three_day_visitor_pass') fails here instead of in production.
function checkoutDependencies({
  proof = true, proofError = null, onFile = true, lookupError = null,
  settings = { casual_payments_enabled: true }, settingsError = null,
  installed = true, capabilityError = null,
  sessionURL = 'https://checkout.stripe.com/c/pay/cs_test_new',
} = {}) {
  const created = [];
  const proofCalls = [];
  const lookupCalls = [];
  const capabilityLookups = [];
  const admin = {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        limit() { return query; },
        async maybeSingle() {
          if (table === 'admin_settings') return { data: settings, error: settingsError };
          assert.equal(table, 'xert_schema_capabilities');
          capabilityLookups.push(filters);
          const asked = filters.find(([column]) => column === 'capability')?.[1];
          return { data: installed && asked === 'ten_session_pack' ? { capability: asked } : null, error: capabilityError };
        },
      };
      return query;
    },
    async rpc(name, payload) {
      if (name === 'xert_visitor_questionnaire_signed') {
        lookupCalls.push(payload);
        return { data: lookupError ? null : onFile, error: lookupError };
      }
      assert.equal(name, 'xert_visitor_questionnaire_completed', `unexpected RPC ${name}`);
      proofCalls.push(payload);
      return { data: proofError ? null : proof, error: proofError };
    },
  };
  const stripe = { checkout: { sessions: { async create(parameters, options) {
    created.push({ parameters, options });
    return { id: 'cs_test_new', url: sessionURL };
  } } } };
  return { admin, stripe, created, proofCalls, lookupCalls, capabilityLookups };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return checkout.publicCheckoutFailure(error);
  }
  return assert.fail('expected the checkout to stop');
}

test('the 10 Session Pack is a screened visitor pass that defaults to $122.40', () => {
  assert.equal(visits.TEN_SESSION_PACK_ACTION, 'ten_session_pack');
  assert.equal(visits.TEN_SESSION_PACK_PRICE_CENTS, 12240);
  const pass = visits.visitorPass('ten_session_pack');
  assert.equal(pass, visits.VISITOR_PASSES.ten_session_pack);
  assert.equal(pass.label, '10 Session Pack');
  assert.equal(pass.productName, 'XERT Fitness 10 Session Pack');
  assert.equal(pass.productDescription, '10 Session Pack — show your receipt to the XERT team.');
  assert.equal(pass.needsSignedQuestionnaire, true, 'nobody buys a pack of sessions unscreened');
  assert.equal(pass.priceField, 'ten_session_pack_price_cents');
  assert.equal(pass.discountField, 'ten_session_pack_discount_cents');
  assert.equal(pass.discountEnabledField, 'ten_session_pack_discount_enabled');
  assert.equal(pass.defaultPriceCents, 12240);
  assert.ok(Object.isFrozen(pass));
  // Nothing about how long the sessions last or when they run out.
  assert.doesNotMatch(`${pass.label} ${pass.productName} ${pass.productDescription}`, /minute|hour|week|month|expir|valid|credit/i);
  assert.deepEqual(visits.visitorPassPricing('ten_session_pack', {}), { full: 12240, charge: 12240, discounted: false });
  assert.equal(visits.formatCasualVisitPrice(12240), '$122.40');
});

test('the club\'s own 10 Session Pack price and discount are what get charged', () => {
  const price = settings => visits.visitorPassPricing('ten_session_pack', settings);
  assert.deepEqual(price({ ten_session_pack_price_cents: 13000 }), { full: 13000, charge: 13000, discounted: false });
  assert.deepEqual(price({
    ten_session_pack_price_cents: 12240, ten_session_pack_discount_cents: 11000, ten_session_pack_discount_enabled: true,
  }), { full: 12240, charge: 11000, discounted: true });
  // A discount that is set but off, not cheaper, or out of range is ignored.
  assert.equal(price({ ten_session_pack_discount_cents: 11000, ten_session_pack_discount_enabled: false }).charge, 12240);
  assert.equal(price({ ten_session_pack_discount_cents: 13000, ten_session_pack_discount_enabled: true }).charge, 12240);
  assert.equal(price({ ten_session_pack_discount_cents: 50, ten_session_pack_discount_enabled: true }).charge, 12240);
  assert.equal(price({ ten_session_pack_price_cents: 50 }).charge, 12240, 'a price outside $1 to $1,000 falls back');
  // The other passes still read their own columns.
  assert.equal(visits.visitorPassPricing('three_day_pass', { ten_session_pack_price_cents: 13000 }).charge, 3900);
  assert.equal(visits.visitorPassPricing('casual_visit', { ten_session_pack_price_cents: 13000 }).charge, 1560);
  assert.equal(price({ three_day_pass_price_cents: 4000, three_day_pass_discount_cents: 1000, three_day_pass_discount_enabled: true }).charge, 12240);
});

test('10 Session Pack checkout parameters describe the pack and carry no member identity', () => {
  const parameters = visits.casualVisitCheckoutParameters({
    visitor: visits.normalizeCasualVisitor(visitor), passKind: 'ten_session_pack',
    priceCents: 12240, currency: 'aud', questionnaireResponseId: responseID, returnURLs,
  });
  const [line] = parameters.line_items;
  assert.equal(parameters.mode, 'payment');
  assert.equal(line.price_data.unit_amount, 12240);
  assert.equal(line.price_data.currency, 'aud');
  assert.equal(line.price_data.product_data.name, 'XERT Fitness 10 Session Pack');
  assert.equal(line.price_data.product_data.description, '10 Session Pack — show your receipt to the XERT team.');
  assert.equal(parameters.payment_intent_data.description, '10 Session Pack — Casey Example');
  for (const metadata of [parameters.metadata, parameters.payment_intent_data.metadata]) {
    assert.equal(metadata.xert_casual_visit, 'true');
    assert.equal(metadata.xert_pass_kind, 'ten_session_pack');
    assert.equal(metadata.xert_amount_cents, '12240');
    assert.equal(metadata.questionnaire_response_id, responseID);
    // Any of these would route the payment into member credit fulfilment.
    assert.equal(metadata.user_id, undefined);
    assert.equal(metadata.sessions_count, undefined);
    assert.equal(metadata.xert_checkout_attempt_id, undefined);
  }
  assert.equal(parameters.metadata.casual_visit_email, visitor.email);
});

test('10 Session Pack parameters refuse a purchase with no screening behind it', () => {
  const base = { visitor: visits.normalizeCasualVisitor(visitor), passKind: 'ten_session_pack', priceCents: 12240, returnURLs };
  assert.throws(() => visits.casualVisitCheckoutParameters(base), /pre-exercise questionnaire/);
  assert.throws(() => visits.casualVisitCheckoutParameters({ ...base, questionnaireResponseId: 'not-a-response' }), /pre-exercise questionnaire/);
  // A checked "already signed" claim carries its verdict instead of an id.
  const declared = visits.casualVisitCheckoutParameters({ ...base, paperworkVerified: false });
  assert.equal(declared.metadata.xert_paperwork_verified, 'false');
  assert.equal(declared.metadata.questionnaire_response_id, undefined);
});

test('a paid 10 Session Pack is recorded under its own kind, for the verified participant', () => {
  const row = visits.casualVisitPaymentFromCheckout(paidSession({
    customer_email: 'payer@example.test',
    customer_details: { email: 'payer@example.test', name: 'Payment Cardholder' },
  }));
  assert.equal(row.pass_kind, 'ten_session_pack');
  assert.equal(row.amount_cents, 12240);
  assert.equal(row.currency, 'aud');
  assert.equal(row.email, visitor.email);
  assert.equal(row.full_name, 'Casey Example');
  assert.equal(row.phone, '+61400111222');
  assert.equal(row.status, 'paid');
  assert.equal(row.stripe_checkout_session_id, 'cs_test_ten_pack');
  assert.equal(row.stripe_payment_intent_id, 'pi_test_ten_pack');
  assert.equal(row.paperwork_verified, undefined, 'signed as part of the purchase, so nothing for staff to check');
  assert.equal(row.user_id, undefined);
  assert.equal(row.credits, undefined);

  const declared = { ...paidSession().metadata, xert_paperwork_verified: 'false' };
  delete declared.questionnaire_response_id;
  assert.equal(visits.casualVisitPaymentFromCheckout(paidSession({ metadata: declared })).paperwork_verified, false);
  assert.equal(visits.casualVisitPaymentFromCheckout(paidSession({ metadata: { ...declared, xert_paperwork_verified: 'true' } })).paperwork_verified, true);
});

test('an unpaid or mismatched 10 Session Pack is never recorded as paid', () => {
  assert.equal(visits.casualVisitPaymentFromCheckout(paidSession({ payment_status: 'unpaid' })), null);
  const unscreened = { ...paidSession().metadata };
  delete unscreened.questionnaire_response_id;
  for (const change of [
    { amount_total: 1560 }, { amount_total: 3900 }, { currency: 'usd' }, { mode: 'subscription' },
    { metadata: { ...paidSession().metadata, xert_amount_cents: '1560' } },
    { metadata: { ...paidSession().metadata, casual_visit_email: '' } },
    { metadata: { ...paidSession().metadata, questionnaire_response_id: '' } },
    { metadata: unscreened },
  ]) {
    assert.throws(() => visits.casualVisitPaymentFromCheckout(paidSession(change)),
      /10 Session Pack payment does not match the approved pass or questionnaire/, JSON.stringify(change));
  }
});

test('the server checks the signed casual questionnaire, then charges the settings price and returns to /10pack', async () => {
  const deps = checkoutDependencies();
  const result = await checkout.startTenSessionPackCheckout({
    ...deps, payload: { ...request, priceCents: 1, currency: 'usd', pass_kind: 'casual' },
    origin, now: 1_800_000_000_000,
  });
  assert.deepEqual(deps.capabilityLookups, [[['capability', 'ten_session_pack']]]);
  assert.deepEqual(deps.proofCalls, [{
    p_response_id: responseID, p_name: 'Casey Example', p_email: visitor.email, p_phone: '+61400111222',
  }]);
  assert.deepEqual(deps.lookupCalls, []);
  assert.equal(deps.created.length, 1);
  const { parameters, options } = deps.created[0];
  // Whatever the browser sent, the price, currency and kind are the server's.
  assert.equal(parameters.line_items[0].price_data.unit_amount, 12240);
  assert.equal(parameters.line_items[0].price_data.currency, 'aud');
  assert.equal(parameters.metadata.xert_pass_kind, 'ten_session_pack');
  assert.equal(parameters.metadata.questionnaire_response_id, responseID);
  assert.equal(parameters.metadata.xert_paperwork_verified, undefined);
  assert.equal(parameters.success_url, returnURLs.success);
  assert.equal(parameters.cancel_url, returnURLs.cancel);
  assert.match(options.idempotencyKey, /^ten-session-pack-[0-9a-f]{64}$/);
  assert.deepEqual(result, { url: 'https://checkout.stripe.com/c/pay/cs_test_new', amount_cents: 12240 });
});

test('the 10 Session Pack charges the price and discount set in Settings', async () => {
  for (const [settings, expected] of [
    [{ ten_session_pack_price_cents: 13000 }, 13000],
    [{ ten_session_pack_price_cents: 12240, ten_session_pack_discount_cents: 11000, ten_session_pack_discount_enabled: true }, 11000],
    [{ ten_session_pack_price_cents: 12240, ten_session_pack_discount_cents: 11000, ten_session_pack_discount_enabled: false }, 12240],
    [{ ten_session_pack_price_cents: 12240, ten_session_pack_discount_cents: 13000, ten_session_pack_discount_enabled: true }, 12240],
    // Another pass's price or discount never leaks into this one.
    [{ three_day_pass_price_cents: 4000, three_day_pass_discount_cents: 1000, three_day_pass_discount_enabled: true }, 12240],
  ]) {
    const deps = checkoutDependencies({ settings: { casual_payments_enabled: true, ...settings } });
    const result = await checkout.startTenSessionPackCheckout({ ...deps, payload: request, origin, now: 1_800_000_000_000 });
    assert.equal(deps.created[0].parameters.line_items[0].price_data.unit_amount, expected, JSON.stringify(settings));
    assert.equal(deps.created[0].parameters.metadata.xert_amount_cents, String(expected));
    assert.equal(result.amount_cents, expected, 'the amount reported is exactly what Stripe was asked to charge');
  }
});

test('a returning visitor who already signed pays without the form, and the claim is checked by email', async () => {
  const deps = checkoutDependencies();
  await checkout.startTenSessionPackCheckout({ ...deps, payload: declaredRequest, origin, now: 1_800_000_000_000 });
  assert.deepEqual(deps.lookupCalls, [{ p_email: visitor.email }]);
  assert.deepEqual(deps.proofCalls, []);
  assert.equal(deps.created.length, 1);
  assert.equal(deps.created[0].parameters.metadata.xert_paperwork_verified, 'true');
  assert.equal(deps.created[0].parameters.metadata.questionnaire_response_id, undefined);
});

test('an unproven claim, or a lookup not deployed yet, still sells the pack and flags it for staff', async () => {
  for (const scenario of [{ onFile: false }, { onFile: null }, { lookupError: { code: 'PGRST202', message: 'function not found' } }]) {
    const deps = checkoutDependencies(scenario);
    await checkout.startTenSessionPackCheckout({ ...deps, payload: declaredRequest, origin, now: 1_800_000_000_000 });
    assert.equal(deps.created.length, 1, `payment must not be blocked: ${JSON.stringify(scenario)}`);
    assert.equal(deps.created[0].parameters.metadata.xert_paperwork_verified, 'false');
  }
});

test('a failed paperwork lookup or proof check stops before Stripe instead of guessing', async () => {
  for (const [scenario, payload] of [
    [{ lookupError: { code: '57014', message: 'canceling statement' } }, declaredRequest],
    [{ proofError: { message: 'down' } }, request],
  ]) {
    const deps = checkoutDependencies(scenario);
    const result = await failure(checkout.startTenSessionPackCheckout({ ...deps, payload, origin }));
    assert.equal(result.status, 503);
    assert.match(result.message, /questionnaire could not be checked/);
    assert.equal(deps.created.length, 0);
  }
});

test('missing or rejected proof, the wrong action, an absent migration and switched-off visitor payments all stop before Stripe', async () => {
  for (const [scenario, status, message] of [
    [{ payload: { ...request, questionnaire_response_id: undefined } }, 400, /Complete and sign the pre-exercise questionnaire/],
    [{ payload: { ...request, questionnaire_response_id: 'not-a-response' } }, 400, /Complete and sign the pre-exercise questionnaire/],
    [{ payload: { ...request, already_signed: 'true', questionnaire_response_id: undefined } }, 400, /Complete and sign the pre-exercise questionnaire/],
    [{ payload: { ...request, action: 'three_day_pass' } }, 400, /This visitor pass is not available/],
    [{ payload: { ...request, action: 'unlimited' } }, 400, /This visitor pass is not available/],
    [{ payload: { ...request, action: undefined } }, 400, /This visitor pass is not available/],
    [{ payload: { ...request, email: 'not-an-email' } }, 400, /email/],
    [{ proof: false }, 400, /using these same contact details/],
    [{ installed: false }, 503, /^10 Session Pack payments are unavailable right now\.$/],
    [{ capabilityError: { message: 'down' } }, 503, /^10 Session Pack payments are unavailable right now\.$/],
    [{ settings: null }, 503, /^10 Session Pack payments are unavailable right now\.$/],
    [{ settingsError: { message: 'down' } }, 503, /^10 Session Pack payments are unavailable right now\.$/],
    [{ settings: { casual_payments_enabled: false } }, 503, /Visitor payments are switched off/],
  ]) {
    const deps = checkoutDependencies(scenario);
    const result = await failure(checkout.startTenSessionPackCheckout({
      ...deps, payload: scenario.payload || request, origin, now: 1_800_000_000_000,
    }));
    assert.equal(result.status, status, JSON.stringify(scenario));
    assert.match(result.message, message, JSON.stringify(scenario));
    assert.equal(deps.created.length, 0);
  }
});

test('only the Visitor payments switch controls the pack, never the session pack payments switch', async () => {
  // Member checkout paused, visitor payments on: the pack still sells.
  const open = checkoutDependencies({ settings: { casual_payments_enabled: true, payments_enabled: false, bookings_enabled: false } });
  await checkout.startTenSessionPackCheckout({ ...open, payload: request, origin, now: 1_800_000_000_000 });
  assert.equal(open.created.length, 1);
  // Member checkout live, visitor payments off: the pack does not.
  const closed = checkoutDependencies({ settings: { casual_payments_enabled: false, payments_enabled: true, bookings_enabled: true } });
  assert.equal((await failure(checkout.startTenSessionPackCheckout({ ...closed, payload: request, origin }))).status, 503);
  assert.equal(closed.created.length, 0);

  const api = read('../api/checkout.js');
  const start = api.indexOf('export async function startTenSessionPackCheckout');
  const body = api.slice(start, api.indexOf('\n}\n', start));
  assert.match(body, /settings\.casual_payments_enabled === false/);
  assert.doesNotMatch(body, /(?<!casual_)payments_enabled|paymentActivation|fulfil/i);
});

test('a payment page that is not Stripe\'s own secure checkout is refused', async () => {
  for (const sessionURL of [
    'http://checkout.stripe.com/c/pay/cs_test_new',
    'https://evil.example/c/pay/cs_test_new',
    'https://checkout.stripe.com:8443/c/pay/cs_test_new',
    'https://user:secret@checkout.stripe.com/c/pay/cs_test_new',
  ]) {
    const deps = checkoutDependencies({ sessionURL });
    const result = await failure(checkout.startTenSessionPackCheckout({ ...deps, payload: request, origin, now: 1_800_000_000_000 }));
    assert.equal(result.status, 502, sessionURL);
    assert.equal(result.message, 'Stripe did not return a secure payment page.');
  }
});

test('10 Session Pack retries reuse one Stripe key within the minute, and any change gets a new one', async () => {
  const same = checkoutDependencies();
  for (const now of [1_800_000_001_000, 1_800_000_058_000]) {
    await checkout.startTenSessionPackCheckout({ ...same, payload: request, origin, now });
  }
  assert.deepEqual(same.created[0], same.created[1]);

  const changed = checkoutDependencies();
  for (const change of [
    {},
    { payload: { ...request, first_name: 'CASEY' } },
    { payload: { ...request, phone: '0400111333' } },
    { payload: declaredRequest },
    { origin: 'https://www.xertfitness.com.au' },
    { now: 1_800_000_061_000 },
  ]) {
    await checkout.startTenSessionPackCheckout({ ...changed, payload: request, origin, now: 1_800_000_001_000, ...change });
  }
  const keys = changed.created.map(value => value.options.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^ten-session-pack-/);
});

test('the API sends the 10 Session Pack to its own visitor checkout before any member sign-in is asked for', () => {
  const api = read('../api/checkout.js');
  const dispatch = api.indexOf('if (payload?.action === TEN_SESSION_PACK_ACTION) {');
  const tokenCheck = api.indexOf("if (!token) return json({ error: 'Not authenticated.' }, 401);");
  assert.ok(dispatch > 0 && tokenCheck > dispatch, 'a visitor has no account, so the pack must be dispatched before the token check');
  assert.ok(api.indexOf('return json(await startTenSessionPackCheckout({', dispatch) < tokenCheck);
  assert.ok(api.indexOf('const authHeader = requestHeader(request, \'authorization\');') > dispatch);
  // Gated on its own capability and priced from settings, like the other passes.
  assert.match(api, /\.eq\('capability', 'ten_session_pack'\)/);
  assert.match(api, /visitorPassPricing\(TEN_SESSION_PACK_ACTION, settings\)\.charge/);
  assert.match(api, /new URL\('\/10pack\?paid=1', origin\)/);
  assert.match(api, /new URL\('\/10pack\?cancelled=1', origin\)/);
  assert.match(api, /idempotencyKey: `ten-session-pack-\$\{fingerprint\}`/);
  // The existing visitor dispatches are still where they were.
  assert.match(api, /if \(payload && payload\.action === CASUAL_VISIT_ACTION\) \{/);
  assert.match(api, /if \(payload\?\.action === THREE_DAY_PASS_ACTION\) \{/);
  assert.match(api, /idempotencyKey: `three-day-\$\{fingerprint\}`/);
});

test('visitor input failures stay actionable while provider errors stay private', async () => {
  const deps = checkoutDependencies();
  const result = await failure(checkout.startTenSessionPackCheckout({ ...deps, payload: { ...request, questionnaire_response_id: '' }, origin }));
  assert.equal(result.status, 400);
  assert.match(result.message, /questionnaire/);
  const stripeDown = checkoutDependencies();
  stripeDown.stripe.checkout.sessions.create = async () => { throw new Error('private Stripe transport detail'); };
  const hidden = await failure(checkout.startTenSessionPackCheckout({ ...stripeDown, payload: request, origin }));
  assert.equal(hidden.message, 'Checkout could not be started. Please try again.');
});

test('paid 10 Session Pack webhook replays settle once without member fulfilment', async () => {
  const rows = new Map();
  const finished = new Set();
  const admin = {
    async rpc(name, payload) {
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
        assert.equal(options.ignoreDuplicates, true);
        if (!rows.has(row.stripe_checkout_session_id)) rows.set(row.stripe_checkout_session_id, row);
        return { error: null };
      } };
    },
  };
  const event = { id: 'evt_ten_pack', type: 'checkout.session.completed', livemode: false, data: { object: paidSession() } };
  const opts = { secretKey: 'sk_test_fixture' };
  assert.equal((await processStripeEvent(admin, event, opts)).handled, true);
  assert.equal((await processStripeEvent(admin, event, opts)).duplicate, true);
  await processStripeEvent(admin, { ...event, id: 'evt_ten_pack_retry' }, opts);
  assert.equal(rows.size, 1);
  assert.equal(rows.get('cs_test_ten_pack').pass_kind, 'ten_session_pack');
  assert.equal(rows.get('cs_test_ten_pack').amount_cents, 12240);
  assert.equal(finished.size, 2);
});

test('the questionnaire hands back to /10pack, and the page is reachable but never indexed', () => {
  assert.equal(returnPathAfterForm('?return=10pack'), '/10pack');
  assert.equal(returnKeyAfterForm('?return=10pack'), '10pack');
  assert.equal(formPath('peq-casual', null, '10pack'), '/forms/peq-casual?return=10pack');
  // The existing return keys still work, and nothing else is let through.
  assert.equal(returnPathAfterForm('?return=3daypass'), '/3daypass');
  assert.equal(returnPathAfterForm('?return=casual'), '/casual');
  assert.equal(returnPathAfterForm('?return=3months'), '/3months');
  for (const hostile of ['?return=https://evil.example', '?return=//evil.example', '?return=/10pack', '?return=10Pack', '?return=constructor']) {
    assert.equal(returnPathAfterForm(hostile), null, hostile);
  }
  assert.equal(formPath('peq-casual', null, '/10pack'), '/forms/peq-casual');

  const meta = metadataForPath('/10pack');
  assert.equal(meta.title, '10 Session Pack | XERT Fitness');
  assert.equal(meta.indexable, false);
  assert.equal(metadataForPath('/10pack/').title, '10 Session Pack | XERT Fitness');
  assert.ok(!read('../public/sitemap.xml').includes('/10pack'), 'a front-desk page stays out of the sitemap');
  assert.match(read('../src/App.jsx'), /<Route path="\/10pack" element=\{<CasualVisit key="ten-session-pack" tenSessionPack \/>\} \/>/);
});

test('the pack is offered with the other passes, with its own QR on /memberships and at the front desk', () => {
  const choice = VISITOR_PASS_CHOICES.find(entry => entry.kind === 'ten_session_pack');
  assert.ok(choice, 'the 10 Session Pack is one of the ways to pay');
  assert.equal(choice.path, '/10pack');
  assert.equal(choice.label, '10 Session Pack');
  assert.ok(choice.blurb);
  assert.doesNotMatch(choice.blurb, /minute|hour|week|month|expir|valid|credit/i);
  assert.equal(visitorPassURL(choice, 'https://www.xertfitness.com.au'), 'https://www.xertfitness.com.au/10pack');
  assert.deepEqual(VISITOR_PASS_CHOICES.map(entry => entry.path), ['/casual', '/3daypass', '/10pack', '/3months']);
  const priced = visitorPassChoices({}).find(entry => entry.kind === 'ten_session_pack');
  assert.equal(priced.charge, 12240);

  const memberships = read('../src/pages/Memberships.jsx');
  assert.match(memberships, /10 Session Pack/);
  assert.match(memberships, /<PassQRCode url=\{visitorPassURL\(choice, origin\)\} label=\{choice\.label\} \/>/);
  assert.ok(!/\$\d/.test(memberships), 'prices come from settings, never typed into the page');

  const orders = read('../src/components/admin/OrdersManager.jsx');
  assert.match(orders, /slug: 'ten-session-pack', path: '\/10pack', title: '10 Session Pack',/);
  assert.match(orders, /qrTitle: '10 Session Pack QR'/);
});

test('the owner payments list names an unknown pass instead of breaking, while checkout still refuses it', () => {
  assert.equal(visits.visitorPassLabel('ten_session_pack'), '10 Session Pack');
  assert.equal(visits.visitorPassLabel(undefined), 'Casual visit');
  assert.equal(visits.visitorPassLabel('casual'), 'Casual visit');
  assert.equal(visits.visitorPassLabel('three_day_pass'), 'Three Day Pass');
  assert.equal(visits.visitorPassLabel('three_month_membership'), 'Three month membership');
  assert.equal(visits.visitorPassLabel('twenty_session_pack'), 'Visitor pass (twenty session pack)');
  assert.equal(visits.visitorPassLabel('constructor'), 'Visitor pass (constructor)');
  assert.equal(visits.visitorPassLabel(''), 'Visitor pass');
  assert.equal(visits.visitorPassLabel(null), 'Visitor pass');

  assert.throws(() => visits.visitorPass('twenty_session_pack'), /This visitor pass is not available/);
  assert.throws(() => visits.casualVisitCheckoutParameters({
    visitor: visits.normalizeCasualVisitor(visitor), passKind: 'twenty_session_pack', priceCents: 12240,
    questionnaireResponseId: responseID, returnURLs,
  }), /This visitor pass is not available/);
  assert.throws(() => visits.casualVisitPaymentFromCheckout(paidSession({
    metadata: { ...paidSession().metadata, xert_pass_kind: 'twenty_session_pack' },
  })), /This visitor pass is not available/);

  assert.match(read('../src/components/admin/OrdersManager.jsx'), /\{visitorPassLabel\(visit\.pass_kind\)\}/);
});

test('Settings edits the 10 Session Pack price only once its columns exist', () => {
  const field = VISITOR_PRICE_FIELDS.find(entry => entry.price === 'ten_session_pack_price_cents');
  assert.deepEqual({ ...field }, {
    key: 'ten-pack', label: '10 Session Pack',
    price: 'ten_session_pack_price_cents', discount: 'ten_session_pack_discount_cents',
    enabled: 'ten_session_pack_discount_enabled', fallback: 12240, optionalColumn: true,
  });
  assert.deepEqual(VISITOR_PRICE_FIELDS.map(entry => entry.key), ['casual', 'three-day', 'ten-pack', 'three-month']);
  for (const other of VISITOR_PRICE_FIELDS.filter(entry => entry !== field)) {
    assert.equal(other.optionalColumn, undefined, `${other.label} is always saved`);
  }

  // Before the migration: nothing about the pack is sent, so the save the
  // database would otherwise refuse still goes through for everything else.
  const before = normalizeLaunchSettings({ target_launch_date: '2026-10-16', casual_payments_enabled: false });
  assert.equal(before.casual_payments_enabled, false);
  assert.deepEqual(Object.keys(before).filter(key => key.startsWith('ten_session_pack')), []);
  assert.equal(visitorPriceFieldInstalled(field, {}), false);
  assert.equal(visitorPriceFieldInstalled(field, null), false);

  // After it: the loaded row carries the column, and all three are saved.
  const after = normalizeLaunchSettings({ target_launch_date: '2026-10-16', ten_session_pack_price_cents: 12240 });
  assert.equal(after.ten_session_pack_price_cents, 12240);
  assert.equal(after.ten_session_pack_discount_cents, null);
  assert.equal(after.ten_session_pack_discount_enabled, false);
  assert.equal(visitorPriceFieldInstalled(field, { ten_session_pack_price_cents: 12240 }), true);
  assert.deepEqual(normalizeVisitorPricing({
    ten_session_pack_price_cents: 13000, ten_session_pack_discount_cents: '110.00', ten_session_pack_discount_enabled: true,
  }), {
    casual_visit_price_cents: 1560, casual_visit_discount_cents: null, casual_visit_discount_enabled: false,
    three_day_pass_price_cents: 3900, three_day_pass_discount_cents: null, three_day_pass_discount_enabled: false,
    ten_session_pack_price_cents: 13000, ten_session_pack_discount_cents: 11000, ten_session_pack_discount_enabled: true,
    three_month_price_cents: 43000, three_month_discount_cents: null, three_month_discount_enabled: false,
  });

  assert.throws(() => normalizeVisitorPricing({ ten_session_pack_price_cents: 12240, ten_session_pack_discount_enabled: true }),
    /Set a 10 session pack discount price/i);
  assert.throws(() => normalizeVisitorPricing({
    ten_session_pack_price_cents: 12240, ten_session_pack_discount_cents: 12240, ten_session_pack_discount_enabled: true,
  }), /10 session pack discount must be cheaper/i);
  assert.throws(() => normalizeVisitorPricing({ ten_session_pack_price_cents: 50 }), /between \$1 and \$1,000/);

  const screen = read('../src/components/admin/SoftLaunchSettings.jsx');
  assert.match(screen, /VISITOR_PRICE_FIELDS\.map\(field => visitorPriceFieldInstalled\(field, savedSettings\) && \(/);
  assert.match(screen, /desc="Controls \/casual, \/3daypass, \/10pack and \/3months\.[^"]*" field="casual_payments_enabled"/);
  const memberSwitch = screen.slice(screen.indexOf('label="Session pack payments"'), screen.indexOf('field="payments_enabled"'));
  assert.doesNotMatch(memberSwitch, /10pack|10 Session Pack/);
});

test('editing the 10 Session Pack price or discount marks Settings as unsaved', () => {
  const saved = {
    target_launch_date: '2026-10-16', ten_session_pack_price_cents: 12240,
    ten_session_pack_discount_cents: null, ten_session_pack_discount_enabled: false,
  };
  assert.equal(launchSettingsChanged({ ...saved }, saved), false);
  assert.equal(launchSettingsChanged({ ...saved, ten_session_pack_price_cents: 13000 }, saved), true);
  assert.equal(launchSettingsChanged({ ...saved, ten_session_pack_discount_cents: 11000 }, saved), true);
  assert.equal(launchSettingsChanged({ ...saved, ten_session_pack_discount_enabled: true }, saved), true);
  // A row loaded before the migration has no column to compare.
  assert.equal(launchSettingsChanged({ target_launch_date: '2026-10-16' }, { target_launch_date: '2026-10-16' }), false);
});

test('every Three Day Pass branch on the visitor page has a 10 Session Pack twin', () => {
  const page = read('../src/pages/CasualVisit.jsx');
  // Each choice on the page falls through to the casual visit, so a branch
  // left out quietly sells a single visit instead of the pack.
  const count = pattern => (page.match(pattern) || []).length;
  assert.equal(count(/\btenSessionPack\b/g), count(/\bthreeDayPass\b/g));
  assert.match(page, /export default function CasualVisit\(\{ threeDayPass = false, tenSessionPack = false, threeMonth = false \}\)/);
  assert.match(page, /: tenSessionPack \? TEN_SESSION_PACK_ACTION : CASUAL_VISIT_ACTION;/);
  assert.match(page, /tenSessionPack \? \{ full: TEN_SESSION_PACK_PRICE_CENTS, charge: TEN_SESSION_PACK_PRICE_CENTS, discounted: false \}/);
  assert.match(page, /tenSessionPack \? '10 Session Pack \| XERT Fitness'/);
  assert.match(page, /\[passKind, threeDayPass, tenSessionPack, threeMonth\]/);
  assert.match(page, /const tenPackAlreadySigned = tenSessionPack && questionnaire === 'done'\s+&& !validQuestionnaireResponseId\(questionnaireResponseId\);/);
  assert.match(page, /const needsTenPackQuestionnaire = tenSessionPack && questionnaire !== 'done';/);
  // The body the checkout receives: its own action, and either the fresh
  // response id or the "already signed" claim.
  assert.match(page, /: tenSessionPack\s*\?\s*\{\s*action: TEN_SESSION_PACK_ACTION, \.\.\.visitor,\s*\.\.\.\(tenPackAlreadySigned\s*\? \{ already_signed: true \}\s*: \{ questionnaire_response_id: questionnaireResponseId \}\),\s*\}\s*: \{ action: CASUAL_VISIT_ACTION, \.\.\.visitor \}\)/);
  // Not done yet: off to the casual questionnaire, details remembered, back here after.
  const detour = page.indexOf('if (needsTenPackQuestionnaire) {');
  const remembered = page.indexOf('rememberCasualVisitor(visitor);', detour);
  const navigate = page.indexOf('navigate(`/forms/${CASUAL_PEQ_SLUG}?return=10pack`);', detour);
  const fetchCall = page.indexOf("fetch('/api/checkout'");
  assert.ok(detour > 0 && remembered > detour && navigate > remembered && fetchCall > navigate);
  assert.match(page, /if \(!threeMonth && !threeDayPass && !tenSessionPack && questionnaire === 'not-done'\) \{/,
    'the casual detour, which returns to /casual, never catches the pack');
  assert.match(page, /\|\| needsTenPackQuestionnaire \? 'Fill in the questionnaire first'/);
  assert.match(page, /tenSessionPack \? '\/forms\/peq-casual\?return=10pack'/);
  assert.match(page, /onClick=\{threeDayPass \|\| tenSessionPack \? \(\) => \{ rememberCasualVisitor\(visitor\); \} : undefined\}/);
  assert.match(page, /readFormCompletion\(threeMonth \? MEMBER_PEQ_SLUG : CASUAL_PEQ_SLUG\)/, 'the pack reads the casual questionnaire');
});

test('/10pack renders the pack at $122.40 and never treats a return query as payment proof', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://ugmkwoapjcpiucsrxwzt.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_local_test_fixture_only_0000'),
    },
  });
  try {
    const { default: CasualVisit } = await server.ssrLoadModule('/src/pages/CasualVisit.jsx');
    const { SupabaseAuthProvider } = await server.ssrLoadModule('/src/lib/SupabaseAuthContext.jsx');
    const render = location => renderToString(React.createElement(StaticRouter, { location },
      React.createElement(SupabaseAuthProvider, null, React.createElement(CasualVisit, { tenSessionPack: true }))));
    // What a visitor reads, without markup (an icon is named credit-card).
    const words = html => html.replace(/<[^>]+>/g, ' ');
    const page = render('/10pack');
    const main = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    assert.match(main, />10 Session Pack</);
    assert.match(main, /Get your 10 Session Pack/);
    assert.match(main, /10 Session Pack — show your receipt to the XERT team/);
    assert.match(main, /\$122\.40/);
    assert.match(main, /First name/);
    assert.match(main, /Pre-exercise questionnaire/);
    assert.match(main, /Signed it on an earlier visit\?/);
    assert.match(main, /href="\/forms\/peq-casual\?return=10pack"/);
    assert.match(main, /Fill in the questionnaire first/);
    // Not the casual visit, not the Three Day Pass, and nothing about how
    // long the sessions last.
    assert.doesNotMatch(main, /Pay for today|One visit, one class|Three Day Pass|return=3daypass|return=casual|\$15\.60|\$39\.00/);
    assert.doesNotMatch(words(main), /minute|hour|week|month|expire|valid for|from purchase|credit/i);

    const returned = render('/10pack?paid=1');
    const paidMain = returned.slice(returned.indexOf('<main'), returned.indexOf('</main>'));
    assert.doesNotMatch(paidMain, /Payment received|team has been told/);
    assert.match(paidMain, /Check your payment receipt/);
    assert.match(paidMain, /Stripe will email your 10 Session Pack receipt/);
    assert.match(paidMain, /the team will arrange your sessions/);
    assert.doesNotMatch(words(paidMain), /minute|hour|week|month|expire|valid for|from purchase|credit/i);

    const cancelled = render('/10pack?cancelled=1');
    assert.match(cancelled, /That payment was cancelled/);
  } finally { await server.close(); }
});
