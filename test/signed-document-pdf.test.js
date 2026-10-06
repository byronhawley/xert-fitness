import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  compoundAnswer, pdfText, renderSignedDocumentPdf, signatureImage, signedDocumentFileName,
} from '../src/lib/signedDocumentPdf.js';
import { signedDocumentHandler } from '../src/lib/signedDocumentServer.js';
import { XERT_CONTRACTOR_FORM_DEFINITION } from '../src/lib/xertContractorForm.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

/** A 2x2 PNG, enough to prove a signature is embedded rather than described. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8//8/AzJgYkAD'
  + 'IwsAHawCDf3SsvIAAAAASUVORK5CYII=';

/** Every piece of text drawn, recovered from the compressed page streams. */
function drawnText(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  let all = '';
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { all += inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { /* not a content stream */ }
  }
  // Helvetica text is written as hex strings: <48656C6C6F> Tj.
  return [...all.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map(m => Buffer.from(m[1], 'hex').toString('latin1')).join('\n');
}

const response = {
  id: '4fea97dc-0000-4000-8000-000000000001',
  respondent_name: 'Jordan Avery',
  respondent_email: 'jordan@example.com',
  respondent_phone: '0400 000 000',
  completed_at: '2026-10-06T00:30:00Z',
  form_snapshot: {
    title: 'XERT Fitness Independent Contractor Agreement',
    questions: [
      { id: 's1', type: 'section_break', content: 'Workplace Health & Safety', description: '' },
      { id: 't1', type: 'statement', content: '• The Independent Contractor indemnifies and holds harmless XERT Fitness.\n• A second clause about lost property.' },
      { id: 'name', type: 'name_fields', question: 'Your first and last name', required: true },
      { id: 'addr', type: 'address', question: 'Your address', required: true },
      { id: 'quals', type: 'multiple_choice', question: 'What qualifications do you hold?', options: ['CPR Certificate', 'First Aid Certificate'] },
      { id: 'accept', type: 'single_choice', question: 'Do you accept?', options: ['I accept this agreement', 'I decline'],
        skip_rules: [{ option: 'I decline', skip_to: 10 }] },
      { id: 'skipped-if-declined', type: 'short_text', question: 'Only asked when accepted' },
      { id: 'sig', type: 'signature', question: 'Independent contractor signature', required: true },
      { id: 'owner', type: 'signature', question: 'Signed for XERT Fitness', signed_by: 'byron-hawley' },
    ],
  },
  answers: {
    name: { last: 'Avery', first: 'Jordan' },
    addr: { state: 'QLD', street: '12 Pound St', suburb: 'Kingaroy', country: 'Australia', postcode: '4610' },
    quals: ['CPR Certificate'],
    accept: 'I accept this agreement',
    'skipped-if-declined': 'Yes',
    sig: PNG,
    owner: PNG,
  },
};

test('the PDF carries the whole document: headings, every clause, and the answers', async () => {
  const bytes = await renderSignedDocumentPdf(response);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
  const text = drawnText(bytes);
  for (const expected of [
    'XERT Fitness Independent Contractor Agreement', 'Workplace Health & Safety',
    'indemnifies and holds harmless XERT Fitness', 'A second clause about lost property',
    'Jordan Avery', '12 Pound St', 'Kingaroy QLD 4610', 'CPR Certificate', 'First Aid Certificate',
    'Byron Hawley, Owner, XERT Fitness',
  ]) assert.ok(text.includes(expected), `missing from the PDF: ${expected}`);
  // A name stored last-then-first still reads the way it is written.
  assert.ok(!text.includes('Last: Avery'));
});

test('both signatures are drawn as images, not described', async () => {
  const doc = await PDFDocument.load(await renderSignedDocumentPdf(response));
  let images = 0;
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'));
    if (xobjects) images += xobjects.keys().length;
  }
  assert.equal(images, 2, 'the contractor signature and Byron\'s signature');
  assert.match(doc.getTitle(), /Jordan Avery/);
});

test('a question skipped by the form’s own rules is left out, as on the record', async () => {
  const declined = { ...response, answers: { ...response.answers, accept: 'I decline' } };
  delete declined.answers['skipped-if-declined'];
  const text = drawnText(await renderSignedDocumentPdf(declined));
  assert.ok(!text.includes('Only asked when accepted'));
  assert.ok(text.includes('Do you accept?'));
});

test('names and addresses are put back together in reading order', () => {
  assert.equal(compoundAnswer({ type: 'name_fields', answer: { last: 'Avery', first: 'Jordan' } }), 'Jordan Avery');
  assert.equal(compoundAnswer({ type: 'address', answer: response.answers.addr }), '12 Pound St\nKingaroy QLD 4610\nAustralia');
  // Unknown parts are not guessed at; the generic labelled form takes over.
  assert.equal(compoundAnswer({ type: 'address', answer: { unit: '4' } }), null);
});

test('text the font cannot draw is replaced, never thrown on', async () => {
  assert.equal(pdfText('don’t “quote” ☐ me… \u{1F600}'), 'don\'t "quote" [ ] me... ');
  const awkward = { ...response, respondent_name: 'Zoë \u{1F600} Avery' };
  await assert.doesNotReject(renderSignedDocumentPdf(awkward));
  assert.equal(signatureImage('data:text/html;base64,PHA+'), null, 'only images are drawn as signatures');
});

test('the file name says what it is and whose', () => {
  assert.equal(signedDocumentFileName(response), 'XERT-Fitness-Independent-Contractor-Agreement-Jordan-Avery-2026-10-06.pdf');
});

function fakeAdmin({ source = null, sourceError = null, sendError = null } = {}) {
  const calls = [];
  return {
    calls,
    create: () => ({
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === 'xert_signed_document_source') return { data: source, error: sourceError };
        return { data: !sendError, error: sendError };
      },
    }),
  };
}

function call(handler, { method = 'POST', body } = {}) {
  let status = 200; let payload = null;
  const res = { setHeader() {}, status(code) { status = code; return this; }, json(value) { payload = value; return this; } };
  return handler({ method, body }, res).then(() => ({ status, payload }));
}

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service' };

test('the server sends the copy with the PDF the database asked for', async () => {
  const admin = fakeAdmin({ source: response });
  const result = await call((req, res) => signedDocumentHandler(req, res, { createAdmin: admin.create, env }),
    { body: { response_id: response.id } });
  assert.deepEqual(result, { status: 200, payload: { status: 'sent' } });
  const send = admin.calls.find(item => item.name === 'send_signed_document_copy');
  assert.equal(send.args.p_response_id, response.id);
  assert.ok(send.args.p_pdf_base64.startsWith('JVBERi'), 'base64 of a real PDF');
  assert.match(send.args.p_pdf_filename, /\.pdf$/);
});

test('the server does nothing the database has not asked for', async () => {
  const handler = admin => (req, res) => signedDocumentHandler(req, res, { createAdmin: admin.create, env });
  // Already sent, too old, or not a PDF form: the database says no.
  const refused = fakeAdmin({ source: null });
  assert.deepEqual(await call(handler(refused), { body: { response_id: response.id } }), { status: 200, payload: { status: 'skipped' } });
  assert.ok(!refused.calls.some(item => item.name === 'send_signed_document_copy'));
  assert.equal((await call(handler(refused), { method: 'GET' })).status, 405);
  assert.equal((await call(handler(refused), { body: { response_id: 'not-a-uuid' } })).status, 400);
  // A failure is reported, and the database's own fallback sends the copy.
  assert.equal((await call(handler(fakeAdmin({ sourceError: new Error('down') })), { body: { response_id: response.id } })).status, 500);
});

test('the database asks for a PDF only for forms that send one, and never loses a copy', async () => {
  const sql = await read('../supabase/migrations/20261006010000_signed_copy_attaches_the_pdf.sql');
  assert.match(sql, /add column if not exists email_pdf_copy boolean not null default false/);
  // The server only ever sees fresh, unsent responses on PDF forms.
  for (const guard of [/and f\.email_pdf_copy\n/, /r\.created_at > now\(\) - interval '2 hours'/, /l\.email_type = 'signed_documents' and l\.related_id = r\.id::text/]) {
    assert.match(sql.slice(sql.indexOf('function public.xert_signed_document_source'), sql.indexOf('drop function if exists public.send_signed_document_copy(uuid)')), guard);
  }
  assert.match(sql, /revoke all on function public\.xert_signed_document_source\(uuid\) from public, anon, authenticated/);
  // One copy per response, however the callers race.
  assert.match(sql, /pg_advisory_xact_lock\(pg_catalog\.hashtextextended\('signed_documents:'/);
  // Only a real PDF is attached.
  assert.match(sql, /v_pdf !~ '\^JVBERi/);
  // The safety net runs on a schedule.
  assert.match(sql, /cron\.schedule\(\s*'send-overdue-signed-document-copies',\s*'\*\/2 \* \* \* \*'/);
  // A form without the setting still sends at once.
  assert.match(sql, /if coalesce\(v_sends_pdf, false\) then[\s\S]*?end if;\n\n  perform public\.send_signed_document_copy\(new\.id\);/);
});

test('it rides on an existing function, so the twelve-function limit holds', async () => {
  const api = await read('../api/push-subscription.js');
  assert.match(api, /queryAction\(request\) === SIGNED_DOCUMENT_ACTION\) return signedDocumentHandler\(request, response\)/);
  const functions = (await readdir(new URL('../api/', import.meta.url))).filter(name => name.endsWith('.js'));
  assert.ok(functions.length <= 12);
  const sql = await read('../supabase/migrations/20261006010000_signed_copy_attaches_the_pdf.sql');
  assert.match(sql, /api\/push-subscription\?action=signed_document/);
  const pkg = JSON.parse(await read('../package.json'));
  assert.ok(pkg.dependencies['pdf-lib'], 'the server needs it at runtime, not only at build time');
});

test('any form can switch it on from the builder, and the contractor agreement has', async () => {
  const manager = await read('../src/components/admin/FormsSurveysManager.jsx');
  assert.match(manager, /draft\.email_copy_to_respondent && <Toggle checked=\{draft\.email_pdf_copy === true\} onChange=\{value => update\('email_pdf_copy', value\)\}/);
  const forms = await read('../src/lib/xertForms.js');
  assert.match(forms, /'email_copy_to_respondent', 'email_pdf_copy',/);
  assert.equal(XERT_CONTRACTOR_FORM_DEFINITION.email_pdf_copy, true);
});
