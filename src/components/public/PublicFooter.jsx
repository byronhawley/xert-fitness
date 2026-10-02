import React from 'react';
import { Link } from 'react-router-dom';
import { Instagram, Mail, MapPin, ShieldCheck } from 'lucide-react';
import { useSiteContent } from '@/lib/siteContent';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { CONTACT_DEFAULTS } from '@/lib/contentDefaults';
import { usePtAvailability } from '@/lib/usePtAvailability';

const LOGO = '/assets/xert-logo-stacked-light.png';

const NAV_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/#facility', label: 'Facility' },
  { to: '/timetable', label: 'Timetable' },
  { to: '/memberships', label: 'Memberships & Passes' },
  { to: '/booking', label: 'Book A Class' },
  { to: '/coaches', label: 'Coaches' },
  { to: '/events', label: 'Event Calendar' },
  { to: '/about', label: 'About XERT' },
  { to: '/training-guide', label: 'Training Guide' },
  { to: '/app', label: 'iOS App' },
  { to: '/trainer-interest', label: 'Coach Interest' },
  { to: '/partner-interest', label: 'Partner / Allied Health' },
  { to: '/contact', label: 'Contact' },
];

const CONTACT_ROW =
  'flex min-h-11 items-center gap-2.5 rounded-full border border-xert-steel/20 bg-xert-steel/[0.06] px-4 py-2 font-body text-sm text-xert-pale/80 transition-colors';

export default function PublicFooter() {
  const contact = useSiteContent('contact', CONTACT_DEFAULTS);
  const { isAdmin } = useSupabaseAuth();
  const pt = usePtAvailability();
  const links = pt.enabled ? NAV_LINKS.flatMap(link => link.to === '/coaches' ? [link, { to: '/pt', label: 'Personal Training' }] : [link]) : NAV_LINKS;

  return (
    <footer
      data-public-footer
      className="bg-xert-ink px-6 pt-12 sm:pt-16"
      style={{ borderTop: '1px solid var(--accent-default-10)', paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom))' }}
    >
      <div className="max-w-5xl mx-auto">
        <div className="mb-10 grid grid-cols-1 gap-9 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)] md:gap-8">
          {/* Brand */}
          <div className="flex items-center gap-4 md:block">
            <img src={LOGO} alt="XERT Fitness. Beat Your Best." loading="lazy" decoding="async" width="574" height="619" className="h-16 w-auto shrink-0 opacity-90 sm:h-20 md:mb-5 md:h-28" />
            <div className="min-w-0">
              <p className="font-body text-xs leading-relaxed text-xert-pale/70 md:mb-3">
                Semi-private functional fitness coaching in Kingaroy, Queensland. Beat Your Best.
              </p>
              <p className="mt-1.5 font-body text-[11px] uppercase tracking-wider text-xert-steel md:mt-0 md:text-xs">Train with purpose. Compete together.</p>
            </div>
          </div>

          {/* Links */}
          <div>
            <p className="mb-2 font-display text-xs uppercase tracking-widest text-xert-steel">Navigate</p>
            <div className="grid grid-cols-2 gap-x-6">
              {links.map(l => (
                <Link key={l.to} to={l.to}
                  className="flex min-h-11 items-center font-body text-sm text-xert-pale/70 transition-colors hover:text-xert-steel">
                  {l.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Contact + CTA */}
          <div>
            <p className="mb-3 font-display text-xs uppercase tracking-widest text-xert-steel">Get In Touch</p>
            <div className="mb-5 flex flex-col gap-2">
              <a href={`mailto:${contact.email}`}
                className={`${CONTACT_ROW} hover:border-xert-steel/50 hover:text-xert-offwhite`}>
                <Mail className="w-3.5 h-3.5 shrink-0 text-xert-steel" aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{contact.email}</span>
              </a>
              <a href={contact.instagram_url} target="_blank" rel="noopener noreferrer"
                className={`${CONTACT_ROW} hover:border-xert-steel/50 hover:text-xert-offwhite`}>
                <Instagram className="w-3.5 h-3.5 shrink-0 text-xert-steel" aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{contact.instagram_handle}</span>
              </a>
              <p className={CONTACT_ROW}>
                <MapPin className="w-3.5 h-3.5 shrink-0 text-xert-steel" aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{contact.address}</span>
              </p>
            </div>
            <Link to="/booking"
              className="xert-btn-primary inline-flex min-h-[52px] w-full items-center justify-center px-5 py-3 font-display text-sm uppercase tracking-wide sm:w-auto">
              Book Your First Session
            </Link>
          </div>
        </div>

        <div aria-hidden="true" className="xert-divider" />

        <div className="flex flex-col items-start gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between sm:pt-6">
          <p className="font-body text-xs text-xert-pale/70">
            © {new Date().getFullYear()} XERT Fitness, Kingaroy QLD 4610. All rights reserved.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link to="/privacy" className="inline-flex min-h-11 items-center font-body text-xs text-xert-pale/70 transition-colors hover:text-xert-steel">Privacy</Link>
            <Link to="/terms" className="inline-flex min-h-11 items-center font-body text-xs text-xert-pale/70 transition-colors hover:text-xert-steel">Terms &amp; Conditions</Link>
            {isAdmin && (
              <Link to="/admin"
                className="xert-chip transition-colors hover:border-xert-steel hover:text-xert-pale"
                style={{ minHeight: '2.75rem', paddingInline: '1rem' }}>
                <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                Admin
              </Link>
            )}
            <p className="font-body text-xs text-xert-steel">
              Beat Your Best.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
