const GYM_TIME_ZONE = 'Australia/Brisbane';

function gymHour(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const hour = new Intl.DateTimeFormat('en-AU', {
    timeZone: GYM_TIME_ZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).find(part => part.type === 'hour')?.value;
  const parsed = Number(hour);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : null;
}

export function filterPublicClasses(sessions, filters = {}, availability = {}) {
  const query = String(filters.query || '').trim().toLocaleLowerCase('en-AU');
  return (Array.isArray(sessions) ? sessions : []).filter(session => {
    if (!session || typeof session !== 'object') return false;
    if (filters.coach && session.coach_name !== filters.coach) return false;
    if (filters.classType && session.class_type !== filters.classType) return false;

    if (query) {
      const haystack = [session.title, session.class_type, session.coach_name, session.location_zone]
        .filter(Boolean).join(' ').toLocaleLowerCase('en-AU');
      if (!haystack.includes(query)) return false;
    }

    if (filters.timeOfDay && filters.timeOfDay !== 'any') {
      const hour = gymHour(session.start_time);
      if (hour === null) return false;
      if (filters.timeOfDay === 'morning' && hour >= 12) return false;
      if (filters.timeOfDay === 'afternoon' && (hour < 12 || hour >= 17)) return false;
      if (filters.timeOfDay === 'evening' && hour < 17) return false;
    }

    if (filters.availableOnly === true) {
      const places = availability?.[session.id]?.spots_left;
      if (!Number.isInteger(places) || places <= 0) return false;
    }

    return true;
  });
}

export function publicTimetableFilterOptions(sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  return {
    coaches: [...new Set(rows.map(row => row?.coach_name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    classTypes: [...new Set(rows.map(row => row?.class_type).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
  };
}
