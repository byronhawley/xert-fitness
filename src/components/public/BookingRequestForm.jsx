import React, { useEffect, useState } from 'react';
import { submitClassSignup } from '@/lib/submitForms';
import FormCheckbox from '@/components/public/FormCheckbox';
import { friendlySignupError, signupErrorDetail } from '@/lib/classSignup';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { gymDateTimeLabel } from '@/lib/gymTime';

const chipClasses = 'min-h-11 px-3 py-2 text-sm font-body rounded-full border transition-colors';
const chipActive = 'border-xert-steel bg-xert-steel text-xert-navy';
const chipIdle = 'border-xert-steel/30 bg-white/[0.03] text-xert-pale/75 hover:border-xert-steel';
const errorStyle = { color: 'var(--state-danger-text)', borderColor: 'var(--state-danger-text-35)', backgroundColor: 'var(--state-danger-text-8)' };

function FieldLabel({ children, required = false, htmlFor = undefined }) {
  const Component = htmlFor ? 'label' : 'span';
  return (
    <Component htmlFor={htmlFor} className="xert-label">
      {children}{required && <span className="text-xert-steel ml-1" aria-hidden="true">*</span>}
    </Component>
  );
}
function Input({ ...props }) {
  return (
    <input {...props} className="xert-input" />
  );
}

const TRAINING_LEVELS = ['New / beginner', 'Some gym experience', 'Regular trainer', 'Advanced'];

// What the signed-in account already knows about them, so a member types
// their name, email and phone once, on their account, not on every class.
function accountDetails(user, profile) {
  return {
    full_name: profile?.full_name || user?.user_metadata?.full_name || '',
    email: user?.email || profile?.email || '',
    phone: profile?.phone || '',
  };
}

export default function BookingRequestForm({
  session,
  onSuccess,
  onCancel,
  submitLabel = 'Request spot',
  busyLabel = 'Requesting...',
  consentLabel = 'I consent to XERT contacting me about this booking request.',
  takesSpot = false,
  joinWaitlist = false,
  onRejected,
}) {
  const { user, profile } = useSupabaseAuth();
  const [form, setForm] = useState(() => ({
    ...accountDetails(user, profile), training_level: '',
    notes: '', consent_to_contact: false, company_website: '',
    class_session_id: session?.id || '',
  }));
  // The profile can arrive after the form opens. Fill only what is still
  // empty, so nothing they have typed is overwritten.
  useEffect(() => {
    const known = accountDetails(user, profile);
    setForm(current => ({
      ...current,
      full_name: current.full_name || known.full_name,
      email: current.email || known.email,
      phone: current.phone || known.phone,
    }));
  }, [profile, user]);
  // Signed in with all three known, the details are a line to check, not
  // three boxes to fill. "Change" opens them for this booking.
  const [changingDetails, setChangingDetails] = useState(false);
  const detailsKnown = Boolean(user) && !changingDetails
    && Boolean(form.full_name.trim() && form.email.trim() && form.phone.trim());
  // Memberships are not linked to the website yet, so nothing here can tell a
  // member from a walk-in. Asking is what lets the confirmation offer a
  // non-member the ways to pay instead of leaving them booked in and stuck.
  const [hasMembership, setHasMembership] = useState(null);
  // Bring-a-friend days put people in a class who owe nothing. Saying so here
  // is the only chance to record it: on the floor a guest looks like anybody
  // else who has not paid yet.
  const [guestVisit, setGuestVisit] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorDetail, setErrorDetail] = useState('');

  const set = (f, v) => setForm(p => ({ ...p, [f]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.full_name.trim()) { setError('Full name is required.'); return; }
    if (!form.email.trim() || !form.email.includes('@')) { setError('Valid email is required.'); return; }
    if (!form.phone.trim()) { setError('Phone is required.'); return; }
    if (hasMembership === null) { setError('Let us know whether you already have a XERT membership.'); return; }
    if (!form.consent_to_contact) { setError('Consent to contact is required.'); return; }
    setLoading(true);
    setError('');
    setErrorDetail('');
    try {
      const result = await submitClassSignup({
        ...form, join_waitlist: joinWaitlist, guest_visit: hasMembership === false && guestVisit,
      });
      // The answer and their details travel with the result so the page can
      // offer a non-member the passes without asking for any of it twice.
      onSuccess?.({
        ...result,
        has_membership: hasMembership,
        guest_visit: hasMembership === false && guestVisit,
        full_name: form.full_name, email: form.email, phone: form.phone,
      });
    } catch (submitError) {
      setError(friendlySignupError(submitError));
      setErrorDetail(signupErrorDetail(submitError) || '');
      // A saved phone or email the database will not take has to be
      // fixable, so the boxes open rather than staying folded away.
      if (/NAME_REQUIRED|EMAIL_REQUIRED|PHONE_REQUIRED/.test(submitError?.message || '')) setChangingDetails(true);
      // The class filled while this form was open. Tell the page so the counts
      // behind the modal stop advertising a spot that is gone, and stop
      // offering a submit that will fail the same way again.
      const gone = /CLASS_FULL|CLASS_WAITLISTED|CLASS_STARTED|CLASS_NOT_OPEN/i.test(submitError?.message || '');
      if (gone) setRejected(true);
      onRejected?.(submitError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="off" className="space-y-5">
      {/* Honeypot must never be browser-autofilled: a filled value silently
          drops the submission server-side while the UI still reports success. */}
      <input type="text" name="company_website" value={form.company_website}
        onChange={e => set('company_website', e.target.value)} autoComplete="off"
        className="absolute opacity-0 h-0 w-0 pointer-events-none" tabIndex={-1} aria-hidden="true" />

      {session && (
        <div className="xert-card-flat p-4 mb-6">
          <p className="font-display text-base text-xert-offwhite uppercase">{session.title}</p>
          <p className="font-body text-xs text-xert-pale/65 mt-1">
            {gymDateTimeLabel(session.start_time)}
            {session.coach_name ? ` · ${session.coach_name}` : ''}
          </p>
        </div>
      )}

      {detailsKnown ? (
        <div className="xert-card-flat flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="xert-label">Booking as</p>
            <p className="font-body text-sm text-xert-offwhite">{form.full_name}</p>
            <p className="break-words font-body text-xs text-xert-pale/65">{form.email} · {form.phone}</p>
          </div>
          <button type="button" onClick={() => setChangingDetails(true)}
            className="xert-btn-ghost inline-flex min-h-11 shrink-0 items-center px-4 font-display text-xs uppercase tracking-wide">
            Change
          </button>
        </div>
      ) : <>
        <div><FieldLabel htmlFor="booking-full-name" required>Full name</FieldLabel><Input id="booking-full-name" name="full_name" autoComplete="name" aria-required="true" placeholder="Your name" value={form.full_name} onChange={e => set('full_name', e.target.value)} /></div>
        <div><FieldLabel htmlFor="booking-email" required>Email</FieldLabel><Input id="booking-email" name="email" autoComplete="email" aria-required="true" type="email" placeholder="you@email.com" value={form.email} onChange={e => set('email', e.target.value)} /></div>
        <div><FieldLabel htmlFor="booking-phone" required>Phone</FieldLabel><Input id="booking-phone" name="phone" autoComplete="tel" aria-required="true" type="tel" placeholder="Mobile number" value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
      </>}

      <fieldset>
        <legend className="xert-label">Training level</legend>
        <div className="flex flex-wrap gap-2">
          {TRAINING_LEVELS.map(l => (
            <button type="button" key={l}
              onClick={() => set('training_level', l)}
              aria-pressed={form.training_level === l}
              className={`${chipClasses} ${form.training_level === l ? chipActive : chipIdle}`}>
              {l}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <FieldLabel htmlFor="booking-notes">Notes</FieldLabel>
        <textarea id="booking-notes" name="notes" value={form.notes} onChange={e => set('notes', e.target.value)}
          rows={2} placeholder="Any questions or information for the coach (optional)"
          className="xert-input resize-none" />
      </div>

      <fieldset>
        <legend className="xert-label">
          Do you already have a XERT membership?<span className="text-xert-steel ml-1" aria-hidden="true">*</span>
        </legend>
        <div className="flex flex-wrap gap-2">
          {[[true, 'Yes, I am a member'], [false, 'No, not yet']].map(([value, label]) => (
            <button type="button" key={label}
              onClick={() => { setHasMembership(value); setError(''); }}
              aria-pressed={hasMembership === value}
              className={`${chipClasses} ${hasMembership === value ? chipActive : chipIdle}`}>
              {label}
            </button>
          ))}
        </div>
        {hasMembership === false && (
          <div className="mt-3 border border-xert-steel/20 p-3">
            <label className="flex min-h-11 cursor-pointer items-center gap-3">
              <input type="checkbox" checked={guestVisit}
                onChange={event => setGuestVisit(event.target.checked)} className="peer sr-only" />
              <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center border-2 ${guestVisit ? 'border-xert-steel bg-xert-steel text-xert-navy' : 'border-xert-steel/40'} peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-xert-offwhite`}>
                {guestVisit && <span className="text-xs">&#10003;</span>}
              </span>
              <span className="font-body text-sm text-xert-offwhite">
                I am a guest of a member (bring a friend)
              </span>
            </label>
            <p className="mt-2 font-body text-xs leading-relaxed text-xert-pale/65">
              {guestVisit
                ? 'Nothing to pay — your spot is held and the team will know you are a guest.'
                : 'No problem — we will show you the ways to pay once your spot is held.'}
            </p>
          </div>
        )}
      </fieldset>

      {takesSpot && (
        <p className="font-body text-xs text-xert-pale/70">
          Your spot is held as soon as you submit these details.
        </p>
      )}
      {joinWaitlist && (
        <p className="font-body text-xs text-xert-pale/70">
          This class is full, so no spot is held. We will contact you the moment one frees up.
        </p>
      )}

      <FormCheckbox name="consent_to_contact" checked={form.consent_to_contact} onChange={checked => set('consent_to_contact', checked)} required>
        {consentLabel}
      </FormCheckbox>

      {error && (
        <div role="alert" className="rounded-xl border p-3" style={errorStyle}>
          <p className="font-body text-sm">{error}</p>
          {errorDetail && <p className="mt-1 break-words font-body text-xs opacity-80">Details: {errorDetail}</p>}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="xert-btn-ghost flex-1 inline-flex min-h-[52px] items-center justify-center font-display text-sm uppercase tracking-wide">
            Cancel
          </button>
        )}
        <button type="submit" disabled={loading || rejected}
          title={rejected ? 'This class can no longer take this submission' : undefined}
          className="xert-btn-primary flex-1 inline-flex min-h-[52px] items-center justify-center font-display text-sm uppercase tracking-wide disabled:opacity-50">
          {loading ? busyLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
