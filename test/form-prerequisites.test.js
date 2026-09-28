import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FORM_COMPLETION_TTL_MS, ageInYears, completionIdentity, formPath, minorStatus, nextFormSlug,
  readFormCompletion, returnPathAfterForm, writeFormCompletion,
} from '../src/lib/formPrerequisites.js';
import * as formPrerequisites from '../src/lib/formPrerequisites.js';
import { XERT_TERMS_FORM_DEFINITION, XERT_TERMS_FORM_PREREQUISITE_ID, validateXertTermsFormDefinition } from '../src/lib/xertTermsForm.js';
import { XERT_PEQ_FORM_ID } from '../src/lib/xertPeqForm.js';
import { XERT_TERMS_SECTIONS } from '../src/lib/xertTermsAgreement.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const fakeStorage = () => {
  const data = new Map();
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value) };
};

test('a form link opens that form, whatever comes before it', async () => {
  // The agreement used to be gated behind the questionnaire, which made its own
  // link unshareable: sending it to somebody who only had to sign the terms
  // opened a questionnaire instead. A prerequisite says what leads here, not
  // what bars the door.
  assert.equal(formPrerequisites.prerequisiteRedirect, undefined,
    'the gate is gone, not merely unused');
  const page = await read('../src/pages/PublicForm.jsx');
  assert.ok(!page.includes('gatePath'), 'the page must not redirect away from a form somebody opened');
  assert.ok(!page.includes('comes first.'), 'nor hold them on a screen explaining why');

  // The hand-off the other way is the whole point of the relationship, and
  // stays: finishing the questionnaire opens the agreement.
  assert.equal(nextFormSlug('?next=terms-and-conditions'), 'terms-and-conditions');
  assert.match(page, /nextFormSlug\(search\) \|\| form\.follow_on_slug/);
});

test('a completion marker expires, and a form without a prerequisite is never gated', () => {
  const storage = fakeStorage();
  writeFormCompletion('peq', { name: 'Cherie' }, { storage, now: 1_000 });
  assert.equal(readFormCompletion('peq', { storage, now: 1_000 + FORM_COMPLETION_TTL_MS + 1 }), null);
  assert.equal(readFormCompletion('peq', { storage, now: 0 }), null, 'a marker from the future is ignored');
});

test('untrusted next and slug values can never become a path', () => {
  assert.equal(nextFormSlug('?next=../admin'), null);
  assert.equal(nextFormSlug('?next=https://evil.example'), null);
  assert.equal(nextFormSlug(''), null);
  assert.equal(formPath('peq'), '/forms/peq');
  assert.equal(formPath('peq', '../admin'), '/forms/peq');
});

test('the name, email and phone already given are carried to the next form', () => {
  const questions = [
    { id: 'blank', type: 'name_fields' },
    { id: 'name', type: 'name_fields' },
    { id: 'email', type: 'email' },
    { id: 'phone', type: 'phone' },
  ];
  const answers = { blank: { first: '  ' }, name: { first: 'Cherie', last: 'Ashby' }, email: ' Cherie@Bigpond.com ', phone: '0400 000 000' };
  assert.deepEqual(completionIdentity(questions, answers, {}), {
    name: 'Cherie Ashby', email: 'cherie@bigpond.com', phone: '0400 000 000', date_of_birth: '',
  });
  assert.deepEqual(completionIdentity([], {}, { name: ' Dene ', email: 'INFO@XERTFITNESS.COM.AU' }), {
    name: 'Dene', email: 'info@xertfitness.com.au', phone: '', date_of_birth: '',
  });
});

test('the date of birth on the questionnaire decides who needs a guardian', () => {
  const today = new Date('2026-09-04T00:00:00Z');
  assert.equal(ageInYears('2008-09-04', today), 18, 'turning 18 today counts as an adult');
  assert.equal(minorStatus({ date_of_birth: '2008-09-04' }, today), 'adult');
  assert.equal(minorStatus({ date_of_birth: '2008-09-05' }, today), 'minor', 'one day short of 18');
  assert.equal(minorStatus({ date_of_birth: '2010-01-01' }, today), 'minor');
  // Never guess: an unusable date leaves the guardian fields askable.
  assert.equal(minorStatus({ date_of_birth: '' }, today), 'unknown');
  assert.equal(minorStatus({ date_of_birth: 'sometime' }, today), 'unknown');
  assert.equal(minorStatus({ date_of_birth: '2027-01-01' }, today), 'unknown', 'a future date proves nothing');
  assert.equal(minorStatus(null, today), 'unknown');

  const dated = [{ id: 'dob', type: 'date', question: 'Date of birth' }, { id: 'signed', type: 'date', question: 'Date signed' }];
  const identity = completionIdentity(dated, { dob: '2010-09-05', signed: '2026-09-04' }, {});
  assert.equal(identity.date_of_birth, '2010-09-05', 'the birthday travels, not the signing date');
});

test('the guardian questions follow that answer instead of asking again', async () => {
  const { XERT_TERMS_FORM_DEFINITION } = await import('../src/lib/xertTermsForm.js');
  const guardians = XERT_TERMS_FORM_DEFINITION.questions.filter(question => question.minor_only);
  assert.equal(guardians.length, 2);
  assert.ok(guardians.every(question => question.required === false),
    'the database must accept an adult submission that omits them');

  const source = await read('../src/pages/PublicForm.jsx');
  assert.match(source, /const audience = useMemo\(\s*\(\) => minorStatus\(\{ date_of_birth: answeredBirthday \|\| carried\?\.date_of_birth \|\| '' \}\)/);
  // Positions in the published definition drive the skip destinations, so a
  // question that does not apply is skipped rather than removed from the list.
  // "Not asked yet" is not a reason to ask for a guardian: the agreement's own
  // link is shared on its own, so there is often no questionnaire behind it.
  assert.match(source, /audience === 'minor' \? \[\] : formItems\.filter\(item => item\.minor_only\)\.map\(item => item\.id\)/,
    'a guardian is asked for only once we know the member is under 18');
  assert.match(source, /buildPublicFormSteps\(formItems, answers, notApplicable\)/);
  assert.match(source, /question\?\.minor_only && audience === 'minor'/,
    'a member under 18 cannot continue without one');
  assert.match(source, /const birthday = \(form\?\.questions \|\| \[\]\)\.find\(item => item\.type === 'date' && \/birth\/i\.test/,
    'a form that asks for a date of birth uses its own answer');
  assert.match(source, /answeredBirthday \|\| carried\?\.date_of_birth/,
    'and otherwise the one carried from the form before it');

  // Both questionnaires ask a guardian to sign; only the membership one leads
  // to the agreement, which asks again in its own right.
  const { XERT_CASUAL_PEQ_FORM_DEFINITION, XERT_PEQ_FORM_DEFINITION } = await import('../src/lib/xertPeqForm.js');
  assert.equal(XERT_CASUAL_PEQ_FORM_DEFINITION.slug, 'peq-casual');
  for (const definition of [XERT_PEQ_FORM_DEFINITION, XERT_CASUAL_PEQ_FORM_DEFINITION]) {
    assert.equal(definition.questions.filter(question => question.minor_only).length, 2);
  }
  const followOn = await read('../supabase/migrations/20260904020000_form_follow_on.sql');
  assert.match(followOn, /where n\.prerequisite_form_id = f\.id/, 'a form knows what follows it');
  assert.match(source, /nextFormSlug\(search\) \|\| form\.follow_on_slug \|\| null/,
    'opening the questionnaire directly still leads to the agreement');
  assert.match(source, /A parent or guardian must complete this for a member under 18\./);
});

test('the terms form is the agreement, gated behind the PEQ, ending in accept or decline', async () => {
  const definition = XERT_TERMS_FORM_DEFINITION;
  assert.equal(validateXertTermsFormDefinition(), null);
  assert.equal(definition.slug, 'terms-and-conditions', 'the printed QR code points here');
  assert.equal(XERT_TERMS_FORM_PREREQUISITE_ID, XERT_PEQ_FORM_ID);
  assert.ok(definition.collect_name_required && definition.collect_email_required);

  const ids = definition.questions.map(question => question.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const section of XERT_TERMS_SECTIONS) {
    assert.ok(ids.includes(section.id), `${section.title} is missing from the form`);
  }

  const accept = definition.questions.find(question => question.id === 'tc-accept');
  assert.ok(accept.required);
  assert.deepEqual(accept.options, ['I accept the Terms and Conditions', 'I decline']);
  assert.deepEqual(accept.skip_rules, [{ option: 'I decline', skip_to: definition.questions.length + 1 }],
    'declining ends the form instead of asking for a signature');
  // The agreement asks for the date of birth itself. It used to rely on the
  // questionnaire's answer, so once its own link became shareable it could not
  // tell an adult from a minor and showed everybody a guardian question
  // captioned "asked because the member is under 18".
  const birthday = definition.questions.find(question => question.id === 'tc-date-of-birth');
  assert.equal(birthday.type, 'date');
  assert.equal(birthday.required, true, 'it decides whether a guardian must sign');
  assert.equal(birthday.prefill, 'date_of_birth', 'still filled in from the questionnaire when there is one');
  const guardianName = definition.questions.find(question => question.id === 'tc-guardian-name');
  const guardianSignature = definition.questions.find(question => question.id === 'tc-guardian-signature');
  assert.equal(guardianName.required, false);
  assert.equal(guardianSignature.required, false);
  assert.match(guardianName.description, /because the member is under 18/);
  const heading = definition.questions.find(question => question.id === 'tc-00-agreement');
  assert.equal(heading.content, 'XERT Fitness Terms and Conditions', 'no date in the heading to go stale');
  // The signature block reads as it does on paper: the member is named, then
  // signs, and only then is a guardian asked for a name and a signature.
  // The date of birth sits before the guardian questions, so by the time those
  // are reached the form knows whether to ask them at all.
  assert.deepEqual(
    definition.questions.slice(-5).map(question => question.id),
    ['tc-member-name', 'tc-signature', 'tc-date-of-birth', 'tc-guardian-name', 'tc-guardian-signature'],
  );
  const memberName = definition.questions.find(question => question.id === 'tc-member-name');
  assert.equal(memberName.required, true);
  assert.equal(memberName.prefill, 'name', 'carried from the questionnaire rather than typed twice');
  const source = await read('../src/pages/PublicForm.jsx');
  assert.match(source, /\.filter\(item => item\.prefill && details\[item\.prefill\]\)/);
  assert.equal(definition.questions.find(question => question.id === 'tc-signature').type, 'signature');
});

test('signed responses stay on the form that collected them', async () => {
  // Submitted records are immutable by design: the database refuses to move a
  // response between forms. The terms form therefore keeps the id that has
  // been collecting signed agreements since August 2026, and the PEQ was given
  // a record of its own rather than the history being rewritten.
  const { XERT_TERMS_FORM_ID } = await import('../src/lib/xertTermsForm.js');
  assert.equal(XERT_TERMS_FORM_ID, '0173f880-7bee-4a2e-bb0c-ac15af40ad9e');
  assert.notEqual(XERT_PEQ_FORM_ID, XERT_TERMS_FORM_ID);

  const guard = await read('../supabase/migrations/20260813010000_xert_form_response_snapshots.sql');
  assert.match(guard, /new\.form_id is distinct from old\.form_id/);
  assert.match(guard, /Submitted form records are immutable/);

  // An exported record must show the questions its respondent actually saw.
  const forms = await read('../src/lib/xertForms.js');
  assert.match(forms, /export function responseCSVColumns\(form, responses\)/);
  assert.match(forms, /const snapshot = response\?\.form_snapshot;/);
  assert.match(forms, /'archived_at', 'form_snapshot'/);
});

test('the published agreement and the signed agreement come from one module', async () => {
  // The public terms page and the signed agreement are one document.
  const page = await read('../src/pages/Terms.jsx');
  assert.match(page, /XERT_TERMS_SECTIONS/);
  assert.match(page, /title="Terms And Conditions"/);
  assert.match(page, /nothing is signed here/, 'the published copy must not read as a document to sign');
  assert.doesNotMatch(page, /TERMS_DEFAULTS|useSiteContent/, 'a signed document is not CMS copy');
  const app = await read('../src/App.jsx');
  assert.match(app, /path="\/membership-terms" element=\{<Navigate to="\/terms" replace \/>\}/,
    'the old address still lands on the agreement');
  const footer = await read('../src/components/public/PublicFooter.jsx');
  assert.match(footer, /Terms &amp; Conditions/);
  const metadata = await read('../src/lib/pageMetadata.js');
  assert.match(metadata, /'\/terms': \{ title: 'Terms and Conditions \| XERT Fitness'/);
  const contentManager = await read('../src/components/admin/ContentManager.jsx');
  assert.doesNotMatch(contentManager, /viewPath: '\/terms'/, 'Site Content must not offer to edit a signed agreement');
  const agreement = await read('../src/lib/xertTermsAgreement.js');
  assert.match(agreement, /ABN 65 327 079 634/);
  assert.match(agreement, /XERT FITNESS MEMBERSHIP OPTIONS/, 'the membership table image is transcribed as text');
  assert.match(agreement, /48 HOUR COOLING OFF PERIOD/);
  // The paper form's ruled signature block has no place in the digital one:
  // the form captures the name, date and signature as real fields, and the
  // long rules forced the reading panel to scroll sideways on a phone.
  assert.doesNotMatch(agreement, /Member Signature: _+/);
  assert.doesNotMatch(agreement, /Guardian Signature: _+/);
  assert.doesNotMatch(agreement, /_{10,}/, 'no ruled lines from the paper form');
  const form = await read('../src/pages/PublicForm.jsx');
  assert.match(form, /overflow-y-auto overflow-x-hidden/);
  // The agreement keeps its line breaks and wraps long words, through the one
  // renderer all owner-written form text uses.
  assert.match(form, /<FormText text=\{title\} className="text-sm leading-relaxed/);
  const formText = await read('../src/components/public/FormText.jsx');
  assert.match(formText, /break-words/);
  assert.match(formText, /whitespace-pre-wrap/);
});

test('the public form page hands over and carries details across', async () => {
  const source = await read('../src/pages/PublicForm.jsx');
  const storage = fakeStorage();
  writeFormCompletion('peq-casual', { ...completionIdentity([], {}, { name: 'Casey Example', email: 'casey@example.test' }), response_id: '11111111-1111-4111-8111-111111111111' }, { storage });
  assert.equal(readFormCompletion('peq-casual', { storage }).response_id, '11111111-1111-4111-8111-111111111111');
  assert.match(source, /const handoff = nextFormSlug\(search\)/);
  assert.match(source, /readFormCompletion\(data\.prerequisite_slug\)/);
  assert.match(source, /role="region"/, 'a long agreement scrolls inside its own panel');
  assert.match(source, /Dated <time dateTime=/, 'a signature shows the date it is being given');

  const sql = await read('../supabase/migrations/20260904010000_form_prerequisites.sql');
  assert.match(sql, /add column if not exists prerequisite_form_id uuid references public\.xert_forms\(id\) on delete set null/);
  assert.match(sql, /check \(prerequisite_form_id is null or prerequisite_form_id <> id\)/);
  assert.match(sql, /prerequisite_slug text/);
  assert.match(sql, /on p\.id = f\.prerequisite_form_id and p\.is_active = true and p\.archived_at is null/,
    'a paused prerequisite must not lock people out');

  const forms = await read('../src/lib/xertForms.js');
  assert.match(forms, /'tags', 'prerequisite_form_id'/);
  const manager = await read('../src/components/admin/FormsSurveysManager.jsx');
  assert.match(manager, /Complete this form first/);
});

test('a form can hand back to the page that sent someone to it, but only a page we own', async () => {
  assert.equal(returnPathAfterForm('?return=casual'), '/casual');
  assert.equal(returnPathAfterForm(''), null);
  assert.equal(returnPathAfterForm('?next=terms-and-conditions'), null);

  // A crafted link must never bounce anyone off the site or onto another form.
  assert.equal(returnPathAfterForm('?return=https://evil.example.com'), null);
  assert.equal(returnPathAfterForm('?return=//evil.example.com'), null);
  assert.equal(returnPathAfterForm('?return=/admin'), null);
  assert.equal(returnPathAfterForm('?return=constructor'), null, 'inherited keys are not paths');

  // The chained form still wins: a questionnaire that gates the agreement
  // hands over to it, and only a form with nothing after it goes back.
  const page = await read('../src/pages/PublicForm.jsx');
  const handoff = page.indexOf('if (handoff && handoff !== slug)');
  const back = page.indexOf('returnPathAfterForm(search)');
  assert.ok(handoff > 0 && back > handoff, 'the follow-on form is offered first');
  assert.match(page, /if \(returnPath\) \{ setHandingOver\(true\); navigate\(returnPath, \{ replace: true \}\); return; \}/);
});

test('the agreement alone can tell an adult from a minor, and asks accordingly', async () => {
  const { XERT_TERMS_FORM_DEFINITION } = await import('../src/lib/xertTermsForm.js');
  const { buildPublicFormSteps } = await import('../src/lib/formBranching.js');
  const { minorStatus } = await import('../src/lib/formPrerequisites.js');

  const items = XERT_TERMS_FORM_DEFINITION.questions;
  const guardianIDs = items.filter(item => item.minor_only).map(item => item.id);
  // What PublicForm does with the audience, exercised against the real form.
  const stepIDs = audience => {
    const omitted = audience === 'minor' ? [] : guardianIDs;
    return buildPublicFormSteps(items, {}, omitted).steps
      .map(step => step.question?.id).filter(Boolean);
  };

  // Somebody who opens the agreement on its own and has answered nothing yet:
  // this is the state that used to show an adult a guardian question captioned
  // "asked because the member is under 18".
  assert.equal(minorStatus({ date_of_birth: '' }), 'unknown');
  for (const id of guardianIDs) {
    assert.ok(!stepIDs('unknown').includes(id), `${id} must not be asked before we know`);
    assert.ok(!stepIDs('adult').includes(id), `${id} must never be asked of an adult`);
    assert.ok(stepIDs('minor').includes(id), `${id} must be asked of a member under 18`);
  }

  // The date of birth is asked before them, so by the time they could appear
  // the form knows whether to ask at all.
  const order = stepIDs('minor');
  assert.ok(order.indexOf('tc-date-of-birth') < order.indexOf(guardianIDs[0]));
  assert.equal(minorStatus({ date_of_birth: '1990-04-02' }), 'adult');
  assert.equal(minorStatus({ date_of_birth: new Date().toISOString().slice(0, 10) }), 'minor');
});

test('the signed copy carries the signature as an attachment, not the word Signed', async () => {
  const sql = await read('../supabase/migrations/20260924010000_signed_copy_carries_the_signature.sql');

  // A data: image source is dropped by Gmail and Outlook, so an inline
  // signature would be a broken box for most people. An attachment opens
  // anywhere and can be kept.
  assert.match(sql, /create or replace function public\.form_response_signatures\(p_response_id uuid\)/);
  assert.match(sql, /'content_type', 'image\/png'/);
  assert.match(sql, /like 'data:image\/png;base64,%'/, 'anything that is not a PNG data URI is left out');
  assert.match(sql, /p_attachments jsonb default null/, 'existing callers keep working unchanged');
  assert.match(sql, /jsonb_build_object\('attachments', p_attachments\)/);
  // Two overloads would leave positional callers silently sending no signature.
  assert.match(sql, /drop function if exists public\.queue_email\(text, text, text, text, text, text, text\)/);
  assert.match(sql, /raise exception 'Signatures must not be readable by anon\.'/);
});
