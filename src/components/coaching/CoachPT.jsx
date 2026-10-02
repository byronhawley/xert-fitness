import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { gymDateKey } from '@/lib/gymTime';
import { clockLabel, gymInstantIso, parseClock } from '@/lib/staffRoster/time';
import {
  BOOKING_STATUS_WORDS, PAYMENT_WORDS, formatDuration, formatPrice, parsePrice, ptClient,
} from '@/lib/ptBookingData';
import { Banner, BUTTON, GHOST, INPUT, LABEL, Pill, Sheet, WEEKDAYS, dateName, when, at } from './coachingUi';

const SECTIONS = [
  { key: 'bookings', label: 'Bookings' },
  { key: 'clients', label: 'Clients' },
  { key: 'services', label: 'Prices' },
  { key: 'hours', label: 'Hours' },
];
const STATUS_TONE = { requested: 'warning', confirmed: 'success', declined: 'neutral', cancelled: 'neutral', completed: 'info', no_show: 'danger' };
const PAY_TONE = { unpaid: 'warning', paid: 'success', package: 'info', waived: 'neutral' };
const LENGTHS = [30, 45, 60, 75, 90, 120];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function useAct(notify, reload) {
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (action, message) => {
    setBusy(true);
    try { const result = await action(); if (message) notify(typeof message === 'function' ? message(result) : message); await reload(); return result || true; } catch (failure) { notify(failure.message, 'error'); return null; } finally { setBusy(false); }
  }, [notify, reload]);
  return { busy, act };
}

// ── Bookings ──────────────────────────────────────────────────────────────

function BookingCard({ booking, busy, onAction }) {
  const now = Date.now();
  const started = new Date(booking.starts_at).getTime() <= now;
  const upcoming = ['requested', 'confirmed'].includes(booking.status) && !started;
  return (
    <article className="coaching-card space-y-2" data-cancelled={['cancelled', 'declined'].includes(booking.status)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-body text-sm font-semibold text-xert-offwhite">{when(booking.starts_at)} · {booking.client_name}</p>
          <p className="font-body text-xs text-xert-pale/65">{booking.service_name} · until {at(booking.ends_at)}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Pill tone={STATUS_TONE[booking.status]}>{BOOKING_STATUS_WORDS[booking.status]}</Pill>
          {!['cancelled', 'declined'].includes(booking.status) && <Pill tone={PAY_TONE[booking.payment_status]}>{booking.payment_status === 'unpaid' ? `${PAYMENT_WORDS.unpaid} · ${formatPrice(booking.price_cents)}` : PAYMENT_WORDS[booking.payment_status]}</Pill>}
        </div>
      </div>
      <p className="font-body text-xs text-xert-pale/60">
        <a className="underline" href={`mailto:${booking.client_email}`}>{booking.client_email}</a>
        {booking.client_phone && <> · <a className="underline" href={`tel:${booking.client_phone.replace(/\s+/g, '')}`}>{booking.client_phone}</a></>}
        {booking.package && <> · {booking.package.name}: {booking.package.remaining} left</>}
      </p>
      {booking.client_notes && <p className="font-body text-sm text-xert-pale/75">“{booking.client_notes}”</p>}
      <div className="flex flex-wrap gap-2">
        {booking.status === 'requested' && !started && <>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction(booking, 'confirm')}>Confirm</button>
          <button type="button" className={GHOST} disabled={busy} onClick={() => onAction(booking, 'decline')}>Decline</button>
        </>}
        {booking.status === 'confirmed' && started && <>
          <button type="button" className={GHOST} disabled={busy} onClick={() => onAction(booking, 'complete')}>Done</button>
          <button type="button" className={GHOST} disabled={busy} onClick={() => onAction(booking, 'no_show')}>No-show</button>
        </>}
        {['confirmed', 'completed', 'no_show'].includes(booking.status) && ['unpaid', 'waived'].includes(booking.payment_status) && (
          <button type="button" className={GHOST} disabled={busy} onClick={() => onAction(booking, 'mark_paid')}>Mark paid</button>
        )}
        {booking.payment_status === 'paid' && <button type="button" className={GHOST} disabled={busy} onClick={() => onAction(booking, 'mark_unpaid')}>Undo paid</button>}
        {upcoming && booking.status === 'confirmed' && <button type="button" className={GHOST} disabled={busy} onClick={() => onAction(booking, 'cancel')}>Cancel session</button>}
      </div>
    </article>
  );
}

function BookClientSheet({ open, onClose, services, clients, today, busy, onSubmit }) {
  const [serviceId, setServiceId] = useState('');
  const [clientId, setClientId] = useState('');
  const [newClient, setNewClient] = useState({ full_name: '', email: '', phone: '' });
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('09:00');
  const [packageId, setPackageId] = useState('');
  useEffect(() => { if (open) { setServiceId(services.find(item => item.active)?.id || ''); setClientId(''); setPackageId(''); setDate(today); } }, [open, services, today]);
  const client = clients.find(item => item.id === clientId);
  const packages = (client?.packages || []).filter(pack => pack.service_id === serviceId && pack.remaining > 0 && !pack.expired);
  const minute = parseClock(time);
  const valid = serviceId && date && minute !== null && (clientId || (newClient.full_name.trim() && newClient.email.trim()));
  return (
    <Sheet open={open} title="Book a client" onClose={onClose}
      footer={<><button type="button" className={BUTTON} disabled={busy || !valid} onClick={() => onSubmit({
        service_id: serviceId, starts_at: gymInstantIso(date, minute), client_package_id: packageId || null,
        ...(clientId ? { client_id: clientId } : { full_name: newClient.full_name.trim(), email: newClient.email.trim(), phone: newClient.phone.trim() || null }),
      })}>Book</button><button type="button" className={GHOST} onClick={onClose}>Cancel</button></>}>
      <div><label className={LABEL} htmlFor="pt-book-service">Session</label>
        <select id="pt-book-service" className={INPUT} value={serviceId} onChange={event => { setServiceId(event.target.value); setPackageId(''); }}>
          {services.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.name} · {formatDuration(item.duration_minutes)}</option>)}
        </select></div>
      <div><label className={LABEL} htmlFor="pt-book-client">Client</label>
        <select id="pt-book-client" className={INPUT} value={clientId} onChange={event => { setClientId(event.target.value); setPackageId(''); }}>
          <option value="">New client…</option>
          {clients.map(item => <option key={item.id} value={item.id}>{item.full_name}</option>)}
        </select></div>
      {!clientId && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><label className={LABEL} htmlFor="pt-book-name">Name</label><input id="pt-book-name" className={INPUT} value={newClient.full_name} onChange={event => setNewClient({ ...newClient, full_name: event.target.value })} /></div>
          <div><label className={LABEL} htmlFor="pt-book-email">Email</label><input id="pt-book-email" type="email" className={INPUT} value={newClient.email} onChange={event => setNewClient({ ...newClient, email: event.target.value })} /></div>
          <div><label className={LABEL} htmlFor="pt-book-phone">Mobile</label><input id="pt-book-phone" type="tel" className={INPUT} value={newClient.phone} onChange={event => setNewClient({ ...newClient, phone: event.target.value })} /></div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div><label className={LABEL} htmlFor="pt-book-date">Date</label><input id="pt-book-date" type="date" className={INPUT} min={today} value={date} onChange={event => setDate(event.target.value)} /></div>
        <div><label className={LABEL} htmlFor="pt-book-time">Start</label><input id="pt-book-time" type="time" step={300} className={INPUT} value={time} onChange={event => setTime(event.target.value)} /></div>
      </div>
      {packages.length > 0 && (
        <div><label className={LABEL} htmlFor="pt-book-package">Pay with</label>
          <select id="pt-book-package" className={INPUT} value={packageId} onChange={event => setPackageId(event.target.value)}>
            <option value="">Single session</option>
            {packages.map(pack => <option key={pack.id} value={pack.id}>{pack.name} ({pack.remaining} left)</option>)}
          </select></div>
      )}
      <p className="font-body text-xs text-xert-pale/60">You can book outside your public hours. Clashes with your classes, time off and other PT are still blocked.</p>
    </Sheet>
  );
}

function BookingsSection({ overview, clients, client, today, notify, reload }) {
  const { busy, act } = useAct(notify, reload);
  const [booking, setBooking] = useState(false);
  const now = Date.now();
  const bookings = overview.bookings || [];
  const requests = bookings.filter(item => item.status === 'requested' && new Date(item.starts_at).getTime() > now);
  const toMark = bookings.filter(item => item.status === 'confirmed' && new Date(item.starts_at).getTime() <= now);
  const unpaid = bookings.filter(item => ['completed', 'no_show'].includes(item.status) && item.payment_status === 'unpaid');
  const upcoming = bookings.filter(item => item.status === 'confirmed' && new Date(item.starts_at).getTime() > now);
  const recent = bookings.filter(item => !requests.includes(item) && !toMark.includes(item) && !unpaid.includes(item) && !upcoming.includes(item))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 10);
  const words = { confirm: 'Confirmed. We’ve emailed them.', decline: 'Declined. We’ve let them know.', cancel: 'Cancelled. We’ve let them know.', complete: 'Marked done.', no_show: 'Marked as a no-show.', mark_paid: 'Marked paid.', mark_unpaid: 'Marked not paid.' };
  const onAction = (item, action) => {
    if (action === 'cancel' && !window.confirm(`Cancel ${item.client_name}’s session on ${when(item.starts_at)}? They’ll get an email.`)) return;
    act(() => client.updateBooking(item.id, action), words[action]);
  };
  const group = (title, list, empty = null) => (list.length || empty) ? (
    <section className="space-y-2">
      <h3 className={LABEL}>{title}</h3>
      {list.length ? list.map(item => <BookingCard key={item.id} booking={item} busy={busy} onAction={onAction} />) : <p className="font-body text-sm text-xert-pale/60">{empty}</p>}
    </section>
  ) : null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={GHOST} onClick={() => setBooking(true)} disabled={!overview.services.some(item => item.active)}>Book a client</button>
      </div>
      {group('Requests to answer', requests)}
      {group('Mark how it went', toMark)}
      {group('Not paid yet', unpaid)}
      {group('Coming up', upcoming, 'Nothing booked yet. Once your prices and hours are set, the public can book you at xertfitness.com.au/pt.')}
      {group('Recent', recent)}
      <BookClientSheet open={booking} onClose={() => setBooking(false)} services={overview.services} clients={clients} today={today} busy={busy}
        onSubmit={async payload => { if (await act(() => client.coachBook(payload), 'Booked. We’ve emailed them.')) setBooking(false); }} />
    </div>
  );
}

// ── Clients ───────────────────────────────────────────────────────────────

function ClientCard({ person, services, client, busy, act }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(person.coach_note || '');
  const [history, setHistory] = useState(null);
  const [giving, setGiving] = useState('');
  const offers = services.flatMap(service => service.packages.filter(pack => pack.active).map(pack => ({ ...pack, service_name: service.name })));
  useEffect(() => { if (open && !history) client.clientHistory(person.id).then(setHistory).catch(() => setHistory([])); }, [open, history, client, person.id]);
  return (
    <article className="coaching-card space-y-2">
      <button type="button" className="w-full text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-body text-sm font-semibold text-xert-offwhite">{person.full_name}{person.is_member ? <span className="font-normal text-xert-pale/60"> · member</span> : null}</p>
            <p className="font-body text-xs text-xert-pale/65">
              {person.next_at ? `Next: ${when(person.next_at)}` : 'Nothing booked'} · {person.completed} done{person.no_shows ? ` · ${person.no_shows} no-show` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            {person.unpaid > 0 && <Pill tone="warning">{person.unpaid} not paid</Pill>}
            {person.packages.map(pack => <Pill key={pack.id} tone={pack.paid ? 'info' : 'warning'}>{pack.remaining} of {pack.sessions_total} left{pack.paid ? '' : ' · unpaid'}</Pill>)}
          </div>
        </div>
      </button>
      {open && (
        <div className="space-y-3 pt-1">
          <p className="font-body text-xs text-xert-pale/65">
            <a className="underline" href={`mailto:${person.email}`}>{person.email}</a>
            {person.phone && <> · <a className="underline" href={`tel:${person.phone.replace(/\s+/g, '')}`}>{person.phone}</a></>}
          </p>
          {person.packages.map(pack => (
            <div key={pack.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-xert-steel/20 px-3 py-2">
              <p className="font-body text-sm text-xert-offwhite">{pack.name} · {formatPrice(pack.price_cents)} · {pack.remaining} of {pack.sessions_total} left{pack.expires_on ? ` · use by ${dateName(pack.expires_on)}` : ''}{pack.expired ? ' (expired)' : ''}</p>
              <div className="flex gap-2">
                <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.clientPackage({ client_package_id: pack.id, action: pack.paid ? 'mark_unpaid' : 'mark_paid' }), pack.paid ? 'Marked not paid.' : 'Package marked paid.')}>{pack.paid ? 'Undo paid' : 'Mark paid'}</button>
                <button type="button" className={GHOST} disabled={busy} onClick={() => { if (window.confirm('Close this package? Booked sessions on it stay booked but become sessions to pay for.')) act(() => client.clientPackage({ client_package_id: pack.id, action: 'cancel' }), 'Package closed.'); }}>Close</button>
              </div>
            </div>
          ))}
          {offers.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1"><label className={LABEL} htmlFor={`give-${person.id}`}>Sell a package</label>
                <select id={`give-${person.id}`} className={INPUT} value={giving} onChange={event => setGiving(event.target.value)}>
                  <option value="">Choose…</option>
                  {offers.map(pack => <option key={pack.id} value={pack.id}>{pack.service_name}: {pack.name} · {formatPrice(pack.price_cents)}</option>)}
                </select></div>
              <button type="button" className={GHOST} disabled={busy || !giving} onClick={async () => { if (await act(() => client.clientPackage({ client_id: person.id, package_id: giving, paid: true }), 'Package added and marked paid.')) setGiving(''); }}>Add, paid</button>
            </div>
          )}
          <div><label className={LABEL} htmlFor={`note-${person.id}`}>Your notes (only you see these)</label>
            <textarea id={`note-${person.id}`} rows={3} maxLength={2000} className={`${INPUT} py-2`} value={note} onChange={event => setNote(event.target.value)} />
            <button type="button" className={`${GHOST} mt-2`} disabled={busy || note === (person.coach_note || '')} onClick={() => act(() => client.updateClient(person.id, note), 'Notes saved.')}>Save notes</button></div>
          {history && history.length > 0 && (
            <div><p className={LABEL}>History</p>
              <ul className="space-y-1">{history.slice(0, 20).map(item => (
                <li key={item.id} className="font-body text-xs text-xert-pale/70">{when(item.starts_at)} · {item.service_name} · {BOOKING_STATUS_WORDS[item.status]}{['completed', 'no_show', 'confirmed'].includes(item.status) ? ` · ${PAYMENT_WORDS[item.payment_status]}` : ''}</li>
              ))}</ul></div>
          )}
        </div>
      )}
    </article>
  );
}

function ClientsSection({ clients, services, client, notify, reload }) {
  const { busy, act } = useAct(notify, reload);
  const [query, setQuery] = useState('');
  const shown = clients.filter(person => !query.trim() || `${person.full_name} ${person.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (!clients.length) return <p className="font-body text-sm text-xert-pale/60">Your clients appear here after their first booking.</p>;
  return (
    <div className="space-y-3">
      <input className={INPUT} placeholder="Find a client" aria-label="Find a client" value={query} onChange={event => setQuery(event.target.value)} />
      {shown.map(person => <ClientCard key={person.id} person={person} services={services} client={client} busy={busy} act={act} />)}
    </div>
  );
}

// ── Services and packages ─────────────────────────────────────────────────

function ServiceSheet({ service, onClose, busy, onSave }) {
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!service) return;
    setForm({ name: service.name || '', description: service.description || '', duration_minutes: service.duration_minutes || 60,
      price: service.price_cents != null ? String(service.price_cents / 100) : '', booking_mode: service.booking_mode || 'request', active: service.active ?? true });
  }, [service]);
  if (!service || !form) return null;
  const price = parsePrice(form.price);
  const valid = form.name.trim() && price !== null;
  return (
    <Sheet open title={service.id ? 'Edit session' : 'New session type'} onClose={onClose}
      footer={<><button type="button" className={BUTTON} disabled={busy || !valid} onClick={() => onSave({
        id: service.id, version: service.version, name: form.name.trim(), description: form.description.trim(), duration_minutes: Number(form.duration_minutes),
        price_cents: price, booking_mode: form.booking_mode, active: form.active, sort_order: service.sort_order ?? 0,
      })}>Save</button><button type="button" className={GHOST} onClick={onClose}>Cancel</button></>}>
      <div><label className={LABEL} htmlFor="svc-name">Name</label><input id="svc-name" className={INPUT} maxLength={80} placeholder="e.g. One-on-one strength" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></div>
      <div><label className={LABEL} htmlFor="svc-desc">What’s included (optional)</label><textarea id="svc-desc" rows={3} maxLength={600} className={`${INPUT} py-2`} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={LABEL} htmlFor="svc-length">Length</label>
          <select id="svc-length" className={INPUT} value={form.duration_minutes} onChange={event => setForm({ ...form, duration_minutes: Number(event.target.value) })}>
            {[...new Set([...LENGTHS, Number(form.duration_minutes)])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{formatDuration(value)}</option>)}
          </select></div>
        <div><label className={LABEL} htmlFor="svc-price">Price per session ($)</label><input id="svc-price" inputMode="decimal" className={INPUT} value={form.price} onChange={event => setForm({ ...form, price: event.target.value })} /></div>
      </div>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How people book">
        <button type="button" role="radio" aria-checked={form.booking_mode === 'request'} className={GHOST} onClick={() => setForm({ ...form, booking_mode: 'request' })}>I confirm each booking</button>
        <button type="button" role="radio" aria-checked={form.booking_mode === 'instant'} className={GHOST} onClick={() => setForm({ ...form, booking_mode: 'instant' })}>Book instantly</button>
      </div>
      <label className="flex items-center gap-2 font-body text-sm text-xert-offwhite"><input type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} />Show on the website</label>
      {price === null && form.price !== '' && <p className="font-body text-xs text-status-danger-200">Enter a price like 80 or 79.50.</p>}
    </Sheet>
  );
}

function PackageSheet({ pack, service, onClose, busy, onSave }) {
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!pack) return;
    setForm({ name: pack.name || '', sessions_count: pack.sessions_count || 10, price: pack.price_cents != null ? String(pack.price_cents / 100) : '',
      valid_days: pack.valid_days ? String(pack.valid_days) : '', active: pack.active ?? true });
  }, [pack]);
  if (!pack || !form || !service) return null;
  const price = parsePrice(form.price);
  const validDays = form.valid_days === '' ? null : Number(form.valid_days);
  const valid = form.name.trim() && price !== null && Number(form.sessions_count) >= 2 && (validDays === null || (validDays >= 7 && validDays <= 730));
  const singles = service.price_cents * Number(form.sessions_count || 0);
  return (
    <Sheet open title={pack.id ? 'Edit package' : `New package: ${service.name}`} onClose={onClose}
      footer={<><button type="button" className={BUTTON} disabled={busy || !valid} onClick={() => onSave({
        id: pack.id, version: pack.version, service_id: service.id, name: form.name.trim(), sessions_count: Number(form.sessions_count),
        price_cents: price, valid_days: validDays, active: form.active,
      })}>Save</button><button type="button" className={GHOST} onClick={onClose}>Cancel</button></>}>
      <div><label className={LABEL} htmlFor="pkg-name">Name</label><input id="pkg-name" className={INPUT} maxLength={80} placeholder="e.g. 10-session pack" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={LABEL} htmlFor="pkg-count">Sessions</label><input id="pkg-count" type="number" min={2} max={100} className={INPUT} value={form.sessions_count} onChange={event => setForm({ ...form, sessions_count: event.target.value })} /></div>
        <div><label className={LABEL} htmlFor="pkg-price">Package price ($)</label><input id="pkg-price" inputMode="decimal" className={INPUT} value={form.price} onChange={event => setForm({ ...form, price: event.target.value })} /></div>
      </div>
      <p className="font-body text-xs text-xert-pale/60">Booked one at a time that’s {formatPrice(singles)}{price !== null && singles > price ? `, so clients save ${formatPrice(singles - price)}` : ''}.</p>
      <div><label className={LABEL} htmlFor="pkg-valid">Use within (days, optional)</label><input id="pkg-valid" type="number" min={7} max={730} className={INPUT} placeholder="No limit" value={form.valid_days} onChange={event => setForm({ ...form, valid_days: event.target.value })} /></div>
      <label className="flex items-center gap-2 font-body text-sm text-xert-offwhite"><input type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} />Offer on the website</label>
    </Sheet>
  );
}

function ServicesSection({ services, client, notify, reload }) {
  const { busy, act } = useAct(notify, reload);
  const [editing, setEditing] = useState(null);
  const [pack, setPack] = useState(null); // { pack, service }
  return (
    <div className="space-y-3">
      <p className="font-body text-sm text-xert-pale/70">Set your own sessions, prices and packages. Clients pay you directly.</p>
      {services.map(service => (
        <article key={service.id} className="coaching-card space-y-2" data-cancelled={!service.active}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-body text-sm font-semibold text-xert-offwhite">{service.name}</p>
              <p className="font-body text-xs text-xert-pale/65">{formatDuration(service.duration_minutes)} · {formatPrice(service.price_cents)} · {service.booking_mode === 'instant' ? 'books instantly' : 'you confirm each booking'}</p>
            </div>
            <div className="flex gap-1 items-center">{!service.active && <Pill>Hidden</Pill>}<button type="button" className={GHOST} onClick={() => setEditing(service)}>Edit</button></div>
          </div>
          {service.packages.map(item => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-xert-steel/20 px-3 py-2">
              <p className="font-body text-sm text-xert-pale/80">{item.name} · {item.sessions_count} sessions · {formatPrice(item.price_cents)}{item.valid_days ? ` · ${item.valid_days} days` : ''}{item.active ? '' : ' · hidden'}</p>
              <button type="button" className={GHOST} onClick={() => setPack({ pack: item, service })}>Edit</button>
            </div>
          ))}
          <button type="button" className={GHOST} onClick={() => setPack({ pack: { sessions_count: 10 }, service })}>Add a package</button>
        </article>
      ))}
      <button type="button" className={BUTTON} onClick={() => setEditing({ duration_minutes: 60, booking_mode: 'request', active: true, sort_order: services.length })}>Add a session type</button>
      <ServiceSheet service={editing} onClose={() => setEditing(null)} busy={busy}
        onSave={async payload => { if (await act(() => client.saveService(payload), 'Saved.')) setEditing(null); }} />
      <PackageSheet pack={pack?.pack} service={pack?.service} onClose={() => setPack(null)} busy={busy}
        onSave={async payload => { if (await act(() => client.savePackage(payload), 'Package saved.')) setPack(null); }} />
    </div>
  );
}

// ── Hours and time off ────────────────────────────────────────────────────

export function hoursByDay(hours) {
  const days = Object.fromEntries(WEEK_ORDER.map(day => [day, []]));
  for (const block of hours || []) days[block.weekday]?.push({ start: clockLabel(block.start), end: clockLabel(block.end) });
  return days;
}

export function hoursFromDays(days) {
  const result = [];
  for (const [weekday, blocks] of Object.entries(days)) {
    for (const block of blocks) {
      const start = parseClock(block.start);
      const end = parseClock(block.end);
      if (start === null || end === null || end <= start) return null;
      result.push({ weekday: Number(weekday), start, end });
    }
  }
  return result;
}

function HoursSection({ overview, client, today, notify, reload }) {
  const { busy, act } = useAct(notify, reload);
  const [days, setDays] = useState(() => hoursByDay(overview.hours.hours));
  const [buffer, setBuffer] = useState(overview.hours.buffer_minutes || 0);
  const [away, setAway] = useState({ from: today, fromTime: '', until: today, untilTime: '', note: '' });
  useEffect(() => { setDays(hoursByDay(overview.hours.hours)); setBuffer(overview.hours.buffer_minutes || 0); }, [overview.hours]);
  const hours = hoursFromDays(days);
  const setBlock = (day, index, patch) => setDays(current => ({ ...current, [day]: current[day].map((block, i) => i === index ? { ...block, ...patch } : block) }));
  const awayStart = away.from ? gymInstantIso(away.from, parseClock(away.fromTime) ?? 0) : null;
  const awayEnd = away.until ? gymInstantIso(away.until, parseClock(away.untilTime) ?? 1440) : null;
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <p className="font-body text-sm text-xert-pale/70">When can the public book you? Times that clash with your classes, time away or other PT are never offered.</p>
        {WEEK_ORDER.map(day => (
          <div key={day} className="coaching-card space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="font-body text-sm font-semibold text-xert-offwhite">{WEEKDAYS[day]}</p>
              <button type="button" className={GHOST} onClick={() => setDays(current => ({ ...current, [day]: [...current[day], { start: '06:00', end: '10:00' }] }))}>Add hours</button>
            </div>
            {days[day].length === 0 && <p className="font-body text-xs text-xert-pale/50">Not taking bookings</p>}
            {days[day].map((block, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <input type="time" step={300} aria-label={`${WEEKDAYS[day]} from`} className={`${INPUT} w-auto`} value={block.start} onChange={event => setBlock(day, index, { start: event.target.value })} />
                <span className="font-body text-xs text-xert-pale/60">to</span>
                <input type="time" step={300} aria-label={`${WEEKDAYS[day]} until`} className={`${INPUT} w-auto`} value={block.end === '24:00' ? '23:55' : block.end} onChange={event => setBlock(day, index, { end: event.target.value })} />
                <button type="button" className={GHOST} aria-label={`Remove ${WEEKDAYS[day]} ${block.start}`} onClick={() => setDays(current => ({ ...current, [day]: current[day].filter((_, i) => i !== index) }))}>Remove</button>
              </div>
            ))}
          </div>
        ))}
        <div className="max-w-xs"><label className={LABEL} htmlFor="pt-buffer">Gap between PT sessions</label>
          <select id="pt-buffer" className={INPUT} value={buffer} onChange={event => setBuffer(Number(event.target.value))}>
            {[0, 5, 10, 15, 30, 45, 60].map(value => <option key={value} value={value}>{value ? `${value} min` : 'No gap'}</option>)}
          </select></div>
        {!hours && <p className="font-body text-xs text-status-danger-200">Each block needs a start before its end.</p>}
        <button type="button" className={BUTTON} disabled={busy || !hours} onClick={() => act(() => client.saveHours(hours, buffer, overview.hours.version), 'Hours saved. Bookings you already have stay as they are.')}>Save hours</button>
      </section>

      <section className="space-y-3">
        <h3 className={LABEL}>Time off from PT</h3>
        {(overview.time_off || []).map(item => (
          <div key={item.id} className="coaching-card flex flex-wrap items-center justify-between gap-2">
            <p className="font-body text-sm text-xert-offwhite">{when(item.starts_at)} to {when(item.ends_at)}{item.note ? ` · ${item.note}` : ''}</p>
            <button type="button" className={GHOST} disabled={busy} onClick={() => act(() => client.removeTimeOff(item.id), 'Removed.')}>Remove</button>
          </div>
        ))}
        <div className="coaching-card space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL} htmlFor="off-from">From</label><input id="off-from" type="date" min={today} className={INPUT} value={away.from} onChange={event => setAway({ ...away, from: event.target.value, until: away.until < event.target.value ? event.target.value : away.until })} /></div>
            <div><label className={LABEL} htmlFor="off-from-time">Time</label><input id="off-from-time" type="time" className={INPUT} placeholder="Start of day" value={away.fromTime} onChange={event => setAway({ ...away, fromTime: event.target.value })} /></div>
            <div><label className={LABEL} htmlFor="off-until">Until</label><input id="off-until" type="date" min={away.from} className={INPUT} value={away.until} onChange={event => setAway({ ...away, until: event.target.value })} /></div>
            <div><label className={LABEL} htmlFor="off-until-time">Time</label><input id="off-until-time" type="time" className={INPUT} placeholder="End of day" value={away.untilTime} onChange={event => setAway({ ...away, untilTime: event.target.value })} /></div>
          </div>
          <input className={INPUT} maxLength={200} placeholder="Note (optional, only you see it)" aria-label="Note" value={away.note} onChange={event => setAway({ ...away, note: event.target.value })} />
          <p className="font-body text-xs text-xert-pale/60">This only stops PT bookings. Time off from classes is under Requests.</p>
          <button type="button" className={GHOST} disabled={busy || !awayStart || !awayEnd || awayEnd <= awayStart} onClick={async () => {
            const result = await act(() => client.addTimeOff(awayStart, awayEnd, away.note), out => out.clashes?.length ? `Saved. You still have ${out.clashes.length} booking${out.clashes.length === 1 ? '' : 's'} in that time; cancel them under Bookings if needed.` : 'Time off saved.');
            if (result) setAway({ from: today, fromTime: '', until: today, untilTime: '', note: '' });
          }}>Add time off</button>
        </div>
      </section>
    </div>
  );
}

// ── Section shell ─────────────────────────────────────────────────────────

/**
 * The coach's own PT business: bookings to answer, clients and packages,
 * their own prices, and the hours the public can book.
 */
export default function CoachPT({ client: injected = null, today = gymDateKey(new Date()), notify, onCounts = null }) {
  const [client, setClient] = useState(injected);
  const [overview, setOverview] = useState(null);
  const [clients, setClients] = useState([]);
  const [error, setError] = useState(null);
  const [section, setSection] = useState('bookings');
  useEffect(() => { if (!injected) ptClient().then(setClient); }, [injected]);
  const load = useCallback(async () => {
    if (!client) return;
    try {
      const [next, people] = await Promise.all([client.overview(), client.clients()]);
      setOverview(next); setClients(people); setError(null);
      onCounts?.(Number(next.requested) + Number(next.to_mark));
    } catch (failure) { setError(failure); }
  }, [client, onCounts]);
  useEffect(() => { load(); }, [load]);

  const setupNeeded = useMemo(() => overview && (!overview.services.some(item => item.active) || !(overview.hours.hours || []).length), [overview]);

  if (error) {
    return <Banner tone={error.code === 'PT_DISABLED' ? 'info' : 'danger'} title={error.code === 'PT_DISABLED' ? 'PT booking isn’t switched on yet' : 'Couldn’t open PT'}
      action={error.code === 'PT_DISABLED' ? null : <button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>;
  }
  if (!overview) return <p className="font-body text-sm text-xert-pale/60" role="status">Loading…</p>;
  return (
    <div className="space-y-4">
      {setupNeeded && (
        <Banner tone="info" title="Set up your PT">
          Add a session type with your price under Prices, then your bookable hours under Hours. You’ll then appear at xertfitness.com.au/pt as {overview.staff.public_name}.
        </Banner>
      )}
      <div role="tablist" aria-label="PT sections" className="coaching-tabs">
        {SECTIONS.map(item => (
          <button key={item.key} type="button" role="tab" aria-selected={section === item.key} onClick={() => setSection(item.key)}>
            {item.label}{item.key === 'bookings' && (Number(overview.requested) + Number(overview.to_mark)) ? <span className="coaching-count">{Number(overview.requested) + Number(overview.to_mark)}</span> : null}
          </button>
        ))}
      </div>
      {section === 'bookings' && <BookingsSection overview={overview} clients={clients} client={client} today={today} notify={notify} reload={load} />}
      {section === 'clients' && <ClientsSection clients={clients} services={overview.services} client={client} notify={notify} reload={load} />}
      {section === 'services' && <ServicesSection services={overview.services} client={client} notify={notify} reload={load} />}
      {section === 'hours' && <HoursSection overview={overview} client={client} today={today} notify={notify} reload={load} />}
    </div>
  );
}

