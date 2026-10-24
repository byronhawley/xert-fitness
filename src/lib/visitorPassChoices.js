// ─── Paying for the class you just booked ───────────────────────────────────
// Someone books a class on the website, and nothing tells them what happens
// next. Memberships are not linked to the site yet, so there is no account to
// charge — the visitor passes are sold on their own pages, reached by QR codes
// at the front desk that a person booking from home has never seen. They end
// up booked in and unable to pay.
//
// So the sign-up asks whether they are already a member, and anyone who is not
// is offered the four ways to pay, priced from the club's own settings.
//
// A weekly membership is the fifth way, and the odd one out: it is not a
// payment this site can take. Memberships live in FitBox, so joining means
// installing FitBox and opening the club's invite there. It is listed beside
// the passes anyway — somebody deciding how to pay wants to see all five, not
// four here and one nobody mentioned.

import {
  CASUAL_VISIT_ACTION, TEN_SESSION_PACK_ACTION, THREE_DAY_PASS_ACTION, THREE_MONTH_MEMBERSHIP_ACTION,
  visitorPassPricing,
} from './casualVisit.js';

export const VISITOR_PASS_CHOICES = Object.freeze([
  Object.freeze({
    kind: CASUAL_VISIT_ACTION,
    path: '/casual',
    label: 'Casual visit',
    blurb: 'This class only.',
  }),
  Object.freeze({
    kind: THREE_DAY_PASS_ACTION,
    path: '/3daypass',
    label: 'Three Day Pass',
    blurb: 'Three days of training to try us properly.',
  }),
  Object.freeze({
    kind: TEN_SESSION_PACK_ACTION,
    path: '/10pack',
    label: '10 Session Pack',
    blurb: 'Ten sessions, paid upfront.',
  }),
  Object.freeze({
    kind: THREE_MONTH_MEMBERSHIP_ACTION,
    path: '/3months',
    label: 'Three month membership',
    blurb: 'Three months, paid upfront.',
  }),
]);

/**
 * Joining on a weekly membership. Not a price and not a checkout: an app to
 * install and an invite to open, which is the whole reason it cannot sit in
 * the list above as though it were another button to press.
 *
 * The invite belongs to this club and never changes with a deploy, so it lives
 * here rather than in settings — there is nothing for staff to keep in step.
 */
export const WEEKLY_MEMBERSHIP = Object.freeze({
  kind: 'weekly_membership',
  label: 'Weekly membership',
  blurb: 'Ongoing, billed weekly. Set up in the FitBox app.',
  url: 'https://links.fitbox.iq/invites/register/0545',
  steps: Object.freeze([
    'Install FitBox from the App Store or Google Play.',
    'Open the XERT invite and register.',
  ]),
  // Step one is "install the app", so it has to be one tap rather than a name
  // to go and search for — a store search for "fitbox" returns several
  // unrelated apps, and installing the wrong one wastes the whole attempt.
  stores: Object.freeze([
    Object.freeze({
      platform: 'ios',
      label: 'App Store',
      url: 'https://apps.apple.com/au/app/fitbox/id1462002702',
    }),
    Object.freeze({
      platform: 'android',
      label: 'Google Play',
      url: 'https://play.google.com/store/apps/details?id=com.wa.fitbox',
    }),
  ]),
});

/**
 * The four ways to pay, with today's prices. A pass whose discount is running
 * carries the full price too, so the page can show what was struck out.
 */
export function visitorPassChoices(settings = {}) {
  return VISITOR_PASS_CHOICES.map(choice => ({
    ...choice, ...visitorPassPricing(choice.kind, settings),
  }));
}

/**
 * The absolute address a pass's QR code has to encode. A QR is scanned by a
 * phone that is not on this page and has no idea what "/casual" means, so a
 * relative path would simply fail to open.
 */
export function visitorPassURL(choice, origin) {
  return new URL(choice.path, origin).toString();
}

/**
 * The visitor details a pass page expects, from what the class sign-up asked.
 *
 * The sign-up takes one full name and the pass pages take two, so the last
 * word is the surname and everything before it is the given name — which keeps
 * double-barrelled and multi-part first names intact. A single word leaves the
 * surname blank rather than guessing: the pass page asks for it, and a name
 * typed in by the person it belongs to beats one this invented.
 */
export function visitorDetailsFromSignup(signup = {}) {
  const parts = String(signup.full_name || '').trim().split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '';
  return {
    first_name: first,
    last_name: last,
    email: String(signup.email || '').trim(),
    phone: String(signup.phone || '').trim(),
  };
}

/**
 * Whether to offer the passes after a sign-up.
 *
 * Only to somebody who said they are not a member — a member already pays
 * through their membership, and being sold a casual visit on top of it is
 * worse than saying nothing — and only while the club is taking visitor
 * payments at all.
 *
 * And only when there is something to pay for. A waitlisted sign-up holds no
 * spot, registered interest is not a booking, and a guest was invited: asking
 * any of them for money is asking for a class they do not owe for.
 */
export function shouldOfferVisitorPasses(signup, settings = {}) {
  if (signup?.has_membership !== false) return false;
  // A bring-a-friend guest owes nothing. Following "your spot is held" with a
  // list of prices is how a free invitation stops feeling free.
  if (signup.guest_visit) return false;
  if (settings?.casual_payments_enabled === false) return false;
  if (signup.waitlisted) return false;
  if (signup.bookings_open === false || signup.booking_mode === 'interest_only') return false;
  return true;
}
