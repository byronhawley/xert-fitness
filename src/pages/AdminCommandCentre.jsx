import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AdminLayout from '@/components/admin/AdminLayout';
import AdminConfirmDialog from '@/components/admin/AdminConfirmDialog';
import PWAInstallPrompt from '@/components/public/PWAInstallPrompt';
import { adminSearchAfterIntent, getAdminSectionFromPath, getAdminSectionPath } from '@/lib/adminNavigation';
import { UNSAVED_ADMIN_CHANGES_MESSAGE } from '@/lib/siteContentDraft';
import { AdminWorkspaceBoundary, WorkspaceSkeleton, retryableLazy as lazy } from '@/components/admin/AdminWorkspaceBoundary';

// Admin tools are independently code-split. Most staff sessions only need one
// operational surface at a time, so there is no reason to preload the rest.
const AdminToday = lazy(() => import('@/components/admin/AdminToday'));
const LeadTable = lazy(() => import('@/components/admin/LeadTable'));
const ClassCalendarAdmin = lazy(() => import('@/components/admin/ClassCalendarAdmin'));
const StaffRosterWorkspace = lazy(() => import('@/components/admin/staffRoster/StaffRosterWorkspace'));
const WorkoutManager = lazy(() => import('@/components/admin/WorkoutManager'));
const BookingRequestsTable = lazy(() => import('@/components/admin/BookingRequestsTable'));
const PTRequestsTable = lazy(() => import('@/components/admin/PTRequestsTable'));
const PTBookingAdmin = lazy(() => import('@/components/admin/PTBookingAdmin'));
const AvailabilityManager = lazy(() => import('@/components/admin/AvailabilityManager'));
const SoftLaunchSettings = lazy(() => import('@/components/admin/SoftLaunchSettings'));
const CampaignStats = lazy(() => import('@/components/admin/CampaignStats'));
const CoachesManager = lazy(() => import('@/components/admin/CoachesManager'));
const EventsManager = lazy(() => import('@/components/admin/EventsManager'));
const MembersManager = lazy(() => import('@/components/admin/MembersManager'));
const OrdersManager = lazy(() => import('@/components/admin/OrdersManager'));
const ProductsManager = lazy(() => import('@/components/admin/ProductsManager'));
const ContentManager = lazy(() => import('@/components/admin/ContentManager'));
const OperationsHealth = lazy(() => import('@/components/admin/OperationsHealth'));
const FitboxHub = lazy(() => import('@/components/admin/FitboxHub'));
const AdminAuditLog = lazy(() => import('@/components/admin/AdminAuditLog'));
const AnnouncementsManager = lazy(() => import('@/components/admin/AnnouncementsManager'));
const SmsManager = lazy(() => import('@/components/admin/SmsManager'));
const EmailManager = lazy(() => import('@/components/admin/EmailManager'));
const FormsSurveysManager = lazy(() => import('@/components/admin/FormsSurveysManager'));

export default function AdminCommandCentre() {
  const location = useLocation();
  const navigate = useNavigate();
  const routeSection = getAdminSectionFromPath(location.pathname);
  const [section, setActiveSection] = useState(routeSection);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState(null);
  const canonicalPath = getAdminSectionPath(section);
  const intent = new URLSearchParams(location.search);
  const acceptedPath = useRef(`${location.pathname}${location.search}`);

  useEffect(() => {
    if (routeSection === section) {
      acceptedPath.current = `${canonicalPath}${location.search}`;
      if (location.pathname !== canonicalPath) navigate(acceptedPath.current, { replace: true });
      return;
    }
    if (hasUnsavedChanges) {
      const requestedPath = `${location.pathname}${location.search}`;
      setPendingNavigation(current => current || { kind: 'section', section: routeSection, path: requestedPath });
      navigate(acceptedPath.current, { replace: true });
      return;
    }
    setActiveSection(routeSection);
  }, [canonicalPath, hasUnsavedChanges, location.pathname, location.search, navigate, routeSection, section]);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeUnload = event => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);

  const setSection = useCallback((nextSection, params) => {
    const nextPath = getAdminSectionPath(nextSection, params);
    if (nextSection === section) {
      const currentPath = `${location.pathname}${location.search}`;
      if (hasUnsavedChanges && nextPath !== currentPath) {
        setPendingNavigation({
          kind: 'section',
          section: nextSection,
          path: nextPath,
        });
        return false;
      }
      navigate(nextPath);
      return true;
    }
    if (hasUnsavedChanges) {
      setPendingNavigation({
        kind: 'section',
        section: nextSection,
        path: nextPath,
      });
      return false;
    }
    setHasUnsavedChanges(false);
    setActiveSection(nextSection);
    navigate(nextPath);
    return true;
  }, [hasUnsavedChanges, location.pathname, location.search, navigate, section]);

  const confirmLeaveAdmin = useCallback(action => {
    if (!hasUnsavedChanges) return true;
    setPendingNavigation({ kind: 'leave', action });
    return false;
  }, [hasUnsavedChanges]);

  const discardAndContinue = useCallback(() => {
    const pending = pendingNavigation;
    setPendingNavigation(null);
    setHasUnsavedChanges(false);
    if (pending?.kind === 'section') {
      setActiveSection(pending.section);
      navigate(pending.path);
    } else if (pending?.kind === 'leave') {
      pending.action?.();
    }
    return true;
  }, [navigate, pendingNavigation]);

  const consumeIntent = useCallback(() => {
    const search = adminSearchAfterIntent(location.search, section);
    navigate({ pathname: canonicalPath, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, state: location.state });
  }, [canonicalPath, location.hash, location.search, location.state, navigate, section]);

  const renderSection = () => {
    switch (section) {
      case 'overview': return <AdminToday onNavigate={setSection} />;
      case 'health': return <OperationsHealth onNavigate={setSection} />;
      case 'fitbox': return <FitboxHub initialTab={intent.get('tab') || 'overview'} />;
      case 'audit': return <AdminAuditLog />;
      // key remounts the shared table per section so filters/selection don't bleed between lead types
      case 'members': return <LeadTable key={section} type="member" onDirtyChange={setHasUnsavedChanges} />;
      case 'trainers': return <LeadTable key={section} type="trainer" onDirtyChange={setHasUnsavedChanges} />;
      case 'partners': return <LeadTable key={section} type="partner" onDirtyChange={setHasUnsavedChanges} />;
      case 'calendar': return <ClassCalendarAdmin initialAction={intent.get('action')} initialSessionId={intent.get('session')} onIntentHandled={consumeIntent} onDirtyChange={setHasUnsavedChanges} />;
      case 'roster': return <StaffRosterWorkspace />;
      case 'workouts': return <WorkoutManager onDirtyChange={setHasUnsavedChanges} />;
      case 'coaches': return <CoachesManager initialAction={intent.get('action')} onIntentHandled={consumeIntent} onDirtyChange={setHasUnsavedChanges} />;
      case 'events': return <EventsManager initialAction={intent.get('action')} onIntentHandled={consumeIntent} onDirtyChange={setHasUnsavedChanges} />;
      case 'gym-members': return <MembersManager initialMemberId={intent.get('member')} onIntentHandled={consumeIntent} onDirtyChange={setHasUnsavedChanges} />;
      case 'orders': return <OrdersManager />;
      case 'products': return <ProductsManager initialAction={intent.get('action')} onIntentHandled={consumeIntent} onDirtyChange={setHasUnsavedChanges} />;
      case 'content': return <ContentManager onDirtyChange={setHasUnsavedChanges} />;
      case 'bookings': return <BookingRequestsTable />;
      case 'pt-requests': return <><div className="px-4 pt-5 sm:px-8 sm:pt-7 mx-auto w-full max-w-6xl"><PTBookingAdmin /></div><PTRequestsTable /></>;
      case 'availability': return <AvailabilityManager />;
      case 'forms': return <FormsSurveysManager initialAction={intent.get('action')} onIntentHandled={consumeIntent} onDirtyChange={setHasUnsavedChanges} />;
      case 'announcements': return <AnnouncementsManager initialAction={intent.get('action')} onIntentHandled={consumeIntent} onDirtyChange={setHasUnsavedChanges} />;
      case 'sms': return <SmsManager />;
      case 'emails': return <EmailManager initialTab={intent.get('tab') || 'send'} />;
      case 'settings': return <SoftLaunchSettings onDirtyChange={setHasUnsavedChanges} />;
      case 'campaigns': return <CampaignStats />;
      default: return <AdminToday onNavigate={setSection} />;
    }
  };

  return (
    <>
      <AdminLayout activeSection={section} onSectionChange={setSection} hasUnsavedChanges={hasUnsavedChanges} onConfirmLeave={confirmLeaveAdmin}>
        <AdminWorkspaceBoundary key={section} onReload={() => { if (confirmLeaveAdmin(() => window.location.reload())) window.location.reload(); }}>
        <Suspense fallback={<WorkspaceSkeleton section={section} />}>
          {renderSection()}
        </Suspense>
        </AdminWorkspaceBoundary>
      </AdminLayout>
      <AdminConfirmDialog
        open={Boolean(pendingNavigation)}
        onOpenChange={open => !open && setPendingNavigation(null)}
        title="Discard unsaved changes?"
        description={UNSAVED_ADMIN_CHANGES_MESSAGE}
        warning="Edits made since the last save will be permanently discarded."
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onConfirm={discardAndContinue}
      />
      <PWAInstallPrompt context="owner" />
    </>
  );
}
