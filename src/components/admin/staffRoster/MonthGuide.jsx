import React, { useMemo, useState } from 'react';
import { AdminButton } from '@/components/admin/ui';
import { monthSteps } from '@/lib/staffRoster/monthSteps';
import { dayLabel, monthLabel } from './rosterFormat';

const GUIDE_KEY = 'xert.staffRoster.guideOpen';
const STATUS_WORD = { done: 'Done', current: 'Next', todo: 'Later' };

function readOpen() {
  try { return window.localStorage.getItem(GUIDE_KEY) !== 'closed'; } catch { return true; }
}

/**
 * "This month" step tracker at the top of the roster workspace. Each step
 * says where it stands in words (never colour alone) and offers one button;
 * the current step's button is the primary action on the page.
 */
export default function MonthGuide({ snapshot, ctx, today, month, busy, onAction }) {
  const { steps, current } = useMemo(() => monthSteps({ snapshot, ctx, today, month, dateLabel: date => dayLabel(date) }), [snapshot, ctx, today, month]);
  const [open, setOpen] = useState(readOpen);
  const currentStep = steps.find(item => item.key === current);
  const doneCount = steps.filter(item => item.status === 'done').length;
  const toggle = event => {
    const next = event.currentTarget.open;
    setOpen(next);
    try { window.localStorage.setItem(GUIDE_KEY, next ? 'open' : 'closed'); } catch { /* per-viewer convenience only */ }
  };

  return (
    <details className="staff-roster-guide" open={open} onToggle={toggle} aria-label={`${monthLabel(month)} steps`}>
      <summary className="staff-roster-guide-summary">
        <span className="min-w-0">
          <span className="font-body text-xs uppercase tracking-wider text-xert-pale/60 block">This month · {monthLabel(month)}</span>
          <span className="font-body text-base font-semibold text-xert-offwhite block">
            {currentStep ? `Step ${currentStep.number} of ${steps.length}: ${currentStep.title}` : 'All done for this month'}
          </span>
        </span>
        <span className="font-body text-xs text-xert-pale/70 whitespace-nowrap">{doneCount} of {steps.length} done · <span className="underline">{open ? 'Hide steps' : 'Show steps'}</span></span>
      </summary>
      <ol className="staff-roster-steps" aria-label="Steps for this month">
        {steps.map(item => (
          <li key={item.key} className="staff-roster-step" data-status={item.status} data-attention={item.attention} aria-current={item.status === 'current' ? 'step' : undefined}>
            <div className="flex items-center gap-2">
              <span className="staff-roster-step-number" aria-hidden="true">{item.status === 'done' ? '✓' : item.number}</span>
              <span className="min-w-0">
                <span className="font-body text-sm font-semibold text-xert-offwhite block">{item.title}</span>
                <span className="staff-roster-step-status">{STATUS_WORD[item.status]}{item.attention ? ' · needs a nudge' : ''}</span>
              </span>
            </div>
            <p className="font-body text-sm text-xert-pale/75">{item.summary}</p>
            {item.why && item.status !== 'done' && <p className="font-body text-xs text-xert-pale/55">{item.why}</p>}
            {item.action && (
              <AdminButton variant={item.status === 'current' ? 'primary' : 'ghost'} disabled={busy} onClick={() => onAction(item.action.kind)}
                aria-label={`${item.action.label} (step ${item.number}, ${item.title})`}>
                {item.action.label}
              </AdminButton>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
