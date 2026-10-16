import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import PassQRCode from '@/components/public/PassQRCode';
import { getSoftLaunchSettings, getDefaultSettings } from '@/lib/adminData';
import { formatCasualVisitPrice } from '@/lib/casualVisit';
import { visitorPassChoices, visitorPassURL, WEEKLY_MEMBERSHIP } from '@/lib/visitorPassChoices';

/**
 * Every way to train at XERT, in one place, with the QR codes.
 *
 * The passes were only reachable by scanning a code at the front desk, and the
 * weekly membership only by being told about it — so somebody deciding at home
 * could not see what any of it cost, let alone choose. This is the page to
 * send them to, and the page the codes on the wall lead back to.
 */
export default function Memberships() {
  const [settings, setSettings] = useState(getDefaultSettings());

  useEffect(() => {
    let active = true;
    getSoftLaunchSettings()
      // A failure here only means the default prices show; the server prices
      // every checkout again before anyone is charged.
      .then(loaded => { if (active) setSettings(loaded); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const origin = typeof window === 'undefined' ? 'https://www.xertfitness.com.au' : window.location.origin;
  const choices = visitorPassChoices(settings);
  const paymentsOn = settings.casual_payments_enabled !== false;

  return (
    <div className="flex min-h-screen flex-col bg-xert-navy">
      <PublicNav />
      <main id="main" className="relative flex-1 px-6 py-24 sm:py-28">
        <div aria-hidden="true" className="xert-glow-top pointer-events-none absolute inset-x-0 top-0 h-96" />
        <div className="relative mx-auto w-full max-w-4xl">
          <div className="mb-5 flex items-center gap-3">
            <div className="h-px w-6 bg-xert-steel" aria-hidden="true" />
            <span className="font-body text-xs uppercase tracking-[0.2em] text-xert-steel">Memberships &amp; Passes</span>
          </div>
          <h1 className="mb-4 font-display text-[clamp(2rem,6vw,3.5rem)] uppercase leading-tight text-xert-offwhite">
            Ways to<br /><span className="text-xert-steel">Train Here.</span>
          </h1>
          <p className="mb-12 max-w-xl font-body text-sm leading-relaxed text-xert-pale/65">
            Join on an ongoing weekly membership, pay for a single visit, try us for three days, buy a
            10 Session Pack, or pay three months upfront. Book any class on the{' '}
            <Link to="/timetable" className="text-xert-steel underline underline-offset-2">timetable</Link>
            {' '}first — you can pay before you come in or when you arrive.
          </p>

          {/* Memberships live in FitBox, not here, so this cannot be a price
              and a button — it is an app to install and an invite to open. */}
          <div className="xert-card mb-4 flex flex-col gap-4 p-6 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-lg uppercase tracking-wide text-xert-offwhite">
                {WEEKLY_MEMBERSHIP.label}
              </h2>
              <p className="mt-1 font-body text-sm text-xert-pale/60">{WEEKLY_MEMBERSHIP.blurb}</p>
              <ol className="mt-3 space-y-2">
                {WEEKLY_MEMBERSHIP.steps.map((step, index) => (
                  <li key={step} className="font-body text-sm text-xert-pale/65">
                    {index + 1}. {step}
                    {index === 0 && (
                      <span className="mt-2 flex flex-wrap gap-2">
                        {WEEKLY_MEMBERSHIP.stores.map(store => (
                          <a key={store.platform} href={store.url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center gap-1.5 border border-xert-steel/30 px-3 font-body text-xs text-xert-pale/80 transition-colors hover:border-xert-steel hover:text-xert-offwhite">
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
                className="mt-4 inline-flex min-h-11 items-center justify-center gap-1.5 border border-xert-steel/40 px-5 font-display text-xs uppercase tracking-wide text-xert-pale transition-colors hover:border-xert-steel hover:text-xert-offwhite">
                Join in FitBox
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
            </div>
            <PassQRCode url={WEEKLY_MEMBERSHIP.url} label={WEEKLY_MEMBERSHIP.label} />
          </div>

          {paymentsOn ? (
            <ul className="grid gap-4 sm:grid-cols-2">
              {choices.map(choice => (
                <li key={choice.kind} className="xert-card flex flex-col gap-4 p-6 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display text-lg uppercase tracking-wide text-xert-offwhite">{choice.label}</h2>
                    <p className="mt-1 font-body text-sm text-xert-pale/60">{choice.blurb}</p>
                    <p className="mt-3 font-display text-2xl text-xert-steel">
                      {choice.discounted && (
                        <span className="mr-2 font-body text-base text-xert-pale/40 line-through">
                          {formatCasualVisitPrice(choice.full)}
                        </span>
                      )}
                      {formatCasualVisitPrice(choice.charge)}
                    </p>
                    <Link to={choice.path}
                      className="xert-btn-primary mt-4 inline-flex min-h-11 items-center justify-center px-5 font-display text-xs uppercase tracking-wide">
                      Pay for this
                    </Link>
                  </div>
                  {/* The same code that is on the wall at the club, so a phone
                      can take it off a laptop screen or a shared photo. */}
                  <PassQRCode url={visitorPassURL(choice, origin)} label={choice.label} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="xert-card p-6">
              <p className="font-body text-sm text-xert-pale/70">
                Visitor passes are not on sale online right now. Speak to the XERT team and they will
                sort you out at the club.
              </p>
            </div>
          )}

          <p className="mt-8 font-body text-xs leading-relaxed text-xert-pale/45">
            Payments are taken by Stripe on their secure page. XERT never sees or stores your card
            details. New here? Please also complete the{' '}
            <Link to="/forms/peq-casual" className="text-xert-steel underline underline-offset-2">
              pre-exercise questionnaire
            </Link>{' '}
            before you train.
          </p>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
