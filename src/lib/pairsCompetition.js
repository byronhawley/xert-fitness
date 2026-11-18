// The Pairs competition on 19 November 2026.
//
// An entry is a response to an ordinary XERT form, so staff read, export and
// pause entries in Admin > Forms like any other form, and the minute job that
// sends form responses to XertOS carries every entry across with the entrant's
// email. Nothing new is stored anywhere.
//
// The /pairs page asks people to sign in first, so each entry belongs to an
// XERT account: the response records the account (created_by) and its email,
// and the form takes one entry per email.

export const PAIRS_FORM_SLUG = 'pairs-2026-11-19';
export const PAIRS_EVENT_DATE = '2026-11-19';
export const PAIRS_EVENT_LABEL = '19.11.2026';
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
export const PAIRS_ENTRIES_CLOSE_AT = '2026-11-19T14:00:00.000Z';

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
    description: 'Enter your pair for the XERT Fitness Pairs Competition on 19.11.2026. Choose the category that suits your team: Everyday, Intermediate or Advanced.',
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
    thank_you_message: 'Your pair is entered. See you on 19.11.2026!',
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

/**
 * Field-by-field problems with an entry, worded for the person filling it in.
 * @param {{ teamName?: string, teammateOne?: string, teammateTwo?: string, category?: string }} [entry]
 * @returns {{ teamName?: string, teammateOne?: string, teammateTwo?: string, category?: string }}
 */
export function pairsEntryErrors(entry = {}) {
  /** @type {{ teamName?: string, teammateOne?: string, teammateTwo?: string, category?: string }} */
  const errors = {};
  const teamName = clean(entry.teamName);
  const one = clean(entry.teammateOne);
  const two = clean(entry.teammateTwo);
  if (!teamName) errors.teamName = 'Give your pair a team name.';
  else if (teamName.length > TEAM_NAME_MAX) errors.teamName = `Keep the team name to ${TEAM_NAME_MAX} characters.`;
  if (!one) errors.teammateOne = 'Enter your name.';
  else if (one.length > NAME_MAX) errors.teammateOne = `Keep names to ${NAME_MAX} characters.`;
  if (!two) errors.teammateTwo = "Enter your teammate's name.";
  else if (two.length > NAME_MAX) errors.teammateTwo = `Keep names to ${NAME_MAX} characters.`;
  else if (one && one.toLowerCase() === two.toLowerCase()) errors.teammateTwo = 'Your teammate needs to be a different person.';
  if (!PAIRS_CATEGORIES.includes(entry.category)) errors.category = 'Choose a category.';
  return errors;
}

/** The answers object the form takes, keyed by the fixed question ids. */
export function pairsEntryAnswers(entry) {
  return {
    [PAIRS_QUESTION_IDS.teamName]: clean(entry.teamName),
    [PAIRS_QUESTION_IDS.teammateOne]: clean(entry.teammateOne),
    [PAIRS_QUESTION_IDS.teammateTwo]: clean(entry.teammateTwo),
    [PAIRS_QUESTION_IDS.category]: entry.category,
  };
}

/** True when the live form still has every question this page answers. */
export function pairsFormMatches(form) {
  const questions = Array.isArray(form?.questions) ? form.questions : [];
  const byId = new Map(questions.map(item => [item?.id, item]));
  const category = byId.get(PAIRS_QUESTION_IDS.category);
  return Boolean(
    byId.get(PAIRS_QUESTION_IDS.teamName)
    && byId.get(PAIRS_QUESTION_IDS.teammateOne)
    && byId.get(PAIRS_QUESTION_IDS.teammateTwo)
    && category
    && PAIRS_CATEGORIES.every(option => (category.options || []).includes(option)),
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
