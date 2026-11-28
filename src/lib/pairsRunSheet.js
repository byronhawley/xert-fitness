// ─── Pairs comp day: the run sheet and the scoring spreadsheet ─────────────
// Byron's plan for Saturday 19 December: three workouts, one an hour, each
// division taking its 20 minutes in turn (everyone in that division on the
// floor at once, M/M and F/F together), with a 15 minute transition between
// workouts, then prizes. The order never changes. Divisions judge each other:
// each one goes workout -> judging the next division -> rest, so Everyday is
// judged by Advanced, Intermediate by Everyday, Advanced by Intermediate.
// Judges fill in a score card per team per workout and hand it to the score
// keeper, who types it into a spreadsheet on the laptop. No leaderboard.

import { buildCsv } from './csv.js';

export const PAIRS_JUDGED_BY = Object.freeze({ Everyday: 'Advanced', Intermediate: 'Everyday', Advanced: 'Intermediate' });
const RESTING = Object.freeze({ Everyday: 'Intermediate', Intermediate: 'Advanced', Advanced: 'Everyday' });

const slot = (workout, division, start, end) => ({
  kind: 'workout', workout, division, start, end, judgedBy: PAIRS_JUDGED_BY[division], resting: RESTING[division],
});
const pause = (label, start, end = null) => ({ kind: 'break', label, start, end });

export const PAIRS_RUN_SHEET = Object.freeze([
  slot(1, 'Everyday', '7:00am', '7:20am'),
  slot(1, 'Intermediate', '7:20am', '7:40am'),
  slot(1, 'Advanced', '7:40am', '8:00am'),
  pause('Transition / prep', '8:00am', '8:15am'),
  slot(2, 'Everyday', '8:15am', '8:35am'),
  slot(2, 'Intermediate', '8:35am', '8:55am'),
  slot(2, 'Advanced', '8:55am', '9:15am'),
  pause('Transition / prep', '9:15am', '9:30am'),
  slot(3, 'Everyday', '9:30am', '9:50am'),
  slot(3, 'Intermediate', '9:50am', '10:10am'),
  slot(3, 'Advanced', '10:10am', '10:30am'),
  pause('Prizes and thank-yous', '10:30am'),
].map(Object.freeze));

export const PAIRS_WORKOUTS = Object.freeze([1, 2, 3]);

/** When a division does a workout, e.g. "7:00am–7:20am", or '' if it has no slot. */
export function pairsSlotTime(workout, division) {
  const item = PAIRS_RUN_SHEET.find(row => row.kind === 'workout' && row.workout === workout && row.division === division);
  return item ? `${item.start}–${item.end}` : '';
}

/** Every pair on the board, in its division, in the order they entered. */
function pairsByDivision(board) {
  const rows = (board?.divisions || []).map(division => ({
    division: division.category,
    pairs: division.columns.flatMap(column => column.entries),
  }));
  if (board?.uncategorised?.length) rows.push({ division: 'No category', pairs: board.uncategorised });
  return rows;
}

/** The run sheet with how many pairs are on the floor in each slot. */
export function pairsRunSheet(board) {
  const counts = new Map(pairsByDivision(board).map(row => [row.division, row.pairs.length]));
  return PAIRS_RUN_SHEET.map(row => (row.kind === 'workout' ? { ...row, pairs: counts.get(row.division) || 0 } : row));
}

const SCORE_COLUMNS = Object.freeze([
  { key: 'division', label: 'Division' },
  { key: 'team', label: 'Team' },
  { key: 'teammateOne', label: 'Teammate 1' },
  { key: 'teammateTwo', label: 'Teammate 2' },
  ...PAIRS_WORKOUTS.flatMap(workout => [
    { key: `w${workout}Time`, label: `Workout ${workout} time` },
    { key: `w${workout}Score`, label: `Workout ${workout} score` },
  ]),
  { key: 'total', label: 'Total' },
  { key: 'place', label: 'Place' },
  { key: 'enteredBy', label: 'Entered by' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
]);

/**
 * The spreadsheet's columns. When the form has a sub category (Byron's
 * MALE/MALE, FEMALE/FEMALE), it gets a column next to the division: those
 * pairs share the floor but can be placed separately.
 */
export function pairsScoreColumns(board) {
  if (!board?.splitLabel) return [...SCORE_COLUMNS];
  return [SCORE_COLUMNS[0], { key: 'split', label: board.splitLabel }, ...SCORE_COLUMNS.slice(1)];
}

/** One row per pair, grouped by division (and sub category), with blank score columns to fill in. */
export function pairsScoreSheetRows(board) {
  return pairsByDivision(board).flatMap(({ division, pairs }) => pairs.map(card => ({
    division,
    split: card.split,
    team: card.teamName || `${card.teammateOne} & ${card.teammateTwo}`,
    teammateOne: card.teammateOne,
    teammateTwo: card.teammateTwo,
    ...Object.fromEntries(PAIRS_WORKOUTS.flatMap(workout => [
      [`w${workout}Time`, pairsSlotTime(workout, division)],
      [`w${workout}Score`, ''],
    ])),
    total: '',
    place: '',
    enteredBy: card.enteredBy,
    email: card.email,
    phone: card.phone,
  })));
}

/** The spreadsheet as CSV text (Excel opens it), or '' with no pairs. */
export function pairsScoreSheetCsv(board) {
  return buildCsv(pairsScoreSheetRows(board), pairsScoreColumns(board));
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/**
 * Every score card for the day as one printable page: a card per pair per
 * workout, in running order (workout 1 Everyday, Intermediate, Advanced, then
 * workout 2...), so each judging group picks up its stack in the order it goes.
 */
export function pairsScoreCards(board) {
  const byDivision = pairsByDivision(board);
  return PAIRS_RUN_SHEET.filter(row => row.kind === 'workout').flatMap(row => (
    (byDivision.find(item => item.division === row.division)?.pairs || []).map(card => ({
      workout: row.workout,
      division: row.division,
      time: `${row.start}–${row.end}`,
      judgedBy: row.judgedBy,
      split: card.split,
      team: card.teamName || `${card.teammateOne} & ${card.teammateTwo}`,
      teammates: [card.teammateOne, card.teammateTwo].filter(Boolean).join(' & '),
    }))
  ));
}

export function pairsScoreCardsHtml(board, title = 'Pairs comp score cards') {
  const cards = pairsScoreCards(board).map(card => `
    <section class="card">
      <header><span>Workout ${card.workout}</span><span>${escapeHtml(card.time)}</span></header>
      <h2>${escapeHtml(card.team)}</h2>
      <p class="who">${escapeHtml(card.teammates)}</p>
      <p class="meta">${escapeHtml(card.division)}${card.split ? ` · ${escapeHtml(card.split)}` : ''} · judged by ${escapeHtml(card.judgedBy)}</p>
      <div class="score">Score</div>
      <div class="lines"><span>Judge</span><span>Team sign</span></div>
    </section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111; }
    .sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
    .card { border: 1.5px solid #111; padding: 4mm; height: 66mm; display: flex; flex-direction: column; break-inside: avoid; }
    header { display: flex; justify-content: space-between; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
    h2 { margin: 2mm 0 0; font-size: 20px; text-transform: uppercase; }
    .who { margin: 0; }
    .meta { margin: 1mm 0 0; color: #444; font-size: 12px; }
    .score { margin-top: auto; border: 1px solid #111; height: 16mm; padding: 1.5mm 2mm; font-size: 11px; text-transform: uppercase; color: #444; }
    .lines { display: flex; gap: 6mm; margin-top: 3mm; font-size: 11px; color: #444; }
    .lines span { flex: 1; border-bottom: 1px solid #111; padding-bottom: 4mm; }
    .empty { padding: 20mm; text-align: center; }
  </style></head><body>${cards ? `<div class="sheet">${cards}</div>` : '<p class="empty">No pairs entered yet.</p>'}</body></html>`;
}
