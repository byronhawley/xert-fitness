// Safe order for switching the roster off.
//
// Switching the whole roster off (`enabled = false`) does NOT touch public
// coach names: names the roster already wrote onto upcoming classes
// (class_sessions.coach_name) stay on the public timetable. Only switching
// "Show the lead coach on the public timetable" off gives them back
// (staff_roster_withdraw_public_names: roster-written names are removed,
// names typed or edited by hand are kept). So the Settings screen asks for
// public names to be switched off first, and says so when they are still on
// after the roster was switched off some other way (for example by SQL).

/**
 * @param {{enabled?: boolean, public_coach_names_enabled?: boolean}|null} settings
 * @returns {{canSwitchOff: boolean, blockReason: string|null, namesStillShowing: boolean}}
 */
export function rosterSwitchState(settings) {
  const enabled = Boolean(settings?.enabled);
  const names = Boolean(settings?.public_coach_names_enabled);
  return {
    canSwitchOff: enabled && !names,
    blockReason: enabled && names
      ? 'Turn off “Show the lead coach on the public timetable” first. That removes the coach names the roster put on upcoming classes (names typed by hand stay). Switching the roster off on its own leaves those names showing.'
      : null,
    namesStillShowing: !enabled && names,
  };
}
