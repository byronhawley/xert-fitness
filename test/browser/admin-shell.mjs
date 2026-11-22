import assert from 'node:assert/strict';

export async function checkAdminShell(page, { origin, width }) {
  const shell = page.locator('[data-admin-shell]');
  await shell.waitFor();
  const menu = page.getByRole('button', { name: 'Open account and navigation', exact: true });
  if (width < 1024) await menu.tap();
  const rail = page.locator('#admin-navigation');
  const classes = rail.getByRole('button', { name: 'Classes', exact: true });
  const currentURL = page.url();
  await classes.tap();
  assert.equal(await classes.getAttribute('aria-expanded'), 'true');
  assert.equal(page.url(), currentURL, 'Browsing a hub never loads its first workspace');
  await rail.getByRole('button', { name: 'Class requests', exact: true }).tap();
  await page.waitForURL(origin + '/admin/bookings');
  if (width < 1024) assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  if (width >= 1024) {
    await page.getByRole('button', { name: 'Compact density', exact: true }).click();
    assert.equal(await shell.getAttribute('data-density'), 'compact');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await shell.getAttribute('data-density'), 'compact', 'Density preference survives reload');
    await page.getByRole('button', { name: 'Comfortable density', exact: true }).click();
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    const handle = page.getByRole('separator', { name: /resize.*navigation/i });
    await handle.focus();
    const initialWidth = Number(await handle.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    const resizedWidth = Number(await handle.getAttribute('aria-valuenow'));
    assert.ok(resizedWidth > initialWidth, 'Keyboard separator resizes the sidebar');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(Number(await handle.getAttribute('aria-valuenow')), resizedWidth, 'Sidebar width survives reload');
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    const rail = await page.locator('#admin-navigation').boundingBox();
    assert.ok(rail.width < initialWidth / 2, 'Collapsed navigation is an icon rail');
    await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
  } else {
    assert.equal(await page.getByRole('button', { name: /^(Compact|Comfortable) density$/ }).count(), 0, 'Mobile header omits the spacing control');
    assert.equal(await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).count(), 0, 'Mobile header omits keyboard help');
    const account = page.getByRole('button', { name: 'Open account and navigation', exact: true });
    await account.tap();
    await page.locator('#admin-navigation[aria-modal="true"]').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await account.getAttribute('aria-expanded'), 'false', 'Mobile account navigation still opens and closes');
  }

  await page.getByRole('button', { name: 'Search admin tools', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Find an owner task', exact: true }).waitFor();
  await page.keyboard.press('Escape');

  if (width === 390) {
    const viewport = page.viewportSize();
    await page.setViewportSize({ ...viewport, width: 1024 });
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Compact density', exact: true }).waitFor();
    await page.setViewportSize({ ...viewport, width: 1023 });
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: /^(Compact|Comfortable) density$/ }).count(), 0, 'Both controls disappear when returning below the desktop breakpoint');
    await page.setViewportSize(viewport);
  }

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Find an owner task', exact: true });
  await palette.waitFor();
  await palette.getByRole('combobox').fill('clcl');
  const calendar = palette.getByRole('option').filter({ hasText: 'Class calendar' });
  await calendar.waitFor();
  assert.ok(await calendar.locator('mark').count(), 'Fuzzy matches are visibly highlighted');
  for (let attempt = 0; attempt < 12 && await calendar.getAttribute('aria-selected') !== 'true'; attempt++) {
    await palette.getByRole('combobox').press('ArrowDown');
  }
  assert.equal(await calendar.getAttribute('aria-selected'), 'true', 'Keyboard reaches the fuzzy calendar result');
  await palette.getByRole('combobox').press('Enter');
  await page.waitForURL(origin + '/admin/calendar');

  const tabs = page.getByRole('tablist', { name: 'Workspace sections', exact: true });
  const tab = tabs.getByRole('tab');
  await tabs.locator('[role="tab"][tabindex="0"]').waitFor();
  assert.equal(await tabs.locator('[role="tab"][tabindex="0"]').count(), 1, 'Tablist has one keyboard entry point');
  await tabs.locator('[role="tab"][tabindex="0"]').focus();
  await page.keyboard.press('End');
  assert.equal(await tab.last().evaluate(el => el === document.activeElement), true, 'End focuses the last workspace tab');
  assert.equal(await tab.last().getAttribute('tabindex'), '0', 'Manual roving updates the keyboard entry point before activation');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await tab.last().evaluate(el => el === document.activeElement), true, 'Returning to the tab rail restores its last focused tab');
  await page.keyboard.press('Home');
  assert.equal(await tab.first().evaluate(el => el === document.activeElement), true, 'Home focuses the first workspace tab');
  const requestsTab = tabs.getByRole('tab', { name: /Class requests/ });
  const tabCount = await tab.count();
  for (let step = 0; step < tabCount; step++) {
    if (await requestsTab.evaluate(el => el === document.activeElement)) break;
    await page.keyboard.press('ArrowRight');
  }
  assert.equal(await requestsTab.evaluate(el => el === document.activeElement), true, 'ArrowRight reaches Class requests');
  await page.keyboard.press('Enter');
  await page.waitForURL(origin + '/admin/bookings');
  await tabs.locator('[role="tab"][aria-selected="true"]').filter({ hasText: 'Class requests' }).waitFor();
  const marker = tabs.locator('.admin-tab-indicator');
  await marker.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
  });
  const selectedBox = await tabs.locator('[aria-selected="true"]').boundingBox();
  const markerBox = await marker.boundingBox();
  assert.ok(Math.abs(markerBox.x - selectedBox.x) <= 2 && Math.abs(markerBox.width - selectedBox.width) <= 2, 'Tab indicator tracks the selected tab after its transition');
  assert.equal(await marker.evaluate(el => el.parentElement.getAttribute('aria-selected')), 'true',
    'The active marker belongs to the selected tab through scroll and resize');

  await page.getByRole('main').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('?');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await page.waitForURL(origin + '/admin/calendar');

  await page.keyboard.press('Control+k');
  await palette.waitFor();
  const search = palette.getByRole('combobox');
  await search.fill('');
  await search.press('g');
  await search.press('c');
  await search.press('?');
  assert.equal(await search.inputValue(), 'gc?', 'Shortcut keys remain ordinary characters inside search');
  assert.equal(page.url(), origin + '/admin/calendar', 'Typing shortcut characters does not navigate');
  assert.equal(await page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }).count(), 0, 'Typing a question mark does not open shortcuts');
  await page.keyboard.press('Escape');

  await page.goto(origin + '/admin/content?source=design-verification', { waitUntil: 'networkidle' });
  const headline = page.getByLabel('Headline', { exact: true });
  await headline.fill('Local unsaved design verification draft');
  await page.getByRole('main').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Control+k');
  await palette.getByRole('combobox').fill('Class calendar');
  await palette.getByRole('option').filter({ hasText: 'Class calendar' }).click();
  const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true });
  await guard.waitFor();
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(page.url(), origin + '/admin/content?source=design-verification', 'Cancelled navigation preserves URL parameters');
  assert.equal(await palette.getByRole('combobox').inputValue(), 'Class calendar', 'Cancelled navigation preserves the palette search');
  await page.keyboard.press('Escape');
  assert.equal(await headline.inputValue(), 'Local unsaved design verification draft', 'Cancelled navigation keeps the actual editor draft');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
}
