import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import handler from '../src/lib/xertosWebhook.js';
import { PassSaleRefused, passSaleRow, recordPassSale } from '../src/lib/xertosPassSale.js';

Object.assign(process.env, { XERTOS_WRITE_SECRET: 'current-secret', XERTOS_WRITE_SECRET_VERSION: '7' });

function signedHeaders(rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', 'current-secret').update(`${timestamp}.${rawBody}`).digest('hex');
  return { 'x-webhook-timestamp': String(timestamp), 'x-webhook-signature': `v1,k7=${signature}` };
}

function mockResponse() {
  return {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(rawBody, headers) {
  return {
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(rawBody); },
  };
}

const sale = {
  saleId: 'sps_abc123',
  passKind: 'ten_session_pack',
  fullName: '  Tyler   Hart ',
  email: 'Tyler@Example.com',
  phone: '+61400000000',
  amountCents: 12240,
  currency: 'AUD',
  checkoutSessionId: 'cs_live_a1B2',
  paymentIntentId: 'pi_3abc',
  paidAt: '2026-11-21T02:00:00.000Z',
  formsOnFile: true,
};

async function withSync(value, run) {
  const before = process.env.CLIENT0_SYNC_ENABLED;
  if (value === undefined) delete process.env.CLIENT0_SYNC_ENABLED;
  else process.env.CLIENT0_SYNC_ENABLED = value;
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env.CLIENT0_SYNC_ENABLED;
    else process.env.CLIENT0_SYNC_ENABLED = before;
  }
}

test('a tablet sale becomes the same record a pass bought on the site leaves', () => {
  assert.deepEqual(passSaleRow({ sale }), {
    pass_kind: 'ten_session_pack',
    paperwork_verified: true,
    full_name: 'Tyler Hart',
    email: 'tyler@example.com',
    phone: '+61400000000',
    amount_cents: 12240,
    currency: 'aud',
    stripe_checkout_session_id: 'cs_live_a1B2',
    stripe_payment_intent_id: 'pi_3abc',
    status: 'paid',
  });
});

test('a casual visit leaves pass_kind to the table default, as the site does', () => {
  const row = passSaleRow({ sale: { ...sale, passKind: 'casual', paymentIntentId: null, phone: '', formsOnFile: false } });
  assert.equal('pass_kind' in row, false);
  assert.equal('paperwork_verified' in row, false);
  assert.equal(row.phone, null);
  assert.equal(row.stripe_payment_intent_id, null);
});

test('a sale that is not whole is refused in words', () => {
  for (const change of [
    { passKind: 'yearly' }, { fullName: '' }, { email: 'tyler' }, { amountCents: 0 }, { amountCents: 12.5 },
    { currency: 'usd' }, { checkoutSessionId: 'pi_wrong' }, { paymentIntentId: 'cs_wrong' },
  ]) {
    assert.throws(() => passSaleRow({ sale: { ...sale, ...change } }), PassSaleRefused, JSON.stringify(change));
  }
  assert.throws(() => passSaleRow({}), PassSaleRefused);
});

test('the sale is written once on its payment reference', async () => {
  const calls = [];
  const admin = {
    from(table) {
      return {
        upsert(row, options) {
          calls.push({ table, row, options });
          return { select: async () => ({ data: calls.length === 1 ? [{ id: 'row-1' }] : [], error: null }) };
        },
      };
    },
  };
  assert.deepEqual(await recordPassSale(admin, { sale }), { recorded: true });
  assert.deepEqual(await recordPassSale(admin, { sale }), { recorded: false });
  assert.equal(calls[0].table, 'casual_visit_payments');
  assert.deepEqual(calls[0].options, { onConflict: 'stripe_checkout_session_id', ignoreDuplicates: true });
});

test('a signed pass sale is recorded only while the sync is on', async () => {
  const rawBody = JSON.stringify({ action: 'passSale', sale, requestId: 'sale-1' });
  let received = null;
  const recorder = async payload => { received = payload; return { recorded: true }; };

  await withSync(undefined, async () => {
    const res = mockResponse();
    await handler(request(rawBody, signedHeaders(rawBody)), res, { recordPassSale: recorder });
    assert.equal(res.statusCode, 501);
    assert.equal(res.body.error.code, 'ACTION_NOT_READY');
    assert.equal(received, null);
  });

  await withSync('true', async () => {
    const unsigned = mockResponse();
    await handler(request(rawBody, { ...signedHeaders(rawBody), 'x-webhook-signature': 'v1,k7=' + '0'.repeat(64) }), unsigned, { recordPassSale: recorder });
    assert.equal(unsigned.statusCode, 401);
    assert.equal(received, null);

    const noRecorder = mockResponse();
    await handler(request(rawBody, signedHeaders(rawBody)), noRecorder);
    assert.equal(noRecorder.statusCode, 501);

    const res = mockResponse();
    await handler(request(rawBody, signedHeaders(rawBody)), res, { recordPassSale: recorder });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, recorded: true });
    assert.equal(received.sale.checkoutSessionId, 'cs_live_a1B2');
  });
});

test('a refused sale answers 422 and a database failure answers 500', async () => {
  const rawBody = JSON.stringify({ action: 'passSale', sale, requestId: 'sale-2' });
  await withSync('true', async () => {
    const refused = mockResponse();
    await handler(request(rawBody, signedHeaders(rawBody)), refused, {
      recordPassSale: async () => { throw new PassSaleRefused('The amount paid is not valid.'); },
    });
    assert.equal(refused.statusCode, 422);
    assert.equal(refused.body.error.message, 'The amount paid is not valid.');

    const failed = mockResponse();
    await handler(request(rawBody, signedHeaders(rawBody)), failed, {
      recordPassSale: async () => { throw new Error('db down'); },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.error.code, 'PASS_SALE_FAILED');
  });
});
