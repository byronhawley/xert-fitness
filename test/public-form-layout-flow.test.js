import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildPublicFormSteps } from '../src/lib/formBranching.js';

const source = await readFile(new URL('../src/pages/PublicForm.jsx', import.meta.url), 'utf8');
const formText = await readFile(new URL('../src/components/public/FormText.jsx', import.meta.url), 'utf8');

test('public forms display statement and section content in the respondent step flow', () => {
  assert.match(source, /function InformationalBlocks/);
  assert.match(source, /item\.type === 'section_break'/);
  assert.match(source, /<InformationalBlocks items=\{currentStep\.information\}/);
  // Line breaks survive through the shared renderer.
  assert.match(source, /<FormText text=\{title\}/);
  assert.match(formText, /whitespace-pre-wrap/);
});

test('public skip logic uses the complete builder sequence before grouping response steps', () => {
  assert.match(source, /buildPublicFormSteps\(formItems, answers, notApplicable\)/);
  assert.doesNotMatch(source, /computeSkippedQuestionIDs\(questions, answers\)/);
});

test('statement content stays attached to the field the respondent answers', () => {
  const terms = { id: 'terms', type: 'statement', content: 'I agree to the gym terms.' };
  const consent = { id: 'consent', type: 'yes_no', question: 'Do you agree?' };
  const { steps, skipped } = buildPublicFormSteps([terms, consent], {});

  assert.deepEqual([...skipped], []);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].information[0], terms);
  assert.equal(steps[0].question, consent);
});

test('branched-away statements are not represented as wording the respondent saw', () => {
  const questions = [
    { id: 'member', type: 'yes_no', skip_rules: [{ option: 'No', skip_to: 5 }] },
    { id: 'waiver-heading', type: 'section_break', content: 'Member waiver' },
    { id: 'waiver-terms', type: 'statement', content: 'Member-only terms' },
    { id: 'consent', type: 'yes_no', question: 'Accept the waiver?' },
  ];
  const { steps, skipped } = buildPublicFormSteps(questions, { member: 'No' });

  assert.deepEqual([...skipped], ['waiver-heading', 'waiver-terms', 'consent']);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].question.id, 'member');
  assert.deepEqual(steps[0].information, []);
});

test('a trailing informational statement gets an explicit final review step', () => {
  const { steps } = buildPublicFormSteps([
    { id: 'name', type: 'short_text', question: 'Name' },
    { id: 'notice', type: 'statement', content: 'Your response will now be submitted.' },
  ], {});

  assert.equal(steps.length, 2);
  assert.equal(steps[1].question, null);
  assert.equal(steps[1].information[0].id, 'notice');
});

test('a stale answer on an already skipped choice cannot cascade into later fields', () => {
  const questions = [
    { id: 'route', type: 'yes_no', skip_rules: [{ option: 'Skip', skip_to: 4 }] },
    { id: 'skipped-choice', type: 'yes_no', skip_rules: [{ option: 'Old answer', skip_to: 5 }] },
    { id: 'skipped-note', type: 'statement', content: 'Not presented' },
    { id: 'consent', type: 'yes_no', question: 'Current consent' },
  ];
  const { steps, skipped } = buildPublicFormSteps(questions, {
    route: 'Skip',
    'skipped-choice': 'Old answer',
  });

  assert.deepEqual([...skipped], ['skipped-choice', 'skipped-note']);
  assert.deepEqual(steps.map(step => step.question?.id), ['route', 'consent']);
});
