// SYNTHETIC DEMO MONTH for browser checks and timing. Fictional coaches,
// fictional classes, example durations and staffing. Email notices stay off
// and every address is on example.invalid, so nothing can reach a real person.
import { migratedDatabase, as } from '../helpers/staff-roster-db.mjs';
import { planPeriodOpening } from '../../src/lib/staffRoster/cycle.js';
import { datesOfMonth, gymInstant, gymInstantIso, weekdayOf } from '../../src/lib/staffRoster/time.js';

let counter = 0;
const rid = () => `20000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

export const DEMO_OWNER = '11111111-1111-4111-8111-111111111111';
export const DEMO_COACHES = [
  { key: 'riley', name: 'Riley Synthetic', roles: ['lead', 'assistant'] },
  { key: 'jordan', name: 'Jordan Synthetic', roles: ['lead', 'assistant'] },
  { key: 'casey', name: 'Casey Synthetic', roles: ['lead', 'assistant'] },
  { key: 'morgan', name: 'Morgan Synthetic', roles: ['lead', 'assistant'] },
  { key: 'taylor', name: 'Taylor Synthetic', roles: ['lead'] },
  { key: 'quinn', name: 'Quinn Synthetic', roles: ['assistant', 'shadow'] },
].map((coach, index) => ({ ...coach, profileId: `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}` }));

const STUB_CLASS_UPDATE = `
  create function public.admin_update_class_session(p_session_id uuid, p_session jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
  begin
    if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
    update public.class_sessions set start_time = (p_session->>'start_time')::timestamptz, end_time = (p_session->>'end_time')::timestamptz,
      duration_minutes = (p_session->>'duration_minutes')::integer, title = p_session->>'title', updated_at = now() where id = p_session_id;
    return p_session_id;
  end; $$;
`;

async function call(db, uid, sql, params = []) {
  await as(db, uid);
  const { rows } = await db.query(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

const week = (days, start, end, status) => days.map(weekday => ({ weekday, start, end, status }));
const WEEKDAYS = [1, 2, 3, 4, 5];

/**
 * A month of synthetic classes and five submitted coaches (one says "not this
 * month"); Quinn has not answered yet. `classesPerDay` scales it for timing.
 */
export async function demoMonth({ month, today, scale = 1, dueOn = null } = {}) {
  const db = await migratedDatabase({ extraSql: STUB_CLASS_UPDATE });
  await db.exec(`insert into public.profiles (id, full_name, email, role) values ('${DEMO_OWNER}', 'Alex Morgan', 'alex@example.invalid', 'admin');`);
  for (const coach of DEMO_COACHES) {
    await db.query(`insert into public.profiles (id, full_name, email, role) values ($1, $2, $3, 'member')`, [coach.profileId, coach.name, `${coach.key}@example.invalid`]);
  }
  await db.exec(`update public.staff_roster_settings set enabled = true, email_notices_enabled = false;`);
  const staff = {};
  for (const coach of DEMO_COACHES) {
    const row = await call(db, DEMO_OWNER, 'select public.staff_roster_upsert_staff($1::jsonb, null, $2)', [JSON.stringify({ display_name: coach.name, profile_id: coach.profileId, roles: coach.roles, target_classes_per_month: 24 }), rid()]);
    staff[coach.key] = row.id;
  }
  await call(db, DEMO_OWNER, 'select public.staff_roster_set_staffing($1, $2, $3::jsonb, 0, $4)', ['class_type', 'XERT Engine',
    JSON.stringify({ slots: [{ key: 'lead', role: 'lead' }, { key: 'assistant', role: 'assistant' }], prep_minutes: 10, wrap_minutes: 0, allow_block: true }), rid()]);

  const sessions = [];
  const insert = async (date, minute, duration, title, classType, status = 'published') => {
    const { rows } = await db.query(`insert into public.class_sessions (start_time, end_time, duration_minutes, title, class_type, status)
      values ($1, $2, $3, $4, $5, $6) returning id`, [gymInstantIso(date, minute), new Date(gymInstant(date, minute) + duration * 60000).toISOString(), duration, title, classType, status]);
    sessions.push(rows[0].id);
  };
  for (const date of datesOfMonth(month)) {
    const weekday = weekdayOf(date);
    for (let copy = 0; copy < scale; copy++) {
      const suffix = scale > 1 ? ` ${copy + 1}` : '';
      if (WEEKDAYS.includes(weekday)) {
        await insert(date, 315, 45, `Strength 5:15${suffix}`, 'XERT Strength');
        await insert(date, 375, 45, `Engine 6:15${suffix}`, 'XERT Engine');
        await insert(date, 570, 60, `Strength 9:30${suffix}`, 'XERT Strength');
        await insert(date, 990, 45, `Engine 4:30${suffix}`, 'XERT Engine');
        await insert(date, 1050, 60, `Strength 5:30${suffix}`, 'XERT Strength');
        if (weekday === 3) await insert(date, 1050, 60, `Mobility 5:30${suffix}`, 'XERT Mobility');
      } else if (weekday === 6) {
        await insert(date, 375, 60, `Saturday Engine${suffix}`, 'XERT Engine');
        await insert(date, 570, 60, `Saturday Strength${suffix}`, 'XERT Strength');
      }
    }
  }
  await insert(datesOfMonth(month)[9], 570, 60, 'Cancelled synthetic class', 'XERT Strength', 'cancelled');

  const monthDate = `${month}-01`;
  const plan = planPeriodOpening(month, { today, dueOn: dueOn || null });
  await call(db, DEMO_OWNER, 'select public.staff_roster_open_period($1, $2, $3, $4, $5, $6)', [monthDate, plan.opensOn, plan.dueOn, plan.publishTargetOn, plan.shortened, rid()]);
  const submit = (key, payload) => call(db, DEMO_COACHES.find(coach => coach.key === key).profileId,
    'select public.staff_roster_submit_availability($1, $2::jsonb, $3)', [monthDate, JSON.stringify({ exceptions: [], ...payload }), rid()]);
  await submit('riley', { weekly: [...week(WEEKDAYS, 300, 480, 'AVAILABLE'), ...week([6], 360, 660, 'PREFERRED')] });
  await submit('jordan', { weekly: [...week(WEEKDAYS, 300, 435, 'PREFERRED'), ...week(WEEKDAYS, 960, 1125, 'AVAILABLE')] });
  await submit('casey', { weekly: [...week(WEEKDAYS, 540, 645, 'AVAILABLE'), ...week(WEEKDAYS, 975, 1125, 'IF_NEEDED')],
    exceptions: [{ date: datesOfMonth(month)[13], start: 0, end: 1440, status: 'UNAVAILABLE' }] });
  await submit('morgan', { weekly: [...week([1, 3, 5], 975, 1125, 'AVAILABLE'), ...week([2, 4], 300, 435, 'AVAILABLE')] });
  await submit('taylor', { weekly: [], exceptions: [], noAvailability: true });
  return { db, staff, sessions, monthDate };
}

/** Calls an entry point the way PostgREST would: named arguments, cast to the declared types. */
export async function rpcAs(db, uid, name, args) {
  const { rows: [fn] } = await db.query(`select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name]);
  if (!fn) { const error = new Error(`Could not find the function public.${name}`); error.code = 'PGRST202'; throw error; }
  const names = fn.names || [];
  const values = [];
  const parts = [];
  for (const [key, value] of Object.entries(args || {})) {
    const index = names.indexOf(key);
    if (index < 0) { const error = new Error(`Unknown argument ${key} for ${name}`); error.code = 'PGRST202'; throw error; }
    const type = fn.types[index];
    values.push(value === null || value === undefined ? null
      : type === 'jsonb' ? JSON.stringify(value)
        : type.endsWith('[]') ? `{${value.join(',')}}` : String(value));
    parts.push(`${key} => $${values.length}::${type}`);
  }
  await as(db, uid);
  const { rows } = await db.query(`select public.${name}(${parts.join(', ')}) as result`, values);
  return rows[0]?.result ?? null;
}
