// Fictional local-browser ledger; read-only and never imported by the product.
export function installOrderData() {
  const now = Date.now();
  const orders = Array.from({ length: 503 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    const status = ['paid', 'pending', 'failed', 'refunded'][index % 4];
    const created = new Date(now - (index + 1) * 3600000).toISOString();
    return {
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      email: `order.buyer.${number}@example.invalid`, amount_cents: 8000 + index * 100,
      currency: index % 5 === 0 ? 'usd' : 'aud', status, created_at: created,
      paid_at: status === 'paid' || status === 'refunded' ? created : null,
      products: { name: `Fictional session pack ${number}` },
      credit_total: index === 1 ? null : 4, credit_validity_days: index === 1 ? null : 90,
      stripe_checkout_session_id: `cs_test_local_fixture_${number}_abcdefghijklmnopqrstuvwxyz`,
      stripe_payment_intent_id: status === 'paid' || status === 'refunded' ? `pi_local_fixture_${number}_abcdefghijklmnopqrstuvwxyz` : null,
      reconciled_at: index === 2 ? created : null,
      reconciled_by: index === 2 ? '11111111-1111-4111-8111-111111111111' : null,
      refunded_at: status === 'refunded' ? created : null,
      refunded_amount_cents: status === 'refunded' ? 8000 + index * 100 : null,
      stripe_refunds: status === 'refunded' ? [{ refund_id: `re_local_fixture_${number}`, amount_cents: 8000 + index * 100,
        credits_revoked: 3, credits_consumed: 1, bookings_cancelled: 2, refunded_at: created }] : [],
    };
  });
  const visits = Array.from({ length: 61 }, (_, index) => ({
    id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    full_name: `Fictional Visitor ${String(index + 1).padStart(3, '0')}`,
    email: `visitor.${String(index + 1).padStart(3, '0')}@example.invalid`, phone: '',
    amount_cents: index % 3 === 2 ? 12240 : index % 2 ? 3590 : 2000, currency: 'aud', status: index % 6 === 5 ? 'refunded' : 'paid',
    pass_kind: index % 3 === 2 ? 'ten_session_pack' : index % 2 ? 'three_day_pass' : 'casual', created_at: new Date(now - (index + 1) * 3600000).toISOString(),
    stripe_payment_intent_id: `pi_local_visitor_fixture_${index + 1}`,
  }));
  return {
    read(name, url) {
      const source = name === 'orders' ? orders : name === 'casual_visit_payments' ? visits : undefined;
      if (!source) return undefined;
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const limit = Math.max(0, Number(url.searchParams.get('limit') || source.length));
      return { rows: structuredClone(source.slice(offset, offset + limit)), total: source.length, offset };
    },
  };
}
