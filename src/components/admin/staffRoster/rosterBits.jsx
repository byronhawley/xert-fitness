import React from 'react';
import { STATUS_LABELS, STATUS_TONE } from './rosterFormat';

/** Badge with an explicit tone (the kit's AdminBadge derives tone from a status word). */
export function Tone({ tone = 'neutral', children, className = '' }) {
  return <span className={`admin-badge ${className}`} data-tone={tone}>{children}</span>;
}

export function AvailabilityBadge({ status }) {
  return <Tone tone={STATUS_TONE[status] || 'neutral'}>{STATUS_LABELS[status] || status}</Tone>;
}

export function Notice({ tone = 'info', title, children, action = null }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className="staff-roster-notice" data-tone={tone}>
      <div className="min-w-0">
        {title && <p className="font-body text-sm font-semibold text-xert-offwhite">{title}</p>}
        {children && <div className="font-body text-sm text-xert-pale/70 mt-0.5">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function ProblemList({ problems }) {
  if (!problems?.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {problems.map((problem, index) => <li key={`${problem.code}-${index}`} className="font-body text-xs text-status-danger-200">{problem.message}</li>)}
    </ul>
  );
}
