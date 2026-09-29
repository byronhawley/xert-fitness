import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FORM_SIGNATORIES, formSignatory, signOffProblem } from '../src/lib/formSignatories.js';
import { buildPublicFormSteps } from '../src/lib/formBranching.js';
import { validateXertFormDefinition } from '../src/lib/xertFormFields.js';
import { XERT_CONTRACTOR_FORM_DEFINITION } from '../src/lib/xertContractorForm.js';
import { renderContractorPdf } from '../src/lib/contractorPdf.js';

// Byron Hawley signs every copy of the contractor agreement, and any form can
// carry his sign-off. The SQL side is in form-signatories-sql.test.js.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const signOff = { id: 'owner', type: 'signature', question: 'Signed for XERT Fitness', signed_by: 'byron-hawley', required: false };

test('a sign-off names somebody who can sign in advance, and only on a signature', () => {
  assert.equal(formSignatory(signOff).name, 'Byron Hawley');
  assert.equal(formSignatory({ ...signOff, type: 'short_text' }), null);
  assert.equal(formSignatory({ ...signOff, signed_by: '' }), null, 'no sign-off is the person filling it in');
  assert.equal(signOffProblem(signOff), null);
  assert.match(signOffProblem({ ...signOff, signed_by: 'nobody' }), /cannot sign in advance/);
  assert.match(signOffProblem({ ...signOff, type: 'short_text' }), /Only a signature field/);
  assert.match(signOffProblem({ ...signOff, required: true }), /cannot also be required/);
  assert.equal(FORM_SIGNATORIES['byron-hawley'].image, '/assets/signatures/byron-hawley.png');
});

test('the person filling the form in reads a sign-off; they are never asked for it', () => {
  const questions = [
    { id: 'name', type: 'short_text', question: 'Your name' },
    { id: 'theirs', type: 'signature', question: 'Your signature' },
    signOff,
  ];
  const { steps } = buildPublicFormSteps(questions, {});
  assert.deepEqual(steps.map(step => step.question?.id ?? null), ['name', 'theirs', null]);
  assert.equal(steps[2].information[0].id, 'owner', 'shown on the last step, before they submit');
});

test('the contractor agreement is signed in advance by Byron, and still a valid form', () => {
  const owner = XERT_CONTRACTOR_FORM_DEFINITION.questions.find(question => question.id === 'ic-98-owner-signature');
  assert.equal(owner.signed_by, 'byron-hawley');
  assert.equal(owner.required, false);
  assert.equal(validateXertFormDefinition(XERT_CONTRACTOR_FORM_DEFINITION), null);
  assert.match(validateXertFormDefinition({ questions: [{ ...owner, signed_by: 'nobody' }] }), /cannot sign in advance/);
});

test('the builder will not save a sign-off it cannot honour', async () => {
  const forms = await read('../src/lib/xertForms.js');
  assert.match(forms, /const signOff = questions\.map\(signOffProblem\)\.find\(Boolean\);/);
});

test('every PDF copy of the agreement carries Byron’s signature, blank or signed', async () => {
  const png = await readFile(new URL('../public/assets/signatures/byron-hawley.png', import.meta.url));
  // Byron's signature is the agreement's only transparent picture: a PNG with
  // an alpha channel is embedded with a soft mask, and nothing else has one.
  const count = async bytes => (Buffer.from(bytes).toString('latin1').match(/\/SMask\s+\d+\s+0\s+R/g) || []).length;
  assert.equal(await count(await renderContractorPdf({ mode: 'interactive' })), 0, 'no signature without one given');
  assert.equal(await count(await renderContractorPdf({ mode: 'interactive', presigned: { 'ic-98-owner-signature': png } })), 1, 'the fillable copy');
  assert.equal(await count(await renderContractorPdf({ mode: 'signed', presigned: { 'ic-98-owner-signature': png } })), 1, 'a signed copy of an older response');
  const script = await read('../scripts/build-contractor-pdf.mjs');
  assert.equal([...script.matchAll(/presigned: PRESIGNED/g)].length, 3, 'blank, demo and signed copies all pass it');
});

test('saving a form from the iPhone keeps the sign-off and the other web-only settings', async () => {
  const models = await read('../ios/XertFitnessApp/XertFitnessApp/AdminModels.swift');
  const question = models.slice(models.indexOf('struct AdminFormQuestion'), models.indexOf('static func blank', models.indexOf('struct AdminFormQuestion')));
  for (const key of ['signed_by: String?', 'allow_already_provided: Bool?', 'prefill: String?', 'minor_only: Bool?']) {
    assert.ok(question.includes(`var ${key}`), key);
  }
});
