import React from 'react';
import { periodDates } from '@/lib/staffRoster/dayAvailability';
import { gymDateOf, gymMinuteOf, minuteLabel, parseDateKey, toMs } from '@/lib/staffRoster/time';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export { WEEKDAYS };

export function monthName(monthKey) {
  const [year, month] = monthKey.slice(0, 7).split('-').map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

/** "November" — the month alone, for "November classes". */
export function monthOnly(monthKey) {
  return MONTHS[Number(monthKey.slice(5, 7)) - 1];
}

/** "1–30 Nov" — the days a roster month covers; "9–31 Oct" for a period starting part-way. */
export function monthSpan(monthKey, startsOn = null) {
  const key = monthKey.slice(0, 7);
  const dates = periodDates(key, startsOn);
  const all = dates.length ? dates : periodDates(key);
  return `${Number(all[0].slice(8))}–${Number(all[all.length - 1].slice(8))} ${MONTHS[Number(key.slice(5, 7)) - 1].slice(0, 3)}`;
}

export function dateName(dateKey, { weekday = true } = {}) {
  const { year, month, day } = parseDateKey(dateKey);
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${weekday ? `${WEEKDAYS[index].slice(0, 3)} ` : ''}${day} ${MONTHS[month - 1].slice(0, 3)}`;
}

export function at(value) {
  const ms = toMs(value);
  return minuteLabel(gymMinuteOf(ms));
}

export function when(value) {
  const ms = toMs(value);
  return `${dateName(gymDateOf(ms))}, ${at(ms)}`;
}

export const BUTTON = 'xert-btn-primary inline-flex min-h-11 items-center justify-center px-5 font-display text-base uppercase tracking-wide disabled:opacity-50';
export const GHOST = 'xert-btn-ghost inline-flex min-h-11 items-center justify-center gap-1.5 px-4 font-body text-xs uppercase tracking-wider disabled:opacity-50';
export const INPUT = 'xert-input w-full min-h-11 px-3 font-body text-base';
export const LABEL = 'block font-body text-xs uppercase tracking-wider text-xert-pale/60 mb-1';

export const STATUS_WORDS = {
  PREFERRED: 'Preferred', AVAILABLE: 'Available', IF_NEEDED: 'If needed', UNAVAILABLE: 'Unavailable', UNKNOWN: 'Not answered', PARTIAL: 'Only part of the time', ABSENT: 'Away',
};

export function Pill({ tone = 'neutral', children }) {
  return <span className="coaching-pill" data-tone={tone}>{children}</span>;
}

export function Banner({ tone = 'info', title, children, action = null }) {
  return (
    <div className="coaching-banner" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="min-w-0">
        {title && <p className="font-body text-sm font-semibold text-xert-offwhite">{title}</p>}
        {children && <div className="font-body text-sm text-xert-pale/75 mt-0.5">{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="coaching-sheet-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="coaching-sheet" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-2xl uppercase text-xert-offwhite">{title}</h2>
          <button type="button" className={GHOST} onClick={onClose} aria-label={`Close ${title}`}>Close</button>
        </div>
        <div className="mt-4 space-y-4">{children}</div>
        {footer && <div className="mt-5 flex flex-wrap gap-2">{footer}</div>}
      </div>
    </div>
  );
}
