import React, { useState, useEffect } from 'react';
import { toast } from '@/components/ui/use-toast';
import { activateSessionPackPayments, getCommerceConfigurationHealth, getSoftLaunchSettings, updateSoftLaunchSettings, getDefaultSettings } from '@/lib/adminData';
import AdminLoadError from '@/components/admin/AdminLoadError';
import AdminConfirmDialog from '@/components/admin/AdminConfirmDialog';
import { countdownVisibility, launchSettingsChanged, normalizeLaunchSettings, VISITOR_PRICE_FIELDS, visitorPriceFieldInstalled } from '@/lib/launchSettings';
import { ADMIN_PAGE } from '@/components/admin/ui';

/** @param {boolean} _dirty */
const NOOP = _dirty => {};

const normalizeLoadedSettings = loadedSettings => ({
  ...loadedSettings,
  // Missing pricing visibility must fail safe to hiding prices.
  prices_coming_soon: loadedSettings?.prices_coming_soon !== false,
});

export default function SoftLaunchSettings({ onDirtyChange = NOOP }) {
  const defaults = getDefaultSettings();
  const [settings, setSettings] = useState(defaults);
  const [savedSettings, setSavedSettings] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [pendingPaymentActivation, setPendingPaymentActivation] = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const loadedSettings = await getSoftLaunchSettings();
      if (loadedSettings) {
        const normalized = normalizeLoadedSettings(loadedSettings);
        setSettings(normalized);
        setSavedSettings(normalized);
      }
    } catch (error) {
      setLoadError(error.message || 'Check the admin settings table and admin permissions.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const dirty = launchSettingsChanged(settings, savedSettings);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const set = (k, v) => {
    setSaved(false);
    setSettings(previous => {
      const next = { ...previous, [k]: v };
      if (k === 'bookings_enabled' && v === false) next.payments_enabled = false;
      // Fitbox owns billing while the handoff is on, so the internal Stripe
      // checkout switch always drops back to paused.
      if (k === 'fitbox_enabled' && v === true) next.payments_enabled = false;
      return next;
    });
  };

  const reconcilePaymentActivation = async activationError => {
    let liveSettings;
    try {
      liveSettings = normalizeLoadedSettings(await getSoftLaunchSettings());
    } catch {
      const message = 'Payment activation could not be verified. Refresh Platform Controls before trying again.';
      setLoadError(message);
      throw new Error(message);
    }

    // The guarded endpoint can commit immediately before its response is lost.
    // Always replace both snapshots with the live row before allowing a retry.
    setSettings(liveSettings);
    setSavedSettings(liveSettings);
    if (liveSettings.payments_enabled) return liveSettings;

    const detail = activationError?.message || 'Payment activation failed. Payments remain paused.';
    throw new Error(`${detail} Your other platform changes were saved.`);
  };

  const persistSettings = async (normalized, activatePayments = false) => {
    setSaving(true);
    try {
      let updated;
      if (activatePayments) {
        // Save every ordinary platform change through the normal CAS path while
        // checkout remains paused. The guarded RPC does not own every setting
        // (notably prices_coming_soon), so it must only perform the final cutover.
        const stagedDraft = { ...normalized, payments_enabled: false };
        const staged = await updateSoftLaunchSettings(stagedDraft, savedSettings);
        setSettings(staged);
        setSavedSettings(staged);

        const activationDraft = { ...staged, payments_enabled: true };
        try {
          const activated = await activateSessionPackPayments(activationDraft, staged);
          updated = { ...staged, ...activated };
        } catch (activationError) {
          updated = await reconcilePaymentActivation(activationError);
        }
      } else {
        updated = await updateSoftLaunchSettings(normalized, savedSettings);
      }
      setSettings(updated);
      setSavedSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    try {
      const normalized = normalizeLaunchSettings(settings);
      const activatingPayments = normalized.payments_enabled && !savedSettings.payments_enabled;
      if (!activatingPayments) {
        await persistSettings(normalized);
        return;
      }

      setSaving(true);
      const health = await getCommerceConfigurationHealth();
      setSaving(false);
      if (!health.ready) {
        const reason = health.issues?.[0]?.reason || 'Open Operations Health and complete every Stripe launch check first.';
        toast({ title: 'Stripe is not ready to activate', description: reason, variant: 'destructive' });
        return;
      }
      setPendingPaymentActivation(normalized);
    } catch (e) {
      setSaving(false);
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    }
  };

  if (loading) return <div className={ADMIN_PAGE}><div className="h-40 bg-xert-ink animate-pulse" /></div>;
  if (loadError) return <div className={ADMIN_PAGE}><AdminLoadError message={loadError} onRetry={load} /></div>;

  // Shows staff what the public site is doing right now, so a passed date is
  // visible here instead of only being discovered by members on the website.
  const countdownState = (() => {
    if (!settings.countdown_enabled) {
      return { label: 'Countdown is switched off — nothing shows on the public site.', tone: 'var(--text-secondary-45)' };
    }
    if (countdownVisibility(settings.target_launch_date, true) === 'counting') {
      return { label: 'Live: the public site is counting down to this date.', tone: 'var(--state-success)' };
    }
    return { label: 'This date has passed — the countdown is hidden on the public site. Set a future date to show it again.', tone: 'var(--state-warning)' };
  })();

  const Toggle = ({ label, desc, field, disabled = false }) => (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-xert-steel/20">
      <div id={`${field}-description`}>
        <p className="font-body text-sm text-xert-offwhite">{label}</p>
        {desc && <p className="font-body text-xs text-xert-concrete/40 mt-0.5">{desc}</p>}
      </div>
      <button type="button" role="switch" aria-checked={Boolean(settings[field])} aria-labelledby={`${field}-description`} onClick={() => set(field, !settings[field])}
        disabled={disabled}
        className={`relative min-w-12 w-12 min-h-11 rounded-full transition-colors shrink-0 disabled:cursor-not-allowed disabled:opacity-35 ${settings[field] ? 'bg-xert-steel' : 'bg-xert-steel/40'}`}>
        <div className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white transition-transform ${settings[field] ? 'translate-x-7' : 'translate-x-1'}`} />
      </button>
    </div>
  );

  return (
    <div className={`${ADMIN_PAGE} max-w-2xl`}>
      <h2 className="font-display text-xl text-xert-offwhite uppercase mb-6">Soft Launch Settings</h2>
      <p className="font-body text-xs text-xert-concrete/50 mb-4">Every control below updates a live public-site behavior.</p>
      {dirty && (
        <div className="mb-4 px-4 py-3 border border-xert-steel/40 bg-xert-steel/10 font-body text-xs text-xert-pale" role="status">
          Unsaved changes. The public site will not change until these settings are saved.
        </div>
      )}

      <div className="bg-xert-ink border border-xert-steel/20 p-6 mb-6 space-y-0">
        <Toggle label="Countdown enabled" desc="Shows countdown timer on public pages." field="countdown_enabled" />
        <Toggle label="Bookings enabled" desc="Shows booking buttons on class cards. Turning this off also pauses checkout." field="bookings_enabled" />
        <Toggle
          label="Session pack payments"
          desc={settings.fitbox_enabled
            ? 'Fitbox is handling payments — the internal checkout stays paused while the handoff is on.'
            : settings.bookings_enabled
              ? 'Master checkout switch for pack purchases. Keep off until Stripe launch checks pass.'
              : 'Open bookings and complete the booking smoke test before enabling payments.'}
          field="payments_enabled"
          disabled={settings.fitbox_enabled || (!settings.bookings_enabled && !settings.payments_enabled)}
        />
        <Toggle label="Announcement banner" desc="Shows a banner across the top of the public site." field="announcement_banner_enabled" />
      </div>

      <div className="bg-xert-ink border border-xert-steel/20 p-6 mb-6">
        <h3 className="font-display text-sm uppercase tracking-wider text-xert-offwhite mb-1">Class credits</h3>
        <p className="font-body text-xs text-xert-concrete/40 mb-2">
          Class packs were retired in favour of memberships, so credits are off: a member asks for a spot and staff
          confirm it. Turn this back on only if XERT sells class packs again &mdash; booking will then require a credit
          and spend one, and a member without any cannot book. Credits already bought are honoured either way.
        </p>
        <Toggle label="Class credits required" desc="Off means booking never looks for a credit. On restores class packs gating every booking." field="class_credits_enabled" />
      </div>

      <div className="bg-xert-ink border border-xert-steel/20 p-6 mb-6">
        <h3 className="font-display text-sm text-xert-offwhite uppercase mb-1">Fitbox handoff</h3>
        <p className="font-body text-xs text-xert-concrete/40 mb-2">
          When on, public Book and Join buttons send people to your Fitbox member portal, and XERT&rsquo;s built-in checkout stays paused. Memberships, billing and class bookings then live in Fitbox.
        </p>
        <Toggle label="Bookings & payments via Fitbox" desc="Requires the member portal link below." field="fitbox_enabled" />
        <div className="pt-4">
          <label htmlFor="fitbox-booking-url" className="block font-body text-xs text-xert-concrete/40 uppercase tracking-wider mb-2">Fitbox member portal link</label>
          <input id="fitbox-booking-url" type="url" inputMode="url" value={settings.fitbox_booking_url || ''} onChange={e => set('fitbox_booking_url', e.target.value)}
            placeholder="https://portal.fitboxcorp.com/your-gym"
            className="w-full bg-xert-charcoal border border-xert-steel/40 px-4 py-3 font-body text-sm text-xert-offwhite placeholder-xert-concrete/30 focus:outline-none focus:border-xert-red" />
          <p className="font-body text-xs text-xert-concrete/40 mt-2">
            Paste the signup or booking link Fitbox gives you for XERT. It must start with https://.
          </p>
        </div>
      </div>

      <div className="bg-xert-ink border border-xert-steel/20 p-6 space-y-5 mb-6">
        <h3 className="font-display text-sm uppercase tracking-wider text-xert-offwhite">Casual visits</h3>
        <p className="font-body text-xs text-xert-concrete/40">
          A walk-in scans the front-desk code, enters their details and pays for a visit or pass on their own phone.
          Nothing here grants a session credit.
        </p>
        <Toggle label="Visitor payments" desc="Controls /casual, /3daypass, /10pack and /3months. When off, visitors are directed to the XERT team." field="casual_payments_enabled" />
        {/* A price whose column the database does not have yet could never be
            saved, so it stays hidden until its migration has been run. */}
        {VISITOR_PRICE_FIELDS.map(field => visitorPriceFieldInstalled(field, savedSettings) && (
          <VisitorPriceRow key={field.key} field={field} settings={settings} set={set} />
        ))}
        <p className="font-body text-xs text-xert-concrete/40">
          Every amount is read from here when somebody pays, never from their browser. A discount is the price
          they actually pay while it is running, so type what you want charged rather than a percentage.
        </p>
      </div>

      <div className="bg-xert-ink border border-xert-steel/20 p-6 space-y-5 mb-6">
        <div>
          <label htmlFor="target-launch-date" className="block font-body text-xs text-xert-concrete/40 uppercase tracking-wider mb-2">Target launch date</label>
          <input id="target-launch-date" type="date" value={settings.target_launch_date || ''} onChange={e => set('target_launch_date', e.target.value)}
            aria-describedby="target-launch-date-help"
            className="w-full bg-xert-charcoal border border-xert-steel/40 px-4 py-3 font-body text-sm text-xert-offwhite focus:outline-none focus:border-xert-red" />
          <p id="target-launch-date-help" className="font-body text-xs text-xert-concrete/40 mt-2">
            The public countdown counts down to this date. Once it passes, the countdown
            disappears from the site — it will not announce that the gym is open.
            To tell the public you have opened, use the announcement banner below.
          </p>
          <p className="font-body text-xs mt-2" role="status" style={{ color: countdownState.tone }}>
            {countdownState.label}
          </p>
        </div>
        <div>
          <label htmlFor="announcement-banner-text" className="block font-body text-xs text-xert-concrete/40 uppercase tracking-wider mb-2">Announcement banner text</label>
          <input id="announcement-banner-text" value={settings.announcement_banner_text || ''} onChange={e => set('announcement_banner_text', e.target.value)}
            placeholder="e.g. Soft launch registrations now open — sign up today!"
            className="w-full bg-xert-charcoal border border-xert-steel/40 px-4 py-3 font-body text-sm text-xert-offwhite placeholder-xert-concrete/30 focus:outline-none focus:border-xert-red" />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <button onClick={handleSave} disabled={saving || !dirty}
          className={`flex-1 min-h-12 py-3 font-display text-base uppercase transition-colors disabled:opacity-50 ${saved ? 'bg-status-confirmed-600 text-xert-navy' : 'bg-xert-steel text-xert-navy hover:bg-xert-pale'}`}>
          {saved ? 'Saved ✓' : saving ? 'Saving...' : dirty ? 'Save settings' : 'Settings saved'}
        </button>
        {dirty && (
          <button type="button" onClick={() => { setSettings(savedSettings); setSaved(false); }} disabled={saving}
            className="min-h-12 px-5 py-3 border border-xert-red/30 font-body text-xs uppercase tracking-wider text-xert-red/70 hover:border-xert-red hover:text-xert-red disabled:opacity-50">
            Discard changes
          </button>
        )}
      </div>
      <AdminConfirmDialog
        open={Boolean(pendingPaymentActivation)}
        onOpenChange={open => !open && setPendingPaymentActivation(null)}
        title="Open session pack checkout?"
        description="Stripe launch checks are passing. Saving will allow signed-in members to start real pack purchases on the website and iOS app."
        warning="Run one low-value purchase and refund immediately after activation."
        cancelLabel="Keep payments paused"
        confirmLabel="Enable pack checkout"
        busy={saving}
        onConfirm={() => {
          const pending = pendingPaymentActivation;
          setPendingPaymentActivation(null);
          if (pending) void persistSettings(pending, true);
        }}
      />
    </div>
  );
}

/**
 * One visitor price and its discount. The dollar field is typed freely and
 * only committed on blur, so a half-typed "1" is never saved as $1 — and a
 * value outside what the database accepts snaps back rather than failing at
 * save time. The discount cannot be switched on until it is set and cheaper,
 * which is the same rule the database enforces.
 */
function VisitorPriceRow({ field, settings, set }) {
  const priceCents = settings[field.price] ?? field.fallback;
  const discountCents = settings[field.discount];
  const running = settings[field.enabled] === true;
  const [priceInput, setPriceInput] = React.useState('');
  const [discountInput, setDiscountInput] = React.useState('');

  React.useEffect(() => { setPriceInput((priceCents / 100).toFixed(2)); }, [priceCents]);
  React.useEffect(() => {
    setDiscountInput(discountCents === null || discountCents === undefined ? '' : (discountCents / 100).toFixed(2));
  }, [discountCents]);

  const dollars = value => {
    const cents = Math.round(Number.parseFloat(String(value).replace(/[^\d.]/g, '')) * 100);
    return Number.isInteger(cents) && cents >= 100 && cents <= 100000 ? cents : null;
  };
  const money = (id, value, onChange, onBlur, label) => (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="font-body text-sm text-xert-concrete/50">$</span>
      <input id={id} type="text" inputMode="decimal" aria-label={label} value={value}
        onChange={event => onChange(event.target.value)} onBlur={onBlur}
        className="w-28 bg-xert-charcoal border border-xert-steel/40 px-4 py-3 font-body text-sm text-xert-offwhite focus:outline-none focus:border-xert-red" />
    </div>
  );
  const canRun = discountCents !== null && discountCents !== undefined && discountCents < priceCents;

  return (
    <div className="border border-xert-steel/15 p-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <label htmlFor={`${field.key}-price`} className="block font-body text-xs text-xert-concrete/40 uppercase tracking-wider mb-2">{field.label}</label>
          {money(`${field.key}-price`, priceInput, setPriceInput, () => {
            const cents = dollars(priceInput);
            if (cents === null) setPriceInput((priceCents / 100).toFixed(2));
            else {
              set(field.price, cents);
              if (running && discountCents >= cents) set(field.enabled, false);
            }
          }, `${field.label} full price in dollars`)}
        </div>
        <div>
          <label htmlFor={`${field.key}-discount`} className="block font-body text-xs text-xert-concrete/40 uppercase tracking-wider mb-2">Discount price</label>
          {money(`${field.key}-discount`, discountInput, setDiscountInput, () => {
            if (String(discountInput).trim() === '') {
              set(field.discount, null);
              if (running) set(field.enabled, false);
              return;
            }
            const cents = dollars(discountInput);
            if (cents === null) {
              setDiscountInput(discountCents === null || discountCents === undefined ? '' : (discountCents / 100).toFixed(2));
              return;
            }
            set(field.discount, cents);
            if (running && cents >= priceCents) set(field.enabled, false);
          }, `${field.label} discount price in dollars`)}
        </div>
      </div>
      <label className="mt-4 flex min-h-11 cursor-pointer items-center gap-3">
        <input type="checkbox" checked={running} disabled={!canRun}
          onChange={event => set(field.enabled, event.target.checked)}
          className="h-5 w-5 shrink-0 accent-xert-steel disabled:opacity-40" />
        <span className="font-body text-sm text-xert-offwhite">
          Run this discount
          {running && canRun && <span className="ml-2 text-xert-steel">paying ${(discountCents / 100).toFixed(2)} instead of ${(priceCents / 100).toFixed(2)}</span>}
          {!canRun && <span className="ml-2 text-xert-concrete/40">set a cheaper discount price first</span>}
        </span>
      </label>
    </div>
  );
}
