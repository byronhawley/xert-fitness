import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  VISITOR_PASS_CHOICES, WEEKLY_MEMBERSHIP, shouldOfferVisitorPasses,
  visitorDetailsFromSignup, visitorPassChoices, visitorPassURL,
} from '../src/lib/visitorPassChoices.js';
import { metadataForPath } from '../src/lib/pageMetadata.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('all four ways to pay are offered, priced from the club\'s own settings', () => {
  const choices = visitorPassChoices({
    casual_visit_price_cents: 2000,
    three_day_pass_price_cents: 3500,
    ten_session_pack_price_cents: 13000,
    three_month_price_cents: 43000,
  });
  assert.deepEqual(choices.map(choice => choice.path), ['/casual', '/3daypass', '/10pack', '/3months']);
  assert.deepEqual(choices.map(choice => choice.charge), [2000, 3500, 13000, 43000]);
  // Each one has to say what it is, or the list is four prices and no choice.
  for (const choice of choices) assert.ok(choice.label && choice.blurb);
});

test('a running discount shows what is charged and what it was', () => {
  const [casual] = visitorPassChoices({
    casual_visit_price_cents: 2000,
    casual_visit_discount_cents: 1500,
    casual_visit_discount_enabled: true,
  });
  assert.equal(casual.charge, 1500);
  assert.equal(casual.full, 2000);
  assert.equal(casual.discounted, true);
});

test('prices fall back to the defaults rather than showing nothing', () => {
  for (const choice of visitorPassChoices({})) {
    assert.ok(Number.isInteger(choice.charge) && choice.charge > 0, choice.kind);
  }
});

test('the class sign-up name splits into the two the pass pages ask for', () => {
  assert.deepEqual(
    visitorDetailsFromSignup({ full_name: '  Kirra  Mc Phee ', email: ' A@B.test ', phone: '0400 000 000' }),
    { first_name: 'Kirra Mc', last_name: 'Phee', email: 'A@B.test', phone: '0400 000 000' },
  );
  // One word is a first name; inventing a surname would be worse than asking.
  assert.deepEqual(visitorDetailsFromSignup({ full_name: 'Casey' }).last_name, '');
  assert.equal(visitorDetailsFromSignup({ full_name: 'Casey' }).first_name, 'Casey');
  assert.deepEqual(visitorDetailsFromSignup({}), {
    first_name: '', last_name: '', email: '', phone: '',
  });
});

test('only a non-member is offered a pass, and only while payments are on', () => {
  assert.equal(shouldOfferVisitorPasses({ has_membership: false }, {}), true);
  // Selling a casual visit to somebody who already pays for a membership is
  // worse than saying nothing at all.
  assert.equal(shouldOfferVisitorPasses({ has_membership: true }, {}), false);
  // Unanswered is not the same as "no".
  assert.equal(shouldOfferVisitorPasses({}, {}), false);
  assert.equal(shouldOfferVisitorPasses(null, {}), false);
  assert.equal(
    shouldOfferVisitorPasses({ has_membership: false }, { casual_payments_enabled: false }), false);
});

test('nobody is asked to pay for a class they have not actually got into', () => {
  // A waitlisted sign-up holds no spot, and registered interest is not a
  // booking. Taking money for either would be selling a class that may never
  // happen for them.
  for (const outcome of [
    { waitlisted: true },
    { bookings_open: false },
    { booking_mode: 'interest_only' },
  ]) {
    assert.equal(shouldOfferVisitorPasses({ has_membership: false, ...outcome }, {}), false,
      JSON.stringify(outcome));
  }
  assert.equal(shouldOfferVisitorPasses({ has_membership: false, took_spot: true }, {}), true);
});

test('the sign-up asks whether they are a member and will not submit without an answer', () => {
  const form = read('../src/components/public/BookingRequestForm.jsx');
  assert.match(form, /Do you already have a XERT membership\?/);
  assert.match(form, /hasMembership === null.*setError/s);
  // The answer and their details have to reach the page, or the confirmation
  // cannot offer anything and would ask for the same details again.
  assert.match(form, /has_membership: hasMembership/);
  assert.match(form, /full_name: form\.full_name, email: form\.email, phone: form\.phone/);
});

test('the timetable offers the passes on the confirmation and standing on the page', () => {
  const page = read('../src/pages/SoftLaunchTimetable.jsx');
  assert.match(page, /shouldOfferVisitorPasses\(bookingSuccess, settings\)/);
  assert.match(page, /offerPasses && \(\s*<VisitorPassChoices/);
  // The QR codes at the front desk are no use to somebody booking from home,
  // so the ways to pay are on the page whether or not anyone has booked.
  assert.match(page, /Not a member\?/);
});

test('a pass list with nobody\'s details does not overwrite remembered ones', () => {
  const component = read('../src/components/public/VisitorPassChoices.jsx');
  assert.match(component, /const carry = Boolean\(visitor\.email\)/);
  assert.match(component, /if \(carry\) rememberCasualVisitor\(visitor\)/);
});

test('the first booking step names the ways to pay, not the retired session pack', () => {
  // Session packs are gone, so "purchase a session pack" was step one of a
  // journey nobody could take.
  for (const file of ['../src/components/public/HowToTrain.jsx', '../src/pages/Booking.jsx']) {
    const source = read(file);
    assert.ok(!source.includes('Purchase a session pack.'), `${file} still sells session packs`);
    assert.match(source, /Memberships &amp; Passes/);
  }
});

test('a weekly membership is offered too, and sends people to FitBox', () => {
  // Memberships are not sold on this site, so this one is an app to install
  // and an invite to open — not a price and not a checkout.
  assert.equal(WEEKLY_MEMBERSHIP.url, 'https://links.fitbox.iq/invites/register/0545');
  assert.match(WEEKLY_MEMBERSHIP.url, /^https:\/\//);
  assert.equal(WEEKLY_MEMBERSHIP.charge, undefined, 'a membership has no price to show here');
  assert.ok(WEEKLY_MEMBERSHIP.label && WEEKLY_MEMBERSHIP.blurb);
  // Opening the invite without the app installed is a dead end, so the order
  // of the two steps is the whole instruction.
  assert.equal(WEEKLY_MEMBERSHIP.steps.length, 2);
  assert.match(WEEKLY_MEMBERSHIP.steps[0], /App Store or Google Play/);
  // The invite is rendered in different places on phone and desktop, so the
  // wording cannot point at where it sits on the page.
  assert.ok(!/\b(below|above)\b/.test(WEEKLY_MEMBERSHIP.steps.join(' ')));
  // It is not one of the priced passes, so it must never be priced as one.
  assert.ok(!VISITOR_PASS_CHOICES.some(choice => choice.kind === WEEKLY_MEMBERSHIP.kind));
  assert.ok(!visitorPassChoices({}).some(choice => choice.kind === WEEKLY_MEMBERSHIP.kind));
});

test('installing FitBox is one tap, on either phone', () => {
  // "Search the store for fitbox" is not an instruction: several unrelated
  // apps answer to that name, and installing the wrong one wastes the attempt.
  const platforms = WEEKLY_MEMBERSHIP.stores.map(store => store.platform);
  assert.deepEqual(platforms.sort(), ['android', 'ios']);
  const byPlatform = Object.fromEntries(
    WEEKLY_MEMBERSHIP.stores.map(store => [store.platform, store]));
  assert.match(byPlatform.ios.url, /^https:\/\/apps\.apple\.com\/.*\/id\d+$/);
  assert.match(byPlatform.android.url, /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+$/);
  for (const store of WEEKLY_MEMBERSHIP.stores) assert.ok(store.label, store.platform);
});

test('both store links are offered wherever the membership is', () => {
  for (const file of [
    '../src/pages/Memberships.jsx',
    '../src/components/public/VisitorPassChoices.jsx',
  ]) {
    const source = read(file);
    assert.match(source, /WEEKLY_MEMBERSHIP\.stores\.map/, file);
    // They sit on step one, which is the step they answer.
    assert.match(source, /index === 0 && \(/, file);
    assert.match(source, /rel="noopener noreferrer"/, file);
  }
});

test('the FitBox invite opens safely in a new tab, not as a pass link', () => {
  const component = read('../src/components/public/VisitorPassChoices.jsx');
  assert.match(component, /href=\{WEEKLY_MEMBERSHIP\.url\}/);
  // An external tab that can reach back into this one is a security hole, and
  // a router Link would try to navigate to it inside the app.
  assert.match(component, /rel="noopener noreferrer"/);
  assert.match(component, /target="_blank"/);
  assert.match(component, /WEEKLY_MEMBERSHIP\.steps\.map/);
});

test('a QR encodes an absolute address, since the phone scanning it is elsewhere', () => {
  for (const choice of VISITOR_PASS_CHOICES) {
    const url = visitorPassURL(choice, 'https://www.xertfitness.com.au');
    assert.equal(url, `https://www.xertfitness.com.au${choice.path}`);
    // A relative path in a QR simply fails to open.
    assert.match(url, /^https:\/\//);
  }
});

test('the memberships page is a real, indexable, listed route', () => {
  const routes = read('../src/App.jsx');
  assert.match(routes, /path="\/memberships" element=\{<Memberships \/>\}/);
  // "Passes" is what half of people call it, so it lands in the same place.
  assert.match(routes, /path="\/passes" element=\{<Navigate to="\/memberships" replace \/>\}/);

  const meta = metadataForPath('/memberships');
  assert.equal(meta.indexable, true);
  assert.match(meta.title, /Memberships/);
  assert.ok(read('../public/sitemap.xml').includes('/memberships</loc>'),
    'a page nobody can find is no better than no page');
  // Named the same in both places people look for it, and the same as the
  // page's own heading — "Memberships" alone hid that the passes are there.
  for (const file of [
    '../src/components/public/PublicNav.jsx',
    '../src/components/public/PublicFooter.jsx',
  ]) {
    assert.match(read(file), /\{ to: '\/memberships', label: 'Memberships & Passes' \}/, file);
  }
});

test('the memberships page shows every option, each with its QR', () => {
  const page = read('../src/pages/Memberships.jsx');
  assert.match(page, /visitorPassChoices\(settings\)/);
  assert.match(page, /<PassQRCode url=\{visitorPassURL\(choice, origin\)\}/);
  // The FitBox invite needs a code of its own, not just a link.
  assert.match(page, /<PassQRCode url=\{WEEKLY_MEMBERSHIP\.url\}/);
  assert.match(page, /rel="noopener noreferrer"/);
  // Prices come from the club's settings, never typed into the page.
  assert.ok(!/\$\d/.test(page), 'prices must not be hardcoded into the page');
});

test('a QR that cannot be drawn is dropped, not left as an empty frame', () => {
  const component = read('../src/components/public/PassQRCode.jsx');
  assert.match(component, /hidden=\{!ready\}/);
  assert.match(component, /\.catch\(\(\) => \{\}\)/);
  // A canvas carrying meaning needs a name a screen reader can say.
  assert.match(component, /role="img"/);
  assert.match(component, /aria-label=\{`QR code for \$\{label\}`\}/);
});

test('every offered pass has a real public route behind it', () => {
  const routes = read('../src/App.jsx');
  for (const choice of VISITOR_PASS_CHOICES) {
    assert.ok(routes.includes(`path="${choice.path}"`), `${choice.path} is not a route`);
  }
});
