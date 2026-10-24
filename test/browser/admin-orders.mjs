import assert from 'node:assert/strict';
import { assertReachableControl } from './control-geometry.mjs';

export async function checkAdminOrderDraft(page, { origin, capture = async () => {} }) {
  await page.goto(origin + '/admin/orders?source=order-draft-proof', { waitUntil: 'networkidle' });
  await page.getByRole('button').filter({ hasText: 'Fictional session pack 001' }).click();
  const detail = page.getByRole('dialog', { name: 'Fictional session pack 001', exact: true });
  await detail.getByLabel('Type REFUND to confirm', { exact: true }).fill('REFUND');
  await detail.getByRole('combobox', { name: 'Refund reason', exact: true }).selectOption('duplicate');
  await detail.getByRole('button', { name: 'Close order detail', exact: true }).click();
  await capture('order-refund-draft-dismissal');
  assert.equal(await page.getByRole('alertdialog').count(), 1, 'Closing an edited refund draft requires explicit discard confirmation');
}

export async function checkAdminOrders(page, { origin, failures, capture = async () => {}, baseline = true, visitError = false }) {
  await page.goto(origin + '/admin/orders?source=order-proof', { waitUntil: 'networkidle' });
  await page.getByText('1-50 of 503 matching orders', { exact: true }).waitFor();
  assert.ok(await page.getByText('Mixed currencies', { exact: true }).count() >= 1);
  assert.equal(await page.getByRole('img', { name: 'Daily paid revenue for the last 30 days', exact: true }).count(), 0, 'Mixed currency revenue is never combined into a chart');
  await page.getByRole('heading', { name: 'Visitor payments', exact: true }).waitFor();
  assert.ok((await page.getByRole('listitem').filter({ hasText: 'Fictional Visitor 003' }).textContent()).includes('10 Session Pack'),
    'A 10 Session Pack sits in the visitor payments list under its own name');
  await page.getByText('Fictional Visitor 050', { exact: true }).waitFor();
  assert.equal(await page.getByText('Fictional Visitor 051', { exact: true }).count(), 0, 'Recent visit display remains bounded to50');
  await page.getByRole('button', { name: 'Next order page', exact: true }).click();
  await page.getByText('51-100 of 503 matching orders', { exact: true }).waitFor();
  await capture('orders-page-two');
  await page.getByRole('button', { name: 'Previous order page', exact: true }).click();
  const open = number => page.getByRole('button').filter({ hasText: `Fictional session pack ${number}` }).click();
  await open('001');
  const detail = page.getByRole('dialog', { name: 'Fictional session pack 001', exact: true });
  await detail.waitFor();
  assert.ok((await detail.textContent()).includes('4 session credits · 90 days validity'));
  const confirmation = detail.getByLabel('Type REFUND to confirm', { exact: true });
  const refund = detail.getByRole('button', { name: /^Refund / });
  await confirmation.fill('refund');
  assert.equal(await refund.isEnabled(), false, 'Refund requires exact uppercase confirmation');
  await confirmation.fill('REFUND');
  await detail.getByRole('combobox', { name: 'Refund reason', exact: true }).selectOption('duplicate');
  assert.equal(await refund.isEnabled(), true);
  await refund.click();
  await page.getByText('Refund failed', { exact: true }).waitFor();
  assert.equal(await confirmation.inputValue(), 'REFUND', 'Rejected local refund preserves confirmation');
  assert.equal(await detail.getByRole('combobox', { name: 'Refund reason', exact: true }).inputValue(), 'duplicate');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await refund.scrollIntoViewIfNeeded();
  if (!baseline) {
    await assertReachableControl(refund, 'Refund control enlarged');
    await assertReachableControl(detail.getByRole('button', { name: 'Close order detail', exact: true }), 'Close order detail enlarged');
  }
  await capture('order-detail-text-200');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await detail.getByRole('button', { name: 'Close order detail', exact: true }).click();
  await open('002');
  const pending = page.getByRole('dialog', { name: 'Fictional session pack 002', exact: true });
  await pending.getByText('Legacy order - purchased terms not recorded', { exact: true }).waitFor();
  await pending.getByRole('button', { name: 'Check Stripe Outcome', exact: true }).click();
  await page.getByText('Reconciliation stopped', { exact: true }).waitFor();
  await pending.getByRole('button', { name: 'Close order detail', exact: true }).click();
  await open('004');
  const refunded = page.getByRole('dialog', { name: 'Fictional session pack 004', exact: true });
  assert.ok((await refunded.textContent()).includes('3 credits revoked; 2 future bookings cancelled; 1 sessions already used'));
  await refunded.getByRole('button', { name: 'Close order detail', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const download = await downloadPromise;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8');
  assert.equal((csv.match(/order\.buyer\.\d{3}@example\.invalid/g) || []).length, 503, 'CSV covers both500-row server pages');
  assert.ok(csv.includes('Purchased session credits') && csv.includes('Unused credits revoked'));
  await page.getByLabel('Filter orders by currency', { exact: true }).selectOption('aud');
  await page.getByLabel('Filter orders by status', { exact: true }).selectOption('paid');
  await page.getByText('1-50 of 100 matching orders · 503 total', { exact: true }).waitFor();
  await page.getByRole('img', { name: 'Daily paid revenue for the last 30 days', exact: true }).waitFor();
  await page.getByLabel('Search orders', { exact: true }).fill('not-a-real-buyer');
  await page.getByText('No matching orders', { exact: true }).waitFor();
  await page.getByLabel('Search orders', { exact: true }).fill('');
  await page.getByLabel('Filter orders by status', { exact: true }).selectOption('all');
  await page.getByLabel('Filter orders by currency', { exact: true }).selectOption('all');
  failures.orders = Number.POSITIVE_INFINITY;
  await page.getByRole('button', { name: 'Refresh orders', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fixture class service temporarily unavailable.' }).waitFor();
  await capture('orders-read-error');
  failures.orders = 0;
  await page.getByRole('button', { name: /^Retry( loading data)?$/ }).click();
  await page.getByText('1-50 of 503 matching orders', { exact: true }).waitFor();
  if (visitError) {
    failures.casual_visit_payments = Number.POSITIVE_INFINITY;
    await page.goto(origin + '/admin/orders?source=order-proof', { waitUntil: 'networkidle' });
    await page.getByText('1-50 of 503 matching orders', { exact: true }).waitFor();
    await capture('visit-read-failure');
    assert.ok(await page.getByRole('alert').count() > 0, 'Visit read failure is visible, not swallowed as an empty ledger');
    failures.casual_visit_payments = 0;
  }
}
