import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// A section break and a statement both render supporting text under their
// title on the public form. The builder's helper-text row is hidden for layout
// fields, so that paragraph reached every respondent and could be edited
// nowhere — the only way to change it was SQL.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('the public form shows supporting text under a section break and a statement', async () => {
  const page = await read('../src/pages/PublicForm.jsx');
  const rendered = [...page.matchAll(/\{item\.description && <p /g)];
  assert.equal(rendered.length, 2, 'both layout kinds render their description');
});

test('the builder can edit the supporting text it renders', async () => {
  const manager = await read('../src/components/admin/FormsSurveysManager.jsx');
  // The non-layout row: the hint, plus example text where the answer box shows it.
  assert.match(manager, /\{!layout && <div className="forms-grid forms-grid-two">.*Hint<span className="forms-secondary">/);
  // Layout fields get their own control, because a placeholder is meaningless
  // on a heading and the text is long enough to want more than one line.
  assert.match(manager, /\{layout && <label[^>]*>Supporting text<textarea/);
  assert.match(manager, /onUpdate\('description', event\.target\.value\)/);
});
