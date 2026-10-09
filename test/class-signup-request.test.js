import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// From 25 September every class sign-up from the website was turned away as
// "not found" (PGRST202): the API's list of the database's functions still had
// the sign-up from before the bring-a-friend answer, and the website sent that
// answer every time. These pin what the website sends, what it shows when a
// sign-up fails, and that a signed-in member is not asked for their details.

const calls = [];
let reply = { data: { status: 'confirmed', took_spot: true }, error: null };
let auth = { user: null, profile: null };

const server = await createServer({
  configFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  plugins: [{
    name: 'signup-boundary',
    enforce: 'pre',
    resolveId(source) {
      // By alias from components, or next door from inside src/lib.
      if (/(^\.\/|\/src\/lib\/)supabase(\.js)?$/.test(source)) return '\0signup-supabase';
      if (/SupabaseAuthContext(?:\.jsx)?$/.test(source)) return '\0signup-auth';
      return null;
    },
    load(id) {
      if (id === '\0signup-supabase') return 'export const supabase = { rpc: (...args) => globalThis.__signupRpc(...args) };';
      if (id === '\0signup-auth') return 'export const useSupabaseAuth = () => globalThis.__signupAuth();';
      return null;
    },
  }],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null },
  appType: 'custom',
});
after(() => server.close());
globalThis.__signupRpc = async (fn, args) => { calls.push({ fn, args }); return reply; };
globalThis.__signupAuth = () => auth;

const { submitClassSignup } = await server.ssrLoadModule('/src/lib/submitForms.js');
const { friendlySignupError, signupErrorDetail } = await server.ssrLoadModule('/src/lib/classSignup.js');
const { default: BookingRequestForm } = await server.ssrLoadModule('/src/components/public/BookingRequestForm.jsx');

const details = {
  class_session_id: '11111111-1111-4111-8111-111111111111', full_name: 'Dene O’Farrell', email: 'dene@example.com',
  phone: '+61401000000', consent_to_contact: true, training_level: 'New / beginner', notes: '', join_waitlist: false,
};
// The eight names the API still knew, from its own "Perhaps you meant" hint.
const KNOWN_TO_THE_API = ['p_consent', 'p_email', 'p_full_name', 'p_join_waitlist', 'p_notes', 'p_phone', 'p_session_id', 'p_training_level'];

test('an ordinary sign-up sends only what the API has always known', async () => {
  calls.length = 0;
  const result = await submitClassSignup({ ...details, guest_visit: false });
  assert.equal(result.took_spot, true);
  assert.equal(calls[0].fn, 'submit_class_signup');
  assert.deepEqual(Object.keys(calls[0].args).sort(), KNOWN_TO_THE_API);
});

test('a bring-a-friend guest still says so', async () => {
  calls.length = 0;
  await submitClassSignup({ ...details, guest_visit: true });
  assert.equal(calls[0].args.p_guest_visit, true);
  assert.deepEqual(Object.keys(calls[0].args).filter(key => key !== 'p_guest_visit').sort(), KNOWN_TO_THE_API);
});

test('a failure the form has no words for shows its reason in small print', async () => {
  reply = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.submit_class_signup(p_consent, p_email, p_full_name, p_guest_visit, p_join_waitlist, p_notes, p_phone, p_session_id, p_training_level) in the schema cache' } };
  let failure = null;
  try { await submitClassSignup({ ...details }); } catch (error) { failure = error; }
  reply = { data: { status: 'confirmed', took_spot: true }, error: null };
  assert.ok(failure, 'the failure reaches the form');
  assert.equal(failure.code, 'PGRST202', 'with the database’s own code');
  assert.equal(friendlySignupError(failure), 'Sign-up failed. Please try again.');
  const detail = signupErrorDetail(failure);
  assert.match(detail, /^PGRST202: Could not find the function public\.submit_class_signup/);
  assert.ok(detail.length <= 180, 'short enough for small print');
  // A failure with its own message needs no small print.
  assert.equal(signupErrorDetail(new Error('CLASS_FULL')), null);
  assert.equal(signupErrorDetail(new Error('')), null);
});

const form = props => renderToStaticMarkup(React.createElement(BookingRequestForm, {
  session: { id: details.class_session_id, title: '6:15am training session', start_time: '2026-10-01T20:15:00Z' },
  takesSpot: true, submitLabel: 'Sign up', ...props,
}));

test('a signed-in member checks their details instead of typing them again', () => {
  auth = { user: { id: 'u', email: 'deneop24@gmail.com' }, profile: { full_name: 'Dene O’Farrell', phone: '+61401359153' } };
  const html = form();
  auth = { user: null, profile: null };
  assert.match(html, /Booking as<\/p>/);
  assert.match(html, /Dene O’Farrell/);
  assert.match(html, /deneop24@gmail\.com · \+61401359153/);
  assert.match(html, />Change<\/button>/);
  assert.ok(!html.includes('id="booking-full-name"'), 'no boxes to fill');
});

test('a member missing a phone on their account is asked only for that', () => {
  auth = { user: { id: 'u', email: 'deneop24@gmail.com' }, profile: { full_name: 'Dene O’Farrell', phone: '' } };
  const html = form();
  auth = { user: null, profile: null };
  assert.match(html, /id="booking-full-name"[^>]*value="Dene O’Farrell"/);
  assert.match(html, /id="booking-email"[^>]*value="deneop24@gmail\.com"/);
  assert.match(html, /id="booking-phone"[^>]*value=""/);
});

test('a visitor who is not signed in fills the form in as before', () => {
  const html = form();
  assert.ok(!html.includes('Booking as'));
  assert.match(html, /id="booking-full-name"[^>]*value=""/);
  assert.match(html, /id="booking-phone"[^>]*value=""/);
});
