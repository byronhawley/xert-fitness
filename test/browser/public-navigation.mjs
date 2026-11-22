import assert from 'node:assert/strict';

async function touchDrag(page, { x, y, distance, beforeRelease }) {
  // This session is attached only to the isolated browser launched by our test runner.
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * step / 8 }] });
    }
    await beforeRelease?.();
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}

export async function checkPublicNavigation(page, { origin, signedIn, failures }) {
  const nav = page.locator('[data-public-nav]');
  await nav.waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  const barHeight = (await nav.boundingBox()).height;
  await page.evaluate(() => window.scrollTo(0, 600));
  assert.equal((await nav.boundingBox()).height, barHeight, 'Scroll keeps targets in place');
  const trigger = nav.getByRole('button', { name: 'Open navigation menu' });
  const desktop = await nav.locator('.public-nav-links').isVisible();
  await nav.getByRole('link', { name: 'Book a class' }).waitFor();
  if (desktop) {
    await nav.getByRole('link', { name: 'Coaches', exact: true }).click();
    await page.waitForURL(origin + '/coaches');
    await nav.locator('.public-nav-link[aria-current="page"]').filter({ hasText: 'Coaches' }).waitFor();
    await page.goto(origin, { waitUntil: 'networkidle' });
  }
  await trigger.click();
  const sheet = page.locator('#mobile-navigation');
  await sheet.getByRole('link', { name: 'Facility', exact: true }).waitFor();
  assert.equal(await sheet.getByRole('region', { name: 'Next class' }).count(), 0, 'Menu opens without loading optional gym details');
  const shortcuts = sheet.getByRole('region', { name: 'Your shortcuts' });
  if (signedIn) {
    await shortcuts.getByRole('link', { name: 'Command centre' }).waitFor();
    assert.equal(await shortcuts.getByRole('link', { name: 'Training progress' }).getAttribute('href'), '/account#progress');
    await shortcuts.getByRole('link', { name: 'Upcoming classes' }).click();
    await page.waitForURL(origin + '/account#bookings');
    const atBookings = () => page.waitForFunction(() => {
      const target = document.getElementById('bookings')?.getBoundingClientRect();
      const header = document.querySelector('[data-public-nav]')?.getBoundingClientRect();
      return target && header && target.top >= header.bottom - 1 && target.top < innerHeight / 2;
    });
    await atBookings();
    await page.evaluate(() => window.scrollTo(0, 0));
    await trigger.click();
    await shortcuts.getByRole('link', { name: 'Upcoming classes' }).click();
    await atBookings();
    await page.goBack();
    await trigger.click();
  } else {
    assert.equal(await shortcuts.count(), 0);
  }
  await sheet.getByRole('button', { name: 'Next class & gym details' }).click();
  const nextClass = page.getByRole('region', { name: 'Next class', exact: true });
  await nextClass.getByText('Foundation Strength', { exact: true }).waitFor();
  assert.match(await nextClass.innerText(), /Sam/);
  assert.match(await nextClass.innerText(), /2\s+(?:spots|places)/i);
  const requestLink = nextClass.getByRole('link', { name: /request/i });
  assert.match(await requestLink.getAttribute('href'), /\/timetable\?session=22222222-2222-4222-8222-222222222222/);
  if (signedIn) {
    assert.match(await sheet.innerText(), /Alex/i);
    assert.match(await sheet.innerText(), /next booking/i);
  } else {
    await sheet.getByRole('link', { name: /log in/i }).waitFor();
    await sheet.getByRole('link', { name: /join/i }).waitFor();
  }
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'Menu locks the page');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  if (desktop) return;

  await page.setViewportSize({ width: 390, height: 844 });
  failures.public_class_availability = 1;
  await page.reload({ waitUntil: 'networkidle' });
  await trigger.click();
  await sheet.getByRole('button', { name: 'Next class & gym details' }).click();
  const retry = page.getByRole('button', { name: 'Retry class information', exact: true });
  await retry.waitFor();
  assert.doesNotMatch(await nextClass.innerText(), /2\s+(?:spots|places)/i, 'A failed availability load cannot promise a place count');
  await retry.click();
  await nextClass.getByText('Foundation Strength', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

  await trigger.click();
  const scroller = page.locator('[data-nav-sheet-scroll]');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const handle = await page.locator('.public-menu-grip').boundingBox();
  assert.ok(handle);
  const before = await sheet.boundingBox();
  await touchDrag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2, distance: 150,
    beforeRelease: async () => {
      const during = await sheet.boundingBox();
      assert.ok(during.y > before.y + 20 && during.y < before.y + 150, 'Sheet tracks the finger with rubber-banding before release');
    },
  });
  await sheet.waitFor({ state: 'detached' });
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden', 'Swipe dismissal unlocks page scroll');

  await trigger.click();
  await sheet.getByRole('button', { name: 'Next class & gym details' }).click();
  await nextClass.getByText('Foundation Strength', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 550 });
  await scroller.evaluate(el => { el.scrollTop = 80; });
  const scrollStart = await scroller.evaluate(el => el.scrollTop);
  assert.ok(scrollStart > 0, 'Fixture content can scroll independently');
  const scrollBox = await scroller.boundingBox();
  await touchDrag(page, { x: scrollBox.x + scrollBox.width / 2, y: scrollBox.y + 100, distance: 140 });
  assert.equal(await nav.locator('[aria-controls="mobile-navigation"]').getAttribute('aria-expanded'), 'true', 'A downward gesture started within scrolled content does not dismiss the sheet');
  await page.keyboard.press('Escape');
}
