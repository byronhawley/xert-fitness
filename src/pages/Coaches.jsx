import React, { useEffect, useMemo, useState } from 'react';
import { Dumbbell, Instagram, Target, Users } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import StickyMobileCTA from '@/components/public/StickyMobileCTA';
import PageHeader from '@/components/public/PageHeader';
import Skeleton from '@/components/public/Skeleton';
import { Link } from 'react-router-dom';
import { getCoaches } from '@/lib/bookingData';
import { ptLinkForCoach, usePtAvailability } from '@/lib/usePtAvailability';

const CATEGORY_LABELS = {
  coach: 'Coaching Team',
  nutritionist: 'Nutrition',
  massage: 'Massage Therapy',
  physio: 'Physiotherapy',
  allied: 'Allied Health',
};

function initials(name) {
  return (name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase())
    .join('');
}

function CoachCard({ coach, ptLink = null }) {
  return (
    <article className="xert-card p-3 flex flex-col">
      <div className="aspect-[4/5] rounded-2xl overflow-hidden relative bg-xert-navy/70">
        {coach.photo_url ? (
          <img src={coach.photo_url} alt={coach.name} loading="lazy" decoding="async" className="w-full h-full object-cover" style={{ filter: 'saturate(0.85)' }} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="font-display text-5xl uppercase text-xert-steel/40">
              {initials(coach.name) || 'X'}
            </span>
          </div>
        )}
      </div>

      <div className="px-2 pt-4 pb-2 sm:px-3 flex flex-col flex-1">
        <h3 className="font-display text-2xl uppercase leading-none text-xert-offwhite">{coach.name}</h3>
        {coach.role && (
          <p className="xert-chip mt-3 self-start">{coach.role}</p>
        )}

        {coach.bio && (
          <p className="font-body text-sm leading-relaxed mt-4 text-xert-pale/75">{coach.bio}</p>
        )}

        <div className="mt-4 space-y-2">
          {coach.experience && (
            <div className="flex items-start gap-2">
              <Dumbbell className="w-4 h-4 mt-0.5 shrink-0 text-xert-steel" />
              <p className="font-body text-sm text-xert-pale/65">{coach.experience}</p>
            </div>
          )}
          {coach.currently_training_for && (
            <div className="flex items-start gap-2">
              <Target className="w-4 h-4 mt-0.5 shrink-0 text-xert-steel" />
              <p className="font-body text-sm text-xert-pale/65">
                <span className="uppercase tracking-wider text-[11px] text-xert-steel/75">Currently training for: </span>
                {coach.currently_training_for}
              </p>
            </div>
          )}
        </div>

        {ptLink && (
          <Link to={ptLink} className="xert-btn-primary inline-flex min-h-11 items-center justify-center self-start mt-5 px-4 font-display text-sm uppercase tracking-wide">
            Book PT with {(coach.name || '').split(' ')[0] || 'this coach'}
          </Link>
        )}

        {coach.social_url && (
          <a
            href={coach.social_url}
            target="_blank"
            rel="noopener noreferrer"
            className="xert-btn-ghost inline-flex min-h-11 items-center gap-2 self-start mt-5 px-4 font-body text-xs uppercase tracking-wider"
          >
            <Instagram className="w-4 h-4" />
            Follow
          </a>
        )}
      </div>
    </article>
  );
}

export default function Coaches() {
  const [coaches, setCoaches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const pt = usePtAvailability();

  useEffect(() => {
    getCoaches()
      .then(setCoaches)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const groups = useMemo(() => {
    const coachesList = coaches.filter(c => (c.category || 'coach') === 'coach');
    const allied = coaches.filter(c => (c.category || 'coach') !== 'coach');
    /** @type {{ key: string, coaches: any[] }[]} */
    const sections = [];
    if (coachesList.length) sections.push({ key: 'coach', coaches: coachesList });
    if (allied.length) sections.push({ key: 'allied', coaches: allied });
    return sections;
  }, [coaches]);

  return (
    <div className="min-h-screen bg-xert-navy">
      <PublicNav />

      <main id="main" className="pb-20">
        <PageHeader
          eyebrow="The Team"
          title={<>Coaches &amp;<br /></>}
          accent="Practitioners."
          intro="Every XERT session is coach-led. Our team brings functional fitness coaching together with nutrition, recovery and allied health support — so you can train with structure and progress sustainably."
          containerClassName="max-w-6xl"
        />

        <div className="max-w-6xl mx-auto px-6">
          <div className="mt-10">
            {loading && (
              <div role="status" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <span className="sr-only">Loading the team…</span>
                {[0, 1, 2].map(i => (
                  <div key={i} className="xert-card p-3 flex flex-col">
                    <Skeleton className="aspect-[4/5] w-full rounded-2xl" />
                    <div className="px-2 pt-4 pb-2 space-y-3">
                      <Skeleton className="h-6 w-2/3" />
                      <Skeleton className="h-6 w-1/3 rounded-full" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <p className="font-body text-sm" style={{ color: 'var(--state-danger-text)' }}>Couldn’t load coaches: {error}</p>
            )}

            {!loading && !error && coaches.length === 0 && (
              <div className="xert-card p-10 text-center">
                <span className="xert-icon-tile mx-auto mb-4"><Users className="w-5 h-5" /></span>
                <p className="font-display text-2xl uppercase text-xert-offwhite">Meet the team soon.</p>
                <p className="font-body text-sm mt-2 max-w-md mx-auto text-xert-pale/60">
                  Coach, nutrition, massage and physio profiles are being finalised and will appear here shortly.
                </p>
              </div>
            )}

            {!loading && !error && groups.map(section => (
              <section key={section.key} className="mb-12">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-px w-6 bg-xert-steel" aria-hidden="true" />
                  <h2 className="font-display text-2xl uppercase text-xert-pale/85">
                    {section.key === 'coach' ? CATEGORY_LABELS.coach : 'Health, Recovery & Performance'}
                  </h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {section.coaches.map(c => <CoachCard key={c.id} coach={c} ptLink={ptLinkForCoach(pt, c.id)} />)}
                </div>
              </section>
            ))}
          </div>

          <div className="mt-8">
            <div className="xert-divider mb-8" />
            {pt.enabled && pt.coaches.length > 0 && (
              <div className="xert-card p-5 sm:p-6 mb-6 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="font-display text-2xl uppercase text-xert-offwhite">Personal training</h2>
                  <p className="font-body text-sm text-xert-pale/65 mt-1">One-on-one sessions with your coach. See their prices and book a time online.</p>
                </div>
                <Link to="/pt" className="xert-btn-primary inline-flex min-h-11 items-center justify-center px-5 font-display text-sm uppercase tracking-wide">Book PT</Link>
              </div>
            )}
            <a
              href="/booking"
              className="xert-btn-primary inline-flex min-h-[52px] w-full sm:w-auto items-center justify-center px-8 font-display text-lg uppercase tracking-wide"
            >
              Train With Us
            </a>
          </div>
        </div>
      </main>

      <PublicFooter />
      <StickyMobileCTA />
    </div>
  );
}
