import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { createServer } from 'vite';

test('the shared visitor page sells the three-day pass and never treats a return query as payment proof', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://ugmkwoapjcpiucsrxwzt.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_local_test_fixture_only_0000'),
    },
  });
  try {
    const { default: CasualVisit } = await server.ssrLoadModule('/src/pages/CasualVisit.jsx');
    const { SupabaseAuthProvider } = await server.ssrLoadModule('/src/lib/SupabaseAuthContext.jsx');
    const render = location => renderToString(React.createElement(StaticRouter, { location },
      React.createElement(SupabaseAuthProvider, null, React.createElement(CasualVisit, { threeDayPass: true }))));
    const page = render('/3daypass');
    assert.match(page, /Three Day Pass/);
    assert.match(page, /\$39\.00/);
    assert.match(page, /show your receipt to the XERT team/i);
    assert.doesNotMatch(page, /three classes|from purchase/i);
    assert.match(page, /First name/);
    assert.match(page, /Pre-exercise questionnaire/);
    assert.match(page, /href="\/forms\/peq-casual\?return=3daypass"/);
    const returned = render('/3daypass?paid=1');
    assert.doesNotMatch(returned, /Payment received|team has been told/);
    assert.match(returned, /receipt/);
    assert.match(returned, /XERT team/);
    // The pass is on their XertOS profile by now: the tablet is where they use it.
    assert.match(returned, /check in on the tablet at the front/);
    assert.doesNotMatch(returned, /three classes|from purchase/i);
  } finally { await server.close(); }
});

test('the owner still sees existing casual purchases before the additive migration is installed', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://ugmkwoapjcpiucsrxwzt.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_local_test_fixture_only_0000'),
    },
  });
  let client;
  let original;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabase.js');
    const { listCasualVisits } = await server.ssrLoadModule('/src/lib/adminData.js');
    client = supabase;
    original = client.from;
    const legacy = { id: 'fixture', full_name: 'Casey Example', email: 'casey@example.test', amount_cents: 1560 };
    client.from = table => {
      assert.equal(table, 'casual_visit_payments');
      let columns;
      const query = {
        select(value) { columns = value; return query; },
        order() { return query; },
        async limit() { return columns.includes('pass_kind')
          ? { data: null, error: { code: '42703', message: 'column casual_visit_payments.pass_kind does not exist' } }
          : { data: [legacy], error: null }; },
      };
      return query;
    };
    assert.deepEqual(await listCasualVisits(), { installed: true, rows: [legacy] });
  } finally {
    if (client && original) client.from = original;
    await server.close();
  }
});
