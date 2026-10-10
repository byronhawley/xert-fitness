import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, List } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import Countdown from '@/components/public/Countdown';
import { DEFAULT_TARGET_LAUNCH_DATE, fitboxHandoff } from '@/lib/launchSettings';
import BookingRequestForm from '@/components/public/BookingRequestForm';
import PTRequestForm from '@/components/public/PTRequestForm';
import ClassSessionCard from '@/components/public/ClassSessionCard';
import PublicClassCalendar from '@/components/public/PublicClassCalendar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { getClassSessions, getSoftLaunchSettings, getDefaultSettings } from '@/lib/adminData';
import { getPublicClassAvailability } from '@/lib/submitForms';
import { classSignupState, signupOutcomeMessage } from '@/lib/classSignup';
import VisitorPassChoices from '@/components/public/VisitorPassChoices';
import { shouldOfferVisitorPasses } from '@/lib/visitorPassChoices';
import { gymDateKey } from '@/lib/gymTime';
import { usePtAvailability } from '@/lib/usePtAvailability';

const VIEW_OPTIONS = [
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'list', label: 'List', icon: List },
];

const dialogClasses = 'xert-card border-xert-steel/20 text-xert-pale rounded-2xl sm:rounded-2xl w-[calc(100%-2rem)] gap-0';
const ctaClasses = 'xert-btn-primary inline-flex min-h-[52px] w-full sm:w-auto items-center justify-center px-8 font-display text-base uppercase tracking-wide';

export default function SoftLaunchTimetable() {
  const [sessions, setSessions] = useState([]);
  const [settings, setSettings] = useState(getDefaultSettings());
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState(null);
  const ptBooking = usePtAvailability();
  const [showPTForm, setShowPTForm] = useState(false);
  const [bookingSuccess, setBookingSuccess] = useState(null);
  const [availability, setAvailability] = useState({});
  const [ptSuccess, setPTSuccess] = useState(false);
  const [view, setView] = useState('calendar');
  const [searchParams, setSearchParams] = useSearchParams();
  const fitbox = fitboxHandoff(settings);
  const deepLinkedId = searchParams.get('session') || '';

  useEffect(() => {
    Promise.all([
      getClassSessions(true).catch(() => []),
      getSoftLaunchSettings().catch(() => getDefaultSettings()),
      // Live remaining places. Failing here only hides spot counts; the
      // database still refuses a sign-up once a class is full.
      getPublicClassAvailability().catch(() => ({})),
    ]).then(([s, cfg, places]) => {
      setSessions(s);
      setSettings(cfg);
      setAvailability(places);
      setLoading(false);
    });
  }, []);

  // Re-read remaining places after a sign-up so other visitors on this page
  // see the spot disappear without a reload.
  const refreshAvailability = useCallback(() => {
    getPublicClassAvailability().then(setAvailability).catch(() => {});
  }, []);

  // Counts stop being true the moment the page is left open, and a visitor who
  // starts a sign-up against a stale number is already doomed. Refresh when the
  // tab comes back into view.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') refreshAvailability(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshAvailability]);

  // /booking sends people here for a named class, and /timetable links are
  // shared for one class at a time. Land on that class's day with its sign-up
  // open, instead of at the top of whichever day happens to be next.
  const deepLinkedSession = useMemo(
    () => (deepLinkedId ? sessions.find(item => String(item.id) === deepLinkedId) || null : null),
    [deepLinkedId, sessions],
  );
  useEffect(() => {
    if (!deepLinkedSession) return;
    setSelectedSession(deepLinkedSession);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.delete('session');
      return next;
    }, { replace: true });
  }, [deepLinkedSession, setSearchParams]);

  const selectedSignup = classSignupState({
    session: selectedSession || {},
    availability: selectedSession ? availability[selectedSession.id] : null,
    bookingsEnabled: settings.bookings_enabled,
    fitbox,
  });
  const successCopy = signupOutcomeMessage(bookingSuccess);
  // Memberships are not linked to the website, so a booking charges nobody.
  // Somebody who told the form they are not a member is shown the ways to pay
  // here, rather than being left to find a QR code at the front desk they have
  // not walked into yet.
  const offerPasses = shouldOfferVisitorPasses(bookingSuccess, settings);

  return (
    <div className="bg-xert-navy min-h-screen flex flex-col">
      <PublicNav />

      <main id="main" className="flex-1 pt-16">
        {/* Header */}
        <section className="relative overflow-hidden py-14 sm:py-20 px-6">
          <div aria-hidden="true" className="absolute inset-0 pointer-events-none xert-glow-top" />
          <div className="relative max-w-4xl mx-auto">
            <div className="flex items-center gap-3 mb-6 xert-enter xert-enter-left">
              <div className="h-px w-6 bg-xert-steel" />
              <span className="font-body text-xs text-xert-steel uppercase tracking-[0.2em]">Soft Launch</span>
            </div>
            <h1 className="font-display text-[clamp(2rem,6vw,4rem)] leading-tight text-xert-offwhite uppercase mb-4 xert-enter xert-enter-up">
              Timetable &<br />
              <span className="text-xert-steel">Launch Plan.</span>
            </h1>
            <p className="font-body text-base text-xert-pale/75 leading-relaxed max-w-xl xert-enter xert-enter-up" style={{ animationDelay: '120ms' }}>
              XERT will open in stages. During the first phase, class capacity may be limited while the full facility continues to take shape. Register interest early to secure your spot.
            </p>
            {settings.show_limited_capacity_badge && (
              <div className="xert-chip mt-5">
                <span className="w-1.5 h-1.5 rounded-full bg-xert-pale" />
                <span>Limited foundation capacity</span>
              </div>
            )}
          </div>
        </section>

        {/* Countdown */}
        <Countdown targetDate={settings.target_launch_date || DEFAULT_TARGET_LAUNCH_DATE} enabled={settings.countdown_enabled !== false} />

        {/* Classes */}
        <section className="py-14 sm:py-20 px-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex flex-col gap-4 mb-8 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <h2 className="font-display text-3xl text-xert-offwhite uppercase">What&rsquo;s On</h2>
              <div className="flex flex-wrap items-center gap-3">
                {fitbox.blocked ? (
                  <span role="status" className="xert-chip" style={{ color: 'var(--state-danger-text)', borderColor: 'var(--state-danger-text-40)' }}>
                    FitBox booking link needs attention
                  </span>
                ) : fitbox.active ? (
                  <a href={fitbox.url} target="_blank" rel="noopener noreferrer"
                    className="xert-chip min-h-11 px-4 hover:border-xert-steel transition-colors">
                    Continue to FitBox booking
                  </a>
                ) : !settings.bookings_enabled && (
                  <span className="xert-chip opacity-75">
                    Bookings not yet open
                  </span>
                )}
                <div className="inline-flex rounded-full border border-xert-steel/20 bg-white/[0.03] p-1" role="group" aria-label="Timetable view">
                  {VIEW_OPTIONS.map(option => (
                    <button key={option.key} type="button" onClick={() => setView(option.key)} aria-pressed={view === option.key}
                      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 font-body text-xs uppercase tracking-wider transition-colors
                        ${view === option.key ? 'bg-xert-steel text-xert-navy' : 'text-xert-pale/60 hover:text-xert-offwhite'}`}>
                      <option.icon className="w-3.5 h-3.5" aria-hidden="true" />
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {loading ? (
              <div className="py-20 text-center">
                <div className="w-6 h-6 border-2 border-xert-steel/30 border-t-xert-steel rounded-full animate-spin mx-auto" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="xert-card px-6 py-14 text-center">
                <p className="font-display text-2xl text-xert-offwhite uppercase mb-3">Timetable coming soon</p>
                <p className="font-body text-sm text-xert-pale/60 mb-8 max-w-md mx-auto">
                  Classes will be published here before the August soft launch. Register your interest now to be notified first.
                </p>
                <a href="/#eoi" className={ctaClasses}>
                  Register interest
                </a>
              </div>
            ) : view === 'calendar' ? (
              <PublicClassCalendar
                sessions={sessions}
                bookingsEnabled={settings.bookings_enabled}
                onBook={setSelectedSession}
                fitbox={fitbox}
                availability={availability}
                initialDayKey={deepLinkedSession ? gymDateKey(deepLinkedSession.start_time) : null}
              />
            ) : (
              <div className="space-y-3">
                {sessions.map(s => (
                  <ClassSessionCard key={s.id} session={s} bookingsEnabled={settings.bookings_enabled}
                    onBook={setSelectedSession} fitbox={fitbox} availability={availability[s.id]} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Not a member? The three ways to pay, in the open. The QR codes at the
            front desk are no use to somebody booking from their kitchen. */}
        {settings.casual_payments_enabled !== false && (
          <section className="px-6 pb-4">
            <div className="mx-auto max-w-4xl xert-card p-6 sm:p-8">
              <h2 className="font-display text-xl text-xert-offwhite uppercase">Not a member?</h2>
              <p className="mt-2 mb-5 max-w-md font-body text-sm text-xert-pale/65">
                Book any class above, then pay whichever way suits you. Bring your receipt to your first session.
              </p>
              <VisitorPassChoices settings={settings} signup={{}} />
              <Link to="/memberships"
                className="inline-flex min-h-11 items-center font-body text-xs uppercase tracking-wider text-xert-steel underline underline-offset-4 hover:text-xert-offwhite">
                See every membership and pass, with QR codes
              </Link>
            </div>
          </section>
        )}

        {/* PT Section */}
        <div className="px-6"><div className="xert-divider max-w-4xl mx-auto" /></div>
        <section className="relative overflow-hidden py-14 sm:py-20 px-6">
          <div aria-hidden="true" className="absolute inset-0 pointer-events-none xert-glow-center" />
          <div className="relative max-w-2xl mx-auto text-center">
            <h2 className="font-display text-3xl text-xert-offwhite uppercase mb-3">Personal Training</h2>
            <p className="font-body text-sm text-xert-pale/65 mb-6 max-w-md mx-auto">
              {ptBooking.enabled
                ? 'One-on-one coaching with your coach. Pick a coach, see their prices and book a time online.'
                : 'Looking for 1-on-1 coaching? Request a PT session and we\'ll be in touch to confirm availability.'}
            </p>
            {ptBooking.enabled && (
              <Link to="/pt" className={ctaClasses}>Book PT online</Link>
            )}
            {!ptBooking.enabled && !showPTForm && !ptSuccess && (
              <button onClick={() => setShowPTForm(true)} className={ctaClasses}>
                Request PT session
              </button>
            )}
            {showPTForm && !ptSuccess && (
              <div className="xert-card p-5 sm:p-8 text-left mt-6">
                <PTRequestForm onSuccess={() => { setPTSuccess(true); setShowPTForm(false); }} />
              </div>
            )}
            {ptSuccess && (
              <div className="xert-card-accent p-8 text-center">
                <p className="font-display text-xl text-xert-offwhite uppercase mb-2">PT request received.</p>
                <p className="font-body text-sm text-xert-pale/65">We'll be in touch to confirm your session.</p>
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Booking modal */}
      <Dialog open={Boolean(selectedSession)} onOpenChange={(open) => { if (!open) setSelectedSession(null); }}>
        <DialogContent
          aria-describedby={undefined}
          className={`${dialogClasses} max-w-lg max-h-[90vh] overflow-y-auto p-5 sm:p-6`}
        >
          <DialogHeader className="text-left mb-6">
            <DialogTitle className="font-display font-normal tracking-normal text-xl text-xert-offwhite uppercase">
              {selectedSignup.label}
            </DialogTitle>
          </DialogHeader>
          {selectedSession && (
            <BookingRequestForm
              session={selectedSession}
              submitLabel={selectedSignup.label}
              busyLabel={selectedSignup.takesSpot ? 'Taking your spot...' : 'Submitting...'}
              takesSpot={selectedSignup.takesSpot}
              joinWaitlist={selectedSignup.joinWaitlist}
              consentLabel={selectedSignup.takesSpot
                ? 'I consent to XERT contacting me about this class.'
                : 'I consent to XERT contacting me about this booking request.'}
              onSuccess={result => { setBookingSuccess(result || {}); setSelectedSession(null); refreshAvailability(); }}
              onRejected={refreshAvailability}
              onCancel={() => setSelectedSession(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Booking success */}
      <Dialog open={Boolean(bookingSuccess)} onOpenChange={(open) => { if (!open) setBookingSuccess(null); }}>
        <DialogContent className={`${dialogClasses} max-h-[90vh] overflow-y-auto p-8 text-center ${offerPasses ? 'max-w-md' : 'max-w-sm'}`}>
          <div className="w-12 h-12 rounded-full bg-xert-steel text-xert-navy flex items-center justify-center mx-auto mb-4">
            <span className="text-xl" aria-hidden="true">✓</span>
          </div>
          <DialogTitle className="font-display font-normal tracking-normal leading-none text-2xl text-xert-offwhite uppercase mb-2">
            {successCopy.title}
          </DialogTitle>
          <DialogDescription className="font-body text-sm text-xert-pale/65 mb-6">
            {successCopy.body}
          </DialogDescription>
          {offerPasses && (
            <VisitorPassChoices settings={settings} signup={bookingSuccess}
              note="Your spot is already held — pay now or on arrival. Bring your receipt either way." />
          )}
          {successCopy.cancelToken && (
            <p className="mb-6 font-body text-xs text-xert-pale/55">
              Can&rsquo;t make it?{' '}
              <a href={`/timetable/release?token=${encodeURIComponent(successCopy.cancelToken)}`}
                className="text-xert-steel underline underline-offset-2 hover:text-xert-offwhite">
                Release your spot
              </a>{' '}
              so someone else can take it. The same link is in your confirmation email.
            </p>
          )}
          <button onClick={() => setBookingSuccess(null)}
            className="xert-btn-primary mx-auto inline-flex min-h-[52px] w-full items-center justify-center px-6 font-display text-sm uppercase tracking-wide">
            {offerPasses ? 'Pay later' : 'Done'}
          </button>
        </DialogContent>
      </Dialog>

      <PublicFooter />
    </div>
  );
}
