import {
  BarChart3, BellRing, Briefcase, CalendarCheck2, CalendarDays, Mail, CalendarRange, ClipboardCheck, ClipboardList, DollarSign,
  Dumbbell, Handshake, Inbox, ListChecks, MessageSquareText, PenSquare, ScrollText,
  Settings, ShieldCheck, Sun, Ticket, Trophy, Tv, UserCog, Users, UserSquare2,
} from 'lucide-react';

// ─── Owner information architecture ─────────────────────────────────────────
// Six hubs in the words a gym owner uses. Every screen keeps its existing
// route key, so nothing deep-links or bookmarks differently; only the way the
// owner reaches it changes. The native app mirrors these hubs one-for-one.
//
//   Today     what's on and what needs you
//   Classes   the timetable and everything attached to a class
//   People    members, enquiries and applicants
//   Communications  every way XERT talks to people
//   Website & forms public pages, waivers and feedback
//   Business  money, settings and the system itself

export const ADMIN_HUBS = Object.freeze([
  {
    key: 'today',
    label: 'Today',
    icon: Sun,
    detail: "What's on and what needs you",
    items: [
      { key: 'overview', label: 'Today', detail: "Next class, what needs you, quick actions", icon: Sun },
    ],
  },
  {
    key: 'classes',
    label: 'Classes',
    icon: CalendarDays,
    detail: 'Timetable, requests and roll call',
    items: [
      { key: 'calendar', label: 'Class calendar', detail: 'Add, publish and run classes', icon: CalendarDays },
      { key: 'roster', label: 'Coach roster', detail: 'Who coaches each class, availability and cover', icon: CalendarCheck2 },
      { key: 'bookings', label: 'Class requests', detail: 'People asking for a spot', icon: Inbox },
      { key: 'pt-requests', label: 'Personal training', detail: 'PT enquiries to approve', icon: Dumbbell },
      { key: 'availability', label: 'Opening hours', detail: 'Bookable times and closures', icon: CalendarRange },
      { key: 'workouts', label: 'Club TV workout', detail: 'What the in-club screen shows', icon: Tv },
    ],
  },
  {
    key: 'people',
    label: 'People',
    icon: Users,
    detail: 'Members and enquiries',
    items: [
      { key: 'gym-members', label: 'Members', detail: 'Accounts, credits and notes', icon: Users },
      { key: 'members', label: 'New enquiries', detail: 'People interested in joining', icon: ClipboardList },
      { key: 'trainers', label: 'Trainer applicants', detail: 'Coaches applying to work here', icon: UserCog },
      { key: 'partners', label: 'Partner enquiries', detail: 'Local businesses reaching out', icon: Handshake },
      { key: 'campaigns', label: 'Where members come from', detail: 'Which channels bring people in', icon: BarChart3 },
    ],
  },
  {
    key: 'communications',
    label: 'Communications',
    icon: MessageSquareText,
    detail: 'Texts, emails and app notices',
    items: [
      { key: 'sms', label: 'Text members', detail: 'SMS any group with a mobile', icon: MessageSquareText },
      { key: 'announcements', label: 'App notices', detail: 'Push a notice to the member app', icon: BellRing },
      { key: 'emails', label: 'Email members', detail: 'Email any group, plus automatic emails', icon: Mail },
    ],
  },
  {
    key: 'website',
    label: 'Website & forms',
    icon: PenSquare,
    detail: 'Forms, pages, coaches and events',
    items: [
      { key: 'forms', label: 'Forms & surveys', detail: 'Waivers, sign-ups and feedback', icon: ListChecks },
      { key: 'content', label: 'Website content', detail: 'Homepage, FAQs and terms', icon: PenSquare },
      { key: 'coaches', label: 'Coaches page', detail: 'Who appears on the website', icon: UserSquare2 },
      { key: 'events', label: 'Events page', detail: 'The public events calendar', icon: Trophy },
    ],
  },
  {
    key: 'business',
    label: 'Business',
    icon: Briefcase,
    detail: 'Money, settings, status',
    items: [
      { key: 'orders', label: 'Orders & revenue', detail: 'Payments, refunds and totals', icon: DollarSign },
      { key: 'products', label: 'Pricing', detail: 'Session packs and prices', icon: Ticket },
      { key: 'settings', label: 'Settings', detail: 'Launch date, bookings and payments', icon: Settings },
      { key: 'health', label: 'System status', detail: 'Is everything connected and working', icon: ShieldCheck },
      { key: 'fitbox', label: 'FitBox', detail: 'Members, memberships, bookings and sync', icon: ClipboardCheck },
      { key: 'audit', label: 'Activity log', detail: 'Who changed what, and when', icon: ScrollText },
    ],
  },
]);

/** Back-compat name: the palette and tests iterate groups; hubs are the groups now. */
export const ADMIN_WORKSPACE_GROUPS = ADMIN_HUBS;

export const ADMIN_WORKSPACES = Object.freeze(
  ADMIN_HUBS.flatMap(hub => hub.items.map(item => ({ ...item, hub: hub.key, hubLabel: hub.label }))),
);

export function hubForSection(sectionKey) {
  return ADMIN_HUBS.find(hub => hub.items.some(item => item.key === sectionKey)) || ADMIN_HUBS[0];
}

/** The phone dock is the six primary hubs; tapping one opens its first screen. */
export const ADMIN_MOBILE_WORKSPACES = Object.freeze(
  ADMIN_HUBS.map(hub => ({
    key: hub.items[0].key,
    hub: hub.key,
    label: hub.label,
    mobileLabel: ({ communications: 'Comms', website: 'Website' })[hub.key] || hub.label,
    icon: hub.icon,
    detail: hub.detail,
  })),
);

/** The four things an owner does most, as one-tap buttons on Today. */
export const ADMIN_QUICK_ACTIONS = Object.freeze([
  { key: 'calendar', label: 'Add a class', icon: CalendarDays, params: { action: 'create' } },
  { key: 'sms', label: 'Text members', icon: MessageSquareText },
  { key: 'announcements', label: 'Publish a notice', icon: BellRing, params: { action: 'create' } },
  { key: 'workouts', label: "Set today's workout", icon: Tv },
]);
