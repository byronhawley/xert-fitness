import { useEffect, useState } from 'react';
import { ptClient } from './ptBookingData';

const OFF = Object.freeze({ enabled: false, coaches: [] });
let pending = null;

/**
 * Whether PT booking is on, and which coaches take bookings. Fetched once per
 * page load and shared, so the nav, footer and pages don't each ask. Anything
 * going wrong reads as "off", so PT links simply stay hidden.
 */
export function loadPtAvailability() {
  if (!pending) {
    pending = ptClient()
      .then(client => client.coaches())
      .then(data => (data?.enabled ? { enabled: true, coaches: data.coaches || [] } : OFF))
      .catch(() => OFF);
  }
  return pending;
}

export function usePtAvailability() {
  const [state, setState] = useState(OFF);
  useEffect(() => {
    let live = true;
    loadPtAvailability().then(value => { if (live) setState(value); });
    return () => { live = false; };
  }, []);
  return state;
}

/** The /pt link for a public coach profile, or null when they don't take PT bookings. */
export function ptLinkForCoach(availability, coachId) {
  const match = availability.enabled && availability.coaches.find(item => item.coach_id && item.coach_id === coachId);
  return match ? `/pt?coach=${match.staff_id}` : null;
}
