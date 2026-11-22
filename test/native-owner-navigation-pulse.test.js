import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const pulse = read('../ios/XertFitnessApp/XertFitnessApp/Services/OwnerNavigationPulse.swift');
const root = read('../ios/XertFitnessApp/XertFitnessApp/Views/RootView.swift');
const account = read('../ios/XertFitnessApp/XertFitnessApp/Views/AccountView.swift');
const swiftTests = read('../ios/XertFitnessApp/XertFitnessAppTests/ModelsTests.swift');

test('owner navigation pulse loads only bounded operational and health summaries concurrently', () => {
  for (const method of [
    'adminDailyOperations',
    'adminWaitlist',
    'adminFollowUps',
    'adminPTRequests',
    'adminCommerceHealth',
    'adminPushHealth',
  ]) {
    assert.match(pulse, new RegExp(`async let [\\s\\S]*api\\.${method}\\(session: session`));
  }
  assert.doesNotMatch(pulse, /adminMembers|adminOrders|adminAudit|adminClassSessions/);
  assert.match(pulse, /adminWaitlist\(session: session, limit: 50\)/);
  assert.match(pulse, /adminFollowUps\(session: session, limit: 50\)/);
  assert.match(pulse, /requested_count \+ \$1\.public_request_count/);
  assert.match(pulse, /filter\(\\\.attendance_due\)/);
  assert.match(pulse, /filter\(\\\.isPending\)/);
  assert.match(pulse, /commerceHealth\?\.ready == false/);
  assert.match(pulse, /pushHealth\?\.isOwnerLaunchReady\(at: updatedAt\) == false/);
});

test('owner pulse store is account scoped, freshness bounded, and resistant to stale responses', () => {
  assert.match(pulse, /private var accountID: UUID\?/);
  assert.match(pulse, /private var requestID: UUID\?/);
  assert.match(pulse, /if accountID != userID \{[\s\S]*reset\(\)[\s\S]*accountID = userID/);
  assert.match(pulse, /guard requestID == currentRequestID, accountID == userID else \{ return \}/);
  assert.match(pulse, /guard force \|\| !snapshot\.isFresh/);
  assert.match(pulse, /func reset\(\)[\s\S]*snapshot = \.empty/);
});

test('owner pulse retains a deterministic exact workspace for the next best action', () => {
  assert.match(pulse, /enum XertOwnerNavigationPriority: Equatable/);
  assert.match(pulse, /case platformHealth\(Int\)/);
  assert.match(pulse, /case attendance\(Int\)/);
  assert.match(pulse, /case bookingRequests\(Int\)/);
  assert.match(pulse, /case waitlist\(Int\)/);
  assert.match(pulse, /case ptRequests\(Int\)/);
  assert.match(pulse, /case retention\(Int\)/);
  assert.match(pulse, /case \.platformHealth: return \.health/);
  assert.match(pulse, /case \.attendance, \.waitlist: return \.classDesk/);
  assert.match(pulse, /static func resolve\([\s\S]*if healthIssueCount > 0[\s\S]*if attendanceDue > 0[\s\S]*if bookingRequests > 0[\s\S]*if waitingMembers > 0[\s\S]*if pendingPT > 0[\s\S]*if followUps > 0/);
  assert.match(pulse, /priority: priority/);
  assert.match(swiftTests, /testOwnerNavigationPriorityRoutesTheMostUrgentWorkExactly/);
});

test('iPad and iPhone expose owner priority routing without stacking an admin strip above member navigation', () => {
  const phoneDock = root.slice(
    root.indexOf('private struct XertNavigationDock: View'),
    root.indexOf('private struct XertOwnerNavigationPulseBadge'),
  );

  assert.match(root, /@StateObject private var ownerNavigationPulse = XertOwnerNavigationPulseStore\(\)/);
  assert.equal((root.match(/ownerPulse: ownerNavigationPulse\.snapshot/g) || []).length, 2);
  assert.ok((root.match(/XertOwnerNavigationPulseBadge\(pulse: ownerPulse\)/g) || []).length >= 2);
  assert.ok((root.match(/onOpenAdmin\(priority\.workspace\)/g) || []).length >= 2);
  assert.match(phoneDock, /HStack\(spacing: 0\)[\s\S]*ForEach\(items\)/);
  assert.match(phoneDock, /dynamicTypeSize\.isAccessibilitySize[\s\S]*LazyVGrid/);
  assert.doesNotMatch(phoneDock, /taskStrip|ownerPriorityControl|safeAreaInset/);
  assert.match(root, /if item == \.account, isAdmin[\s\S]*XertOwnerNavigationPulseBadge\(pulse: ownerPulse\)/);
  assert.match(root, /if item == \.account, isAdmin[\s\S]*Label\("Owner Command Centre", systemImage: XertOwnerWorkspace\.overview\.icon\)/);
  assert.match(account, /store\.profile\?\.isAdmin == true[\s\S]*Label\("Owner", systemImage: "waveform\.path\.ecg\.rectangle"\)/);
  assert.match(account, /Button \{[\s\S]*onOpenOwner\(\)[\s\S]*Text\("Owner Command Centre"\)/);
  assert.match(root, /private func openOwnerCommandCentre\(_ workspace: XertOwnerWorkspace\? = nil\)/);
  assert.match(root, /authorizeAndOpenOwnerRoute\(XertOwnerRoute\(workspace: workspace \?\? \.overview\)\)/);
  assert.match(root, /refreshOwnerNavigationPulse\(force: true\)/);
  assert.match(root, /ownerNavigationPulse\.reset\(\)/);
  assert.match(swiftTests, /testOwnerNavigationPulseBoundsCountsAndExplainsAttention/);
  assert.match(swiftTests, /testOwnerNavigationPulseFreshnessRejectsFutureAndExpiredSnapshots/);
});
