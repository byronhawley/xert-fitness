import assert from 'node:assert/strict';
import { assertReachableControl } from './control-geometry.mjs';

export async function checkAdminQR(page, { capture = async () => {} } = {}) {
  const entries = new URL(page.url()).pathname === '/admin/orders' ? [
    { title: 'Casual visit QR', path: '/casual', filename: 'casual-visit' },
    { title: 'Three Day Pass QR', path: '/3daypass', filename: 'three-day-pass' },
    { title: '10 Session Pack QR', path: '/10pack', filename: 'ten-session-pack' },
    { title: 'Three month membership QR', path: '/3months', filename: 'three-month-membership' },
  ] : [{ title: 'Branded QR code' }];
  for (const entry of entries) {
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: entry.title, exact: true }) });
  const downloadButton = section.getByRole('button', { name: 'Download PNG', exact: true });
  if (entry.path) assert.ok((await section.textContent()).includes(new URL(entry.path, page.url()).href), 'Each QR card identifies the intended public payment route');
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const png = Buffer.concat(chunks);
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10], 'QR UI downloads a genuine PNG');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.ok(download.suggestedFilename().endsWith('.png'));
  if (entry.filename) assert.ok(download.suggestedFilename().includes(entry.filename), 'Pass downloads have distinct useful filenames');
  const notices = page.locator('li[data-state="open"]').filter({ hasText: 'Branded QR code downloaded.' });
  if (await notices.count()) {
    await notices.last().locator('[toast-close]').click();
    await page.getByText('Branded QR code downloaded.', { exact: true }).waitFor({ state: 'hidden' });
  }
  assert.deepEqual(await section.locator('canvas[aria-label^="QR code for"]')
    .evaluate(canvas => [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]), [255,255,255,255], 'Displayed QR preserves an opaque white quiet zone');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  try {
    await assertReachableControl(downloadButton, 'Download QR image outside the Forms workspace');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await capture(`qr-download-${entry.filename || 'form'}-text-200`);
  } finally {
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  }
  }
}
