import assert from 'node:assert/strict';
import test from 'node:test';

import { remapSkipTargets, skipRuleProblems } from '../src/lib/formBranching.js';

// Skip rules store a position, not a question. Every structural edit in the
// builder shifted positions underneath them, so a rule written as "No → go to
// Emergency contact" quietly became "No → go to whatever is fifth now".

const q = (id, skip_rules = []) => ({ id, question: id, type: 'single_choice', options: ['Yes', 'No'], skip_rules });
const ids = questions => questions.map(question => question.id);
const targetOf = (questions, id) => questions.find(question => question.id === id).skip_rules[0].skip_to;
const move = (list, from, to) => { const next = [...list]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next; };

test('moving a question keeps every jump pointed at the same destination', () => {
  // A jumps to D (position 4). Move B below D: D is now third.
  const before = [q('A', [{ option: 'No', skip_to: 4 }]), q('B'), q('C'), q('D'), q('E')];
  const after = remapSkipTargets(before, move(before, 1, 3));
  assert.deepEqual(ids(after), ['A', 'C', 'D', 'B', 'E']);
  assert.equal(targetOf(after, 'A'), 3, 'still D, which moved up a place');
  assert.deepEqual(skipRuleProblems(after), []);
});

test('the rule moves with its own question', () => {
  // B jumps to E. Move B to the top; E has not moved, so the rule still says 5.
  const before = [q('A'), q('B', [{ option: 'No', skip_to: 5 }]), q('C'), q('D'), q('E')];
  const after = remapSkipTargets(before, move(before, 1, 0));
  assert.equal(targetOf(after, 'B'), 5);
  assert.deepEqual(skipRuleProblems(after), []);
});

test('adding a question at the end does not re-aim "End form" at it', () => {
  const before = [q('A', [{ option: 'No', skip_to: 4 }]), q('B'), q('C')];
  const after = remapSkipTargets(before, [...before, q('NEW')]);
  assert.equal(targetOf(after, 'A'), 5, 'the new end, not the new question');
});

test('deleting a question in between keeps later jumps on their question', () => {
  const before = [q('A', [{ option: 'No', skip_to: 4 }]), q('B'), q('C'), q('D')];
  const after = remapSkipTargets(before, before.filter(question => question.id !== 'B'));
  assert.equal(targetOf(after, 'A'), 3, 'still D');
});

test('deleting the destination itself is reported, never silently re-aimed', () => {
  const before = [q('A', [{ option: 'No', skip_to: 3 }]), q('B'), q('C'), q('D')];
  const after = remapSkipTargets(before, before.filter(question => question.id !== 'C'));
  assert.equal(targetOf(after, 'A'), null);
  const [problem] = skipRuleProblems(after);
  assert.equal(problem.reason, 'no-destination');
});

test('a duplicate carries rules that point where the original’s did', () => {
  const before = [q('A', [{ option: 'No', skip_to: 3 }]), q('B'), q('C')];
  const copy = { ...before[0], id: 'A2' };
  const after = remapSkipTargets(before, [before[0], copy, ...before.slice(1)]);
  assert.equal(targetOf(after, 'A'), 4, 'C moved down one');
  assert.equal(targetOf(after, 'A2'), 4, 'the copy aims at C too');
});

test('a move that puts the destination above its rule is caught, not hidden', () => {
  // A jumps to C. Drag C to the top: the jump is now backwards.
  const before = [q('A', [{ option: 'No', skip_to: 3 }]), q('B'), q('C')];
  const after = remapSkipTargets(before, move(before, 2, 0));
  assert.equal(targetOf(after, 'A'), 1);
  assert.equal(skipRuleProblems(after)[0].reason, 'backwards');
});

test('rules that were already broken are left for the diagnosis to name', () => {
  const before = [q('A', [{ option: 'No', skip_to: null }, { option: 'Yes', skip_to: 99 }]), q('B')];
  const after = remapSkipTargets(before, before);
  assert.deepEqual(after[0].skip_rules, before[0].skip_rules);
});

test('questions without rules pass through untouched', () => {
  const before = [q('A'), q('B')];
  const after = remapSkipTargets(before, [...before].reverse());
  assert.equal(after[0], before[1]);
});

test('every change to the shape of the list goes through the remap', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/components/admin/FormsSurveysManager.jsx', import.meta.url), 'utf8');
  assert.match(source, /const setQuestions = change => setDraft\(current => \(\{ \.\.\.current, questions: remapSkipTargets\(current\.questions, change\(current\.questions\)\) \}\)\);/);
  for (const operation of ['moveField', 'moveRows', 'addField', 'duplicateField', 'removeField']) {
    assert.match(source, new RegExp(`const ${operation} = [^\\n]*setQuestions\\(`), `${operation} must remap skip rules`);
  }
  // Only a change that keeps every question in place may bypass it.
  const direct = [...source.matchAll(/update\('questions'/g)];
  assert.equal(direct.length, 1, 'the one direct write is Make all required, which moves nothing');
  assert.match(source, /const setAllRequired = value => update\('questions'/);
  // Undo puts back the whole list from before a removal — positions and rules
  // together, so nothing needs remapping — and only while nothing has changed
  // since; otherwise it would quietly throw later edits away.
  assert.match(source, /const undoRemove = [^\n]*current\.questions === undo\.after \? \{ \.\.\.current, questions: undo\.before \} : current/);
  assert.match(source, /return current\.after === draft\.questions \? current : null;/);
});
