// ─── Casual visit door payments ─────────────────────────────────────────────
// A walk-in pays for one visit on their own phone. Nobody at the club ever
// handles their card: the visitor types their own details, and Stripe collects
// the payment. This is a door fee, not a session pack, so it deliberately has
// nothing to do with accounts, credits or the fulfilment ledger.

export const CASUAL_VISIT_ACTION = 'casual_visit';
export const CASUAL_VISIT_METADATA_FLAG = 'xert_casual_visit';
export const THREE_DAY_PASS_ACTION = 'three_day_pass';
export const THREE_DAY_PASS_PRICE_CENTS = 3900;
export const THREE_MONTH_MEMBERSHIP_ACTION = 'three_month_membership';
export const THREE_MONTH_MEMBERSHIP_PRICE_CENTS = 43000;
// $120 plus Stripe's card fee (1.7% + 30c), so the club keeps the $120.
export const TEN_SESSION_PACK_ACTION = 'ten_session_pack';
export const TEN_SESSION_PACK_PRICE_CENTS = 12240;

/**
 * Everything sold on a visitor page. A casual visit is priced by the club in
 * settings; the passes carry a fixed price here so the browser can never move
 * one, and the server checks the amount again on the way back from Stripe.
 */
export const VISITOR_PASSES = Object.freeze({
  casual: Object.freeze({
    label: 'Casual visit',
    priceCents: null,
    priceField: 'casual_visit_price_cents',
    discountField: 'casual_visit_discount_cents',
    discountEnabledField: 'casual_visit_discount_enabled',
    defaultPriceCents: 1560,
    productName: 'XERT Fitness casual visit',
    productDescription: 'Entry and one class for a single visit.',
    needsSignedQuestionnaire: false,
  }),
  [THREE_DAY_PASS_ACTION]: Object.freeze({
    label: 'Three Day Pass',
    priceCents: THREE_DAY_PASS_PRICE_CENTS,
    priceField: 'three_day_pass_price_cents',
    discountField: 'three_day_pass_discount_cents',
    discountEnabledField: 'three_day_pass_discount_enabled',
    defaultPriceCents: THREE_DAY_PASS_PRICE_CENTS,
    productName: 'XERT Fitness Three Day Pass',
    productDescription: 'Three Day Pass — show your receipt to the XERT team.',
    needsSignedQuestionnaire: true,
  }),
  // Sold and screened exactly like the Three Day Pass: the casual
  // questionnaire first, then a receipt the team arranges the sessions from.
  // It is a visitor purchase, not a member session pack, so it never carries
  // a user or an order and never grants credits.
  [TEN_SESSION_PACK_ACTION]: Object.freeze({
    label: '10 Session Pack',
    priceCents: TEN_SESSION_PACK_PRICE_CENTS,
    priceField: 'ten_session_pack_price_cents',
    discountField: 'ten_session_pack_discount_cents',
    discountEnabledField: 'ten_session_pack_discount_enabled',
    defaultPriceCents: TEN_SESSION_PACK_PRICE_CENTS,
    productName: 'XERT Fitness 10 Session Pack',
    productDescription: '10 Session Pack — show your receipt to the XERT team.',
    needsSignedQuestionnaire: true,
  }),
  [THREE_MONTH_MEMBERSHIP_ACTION]: Object.freeze({
    label: 'Three month membership',
    priceCents: THREE_MONTH_MEMBERSHIP_PRICE_CENTS,
    priceField: 'three_month_price_cents',
    discountField: 'three_month_discount_cents',
    discountEnabledField: 'three_month_discount_enabled',
    defaultPriceCents: THREE_MONTH_MEMBERSHIP_PRICE_CENTS,
    productName: 'XERT Fitness three month membership',
    productDescription: 'Three months of training, paid in full.',
    needsSignedQuestionnaire: false,
  }),
});

export function visitorPass(kind = 'casual') {
  const pass = VISITOR_PASSES[kind];
  if (!pass) throw new Error('This visitor pass is not available.');
  return pass;
}

const RESPONSE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The name the owner's payments list shows for a recorded purchase.
 *
 * Unlike visitorPass(), this never throws. One row of a kind this copy of the
 * site does not know yet — an admin screen still cached from before a new pass
 * shipped — must not take the whole payments list down with it. Checkout and
 * the webhook go through visitorPass(), which still refuses an unknown kind.
 */
export function visitorPassLabel(kind = 'casual') {
  if (Object.prototype.hasOwnProperty.call(VISITOR_PASSES, kind)) return VISITOR_PASSES[kind].label;
  const readable = String(kind ?? '').replace(/[_-]+/g, ' ').trim().slice(0, 60);
  return readable ? `Visitor pass (${readable})` : 'Visitor pass';
}

export function validQuestionnaireResponseId(value) {
  return typeof value === 'string' && RESPONSE_ID_PATTERN.test(value);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

/** Australian mobiles and landlines, kept readable rather than reformatted. */
export function normalizeVisitorPhone(value) {
  const digits = clean(value).replace(/[^\d+]/g, '');
  if (!digits) return '';
  const bare = digits.startsWith('+') ? digits.slice(1) : digits;
  if (/^61\d{9}$/.test(bare)) return `+${bare}`;
  if (/^0\d{9}$/.test(bare)) return `+61${bare.slice(1)}`;
  return /^\+?\d{6,15}$/.test(digits) ? digits : '';
}

/**
 * Everything the checkout needs from the visitor, or a message saying what is
 * missing. Validated in the browser and again on the server: the browser copy
 * is a courtesy, the server copy is the rule.
 */
export function normalizeCasualVisitor(input = {}) {
  const firstName = clean(input.first_name ?? input.firstName);
  const lastName = clean(input.last_name ?? input.lastName);
  const email = clean(input.email).toLowerCase();
  const phone = normalizeVisitorPhone(input.phone);
  if (!firstName) throw new Error('Enter your first name.');
  if (!lastName) throw new Error('Enter your last name.');
  if (`${firstName} ${lastName}`.length > 120) throw new Error('That name is too long for our records.');
  if (!EMAIL_PATTERN.test(email) || email.length > 320) {
    throw new Error('Enter a complete email address, including the part after the dot.');
  }
  if (!clean(input.phone)) throw new Error('Enter a phone number so we can reach you.');
  if (!phone) throw new Error('Enter a valid phone number, for example 0400 000 000.');
  return { fullName: `${firstName} ${lastName}`, firstName, lastName, email, phone };
}

/** The message a form can show before anything is sent, or null when ready. */
export function casualVisitValidationError(input) {
  try {
    normalizeCasualVisitor(input);
    return null;
  } catch (error) {
    return error.message;
  }
}

export function formatCasualVisitPrice(cents, currency = 'aud') {
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return '';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: String(currency || 'aud').toUpperCase(),
  }).format(amount / 100);
}

export function normalizeCasualVisitPriceCents(value, fallback = 1560) {
  const cents = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(cents) && cents >= 100 && cents <= 100000 ? cents : fallback;
}

/**
 * What a pass costs right now, read from the club's settings.
 *
 * A discount is stored as the price actually charged while it runs, so there
 * is no percentage arithmetic to get wrong: `charge` is what the visitor pays
 * and `full` is what to show struck through beside it. A discount that is not
 * cheaper than the full price is ignored rather than trusted, so a bad row can
 * never raise anyone's bill.
 */
export function visitorPassPricing(passKind, settings = {}) {
  // Checkout actions and persisted pass kinds use different names for casual visits.
  const pass = visitorPass(passKind === CASUAL_VISIT_ACTION ? 'casual' : passKind);
  const full = normalizeCasualVisitPriceCents(settings?.[pass.priceField], pass.defaultPriceCents);
  const discount = normalizeCasualVisitPriceCents(settings?.[pass.discountField], NaN);
  const running = settings?.[pass.discountEnabledField] === true
    && Number.isInteger(discount) && discount < full;
  return { full, charge: running ? discount : full, discounted: running };
}

/**
 * The Stripe Checkout Session for one casual visit. The amount comes from the
 * database, never from the browser, and the visitor's own details are carried
 * in so they never retype them at the card screen.
 */
export function casualVisitCheckoutParameters({ visitor, priceCents, currency = 'aud', returnURLs, now = Date.now(), passKind = 'casual', questionnaireResponseId = '', paperworkVerified = null }) {
  const pass = visitorPass(passKind);
  const label = pass.label;
  // Somebody who signed on an earlier visit has no response id to hand: their
  // browser forgot it long ago. They say so instead, and the server looks the
  // record up — which is what `paperworkVerified` records the result of. Only
  // a purchase carrying neither is missing its screening.
  const declaredSigned = paperworkVerified !== null;
  if (pass.needsSignedQuestionnaire && !declaredSigned && !validQuestionnaireResponseId(questionnaireResponseId)) {
    throw new Error('Complete and sign the pre-exercise questionnaire before buying this pass.');
  }
  const amount = normalizeCasualVisitPriceCents(priceCents, NaN);
  const passMetadata = {
    xert_amount_cents: String(amount),
    ...(passKind === 'casual' ? {} : { xert_pass_kind: passKind }),
    ...(pass.needsSignedQuestionnaire && !declaredSigned ? { questionnaire_response_id: questionnaireResponseId } : {}),
    ...(paperworkVerified === null ? {} : { xert_paperwork_verified: paperworkVerified ? 'true' : 'false' }),
  };
  if (!Number.isInteger(amount)) throw new Error('The casual visit price is not set correctly.');
  for (const value of [returnURLs?.success, returnURLs?.cancel]) {
    let url;
    try {
      url = new URL(value || '');
    } catch {
      throw new Error('Checkout return URL is invalid.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Checkout return URL must use HTTP or HTTPS.');
    }
  }
  const milliseconds = Number(now);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Checkout session time is invalid.');
  return {
    mode: 'payment',
    customer_creation: 'if_required',
    billing_address_collection: 'auto',
    customer_email: visitor.email,
    success_url: returnURLs.success,
    cancel_url: returnURLs.cancel,
    expires_at: Math.floor(milliseconds / 1000) + 35 * 60,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(currency || 'aud').toLowerCase(),
        unit_amount: amount,
        product_data: {
          name: pass.productName,
          description: pass.productDescription,
        },
      },
    }],
    payment_intent_data: {
      description: `${label} — ${visitor.fullName}`,
      receipt_email: visitor.email,
      metadata: {
        ...passMetadata,
        [CASUAL_VISIT_METADATA_FLAG]: 'true',
        casual_visit_name: visitor.fullName,
        casual_visit_phone: visitor.phone,
      },
    },
    metadata: {
      ...passMetadata,
      [CASUAL_VISIT_METADATA_FLAG]: 'true',
      casual_visit_name: visitor.fullName,
      casual_visit_email: visitor.email,
      casual_visit_phone: visitor.phone,
    },
  };
}

/** The paid visit to record, or null when a session is not a paid casual visit. */
export function casualVisitPaymentFromCheckout(checkout) {
  const metadata = checkout?.metadata || {};
  if (String(metadata[CASUAL_VISIT_METADATA_FLAG] || '') !== 'true') return null;
  if (String(checkout?.payment_status || '') !== 'paid') return null;
  const passKind = metadata.xert_pass_kind || 'casual';
  const pass = visitorPass(passKind);
  const isPass = passKind !== 'casual';
  // Prices are set by the club and can change, so the amount to expect is the
  // one this server put in the session rather than a constant. Stripe signs
  // the webhook, so metadata is ours; a session charging anything else did not
  // come from us.
  const approvedAmount = Number.parseInt(String(metadata.xert_amount_cents ?? ''), 10);
  // As above: a declared "already signed" was checked against the club's own
  // records before Stripe was ever called, and carries that verdict instead of
  // a response id.
  const declaredSigned = metadata.xert_paperwork_verified !== undefined
    && metadata.xert_paperwork_verified !== '';
  // Stripe's payer email can be edited at Checkout. A pass belongs to the
  // participant our server verified, not to whoever's card was used.
  const participantEmail = clean(metadata.casual_visit_email).toLowerCase();
  if (isPass && (
    checkout.mode !== 'payment' || !Number.isInteger(approvedAmount)
    || checkout.amount_total !== approvedAmount
    || checkout.currency !== 'aud'
    || (pass.needsSignedQuestionnaire && !declaredSigned && !validQuestionnaireResponseId(metadata.questionnaire_response_id))
    || !/^cs_[a-zA-Z0-9_]+$/.test(checkout.id || '')
    || !EMAIL_PATTERN.test(participantEmail) || participantEmail.length > 320
  )) throw new Error(`${pass.label} payment does not match the approved pass or questionnaire.`);
  const email = isPass ? participantEmail : clean(checkout?.customer_details?.email || checkout?.customer_email || metadata.casual_visit_email).toLowerCase();
  const fullName = clean(metadata.casual_visit_name || checkout?.customer_details?.name);
  const sessionID = clean(checkout?.id);
  if (!EMAIL_PATTERN.test(email) || !fullName || !sessionID) return null;
  const amount = Number(checkout?.amount_total);
  return {
    ...(passKind === 'casual' ? {} : { pass_kind: passKind }),
    // Only a declared "already signed" carries this, so null means they signed
    // as part of the purchase and there is nothing for staff to check.
    ...(declaredSigned ? { paperwork_verified: metadata.xert_paperwork_verified === 'true' } : {}),
    full_name: fullName.slice(0, 120),
    email,
    phone: normalizeVisitorPhone(metadata.casual_visit_phone || checkout?.customer_details?.phone) || null,
    amount_cents: Number.isInteger(amount) && amount >= 0 ? amount : 0,
    currency: String(checkout?.currency || 'aud').toLowerCase(),
    stripe_checkout_session_id: sessionID,
    stripe_payment_intent_id: clean(typeof checkout?.payment_intent === 'string' ? checkout.payment_intent : checkout?.payment_intent?.id) || null,
    status: 'paid',
  };
}

/** Totals for the owner's screen: today, this month, and everything shown. */
export function summarizeCasualVisits(rows = [], now = new Date()) {
  const paid = (rows || []).filter(row => row?.status === 'paid');
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const total = list => list.reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
  const since = start => paid.filter(row => new Date(row.created_at) >= start);
  const today = since(day);
  const month = since(monthStart);
  const currencies = [...new Set(paid.map(row => String(row.currency || 'aud').toLowerCase()))];
  return {
    count: paid.length,
    revenue: total(paid),
    todayCount: today.length,
    todayRevenue: total(today),
    monthCount: month.length,
    monthRevenue: total(month),
    currency: currencies.length === 1 ? currencies[0] : 'aud',
    mixedCurrencies: currencies.length > 1,
  };
}

// ─── Remembering a visitor across the questionnaire ─────────────────────────
// Somebody who has not done the questionnaire is sent to fill it in before
// they pay. Their typed details wait here so the payment form is not blank
// when they come back. sessionStorage, so it belongs to one person in one
// sitting and a shared phone starts clean.

export const CASUAL_VISITOR_KEY = 'xert-casual-visitor';
export const CASUAL_VISITOR_TTL_MS = 12 * 60 * 60 * 1000;

function visitorStorage() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function rememberCasualVisitor(visitor, { storage = visitorStorage(), now = Date.now() } = {}) {
  if (!storage) return false;
  try {
    storage.setItem(CASUAL_VISITOR_KEY, JSON.stringify({ ...visitor, at: now }));
    return true;
  } catch {
    return false;
  }
}

export function recallCasualVisitor({ storage = visitorStorage(), now = Date.now() } = {}) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CASUAL_VISITOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const at = Number(parsed?.at);
    if (!Number.isFinite(at) || now - at > CASUAL_VISITOR_TTL_MS || now < at) return null;
    return parsed;
  } catch {
    return null;
  }
}
