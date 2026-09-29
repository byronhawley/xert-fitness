// People who sign a form in advance, for XERT Fitness, on every copy of it.
//
// A signature field marked `signed_by` is not asked of the person filling the
// form in. They see it already signed, and the database writes the signature
// into every response it accepts, so the admin record, the printed and PDF
// copies, the iOS record and the emailed copy all carry it. The picture here
// is what the form shows; the database holds the same PNG as a data URI in
// xert_form_signatories, which is what gets written into the response.
//
// Adding somebody is two steps: an entry here and a row in that table.

export const FORM_SIGNATORIES = Object.freeze({
  'byron-hawley': Object.freeze({
    key: 'byron-hawley',
    name: 'Byron Hawley',
    role: 'Owner, XERT Fitness',
    image: '/assets/signatures/byron-hawley.png',
  }),
});

/** Who has signed this field in advance, or null when the respondent signs it. */
export function formSignatory(field) {
  if (field?.type !== 'signature' || !field?.signed_by) return null;
  return FORM_SIGNATORIES[field.signed_by] || null;
}

/** Why a field's sign-off cannot be saved, in words the builder can show. */
export function signOffProblem(field) {
  const named = field?.signed_by;
  if (named === undefined || named === null || named === '') return null;
  if (field.type !== 'signature') return 'Only a signature field can be signed in advance.';
  if (!FORM_SIGNATORIES[named]) return 'A sign-off names somebody who cannot sign in advance. Choose who signs it again.';
  if (field.required) return 'A field signed in advance cannot also be required of the person filling it in.';
  return null;
}
