// ─── One form leading into another ──────────────────────────────────────────
// The club's poster QR code points at the terms agreement, but nobody may
// train before the Pre-Exercise Questionnaire is answered. A form can name a
// prerequisite: opening it sends a first-time visitor to that form, and the
// original opens again the moment it is submitted.
//
// The "already completed" marker lives in sessionStorage, so it belongs to one
// person in one sitting: a shared phone or a new browser session starts again,
// and a marker older than the window below is ignored.

import { normalizeVisitorPhone } from './casualVisit.js';

export const FORM_COMPLETION_PREFIX = 'xert-form-complete:';
export const FORM_COMPLETION_TTL_MS = 12 * 60 * 60 * 1000;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESPONSE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeStorage() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // Private browsing and locked-down devices throw on access.
  }
}

/** Whole years old on a given day, or null when the date makes no sense. */
export function ageInYears(dateOfBirth, now = new Date()) {
  const born = new Date(String(dateOfBirth || ''));
  if (Number.isNaN(born.getTime())) return null;
  const today = now instanceof Date ? now : new Date(now);
  if (born > today) return null;
  let age = today.getFullYear() - born.getFullYear();
  const monthGap = today.getMonth() - born.getMonth();
  if (monthGap < 0 || (monthGap === 0 && today.getDate() < born.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Whether the person filling this form is a minor, from the date of birth they
 * already gave on the prerequisite. "unknown" when no usable date came across,
 * which must stay askable rather than silently dropping a guardian signature.
 */
export function minorStatus(identity, now = new Date()) {
  const age = ageInYears(identity?.date_of_birth, now);
  if (age === null) return 'unknown';
  return age < 18 ? 'minor' : 'adult';
}

/** The best name, email, phone and date of birth to carry from one form to the next. */
export function completionIdentity(questions, answers = {}, contact = {}) {
  const present = value => value !== undefined && value !== null && String(value).trim() !== '';
  const firstAnswer = type => {
    const match = (questions || []).find(question => question?.type === type
      && (type === 'name_fields'
        ? present(answers[question.id]?.first) || present(answers[question.id]?.last)
        : present(answers[question.id])));
    return match ? answers[match.id] : null;
  };
  const names = firstAnswer('name_fields') || {};
  const fromFields = [names.first, names.last].filter(present).join(' ').trim();
  const text = value => (present(value) ? String(value).trim() : '');
  // A date of birth carries across so the next form can tell a minor from an
  // adult without asking anyone their age twice.
  const birthday = (questions || []).find(question => question?.type === 'date'
    && /birth/i.test(String(question.question || ''))
    && present(answers[question.id]));
  return {
    name: text(contact.name) || fromFields,
    email: text(contact.email).toLowerCase() || text(firstAnswer('email')).toLowerCase(),
    phone: text(contact.phone) || text(firstAnswer('phone')),
    date_of_birth: birthday ? text(answers[birthday.id]) : '',
  };
}

/** The privacy-minimised completion marker written after a public form saves. */
export function formCompletionMarker(slug, questions, answers, contact, responseID) {
  return {
    ...completionIdentity(questions, answers, contact),
    response_id: responseID,
    ...(slug === 'terms-and-conditions'
      ? { agreement_accepted: answers?.['tc-accept'] === 'I accept the Terms and Conditions' }
      : {}),
  };
}

function normalizedName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizedEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function visitorName(visitor) {
  return visitor?.fullName ?? `${visitor?.first_name ?? visitor?.firstName ?? ''} ${visitor?.last_name ?? visitor?.lastName ?? ''}`;
}

function completionMatchesVisitor(completion, visitor, { phoneOptional = false } = {}) {
  if (!completion || !visitor) return false;
  const expectedName = normalizedName(visitorName(visitor));
  const expectedEmail = normalizedEmail(visitor.email);
  const expectedPhone = normalizeVisitorPhone(visitor.phone);
  const completedName = normalizedName(completion.name);
  const completedEmail = normalizedEmail(completion.email);
  const rawCompletedPhone = String(completion.phone ?? '').trim();
  const completedPhone = normalizeVisitorPhone(rawCompletedPhone);
  return Boolean(
    expectedName && expectedEmail && expectedPhone
    && completedName === expectedName
    && completedEmail === expectedEmail
    && (phoneOptional && !rawCompletedPhone
      ? true
      : Boolean(completedPhone) && completedPhone === expectedPhone),
  );
}

/** Which signed membership document must be completed next, if any. */
export function membershipPaperworkStatus(visitor, questionnaire, agreement) {
  const questionnaireReady = RESPONSE_ID_PATTERN.test(String(questionnaire?.response_id || ''))
    && completionMatchesVisitor(questionnaire, visitor);
  const agreementReady = RESPONSE_ID_PATTERN.test(String(agreement?.response_id || ''))
    && agreement?.agreement_accepted === true
    && completionMatchesVisitor(agreement, visitor, { phoneOptional: true });
  return {
    questionnaireReady,
    agreementReady,
    questionnaireResponseId: questionnaireReady ? questionnaire.response_id : '',
    agreementResponseId: agreementReady ? agreement.response_id : '',
    nextPath: !questionnaireReady
      ? formPath('peq', null, '3months')
      : !agreementReady ? formPath('terms-and-conditions', null, '3months') : null,
  };
}

export function writeFormCompletion(slug, identity, { storage = safeStorage(), now = Date.now() } = {}) {
  if (!storage || !SLUG_PATTERN.test(String(slug || ''))) return false;
  try {
    storage.setItem(`${FORM_COMPLETION_PREFIX}${slug}`, JSON.stringify({ ...identity, at: now }));
    return true;
  } catch {
    return false; // A full or blocked store must never break the submission.
  }
}

export function readFormCompletion(slug, { storage = safeStorage(), now = Date.now() } = {}) {
  if (!storage || !SLUG_PATTERN.test(String(slug || ''))) return null;
  try {
    const raw = storage.getItem(`${FORM_COMPLETION_PREFIX}${slug}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const at = Number(parsed?.at);
    if (!Number.isFinite(at) || now - at > FORM_COMPLETION_TTL_MS || now < at) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The slug a finished form should hand over to, taken from ?next= */
export function nextFormSlug(search) {
  const raw = new URLSearchParams(search || '').get('next') || '';
  return SLUG_PATTERN.test(raw) ? raw : null;
}

// A form can also hand back to a page rather than another form. Only these
// are ever accepted, so a crafted link can never bounce someone off the site.
const RETURN_PATHS = Object.freeze({ casual: '/casual', '3daypass': '/3daypass', '10pack': '/10pack', '3months': '/3months' });

/** Where a finished form should return to, taken from ?return= */
export function returnPathAfterForm(search) {
  const raw = new URLSearchParams(search || '').get('return') || '';
  return Object.prototype.hasOwnProperty.call(RETURN_PATHS, raw) ? RETURN_PATHS[raw] : null;
}

/** The ?return= key itself, so a handoff can carry it to the next form. */
export function returnKeyAfterForm(search) {
  const raw = new URLSearchParams(search || '').get('return') || '';
  return Object.prototype.hasOwnProperty.call(RETURN_PATHS, raw) ? raw : null;
}

export function formPath(slug, nextSlug = null, returnKey = null) {
  const query = new URLSearchParams();
  if (SLUG_PATTERN.test(String(nextSlug || ''))) query.set('next', String(nextSlug));
  // A questionnaire that hands off to the agreement has to carry the page that
  // sent them, or finishing the agreement leaves them stranded on a thank-you
  // screen half way through paying.
  if (returnKey && Object.prototype.hasOwnProperty.call(RETURN_PATHS, returnKey)) query.set('return', returnKey);
  const search = query.size ? `?${query}` : '';
  return `/forms/${encodeURIComponent(slug)}${search}`;
}

// A form used to be gated behind its prerequisite: open the agreement and you
// were redirected to the questionnaire first. That made the agreement's own
// link unshareable — sending it to somebody who only had to sign the terms
// opened a questionnaire instead. The relationship is kept for the direction
// it is actually useful in: finishing the questionnaire hands over to the
// agreement, which is what `follow_on_slug` reads off the same link.
