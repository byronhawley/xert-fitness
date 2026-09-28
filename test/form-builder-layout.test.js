import assert from 'node:assert/strict';
import test from 'node:test';
import { builderRows, moveVisibleRow, sectionEnd, sectionOf } from '../src/lib/formBuilderLayout.js';
import { remapSkipTargets } from '../src/lib/formBranching.js';

// The builder shows a form as its sections, each holding the fields after it.
// The stored list stays flat, because skip rules are positions in it, so these
// check that the grouped view and every move map back onto that list exactly.

const q = (id, type = 'short_text', extra = {}) => ({ id, type, question: id, ...extra });
const s = id => ({ id, type: 'section_break', content: id });
const form = [q('intro'), s('A'), q('a1'), q('a2'), s('B'), q('b1'), s('C')];
const ids = list => list.map(field => field.id);

test('each section holds the fields after it, and fields before the first belong to none', () => {
  const rows = builderRows(form);
  assert.deepEqual(rows.map(row => [row.field.id, row.depth, row.section]), [
    ['intro', 0, false], ['A', 0, true], ['a1', 1, false], ['a2', 1, false], ['B', 0, true], ['b1', 1, false], ['C', 0, true],
  ]);
  assert.deepEqual(rows.filter(row => row.section).map(row => row.childCount), [2, 1, 0]);
  // Where "Add to this section" goes: after each section's last field, or under an empty one.
  assert.deepEqual(rows.filter(row => row.lastInGroup).map(row => row.field.id), ['a2', 'b1', 'C']);
});

test('a folded section is one row that stands for everything in it', () => {
  const rows = builderRows(form, new Set(['A']));
  assert.deepEqual(rows.map(row => row.field.id), ['intro', 'A', 'B', 'b1', 'C']);
  assert.equal(rows[1].span, 3);
  assert.equal(rows[1].folded, true);
});

test('a single field moves exactly as a spliced list would, up or down', () => {
  const rows = builderRows(form);
  // a1 (row 2) dropped at row 5: after b1.
  assert.deepEqual(ids(moveVisibleRow(form, rows, 2, 5)), ['intro', 'A', 'a2', 'B', 'b1', 'a1', 'C']);
  // b1 (row 5) dropped at row 0: first of all.
  assert.deepEqual(ids(moveVisibleRow(form, rows, 5, 0)), ['b1', 'intro', 'A', 'a1', 'a2', 'B', 'C']);
  assert.equal(moveVisibleRow(form, rows, 3, 3), form, 'dropping in place changes nothing');
});

test('a folded section moves with everything in it', () => {
  const folded = new Set(['A']);
  const rows = builderRows(form, folded); // intro, A(+a1,a2), B, b1, C
  assert.deepEqual(ids(moveVisibleRow(form, rows, 1, 3)), ['intro', 'B', 'b1', 'A', 'a1', 'a2', 'C']);
  assert.deepEqual(ids(moveVisibleRow(form, rows, 1, 4)), ['intro', 'B', 'b1', 'C', 'A', 'a1', 'a2']);
  // And a field dropped just after a folded section lands after all it holds.
  assert.deepEqual(ids(moveVisibleRow(form, builderRows(form, new Set(['A'])), 0, 1)), ['A', 'a1', 'a2', 'intro', 'B', 'b1', 'C']);
});

test('moving a whole section keeps every skip rule aimed at the same question', () => {
  const branching = [
    q('start', 'yes_no', { skip_rules: [{ option: 'No', skip_to: 6 }] }), // jumps to b1
    s('A'), q('a1'), q('a2'),
    s('B'), q('b1'),
  ];
  const rows = builderRows(branching, new Set(['B']));
  // Rows: start, A, a1, a2, B (standing for b1 too). B goes above A.
  const moved = moveVisibleRow(branching, rows, 4, 1);
  const remapped = remapSkipTargets(branching, moved);
  assert.deepEqual(ids(remapped), ['start', 'B', 'b1', 'A', 'a1', 'a2']);
  assert.equal(remapped[0].skip_rules[0].skip_to, 3, 'still b1, now third');
});

test('a field added to a section goes after its last field', () => {
  assert.equal(sectionEnd(form, 1), 4, 'section A ends before B');
  assert.equal(sectionEnd(form, 3), 4, 'from inside A as well');
  assert.equal(sectionEnd(form, 6), 7, 'an empty last section');
  assert.equal(sectionOf(form, 3).id, 'A');
  assert.equal(sectionOf(form, 0), null, 'the intro sits under no section');
});
