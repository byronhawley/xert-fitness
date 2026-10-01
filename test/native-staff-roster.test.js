import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ios = (path) => new URL(`../ios/XertFitnessApp/${path}`, import.meta.url);
const read = (path) => readFile(ios(path), 'utf8');

test('native My Coaching keeps the shared deep-link contract', async () => {
  const links = await read('XertFitnessApp/StaffRoster/StaffRosterLinks.swift');
  const navigation = await read('XertFitnessApp/XertNavigation.swift');

  for (const tab of ['roster', 'availability', 'requests']) {
    assert.match(links, new RegExp(`case ${tab}\\b`));
  }
  assert.match(links, /static let linkableTabs: \[XertCoachingTab\] = \[\.roster, \.availability, \.requests\]/);
  assert.match(links, /allowed: \["month"\]/);
  assert.match(links, /allowed: \["tab", "month"\]/);
  assert.match(links, /path == "\/coaching"/);
  assert.match(links, /\(2000\.\.\.2100\)\.contains\(year\) && \(1\.\.\.12\)\.contains\(month\)/);

  // Coaching links are parsed before the query-free guard that protects every other route.
  const coachingIndex = navigation.indexOf('XertCoachingLink.link(for: url)');
  const guardIndex = navigation.indexOf('guard url.user == nil, url.password == nil, url.query == nil');
  assert.ok(coachingIndex > 0 && guardIndex > coachingIndex);
  assert.match(navigation, /case \.coaching\(_\):\s*\/\/ Staff roster data is private[^\n]*\n\s*return true/);
  assert.match(navigation, /case \.account, \.coaching\(_\):[\s\S]{0,120}return nil/);
});

test('staff roster pushes route open_path and are marked read only when viewed', async () => {
  const links = await read('XertFitnessApp/StaffRoster/StaffRosterLinks.swift');
  const delegate = await read('XertFitnessApp/Services/ClassReminderNavigation.swift');
  const store = await read('XertFitnessApp/Store/StaffRosterStore.swift');
  const coaching = await read('XertFitnessApp/Views/MyCoachingView.swift');

  assert.match(links, /static let category = "xert\.staff-roster"/);
  assert.match(links, /static let threadIdentifier = "xert-staff-roster"/);
  assert.match(links, /static let notificationIDKey = "staff_notification_id"/);
  assert.match(links, /static let openPathKey = "open_path"/);
  assert.match(delegate, /StaffRosterPush\.target\(from: response\.notification\.request\.content\.userInfo\)/);
  assert.match(delegate, /StaffRosterPushNavigation\.markPending\(target\)/);

  const willPresent = delegate.slice(delegate.indexOf('willPresent'), delegate.indexOf('didReceive'));
  assert.doesNotMatch(willPresent, /markRead|mark_notifications_read|MarkNotificationsRead/);
  assert.match(store, /func markOpenedNotificationsViewed\(\) async \{\s*guard access\.me != nil/);
  assert.match(coaching, /await staffRoster\.markOpenedNotificationsViewed\(\)/);
});

test('My Coaching uses Brisbane time, server-decided visibility and no manager builder', async () => {
  const time = await read('XertFitnessApp/StaffRoster/StaffRosterTime.swift');
  const models = await read('XertFitnessApp/StaffRoster/StaffRosterModels.swift');
  const account = await read('XertFitnessApp/Views/AccountView.swift');
  const api = await read('XertFitnessApp/Services/XertAPI.swift');
  const sources = [
    await read('XertFitnessApp/Views/MyCoachingView.swift'),
    await read('XertFitnessApp/Views/CoachAvailabilityView.swift'),
    await read('XertFitnessApp/Store/StaffRosterStore.swift'),
  ].join('\n');

  assert.match(time, /TimeZone\(identifier: "Australia\/Brisbane"\)/);
  assert.doesNotMatch(sources, /TimeZone\.current|Calendar\.current/);
  assert.match(models, /guard let me = access\.me else \{ return false \}\s*return me\.staff\.status == "active"/);
  assert.match(account, /if staffRoster\.showsEntry \{\s*staffCoachingSection/);
  assert.match(api, /"\/rest\/v1\/rpc\/staff_roster_\\\(name\)"/);
  for (const manager of ['staff_roster_admin', 'staff_roster_publish', 'staff_roster_build', 'approve_cover']) {
    assert.ok(!api.includes(manager), `${manager} must stay on the web`);
  }

  const tests = await read('XertFitnessAppTests/StaffRosterTests.swift');
  for (const name of [
    'testDeepLinksRejectInvalidMonthsUnknownTabsAndForeignHosts',
    'testStaffRosterPushRoutesItsOpenPath',
    'testBrisbaneDatesAndMonthBoundaries',
    'testRosterGroupsByBrisbaneDateInStartOrder',
    'testDecodesStaffRosterMe',
    'testMyCoachingIsVisibleOnlyForAnActiveCoach',
  ]) {
    assert.match(tests, new RegExp(`func ${name}\\(`));
  }
});
