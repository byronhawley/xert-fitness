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
