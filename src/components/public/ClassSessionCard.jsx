import React from 'react';
import { classSignupState } from '@/lib/classSignup';
import { gymShortDateLabel, gymTimeLabel } from '@/lib/gymTime';

export const CLASS_COLORS = {
  'XERT Foundation': 'border-status-confirmed-600/40 text-status-confirmed-400',
  'XERT Strength': 'border-status-info-600/40 text-status-info-400',
  'XERT Engine': 'border-xert-orange/40 text-xert-orange',
  'XERT Hybrid': 'border-category-specialty-600/40 text-category-specialty-400',
  'XERT Event Prep': 'border-xert-red/40 text-xert-red',
  'XERT Team': 'border-status-attention-600/40 text-status-attention-400',
};

export const CLASS_DOT_COLORS = {
  'XERT Foundation': 'bg-status-confirmed-400',
  'XERT Strength': 'bg-status-info-400',
  'XERT Engine': 'bg-xert-orange',
  'XERT Hybrid': 'bg-category-specialty-400',
  'XERT Event Prep': 'bg-xert-red',
  'XERT Team': 'bg-status-attention-400',
};

const actionClasses = 'flex min-h-[52px] w-full items-center justify-center px-5 text-center font-display text-sm uppercase tracking-wide';

export default function ClassSessionCard({ session, bookingsEnabled, onBook, fitbox = null, availability = null }) {
  const dotClass = CLASS_DOT_COLORS[session.class_type] || 'bg-xert-steel';
  const signup = classSignupState({ session, availability, bookingsEnabled, fitbox });
  const isFull = signup.kind === 'waitlist';

  return (
    <div className={`xert-card p-4 sm:p-5 ${isFull ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-4">
        {/* Time block */}
        <div className="shrink-0 min-w-[4.25rem] border-r border-xert-steel/15 pr-3 sm:pr-4">
          <p className="font-body text-[10px] uppercase tracking-[0.16em] text-xert-pale/45">Time</p>
          <p className="font-display text-2xl leading-none text-xert-offwhite tabular-nums mt-1">
            {gymTimeLabel(session.start_time) || 'TBC'}
          </p>
          <p className="font-body text-[10px] uppercase tracking-[0.16em] text-xert-pale/45 mt-3">Date</p>
          <p className="font-display text-sm text-xert-pale/85 tabular-nums mt-0.5">
            {gymShortDateLabel(session.start_time) || 'TBC'}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
            <span className="xert-chip whitespace-nowrap">
              <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
              {session.class_type}
            </span>
            {session.beginner_friendly && (
              <span className="xert-chip whitespace-nowrap">
                Beginner friendly
              </span>
            )}
            {isFull && (
              <span className="xert-chip-solid xert-chip whitespace-nowrap">Full</span>
            )}
          </div>
          <h3 className="font-display text-xl leading-tight text-xert-offwhite uppercase">{session.title}</h3>
          {session.coach_name && (
            <p className="font-body text-sm text-xert-pale/65 mt-1.5">
              Coach: <span className="text-xert-pale/90">{session.coach_name}</span>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-white/[0.03] px-3 py-2">
          <p className="font-body text-[10px] text-xert-pale/45 uppercase tracking-wider">Duration</p>
          <p className="font-display text-base text-xert-offwhite tabular-nums">{session.duration_minutes || '—'}min</p>
        </div>
        <div className="rounded-xl bg-white/[0.03] px-3 py-2">
          {/* A live "spots left" counter under copy saying no spot is held read
              as a bookable class. Only a class that actually hands out places
              counts them down; other modes show the session's configured size. */}
          <p className="font-body text-[10px] text-xert-pale/45 uppercase tracking-wider">
            {signup.takesSpot ? 'Spots left' : 'Class size'}
          </p>
          <p className="font-display text-base text-xert-offwhite tabular-nums">
            {signup.takesSpot && signup.spotsLeft !== null
              ? `${signup.spotsLeft}${session.capacity ? ` / ${session.capacity}` : ''}`
              : (session.capacity ? `${session.capacity} places` : 'Set per session')}
          </p>
        </div>
        {session.intensity_level && (
          <div className="rounded-xl bg-white/[0.03] px-3 py-2">
            <p className="font-body text-[10px] text-xert-pale/45 uppercase tracking-wider">Intensity</p>
            <p className="font-display text-base text-xert-pale/85 uppercase">{session.intensity_level}</p>
          </div>
        )}
      </div>

      {signup.detail && (
        <p className="font-body text-xs text-xert-pale/55 mt-3">{signup.detail}</p>
      )}

      <div className="mt-4">
        {signup.kind === 'fitbox' && (
          <a href={fitbox.url} target="_blank" rel="noopener noreferrer"
            className={`xert-btn-primary ${actionClasses}`}>
            {signup.label}
          </a>
        )}

        {signup.kind === 'signup' && (
          <button onClick={() => onBook(session)}
            className={`xert-btn-primary ${actionClasses}`}>
            {signup.label}
          </button>
        )}

        {(signup.kind === 'request' || signup.kind === 'interest' || signup.kind === 'waitlist') && (
          <button onClick={() => onBook(session)}
            className={`${signup.kind === 'request' ? 'xert-btn-primary' : 'xert-btn-ghost'} ${actionClasses}`}>
            {signup.label}
          </button>
        )}

        {(signup.kind === 'past' || signup.kind === 'provider-unavailable') && (
          <button type="button" disabled aria-disabled="true"
            className={`${actionClasses} rounded-[0.875rem] border border-xert-steel/15 bg-white/[0.03] text-xert-pale/40 cursor-not-allowed`}>
            {signup.label}
          </button>
        )}
      </div>
    </div>
  );
}
