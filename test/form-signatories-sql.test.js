import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { XERT_CONTRACTOR_FORM_DEFINITION, CONTRACTOR_ACCEPT_OPTION, CONTRACTOR_DECLINE_OPTION } from '../src/lib/xertContractorForm.js';

// Byron Hawley signs every copy of the contractor agreement. These run the
// real migration and the real submit function in Postgres: the signature has
// to land in the stored response, because that is what every copy is made from.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const VALID_SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const UPDATED = '2026-09-29T00:00:00Z';

function functionDefinition(sql, name) {
  const start = sql.toLowerCase().indexOf(`create or replace function ${name}`);
  if (start < 0) throw new Error(`Missing ${name}`);
  const bodyStart = sql.indexOf('as $$', start);
  return sql.slice(start, sql.indexOf('$$;', bodyStart) + 3);
}

// The agreement as it was before this change: the owner line was a signature
// anybody could leave blank, captioned for a witness at the desk.
function contractorAsItWas(overrides = {}) {
  return XERT_CONTRACTOR_FORM_DEFINITION.questions.map(question => {
    if (question.id === 'ic-98-owner-signature') {
      const { signed_by: _signedBy, ...rest } = question;
      return { ...rest, question: 'Owner / witness signature', description: 'Signed by Byron Hawley, or a XERT Fitness representative witnessing this agreement.', ...overrides };
    }
    if (question.id === 'ic-97-owner-details') return { ...question, content: 'Owner / Witness: Byron Hawley. Phone 0431 676 053. Email info@xertfitness.com.au.' };
    if (question.id === 'ic-96-owner') return { ...question, description: 'Completed by the owner or witness at the club.' };
    return question;
  });
}

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create table public.xert_forms (
      id uuid primary key, slug text not null, is_active boolean not null default true, archived_at timestamptz,
      questions jsonb not null, collect_name_required boolean not null default false,
      collect_email_required boolean not null default false, collect_phone_required boolean not null default false,
      one_response_per_email boolean not null default false, response_count integer not null default 0,
      updated_at timestamptz not null default '${UPDATED}'
    );
    create table public.xert_form_responses (
      id uuid primary key default gen_random_uuid(), form_id uuid, answers jsonb, respondent_name text,
      respondent_email text, respondent_phone text, time_taken_seconds integer, source_url text,
      created_by uuid, archived_at timestamptz
    );
  `);
  const snapshots = await read('../supabase/migrations/20260813010000_xert_form_response_snapshots.sql');
  const alreadyProvided = await read('../supabase/migrations/20260926010000_form_field_already_provided.sql');
  await db.exec(functionDefinition(snapshots, 'public.xert_valid_form_signature'));
  await db.exec(functionDefinition(snapshots, 'public.xert_form_answer_is_present'));
  await db.exec(functionDefinition(alreadyProvided, 'public.xert_form_answer_is_already_provided'));
  return db;
}

async function addForm(db, id, slug, questions) {
  await db.query('insert into public.xert_forms (id, slug, questions) values ($1, $2, $3)', [id, slug, JSON.stringify(questions)]);
}

// A complete, valid set of answers for the agreement, taking one branch.
function answersFor(questions, decision) {
  const answers = {};
  for (const question of questions) {
    if (!question.required || question.hidden || ['section_break', 'statement'].includes(question.type)) continue;
    if (question.id === 'ic-91-accept') { answers[question.id] = decision; continue; }
    const pick = question.options?.[0];
    answers[question.id] = {
      short_text: 'Jordan Avery', long_text: 'Text', email: 'jordan@example.com', phone: '0400 000 000',
      date: '2026-09-29', signature: VALID_SIGNATURE, single_choice: pick, dropdown: pick, yes_no: 'Yes',
      multiple_choice: [pick], name_fields: { first: 'Jordan', last: 'Avery' },
      address: { street: '12 Pound St', suburb: 'Kingaroy', state: 'QLD', postcode: '4610', country: 'Australia' },
    }[question.type] ?? 'x';
  }
  return answers;
}

const submit = (db, slug, answers) => db.query(
  'select public.submit_xert_form_response_v2($1, $2::jsonb, $3::timestamptz, $4, $5, $6) as id',
  [slug, JSON.stringify(answers), UPDATED, 'Jordan Avery', 'jordan@example.com', '0400 000 000'],
);

const migration = await read('../supabase/migrations/20260929010000_form_signatories.sql');
const byron = `data:image/png;base64,${(await readFile(new URL('../public/assets/signatures/byron-hawley.png', import.meta.url))).toString('base64')}`;
const FORM = '11111111-1111-4111-8111-111111111111';

async function migrated() {
  const db = await database();
  await addForm(db, FORM, 'contractor-agreement', contractorAsItWas());
  await db.exec(migration);
  return db;
}

test('the migration holds the same signature the site shows', () => {
  const literal = migration.slice(migration.indexOf("'byron-hawley', 'Byron Hawley'"), migration.indexOf('on conflict (key)'));
  const stored = [...literal.matchAll(/'([^']*)'/g)].slice(3).map(match => match[1]).join('');
  assert.equal(stored, byron, 'the database copy and public/assets/signatures/byron-hawley.png are the same bytes');
});

test('the live agreement becomes signed in advance by Byron', async () => {
  const db = await migrated();
  const { rows } = await db.query(`select questions from public.xert_forms where id = $1`, [FORM]);
  const byId = Object.fromEntries(rows[0].questions.map(question => [question.id, question]));
  assert.equal(byId['ic-98-owner-signature'].signed_by, 'byron-hawley');
  assert.equal(byId['ic-98-owner-signature'].required, false);
  assert.equal(byId['ic-98-owner-signature'].question, 'Signed for XERT Fitness');
  assert.equal(byId['ic-97-owner-details'].content, 'Byron Hawley, Owner. Phone 0431 676 053. Email info@xertfitness.com.au.');
  assert.equal(rows[0].questions.length, XERT_CONTRACTOR_FORM_DEFINITION.questions.length, 'nothing else added or lost');
});

test('an owner’s own wording is kept; only the signing changes', async () => {
  const db = await database();
  await addForm(db, FORM, 'contractor-agreement', contractorAsItWas({ question: 'Byron’s signature' }));
  await db.exec(migration);
  const { rows } = await db.query(`select q from public.xert_forms, jsonb_array_elements(questions) q where q ->> 'id' = 'ic-98-owner-signature'`);
  assert.equal(rows[0].q.question, 'Byron’s signature');
  assert.equal(rows[0].q.signed_by, 'byron-hawley');
});

test('the owner line reads “Byron Hawley, Owner.” and nothing more', async () => {
  const wording = await read('../supabase/migrations/20260929020000_byron_signoff_wording.sql');
  const ownerLine = async db => (await db.query(`select q from public.xert_forms, jsonb_array_elements(questions) q where q ->> 'id' = 'ic-98-owner-signature'`)).rows[0].q;
  const db = await migrated();
  await db.exec(wording);
  const line = await ownerLine(db);
  assert.equal(line.description, 'Byron Hawley, Owner.');
  assert.equal(line.signed_by, 'byron-hawley', 'still signed by Byron');
  assert.equal(line.description, XERT_CONTRACTOR_FORM_DEFINITION.questions.find(question => question.id === 'ic-98-owner-signature').description, 'the live form and the definition agree');
  await db.exec(wording);
  assert.equal((await ownerLine(db)).description, 'Byron Hawley, Owner.', 'running it twice changes nothing');

  const edited = await database();
  await addForm(edited, FORM, 'contractor-agreement', contractorAsItWas());
  await edited.exec(migration);
  await edited.exec(`update public.xert_forms set questions = (select jsonb_agg(case when q ->> 'id' = 'ic-98-owner-signature' then q || '{"description": "Owner, on behalf of the club."}'::jsonb else q end) from jsonb_array_elements(questions) q)`);
  await edited.exec(wording);
  assert.equal((await ownerLine(edited)).description, 'Owner, on behalf of the club.', 'wording edited in the builder is left alone');
});

test('every accepted agreement stores Byron’s signature, from the database’s own record', async () => {
  const db = await migrated();
  const { rows: [form] } = await db.query('select questions from public.xert_forms where id = $1', [FORM]);
  await submit(db, 'contractor-agreement', answersFor(form.questions, CONTRACTOR_ACCEPT_OPTION));
  const { rows: [response] } = await db.query('select answers from public.xert_form_responses');
  assert.equal(response.answers['ic-98-owner-signature'], byron);
  assert.equal(response.answers['ic-93-contractor-signature'], VALID_SIGNATURE, 'the contractor’s own signature is untouched');
});

test('a declined agreement is not countersigned', async () => {
  const db = await migrated();
  const { rows: [form] } = await db.query('select questions from public.xert_forms where id = $1', [FORM]);
  const declined = Object.fromEntries(Object.entries(answersFor(form.questions, CONTRACTOR_DECLINE_OPTION))
    .filter(([id]) => !['ic-92-contractor-name', 'ic-93-contractor-signature', 'ic-94-commencement', 'ic-95-marketing'].includes(id)));
  await submit(db, 'contractor-agreement', declined);
  const { rows: [response] } = await db.query('select answers from public.xert_form_responses');
  assert.equal(response.answers['ic-98-owner-signature'], undefined);
});

test('nobody filling the form in can supply Byron’s signature for him', async () => {
  const db = await migrated();
  const { rows: [form] } = await db.query('select questions from public.xert_forms where id = $1', [FORM]);
  const forged = { ...answersFor(form.questions, CONTRACTOR_ACCEPT_OPTION), 'ic-98-owner-signature': VALID_SIGNATURE };
  await assert.rejects(submit(db, 'contractor-agreement', forged), /was not presented/);
});

test('a sign-off has to be a signature, naming somebody on record', async () => {
  const db = await migrated();
  await addForm(db, '22222222-2222-4222-8222-222222222222', 'wrong-type', [{ id: 'a', type: 'short_text', question: 'Name', signed_by: 'byron-hawley' }]);
  await assert.rejects(submit(db, 'wrong-type', { a: 'x' }), /not configured correctly/);
  await addForm(db, '33333333-3333-4333-8333-333333333333', 'nobody', [{ id: 's', type: 'signature', question: 'Sign', signed_by: 'someone-else' }]);
  await assert.rejects(submit(db, 'nobody', {}), /not configured correctly/);
});

test('the signature table is closed to the browser', async () => {
  const db = await migrated();
  const { rows } = await db.query(`select has_table_privilege('anon', 'public.xert_form_signatories', 'select') as anon, has_table_privilege('authenticated', 'public.xert_form_signatories', 'select') as signed_in`);
  assert.deepEqual(rows[0], { anon: false, signed_in: false });
});
