import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pairsBoard } from '../src/lib/pairsBoard.js';
import { pairsFormDefinition } from '../src/lib/pairsCompetition.js';
import { PAIRS_RUN_SHEET, pairsRunSheet, pairsScoreSheetCsv, pairsScoreSheetRows, pairsSlotTime } from '../src/lib/pairsRunSheet.js';

const form = pairsFormDefinition();
let n = 0;
const entry = (category, team = `Team ${n + 1}`) => ({
  id: `r${n += 1}`, respondent_name: `Entrant ${n}`, respondent_email: `e${n}@example.com`, respondent_phone: '0400 000 000',
  created_at: `2026-11-2${n}T00:00:00Z`,
  answers: { 'pairs-team-name': team, 'pairs-teammate-1': `A${n}`, 'pairs-teammate-2': `B${n}`, 'pairs-category': category },
});

test("Byron's day: three workouts an hour apart, 20 minutes a division, then prizes", () => {
  assert.equal(pairsSlotTime(1, 'Everyday'), '7:00am–7:20am');
  assert.equal(pairsSlotTime(1, 'Advanced'), '7:40am–8:00am');
  assert.equal(pairsSlotTime(2, 'Intermediate'), '8:35am–8:55am');
  assert.equal(pairsSlotTime(3, 'Advanced'), '10:10am–10:30am');
  assert.equal(pairsSlotTime(1, 'Elite'), '');
  assert.deepEqual(PAIRS_RUN_SHEET.filter(row => row.kind === 'break').map(row => `${row.start} ${row.label}`),
    ['8:00am Transition / prep', '9:15am Transition / prep', '10:30am Prizes and thank-yous']);
});

test('the run sheet counts the pairs on the floor in each slot', () => {
  const board = pairsBoard(form, [entry('Everyday'), entry('Everyday'), entry('Advanced')]);
  const sheet = pairsRunSheet(board);
  assert.equal(sheet.find(row => row.workout === 2 && row.division === 'Everyday').pairs, 2);
  assert.equal(sheet.find(row => row.workout === 3 && row.division === 'Intermediate').pairs, 0);
  assert.equal(sheet.find(row => row.workout === 1 && row.division === 'Advanced').pairs, 1);
});

test('the score spreadsheet has every pair by division with blank scores to fill in', () => {
  const board = pairsBoard(form, [entry('Advanced', '=HYPERLINK("x")'), entry('Everyday', 'Sweat Squad'), entry('', 'Lost')]);
  const rows = pairsScoreSheetRows(board);
  assert.deepEqual(rows.map(row => [row.division, row.team]), [['Everyday', 'Sweat Squad'], ['Advanced', '=HYPERLINK("x")'], ['No category', 'Lost']]);
  assert.equal(rows[0].w1Time, '7:00am–7:20am');
  assert.equal(rows[0].w3Score, '');
  const csv = pairsScoreSheetCsv(board);
  assert.match(csv.split('\n')[0], /^Division,Team,Teammate 1,Teammate 2,Workout 1 time,Workout 1 score,Workout 2 time,Workout 2 score,Workout 3 time,Workout 3 score,Total,Place,Entered by,Email,Phone$/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/, 'a team name cannot run as a formula in Excel');
  assert.equal(pairsScoreSheetCsv(pairsBoard(form, [])), '');
});

test('the admin board shows the run sheet and downloads the spreadsheet; /pairs shows the times', () => {
  const board = readFileSync(new URL('../src/components/admin/PairsCompBoard.jsx', import.meta.url), 'utf8');
  assert.match(board, /<RunSheet rows=\{pairsRunSheet\(everyone\)\} \/>/);
  assert.match(board, /downloadCsv\(`pairs-comp-/);
  const page = readFileSync(new URL('../src/pages/PairsSignup.jsx', import.meta.url), 'utf8');
  assert.match(page, /<OnTheDay \/>/);
  assert.match(readFileSync(new URL('../src/lib/xertosPairs.js', import.meta.url), 'utf8'), /runSheet: PAIRS_RUN_SHEET,/);
});

test('with a sub category, M/M and F/F share the division slot and get their own column', () => {
  const SUB = 'sub';
  const withSub = { ...form, questions: [...form.questions, { id: SUB, type: 'single_choice', question: 'SUB category', options: ['MALE/MALE', 'FEMALE/FEMALE'], required: true }] };
  const pair = (split) => { const item = entry('Advanced'); item.answers[SUB] = split; return item; };
  const board = pairsBoard(withSub, [pair('FEMALE/FEMALE'), pair('MALE/MALE'), pair('FEMALE/FEMALE')]);
  assert.equal(pairsRunSheet(board).find(row => row.workout === 1 && row.division === 'Advanced').pairs, 3, 'all on the floor together');
  const csv = pairsScoreSheetCsv(board).split('\n');
  assert.match(csv[0], /^Division,SUB category,Team,/);
  assert.deepEqual(pairsScoreSheetRows(board).map(row => row.split), ['MALE/MALE', 'FEMALE/FEMALE', 'FEMALE/FEMALE'], 'grouped by sub category');
});

test('divisions judge each other: workout, then judge the next division, then rest', async () => {
  const { pairsScoreCards, pairsScoreCardsHtml } = await import('../src/lib/pairsRunSheet.js');
  const first = PAIRS_RUN_SHEET.filter(row => row.workout === 1);
  assert.deepEqual(first.map(row => [row.start, row.division, row.judgedBy, row.resting]), [
    ['7:00am', 'Everyday', 'Advanced', 'Intermediate'],
    ['7:20am', 'Intermediate', 'Everyday', 'Advanced'],
    ['7:40am', 'Advanced', 'Intermediate', 'Everyday'],
  ]);
  for (const workout of [2, 3]) {
    assert.deepEqual(PAIRS_RUN_SHEET.filter(row => row.workout === workout).map(row => row.judgedBy), ['Advanced', 'Everyday', 'Intermediate'], 'the order never changes');
  }

  const board = pairsBoard(form, [entry('Advanced', '<b>Beast</b>'), entry('Everyday', 'Sweat Squad')]);
  const cards = pairsScoreCards(board);
  assert.equal(cards.length, 6, 'a card per pair per workout');
  assert.deepEqual(cards.map(card => `${card.workout} ${card.division}`), ['1 Everyday', '1 Advanced', '2 Everyday', '2 Advanced', '3 Everyday', '3 Advanced'], 'in running order');
  assert.equal(cards[1].judgedBy, 'Intermediate');
  const html = pairsScoreCardsHtml(board);
  assert.equal((html.match(/class="card"/g) || []).length, 6);
  assert.match(html, /&lt;b&gt;Beast&lt;\/b&gt;/, 'names are escaped');
  assert.doesNotMatch(html, /<b>Beast/);
  assert.match(pairsScoreCardsHtml(pairsBoard(form, [])), /No pairs entered yet/);
});
