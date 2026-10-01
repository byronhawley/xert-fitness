export const DEFAULT_ADMIN_SECTION = 'overview';

export const ADMIN_SECTION_KEYS = Object.freeze([
  'overview',
  'health',
  'fitbox',
  'audit',
  'gym-members',
  'orders',
  'products',
  'calendar',
  'roster',
  'workouts',
  'bookings',
  'pt-requests',
  'availability',
  'forms',
  'announcements',
  'sms',
  'emails',
  'content',
  'coaches',
  'events',
  'members',
  'trainers',
  'partners',
  'settings',
  'campaigns'
]);

const ADMIN_SECTION_SET = new Set(ADMIN_SECTION_KEYS);

/** Consume only this workspace's handled intent; filters and caller context survive. */
export function adminSearchAfterIntent(search, section) {
  const params = new URLSearchParams(search);
  const keys = section === 'calendar' ? ['action', 'session'] : section === 'gym-members' ? ['member'] : ['action'];
  keys.forEach(key => params.delete(key));
  return params.toString();
}

export function isAdminSection(value) {
  return ADMIN_SECTION_SET.has(value);
}

export function getAdminSectionFromPath(pathname) {
  const path = String(pathname || '').split(/[?#]/, 1)[0];
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'admin' || segments.length === 1) return DEFAULT_ADMIN_SECTION;
  return isAdminSection(segments[1]) ? segments[1] : DEFAULT_ADMIN_SECTION;
}

export function getAdminSectionPath(section, params = {}) {
  const safeSection = isAdminSection(section) ? section : DEFAULT_ADMIN_SECTION;
  const pathname = safeSection === DEFAULT_ADMIN_SECTION ? '/admin' : `/admin/${safeSection}`;
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) search.set(key, String(value));
  });
  return search.size ? `${pathname}?${search}` : pathname;
}
