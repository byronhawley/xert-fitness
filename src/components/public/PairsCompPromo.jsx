import React from 'react';
import { Link } from 'react-router-dom';
import { pairsDaysToGo, pairsEntriesOpen } from '@/lib/pairsCompetition';

// The homepage's notice for the Pairs comp. It comes down by itself once
// entries close at the end of comp day.
export default function PairsCompPromo({ now = new Date() }) {
  if (!pairsEntriesOpen(now)) return null;
  const days = pairsDaysToGo(now);
  const when = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days to go`;
  return (
    <section aria-labelledby="pairs-promo-title" className="xert-glow-center bg-xert-navy px-6 py-14 sm:py-20" data-pairs-promo>
      <div className="mx-auto max-w-3xl">
        <div className="xert-card-accent px-5 py-8 text-center sm:px-10 sm:py-12">
          <span className="xert-chip">Pairs Competition · {when}</span>
          <h2 id="pairs-promo-title" className="mt-6 font-display uppercase leading-none text-xert-offwhite" style={{ fontSize: 'clamp(2.25rem,8vw,4rem)' }}>
            Saturday 19 December
          </h2>
          <p className="mx-auto mt-4 max-w-[42ch] font-body text-base leading-relaxed text-xert-pale/70">
            Grab a partner and enter as a pair. Pick the category that suits you both: Everyday, Intermediate or Advanced.
          </p>
          <div className="mt-7 flex justify-center">
            <Link to="/pairs"
              className="xert-btn-primary inline-flex min-h-[52px] w-full items-center justify-center px-8 py-3.5 font-display text-lg uppercase tracking-wide sm:w-auto sm:py-4">
              Enter your pair
            </Link>
          </div>
          <p className="mt-4 font-body text-xs text-xert-pale/50">Only one of you needs a XERT account to enter.</p>
        </div>
      </div>
    </section>
  );
}
