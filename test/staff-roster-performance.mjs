// Timing for the roster engine on synthetic data. Not part of `npm test`
// (timings vary by machine); run with `node test/staff-roster-performance.mjs`.
// SYNTHETIC DATA ONLY.
import { planningContext as fromSnapshot } from '../src/lib/staffRoster/snapshot.js';
import { coverageReport } from '../src/lib/staffRoster/coverage.js';
import { suggestDraft } from '../src/lib/staffRoster/suggest.js';
import { checkAssignment } from '../src/lib/staffRoster/validate.js';
import { addMonths, datesOfMonth, gymInstant, monthKeyOf, weekdayOf } from '../src/lib/staffRoster/time.js';
import { gymDateKey } from '../src/lib/gymTime.js';
import { coach, everyDay, planningContext, session } from './fixtures/staff-roster-fixtures.mjs';
import { DEMO_OWNER, demoMonth, rpcAs } from './fixtures/staff-roster-demo.mjs';

const time = async (label, fn) => {
  const started = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - started);
  console.log(`${label}: ${ms} ms`);
  return { result, ms };
};

const today = gymDateKey(new Date());
const MONTH = addMonths(monthKeyOf(today), 2);

// 1. The browser demo month through the real database snapshot.
const { db } = await demoMonth({ month: MONTH, today });
const { result: snap } = await time('database planning snapshot (demo month, 129 classes x 6 coaches)', () => rpcAs(db, DEMO_OWNER, 'staff_roster_planning_snapshot', { p_month: `${MONTH}-01` }));
const ctx = fromSnapshot(snap, { view: 'draft', now: Date.now() });
const ids = [...ctx.sessions.values()].filter(item => item.inMonth).map(item => item.id);
await time('coverage report (demo month)', () => coverageReport(ctx, ids));
const { result: demo } = await time('suggest draft (demo month)', () => suggestDraft(ctx, { sessionIds: ids }));
console.log(`  ${demo.summary} added=${demo.added.length} unfilled=${demo.unfilled.length} nodes=${demo.nodes}`);

// 2. Stress: 200 classes x 20 coaches, all in one month, engine only.
const dates = datesOfMonth(MONTH).filter(date => weekdayOf(date) !== 0);
const minutes = [315, 375, 570, 990, 1050, 1110, 1170, 420];
const sessions = [];
for (let index = 0; sessions.length < 200; index++) {
  const date = dates[index % dates.length];
  const minute = minutes[Math.floor(index / dates.length) % minutes.length];
  sessions.push(session(`s${String(sessions.length).padStart(3, '0')}`, date, minute, 45, index % 4 === 0
    ? { staffing: { slots: [{ key: 'lead', role: 'lead' }, { key: 'assistant', role: 'assistant' }], prepMinutes: 10 } } : {}));
}
const staff = Array.from({ length: 20 }, (_, index) => coach(`c${String(index).padStart(2, '0')}`, { targets: { classesPerMonth: 14 }, limits: { maxClassesPerWeek: 6 } }));
const availability = Object.fromEntries(staff.map((member, index) => [member.id, index % 3 === 0
  ? everyDay(300, 720, 'AVAILABLE') : index % 3 === 1 ? everyDay(900, 1260, 'PREFERRED') : everyDay(300, 1260, 'IF_NEEDED')]));
const { result: stress, ms: buildMs } = await time('stress context build (200 x 20)', () => planningContext({ sessions, staff, month: MONTH, availability, now: gymInstant(dates[0], 0) - 86400000 }));
const stressIds = sessions.map(item => item.id);
await time('stress: 4,000 single assignment checks', () => { for (let i = 0; i < 4000; i++) checkAssignment(stress, { sessionId: stressIds[i % 200], slotKey: 'lead', staffId: staff[i % 20].id }); });
await time('stress: coverage report', () => coverageReport(stress, stressIds));
const { result: suggested } = await time('stress: suggest draft', () => suggestDraft(stress, { sessionIds: stressIds }));
console.log(`  ${suggested.summary} added=${suggested.added.length} unfilled=${suggested.unfilled.length} nodes=${suggested.nodes}`);
void buildMs;
