// Coach dashboard Home tab and invite-link helpers. SYNTHETIC DATA ONLY.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import { answerableMonths, coachChecklist, upcomingClasses } from '../src/lib/staffRoster/coachHome.js';
import {
  forgetInviteToken, INVITE_OUTCOMES, inviteLink, inviteTokenFromHash, normalizeInviteToken, recallInviteToken, rememberInviteToken,
} from '../src/lib/staffRoster/invite.js';
import { createStaffRosterClient } from '../src/lib/staffRosterData.js';
import { nativeTaskFallback } from '../src/lib/nativeTaskLinks.js';

const TOKEN = 'ab'.repeat(32);
const period = (month, extra = {}) => ({ month: `${month}-01`, due_on: `${month}-20`, is_open: true, deadline_passed: false, reopened: false, submission: null, ...extra });
const me = (extra = {}) => ({ staff: { display_name: 'Synthetic Coach' }, periods: [], pending_acknowledgements: [], unread_notifications: 0, ...extra });

test('checklist: an open, unanswered month is the first thing to do', () => {
  const rows = coachChecklist(me({ periods: [period('2026-12'), period('2027-01')], unread_notifications: 2 }));
  assert.deepEqual(rows.map(row => [row.key, row.done]), [['linked', true], ['availability', false], ['roster', true], ['inbox', false]]);
  assert.equal(rows[1].month, '2026-12');
  assert.match(rows[3].detail, /2 unread notices/);
});

test('checklist: submitted, past-deadline and no-period months read honestly', () => {
  const submitted = coachChecklist(me({ periods: [period('2026-12', { submission: { version: 1 } })] }));
  assert.equal(submitted[1].done, true);
  const closed = coachChecklist(me({ periods: [period('2026-12', { deadline_passed: true })] }));
  assert.equal(closed[1].done, null, 'a missed deadline is not a to-do the coach can act on');
  assert.equal(answerableMonths(me({ periods: [period('2026-12', { deadline_passed: true, reopened: true })] })).length, 1, 'a reopened month is answerable');
  const reopened = coachChecklist(me({ periods: [period('2026-12', { deadline_passed: true, reopened: true, submission: { version: 1 } })] }));
  assert.equal(reopened[1].done, false, 'a month the manager reopened is a to-do even with an earlier submission');
  assert.match(reopened[1].detail, /reopened it for you/);
  const acks = coachChecklist(me({ pending_acknowledgements: [{ month: '2026-12-01', revision_id: 'r', number: 2 }] }));
  assert.equal(acks.find(row => row.key === 'roster').done, false);
});

test('next classes skip cancelled and finished ones and are soonest first', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const rows = [
    { assignment_id: 'c', start: '2026-12-03T00:00:00Z', end: '2026-12-03T01:00:00Z', status: 'published' },
    { assignment_id: 'x', start: '2026-12-02T00:00:00Z', end: '2026-12-02T01:00:00Z', status: 'cancelled' },
    { assignment_id: 'a', start: '2026-12-01T20:00:00Z', end: '2026-12-01T21:00:00Z', status: 'published' },
    { assignment_id: 'old', start: '2026-11-30T20:00:00Z', end: '2026-11-30T21:00:00Z', status: 'published' },
  ];
  assert.deepEqual(upcomingClasses(rows, now).map(row => row.assignment_id), ['a', 'c']);
});

test('invite links carry the token in the fragment only, and the helpers reject anything else', () => {
  assert.equal(inviteLink('https://example.test/', TOKEN), `https://example.test/coach-invite#token=${TOKEN}`);
  assert.equal(new URL(inviteLink('https://example.test', TOKEN)).search, '', 'nothing in the query string');
  assert.equal(inviteTokenFromHash(`#token=${TOKEN.toUpperCase()}`), TOKEN);
  for (const bad of ['', '#', '#token=abc', `#token=${TOKEN}0`, `#token=${'zz'.repeat(32)}`, null]) assert.equal(inviteTokenFromHash(bad), null, String(bad));
  assert.equal(normalizeInviteToken(` ${TOKEN} `), TOKEN);
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  rememberInviteToken(TOKEN, storage, 1000);
  assert.equal(recallInviteToken(storage, 2000), TOKEN);
  assert.equal(recallInviteToken(storage, 1000 + 25 * 3600 * 1000), null, 'a remembered link is forgotten after a day');
  forgetInviteToken(storage);
  assert.equal(recallInviteToken(storage, 2000), null);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.doesNotThrow(() => rememberInviteToken(TOKEN, blocked));
  assert.equal(recallInviteToken(blocked), null);
  for (const code of ['INVITE_INVALID', 'INVITE_EXPIRED', 'INVITE_USED', 'INVITE_REVOKED', 'TOO_MANY_ATTEMPTS', 'ACCOUNT_ALREADY_LINKED']) assert.equal(INVITE_OUTCOMES[code].length, 2, code);
});

test('the client sends the invite parameters the database expects', async () => {
  const calls = [];
  const client = createStaffRosterClient(async (name, params) => { calls.push([name, params]); return { data: { ok: true }, error: null }; });
  await client.createInvite('s1', '');
  await client.createInvite('s1', 'a@example.test');
  await client.revokeInvite('i1');
  await client.listInvites();
  await client.previewInvite(TOKEN);
  await client.acceptInvite(TOKEN);
  assert.deepEqual(calls, [
    ['staff_roster_invite_create', { p_staff_id: 's1', p_email: null }],
    ['staff_roster_invite_create', { p_staff_id: 's1', p_email: 'a@example.test' }],
    ['staff_roster_invite_revoke', { p_invite_id: 'i1' }],
    ['staff_roster_invite_list', {}],
    ['staff_roster_invite_preview', { p_token: TOKEN }],
    ['staff_roster_invite_accept', { p_token: TOKEN }],
  ]);
});

test('existing coach links still open the same screens', async () => {
  assert.equal(nativeTaskFallback('/open/coaching/roster'), '/coaching?tab=roster');
  assert.equal(nativeTaskFallback('/open/coaching'), '/coaching', 'the bare link opens the dashboard (now Home)');
  const page = (await readFile(new URL('../src/pages/Coaching.jsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  for (const tab of ['home', 'roster', 'availability', 'requests', 'inbox']) assert.match(page, new RegExp(`key: '${tab}'`));
  assert.match(page, /: 'home';\n/, 'Home is the default tab');
  assert.match(page, /ROSTER_DISABLED:/, 'the switched-off message is unchanged');
  const app = (await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(app, /path="\/coach-invite"/);
});

const server = await createServer({ configFile: false, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } },
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom' });
after(() => server.close());

test('Home renders what needs the coach, then next classes; done items fold away', async () => {
  const { CoachHomeView, tabHref } = await server.ssrLoadModule('/src/components/coaching/CoachHome.jsx');
  const { MemoryRouter } = await server.ssrLoadModule('react-router-dom');
  const render = props => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(CoachHomeView, props)));
  const upcoming = [{ assignment_id: 'a1', start: '2026-12-02T19:15:00Z', end: '2026-12-02T20:00:00Z', title: 'Synthetic Strength', role: 'lead', colleagues: [{ display_name: 'Other Coach' }] }];
  const html = render({ me: me({ periods: [period('2026-12')], unread_notifications: 1 }), today: '2026-12-01', upcoming, joined: 'Synthetic Coach', counts: { availability: 1, inbox: 1 } });
  assert.match(html, /Welcome to the XERT coach roster, Synthetic Coach/);
  assert.match(html, /To do · 2/);
  assert.match(html, /<details[^>]*><summary[^>]*>Done and up to date \(2\)/);
  assert.match(html, /Availability for December 2026/);
  assert.match(html, /href="\/coaching\?tab=availability&amp;month=2026-12"/);
  assert.match(html, /Synthetic Strength/);
  assert.match(html, /with Other Coach/);
  assert.doesNotMatch(html, /Coach shortcuts/);
  for (const tab of ['roster', 'inbox']) assert.ok(html.includes(`href="${tabHref(tab).replace('&', '&amp;')}"`), tab);
  assert.doesNotMatch(html, /Welcome to the XERT coach roster.*Welcome/);
  const loading = render({ me: me(), today: '2026-12-01', upcoming: null });
  assert.match(loading, /Loading your classes/);
  assert.doesNotMatch(loading, /Welcome/);
  const empty = render({ me: me(), today: '2026-12-01', upcoming: [] });
  assert.match(empty, /No published classes for you in the next two weeks/);
  assert.match(empty, /No month is open for availability right now/);
});

test('dashboard rows: certificates and the website profile join the checklist; hours read as hours', async () => {
  const { hoursLabel } = await import('../src/lib/staffRoster/coachHome.js');
  const rows = coachChecklist(me(), { dashboard: { certificates: { first_aid_current: 0, expired: 0 }, profile: { status: null, on_website: false } } });
  assert.deepEqual(rows.filter(row => ['certificates', 'profile'].includes(row.key)).map(row => [row.key, row.done, row.tab]), [['certificates', false, 'profile'], ['profile', false, 'profile']]);
  const waiting = coachChecklist(me(), { dashboard: { certificates: { first_aid_current: 1, expired: 0 }, profile: { status: 'submitted' } } });
  assert.deepEqual(waiting.filter(row => ['certificates', 'profile'].includes(row.key)).map(row => row.done), [true, null]);
  const expired = coachChecklist(me(), { dashboard: { certificates: { first_aid_current: 1, expired: 1 }, profile: { status: 'approved' } } });
  assert.deepEqual(expired.filter(row => ['certificates', 'profile'].includes(row.key)).map(row => row.done), [false, true]);
  assert.equal(hoursLabel(0), '0 min');
  assert.equal(hoursLabel(45), '45 min');
  assert.equal(hoursLabel(150), '2 h 30 min');
  assert.equal(hoursLabel(120), '2 h');
});

test('class details, profile and certificates screens render what coaches need and nothing private', async () => {
  const { ClassDetailBody, headcountLine } = await server.ssrLoadModule('/src/components/coaching/CoachClassDetail.jsx');
  assert.equal(headcountLine({ booked: 5, capacity: 8, pending: 1, waitlist: 2 }), '5 of 8 booked · 1 request · 2 waiting');
  assert.equal(headcountLine({ booked: 0, capacity: null, pending: 0, waitlist: 0 }), '0 booked');
  const detail = { booked: 2, capacity: 6, pending: 1, waitlist: 0, people: [{ name: 'Ava S.', status: 'confirmed', guest: false }, { name: 'Pat V.', status: 'requested', guest: true }],
    note: { id: 'n1', body: 'Rower warm-up', at: '2026-12-01T00:00:00Z', by: 'Ava' }, note_history: [] };
  const html = renderToStaticMarkup(React.createElement(ClassDetailBody, { detail, draft: 'Rower warm-up', setDraft: () => {}, busy: false, onSave: () => {}, showHistory: false, setShowHistory: () => {} }));
  assert.match(html, /2 of 6 booked · 1 request/);
  assert.match(html, /Pat V\. \(guest\) · Request/);
  assert.match(html, /Last saved by Ava/);
  assert.match(html, /not members/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Save plan/, 'nothing to save until the plan changes');
  const { default: CoachProfile, CERTIFICATE_KINDS } = await server.ssrLoadModule('/src/components/coaching/CoachProfile.jsx');
  assert.deepEqual(CERTIFICATE_KINDS.map(([kind]) => kind), ['first_aid', 'cpr', 'coaching', 'working_with_children', 'other']);
  const profile = renderToStaticMarkup(React.createElement(CoachProfile, { client: {}, uid: 'u', notify: () => {}, files: {} }));
  assert.match(profile, /Loading your profile/);
  assert.match(profile, /Certificates/);
  assert.match(profile, /Only you and the managers can see these/);
});

test('upload paths stay inside the coach’s own folder and files are checked first', async () => {
  const { certificateFilePath, fileProblem, profilePhotoPath } = await import('../src/lib/staffFiles.js');
  const uid = '00000000-0000-4000-8000-0000000000a1';
  assert.match(certificateFilePath(uid, 'My Cert.PDF', 1), new RegExp(`^${uid}/1-[0-9a-f]{8}\\.pdf$`));
  assert.match(certificateFilePath(uid, '../../evil', 1), new RegExp(`^${uid}/1-[0-9a-f]{8}\\.[a-z0-9]+$`));
  assert.match(profilePhotoPath(uid, 'me.jpeg', 1), new RegExp(`^staff-profiles/${uid}/1-[0-9a-f]{8}\\.jpeg$`));
  assert.equal(fileProblem({ type: 'application/pdf', size: 1000 }, 'certificate'), null);
  assert.match(fileProblem({ type: 'application/zip', size: 1000 }, 'certificate'), /PDF or a photo/);
  assert.match(fileProblem({ type: 'image/png', size: 11 * 1024 * 1024 }, 'certificate'), /10 MB/);
  assert.match(fileProblem({ type: 'text/plain', size: 10 }, 'photo'), /image/);
});
