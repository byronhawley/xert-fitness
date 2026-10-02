/**
 * The coach dashboard's Home tab: an onboarding checklist and the next few
 * published classes, worked out from `staff_roster_me` and
 * `staff_roster_my_roster`. Pure functions, so the screen and tests agree.
 */
import { toMs } from './time.js';

/** Months the coach can answer now: open, and before the deadline or reopened. */
export function answerableMonths(me) {
  return (me?.periods || []).filter(period => period.is_open && (!period.deadline_passed || period.reopened));
}

/**
 * Checklist rows `{ key, label, done, detail, tab, month? }`. `done: null`
 * means nothing to do right now (shown as neutral, not as a tick).
 */
export function coachChecklist(me, { monthLabel = month => month, dateLabel = date => date } = {}) {
  const rows = [{ key: 'linked', label: 'Sign-in linked to the roster', done: true, detail: 'You can use the coach screens on the website and in the app.', tab: null }];
  const open = answerableMonths(me);
  const waiting = open.find(period => !period.submission);
  if (waiting) {
    const month = waiting.month.slice(0, 7);
    rows.push({ key: 'availability', label: `Availability for ${monthLabel(month)}`, done: false,
      detail: `Due ${dateLabel(waiting.due_on)}. The manager plans the roster from your answers.`, tab: 'availability', month });
  } else if (open.length) {
    const latest = open.at(-1);
    const month = latest.month.slice(0, 7);
    rows.push({ key: 'availability', label: `Availability for ${monthLabel(month)}`, done: true, detail: 'Submitted. You can change it until the deadline.', tab: 'availability', month });
  } else {
    rows.push({ key: 'availability', label: 'Availability', done: null, detail: 'No month is open for availability right now. You’ll get a notice when one opens.', tab: 'availability' });
  }
  const acks = me?.pending_acknowledgements?.length || 0;
  rows.push({ key: 'roster', label: 'Published roster checked', done: acks === 0,
    detail: acks ? `${acks === 1 ? 'A roster has' : `${acks} rosters have`} changed since you last looked.` : 'You’re up to date.', tab: 'roster' });
  const unread = Number(me?.unread_notifications) || 0;
  rows.push({ key: 'inbox', label: 'Notices read', done: unread === 0,
    detail: unread ? `${unread} unread ${unread === 1 ? 'notice' : 'notices'}.` : 'Nothing unread.', tab: 'inbox' });
  return rows;
}

/** The next `limit` live classes from now, soonest first. */
export function upcomingClasses(assignments, now = Date.now(), limit = 3) {
  return (assignments || [])
    .filter(item => item.status !== 'cancelled' && item.status !== 'removed' && toMs(item.end || item.start) > now)
    .sort((a, b) => toMs(a.start) - toMs(b.start))
    .slice(0, limit);
}
