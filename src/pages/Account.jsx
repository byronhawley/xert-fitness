import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, BellRing, CalendarDays, CheckCircle2, Clock, Dumbbell, ExternalLink, Loader2, Receipt, ShieldCheck, Target, Ticket, X } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import { useSupabaseAuth } from '@/lib/SupabaseAuthContext';
import { dismissMemberAnnouncement, getMemberAnnouncements, getMyCredits, getMyBookings, getMyEventGoals, getMyMemberOnboarding, getMyOrders, getMyPrivateSessionRequests, cancelBooking, removeMyEventGoal, saveMyMemberOnboarding, updateMyProfile } from '@/lib/bookingData';
import { cancellationMessage, cancellationOutcomeMessage } from '@/lib/bookingCancellation';
import { partitionAccountBookings } from '@/lib/accountBookings';
import { summarizeExpiringCredits } from '@/lib/creditExpiry';
import { summarizeMemberProgress } from '@/lib/memberProgress';
import { announcementAction } from '@/lib/memberAnnouncements';
import {
  clearPendingWebCheckout,
  loadPendingWebCheckout,
  pendingWebCheckoutForReturn,
  WEB_CHECKOUT_RETRY_DELAYS_MS,
  webCheckoutSettlement,
} from '@/lib/webCheckoutRecovery';
import { useToast } from '@/components/ui/use-toast';
import MemberPT from '@/components/public/MemberPT';
import { usePtAvailability } from '@/lib/usePtAvailability';
import { deleteMyAccount } from '@/lib/accountData';
import { authPathWithNext } from '@/lib/authRedirect';
import { getSoftLaunchSettings } from '@/lib/adminData';
import { PLATFORM_PROVIDERS, resolvePlatformProvider } from '@/lib/platformProvider';

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function privateSessionStatus(status) {
  const labels = {
    requested: 'Awaiting review',
    approved: 'Approved',
    reschedule_requested: 'Scheduling follow-up',
    declined: 'Declined',
    completed: 'Completed',
    cancelled: 'Cancelled'
  };
  return labels[status] || String(status || 'requested').replace(/_/g, ' ');
}

const ghostButtonClasses = 'xert-btn-ghost inline-flex min-h-11 items-center justify-center gap-1.5 px-4 font-body text-xs uppercase tracking-wider';
const primaryButtonClasses = 'xert-btn-primary inline-flex min-h-[52px] items-center justify-center px-5 font-display text-base uppercase tracking-wide';
const inlineLinkClasses = 'inline-flex min-h-11 items-center font-body text-xs uppercase tracking-wider text-xert-steel hover:text-xert-pale transition-colors';
const warningBoxClasses = 'rounded-2xl border border-state-warning/40 bg-state-warning/10';
const warningButtonClasses = 'inline-flex min-h-11 items-center justify-center rounded-[0.875rem] border border-state-warning/60 px-4 font-display text-sm uppercase tracking-wide text-xert-offwhite transition-colors hover:bg-state-warning/10';
const fieldLabelClasses = 'xert-label';
const fieldInputClasses = 'xert-input mt-2 block normal-case tracking-normal';

const emptyReadinessForm = {
  fullName: '',
  phone: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  emergencyContactRelationship: '',
};

function officialSourceURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export default function Account() {
  const location = useLocation();
  const { session, user, profile, loading: authLoading, signOut } = useSupabaseAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [credits, setCredits] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [orders, setOrders] = useState([]);
  const [eventGoals, setEventGoals] = useState([]);
  const [privateSessionRequests, setPrivateSessionRequests] = useState([]);
  const ptBooking = usePtAvailability();
  const [announcements, setAnnouncements] = useState([]);
  const [dismissingAnnouncementId, setDismissingAnnouncementId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hasLoadedAccount, setHasLoadedAccount] = useState(false);
  const [loadedAccountUserId, setLoadedAccountUserId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [accountSourceErrors, setAccountSourceErrors] = useState(
    /** @type {Record<string, string>} */ ({}),
  );
  const [cancellingId, setCancellingId] = useState(null);
  const [cancellationTarget, setCancellationTarget] = useState(null);
  const [provider, setProvider] = useState(() => resolvePlatformProvider(null));
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ full_name: '', phone: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [memberReadiness, setMemberReadiness] = useState(null);
  const [readinessForm, setReadinessForm] = useState(emptyReadinessForm);
  const [adultEligibilityConfirmed, setAdultEligibilityConfirmed] = useState(false);
  const [contactIsAware, setContactIsAware] = useState(false);
  const [documentAcknowledgements, setDocumentAcknowledgements] = useState({});
  const [readinessDirty, setReadinessDirty] = useState(false);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessSaving, setReadinessSaving] = useState(false);
  const [readinessError, setReadinessError] = useState('');
  const [readinessSavedMessage, setReadinessSavedMessage] = useState('');
  const expiringCredits = useMemo(() => summarizeExpiringCredits(credits?.batches), [credits]);
  // Nothing sells class packs any more, so the wallet is shown only to the
  // members who still have one to spend.
  const hasLegacyCredits = (credits?.total ?? 0) > 0;
  const trainingProgress = useMemo(() => summarizeMemberProgress(bookings), [bookings]);

  const purchaseSuccess = searchParams.get('purchase') === 'success';
  const [purchaseStatus, setPurchaseStatus] = useState(purchaseSuccess ? 'confirming' : null);
  const [purchaseRefreshKey, setPurchaseRefreshKey] = useState(0);
  const accountDataOwnerIDRef = useRef('');
  const accountRefreshRequestIDRef = useRef(0);
  const commerceRequestIDRef = useRef(0);
  const readinessRequestIDRef = useRef(0);
  const readinessSaveIDRef = useRef(0);
  const readinessUserIDRef = useRef('');
  const readinessDirtyRef = useRef(false);
  const readinessSavingRef = useRef(false);

  const setReadinessDirtyState = useCallback(value => {
    readinessDirtyRef.current = value;
    setReadinessDirty(value);
  }, []);

  const markReadinessDirty = useCallback(() => {
    setReadinessDirtyState(true);
    setReadinessError('');
    setReadinessSavedMessage('');
  }, [setReadinessDirtyState]);

  const setReadinessFromServer = useCallback((
    data,
    { replaceDraft = false, confirmedAdultEligibility = false } = {}
  ) => {
    setMemberReadiness(data);

    // A background response may update confirmed status, but it must never
    // overwrite fields or deliberate acknowledgements while the member is
    // editing or an exact save is still in flight.
    if (!replaceDraft || readinessDirtyRef.current || readinessSavingRef.current) return false;

    setReadinessForm({
      fullName: data.profile?.full_name || '',
      phone: data.profile?.phone || '',
      emergencyContactName: data.emergency_contact?.name || '',
      emergencyContactPhone: data.emergency_contact?.phone || '',
      emergencyContactRelationship: data.emergency_contact?.relationship || '',
    });
    // Awareness and document acknowledgements are deliberate acts. Never
    // infer checked controls from a previous receipt or persist them locally.
    setAdultEligibilityConfirmed(confirmedAdultEligibility);
    setContactIsAware(false);
    setDocumentAcknowledgements(Object.fromEntries(
      data.required_documents.map(document => [document.id, false])
    ));
    setReadinessDirtyState(false);
    return true;
  }, [setReadinessDirtyState]);

  const refreshMemberReadiness = useCallback(async ({ userID = '', replaceDraft = false } = {}) => {
    const requestedUserID = userID || readinessUserIDRef.current;
    if (!requestedUserID) return;

    const requestID = ++readinessRequestIDRef.current;
    setReadinessLoading(true);
    setReadinessError('');
    if (!readinessDirtyRef.current) setReadinessSavedMessage('');
    try {
      const data = await getMyMemberOnboarding();
      if (requestID !== readinessRequestIDRef.current
          || requestedUserID !== readinessUserIDRef.current) return;

      const draftReplaced = setReadinessFromServer(data, { replaceDraft });
      if (replaceDraft && !draftReplaced) {
        setReadinessError('XERT has newer readiness information. Your unsaved details were kept; review the current acknowledgements before saving.');
      }
    } catch (error) {
      if (requestID === readinessRequestIDRef.current
          && requestedUserID === readinessUserIDRef.current) {
        setReadinessError(error.message || 'Member readiness is unavailable.');
      }
    } finally {
      if (requestID === readinessRequestIDRef.current
          && requestedUserID === readinessUserIDRef.current) {
        setReadinessLoading(false);
      }
    }
  }, [setReadinessFromServer]);

  const refresh = useCallback(async () => {
    const accountRequestID = ++accountRefreshRequestIDRef.current;
    const requestedUserID = user?.id || '';
    setLoading(true);
    setLoadError('');
    setAccountSourceErrors({});
    // Never permit a cancellation using a provider selection from an older
    // settings snapshot while the current row is still being refreshed.
    setProvider(resolvePlatformProvider(null));
    try {
      const results = await Promise.allSettled([
        getMyCredits(),
        getMyBookings(),
        getMyOrders(),
        getMyEventGoals(),
        getMyPrivateSessionRequests(),
        getMemberAnnouncements(),
        getSoftLaunchSettings(),
      ]);
      if (accountRequestID !== accountRefreshRequestIDRef.current) return;

      const sources = [
        { name: 'credits', apply: value => setCredits(value) },
        { name: 'bookings', apply: value => setBookings(value) },
        { name: 'orders', apply: value => setOrders(value) },
        { name: 'eventGoals', apply: value => setEventGoals(value) },
        { name: 'privateSessions', apply: value => setPrivateSessionRequests(value) },
        { name: 'announcements', apply: value => setAnnouncements(value) },
        { name: 'provider', apply: value => setProvider(resolvePlatformProvider(value)), fail: () => setProvider(resolvePlatformProvider(null)) },
      ];
      const nextErrors = /** @type {Record<string, string>} */ ({});
      results.forEach((result, index) => {
        const { name: source, apply, fail } = sources[index];
        if (result.status === 'fulfilled') {
          apply(result.value);
        } else {
          fail?.();
          nextErrors[source] = result.reason?.message || `${source} could not be refreshed.`;
        }
      });

      setAccountSourceErrors(nextErrors);
      const failedLabels = Object.keys(nextErrors).map(source => ({
        credits: 'credits',
        bookings: 'bookings',
        orders: 'purchases',
        eventGoals: 'training goals',
        privateSessions: 'PT requests',
        announcements: 'notices',
        provider: 'booking provider',
      })[source]);
      setLoadError(failedLabels.length > 0
        ? `Some account details could not be refreshed: ${failedLabels.join(', ')}.`
        : '');
      setLoadedAccountUserId(requestedUserID);
      setHasLoadedAccount(true);
    } catch (e) {
      if (accountRequestID === accountRefreshRequestIDRef.current) {
        setLoadError(e.message || 'Your account data could not be reached.');
      }
    } finally {
      if (accountRequestID === accountRefreshRequestIDRef.current) setLoading(false);
    }
  }, [user?.id]);

  const accountUserID = user?.id || '';
  useEffect(() => {
    if (accountDataOwnerIDRef.current === accountUserID) return;

    // Member data may be retained after a same-account transient failure, but
    // it must never survive an identity change. Invalidate both request lanes
    // before clearing every user-scoped source.
    accountDataOwnerIDRef.current = accountUserID;
    accountRefreshRequestIDRef.current += 1;
    commerceRequestIDRef.current += 1;
    setCredits(null);
    setBookings([]);
    setOrders([]);
    setEventGoals([]);
    setPrivateSessionRequests([]);
    setAnnouncements([]);
    setAccountSourceErrors({});
    setLoadError('');
    setLoadedAccountUserId('');
    setHasLoadedAccount(false);
    setCancellationTarget(null);
    setPurchaseStatus(null);
  }, [accountUserID]);

  useEffect(() => {
    if (session) refresh();
  }, [session, refresh]);

  const readinessUserID = user?.id || '';

  useEffect(() => {
    readinessUserIDRef.current = readinessUserID;
    readinessRequestIDRef.current += 1;
    readinessSaveIDRef.current += 1;
    readinessSavingRef.current = false;
    readinessDirtyRef.current = false;
    setMemberReadiness(null);
    setReadinessForm(emptyReadinessForm);
    setAdultEligibilityConfirmed(false);
    setContactIsAware(false);
    setDocumentAcknowledgements({});
    setReadinessDirty(false);
    setReadinessLoading(false);
    setReadinessSaving(false);
    setReadinessError('');
    setReadinessSavedMessage('');

    if (readinessUserID) {
      void refreshMemberReadiness({ userID: readinessUserID, replaceDraft: true });
    }

    return () => {
      readinessRequestIDRef.current += 1;
      readinessSaveIDRef.current += 1;
    };
  }, [readinessUserID, refreshMemberReadiness]);

  const handleDismissAnnouncement = async announcement => {
    setDismissingAnnouncementId(announcement.id);
    try {
      await dismissMemberAnnouncement(announcement.id);
      setAnnouncements(current => current.filter(item => item.id !== announcement.id));
    } catch (error) {
      toast({ title: 'Notice not dismissed', description: error.message, variant: 'destructive' });
    } finally {
      setDismissingAnnouncementId(null);
    }
  };

  useEffect(() => {
    setProfileForm({
      full_name: profile?.full_name || '',
      phone: profile?.phone || ''
    });
  }, [profile]);

  useEffect(() => {
    if (!cancellationTarget) return undefined;
    const dismissOnEscape = event => {
      if (event.key === 'Escape') setCancellationTarget(null);
    };
    window.addEventListener('keydown', dismissOnEscape);
    return () => window.removeEventListener('keydown', dismissOnEscape);
  }, [cancellationTarget]);

  useEffect(() => {
    if (!purchaseSuccess || !session || !user?.id) return undefined;
    let cancelled = false;
    let timeoutID;
    const pending = pendingWebCheckoutForReturn({
      userID: user.id,
      checkoutSessionID: searchParams.get('checkout_session_id'),
      storedPending: loadPendingWebCheckout(user.id),
    });
    const commerceRequestID = ++commerceRequestIDRef.current;
    setPurchaseStatus('confirming');

    const reconcile = async () => {
      for (const delay of WEB_CHECKOUT_RETRY_DELAYS_MS) {
        if (delay > 0) {
          await new Promise(resolve => { timeoutID = window.setTimeout(resolve, delay); });
        }
        if (cancelled) return;
        try {
          const [loadedCredits, loadedOrders] = await Promise.all([getMyCredits(), getMyOrders()]);
          if (cancelled) return;
          if (commerceRequestID === commerceRequestIDRef.current) {
            setCredits(loadedCredits);
            setOrders(loadedOrders);
          }
          const settlement = webCheckoutSettlement(pending, loadedOrders);
          if (settlement !== 'pending') {
            clearPendingWebCheckout();
            setPurchaseStatus(settlement);
            const nextParams = new URLSearchParams(searchParams);
            nextParams.delete('purchase');
            nextParams.delete('checkout_session_id');
            setSearchParams(nextParams, { replace: true });
            return;
          }
        } catch {
          // The bounded retry loop keeps account data usable during a transient read failure.
        }
      }
      if (!cancelled) setPurchaseStatus('delayed');
    };

    void reconcile();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutID);
    };
  }, [purchaseRefreshKey, purchaseSuccess, searchParams, session, setSearchParams, user?.id]);

  const handleCancel = async booking => {
    if (!provider.capabilities.canCancelInternally) {
      toast({
        title: 'Manage this booking in FitBox',
        description: provider.blockedReason || 'XERT booking changes are paused while FitBox is selected.',
        variant: provider.blocked ? 'destructive' : undefined,
      });
      return;
    }
    setCancellingId(booking.booking_id);
    try {
      const receipt = await cancelBooking(booking.booking_id);
      toast({
        title: 'Booking cancelled',
        description: cancellationOutcomeMessage(receipt)
      });
      await refresh();
    } catch (e) {
      toast({
        title: 'Could not cancel',
        description: e.message,
        variant: 'destructive'
      });
    } finally {
      setCancellingId(null);
    }
  };

  const providerAllowsNativeCancellation = provider.provider === PLATFORM_PROVIDERS.NATIVE
    && provider.capabilities.canCancelInternally;

  const confirmCancellation = () => {
    if (!cancellationTarget) return;
    const booking = cancellationTarget;
    setCancellationTarget(null);
    void handleCancel(booking);
  };

  const handleProfileSave = async event => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await updateMyProfile({
        full_name: profileForm.full_name.trim() || null,
        phone: profileForm.phone.trim() || null
      });
      setEditingProfile(false);
      toast({
        title: 'Account details saved',
        description: 'Your contact details are up to date.'
      });
    } catch (e) {
      toast({
        title: 'Could not save account details',
        description: e.message,
        variant: 'destructive'
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleReadinessFieldChange = (field, value) => {
    setReadinessForm(current => ({ ...current, [field]: value }));
    if (field === 'emergencyContactName'
        || field === 'emergencyContactPhone'
        || field === 'emergencyContactRelationship') {
      // Awareness applies to the exact person and details currently entered.
      setContactIsAware(false);
    }
    markReadinessDirty();
  };

  const handleAdultEligibilityChange = event => {
    const confirmed = event.target.checked;
    setAdultEligibilityConfirmed(confirmed);
    if (!confirmed) {
      // Returning to the under-18 route revokes every unsaved adult consent.
      setContactIsAware(false);
      setDocumentAcknowledgements(Object.fromEntries(
        (memberReadiness?.required_documents || []).map(document => [document.id, false])
      ));
    }
    markReadinessDirty();
  };

  const handleContactAwarenessChange = event => {
    setContactIsAware(event.target.checked);
    markReadinessDirty();
  };

  const handleDocumentAcknowledgementChange = (documentID, checked) => {
    setDocumentAcknowledgements(current => ({ ...current, [documentID]: checked }));
    markReadinessDirty();
  };

  const handleReadinessSave = async event => {
    event.preventDefault();
    if (!memberReadiness || !adultEligibilityConfirmed || !canSaveReadiness
        || readinessSavingRef.current) {
      if (!adultEligibilityConfirmed) {
        setReadinessError('This adult readiness form cannot be submitted unless you confirm you are 18 or older. If you are under 18, ask a parent or guardian to contact XERT.');
      }
      return;
    }

    const savingUserID = readinessUserIDRef.current;
    if (!savingUserID) return;
    const saveID = ++readinessSaveIDRef.current;
    // Saving this exact draft supersedes any older background hydration.
    readinessRequestIDRef.current += 1;
    setReadinessLoading(false);
    readinessSavingRef.current = true;
    setReadinessSaving(true);
    setReadinessError('');
    setReadinessSavedMessage('');
    try {
      const requiredDocumentIds = memberReadiness.required_documents.map(document => document.id);
      const saved = await saveMyMemberOnboarding({
        ...readinessForm,
        contactIsAware,
        acceptedDocumentIds: requiredDocumentIds,
      });
      if (saveID !== readinessSaveIDRef.current
          || savingUserID !== readinessUserIDRef.current) return;

      readinessSavingRef.current = false;
      setReadinessSaving(false);
      setReadinessDirtyState(false);
      setReadinessFromServer(saved, {
        replaceDraft: true,
        confirmedAdultEligibility: true,
      });
      setProfileForm({
        full_name: saved.profile?.full_name || '',
        phone: saved.profile?.phone || '',
      });
      setReadinessSavedMessage('Saved and confirmed by XERT.');
      toast({
        title: 'Member readiness saved',
        description: 'Your contact details and current acknowledgements are on file.'
      });
    } catch (error) {
      if (saveID === readinessSaveIDRef.current
          && savingUserID === readinessUserIDRef.current) {
        setReadinessError(error.message || 'Member readiness could not be saved.');
      }
    } finally {
      if (saveID === readinessSaveIDRef.current
          && savingUserID === readinessUserIDRef.current) {
        readinessSavingRef.current = false;
        setReadinessSaving(false);
      }
    }
  };

  const handleRemoveEventGoal = async goal => {
    try {
      await removeMyEventGoal(goal.event_id);
      setEventGoals(current => current.filter(item => item.event_id !== goal.event_id));
      toast({
        title: 'Training goal removed',
        description: `${goal.events?.name || 'This event'} has been removed from your account.`
      });
    } catch (e) {
      toast({
        title: 'Could not remove training goal',
        description: e.message,
        variant: 'destructive'
      });
    }
  };

  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    try {
      await deleteMyAccount(session?.access_token);
      setShowDeleteAccount(false);
      toast({ title: 'Account deleted', description: 'Your XERT member account has been permanently removed.' });
    } catch (error) {
      toast({ title: 'Could not delete account', description: error.message, variant: 'destructive' });
    } finally {
      setDeletingAccount(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-xert-navy">
        <Loader2 className="w-6 h-6 animate-spin text-xert-steel" />
      </div>
    );
  }

  if (!session) {
    const accountReturnPath = `${location.pathname}${location.search}${location.hash}`;
    return (
      <div className="min-h-screen bg-xert-navy">
        <PublicNav />
        <main id="main" className="relative max-w-md mx-auto px-6 pt-36 pb-20 text-center">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[24rem] pointer-events-none xert-glow-top" />
          <div className="relative xert-card p-6 sm:p-8">
            <h1 className="font-display text-3xl uppercase text-xert-offwhite mb-3">Sign in to your account</h1>
            <p className="font-body text-sm mb-8 text-xert-pale/65">
              View your bookings, purchases and training goals.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link to={authPathWithNext('/login', accountReturnPath)} className="xert-btn-primary inline-flex min-h-[52px] w-full sm:w-auto items-center justify-center px-6 font-display text-base uppercase tracking-wide">
                Log In
              </Link>
              <Link
                to={authPathWithNext('/register', accountReturnPath)}
                className="xert-btn-ghost inline-flex min-h-[52px] w-full sm:w-auto items-center justify-center px-6 font-display text-base uppercase tracking-wide"
              >
                Create Account
              </Link>
            </div>
          </div>
        </main>
        <PublicFooter />
      </div>
    );
  }

  const { pending, upcoming, history: past } = partitionAccountBookings(bookings);
  const displayName = profileForm.full_name.trim() || user?.email;
  const accountReady = hasLoadedAccount && loadedAccountUserId === user?.id;
  const firstLoadFailed = !accountReady && Boolean(loadError);
  const initialAccountLoad = !accountReady && !loadError;
  const creditsUnavailable = Boolean(accountSourceErrors.credits);
  const bookingsUnavailable = Boolean(accountSourceErrors.bookings);
  const ordersUnavailable = Boolean(accountSourceErrors.orders);
  const unavailableMessage = (
    <p className="font-body text-sm" role="status" style={{ color: 'var(--state-warning)' }}>
      Account data unavailable. Retry above to check again.
    </p>
  );
  const requiredDocuments = memberReadiness?.required_documents || [];
  const readinessFieldsComplete = Object.values(readinessForm).every(value => String(value || '').trim());
  const documentsAcknowledged = requiredDocuments.length > 0
    && requiredDocuments.every(document => documentAcknowledgements[document.id] === true);
  const canSaveReadiness = Boolean(memberReadiness)
    && adultEligibilityConfirmed
    && readinessFieldsComplete
    && contactIsAware
    && documentsAcknowledged
    && readinessDirty
    && !readinessLoading
    && !readinessSaving;

  return (
    <div className="relative min-h-screen bg-xert-navy">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[28rem] pointer-events-none xert-glow-top" />
      <PublicNav />

      <main id="main" className="relative max-w-4xl mx-auto px-6 pt-28 pb-20">
        {loadError && (
          <div
            className={`${warningBoxClasses} mb-8 flex flex-col gap-3 p-4 sm:p-5 sm:flex-row sm:items-center`}
            role="alert"
          >
            <AlertTriangle className="h-5 w-5 shrink-0 text-state-warning" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-body text-sm font-semibold text-xert-offwhite">Could not refresh your account</p>
              <p className="mt-1 break-words font-body text-xs text-xert-pale/70">{loadError}</p>
              {hasLoadedAccount && (
                <p className="mt-1 font-body text-xs text-xert-pale/70">Your previously loaded details are still shown below.</p>
              )}
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className={`${warningButtonClasses} shrink-0 disabled:opacity-50`}
            >
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}
        {purchaseStatus && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-2xl border p-4 sm:p-5 mb-8"
            role="status"
            aria-live="polite"
            style={{
              borderColor: purchaseStatus === 'failed' || purchaseStatus === 'refunded' ? 'var(--state-warning)' : 'var(--accent-default)',
              backgroundColor: purchaseStatus === 'failed' || purchaseStatus === 'refunded'
                ? 'var(--state-warning-10)'
                : 'var(--accent-default-12)'
            }}
          >
            {purchaseStatus === 'confirming'
              ? <Loader2 className="w-5 h-5 shrink-0 animate-spin" style={{ color: 'var(--accent-default)' }} />
              : purchaseStatus === 'confirmed'
                ? <CheckCircle2 className="w-5 h-5 shrink-0" style={{ color: 'var(--accent-default)' }} />
                : <AlertTriangle className="w-5 h-5 shrink-0" style={{ color: 'var(--state-warning)' }} />}
            <p className="font-body text-sm flex-1 min-w-[14rem]" style={{ color: 'var(--text-secondary)' }}>
              {purchaseStatus === 'confirming' && 'Payment received — confirming your purchase now.'}
              {purchaseStatus === 'confirmed' && 'Payment confirmed.'}
              {purchaseStatus === 'refunded' && 'This payment was refunded.'}
              {purchaseStatus === 'failed' && 'Checkout did not complete. Nothing was activated.'}
              {purchaseStatus === 'delayed' && 'Confirmation is taking longer than usual. Your payment record remains safe.'}
            </p>
            {purchaseStatus === 'delayed' && (
              <button
                type="button"
                onClick={() => setPurchaseRefreshKey(value => value + 1)}
                className="xert-btn-ghost inline-flex min-h-11 items-center justify-center px-4 font-display text-sm uppercase tracking-wide"
              >
                Check again
              </button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-4 mb-10">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-px w-6 bg-xert-steel" />
              <span className="font-body text-xs uppercase tracking-[0.2em] text-xert-steel">
                My Account
              </span>
            </div>
            <h1 className="font-display uppercase text-xert-offwhite" style={{ fontSize: 'clamp(2rem,5vw,3rem)', lineHeight: 0.95 }}>
              {displayName}
            </h1>
          </div>
          <button onClick={signOut} className={ghostButtonClasses}>
            Sign Out
          </button>
        </div>

        {accountReady && announcements.length > 0 && (
          <section id="notices" className="mb-10 scroll-mt-32" aria-labelledby="member-notices-title">
            <div className="mb-4 flex items-center gap-2">
              <BellRing className="h-5 w-5 text-xert-steel" aria-hidden="true" />
              <h2 id="member-notices-title" className="font-display text-2xl uppercase text-xert-offwhite">Member notices</h2>
            </div>
            <div className="space-y-3">
              {announcements.map(notice => {
                const action = announcementAction(notice);
                const tone = notice.tone === 'urgent'
                  ? { border: 'var(--state-danger-55)', label: 'Urgent', color: 'var(--state-danger-text)' }
                  : notice.tone === 'action'
                    ? { border: 'var(--state-warning-50)', label: 'Action requested', color: 'var(--state-warning)' }
                    : { border: 'var(--accent-default-40)', label: 'Update', color: 'var(--accent-default)' };
                return (
                  <article key={notice.id} className="xert-card p-5" style={{ borderColor: tone.border }}>
                    <div className="flex items-start justify-between gap-4">
                      <p className="xert-chip" style={{ color: tone.color, borderColor: tone.border }}>{tone.label}</p>
                      <button type="button" onClick={() => void handleDismissAnnouncement(notice)} disabled={dismissingAnnouncementId === notice.id} title="Dismiss notice" aria-label={'Dismiss ' + notice.title} className="min-w-11 min-h-11 -mr-2 -mt-2 inline-flex items-center justify-center text-xert-pale/50 hover:text-xert-offwhite disabled:opacity-40">
                        {dismissingAnnouncementId === notice.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                      </button>
                    </div>
                    <h3 className="mt-2 font-display text-xl uppercase text-xert-offwhite">{notice.title}</h3>
                    <p className="mt-2 whitespace-pre-wrap font-body text-sm leading-relaxed text-xert-pale/70">{notice.body}</p>
                    {action && (action.external ? (
                      <a href={action.href} target="_blank" rel="noreferrer" className="xert-btn-primary mt-4 inline-flex min-h-11 items-center px-4 font-display text-sm uppercase tracking-wide">{action.label}</a>
                    ) : (
                      <Link to={action.href} className="xert-btn-primary mt-4 inline-flex min-h-11 items-center px-4 font-display text-sm uppercase tracking-wide">{action.label}</Link>
                    ))}
                    {notice.expires_at && <p className="mt-3 font-body text-xs text-xert-pale/40">Available until {formatDateTime(notice.expires_at)}</p>}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <section id="member-readiness" className="mb-10 scroll-mt-32" aria-labelledby="member-readiness-title">
          <div className="xert-card p-5 sm:p-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <span className="xert-icon-tile">
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-body text-[10px] uppercase tracking-[0.2em] text-xert-steel">Member companion</p>
                  <h2 id="member-readiness-title" className="mt-1 font-display text-2xl uppercase text-xert-offwhite">Member Readiness</h2>
                  <p className="mt-2 max-w-2xl font-body text-sm leading-relaxed text-xert-pale/65">
                    Keep contact details current and review XERT’s required safety information. This is administrative preparation, not a medical assessment or medical clearance, and it does not change your booking access.
                  </p>
                </div>
              </div>
              {memberReadiness && (
                <span className="xert-chip shrink-0" style={readinessDirty || !memberReadiness.is_complete ? { color: 'var(--state-warning)', borderColor: 'var(--state-warning-50)' } : { color: 'var(--state-success-bright)', borderColor: 'var(--state-success-strong-40)' }}>
                  {readinessDirty ? 'Unsaved changes' : memberReadiness.is_complete ? 'On file' : 'Action available'}
                </span>
              )}
            </div>

            {readinessLoading && !memberReadiness ? (
              <div className="mt-6 flex min-h-28 items-center justify-center rounded-2xl border border-xert-steel/20" role="status">
                <Loader2 className="mr-2 h-5 w-5 animate-spin text-xert-steel" aria-hidden="true" />
                <span className="font-body text-sm text-xert-pale/60">Loading member readiness…</span>
              </div>
            ) : readinessError && !memberReadiness ? (
              <div className={`${warningBoxClasses} mt-6 p-4`} role="alert">
                <p className="font-body text-sm font-semibold text-xert-offwhite">Member readiness is unavailable</p>
                <p className="mt-1 break-words font-body text-xs text-xert-pale/70">{readinessError}</p>
                <p className="mt-1 font-body text-xs text-xert-pale/55">Bookings and the rest of your account remain available.</p>
                <button type="button" onClick={() => void refreshMemberReadiness({ userID: readinessUserID, replaceDraft: true })} disabled={readinessLoading} className={`${warningButtonClasses} mt-4 disabled:opacity-50`}>
                  {readinessLoading ? 'Retrying…' : 'Retry readiness'}
                </button>
              </div>
            ) : memberReadiness && (
              <form onSubmit={handleReadinessSave} className="mt-7 space-y-7">
                {readinessLoading && (
                  <p className="flex items-center gap-2 font-body text-xs text-xert-pale/55" role="status">
                    <Loader2 className="h-4 w-4 animate-spin text-xert-steel" aria-hidden="true" />
                    Checking the latest server-confirmed readiness information…
                  </p>
                )}
                <fieldset disabled={readinessSaving || readinessLoading} className="space-y-3 disabled:opacity-70">
                  <legend className="font-display text-lg uppercase text-xert-offwhite">Adult eligibility</legend>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-xert-steel/25 bg-white/[0.03] p-4 font-body text-sm leading-relaxed text-xert-pale/80">
                    <input
                      type="checkbox"
                      required
                      checked={adultEligibilityConfirmed}
                      onChange={handleAdultEligibilityChange}
                      aria-describedby={!adultEligibilityConfirmed ? 'under-18-readiness-guidance' : undefined}
                      className="mt-0.5 h-5 w-5 shrink-0 rounded accent-xert-steel"
                    />
                    I confirm I am 18 years of age or older and eligible to complete the adult readiness acknowledgement below.
                  </label>
                </fieldset>

                {!adultEligibilityConfirmed ? (
                  <div id="under-18-readiness-guidance" className={`${warningBoxClasses} p-4`} role="note">
                    <h3 className="font-display text-lg uppercase text-xert-offwhite">Under 18?</h3>
                    <p className="mt-2 font-body text-sm leading-relaxed text-xert-pale/70">
                      Do not submit this adult form. Ask a parent or guardian to contact XERT so the team can discuss the appropriate next step with them.
                    </p>
                    <Link to="/contact" className={`${warningButtonClasses} mt-4`}>
                      Parent or guardian: contact XERT
                    </Link>
                  </div>
                ) : (
                  <>
                <fieldset disabled={readinessSaving} className="space-y-4 disabled:opacity-70">
                  <legend className="font-display text-lg uppercase text-xert-offwhite">Your details</legend>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className={fieldLabelClasses}>
                      Full name
                      <input required maxLength={100} autoComplete="name" value={readinessForm.fullName} onChange={event => handleReadinessFieldChange('fullName', event.target.value)} className={fieldInputClasses} />
                    </label>
                    <label className={fieldLabelClasses}>
                      Mobile number
                      <input required maxLength={32} type="tel" inputMode="tel" autoComplete="tel" value={readinessForm.phone} onChange={event => handleReadinessFieldChange('phone', event.target.value)} className={fieldInputClasses} />
                    </label>
                  </div>
                </fieldset>

                <fieldset disabled={readinessSaving} className="space-y-4 disabled:opacity-70">
                  <legend className="font-display text-lg uppercase text-xert-offwhite">Emergency contact</legend>
                  <p className="font-body text-xs leading-relaxed text-xert-pale/55">Used only if XERT reasonably needs to contact someone about your immediate safety. Other members cannot see it.</p>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className={fieldLabelClasses}>
                      Contact name
                      <input required maxLength={100} autoComplete="off" value={readinessForm.emergencyContactName} onChange={event => handleReadinessFieldChange('emergencyContactName', event.target.value)} className={fieldInputClasses} />
                    </label>
                    <label className={fieldLabelClasses}>
                      Contact phone
                      <input required maxLength={32} type="tel" inputMode="tel" autoComplete="off" value={readinessForm.emergencyContactPhone} onChange={event => handleReadinessFieldChange('emergencyContactPhone', event.target.value)} className={fieldInputClasses} />
                    </label>
                    <label className={`${fieldLabelClasses} sm:col-span-2`}>
                      Relationship
                      <input required maxLength={60} autoComplete="off" placeholder="For example: parent, family member or friend" value={readinessForm.emergencyContactRelationship} onChange={event => handleReadinessFieldChange('emergencyContactRelationship', event.target.value)} className={fieldInputClasses} />
                    </label>
                  </div>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-xert-steel/20 bg-white/[0.02] p-3 font-body text-sm leading-relaxed text-xert-pale/75">
                    <input type="checkbox" required checked={contactIsAware} onChange={handleContactAwarenessChange} className="mt-0.5 h-5 w-5 shrink-0 rounded accent-xert-steel" />
                    I confirm this person knows I have listed them as my emergency contact and may be contacted by XERT if reasonably needed for my immediate safety.
                  </label>
                </fieldset>

                <fieldset disabled={readinessSaving} className="space-y-4 disabled:opacity-70">
                  <legend className="font-display text-lg uppercase text-xert-offwhite">Required acknowledgements</legend>
                  <p className="font-body text-xs leading-relaxed text-xert-pale/55">Review each current document in full. XERT stores its version and your server-confirmed acceptance time. No health answers or medical outcomes are collected in this form.</p>
                  {requiredDocuments.map(document => {
                    const sourceURL = officialSourceURL(document.source_url);
                    const previouslyAccepted = memberReadiness.accepted_documents.some(receipt => receipt.document_id === document.id);
                    return (
                      <article key={document.id} className="xert-card-flat p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h3 className="font-display text-base uppercase text-xert-offwhite">{document.title}</h3>
                            <p className="mt-1 font-body text-[10px] uppercase tracking-wider text-xert-pale/40">Version {document.version}</p>
                          </div>
                          {previouslyAccepted && <span className="xert-chip" style={{ color: 'var(--state-success-bright)', borderColor: 'var(--state-success-strong-40)' }}>Previously accepted</span>}
                        </div>
                        <p className="mt-3 whitespace-pre-wrap font-body text-sm leading-relaxed text-xert-pale/70">{document.body}</p>
                        {sourceURL && (
                          <a href={sourceURL} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-2 font-body text-xs uppercase tracking-wider text-xert-steel underline underline-offset-4">
                            Open official source <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        )}
                        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 border-t border-xert-steel/15 pt-3 font-body text-sm leading-relaxed text-xert-pale/80">
                          <input type="checkbox" required checked={documentAcknowledgements[document.id] === true} onChange={event => handleDocumentAcknowledgementChange(document.id, event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 rounded accent-xert-steel" />
                          I have read and acknowledge this version.
                        </label>
                      </article>
                    );
                  })}
                </fieldset>

                <div className="border-t border-xert-steel/20 pt-5">
                  <p className="font-body text-xs leading-relaxed text-xert-pale/50">
                    Authorized XERT administrators can see completion status. Emergency details are available only from your individual member record through a recorded reveal. See the <Link to="/privacy" className="text-xert-steel underline underline-offset-2">Privacy Policy</Link>.
                  </p>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="font-body text-xs text-xert-pale/45">Your update is complete only after XERT confirms the save.</p>
                    <button type="submit" disabled={!canSaveReadiness} className="xert-btn-primary inline-flex min-h-[52px] w-full sm:w-auto items-center justify-center px-5 font-display text-sm uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40">
                      {readinessSaving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />Saving…</> : 'Save member readiness'}
                    </button>
                  </div>
                </div>
                  </>
                )}
                {readinessError && <p className="font-body text-sm text-state-warning" role="alert">{readinessError}</p>}
                {readinessSavedMessage && <p className="flex items-center gap-2 font-body text-sm text-status-confirmed-300" role="status"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{readinessSavedMessage}</p>}
              </form>
            )}
          </div>
        </section>

        {/* Member details */}
        <section className="mb-10">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="font-display text-2xl uppercase text-xert-pale/85">
              Account Details
            </h2>
            {!editingProfile && (
              <button onClick={() => setEditingProfile(true)} className={ghostButtonClasses}>
                Edit
              </button>
            )}
          </div>

          {editingProfile ? (
            <form onSubmit={handleProfileSave} className="xert-card p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className={fieldLabelClasses}>
                  Full name
                  <input
                    value={profileForm.full_name}
                    onChange={e =>
                      setProfileForm(current => ({
                        ...current,
                        full_name: e.target.value
                      }))
                    }
                    autoComplete="name"
                    className={fieldInputClasses}
                  />
                </label>
                <label className={fieldLabelClasses}>
                  Mobile number
                  <input
                    value={profileForm.phone}
                    onChange={e =>
                      setProfileForm(current => ({
                        ...current,
                        phone: e.target.value
                      }))
                    }
                    autoComplete="tel"
                    inputMode="tel"
                    className={fieldInputClasses}
                  />
                </label>
              </div>
              <div className="flex flex-wrap justify-end gap-3 mt-5">
                <button
                  type="button"
                  onClick={() => {
                    setEditingProfile(false);
                    setProfileForm({
                      full_name: profile?.full_name || '',
                      phone: profile?.phone || ''
                    });
                  }}
                  className={ghostButtonClasses}
                >
                  Cancel
                </button>
                <button type="submit" disabled={savingProfile} className="xert-btn-primary inline-flex min-h-11 items-center justify-center px-5 font-display text-sm uppercase tracking-wide disabled:opacity-50">
                  {savingProfile ? 'Saving...' : 'Save details'}
                </button>
              </div>
            </form>
          ) : (
            <div className="xert-card p-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <p className="font-body text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-secondary-40)' }}>
                  Email
                </p>
                <p className="font-body text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {user?.email}
                </p>
              </div>
              <div>
                <p className="font-body text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-secondary-40)' }}>
                  Mobile
                </p>
                <p className="font-body text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {profileForm.phone || 'Not provided'}
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Class packs are retired. This wallet stays only for the members who
            still hold credits bought before memberships replaced them. */}
        {hasLegacyCredits && (
        <section className="mb-10">
          {accountReady && creditsUnavailable && (
            <div className={`${warningBoxClasses} mb-3 p-4`}>
              <p className="font-body text-sm text-xert-pale" role="status">
                Credit balance unavailable. {credits ? 'Your last loaded balance is shown below.' : 'Retry before relying on your balance.'}
              </p>
            </div>
          )}
          {accountReady && expiringCredits && (
            <div role="status" className={`${warningBoxClasses} mb-3 flex flex-wrap items-center gap-3 p-4`}>
              <AlertTriangle className="h-5 w-5 shrink-0 text-state-warning" aria-hidden="true" />
              <p className="min-w-0 flex-1 font-body text-sm text-xert-pale">
                {expiringCredits.credits} class credit{expiringCredits.credits === 1 ? '' : 's'} expire{expiringCredits.credits === 1 ? 's' : ''} in {expiringCredits.daysRemaining} day{expiringCredits.daysRemaining === 1 ? '' : 's'}, on {formatDate(expiringCredits.expiresAt)}.
              </p>
              <Link to="/booking" className="inline-flex min-h-11 items-center rounded-[0.875rem] bg-state-warning px-4 font-display text-sm uppercase tracking-wide text-xert-navy">
                Book A Class
              </Link>
            </div>
          )}
          <div className="xert-card-accent p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-6">
            <div className="flex items-center gap-4">
              <div className="xert-icon-tile" style={{ backgroundColor: 'var(--accent-default)', color: 'var(--surface-base)' }}>
                <Ticket className="w-6 h-6" />
              </div>
              <div>
                <p className="font-display text-4xl uppercase leading-none text-xert-offwhite">{initialAccountLoad || firstLoadFailed || (creditsUnavailable && !credits) ? '—' : (credits?.total ?? 0)}</p>
                <p className="font-body text-xs uppercase tracking-wider mt-1" style={{ color: 'var(--text-secondary-50)' }}>
                  Class credits available
                </p>
              </div>
            </div>
            <div className="sm:ml-auto flex flex-wrap items-center gap-3">
              {accountReady && !loading && credits?.batches?.some(batch => batch.expires_at) && (
                <p className="font-body text-xs" style={{ color: 'var(--text-secondary-45)' }}>
                  Next expiry: {formatDate(credits.batches.find(batch => batch.expires_at)?.expires_at)}
                </p>
              )}
              <Link to="/booking" className={`${primaryButtonClasses} w-full sm:w-auto`}>
                Book A Class
              </Link>
            </div>
          </div>
        </section>
        )}

        {/* Attendance-derived progress */}
        <section id="progress" className="mb-10 scroll-mt-32">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl uppercase text-xert-pale/85">
                Training Momentum
              </h2>
              <p className="mt-1 font-body text-xs" style={{ color: 'var(--text-secondary-48)' }}>
                Based only on attendance recorded by XERT.
              </p>
            </div>
            <Link to="/booking" className={inlineLinkClasses}>
              Book next class
            </Link>
          </div>

          {initialAccountLoad ? (
            <div className="xert-card flex min-h-28 items-center gap-3 p-6" role="status">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--accent-default)' }} aria-hidden="true" />
              <p className="font-body text-sm" style={{ color: 'var(--text-secondary-60)' }}>Loading your progress…</p>
            </div>
          ) : firstLoadFailed || bookingsUnavailable ? (
            <div className="xert-card p-6">{unavailableMessage}</div>
          ) : trainingProgress.totalAttended === 0 ? (
            <div className="xert-card flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
              <CheckCircle2 className="h-8 w-8 shrink-0" style={{ color: 'var(--accent-default)' }} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-display text-xl uppercase text-xert-offwhite">Your progress starts here</p>
                <p className="mt-1 font-body text-sm leading-relaxed" style={{ color: 'var(--text-secondary-58)' }}>
                  Completed classes appear after Byron or the XERT team records attendance. Confirmed, cancelled and missed classes never inflate your totals.
                </p>
              </div>
            </div>
          ) : (
            <div className="xert-card p-5 sm:p-6">
              <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-3">
                {[
                  [trainingProgress.attendedLast30Days, 'Completed · 30 days'],
                  [`${trainingProgress.activeWeeksLastFour}/4`, 'Active weeks'],
                  [trainingProgress.totalAttended, 'Completed · all time'],
                ].map(([value, label]) => (
                  <div key={label} className="rounded-xl bg-white/[0.03] p-4">
                    <p className="font-display text-3xl uppercase leading-none text-xert-offwhite">{value}</p>
                    <p className="mt-2 font-body text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary-52)' }}>{label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 font-body text-xs" style={{ color: 'var(--text-secondary-48)' }}>
                Last completed class: {formatDateTime(trainingProgress.lastAttendedAt)}
              </p>
            </div>
          )}
        </section>

        {/* Event goals */}
        <section id="goals" className="mb-10 scroll-mt-32">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="font-display text-2xl uppercase text-xert-pale/85">
              Training Goals
            </h2>
            <Link to="/events" className={inlineLinkClasses}>
              Explore events
            </Link>
          </div>
          {initialAccountLoad ? (
            <p className="font-body text-sm" style={{ color: 'var(--text-secondary-50)' }}>
              Loading goals…
            </p>
          ) : firstLoadFailed || accountSourceErrors.eventGoals ? (
            unavailableMessage
          ) : eventGoals.length === 0 ? (
            <div className="xert-card p-6 flex flex-wrap items-center gap-4">
              <span className="xert-icon-tile"><Target className="w-5 h-5" /></span>
              <p className="font-body text-sm flex-1 min-w-[12rem] text-xert-pale/60">
                Choose an event and make it part of your XERT training plan.
              </p>
              <Link to="/events" className="xert-btn-primary inline-flex min-h-11 items-center justify-center px-4 font-display text-sm uppercase tracking-wide">
                Choose an event
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {eventGoals.map(goal => {
                const event = goal.events;
                return (
                  <div key={goal.event_id} className="xert-card p-5 flex flex-wrap items-center gap-4">
                    <div className="xert-icon-tile">
                      <Target className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-[12rem]">
                      <p className="font-display text-xl uppercase leading-tight text-xert-offwhite">{event?.name || 'XERT event'}</p>
                      <p className="font-body text-sm mt-1" style={{ color: 'var(--text-secondary-58)' }}>
                        {[formatDate(event?.event_date), event?.location].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <button onClick={() => handleRemoveEventGoal(goal)} className={ghostButtonClasses}>
                      Remove goal
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <MemberPT />

        {/* Personal training requests (the older enquiry form; hidden once PT booking is on and there are none) */}
        {(!ptBooking.enabled || privateSessionRequests.length > 0) && <section className="mb-10">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="font-display text-2xl uppercase text-xert-pale/85">
              PT Requests
            </h2>
            <Link to="/timetable" className={inlineLinkClasses}>
              Request a session
            </Link>
          </div>
          {initialAccountLoad ? (
            <p className="font-body text-sm" style={{ color: 'var(--text-secondary-50)' }}>Loading PT requests…</p>
          ) : firstLoadFailed || accountSourceErrors.privateSessions ? (
            unavailableMessage
          ) : privateSessionRequests.length === 0 ? (
            <div className="xert-card p-6 flex flex-wrap items-center gap-4">
              <span className="xert-icon-tile"><Dumbbell className="w-5 h-5" /></span>
              <p className="font-body text-sm flex-1 min-w-[12rem] text-xert-pale/60">
                No personal training requests yet.
              </p>
              <Link to="/timetable" className="xert-btn-primary inline-flex min-h-11 items-center justify-center px-4 font-display text-sm uppercase tracking-wide">
                Request PT
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {privateSessionRequests.map(request => (
                <div key={request.id} className="xert-card p-5 flex flex-wrap items-center gap-4">
                  <div className="xert-icon-tile">
                    <Dumbbell className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-[12rem]">
                    <p className="font-display text-xl uppercase leading-tight text-xert-offwhite">{request.requested_session_type}</p>
                    <p className="font-body text-sm mt-1" style={{ color: 'var(--text-secondary-58)' }}>
                      {[formatDate(request.created_at), request.preferred_day, request.preferred_time].filter(Boolean).join(' · ')}
                    </p>
                    {request.training_goal && <p className="font-body text-xs mt-1" style={{ color: 'var(--text-secondary-45)' }}>Goal: {request.training_goal}</p>}
                  </div>
                  <span className="xert-chip">
                    {privateSessionStatus(request.status)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>}

        {/* Pending booking requests */}
        {accountReady && pending.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display text-2xl uppercase mb-4 text-xert-pale/85">
              Requests &amp; Waitlist
            </h2>
            <div className="space-y-3">
              {pending.map(b => (
                <div key={b.booking_id} className="xert-card p-5 flex flex-wrap items-center gap-4">
                  <div className="xert-icon-tile">
                    <Clock className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-[12rem]">
                    <p className="font-display text-xl uppercase leading-tight text-xert-offwhite">{b.title || b.class_type || 'XERT Class'}</p>
                    <p className="font-body text-sm mt-0.5" style={{ color: 'var(--text-secondary-60)' }}>
                      {formatDateTime(b.start_time)}
                      {b.coach_name ? ` · Coach ${b.coach_name}` : ''}
                    </p>
                    <p className="font-body text-xs mt-1" style={{ color: 'var(--accent-default-75)' }}>
                      {b.status === 'waitlisted'
                        ? `You are ${b.waitlist_position ? `#${b.waitlist_position} ` : ''}on the waitlist. XERT will let you know as soon as a place opens up.`
                        : 'Your place is held while XERT confirms this request.'}
                    </p>
                  </div>
                  {providerAllowsNativeCancellation ? (
                    <button
                      onClick={() => setCancellationTarget(b)}
                      disabled={cancellingId === b.booking_id}
                      className={`${ghostButtonClasses} disabled:opacity-50`}
                    >
                      {cancellingId === b.booking_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                      {b.status === 'waitlisted' ? 'Leave waitlist' : 'Cancel request'}
                    </button>
                  ) : provider.portalUrl ? (
                    <a href={provider.portalUrl} target="_blank" rel="noopener noreferrer"
                      className={ghostButtonClasses}>
                      <ExternalLink className="h-3.5 w-3.5" /> Manage in FitBox
                    </a>
                  ) : (
                    <span className="font-body text-xs text-xert-concrete/50">Booking changes paused</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Upcoming bookings */}
        <section id="bookings" className="mb-10 scroll-mt-32">
          <h2 className="font-display text-2xl uppercase mb-4 text-xert-pale/85">
            Upcoming Classes
          </h2>
          {initialAccountLoad ? (
            <p className="font-body text-sm" style={{ color: 'var(--text-secondary-50)' }}>
              Loading…
            </p>
          ) : firstLoadFailed || bookingsUnavailable ? (
            unavailableMessage
          ) : upcoming.length === 0 ? (
            <div className="xert-card p-6">
              <p className="font-body text-sm" style={{ color: 'var(--text-secondary-55)' }}>
                No upcoming classes booked.{' '}
                <Link to="/booking" style={{ color: 'var(--accent-default)' }}>
                  Browse the timetable
                </Link>{' '}
                to book your next session.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {upcoming.map(b => (
                <div key={b.booking_id} className="xert-card p-5 flex flex-wrap items-center gap-4">
                  <div className="xert-icon-tile">
                    <CalendarDays className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-[12rem]">
                    <p className="font-display text-xl uppercase leading-tight text-xert-offwhite">{b.title || b.class_type || 'XERT Class'}</p>
                    <p className="font-body text-sm mt-0.5" style={{ color: 'var(--text-secondary-60)' }}>
                      {formatDateTime(b.start_time)}
                      {b.coach_name ? ` · Coach ${b.coach_name}` : ''}
                    </p>
                  </div>
                  {providerAllowsNativeCancellation ? (
                    <button
                      onClick={() => setCancellationTarget(b)}
                      disabled={cancellingId === b.booking_id}
                      className={`${ghostButtonClasses} disabled:opacity-50`}
                    >
                      {cancellingId === b.booking_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                      Cancel
                    </button>
                  ) : provider.portalUrl ? (
                    <a href={provider.portalUrl} target="_blank" rel="noopener noreferrer"
                      className={ghostButtonClasses}>
                      <ExternalLink className="h-3.5 w-3.5" /> Manage in FitBox
                    </a>
                  ) : (
                    <span className="font-body text-xs text-xert-concrete/50">Booking changes paused</span>
                  )}
                </div>
              ))}
              <p className="font-body text-xs flex items-center gap-1.5" style={{ color: 'var(--text-secondary-40)' }}>
                <Clock className="w-3.5 h-3.5" />
                Please cancel more than 12 hours before class so someone else can take the place.
              </p>
            </div>
          )}
        </section>

        {/* Purchase history */}
        <section className="mb-10">
          <h2 className="font-display text-2xl uppercase mb-4 text-xert-pale/85">
            Purchases
          </h2>
          {initialAccountLoad ? (
            <p className="font-body text-sm" style={{ color: 'var(--text-secondary-50)' }}>
              Loading…
            </p>
          ) : firstLoadFailed || ordersUnavailable ? (
            unavailableMessage
          ) : orders.length === 0 ? (
            <div className="xert-card p-6">
              <p className="font-body text-sm" style={{ color: 'var(--text-secondary-55)' }}>
                No purchases yet.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {orders.map(o => (
                <div key={o.id} className="xert-card p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Receipt className="w-4 h-4 shrink-0 text-xert-steel" />
                  <p className="font-body text-sm flex-1 min-w-[8rem]" style={{ color: 'var(--text-secondary-70)' }}>
                    {o.products?.name || 'Session pack'}
                  </p>
                  <p className="font-body text-xs" style={{ color: 'var(--text-secondary-45)' }}>
                    {formatDate(o.paid_at || o.created_at)}
                  </p>
                  <p className="font-display text-lg uppercase" style={{ color: 'var(--accent-default)' }}>
                    ${((o.amount_cents || 0) / 100).toFixed(2)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Past classes */}
        {accountReady && past.length > 0 && (
          <section>
            <h2 className="font-display text-2xl uppercase mb-4 text-xert-pale/85">
              Past &amp; Cancelled
            </h2>
            <div className="space-y-2">
              {past.slice(0, 10).map(b => (
                <div key={b.booking_id} className="xert-card p-4 flex flex-wrap items-center gap-x-4 gap-y-2 opacity-70">
                  <p className="font-body text-sm flex-1 min-w-[10rem]" style={{ color: 'var(--text-secondary-60)' }}>
                    {b.title || b.class_type || 'XERT Class'}
                  </p>
                  <p className="font-body text-xs" style={{ color: 'var(--text-secondary-40)' }}>
                    {formatDateTime(b.start_time)}
                  </p>
                  <span className="xert-chip opacity-80">
                    {b.status}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-12 pt-8 border-t border-state-danger/25">
          <h2 className="font-display text-xl uppercase text-xert-offwhite">Account Control</h2>
          <p className="font-body text-sm mt-2 max-w-xl" style={{ color: 'var(--text-secondary-55)' }}>
            Permanently remove your profile, emergency contact, readiness acknowledgements, credits, bookings, PT requests and training goals. Purchase records are anonymized.
          </p>
          <button type="button" onClick={() => setShowDeleteAccount(true)} className="mt-4 inline-flex min-h-11 items-center justify-center rounded-[0.875rem] border px-4 font-body text-xs uppercase tracking-wider transition-colors hover:bg-state-danger/10" style={{ borderColor: 'var(--state-danger-55)', color: 'var(--state-danger-text)' }}>
            Delete account
          </button>
        </section>
      </main>

      <PublicFooter />
      {cancellationTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cancel-booking-title"
          aria-describedby="cancel-booking-description"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setCancellationTarget(null);
          }}
        >
          <div className="xert-card w-full max-w-md p-6">
            <h2 id="cancel-booking-title" className="font-display text-2xl uppercase text-xert-offwhite">
              Cancel booking?
            </h2>
            <p id="cancel-booking-description" className="font-body text-sm leading-relaxed mt-3" style={{ color: 'var(--text-secondary-68)' }}>
              {cancellationMessage(cancellationTarget)}
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 mt-6">
              <button
                type="button"
                autoFocus
                onClick={() => setCancellationTarget(null)}
                className={ghostButtonClasses}
              >
                Keep booking
              </button>
              <button type="button" onClick={confirmCancellation} className="inline-flex min-h-11 items-center justify-center rounded-[0.875rem] px-4 font-body text-xs uppercase tracking-wider transition-colors" style={{ backgroundColor: 'var(--state-danger)', color: 'var(--text-on-color)' }}>
                Cancel booking
              </button>
            </div>
          </div>
        </div>
      )}
      {showDeleteAccount && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title" aria-describedby="delete-account-description">
          <div className="xert-card w-full max-w-md p-6" style={{ borderColor: 'var(--state-danger-45)' }}>
            <h2 id="delete-account-title" className="font-display text-2xl uppercase text-xert-offwhite">Delete account permanently?</h2>
            <p id="delete-account-description" className="font-body text-sm leading-relaxed mt-3" style={{ color: 'var(--text-secondary-68)' }}>
              Your profile, emergency contact, readiness acknowledgements, credits, bookings, PT requests and training goals will be removed. Purchase records are anonymized. This cannot be undone.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 mt-6">
              <button type="button" autoFocus disabled={deletingAccount} onClick={() => setShowDeleteAccount(false)} className={`${ghostButtonClasses} disabled:opacity-50`}>Keep account</button>
              <button type="button" disabled={deletingAccount} onClick={() => void handleDeleteAccount()} className="inline-flex min-h-11 items-center justify-center rounded-[0.875rem] px-4 font-body text-xs uppercase tracking-wider disabled:opacity-50" style={{ backgroundColor: 'var(--state-danger)', color: 'var(--text-on-color)' }}>
                {deletingAccount ? 'Deleting...' : 'Delete account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
