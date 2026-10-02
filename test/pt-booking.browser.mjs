// End-to-end browser check of PT booking against the REAL migrations. The app
// runs unmodified in Chromium; its pt_* and staff_roster_* RPC calls are
// answered by PGlite running the roster migrations and
// 20261002030000_pt_booking.sql. Everything else uses the shared local
// design fixtures.
// SYNTHETIC DATA ONLY; no email can be sent and no request leaves the machine.
//
// Run: PLAYWRIGHT_MODULE=/path/to/playwright-core node test/pt-booking.browser.mjs [--screenshots=DIR]
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { installDesignFixtures } from './fixtures/design-data.mjs';
import { DEMO_COACHES, DEMO_OWNER, demoMonth, rpcAs } from './fixtures/staff-roster-demo.mjs';
import { BLACKOUTS, PT_MIGRATION_URL } from './helpers/pt-booking-world.mjs';
import { addMonths, monthKeyOf } from '../src/lib/staffRoster/time.js';
import { gymDateKey } from '../src/lib/gymTime.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const shotsArg = process.argv.find(arg => arg.startsWith('--screenshots='));
const shots = shotsArg ? resolve(shotsArg.split('=')[1]) : null;
if (shots) await mkdir(shots, { recursive: true });

const today = gymDateKey(new Date());
const riley = DEMO_COACHES.find(item => item.key === 'riley');
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL ${name}\n  ${error.stack}`); throw error; }
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

const { db } = await demoMonth({ month: addMonths(monthKeyOf(today), 2), today });
await db.exec(BLACKOUTS);
await db.exec(await readFile(PT_MIGRATION_URL, 'utf8'));
await db.exec(`update public.pt_settings set enabled = true;`);
let counter = 0;
const rid = () => `30000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const service = await rpcAs(db, riley.profileId, 'pt_coach_save_service', { p_service: { name: 'One-on-one strength', description: 'Technique, a plan and accountability.', duration_minutes: 60, price_cents: 9000, booking_mode: 'request' }, p_request_id: rid() });
await rpcAs(db, riley.profileId, 'pt_coach_save_package', { p_package: { service_id: service.id, name: '10-session pack', sessions_count: 10, price_cents: 80000, valid_days: 120 }, p_request_id: rid() });
await rpcAs(db, riley.profileId, 'pt_coach_save_hours', { p_hours: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: 300, end: 720 })), p_buffer_minutes: 15, p_expected_version: 0 });

async function ptContext(browser, origin, uid, viewport, { signedIn = true } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', deviceScaleFactor: viewport.width < 600 ? 2 : 1, timezoneId: 'Australia/Brisbane' });
  await installDesignFixtures(context, { origin, signedIn });
  for (const pattern of ['**/rest/v1/rpc/pt_*', '**/rest/v1/rpc/staff_roster_*']) {
    await context.route(pattern, async route => {
      const request = route.request();
      const name = new URL(request.url()).pathname.split('/').at(-1);
      const args = request.method() === 'POST' ? request.postDataJSON() || {} : Object.fromEntries(new URL(request.url()).searchParams);
      try {
        const result = await rpcAs(db, uid, name, args);
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(result) });
      } catch (error) {
        await route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ code: error.code || 'P0001', message: error.message, details: null, hint: null }) });
      }
    });
  }
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|favicon|blockedbyclient|ERR_BLOCKED|403|400/.test(message.text())) problems.push(message.text()); });
  return { context, page, problems };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://ugmkwoapjcpiucsrxwzt.supabase.co'),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_LOCAL_DESIGN_FIXTURE_NOT_A_REAL_KEY'),
} });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });

  const visitor = await ptContext(browser, origin, null, { width: 390, height: 844 }, { signedIn: false });
  let manageUrl = '';
  await step('a visitor sees the coach, their session and price', async () => {
    const { page } = visitor;
    await page.goto(`${origin}/pt`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Riley Synthetic' }).waitFor();
    assert.ok(await page.getByText('$90').first().isVisible());
    await shot(page, '01-pt-coaches-phone');
  });
  await step('a visitor picks a package and an open time, and requests it', async () => {
    const { page } = visitor;
    await page.getByRole('button', { name: /One-on-one strength/ }).click();
    await page.getByText('10-session pack').click();
    await page.getByText(/save \$100/).waitFor();
    await page.getByRole('button', { name: /^\d{1,2}:\d{2} (am|pm)$/ }).first().waitFor();
    await shot(page, '02-pt-times-phone');
    // A week out, so the booking is well before the online cancel cut-off.
    await page.getByRole('button', { name: 'Later dates' }).click();
    const firstTime = page.getByRole('button', { name: /^\d{1,2}:\d{2} (am|pm)$/ }).first();
    await firstTime.waitFor();
    await firstTime.click();
    await page.getByLabel('Your name').fill('Sam Visitor');
    await page.getByLabel('Email').fill('sam@example.invalid');
    await page.getByLabel('Mobile (optional)').fill('0400 000 111');
    await shot(page, '03-pt-details-phone');
    await page.getByRole('button', { name: 'Request this time' }).click();
    await page.getByRole('heading', { name: 'Request sent' }).waitFor();
    await page.getByText(/9 left after this one/).waitFor();
    await shot(page, '04-pt-request-sent-phone');
    manageUrl = await page.getByRole('link', { name: 'View or cancel this booking' }).getAttribute('href');
    assert.match(manageUrl, /^\/pt\/booking\?token=/);
  });

  const coach = await ptContext(browser, origin, riley.profileId, { width: 390, height: 844 });
  await step('the coach confirms the request from the PT tab', async () => {
    const { page } = coach;
    await page.goto(`${origin}/coaching?tab=pt`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /^PT/ }).waitFor();
    await page.getByText('Requests to answer').waitFor();
    await page.getByText(/Sam Visitor/).first().waitFor();
    await shot(page, '05-coach-pt-requests-phone');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.getByText('Requests to answer').waitFor({ state: 'detached' });
    await page.getByText('Booked', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Clients' }).click();
    await page.getByText('Sam Visitor').click();
    await page.getByText(/10-session pack · \$800 · 9 of 10 left/).waitFor();
    await shot(page, '06-coach-pt-client-phone');
    await page.getByRole('tab', { name: 'Prices' }).click();
    await page.getByText('10-session pack · 10 sessions · $800 · 120 days').waitFor();
    await shot(page, '07-coach-pt-prices-phone');
    await page.getByRole('tab', { name: 'Hours' }).click();
    await page.getByRole('heading', { name: 'When can people book you?' }).waitFor();
    await page.getByText('Every day 5 am–12 pm').waitFor();
    const evening = page.getByRole('button', { name: /^Saturday evening/ });
    assert.equal(await evening.getAttribute('aria-pressed'), 'false');
    await evening.click();
    await page.getByText('Not saved yet').waitFor();
    await page.getByRole('button', { name: 'Save my hours' }).click();
    await page.getByText('Not saved yet').waitFor({ state: 'detached' });
    assert.equal(await evening.getAttribute('aria-pressed'), 'true');
    await page.getByRole('heading', { name: 'Going away?' }).waitFor();
    await shot(page, '08-coach-pt-hours-phone');
  });

  await step('the visitor’s link shows the confirmed booking and cancels it', async () => {
    const { page } = visitor;
    await page.goto(`${origin}${manageUrl}`, { waitUntil: 'networkidle' });
    await page.getByText('Booked', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel this booking' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await page.getByText('You cancelled this session.').waitFor();
    await shot(page, '09-pt-booking-cancelled-phone');
  });

  const owner = await ptContext(browser, origin, DEMO_OWNER, { width: 1440, height: 1000 });
  await step('the owner sees the PT switch and coaches in Personal training', async () => {
    const { page } = owner;
    await page.goto(`${origin}/admin/pt-requests`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'PT booking' }).waitFor();
    await page.getByText('1 of 6 coaches have a price and hours set.', { exact: false }).waitFor();
    await shot(page, '10-owner-pt-booking');
  });

  for (const [name, ctx] of [['visitor', visitor], ['coach', coach], ['owner', owner]]) {
    assert.deepEqual(ctx.problems, [], `${name} page errors`);
  }
} finally {
  await browser?.close();
  await server.close();
}
console.log(`\n${results.filter(r => r.ok).length}/${results.length} browser steps passed`);
