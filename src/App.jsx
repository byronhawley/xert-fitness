import React, { Suspense, lazy } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { SupabaseAuthProvider } from '@/lib/SupabaseAuthContext';
import AdminRoute from '@/components/admin/AdminRoute';
import ScrollToTop from './components/ScrollToTop';
import RouteMetadata from './lib/RouteMetadata';
import AppUpdatePrompt from '@/components/public/AppUpdatePrompt';

// Routes load on demand, keeping the initial public visit lightweight.
const Home = lazy(() => import('./pages/Home'));
const ThankYou = lazy(() => import('./pages/ThankYou'));
const TrainerInterest = lazy(() => import('./pages/TrainerInterest'));
const PartnerInterest = lazy(() => import('./pages/PartnerInterest'));
const SoftLaunchTimetable = lazy(() => import('./pages/SoftLaunchTimetable'));
const Memberships = lazy(() => import('./pages/Memberships'));
const ReleaseClassSpot = lazy(() => import('./pages/ReleaseClassSpot'));
const AdminCommandCentre = lazy(() => import('./pages/AdminCommandCentre'));
// Dev-only owner shell preview with fixture data; never routed in production builds.
const AdminPreview = import.meta.env.DEV ? lazy(() => import('./pages/AdminPreview')) : null;
const About = lazy(() => import('./pages/About'));
const Contact = lazy(() => import('./pages/Contact'));
const TrainingGuide = lazy(() => import('./pages/TrainingGuide'));
const Coaches = lazy(() => import('./pages/Coaches'));
const Events = lazy(() => import('./pages/Events'));
const Booking = lazy(() => import('./pages/Booking'));
const Account = lazy(() => import('./pages/Account'));
const Coaching = lazy(() => import('./pages/Coaching'));
const CoachInvite = lazy(() => import('./pages/CoachInvite'));
const PTBooking = lazy(() => import('./pages/PTBooking'));
const PTBookingManage = lazy(() => import('./pages/PTBookingManage'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Terms = lazy(() => import('./pages/Terms'));
const CasualVisit = lazy(() => import('./pages/CasualVisit'));
const AppLanding = lazy(() => import('./pages/AppLanding'));
const WorkoutDisplay = lazy(() => import('./pages/WorkoutDisplay'));
const CheckoutReturn = lazy(() => import('./pages/CheckoutReturn'));
const NativeTaskBridge = lazy(() => import('./pages/NativeTaskBridge'));
const PublicForm = lazy(() => import('./pages/PublicForm'));

function RouteLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-xert-navy" role="status" aria-label="Loading page">
      <span className="w-7 h-7 border-2 border-xert-steel/30 border-t-xert-steel rounded-full animate-spin" />
    </div>
  );
}

const AppRoutes = () => (
    <Suspense fallback={<RouteLoader />}>
      <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/thank-you" element={<ThankYou />} />
      <Route path="/trainer-interest" element={<TrainerInterest />} />
      <Route path="/partner-interest" element={<PartnerInterest />} />
      <Route path="/timetable" element={<SoftLaunchTimetable />} />
      <Route path="/timetable/release" element={<ReleaseClassSpot />} />
      <Route path="/about" element={<About />} />
      <Route path="/coaches" element={<Coaches />} />
      <Route path="/events" element={<Events />} />
      <Route path="/booking" element={<Booking />} />
      <Route path="/account" element={<Account />} />
      <Route path="/coaching" element={<Coaching />} />
      {/* Coach invite links: the token is in the #fragment, never sent to a server. */}
      <Route path="/coach-invite" element={<CoachInvite />} />
      <Route path="/pt" element={<PTBooking />} />
      <Route path="/pt/booking" element={<PTBookingManage />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/app" element={<AppLanding />} />
      {/* Club TV kiosk. Public because a television cannot sign in; only
          published workouts are readable, and the page is kept out of search. */}
      <Route path="/display" element={<WorkoutDisplay />} />
      <Route path="/checkout-return" element={<CheckoutReturn />} />
      <Route path="/open/*" element={<NativeTaskBridge />} />
      {/* The agreement moved onto /terms; anything already pointing here still lands. */}
      <Route path="/membership-terms" element={<Navigate to="/terms" replace />} />
      <Route path="/memberships" element={<Memberships />} />
      {/* People say "passes" as often as "memberships"; both land in one place. */}
      <Route path="/passes" element={<Navigate to="/memberships" replace />} />
      <Route path="/casual" element={<CasualVisit key="casual" />} />
      <Route path="/3daypass" element={<CasualVisit key="three-day-pass" threeDayPass />} />
      <Route path="/3months" element={<CasualVisit key="three-month-membership" threeMonth />} />
      <Route path="/forms/:slug" element={<PublicForm />} />
      <Route path="/contact" element={<Contact />} />
      <Route path="/training-guide" element={<TrainingGuide />} />
      {/* ADMIN — requires a signed-in user whose profiles.role = 'admin'.
          Promote an admin with the SQL noted in src/supabase/booking_schema.sql. */}
      {AdminPreview && <Route path="/admin/__preview" element={<AdminPreview />} />}
      <Route path="/admin" element={<AdminRoute><AdminCommandCentre /></AdminRoute>} />
      <Route path="/admin/*" element={<AdminRoute><AdminCommandCentre /></AdminRoute>} />
      <Route path="*" element={<PageNotFound />} />
      </Routes>
    </Suspense>
);

function App() {
  return (
    <SupabaseAuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <RouteMetadata />
          <AppRoutes />
        </Router>
        <Toaster />
        {/* A deployed fix is no use to somebody still running the old build. */}
        <AppUpdatePrompt />
      </QueryClientProvider>
    </SupabaseAuthProvider>
  );
}

export default App;
