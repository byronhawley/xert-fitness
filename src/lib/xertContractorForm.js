// ─── Independent Contractor Agreement, as a form ────────────────────────────
// The digital version of the paper agreement personal and group trainers sign.
// Every blank on the paper is a field here, every tick box is a real tick box,
// and the two signature lines are real signatures — so a completed response is
// the whole agreement rather than a record that one was signed somewhere else.
//
// Field IDs are permanent: a submitted response keeps a snapshot referencing
// them forever, so renaming one would orphan every agreement already signed.
//
// Apply changes with: node scripts/apply-xert-contractor-form.mjs --apply

import { field, required, section, statement, validateXertFormDefinition } from './xertFormFields.js';
import {
  XERT_CONTRACTOR_BUSINESS_TYPES, XERT_CONTRACTOR_PARTIES, XERT_CONTRACTOR_QUALIFICATIONS,
  XERT_CONTRACTOR_SECTIONS,
  XERT_CONTRACTOR_SERVICES, XERT_CONTRACTOR_SUBTITLE, XERT_CONTRACTOR_TITLE,
  contractorSectionText,
} from './xertContractorAgreement.js';

export const CONTRACTOR_ACCEPT_OPTION = 'I accept this agreement';
export const CONTRACTOR_DECLINE_OPTION = 'I decline';
export const CONTRACTOR_MARKETING_YES = 'Yes, I consent';
export const CONTRACTOR_MARKETING_NO = 'No, I do not consent';

function partyQuestions() {
  return [
    section('ic-00-parties', XERT_CONTRACTOR_TITLE, XERT_CONTRACTOR_SUBTITLE),
    statement('ic-00-parties-text', XERT_CONTRACTOR_PARTIES),
    // The paper form has one ruled line per detail. Each is its own field so
    // the record reads back as the agreement does, not as a block of text.
    required('ic-01-name', 'name_fields', 'Your first and last name', { prefill: 'name' }),
    required('ic-02-address', 'address', 'Your address'),
    required('ic-03-abn', 'short_text', 'A.B.N.', {
      description: 'Your Australian Business Number, as an independent contractor.',
    }),
    field('ic-04-business-name', 'short_text', 'Business name', {
      description: 'If you trade under one. Leave blank if you do not.',
    }),
    // Asked alongside the business name rather than folded into it, because
    // the company type is what tells us who we are actually contracting with.
    field('ic-04b-business-type', 'single_choice', 'Is the business a company?', {
      options: [...XERT_CONTRACTOR_BUSINESS_TYPES],
      description: 'Only if you trade under a registered company. Leave blank if you are a sole trader.',
    }),
    // Both were given at the start of the form, so the contractor can tick
    // rather than type them again.
    required('ic-05-phone', 'phone', 'Phone number', { prefill: 'phone', allow_already_provided: true }),
    required('ic-06-email', 'email', 'Email address', { prefill: 'email', allow_already_provided: true }),
  ];
}

function qualificationQuestions() {
  return [
    section(
      'ic-07-qualifications',
      'Qualifications and certificates',
      'Tick everything you hold and keep current. You will present a hard copy for XERT Fitness to photograph, or email info@xertfitness.com.au, or SMS a digital copy.',
    ),
    required('ic-08-qualifications', 'multiple_choice', 'Which do you hold and keep current?', {
      options: [...XERT_CONTRACTOR_QUALIFICATIONS],
      description: 'Tick every one that applies to the service you are providing.',
    }),
    statement(
      'ic-09-qualifications-lapse',
      'You understand that you will not be able to work with Xert Fitness if your qualifications are not kept up to date throughout the duration of your relationship with us. We will notify you of any lapse in writing as soon as it is brought to our attention, and will advise you of the period of time within which you must update them in order to uphold this agreement.',
    ),
    required('ic-09-service', 'single_choice', 'Which service do you intend to provide to Xert Fitness?', {
      options: [...XERT_CONTRACTOR_SERVICES],
      description: 'Changing this later requires a new copy of this agreement to be signed.',
    }),
  ];
}

function agreementBlocks() {
  const blocks = [];
  for (const item of XERT_CONTRACTOR_SECTIONS) {
    blocks.push(section(item.id, item.title));
    const body = contractorSectionText(item);
    if (body) blocks.push(statement(`${item.id}-text`, body));
  }
  return blocks;
}

function signingQuestions(total) {
  // Skip destinations are one-based against the whole field list and may only
  // jump forward, so declining lands past the end of the form.
  const end = total + 1;
  return [
    // No "Your decision" heading here. The acceptance question says plainly
    // enough what it is, and a section break in front of it only pushed the
    // question itself further down the page.
    required('ic-91-accept', 'single_choice', 'Do you accept this Independent Contractor Agreement?', {
      description: 'By accepting, you confirm you have raised any concerns about any part of this agreement, and you agree to commence the relationship from the date you sign below.',
      options: [CONTRACTOR_ACCEPT_OPTION, CONTRACTOR_DECLINE_OPTION],
      skip_rules: [{ option: CONTRACTOR_DECLINE_OPTION, skip_to: end }],
    }),
    required('ic-92-contractor-name', 'short_text', 'Independent contractor first and last name', {
      prefill: 'name',
      description: 'The contractor this agreement applies to.',
    }),
    required('ic-93-contractor-signature', 'signature', 'Independent contractor signature', {
      description: 'Sign with your finger, mouse or Apple Pencil.',
    }),
    required('ic-94-commencement', 'date', 'Date signed', {
      default_today: true,
      description: 'This agreement commences on this date and continues until terminated in accordance with it.',
    }),
    required('ic-95-marketing', 'single_choice', 'Do you consent to being featured in XERT Fitness marketing material?', {
      description: 'We sometimes film or photograph in the Club. Consenting allows us to use your image in promotional and other business related marketing material. You can tell us in writing at any time if you change your mind.',
      options: [CONTRACTOR_MARKETING_YES, CONTRACTOR_MARKETING_NO],
    }),
    // Byron signs every copy of this agreement for XERT Fitness. His signature
    // is signed in advance: the contractor sees it already on the form, and the
    // database writes it into every accepted response, so the record, the PDF
    // and the emailed copy all carry both signatures.
    section('ic-96-owner', 'For XERT Fitness', 'Signed by the owner for XERT Fitness.'),
    statement(
      'ic-97-owner-details',
      'Byron Hawley, Owner. Phone 0431 676 053. Email info@xertfitness.com.au.',
    ),
    field('ic-98-owner-signature', 'signature', 'Signed for XERT Fitness', {
      description: 'Byron Hawley, Owner.',
      signed_by: 'byron-hawley',
    }),
  ];
}

const parties = partyQuestions();
const qualifications = qualificationQuestions();
const blocks = agreementBlocks();
const lead = parties.length + qualifications.length + blocks.length;
// Eight signing fields now the decision heading has gone, and the decline
// branch jumps past the end of the whole list, so this has to count.
const questions = [...parties, ...qualifications, ...blocks, ...signingQuestions(lead + 8)];

export const XERT_CONTRACTOR_FORM_DEFINITION = Object.freeze({
  title: XERT_CONTRACTOR_TITLE,
  description: 'The agreement between XERT Fitness and an independent personal or group trainer. Read it through, fill in your details, then accept and sign. Your answers, the date and your signature are recorded together.',
  form_type: 'waiver',
  slug: 'contractor-agreement',
  questions,
  show_progress_bar: true,
  thank_you_message: 'Thanks — your agreement has been recorded with today’s date, and a copy is on its way to your email. Byron will be in touch about anything still to arrange.',
  collect_name: true,
  collect_name_required: true,
  collect_email: true,
  collect_email_required: true,
  collect_phone: true,
  collect_phone_required: true,
  one_response_per_email: false,
  notify_admin: true,
  email_copy_to_respondent: true,
  // The whole agreement, not just the answers: it is what they signed.
  email_pdf_copy: true,
  tags: ['contractor', 'agreement', 'trainers'],
});

export function validateXertContractorFormDefinition(definition = XERT_CONTRACTOR_FORM_DEFINITION) {
  return validateXertFormDefinition(definition);
}
