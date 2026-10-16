import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CASUAL_VISIT_ACTION, casualVisitCheckoutParameters, casualVisitPaymentFromCheckout,
  casualVisitValidationError, formatCasualVisitPrice, normalizeCasualVisitPriceCents,
  CASUAL_VISITOR_KEY, CASUAL_VISITOR_TTL_MS, normalizeCasualVisitor, normalizeVisitorPhone,
  recallCasualVisitor, rememberCasualVisitor, summarizeCasualVisits,
} from '../src/lib/casualVisit.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const visitor = { first_name: 'Jane', last_name: 'Smith', email: 'jane@example.com', phone: '0400 000 000' };

test('a visitor is asked for everything the club needs, and nothing is guessed', () => {
  const clean = normalizeCasualVisitor({ ...visitor, first_name: ' jane ', email: ' Jane@Example.COM ' });
  assert.equal(clean.fullName, 'jane Smith');
  assert.equal(clean.email, 'jane@example.com');
  assert.equal(clean.phone, '+61400000000');
  assert.equal(normalizeVisitorPhone('(07) 4162 1234'), '+61741621234');
  assert.equal(normalizeVisitorPhone('nope'), '');

  assert.match(casualVisitValidationError({ ...visitor, first_name: '' }), /first name/);
  assert.match(casualVisitValidationError({ ...visitor, last_name: '' }), /last name/);
  assert.match(casualVisitValidationError({ ...visitor, email: 'jane@example' }), /part after the dot/);
  assert.match(casualVisitValidationError({ ...visitor, phone: '' }), /phone number/);
  assert.match(casualVisitValidationError({ ...visitor, phone: 'call me' }), /valid phone number/);
  assert.equal(casualVisitValidationError(visitor), null);
});

test('the amount comes from the club, never the browser', () => {
  const parameters = casualVisitCheckoutParameters({
    visitor: normalizeCasualVisitor(visitor),
    priceCents: 1560,
    returnURLs: { success: 'https://www.xertfitness.com.au/casual?paid=1', cancel: 'https://www.xertfitness.com.au/casual?cancelled=1' },
    now: 1_757_000_000_000,
  });
  assert.equal(parameters.mode, 'payment');
  assert.equal(parameters.line_items[0].price_data.unit_amount, 1560);
  assert.equal(parameters.line_items[0].price_data.currency, 'aud');
  assert.equal(parameters.customer_email, 'jane@example.com', 'the card screen opens with their email filled in');
  assert.equal(parameters.metadata.xert_casual_visit, 'true');
  assert.equal(parameters.metadata.casual_visit_phone, '+61400000000');
  assert.equal(parameters.payment_intent_data.description, 'Casual visit — Jane Smith');

  // A price the database could not supply must stop the payment, not invent one.
  assert.throws(() => casualVisitCheckoutParameters({ visitor: normalizeCasualVisitor(visitor), priceCents: 5, returnURLs: { success: 'https://x/a', cancel: 'https://x/b' } }), /price is not set/);
  assert.throws(() => casualVisitCheckoutParameters({ visitor: normalizeCasualVisitor(visitor), priceCents: 1560, returnURLs: { success: 'javascript:alert(1)', cancel: 'https://x/b' } }), /return URL/);
  assert.equal(normalizeCasualVisitPriceCents('abc'), 1560);
  assert.equal(normalizeCasualVisitPriceCents(2000), 2000);
  assert.equal(formatCasualVisitPrice(1560), '$15.60');
});

test('only a paid casual visit is recorded, and never as a member order', () => {
  const paid = casualVisitPaymentFromCheckout({
    id: 'cs_test_1', payment_status: 'paid', amount_total: 1560, currency: 'aud',
    customer_details: { email: 'jane@example.com' }, payment_intent: 'pi_test_1',
    metadata: { xert_casual_visit: 'true', casual_visit_name: 'Jane Smith', casual_visit_phone: '0400000000' },
  });
  assert.deepEqual(paid, {
    full_name: 'Jane Smith', email: 'jane@example.com', phone: '+61400000000',
    amount_cents: 1560, currency: 'aud', stripe_checkout_session_id: 'cs_test_1',
    stripe_payment_intent_id: 'pi_test_1', status: 'paid',
  });
  assert.equal(casualVisitPaymentFromCheckout({ id: 'cs_2', payment_status: 'unpaid', metadata: { xert_casual_visit: 'true' } }), null);
  assert.equal(casualVisitPaymentFromCheckout({ id: 'cs_3', payment_status: 'paid', metadata: { user_id: 'member' } }), null,
    'a member checkout is left to member fulfilment');
});

test('the door fee never touches the member fulfilment path', async () => {
  const checkout = await read('../api/checkout.js');
  assert.match(checkout, /if \(payload && payload\.action === CASUAL_VISIT_ACTION\) \{/);
  assert.match(checkout, /return handleCasualVisitCheckout\(\{ payload, request, admin, json \}\)/);
  assert.ok(checkout.indexOf('handleCasualVisitCheckout({ payload') < checkout.indexOf("if (!token) return json({ error: 'Not authenticated.' }, 401);"),
    'a walk-in has no account, so the casual path must come before the auth check');
  // Runtime casual-visit-checkout tests verify the settings projection,
  // charged amount and disabled-payment gate with real handler execution.

  const webhook = await read('../api/stripe-webhook.js');
  assert.match(webhook, /const casualVisit = casualVisitPaymentFromCheckout\(event\.data\?\.object\);/);
  assert.match(webhook, /onConflict: 'stripe_checkout_session_id'/, 'a replayed webhook must not double-record');

  const sql = await read('../supabase/migrations/20260905010000_casual_visit_payments.sql');
  assert.match(sql, /create table if not exists public\.casual_visit_payments/);
  assert.match(sql, /stripe_checkout_session_id text not null unique/);
  assert.match(sql, /create policy "casual_visit_payments_admin_read"/);
  assert.match(sql, /casual_visit_price_cents integer not null default 1560/);
  assert.match(sql, /create trigger email_on_casual_visit_payment/, 'the owner is told a visit was paid');
  assert.match(sql, /values \('casual_visit_payments'\)/);

  const page = await read('../src/pages/CasualVisit.jsx');
  assert.match(page, /action: CASUAL_VISIT_ACTION/);
  assert.match(page, /XERT never sees or stores your card details/);
  assert.match(page, /forms\/peq-casual/, 'a first-time visitor is pointed at the questionnaire');
  const app = await read('../src/App.jsx');
  assert.match(app, /path="\/casual"/);
});

test('the owner sees door takings beside orders, counted only when actually paid', async () => {
  const now = new Date('2026-09-05T10:00:00+10:00');
  const summary = summarizeCasualVisits([
    { status: 'paid', amount_cents: 1560, currency: 'aud', created_at: '2026-09-05T00:30:00Z' },
    { status: 'paid', amount_cents: 1560, currency: 'aud', created_at: '2026-09-02T00:30:00Z' },
    { status: 'refunded', amount_cents: 1560, currency: 'aud', created_at: '2026-09-02T00:30:00Z' },
    { status: 'paid', amount_cents: 1560, currency: 'aud', created_at: '2026-08-20T00:30:00Z' },
  ], now);
  assert.equal(summary.count, 3, 'a refunded visit is not takings');
  assert.equal(summary.todayCount, 1);
  assert.equal(summary.todayRevenue, 1560);
  assert.equal(summary.monthCount, 2);
  assert.equal(summary.monthRevenue, 3120);
  assert.deepEqual(summarizeCasualVisits([], now).revenue, 0);

  const data = await read('../src/lib/adminData.js');
  assert.match(data, /export async function listCasualVisits/);
  assert.match(data, /from\('casual_visit_payments'\)/);
  assert.match(data, /return \{ installed: false, rows: \[\] \}/,
    'the screen says so rather than failing before the migration is applied');

  const orders = await read('../src/components/admin/OrdersManager.jsx');
  assert.match(orders, /Casual visits/);
  assert.match(orders, /Paid at the door on the visitor&apos;s own phone/);
  assert.match(orders, /summarizeCasualVisits\(casualVisits\.rows\)/);
  assert.match(orders, /casualVisits\.installed && casualVisits\.rows\.length > 0/,
    'an empty list adds nothing to the screen');

  // The front desk needs a code to print, whether or not anyone has paid yet.
  // A code for each thing somebody can buy at the door, named for what it is.
  for (const [slug, path] of [
    ['casual-visit', '/casual'], ['three-day-pass', '/3daypass'], ['ten-session-pack', '/10pack'],
    ['three-month-membership', '/3months'],
  ]) {
    assert.match(orders, new RegExp(`slug: '${slug}', path: '${path}'`));
  }
  assert.match(orders, /new URL\(code\.path, window\.location\.origin\)/);
  assert.match(orders, /title="Casual visit QR"|qrTitle: 'Casual visit QR'/);
  const qr = await read('../src/components/admin/FormQRCode.jsx');
  assert.match(qr, /title = 'Branded QR code'/, 'the form screens keep their wording');
  assert.match(qr, /<h2 className="font-display text-2xl uppercase text-text-primary">\{title\}<\/h2>/);
});

test('the club owns the door fee: price and switch live in Settings', async () => {
  const { normalizeCasualPrice, normalizeLaunchSettings, launchSettingsChanged } = await import('../src/lib/launchSettings.js');
  assert.equal(normalizeCasualPrice('15.60'), 1560);
  assert.equal(normalizeCasualPrice(2000), 2000);
  assert.equal(normalizeCasualPrice(''), 1560, 'an empty field keeps the default rather than clearing the price');
  assert.throws(() => normalizeCasualPrice('50'), /between \$1 and \$1,000/);
  assert.throws(() => normalizeCasualPrice('abc'), /in dollars/);

  const normalized = normalizeLaunchSettings({ casual_visit_price_cents: 1560, target_launch_date: '2026-09-05' });
  assert.equal(normalized.casual_payments_enabled, true, 'on unless switched off');
  assert.equal(normalized.casual_visit_price_cents, 1560);
  assert.ok(launchSettingsChanged({ casual_visit_price_cents: 2000 }, { casual_visit_price_cents: 1560 }),
    'changing the price must enable Save');

  const screen = await read('../src/components/admin/SoftLaunchSettings.jsx');
  assert.match(screen, /field="casual_payments_enabled"/);
  assert.match(screen, /VISITOR_PRICE_FIELDS\.map/, 'every visitor price is editable, not just the casual one');
  assert.match(screen, /function VisitorPriceRow\(/);
  assert.match(screen, /never from their browser/);
  assert.match(screen, /Run this discount/);
  assert.match(screen, /set a cheaper discount price first/,
    'a discount cannot be switched on until it is actually a discount');
});

test('nobody trains unscreened: the questionnaire is answered before Stripe is opened', async () => {
  const page = await read('../src/pages/CasualVisit.jsx');

  // Two options, and neither is pre-selected — the visitor has to say which.
  assert.match(page, /useState\(''\)/);
  assert.match(page, /\['done', 'I have already completed the pre-exercise questionnaire'\]/);
  assert.match(page, /\['not-done', 'I have not completed it yet'\]/);
  assert.match(page, /role="radiogroup"/);

  // Leaving it blank stops the submit before any network call is made.
  const guard = page.indexOf("Tell us whether you have completed the pre-exercise questionnaire.");
  const detour = page.indexOf("questionnaire === 'not-done'");
  const checkout = page.indexOf("fetch('/api/checkout'");
  assert.ok(guard > 0 && detour > guard && checkout > detour,
    'the blank guard and the detour both come before the checkout call');
  assert.match(page, /navigate\(`\/forms\/\$\{CASUAL_PEQ_SLUG\}\?return=casual`\)/);
  assert.match(page, /const CASUAL_PEQ_SLUG = 'peq-casual'/,
    'the casual questionnaire, not the membership one');
  assert.match(page, /'Fill in the questionnaire first'/,
    'the button says where it is about to take them');

  // Coming back, their details are already in the form and the answer is set.
  assert.match(page, /readFormCompletion\(threeMonth \? MEMBER_PEQ_SLUG : CASUAL_PEQ_SLUG\)/,
    'a casual visit reads the casual questionnaire; a membership reads the member one');
  assert.match(page, /recallCasualVisitor\(\)/);
  assert.match(page, /if \(completed\) setQuestionnaire\('done'\)/);
});

test('a visitor sent off to the questionnaire comes back to a form that still knows them', () => {
  const data = new Map();
  const storage = { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value) };
  const typed = { first_name: 'Casey', last_name: 'Doe', email: 'casey@example.com', phone: '0400 111 222' };

  assert.equal(recallCasualVisitor({ storage }), null, 'a fresh phone starts blank');
  assert.equal(rememberCasualVisitor(typed, { storage, now: 1_000 }), true);
  assert.deepEqual(recallCasualVisitor({ storage, now: 2_000 }), { ...typed, at: 1_000 });

  assert.equal(recallCasualVisitor({ storage, now: 1_000 + CASUAL_VISITOR_TTL_MS + 1 }), null,
    'yesterday\'s visitor is not offered to today\'s');
  assert.equal(recallCasualVisitor({ storage, now: 0 }), null, 'a marker from the future is ignored');

  data.set(CASUAL_VISITOR_KEY, 'not json');
  assert.equal(recallCasualVisitor({ storage }), null, 'a corrupt marker never breaks the payment page');
  assert.equal(rememberCasualVisitor(typed, { storage: null }), false, 'a browser with no storage still pays');
  assert.equal(recallCasualVisitor({ storage: null }), null);
});

test('class credits are a switch the club owns, and it is off', async () => {
  const { normalizeLaunchSettings, launchSettingsChanged } = await import('../src/lib/launchSettings.js');

  // Retired means off unless someone deliberately turns it back on.
  const base = { casual_visit_price_cents: 1560, target_launch_date: '2026-09-05' };
  assert.equal(normalizeLaunchSettings(base).class_credits_enabled, false);
  assert.equal(normalizeLaunchSettings({ ...base, class_credits_enabled: true }).class_credits_enabled, true);
  assert.ok(
    launchSettingsChanged({ class_credits_enabled: true }, { class_credits_enabled: false }),
    'flipping the switch must enable Save'
  );

  const screen = await read('../src/components/admin/SoftLaunchSettings.jsx');
  assert.match(screen, /field="class_credits_enabled"/);
  assert.match(screen, /Off means booking never looks for a credit/);

  const sql = await read('../supabase/migrations/20260908030000_class_credits_switch.sql');
  assert.match(sql, /add column if not exists class_credits_enabled boolean not null default false/);
  // Every path that could spend a credit asks the switch first.
  for (const fn of ['book_session', 'admin_set_booking_status', 'admin_book_member_into_class']) {
    const start = sql.indexOf(`FUNCTION public.${fn}(`);
    assert.ok(start > 0, `${fn} is in the migration`);
    const body = sql.slice(start, sql.indexOf('CREATE OR REPLACE FUNCTION', start + 1) + 1 || undefined);
    assert.match(body, /class_credits_are_enabled\(\)/, `${fn} reads the switch`);
  }
  // A credit already bought is still returned when a booking is undone,
  // whichever way the switch is set today.
  assert.match(sql, /update public\.credit_batches set remaining = remaining \+ 1 where id = v_batch/);
});

test('a place cannot be sold twice, and the queue goes first', async () => {
  const sql = await read('../supabase/migrations/20260908040000_restore_booking_integrity_guards.sql');

  for (const fn of ['book_session', 'admin_set_booking_status']) {
    const start = sql.indexOf(`FUNCTION public.${fn}(`);
    assert.ok(start > 0, `${fn} is restored in the migration`);
    const next = sql.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
    const body = next > 0 ? sql.slice(start, next) : sql.slice(start);

    // Capacity counts both doors: the public timetable and member accounts.
    assert.match(body, /class_places_held\(/, `${fn} counts public sign-ups`);
    assert.doesNotMatch(
      body,
      /select count\(\*\)[\s\S]{0,120}from public\.session_bookings[\s\S]{0,160}status in \('requested', 'confirmed'\)/,
      `${fn} must not count member bookings alone`
    );
    // A full class stays reachable so its waitlist still works.
    assert.match(body, /not in \('published', 'full'\)/, `${fn} keeps full classes reachable`);
    // The entitlement path and the credits switch both survive the repair.
    assert.match(body, /booking_entitlement_for_session\(/, `${fn} keeps passes working`);
    assert.match(body, /class_credits_are_enabled\(\)/, `${fn} still reads the credits switch`);
  }

  // Nobody takes a place somebody is already queued for.
  assert.match(sql, /if coalesce\(v_waiting, 0\) > 0 then raise exception 'SESSION_WAITLIST_FIRST'/);

  // Both codes reach a member in words rather than as a database code.
  const web = await read('../src/lib/bookingData.js');
  const native = await read('../ios/XertFitnessApp/XertFitnessApp/BookingCancellationPolicy.swift');
  for (const code of ['SESSION_WAITLIST_FIRST', 'SESSION_FULL']) {
    assert.match(web, new RegExp(`${code}:`));
    assert.match(native, new RegExp(`\\("${code}"`));
  }
});
