export const SITE_NAME = 'XERT Fitness';

// The address people actually visit. Every public tag — canonical, og:url, the
// sitemap — has to agree on it, or a shared link previews as, and opens on, the
// deployment host instead of the club's own domain.
//
// With the www, because that is where the site actually answers: the bare
// domain 308-redirects to it, and a canonical pointing at a redirect makes
// search engines and scrapers take an extra hop to work out the real page.
export const SITE_ORIGIN = 'https://www.xertfitness.com.au';

// Site-wide social-preview image for og:image / twitter:image: a purpose-built
// 1200x630 card (navy blueprint backdrop + wordmark) at the exact ratio social
// platforms crop to, saved as an opaque JPEG so it composites predictably.
export const SOCIAL_IMAGE = Object.freeze({
  url: '/assets/xert-social-card.jpg',
  width: 1200,
  height: 630,
  alt: 'XERT Fitness',
});

const HOME_TITLE = 'XERT Fitness | Functional Training Kingaroy';
const HOME_DESCRIPTION = 'Structured, coach-led functional fitness, personal training and event preparation in Kingaroy, Queensland.';

export const PUBLIC_METADATA = Object.freeze({
  '/': { title: HOME_TITLE, description: HOME_DESCRIPTION },
  '/about': { title: 'About XERT Fitness | Kingaroy', description: 'Meet the purpose, coaching model and training philosophy behind XERT Fitness in Kingaroy.' },
  '/coaches': { title: 'Coaches and Practitioners | XERT Fitness', description: 'Meet the coaches and allied health practitioners supporting XERT Fitness members.' },
  '/events': { title: '2026 Event Calendar | XERT Fitness', description: 'Explore the 2026 South East Queensland events that shape XERT Fitness training blocks and shared member goals.' },
  '/booking': { title: 'Book Classes | XERT Fitness', description: 'Request a class or a personal training session with XERT Fitness in Kingaroy.' },
  '/contact': { title: 'Contact XERT Fitness | Kingaroy', description: 'Contact XERT Fitness about classes, coaching, allied health partnerships or your first session.' },
  '/training-guide': { title: 'Functional Training Guide | XERT Fitness', description: 'Learn how XERT approaches functional fitness, movement quality, conditioning and event preparation.' },
  '/memberships': { title: 'Memberships and Passes | XERT Fitness', description: 'Casual visits, the Three Day Pass, three months upfront or an ongoing weekly membership at XERT Fitness in Kingaroy — prices, QR codes and how to join.' },
  '/timetable': { title: 'Class Timetable | XERT Fitness', description: 'View the XERT Fitness soft-launch timetable and planned class schedule in Kingaroy.' },
  '/app': { title: 'XERT Fitness iPhone App', description: 'Manage XERT bookings, your membership, training goals and events from the XERT Fitness iPhone app.' },
  '/trainer-interest': { title: 'Coach Opportunities | XERT Fitness', description: 'Register your interest in coaching or personal training opportunities with XERT Fitness.' },
  '/partner-interest': { title: 'Allied Health Partnerships | XERT Fitness', description: 'Register your interest in an allied health or community partnership with XERT Fitness.' },
  '/privacy': { title: 'Privacy Policy | XERT Fitness', description: 'Read how XERT Fitness collects, uses and protects member and website visitor information.' },
  '/terms': { title: 'Terms and Conditions | XERT Fitness', description: 'The XERT Fitness membership agreement: memberships, club access, cancellation, privacy and the conditions that apply to training with us.' },
});

// Real pages that must never be indexed. The club TV kiosk is public (a
// television cannot sign in) but has no business appearing in search results.
const NOINDEX_TITLES = Object.freeze({
  '/display': 'Workout Display | XERT Fitness',
  // Reached from a QR code at the front desk, not from a search result.
  '/casual': 'Casual visit | XERT Fitness',
  '/3daypass': 'Three Day Pass | XERT Fitness',
  '/3months': 'Three month membership | XERT Fitness',
});

const NOINDEX_PATHS = new Set([
  '/account',
  '/coaching',
  '/admin',
  '/display',
  '/checkout-return',
  '/forgot-password',
  '/login',
  '/register',
  '/reset-password',
  '/thank-you',
]);

export function metadataForPath(pathname) {
  const normalized = pathname !== '/' ? pathname.replace(/\/+$/, '') : '/';
  const publicMetadata = PUBLIC_METADATA[normalized];
  if (publicMetadata) return { ...publicMetadata, indexable: true, path: normalized };

  const isPrivate = normalized.startsWith('/admin/') || NOINDEX_PATHS.has(normalized);
  return {
    title: NOINDEX_TITLES[normalized]
      || (isPrivate ? `${SITE_NAME} | Member Access` : `Page Not Found | ${SITE_NAME}`),
    description: HOME_DESCRIPTION,
    indexable: false,
    path: normalized,
  };
}
