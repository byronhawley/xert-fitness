// Shared synthetic world for the staff roster database tests.
// SYNTHETIC DATA ONLY: fictional coaches, a fictional owner and fictional
// classes. Email notices stay off, so nothing here can message a real person.
import assert from 'node:assert/strict';

import { migratedDatabase, as } from './staff-roster-db.mjs';
import { addMonths, gymInstantIso, monthKeyOf, gymInstant, dateInMonth } from '../../src/lib/staffRoster/time.js';
import { gymDateKey } from '../../src/lib/gymTime.js';

export const TODAY = gymDateKey(new Date());
export const MONTH = addMonths(monthKeyOf(TODAY), 2);
export const MONTH_DATE = `${MONTH}-01`;
export const NEXT = addMonths(MONTH, 1);
export const day = n => dateInMonth(MONTH, n);
export const ids = {
  owner: '00000000-0000-4000-8000-000000000001',
  member: '00000000-0000-4000-8000-000000000002',
  ava: '00000000-0000-4000-8000-0000000000a1',
  ben: '00000000-0000-4000-8000-0000000000b1',
  cam: '00000000-0000-4000-8000-0000000000c1',
};
let requestCounter = 0;
export const rid = () => `10000000-0000-4000-8000-${String(++requestCounter).padStart(12, '0')}`;

export const STUB_CLASS_UPDATE = `
  create function public.admin_update_class_session(p_session_id uuid, p_session jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
  begin
    if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
    update public.class_sessions set start_time = (p_session->>'start_time')::timestamptz, end_time = (p_session->>'end_time')::timestamptz,
      duration_minutes = (p_session->>'duration_minutes')::integer, title = p_session->>'title', updated_at = now() where id = p_session_id;
    return p_session_id;
  end; $$;
`;

export async function rpc(db, uid, sql, params = []) {
  await as(db, uid);
  const { rows } = await db.query(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

export async function rejects(db, uid, sql, params, pattern) {
  await as(db, uid);
  await assert.rejects(() => db.query(sql, params), error => pattern.test(error.message) || pattern.test(String(error.detail)));
}

// `openPeriod: false` leaves MONTH without a period, e.g. to open a part-month one.
export async function world({ enabled = true, openPeriod = true } = {}) {
  const db = await migratedDatabase({ extraSql: STUB_CLASS_UPDATE });
  await db.exec(`
    insert into public.profiles (id, full_name, email, role) values
      ('${ids.owner}', 'Synthetic Owner', 'owner@example.test', 'admin'),
      ('${ids.member}', 'Synthetic Member', 'member@example.test', 'member'),
      ('${ids.ava}', 'Ava Synthetic', 'ava@example.test', 'member'),
      ('${ids.ben}', 'Ben Synthetic', 'ben@example.test', 'member'),
      ('${ids.cam}', 'Cam Synthetic', 'cam@example.test', 'member');
    update public.staff_roster_settings set enabled = ${enabled};
  `);
  const staff = {};
  for (const [key, name, roles] of [['ava', 'Ava', ['lead', 'assistant']], ['ben', 'Ben', ['lead', 'assistant']], ['cam', 'Cam', ['shadow']]]) {
    const row = await rpc(db, ids.owner, 'select public.staff_roster_upsert_staff($1::jsonb, null, $2)', [
      JSON.stringify({ display_name: name, profile_id: ids[key], roles }), rid()]);
    staff[key] = row.id;
  }
  if (openPeriod) {
    await rpc(db, ids.owner, 'select public.staff_roster_open_period($1, $2, $3, $4, false, $5)', [MONTH_DATE, TODAY, dateInMonth(addMonths(MONTH, -1), 5), dateInMonth(addMonths(MONTH, -1), 10), rid()]);
  }
  return { db, staff };
}

export async function addSession(db, date, minute, duration, extra = {}) {
  const { rows } = await db.query(
    `insert into public.class_sessions (start_time, end_time, duration_minutes, title, status, class_type)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [gymInstantIso(date, minute), new Date(gymInstant(date, minute) + duration * 60000).toISOString(), duration,
      extra.title || 'Synthetic class', extra.status || 'published', extra.classType || 'XERT Strength']);
  return rows[0].id;
}

export const allWeek = (start, end, status = 'AVAILABLE') => ({ weekly: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start, end, status })), exceptions: [] });

export async function submit(db, uid, payload, month = MONTH_DATE) {
  return rpc(db, uid, 'select public.staff_roster_submit_availability($1, $2::jsonb, $3)', [month, JSON.stringify(payload), rid()]);
}

export async function draftVersion(db, month = MONTH_DATE) {
  const { rows } = await db.query(`select version from public.staff_roster_revisions where month = $1 and state = 'draft'`, [month]);
  return rows[0]?.version ?? 0;
}

export async function apply(db, changes, month = MONTH_DATE) {
  return rpc(db, ids.owner, 'select public.staff_roster_apply_changes($1, $2, $3::jsonb, $4)', [month, await draftVersion(db, month), JSON.stringify(changes), rid()]);
}

export async function applyRejects(db, changes, pattern) {
  await rejects(db, ids.owner, 'select public.staff_roster_apply_changes($1, $2, $3::jsonb, $4)', [MONTH_DATE, await draftVersion(db), JSON.stringify(changes), rid()], pattern);
}

export async function publish(db, reason = null, requestId = rid(), month = MONTH_DATE) {
  return rpc(db, ids.owner, 'select public.staff_roster_publish($1, $2, $3, $4)', [month, await draftVersion(db, month), reason, requestId]);
}
