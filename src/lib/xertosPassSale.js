// A pass sold at the gym's check-in tablet, sent on by XertOS.
//
// The buyer picks a pass at the tablet and pays on their own phone through
// XertOS. XertOS makes the pass and holds the forms. This site keeps the same
// record it keeps for a pass bought here (casual_visit_payments), so the
// takings list and the owner's "paid" email cover both places.

const PASS_KINDS = new Set(['casual', 'three_day_pass', 'ten_session_pack', 'three_month_membership']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

/** What a refused sale answers with: the site's own words, for XertOS to keep. */
export class PassSaleRefused extends Error {
  constructor(message) {
    super(message);
    this.code = 'PASS_SALE_REFUSED';
  }
}

/**
 * The casual_visit_payments row for a sale XertOS sent. Throws PassSaleRefused
 * when the sale can't be recorded as sent.
 */
export function passSaleRow(payload) {
  const sale = payload?.sale;
  if (!sale || typeof sale !== 'object') throw new PassSaleRefused('The sale is missing.');
  const passKind = String(sale.passKind ?? '');
  if (!PASS_KINDS.has(passKind)) throw new PassSaleRefused('This pass is not one XERT Fitness sells.');
  const fullName = clean(sale.fullName);
  if (!fullName || fullName.length > 120) throw new PassSaleRefused('The buyer\'s name is missing or too long.');
  const email = clean(sale.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 320) throw new PassSaleRefused('The buyer\'s email is not valid.');
  const phone = clean(sale.phone);
  if (phone.length > 40) throw new PassSaleRefused('The buyer\'s phone number is too long.');
  const amount = sale.amountCents;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) {
    throw new PassSaleRefused('The amount paid is not valid.');
  }
  const currency = String(sale.currency ?? '').toLowerCase();
  if (currency !== 'aud') throw new PassSaleRefused('XERT Fitness takes payment in Australian dollars only.');
  const sessionId = String(sale.checkoutSessionId ?? '');
  if (!/^cs_[a-zA-Z0-9_]{1,250}$/.test(sessionId)) throw new PassSaleRefused('The payment reference is not valid.');
  const paymentIntent = String(sale.paymentIntentId ?? '');
  if (paymentIntent && !/^pi_[a-zA-Z0-9_]{1,250}$/.test(paymentIntent)) {
    throw new PassSaleRefused('The payment reference is not valid.');
  }
  return {
    ...(passKind === 'casual' ? {} : { pass_kind: passKind }),
    // XertOS only takes payment once the forms this pass needs are signed
    // there, so the owner's email says they are on file.
    ...(sale.formsOnFile === true ? { paperwork_verified: true } : {}),
    full_name: fullName,
    email,
    phone: phone || null,
    amount_cents: amount,
    currency,
    stripe_checkout_session_id: sessionId,
    stripe_payment_intent_id: paymentIntent || null,
    status: 'paid',
  };
}

/**
 * Writes the sale once. The payment reference is unique, so a sale XertOS
 * sends twice (a retry after a lost answer) is recorded, and emailed, once.
 */
export async function recordPassSale(admin, payload) {
  const row = passSaleRow(payload);
  const { data, error } = await admin
    .from('casual_visit_payments')
    .upsert(row, { onConflict: 'stripe_checkout_session_id', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`The pass sale could not be recorded: ${error.message}`);
  return { recorded: Array.isArray(data) && data.length > 0 };
}
