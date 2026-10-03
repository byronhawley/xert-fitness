// Roster texts on the screens: the Settings switch, the publish dialog's
// "Texts: …" line and resend button, the Coaches tab "No mobile" badge, the
// coach's "Text messages" choice, and the browser client calls.
// SYNTHETIC DATA ONLY; nothing is sent.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import { createStaffRosterClient, requestRosterTexts } from '../src/lib/staffRosterData.js';

const server = await createServer({ configFile: false, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' });
after(() => server.close());

const settingsPanel = async settings => {
  const { default: SettingsPanel } = await server.ssrLoadModule('/src/components/admin/staffRoster/SettingsPanel.jsx');
  return renderToStaticMarkup(React.createElement(SettingsPanel, {
    data: { busy: false, snapshot: { settings: { version: 1, class_time_presets: [], enabled: true, ...settings }, class_type_staffing: [], sessions: [], series: [] } },
    month: '2026-12', today: '2026-10-01', onMutate: () => {}, onSaveStaffing: () => {},
  }));
};

test('Settings: a plain "Text coaches when you publish" switch that mentions the SMS credit', async () => {
  const off = await settingsPanel({ sms_enabled: false });
  assert.match(off, /<button[^>]*>Text coaches when you publish<\/button>/);
  assert.match(off, /Off — no texts are sent/);
  assert.match(off, /gym’s SMS credit/);
  const on = await settingsPanel({ sms_enabled: true });
  assert.match(on, /On — coaches get a text when you publish/);
  assert.match(on, /<button[^>]*>Stop texting coaches<\/button>/);
  const before = await settingsPanel({});
  assert.doesNotMatch(before, /Text messages/, 'hidden until the database has the switch');
});

test('Publish dialog: "Texts: 4 sent, 1 no mobile number (Cam)" and a resend button when any can be resent', async () => {
  const { RosterTextsSummary } = await server.ssrLoadModule('/src/components/admin/staffRoster/RosterTexts.jsx');
  const status = {
    enabled: true, retryable: 1, counts: { sent: 4, pending: 0, failed: 0, skipped: 1 },
    messages: ['Ava', 'Ben', 'Dee', 'Eve'].map(name => ({ name, status: 'sent' })).concat({ name: 'Cam', status: 'skipped', reason: 'NO_MOBILE' }),
  };
  const html = renderToStaticMarkup(React.createElement(RosterTextsSummary, { status, onRetry: () => {} }));
  assert.match(html, /Texts: 4 sent, 1 no mobile number \(Cam\)/);
  assert.match(html, /<button[^>]*>Resend failed texts<\/button>/);
  assert.match(html, /Account details/);

  const clean = renderToStaticMarkup(React.createElement(RosterTextsSummary, { status: { ...status, retryable: 0, messages: status.messages.slice(0, 4) }, onRetry: () => {} }));
  assert.match(clean, /Texts: 4 sent/);
  assert.doesNotMatch(clean, /Resend failed texts/);

  const off = renderToStaticMarkup(React.createElement(RosterTextsSummary, { status: { enabled: false } }));
  assert.match(off, /Texts are off/);
  const unconfigured = renderToStaticMarkup(React.createElement(RosterTextsSummary, {
    status: { ...status, counts: { pending: 1 }, messages: [{ name: 'Ava', status: 'pending' }] }, result: { configured: false },
  }));
  assert.match(unconfigured, /SMS is not set up on the server/);
  // Published while coach screens were off: nothing was queued, and it says why
  // (not "nobody's classes changed").
  const screensOff = renderToStaticMarkup(React.createElement(RosterTextsSummary, { status: { enabled: true, roster_enabled: false, counts: {}, messages: [], retryable: 0 } }));
  assert.match(screensOff, /only go while coach screens are switched on/);
  assert.doesNotMatch(screensOff, /Nobody’s classes changed/);
});

test('Publish dialog after publishing: the notice count, then the texts', async () => {
  const { PublishedView } = await server.ssrLoadModule('/src/components/admin/staffRoster/PublishDialog.jsx');
  const html = renderToStaticMarkup(React.createElement(PublishedView, { result: { ok: true, number: 2, affected_staff: ['a', 'b'] }, month: '2026-12', client: null }));
  assert.match(html, /December 2026 roster is published/);
  assert.match(html, /2 coaches have a notice in their coach inbox/);
});

test('Coaches tab: "No mobile" only for active, signed-in coaches without a valid Australian mobile', async () => {
  const { mobileBadge } = await server.ssrLoadModule('/src/components/admin/staffRoster/CoachesPanel.jsx');
  const coach = { status: 'active', profile_id: 'p' };
  assert.equal(mobileBadge(coach, 'ok'), null);
  assert.equal(mobileBadge(coach, 'missing').label, 'No mobile');
  assert.equal(mobileBadge(coach, 'invalid').label, 'No mobile');
  assert.match(mobileBadge(coach, 'invalid').detail, /Australian mobile/);
  assert.equal(mobileBadge({ ...coach, profile_id: null }, 'no_account'), null, '"Needs to sign in" already says it');
  assert.equal(mobileBadge({ ...coach, status: 'inactive' }, 'missing'), null);
  assert.equal(mobileBadge(coach, undefined), null, 'no badge before the numbers load');
});

test('Coach profile: "Text messages" on or off, with what is missing in plain words', async () => {
  const { NoticeChoices, smsPreferenceHint } = await server.ssrLoadModule('/src/components/coaching/CoachProfile.jsx');
  const prefs = { email: true, push: true, sms: true, email_available: false, sms_available: true, mobile_state: 'ok', mobile_ending: '001' };
  const html = renderToStaticMarkup(React.createElement(NoticeChoices, { prefs, onChange: () => {} }));
  assert.match(html, /Text messages to your mobile ending 001/);
  assert.match(html, /A text listing your classes when a roster is published/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(NoticeChoices, { prefs: { email: true, push: true }, onChange: () => {} })), /Text messages/,
    'hidden until the database has texts');
  assert.match(smsPreferenceHint({ ...prefs, mobile_state: 'missing' }), /Add your mobile number in Account details/);
  assert.match(smsPreferenceHint({ ...prefs, mobile_state: 'invalid' }), /isn’t an Australian mobile/);
  assert.match(smsPreferenceHint({ ...prefs, sms_available: false }), /hasn’t switched roster texts on yet/);
});

test('the browser client calls the texting entry points and the server action', async () => {
  const calls = [];
  const client = createStaffRosterClient(async (name, params) => { calls.push([name, params]); return { data: { ok: true }, error: null }; },
    { sendTexts: async () => ({ requested: true, ok: true, sent: 1 }) });
  await client.smsStatus('2026-12');
  await client.smsStatus(null);
  await client.setSmsEnabled(true, 4);
  await client.retryTexts('2026-12');
  await client.setSmsPreference(false);
  assert.deepEqual(calls, [
    ['staff_roster_sms_status', { p_month: '2026-12-01' }],
    ['staff_roster_sms_status', { p_month: null }],
    ['staff_roster_sms_set_enabled', { p_enabled: true, p_expected_version: 4 }],
    ['staff_roster_sms_retry', { p_month: '2026-12-01' }],
    ['staff_roster_set_sms_preference', { p_sms: false }],
  ]);
  assert.deepEqual(await client.sendTexts(), { requested: true, ok: true, sent: 1 });
  assert.deepEqual(await createStaffRosterClient(async () => ({ data: null, error: null })).sendTexts(), { requested: false });

  const requests = [];
  const fetcher = async (url, init) => { requests.push([url, init]); return new Response(JSON.stringify({ configured: true, sent: 2 }), { status: 200 }); };
  const session = async () => ({ data: { session: { access_token: 'synthetic' } } });
  assert.deepEqual(await requestRosterTexts(session, fetcher), { requested: true, ok: true, configured: true, sent: 2 });
  assert.equal(requests[0][0], '/api/admin-publish-announcement');
  assert.deepEqual(JSON.parse(requests[0][1].body), { action: 'send_roster_sms' });
  assert.equal(requests[0][1].headers.Authorization, 'Bearer synthetic');
  const refused = await requestRosterTexts(session, async () => new Response(JSON.stringify({ error: 'Admin access required.' }), { status: 403 }));
  assert.deepEqual(refused, { requested: true, ok: false, error: 'Admin access required.' });
  assert.equal((await requestRosterTexts(async () => ({ data: {} }), fetcher)).requested, false, 'no session, no request');
  assert.equal((await requestRosterTexts(session, async () => { throw new Error('offline'); })).requested, false, 'never throws');
});

test('no new serverless function: texts ride the existing admin communications endpoint', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../api/', import.meta.url))).filter(name => name.endsWith('.js'));
  assert.equal(files.length, 12, 'Vercel Hobby allows 12 functions');
});
