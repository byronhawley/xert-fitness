import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { REQUIRED_SCHEMA_CAPABILITIES } from '../src/lib/schemaCapabilities.js';

// Three places have to know which database capabilities a release needs:
// Operations Health (schemaCapabilities.js), the owner's runnable pre-release
// query (release_readiness_check.sql), and the Codemagic TestFlight gate. Each
// held its own hand-written copy of the list, and the existing tests only
// asserted one direction — that everything named in a gate exists — so all of
// them passed while two gates sat four migrations behind. A stale gate is worse
// than no gate: it reports release_ready = true against a database missing the
// RPCs the build calls.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const capabilities = () => new Set(Object.keys(REQUIRED_SCHEMA_CAPABILITIES));

test('the runnable readiness query checks every required capability', async () => {
  const sql = await read('../src/supabase/release_readiness_check.sql');
  const listed = new Set([...sql.matchAll(/\('([a-z_]+)',\s*'[^']+'\)/g)].map(m => m[1]));
  assert.deepEqual([...capabilities()].filter(c => !listed.has(c)), []);
  assert.deepEqual([...listed].filter(c => !capabilities().has(c)), []);
});

test('the TestFlight gate checks every required capability', async () => {
  const yaml = await read('../codemagic.yaml');
  const block = yaml.match(/const required = \[([\s\S]*?)\];/);
  assert.ok(block, 'expected a required[] list in the codemagic capability gate');
  const listed = new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]));
  assert.deepEqual([...capabilities()].filter(c => !listed.has(c)), []);
  assert.deepEqual([...listed].filter(c => !capabilities().has(c)), []);
});

test('every capability a migration installs is one a release gate knows about', async () => {
  // casual_visit_payments was written by a migration and named by no gate at
  // all, so nothing anywhere would have said if it had never been applied.
  const { readdir } = await import('node:fs/promises');
  const dirs = ['../supabase/migrations/', '../src/supabase/'];
  const installed = new Set();
  for (const dir of dirs) {
    const url = new URL(dir, import.meta.url);
    for (const name of await readdir(url)) {
      if (!name.endsWith('.sql')) continue;
      const sql = await readFile(new URL(name, url), 'utf8');
      for (const m of sql.matchAll(/xert_schema_capabilities\s*\(capability\)\s*values\s*\('([a-z_0-9]+)'/g)) {
        installed.add(m[1]);
      }
    }
  }
  assert.ok(installed.size > 40, `expected to find the capability inserts, found ${installed.size}`);
  assert.deepEqual([...installed].filter(c => !capabilities().has(c)), []);
});
