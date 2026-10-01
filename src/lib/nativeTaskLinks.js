const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const exactFallbacks = new Map([
  ['/open/home', '/'],
  ['/open/home/notices', '/account#notices'],
  ['/open/booking', '/booking'],
  ['/open/booking/packs', '/booking#packs'],
  ['/open/booking/purchase-confirmation', '/account'],
  ['/open/events', '/events'],
  ['/open/events/goals', '/events#goals'],
  ['/open/explore', '/about'],
  ['/open/account', '/account'],
  ['/open/account/bookings', '/account#bookings'],
]);

const contextualFallbacks = [
  {
    pattern: new RegExp(`^/open/booking/classes/(${UUID_PATTERN})$`, 'i'),
    destination: match => `/booking?session=${match[1].toLowerCase()}`,
  },
  {
    pattern: new RegExp(`^/open/home/notices/${UUID_PATTERN}$`, 'i'),
    destination: '/account#notices',
  },
  {
    pattern: new RegExp(`^/open/account/bookings/${UUID_PATTERN}$`, 'i'),
    destination: '/account#bookings',
  },
];

// Coach roster links shared with the native app: `/open/coaching[/<tab>]`,
// optionally with `?month=YYYY-MM`. Only a well-formed month is carried over;
// every other query value is dropped, so no roster detail travels in a URL.
const coachingTabs = new Map([
  ['/open/coaching', null],
  ['/open/coaching/roster', 'roster'],
  ['/open/coaching/availability', 'availability'],
  ['/open/coaching/requests', 'requests'],
]);
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function coachingMonthParam(search) {
  if (typeof search !== 'string' || !search) return null;
  let month;
  try {
    month = new URLSearchParams(search).getAll('month');
  } catch {
    return null;
  }
  return month.length === 1 && MONTH_PATTERN.test(month[0]) ? month[0] : null;
}

function coachingFallback(normalized, search) {
  if (!coachingTabs.has(normalized)) return null;
  const params = new URLSearchParams();
  const tab = coachingTabs.get(normalized);
  if (tab) params.set('tab', tab);
  const month = coachingMonthParam(search);
  if (month) params.set('month', month);
  const query = params.toString();
  return query ? `/coaching?${query}` : '/coaching';
}

export function nativeTaskFallback(pathname, search = '') {
  if (typeof pathname !== 'string') return '/app';
  const normalized = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const coaching = coachingFallback(normalized, search);
  if (coaching) return coaching;
  const exact = exactFallbacks.get(normalized);
  if (exact) return exact;
  for (const { pattern, destination } of contextualFallbacks) {
    const match = normalized.match(pattern);
    if (match) return typeof destination === 'function' ? destination(match) : destination;
  }
  return '/app';
}
