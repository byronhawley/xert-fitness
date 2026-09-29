import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { localDateISO, readsAsSigningDate, todayAnswers, todayDateFieldIDs } from '../src/lib/formDateToday.js';
import { buildPublicFormSteps } from '../src/lib/formBranching.js';
import { answerValidationMessage } from '../src/lib/formAnswerValidation.js';
import { CONTRACTOR_DECLINE_OPTION, XERT_CONTRACTOR_FORM_DEFINITION } from '../src/lib/xertContractorForm.js';

// A date signed opens on today's date, and stays theirs to change.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const date = (id, question, extra = {}) => ({ id, type: 'date', question, ...extra });

test('today is the respondent’s own day, not the one in London', () => {
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'Australia/Brisbane';
    // 6:30 on a Brisbane morning is still yesterday in UTC.
    const morning = new Date('2026-09-28T20:30:00Z');
    assert.equal(morning.toISOString().slice(0, 10), '2026-09-28');
    assert.equal(localDateISO(morning), '2026-09-29');
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
  assert.equal(answerValidationMessage({ type: 'date' }, localDateISO()), null, 'held the way a date answer is checked');
});

test('a date that reads as the day of signing opens on today', () => {
  for (const wording of ['Date signed', 'Date Signed *', 'Signature date', 'Date of signing', 'Date of signature', 'Signed on', 'Today’s date', "Today's date", 'Parent or guardian date signed']) {
    assert.ok(readsAsSigningDate(date('d', wording)), wording);
  }
  for (const wording of ['Date of birth', 'Member date of birth', 'Date signed up', 'Start date', 'Date of injury', 'Date']) {
    assert.ok(!readsAsSigningDate(date('d', wording)), wording);
  }
  assert.ok(!readsAsSigningDate({ id: 'd', type: 'short_text', question: 'Date signed' }), 'only a date field');
  assert.ok(!readsAsSigningDate({ id: 'd', type: 'datetime', question: 'Date signed' }), 'a date, not a date and time');
});

test('a plain “Date” is the day of the signature just before it', () => {
  const ids = todayDateFieldIDs([
    { id: 'name', type: 'short_text', question: 'Your name' },
    date('first', 'Date'),
    { id: 'sig', type: 'signature', question: 'Signature' },
    { id: 'note', type: 'statement', content: 'Keep a copy.' },
    date('second', 'Date:'),
  ]);
  assert.deepEqual([...ids], ['second'], 'a “Date” after a name is not a signing date; one after a signature is, past the text between');
});

test('the builder’s switch decides, whichever way the wording reads', () => {
  const ids = todayDateFieldIDs([
    date('on', 'Start date', { default_today: true }),
    date('off', 'Date signed', { default_today: false }),
    date('read', 'Date signed'),
  ]);
  assert.deepEqual([...ids].sort(), ['on', 'read']);
});

test('a run starts with today in each date signed, and nothing hidden is filled', () => {
  const now = new Date(2026, 8, 29, 9, 15);
  const answers = todayAnswers([
    date('signed', 'Date signed'),
    date('hidden', 'Date signed', { hidden: true }),
    date('birthday', 'Date of birth'),
    { id: 'text', type: 'short_text', question: 'Date signed' },
  ], now);
  assert.deepEqual(answers, { signed: '2026-09-29' }, 'a hidden field is never shown, so it is never answered');
});

test('the contractor agreement’s date signed opens on today, and a declined one sends none', () => {
  const questions = XERT_CONTRACTOR_FORM_DEFINITION.questions;
  const signed = questions.find(question => question.id === 'ic-94-commencement');
  assert.equal(signed.default_today, true);
  assert.deepEqual(Object.keys(todayAnswers(questions)), ['ic-94-commencement'], 'the only date on it');
  // Declining jumps past the signing questions. The runner drops every
  // skipped answer before sending, and the database refuses one that was not
  // presented, so the date it started with must be among the skipped.
  const declined = { ...todayAnswers(questions), 'ic-91-accept': CONTRACTOR_DECLINE_OPTION };
  assert.ok(buildPublicFormSteps(questions, declined).skipped.has('ic-94-commencement'));
});

test('the terms and the health questionnaire still ask for a date of birth, blank', async () => {
  const { XERT_TERMS_FORM_DEFINITION } = await import('../src/lib/xertTermsForm.js');
  const { XERT_PEQ_FORM_DEFINITION } = await import('../src/lib/xertPeqForm.js');
  for (const form of [XERT_TERMS_FORM_DEFINITION, XERT_PEQ_FORM_DEFINITION]) {
    assert.deepEqual(todayAnswers(form.questions), {}, form.title);
  }
});

test('the public form, the builder preview and the field preview all start there', async () => {
  const page = await read('../src/pages/PublicForm.jsx');
  const runner = page.slice(page.indexOf('export function FormRunner('), page.indexOf('export default function PublicForm('));
  // What a questionnaire carried over is typed by them, so it wins over today.
  assert.match(runner, /useState\(\(\) => \(\{ \.\.\.todayAnswers\(form\?\.questions\), \.\.\.\(initialAnswers \|\| \{\}\) \}\)\)/);
  assert.match(runner, /Object\.entries\(answers\)\.filter\(\(\[id\]\) => !skipped\.has\(id\)\)/, 'skipped answers, today’s date among them, are never sent');
  assert.match(page, /Dated <time dateTime=\{localDateISO\(\)\}>/, 'the date under a signature is the local day too');
});

test('saving a form from the iPhone keeps the switch', async () => {
  const models = await read('../ios/XertFitnessApp/XertFitnessApp/AdminModels.swift');
  const question = models.slice(models.indexOf('struct AdminFormQuestion'), models.indexOf('static func blank', models.indexOf('struct AdminFormQuestion')));
  assert.ok(question.includes('var default_today: Bool?'));
});
