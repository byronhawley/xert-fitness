import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  XERT_TERMS_FORM_DEFINITION,
  XERT_TERMS_FORM_ID,
  validateXertTermsFormDefinition,
} from '../src/lib/xertTermsForm.js';

test('the XERT Terms definition upgrades the existing live record safely', () => {
  assert.equal(XERT_TERMS_FORM_ID, '0173f880-7bee-4a2e-bb0c-ac15af40ad9e');
  assert.equal(XERT_TERMS_FORM_DEFINITION.slug, 'terms-and-conditions');
  assert.equal(XERT_TERMS_FORM_DEFINITION.form_type, 'waiver');
  assert.equal(validateXertTermsFormDefinition(), null);
  assert.ok(XERT_TERMS_FORM_DEFINITION.questions.length <= 100);
});

test('the pre-exercise screen requires explicit Yes or No for every reference question', () => {
  const healthQuestions = XERT_TERMS_FORM_DEFINITION.questions.filter(question => question.type === 'yes_no')
    .filter(question => !/under 18|Friends Train Free|photos or video/i.test(question.question));
  assert.equal(healthQuestions.length, 8);
  assert.ok(healthQuestions.every(question => question.required));
  assert.match(healthQuestions.map(question => question.question).join('\n'), /stroke/i);
  assert.match(healthQuestions.map(question => question.question).join('\n'), /heart condition/i);
  assert.match(healthQuestions.map(question => question.question).join('\n'), /asthma attack/i);
  assert.match(healthQuestions.map(question => question.question).join('\n'), /muscle, bone or joint/i);
});

test('the declaration mirrors the supplied paper structure and uses conditional guardian and referral fields', () => {
  const allText = XERT_TERMS_FORM_DEFINITION.questions
    .map(question => `${question.question}\n${question.content}\n${question.description}`)
    .join('\n');
  assert.match(allText, /Risk warning & participant acknowledgement/i);
  assert.match(allText, /maximum extent permitted by applicable law/i);
  assert.match(allText, /cannot lawfully be excluded/i);
  assert.match(allText, /Parent or guardian signature/i);
  assert.match(allText, /XERT representative signature/i);
  assert.match(allText, /Friends Train Free Saturdays campaign/i);
  assert.match(allText, /consent to XERT using identifiable photos or video/i);

  const minorQuestion = XERT_TERMS_FORM_DEFINITION.questions.find(question => /under 18/i.test(question.question));
  const referralQuestion = XERT_TERMS_FORM_DEFINITION.questions.find(question => /Friends Train Free/i.test(question.question));
  assert.deepEqual(minorQuestion.skip_rules, [{ option: 'No', skip_to: 36 }]);
  assert.deepEqual(referralQuestion.skip_rules, [{ option: 'No', skip_to: 43 }]);
});

test('digital Yes/No and one-option consents show visible checkbox controls while retaining radio semantics', async () => {
  const source = await readFile(new URL('../src/pages/PublicForm.jsx', import.meta.url), 'utf8');
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio"/);
  assert.match(source, /grid h-6 w-6 shrink-0 place-items-center border-2/);
  assert.match(source, /compactConsent/);
  assert.match(source, /aria-checked=\{checked\}/);
});
