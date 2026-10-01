// Feature-off and full-removal paths. SYNTHETIC DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allWeek, apply, day, ids, publish, submit, world, addSession } from './helpers/staff-roster-world.mjs';

const rollbackSql = () => readFile(new URL('../docs/staff-roster/rollback.sql', import.meta.url), 'utf8');
const migrationSql = () => readFile(new URL('../supabase/migrations/20261001010000_staff_roster.sql', import.meta.url), 'utf8');

test('full removal leaves classes intact, removes every roster object, and the migration can be applied again', async () => {
  const { db, staff } = await world();
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(3), 360, 60, { title: 'Synthetic kept class' });
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  await db.query(`update public.class_sessions set coach_name = 'Synthetic name' where id = $1`, [session]);
  const before = (await db.query('select id, title, start_time, coach_name, status from public.class_sessions order by id')).rows;

  await db.exec(await rollbackSql());

  assert.deepEqual((await db.query('select id, title, start_time, coach_name, status from public.class_sessions order by id')).rows, before);
  const leftovers = await db.query(`
    select 'table ' || tablename as name from pg_tables where schemaname = 'public' and (tablename like 'staff\\_%' or tablename = 'class_schedule_series')
    union all select 'function ' || proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'staff\\_%'
    union all select 'column ' || column_name from information_schema.columns where table_schema = 'public' and table_name = 'class_sessions' and column_name like 'series\\_%'
    union all select 'trigger ' || tgname from pg_trigger where tgname like '%staff_roster%'
    union all select 'capability ' || capability from public.xert_schema_capabilities where capability = 'staff_roster'`);
  assert.deepEqual(leftovers.rows, []);

  await db.exec(await migrationSql());
  const { rows } = await db.query('select enabled from public.staff_roster_settings');
  assert.deepEqual(rows, [{ enabled: false }], 'a fresh install starts switched off');
});
