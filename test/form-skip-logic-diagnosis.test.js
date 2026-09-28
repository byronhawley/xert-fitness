import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { skipRuleProblems } from '../src/lib/formBranching.js';

// The builder's destination menu only ever offers valid jumps, so a broken skip
// rule is never typed by hand — it is left behind when fields are reordered,
// deleted, or changed to a type with no options. The old message named neither
// the field nor the reason, so the owner had to open every field to find it.

const field = (n, skip_rules = []) => ({ id: `q${n}`, question: `Question ${n}`, type: 'single_choice', options: ['Yes', 'No'], skip_rules });

test('a rule stranded past the end of the form says so, and where it ends', () => {
  // Q1 jumped to Q9 before six fields were deleted.
  const questions = [field(1, [{ option: 'Yes', skip_to: 9 }]), field(2), field(3)];
  const [problem, ...rest] = skipRuleProblems(questions);
  assert.equal(rest.length, 0);
  assert.equal(problem.reason, 'past-end');
  assert.equal(problem.position, 1);
  assert.equal(problem.option, 'Yes');
  assert.match(problem.message, /^Q1 “Question 1” skips to Q9 for “Yes”, but the form ends at Q3\.$/);
  assert.match(problem.fix, /reordered or deleted/);
});

test('a rule pointing at itself or backwards is called a loop, not an invalid number', () => {
  const questions = [field(1), field(2), field(3, [{ option: 'No', skip_to: 2 }])];
  const [problem] = skipRuleProblems(questions);
  assert.equal(problem.reason, 'backwards');
  assert.match(problem.message, /Q3 “Question 3” skips back to Q2 for “No”\./);
  assert.match(problem.fix, /only jump forward/);
  // Jumping to itself is the same failure, not a separate mystery.
  assert.equal(skipRuleProblems([field(1), field(2, [{ option: 'No', skip_to: 2 }])])[0].reason, 'backwards');
});

test('a jump to the very next field is distinguished from a jump that is out of range', () => {
  const questions = [field(1, [{ option: 'Yes', skip_to: 2 }]), field(2), field(3)];
  const [problem] = skipRuleProblems(questions);
  assert.equal(problem.reason, 'next-field');
  assert.match(problem.message, /already the next field/);
  assert.match(problem.fix, /jump over at least one field/);
});

test('a rule with no destination is not reported as a bad jump', () => {
  for (const skip_to of [undefined, null, '', 'end', Number.NaN, 2.5]) {
    const [problem] = skipRuleProblems([field(1, [{ option: 'Yes', skip_to }]), field(2), field(3)]);
    assert.equal(problem.reason, 'no-destination', `skip_to ${String(skip_to)}`);
    assert.match(problem.message, /has a skip rule for “Yes” with no destination\./);
  }
});

test('valid forward jumps and the end-of-form destination are left alone', () => {
  const questions = [field(1, [{ option: 'Yes', skip_to: 3 }, { option: 'No', skip_to: 4 }]), field(2), field(3)];
  // 3 is a real later field; 4 is questions.length + 1, which is "End form".
  assert.deepEqual(skipRuleProblems(questions), []);
  assert.deepEqual(skipRuleProblems([]), []);
  assert.deepEqual(skipRuleProblems([{ id: 'a', question: 'A' }]), []);
});

test('an untitled field still gets a position, and every broken rule is reported', () => {
  const questions = [
    { id: 'a', type: 'single_choice', options: ['Yes'], skip_rules: [{ option: 'Yes', skip_to: 99 }] },
    field(2, [{ option: 'Yes', skip_to: 1 }, { option: 'No', skip_to: 3 }]),
    field(3),
  ];
  const problems = skipRuleProblems(questions);
  assert.equal(problems.length, 3);
  assert.match(problems[0].message, /^Q1 “Untitled field”/);
  assert.deepEqual(problems.map(problem => problem.reason), ['past-end', 'backwards', 'next-field']);
});

test('the save error names the field and the reason, and counts the rest', async () => {
  const source = await readFile(new URL('../src/lib/xertForms.js', import.meta.url), 'utf8');
  // xertForms imports the Supabase client, so this is read rather than imported.
  assert.match(source, /const \[problem, \.\.\.rest\] = skipRuleProblems\(questions\);/);
  assert.match(source, /return `Skip logic: \$\{problem\.message\} \$\{problem\.fix\}\$\{more\}`;/);
  assert.doesNotMatch(source, /Skip logic can only jump forward to a later field or the end of the form\./);
});

test('a field that lost its options still offers a way to clear the rules that block saving', async () => {
  const source = await readFile(new URL('../src/components/admin/FormsSurveysManager.jsx', import.meta.url), 'utf8');
  // The Skip logic section renders only for a choice type that still has
  // options, so changing the type stranded the rules with no control to remove
  // them — an unsavable form with nothing on screen to explain it.
  assert.match(source, /hasInvalidSkipRules && !\(CHOICE_TYPES\.has\(field\.type\) && choices\.length > 0\)/);
  assert.match(source, /Skip logic left over/);
  // And a broken rule on a collapsed field is findable from the header.
  assert.match(source, /\{hasInvalidSkipRules && <span[^>]*>.*Skip logic<\/span>\}/);
});
