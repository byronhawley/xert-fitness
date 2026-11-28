import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pairsBoard, pairsCard, pairsSplitQuestion } from '../src/lib/pairsBoard.js';
import { pairsFormDefinition } from '../src/lib/pairsCompetition.js';

const SUB = 'aacdf9ca-f8df-47ae-acc1-6a5931e574a2';
// The live form as Byron set it up: the original four plus a SUB category.
const form = (() => {
  const base = pairsFormDefinition();
  const sub = { id: SUB, type: 'single_choice', question: 'SUB category', options: ['MALE/MALE', 'FEMALE/FEMALE'], required: true, hidden: false };
  return { ...base, questions: [base.questions[0], sub, ...base.questions.slice(1)] };
})();

let n = 0;
const entry = (category, split, extra = {}) => ({
  id: `r${n += 1}`,
  respondent_name: `Entrant ${n}`, respondent_email: `e${n}@example.com`, created_at: `2026-11-2${n % 9}T00:00:00Z`,
  answers: { 'pairs-team-name': `Team ${n}`, 'pairs-teammate-1': `A${n}`, 'pairs-teammate-2': `B${n}`, 'pairs-category': category, ...(split ? { [SUB]: split } : {}) },
  ...extra,
});

test('the split comes from the form: the first extra choice question', () => {
  assert.equal(pairsSplitQuestion(form).id, SUB);
  assert.equal(pairsSplitQuestion(pairsFormDefinition()), null);
});

test('every pair lands in its category and split, with counts', () => {
  const board = pairsBoard(form, [
    entry('Everyday', 'MALE/MALE'), entry('Everyday', 'FEMALE/FEMALE'), entry('Everyday', 'MALE/MALE'),
    entry('Advanced', 'FEMALE/FEMALE'),
  ]);
  assert.equal(board.total, 4);
  assert.equal(board.splitLabel, 'SUB category');
  assert.deepEqual(board.divisions.map(d => [d.category, d.total]), [['Everyday', 3], ['Intermediate', 0], ['Advanced', 1]]);
  const everyday = board.divisions[0].columns;
  assert.deepEqual(everyday.map(c => [c.label, c.entries.length]), [['MALE/MALE', 2], ['FEMALE/FEMALE', 1]]);
});

test('nothing goes missing when the form changes under existing entries', () => {
  const board = pairsBoard(form, [
    entry('Everyday', null),          // entered before the SUB category existed
    entry('Elite', 'MALE/MALE'),      // a category since renamed or removed
    entry('', 'MALE/MALE'),           // no category at all
  ]);
  assert.equal(board.total, 3);
  const everyday = board.divisions.find(d => d.category === 'Everyday');
  assert.deepEqual(everyday.columns.at(-1), { key: '__unset', label: 'No sub category', unset: true, entries: everyday.columns.at(-1).entries });
  assert.equal(everyday.columns.at(-1).entries.length, 1);
  const elite = board.divisions.find(d => d.category === 'Elite');
  assert.equal(elite.known, false);
  assert.equal(board.uncategorised.length, 1);
});

test('archived entries are off the board, and search narrows it', () => {
  const board = pairsBoard(form, [
    entry('Everyday', 'MALE/MALE', { archived_at: '2026-11-28T00:00:00Z' }),
    entry('Advanced', 'FEMALE/FEMALE', { answers: { 'pairs-team-name': 'Sweat Squad', 'pairs-teammate-1': 'Kirra', 'pairs-teammate-2': 'Jo', 'pairs-category': 'Advanced', [SUB]: 'FEMALE/FEMALE' } }),
    entry('Advanced', 'FEMALE/FEMALE'),
  ], 'kirra');
  assert.equal(board.total, 2, 'the archived test is gone');
  assert.equal(board.shown, 1);
  assert.equal(board.divisions.find(d => d.category === 'Advanced').columns[1].entries[0].teamName, 'Sweat Squad');
});

test('a card shows the pair, who entered, and any other answers', () => {
  const withNote = { ...form, questions: [...form.questions, { id: 'tee', type: 'short_text', question: 'T-shirt sizes', required: false }] };
  const card = pairsCard({ ...entry('Everyday', 'MALE/MALE'), respondent_phone: '0400', answers: { ...entry('Everyday', 'MALE/MALE').answers, tee: 'M, L' } }, withNote);
  assert.equal(card.split, 'MALE/MALE');
  assert.deepEqual(card.extras, [['T-shirt sizes', 'M, L']], 'the split is a column, not repeated on the card');
  assert.equal(card.phone, '0400');
});

test('the board is in the admin under Classes, and removing archives', () => {
  const nav = readFileSync(new URL('../src/lib/adminWorkspaces.js', import.meta.url), 'utf8');
  assert.match(nav, /\{ key: 'pairs', label: 'Pairs comp'/);
  assert.match(readFileSync(new URL('../src/lib/adminNavigation.js', import.meta.url), 'utf8'), /'pairs',/);
  assert.match(readFileSync(new URL('../src/pages/AdminCommandCentre.jsx', import.meta.url), 'utf8'), /case 'pairs': return <PairsCompBoard/);
  const board = readFileSync(new URL('../src/components/admin/PairsCompBoard.jsx', import.meta.url), 'utf8');
  assert.match(board, /archive: responseId => archiveFormResponse\(responseId\)/);
  assert.match(board, /await source\.archive\(archiving\.id\)/);
  assert.doesNotMatch(board, /delete\(/, 'entries are archived, never deleted');
});
