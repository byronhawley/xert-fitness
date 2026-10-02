import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarCheck2, ChevronLeft, ChevronRight, Clock, LoaderCircle } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import PageHeader from '@/components/public/PageHeader';
import Skeleton from '@/components/public/Skeleton';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { gymDateKey, gymDayLabel, gymTimeLabel } from '@/lib/gymTime';
import { addDays } from '@/lib/staffRoster/time';
import {
  bookingDetailsError, formatDuration, formatPrice, groupSlotsByDay, newRequestId, packageSaving, ptClient,
} from '@/lib/ptBookingData';

const BUTTON = 'xert-btn-primary inline-flex min-h-[52px] items-center justify-center px-6 font-display text-base uppercase tracking-wide disabled:opacity-50';
const GHOST = 'xert-btn-ghost inline-flex min-h-11 items-center justify-center gap-1.5 px-4 font-body text-xs uppercase tracking-wider disabled:opacity-50';
const INPUT = 'xert-input w-full min-h-11 px-3 font-body text-base';
const LABEL = 'block font-body text-xs uppercase tracking-wider text-xert-pale/60 mb-1';
const DAYS_SHOWN = 7;

function initials(name) {
  return String(name || '').split(' ').filter(Boolean).slice(0, 2).map(word => word[0]?.toUpperCase()).join('') || 'X';
}

function CoachPhoto({ coach, size = 'w-16 h-16' }) {
  return coach.photo_url
    ? <img src={coach.photo_url} alt="" className={`${size} rounded-2xl object-cover shrink-0`} style={{ filter: 'saturate(0.85)' }} />
    : <span aria-hidden="true" className={`${size} rounded-2xl shrink-0 bg-xert-navy/70 flex items-center justify-center font-display text-2xl text-xert-steel/50`}>{initials(coach.name)}</span>;
}

function CoachChoice({ coach, onChoose }) {
  return (
    <article className="xert-card p-4 sm:p-5">
      <div className="flex items-start gap-4">
        <CoachPhoto coach={coach} />
        <div className="min-w-0">
          <h2 className="font-display text-2xl uppercase leading-none text-xert-offwhite">{coach.name}</h2>
          {coach.role && <p className="font-body text-xs uppercase tracking-wider text-xert-steel mt-1.5">{coach.role}</p>}
          {coach.bio && <p className="font-body text-sm text-xert-pale/70 mt-2 line-clamp-3">{coach.bio}</p>}
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {coach.services.map(service => (
          <li key={service.id}>
            <button type="button" onClick={() => onChoose(coach, service)}
              className="w-full text-left rounded-xl border border-xert-steel/20 hover:border-xert-steel/60 focus-visible:border-xert-steel px-4 py-3 min-h-[52px] flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-body text-sm font-semibold text-xert-offwhite">{service.name}</span>
                <span className="block font-body text-xs text-xert-pale/60">
                  {formatDuration(service.duration_minutes)}{service.packages.length ? ` · packages from ${service.packages[0].sessions_count} sessions` : ''}
                </span>
              </span>
              <span className="font-display text-xl text-xert-offwhite shrink-0">{formatPrice(service.price_cents)}</span>
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

function OptionRow({ checked, onChange, title, detail = null, price, name, value }) {
  return (
    <label className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 min-h-[52px] cursor-pointer ${checked ? 'border-xert-steel' : 'border-xert-steel/20'}`}>
      <span className="flex items-center gap-3 min-w-0">
        <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="accent-current" />
        <span className="min-w-0">
          <span className="block font-body text-sm font-semibold text-xert-offwhite">{title}</span>
          {detail && <span className="block font-body text-xs text-xert-pale/60">{detail}</span>}
        </span>
      </span>
      <span className="font-display text-lg text-xert-offwhite shrink-0">{price}</span>
    </label>
  );
}

/**
 * Public PT booking: pick a coach and one of their sessions, an open time,
 * and leave your details. Coaches set their own prices, packages and hours;
 * clients pay the coach directly.
 */
export default function PTBooking({ client: injected = null }) {
  const { user, profile } = useSupabaseAuth();
  const [params, setParams] = useSearchParams();
  const [client, setClient] = useState(injected);
  const [catalog, setCatalog] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [choice, setChoice] = useState(null); // { coach, service }
  const [packageId, setPackageId] = useState('');
  const [from, setFrom] = useState(() => gymDateKey(new Date()));
  const [slots, setSlots] = useState(null);
  const [slotError, setSlotError] = useState('');
  const [time, setTime] = useState('');
  const [details, setDetails] = useState({ full_name: '', email: '', phone: '', notes: '' });
  const [requestId, setRequestId] = useState(() => newRequestId());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const today = gymDateKey(new Date());

  useEffect(() => { if (!injected) ptClient().then(setClient); }, [injected]);
  useEffect(() => {
    if (!client) return;
    client.coaches().then(setCatalog).catch(failure => setLoadError(failure.message));
  }, [client]);

  // Signed-in members don't retype what we already know.
  useEffect(() => {
    if (!user) return;
    setDetails(current => ({
      ...current,
      full_name: current.full_name || profile?.full_name || '',
      email: current.email || user.email || '',
      phone: current.phone || profile?.phone || '',
    }));
  }, [user, profile]);

  const coaches = useMemo(() => catalog?.coaches || [], [catalog]);
  const onlyCoach = params.get('coach');
  const shown = onlyCoach && coaches.some(coach => coach.staff_id === onlyCoach) ? coaches.filter(coach => coach.staff_id === onlyCoach) : coaches;

  const loadSlots = useCallback(async () => {
    if (!client || !choice) return;
    setSlots(null);
    setSlotError('');
    try {
      const result = await client.slots(choice.service.id, from, DAYS_SHOWN);
      setSlots(result.slots || []);
    } catch (failure) {
      setSlotError(failure.message);
      setSlots([]);
    }
  }, [client, choice, from]);
  useEffect(() => { loadSlots(); }, [loadSlots]);

  const days = useMemo(() => groupSlotsByDay(slots), [slots]);

  const choose = (coach, service) => {
    setChoice({ coach, service });
    setPackageId('');
    setTime('');
    setFrom(today);
    setError('');
    setRequestId(newRequestId());
    setParams(current => { const next = new URLSearchParams(current); next.set('coach', coach.staff_id); return next; }, { replace: true });
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  };
  const back = () => { setChoice(null); setTime(''); setSlots(null); };

  const submit = async event => {
    event.preventDefault();
    const problem = bookingDetailsError(details);
    if (problem) { setError(problem); return; }
    setSending(true);
    setError('');
    try {
      const result = await client.book({
        service_id: choice.service.id, starts_at: time, package_id: packageId || null,
        full_name: details.full_name.trim(), email: details.email.trim(), phone: details.phone.trim() || null, notes: details.notes.trim() || null,
      }, requestId);
      setDone(result);
    } catch (failure) {
      setError(failure.message);
      if (failure.code === 'SLOT_UNAVAILABLE') { setTime(''); setRequestId(newRequestId()); loadSlots(); }
      if (failure.code === 'TOO_MANY_BOOKINGS' || failure.code === 'DETAILS_INVALID') setRequestId(newRequestId());
    } finally {
      setSending(false);
    }
  };

  const chosenPackage = choice?.service.packages.find(pack => pack.id === packageId) || null;

  let body;
  if (loadError) {
    body = <p className="font-body text-sm" role="alert" style={{ color: 'var(--state-danger-text)' }}>Couldn’t load personal training: {loadError}</p>;
  } else if (!catalog) {
    body = (
      <div role="status" className="grid gap-4 sm:grid-cols-2">
        <span className="sr-only">Loading coaches…</span>
        {[0, 1].map(i => <div key={i} className="xert-card p-5 space-y-3"><Skeleton className="h-16 w-16 rounded-2xl" /><Skeleton className="h-6 w-1/2" /><Skeleton className="h-12 w-full" /></div>)}
      </div>
    );
  } else if (!catalog.enabled || coaches.length === 0) {
    body = (
      <div className="xert-card p-8 text-center space-y-3">
        <p className="font-display text-2xl uppercase text-xert-offwhite">Online PT booking opens soon</p>
        <p className="font-body text-sm text-xert-pale/70 max-w-md mx-auto">In the meantime, tell us what you’re after and a coach will be in touch.</p>
        <Link to="/contact" className={`${BUTTON} mt-2`}>Get in touch</Link>
      </div>
    );
  } else if (done) {
    const confirmed = done.status === 'confirmed';
    body = (
      <div className="xert-card p-6 sm:p-8 space-y-4" role="status">
        <span className="xert-icon-tile"><CalendarCheck2 className="w-5 h-5" /></span>
        <h2 className="font-display text-3xl uppercase text-xert-offwhite">{confirmed ? 'You’re booked in' : 'Request sent'}</h2>
        <p className="font-body text-base text-xert-pale/80">
          {done.service_name} with {done.coach_name}, {gymDayLabel(done.starts_at)} at {gymTimeLabel(done.starts_at)}.
        </p>
        <p className="font-body text-sm text-xert-pale/70">
          {confirmed ? 'We’ve emailed you the details.' : `${done.coach_name} will confirm shortly, and we’ll email you when they do.`}
          {' '}{done.payment_status === 'package'
            ? `This session comes out of your ${done.package?.name || 'package'} (${done.package?.remaining} left after this one). Pay your coach for the package directly.`
            : `Pay ${formatPrice(done.price_cents)} to your coach directly.`}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Link to={`/pt/booking?token=${encodeURIComponent(done.token)}`} className={GHOST}>View or cancel this booking</Link>
          <button type="button" className={GHOST} onClick={() => { setDone(null); setTime(''); setRequestId(newRequestId()); loadSlots(); }}>Book another time</button>
        </div>
      </div>
    );
  } else if (!choice) {
    body = (
      <>
        {onlyCoach && shown.length === 1 && coaches.length > 1 && (
          <button type="button" className={`${GHOST} mb-4`} onClick={() => setParams({}, { replace: true })}>See all coaches</button>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {shown.map(coach => <CoachChoice key={coach.staff_id} coach={coach} onChoose={choose} />)}
        </div>
      </>
    );
  } else {
    const { coach, service } = choice;
    body = (
      <div className="space-y-5">
        <button type="button" className={GHOST} onClick={back}><ArrowLeft className="w-4 h-4" />All coaches</button>
        <div className="xert-card p-4 sm:p-5 flex items-start gap-4">
          <CoachPhoto coach={coach} size="w-14 h-14" />
          <div className="min-w-0">
            <h2 className="font-display text-2xl uppercase leading-none text-xert-offwhite">{service.name}</h2>
            <p className="font-body text-sm text-xert-pale/70 mt-1">with {coach.name} · {formatDuration(service.duration_minutes)}</p>
            {service.description && <p className="font-body text-sm text-xert-pale/65 mt-2">{service.description}</p>}
          </div>
        </div>

        {service.packages.length > 0 && (
          <fieldset className="space-y-2">
            <legend className={LABEL}>How you’d like to pay</legend>
            <OptionRow name="pt-package" value="" checked={!packageId} onChange={() => setPackageId('')} title="Single session" price={formatPrice(service.price_cents)} />
            {service.packages.map(pack => {
              const saving = packageSaving(service.price_cents, pack);
              return (
                <OptionRow key={pack.id} name="pt-package" value={pack.id} checked={packageId === pack.id} onChange={() => setPackageId(pack.id)}
                  title={pack.name} price={formatPrice(pack.price_cents)}
                  detail={[`${pack.sessions_count} sessions`, saving ? `save ${formatPrice(saving)}` : null, pack.valid_days ? `use within ${pack.valid_days} days` : null].filter(Boolean).join(' · ')} />
              );
            })}
          </fieldset>
        )}

        <section aria-labelledby="pt-times">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 id="pt-times" className={LABEL}>Choose a time</h3>
            <div className="flex gap-1">
              <button type="button" className={GHOST} disabled={from <= today} onClick={() => setFrom(addDays(from, -DAYS_SHOWN) < today ? today : addDays(from, -DAYS_SHOWN))} aria-label="Earlier dates"><ChevronLeft className="w-4 h-4" /></button>
              <button type="button" className={GHOST} onClick={() => setFrom(addDays(from, DAYS_SHOWN))} aria-label="Later dates"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
          {slots === null && <p className="font-body text-sm text-xert-pale/60" role="status"><LoaderCircle className="inline w-4 h-4 animate-spin mr-1" />Finding open times…</p>}
          {slotError && <p className="font-body text-sm" role="alert" style={{ color: 'var(--state-danger-text)' }}>{slotError}</p>}
          {slots && !slotError && days.length === 0 && (
            <p className="font-body text-sm text-xert-pale/70 xert-card p-4">No open times in these {DAYS_SHOWN} days. Try later dates.</p>
          )}
          <div className="space-y-4">
            {days.map(dayGroup => (
              <div key={dayGroup.date}>
                <p className="font-body text-sm font-semibold text-xert-offwhite mb-2">{gymDayLabel(dayGroup.times[0].iso)}</p>
                <div className="flex flex-wrap gap-2">
                  {dayGroup.times.map(slot => (
                    <button key={slot.iso} type="button" aria-pressed={time === slot.iso} onClick={() => { setTime(slot.iso); setError(''); }}
                      className={`min-h-11 min-w-[5.5rem] rounded-xl border px-3 font-body text-sm ${time === slot.iso ? 'bg-xert-steel text-xert-navy border-xert-steel' : 'border-xert-steel/30 text-xert-offwhite hover:border-xert-steel/70'}`}>
                      {gymTimeLabel(slot.iso)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {time && (
          <form onSubmit={submit} className="xert-card p-4 sm:p-5 space-y-4" noValidate>
            <p className="font-body text-sm text-xert-offwhite flex items-center gap-2">
              <Clock className="w-4 h-4 text-xert-steel" />{gymDayLabel(time)} at {gymTimeLabel(time)}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2"><label className={LABEL} htmlFor="pt-name">Your name</label>
                <input id="pt-name" className={INPUT} autoComplete="name" value={details.full_name} onChange={event => setDetails({ ...details, full_name: event.target.value })} /></div>
              <div><label className={LABEL} htmlFor="pt-email">Email</label>
                <input id="pt-email" type="email" className={INPUT} autoComplete="email" value={details.email} onChange={event => setDetails({ ...details, email: event.target.value })} /></div>
              <div><label className={LABEL} htmlFor="pt-phone">Mobile (optional)</label>
                <input id="pt-phone" type="tel" className={INPUT} autoComplete="tel" value={details.phone} onChange={event => setDetails({ ...details, phone: event.target.value })} /></div>
              <div className="sm:col-span-2"><label className={LABEL} htmlFor="pt-notes">Anything your coach should know? (optional)</label>
                <textarea id="pt-notes" rows={3} maxLength={1000} className={`${INPUT} py-2`} value={details.notes} onChange={event => setDetails({ ...details, notes: event.target.value })} /></div>
            </div>
            <p className="font-body text-xs text-xert-pale/60">
              {chosenPackage ? `${chosenPackage.name}: ${formatPrice(chosenPackage.price_cents)}, paid to ${coach.name}.` : `${formatPrice(service.price_cents)}, paid to ${coach.name}.`}
              {' '}{service.booking_mode === 'instant' ? 'This books you in straight away.' : `${coach.name} confirms each booking.`}
              {catalog.cancel_cutoff_hours ? ` Cancel online up to ${catalog.cancel_cutoff_hours} hours before.` : ''}
            </p>
            {error && <p className="font-body text-sm" role="alert" style={{ color: 'var(--state-danger-text)' }}>{error}</p>}
            <button type="submit" className={`${BUTTON} w-full sm:w-auto`} disabled={sending}>
              {sending ? 'Booking…' : service.booking_mode === 'instant' ? 'Book this time' : 'Request this time'}
            </button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-xert-navy">
      <PublicNav />
      <main id="main" className="pb-20">
        <PageHeader eyebrow="Personal training" title="Train one" accent="on one." containerClassName="max-w-3xl"
          intro="Pick a coach, choose a session and book a time that suits you. Each coach sets their own sessions and prices." />
        <div className="max-w-3xl mx-auto px-6 mt-8">{body}</div>
      </main>
      <PublicFooter />
    </div>
  );
}
