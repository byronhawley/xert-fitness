// End-to-end browser check of the staff roster against the REAL migration.
// The app runs unmodified in Chromium; its Supabase RPC calls are answered by
// PGlite running supabase/migrations/20261001010000_staff_roster.sql over a
// synthetic month. Everything else uses the shared local design fixtures.
// SYNTHETIC DATA ONLY; email notices are off and no request leaves the machine.
//
// Run: PLAYWRIGHT_MODULE=/path/to/playwright-core node test/staff-roster.browser.mjs [--screenshots=DIR]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { installDesignFixtures } from './fixtures/design-data.mjs';
import { DEMO_COACHES, DEMO_OWNER, demoMonth, rpcAs } from './fixtures/staff-roster-demo.mjs';
import { addDays, addMonths, datesOfMonth, gymInstantIso, monthKeyOf, weekdayOf } from '../src/lib/staffRoster/time.js';
import { gymDateKey } from '../src/lib/gymTime.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const shotsArg = process.argv.find(arg => arg.startsWith('--screenshots='));
const shots = shotsArg ? resolve(shotsArg.split('=')[1]) : null;
if (shots) await mkdir(shots, { recursive: true });

const today = gymDateKey(new Date());
const MONTH = addMonths(monthKeyOf(today), 2);
const firstMonday = datesOfMonth(MONTH).find(date => weekdayOf(date) === 1);
const coach = key => DEMO_COACHES.find(item => item.key === key);
const results = [];
const step = async (name, fn) => {
  const started = performance.now();
  try { await fn(); results.push({ name, ok: true, ms: Math.round(performance.now() - started) }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log(`FAIL ${name}\n  ${error.stack}`); throw error; }
};

const { db } = await demoMonth({ month: MONTH, today });
const rpcLog = [];

async function rosterContext(browser, origin, uid, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', deviceScaleFactor: viewport.width < 600 ? 2 : 1, timezoneId: 'Australia/Brisbane' });
  await installDesignFixtures(context, { origin, signedIn: true });
  await context.route('**/rest/v1/rpc/staff_roster_*', async route => {
    const request = route.request();
    const name = new URL(request.url()).pathname.split('/').at(-1);
    const args = request.method() === 'POST' ? request.postDataJSON() || {} : {};
    rpcLog.push({ uid, name });
    try {
      const result = await rpcAs(db, uid, name, args);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(result) });
    } catch (error) {
      await route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ code: error.code || 'P0001', message: error.message, details: error.detail || null, hint: null }) });
    }
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

  await step('manager opens the roster in the Classes hub', async () => {
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterView=month`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Coach roster', exact: true }).waitFor();
    await page.getByText('Nothing published for this month yet').waitFor();
  });

  await step('suggest draft previews, then adds to the draft without publishing', async () => {
    await page.getByRole('button', { name: /^Suggest draft/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Suggested draft' });
    await drawer.getByText(/Search (finished|limit reached)/).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/02-suggest-draft-preview.png` });
    await drawer.getByRole('button', { name: /^Add \d+ to draft/ }).click();
    await drawer.waitFor({ state: 'hidden' });
    await page.getByText(/^Draft 1 — coaches can’t see these changes yet/).first().waitFor();
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
    await page.getByText(/more classes than available coaches|required positions filled/).first().waitFor();
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
      await rpcAs(db, DEMO_OWNER, 'staff_roster_apply_changes', { p_month: `${MONTH}-01`, p_expected_version: draft.version,
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
    const gaps = await dialog.getByText(/required positions? (is|are) still open/).count();
    if (gaps) {
      assert.equal(await publish.isDisabled(), true, 'cannot publish gaps without a reason');
      await dialog.getByLabel(/Why publish with gaps/).fill('Synthetic demo: hiring a weekend coach');
    }
    if (shots) await page.screenshot({ path: `${shots}/05-publish-review.png` });
    await publish.click();
    await page.getByText(/^Version 1 published/).first().waitFor();
    const { rows } = await db.query(`select state, number from public.staff_roster_revisions`);
    assert.deepEqual(rows.map(row => row.state), ['published']);
    const notices = await db.query(`select count(*)::int as n, count(*) filter (where email_status <> 'not_requested')::int as emailed from public.staff_notifications where kind = 'roster_published'`);
    assert.ok(notices.rows[0].n >= 3, 'affected coaches get an inbox notice');
    assert.equal(notices.rows[0].emailed, 0, 'email is off, so nothing is queued to send');
  });

  const quinn = await rosterContext(browser, origin, coach('quinn').profileId, { width: 390, height: 844 });
  await step('coach gives availability on a phone: shortcuts, autosave, review, submit', async () => {
    const phone = quinn.page;
    await phone.goto(`${origin}/coaching?tab=availability&month=${MONTH}`, { waitUntil: 'networkidle' });
    await phone.getByRole('heading', { name: /Hi Quinn Synthetic/ }).waitFor();
    await phone.getByRole('group', { name: /^Tuesday 6:15 am/ }).getByRole('button', { name: 'Yes' }).click();
    await phone.getByRole('group', { name: /^Thursday 6:15 am/ }).getByRole('button', { name: 'Yes' }).click();
    await phone.getByRole('group', { name: /^Saturday 6:15 am/ }).getByRole('button', { name: 'Prefer' }).click();
    await phone.getByRole('group', { name: /^Wednesday 4:30 pm/ }).getByRole('button', { name: 'If needed' }).click();
    await phone.getByText('Draft saved — not submitted yet').waitFor({ timeout: 10000 });
    const draft = await db.query(`select count(*)::int as n from public.staff_availability_drafts`);
    assert.equal(draft.rows[0].n, 1, 'autosave writes a draft, not a submission');
    if (shots) await phone.screenshot({ path: `${shots}/06-coach-availability-phone.png`, fullPage: true });
    await phone.getByRole('button', { name: /^Review / }).click();
    await phone.getByText(/You’ll be considered for/).first().waitFor();
    if (shots) await phone.screenshot({ path: `${shots}/07-coach-availability-review-phone.png`, fullPage: true });
    await phone.getByRole('button', { name: /^Submit / }).click();
    await phone.getByText(/submitted/).first().waitFor();
    const submitted = await db.query(`select s.version from public.staff_availability_submissions s join public.staff_members m on m.id = s.staff_id where m.display_name = 'Quinn Synthetic'`);
    assert.deepEqual(submitted.rows.map(row => row.version), [1]);
  });

  const riley = await rosterContext(browser, origin, coach('riley').profileId, { width: 390, height: 844 });
  let coverSession = null;
  await step('coach sees only published classes on a phone and asks for cover', async () => {
    const phone = riley.page;
    await phone.goto(`${origin}/coaching`, { waitUntil: 'networkidle' });
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
      const board = await rpcAs(db, candidate.profileId, 'staff_roster_cover_board', {});
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
    await page.getByText(/approved\. A new roster version is published/).first().waitFor();
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
    await sheet.getByLabel('From', { exact: true }).fill(firstMonday);
    await sheet.getByLabel('Until', { exact: true }).fill(firstMonday);
    await sheet.getByRole('button', { name: 'Tell the manager now' }).click();
    await jordan.page.getByText(/The manager has been told/).first().waitFor();
    await page.goto(`${origin}/admin/roster?rosterMonth=${MONTH}&rosterView=week&rosterDate=${firstMonday}`, { waitUntil: 'networkidle' });
    const attention = page.getByRole('complementary', { name: /Needs attention/ });
    await attention.getByRole('heading').waitFor();
    const firstItem = (await attention.getByRole('button').first().textContent()) || '';
    assert.match(firstItem, /Jordan Synthetic reported an urgent absence/, `first Needs Attention item was: ${firstItem}`);
    if (shots) await page.screenshot({ path: `${shots}/10-manager-needs-attention.png`, fullPage: true });
  });

  await step('no page errors in any session', async () => {
    const all = [...manager.problems, ...quinn.problems, ...riley.problems, ...jordan.problems];
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
