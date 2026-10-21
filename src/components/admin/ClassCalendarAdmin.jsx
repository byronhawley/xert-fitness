import React, { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { SessionEditor, RepeatModal } from './ClassCalendarEditors';
import WaitlistDesk from './ClassCalendarWaitlist';
import { calendarListWithSelectedSession } from './calendarModel.mjs';
import './calendar.css';
import { kitTokens } from './ui/kitTokens.mjs';
import { AlertTriangle, BellRing, CheckCheck, ClipboardCheck, Copy, Download, LoaderCircle, Search, Mail, Phone, RotateCcw, UserCheck } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import { getClassSessions, staffAddWalkIn, createClassSession, cancelClassSession, notifyClassCancellation, duplicateClassSession, getClassBookings, updateBookingStatus, adminSessionRoster, adminClassCapacity, adminWaitlistOverview, adminSetBookingStatus, adminPromoteNextWaitlisted, adminRecordSessionAttendance, adminSearchMembers, staffBookMemberIntoClass, searchClassAttendees, getBlackoutPeriods, getClassTemplates, createClassTemplate, getSoftLaunchSettings } from '@/lib/adminData';
import { downloadCsv } from '@/lib/csv';
import { blackoutsOverlappingSession } from '@/lib/scheduling';
import { classSessionFromTemplate, classSessionSeedForDate, classTemplateFromSession } from '@/lib/classCalendar';
import { attendeeMatchesByPerson, summarizeAttendeeSearch } from '@/lib/classAttendeeSearch';
import { gymDateKey, gymDateTimeLabel, gymDayLabel, gymTimeLabel } from '@/lib/gymTime';
import { buildClassCancellationMailto, buildClassCancellationMessage, collectClassCancellationContacts } from '@/lib/classCommunications';
import { attendanceRoll, attendanceRowId, blankAttendanceDraft, createAttendanceDraft, markAllAttendance, summarizeAttendanceDraft } from '@/lib/attendanceDraft';
import AdminConfirmDialog from '@/components/admin/AdminConfirmDialog';
import ClassCalendarBoard from '@/components/admin/ClassCalendarBoard';
import ClassBankManager from '@/components/admin/ClassBankManager';
import { ADMIN_BUTTON, ADMIN_INPUT, ADMIN_PANEL, ADMIN_TEXT, AdminPageHeader, AdminFilterBar, AdminSegmented, AdminBadge, AdminSkeleton, AdminEmptyState, AdminDrawer } from '@/components/admin/ui';

const CLASS_TYPES = ['XERT Foundation', 'XERT Strength', 'XERT Engine', 'XERT Hybrid', 'XERT Event Prep', 'XERT Team'];
const BOOKING_STATUSES = ['requested', 'confirmed', 'waitlisted', 'cancelled', 'declined', 'attended', 'no_show'];

function rosterStatusOptions(status, sessionStatus, hasWaitlist = false) {
  // A class marked full is still a live class: its roster is exactly the one
  // most likely to need a cancellation or a waitlist promotion.
  if (!['published', 'full'].includes(sessionStatus)) return [status];
  if (status === 'requested') return ['requested', 'confirmed', 'waitlisted', 'declined', 'cancelled'];
  // Promoting the head of the queue is the whole point of a waitlist, and it
  // was the one thing the roster would not let staff do from here.
  if (status === 'waitlisted') return ['waitlisted', 'confirmed', 'declined', 'cancelled'];
  if (['declined', 'cancelled'].includes(status)) {
    if (hasWaitlist) return [status];
    return [status, 'requested', 'confirmed'];
  }
  return ['confirmed', 'attended', 'no_show', 'cancelled'];
}

function rosterExportFilename(session) {
  const className = (session.title || 'class')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  // slice(0, 10) on a UTC timestamp files the 6am class under the previous day.
  const date = gymDateKey(session.start_time) || 'undated';
  return `xert-roster-${className || 'class'}-${date}.csv`;
}

function CancellationFollowUpDialog({ followUp, onClose }) {
  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(followUp.message.body);
      toast({ title: 'Cancellation message copied' });
    } catch {
      toast({ title: 'Could not copy the message', description: 'Select the message text and copy it manually.', variant: 'destructive' });
    }
  };

  return (
    <AdminDrawer open onOpenChange={open => { if (!open) onClose(); }} title="Notify affected members" closeLabel="Close cancellation follow-up"
      description={`${followUp.affectedBookings} active ${followUp.affectedBookings === 1 ? 'booking was' : 'bookings were'} cancelled and refunded.`}>
        <div className="calendar-dialog-content">

          {followUp.notification ? (
            <div className="mb-4 flex gap-3 border border-xert-steel/30 bg-xert-steel/10 p-3">
              <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-xert-steel" aria-hidden="true" />
              <div>
                <p className="font-body text-xs font-semibold text-xert-offwhite">
                  Private in-app notice created for {followUp.notification.recipients} member {followUp.notification.recipients === 1 ? 'account' : 'accounts'}.
                </p>
                <p className="mt-1 font-body text-xs leading-relaxed text-xert-concrete/65">
                  {followUp.notification.push?.delivered > 0
                    ? `${followUp.notification.push.delivered} Apple push ${followUp.notification.push.delivered === 1 ? 'notification was' : 'notifications were'} delivered.`
                    : followUp.notification.push?.configured === false
                      ? 'The notice is available in XERT, but Apple push delivery is not configured. Use the contact fallback below.'
                      : followUp.notification.push?.attempted > 0
                        ? 'Apple push delivery was attempted but did not reach a registered device. Use the contact fallback below.'
                        : 'No enabled Apple device was registered. The notice remains available when the member opens XERT.'}
                </p>
              </div>
            </div>
          ) : followUp.notificationError ? (
            <p role="alert" className="mb-4 border border-xert-orange/30 bg-xert-orange/10 p-3 font-body text-xs leading-relaxed text-xert-concrete/80">
              {followUp.notificationError} Use the contact fallback below so no affected member is missed.
            </p>
          ) : null}
          {followUp.contactLookupIncomplete && (
            <p role="alert" className="mb-4 border border-xert-orange/30 bg-xert-orange/10 p-3 font-body text-xs leading-relaxed text-xert-concrete/80">
              One booking source could not be checked. Review the class bookings queue before considering follow-up complete.
            </p>
          )}
          {followUp.contacts.length === 0 ? (
            <p className="mb-5 font-body text-sm text-xert-concrete/60">No email address or mobile number was available for the affected bookings.</p>
          ) : (
            <div className="mb-5 space-y-2" aria-label="Affected member contacts">
              {followUp.contacts.map(contact => (
                <div key={`${contact.email}:${contact.phoneDialable}`} className="flex flex-wrap items-center justify-between gap-3 border border-xert-steel/15 bg-xert-charcoal p-3">
                  <div className="min-w-0">
                    <p className="break-words font-body text-sm text-xert-offwhite">{contact.name || contact.email || contact.phone}</p>
                    <p className="break-words font-body text-xs text-xert-concrete/50">{[contact.email, contact.phone].filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {contact.email && <a href={`mailto:${contact.email}`} aria-label={`Email ${contact.name || contact.email}`} title="Email member" className="inline-flex min-h-11 min-w-11 items-center justify-center text-xert-steel"><Mail className="h-4 w-4" /></a>}
                    {contact.phoneDialable && <a href={`tel:${contact.phoneDialable}`} aria-label={`Call ${contact.name || contact.phone}`} title="Call member" className="inline-flex min-h-11 min-w-11 items-center justify-center text-xert-steel"><Phone className="h-4 w-4" /></a>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <label htmlFor="cancellation-message" className="block font-body text-xs uppercase tracking-wider text-xert-concrete/50">Ready-to-send message</label>
          <textarea id="cancellation-message" readOnly value={followUp.message.body} rows={9}
            className="mt-2 w-full resize-y border border-xert-steel/25 bg-xert-charcoal p-3 font-body text-sm leading-relaxed text-xert-offwhite focus:outline-none focus:border-xert-steel" />
          {followUp.mailto.omittedCount > 0 && (
            <p className="mt-2 font-body text-xs text-xert-orange">{followUp.mailto.omittedCount} additional email recipients were omitted from the bounded BCC link. Contact them individually.</p>
          )}
        </div>

        <div className="calendar-dialog-actions">
          <button type="button" onClick={onClose} className="min-h-11 border border-xert-steel/40 px-5 font-display text-xs uppercase text-xert-concrete/70">Done</button>
          <button type="button" onClick={copyMessage} className="inline-flex min-h-11 items-center justify-center gap-2 border border-xert-steel/40 px-5 font-display text-xs uppercase text-xert-steel">
            <Copy className="h-4 w-4" /> Copy message
          </button>
          {followUp.mailto.url && (
            <a href={followUp.mailto.url} className="inline-flex min-h-11 items-center justify-center gap-2 bg-xert-steel px-5 font-display text-xs uppercase text-xert-navy">
              <Mail className="h-4 w-4" /> Email {followUp.mailto.recipientCount} via BCC
            </a>
          )}
        </div>
    </AdminDrawer>
  );
}

export default function ClassCalendarAdmin({ initialAction, initialSessionId, onIntentHandled, onDirtyChange }) {
  const location = useLocation();
  const calendarParams = new URLSearchParams(location.search);
  const calendarSearch = (calendarParams.get('calendarSearch') || '').trim().toLowerCase();
  const calendarType = calendarParams.get('calendarType') || '';
  const matchesSearch = session => (!calendarType || !CLASS_TYPES.includes(calendarType) || session.class_type === calendarType)
    && (!calendarSearch || [session.title, session.class_type, session.coach_name].filter(Boolean).join(' ').toLowerCase().includes(calendarSearch));
  const [sessions, setSessions] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingSession, setEditingSession] = useState(null);
  const [expandedBookings, setExpandedBookings] = useState(null);
  const [attendeeQuery, setAttendeeQuery] = useState('');
  const [attendeeMatches, setAttendeeMatches] = useState(null);
  const [attendeeSearching, setAttendeeSearching] = useState(false);
  const [attendeeError, setAttendeeError] = useState('');
  const [bookings, setBookings] = useState([]);
  const [roster, setRoster] = useState([]);
  const [attendeeSearch, setAttendeeSearch] = useState('');
  const [attendeeResults, setAttendeeResults] = useState([]);
  const [addingAttendeeId, setAddingAttendeeId] = useState('');
  const [walkIn, setWalkIn] = useState(null);
  const [walkInBusy, setWalkInBusy] = useState(false);
  const [boardRosterSessionId, setBoardRosterSessionId] = useState(null);
  const [boardRosterLoading, setBoardRosterLoading] = useState(false);
  const [allSignups, setAllSignups] = useState([]);
  const [capacityById, setCapacityById] = useState({});
  const [bookingsEnabled, setBookingsEnabled] = useState(null);
  const [waitlistOverview, setWaitlistOverview] = useState([]);
  const [waitlistOverviewAvailable, setWaitlistOverviewAvailable] = useState(true);
  const [waitlistOverviewError, setWaitlistOverviewError] = useState('');
  const [waitlistOverviewLoading, setWaitlistOverviewLoading] = useState(true);
  const [blackouts, setBlackouts] = useState([]);
  const [repeating, setRepeating] = useState(null);
  const [timeFilter, setTimeFilter] = useState('upcoming');
  const [showCancelled, setShowCancelled] = useState(false);
  const [updatingBookingId, setUpdatingBookingId] = useState(null);
  const [promotingSessionId, setPromotingSessionId] = useState(null);
  const [promotionCandidate, setPromotionCandidate] = useState(null);
  const [sessionToCancel, setSessionToCancel] = useState(null);
  const [isCancellingSession, setIsCancellingSession] = useState(false);
  const [cancellationFollowUp, setCancellationFollowUp] = useState(null);
  const [duplicatingSessionId, setDuplicatingSessionId] = useState(null);
  const [attendanceSession, setAttendanceSession] = useState(null);
  const [attendanceDraft, setAttendanceDraft] = useState({});
  const [isSavingAttendance, setIsSavingAttendance] = useState(false);
  const [view, setView] = useState('calendar');
  const [templates, setTemplates] = useState([]);
  const [templatesAvailable, setTemplatesAvailable] = useState(true);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [showBankManager, setShowBankManager] = useState(false);
  const [savingToBankId, setSavingToBankId] = useState(null);

  const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const result = await getClassTemplates();
      setTemplates(result.rows);
      setTemplatesAvailable(result.available);
    } catch (error) {
      setTemplates([]);
      toast({ title: 'Could not load the class bank', description: error.message, variant: 'destructive' });
    } finally {
      setTemplatesLoading(false);
    }
  };

  const refreshWaitlistOverview = async () => {
    setWaitlistOverviewLoading(true);
    setWaitlistOverviewError('');
    try {
      const result = await adminWaitlistOverview(20);
      setWaitlistOverview(result.rows);
      setWaitlistOverviewAvailable(result.available);
    } catch (error) {
      setWaitlistOverview([]);
      setWaitlistOverviewAvailable(true);
      setWaitlistOverviewError(error.message || 'Check the waitlist overview permissions.');
    } finally {
      setWaitlistOverviewLoading(false);
    }
  };

  // How full each class is, at a glance on the calendar. The database counts
  // both doors into the room; this only falls back to counting public sign-ups
  // alone on an installation that has not taken the capacity migration, where
  // it is still better than nothing.
  const signupCounts = useMemo(() => {
    const byId = {};
    for (const signup of allSignups) {
      const key = signup?.class_session_id;
      if (!key) continue;
      if (!byId[key]) byId[key] = { taken: 0, pending: 0, waiting: 0, spotsLeft: null };
      if (signup.status === 'confirmed') byId[key].taken += 1;
      else if (signup.status === 'requested') byId[key].pending += 1;
      else if (signup.status === 'waitlisted') byId[key].waiting += 1;
    }
    for (const [key, row] of Object.entries(capacityById)) {
      byId[key] = {
        taken: row.taken,
        pending: row.pending,
        waiting: row.waiting,
        spotsLeft: row.spotsLeft,
      };
    }
    return byId;
  }, [allSignups, capacityById]);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [loadedSessions, loadedBlackouts, loadedSignups, loadedCapacity, loadedSettings] = await Promise.all([
        getClassSessions(false),
        getBlackoutPeriods().catch(error => {
          toast({ title: 'Blackout checks unavailable', description: error.message, variant: 'destructive' });
          return [];
        }),
        // Sign-up counts for every class, so the calendar can show how full
        // each one is without opening it. Counts are a convenience; a failure
        // must not stop the timetable loading.
        getClassBookings().catch(() => []),
        // The database's own count of how full each class is, across member
        // bookings and public sign-ups alike.
        adminClassCapacity().catch(() => ({ byId: {} })),
        // The switch that decides whether anyone can actually take a spot. It
        // lives on another screen entirely, so a calendar full of published
        // classes gave no hint that every one of them said "Register interest".
        getSoftLaunchSettings().catch(() => null),
        refreshWaitlistOverview(),
        loadTemplates(),
      ]);
      setSessions(loadedSessions);
      setBlackouts(loadedBlackouts);
      setAllSignups(loadedSignups);
      setCapacityById(loadedCapacity?.byId || {});
      if (loadedSettings) setBookingsEnabled(loadedSettings.bookings_enabled === true);
    } catch (error) {
      setLoadError(error.message || 'Please retry loading the calendar.');
      toast({ title: 'Could not load class sessions', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (initialAction !== 'create') return;
    setEditingSession(null);
    setShowEditor(true);
    onIntentHandled?.();
  }, [initialAction, onIntentHandled]);

  const refreshBookings = async (sessionId) => {
    const [requests, members] = await Promise.all([
      getClassBookings({ class_session_id: sessionId }),
      adminSessionRoster(sessionId).catch(() => []),
    ]);
    setBookings(requests);
    setRoster(members);
    return { requests, members };
  };

  useEffect(() => {
    if (loading || !initialSessionId || !['roster', 'attendance'].includes(initialAction)) return;
    const target = sessions.find(session => session.id === initialSessionId);
    if (!target) {
      toast({ title: 'Class not found', description: 'That class is no longer available in the calendar.', variant: 'destructive' });
      onIntentHandled?.();
      return;
    }

    let active = true;
    const openIntent = async () => {
      try {
        const { members, requests } = await refreshBookings(target.id);
        if (!active) return;
        setView('list');
        setTimeFilter(new Date(target.start_time).getTime() < Date.now() ? 'past' : 'upcoming');
        setExpandedBookings(target.id);
        if (initialAction === 'attendance') {
          // Everyone in the room, not just the credit members — otherwise Today
          // offers a Roll call button for a class the timetable filled and this
          // answers "Roll call is not ready" for the very people in it.
          const roll = attendanceRoll(members, requests);
          const eligible = roll.some(person => ['confirmed', 'attended', 'no_show'].includes(person.status));
          if (new Date(target.start_time).getTime() <= Date.now() && eligible) {
            setAttendanceDraft(createAttendanceDraft(roll));
            setAttendanceSession(target);
          } else {
            toast({ title: 'Roll call is not ready', description: 'The roster is open so you can review this class.' });
          }
        }
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          document.getElementById(`class-session-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }));
      } catch (error) {
        if (active) toast({ title: 'Could not load class roster', description: error.message, variant: 'destructive' });
      } finally {
        if (active) onIntentHandled?.();
      }
    };
    void openIntent();
    return () => { active = false; };
  }, [initialAction, initialSessionId, loading, onIntentHandled, sessions]);

  const loadBookings = async (sessionId) => {
    if (expandedBookings === sessionId) {
      setExpandedBookings(null);
      setBookings([]);
      setRoster([]);
      return;
    }
    try {
      await refreshBookings(sessionId);
      setExpandedBookings(sessionId);
    } catch (e) {
      toast({ title: 'Could not load class bookings', description: e.message, variant: 'destructive' });
    }
  };

  // Searching the whole timetable for one person. Debounced so typing a name
  // is one query rather than one per keystroke, and the last answer wins even
  // if an earlier query comes back slower.
  useEffect(() => {
    const term = attendeeQuery.trim();
    setAttendeeMatches(null);
    setAttendeeError('');
    if (term.length < 2) { setAttendeeMatches(null); setAttendeeSearching(false); return undefined; }
    let active = true;
    setAttendeeSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchClassAttendees(term);
        if (active) setAttendeeMatches(attendeeMatchesByPerson(rows));
      } catch (error) {
        if (active) {
          setAttendeeError(error.message || 'Please try searching again.');
        }
      } finally {
        if (active) setAttendeeSearching(false);
      }
    }, kitTokens['filter.debounce']);
    return () => { active = false; window.clearTimeout(timer); };
  }, [attendeeQuery]);

  const openWaitlistRoster = async (sessionId, { preservePeriod = false } = {}) => {
    setView('list');
    if (!preservePeriod) setTimeFilter('upcoming');
    try {
      await refreshBookings(sessionId);
      setExpandedBookings(sessionId);
      window.requestAnimationFrame(() => document.getElementById(`class-session-${sessionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (error) {
      toast({ title: 'Could not load class roster', description: error.message, variant: 'destructive' });
    }
  };

  // The roster is open either in the list view (expandedBookings) or in the
  // calendar view (boardRosterSessionId); status changes must work in both.
  const activeRosterSessionId = () => expandedBookings || boardRosterSessionId;

  // Front-desk booking: search the member directory, then book the chosen
  // member in. The database takes the credit and writes their private notice,
  // so a staff booking is a member booking made by somebody else.
  useEffect(() => {
    const term = attendeeSearch.trim();
    if (term.length < 2) { setAttendeeResults([]); return undefined; }
    let active = true;
    const timer = setTimeout(() => {
      adminSearchMembers(term)
        .then(found => { if (active) setAttendeeResults(found); })
        .catch(() => { if (active) setAttendeeResults([]); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [attendeeSearch]);

  // Somebody with no account, added by name as a sign-up on the class.
  const addWalkIn = async (event, session) => {
    event.preventDefault();
    setWalkInBusy(true);
    try {
      const result = await staffAddWalkIn(session.id, walkIn);
      toast({
        title: result?.status === 'waitlisted' ? 'Added to the waitlist' : 'Added to the class',
        description: `${result?.full_name || walkIn.fullName} is ${result?.status || 'added'} for ${session.title || 'this class'}.`,
      });
      setWalkIn(null);
      setAttendeeSearch('');
      setAttendeeResults([]);
      await refreshBookings(session.id);
    } catch (error) {
      toast({ title: 'Could not add them', description: error.message, variant: 'destructive' });
    } finally {
      setWalkInBusy(false);
    }
  };

  const addAttendee = async (session, member) => {
    setAddingAttendeeId(member.id);
    try {
      const receipt = await staffBookMemberIntoClass(session.id, member.id);
      toast({
        title: receipt.booking_status === 'waitlisted' ? 'Added to the waitlist' : 'Added to the class',
        description: receipt.warning
          || `${member.full_name || member.email} is ${receipt.booking_status} for ${session.title || 'this class'}. Their notice is in the member app.`,
        variant: receipt.warning ? 'destructive' : undefined,
      });
      setAttendeeSearch('');
      setAttendeeResults([]);
      // refreshBookings loads both the public sign-ups and the member roster.
      await refreshBookings(session.id);
    } catch (error) {
      toast({ title: 'Could not add that member', description: error.message, variant: 'destructive' });
    } finally {
      setAddingAttendeeId('');
    }
  };

  const handleRosterStatus = async (bookingId, status) => {
    const sessionId = activeRosterSessionId();
    if (!sessionId) {
      toast({ title: 'Open the class first', description: 'Open the class sign-ups, then change the status.', variant: 'destructive' });
      return;
    }
    const session = sessions.find(item => item.id === sessionId);
    if (!['published', 'full'].includes(session?.status)) {
      toast({ title: 'Class is not open for booking', description: 'Publish the class before reopening a member booking.', variant: 'destructive' });
      return;
    }
    setUpdatingBookingId(bookingId);
    try {
      const result = await adminSetBookingStatus(bookingId, status);
      await refreshBookings(sessionId);
      if (result?.notice_created) {
        toast({
          title: 'Booking updated and member notified',
          description: result.warning
            || (Number(result.push?.delivered || 0) > 0
              ? 'Their private notice is live and Apple push was delivered.'
              : 'Their private notice is live in their member account.'),
        });
      } else {
        toast({ title: 'Booking updated', description: `Now ${status.replace(/_/g, ' ')}.` });
      }
    } catch (e) {
      toast({ title: 'Update failed', description: e.message, variant: 'destructive' });
    } finally {
      setUpdatingBookingId(null);
    }
  };

  // The roster mixes both doors into the room. A member booking moves credits
  // and writes the member a private notice, a public sign-up does neither, so
  // the row's own source decides which database function is called. Sending a
  // member's booking id to the public one used to fail every time with
  // "A request record is required".
  const handleRosterPersonStatus = async (person, status) => {
    if (!person?.rowId) {
      toast({ title: 'Could not update that person', description: 'Reload the class sign-ups and try again.', variant: 'destructive' });
      return;
    }
    if (person.source === 'member') return handleRosterStatus(person.rowId, status);
    return handleBookingStatus(person.rowId, status);
  };

  const handlePromoteNext = async candidate => {
    if (promotingSessionId) return;
    setPromotingSessionId(candidate.session_id);
    try {
      const result = await adminPromoteNextWaitlisted(candidate.session_id, candidate.next_booking_id);
      await Promise.all([
        refreshWaitlistOverview(),
        ...(activeRosterSessionId() === candidate.session_id ? [refreshBookings(candidate.session_id)] : []),
      ]);
      const delivery = result.warning
        || (Number(result.push?.delivered || 0) > 0
          ? 'Their credit is reserved, their member notice is live, and Apple push was delivered.'
          : 'Their credit is reserved and a private notice is waiting in their member account.');
      toast({ title: 'Member promoted and notified', description: delivery });
    } catch (error) {
      toast({ title: 'Promotion paused', description: error.message, variant: 'destructive' });
    } finally {
      setPromotingSessionId(null);
      setPromotionCandidate(null);
    }
  };

  const handleDuplicate = async (session) => {
    if (duplicatingSessionId) return;
    setDuplicatingSessionId(session.id);
    try {
      await duplicateClassSession(session);
      await load();
    } catch (e) { toast({ title: 'Duplicate failed', description: e.message, variant: 'destructive' }); }
    finally { setDuplicatingSessionId(null); }
  };

  // Opens the sign-up list in place, so managing attendees never costs the
  // owner their position in the calendar.
  const openRosterFromBoard = async session => {
    if (boardRosterSessionId === session.id) {
      setBoardRosterSessionId(null);
      return;
    }
    setBoardRosterSessionId(session.id);
    setBoardRosterLoading(true);
    try {
      await refreshBookings(session.id);
    } catch (error) {
      toast({ title: 'Could not load class sign-ups', description: error.message, variant: 'destructive' });
      setBoardRosterSessionId(null);
    } finally {
      setBoardRosterLoading(false);
    }
  };

  const handleQuickAdd = async (template, dayKey, options) => {
    try {
      const created = await createClassSession(classSessionFromTemplate(template, dayKey, options));
      toast({
        title: options?.publish ? 'Class published to the timetable' : 'Draft class added',
        description: `${created.title} · ${new Date(created.start_time).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      });
      await load();
    } catch (error) {
      toast({ title: 'Could not add class', description: error.message, variant: 'destructive' });
    }
  };

  const handleCreateCustomForDay = dayKey => {
    setEditingSession(classSessionSeedForDate(dayKey));
    setShowEditor(true);
  };

  const handleSaveToBank = async session => {
    if (savingToBankId) return;
    setSavingToBankId(session.id);
    try {
      const template = await createClassTemplate(classTemplateFromSession(session));
      toast({ title: 'Saved to class bank', description: `${template.name} can now be dropped onto any date in one tap.` });
      await loadTemplates();
    } catch (error) {
      toast({ title: 'Could not save to the bank', description: error.message, variant: 'destructive' });
    } finally {
      setSavingToBankId(null);
    }
  };

  const handleCancel = async () => {
    const session = sessionToCancel;
    if (!session) return;
    setIsCancellingSession(true);
    try {
      const contactResults = await Promise.allSettled([
        adminSessionRoster(session.id),
        getClassBookings({ class_session_id: session.id }),
      ]);
      const contacts = collectClassCancellationContacts(
        contactResults[0].status === 'fulfilled' ? contactResults[0].value : [],
        contactResults[1].status === 'fulfilled' ? contactResults[1].value : []
      );
      const message = buildClassCancellationMessage(session);
      const affectedBookings = await cancelClassSession(session.id);
      if (affectedBookings > 0) {
        let notification = null;
        let notificationError = '';
        try {
          notification = await notifyClassCancellation(session.id);
        } catch (error) {
          notificationError = error.message || 'Push delivery status could not be confirmed.';
        }
        setCancellationFollowUp({
          session,
          affectedBookings,
          contacts,
          message,
          mailto: buildClassCancellationMailto(contacts, message.subject, message.body),
          contactLookupIncomplete: contactResults.some(result => result.status === 'rejected'),
          notification,
          notificationError,
        });
      }
      const noun = affectedBookings === 1 ? 'booking' : 'bookings';
      toast({
        title: 'Class cancelled',
        description: affectedBookings
          ? `${affectedBookings} ${noun} cancelled. Reserved member credits were returned.`
          : 'No active bookings needed to be cancelled.',
      });
      if (expandedBookings === session.id) {
        setExpandedBookings(null);
        setBookings([]);
        setRoster([]);
      }
      setSessionToCancel(null);
      setShowCancelled(false);
      await load();
    } catch (e) {
      toast({ title: 'Cancel failed', description: e.message, variant: 'destructive' });
    } finally {
      setIsCancellingSession(false);
    }
  };

  const handleBookingStatus = async (id, status) => {
    const sessionId = activeRosterSessionId();
    if (!sessionId) {
      toast({ title: 'Open the class first', description: 'Open the class sign-ups, then change the status.', variant: 'destructive' });
      return;
    }
    setUpdatingBookingId(id);
    try {
      await updateBookingStatus(id, status);
      await refreshBookings(sessionId);
      toast({ title: 'Request updated', description: `Now ${status.replace(/_/g, ' ')}.` });
    } catch (e) {
      toast({ title: 'Update failed', description: e.message, variant: 'destructive' });
    } finally {
      setUpdatingBookingId(null);
    }
  };

  // The door list. It used to carry credit members only, so for an instant_book
  // class — the live soft-launch path — it was empty and the button was greyed
  // out, and for a mixed class the owner walked onto the floor with half the
  // names. Times are the gym's, so the CSV reads the way the door does.
  const exportRoster = (session) => {
    const roll = attendanceRoll(roster, bookings);
    downloadCsv(
      rosterExportFilename(session),
      roll.map(person => ({
        class_title: session.title || 'XERT class',
        class_starts_at: gymDateTimeLabel(session.start_time),
        name: person.full_name || person.member_name || '',
        email: person.email || '',
        phone: person.phone || '',
        source: person.attendance_source === 'signup' ? 'Timetable sign-up' : 'Member credit',
        status: person.status,
        training_level: person.training_level || '',
        notes: person.notes || '',
        admin_notes: person.admin_notes || '',
        booked_at: gymDateTimeLabel(person.booked_at || person.created_at),
      })),
      [
        { key: 'class_title', label: 'Class' },
        { key: 'class_starts_at', label: 'Class starts' },
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Mobile' },
        { key: 'source', label: 'Booked through' },
        { key: 'status', label: 'Booking status' },
        { key: 'training_level', label: 'Training level' },
        { key: 'notes', label: 'Their note' },
        { key: 'admin_notes', label: 'Staff note' },
        { key: 'booked_at', label: 'Booked at' },
      ]
    );
  };

  const openAttendance = (session) => {
    setAttendanceDraft(createAttendanceDraft(attendanceRoll(roster, bookings)));
    setAttendanceSession(session);
  };

  const saveAttendance = async () => {
    if (!attendanceSession) return;
    const roll = attendanceRoll(roster, bookings);
    const summary = summarizeAttendanceDraft(roll, attendanceDraft);
    // Member requests only. Each one is holding a credit this roll call would
    // settle, so it genuinely blocks. A public enquiry holds nothing and can sit
    // at 'requested' for weeks by design — blocking on those would freeze a
    // class's attendance permanently, which is the exact trap the database was
    // repaired to remove. The two must agree.
    const pendingRequests = roll.filter(person => person.status === 'requested' && person.attendance_source === 'member');
    if (pendingRequests.length > 0) {
      toast({
        title: 'Resolve booking requests first',
        description: `Confirm or decline the ${pendingRequests.length} pending ${pendingRequests.length === 1 ? 'request' : 'requests'} before completing this class.`,
        variant: 'destructive',
      });
      return;
    }
    if (!summary.complete) {
      toast({
        title: 'Roll call is incomplete',
        description: `Mark the remaining ${summary.unmarked} ${summary.unmarked === 1 ? 'person' : 'people'} as present or no show.`,
        variant: 'destructive',
      });
      return;
    }
    setIsSavingAttendance(true);
    try {
      const updated = await adminRecordSessionAttendance(attendanceSession.id, summary.entries);
      toast({
        title: 'Attendance recorded',
        description: `${updated} ${updated === 1 ? 'person' : 'people'} marked and class completed.`,
      });
      setAttendanceSession(null);
      await refreshBookings(attendanceSession.id);
      await load();
    } catch (error) {
      toast({ title: 'Roll call failed', description: error.message, variant: 'destructive' });
    } finally {
      setIsSavingAttendance(false);
    }
  };

  const now = Date.now();
  const sessionsInTimeFilter = sessions.filter(s => {
    if (timeFilter === 'all') return true;
    const isPast = s.start_time && new Date(s.start_time).getTime() < now;
    return timeFilter === 'past' ? isPast : !isPast;
  });
  const cancelledInTimeFilter = sessionsInTimeFilter.filter(s => s.status === 'cancelled');
  const activeSessions = sessions.filter(s => s.status !== 'cancelled');
  const filtered = sessionsInTimeFilter.filter(s => (showCancelled || s.status !== 'cancelled') && matchesSearch(s));
  const { rows: visibleListSessions, selectedOutsideFilters } = calendarListWithSelectedSession(filtered, sessions, expandedBookings);
  const visibleCalendarSessions = sessions.filter(s => (showCancelled || s.status !== 'cancelled') && matchesSearch(s));
  const upcomingCount = activeSessions.filter(s => !s.start_time || new Date(s.start_time).getTime() >= now).length;
  const pastCount = activeSessions.length - upcomingCount;
  const cancelledCount = view === 'calendar'
    ? sessions.filter(s => s.status === 'cancelled').length
    : cancelledInTimeFilter.length;
  // Everyone in the room, not just the credit members. A class filled through
  // the public timetable had no roll call at all before this.
  const classRoll = attendanceRoll(roster, bookings);
  const attendanceSummary = summarizeAttendanceDraft(classRoll, attendanceDraft);
  const pendingAttendanceRequests = classRoll.filter(person => person.status === 'requested' && person.attendance_source === 'member');

  return (
    <div className="calendar-workspace admin-kit-container">
      <AdminPageHeader eyebrow="Scheduling" title="Class Calendar" description="Plan classes, review who is coming and keep the next place moving.">
        <button type="button" onClick={() => setShowBankManager(true)} className={ADMIN_BUTTON.ghost}>Class bank</button>
        <button type="button" onClick={() => { setEditingSession(null); setShowEditor(true); }} className={ADMIN_BUTTON.primary}>+ New Class</button>
      </AdminPageHeader>
      <div className="calendar-toolbar">
        <AdminSegmented label="Calendar view" value={view} onValueChange={setView} options={[{value:'calendar',label:'Calendar'},{value:'list',label:'List'}]} />
        {view === 'list' && <AdminSegmented label="Class period" value={timeFilter} onValueChange={setTimeFilter} options={[{value:'upcoming',label:`Upcoming (${upcomingCount})`},{value:'past',label:`Past (${pastCount})`},{value:'all',label:'All'}]} />}
        {cancelledCount > 0 && <button type="button" className="admin-kit-button" onClick={() => setShowCancelled(current => !current)} aria-pressed={showCancelled}>{showCancelled ? 'Hide cancelled' : `Show cancelled (${cancelledCount})`}</button>}
      </div>
      <AdminFilterBar queryKey="calendarSearch" searchLabel="Search class names" filters={[{key:'calendarType',label:'Class type',options:CLASS_TYPES.map(value => ({value,label:value}))}]} />

      {/* Find one person across the whole timetable, both ways into a class.
          This sat directly under the class filter as a second, unlabelled
          search box — so staff typed a name into the labelled one above,
          matched nothing, and concluded you could search classes but not the
          people in them. It says what it is now. */}
      <div className={`${ADMIN_PANEL} mb-6 p-4`}>
        <p className={ADMIN_TEXT.sectionHeading}>Find a person</p>
        <p className={`${ADMIN_TEXT.lede} mt-1 mb-3`}>
          Every class someone is signed up for, members and public sign-ups alike. Search by name,
          email or phone, then press a class to open its roster.
        </p>
        <label className="relative block max-w-md">
          <span className="sr-only">Search everyone registered for a class</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            type="search"
            value={attendeeQuery}
            onChange={event => setAttendeeQuery(event.target.value)}
            placeholder="Name, email or phone"
            className={`${ADMIN_INPUT} pl-10`}
          />
          {attendeeSearching && <LoaderCircle aria-hidden="true" className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-text-secondary" />}
        </label>

        {attendeeSearching && <p role="status" className="admin-kit-label mt-3">Searching the timetable…</p>}
        {attendeeError && <p role="alert" className="mt-3 text-state-danger-text">Could not search the timetable. {attendeeError}</p>}
        {attendeeMatches && (
          <div className="mt-3 border border-border-hairline bg-surface-raised">
            {attendeeMatches.length === 0 ? (
              <p className="p-4 font-body text-sm text-text-secondary">
                Nobody matching &ldquo;{attendeeQuery.trim()}&rdquo; is registered for a class.
              </p>
            ) : (
              <>
                <p className="border-b border-border-hairline px-4 py-2 font-body text-xs text-text-secondary">
                  {(() => {
                    const totals = summarizeAttendeeSearch(attendeeMatches);
                    return `${totals.people} ${totals.people === 1 ? 'person' : 'people'} \u00b7 ${totals.bookings} ${totals.bookings === 1 ? 'booking' : 'bookings'} \u00b7 ${totals.upcoming} still to come`;
                  })()}
                </p>
                <ul tabIndex={0} aria-label="Matching people and classes" className="max-h-96 divide-y divide-border-hairline overflow-y-auto">
                  {attendeeMatches.map(person => (
                    <li key={person.key} className="p-4">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <p className="font-display text-lg uppercase text-text-primary">{person.name}</p>
                        {person.sources.includes('member') && <span className="border border-border-hairline px-2 py-0.5 font-body text-[10px] uppercase tracking-wider text-text-secondary">Member</span>}
                        {person.sources.includes('signup') && <span className="border border-border-hairline px-2 py-0.5 font-body text-[10px] uppercase tracking-wider text-text-secondary">Sign-up</span>}
                        {person.email && <a href={`mailto:${person.email}`} className="font-body text-xs text-text-secondary">{person.email}</a>}
                        {person.phone && <a href={`tel:${person.phone.replace(/\s+/g, '')}`} className="font-body text-xs text-text-secondary">{person.phone}</a>}
                      </div>
                      <ul className="mt-2 space-y-1">
                        {person.classes.map(entry => (
                          <li key={`${entry.source}:${entry.bookingId}`}>
                            <button
                              type="button"
                              onClick={() => openWaitlistRoster(entry.sessionId, { preservePeriod: true })}
                              className={`flex min-h-11 w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-sunken ${entry.active ? 'border-border-hairline' : 'border-border-hairline'}`}
                            >
                              <span className={`font-body text-sm ${entry.active ? 'text-text-primary' : 'text-text-secondary line-through'}`}>
                                {entry.startsAt ? gymDateTimeLabel(entry.startsAt) : 'Date unknown'}
                              </span>
                              <span className="font-body text-sm text-text-secondary">{entry.title}</span>
                              <span className="font-body text-xs uppercase tracking-wider text-text-secondary">{entry.status.replace(/_/g, ' ')}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {bookingsEnabled === false && (
        <div className="mb-6 flex flex-wrap items-start gap-3 border border-xert-orange/40 bg-xert-orange/[0.06] p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-xert-orange" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-body text-sm font-semibold text-xert-offwhite">
              Bookings are switched off, so no class on this calendar can be booked.
            </p>
            <p className="mt-1 font-body text-xs leading-relaxed text-xert-concrete/65">
              Every published class shows “Register interest” on the timetable and holds no spot, whatever
              its booking mode says here. Turn bookings on in Settings → Platform controls when you want
              people to be able to take a place.
            </p>
          </div>
        </div>
      )}

      <WaitlistDesk
        rows={waitlistOverview}
        available={waitlistOverviewAvailable}
        error={waitlistOverviewError}
        loading={waitlistOverviewLoading}
        promotingSessionId={promotingSessionId}
        onRetry={refreshWaitlistOverview}
        onOpen={openWaitlistRoster}
        onPromote={setPromotionCandidate}
      />

      {loading ? (
        <div className="calendar-loading"><AdminSkeleton variant="editor" label="Loading class calendar" /><AdminSkeleton variant="field" decorative /><AdminSkeleton variant="field" decorative /></div>
      ) : loadError ? (
        <AdminEmptyState title="Could not load classes" description={loadError} action={<button type="button" className="admin-kit-button" onClick={() => void load()}>Retry classes</button>} />
      ) : view === 'calendar' ? (
        <ClassCalendarBoard
          sessions={visibleCalendarSessions}
          signupCounts={signupCounts}
          rosterSessionId={boardRosterSessionId}
          rosterSignups={bookings}
          rosterMembers={roster}
          rosterLoading={boardRosterLoading}
          rosterStatuses={BOOKING_STATUSES}
          rosterUpdatingId={updatingBookingId}
          onRosterStatusChange={handleRosterPersonStatus}
          onCloseRoster={() => setBoardRosterSessionId(null)}
          blackouts={blackouts}
          templates={templates}
          templatesAvailable={templatesAvailable}
          templatesLoading={templatesLoading}
          onQuickAdd={handleQuickAdd}
          onCreateCustom={handleCreateCustomForDay}
          onEditSession={session => { setEditingSession(session); setShowEditor(true); }}
          onOpenRoster={openRosterFromBoard}
          onDuplicateSession={handleDuplicate}
          onCancelSession={setSessionToCancel}
          onSaveToBank={handleSaveToBank}
          onManageBank={() => setShowBankManager(true)}
          duplicatingSessionId={duplicatingSessionId}
          savingToBankId={savingToBankId}
        />
      ) : visibleListSessions.length === 0 ? (
        <AdminEmptyState title={sessions.length === 0 ? 'No classes yet' : `No ${timeFilter === 'all' ? '' : timeFilter} classes`}
          description={sessions.length === 0 ? 'Create your first class session.' : !showCancelled && cancelledInTimeFilter.length > 0 ? `${cancelledInTimeFilter.length} cancelled classes are hidden. Show cancelled to review the retained record.` : 'Try another filter or create a new class.'}
          action={<button type="button" className="admin-kit-button" onClick={() => { setEditingSession(null); setShowEditor(true); }}>New Class</button>} />
      ) : (
        <div className="space-y-2">
          <p className="admin-kit-label" role="status">{filtered.length} matching {filtered.length === 1 ? 'class' : 'classes'}{selectedOutsideFilters ? ' · Selected class shown separately' : ''}</p>
          {visibleListSessions.map(s => {
            const sessionBlackouts = blackoutsOverlappingSession(s, blackouts);
            const activeRosterCount = roster.filter(member => ['requested', 'confirmed'].includes(member.status)).length;
            const waitlistedRoster = roster.filter(member => member.status === 'waitlisted');
            const promotionItem = waitlistOverview.find(item => item.session_id === s.id) || null;
            // The database's own count of both doors into the room. Counting
            // credit members alone showed "Class roster (0/8)" and a live
            // Promote next button for a class the timetable had filled to 8/8 —
            // and the promotion was then refused with SESSION_FULL.
            const placesTaken = capacityById[s.id]?.taken ?? activeRosterCount;
            const hasOpenPlace = s.capacity == null || placesTaken < s.capacity;
            return (
            <div id={`class-session-${s.id}`} key={s.id} className="calendar-session-card">
              <div className="p-4">
                {selectedOutsideFilters === s.id && <p className="admin-kit-label mb-3">Selected class — outside current filters</p>}
                <div className="calendar-session-heading">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <AdminBadge status={s.status}>{s.status}</AdminBadge>
                      {s.public_visible && <AdminBadge status="active">Public</AdminBadge>}
                      {s.beginner_friendly && <span className="font-body text-xs text-xert-concrete/40 uppercase text-xs">Beginner friendly</span>}
                      {s.booking_mode && <span className="font-body text-xs text-xert-concrete/40 uppercase">{s.booking_mode.replaceAll('_', ' ')}</span>}
                    </div>
                    <h3 className="calendar-session-title">{s.title}</h3>
                    <p className="font-body text-xs text-xert-concrete/50">
                      {s.class_type} · {s.start_time ? new Date(s.start_time).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'No time set'}
                      {s.coach_name ? ` · ${s.coach_name}` : ''} · Cap: {s.capacity}
                    </p>
                    {sessionBlackouts.length > 0 && (
                      <p className="mt-2 inline-flex items-center gap-1.5 font-body text-xs text-xert-orange">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Blackout overlap: {sessionBlackouts.map(blackout => blackout.reason).join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="calendar-session-actions">
                    <button aria-expanded={expandedBookings === s.id} onClick={() => loadBookings(s.id)}
                      className="px-3 py-1.5 border border-xert-steel/30 font-body text-xs text-xert-concrete/60 hover:border-xert-steel transition-colors">
                      Bookings
                    </button>
                    <button onClick={() => { setEditingSession(s); setShowEditor(true); }}
                      className="px-3 py-1.5 border border-xert-steel/30 font-body text-xs text-xert-concrete/60 hover:border-xert-steel transition-colors">
                      Edit
                    </button>
                    <button onClick={() => handleDuplicate(s)} disabled={Boolean(duplicatingSessionId)}
                      className="px-3 py-1.5 border border-xert-steel/30 font-body text-xs text-xert-concrete/60 hover:border-xert-steel transition-colors disabled:opacity-50">
                      {duplicatingSessionId === s.id ? 'Duping…' : 'Dupe'}
                    </button>
                    <button onClick={() => setRepeating(s)}
                      className="px-3 py-1.5 border border-xert-steel/30 font-body text-xs text-xert-concrete/60 hover:border-xert-steel transition-colors">
                      Repeat…
                    </button>
                    {s.status !== 'cancelled' && (
                      <button onClick={() => setSessionToCancel(s)}
                        className="px-3 py-1.5 border border-xert-red/30 font-body text-xs text-xert-red/60 hover:border-xert-red/60 transition-colors">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Bookings panel */}
              {expandedBookings === s.id && (
                <div className="calendar-roster-panel">
                  {/* Credit-based member roster */}
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <h4 className="font-display text-sm text-xert-concrete/60 uppercase">
                      Class roster ({placesTaken}{s.capacity ? `/${s.capacity}` : ''})
                      {placesTaken !== activeRosterCount && (
                        <span className="ml-2 font-body text-xs normal-case text-xert-concrete/40">
                          {activeRosterCount} with credits · {placesTaken - activeRosterCount} from the timetable
                        </span>
                      )}
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {s.status === 'published' && new Date(s.start_time).getTime() > now && hasOpenPlace && waitlistedRoster.length > 0 && promotionItem && (
                        <button type="button" onClick={() => setPromotionCandidate(promotionItem)} disabled={Boolean(promotingSessionId)}
                          className="inline-flex min-h-11 items-center gap-1.5 px-3 py-2 border border-xert-steel/40 font-body text-[11px] uppercase tracking-wider text-xert-steel hover:border-xert-steel transition-colors disabled:opacity-40">
                          <UserCheck className="w-3.5 h-3.5" />
                          {promotingSessionId === s.id ? 'Promoting...' : `Promote next (${waitlistedRoster.length})`}
                        </button>
                      )}
                      {s.start_time && new Date(s.start_time).getTime() <= now
                        && ['published', 'full', 'completed'].includes(s.status)
                        && [...roster, ...bookings].some(person => ['confirmed', 'attended', 'no_show'].includes(person.status)) && (
                        <button type="button" onClick={() => openAttendance(s)}
                          className="inline-flex min-h-11 items-center gap-1.5 px-3 py-2 border border-status-confirmed-600/40 font-body text-[11px] uppercase tracking-wider text-status-confirmed-400 hover:bg-status-confirmed-900/20 transition-colors">
                          <ClipboardCheck className="w-3.5 h-3.5" />
                          Take attendance
                        </button>
                      )}
                      <button onClick={() => exportRoster(s)} disabled={roster.length === 0 && bookings.length === 0}
                        className="inline-flex min-h-11 items-center gap-1.5 px-3 py-2 border border-xert-steel/30 font-body text-[11px] uppercase tracking-wider text-xert-concrete/60 hover:border-xert-steel transition-colors disabled:opacity-40">
                        <Download className="w-3.5 h-3.5" />
                        Export roster
                      </button>
                    </div>
                  </div>
                  {roster.length === 0 ? (
                    <p className="font-body text-sm text-xert-concrete/40 mb-4">No member bookings yet.</p>
                  ) : (
                    <div className="space-y-2 mb-5">
                      {roster.map(r => {
                        const waitlistPosition = r.status === 'waitlisted'
                          ? waitlistedRoster.findIndex(member => member.booking_id === r.booking_id) + 1
                          : null;
                        return (
                        <div key={r.booking_id} className="calendar-roster-row">
                          <div>
                            <p className="font-body text-sm text-xert-offwhite">{r.full_name || r.email || 'Member'}</p>
                            <p className="font-body text-xs text-xert-concrete/50">{r.email}{r.phone ? ` · ${r.phone}` : ''}</p>
                            {waitlistPosition && <p className="font-body text-[11px] text-xert-steel mt-1">Waitlist position {waitlistPosition}</p>}
                          </div>
                          <select aria-label={`Status for ${r.full_name || r.email || 'Member'}`} value={r.status} onChange={e => handleRosterStatus(r.booking_id, e.target.value)} disabled={updatingBookingId === r.booking_id || !['published', 'full'].includes(s.status)}
                            className="bg-xert-charcoal border border-xert-steel/40 px-2 py-1 font-body text-xs text-xert-offwhite focus:outline-none focus:border-xert-red">
                            {rosterStatusOptions(r.status, s.status, waitlistedRoster.length > 0).map(st => <option key={st} value={st}>{st}</option>)}
                          </select>
                        </div>
                        );
                      })}
                      <p className="font-body text-xs text-xert-concrete/40">Waitlisting, declining, or cancelling a request returns its reserved credit.</p>
                    </div>
                  )}

                  <div className="mb-5 border border-xert-steel/20 bg-xert-ink p-3">
                    <label htmlFor={`add-attendee-${s.id}`} className="block font-body text-xs uppercase tracking-wider text-xert-concrete/50">
                      Add an attendee
                    </label>
                    <p className="mt-1 mb-2 font-body text-xs text-xert-concrete/40">
                      Books a registered member in, the same as if they had booked it themselves. Not registered? Add them as a walk-in.
                    </p>
                    <input id={`add-attendee-${s.id}`} value={attendeeSearch} onChange={e => setAttendeeSearch(e.target.value)}
                      placeholder="Search a member by name or email"
                      className="w-full bg-xert-charcoal border border-xert-steel/40 px-3 py-2 font-body text-sm text-xert-offwhite focus:outline-none focus:border-xert-steel" />
                    {attendeeSearch.trim().length >= 2 && attendeeResults.length === 0 && (
                      <p className="mt-2 font-body text-xs text-xert-concrete/40">No registered member matches that.</p>
                    )}
                    {!walkIn && (
                      <button type="button" onClick={() => setWalkIn({ fullName: attendeeSearch.trim().includes('@') ? '' : attendeeSearch.trim(), phone: '', email: '' })}
                        className="mt-2 min-h-11 font-body text-xs uppercase tracking-wider text-xert-steel hover:text-xert-offwhite">
                        Not registered? Add a walk-in
                      </button>
                    )}
                    {walkIn && (
                      <form onSubmit={event => addWalkIn(event, s)} aria-label="Add a walk-in" className="mt-3 space-y-2 border-t border-xert-steel/20 pt-3">
                        <p className="font-body text-xs text-xert-concrete/40">For someone without an account. With an email they get the usual booking confirmation.</p>
                        {[['fullName', 'Name', 'text', true], ['phone', 'Phone (optional)', 'tel', false], ['email', 'Email (optional)', 'email', false]].map(([key, label, type, required]) => (
                          <label key={key} className="block font-body text-xs uppercase tracking-wider text-xert-concrete/50">
                            {label}
                            <input type={type} value={walkIn[key]} required={required} minLength={required ? 2 : undefined} autoComplete="off"
                              onChange={e => setWalkIn({ ...walkIn, [key]: e.target.value })}
                              className="mt-1 w-full bg-xert-charcoal border border-xert-steel/40 px-3 py-2 font-body text-sm normal-case tracking-normal text-xert-offwhite focus:outline-none focus:border-xert-steel" />
                          </label>
                        ))}
                        <div className="flex gap-2">
                          <button type="submit" disabled={walkInBusy || walkIn.fullName.trim().length < 2}
                            className="min-h-11 border border-xert-steel px-4 font-body text-xs uppercase tracking-wider text-xert-offwhite disabled:opacity-50">
                            {walkInBusy ? 'Adding…' : 'Add to class'}
                          </button>
                          <button type="button" onClick={() => setWalkIn(null)} className="min-h-11 px-4 font-body text-xs uppercase tracking-wider text-xert-concrete/60">Cancel</button>
                        </div>
                      </form>
                    )}
                    {attendeeResults.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {attendeeResults.map(member => (
                          <li key={member.id}>
                            <button type="button" disabled={Boolean(addingAttendeeId)} onClick={() => addAttendee(s, member)}
                              className="flex min-h-11 w-full items-center justify-between gap-3 border border-xert-steel/25 px-3 py-2 text-left transition-colors hover:border-xert-steel disabled:opacity-50">
                              <span className="min-w-0">
                                <span className="block truncate font-body text-sm text-xert-offwhite">{member.full_name || member.email}</span>
                                <span className="block truncate font-body text-xs text-xert-concrete/45">{member.email}{member.credits_remaining !== undefined ? ` · ${member.credits_remaining} credits` : ''}</span>
                              </span>
                              <span className="shrink-0 font-body text-xs uppercase tracking-wider text-xert-steel">
                                {addingAttendeeId === member.id ? 'Adding…' : 'Add'}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <h4 className="font-display text-sm text-xert-concrete/60 uppercase mb-3">Booking requests ({bookings.length})</h4>
                  {bookings.length === 0 ? (
                    <p className="font-body text-sm text-xert-concrete/40">No bookings yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {bookings.map(b => (
                        <div key={b.id} className="calendar-roster-row">
                          <div>
                            <p className="font-body text-sm text-xert-offwhite">{b.full_name}</p>
                            <p className="font-body text-xs text-xert-concrete/50">{b.email} · {b.training_level}</p>
                          </div>
                          <select aria-label={`Status for ${b.full_name || b.email || 'Signup'}`} value={b.status} onChange={e => handleBookingStatus(b.id, e.target.value)} disabled={updatingBookingId === b.id}
                            className="bg-xert-charcoal border border-xert-steel/40 px-2 py-1 font-body text-xs text-xert-offwhite focus:outline-none focus:border-xert-red">
                            {BOOKING_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {showEditor && (
        <SessionEditor
          key={editingSession?.id || 'new-class'}
          session={editingSession}
          blackouts={blackouts}
          onSave={() => { setShowEditor(false); load(); }}
          onCancel={() => {
            setShowEditor(false);
            setEditingSession(null);
          }}
          onDirtyChange={onDirtyChange}
        />
      )}

      {repeating && (
        <RepeatModal
          session={repeating}
          onDone={() => { setRepeating(null); load(); }}
          onCancel={() => setRepeating(null)}
        />
      )}

      {showBankManager && (
        <ClassBankManager
          templates={templates}
          available={templatesAvailable}
          loading={templatesLoading}
          onChanged={loadTemplates}
          onClose={() => setShowBankManager(false)}
          onDirtyChange={onDirtyChange}
        />
      )}

      {attendanceSession && (
        <AdminDrawer open onOpenChange={open => { if (!open && !isSavingAttendance) setAttendanceSession(null); }} title={attendanceSession.title}
          description={`Class roll call · ${gymDayLabel(attendanceSession.start_time)}, ${gymTimeLabel(attendanceSession.start_time)}`} closeLabel="Close attendance roll call">
            <div className="calendar-attendance">

              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-5 font-body text-xs text-xert-concrete/60" aria-live="polite">
                  <span><strong className="text-xert-offwhite">{attendanceSummary.marked}/{attendanceSummary.total}</strong> marked</span>
                  <span><strong className="text-status-confirmed-400">{attendanceSummary.attended}</strong> present</span>
                  <span><strong className="text-xert-orange">{attendanceSummary.noShow}</strong> no show</span>
                  {attendanceSummary.unmarked > 0 && <span><strong className="text-xert-steel">{attendanceSummary.unmarked}</strong> unmarked</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setAttendanceDraft(markAllAttendance(classRoll))} disabled={isSavingAttendance}
                    className="inline-flex min-h-11 items-center gap-2 border border-status-confirmed-600/40 px-3 font-body text-xs text-status-confirmed-400 disabled:opacity-40">
                    <CheckCheck className="h-4 w-4" /> Mark all present
                  </button>
                  <button type="button" onClick={() => setAttendanceDraft(blankAttendanceDraft(classRoll))} disabled={isSavingAttendance || attendanceSummary.marked === 0}
                    className="inline-flex min-h-11 items-center gap-2 border border-xert-steel/30 px-3 font-body text-xs text-xert-concrete/60 disabled:opacity-40">
                    <RotateCcw className="h-4 w-4" /> Clear marks
                  </button>
                </div>
              </div>
              {pendingAttendanceRequests.length > 0 && (
                <div role="alert" className="mb-4 flex gap-3 border border-xert-orange/40 bg-xert-orange/10 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-xert-orange" aria-hidden="true" />
                  <div>
                    <p className="font-body text-sm font-semibold text-xert-offwhite">
                      Resolve {pendingAttendanceRequests.length} booking {pendingAttendanceRequests.length === 1 ? 'request' : 'requests'} before completing this class.
                    </p>
                    <p className="mt-1 font-body text-xs leading-relaxed text-xert-concrete/65">
                      Close roll call, then confirm or decline each requested member in the roster. This protects their reserved training credit.
                    </p>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {attendanceSummary.members.map(member => {
                  const rowId = attendanceRowId(member);
                  const who = member.full_name || member.email || 'Member';
                  return (
                  <div key={rowId} className="calendar-attendance-row">
                    <div className="min-w-0">
                      <p className="break-words font-body text-sm text-xert-offwhite">{who}</p>
                      <p className="break-words font-body text-xs text-xert-concrete/45">
                        {member.email}
                        {member.attendance_source === 'signup' ? ' · timetable sign-up' : ''}
                      </p>
                    </div>
                    <div className="grid grid-cols-2" role="group" aria-label={`Attendance for ${who}`}>
                      <button type="button" onClick={() => setAttendanceDraft(current => ({ ...current, [rowId]: 'attended' }))}
                        aria-pressed={attendanceDraft[rowId] === 'attended'}
                        className={`min-h-11 px-4 font-body text-xs transition-colors ${attendanceDraft[rowId] === 'attended' ? 'bg-status-confirmed-700 text-white' : 'border border-xert-steel/30 text-xert-concrete/60'}`}>
                        Present
                      </button>
                      <button type="button" onClick={() => setAttendanceDraft(current => ({ ...current, [rowId]: 'no_show' }))}
                        aria-pressed={attendanceDraft[rowId] === 'no_show'}
                        className={`min-h-11 px-4 font-body text-xs transition-colors ${attendanceDraft[rowId] === 'no_show' ? 'bg-xert-orange text-xert-ink' : 'border border-l-0 border-xert-steel/30 text-xert-concrete/60'}`}>
                        No show
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>

            <div className="calendar-dialog-actions">
              <button type="button" onClick={() => setAttendanceSession(null)} disabled={isSavingAttendance}
                className="min-h-11 border border-xert-steel/40 px-5 font-display text-xs uppercase text-xert-concrete/70 disabled:opacity-40">Cancel</button>
              <button type="button" onClick={() => void saveAttendance()} disabled={isSavingAttendance || !attendanceSummary.complete || pendingAttendanceRequests.length > 0}
                title={pendingAttendanceRequests.length > 0 ? 'Resolve pending booking requests first' : attendanceSummary.complete ? 'Save complete roll call' : 'Mark every member before saving'}
                className="min-h-11 bg-status-confirmed-700 px-5 font-display text-xs uppercase text-white transition-colors hover:bg-status-confirmed-600 disabled:opacity-40">
                {isSavingAttendance ? 'Saving roll call...' : 'Save attendance'}
              </button>
            </div>
        </AdminDrawer>
      )}

      {sessionToCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="presentation">
          <div
            className="w-full max-w-md border border-xert-steel/30 bg-xert-ink p-6 text-xert-offwhite"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cancel-class-title"
            aria-describedby="cancel-class-description"
          >
            <h3 id="cancel-class-title" className="font-display text-xl uppercase text-xert-offwhite">Cancel this class?</h3>
            <p id="cancel-class-description" className="mt-3 font-body text-sm leading-relaxed text-xert-concrete/70">
              {sessionToCancel.title} will be removed from the timetable. All active bookings will be cancelled and any reserved class credits returned.
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={isCancellingSession}
                onClick={() => setSessionToCancel(null)}
                className="border border-xert-steel/40 px-4 py-2.5 font-display text-xs uppercase text-xert-concrete/70 transition-colors hover:bg-xert-charcoal hover:text-xert-offwhite disabled:opacity-50"
              >
                Keep class
              </button>
              <button
                type="button"
                disabled={isCancellingSession}
                onClick={handleCancel}
                className="bg-xert-steel px-4 py-2.5 font-display text-xs uppercase text-xert-navy transition-colors hover:bg-xert-pale disabled:opacity-50"
              >
                {isCancellingSession ? 'Cancelling...' : 'Cancel class'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cancellationFollowUp && (
        <CancellationFollowUpDialog followUp={cancellationFollowUp} onClose={() => setCancellationFollowUp(null)} />
      )}

      <AdminConfirmDialog
        open={Boolean(promotionCandidate)}
        title="Confirm and notify this member?"
        description={promotionCandidate
          ? `${promotionCandidate.next_full_name || promotionCandidate.next_email || 'The next member'} will be confirmed into ${promotionCandidate.title}. Their earliest-expiring credit will be reserved and a private member notice will be created.`
          : ''}
        warning="This is FIFO protected. If the queue changes before confirmation, the promotion stops for review."
        confirmLabel={promotingSessionId ? 'Promoting…' : 'Promote and notify'}
        busy={Boolean(promotingSessionId)}
        onOpenChange={open => { if (!open) setPromotionCandidate(null); }}
        onConfirm={() => promotionCandidate && void handlePromoteNext(promotionCandidate)}
      />
    </div>
  );
}
