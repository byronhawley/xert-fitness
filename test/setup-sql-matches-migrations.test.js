import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { REQUIRED_SCHEMA_CAPABILITIES } from '../src/lib/schemaCapabilities.js';

// The files under src/supabase/ are re-runnable setup scripts, and several of
// them predate the booking overhaul. Re-running one restores the definition it
// carried at the time, silently, with no error and with the schema capability
// marker still reading as applied. These tests pin the two places where that
// has actually mattered.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

// The guard the overhaul replaced. A file still carrying it defines a
// pre-overhaul admin_set_booking_status.
const SUPERSEDED_GUARD = /v_session_status <> 'published'/;
// The migration that restores the current one.
const RESTORING_MIGRATION = '20260906020000';

test('the setup scripts agree with the migrations on who may read a class', async () => {
  const [setup, followups] = await Promise.all([
    read('../src/supabase/rls_policies.sql'),
    read('../supabase/migrations/20260906030000_booking_repair_followups.sql'),
  ]);
  // A class marked 'full' is live and listed — the timetable offers its
  // waitlist. Both definitions of the policy have to say so, or re-running the
  // setup script takes full classes off the public site again.
  const widened = /using \(public_visible = true and status in \('published', 'full'\)\)/;
  assert.match(followups, widened);
  assert.match(setup, widened);
  // And neither may still carry the narrow predicate it replaced.
  const narrow = /using \(public_visible = true and status = 'published'\)/;
  assert.doesNotMatch(setup, narrow);
  assert.doesNotMatch(followups, narrow);
});

test('no repair instruction sends the owner to a file that undoes the overhaul', async () => {
  // Operations Health prints these strings to the owner when a capability is
  // missing. One of them used to name booking_modes_upgrade.sql on its own —
  // a file whose admin_set_booking_status predates class_places_held, so
  // following the app's own advice reverted the capacity fix.
  const entries = Object.entries(REQUIRED_SCHEMA_CAPABILITIES);
  assert.ok(entries.length > 0, 'expected capabilities to check');

  let checked = 0;
  for (const [capability, instruction] of entries) {
    for (const path of instruction.match(/src\/supabase\/[\w.-]+\.sql/g) || []) {
      const sql = await read(`../${path}`);
      if (!SUPERSEDED_GUARD.test(sql)) continue;
      checked += 1;
      assert.ok(
        instruction.includes(RESTORING_MIGRATION),
        `${capability} sends the owner to ${path}, which restores a pre-overhaul `
          + `admin_set_booking_status, without also naming migration ${RESTORING_MIGRATION}.`
      );
    }
  }
  // If this drops to zero the guard has stopped guarding anything — either the
  // stale files were cleaned up (delete this test) or a path stopped matching.
  assert.equal(checked, 1);
});
