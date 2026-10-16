// Usage: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/verify-design.mjs
// Optional: --tag=before --routes=/,/admin --quick (390 and 1440 only).
// Runs only against its own loopback Vite server; external data I/O is blocked.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { installDesignFixtures } from '../test/fixtures/design-data.mjs';
import { checkPublicNavigation } from '../test/browser/public-navigation.mjs';
import { checkAdminShell } from '../test/browser/admin-shell.mjs';
import { checkAdminCommands } from '../test/browser/admin-commands.mjs';
import { checkAdminRecovery } from '../test/browser/admin-recovery.mjs';
import { checkAdminKit, checkAdminFilterGuard } from '../test/browser/admin-kit.mjs';
import { checkAdminCalendar } from '../test/browser/admin-calendar.mjs';
import { checkAttendeeSearch } from '../test/browser/admin-attendee-search.mjs';
import { checkVisitorPrices } from '../test/browser/admin-visitor-prices.mjs';
import { checkMembershipPaperwork } from '../test/browser/public-membership-paperwork.mjs';
import { checkPublicVisitorPrices } from '../test/browser/public-visitor-prices.mjs';
import { checkAdminLeads } from '../test/browser/admin-leads.mjs';
import { checkAdminHeaderLayout } from '../test/browser/admin-header.mjs';
import { checkAdminForms } from '../test/browser/admin-forms.mjs';
import { checkAdminMembers } from '../test/browser/admin-members.mjs';
import { checkAdminQR } from '../test/browser/admin-qr.mjs';
import { checkAdminFormsLoading } from '../test/browser/admin-forms-loading.mjs';
import { checkAdminMembersLoading } from '../test/browser/admin-members-loading.mjs';
import { checkAdminMemberFilters } from '../test/browser/admin-member-filters.mjs';
import { checkAdminOrders, checkAdminOrderDraft } from '../test/browser/admin-orders.mjs';
import { checkAdminToday } from '../test/browser/admin-today.mjs';

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback;
const tag = option('tag', 'current').replace(/[^a-z0-9_-]/gi, '-');
const kitOnly = process.argv.includes('--kit-only');
const routes = kitOnly ? [] : option('routes', '/,/admin').split(',');
const reducedMotion = option('motion', 'reduce') === 'reduce' ? 'reduce' : 'no-preference';
const output = resolve('.superpowers', 'design-proof', tag);
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://ugmkwoapjcpiucsrxwzt.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_LOCAL_DESIGN_FIXTURE_NOT_A_REAL_KEY'),
  },
});
let browser;
const results = [];
async function checkAnnouncement(page) {
  const banner = page.locator('[data-public-announcement]');
  if (!await banner.count()) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bar = await page.locator('[data-public-nav]').boundingBox();
  const notice = await banner.boundingBox();
  const logo = await page.locator('#main').getByRole('img', { name: 'XERT Fitness', exact: true }).boundingBox();
  assert.ok(notice.y >= bar.y + bar.height - 1, 'Announcement clears navigation');
  assert.ok(logo.y >= notice.y + notice.height - 1, 'Hero content clears the entire multiline announcement');
}
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const sizes = process.argv.includes('--quick') ? [[390, 844], [1440, 900]]
    : [[390, 844], [768, 1024], [1440, 900], [1920, 1080]];
  for (const [width, height] of sizes) {
    for (const signedIn of kitOnly ? [true] : [false, true]) {
      const requests = [];
      const failures = {};
      const mutations = [];
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion, hasTouch: true, serviceWorkers: 'block' });
      await installDesignFixtures(context, { origin, signedIn, requests, failures, announcement: process.argv.includes('--announcement'), commands: process.argv.includes('--commands'), calendar: process.argv.includes('--calendar-data'), leads: process.argv.includes('--lead-data'), forms: process.argv.includes('--form-data'), members: process.argv.includes('--member-data'), orders: process.argv.includes('--order-data'), today: process.argv.includes('--today-data'), mutations });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const path of routes) {
        if (path.startsWith('/admin') && !signedIn) continue;
        const prefix = `${width}-${signedIn ? 'signed-in' : 'signed-out'}-${path === '/' ? 'home' : path.slice(1).replaceAll('/', '-')}`;
        try {
          await page.goto(origin + path, { waitUntil: 'networkidle' });
          if (path === '/login' && !signedIn) {
            await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
            await page.getByLabel('Email', { exact: true }).waitFor();
            await page.getByLabel('Password', { exact: true }).waitFor();
          } else {
            await page.locator('main').first().waitFor();
          }
          if (path.startsWith('/admin') && process.argv.includes('--compact')) {
            // Choose the desktop-only preference before checking its retained mobile layout.
            if (width < 1024) await page.setViewportSize({ width: 1024, height });
            await page.getByRole('button', { name: /^(Compact|Comfortable) density$/ }).waitFor();
            const compact = page.getByRole('button', { name: 'Compact density', exact: true });
            if (await compact.count()) await compact.click();
            await page.locator('[data-admin-shell][data-density="compact"]').waitFor();
            if (width < 1024) await page.setViewportSize({ width, height });
          }
          if (path === '/') await checkAnnouncement(page);
          if (path === '/' && signedIn && width === 390) {
            const qr = await page.evaluate(async () => {
              const { renderBrandedFormQR, qrCanvasBlob } = await import('/src/lib/brandedFormQR.js');
              const canvas = document.createElement('canvas');
              await renderBrandedFormQR(canvas, new URL('/casual', location.origin).href);
              const blob = await qrCanvasBlob(canvas);
              return { width: canvas.width, height: canvas.height, type: blob.type, bytes: blob.size,
                corner: [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data], png: canvas.toDataURL('image/png') };
            });
            assert.equal(qr.width, 1024);
            assert.equal(qr.height, 1024);
            assert.equal(qr.type, 'image/png');
            assert.ok(qr.bytes > 1000, 'QR exports a nonempty PNG');
            assert.deepEqual(qr.corner, [255, 255, 255, 255], 'QR quiet zone remains opaque white');
            await writeFile(resolve(output, 'casual-qr.png'), Buffer.from(qr.png.split(',')[1], 'base64'));
          }
          await page.screenshot({ path: resolve(output, `${prefix}-rest.png`) });
          if (path.startsWith('/admin') && process.argv.includes('--header')) await checkAdminHeaderLayout(page);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
          assert.equal(overflow, false, 'Page must not overflow horizontally');
          if (path === '/') {
            await page.evaluate(() => window.scrollTo(0, 600));
            await page.screenshot({ path: resolve(output, `${prefix}-scrolled.png`) });
            const menu = page.locator('button[aria-controls="mobile-navigation"]');
            if (await menu.isVisible()) {
              await menu.click();
              await page.screenshot({ path: resolve(output, `${prefix}-menu.png`) });
              assert.equal(await menu.getAttribute('aria-expanded'), 'true');
              for (let step = 0; step < 18; step++) {
                await page.keyboard.press('Tab');
                assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('nav'))), true, 'Tab stays inside the open navigation');
              }
              await page.keyboard.press('Shift+Tab');
              assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('nav'))), true, 'Reverse Tab stays inside the open navigation');
              await page.keyboard.press('Escape');
              assert.equal(await menu.getAttribute('aria-expanded'), 'false');
              assert.equal(await menu.evaluate(el => el === document.activeElement), true, 'Escape restores menu trigger focus');
            }
          }
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          if (path === '/') await checkAnnouncement(page);
          const zoomMenu = page.locator('button[aria-controls="mobile-navigation"]');
          if (path === '/' && await zoomMenu.isVisible()) await zoomMenu.click();
          await page.screenshot({ path: resolve(output, `${prefix}-text-200.png`) });
          if (path.startsWith('/admin') && process.argv.includes('--header')) await checkAdminHeaderLayout(page);
          if (path === '/') {
            const clipped = await page.evaluate(() => {
              const nav = document.querySelector('[data-public-nav]');
              if (!nav) return [];
              return [...nav.querySelectorAll('a,button')].filter(el => !el.closest('#mobile-navigation') && el.checkVisibility({ visibilityProperty: true }))
                .filter(el => { const box = el.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1 || box.bottom > nav.getBoundingClientRect().bottom + 1; })
                .map(el => el.textContent.trim() || el.getAttribute('aria-label'));
            });
            assert.deepEqual(clipped, [], 'Public navigation controls are not clipped at 200% text');
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '200% text does not overflow horizontally');
          if (path === '/' && await zoomMenu.isVisible()) await page.keyboard.press('Escape');
          await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
          assert.deepEqual(errors, [], 'No browser runtime errors');
          results.push({ prefix, passed: true });
        } catch (error) {
          await page.screenshot({ path: resolve(output, `${prefix}-failure.png`) });
          const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')]
            .filter(el => {
              const box = el.getBoundingClientRect();
              if (!el.checkVisibility({ visibilityProperty: true }) || box.right <= innerWidth + 1) return false;
              for (let ancestor = el.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                if (getComputedStyle(ancestor).overflowX !== 'visible' && ancestor.getBoundingClientRect().right <= innerWidth + 1) return false;
              }
              return true;
            })
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
            .slice(0, 15).map(el => ({ tag: el.tagName, class: el.getAttribute('class'), text: el.textContent?.slice(0, 100), width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })));
          const textOverflow = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const entries = [];
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const parent = node.parentElement;
              if (!node.textContent.trim() || !parent?.checkVisibility({ visibilityProperty: true })) continue;
              let clipped = false;
              for (let ancestor = parent; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                if (getComputedStyle(ancestor).overflowX !== 'visible' && ancestor.getBoundingClientRect().right <= innerWidth + 1) { clipped = true; break; }
              }
              if (clipped) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const box of range.getClientRects()) {
                if (box.right > innerWidth + 1) entries.push({ text: node.textContent.slice(0, 100), tag: parent.tagName, class: parent.className, right: box.right });
              }
            }
            return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, text: entries.slice(0, 15) };
          });
          results.push({ prefix, passed: false, error: error.message, browserErrors: errors, overflow, textOverflow });
        }
        if (path === '/' && process.argv.includes('--navigation')) {
          try {
            await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
            await page.goto(origin, { waitUntil: 'networkidle' });
            await checkPublicNavigation(page, { origin, signedIn, failures });
            assert.deepEqual(errors, [], 'No browser runtime errors during navigation interactions');
            results.push({ prefix: `${prefix}-interactions`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-interaction-failure.png`) });
            results.push({ prefix: `${prefix}-interactions`, passed: false, error: error.message, browserErrors: errors });
          } finally {
            await page.setViewportSize({ width, height });
          }
        }
        if (path.startsWith('/admin') && signedIn && process.argv.includes('--shell')) {
          try {
            await page.goto(origin + path, { waitUntil: 'networkidle' });
            await checkAdminShell(page, { origin, width });
            assert.deepEqual(errors, [], 'No browser runtime errors during shell interactions');
            results.push({ prefix: `${prefix}-shell`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-shell-failure.png`) });
            results.push({ prefix: `${prefix}-shell`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin' && signedIn && process.argv.includes('--commands')) {
          try {
            await page.goto(origin + path, { waitUntil: 'networkidle' });
            await checkAdminCommands(page, { mutations, failures, requests, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No browser runtime errors during command actions');
            results.push({ prefix: `${prefix}-commands`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-commands-failure.png`) });
            results.push({ prefix: `${prefix}-commands`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/calendar' && signedIn && (process.argv.includes('--calendar') || process.argv.includes('--calendar-before'))) {
          try {
            await checkAdminCalendar(page, { origin, failures, baseline: process.argv.includes('--calendar-before'), capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during calendar workflows');
            results.push({ prefix: `${prefix}-calendar-flows`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-calendar-failure.png`) });
            results.push({ prefix: `${prefix}-calendar-flows`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (['/casual', '/3daypass', '/10pack', '/3months'].includes(path) && process.argv.includes('--public-visitor-prices')) {
          try {
            await checkPublicVisitorPrices(page, { origin, path, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during public price display checks');
            results.push({ prefix: `${prefix}-public-prices`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-public-prices-failure.png`) });
            results.push({ prefix: `${prefix}-public-prices`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/3months' && process.argv.includes('--membership-paperwork')) {
          try {
            await checkMembershipPaperwork(page, { origin, requests, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during membership paperwork handoff');
            results.push({ prefix: `${prefix}-membership-paperwork`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-membership-paperwork-failure.png`) });
            results.push({ prefix: `${prefix}-membership-paperwork`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/settings' && signedIn && process.argv.includes('--visitor-prices')) {
          try {
            await checkVisitorPrices(page, { origin, requests, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during visitor price draft changes');
            results.push({ prefix: `${prefix}-visitor-prices`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-visitor-prices-failure.png`) });
            results.push({ prefix: `${prefix}-visitor-prices`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/calendar' && signedIn && process.argv.includes('--calendar-search')) {
          try {
            await checkAttendeeSearch(page, { origin, failures, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during attendee search');
            results.push({ prefix: `${prefix}-attendee-search`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-attendee-search-failure.png`) });
            results.push({ prefix: `${prefix}-attendee-search`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/forms' && signedIn && (process.argv.includes('--forms-before') || process.argv.includes('--forms'))) {
          try {
            await checkAdminForms(page, { origin, failures, baseline: process.argv.includes('--forms-before'), capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }), capturePDF: name => page.pdf({ path: resolve(output, `${prefix}-${name}.pdf`), format: 'A4', printBackground: true }) });
            assert.deepEqual(errors, [], 'No runtime errors during form workflows');
            results.push({ prefix: `${prefix}-form-flows`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-forms-failure.png`) });
            results.push({ prefix: `${prefix}-form-flows`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/forms' && signedIn && process.argv.includes('--forms-loading')) {
          try {
            await checkAdminFormsLoading(page, { origin, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'Forms loading has no runtime errors');
            results.push({ prefix: `${prefix}-loading`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-loading-failure.png`) });
            results.push({ prefix: `${prefix}-loading`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/orders' && signedIn && (process.argv.includes('--orders-before') || process.argv.includes('--orders'))) {
          try {
            await checkAdminOrders(page, { origin, failures, baseline: process.argv.includes('--orders-before'), visitError: process.argv.includes('--orders-error') || process.argv.includes('--orders'), capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'Order workflows have no runtime errors');
            results.push({ prefix: `${prefix}-order-flows`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-order-flows-failure.png`) });
            results.push({ prefix: `${prefix}-order-flows`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/orders' && signedIn && process.argv.includes('--order-draft')) {
          try {
            await checkAdminOrderDraft(page, { origin, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'Refund draft guard has no runtime errors');
            results.push({ prefix: `${prefix}-order-draft`, passed: true });
          } catch (error) {
            results.push({ prefix: `${prefix}-order-draft`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin' && signedIn && (process.argv.includes('--today-before') || process.argv.includes('--today'))) {
          try {
            await checkAdminToday(page, { origin, failures, baseline: process.argv.includes('--today-before'), partialError: process.argv.includes('--today-error') || process.argv.includes('--today'), capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'Today workflows have no runtime errors');
            results.push({ prefix: `${prefix}-today-flows`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-today-flows-failure.png`) });
            results.push({ prefix: `${prefix}-today-flows`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (process.argv.includes('--qr') && signedIn) {
          try {
            await checkAdminQR(page, { capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during QR export');
            results.push({ prefix: `${prefix}-qr`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-qr-failure.png`) });
            results.push({ prefix: `${prefix}-qr`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/gym-members' && signedIn && (process.argv.includes('--members') || process.argv.includes('--members-before'))) {
          try {
            await checkAdminMembers(page, { origin, failures, baseline: process.argv.includes('--members-before'), geometry: process.argv.includes('--member-geometry') || process.argv.includes('--members'), noteGuard: process.argv.includes('--member-note-guard') || process.argv.includes('--members'), capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during member workflows');
            results.push({ prefix: `${prefix}-member-flows`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-member-failure.png`) });
            results.push({ prefix: `${prefix}-member-flows`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/gym-members' && signedIn && process.argv.includes('--member-filters')) {
          try {
            await checkAdminMemberFilters(page, { origin, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'Members composed filters have no runtime errors');
            results.push({ prefix: `${prefix}-member-filters`, passed: true });
          } catch (error) {
            results.push({ prefix: `${prefix}-member-filters`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/gym-members' && signedIn && process.argv.includes('--members-loading')) {
          try {
            await checkAdminMembersLoading(page, { origin, capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'Members loading has no runtime errors');
            results.push({ prefix: `${prefix}-member-loading`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-member-loading-failure.png`) });
            results.push({ prefix: `${prefix}-member-loading`, passed: false, error: error.message, browserErrors: errors });
          }
        }
        if (path === '/admin/members' && signedIn && (process.argv.includes('--leads') || process.argv.includes('--leads-before'))) {
          try {
            await checkAdminLeads(page, { origin, failures, baseline: process.argv.includes('--leads-before'), capture: name => page.screenshot({ path: resolve(output, `${prefix}-${name}.png`) }) });
            assert.deepEqual(errors, [], 'No runtime errors during lead workflows');
            results.push({ prefix: `${prefix}-lead-flows`, passed: true });
          } catch (error) {
            await page.screenshot({ path: resolve(output, `${prefix}-lead-failure.png`) });
            results.push({ prefix: `${prefix}-lead-flows`, passed: false, error: error.message, browserErrors: errors });
          }
        }
      }
      if (signedIn && process.argv.includes('--recovery')) {
        try {
          await checkAdminRecovery(context, { origin, capture: (targetPage, name) => targetPage.screenshot({ path: resolve(output, `${width}-${name}.png`) }) });
          results.push({ prefix: `${width}-workspace-recovery`, passed: true });
        } catch (error) {
          results.push({ prefix: `${width}-workspace-recovery`, passed: false, error: error.message });
        }
      }
      if (signedIn && (kitOnly || process.argv.includes('--kit'))) {
        try {
          await checkAdminKit(context, { origin, width, capture: (targetPage, name) => targetPage.screenshot({ path: resolve(output, `${width}-${name}.png`) }) });
          results.push({ prefix: `${width}-admin-kit`, passed: true });
        } catch (error) {
          results.push({ prefix: `${width}-admin-kit`, passed: false, error: error.message });
        }
        try {
          await checkAdminFilterGuard(context, { origin, capture: (targetPage, name) => targetPage.screenshot({ path: resolve(output, `${width}-${name}.png`) }) });
          results.push({ prefix: `${width}-admin-filter-guard`, passed: true });
        } catch (error) {
          results.push({ prefix: `${width}-admin-filter-guard`, passed: false, error: error.message });
        }
      }
      await writeFile(resolve(output, `${width}-${signedIn ? 'signed-in' : 'signed-out'}-requests.json`), JSON.stringify(requests, null, 2));
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ output, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
