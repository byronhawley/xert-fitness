import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import AdminConfirmDialog from '@/components/admin/AdminConfirmDialog';
import { ADMIN_BUTTON, ADMIN_INPUT, ADMIN_LABEL, ADMIN_PANEL, ADMIN_TEXT } from '@/components/admin/ui';
import { gymDateKey, gymDateTimeLabel } from '@/lib/gymTime';
import { addDays } from '@/lib/staffRoster/time';
import { BOOKING_STATUS_WORDS, PAYMENT_WORDS, formatPrice, ptClient } from '@/lib/ptBookingData';

const NUMBER_FIELDS = [
  { key: 'min_notice_minutes', label: 'Minimum notice (hours)', toForm: value => value / 60, fromForm: value => Math.round(Number(value) * 60) },
  { key: 'max_days_ahead', label: 'Book up to (days ahead)' },
  { key: 'cancel_cutoff_hours', label: 'Cancel online until (hours before)' },
  { key: 'max_upcoming_per_client', label: 'Upcoming sessions per client' },
];

/**
 * The owner's view of PT booking: the switch, the booking rules every coach
 * shares, which coaches are set up, and what's booked. Coaches run their own
 * prices, hours and clients from their coach screens.
 */
export default function PTBookingAdmin({ client: injected = null }) {
  const [client, setClient] = useState(injected);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = gymDateKey(new Date());

  useEffect(() => { if (!injected) ptClient().then(setClient); }, [injected]);
  const load = useCallback(async () => {
    if (!client) return;
    try {
      const next = await client.adminOverview(today, addDays(today, 30));
      setData(next);
      setForm(Object.fromEntries(NUMBER_FIELDS.map(field => [field.key, String(field.toForm ? field.toForm(next.settings[field.key]) : next.settings[field.key])]).concat([['slot_step_minutes', String(next.settings.slot_step_minutes)]])));
      setError('');
    } catch (failure) {
      setError(failure.code === 'MANAGER_ONLY' ? failure.message : failure.code ? failure.message : 'PT booking isn’t installed yet. Apply the PT booking migration in Supabase first.');
    }
  }, [client, today]);
  useEffect(() => { load(); }, [load]);

  const save = async patch => {
    setBusy(true);
    try {
      await client.adminUpdateSettings(patch, data.settings.version);
      toast({ title: 'Saved' });
      await load();
      return true;
    } catch (failure) {
      toast({ title: failure.message, variant: 'destructive' });
      if (failure.code === 'STALE_VERSION') await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) return <section className={`${ADMIN_PANEL} p-4 mb-6`}><p className={ADMIN_TEXT.sectionHeading}>PT booking</p><p className={`${ADMIN_TEXT.lede} mt-1`}>{error}</p></section>;
  if (!data || !form) return <section className={`${ADMIN_PANEL} p-4 mb-6`}><p className={ADMIN_TEXT.lede} role="status">Loading PT booking…</p></section>;

  const enabled = data.settings.enabled;
  const ready = data.coaches.filter(coach => coach.status === 'active' && coach.services > 0 && coach.has_hours);
  const dirty = NUMBER_FIELDS.some(field => String(field.toForm ? field.toForm(data.settings[field.key]) : data.settings[field.key]) !== form[field.key])
    || String(data.settings.slot_step_minutes) !== form.slot_step_minutes;
  const patch = () => Object.fromEntries(NUMBER_FIELDS.map(field => [field.key, field.fromForm ? field.fromForm(form[field.key]) : Number(form[field.key])]).concat([['slot_step_minutes', Number(form.slot_step_minutes)]]));

  return (
    <section className="mb-8 space-y-4" aria-labelledby="pt-booking-heading">
      <div className={`${ADMIN_PANEL} p-4 sm:p-5 space-y-4`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="pt-booking-heading" className="font-display text-2xl uppercase text-xert-offwhite">PT booking</h2>
            <p className={ADMIN_TEXT.lede}>
              {enabled ? 'On. The public can book coaches at xertfitness.com.au/pt.' : 'Off. Nothing is shown to the public or to coaches.'}
              {' '}Coaches set their own prices, packages and hours in their coach screens, and clients pay them directly.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={ADMIN_BUTTON.ghost} onClick={load} aria-label="Refresh PT booking"><RefreshCw className="w-4 h-4" /></button>
            <button type="button" className={enabled ? ADMIN_BUTTON.danger : ADMIN_BUTTON.primary} onClick={() => setConfirm(true)}>{enabled ? 'Switch off' : 'Switch on'}</button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-5">
          {NUMBER_FIELDS.map(field => (
            <div key={field.key}><label className={ADMIN_LABEL} htmlFor={`pt-${field.key}`}>{field.label}</label>
              <input id={`pt-${field.key}`} type="number" min={0} className={ADMIN_INPUT} value={form[field.key]} onChange={event => setForm({ ...form, [field.key]: event.target.value })} /></div>
          ))}
          <div><label className={ADMIN_LABEL} htmlFor="pt-step">Start times every</label>
            <select id="pt-step" className={ADMIN_INPUT} value={form.slot_step_minutes} onChange={event => setForm({ ...form, slot_step_minutes: event.target.value })}>
              {[10, 15, 20, 30, 60].map(value => <option key={value} value={value}>{value} min</option>)}
            </select></div>
        </div>
        {dirty && <button type="button" className={ADMIN_BUTTON.primary} disabled={busy} onClick={() => save(patch())}>Save booking rules</button>}
      </div>

      <div className={`${ADMIN_PANEL} p-4 sm:p-5`}>
        <p className={ADMIN_TEXT.sectionHeading}>Coaches</p>
        <p className={`${ADMIN_TEXT.lede} mb-3`}>{ready.length} of {data.coaches.length} coaches have a price and hours set. Coaches come from Coach roster; each needs their sign-in linked there.</p>
        <ul className="divide-y divide-white/5">
          {data.coaches.map(coach => (
            <li key={coach.staff_id} className="py-2 flex flex-wrap items-center justify-between gap-2 font-body text-sm">
              <span className="text-xert-offwhite">{coach.name}{coach.status !== 'active' ? ' (inactive)' : ''}</span>
              <span className="text-xert-pale/60">
                {!coach.linked ? 'Sign-in not linked' : coach.services && coach.has_hours ? `${coach.upcoming} upcoming · ${coach.clients} clients` : coach.services ? 'No hours yet' : 'No prices yet'}
              </span>
            </li>
          ))}
          {!data.coaches.length && <li className={`${ADMIN_TEXT.lede} py-2`}>No coaches yet. Add them under Coach roster.</li>}
        </ul>
      </div>

      <div className={`${ADMIN_PANEL} p-4 sm:p-5`}>
        <p className={ADMIN_TEXT.sectionHeading}>Next 30 days</p>
        {data.bookings.length === 0 ? <p className={`${ADMIN_TEXT.lede} mt-1`}>No PT booked.</p> : (
          <ul className="divide-y divide-white/5 mt-2">
            {data.bookings.map(booking => (
              <li key={booking.id} className="py-2 flex flex-wrap items-center justify-between gap-2 font-body text-sm">
                <span className="text-xert-offwhite">{gymDateTimeLabel(booking.starts_at)} · {booking.coach_name} with {booking.client_name}</span>
                <span className="text-xert-pale/60">{booking.service_name} · {BOOKING_STATUS_WORDS[booking.status]} · {booking.payment_status === 'unpaid' ? formatPrice(booking.price_cents) : PAYMENT_WORDS[booking.payment_status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AdminConfirmDialog open={confirm} onOpenChange={setConfirm} busy={busy}
        title={enabled ? 'Switch PT booking off?' : 'Switch PT booking on?'}
        description={enabled
          ? 'The PT page stops taking bookings and coaches lose the PT tab. Bookings already made stay as they are, and their email links keep working.'
          : `The PT page at /pt starts taking bookings for the ${ready.length} coach${ready.length === 1 ? '' : 'es'} with prices and hours set, and every linked coach gets a PT tab.`}
        confirmLabel={enabled ? 'Switch off' : 'Switch on'}
        onConfirm={async () => { if (await save({ enabled: !enabled })) setConfirm(false); }} />
    </section>
  );
}
