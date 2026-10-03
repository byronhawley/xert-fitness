/**
 * The manager's "This month" guide: five plain steps for one roster month,
 * each with a status and the ONE next action, worked out from the planning
 * snapshot. Pure, so the screen and the tests agree on what "done" means.
 *
 *   1 Add coaches → 2 Ask for availability → 3 Wait for answers
 *   → 4 Build the roster → 5 Publish
 *
 * Steps are a guide, not a gate: the manager can build before every answer
 * is in. `current` is the first step that is not done.
 */
import { partMonthStartRange, planPeriodOpening } from './cycle.js';
import { normalizeStaffing } from './duty.js';
import { submissionProgress } from './snapshot.js';
import { LIVE_SESSION_STATUSES } from './validate.js';
import { addDays, compareDateKeys, dateInMonth } from './time.js';

/**
 * Dates to offer when asking coaches, so the manager rarely types one. Uses
 * the usual monthly dates; when the usual due date has already passed, offers
 * a week from today (but always before the month starts). Returns
 * `{ plan, problem }`; `problem` is set when the month can no longer be asked.
 * @param {string} monthKey
 * @param {{ today?: string, cycle?: object }} [options]
 */
export function suggestedOpening(monthKey, { today, cycle } = {}) {
  try {
    const plan = planPeriodOpening(monthKey, { today, cycle });
    if (!plan.needsDueDate) return { plan, problem: null };
    const lastChance = addDays(dateInMonth(monthKey, 1), -1);
    let dueOn = addDays(today, 7);
    if (compareDateKeys(dueOn, lastChance) > 0) dueOn = compareDateKeys(today, lastChance) <= 0 ? lastChance : today;
    return { plan: { ...planPeriodOpening(monthKey, { today, cycle, dueOn }), suggestedDue: true }, problem: null };
  } catch (error) {
    return { plan: null, problem: error.message };
  }
}

/** Required coaching spots on future, live classes of the month, and how many are filled. */
export function openSpots(ctx) {
  let required = 0;
  let filled = 0;
  let classes = 0;
  let assigned = 0;
  for (const session of ctx.sessions.values()) {
    if (!session.inMonth || session.start <= ctx.now || !LIVE_SESSION_STATUSES.includes(session.status)) continue;
    classes += 1;
    const taken = ctx.bySession.get(session.id) || [];
    assigned += taken.length;
    for (const slot of normalizeStaffing(session.staffing).slots) {
      if (!slot.required) continue;
      required += 1;
      if (taken.some(item => item.slotKey === slot.key)) filled += 1;
    }
  }
  return { required, filled, open: required - filled, classes, assigned };
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = monthKey => MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1];

/**
 * @param {{ snapshot: object, ctx: object, today: string, month: string, dateLabel?: (date: string) => string }} input
 * @returns {{ steps: Array<{ key: string, number: number, title: string, status: 'done' | 'current' | 'todo', attention: boolean, summary: string, why?: string, action: { kind: string, label: string } | null }>, current: string | null }}
 */
export function monthSteps({ snapshot, ctx, today, month, dateLabel = date => date }) {
  const settings = snapshot.settings || {};
  const active = (snapshot.staff || []).filter(member => member.status === 'active');
  const linked = active.filter(member => member.profile_id);
  const unlinked = active.length - linked.length;
  const period = snapshot.period || null;
  const progress = submissionProgress(snapshot, today);
  const spots = openSpots(ctx);
  const started = compareDateKeys(today, dateInMonth(month, 1)) >= 0;
  // A month that has started can still be asked about from a later day.
  const restOfMonth = started && !period ? partMonthStartRange(month, today) : null;
  const steps = [];

  // 1 Add coaches: at least one active coach who can sign in.
  {
    const done = linked.length > 0;
    let summary;
    let action = null;
    if (active.length === 0) { summary = 'No coaches yet. Add the people who run your classes.'; action = { kind: 'add-coach', label: 'Add your first coach' }; }
    else if (!done) { summary = `${plural(active.length, 'coach', 'coaches')} added, but nobody can sign in yet.`; action = { kind: 'coaches', label: 'Send invite links' }; }
    else {
      summary = `${plural(linked.length, 'coach', 'coaches')} ready${unlinked ? `, ${unlinked} still to sign in` : ''}.`;
      action = unlinked ? { kind: 'coaches', label: 'Invite the rest' } : { kind: 'add-coach', label: 'Add another coach' };
    }
    steps.push({ key: 'coaches', title: 'Add coaches', done, attention: false, summary, action });
  }

  // 2 Ask for availability: the month is open to coaches (and coaches can see it).
  {
    let done = Boolean(period) && Boolean(settings.enabled);
    let summary;
    let action = null;
    let why;
    if (!settings.enabled) {
      summary = 'Coach screens are switched off, so coaches can’t answer yet.';
      action = { kind: 'switch-on', label: 'Switch on coach screens' };
      why = 'Coaches see only their own classes and availability. You can switch it off again in Settings.';
    } else if (period) {
      summary = `Asked.${period.starts_on ? ` Roster starts ${dateLabel(period.starts_on)}.` : ''} Due by ${dateLabel(period.due_on)}${period.publish_target_on ? `; aim to publish by ${dateLabel(period.publish_target_on)}` : ''}.`;
      action = { kind: 'availability', label: 'Change the due date' };
    } else if (restOfMonth) {
      summary = `${monthName(month)} has started. You can still ask coaches about the classes from a later day, such as ${dateLabel(restOfMonth.suggested)}. Earlier classes keep their current coach.`;
      action = { kind: 'availability', label: `Ask coaches for the rest of ${monthName(month)}` };
    } else if (started) {
      done = true;
      summary = 'This month has started, so there is nothing to ask. Build the roster from what you know.';
    } else {
      const { plan } = suggestedOpening(month, { today, cycle: settings.cycle });
      summary = plan ? `Coaches get a notice and answer on the website. Suggested due date: ${dateLabel(plan.dueOn)}.` : 'Coaches get a notice and answer on the website.';
      action = { kind: 'availability', label: 'Ask coaches for availability' };
    }
    steps.push({ key: 'ask', title: 'Ask for availability', done, attention: false, summary, why, action });
  }

  // 3 Wait for answers: everyone who can sign in has answered, or the due date passed.
  {
    const total = progress.total;
    const allIn = total > 0 && progress.submitted >= total;
    const pastDue = Boolean(period) && compareDateKeys(today, period.due_on) > 0;
    const done = Boolean(period) && (allIn || pastDue);
    let summary;
    if (!period) summary = started && !restOfMonth ? 'Not needed this month.' : 'Starts once you ask.';
    else if (total === 0) summary = 'No coach can sign in yet, so nobody can answer.';
    else summary = `${progress.submitted} of ${total} in${progress.overdue ? `, ${progress.overdue} overdue` : allIn ? '' : `, due by ${dateLabel(period.due_on)}`}.`;
    steps.push({ key: 'answers', title: 'Wait for answers', done: done || (!period && started && !restOfMonth), attention: progress.overdue > 0, summary,
      counts: { submitted: progress.submitted, total },
      action: period ? { kind: 'availability', label: allIn ? 'See who can do what' : 'See who has answered' } : null });
  }

  // 4 Build the roster: every required spot on a future class has a coach.
  {
    const done = spots.required > 0 ? spots.open === 0 : spots.classes > 0;
    let summary;
    let action;
    if (spots.classes === 0) { summary = 'No upcoming classes on the timetable for this month yet. Add them on the class calendar, then come back.'; action = { kind: 'calendar', label: 'Open the class calendar' }; }
    else if (spots.open === 0) { summary = `All ${plural(spots.required, 'coaching spot')} filled across ${plural(spots.classes, 'class', 'classes')}.`; action = { kind: 'roster', label: 'Look over the roster' }; }
    else if (spots.assigned === 0) { summary = `${plural(spots.classes, 'class', 'classes')} need coaches. Suggest fills them from coaches’ answers; you check it first.`; action = { kind: 'suggest', label: 'Suggest a roster' }; }
    else { summary = `${spots.filled} of ${spots.required} spots filled. ${plural(spots.open, 'spot')} still need a coach.`; action = { kind: 'suggest', label: `Fill ${plural(spots.open, 'open spot')}` }; }
    steps.push({ key: 'build', title: 'Build the roster', done, attention: false, summary, spots, action });
  }

  // 5 Publish: what coaches see matches the latest changes.
  {
    const draft = snapshot.draft;
    const published = snapshot.published;
    const done = Boolean(published) && !draft;
    let summary;
    let action = null;
    const target = period?.publish_target_on ? ` Aim to publish by ${dateLabel(period.publish_target_on)}.` : '';
    if (draft) { summary = `You have changes coaches can’t see yet.${target}`; action = { kind: 'publish', label: published ? 'Publish the changes' : 'Publish the roster' }; }
    else if (published) summary = snapshot.settings?.enabled === false ? 'Published, but coach screens are off, so coaches can’t see it yet.' : `Published. Coaches can see their classes${published.gap_count ? `, with ${plural(published.gap_count, 'open spot')}` : ''}.`;
    else summary = `Nothing published yet.${target}`;
    steps.push({ key: 'publish', title: 'Publish', done, attention: false, summary,
      why: 'Coaches only see the roster once it is published, and get a notice when their classes change.', action });
  }

  const current = steps.find(item => !item.done)?.key || null;
  return {
    current,
    steps: steps.map((item, index) => ({ ...item, number: index + 1, status: item.done ? 'done' : item.key === current ? 'current' : 'todo' })),
  };
}
