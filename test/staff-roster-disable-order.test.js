// Switching the roster off vs switching public coach names off. SYNTHETIC DATA.
//
// Verified in code (staff_roster_update_settings): `enabled = false` changes
// nothing on class_sessions. Only `public_coach_names_enabled` true -> false
// calls staff_roster_withdraw_public_names. So the safe order is names off
// first, then the roster; the Settings screen enforces it.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import { rosterSwitchState } from '../src/lib/staffRoster/switchOrder.js';
import { allWeek, apply, day, ids, publish, rpc, submit, world, addSession } from './helpers/staff-roster-world.mjs';

async function namedWorld() {
  const { db, staff } = await world();
  const { rows: [profile] } = await db.query(`insert into public.coaches (name, published) values ('Ava (website)', true) returning id`);
  await db.query('update public.staff_members set coach_id = $1 where id = $2', [profile.id, staff.ava]);
  await submit(db, ids.ava, allWeek(0, 1440));
  const rostered = await addSession(db, day(3), 360, 60);
  const typed = await addSession(db, day(4), 360, 60);
  await apply(db, [{ op: 'assign', session_id: rostered, slot_key: 'lead', staff_id: staff.ava }, { op: 'assign', session_id: typed, slot_key: 'lead', staff_id: staff.ava }]);
  await db.query(`update public.class_sessions set coach_name = 'Typed by hand' where id = $1`, [typed]);
  const settings = async patch => {
    const version = (await db.query('select version from public.staff_roster_settings')).rows[0].version;
    return rpc(db, ids.owner, 'select public.staff_roster_update_settings($1::jsonb, $2)', [JSON.stringify(patch), version]);
  };
  await settings({ public_coach_names_enabled: true });
  assert.equal((await publish(db, 'Synthetic gaps')).ok, true);
  const names = async () => (await db.query('select id, coach_name from public.class_sessions where id = any($1) order by start_time', [[rostered, typed]])).rows.map(row => row.coach_name);
  assert.deepEqual(await names(), ['Ava (website)', 'Typed by hand']);
  return { db, settings, names };
}

test('switching the whole roster off leaves public names showing (what the old order risked)', async () => {
  const { settings, names } = await namedWorld();
  await settings({ enabled: false });
  assert.deepEqual(await names(), ['Ava (website)', 'Typed by hand'], 'the roster switch alone withdraws nothing');
  // Recovery: the names switch still works while the roster is off.
  const result = await settings({ public_coach_names_enabled: false });
  assert.deepEqual(result.public_names, { enabled: false, cleared: 1, kept_edited: 0 });
  assert.deepEqual(await names(), [null, 'Typed by hand'], 'roster-written name removed, hand-typed name kept');
});

test('the safe order: names off first, then the roster; hand-typed names survive both', async () => {
  const { db, settings, names } = await namedWorld();
  await settings({ public_coach_names_enabled: false });
  assert.deepEqual(await names(), [null, 'Typed by hand']);
  await settings({ enabled: false });
  assert.deepEqual(await names(), [null, 'Typed by hand']);
  const { rows } = await db.query('select count(*)::int as n from public.staff_roster_public_names');
  assert.equal(rows[0].n, 0, 'the roster owns no public name any more');
});

test('Settings only offers "Switch off" once public names are off, and warns if names outlived the roster', () => {
  assert.deepEqual(rosterSwitchState({ enabled: true, public_coach_names_enabled: false }), { canSwitchOff: true, blockReason: null, namesStillShowing: false });
  const blocked = rosterSwitchState({ enabled: true, public_coach_names_enabled: true });
  assert.equal(blocked.canSwitchOff, false);
  assert.match(blocked.blockReason, /Turn off “Show the lead coach on the public timetable” first/);
  assert.match(blocked.blockReason, /names typed by hand stay/);
  assert.deepEqual(rosterSwitchState({ enabled: false, public_coach_names_enabled: true }), { canSwitchOff: false, blockReason: null, namesStillShowing: true });
  assert.deepEqual(rosterSwitchState({ enabled: false, public_coach_names_enabled: false }), { canSwitchOff: false, blockReason: null, namesStillShowing: false });
  assert.deepEqual(rosterSwitchState(null), { canSwitchOff: false, blockReason: null, namesStillShowing: false });
});

const server = await createServer({ configFile: false, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' });
after(() => server.close());

test('the Settings screen renders the enforced order', async () => {
  const { default: SettingsPanel } = await server.ssrLoadModule('/src/components/admin/staffRoster/SettingsPanel.jsx');
  const render = settings => renderToStaticMarkup(React.createElement(SettingsPanel, {
    data: { busy: false, snapshot: { settings: { version: 1, class_time_presets: [], ...settings }, class_type_staffing: [], sessions: [], series: [] } },
    month: '2026-12', today: '2026-10-01', onMutate: () => {}, onSaveStaffing: () => {},
  }));
  const switchButton = html => html.match(/<button[^>]*>Switch (off|on)<\/button>/)[0];
  const on = render({ enabled: true, public_coach_names_enabled: true });
  assert.match(switchButton(on), / disabled=""/);
  assert.match(switchButton(on), /aria-describedby="roster-switch-order"/);
  assert.match(on, /id="roster-switch-order"[^>]*>Turn off/);
  const ready = render({ enabled: true, public_coach_names_enabled: false });
  assert.doesNotMatch(switchButton(ready), / disabled=""/);
  const leftover = render({ enabled: false, public_coach_names_enabled: true });
  assert.match(leftover, /Coach names are still on the public timetable/);
  assert.doesNotMatch(switchButton(leftover), / disabled=""/, 'switching back on is always possible');
});
