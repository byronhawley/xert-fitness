import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { authPathWithNext } from '@/lib/authRedirect';
import { staffRoster } from '@/lib/staffRosterData';
import { forgetInviteToken, INVITE_OUTCOMES, INVITE_PATH, inviteTokenFromHash, recallInviteToken, rememberInviteToken } from '@/lib/staffRoster/invite';
import { Banner, BUTTON, GHOST } from '@/components/coaching/coachingUi';
import '@/components/coaching/coaching.css';

function Shell({ children }) {
  return (
    <div className="relative min-h-screen bg-xert-navy">
      <PublicNav />
      <main id="main" className="relative max-w-xl mx-auto px-4 sm:px-6 pt-28 pb-20">{children}</main>
      <PublicFooter />
    </div>
  );
}

const PRIMARY_LINK = 'xert-btn-primary inline-flex min-h-[52px] items-center justify-center px-6 font-display text-base uppercase tracking-wide';
const GHOST_LINK = 'xert-btn-ghost inline-flex min-h-[52px] items-center justify-center px-6 font-body text-sm uppercase tracking-wider';

/**
 * Where a coach invite link lands (`/coach-invite#token=…`). Signed out, it
 * explains the invite and sends them to sign in or create an account, coming
 * back here afterwards. Signed in, it shows which coach the link is for and
 * links this account on the coach's say-so, then opens the coach dashboard.
 * Nothing about any coach is shown until a valid link is presented.
 */
export default function CoachInvite({ client: injected = null }) {
  const { session, loading: authLoading, signOut } = useSupabaseAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [client, setClient] = useState(injected);
  const [token, setToken] = useState(undefined);
  const [preview, setPreview] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const signedIn = Boolean(session || injected);

  // Take the token out of the address bar at once; keep it in this browser so
  // it survives sign-in and account creation.
  useEffect(() => {
    const fromLink = inviteTokenFromHash(location.hash);
    if (fromLink) {
      rememberInviteToken(fromLink);
      window.history.replaceState(window.history.state, '', INVITE_PATH);
    }
    setToken(fromLink || recallInviteToken());
  }, [location.hash]);

  useEffect(() => { if (!injected) staffRoster().then(setClient); }, [injected]);

  const load = useCallback(async () => {
    if (!client || !token) return;
    setFailure(null);
    try {
      const result = await client.previewInvite(token);
      if (result?.ok) setPreview(result);
      else { setPreview(null); setFailure(result?.code || 'INVITE_INVALID'); }
    } catch (error) {
      setFailure(error.code === 'SIGN_IN_REQUIRED' ? 'SIGN_IN_REQUIRED' : error);
    }
  }, [client, token]);
  useEffect(() => { if (signedIn) load(); }, [signedIn, load]);

  const accept = async () => {
    setBusy(true);
    try {
      const result = await client.acceptInvite(token);
      if (!result?.ok) { setFailure(result?.code || 'INVITE_INVALID'); return; }
      forgetInviteToken();
      navigate('/coaching', { replace: true, state: { joined: result.staff?.display_name || true } });
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const switchAccount = async () => {
    await signOut?.();
    setPreview(null);
    setFailure(null);
  };

  if ((authLoading && !injected) || token === undefined) {
    return <div className="min-h-screen flex items-center justify-center bg-xert-navy"><Loader2 className="w-6 h-6 animate-spin text-xert-steel" /></div>;
  }

  if (!token) {
    return (
      <Shell>
        <Banner tone="warning" title="Open your invite link again">
          This page needs the full link from your invite. If you created an account in another browser or on another device, open the link from your invite there, or here again now that you’re set up.
        </Banner>
      </Shell>
    );
  }

  if (!signedIn) {
    return (
      <Shell>
        <div className="xert-card p-6 space-y-4">
          <p className="font-body text-xs uppercase tracking-wider text-xert-pale/60">XERT coaches</p>
          <h1 className="font-display text-3xl uppercase text-xert-offwhite">You’re invited to coach</h1>
          <p className="font-body text-sm text-xert-pale/75">This link connects your XERT sign-in to your place on the coach roster, so you can give your availability, see your classes and ask for cover. No membership is needed.</p>
          <p className="font-body text-sm text-xert-pale/75">Log in, or create an account with the email you’d like to use for coaching. You’ll come straight back here.</p>
          <div className="flex flex-wrap gap-2">
            <Link to={authPathWithNext('/login', INVITE_PATH)} className={PRIMARY_LINK}>Log in</Link>
            <Link to={authPathWithNext('/register', INVITE_PATH)} className={GHOST_LINK}>Create an account</Link>
          </div>
          <p className="font-body text-xs text-xert-pale/50">The link works once and expires 14 days after it was sent.</p>
        </div>
      </Shell>
    );
  }

  if (failure) {
    const [title, detail] = typeof failure === 'string'
      ? INVITE_OUTCOMES[failure] || (failure === 'SIGN_IN_REQUIRED' ? ['Please sign in again', 'Your session ended. Log in and open the link again.'] : INVITE_OUTCOMES.INVITE_INVALID)
      : ['Couldn’t check your invite', failure.message];
    const retry = typeof failure !== 'string' || failure === 'PROFILE_NOT_READY';
    return (
      <Shell>
        <div className="space-y-4">
          <h1 className="font-display text-3xl uppercase text-xert-offwhite">Coach invite</h1>
          <Banner tone={retry ? 'warning' : 'danger'} title={title}
            action={retry ? <button type="button" className={GHOST} onClick={load}>Try again</button> : null}>{detail}</Banner>
          {failure === 'ACCOUNT_ALREADY_LINKED' && <div className="flex flex-wrap gap-2"><Link to="/coaching" className={GHOST_LINK}>Open coach dashboard</Link><button type="button" className={GHOST} onClick={switchAccount}>Use a different account</button></div>}
        </div>
      </Shell>
    );
  }

  if (!preview) return <Shell><p className="font-body text-sm text-xert-pale/60" role="status">Checking your invite…</p></Shell>;

  if (preview.linked_to_you) {
    return (
      <Shell>
        <div className="xert-card p-6 space-y-4">
          <h1 className="font-display text-3xl uppercase text-xert-offwhite">You’re already on the roster</h1>
          <p className="font-body text-sm text-xert-pale/75">This sign-in is linked to {preview.display_name}.</p>
          <Link to="/coaching" className={PRIMARY_LINK} onClick={() => forgetInviteToken()}>Open coach dashboard</Link>
        </div>
      </Shell>
    );
  }

  const email = session?.user?.email;
  return (
    <Shell>
      <div className="xert-card p-6 space-y-4">
        <p className="font-body text-xs uppercase tracking-wider text-xert-pale/60">XERT coaches</p>
        <h1 className="font-display text-3xl uppercase text-xert-offwhite">Join as {preview.display_name}</h1>
        <p className="font-body text-sm text-xert-pale/75">
          {email ? <>You’re signed in as <strong className="text-xert-offwhite">{email}</strong>. </> : null}
          Accepting links this sign-in to {preview.display_name} on the coach roster. You’ll use it to give availability and see your classes.
        </p>
        {preview.account_already_staff
          ? <Banner tone="warning" title={INVITE_OUTCOMES.ACCOUNT_ALREADY_LINKED[0]}>{INVITE_OUTCOMES.ACCOUNT_ALREADY_LINKED[1]}</Banner>
          : <button type="button" className={BUTTON} disabled={busy} onClick={accept}>{busy ? 'Joining…' : 'Accept invite'}</button>}
        <button type="button" className={GHOST} onClick={switchAccount}>Not you? Use a different account</button>
      </div>
    </Shell>
  );
}
