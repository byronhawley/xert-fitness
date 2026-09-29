// ─── Dates that start on today ──────────────────────────────────────────────
// The date a form is signed is nearly always the day it is filled in, so a
// date field for it opens already set to today. It is an ordinary answer from
// then on: they can change it, and it is checked and stored like any date.
//
// A field says so with `default_today`. Left unset, a date field decides from
// its wording: "Date signed", "Signature date", "Date of signing", "Today's
// date", or a plain "Date" straight after a signature. That covers every form
// already built without anybody having to open it. Switching it off in the
// builder saves `default_today: false`, which the wording never overrides.

// "Date signed up" is when somebody joined, not when they signed this.
const SIGNING_DATE = /\b(?:date\s+(?:of\s+)?sign(?:ed|ing|ature)(?!\s+up)|sign(?:ed|ing|ature)\s+date|signed\s+on|today[’']?s\s+date)\b/i;
const PLAIN_DATE = /^\s*date\s*:?\s*$/i;
const LAYOUT_TYPES = new Set(['section_break', 'statement']);

/** Today in the respondent's own time zone, the way a date input holds it. */
export function localDateISO(now = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whether this date field's wording reads as the day something was signed. */
export function readsAsSigningDate(field, previous = null) {
  if (field?.type !== 'date') return false;
  const wording = String(field.question || '');
  if (/birth/i.test(wording)) return false;
  if (SIGNING_DATE.test(wording)) return true;
  return PLAIN_DATE.test(wording) && previous?.type === 'signature';
}

/** The ids of the date fields that open set to today, in a whole form. */
export function todayDateFieldIDs(questions) {
  const ids = new Set();
  let previous = null;
  for (const field of Array.isArray(questions) ? questions : []) {
    if (!field || LAYOUT_TYPES.has(field.type)) continue;
    if (field.type === 'date') {
      const starts = field.default_today === true
        || (field.default_today !== false && readsAsSigningDate(field, previous));
      if (starts) ids.add(field.id);
    }
    previous = field;
  }
  return ids;
}

/**
 * The answers a run through the form starts with: today, for each date field
 * that opens on it. A hidden field is never shown, so it is never given one;
 * one that ends up skipped is dropped with every other skipped answer before
 * the form is sent.
 */
export function todayAnswers(questions, now = new Date()) {
  const ids = todayDateFieldIDs(questions);
  const today = localDateISO(now);
  return Object.fromEntries((Array.isArray(questions) ? questions : [])
    .filter(field => field && ids.has(field.id) && !field.hidden)
    .map(field => [field.id, today]));
}
