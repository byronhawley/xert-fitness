// The Pairs competition on 19 December 2026.
//
// An entry is a response to an ordinary XERT form, so staff read, export and
// pause entries in Admin > Forms like any other form, and the minute job that
// sends form responses to XertOS carries every entry across with the entrant's
// email. Nothing new is stored anywhere.
//
// The /pairs page asks people to sign in first, so each entry belongs to an
// XERT account: the response records the account (created_by) and its email,
// and the form takes one entry per email.

// The slug keeps the date first announced (19 Nov): the form, and any entries
// already made, live under it. The competition itself is on 19 Dec.
export const PAIRS_FORM_SLUG = 'pairs-2026-11-19';
export const PAIRS_EVENT_DATE = '2026-12-19';
export const PAIRS_EVENT_LABEL = '19.12.2026';
export const PAIRS_CATEGORIES = Object.freeze(['Everyday', 'Intermediate', 'Advanced']);

// Fixed question ids: the page writes answers against these, and they stay the
// same if staff later edit the wording in the form builder.
export const PAIRS_QUESTION_IDS = Object.freeze({
  teamName: 'pairs-team-name',
  teammateOne: 'pairs-teammate-1',
  teammateTwo: 'pairs-teammate-2',
  category: 'pairs-category',
});

// Entries stop at the end of competition day, Brisbane time (UTC+10, no DST).
export const PAIRS_ENTRIES_CLOSE_AT = '2026-12-19T14:00:00.000Z';

export const NAME_MAX = 80;
export const TEAM_NAME_MAX = 60;

function question(id, type, label, extra = {}) {
  return {
    id, type, question: label, description: '', required: true, hidden: false,
    allow_already_provided: false, placeholder: '', options: [], allow_other: false,
    scale_min: 1, scale_max: 10, scale_min_label: '', scale_max_label: '',
    media_type: null, media_url: '', media_caption: '', correct_answer: null,
    points: 0, content: '', skip_rules: [], ...extra,
  };
}

/** The form row an admin creates from /pairs (same columns as the form builder saves). */
export function pairsFormDefinition() {
  return {
    title: `Pairs Competition ${PAIRS_EVENT_LABEL}`,
    description: `Enter your pair for the XERT Fitness Pairs Competition on ${PAIRS_EVENT_LABEL}. Choose the category that suits your team: Everyday, Intermediate or Advanced.`,
    form_type: 'registration',
    slug: PAIRS_FORM_SLUG,
    questions: [
      question(PAIRS_QUESTION_IDS.teamName, 'short_text', 'Pair team name'),
      question(PAIRS_QUESTION_IDS.teammateOne, 'short_text', 'Teammate 1 name'),
      question(PAIRS_QUESTION_IDS.teammateTwo, 'short_text', 'Teammate 2 name'),
      question(PAIRS_QUESTION_IDS.category, 'single_choice', 'Category', { options: [...PAIRS_CATEGORIES] }),
    ],
    is_active: true,
    show_progress_bar: false,
    thank_you_message: `Your pair is entered. See you on ${PAIRS_EVENT_LABEL}!`,
    redirect_url: null,
    header_media_type: null,
    header_media_url: '',
    header_media_caption: '',
    collect_name: true,
    collect_name_required: true,
    collect_email: true,
    collect_email_required: true,
    collect_phone: true,
    collect_phone_required: false,
    one_response_per_email: true,
    notify_admin: true,
    email_copy_to_respondent: false,
    email_pdf_copy: false,
    tags: ['competition', 'pairs'],
    prerequisite_form_id: null,
  };
}

export function pairsEntriesOpen(now = new Date()) {
  return now.getTime() < Date.parse(PAIRS_ENTRIES_CLOSE_AT);
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// ─── Following the live form ─────────────────────────────────────────────
// Staff edit the Pairs form in the builder like any other form. The page has
// to follow those edits, or one change stops every entry: a required question
// added in the builder is one the page never asked, and the database refuses
// the entry for it ("Please complete every required question"). So the page
// asks every question the live form has. The team name is asked while the
// form still has it, the categories are whatever the form offers, and any
// other question appears below them as it is set up in the builder.

const CORE_IDS = new Set(Object.values(PAIRS_QUESTION_IDS));
const LAYOUT_TYPES = new Set(['section_break', 'statement']);
const CHOICE_TYPES = new Set(['single_choice', 'dropdown', 'yes_no']);
// What the page can ask beyond the core fields. Anything else (a signature, a
// file) would need its own control; pairsFormMatches refuses such a form
// rather than post an entry the database will reject.
export const PAIRS_EXTRA_TYPES = new Set(['single_choice', 'dropdown', 'yes_no', 'multiple_choice',
  'short_text', 'long_text', 'email', 'phone', 'number', 'date']);

const questionsOf = form => (Array.isArray(form?.questions) ? form.questions.filter(Boolean) : []);
const questionById = (form, id) => questionsOf(form).find(item => item.id === id) || null;

/** Questions the live form has beyond the core four, in the form's order. */
export function pairsExtraQuestions(form) {
  return questionsOf(form).filter(item => !CORE_IDS.has(item.id) && !LAYOUT_TYPES.has(item.type) && !item.hidden);
}

/** The options a choice question offers. */
export function pairsChoiceOptions(question) {
  if (question?.type === 'yes_no') return ['Yes', 'No'];
  return (Array.isArray(question?.options) ? question.options : []).map(String).filter(Boolean);
}

/** Whether the live form still asks for a team name. */
export function pairsAsksTeamName(form) {
  const item = questionById(form, PAIRS_QUESTION_IDS.teamName);
  return Boolean(item && !item.hidden);
}

/** The categories the live form offers (the built-in three without a form). */
export function pairsCategories(form) {
  const item = form ? questionById(form, PAIRS_QUESTION_IDS.category) : null;
  const options = item ? pairsChoiceOptions(item) : [];
  return options.length ? options : [...PAIRS_CATEGORIES];
}

function extraPresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  return clean(value) !== '';
}

/**
 * Field-by-field problems with an entry, worded for the person filling it in.
 * Without a form it checks the original four fields, as it always did.
 * @param {{ teamName?: string, teammateOne?: string, teammateTwo?: string, category?: string, extras?: Record<string, any> }} [entry]
 * @param {object} [form] the live form, so its own questions are checked too
 * @returns {Record<string, string>}
 */
export function pairsEntryErrors(entry = {}, form = null) {
  /** @type {Record<string, string>} */
  const errors = {};
  const teamName = clean(entry.teamName);
  const one = clean(entry.teammateOne);
  const two = clean(entry.teammateTwo);
  if (!form || pairsAsksTeamName(form)) {
    if (!teamName) errors.teamName = 'Give your pair a team name.';
    else if (teamName.length > TEAM_NAME_MAX) errors.teamName = `Keep the team name to ${TEAM_NAME_MAX} characters.`;
  }
  if (!one) errors.teammateOne = 'Enter your name.';
  else if (one.length > NAME_MAX) errors.teammateOne = `Keep names to ${NAME_MAX} characters.`;
  if (!two) errors.teammateTwo = "Enter your teammate's name.";
  else if (two.length > NAME_MAX) errors.teammateTwo = `Keep names to ${NAME_MAX} characters.`;
  else if (one && one.toLowerCase() === two.toLowerCase()) errors.teammateTwo = 'Your teammate needs to be a different person.';
  if (!pairsCategories(form).includes(entry.category)) errors.category = 'Choose a category.';
  for (const item of form ? pairsExtraQuestions(form) : []) {
    const value = entry.extras?.[item.id];
    if (item.required && !extraPresent(value)) {
      errors[item.id] = CHOICE_TYPES.has(item.type) || item.type === 'multiple_choice'
        ? `Choose ${clean(item.question) ? `a ${clean(item.question).toLowerCase()}` : 'an option'}.`
        : `Fill in ${clean(item.question) || 'this question'}.`;
    } else if (CHOICE_TYPES.has(item.type) && extraPresent(value) && !pairsChoiceOptions(item).includes(value)) {
      errors[item.id] = 'Choose one of the options listed.';
    }
  }
  return errors;
}

/**
 * The answers object the form takes, keyed by the live form's question ids.
 * Without a form it answers the original four, as it always did.
 */
export function pairsEntryAnswers(entry, form = null) {
  const answers = {
    [PAIRS_QUESTION_IDS.teammateOne]: clean(entry.teammateOne),
    [PAIRS_QUESTION_IDS.teammateTwo]: clean(entry.teammateTwo),
    [PAIRS_QUESTION_IDS.category]: entry.category,
  };
  // A team name the form no longer has would be refused as an unknown answer.
  if (!form || pairsAsksTeamName(form)) answers[PAIRS_QUESTION_IDS.teamName] = clean(entry.teamName);
  for (const item of form ? pairsExtraQuestions(form) : []) {
    const value = entry.extras?.[item.id];
    if (!extraPresent(value)) continue;
    if (item.type === 'number') answers[item.id] = Number(value);
    else answers[item.id] = Array.isArray(value) ? value : clean(value);
  }
  return Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * True when the page can take an entry for the live form: it still has both
 * teammates and a category with options, and every other question is one the
 * page knows how to ask.
 */
export function pairsFormMatches(form) {
  const one = questionById(form, PAIRS_QUESTION_IDS.teammateOne);
  const two = questionById(form, PAIRS_QUESTION_IDS.teammateTwo);
  const category = questionById(form, PAIRS_QUESTION_IDS.category);
  return Boolean(
    one && two && category && pairsChoiceOptions(category).length
    && pairsExtraQuestions(form).every(item => PAIRS_EXTRA_TYPES.has(item.type)),
  );
}

/** Turn the database's refusal into words for the entrant. */
export function pairsSubmitErrorMessage(error) {
  const code = error?.code;
  const message = String(error?.message || '');
  if (code === '23505' || /already been submitted/i.test(message)) return 'ALREADY_ENTERED';
  if (code === '40001') return 'The entry form was just updated. Refresh the page and send your entry again.';
  if (code === 'P0002' || /not available/i.test(message)) return 'Entries are closed right now. Ask the XERT team at the front desk.';
  return message || 'Your entry did not send. Check your connection and try again.';
}
