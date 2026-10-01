// Public coach names on the timetable come from the published roster only when
// the manager switches it on, only for coaches with a published website
// profile, and never over a name typed on the class by hand. SYNTHETIC DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MONTH_DATE, allWeek, apply, day, ids, publish, rpc, submit, world, addSession } from './helpers/staff-roster-world.mjs';

async function setup() {
  const { db, staff } = await world();
  const { rows: [ava] } = await db.query(`insert into public.coaches (name, published) values ('Ava (website)', true) returning id`);
  const { rows: [ben] } = await db.query(`insert into public.coaches (name, published) values ('Ben (hidden profile)', false) returning id`);
  await db.query('update public.staff_members set coach_id = $1 where id = $2', [ava.id, staff.ava]);
  await db.query('update public.staff_members set coach_id = $1 where id = $2', [ben.id, staff.ben]);
  await submit(db, ids.ava, allWeek(0, 1440));
  await submit(db, ids.ben, allWeek(0, 1440));
  const first = await addSession(db, day(3), 360, 60);
  const second = await addSession(db, day(4), 360, 60);
  const typed = await addSession(db, day(5), 360, 60);
  await db.query(`update public.class_sessions set coach_name = 'Typed by hand' where id = $1`, [typed]);
  const coachName = async id => (await db.query('select coach_name from public.class_sessions where id = $1', [id])).rows[0].coach_name;
  return { db, staff, first, second, typed, coachName };
}

const assign = (session, staff) => ({ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff });

test('public coach names stay off by default: publishing leaves the timetable untouched', async () => {
  const { db, staff, first, coachName } = await setup();
  await apply(db, [assign(first, staff.ava)]);
  const result = await publish(db, 'Synthetic gaps for the test');
  assert.equal(result.ok, true);
  assert.deepEqual(result.public_names, { enabled: false });
  assert.equal(await coachName(first), null);
});

test('when switched on, only published website profiles are named, typed names are kept, and changes follow the roster', async () => {
  const { db, staff, first, second, typed, coachName } = await setup();
  const settings = await rpc(db, ids.owner, 'select public.staff_roster_get_settings()');
  await rpc(db, ids.owner, 'select public.staff_roster_update_settings($1::jsonb, $2)', [JSON.stringify({ public_coach_names_enabled: true }), settings.version]);

  await apply(db, [assign(first, staff.ava), assign(second, staff.ben), assign(typed, staff.ava)]);
  const published = await publish(db);
  assert.deepEqual(published.public_names, { enabled: true, written: 1, cleared: 0, kept_manual: 1 });
  assert.equal(await coachName(first), 'Ava (website)');
  assert.equal(await coachName(second), null, 'a coach without a published website profile is not named');
  assert.equal(await coachName(typed), 'Typed by hand');

  // Next version: Ava comes off the first class, so the name the roster wrote is cleared.
  await rpc(db, ids.owner, 'select (public.staff_roster_draft($1)).id', [MONTH_DATE]);
  const { rows: [draftLine] } = await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
    where r.state = 'draft' and a.session_id = $1`, [first]);
  await apply(db, [{ op: 'unassign', assignment_id: draftLine.id }]);
  const again = await publish(db, 'Synthetic gap for the test');
  assert.equal(again.ok, true);
  assert.equal(again.public_names.cleared, 1);
  assert.equal(await coachName(first), null);
  assert.equal(await coachName(typed), 'Typed by hand');

  const { rows } = await db.query('select count(*)::int as n from public.staff_roster_public_names');
  assert.equal(rows[0].n, 0);
});

async function setNames(db, enabled) {
  const settings = await rpc(db, ids.owner, 'select public.staff_roster_get_settings()');
  return rpc(db, ids.owner, 'select public.staff_roster_update_settings($1::jsonb, $2)', [JSON.stringify({ public_coach_names_enabled: enabled }), settings.version]);
}

test('switching public names off gives back only what the roster wrote; hand-typed and edited names are never destroyed', async () => {
  const { db, staff, first, second, typed, coachName } = await setup();
  const blank = await addSession(db, day(6), 360, 60);
  const edited = await addSession(db, day(7), 360, 60);
  await db.query(`update public.class_sessions set coach_name = '  ' where id = $1`, [blank]);
  await setNames(db, true);
  await apply(db, [assign(first, staff.ava), assign(second, staff.ben), assign(typed, staff.ava), assign(blank, staff.ava), assign(edited, staff.ava)]);
  assert.equal((await publish(db)).ok, true);
  assert.equal(await coachName(blank), 'Ava (website)');
  await db.query(`update public.class_sessions set coach_name = 'Ava, edited on the class' where id = $1`, [edited]);
  // A past class keeps its history even if the roster named it.
  const past = await addSession(db, day(1), 360, 60);
  await db.query(`update public.class_sessions set start_time = now() - interval '2 days', end_time = now() - interval '2 days' + interval '1 hour', coach_name = 'Ava (website)' where id = $1`, [past]);
  await db.query(`insert into public.staff_roster_public_names (session_id, projected_name) values ($1, 'Ava (website)')`, [past]);

  const off = await setNames(db, false);
  assert.equal(off.public_coach_names_enabled, false);
  assert.deepEqual(off.public_names, { enabled: false, cleared: 2, kept_edited: 1 });
  assert.equal(await coachName(first), null, 'roster-written name removed');
  assert.equal(await coachName(blank), '  ', 'the exact earlier value is put back');
  assert.equal(await coachName(typed), 'Typed by hand', 'hand-typed name untouched');
  assert.equal(await coachName(edited), 'Ava, edited on the class', 'a name edited since is left as it is');
  assert.equal(await coachName(past), 'Ava (website)', 'past classes are history');
  const { rows } = await db.query('select session_id from public.staff_roster_public_names');
  assert.deepEqual(rows.map(row => row.session_id), [past], 'the roster no longer owns any upcoming class name');
  const audit = await db.query(`select after from public.staff_roster_audit_events where action = 'public_names_withdrawn'`);
  assert.deepEqual(audit.rows.map(row => row.after), [{ enabled: false, cleared: 2, kept_edited: 1 }]);

  // Publishing while off writes nothing.
  await rpc(db, ids.owner, 'select (public.staff_roster_draft($1)).id', [MONTH_DATE]);
  const { rows: [line] } = await db.query(`select a.id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id
    where r.state = 'draft' and a.session_id = $1`, [blank]);
  await apply(db, [{ op: 'unassign', assignment_id: line.id }]);
  const quiet = await publish(db, 'Synthetic gap for the test');
  assert.deepEqual(quiet.public_names, { enabled: false });
  assert.equal(await coachName(first), null);
});

test('switching public names back on derives them from the current published roster, never from what was shown before', async () => {
  const { db, staff, first, second, typed, coachName } = await setup();
  await setNames(db, true);
  await apply(db, [assign(first, staff.ava), assign(second, staff.ben)]);
  assert.equal((await publish(db, 'Synthetic gap for the test')).ok, true);
  assert.equal(await coachName(first), 'Ava (website)');
  await setNames(db, false);
  assert.equal(await coachName(first), null);

  // While off: Ava moves from the first class to the second, and someone types a name on the first.
  await rpc(db, ids.owner, 'select (public.staff_roster_draft($1)).id', [MONTH_DATE]);
  const lines = (await db.query(`select a.id, a.session_id from public.staff_assignments a join public.staff_roster_revisions r on r.id = a.revision_id where r.state = 'draft'`)).rows;
  await apply(db, lines.map(row => ({ op: 'unassign', assignment_id: row.id })));
  await apply(db, [assign(second, staff.ava)]);
  assert.equal((await publish(db, 'Synthetic gaps for the test')).ok, true);
  await db.query(`update public.class_sessions set coach_name = 'Guest coach' where id = $1`, [first]);

  const on = await setNames(db, true);
  assert.deepEqual(on.public_names, { enabled: true, written: 1, cleared: 0, kept_manual: 2 });
  assert.equal(await coachName(second), 'Ava (website)', 'named from the roster that is published now');
  assert.equal(await coachName(first), 'Guest coach', 'the old roster name is not brought back over a typed one');
  assert.equal(await coachName(typed), 'Typed by hand');
  const { rows } = await db.query('select session_id, projected_name from public.staff_roster_public_names');
  assert.deepEqual(rows, [{ session_id: second, projected_name: 'Ava (website)' }]);
  const again = await setNames(db, true);
  assert.equal(again.public_names, undefined, 'saving with the switch unchanged does nothing to names');
});
