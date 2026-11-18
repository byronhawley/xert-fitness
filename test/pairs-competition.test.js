import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PAIRS_CATEGORIES, PAIRS_FORM_SLUG, PAIRS_QUESTION_IDS, pairsEntriesOpen, pairsEntryAnswers,
  pairsEntryErrors, pairsFormDefinition, pairsFormMatches, pairsSubmitErrorMessage,
} from '../src/lib/pairsCompetition.js';

const goodEntry = { teamName: '  Sweat  Squad ', teammateOne: 'Sam Lee', teammateTwo: 'Jo Park', category: 'Intermediate' };

test('the form definition passes the rules the database applies to every form', () => {
  const form = pairsFormDefinition();
  assert.equal(form.slug, PAIRS_FORM_SLUG);
  assert.match(form.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(form.form_type, 'registration');
  // one entry per account email needs the email to be required
  assert.equal(form.one_response_per_email, true);
  assert.equal(form.collect_email_required, true);
  assert.equal(form.collect_name_required, true);
  const ids = form.questions.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, Object.values(PAIRS_QUESTION_IDS));
  for (const q of form.questions) {
    assert.ok(['short_text', 'single_choice'].includes(q.type));
    assert.equal(q.required, true);
    assert.equal(q.hidden, false);
  }
  const category = form.questions.find(q => q.id === PAIRS_QUESTION_IDS.category);
  assert.deepEqual(category.options, ['Everyday', 'Intermediate', 'Advanced']);
  assert.equal(category.allow_other, false);
  assert.ok(pairsFormMatches(form));
});

test('the form definition only uses columns the form builder saves', () => {
  const source = readFileSync(new URL('../src/lib/xertForms.js', import.meta.url), 'utf8');
  const allowed = source.match(/const allowed = \[([\s\S]*?)\];/)[1].match(/'([a-z_]+)'/g).map(v => v.slice(1, -1));
  assert.deepEqual(Object.keys(pairsFormDefinition()).sort(), [...allowed].sort());
});

test('a complete entry has no errors and answers every question with tidy text', () => {
  assert.deepEqual(pairsEntryErrors(goodEntry), {});
  assert.deepEqual(pairsEntryAnswers(goodEntry), {
    [PAIRS_QUESTION_IDS.teamName]: 'Sweat Squad',
    [PAIRS_QUESTION_IDS.teammateOne]: 'Sam Lee',
    [PAIRS_QUESTION_IDS.teammateTwo]: 'Jo Park',
    [PAIRS_QUESTION_IDS.category]: 'Intermediate',
  });
});

test('missing, oversized or duplicate details are refused before sending', () => {
  const errors = pairsEntryErrors({ teamName: ' ', teammateOne: '', teammateTwo: '', category: 'Elite' });
  assert.deepEqual(Object.keys(errors).sort(), ['category', 'teamName', 'teammateOne', 'teammateTwo']);
  assert.ok(pairsEntryErrors({ ...goodEntry, teamName: 'x'.repeat(61) }).teamName);
  assert.ok(pairsEntryErrors({ ...goodEntry, teammateTwo: ' sam  lee ' }).teammateTwo);
  for (const category of PAIRS_CATEGORIES) assert.deepEqual(pairsEntryErrors({ ...goodEntry, category }), {});
});

test('the page refuses to post into a form whose questions were changed', () => {
  const form = pairsFormDefinition();
  assert.equal(pairsFormMatches(null), false);
  assert.equal(pairsFormMatches({ ...form, questions: form.questions.slice(0, 3) }), false);
  const renamedOption = form.questions.map(q => (q.id === PAIRS_QUESTION_IDS.category ? { ...q, options: ['Everyday', 'Intermediate', 'Pro'] } : q));
  assert.equal(pairsFormMatches({ ...form, questions: renamedOption }), false);
});

test('entries close at the end of competition day in Brisbane', () => {
  assert.equal(pairsEntriesOpen(new Date('2026-11-18T12:00:00Z')), true);
  assert.equal(pairsEntriesOpen(new Date('2026-11-19T23:59:00+10:00')), true);
  assert.equal(pairsEntriesOpen(new Date('2026-11-20T00:00:00+10:00')), false);
});

test('database refusals are worded for the entrant', () => {
  assert.equal(pairsSubmitErrorMessage({ code: '23505', message: 'A response has already been submitted for this email.' }), 'ALREADY_ENTERED');
  assert.match(pairsSubmitErrorMessage({ code: 'P0002', message: 'This form is not available.' }), /closed/);
  assert.match(pairsSubmitErrorMessage({ code: '40001' }), /Refresh/);
  assert.match(pairsSubmitErrorMessage({}), /did not send/);
});

test('the site routes /pairs and sends the bare form link through the sign-in page', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<Route path="\/pairs" element={<PairsSignup \/>} \/>/);
  const redirect = app.indexOf(`path="/forms/${PAIRS_FORM_SLUG}"`);
  assert.ok(redirect > 0 && redirect < app.indexOf('path="/forms/:slug"'));
});
