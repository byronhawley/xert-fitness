import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, LoaderCircle, LogIn, UserPlus, Users } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import PageHeader from '@/components/public/PageHeader';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { authPathWithNext } from '@/lib/authRedirect';
import { supabase } from '@/lib/supabase';
import { loadPublicForm, saveOwnerForm, submitPublicForm } from '@/lib/xertForms';
import {
  NAME_MAX, PAIRS_CATEGORIES, PAIRS_EVENT_LABEL, PAIRS_FORM_SLUG, TEAM_NAME_MAX,
  pairsEntriesOpen, pairsEntryAnswers, pairsEntryErrors, pairsFormDefinition,
  pairsFormMatches, pairsSubmitErrorMessage,
} from '@/lib/pairsCompetition';

const PAGE_PATH = '/pairs';
const ENTERED_KEY = `xert.pairs.${PAIRS_FORM_SLUG}.entered`;

const CATEGORY_NOTES = Object.freeze({
  Everyday: 'New to competing or just here for fun.',
  Intermediate: 'Training regularly and comfortable with the movements.',
  Advanced: 'Experienced, fit and ready to be pushed.',
});

const errorStyle = { color: 'var(--state-danger-text)', borderColor: 'var(--state-danger-text-35)', backgroundColor: 'var(--state-danger-text-8)' };

function readEntered(userId) {
  try { return window.localStorage.getItem(ENTERED_KEY) === userId; } catch { return false; }
}
function writeEntered(userId) {
  try { window.localStorage.setItem(ENTERED_KEY, userId); } catch { /* private mode: the server still refuses a second entry */ }
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-xert-navy text-xert-offwhite">
      <PublicNav />
      <main>
        <PageHeader
          eyebrow={`XERT Fitness · ${PAIRS_EVENT_LABEL}`}
          title="Pairs"
          accent="Competition."
          intro="Grab a partner. Pick a team name and the category that suits you both: Everyday, Intermediate or Advanced."
          containerClassName="max-w-3xl"
        />
        <section className="mx-auto max-w-3xl px-6 pb-24 pt-6">{children}</section>
      </main>
      <PublicFooter />
    </div>
  );
}

function Field({ id, label, hint = "", error, children }) {
  return (
    <div>
      <label htmlFor={id} className="xert-label">{label}</label>
      {children}
      {hint && !error && <p className="mt-1.5 text-xs text-xert-pale/50">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1.5 text-sm" style={{ color: 'var(--state-danger-text)' }}>{error}</p>}
    </div>
  );
}

function SignInGate() {
  return (
    <div className="xert-card p-6 sm:p-8">
      <span className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-xert-steel/10 text-xert-steel"><Users className="h-6 w-6" /></span>
      <h2 className="font-display text-3xl uppercase tracking-wide text-white">Sign in to enter</h2>
      <p className="mt-3 text-xert-pale/70">
        Entries are made from your XERT account. Already a member or booked a class online? Log in.
        New to XERT? Create a free account.
      </p>
      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        <Link to={authPathWithNext('/login', PAGE_PATH)} className="xert-btn-primary inline-flex min-h-[56px] items-center justify-center gap-2 px-6 font-display text-lg uppercase tracking-wide">
          <LogIn className="h-5 w-5" /> Log in
        </Link>
        <Link to={authPathWithNext('/register', PAGE_PATH)} className="xert-btn-ghost inline-flex min-h-[56px] items-center justify-center gap-2 px-6 font-display text-lg uppercase tracking-wide">
          <UserPlus className="h-5 w-5" /> Create account
        </Link>
      </div>
      <p className="mt-5 text-xs text-xert-pale/50">Only one of you needs an account to enter the pair.</p>
    </div>
  );
}

function Notice({ title, children, tone = 'info' }) {
  return (
    <div className="xert-card p-6 sm:p-8" role={tone === 'error' ? 'alert' : 'status'}>
      <h2 className="font-display text-3xl uppercase tracking-wide text-white">{title}</h2>
      <div className="mt-3 text-xert-pale/70">{children}</div>
    </div>
  );
}

function AdminSetup({ onCreated }) {
  const [state, setState] = useState({ checking: true, existing: null, busy: false, error: '' });
  useEffect(() => {
    let active = true;
    supabase.from('xert_forms').select('id, is_active, title').eq('slug', PAIRS_FORM_SLUG).is('archived_at', null).maybeSingle()
      .then(({ data, error }) => { if (active) setState(s => ({ ...s, checking: false, existing: data || null, error: error?.message || '' })); });
    return () => { active = false; };
  }, []);
  const create = async () => {
    setState(s => ({ ...s, busy: true, error: '' }));
    try { await saveOwnerForm(pairsFormDefinition()); onCreated(); } catch (err) { setState(s => ({ ...s, busy: false, error: err.message })); }
  };
  if (state.checking) return <Notice title="Checking entries">One moment…</Notice>;
  if (state.existing) {
    return (
      <Notice title="Entries are paused">
        The Pairs entry form exists but is switched off, so members can't enter yet. Turn it on in{' '}
        <Link className="text-xert-steel underline" to="/admin/forms">Admin › Forms</Link> ({state.existing.title}).
      </Notice>
    );
  }
  return (
    <div className="xert-card p-6 sm:p-8">
      <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-xert-steel">Staff only</p>
      <h2 className="font-display text-3xl uppercase tracking-wide text-white">Open Pairs entries</h2>
      <p className="mt-3 text-xert-pale/70">
        Members see "entries aren't open yet" until this is switched on. Opening entries creates the
        "Pairs Competition {PAIRS_EVENT_LABEL}" form. Entries show up under Admin › Forms, where you can export
        them or pause entries at any time.
      </p>
      {state.error && <p role="alert" className="mt-5 rounded-xl border p-3 text-sm" style={errorStyle}>{state.error}</p>}
      <button type="button" onClick={create} disabled={state.busy} className="xert-btn-primary mt-6 inline-flex min-h-[56px] items-center gap-2 px-6 font-display text-lg uppercase tracking-wide disabled:opacity-60">
        {state.busy ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />} Open entries
      </button>
    </div>
  );
}

function EntryForm({ form, user, profile, onEntered }) {
  const accountName = String(profile?.full_name || user?.user_metadata?.full_name || '').trim();
  const [entry, setEntry] = useState({ teamName: '', teammateOne: accountName, teammateTwo: '', category: '' });
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const errors = useMemo(() => (touched ? pairsEntryErrors(entry) : {}), [entry, touched]);
  const set = key => event => setEntry(current => ({ ...current, [key]: event.target.value }));

  useEffect(() => {
    if (accountName) setEntry(current => (current.teammateOne ? current : { ...current, teammateOne: accountName }));
  }, [accountName]);

  const submit = async event => {
    event.preventDefault();
    setTouched(true);
    setError('');
    if (Object.keys(pairsEntryErrors(entry)).length) return;
    setSending(true);
    try {
      await submitPublicForm({
        slug: PAIRS_FORM_SLUG,
        formUpdatedAt: form.updated_at,
        answers: pairsEntryAnswers(entry),
        name: accountName || entry.teammateOne.trim(),
        email: user.email,
        phone: profile?.phone || '',
        elapsedSeconds: 0,
        sourceURL: window.location.href,
      });
      onEntered({ ...entry });
    } catch (err) {
      const message = pairsSubmitErrorMessage(err);
      if (message === 'ALREADY_ENTERED') onEntered(null);
      else setError(message);
    } finally {
      setSending(false);
    }
  };

  const input = 'xert-input h-12 w-full text-base';
  return (
    <form onSubmit={submit} noValidate className="xert-card p-6 sm:p-8">
      <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-xert-steel">Pairs signup · {PAIRS_EVENT_LABEL}</p>
      <h2 className="font-display text-3xl uppercase tracking-wide text-white">Enter your pair</h2>
      <p className="mt-2 text-sm text-xert-pale/60">Entering as {user.email}</p>

      <div className="mt-7 grid gap-5">
        <Field id="pairs-team" label="Pair team name" error={errors.teamName}>
          <input id="pairs-team" className={input} maxLength={TEAM_NAME_MAX} autoComplete="off" value={entry.teamName} onChange={set('teamName')} aria-invalid={Boolean(errors.teamName)} aria-describedby={errors.teamName ? 'pairs-team-error' : undefined} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="pairs-one" label="Teammate 1 (you)" error={errors.teammateOne}>
            <input id="pairs-one" className={input} maxLength={NAME_MAX} autoComplete="name" autoCapitalize="words" value={entry.teammateOne} onChange={set('teammateOne')} aria-invalid={Boolean(errors.teammateOne)} aria-describedby={errors.teammateOne ? 'pairs-one-error' : undefined} />
          </Field>
          <Field id="pairs-two" label="Teammate 2" hint="Your partner doesn't need an account." error={errors.teammateTwo}>
            <input id="pairs-two" className={input} maxLength={NAME_MAX} autoComplete="off" autoCapitalize="words" value={entry.teammateTwo} onChange={set('teammateTwo')} aria-invalid={Boolean(errors.teammateTwo)} aria-describedby={errors.teammateTwo ? 'pairs-two-error' : undefined} />
          </Field>
        </div>

        <fieldset>
          <legend className="xert-label">Category</legend>
          <div role="radiogroup" className="grid gap-3 sm:grid-cols-3">
            {PAIRS_CATEGORIES.map(option => {
              const chosen = entry.category === option;
              return (
                <label key={option} className={`relative flex min-h-[96px] cursor-pointer flex-col justify-between rounded-2xl border p-4 transition-colors ${chosen ? 'border-xert-steel bg-xert-steel/15' : 'border-xert-steel/20 bg-white/[0.03] hover:border-xert-steel/60'}`}>
                  <input type="radio" name="pairs-category" value={option} checked={chosen} onChange={set('category')} className="sr-only" />
                  <span className="flex items-center justify-between font-display text-2xl uppercase tracking-wide text-white">
                    {option}
                    {chosen && <Check className="h-5 w-5 text-xert-steel" aria-hidden="true" />}
                  </span>
                  <span className="mt-2 text-xs text-xert-pale/60">{CATEGORY_NOTES[option]}</span>
                </label>
              );
            })}
          </div>
          {errors.category && <p className="mt-1.5 text-sm" style={{ color: 'var(--state-danger-text)' }}>{errors.category}</p>}
        </fieldset>
      </div>

      {error && <p role="alert" className="mt-6 rounded-xl border p-3 text-sm" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={sending} className="xert-btn-primary mt-8 inline-flex min-h-[56px] w-full items-center justify-center gap-2 px-6 font-display text-xl uppercase tracking-wide disabled:opacity-60 sm:w-auto">
        {sending ? <><LoaderCircle className="h-5 w-5 animate-spin" /> Sending</> : <>Enter our pair <ArrowRight className="h-5 w-5" /></>}
      </button>
    </form>
  );
}

function Entered({ entry }) {
  return (
    <div className="xert-card p-6 text-center sm:p-10" role="status">
      <span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full bg-status-success-400/10 text-status-success-300"><Check /></span>
      <h2 className="font-display text-4xl uppercase tracking-wide text-white">You're in</h2>
      {entry ? (
        <p className="mt-4 text-xert-pale/75">
          <strong className="text-white">{entry.teamName.trim()}</strong> ({entry.teammateOne.trim()} &amp; {entry.teammateTwo.trim()}) is entered in{' '}
          <strong className="text-white">{entry.category}</strong> for {PAIRS_EVENT_LABEL}.
        </p>
      ) : (
        <p className="mt-4 text-xert-pale/75">This account has already entered a pair for {PAIRS_EVENT_LABEL}.</p>
      )}
      <p className="mt-3 text-sm text-xert-pale/55">Need to change something? Talk to the XERT team at the front desk.</p>
    </div>
  );
}

export default function PairsSignup() {
  const { user, profile, isAdmin, loading } = useSupabaseAuth();
  const [form, setForm] = useState(undefined);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [entered, setEntered] = useState(null);

  useEffect(() => {
    let active = true;
    setForm(undefined);
    loadPublicForm(PAIRS_FORM_SLUG)
      .then(data => { if (active) setForm(data || null); })
      .catch(err => { if (active) { setForm(null); setLoadError(err.message); } });
    return () => { active = false; };
  }, [reload]);
  useEffect(() => {
    if (user?.id && readEntered(user.id)) setEntered(current => current || { previous: true });
  }, [user?.id]);

  const onEntered = value => {
    writeEntered(user.id);
    setEntered(value ? { entry: value } : { previous: true });
  };

  let body;
  if (loading || form === undefined) body = <Notice title="Loading">One moment…</Notice>;
  else if (!pairsEntriesOpen()) body = <Notice title="Entries closed">Entries for {PAIRS_EVENT_LABEL} have closed. Ask the XERT team if you still want to get in.</Notice>;
  else if (!user) body = <SignInGate />;
  else if (entered) body = <Entered entry={entered.entry || null} />;
  else if (!form) body = isAdmin ? <AdminSetup onCreated={() => setReload(n => n + 1)} /> : (
    <Notice title="Entries aren't open yet" tone={loadError ? 'error' : 'info'}>
      {loadError ? 'We could not reach the entry form. Check your connection and refresh.' : 'Pairs entries open soon. Check back shortly, or ask the XERT team.'}
    </Notice>
  );
  else if (!pairsFormMatches(form)) body = <Notice title="Entries unavailable" tone="error">The entry form has been changed and no longer matches this page. Staff: restore the Pairs questions in Admin › Forms.</Notice>;
  else body = <EntryForm form={form} user={user} profile={profile} onEntered={onEntered} />;

  return <Shell>{body}</Shell>;
}
