import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('forms schema is public-submit bounded and owner-administered without client linking or draws', async () => {
  const sql = await read('../supabase/migrations/20260811010000_xert_forms_surveys.sql');
  assert.match(sql, /create table if not exists public\.xert_forms/);
  assert.match(sql, /create table if not exists public\.xert_form_responses/);
  assert.match(sql, /create or replace function public\.xert_public_form/);
  assert.match(sql, /create or replace function public\.submit_xert_form_response/);
  assert.match(sql, /jsonb_array_length\(jsonb_path_query_array\(p_answers, '\$\.\*'\)\) > 100/);
  assert.match(sql, /octet_length\(p_answers::text\) > 524288/);
  assert.match(sql, /v_form\.one_response_per_email/);
  assert.match(sql, /Please complete every required question/);
  assert.match(sql, /using \(\(select public\.is_admin\(\)\)\)/);
  assert.doesNotMatch(sql, /client_profile|competition|spinner|wheel/i);
});

test('desktop command centre exposes the full responsive builder and analytics workflow', async () => {
  const [manager, publicPage, data, app, navigation] = await Promise.all([
    read('../src/components/admin/FormsSurveysManager.jsx'),
    read('../src/pages/PublicForm.jsx'),
    read('../src/lib/xertForms.js'),
    read('../src/App.jsx'),
    read('../src/lib/adminNavigation.js'),
  ]);
  assert.match(app, /path="\/forms\/:slug"/);
  assert.match(navigation, /'forms'/);
  for (const feature of ['Skip logic', 'Share form', 'Export CSV', 'Duplicate and edit', 'Archive form']) {
    assert.match(manager, new RegExp(feature));
  }
  assert.match(manager, /forwardDestinations[\s\S]*Jump to Q[\s\S]*End form/);
  assert.match(manager, /hasInvalidSkipRules[\s\S]*Clear obsolete skip rules/);
  assert.doesNotMatch(manager, /aria-label=\{`Skip destination[^\n]*type="number"/);
  // The rule itself lives in formBranching.js and is covered by behaviour in
  // form-skip-logic-diagnosis.test.js. What matters here is that the builder's
  // validator delegates to it rather than keeping a second copy that can drift.
  assert.match(data, /skipRuleProblems\(questions\)/);
  assert.match(data, /Skip logic: \$\{problem\.message\}/);
  for (const type of ['short_text', 'multiple_choice', 'star_rating', 'nps', 'signature', 'address', 'file_upload']) {
    assert.match(data, new RegExp(`['"]${type}['"]`));
  }
  assert.match(publicPage, /role="radiogroup"/);
  assert.match(publicPage, /autoComplete="street-address"/);
  assert.match(publicPage, /SignatureInput/);
  assert.match(publicPage, /strokeStyle = resolveSemanticColor\('signature.ink'\)/);
  assert.match(publicPage, /aria-label="Signature pad"[^>]*bg-white/);
  assert.match(publicPage, /submitPublicForm/);
  assert.doesNotMatch(manager, /Copy embed|<iframe/);
  assert.doesNotMatch(manager, /CompetitionDrawWheel|SendFormToClient|client_profile/i);
  assert.match(data, /FORM_RESPONSE_LIST_FIELDS[\s\S]*\.range\(from, from \+ FORM_RESPONSE_PAGE_SIZE - 1\)/);
  assert.match(data, /export async function getFormResponse[\s\S]*\.select\('\*'\)/);
  assert.match(manager, /getFormResponse\(selectedResponseID\)/);
});

test('native command centre has a first-class forms workspace and editor', async () => {
  const [navigation, commandCentre, view, models, api] = await Promise.all([
    read('../ios/XertFitnessApp/XertFitnessApp/OwnerNavigation.swift'),
    read('../ios/XertFitnessApp/XertFitnessApp/Views/AdminCommandCentreView.swift'),
    read('../ios/XertFitnessApp/XertFitnessApp/Views/AdminFormsView.swift'),
    read('../ios/XertFitnessApp/XertFitnessApp/AdminModels.swift'),
    read('../ios/XertFitnessApp/XertFitnessApp/Services/XertAPI.swift'),
  ]);
  assert.match(navigation, /case forms/);
  assert.match(
    commandCentre,
    /case \.forms:[\s\S]*AdminFormsView\([\s\S]*session: session,[\s\S]*createIntentID: \$createFormIntentID/,
  );
  assert.match(view, /struct AdminFormsView: View/);
  assert.match(view, /struct AdminFormEditorView: View/);
  assert.match(view, /Section\("Skip logic"\)/);
  assert.match(view, /ShareLink\(item: form\.publicURL/);
  assert.match(models, /struct AdminFormQuestion: Identifiable, Codable, Hashable/);
  assert.match(api, /func adminSaveForm/);
  assert.match(api, /func adminFormResponses/);
  assert.doesNotMatch(view, /client linking|competition|spinner|wheel/i);
});

test('choice breakdowns name the people behind each option', async () => {
  const source = await readFile(new URL('../src/components/admin/FormsSurveysManager.jsx', import.meta.url), 'utf8');

  // Each option keeps its respondents, not just a tally: "who said no" is the
  // question staff actually need answered.
  assert.match(source, /const people = responses\.filter\(item => \{/);
  assert.match(source, /\(Array\.isArray\(answer\) \? answer : \[answer\]\)\.map\(String\)\.includes\(String\(label\)\)/);
  assert.match(source, /return \{ label, count: people\.length, people \};/);

  // The row shows share as well as count, and opens to the names.
  assert.match(source, /function OptionBreakdown\(/);
  assert.match(source, /const share = total \? Math\.round\(\(count \/ total\) \* 100\) : 0;/);
  assert.match(source, /aria-expanded=\{isOpen\}/);
  // The label now reads the answers when a form asks for the name as one of
  // its questions rather than in a separate contact block.
  assert.match(source, /respondentLabel\(person\)/);
  assert.match(source, /href=\{`mailto:\$\{respondentIdentity\(person\)\.email\}`\}/);
  assert.match(source, /href=\{`tel:\$\{String\(respondentIdentity\(person\)\.phone\)\.replace\(\/\\s\+\/g, ''\)\}`\}/);

  // An option nobody chose cannot be opened.
  assert.match(source, /disabled=\{count === 0\}/);
  assert.match(source, /select an option to see who/);
});

test('written answers read as one table, a row per person with their name attached', async () => {
  const { answerTable, answerText, numberedAnswers } = await import('../src/lib/formAnswers.js');
  const questions = [
    { id: 'name', question: 'Full name' },
    { id: 'mobile', question: 'Mobile' },
    { id: 'notes', question: 'Anything else' },
  ];
  const responses = [
    { id: 'r1', respondent_name: 'Aleisha Collins', answers: { name: 'Collins, Aleisha', mobile: '0439570959' } },
    { id: 'r2', respondent_name: 'Jasmine Bonwick', answers: { name: 'Bonwick, Jasmine' } },
    { id: 'r3', respondent_email: 'holly@example.com', answers: { name: 'Berthold, Holly', mobile: '0467207777' } },
  ];

  const { columns, rows } = answerTable(responses, questions);

  // A question nobody answered is not a column of dashes to scroll past, and
  // the question that asked for their name is not repeated beside the person.
  assert.deepEqual(columns.map(column => column.id), ['mobile']);

  // Only an exact repeat is dropped. A question that merely mentions a name
  // for one person is a real answer and keeps its column.
  const nicknames = answerTable(
    [{ id: 'a', respondent_name: 'Aleisha Collins', answers: { who: 'Collins, Aleisha' } },
     { id: 'b', respondent_name: 'Max Eastwell', answers: { who: 'Trains with Aleisha' } }],
    [{ id: 'who', question: 'Who referred you' }],
  );
  assert.deepEqual(nicknames.columns.map(column => column.id), ['who']);

  // The name travels with the answer, which is the whole point — and Holly's
  // record has no stored name, so the one she typed is used instead of the
  // email address the record would otherwise fall back to.
  assert.deepEqual(rows.map(row => [row.number, row.person, row.cells.mobile]), [
    [1, 'Aleisha Collins', '0439570959'],
    [2, 'Jasmine Bonwick', ''],
    [3, 'Berthold, Holly', '0467207777'],
  ]);

  // Somebody who wrote nothing gets no row; a missing answer is a blank cell.
  assert.deepEqual(answerTable([{ id: 'x', answers: {} }], questions).rows, []);
  assert.deepEqual(answerTable(null, questions), { columns: [], rows: [] });

  // Composite answers stay on one line.
  assert.equal(answerText(['Strength', 'Conditioning']), 'Strength, Conditioning');
  assert.equal(answerText({ street: '27 Pound St', suburb: 'Kingaroy' }), '27 Pound St, Kingaroy');
  assert.equal(answerText(''), '');
  assert.equal(answerText(null), '');

  // The single-question helper still numbers by respondent, so a skipped answer
  // leaves a gap instead of shifting everyone below it.
  assert.deepEqual(numberedAnswers(responses, 'mobile').map(answer => answer.number), [1, 3]);

  // Rendered row/card completeness is checked in admin-forms-render.test.js;
  // browser proofs cover responsive visibility and the frozen person column.
});

test('an image answer is recognised, and ordinary text is left alone', async () => {
  const { answerImage } = await import('../src/lib/formAnswers.js');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  assert.equal(answerImage(png), png);
  // Signatures arrive with line breaks in some browsers.
  assert.equal(answerImage(`data:image/png;base64,iVBOR\n  w0KGg==`), 'data:image/png;base64,iVBORw0KGg==');
  assert.equal(answerImage('data:image/jpeg;base64,/9j/4AAQ=='), 'data:image/jpeg;base64,/9j/4AAQ==');

  for (const notAnImage of [
    'Knee injury', '', null, undefined, 42,
    // Only images: nothing here may turn an answer into an arbitrary embed.
    'data:text/html;base64,PHNjcmlwdD4=',
    'javascript:alert(1)',
    'https://example.test/signature.png',
  ]) assert.equal(answerImage(notAnImage), null, String(notAnImage));
});
