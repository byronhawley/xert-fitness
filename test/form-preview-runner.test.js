import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The builder's Preview is only worth trusting if it is the real form. Both
// run one component; only what happens on submit differs.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('the public page and the builder preview run the same form', async () => {
  const [page, manager] = await Promise.all([read('../src/pages/PublicForm.jsx'), read('../src/components/admin/FormsSurveysManager.jsx')]);
  assert.match(page, /export function FormRunner\(/);
  assert.match(page, /<FormRunner key=\{slug\} form=\{form\} carried=\{carried\} initialAnswers=\{seededAnswers\} onSubmit=\{submit\} \/>/);
  assert.match(manager, /<FormRunner key=\{run\} form=\{draft\} preview onSubmit=\{async \(\) => setFinished\(true\)\} \/>/);
});

test('only the public page sends anything', async () => {
  const page = await read('../src/pages/PublicForm.jsx');
  const runner = page.slice(page.indexOf('export function FormRunner('), page.indexOf('export default function PublicForm('));
  assert.doesNotMatch(runner, /submitPublicForm|writeFormCompletion|navigate\(/, 'the runner hands answers over; it never sends them itself');
  assert.match(runner, /await onSubmit\(\{ answers: kept, name, email, phone, elapsedSeconds/);
});
