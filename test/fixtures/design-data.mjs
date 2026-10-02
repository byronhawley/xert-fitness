// Fictional, local-browser-only data. Never imported by the application.
import { installCommandData } from './admin-command-data.mjs';
import { installCalendarData } from './admin-calendar-data.mjs';
import { installLeadData } from './admin-lead-data.mjs';
import { installFormData } from './admin-form-data.mjs';
import { installMemberData } from './admin-member-data.mjs';
import { installOrderData } from './admin-order-data.mjs';
import { installTodayData } from './admin-today-data.mjs';

export const fixtureUser = {
  id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated',
  email: 'alex@example.invalid', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Alex Morgan' }, created_at: '2026-01-01T00:00:00Z',
};

export function fixtureSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    access_token: `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: fixtureUser.id, aud: 'authenticated', role: 'authenticated', exp: expiresAt })}.local-fixture-only`,
    refresh_token: 'local-fixture-only', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt,
    user: fixtureUser,
  };
}

export function designData() {
  const start = new Date(Date.now() + 2 * 3600000).toISOString();
  const end = new Date(Date.now() + 3 * 3600000).toISOString();
  const session = {
    id: '22222222-2222-4222-8222-222222222222', session_id: '22222222-2222-4222-8222-222222222222',
    title: 'Foundation Strength', session_type: 'strength', start_time: start, end_time: end,
    status: 'published', coach_name: 'Sam', location_zone: 'Main floor', capacity: 8,
    confirmed_count: 6, booked_count: 6, available_spots: 2, spots_remaining: 2,
    requested_count: 2, public_request_count: 1, waitlist_count: 2, attendance_due: false,
    booking_mode: 'request_to_book',
  };
  return {
    profiles: [{ ...fixtureUser, full_name: 'Alex Morgan', role: 'admin' }],
    admin_settings: [{ id: 'fixture-settings', bookings_enabled: true, payments_enabled: false,
      prices_coming_soon: true, countdown_enabled: false, class_credits_enabled: false,
      soft_launch_mode: true, default_booking_mode: 'request_to_book' }],
    sessions: [session],
    class_sessions: [{ ...session, public_visible: true }],
    public_class_availability: [{ class_session_id: session.id, capacity: 8, taken: 6, waiting: 0,
      pending: 2, spots_left: 2, bookings_open: true, can_take_spot: true, booking_mode: 'request_to_book' }],
    sessions_with_availability: [session],
    admin_daily_operations: [session],
    my_bookings: [{ id: '33333333-3333-4333-8333-333333333333', booking_id: '33333333-3333-4333-8333-333333333333', session_id: session.id,
      session_title: session.title, title: session.title, start_time: start, end_time: end,
      status: 'confirmed', coach_name: 'Sam' }],
    my_member_announcements: [], admin_waitlist_overview: [],
  };
}

const readRPCs = new Set([
  'sessions_with_availability', 'my_bookings', 'my_member_announcements', 'admin_daily_operations',
  'admin_waitlist_overview', 'admin_search_members', 'admin_members_overview',
  'public_class_availability',
  'admin_session_roster', 'admin_class_capacity', 'admin_search_class_attendees',
  'pt_public_coaches', 'pt_member_overview',
]);

// Network-level isolation: keep real auth/router/components, intercept only I/O.
// External data destinations are fulfilled here or aborted. Only unauthenticated
// Google Fonts reads pass through so typography matches the real product.
export async function installDesignFixtures(context, { origin, signedIn = false, requests = [], failures = {}, announcement = false, commands = false, calendar = false, leads = false, forms = false, members = false, orders = false, today = false, mutations = [] }) {
  const data = designData();
  // PT booking is installed but switched off unless a test routes pt_* itself.
  data.pt_public_coaches = { enabled: false, coaches: [] };
  data.pt_member_overview = { enabled: false, bookings: [], packages: [] };
  if (commands && calendar) throw new Error('Use separate contexts for command mutation and read-only calendar fixtures.');
  if (commands && forms) throw new Error('Use separate contexts for command mutation and read-only form fixtures.');
  if (commands && members) throw new Error('Use separate contexts for command mutation and read-only member fixtures.');
  if (commands && orders) throw new Error('Use separate contexts for command mutation and read-only order fixtures.');
  if (members && orders) throw new Error('Use separate contexts for member history and full order fixtures.');
  if (today && (commands || calendar || leads || forms || members || orders)) throw new Error('Use a separate context for the read-only Today fixture.');
  const commandData = commands ? installCommandData(data, { mutations }) : null;
  const calendarData = calendar ? installCalendarData(data) : null;
  const leadData = leads ? installLeadData() : null;
  const formData = forms ? installFormData() : null;
  const memberData = members ? installMemberData() : null;
  const orderData = orders ? installOrderData() : null;
  const todayData = today ? installTodayData() : null;
  if (announcement) Object.assign(data.admin_settings[0], {
    announcement_banner_enabled: true,
    announcement_banner_text: 'Welcome to XERT. Our coached training sessions are open for booking. Please arrive ten minutes early so your coach can help you get ready.',
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue();
    const method = request.method();
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)
      && method === 'GET' && !request.headers().authorization) return route.continue();
    const respond = (body, status = 200, extra = {}) => route.fulfill({ status,
      contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...extra },
      body: method === 'HEAD' ? '' : JSON.stringify(body),
    });
    if (url.hostname.endsWith('.supabase.co') || url.hostname === 'invalid.xert.invalid') {
      requests.push({ method, path: url.pathname });
      if (url.pathname === '/auth/v1/user') return respond(fixtureUser);
      const rpc = url.pathname.startsWith('/rest/v1/rpc/');
      const name = url.pathname.split('/').at(-1);
      if (failures[name] > 0) {
        failures[name] -= 1;
        return respond({ message: 'Fixture class service temporarily unavailable.' }, 503);
      }
      const args = method === 'POST' || method === 'PATCH' ? request.postDataJSON() || {} : {};
      const simulated = commandData?.mutate(name, { method, url, body: args });
      if (simulated) return respond(simulated.body, simulated.status || 200);
      const memberPage = memberData?.read(name, args, url);
      if (rpc && !readRPCs.has(name) && !memberPage) return respond({ message: 'Mutation or unconfigured RPC blocked by local design fixture.' }, 501);
      if (!rpc && !['GET', 'HEAD', 'OPTIONS'].includes(method)) return respond({ message: 'Writes blocked by local design fixture.' }, 403);
      const fixturePage = leadData?.read(name, url) ?? formData?.read(name, url) ?? memberPage ?? orderData?.read(name, url) ?? todayData?.read(name, url);
      if (fixturePage) {
        const single = request.headers().accept?.includes('vnd.pgrst.object');
        return respond(single ? fixturePage.rows[0] ?? null : fixturePage.rows, 200, { 'content-range': fixturePage.rows.length
          ? `${fixturePage.offset}-${fixturePage.offset + fixturePage.rows.length - 1}/${fixturePage.total}` : `*/${fixturePage.total}` });
      }
      const rows = calendarData?.read(name, args, url) ?? commandData?.read(name, args) ?? data[name] ?? [];
      const single = request.headers().accept?.includes('vnd.pgrst.object');
      return respond(single ? rows[0] ?? null : rows, 200, { 'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' });
    }
    if (url.origin === origin && method === 'GET' && url.pathname === '/api/admin-fitbox-integration') {
      const leadState = leadData?.leadState(url.searchParams.get('lead_id'));
      if (leadState) {
        requests.push({ method, path: url.pathname, fixture: true });
        return respond(leadState);
      }
    }
    requests.push({ method, path: url.pathname, blocked: true });
    if (url.origin === origin) return respond({ message: 'Live APIs disabled in local design verification.' }, 403);
    return route.abort('blockedbyclient');
  });
  if (signedIn) {
    await context.addInitScript(session => {
      localStorage.setItem('sb-ugmkwoapjcpiucsrxwzt-auth-token', JSON.stringify(session));
    }, fixtureSession());
  }
}
