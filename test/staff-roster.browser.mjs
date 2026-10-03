// End-to-end browser check of the staff roster against the REAL migration.
// The app runs unmodified in Chromium; its Supabase RPC calls are answered by
// PGlite running the roster migrations (20261001010000_staff_roster.sql,
// 20261002010000_staff_roster_push_reliability.sql, then
// 20261002020000_staff_roster_coach_dashboard.sql) over a synthetic month. Everything else uses the shared local design fixtures.
// SYNTHETIC DATA ONLY; email notices are off and no request leaves the machine.
//
// Run: PLAYWRIGHT_MODULE=/path/to/playwright-core node test/staff-roster.browser.mjs [--screenshots=DIR]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { fixtureSession, fixtureUser, installDesignFixtures } from './fixtures/design-data.mjs';
import { as } from './helpers/staff-roster-db.mjs';
import { DEMO_COACHES, DEMO_OWNER, demoMonth, rpcAs } from './fixtures/staff-roster-demo.mjs';
import { addDays, addMonths, datesOfMonth, gymInstant, gymInstantIso, monthKeyOf, weekdayOf } from '../src/lib/staffRoster/time.js';
import { partMonthStartRange, planPartMonthOpening } from '../src/lib/staffRoster/cycle.js';
import { gymDateKey } from '../src/lib/gymTime.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const shotsArg = process.argv.find(arg => arg.startsWith('--screenshots='));
const shots = shotsArg ? resolve(shotsArg.split('=')[1]) : null;
if (shots) await mkdir(shots, { recursive: true });

const today = gymDateKey(new Date());
const MONTH = addMonths(monthKeyOf(today), 2);
const firstMonday = datesOfMonth(MONTH).find(date => weekdayOf(date) === 1);
const MONTH_WORD = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(MONTH.slice(5)) - 1];
const dayLabel = date => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(date)]} ${Number(date.slice(8))} ${MONTH_WORD.slice(0, 3)}`;
const coach = key => DEMO_COACHES.find(item => item.key === key);
const results = [];
const step = async (name, fn) => {
  const started = performance.now();
  try { await fn(); results.push({ name, ok: true, ms: Math.round(performance.now() - started) }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log(`FAIL ${name}\n  ${error.stack}`); throw error; }
};

const { db } = await demoMonth({ month: MONTH, today });
// Stand-ins for the member booking tables the class details read (synthetic rows only).
await db.exec(`
  create table public.session_bookings (id uuid primary key default gen_random_uuid(), user_id uuid not null, class_session_id uuid not null,
    status text not null default 'confirmed', created_at timestamptz not null default now());
  create table public.class_bookings (id uuid primary key default gen_random_uuid(), class_session_id uuid not null, full_name text, email text, phone text,
    status text not null default 'confirmed', guest_visit boolean not null default false, created_at timestamptz not null default now());`);
const rpcLog = [];
const pushRequests = [];
// PGlite has one session and rpcAs sets the caller before each call, so calls
// run one at a time: a call can never run as someone else's account.
let rpcQueue = Promise.resolve();
const serialRpc = (uid, name, args) => {
  const run = rpcQueue.then(() => rpcAs(db, uid, name, args));
  rpcQueue = run.catch(() => {});
  return run;
};
// Roster texts: the REAL sender (api/admin-publish-announcement.js) runs here
// against the database, with Twilio replaced by a recorder. No request can
// reach Twilio: `twilio.calls` is the only place a text goes.
const { sendRosterSms } = await import('../api/admin-publish-announcement.js');
const twilio = { calls: [], configured: true };
const SMS_CREDENTIALS = { accountSid: 'ACsyntheticbrowser', authToken: 'synthetic-token', fromNumber: '+61400000999' };
const serviceRole = { rpc: async (name, args) => {
  try { return { data: await serialRpc(null, name, args), error: null }; } catch (error) { return { data: null, error: { message: error.message } }; }
} };
const twilioRecorder = async (url, init) => {
  assert.match(String(url), /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/ACsyntheticbrowser\/Messages\.json$/);
  const params = Object.fromEntries(new URLSearchParams(init.body));
  twilio.calls.push(params);
  return new Response(JSON.stringify({ sid: `SMsynthetic${twilio.calls.length}`, status: 'queued' }), { status: 201 });
};
const smsRequests = [];

async function rosterContext(browser, origin, uid, viewport, { signedIn = true } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', deviceScaleFactor: viewport.width < 600 ? 2 : 1, timezoneId: 'Australia/Brisbane' });
  await installDesignFixtures(context, { origin, signedIn });
  await context.route('**/rest/v1/rpc/staff_roster_*', async route => {
    const request = route.request();
    const name = new URL(request.url()).pathname.split('/').at(-1);
    const args = request.method() === 'POST' ? request.postDataJSON() || {} : {};
    rpcLog.push({ uid, name });
    try {
      const result = await serialRpc(uid, name, args);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(result) });
    } catch (error) {
      await route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ code: error.code || 'P0001', message: error.message, details: error.detail || null, hint: null }) });
    }
  });
  // The phone-push nudge is answered locally; nothing is sent anywhere.
  await context.route('**/api/push-subscription', async route => {
    pushRequests.push({ uid, authorization: route.request().headers().authorization || '', body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: false, claimed: 0, attempted: 0 }) });
  });
  // Roster texts go to the real sender with Twilio stubbed (see above).
  await context.route('**/api/admin-publish-announcement', async route => {
    const body = route.request().postDataJSON() || {};
    smsRequests.push({ uid, authorization: route.request().headers().authorization || '', body });
    if (uid !== DEMO_OWNER || body.action !== 'send_roster_sms') {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Admin access required.' }) });
    }
    const result = await sendRosterSms(serviceRole, { credentials: twilio.configured ? SMS_CREDENTIALS : null, fetcher: twilioRecorder, baseUrl: 'https://xert.example.test', sleep: async () => {} });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|favicon|blockedbyclient|ERR_BLOCKED|403/.test(message.text())) problems.push(message.text()); });
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

  const manager = await rosterContext(browser, origin, DEMO_OWNER, { width: 1440, height: 1000 });
  const page = manager.page;

  const NEXT_MONTH = addMonths(MONTH, 1);
  await step('guided month: a new month asks coaches with suggested dates, no typing', async () => {
    await page.goto(`${origin}/admin/roster?rosterMonth=${NEXT_MONTH}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Coach roster', exact: true }).waitFor();
    const guide = page.getByRole('group', { name: /steps$/ });
    await guide.getByText('Step 2 of 5: Ask for availability').waitFor();
    await guide.locator('[aria-current="step"]').getByText('Next', { exact: true }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/21-manager-guide-ask.png`, fullPage: true });
    await guide.getByRole('button', { name: /^Ask coaches for availability/ }).click();
    await page.getByRole('radio', { name: 'Availability', checked: true }).waitFor();
    await page.getByText('Due by', { exact: true }).first().waitFor();
    await page.getByText('Aim to publish by', { exact: true }).first().waitFor();
    assert.equal(await page.locator('input[type="date"]').count(), 0, 'dates are suggested; no date field until Byron asks to change them');
    if (shots) await page.screenshot({ path: `${shots}/22-manager-ask-coaches.png`, fullPage: true });
    await page.getByRole('button', { name: /^Ask coaches/ }).last().click();
    await page.getByText(/Coaches asked\./).first().waitFor();
    const { rows } = await db.query(`select due_on::text, publish_target_on::text from public.staff_roster_periods where month = $1`, [`${NEXT_MONTH}-01`]);
    assert.equal(rows.length, 1, 'the month is open for availability');
    await guide.getByText('Step 3 of 5: Wait for answers').waitFor();
    await guide.getByText(/^0 of \d+ in/).waitFor();
  });

  await step('guided month on a 375px phone: steps stack, nothing scrolls sideways', async () => {
    const small = await rosterContext(browser, origin, DEMO_OWNER, { width: 375, height: 812 });
    await small.page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}`, { waitUntil: 'networkidle' });
    await small.page.getByText(/^Step \d of 5:/).waitFor();
    const overflow = await small.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll at 375px (overflow ${overflow}px)`);
    if (shots) await small.page.screenshot({ path: `${shots}/23-manager-guide-phone.png`, fullPage: true });
    assert.deepEqual(small.problems, []);
    await small.context.close();
  });

  await step('manager opens the roster in the Classes hub', async () => {
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterView=month`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Coach roster', exact: true }).waitFor();
    await page.getByText('Nothing published for this month yet').waitFor();
    // Quinn hasn't answered yet, so the guide is waiting on answers and says how many are in.
    // (Step 4 once the due date has passed, depending on today's date.)
    await page.getByText(/^Step [34] of 5: (Wait for answers|Build the roster)$/).waitFor();
    await page.getByText(/^\d+ of \d+ in/).waitFor();
  });

  await step('the guide’s Suggest previews the whole month, then adds to the draft without publishing', async () => {
    await page.getByRole('group', { name: /steps$/ }).getByRole('button', { name: /^Suggest a roster/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Suggested coaches' });
    await drawer.getByText(/Search (finished|limit reached)/).waitFor();
    await drawer.getByText(/For all of /).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/02-suggest-draft-preview.png` });
    await drawer.getByRole('button', { name: /^Add \d+ to the roster draft/ }).click();
    await drawer.waitFor({ state: 'hidden' });
    await page.getByText(/^Draft — coaches can’t see these changes yet/).first().waitFor();
    const { rows } = await db.query(`select state, (select count(*) from public.staff_assignments a where a.revision_id = r.id)::int as n from public.staff_roster_revisions r`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'draft', 'suggesting never publishes');
    assert.ok(rows[0].n > 60, `expected a full draft, got ${rows[0].n}`);
  });

  await step('week view shows coverage on every class; gaps and joint shortages are explained', async () => {
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterView=week&rosterDate=${firstMonday}`, { waitUntil: 'networkidle' });
    await page.getByRole('region', { name: /^Mon / }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/01-manager-roster-week.png`, fullPage: true });
    await page.getByLabel('Only classes needing a coach').check();
    await page.getByText(/more classes than available coaches|coaching spots filled/).first().waitFor();
    if (shots) await page.screenshot({ path: `${shots}/03-coverage-shortage.png`, fullPage: true });
    await page.getByLabel('Only classes needing a coach').uncheck();
  });

  await step('assignment drawer explains who can and cannot take a position', async () => {
    await page.getByRole('button', { name: /Lead coach.*Open details|Lead coach open for/ }).first().click();
    const drawer = page.getByRole('dialog').last();
    await drawer.getByText(/^Can’t take it \(\d+\)/).waitFor();
    await drawer.getByRole('button', { name: 'Show reasons' }).click();
    await drawer.getByText(/Said they are unavailable|Has not said they are available|Already coaching/).first().waitFor();
    if (shots) await page.screenshot({ path: `${shots}/04-assignment-drawer.png` });
    await drawer.getByRole('button', { name: 'Close position details' }).click();
  });

  await step('Move… / Place here moves a coach by keyboard, and the server checks every placement', async () => {
    // From the real draft, pick one assignment in this week (coach C) and a
    // position held by someone else that C could take if it were open. Open
    // that position server-side as the manager would, so the move has a valid
    // target; any position C cannot take serves as the refused target.
    const weekEnd = addDays(firstMonday, 7);
    const pairSql = `
      with d as (select id from public.staff_roster_revisions where state = 'draft'),
      wk as (select * from public.staff_roster_sessions($1::timestamptz, $2::timestamptz)
        where status in ('draft', 'published', 'full') and starts_at > now()),
      slots as (
        select wk.session_id, x->>'key' as slot_key, x->>'role' as role,
          (select a.id from public.staff_assignments a where a.revision_id = (select id from d) and a.session_id = wk.session_id and a.slot_key = x->>'key') as holder
        from wk, jsonb_array_elements(public.staff_roster_normalize_slots(wk.slots)) x where (x->>'required')::boolean),
      src as (select a.* from public.staff_assignments a join wk on wk.session_id = a.session_id where a.revision_id = (select id from d) and not a.pinned)
      select src.id, src.staff_id, src.session_id as from_session, src.slot_key as from_slot, src.role as from_role,
        o.session_id as to_session, o.slot_key as to_slot, o.role as to_role, o.holder,
        public.staff_roster_assignment_problems(src.revision_id, o.session_id, o.slot_key, src.staff_id,
          array_remove(array[src.id, o.holder], null)) as problems
      from src cross join slots o
      where o.session_id <> src.session_id
      order by src.id, o.session_id, o.slot_key`;
    const { rows: pairs } = await db.query(pairSql, [gymInstantIso(firstMonday, 0), gymInstantIso(weekEnd, 0)]);
    const good = pairs.find(row => row.problems.length === 0);
    assert.ok(good, 'the synthetic week has a coach who could take another position');
    const bad = pairs.find(row => row.id === good.id && row.holder === null && row.problems.length > 0);
    assert.ok(bad, 'and an open position the same coach cannot take');
    if (good.holder) {
      const draft = (await db.query(`select version from public.staff_roster_revisions where state = 'draft'`)).rows[0];
      await serialRpc(DEMO_OWNER, 'staff_roster_apply_changes', { p_month: `${MONTH}-01`, p_expected_version: draft.version,
        p_changes: [{ op: 'unassign', assignment_id: good.holder }], p_request_id: crypto.randomUUID() });
    }
    const name = (await db.query('select display_name from public.staff_members where id = $1', [good.staff_id])).rows[0].display_name;
    const label = role => ({ lead: 'Lead coach', assistant: 'Assistant', shadow: 'Shadow' })[role];
    const applyCalls = () => rpcLog.filter(item => item.name === 'staff_roster_apply_changes').length;

    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterView=week&rosterDate=${firstMonday}`, { waitUntil: 'networkidle' });
    const startMove = async () => {
      const chip = page.locator(`#roster-session-${good.from_session}`).getByRole('button', { name: new RegExp(`^${label(good.from_role)}: ${name}`) });
      await chip.focus();
      await page.keyboard.press('Enter');
      const drawer = page.getByRole('dialog').last();
      const move = drawer.getByRole('button', { name: 'Move…' });
      await move.focus();
      await page.keyboard.press('Enter');
      await page.getByText(`Moving ${name}`).waitFor();
    };
    const placeButton = row => page.locator(`#roster-session-${row.to_session} .staff-roster-slot`)
      .filter({ has: page.getByText(label(row.to_role), { exact: true }) })
      .getByRole('button', { name: `Place ${name} here` });

    // Escape cancels a move without touching anything.
    await startMove();
    await placeButton(good).waitFor();
    await page.keyboard.press('Escape');
    await page.getByText(`Moving ${name}`).waitFor({ state: 'hidden' });
    assert.equal(await placeButton(good).count(), 0, 'Place here buttons go away after Escape');

    // A placement the rules forbid is refused by the server; nothing moves.
    const before = applyCalls();
    await startMove();
    await placeButton(bad).focus();
    await page.keyboard.press('Enter');
    await page.getByText('Not saved').first().waitFor();
    assert.equal(applyCalls(), before + 1, 'the placement went to the server');
    const kept = await db.query('select session_id, slot_key, staff_id from public.staff_assignments where id = $1', [good.id]);
    assert.deepEqual(kept.rows, [{ session_id: good.from_session, slot_key: good.from_slot, staff_id: good.staff_id }], 'a refused move leaves the coach where they were');
    if (shots) await page.screenshot({ path: `${shots}/04b-move-refused.png` });

    // A valid placement moves the coach in one server-checked change.
    const version = (await db.query(`select version from public.staff_roster_revisions where state = 'draft'`)).rows[0].version;
    await startMove();
    if (shots) await page.screenshot({ path: `${shots}/04c-move-place-here.png`, fullPage: true });
    await placeButton(good).focus();
    await page.keyboard.press('Enter');
    await page.getByText('Coach moved').first().waitFor();
    assert.equal(applyCalls(), before + 2);
    const gone = await db.query('select count(*)::int as n from public.staff_assignments where id = $1', [good.id]);
    assert.equal(gone.rows[0].n, 0, 'the old assignment is replaced, not copied');
    const { rows: placed } = await db.query(`select a.staff_id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'draft'
      where a.session_id = $1 and a.slot_key = $2`, [good.to_session, good.to_slot]);
    assert.deepEqual(placed.map(row => row.staff_id), [good.staff_id], 'the coach now holds the new position');
    const { rows: vacated } = await db.query(`select count(*)::int as n from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'draft'
      where a.session_id = $1 and a.slot_key = $2`, [good.from_session, good.from_slot]);
    assert.equal(vacated[0].n, 0, 'the old position is open again');
    const after = await db.query(`select version, state from public.staff_roster_revisions where state in ('draft', 'published')`);
    assert.deepEqual(after.rows, [{ version: version + 1, state: 'draft' }], 'one draft edit; nothing was published');
    const audit = await db.query(`select count(*)::int as n from public.staff_roster_audit_events where action = 'assignment_moved' and entity_id = (
      select a.id::text from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'draft' where a.session_id = $1 and a.slot_key = $2)`, [good.to_session, good.to_slot]);
    assert.equal(audit.rows[0].n, 1, 'the move is audited');
    await page.locator(`#roster-session-${good.to_session}`).getByRole('button', { name: new RegExp(`^${label(good.to_role)}: ${name}`) }).waitFor();
  });

  await step('publishing with gaps needs a reason, then coaches are notified in the app only', async () => {
    await page.getByRole('button', { name: 'Review & publish' }).click();
    const dialog = page.getByRole('dialog', { name: /^Publish / });
    const publish = dialog.getByRole('button', { name: /^Publish/ });
    const gaps = await dialog.getByText(/required spots? (is|are) still open/).count();
    if (gaps) {
      assert.equal(await publish.isDisabled(), true, 'cannot publish gaps without a reason');
      await dialog.getByLabel(/Why publish with empty spots/).fill('Synthetic demo: hiring a weekend coach');
    }
    if (shots) await page.screenshot({ path: `${shots}/05-publish-review.png` });
    await publish.click();
    await page.getByText(/ roster published$/).first().waitFor();
    const { rows } = await db.query(`select state, number from public.staff_roster_revisions`);
    assert.deepEqual(rows.map(row => row.state), ['published']);
    const notices = await db.query(`select count(*)::int as n, count(*) filter (where email_status <> 'not_requested')::int as emailed from public.staff_notifications where kind = 'roster_published'`);
    assert.ok(notices.rows[0].n >= 3, 'affected coaches get an inbox notice');
    assert.equal(notices.rows[0].emailed, 0, 'email is off, so nothing is queued to send');
    for (let tries = 0; tries < 50 && !pushRequests.some(item => item.uid === DEMO_OWNER); tries++) await new Promise(done => setTimeout(done, 100));
    const nudge = pushRequests.find(item => item.uid === DEMO_OWNER);
    assert.ok(nudge, 'publishing asks the server to push the new notices');
    assert.match(nudge.authorization, /^Bearer \S+/);
    assert.equal(nudge.body, JSON.stringify({ action: 'staff_roster_push' }), 'no roster detail goes with the push request');
  });

  const quinn = await rosterContext(browser, origin, coach('quinn').profileId, { width: 375, height: 812 });
  await step('coach gives availability on a 375px phone: days first, then each class, free time on a day with no classes, autosave, review, submit', async () => {
    const phone = quinn.page;
    await phone.goto(`${origin}/coaching?tab=availability&month=${MONTH}`, { waitUntil: 'networkidle' });
    await phone.getByRole('heading', { name: /Hi Quinn Synthetic/ }).waitFor();
    await phone.getByText('What we need from you').waitFor();
    await phone.getByRole('heading', { name: new RegExp(`^Your availability for ${MONTH_WORD} classes \\(1–\\d+ ${MONTH_WORD.slice(0, 3)}\\)$`) }).waitFor();
    await phone.getByText('Send your answers by', { exact: true }).waitFor();
    await phone.getByText('Not started', { exact: true }).waitFor();
    const calendar = phone.getByRole('group', { name: `Days in ${MONTH_WORD} ${MONTH.slice(0, 4)}` });
    const dayButton = date => calendar.getByRole('button', { name: new RegExp(`^${dayLabel(date)},`) });
    const panel = date => phone.getByRole('region', { name: `${dayLabel(date)} classes` });
    await dayButton(firstMonday).and(phone.locator(':enabled')).waitFor();
    assert.equal(await phone.getByRole('radio', { name: /I can work/ }).getAttribute('aria-checked'), 'true', 'a tap marks "can work" to start with');

    // Every Tuesday and Thursday: every class on those days starts as Can do.
    await phone.getByRole('button', { name: 'Every Tuesday' }).click();
    await phone.getByRole('button', { name: 'Every Thursday' }).click();
    const tuesday = datesOfMonth(MONTH).find(date => weekdayOf(date) === 2);
    await dayButton(tuesday).getByText('Work').waitFor();

    // A Saturday: prefer the 6:15 Engine.
    const saturday = datesOfMonth(MONTH).find(date => weekdayOf(date) === 6);
    await dayButton(saturday).click();
    await panel(saturday).getByRole('button', { name: 'Prefer: 6:15 am Saturday Engine' }).click();
    await panel(saturday).getByRole('button', { name: 'Prefer: 6:15 am Saturday Engine' }).and(phone.locator('[aria-pressed="true"]')).waitFor();
    assert.equal(await panel(saturday).getByRole('button', { name: 'Can do: 9:30 am Saturday Strength' }).getAttribute('aria-pressed'), 'true', 'other classes default to Can do');

    // A Wednesday: can't do the 4:30 pm Engine.
    const wednesday = datesOfMonth(MONTH).find(date => weekdayOf(date) === 3);
    await dayButton(wednesday).click();
    await panel(wednesday).getByRole('button', { name: 'Can’t: 4:30 pm Engine 4:30' }).click();
    await panel(wednesday).getByRole('button', { name: 'Can’t: 4:30 pm Engine 4:30' }).and(phone.locator('[aria-pressed="true"]')).waitFor();

    // A Sunday has no classes, so it asks for free time instead.
    const sunday = datesOfMonth(MONTH).find(date => weekdayOf(date) === 0);
    await dayButton(sunday).click();
    await panel(sunday).getByText('No classes on the timetable this day yet. When are you free?').waitFor();
    await panel(sunday).getByRole('button', { name: /^All day/ }).and(phone.locator('[aria-pressed="true"]')).waitFor();
    await panel(sunday).getByRole('button', { name: /^Evening/ }).click();
    await panel(sunday).getByRole('button', { name: /^Evening/ }).and(phone.locator('[aria-pressed="true"]')).waitFor();

    // Away on one Tuesday.
    const awayDay = datesOfMonth(MONTH).find(date => weekdayOf(date) === 2 && date > firstMonday);
    await phone.getByRole('radio', { name: /I’m away/ }).click();
    await dayButton(awayDay).click();
    await dayButton(awayDay).getByText('Away').waitFor();
    await phone.getByText(/^Can work \d+ days · Away 1 day$/).waitFor();

    await phone.getByText('Draft saved. Not sent to the manager until you submit.').waitFor({ timeout: 10000 });
    await phone.getByText('Draft saved', { exact: true }).waitFor();
    const draft = await db.query(`select count(*)::int as n, (select payload from public.staff_availability_drafts limit 1) as payload from public.staff_availability_drafts`);
    assert.equal(draft.rows[0].n, 1, 'autosave writes a draft, not a submission');
    const saved = draft.rows[0].payload;
    assert.deepEqual(saved.weekly, [], 'day-first answers are dates only');
    assert.deepEqual(saved.exceptions.filter(item => item.date === awayDay), [{ date: awayDay, start: 0, end: 1440, status: 'UNAVAILABLE' }]);
    assert.deepEqual(saved.exceptions.filter(item => item.date === sunday), [{ date: sunday, start: 960, end: 1260, status: 'AVAILABLE' }]);
    assert.equal(saved.exceptions.filter(item => item.date === firstMonday).length, 0, 'a Monday nobody tapped stays not stated');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll at 375px (overflow ${overflow}px)`);
    const small = await phone.evaluate(() => [...document.querySelectorAll('.coaching-day, .coaching-every-day, .coaching-brush button, .coaching-day-states button, .coaching-class-choices button, .coaching-presets button')]
      .map(node => node.getBoundingClientRect()).filter(box => box.width < 44 || box.height < 44).length);
    assert.equal(small, 0, 'every calendar, day and class button is at least 44px');
    if (shots) await phone.screenshot({ path: `${shots}/06-coach-availability-phone.png`, fullPage: true });
    await phone.getByRole('button', { name: 'Review and submit' }).click();
    await phone.getByText(/^You can do \d+ classes? of \d+, prefer 1, can’t do \d+, away 1 day, free on 1 day with no classes\.$/).first().waitFor();
    if (shots) await phone.screenshot({ path: `${shots}/07-coach-availability-review-phone.png`, fullPage: true });
    await phone.getByRole('button', { name: `Submit ${MONTH_WORD} classes` }).click();
    await phone.getByText(/submitted/).first().waitFor();
    await phone.getByText('Submitted', { exact: true }).waitFor();
    const submitted = await db.query(`select s.version, s.staff_id from public.staff_availability_submissions s join public.staff_members m on m.id = s.staff_id where m.display_name = 'Quinn Synthetic'`);
    assert.deepEqual(submitted.rows.map(row => row.version), [1]);

    // What the manager's "who can take what" matrix now shows for Quinn.
    const matrix = await serialRpc(DEMO_OWNER, 'staff_roster_planning_snapshot', { p_month: `${MONTH}-01` });
    const quinnId = submitted.rows[0].staff_id;
    const classAt = (date, minute) => matrix.sessions.find(item => item.start === gymInstantIso(date, minute) || new Date(item.start).getTime() === new Date(gymInstantIso(date, minute)).getTime());
    const statusOf = (date, minute) => matrix.availability.find(item => item.staff_id === quinnId && item.session_id === classAt(date, minute)?.id)?.status || 'UNKNOWN';
    assert.equal(statusOf(tuesday, 315), 'AVAILABLE');
    assert.equal(statusOf(saturday, 375), 'PREFERRED');
    assert.equal(statusOf(saturday, 570), 'AVAILABLE');
    assert.equal(statusOf(wednesday, 990), 'UNAVAILABLE');
    assert.equal(statusOf(wednesday, 315), 'AVAILABLE');
    assert.equal(statusOf(awayDay, 315), 'UNAVAILABLE');
    assert.equal(statusOf(firstMonday, 315), 'UNKNOWN', 'blank days are unanswered, never available');
  });

  const riley = await rosterContext(browser, origin, coach('riley').profileId, { width: 390, height: 844 });
  let coverSession = null;
  await step('coach sees only published classes on a phone and asks for cover', async () => {
    const phone = riley.page;
    // /coaching now opens Home; the classes list is its own tab.
    await phone.goto(`${origin}/coaching?tab=roster`, { waitUntil: 'networkidle' });
    await phone.getByText(/Your .* roster changed/).first().waitFor();
    if (shots) await phone.screenshot({ path: `${shots}/08-coach-roster-phone.png`, fullPage: true });
    await phone.getByRole('button', { name: 'I’ve seen it' }).click();
    await phone.getByText(/marked as seen/).first().waitFor();
    await phone.getByRole('button', { name: 'Ask for cover' }).first().click();
    await phone.getByRole('dialog', { name: 'Ask for cover' }).getByRole('button', { name: 'Ask for cover', exact: true }).click();
    await phone.getByText(/Cover requested\. Other coaches can offer/).first().waitFor();
    const { rows } = await db.query(`select session_id, status from public.staff_cover_requests`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'open');
    coverSession = rows[0].session_id;
  });

  let volunteer = null;
  await step('another coach volunteers; volunteering alone changes nothing', async () => {
    for (const candidate of DEMO_COACHES.filter(item => item.key !== 'riley' && item.key !== 'taylor')) {
      const board = await serialRpc(candidate.profileId, 'staff_roster_cover_board', {});
      if (board.length && board[0].problems.length === 0) { volunteer = candidate; break; }
    }
    assert.ok(volunteer, 'some synthetic coach can cover');
    const other = await rosterContext(browser, origin, volunteer.profileId, { width: 390, height: 844 });
    await other.page.goto(`${origin}/coaching?tab=requests`, { waitUntil: 'networkidle' });
    await other.page.getByRole('button', { name: 'I can cover this' }).click();
    await other.page.getByText(/only once the manager approves/).first().waitFor();
    if (shots) await other.page.screenshot({ path: `${shots}/09-coach-cover-board-phone.png`, fullPage: true });
    const { rows } = await db.query(`select a.staff_id = m.id as still_riley from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published'
      join public.staff_members m on m.display_name = 'Riley Synthetic' where a.session_id = $1`, [coverSession]);
    assert.ok(rows.some(row => row.still_riley), 'the original coach stays rostered until a manager approves');
    await other.context.close();
  });

  await step('manager approves the volunteer: one new published version, original coach released', async () => {
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterTab=requests`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: `Approve ${volunteer.name}` }).click();
    await page.getByText(/approved\. The published roster now shows them/).first().waitFor();
    const revisions = await db.query(`select number, state from public.staff_roster_revisions order by number`);
    assert.deepEqual(revisions.rows.map(row => `${row.number}:${row.state}`), ['1:superseded', '2:published']);
    const holder = await db.query(`select m.display_name from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published'
      join public.staff_members m on m.id = a.staff_id where a.session_id = $1`, [coverSession]);
    assert.ok(holder.rows.some(row => row.display_name === volunteer.name));
    assert.ok(!holder.rows.some(row => row.display_name === 'Riley Synthetic'));
  });

  const jordan = await rosterContext(browser, origin, coach('jordan').profileId, { width: 390, height: 844 });
  await step('urgent absence is never blocked and shows at the top of Needs Attention', async () => {
    await jordan.page.goto(`${origin}/coaching?tab=requests`, { waitUntil: 'networkidle' });
    await jordan.page.getByRole('button', { name: 'I need time away' }).click();
    const sheet = jordan.page.getByRole('dialog', { name: 'Time away' });
    await sheet.getByRole('radio', { name: 'Can’t make it (urgent)' }).click();
    await sheet.getByLabel('First day away', { exact: true }).fill(firstMonday);
    await sheet.getByLabel('Last day away', { exact: true }).fill(firstMonday);
    await sheet.getByRole('button', { name: 'Tell the manager now' }).click();
    await jordan.page.getByText(/The manager has been told/).first().waitFor();
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterView=week&rosterDate=${firstMonday}`, { waitUntil: 'networkidle' });
    const attention = page.getByRole('complementary', { name: /Needs attention/ });
    await attention.getByRole('heading').waitFor();
    const firstItem = (await attention.getByRole('button').first().textContent()) || '';
    assert.match(firstItem, /Jordan Synthetic reported an urgent absence/, `first Needs Attention item was: ${firstItem}`);
    // The Requests tab says a decision is waiting, from any tab.
    await page.getByRole('radio', { name: /^Requests \(\d+\)$/ }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/10-manager-needs-attention.png`, fullPage: true });
  });

  await step('five sections: an old Activity link opens Settings with the history showing', async () => {
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterTab=activity`, { waitUntil: 'networkidle' });
    await page.getByRole('radio', { name: 'Settings', checked: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Activity' }).count(), 0);
    await page.locator('details[open] > summary', { hasText: 'History' }).waitFor();
  });

  // Manager push destinations open /admin/roster?rosterTab=…&rosterMonth=… in
  // the web console. Signed out, the console shows its sign-in form at that
  // same URL, so the destination survives sign-in.
  const signedOut = await rosterContext(browser, origin, DEMO_OWNER, { width: 1280, height: 900 }, { signedIn: false });
  await step('a signed-out manager opening a manager push link signs in and lands on the same view', async () => {
    const tokenCalls = [];
    await signedOut.context.route('**/auth/v1/token**', async route => {
      tokenCalls.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fixtureSession()) });
    });
    const target = `/admin/roster?rosterTab=requests&rosterMonth=${MONTH}`;
    await signedOut.page.goto(`${origin}${target}`, { waitUntil: 'networkidle' });
    await signedOut.page.getByText('Admin sign in').waitFor();
    assert.equal(new URL(signedOut.page.url()).pathname + new URL(signedOut.page.url()).search, target, 'the sign-in form is shown at the destination URL');
    await signedOut.page.locator('input[type="email"]').fill(fixtureUser.email);
    await signedOut.page.locator('input[type="password"]').fill('synthetic-password');
    await signedOut.page.getByRole('button', { name: 'Sign in' }).click();
    await signedOut.page.getByRole('heading', { name: 'Coach roster', exact: true }).waitFor();
    await signedOut.page.getByRole('radio', { name: 'Requests', checked: true }).waitFor();
    const landed = new URL(signedOut.page.url());
    assert.equal(landed.pathname, '/admin/roster');
    assert.equal(landed.searchParams.get('rosterTab'), 'requests');
    assert.equal(landed.searchParams.get('rosterMonth'), MONTH);
    assert.equal(tokenCalls.length, 1);
    if (shots) await signedOut.page.screenshot({ path: `${shots}/11-manager-link-after-sign-in.png` });
  });

  await step('a signed-out coach opening a coach link is sent to sign in with the link kept', async () => {
    await signedOut.page.goto(`${origin}/coaching?tab=requests&month=${MONTH}`, { waitUntil: 'networkidle' });
    // The fixture session from the previous step is still signed in; sign out first.
    await signedOut.page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.includes('auth-token')) localStorage.removeItem(key); });
    await signedOut.page.goto(`${origin}/coaching?tab=requests&month=${MONTH}`, { waitUntil: 'networkidle' });
    const login = signedOut.page.getByRole('link', { name: 'Log in', exact: true });
    await login.waitFor();
    const href = new URL(await login.getAttribute('href'), origin);
    assert.equal(href.pathname, '/login');
    assert.equal(href.searchParams.get('next'), `/coaching?tab=requests&month=${MONTH}`);
  });

  await step('a recipient whose manager access was revoked sees "Admin access only", not the roster', async () => {
    const revoked = await rosterContext(browser, origin, coach('quinn').profileId, { width: 1280, height: 900 });
    await revoked.context.route('**/rest/v1/profiles**', route => route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(route.request().headers().accept?.includes('vnd.pgrst.object')
        ? { ...fixtureUser, full_name: 'Alex Morgan', role: 'member' } : [{ ...fixtureUser, full_name: 'Alex Morgan', role: 'member' }]) }));
    const before = rpcLog.length;
    await revoked.page.goto(`${origin}/admin/roster?rosterTab=requests&rosterMonth=${MONTH}`, { waitUntil: 'networkidle' });
    await revoked.page.getByText('Admin access only').waitFor();
    assert.equal(rpcLog.slice(before).length, 0, 'no roster data is requested for a non-manager');
    // And the server refuses the manager RPC even if called directly.
    await assert.rejects(() => serialRpc(coach('quinn').profileId, 'staff_roster_planning_snapshot', { p_month: `${MONTH}-01` }), /MANAGER_ONLY/);
    await revoked.context.close();
  });


  // ── Coach invite: manager makes a link → signed-out coach opens it → signs in → lands on the dashboard, linked.
  const SAM = '00000000-0000-4000-9000-0000000000aa';
  const samUser = { ...fixtureUser, id: SAM, email: 'sam@example.invalid', user_metadata: { full_name: 'Sam Synthetic' } };
  const samSession = () => {
    const session = fixtureSession();
    const [header, , signature] = session.access_token.split('.');
    const claims = Buffer.from(JSON.stringify({ sub: SAM, aud: 'authenticated', role: 'authenticated', exp: session.expires_at })).toString('base64url');
    return { ...session, access_token: `${header}.${claims}.${signature}`, user: samUser };
  };
  await db.query(`insert into public.profiles (id, full_name, email, role) values ($1, 'Sam Synthetic', 'sam@example.invalid', 'member')`, [SAM]);
  const samStaff = await serialRpc(DEMO_OWNER, 'staff_roster_upsert_staff', { p_staff: { display_name: 'Sam Synthetic', roles: ['assistant'] }, p_expected_version: null, p_request_id: crypto.randomUUID() });
  let inviteUrl = null;
  await step('manager creates an invite link for a coach with no sign-in', async () => {
    await page.goto(`${origin}/admin/roster?rosterTab=coaches&rosterMonth=${MONTH}`, { waitUntil: 'networkidle' });
    const invite = page.getByRole('button', { name: 'Invite Sam Synthetic' });
    await invite.waitFor();
    assert.equal(await page.getByRole('button', { name: /^Invite Riley Synthetic/ }).count(), 0, 'linked coaches are not offered an invite');
    await invite.click();
    const drawer = page.getByRole('dialog', { name: 'Invite Sam Synthetic' });
    await drawer.getByRole('button', { name: 'Create invite link' }).click();
    const field = drawer.getByLabel('Invite link');
    await field.waitFor();
    inviteUrl = await field.inputValue();
    assert.match(inviteUrl, new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/coach-invite#token=[0-9a-f]{64}$`));
    const token = inviteUrl.split('#token=')[1];
    const { rows } = await db.query(`select encode(token_hash, 'hex') = encode(sha256(convert_to($1, 'UTF8')), 'hex') as matches, accepted_at from public.staff_roster_invites where staff_id = $2`, [token, samStaff.id]);
    assert.deepEqual(rows, [{ matches: true, accepted_at: null }], 'one pending invite, stored as a hash');
    if (shots) await page.screenshot({ path: `${shots}/12-manager-invite-link.png` });
    await drawer.getByRole('button', { name: 'Done' }).click();
    await page.getByText('Invite sent').first().waitFor();
  });

  const samContext = await rosterContext(browser, origin, SAM, { width: 390, height: 844 }, { signedIn: false });
  await step('a signed-out coach opens the link, signs in, accepts, and lands on the dashboard linked', async () => {
    const coachPage = samContext.page;
    const token = inviteUrl.split('#token=')[1];
    const urlsWithToken = [];
    coachPage.on('request', request => { if (request.url().includes(token)) urlsWithToken.push(request.url()); });
    await samContext.context.route('**/auth/v1/user', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(samUser) }));
    await samContext.context.route('**/auth/v1/token**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(samSession()) }));
    await coachPage.goto(inviteUrl, { waitUntil: 'networkidle' });
    await coachPage.getByRole('heading', { name: 'You’re invited to coach' }).waitFor();
    assert.equal(new URL(coachPage.url()).hash, '', 'the token is taken out of the address bar');
    assert.equal(await coachPage.getByText('Sam Synthetic').count(), 0, 'no coach name before sign-in');
    if (shots) await coachPage.screenshot({ path: `${shots}/13-coach-invite-signed-out-phone.png`, fullPage: true });
    const login = coachPage.getByRole('link', { name: 'Log in', exact: true }).last();
    assert.equal(new URL(await login.getAttribute('href'), origin).searchParams.get('next'), '/coach-invite', 'the token never goes into ?next=');
    await login.click();
    await coachPage.locator('input[type="email"]').fill(samUser.email);
    await coachPage.locator('input[type="password"]').fill('synthetic-password');
    await coachPage.getByRole('button', { name: 'Log in' }).click();
    await coachPage.getByRole('heading', { name: 'Join as Sam Synthetic' }).waitFor();
    await coachPage.getByText('sam@example.invalid').waitFor();
    if (shots) await coachPage.screenshot({ path: `${shots}/14-coach-invite-accept-phone.png`, fullPage: true });
    await coachPage.getByRole('button', { name: 'Accept invite' }).click();
    await coachPage.getByRole('heading', { name: /Hi Sam Synthetic/ }).waitFor();
    await coachPage.getByText('Welcome to the XERT coach roster, Sam Synthetic').waitFor();
    await coachPage.getByRole('tab', { name: 'Home', selected: true }).waitFor();
    await coachPage.getByText(/Availability for/).first().waitFor();
    assert.equal(new URL(coachPage.url()).pathname, '/coaching');
    const { rows } = await db.query(`select m.profile_id, i.accepted_by from public.staff_members m join public.staff_roster_invites i on i.staff_id = m.id where m.id = $1`, [samStaff.id]);
    assert.deepEqual(rows, [{ profile_id: SAM, accepted_by: SAM }]);
    assert.deepEqual(urlsWithToken, [], 'no request URL ever carried the token');
    assert.equal(await coachPage.evaluate(() => localStorage.getItem('xert.coachInvite')), null, 'the remembered link is cleared after joining');
    if (shots) await coachPage.screenshot({ path: `${shots}/15-coach-home-after-joining-phone.png`, fullPage: true });
  });

  await step('the used link is refused for anyone else, in plain words', async () => {
    const other = await rosterContext(browser, origin, coach('quinn').profileId, { width: 390, height: 844 });
    await other.page.goto(inviteUrl, { waitUntil: 'networkidle' });
    await other.page.getByText('This invite has already been used').waitFor();
    assert.equal(await other.page.getByText('Sam Synthetic').count(), 0);
    if (shots) await other.page.screenshot({ path: `${shots}/16-coach-invite-used-phone.png`, fullPage: true });
    await other.context.close();
    await as(db, '');
  });

  await step('a coach on a published class sees who is booked and writes the session plan', async () => {
    const rileyStaff = (await db.query(`select id from public.staff_members where display_name = 'Riley Synthetic'`)).rows[0].id;
    await db.query(`insert into public.class_bookings (class_session_id, full_name, email, phone, status, guest_visit)
      select distinct a.session_id, 'Pat Visitor', 'pat@example.invalid', '0400000000', 'confirmed', true from public.staff_assignments a
      join public.staff_roster_revisions r on r.id = a.revision_id and r.state = 'published' where a.staff_id = $1`, [rileyStaff]);
    const phone = riley.page;
    await phone.goto(`${origin}/coaching?tab=roster`, { waitUntil: 'networkidle' });
    await phone.getByRole('button', { name: /^Who’s booked and session plan:/ }).first().click();
    const sheet = phone.getByRole('dialog', { name: 'Class details' });
    await sheet.getByText(/^1 of \d+ booked/).waitFor();
    await sheet.getByText('Pat V. (guest)').waitFor();
    assert.equal(await sheet.getByText(/pat@example|0400000000|Pat Visitor/).count(), 0, 'no contact details or full names');
    await sheet.getByLabel('Session plan and notes').fill('Warm-up: 5 min rower. Main: 5x5 front squat. Finisher: 10 min engine.');
    await sheet.getByRole('button', { name: 'Save plan' }).click();
    await sheet.getByText(/Last saved by Riley Synthetic/).waitFor();
    if (shots) await phone.screenshot({ path: `${shots}/17-coach-class-details-phone.png` });
    const { rows } = await db.query('select session_id, author_staff_id from public.staff_session_notes');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].author_staff_id, rileyStaff);
    await assert.rejects(() => serialRpc(coach('quinn').profileId, 'staff_roster_class_detail', { p_session_id: rows[0].session_id }), /NOT_ON_CLASS/);
    await sheet.getByRole('button', { name: 'Close Class details' }).click();
  });

  await step('a coach drafts their website profile, adds a certificate and switches email off', async () => {
    const phone = riley.page;
    await phone.goto(`${origin}/coaching?tab=profile`, { waitUntil: 'networkidle' });
    await phone.getByLabel('Name on the Coaches page', { exact: true }).fill('Riley Synthetic');
    await phone.getByLabel('Role or title', { exact: true }).fill('Strength coach');
    await phone.getByLabel('About you', { exact: true }).fill('Synthetic bio for a fictional coach.');
    await phone.getByRole('button', { name: 'Send for approval' }).click();
    await phone.getByText('Waiting for the manager').waitFor();
    await phone.getByRole('button', { name: 'Add certificate' }).click();
    const sheet = phone.getByRole('dialog', { name: 'Add certificate' });
    await sheet.getByLabel('Type').selectOption('cpr');
    await sheet.getByLabel('Expires').fill(`${Number(today.slice(0, 4)) + 1}${today.slice(4)}`);
    await sheet.getByRole('button', { name: 'Save certificate' }).click();
    await phone.getByText('Current', { exact: true }).waitFor();
    await phone.getByRole('checkbox', { name: /^Email/ }).uncheck();
    await phone.getByText('Notice settings saved.').first().waitFor();
    if (shots) await phone.screenshot({ path: `${shots}/18-coach-profile-tab-phone.png`, fullPage: true });
    const { rows } = await db.query(`select (select status from public.staff_profile_drafts) as profile, (select kind from public.staff_certificates) as cert,
      (select email from public.staff_notice_preferences where profile_id = $1) as email`, [coach('riley').profileId]);
    assert.deepEqual(rows, [{ profile: 'submitted', cert: 'cpr', email: false }]);
    assert.equal((await db.query('select count(*)::int as n from public.coaches')).rows[0].n, 0, 'nothing on the website before approval');
  });

  await step('manager approves the profile onto the Coaches page and sees who lacks first aid', async () => {
    await page.goto(`${origin}/admin/roster?rosterTab=coaches&rosterMonth=${MONTH}`, { waitUntil: 'networkidle' });
    await page.getByText('Profiles waiting for approval (1)').waitFor();
    await page.getByText(/active coaches have no current first aid or CPR on file/).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/19-manager-profile-review.png` });
    await page.getByRole('button', { name: 'Approve Riley Synthetic’s profile' }).click();
    await page.getByText('Riley Synthetic’s profile is approved').first().waitFor();
    const { rows } = await db.query(`select c.name, c.role, c.published from public.coaches c join public.staff_members m on m.coach_id = c.id where m.display_name = 'Riley Synthetic'`);
    assert.deepEqual(rows, [{ name: 'Riley Synthetic', role: 'Strength coach', published: true }]);
  });

  await step('Home shows the next class headcount and hours coached (a summary, not payroll)', async () => {
    const phone = riley.page;
    await phone.goto(`${origin}/coaching`, { waitUntil: 'networkidle' });
    await phone.getByRole('heading', { name: 'Hours coached' }).waitFor();
    await phone.getByText(/Not a timesheet or payroll record/).waitFor();
    await phone.getByText('Coach profile for the website').waitFor({ state: 'attached' });
    await phone.getByRole('heading', { name: /^To do/ }).waitFor();
    assert.equal(await phone.getByRole('navigation', { name: 'Coach shortcuts' }).count(), 0, 'Home no longer repeats the tabs as shortcuts');
    if (shots) await phone.screenshot({ path: `${shots}/20-coach-home-dashboard-phone.png`, fullPage: true });
  });

  await step('adding a coach goes straight to their invite link', async () => {
    await page.goto(`${origin}/admin/roster?rosterTab=coaches&rosterMonth=${MONTH}`, { waitUntil: 'networkidle' });
    await page.getByText(/^\d+ ready/).waitFor();
    await page.getByRole('button', { name: 'Add a coach' }).click();
    const editor = page.getByRole('dialog', { name: 'Add a coach' });
    await editor.getByLabel('Name on the roster').fill('Drew Synthetic');
    assert.equal(await editor.getByLabel('Most classes a week').isVisible(), false, 'limits wait behind More settings');
    if (shots) await page.screenshot({ path: `${shots}/24-manager-add-coach.png` });
    await editor.getByRole('button', { name: 'Save' }).click();
    const invite = page.getByRole('dialog', { name: 'Invite Drew Synthetic' });
    await invite.getByRole('button', { name: 'Create invite link' }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/25-manager-new-coach-invite.png` });
    await invite.getByRole('button', { name: 'Done' }).click();
    await page.locator('li', { hasText: 'Drew Synthetic' }).getByText('Needs to sign in').waitFor();
    if (shots) await page.screenshot({ path: `${shots}/26-manager-coaches-tab.png`, fullPage: true });
  });

  // ── Part-month: the month that has already started ──────────────────────
  // This month (today's) has no roster period. The manager asks coaches about
  // the rest of it from a chosen day; earlier classes stay out of the roster.
  const CURRENT = monthKeyOf(today);
  const CURRENT_WORD = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(CURRENT.slice(5)) - 1];
  const shortDay = date => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(date)]} ${Number(date.slice(8))} ${CURRENT_WORD.slice(0, 3)}`;
  const restOfMonth = partMonthStartRange(CURRENT, today);
  const partPlan = restOfMonth ? planPartMonthOpening(CURRENT, { today, startsOn: restOfMonth.suggested }) : null;
  // Synthetic evening classes on every remaining day of this month.
  const currentClasses = [];
  for (const date of datesOfMonth(CURRENT).filter(item => item > today)) {
    const { rows } = await db.query(`insert into public.class_sessions (start_time, end_time, duration_minutes, title, class_type, status)
      values ($1, $2, 45, 'Current Engine 6:00', 'XERT Engine', 'published') returning id`, [gymInstantIso(date, 1080), new Date(gymInstant(date, 1080) + 45 * 60000).toISOString()]);
    currentClasses.push({ date, id: rows[0].id });
  }
  const partSmall = await rosterContext(browser, origin, DEMO_OWNER, { width: 375, height: 812 });
  await step('a started month: the manager asks coaches about the rest of it from a chosen day; earlier classes stay out', async () => {
    await page.goto(`${origin}/admin/roster?rosterMonth=${CURRENT}&rosterTab=availability`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Coach roster', exact: true }).waitFor();
    if (!restOfMonth) {
      // The last day of the month: nothing left to ask about, said plainly.
      await page.getByText(new RegExp(`too late to ask for ${CURRENT_WORD}`)).waitFor();
      return;
    }
    const guide = page.getByRole('group', { name: /steps$/ });
    await guide.getByText(new RegExp(`${CURRENT_WORD} has started\\. You can still ask coaches`)).waitFor();
    await guide.getByRole('button', { name: `Ask coaches for the rest of ${CURRENT_WORD}` }).click();
    await page.getByRole('heading', { name: `Ask coaches for the rest of ${CURRENT_WORD}` }).waitFor();
    const start = page.getByLabel(/Roster coaches from/);
    assert.equal(await start.inputValue(), restOfMonth.suggested, 'a start day is suggested');
    assert.equal(await start.getAttribute('min'), restOfMonth.min, 'no start day today or earlier');
    assert.equal(await start.getAttribute('max'), restOfMonth.max, 'no start day in another month');
    if (shots) await page.screenshot({ path: `${shots}/27-manager-rest-of-month.png`, fullPage: true });
    // The same screen at 375px: readable, nothing scrolls sideways.
    await partSmall.page.goto(`${origin}/admin/roster?rosterMonth=${CURRENT}&rosterTab=availability`, { waitUntil: 'networkidle' });
    await partSmall.page.getByRole('heading', { name: `Ask coaches for the rest of ${CURRENT_WORD}` }).waitFor();
    const overflow = await partSmall.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll at 375px (overflow ${overflow}px)`);
    if (shots) await partSmall.page.screenshot({ path: `${shots}/28-manager-rest-of-month-phone.png`, fullPage: true });

    await page.getByRole('button', { name: `Ask coaches about classes from ${shortDay(partPlan.startsOn)}` }).click();
    await page.getByText(`Coaches asked about classes from ${shortDay(partPlan.startsOn)}.`, { exact: false }).first().waitFor();
    const { rows } = await db.query(`select starts_on::text, opens_on::text, due_on::text, publish_target_on::text, shortened from public.staff_roster_periods where month = $1`, [`${CURRENT}-01`]);
    assert.deepEqual(rows[0], { starts_on: partPlan.startsOn, opens_on: today, due_on: partPlan.dueOn, publish_target_on: partPlan.publishTargetOn, shortened: true });
    await page.getByText(`Classes from ${shortDay(partPlan.startsOn)}.`, { exact: true }).waitFor();
    await guide.getByText(new RegExp(`Roster starts ${shortDay(partPlan.startsOn)}\\.`)).waitFor();

    // A class before the start day is shown but can't be rostered from here.
    const before = currentClasses.find(item => item.date < partPlan.startsOn);
    if (before) {
      await page.goto(`${origin}/admin/roster?rosterMonth=${CURRENT}&rosterView=day&rosterDate=${before.date}`, { waitUntil: 'networkidle' });
      await page.locator(`#roster-session-${before.id}`).getByText(`Before this roster starts on ${shortDay(partPlan.startsOn)}; it stays with the current coach.`).first().waitFor();
    }
    // Asking twice is refused in plain words, never raw database text.
    const again = await serialRpc(DEMO_OWNER, 'staff_roster_open_part_month', { p_month: `${CURRENT}-01`, p_starts_on: partPlan.startsOn, p_due_on: partPlan.dueOn, p_publish_target_on: partPlan.publishTargetOn, p_request_id: crypto.randomUUID() }).catch(error => error);
    assert.match(String(again.message), /PERIOD_EXISTS/);
  });

  const quinnPart = await rosterContext(browser, origin, coach('quinn').profileId, { width: 375, height: 812 });
  await step('coach answers a part-month on a 375px phone: days before the start are off, nothing is kept for them, and a quick tab switch loses nothing', async () => {
    if (!restOfMonth) return;
    const phone = quinnPart.page;
    const startsOn = partPlan.startsOn;
    await phone.goto(`${origin}/coaching?tab=availability&month=${CURRENT}`, { waitUntil: 'networkidle' });
    const last = datesOfMonth(CURRENT).at(-1);
    await phone.getByRole('heading', { name: `Your availability for ${CURRENT_WORD} classes (${Number(startsOn.slice(8))}–${Number(last.slice(8))} ${CURRENT_WORD.slice(0, 3)})` }).waitFor();
    const calendar = phone.getByRole('group', { name: `Days in ${CURRENT_WORD} ${CURRENT.slice(0, 4)}` });
    await calendar.getByRole('button', { name: new RegExp(`^${shortDay(startsOn)},`) }).and(phone.locator(':enabled')).waitFor();
    // Every day before the start is disabled and says why; every day from it can be tapped.
    const outside = calendar.getByRole('button', { name: /not part of this roster$/ });
    assert.equal(await outside.count(), Number(startsOn.slice(8)) - 1);
    for (const date of datesOfMonth(CURRENT)) {
      const button = calendar.getByRole('button', { name: new RegExp(`^${shortDay(date)},`) });
      assert.equal(await button.isDisabled(), date < startsOn, `${date} ${date < startsOn ? 'disabled' : 'enabled'}`);
    }
    await phone.getByText(new RegExp(`this roster starts ${shortDay(startsOn)}; earlier days are greyed out`)).waitFor();

    // "Every <weekday>" marks only days from the start.
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const firstMonthDay = `${CURRENT}-01`;
    await phone.getByRole('button', { name: `Every ${weekdayNames[weekdayOf(firstMonthDay)]}` }).click();
    // Tap one more day, then leave the tab before the autosave delay: the change is still saved.
    const lastDay = calendar.getByRole('button', { name: new RegExp(`^${shortDay(last)},`) });
    const lastWasMarked = (await lastDay.getAttribute('aria-label')).includes('can work');
    if (!lastWasMarked) await lastDay.click();
    await phone.getByRole('tab', { name: /^Inbox/ }).click();
    let draft = null;
    for (let tries = 0; tries < 50; tries++) {
      draft = (await db.query(`select d.payload from public.staff_availability_drafts d join public.staff_members m on m.id = d.staff_id
        where m.display_name = 'Quinn Synthetic' and d.month = $1`, [`${CURRENT}-01`])).rows[0]?.payload || null;
      if (draft?.exceptions?.some(item => item.date === last)) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(draft?.exceptions?.some(item => item.date === last), 'the last tap was saved even though the tab closed straight away');
    assert.equal(draft.exceptions.filter(item => item.date < startsOn).length, 0, 'nothing is written for days before the start');
    const marked = new Set(draft.exceptions.map(item => item.date));
    for (const date of datesOfMonth(CURRENT).filter(item => weekdayOf(item) === weekdayOf(firstMonthDay))) {
      assert.equal(marked.has(date), date >= startsOn, `${date} every-weekday answer only from the start`);
    }

    // Back on the tab, the answers are there. Ticking "can't coach at all" and
    // unticking it again gives every answer back.
    await phone.getByRole('tab', { name: /^Availability/ }).click();
    await lastDay.getByText('Work').waitFor();
    const none = phone.getByLabel(`I can’t coach at all in ${CURRENT_WORD} ${CURRENT.slice(0, 4)}`);
    await none.check();
    await calendar.waitFor({ state: 'hidden' });
    await none.uncheck();
    await lastDay.getByText('Work').waitFor();
    await phone.getByText('Draft saved. Not sent to the manager until you submit.').waitFor({ timeout: 10000 });
    const restored = (await db.query(`select d.payload from public.staff_availability_drafts d join public.staff_members m on m.id = d.staff_id
      where m.display_name = 'Quinn Synthetic' and d.month = $1`, [`${CURRENT}-01`])).rows[0].payload;
    assert.deepEqual(restored.exceptions, draft.exceptions, 'unticking restores the same answers');
    assert.equal(restored.noAvailability, false);

    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll at 375px (overflow ${overflow}px)`);
    const small = await phone.evaluate(() => [...document.querySelectorAll('.coaching-day, .coaching-every-day, .coaching-brush button')]
      .map(node => node.getBoundingClientRect()).filter(box => box.width < 44 || box.height < 44).length);
    assert.equal(small, 0, 'every calendar button is at least 44px');
    if (shots) await phone.screenshot({ path: `${shots}/29-coach-part-month-phone.png`, fullPage: true });

    await phone.getByRole('button', { name: 'Review and submit' }).click();
    await phone.getByRole('button', { name: `Submit ${CURRENT_WORD} classes` }).click();
    await phone.getByText('Submitted', { exact: true }).waitFor();
    const submitted = await db.query(`select s.payload from public.staff_availability_submissions s join public.staff_members m on m.id = s.staff_id
      where m.display_name = 'Quinn Synthetic' and s.month = $1`, [`${CURRENT}-01`]);
    assert.equal(submitted.rows.length, 1);
    assert.equal(submitted.rows[0].payload.exceptions.filter(item => item.date < startsOn).length, 0);
  });

  // ── Roster texts (Twilio stubbed; no real SMS) ──────────────────────────
  const publishChange = async () => {
    // One coach comes off one future class in the draft, then the manager publishes in the UI.
    let draft = (await db.query(`select id, version from public.staff_roster_revisions where month = $1 and state = 'draft'`, [`${MONTH}-01`])).rows[0];
    if (!draft) {
      await serialRpc(DEMO_OWNER, 'staff_roster_draft', { p_month: `${MONTH}-01` });
      draft = (await db.query(`select id, version from public.staff_roster_revisions where month = $1 and state = 'draft'`, [`${MONTH}-01`])).rows[0];
    }
    const target = (await db.query(`select id, staff_id from public.staff_assignments where revision_id = $1 and session_start > now() + interval '1 day'
      order by session_start, id limit 1`, [draft.id])).rows[0];
    // Earlier steps (an urgent absence) left some assignments breaking a rule; those come off too, or publishing is blocked.
    const broken = (await db.query(`select a.id from public.staff_assignments a where a.revision_id = $1 and a.session_start > now() and a.id <> $2
      and cardinality(public.staff_roster_assignment_problems(a.revision_id, a.session_id, a.slot_key, a.staff_id, array[a.id])) > 0`, [draft.id, target.id])).rows;
    await serialRpc(DEMO_OWNER, 'staff_roster_apply_changes', { p_month: `${MONTH}-01`, p_expected_version: draft.version,
      p_changes: [target, ...broken].map(item => ({ op: 'unassign', assignment_id: item.id })), p_request_id: crypto.randomUUID() });
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterView=month`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Review & publish' }).click();
    const dialog = page.getByRole('dialog', { name: /^Publish / });
    await dialog.getByRole('heading', { name: 'Classes still without a coach' }).waitFor();
    if (await dialog.getByText(/required spots? (is|are) still open/).count()) await dialog.getByLabel(/Why publish with empty spots/).fill('Synthetic demo: texts check');
    await dialog.getByRole('button', { name: /^Publish/ }).click();
    await dialog.getByText(/^.* roster is published$/).waitFor();
    return { dialog, staffId: target.staff_id };
  };

  await step('texts off: publishing sends no text and says how to turn them on', async () => {
    const before = twilio.calls.length;
    const { dialog } = await publishChange();
    await dialog.getByText(/Texts are off\. Turn on “Text coaches when you publish” in Settings/).waitFor();
    assert.equal(twilio.calls.length, before);
    const queued = await db.query('select count(*)::int as n from public.staff_roster_sms_messages');
    assert.equal(queued.rows[0].n, 0, 'nothing is even queued while texts are off');
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  await step('texts on: the publish dialog texts the coaches whose classes changed through Twilio (stubbed), once', async () => {
    // Synthetic mobiles on example accounts.
    for (const [index, item] of DEMO_COACHES.entries()) {
      await db.query('update public.profiles set phone = $2 where id = $1', [item.profileId, `04000000${String(index + 10)}`]);
    }
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterTab=settings`, { waitUntil: 'networkidle' });
    await page.getByText('Off — no texts are sent').waitFor();
    await page.getByRole('button', { name: 'Text coaches when you publish' }).click();
    await page.getByText('On — coaches get a text when you publish').waitFor();

    const before = twilio.calls.length;
    const { dialog, staffId } = await publishChange();
    await dialog.getByText(/^Texts: \d+ sent/).waitFor({ timeout: 15000 });
    const sent = twilio.calls.slice(before);
    const messages = (await db.query(`select m.status, m.phone, m.kind, m.body, s.display_name from public.staff_roster_sms_messages m join public.staff_members s on s.id = m.staff_id`)).rows;
    assert.ok(sent.length >= 1, 'at least the coach taken off a class is texted');
    assert.equal(sent.length, messages.filter(row => row.status === 'sent').length, 'one Twilio request per text recorded as sent');
    for (const call of sent) {
      assert.match(call.To, /^\+614000000\d\d$/, 'only synthetic numbers');
      assert.equal(call.From, '+61400000999');
      // Their first text lists all their classes; later ones only what changed.
      assert.match(call.Body, /^XERT: Hi \w+, your \w+ (classes|roster changed): .*(See all|see the app): https:\/\/xert\.example\.test\/coaching\?tab=roster$/);
    }
    assert.ok(messages.some(row => row.status === 'sent' && row.phone && sent.some(call => call.To === row.phone)));
    const owner = smsRequests.filter(item => item.uid === DEMO_OWNER).at(-1);
    assert.match(owner.authorization, /^Bearer \S+/);
    assert.deepEqual(owner.body, { action: 'send_roster_sms' });
    assert.ok(staffId);
    if (shots) await page.screenshot({ path: `${shots}/30-publish-texts-sent.png` });

    // Opening the roster again sends nothing twice.
    const afterPublish = twilio.calls.length;
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Coach roster', exact: true }).waitFor();
    await new Promise(done => setTimeout(done, 500));
    assert.equal(twilio.calls.length, afterPublish, 'no text is sent twice');
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterTab=settings`, { waitUntil: 'networkidle' });
  });

  await step('texts on but Twilio not set up: nothing is sent and the dialog says the texts are waiting', async () => {
    twilio.configured = false;
    const before = twilio.calls.length;
    try {
      const { dialog } = await publishChange();
      await dialog.getByText(/SMS is not set up on the server yet/).waitFor({ timeout: 15000 });
      const waiting = await db.query(`select count(*)::int as n from public.staff_roster_sms_messages where status = 'pending'`);
      assert.ok(waiting.rows[0].n >= 1, 'the texts stay queued for when SMS is set up');
      await dialog.getByRole('button', { name: 'Done' }).click();
      // Switching texts off cancels what was waiting, so nothing old goes out later.
      await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterTab=settings`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Stop texting coaches' }).click();
      await page.getByText('Off — no texts are sent').waitFor();
      const left = await db.query(`select count(*)::int as n from public.staff_roster_sms_messages where status in ('pending', 'sending')`);
      assert.equal(left.rows[0].n, 0);
    } finally {
      twilio.configured = true;
    }
    assert.equal(twilio.calls.length, before, 'nothing reached Twilio');
  });

  await step('no page errors in any session', async () => {
    const all = [...manager.problems, ...quinn.problems, ...riley.problems, ...jordan.problems, ...signedOut.problems, ...samContext.problems,
      ...partSmall.problems, ...quinnPart.problems];
    assert.deepEqual(all, []);
  });
  const names = new Set(rpcLog.map(item => item.name));
  console.log(`RPC entry points exercised through the UI: ${names.size}`);
  console.log([...names].sort().join(', '));
} finally {
  await browser?.close();
  await server.close();
  console.log(JSON.stringify({ month: MONTH, results }, null, 2));
}
