import React from 'react';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatCasualVisitPrice, rememberCasualVisitor } from '@/lib/casualVisit';
import { visitorDetailsFromSignup, visitorPassChoices, WEEKLY_MEMBERSHIP } from '@/lib/visitorPassChoices';

/**
 * The four ways a non-member can pay for, or join for, the class they have
 * just booked: three passes sold here, and a weekly membership set up in
 * FitBox because that is where memberships live.
 *
 * Their details carry across to the passes, so nobody retypes a name and
 * number they gave thirty seconds ago on the same screen.
 */
export default function VisitorPassChoices({ settings, signup, note = '', onChoose = undefined }) {
  const choices = visitorPassChoices(settings);
  const visitor = visitorDetailsFromSignup(signup);
  // Standing on the page with nobody's details to carry, remembering would
  // overwrite whatever an earlier form left with a row of blanks.
  const carry = Boolean(visitor.email);

  return (
    <div className="mb-6 text-left">
      <p className="mb-3 font-body text-xs uppercase tracking-wider text-xert-pale/55">
        How to pay or join
      </p>
      {/* Listed first, and the one this site cannot sell. Memberships
          live in FitBox, so it gets its own block: a link styled like the
          others would promise a checkout that is not there. */}
      <div className="mb-2 border border-xert-steel/25 p-3">
        <p className="font-display text-sm uppercase tracking-wide text-xert-offwhite">
          {WEEKLY_MEMBERSHIP.label}
        </p>
        <p className="font-body text-xs text-xert-pale/60">{WEEKLY_MEMBERSHIP.blurb}</p>
        <ol className="mt-2 space-y-1.5">
          {WEEKLY_MEMBERSHIP.steps.map((step, index) => (
            <li key={step} className="font-body text-xs text-xert-pale/60">
              {index + 1}. {step}
              {index === 0 && (
                <span className="mt-1.5 flex flex-wrap gap-2">
                  {WEEKLY_MEMBERSHIP.stores.map(store => (
                    <a key={store.platform} href={store.url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center gap-1.5 border border-xert-steel/30 px-3 text-xs text-xert-pale/80 transition-colors hover:border-xert-steel hover:text-xert-offwhite">
                      {store.label}
                      <ExternalLink aria-hidden="true" className="h-3 w-3" />
                    </a>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>
        <a href={WEEKLY_MEMBERSHIP.url} target="_blank" rel="noopener noreferrer"
          onClick={() => onChoose?.(WEEKLY_MEMBERSHIP)}
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 border border-xert-steel/40 px-4 font-display text-xs uppercase tracking-wide text-xert-pale transition-colors hover:border-xert-steel hover:text-xert-offwhite">
          Join in FitBox
          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
        </a>
      </div>
      <ul className="space-y-2">
        {choices.map(choice => (
          <li key={choice.kind}>
            <Link to={choice.path}
              onClick={() => { if (carry) rememberCasualVisitor(visitor); onChoose?.(choice); }}
              className="flex min-h-[52px] items-center justify-between gap-3 border border-xert-steel/25 p-3 transition-colors hover:border-xert-steel hover:bg-xert-steel/10">
              <span className="min-w-0">
                <span className="block font-display text-sm uppercase tracking-wide text-xert-offwhite">
                  {choice.label}
                </span>
                <span className="block font-body text-xs text-xert-pale/60">{choice.blurb}</span>
              </span>
              <span className="shrink-0 text-right">
                {choice.discounted && (
                  <span className="block font-body text-xs text-xert-pale/45 line-through">
                    {formatCasualVisitPrice(choice.full)}
                  </span>
                )}
                <span className="block font-display text-sm text-xert-steel">
                  {formatCasualVisitPrice(choice.charge)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {note && (
        <p className="mt-3 font-body text-xs leading-relaxed text-xert-pale/55">{note}</p>
      )}
    </div>
  );
}
