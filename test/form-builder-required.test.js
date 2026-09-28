import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Required used to live at the bottom of the expanded field editor, so a
// collapsed question never said whether it had to be answered, and changing a
// whole form meant opening every question one at a time.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const manager = () => read('../src/components/admin/FormsSurveysManager.jsx');

test('every question says on its heading whether it is required, and toggles there', async () => {
  const source = await manager();
  // A real switch on the always-visible heading, not inside the expanded body.
  assert.match(source, /\{!layout && <button type="button" role="switch" aria-checked=\{Boolean\(field\.required\)\}/);
  assert.match(source, /onClick=\{\(\) => onUpdate\('required', !field\.required\)\}>\{field\.required \? 'Required' : 'Optional'\}/);
  // And there is exactly one control for it, so the two cannot disagree.
  assert.equal([...source.matchAll(/onUpdate\('required'/g)].length, 1);
  assert.doesNotMatch(source, /label="Required"/);
});

test('the whole form can be made required or optional at once', async () => {
  const source = await manager();
  assert.match(source, /Make all required/);
  assert.match(source, /Make all optional/);
  // Headings and statements have no answer, so they are never marked.
  assert.match(source, /const answerable = field => !\['section_break', 'statement'\]\.includes\(field\.type\);/);
  assert.match(source, /answerable\(field\) \? \{ \.\.\.field, required: value \} : field/);
});

test('a bulk switch cannot block submissions through a hidden or skipped question', async () => {
  // The builder marks hidden questions too. That is only safe because the
  // database never enforces required on a question the respondent did not see.
  const sql = await read('../supabase/migrations/20260813010000_xert_form_response_snapshots.sql');
  assert.match(sql, /if coalesce\(\(v_question ->> 'hidden'\)::boolean, false\)\s*or v_question_type in \('section_break', 'statement'\)\s*or v_question_id = any\(v_skipped_ids\) then\s*continue;/);
});
