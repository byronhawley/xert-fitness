import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import test from 'node:test';

const navDirectory = new URL('../src/components/public/nav/', import.meta.url);
const nav = [readFileSync(new URL('../src/components/public/PublicNav.jsx', import.meta.url), 'utf8'),
  ...(existsSync(navDirectory) ? readdirSync(navDirectory).filter(name => /\.(jsx|js|css)$/.test(name)).map(name => readFileSync(new URL(name, navDirectory), 'utf8')) : []),
].join('\n');
const memberForm = readFileSync(new URL('../src/components/public/MemberInterestForm.jsx', import.meta.url), 'utf8');
const events = readFileSync(new URL('../src/pages/Events.jsx', import.meta.url), 'utf8');
const contact = readFileSync(new URL('../src/pages/Contact.jsx', import.meta.url), 'utf8');
const stickyMobileCta = readFileSync(new URL('../src/components/public/StickyMobileCTA.jsx', import.meta.url), 'utf8');
const account = readFileSync(new URL('../src/pages/Account.jsx', import.meta.url), 'utf8');
const scrollToTop = readFileSync(new URL('../src/components/ScrollToTop.jsx', import.meta.url), 'utf8');
const packageManifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const formSources = [
  '../src/components/public/TrainerInterestForm.jsx',
  '../src/components/public/PartnerInterestForm.jsx',
  '../src/components/public/BookingRequestForm.jsx',
  '../src/components/public/PTRequestForm.jsx',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));

test('mobile navigation exposes its name, expanded state, controlled menu, and minimum target', () => {
  assert.match(nav, /aria-label=\{menuOpen \? 'Close navigation menu' : 'Open navigation menu'\}/);
  assert.match(nav, /aria-expanded=\{menuOpen\}/);
  assert.match(nav, /aria-controls="mobile-navigation"/);
  assert.match(nav, /min-w-11 min-h-11/);
  assert.match(nav, /id="mobile-navigation"/);
});

test('extracted navigation preserves keyboard containment and names useful sheet regions', () => {
  assert.match(nav, /aria-label="Next class"/);
  assert.match(nav, /Retry class information/);
  assert.match(nav, /aria-label="Close navigation menu"/);
  assert.match(nav, /<dialog\b/);
  assert.match(nav, /dialog\.showModal\(\)/);
  assert.match(nav, /onCancel=\{event => \{ event.preventDefault\(\); close\(\);/);
  assert.match(nav, /event\.key !== 'Tab'/);
  assert.match(nav, /\.focus\(/);
  assert.match(nav, /document\.body\.style\.overflow/);
});

test('Home display headings allow long words to wrap at enlarged text sizes', () => {
  for (const file of ['WhatXertIs', 'FacilitySection', 'TrainingStyle']) {
    const source = readFileSync(new URL(`../src/components/public/${file}.jsx`, import.meta.url), 'utf8');
    const heading = source.match(/<h2\b[\s\S]*?>/)?.[0];
    assert.ok(heading, `${file} has its display heading`);
    assert.match(heading, /overflowWrap: 'anywhere'/, `${file} must wrap long words within its column`);
  }
});

test('acquisition steppers wrap whole step groups rather than overflowing at enlarged text', () => {
  for (const file of ['MemberInterestForm', 'TrainerInterestForm', 'PartnerInterestForm']) {
    const source = readFileSync(new URL(`../src/components/public/${file}.jsx`, import.meta.url), 'utf8');
    assert.match(source, /className="flex flex-wrap items-center gap-2 mb-8">\s*\{STEPS\.map/);
  }
});

test('footer contact details remain fully readable inside constrained columns', () => {
  const source = readFileSync(new URL('../src/components/public/PublicFooter.jsx', import.meta.url), 'utf8');
  for (const field of ['email', 'instagram_handle', 'address']) {
    assert.match(source, new RegExp(`className="min-w-0 \\[overflow-wrap:anywhere\\]">\\{contact\\.${field}\\}`));
  }
  assert.match(source, /lg:grid-cols-\[minmax\(0,1\.1fr\)_minmax\(0,1\.2fr\)_minmax\(0,1fr\)\]/);
});

test('facility stats allow enlarged labels to wrap inside their responsive columns', () => {
  const source = readFileSync(new URL('../src/components/public/FacilitySection.jsx', import.meta.url), 'utf8');
  assert.match(source, /className="min-w-0 \[overflow-wrap:anywhere\]">\s*<p[^>]*>\{stat\.label\}/);
  assert.match(source, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,calc\(var\(--space-section\)\*6\)\),1fr\)\)\]/);
});

test('member contact fields use associated labels, stable names, and required semantics', () => {
  for (const field of ['full-name', 'email', 'phone', 'suburb']) {
    assert.match(memberForm, new RegExp(`htmlFor="member-${field}"`));
    assert.match(memberForm, new RegExp(`id="member-${field}"`));
  }
  assert.match(memberForm, /id="member-email" name="email" required autoComplete="email"/);
  assert.match(memberForm, /id="member-phone" name="phone" required autoComplete="tel"/);
});

test('event filters and actions provide full-size mobile targets', () => {
  assert.ok((events.match(/min-h-11/g) || []).length >= 5);
  assert.match(events, /Add to calendar/);
  assert.match(events, /Train for this/);
});

test('contact provides an accessible training gallery and actionable area map', () => {
  assert.match(contact, /aria-labelledby="contact-gallery-title"/);
  assert.match(contact, /title="Map of the Kingaroy Queensland area"/);
  assert.match(contact, /loading="lazy"/);
  assert.match(contact, /<Link to="\/booking"/);
});

test('the shared mobile booking action avoids a page reload and respects reduced motion', () => {
  assert.match(stickyMobileCta, /<Link to="\/booking"/);
  assert.match(stickyMobileCta, /motion-reduce:transition-none/);
  assert.match(stickyMobileCta, /requestAnimationFrame/);
  assert.doesNotMatch(stickyMobileCta, /framer-motion/);
});

test('member account failures stay inline and never masquerade as empty account data', () => {
  assert.match(account, /const \[hasLoadedAccount, setHasLoadedAccount\] = useState\(false\)/);
  assert.match(account, /const accountReady = hasLoadedAccount && loadedAccountUserId === user\?\.id/);
  assert.match(account, /const firstLoadFailed = !accountReady && Boolean\(loadError\)/);
  assert.match(account, /Could not refresh your account/);
  assert.match(account, /Your previously loaded details are still shown below/);
  assert.match(account, /onClick=\{refresh\}/);
  assert.match(account, /firstLoadFailed \|\| bookingsUnavailable/);
  assert.match(account, /firstLoadFailed \|\| ordersUnavailable/);
  assert.match(account, /Credit balance unavailable/);
});

test('public motion uses native reduced-motion-aware effects without a runtime dependency', () => {
  assert.doesNotMatch(packageManifest, /framer-motion/);
  assert.match(readFileSync(new URL('../src/index.css', import.meta.url), 'utf8'), /prefers-reduced-motion: reduce/);
  assert.match(readFileSync(new URL('../src/components/public/motion/Reveal.jsx', import.meta.url), 'utf8'), /IntersectionObserver/);
});

test('deep links wait for lazy authenticated content and respect reduced motion', () => {
  assert.match(scrollToTop, /new MutationObserver/);
  assert.match(scrollToTop, /observer\.observe\(document\.body, \{ childList: true, subtree: true \}\)/);
  assert.match(scrollToTop, /prefers-reduced-motion: reduce/);
  assert.match(scrollToTop, /scrollIntoView\(\{ behavior, block: "start" \}\)/);
  assert.match(scrollToTop, /observer\.disconnect\(\)/);
});

test('every remaining acquisition form names custom inputs and non-input controls', () => {
  for (const source of formSources) {
    // The accessible name comes from an associated label (htmlFor/id) — it must
    // never fall back to placeholder text.
    assert.doesNotMatch(source, /aria-label=\{props\['aria-label'\] \|\| props\.placeholder\}/);
    assert.match(source, /htmlFor="/);
    assert.match(source, /\bid="/);
    // Selects and textareas are named by an associated label (id) or aria-label.
    for (const tag of source.match(/<(select|textarea)\b[^>]*>/g) || []) {
      assert.match(tag, /aria-label=|\bid=/);
    }
    // Browser autofill must never fill the spam honeypot: a filled honeypot
    // silently drops the lead while the UI still reports success.
    assert.match(source, /name="company_website"[\s\S]{0,200}?autoComplete="off"/);
    // Chip option buttons meet the 44px touch-target minimum.
    assert.match(source, /min-h-11 px-3 py-2/);
  }
  // The member form's chips share the same pattern.
  assert.match(memberForm, /min-h-11 px-3 py-2/);
});

test('the shared dialog close control meets the 44px touch-target minimum', () => {
  const dialog = readFileSync(new URL('../src/components/ui/dialog.jsx', import.meta.url), 'utf8');
  assert.match(dialog, /h-11 w-11 items-center justify-center/);
});
