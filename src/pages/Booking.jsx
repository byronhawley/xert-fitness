import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CalendarDays, List, Loader2, RefreshCw, Users } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import PageHeader from '@/components/public/PageHeader';
import Skeleton from '@/components/public/Skeleton';
import PublicClassCalendar from '@/components/public/PublicClassCalendar';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { getAvailableSessions, bookSession, joinSessionWaitlist, getMyBookings,
} from '@/lib/bookingData';
import { useToast } from '@/components/ui/use-toast';
import { useSiteContent } from '@/lib/siteContent';
import { getSoftLaunchSettings } from '@/lib/adminData';
import { PLATFORM_PROVIDERS, resolvePlatformProvider } from '@/lib/platformProvider';
import { BOOKING_DEFAULTS } from '@/lib/contentDefaults';
import { activeBookingsBySession, bookingTimeConflict, classActionLabel, classIsClosedToBooking } from '@/lib/bookingUi';
import { clearPendingWebCheckout } from '@/lib/webCheckoutRecovery';
import { gymDateKey, gymDayLabel, gymTimeLabel } from '@/lib/gymTime';

// The same two views the public timetable offers, so a member can pick any day
// rather than scroll a list that starts at whichever day happens to be next.
const VIEW_OPTIONS = [
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'list', label: 'List', icon: List },
];

const nativeSteps = [
  'Pay for a casual visit, a Three Day Pass or three months upfront — or sign up for a membership.',
  'Book your sessions online.',
  'Train with expert coaching in a structured semi-private environment.',
];

const fitboxSteps = [
  'Open the secure FitBox member portal.',
  'Choose and confirm your class in FitBox.',
  'Return to XERT for your training tools, forms and updates.',
];

const unavailableSteps = [
  'Retry the secure provider check.',
  'Booking and checkout stay paused.',
  'Contact XERT if access is not restored.',
];

const alertCardClasses = 'rounded-2xl border';
const alertCardStyle = { borderColor: 'var(--state-danger-text-30)', backgroundColor: 'var(--state-danger-text-6)' };
const rowButtonClasses = 'inline-flex min-h-[52px] w-full sm:w-auto items-center justify-center gap-2 px-5 font-display text-base uppercase tracking-wide';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The gym's clock, as on the timetable: the calendar files a class under its
// Brisbane day, so the list and the toast must not use the viewer's own clock.
function formatDay(iso) {
  return gymDayLabel(iso);
}

function formatTime(iso) {
  return gymTimeLabel(iso);
}

export default function Booking() {
  const { session } = useSupabaseAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const pageContent = useSiteContent('booking', BOOKING_DEFAULTS);

  const [sessions, setSessions] = useState([]);
  const [myBookings, setMyBookings] = useState([]);
  // Missing settings are not permission to expose either booking engine.
  const [provider, setProvider] = useState(() => resolvePlatformProvider(null));
  const [loading, setLoading] = useState(true);
  const [bookingId, setBookingId] = useState(null);
  const [loadErrors, setLoadErrors] = useState([]);
  const [view, setView] = useState('calendar');
  const requestedSession = searchParams.get('session');
  const targetSessionId = requestedSession && UUID_PATTERN.test(requestedSession)
    ? requestedSession.toLowerCase()
    : null;

  useEffect(() => {
    if (searchParams.get('purchase') !== 'cancelled') return;
    clearPendingWebCheckout();
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('purchase');
    setSearchParams(nextParams, { replace: true });
    toast({ title: 'Checkout cancelled', description: 'No payment was taken.' });
  }, [searchParams, setSearchParams, toast]);

  const refresh = useCallback(async () => {
    setLoadErrors([]);
    // A refresh invalidates the previous provider decision until the current
    // singleton settings row has been verified again.
    setProvider(resolvePlatformProvider(null));
    const requests = [getAvailableSessions(), getSoftLaunchSettings()];
    if (session) requests.push(getMyBookings());
    const results = await Promise.allSettled(requests);
    const errors = [];
    const apply = (result, label, setter, fallback) => {
      if (result.status === 'fulfilled') setter(result.value);
      else {
        setter(fallback);
        errors.push(`${label}: ${result.reason?.message || 'unavailable'}`);
      }
    };
    apply(results[0], 'Timetable', setSessions, []);
    // On failure the fallback keeps pricing hidden rather than leaking amounts.
    apply(results[1], 'Launch settings', s => setProvider(resolvePlatformProvider(s)), null);
    if (session) apply(results[2], 'Your bookings', setMyBookings, []);
    else setMyBookings([]);
    setLoadErrors(errors);
    setLoading(false);
    if (errors.length) {
      toast({ title: 'Some booking data could not load', description: 'Use retry to refresh the unavailable sections.', variant: 'destructive' });
    }
  }, [session, toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const sessionsByDay = useMemo(() => {
    const groups = new Map();
    for (const s of sessions) {
      const key = formatDay(s.start_time);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    return Array.from(groups.entries());
  }, [sessions]);

  // A link to one class (?session=) opens the calendar on that class's day.
  const targetSession = useMemo(
    () => (targetSessionId ? sessions.find(item => item.id?.toLowerCase() === targetSessionId) || null : null),
    [sessions, targetSessionId],
  );

  const memberBookingsBySession = useMemo(() => activeBookingsBySession(myBookings), [myBookings]);
  const timetableUnavailable = loadErrors.some(error => error.startsWith('Timetable:'));
  const nativeOperations = provider.provider === PLATFORM_PROVIDERS.NATIVE
    && provider.configured
    && !provider.blocked;
  const fitboxActive = provider.provider === PLATFORM_PROVIDERS.FITBOX
    && provider.configured
    && !provider.blocked;
  const bookingSteps = fitboxActive
    ? fitboxSteps
    : nativeOperations
      ? nativeSteps
      : unavailableSteps;

  useEffect(() => {
    if (!requestedSession || loading || timetableUnavailable) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('session');

    if (!nativeOperations) {
      setSearchParams(nextParams, { replace: true });
      return;
    }

    if (!targetSessionId) {
      setSearchParams(nextParams, { replace: true });
      return;
    }

    const targetExists = sessions.some(item => item.id?.toLowerCase() === targetSessionId);
    const target = document.getElementById(`class-session-${targetSessionId}`);
    if (!targetExists || !target) {
      setSearchParams(nextParams, { replace: true });
      toast({
        title: 'Class no longer available',
        description: 'The timetable has changed. Explore the latest available sessions below.',
      });
      return;
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
    setSearchParams(nextParams, { replace: true });
  }, [
    loading,
    nativeOperations,
    requestedSession,
    searchParams,
    sessions,
    setSearchParams,
    targetSessionId,
    timetableUnavailable,
    toast,
  ]);

  const handleBook = async (s) => {
    if (!nativeOperations || !provider.capabilities.canBookInternally) {
      toast({
        title: fitboxActive ? 'Bookings are managed in FitBox' : 'Booking provider unavailable',
        description: fitboxActive
          ? 'Continue through the secure FitBox member portal to choose your class.'
          : provider.blockedReason || 'Refresh before booking a class.',
      });
      return;
    }
    if (!session) {
      toast({ title: 'Sign in to book', description: 'Create a free account and book in seconds.' });
      navigate('/login');
      return;
    }
    setBookingId(s.id);
    try {
      // The same rule the button label uses, and the same one book_session
      // enforces: a class with anyone queued for it is closed to new bookings
      // even when places have freed up, because the queue goes first. Deciding
      // this twice, differently, is how a button labelled "Join waitlist" came
      // to call book_session and answer SESSION_WAITLIST_FIRST.
      const joiningWaitlist = classIsClosedToBooking(s);
      if (joiningWaitlist) await joinSessionWaitlist(s.id);
      else await bookSession(s.id);
      const requested = s.booking_mode === 'request_to_book';
      toast({
        title: joiningWaitlist ? 'Waitlist joined' : requested ? 'Booking request sent' : 'Class booked',
        description: joiningWaitlist
          ? `You are on the waitlist for ${s.title || s.class_type}. XERT will let you know if a place opens up.`
          : requested
          ? `${s.title || s.class_type} is awaiting staff confirmation. XERT will let you know once your place is confirmed.`
          : `${s.title || s.class_type} — ${formatDay(s.start_time)} ${formatTime(s.start_time)}`,
      });
      await refresh();
    } catch (e) {
      toast({ title: 'Booking failed', description: e.message, variant: 'destructive' });
    } finally {
      setBookingId(null);
    }
  };

  const renderSessionRow = s => {
    const queued = Number(s.waiting_count) > 0;
    const full = classIsClosedToBooking(s);
    const existingBooking = memberBookingsBySession.get(s.id);
    const isInterestOnly = s.booking_mode === 'interest_only';
    const isRequest = s.booking_mode === 'request_to_book';
    // Computed even for a full class: joining its waitlist
    // would still land the member in two classes at once.
    const timeConflict = existingBooking ? null : bookingTimeConflict(s, myBookings);
    const actionLabel = classActionLabel({ booking: existingBooking, conflict: timeConflict, full, bookingMode: s.booking_mode });
    return (
      <div
        key={s.id}
        id={`class-session-${s.id.toLowerCase()}`}
        tabIndex={-1}
        className="xert-card p-4 sm:p-5 flex flex-wrap items-center gap-4 focus:outline-none focus:ring-2 focus:ring-xert-steel"
      >
        <p className="font-display text-2xl leading-none uppercase tabular-nums shrink-0 text-xert-steel">
          {formatTime(s.start_time)}
        </p>
        <div className="flex-1 min-w-[12rem]">
          <p className="font-display text-xl uppercase leading-tight text-xert-offwhite">
            {s.title || s.class_type || 'XERT Class'}
          </p>
          <p className="font-body text-xs mt-0.5 text-xert-pale/55">
            {[s.coach_name && `Coach ${s.coach_name}`, s.intensity_level, s.duration_minutes && `${s.duration_minutes} min`]
              .filter(Boolean).join(' · ')}
          </p>
          {isRequest && (
            <p className="font-body text-xs mt-1 text-xert-steel/75">
              Staff confirmation required
            </p>
          )}
          {timeConflict && (
            <p id={`booking-conflict-${s.id}`} className="font-body text-xs mt-1" style={{ color: 'var(--state-danger-text)' }}>
              Overlaps {timeConflict.title || timeConflict.class_type || 'another active booking'}
            </p>
          )}
        </div>
        {s.spots_left !== null && (
          <span className={`xert-chip shrink-0 ${full ? 'opacity-70' : ''}`}>
            {queued && s.spots_left > 0
              ? `${s.waiting_count} waiting`
              : full ? 'Full' : `${s.spots_left} spot${s.spots_left === 1 ? '' : 's'} left`}
          </span>
        )}
        {isInterestOnly ? (
          <Link to="/timetable"
            className={`xert-btn-ghost ${rowButtonClasses} shrink-0`}>
            Register interest
          </Link>
        ) : (
          <button
            onClick={() => handleBook(s)}
            disabled={Boolean(existingBooking) || Boolean(timeConflict) || bookingId === s.id}
            aria-describedby={timeConflict ? `booking-conflict-${s.id}` : undefined}
            className={`xert-btn-primary ${rowButtonClasses} disabled:opacity-40 shrink-0`}>
            {bookingId === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : actionLabel}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-xert-navy">
      <PublicNav />

      <main id="main" className="pb-20">
        <PageHeader
          eyebrow="Classes, Programs, Products"
          title={<>Simple booking.<br /></>}
          accent="Structured training."
          intro={pageContent.intro}
          containerClassName="max-w-6xl"
        />

        <div className="max-w-6xl mx-auto px-6">
          {loadErrors.length > 0 && (
            <div role="alert" className={`${alertCardClasses} mt-6 p-4 sm:p-5 flex flex-wrap items-start gap-3`} style={alertCardStyle}>
              <AlertTriangle className="w-5 h-5 shrink-0" style={{ color: 'var(--state-danger-text)' }} />
              <div className="flex-1 min-w-[12rem]">
                <p className="font-display text-sm uppercase text-xert-offwhite">Some booking information is unavailable</p>
                <p className="font-body text-xs mt-1 text-xert-pale/60">{loadErrors.join(' | ')}</p>
              </div>
              <button type="button" onClick={() => void refresh()} className="xert-btn-ghost inline-flex min-h-11 items-center gap-2 px-4 font-display text-xs uppercase tracking-wide">
                <RefreshCw className="w-4 h-4" /> Retry
              </button>
            </div>
          )}

          {/* Steps */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-10">
            {bookingSteps.map((step, i) => (
              <div key={step} className="xert-card p-5">
                <p className="xert-chip tabular-nums mb-3">STEP {i + 1}</p>
                <p className="font-body text-sm leading-relaxed text-xert-pale/75">{step}</p>
              </div>
            ))}
          </div>

          {provider.blocked && (
            <div role="alert" className={`${alertCardClasses} flex items-start gap-3 p-4 sm:p-5 mt-8`} style={alertCardStyle}>
              <AlertTriangle className="w-5 h-5 shrink-0" style={{ color: 'var(--state-danger-text)' }} aria-hidden="true" />
              <div>
                <p className="font-display text-sm uppercase text-xert-offwhite">Booking provider needs attention</p>
                <p className="mt-1 font-body text-xs leading-relaxed text-xert-pale/65">{provider.blockedReason}</p>
              </div>
            </div>
          )}

          {/* FitBox handoff: memberships, billing and bookings live in the provider portal. */}
          {fitboxActive && (
            <div className="xert-card-accent flex flex-wrap items-center gap-3 p-4 sm:p-5 mt-8">
              <span className="xert-icon-tile"><ArrowRight className="w-5 h-5" aria-hidden="true" /></span>
              <p className="min-w-[14rem] flex-1 font-body text-sm text-xert-pale">
                Memberships, payments and class bookings are managed securely in FitBox. XERT&rsquo;s own checkout and booking buttons are paused to prevent duplicate records.
              </p>
              <a href={provider.portalUrl} target="_blank" rel="noopener noreferrer"
                className={`xert-btn-primary ${rowButtonClasses} shrink-0`}>
                Continue to FitBox
              </a>
            </div>
          )}

          {nativeOperations && (
            <>
          {/* This page used to be the session-pack shop: buy credits here, then
              spend them on a class below. Packs are retired, so what is left is
              the timetable — and a pointer to where paying actually happens. */}
          <section id="packs" className="xert-card-flat mt-12 p-5 text-center sm:p-6">
            <p className="mb-4 font-body text-sm leading-relaxed text-xert-pale/70">
              Not a member yet? Weekly membership, a casual visit, a Three Day Pass or three months
              upfront — every price and how to start.
            </p>
            <Link to="/memberships"
              className="xert-btn-primary inline-flex min-h-[52px] items-center justify-center gap-2 px-6 font-display text-base uppercase tracking-wide">
              Memberships &amp; Passes
              <ArrowRight className="h-4 w-4" />
            </Link>
          </section>

          {/* Timetable */}
          <section id="timetable" className="mt-16">
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-display text-3xl uppercase text-xert-offwhite mb-2">Book A Class</h2>
                <p className="font-body text-sm text-xert-pale/60">
                  Ask for a spot and XERT confirms it. All sessions are scalable to your current level.
                </p>
              </div>
              <div className="inline-flex self-start rounded-full border border-xert-steel/20 bg-white/[0.03] p-1 sm:self-auto" role="group" aria-label="Timetable view">
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

            {loading ? (
              <div role="status" className="space-y-8">
                <span className="sr-only">Loading the timetable…</span>
                {[0, 1].map(day => (
                  <div key={day}>
                    <Skeleton className="h-6 w-48 mb-3" />
                    <div className="space-y-2">
                      {[0, 1, 2].map(row => (
                        <div key={row} className="xert-card p-4 flex flex-wrap items-center gap-4">
                          <Skeleton className="h-6 w-16 shrink-0" />
                          <div className="flex-1 min-w-[12rem] space-y-2">
                            <Skeleton className="h-5 w-1/2" />
                            <Skeleton className="h-3 w-1/3" />
                          </div>
                          <Skeleton className="h-11 w-28 shrink-0" />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : timetableUnavailable ? (
              <div className={`${alertCardClasses} p-8 text-center`} style={alertCardStyle}>
                <p className="font-display text-xl uppercase text-xert-offwhite">Timetable temporarily unavailable</p>
                <button type="button" onClick={() => void refresh()} className="xert-btn-ghost mt-4 inline-flex min-h-11 items-center justify-center px-5 font-display text-sm uppercase tracking-wide">Try again</button>
              </div>
            ) : sessionsByDay.length === 0 ? (
              <div className="xert-card p-10 text-center">
                <Users className="w-8 h-8 mx-auto mb-4" style={{ color: 'var(--accent-default-40)' }} />
                <p className="font-display text-2xl uppercase text-xert-offwhite">Timetable opening soon.</p>
                <p className="font-body text-sm mt-2 max-w-md mx-auto" style={{ color: 'var(--text-secondary-55)' }}>
                  Classes for the launch block are being scheduled. Check back shortly, or register
                  your interest and XERT will let you know the moment they go live.
                </p>
              </div>
            ) : view === 'calendar' ? (
              <PublicClassCalendar
                sessions={sessions}
                renderSession={renderSessionRow}
                initialDayKey={targetSession ? gymDateKey(targetSession.start_time) : null}
              />
            ) : (
              <div className="space-y-8">
                {sessionsByDay.map(([day, list]) => (
                  <div key={day}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-px w-6 bg-xert-steel" aria-hidden="true" />
                      <h3 className="font-display text-xl uppercase text-xert-pale/85">{day}</h3>
                    </div>
                    <div className="space-y-2">
                      {list.map(renderSessionRow)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
            </>
          )}
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}
