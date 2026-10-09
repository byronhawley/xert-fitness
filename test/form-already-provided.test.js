import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ALREADY_PROVIDED_ANSWER, ALREADY_PROVIDED_TYPES, canOfferAlreadyProvided,
  isAlreadyProvided, offersAlreadyProvided,
} from '../src/lib/formAlreadyProvided.js';
import { answerValidationMessage } from '../src/lib/formAnswerValidation.js';
import { XERT_CONTRACTOR_FORM_DEFINITION } from '../src/lib/xertContractorForm.js';

const read = async name => (await readFile(new URL(name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const email = { id: 'e', type: 'email', question: 'Email', allow_already_provided: true };

test('the tick is only offered on fields whose answer is one piece of text', () => {
  for (const type of ['email', 'phone', 'short_text', 'long_text', 'url', 'date']) {
    assert.ok(canOfferAlreadyProvided({ type }), type);
  }
  // A name or address has parts, a number is a number, a choice is a tick
  // already, and a signature has to be signed.
  for (const type of ['name_fields', 'address', 'number', 'single_choice', 'signature', 'file_upload']) {
    assert.equal(canOfferAlreadyProvided({ type }), false, type);
  }
});

test('the option is off unless a field switches it on', () => {
  assert.equal(offersAlreadyProvided({ type: 'email' }), false);
  assert.equal(offersAlreadyProvided({ type: 'email', allow_already_provided: 'yes' }), false,
    'only a real boolean true turns it on, matching the database');
  assert.equal(offersAlreadyProvided(email), true);
});

test('the tick passes validation only where it is offered', () => {
  assert.equal(answerValidationMessage(email, ALREADY_PROVIDED_ANSWER), null);
  // Without the option the same words are just a malformed email.
  assert.match(answerValidationMessage({ ...email, allow_already_provided: false }, ALREADY_PROVIDED_ANSWER),
    /complete email address/);
  // The option exempts the tick, not anything else typed into the field.
  assert.match(answerValidationMessage(email, 'not an email'), /complete email address/);
  assert.equal(isAlreadyProvided(email, 'already provided'), false, 'the exact answer, nothing looser');
});

test('client and database agree on which field types can carry it', async () => {
  const sql = await read('../supabase/migrations/20260926010000_form_field_already_provided.sql');
  const listed = sql.match(/p_question ->> 'type' in \(([^)]+)\)/)[1]
    .split(',').map(item => item.trim().replace(/'/g, ''));
  assert.deepEqual(new Set(listed), ALREADY_PROVIDED_TYPES);
  assert.ok(sql.includes(`to_jsonb('${ALREADY_PROVIDED_ANSWER}'::text)`),
    'the database must accept exactly the answer the form sends');
  // The exemption is narrow: it steps aside for the email format check only.
  assert.match(sql, /and not public\.xert_form_answer_is_already_provided\(v_question, v_answer\) and \(/);
  assert.match(sql, /allow_already_provided' and jsonb_typeof\(v_question -> 'allow_already_provided'\) is distinct from 'boolean'/);
});

test('any form can switch it on from the builder, not only by code', async () => {
  const manager = await read('../src/components/admin/FormsSurveysManager.jsx');
  assert.match(manager, /canOfferAlreadyProvided\(field\) && <Toggle checked=\{field\.allow_already_provided === true\} onChange=\{value => onUpdate\('allow_already_provided', value\)\}/);
  const forms = await read('../src/lib/xertForms.js');
  assert.match(forms, /allow_already_provided: false/, 'new fields start with it off');
});

test('the public form shows the tick and hides the input while ticked', async () => {
  const page = await read('../src/pages/PublicForm.jsx');
  assert.match(page, /if \(!offersAlreadyProvided\(question\)\) return <FieldAnswerInput/);
  assert.match(page, /onChange\(event\.target\.checked \? ALREADY_PROVIDED_ANSWER : ''\)/);
  assert.match(page, /Already provided\n/);
});

test('the contractor agreement offers it on email and phone', () => {
  const byId = id => XERT_CONTRACTOR_FORM_DEFINITION.questions.find(question => question.id === id);
  assert.equal(offersAlreadyProvided(byId('ic-05-phone')), true);
  assert.equal(offersAlreadyProvided(byId('ic-06-email')), true);
  assert.equal(offersAlreadyProvided(byId('ic-03-abn')), false, 'the ABN is not given anywhere else');
});
