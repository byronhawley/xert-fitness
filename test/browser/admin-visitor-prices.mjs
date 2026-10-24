import assert from 'node:assert/strict';

// Real Settings component, fictional data, unsaved drafts only. No price writes.
export async function checkVisitorPrices(page, { origin, requests, capture = async () => {} }) {
  await page.goto(origin + '/admin/settings', { waitUntil: 'networkidle' });
  const prices = page.getByRole('textbox', { name: /full price in dollars$/ });
  await prices.first().waitFor();
  assert.equal(await prices.count(), 4, 'All four visitor products have independent price controls');
  for (let index = 0; index < 4; index++) {
    const price = prices.nth(index);
    const name = await price.getAttribute('aria-label');
    const row = price.locator('xpath=../../../..');
    const discount = row.getByRole('textbox', { name: /discount price in dollars$/ });
    const running = row.getByRole('checkbox', { name: /Run this discount/ });
    await price.fill('100.00');
    await price.press('Tab');
    await discount.fill('80.00');
    await discount.press('Tab');
    await running.check();
    assert.equal(await running.isChecked(), true, `${name}: valid discount can run`);
    await price.fill('50.00');
    await price.press('Tab');
    await capture(`visitor-price-${index}-lowered`);
    assert.equal(await running.isChecked() && await running.isDisabled(), false, `${name}: lowering base price must not trap an enabled discount behind a disabled switch`);
    if (await running.isChecked()) await running.uncheck();
    assert.equal(await running.isChecked(), false, `${name}: the invalid discount can be turned off`);
    // Invalid intermediate edits retain the committed base amount on blur.
    await price.fill('');
    await price.press('Tab');
    assert.equal(await price.inputValue(), '50.00');
    await discount.fill('40.00');
    await discount.press('Tab');
    await running.check();
    await discount.fill('');
    await discount.press('Tab');
    assert.equal(await running.isChecked(), false, `${name}: clearing a discount disables it`);
  }
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('button', { name: 'Settings saved', exact: true }).waitFor();
  assert.deepEqual(requests.filter(request => ['PATCH', 'PUT', 'DELETE'].includes(request.method)
    || (request.method === 'POST' && /admin_settings|update.*settings|activate.*payment/.test(request.path))), [], 'Unsaved price proof makes no settings or payment mutation request');
}
