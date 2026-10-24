import assert from 'node:assert/strict';

// Exercise the actual public price read/display with fictional settings only.
export async function checkPublicVisitorPrices(page, { origin, path, capture = async () => {} }) {
  const fields = {
    '/casual': ['casual_visit_price_cents', 'casual_visit_discount_cents', 'casual_visit_discount_enabled'],
    '/3daypass': ['three_day_pass_price_cents', 'three_day_pass_discount_cents', 'three_day_pass_discount_enabled'],
    '/10pack': ['ten_session_pack_price_cents', 'ten_session_pack_discount_cents', 'ten_session_pack_discount_enabled'],
    '/3months': ['three_month_price_cents', 'three_month_discount_cents', 'three_month_discount_enabled'],
  }[path];
  let settings;
  const pattern = '**/rest/v1/admin_settings?*';
  const handler = async route => {
    assert.equal(route.request().method(), 'GET', 'Price display requires only a settings read');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) });
  };
  await page.route(pattern, handler);
  try {
    for (const scenario of [
      { enabled: true, discount: 1250, expected: '$12.50', running: true },
      { enabled: false, discount: 1250, expected: '$20.00', running: false },
      { enabled: true, discount: 2500, expected: '$20.00', running: false },
    ]) {
      settings = { [fields[0]]: 2000, [fields[1]]: scenario.discount, [fields[2]]: scenario.enabled };
      await page.goto(origin + path, { waitUntil: 'networkidle' });
      const amount = page.locator('main p strong').first();
      await page.getByText(scenario.expected, { exact: true }).first().waitFor();
      assert.equal(await amount.textContent(), scenario.expected, 'Displayed charge follows current server-provided configuration');
      assert.equal(await page.getByText('(discount on now)', { exact: true }).count(), scenario.running ? 1 : 0);
      assert.equal(await page.locator('main s').count(), scenario.running ? 1 : 0);
      if (scenario.running) {
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Discount copy fits enlarged text');
        await capture('visitor-discount-text-200');
      }
    }
  } finally {
    await page.unroute(pattern, handler);
  }
}
