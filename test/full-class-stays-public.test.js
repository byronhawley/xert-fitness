import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// A class marked Full is live and listed: the card shows its Full badge and
// offers the waitlist. Every client that saves a class decides for itself
// whether it stays publicly visible, and any writer still testing for
// 'published' alone deletes a full class from the timetable — taking its
// waitlist path with it — the next time anyone saves that class.
//
// The web editor is covered by 'marking a class full keeps it on the public
// timetable' in scheduling.test.js. These are the writers that were not.
//
// The database repair for this (20260906030000) is one-shot: it un-hides the
// classes that were already wrongly hidden. Nothing stops a client hiding them
// again, so these checks are permanent, not landing checks.

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('the phone keeps a full class on the public timetable', async () => {
  const [api, view] = await Promise.all([
    read('../ios/XertFitnessApp/XertFitnessApp/Services/XertAPI.swift'),
    read('../ios/XertFitnessApp/XertFitnessApp/Views/AdminCommandCentreView.swift'),
  ]);
  // The owner can mark a class Full from the phone, so this writer matters.
  assert.match(view, /Text\("Full"\)\.tag\("full"\)/);
  assert.match(api, /public_visible: \["published", "full"\]\.contains\(draft\.status\) && draft\.publicVisible,/);
  assert.doesNotMatch(api, /public_visible: draft\.status == "published" && draft\.publicVisible,/);
});

test('the RLS policy and the migration both let the public see a full class', async () => {
  const [policy, followups] = await Promise.all([
    read('../src/supabase/rls_policies.sql'),
    read('../supabase/migrations/20260906030000_booking_repair_followups.sql'),
  ]);
  const widened = /status in \('published', 'full'\)/;
  assert.match(policy, widened);
  assert.match(followups, widened);
});
