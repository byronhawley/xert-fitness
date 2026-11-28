// ─── The Pairs entries board ───────────────────────────────────────────────
// Every entry as a card, sorted into its division. A division is a category
// (Everyday, Intermediate, Advanced) split by the first extra choice question
// the form has -- today the SUB category Byron added (MALE/MALE,
// FEMALE/FEMALE). Both come from the live form, so renaming a category or
// adding a split in the builder reshapes the board without a code change.
//
// Entries are still ordinary form responses; this only reads them.

import { PAIRS_QUESTION_IDS, pairsCategories, pairsChoiceOptions, pairsExtraQuestions } from './pairsCompetition.js';

const SPLIT_TYPES = new Set(['single_choice', 'dropdown', 'yes_no']);
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** The extra question the board splits each category by, or null. */
export function pairsSplitQuestion(form) {
  return pairsExtraQuestions(form).find(item => SPLIT_TYPES.has(item.type) && pairsChoiceOptions(item).length) || null;
}

/** One entry as the card shows it. */
export function pairsCard(response, form) {
  const answers = response?.answers || {};
  const split = pairsSplitQuestion(form);
  const extras = pairsExtraQuestions(form)
    .filter(item => item.id !== split?.id)
    .map(item => [clean(item.question) || 'Answer', Array.isArray(answers[item.id]) ? answers[item.id].join(', ') : clean(answers[item.id])])
    .filter(([, value]) => value);
  return {
    id: response.id,
    teamName: clean(answers[PAIRS_QUESTION_IDS.teamName]),
    teammateOne: clean(answers[PAIRS_QUESTION_IDS.teammateOne]),
    teammateTwo: clean(answers[PAIRS_QUESTION_IDS.teammateTwo]),
    category: clean(answers[PAIRS_QUESTION_IDS.category]),
    split: split ? clean(answers[split.id]) : '',
    enteredBy: clean(response.respondent_name) || clean(response.respondent_email),
    email: clean(response.respondent_email),
    phone: clean(response.respondent_phone),
    enteredAt: response.completed_at || response.created_at || null,
    extras,
  };
}

function matches(card, term) {
  if (!term) return true;
  return [card.teamName, card.teammateOne, card.teammateTwo, card.enteredBy, card.email, card.category, card.split]
    .some(value => value.toLowerCase().includes(term));
}

/**
 * The board: categories in the form's order, each split into columns.
 * An entry whose category or split is not on the form any more (or was made
 * before the split existed) still shows, in a "not set" column, so nothing
 * goes missing from view when the form is edited.
 */
export function pairsBoard(form, responses = [], search = '') {
  const term = clean(search).toLowerCase();
  const split = pairsSplitQuestion(form);
  const splitOptions = split ? pairsChoiceOptions(split) : [];
  const categories = pairsCategories(form);
  const all = (responses || []).filter(item => item && !item.archived_at).map(item => pairsCard(item, form));
  const shown = all.filter(card => matches(card, term));
  const byOrder = (a, b) => String(a.enteredAt || '').localeCompare(String(b.enteredAt || ''));

  const extraCategories = [...new Set(shown.map(card => card.category).filter(value => value && !categories.includes(value)))];
  const divisions = [...categories, ...extraCategories].map(category => {
    const inCategory = shown.filter(card => card.category === category).sort(byOrder);
    const columns = split
      ? [
        ...splitOptions.map(option => ({ key: option, label: option, entries: inCategory.filter(card => card.split === option) })),
        { key: '__unset', label: `No ${clean(split.question).toLowerCase() || 'choice'}`, unset: true, entries: inCategory.filter(card => !splitOptions.includes(card.split)) },
      ].filter(column => !column.unset || column.entries.length)
      : [{ key: '__all', label: 'All pairs', entries: inCategory }];
    return { category, known: categories.includes(category), total: inCategory.length, columns };
  });
  const uncategorised = shown.filter(card => !card.category).sort(byOrder);
  return {
    total: all.length,
    shown: shown.length,
    splitLabel: split ? clean(split.question) : '',
    divisions,
    uncategorised,
  };
}
