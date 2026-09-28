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
  const rendered = [...page.matchAll(/\{item\.description && <FormText text=\{item\.description\}/g)];
  assert.equal(rendered.length, 2, 'both layout kinds render their description');
});

test('the builder can edit the supporting text it renders', async () => {
  const manager = await read('../src/components/admin/FormsSurveysManager.jsx');
  // A question has a hint; a heading or statement has supporting text. Both
  // are writing boxes, long enough for a few lines and dot points.
  assert.match(manager, /\{!layout && <WritingBox label="Hint"/);
  assert.match(manager, /\{layout && <WritingBox label="Supporting text"/);
  assert.equal([...manager.matchAll(/onChange=\{value => onUpdate\('description', value\)\}/g)].length, 2);
});
