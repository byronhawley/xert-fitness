import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StaticRouter} from 'react-router-dom/server.js';

// Expose the real editor at the test boundary; no production test-only API.
const server = await createServer({configFile:false, resolve:{alias:{'@':fileURLToPath(new URL('../src', import.meta.url))}},
  plugins:[{name:'forms-render-boundary',transform(code,id){if (id.endsWith('/FormsSurveysManager.jsx')) return `${code}\nexport {FormEditor, Analytics, WrittenAnswers, DetailAsk, FormPreview, TypePicker};`;}}],
  define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://ugmkwoapjcpiucsrxwzt.supabase.co'),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_fixture_render_key_not_real')},
  optimizeDeps:{noDiscovery:true,include:[]}, server:{middlewareMode:true,watch:null}, appType:'custom'});
after(() => server.close());
const {default: FormsSurveysManager, FormEditor, Analytics, WrittenAnswers, DetailAsk, FormPreview, TypePicker} = await server.ssrLoadModule('/src/components/admin/FormsSurveysManager.jsx');
const {XERT_CONTRACTOR_FORM_DEFINITION} = await server.ssrLoadModule('/src/lib/xertContractorForm.js');
const recordModule = await server.ssrLoadModule('/src/components/admin/FormResponseRecord.jsx');
const {default: FormResponseRecord} = recordModule;
const draft = {title:'Survey',questions:[{id:'one',type:'single_choice',question:'Preferred time?',options:['Morning','Evening']}]};
const render = props => renderToStaticMarkup(React.createElement(FormEditor, {draft,setDraft:()=>{},onSave:()=>{},onCancel:()=>{},...props}));

test('written answer cards and table retain every person with their own answer beyond twenty rows', () => {
  const responses = Array.from({length:22}, (_,index) => ({id:`person-${index + 1}`,respondent_name:`Person ${index + 1}`,answers:{notes:`Written answer ${index + 1}`}}));
  const html = renderToStaticMarkup(React.createElement(WrittenAnswers, {responses,questions:[{id:'notes',question:'Notes'}]}));
  const cards = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)];
  const tableRows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].slice(1);
  assert.equal(cards.length, 22);
  assert.equal(tableRows.length, 22);
  for (const rows of [cards,tableRows]) {
    assert.match(rows[0][1], /Person 1<\//);
    assert.match(rows[0][1], /Written answer 1<\//);
    assert.match(rows[21][1], /Person 22<\//);
    assert.match(rows[21][1], /Written answer 22<\//);
  }
  assert.match(html, /<caption[^>]*>Written answers, one row per person<\/caption>/);
  assert.match(html, /role="region" aria-label="Written answers table"/);
});

test('builder names each question, type and option and disambiguates duplicate/remove controls', () => {
  const html = render({});
  for (const label of ['Question 1','Field type for question 1','Option 1 for question 1','Option 2 for question 1','Duplicate question 1','Remove question 1']) {
    assert.ok(html.includes(`aria-label="${label}"`), `Missing accessible name: ${label}`);
  }
});

test('a pending save disables the editor and its navigation while retaining typed values', () => {
  const html = render({saving:true});
  assert.match(html, /<fieldset[^>]*disabled=""/);
  assert.match(html, /value="Preferred time\?"/);
  assert.match(html, /value="Survey"/);
});

test('a legacy response without layout blocks still warns that current labels are unverified', () => {
  const response = {id:'legacy',completed_at:'2026-09-08T12:00:00Z',status:'new',answers:{q:'Yes'}};
  const html = renderToStaticMarkup(React.createElement(FormResponseRecord, {form:{title:'Current agreement',questions:[{id:'q',type:'yes_no',question:'New wording'}]},response,responses:[response]}));
  assert.match(html, /Reconstructed record — original wording unverified/);
});

test('pending form cards reserve separate title, badge and summary geometry without pretend actions', () => {
  const html = renderToStaticMarkup(React.createElement(StaticRouter, {location:'/admin/forms'}, React.createElement(FormsSurveysManager)));
  const cards = [...html.matchAll(/<article[^>]*data-form-placeholder="card"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(cards.length, 3, 'loading retains repeated form-card groups');
  for (const [, card] of cards) {
    assert.match(card, /data-size="title"/);
    assert.match(card, /forms-loading-badge/);
    assert.match(card, /data-size="medium"/);
    assert.doesNotMatch(card, /<button|<input|<select|<a\s/);
  }
});

test('pending analytics reserve each question header, count and answer rows', () => {
  const form = {...draft,id:'survey',questions:[...draft.questions,{id:'two',type:'short_text',question:'Why?'}]};
  const html = renderToStaticMarkup(React.createElement(Analytics, {form,onBack:()=>{}}));
  const questions = [...html.matchAll(/<section[^>]*data-form-placeholder="question"[^>]*>([\s\S]*?)<\/section>/g)];
  assert.equal(questions.length, 2, 'loading retains each question card');
  for (const [, question] of questions) {
    assert.match(question, /data-size="title"/);
    assert.match(question, /data-size="short"/);
    assert.equal((question.match(/data-form-placeholder="answer-row"/g) || []).length, 3);
    assert.doesNotMatch(question, /<button|<input|<select|<a\s/);
  }
});

test('pending full records reserve header, paired metadata and original-answer areas', () => {
  assert.equal(typeof recordModule.FormRecordLoading, 'function', 'full-record loading needs a composed document shape');
  const html = renderToStaticMarkup(React.createElement(recordModule.FormRecordLoading));
  assert.match(html, /role="status" aria-label="Loading full response"/);
  assert.match(html, /data-form-placeholder="record-header"/);
  assert.equal((html.match(/data-form-placeholder="metadata-item"/g) || []).length, 6);
  assert.equal((html.match(/data-form-placeholder="record-answer"/g) || []).length, 2);
  assert.doesNotMatch(html, /<button|<input|<select|<a\s/);
});

test('a signature is shown as the signature, not as its base64', () => {
  // A 1x1 PNG stands in for the real thing: what matters is the shape.
  const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const responses = [{ id: 'one', respondent_name: 'Cheryl Harb', answers: { sig: signature, notes: 'Knee injury' } }];
  const html = renderToStaticMarkup(React.createElement(WrittenAnswers, {
    responses,
    questions: [{ id: 'sig', question: 'Participant signature' }, { id: 'notes', question: 'Notes' }],
  }));

  // It used to print several hundred characters of base64 into a table cell,
  // which pushed every other column off the screen and told nobody anything.
  assert.ok(!html.includes('iVBORw0KGgo'.repeat(1) + '"') || html.includes('<img'), 'signature must render as an image');
  assert.match(html, /<img[^>]+src="data:image\/png;base64,/);
  assert.match(html, /alt="Participant signature from Cheryl Harb"/);
  assert.match(html, /class="forms-signature"/);
  // Ordinary answers are still plain text beside it.
  assert.match(html, /Knee injury/);
});

test('the answers table can take the width its columns need', () => {
  const responses = [{ id: 'one', respondent_name: 'Cheryl Harb', answers: { notes: 'Knee injury' } }];
  const html = renderToStaticMarkup(React.createElement(WrittenAnswers, {
    responses, questions: [{ id: 'notes', question: 'Notes' }],
  }));
  // A width:100% table inside the scroller squeezed every column toward
  // nothing, and overflow-wrap finished the job one character per line.
  assert.ok(!/<table[^>]*class="[^"]*\bw-full\b/.test(html), 'the table must not be forced to the container width');
});

// ─── The builder a person can actually read ────────────────────────────────
// Every field used to open fully expanded, Required sat at the bottom of each
// one, and text typed into a field that the public form never shows was kept
// without a word. These render the real editor, not its source.

const longForm = {title:'Contractor agreement',questions:[
  {id:'a',type:'short_text',question:'Business name',required:true,placeholder:'e.g. Kirra Coaching',options:[]},
  {id:'b',type:'multiple_choice',question:'Which do you hold?',required:false,options:['CPR','First aid'],placeholder:'Before signing, you confirm the below are current'},
  {id:'c',type:'section_break',content:'Qualifications',description:'Bring a copy to your first session.'},
]};
const renderForm = draftValue => renderToStaticMarkup(React.createElement(FormEditor, {draft:draftValue,setDraft:()=>{},onSave:()=>{},onCancel:()=>{}}));

test('the builder opens on the first question and shows the rest as one line each', () => {
  const html = renderForm(longForm);
  assert.ok(html.includes('aria-label="Question 1"'), 'the first question is open for editing');
  assert.ok(!html.includes('aria-label="Option 1 for question 2"'), 'a closed question does not render its editor');
  assert.match(html, /Which do you hold\?<\/button>/, 'a closed question still says what it asks');
  assert.match(html, /aria-label="Edit question 2"/);
  assert.match(html, /aria-expanded="true"[^>]*>Business name<\/button>/);
});

test('every question says whether it is required without being opened', () => {
  const html = renderForm(longForm);
  assert.match(html, /role="switch" aria-checked="true" aria-label="Question 1 is required"[^>]*>Required</);
  assert.match(html, /role="switch" aria-checked="false" aria-label="Question 2 is required"[^>]*>Optional</);
  assert.ok(!html.includes('aria-label="Question 3 is required"'), 'a heading has no answer to require');
  assert.match(html, /1 of 2 questions are marked required/);
});

test('fields are named for what they do, not for what HTML calls them', () => {
  const html = renderForm(longForm);
  assert.match(html, /What are you asking\?/);
  assert.match(html, />Hint<span class="forms-secondary">Shown under the question, in smaller text\./);
  assert.match(html, />Example answer<span class="forms-secondary">Faint text inside the answer box/);
  assert.ok(!/>Helper text</.test(html) && !/>Placeholder</.test(html));
});

test('example text on a question with no answer box is flagged, not silently kept', () => {
  const html = renderForm(longForm);
  // Closed, the heading warns; the choice question offers no example field at all.
  assert.match(html, /Unseen text/);
  const opened = renderToStaticMarkup(React.createElement(FormEditor, {draft:{...longForm,questions:[longForm.questions[1]]},setDraft:()=>{},onSave:()=>{},onCancel:()=>{}}));
  assert.match(opened, /Nobody sees this text/);
  assert.match(opened, /Before signing, you confirm the below are current/);
  assert.match(opened, />Move into hint</);
  assert.ok(!opened.includes('aria-label="Example answer for question 1"'), 'a choice question has no answer box to show it in');
});

test('the open question is previewed through the public form’s own renderer', () => {
  const html = renderForm(longForm);
  assert.match(html, /<aside aria-label="Preview of question 1"/);
  assert.match(html, /What they will see/);
  // The live form's card, and its heading markup with the required asterisk.
  assert.match(html, /<div class="xert-card p-5"><h3 id="question-a"[^>]*>Business name<span class="ml-2 text-xert-steel">\*<\/span><\/h3>/);
  // And its real answer box, carrying the example answer the owner typed.
  assert.match(html, /placeholder="e\.g\. Kirra Coaching"/);
});

test('questions are added by choosing what they are, and can be dragged into place', () => {
  const html = renderForm(longForm);
  assert.match(html, /aria-expanded="false"[^>]*><svg[\s\S]*?<\/svg> Add a question<\/button>/);
  assert.match(html, /aria-label="Drag to reorder question 1"/);
  assert.match(html, /data-rfd-drag-handle-draggable-id="a"/);
});

test('skip logic is one button until there is a rule, not a dropdown per option', () => {
  const choice = (id, skip_rules = []) => ({id,type:'single_choice',question:id,options:['A','B','C','D'],skip_rules});
  const noRules = renderForm({title:'x',questions:[choice('first'),choice('second'),choice('third')]});
  assert.match(noRules, /Set up skip logic<\/button>/);
  assert.ok(!noRules.includes('aria-label="Skip destination for A"'), 'no dropdown wall before a rule exists');
  const withRule = renderForm({title:'x',questions:[choice('first',[{option:'B',skip_to:3}]),choice('second'),choice('third')]});
  assert.ok(withRule.includes('aria-label="Skip destination for A"'), 'an existing rule shows every option in full');
  assert.ok(!withRule.includes('Set up skip logic'));
});

// ─── Dot points ────────────────────────────────────────────────────────────
// The hint was a one-line box and the form ran it together as one paragraph,
// so points typed with "•" between them read as one long sentence.

const pointed = {id:'svc',type:'single_choice',question:'Which service?',options:['Group','PT'],required:true,
  description:'A new agreement is needed when:\n• Changing from PT to Group\n• Adding Group Classes'};

test('the hint is a writing box with a Dot points button', () => {
  const html = renderForm({title:'x',questions:[pointed]});
  assert.match(html, /<textarea[^>]*aria-label="Hint for question 1"[^>]*>A new agreement is needed when:\n• Changing from PT to Group\n• Adding Group Classes<\/textarea>/);
  assert.match(html, /<\/svg> Dot points<\/button>/);
});

test('the preview shows the hint’s dot points as a list, the way the form will', () => {
  const html = renderForm({title:'x',questions:[pointed]});
  const preview = html.slice(html.indexOf('<aside aria-label="Preview of question 1"'));
  assert.match(preview, /<p class="whitespace-pre-wrap">A new agreement is needed when:<\/p><ul class="list-disc pl-5 space-y-1"><li>Changing from PT to Group<\/li><li>Adding Group Classes<\/li><\/ul>/);
});

test('a statement is written in a box that keeps its line breaks', () => {
  const html = renderForm({title:'x',questions:[{id:'s',type:'statement',content:'Please note:\n• Bring your certificates',description:''}]});
  assert.match(html, /<textarea[^>]*aria-label="Question 1"[^>]*>Please note:\n• Bring your certificates<\/textarea>/);
  assert.ok(!/<input[^>]*aria-label="Question 1"/.test(html), 'a one-line input strips the line breaks out of whatever it edits');
});

test('the signed record lays dot points out the way the person read them', () => {
  const response = {id:'r',completed_at:'2026-09-28T12:00:00Z',status:'new',answers:{svc:'PT'}};
  const html = renderToStaticMarkup(React.createElement(FormResponseRecord, {form:{title:'Contractor',questions:[pointed]},response,responses:[response]}));
  assert.match(html, /<li>Changing from PT to Group<\/li><li>Adding Group Classes<\/li>/);
});

// ─── The builder as a whole ────────────────────────────────────────────────
// A 45-field agreement used to open as 45 identical rows with Save out of
// reach at the top. These render the real editor.

test('a long form opens as an outline: every section one line, saying what it holds', () => {
  const html = renderForm(structuredClone(XERT_CONTRACTOR_FORM_DEFINITION));
  const sections = XERT_CONTRACTOR_FORM_DEFINITION.questions.filter(field => field.type === 'section_break');
  assert.equal([...html.matchAll(/class="[^"]*forms-section-card/g)].length, sections.length);
  assert.equal([...html.matchAll(/<article id="form-field-/g)].length, sections.length, 'nothing inside a folded section is drawn');
  assert.match(html, /aria-expanded="false" aria-label="XERT Fitness Independent Contractor Agreement: show the \d+ fields in it"/);
  assert.match(html, /· 2 questions · 1 text block/);
  assert.ok(!html.includes('What they will see'), 'no field is open on arrival');
  assert.match(html, /Expand all/);
});

test('a short form opens on its first question, with each section holding its fields', () => {
  const html = renderForm(longForm);
  assert.match(html, /aria-expanded="true" aria-label="Qualifications: hide the 0 fields in it"/);
  assert.match(html, /Add to this section<\/button>/, 'a section can be added to where it is, not only at the end of the form');
  assert.match(html, /forms-type-icon/, 'each question shows what kind it is');
});

test('the name, the views and Save stay in one toolbar', () => {
  const html = renderForm(longForm);
  const toolbar = html.slice(html.indexOf('class="forms-toolbar"'), html.indexOf('Save<span'));
  assert.match(toolbar, /aria-label="Form title"[^>]*value="Contractor agreement"/);
  assert.match(toolbar, /role="radiogroup" aria-label="Form editor view"/);
  for (const view of ['Build', 'Preview', 'Settings']) assert.match(toolbar, new RegExp(`role="radio"[^>]*>${view}</button>`));
  assert.match(html, /class="admin-kit-button [^"]*forms-save"[^>]*title="Save \(Ctrl or Cmd \+ S\)"/);
});

test('the list of types says what each one collects', () => {
  const html = renderToStaticMarkup(React.createElement(TypePicker, {label:'Add to this section', onPick:()=>{}, onClose:()=>{}}));
  assert.match(html, /aria-label="Add to this section"/);
  assert.match(html, /Yes \/ No<\/span><span class="forms-secondary">A yes or a no<\/span>/);
  assert.match(html, /Statement<\/span><span class="forms-secondary">Something to read, nothing to answer<\/span>/);
  assert.equal([...html.matchAll(/forms-type-card/g)].length, 22);
});

test('name, email and phone are each asked for, optional, or not asked, in one control', () => {
  const html = state => renderToStaticMarkup(React.createElement(DetailAsk, {label:'Email', onChange:()=>{}, ...state}));
  assert.match(html({collect:false, required:false}), /aria-checked="true"[^>]*>Don&#x27;t ask</);
  assert.match(html({collect:true, required:false}), /aria-checked="true"[^>]*>Optional</);
  assert.match(html({collect:true, required:true}), /aria-checked="true"[^>]*>Required</);
  // One response per email needs the email, so only Required is left open.
  const locked = html({collect:true, required:true, locked:true});
  assert.equal([...locked.matchAll(/disabled=""/g)].length, 2);
});

test('Preview runs the unsaved draft through the public form itself', () => {
  const draftForm = {...longForm, form_type:'registration', description:'Before you start', collect_name:true, collect_name_required:true, show_progress_bar:true, questions:longForm.questions};
  const html = renderToStaticMarkup(React.createElement(FormPreview, {draft:draftForm}));
  assert.match(html, /including unsaved changes/);
  assert.match(html, /Nothing you enter is saved or sent/);
  assert.match(html, /<h1 class="font-display[^"]*">Contractor agreement<\/h1>/, 'the respondent’s first page, with the draft’s title');
  assert.match(html, /Name \*/);
  assert.match(html, />Continue/);
});
