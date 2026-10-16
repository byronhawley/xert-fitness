import { normalizeProviderUrl, resolvePlatformProvider } from './platformProvider.js';
import {
  CASUAL_VISIT_ACTION, TEN_SESSION_PACK_ACTION, THREE_DAY_PASS_ACTION, THREE_MONTH_MEMBERSHIP_ACTION, visitorPass,
} from './casualVisit.js';

/**
 * Fallback opening date, used only when no admin settings row supplies one.
 * The live value is `admin_settings.target_launch_date`, editable in the admin
 * panel under Platform Settings -> Target launch date. Keep this in one place:
 * it was previously duplicated across four files, so moving the date meant
 * finding all four.
 */
export const DEFAULT_TARGET_LAUNCH_DATE = '2026-09-14';

function normalizeDate(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error('Choose a valid target launch date.');
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Choose a valid target launch date.');
  }
  return normalized;
}

export function sessionPackPaymentsEnabled(settings) {
  return settings?.bookings_enabled === true && settings?.payments_enabled === true;
}

// `prices_coming_soon` hid amounts on the public session-pack shop. That shop
// is gone with the packs, and the prices the site shows now — the visitor
// passes — are read straight from settings and priced again by the server, so
// nothing reads the flag any more. The column stays where it is: dropping it
// would rewrite the settings row for no gain.

function normalizeFitboxUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const url = normalizeProviderUrl(raw);
  if (!url) {
    throw new Error('Enter a valid Fitbox member portal link, starting with https://.');
  }
  return url;
}

// Bookings and payments hand off to the external FitBox member portal only
// when the switch is on AND a usable HTTPS link is saved. A requested FitBox
// provider with a broken link fails closed; it never falls back to native
// booking or checkout without Byron deliberately switching providers.
export function fitboxHandoff(settings = {}) {
  const provider = resolvePlatformProvider(settings);
  return {
    active: provider.provider === 'fitbox' && provider.configured && !provider.blocked,
    requested: settings?.fitbox_enabled === true,
    blocked: provider.provider === 'fitbox' && provider.blocked,
    blockedReason: provider.provider === 'fitbox' ? provider.blockedReason : null,
    url: provider.portalUrl,
    capabilities: provider.capabilities,
  };
}

export function normalizeLaunchSettings(settings = {}) {
  const announcement = String(settings.announcement_banner_text || '').trim();
  if (settings.announcement_banner_enabled && !announcement) {
    throw new Error('Add announcement text before enabling the banner.');
  }
  const fitboxUrl = normalizeFitboxUrl(settings.fitbox_booking_url);
  if (settings.fitbox_enabled && !fitboxUrl) {
    throw new Error('Add the Fitbox member portal link before enabling Fitbox bookings.');
  }

  return {
    countdown_enabled: Boolean(settings.countdown_enabled),
    bookings_enabled: Boolean(settings.bookings_enabled),
    payments_enabled: Boolean(settings.payments_enabled),
    prices_coming_soon: settings.prices_coming_soon !== false,
    announcement_banner_enabled: Boolean(settings.announcement_banner_enabled),
    target_launch_date: normalizeDate(settings.target_launch_date),
    announcement_banner_text: announcement || null,
    fitbox_enabled: Boolean(settings.fitbox_enabled),
    fitbox_booking_url: fitboxUrl,
    // Class packs are retired, so credits stay off unless the club turns them
    // back on. Off means booking never looks for one.
    class_credits_enabled: Boolean(settings.class_credits_enabled),
    casual_payments_enabled: settings.casual_payments_enabled !== false,
    ...normalizeVisitorPricing(settings),
  };
}

/**
 * The four visitor prices and their discounts. A discount is the price
 * actually charged while it runs, so a club types what a visitor pays rather
 * than a percentage — and a discount cannot be switched on unless it is set
 * and genuinely cheaper, which is the same rule the database enforces.
 */
export const VISITOR_PRICE_FIELDS = Object.freeze([
  // Each pass's price lives with the pass itself. These used to carry their
  // own copy of the amount, so raising the Three Day Pass to $39 in one place
  // quietly left the other still answering $35.
  Object.freeze({
    key: 'casual', label: 'Casual visit',
    price: 'casual_visit_price_cents', discount: 'casual_visit_discount_cents',
    enabled: 'casual_visit_discount_enabled',
    fallback: visitorPass(CASUAL_VISIT_ACTION === 'casual_visit' ? 'casual' : CASUAL_VISIT_ACTION).defaultPriceCents,
  }),
  Object.freeze({
    key: 'three-day', label: 'Three Day Pass',
    price: 'three_day_pass_price_cents', discount: 'three_day_pass_discount_cents',
    enabled: 'three_day_pass_discount_enabled',
    fallback: visitorPass(THREE_DAY_PASS_ACTION).defaultPriceCents,
  }),
  // The site can go live before the 10 Session Pack migration has been run.
  // Until its columns exist this row is left out of every save, because one
  // unknown column makes the database refuse the whole Settings save, visitor
  // payments switch and all.
  Object.freeze({
    key: 'ten-pack', label: '10 Session Pack',
    price: 'ten_session_pack_price_cents', discount: 'ten_session_pack_discount_cents',
    enabled: 'ten_session_pack_discount_enabled',
    fallback: visitorPass(TEN_SESSION_PACK_ACTION).defaultPriceCents,
    optionalColumn: true,
  }),
  Object.freeze({
    key: 'three-month', label: 'Three month membership',
    price: 'three_month_price_cents', discount: 'three_month_discount_cents',
    enabled: 'three_month_discount_enabled',
    fallback: visitorPass(THREE_MONTH_MEMBERSHIP_ACTION).defaultPriceCents,
  }),
]);

export function normalizeVisitorPricing(settings = {}) {
  const normalized = {};
  for (const field of VISITOR_PRICE_FIELDS) {
    if (!visitorPriceFieldInstalled(field, settings)) continue;
    const price = normalizeCasualPrice(settings[field.price], field.fallback);
    const raw = settings[field.discount];
    const discount = raw === '' || raw === null || raw === undefined
      ? null
      : normalizeCasualPrice(raw, field.fallback);
    const enabled = settings[field.enabled] === true;
    if (enabled && discount === null) {
      throw new Error(`Set a ${field.label.toLowerCase()} discount price before switching the discount on.`);
    }
    if (enabled && discount >= price) {
      throw new Error(`The ${field.label.toLowerCase()} discount must be cheaper than its full price.`);
    }
    normalized[field.price] = price;
    normalized[field.discount] = discount;
    normalized[field.enabled] = enabled;
  }
  return normalized;
}

/**
 * Whether the settings row has a price's columns yet. The row is read with
 * select('*'), so a column the database has is always present, if only as
 * its default.
 */
export function visitorPriceFieldInstalled(field, settings = {}) {
  return !field.optionalColumn || settings?.[field.price] !== undefined;
}

/**
 * The door fee, in cents. Kept inside the range the database will accept so a
 * typo is refused here with an explanation rather than by a constraint later.
 */
export function normalizeCasualPrice(value, fallback = 1560) {
  if (value === '' || value === null || value === undefined) return fallback;
  const cents = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value).replace(/[^\d]/g, ''), 10);
  if (!Number.isInteger(cents)) throw new Error('Enter the casual visit price in dollars, for example 15.60.');
  if (cents < 100 || cents > 100000) throw new Error('The casual visit price must be between $1 and $1,000.');
  return cents;
}

export function launchSettingsChanged(current = {}, saved = {}) {
  const fields = [
    'countdown_enabled',
    'bookings_enabled',
    'payments_enabled',
    'prices_coming_soon',
    'announcement_banner_enabled',
    'target_launch_date',
    'announcement_banner_text',
    'fitbox_enabled',
    'fitbox_booking_url',
    'class_credits_enabled',
    'casual_payments_enabled',
    'casual_visit_price_cents',
    'casual_visit_discount_cents',
    'casual_visit_discount_enabled',
    'three_day_pass_price_cents',
    'three_day_pass_discount_cents',
    'three_day_pass_discount_enabled',
    'three_month_price_cents',
    'three_month_discount_cents',
    'three_month_discount_enabled',
    'ten_session_pack_price_cents',
    'ten_session_pack_discount_cents',
    'ten_session_pack_discount_enabled',
  ];
  return fields.some(field => String(current[field] ?? '') !== String(saved[field] ?? ''));
}

/**
 * Decides whether the public soft-launch countdown should render.
 *
 * A countdown reaching zero says the target date arrived. It does NOT say the
 * gym opened — that is a business fact the timer cannot know. The countdown
 * previously flipped to a hardcoded "We're Open — XERT Fitness is now open in
 * Kingaroy." the moment the date rolled past, which the public read as fact.
 * Staff had no way to retract it: the copy was not editable anywhere, and the
 * only control was a toggle that hid the entire section.
 *
 * An expired countdown is therefore hidden. Announcing an opening is a
 * deliberate act and belongs to the announcement banner
 * (`announcement_banner_text` / `announcement_banner_enabled`), which is
 * admin-authored and can be switched off again.
 */
/**
 * `target_launch_date` is a bare calendar date, and `new Date('2026-09-14')`
 * reads it as UTC midnight — which is 10:00 am in Kingaroy. The countdown
 * therefore kept ticking through the opening morning and then vanished
 * mid-morning, and the day counter dropped to "00 Days" from 10:00 am the day
 * before. The gym opens at the start of its own day, so that is what we count
 * down to: midnight in Brisbane, which is 14:00 UTC the day before.
 */
export function launchTargetTime(targetDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(targetDate || '').trim());
  if (!match) {
    const loose = new Date(targetDate).getTime();
    return Number.isFinite(loose) ? loose : NaN;
  }
  const [, year, month, day] = match.map(Number);
  // Brisbane is UTC+10 all year — no daylight saving to track.
  return Date.UTC(year, month - 1, day, 0, 0, 0) - 10 * 60 * 60 * 1000;
}

export function countdownVisibility(targetDate, enabled, now = new Date()) {
  if (!enabled) return 'hidden';
  const target = launchTargetTime(targetDate);
  if (!Number.isFinite(target)) return 'hidden';
  return target - now.getTime() <= 0 ? 'hidden' : 'counting';
}
