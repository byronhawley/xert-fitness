// The Pairs competition, run from XertOS as well as here.
//
// Byron manages Pairs in the XertOS app and members can enter there. XertOS
// asks this site over the same signed webhook as bookings and pass sales:
//
//   pairsBoard        the live form (its questions, as Byron set them up in
//                     Forms & surveys), how entries are split into divisions,
//                     whether entries are open, and every entry.
//   pairsEnter        an entry made in XertOS by a signed-in member.
//   pairsSetArchived  Remove entry / restore, as on the admin board here.
//
// Entries stay this site's Pairs form responses, so /pairs, the admin board
// and XertOS all show the same list. The database functions only touch a form
// tagged 'pairs' (20261128020000_xertos_pairs.sql).

import {
  PAIRS_ENTRIES_CLOSE_AT,
  PAIRS_EVENT_DATE,
  PAIRS_EVENT_LABEL,
  PAIRS_FORM_SLUG,
  PAIRS_QUESTION_IDS,
  pairsCategories,
  pairsChoiceOptions,
  pairsEntriesOpen,
} from './pairsCompetition.js';
import { pairsSplitQuestion } from './pairsBoard.js';

export const PAIRS_ACTIONS = Object.freeze(['pairsBoard', 'pairsEnter', 'pairsSetArchived']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');

/** A request XertOS sent that the site turns down, in words for the member or Byron. */
export class PairsRefused extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** What the competition looks like to XertOS: the form, the divisions, every entry. */
export function pairsBoardForXertos(board, now = new Date()) {
  const form = board?.form || {};
  const split = pairsSplitQuestion(form);
  const open = pairsEntriesOpen(now);
  return {
    slug: form.slug,
    title: form.title,
    description: form.description || '',
    eventDate: PAIRS_EVENT_DATE,
    eventLabel: PAIRS_EVENT_LABEL,
    entriesCloseAt: PAIRS_ENTRIES_CLOSE_AT,
    entriesOpen: open && form.isActive === true,
    entriesSwitchedOff: form.isActive !== true,
    form: { id: form.id, updatedAt: form.updatedAt, questions: Array.isArray(form.questions) ? form.questions : [] },
    divisions: {
      categoryQuestionId: PAIRS_QUESTION_IDS.category,
      categories: pairsCategories(form),
      splitQuestionId: split?.id || null,
      splitLabel: split ? clean(split.question) : null,
      splitOptions: split ? pairsChoiceOptions(split) : [],
    },
    entries: (board?.entries || []).map(entry => ({
      id: entry.id,
      name: entry.name || null,
      email: entry.email || null,
      phone: entry.phone || null,
      enteredAt: entry.enteredAt || null,
      archivedAt: entry.archivedAt || null,
      answers: entry.answers || {},
    })),
  };
}

function refusalFor(error) {
  const message = String(error?.message || '');
  if (/PAIRS_FORM_NOT_FOUND/.test(message)) return new PairsRefused('PAIRS_NOT_FOUND', 'There is no Pairs competition open on XERT Fitness right now.', 404);
  if (/PAIRS_ENTRY_NOT_FOUND/.test(message)) return new PairsRefused('ENTRY_NOT_FOUND', 'That entry is not on the Pairs competition.', 404);
  if (/NO_XERT_ACCOUNT/.test(message)) return new PairsRefused('NO_XERT_ACCOUNT', 'There is no XERT Fitness account with this email. Sign up at xertfitness.com.au first, with the same email.');
  if (/XERT_ACCOUNT_AMBIGUOUS/.test(message)) return new PairsRefused('XERT_ACCOUNT_AMBIGUOUS', 'More than one XERT Fitness account has this email. Ask the front desk to sort it out, then enter.');
  if (/ALREADY_ENTERED/.test(message) || error?.code === '23505') return new PairsRefused('ALREADY_ENTERED', 'This email already has a pair entered. Each person enters once.', 409);
  if (error?.code === 'P0002') return new PairsRefused('ENTRIES_CLOSED', 'Pairs entries are switched off at the moment.');
  if (error?.code === '40001') return new PairsRefused('FORM_CHANGED', 'The entry form changed just now. Refresh and try again.', 409);
  // The form's own checks (required questions, choices on the list, a valid
  // email) answer in words meant for the person entering.
  if (error?.code === '22023') return new PairsRefused('INVALID_ENTRY', message || 'Please complete every required question.');
  return null;
}

async function rpc(admin, name, args) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw refusalFor(error) || new Error(`${name} failed: ${error.message}`);
  return data;
}

/** The entry XertOS sent, checked before it reaches the form. */
export function pairsEntryFromXertos(payload) {
  const entry = payload?.entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new PairsRefused('INVALID_ENTRY', 'The entry is missing.');
  const email = clean(entry.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 320) throw new PairsRefused('INVALID_ENTRY', 'Enter a valid email address.');
  const name = clean(entry.name);
  if (name.length > 160) throw new PairsRefused('INVALID_ENTRY', 'The name is too long.');
  const phone = clean(entry.phone);
  if (phone.length > 60) throw new PairsRefused('INVALID_ENTRY', 'The phone number is too long.');
  const answers = entry.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new PairsRefused('INVALID_ENTRY', 'The answers are missing.');
  return { email, name: name || null, phone: phone || null, answers };
}

/** Runs one Pairs action XertOS sent. Throws PairsRefused for a refusal. */
export async function runPairsAction(admin, payload, { now = new Date() } = {}) {
  switch (payload?.action) {
    case 'pairsBoard': {
      const board = await rpc(admin, 'xertos_pairs_board', { p_slug: PAIRS_FORM_SLUG });
      return { competition: pairsBoardForXertos(board, now) };
    }
    case 'pairsEnter': {
      const entry = pairsEntryFromXertos(payload);
      if (!pairsEntriesOpen(now)) throw new PairsRefused('ENTRIES_CLOSED', `Pairs entries closed on ${PAIRS_EVENT_LABEL}.`);
      const id = await rpc(admin, 'xertos_pairs_enter', {
        p_slug: PAIRS_FORM_SLUG, p_email: entry.email, p_name: entry.name, p_phone: entry.phone, p_answers: entry.answers,
      });
      return { entryId: id };
    }
    case 'pairsSetArchived': {
      const entryId = String(payload?.entryId ?? '');
      if (!UUID_PATTERN.test(entryId)) throw new PairsRefused('ENTRY_NOT_FOUND', 'That entry is not on the Pairs competition.', 404);
      if (typeof payload?.archived !== 'boolean') throw new PairsRefused('INVALID_REQUEST', 'Say whether the entry is removed (archived: true) or restored (archived: false).');
      const result = await rpc(admin, 'xertos_pairs_set_archived', { p_slug: PAIRS_FORM_SLUG, p_response_id: entryId, p_archived: payload.archived });
      return { entryId: result?.id || entryId, archivedAt: result?.archivedAt || null };
    }
    default:
      throw new PairsRefused('ACTION_NOT_READY', 'That is not a Pairs action.', 501);
  }
}
