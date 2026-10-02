import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { metadataForPath, SITE_ORIGIN } from '../src/lib/pageMetadata.js';

test('public routes have distinct indexable search metadata', () => {
  const home = metadataForPath('/');
  const events = metadataForPath('/events');
  const booking = metadataForPath('/booking/');

  assert.equal(home.indexable, true);
  assert.equal(events.indexable, true);
  assert.equal(booking.indexable, true);
  assert.notEqual(home.title, events.title);
  assert.notEqual(events.title, booking.title);
  assert.match(events.description, /2026/);
});

test('private, transactional and unknown routes are never indexed', () => {
  for (const path of ['/account', '/coaching', '/coach-invite', '/admin/orders', '/checkout-return', '/reset-password', '/missing']) {
    assert.equal(metadataForPath(path).indexable, false, path);
  }
});

test('sitemap contains indexable routes and excludes private screens', async () => {
  const sitemap = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  const robots = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');

  for (const path of ['/events', '/booking', '/training-guide', '/privacy']) {
    assert.ok(sitemap.includes(`<loc>${SITE_ORIGIN}${path}</loc>`), path);
  }
  assert.doesNotMatch(sitemap, /\/admin|\/account|\/checkout-return/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /^Disallow: \/coach-invite$/m);
  assert.ok(robots.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`));
});
