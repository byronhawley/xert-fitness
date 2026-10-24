import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// The 10 Session Pack migration, run for real in Postgres on top of the
// migrations it builds on, and then run again. It has to add the new pass
// without changing a word of what the casual visit, Three Day Pass and three
// month membership already do, and it must never be the reason a payment
// that has already been taken fails to record.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const migration = await read('../supabase/migrations/20261016010000_ten_session_pack.sql');

const CASUAL_PEQ_FORM_ID = 'e90f30f7-b0d2-56e7-8e1d-8b290721e234';
const NAME_ANSWER_ID = '84703ad7-a28d-4904-9868-6c832ce38055';
const EMAIL_ANSWER_ID = 'e4c4e161-43e3-5462-a865-f27c411ac809';
const PHONE_ANSWER_ID = '5d5d7d53-d5ea-4743-8f94-22ecd5fd6ded';
const SIGNATURE_ANSWER_ID = '576cbb02-2819-488f-a7d8-1719d8d53840';
const VALID_SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function functionDefinition(sql, name) {
  const start = sql.toLowerCase().indexOf(`create or replace function ${name}`);
  if (start < 0) throw new Error(`Missing ${name}`);
  const bodyStart = sql.indexOf('as $$', start);
  return sql.slice(start, sql.indexOf('$$;', bodyStart) + 3);
}

// Only the tables and helpers the visitor payment migrations touch. The owner
// alert is captured instead of sent, and can be made to fail on demand.
async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create function public.is_admin() returns boolean language sql as $$ select false $$;
    create table public.xert_schema_capabilities (
      capability text primary key, installed_at timestamptz not null default now()
    );
    create table public.admin_settings (id integer primary key, payments_enabled boolean default false);
    insert into public.admin_settings (id) values (1);
    create table public.test_owner_alerts (n serial, alert_type text, subject text, body text, related_table text, related_id text);
    create table public.test_alert_switch (fail boolean not null);
    insert into public.test_alert_switch values (false);
    create function public.email_owner_alert(text, text, text, text, text)
    returns void language plpgsql security definer set search_path = public as $$
    begin
      if (select fail from public.test_alert_switch) then raise exception 'mail service down'; end if;
      insert into public.test_owner_alerts (alert_type, subject, body, related_table, related_id)
      values ($1, $2, $3, $4, $5);
    end $$;
    create table public.xert_form_responses (
      id uuid primary key, form_id uuid not null, answers jsonb not null default '{}'::jsonb,
      respondent_name text, respondent_email text, respondent_phone text,
      completed_at timestamptz, archived_at timestamptz, form_snapshot jsonb not null default '{}'::jsonb
    );
  `);
  await db.exec(functionDefinition(await read('../supabase/migrations/20260906030000_booking_repair_followups.sql'), 'public.email_escape'));
  await db.exec(functionDefinition(await read('../supabase/migrations/20260813010000_xert_form_response_snapshots.sql'), 'public.xert_valid_form_signature'));
  for (const name of [
    '20260905010000_casual_visit_payments.sql',
    '20260908010000_three_day_visitor_pass.sql',
    '20260908060000_three_month_membership.sql',
    '20260908070000_visitor_pass_pricing_and_discounts.sql',
    '20260909081702_three_month_paperwork_proof.sql',
    '20260914020000_visitor_pass_already_signed.sql',
  ]) await db.exec(await read(`../supabase/migrations/${name}`));
  return db;
}

let sequence = 0;
async function pay(db, kind, verified = null, { name = 'Casey <Example>', amount = 12240 } = {}) {
  sequence += 1;
  await db.query(`
    insert into public.casual_visit_payments
      (full_name, email, phone, amount_cents, stripe_checkout_session_id, pass_kind, paperwork_verified)
    values ($1, 'casey@example.test', '+61400111222', $2, $3, $4, $5)`,
  [name, amount, `cs_test_ten_${sequence}`, kind, verified]);
  const { rows } = await db.query('select alert_type, subject, body, related_table from public.test_owner_alerts order by n desc limit 1');
  return rows[0];
}

const EXISTING = [
  ['casual', null],
  ['three_day_pass', null], ['three_day_pass', true], ['three_day_pass', false],
  ['three_month_membership', null], ['three_month_membership', true], ['three_month_membership', false],
];

async function settings(db) {
  const { rows } = await db.query(`
    select ten_session_pack_price_cents as price, ten_session_pack_discount_cents as discount,
      ten_session_pack_discount_enabled as enabled from public.admin_settings`);
  return rows[0];
}

test('applied twice, the migration adds the 10 Session Pack and leaves every existing alert word for word', async () => {
  const db = await database();
  const before = [];
  for (const [kind, verified] of EXISTING) before.push(await pay(db, kind, verified));

  await db.exec(migration);
  await db.exec(migration);

  const after = [];
  for (const [kind, verified] of EXISTING) after.push(await pay(db, kind, verified));
  assert.deepEqual(after, before, 'the casual, Three Day Pass and membership alerts must not change');

  for (const verified of [null, true, false]) {
    const alert = await pay(db, 'ten_session_pack', verified);
    assert.equal(alert.alert_type, 'owner_alerts');
    assert.equal(alert.subject, '10 Session Pack paid: Casey <Example>');
    assert.equal(alert.related_table, 'casual_visit_payments');
    // The visitor's own name goes into an email, so it is escaped there.
    assert.match(alert.body, /^<p>Casey &lt;Example&gt; \(casey@example\.test, \+61400111222\) paid \$122\.40 for a 10 Session Pack\.<\/p>/);
    assert.match(alert.body, /<p>10 Session Pack\./);
    assert.match(alert.body, /does not create member credits/);
    assert.doesNotMatch(alert.body, /Check them in as usual|Casual visit|Three Day Pass|FitBox/);
  }
  const unchecked = await pay(db, 'ten_session_pack', null);
  assert.equal(unchecked.body.endsWith('<p>10 Session Pack. Confirm the receipt and arrange their sessions; this payment does not create member credits.</p>'), true);
  const onFile = await pay(db, 'ten_session_pack', true);
  assert.match(onFile.body, /Their signed pre-exercise questionnaire is on file\. Confirm the receipt and arrange their sessions/);
  const notFound = await pay(db, 'ten_session_pack', false);
  assert.match(notFound.body, /<strong>They said they had already completed the pre-exercise questionnaire, but no signed questionnaire was found under this email\.<\/strong> Check with them before their first session\./);
});

test('the pass kind accepts the 10 Session Pack and every existing kind, and nothing else', async () => {
  const db = await database();
  await db.exec(migration);
  await db.exec(migration);
  for (const kind of ['casual', 'three_day_pass', 'three_month_membership', 'ten_session_pack']) {
    await pay(db, kind);
  }
  for (const junk of ['unlimited', 'ten_session_packs', '10pack', '']) {
    await assert.rejects(pay(db, junk), /casual_visit_pass_kind_check/, junk);
  }
  const { rows } = await db.query(`
    select pg_get_constraintdef(oid) as definition from pg_constraint
    where conname = 'casual_visit_pass_kind_check'`);
  assert.equal(rows.length, 1);
  for (const kind of ['casual', 'three_day_pass', 'three_month_membership', 'ten_session_pack']) {
    assert.ok(rows[0].definition.includes(`'${kind}'`), kind);
  }
});

test('a failing owner email never stops a paid 10 Session Pack being recorded', async () => {
  const db = await database();
  await db.exec(migration);
  await db.exec('update public.test_alert_switch set fail = true');
  await pay(db, 'ten_session_pack', false);
  const { rows } = await db.query(`select count(*)::int as n from public.casual_visit_payments where pass_kind = 'ten_session_pack'`);
  assert.equal(rows[0].n, 1);
});

test('the price defaults to $122.40 with no discount, and the database refuses a bad price or a fake discount', async () => {
  const db = await database();
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual(await settings(db), { price: 12240, discount: null, enabled: false });

  const refused = [
    ['ten_session_pack_price_cents = 50', /ten_session_pack_price_bounds/],
    ['ten_session_pack_price_cents = 100001', /ten_session_pack_price_bounds/],
    ['ten_session_pack_discount_cents = 99', /ten_session_pack_price_bounds/],
    ['ten_session_pack_discount_cents = 100001', /ten_session_pack_price_bounds/],
    // Switched on with nothing behind it, or with a "discount" that costs as much or more.
    ['ten_session_pack_discount_enabled = true', /ten_session_pack_discount_is_a_discount/],
    ['ten_session_pack_discount_cents = 12240, ten_session_pack_discount_enabled = true', /ten_session_pack_discount_is_a_discount/],
    ['ten_session_pack_discount_cents = 13000, ten_session_pack_discount_enabled = true', /ten_session_pack_discount_is_a_discount/],
  ];
  for (const [assignment, constraint] of refused) {
    await assert.rejects(db.query(`update public.admin_settings set ${assignment}`), constraint, assignment);
  }
  assert.deepEqual(await settings(db), { price: 12240, discount: null, enabled: false }, 'nothing refused was saved');

  await db.query('update public.admin_settings set ten_session_pack_discount_cents = 11000, ten_session_pack_discount_enabled = true');
  await db.query('update public.admin_settings set ten_session_pack_price_cents = 13000');
  assert.deepEqual(await settings(db), { price: 13000, discount: 11000, enabled: true });
  // A rerun keeps the club's own price rather than resetting it.
  await db.exec(migration);
  assert.deepEqual(await settings(db), { price: 13000, discount: 11000, enabled: true });
});

test('the other visitor prices keep their own constraints, untouched', async () => {
  const db = await database();
  await db.exec(migration);
  const { rows } = await db.query(`
    select conname from pg_constraint
    where conrelid = 'public.admin_settings'::regclass and contype = 'c' order by conname`);
  assert.deepEqual(rows.map(row => row.conname), [
    'admin_settings_casual_price_check',
    'ten_session_pack_discount_is_a_discount',
    'ten_session_pack_price_bounds',
    'visitor_pass_discount_is_a_discount',
    'visitor_pass_price_bounds',
  ]);
  await assert.rejects(db.query('update public.admin_settings set three_day_pass_discount_enabled = true'), /visitor_pass_discount_is_a_discount/);
  await assert.rejects(db.query('update public.admin_settings set three_month_price_cents = 50'), /visitor_pass_price_bounds/);
  await assert.rejects(db.query('update public.admin_settings set casual_visit_price_cents = 50'), /admin_settings_casual_price_check/);
});

test('the capability is published once, and the 10 Session Pack reuses the casual questionnaire lookups unchanged', async () => {
  const db = await database();
  await db.exec(migration);
  await db.exec(migration);
  const { rows } = await db.query(`select count(*)::int as n from public.xert_schema_capabilities where capability = 'ten_session_pack'`);
  assert.equal(rows[0].n, 1);

  // A signed casual questionnaire is the proof both checkout paths look for.
  const responseID = '11111111-1111-4111-8111-111111111111';
  await db.query(`
    insert into public.xert_form_responses (id, form_id, answers, completed_at, form_snapshot)
    values ($1, $2, $3, now() - interval '1 minute', $4)`, [
    responseID, CASUAL_PEQ_FORM_ID,
    JSON.stringify({
      [NAME_ANSWER_ID]: { first: 'Casey', last: 'Example' },
      [EMAIL_ANSWER_ID]: 'casey@example.test',
      [PHONE_ANSWER_ID]: '0400 111 222',
      [SIGNATURE_ANSWER_ID]: VALID_SIGNATURE,
    }),
    JSON.stringify({ version: 1, questions: [{ id: SIGNATURE_ANSWER_ID, type: 'signature' }] }),
  ]);
  const proof = await db.query(`
    select public.xert_visitor_questionnaire_completed($1, 'Casey Example', 'casey@example.test', '+61400111222') as completed,
      public.xert_visitor_questionnaire_signed('casey@example.test') as signed,
      public.xert_visitor_questionnaire_signed('nobody@example.test') as stranger`, [responseID]);
  assert.deepEqual(proof.rows[0], { completed: true, signed: true, stranger: false });
  const grants = await db.query(`
    select has_function_privilege('anon', 'public.xert_visitor_questionnaire_signed(text)', 'execute') as anon,
      has_function_privilege('service_role', 'public.xert_visitor_questionnaire_signed(text)', 'execute') as server`);
  assert.deepEqual(grants.rows[0], { anon: false, server: true });
});

test('on a database missing what it builds on, the migration refuses and publishes nothing', async () => {
  const db = new PGlite();
  await db.exec(`
    create table public.xert_schema_capabilities (capability text primary key, installed_at timestamptz not null default now());
    create table public.admin_settings (id integer primary key);
    create table public.casual_visit_payments (id uuid primary key default gen_random_uuid(), full_name text not null);
  `);
  await assert.rejects(db.exec(migration), /20260908010000_three_day_visitor_pass\.sql before the 10 Session Pack/);
  const { rows } = await db.query('select count(*)::int as n from public.xert_schema_capabilities');
  assert.equal(rows[0].n, 0);
});

test('the capability is the last thing written, followed only by a schema reload', () => {
  const statements = migration.replace(/--.*$/gm, '').trim();
  assert.ok(statements.endsWith("notify pgrst, 'reload schema';"));
  const capability = migration.indexOf("values ('ten_session_pack') on conflict (capability) do nothing;");
  assert.ok(capability > 0);
  for (const guarded of [
    'add constraint casual_visit_pass_kind_check',
    'add column if not exists ten_session_pack_price_cents integer not null default 12240',
    'create or replace function public.email_on_casual_visit_payment()',
    'add constraint ten_session_pack_discount_is_a_discount',
  ]) {
    const at = migration.indexOf(guarded);
    assert.ok(at > 0 && at < capability, `${guarded} must come before the capability row`);
  }
  // Separate constraints for the new columns: the shared ones are never rewritten here.
  assert.doesNotMatch(migration, /constraint (?:if exists )?visitor_pass_(?:price_bounds|discount_is_a_discount)/);
  assert.doesNotMatch(migration, /admin_settings_casual_price_check/);
});
