import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootURL = new URL('../ios/XertFitnessApp/XertFitnessApp/Views/RootView.swift', import.meta.url);
const navigationURL = new URL('../ios/XertFitnessApp/XertFitnessApp/XertNavigation.swift', import.meta.url);
const ownerNavigationURL = new URL('../ios/XertFitnessApp/XertFitnessApp/OwnerNavigation.swift', import.meta.url);
const sceneCommandsURL = new URL('../ios/XertFitnessApp/XertFitnessApp/Services/XertNavigationCommands.swift', import.meta.url);
const hapticsURL = new URL('../ios/XertFitnessApp/XertFitnessApp/Services/XertHaptics.swift', import.meta.url);
const modelsTestsURL = new URL('../ios/XertFitnessApp/XertFitnessAppTests/ModelsTests.swift', import.meta.url);
const viewURL = name => new URL(`../ios/XertFitnessApp/XertFitnessApp/Views/${name}.swift`, import.meta.url);

test('native navigation uses five stable primary destinations without iOS More overflow', async () => {
  const [root, navigation, ...primaryViews] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(navigationURL, 'utf8'),
    ...['HomeView', 'BookingView', 'EventsView', 'ExploreView', 'AccountView']
      .map(name => readFile(viewURL(name), 'utf8')),
  ]);
  assert.match(root, /struct XertNavigationDock/);
  assert.ok((root.match(/\.toolbar\(\.hidden, for: \.tabBar\)/g) || []).length >= 6);
  for (const view of primaryViews) assert.match(view, /\.toolbar\(\.hidden, for: \.tabBar\)/);
  assert.match(root, /\.safeAreaInset\(edge: \.bottom, spacing: 0\)/);
  assert.match(navigation, /enum XertPrimaryDestination: Int, CaseIterable, Identifiable, Hashable/);
  for (const item of [
    ['home', '0'], ['booking', '1'], ['events', '2'], ['account', '3'], ['explore', '4'],
  ]) assert.match(navigation, new RegExp(`case ${item[0]} = ${item[1]}`));
  assert.match(navigation, /dockOrder: \[Self\] = \[\.home, \.booking, \.events, \.explore, \.account\]/);
  assert.match(root, /ForEach\(items\)/);
  assert.doesNotMatch(root, /Label\("Admin", systemImage:/);
});

test('native navigation adapts from a compact dock to an iPad workspace rail', async () => {
  const [root, navigation] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(navigationURL, 'utf8'),
  ]);
  assert.match(root, /@Environment\(\\\.horizontalSizeClass\) private var horizontalSizeClass/);
  assert.match(navigation, /enum XertNavigationPresentation: Equatable/);
  assert.match(navigation, /isRegularWidth \? \.workspaceRail : \.compactDock/);
  assert.match(root, /safeAreaInset\(edge: \.leading, spacing: 0\)[\s\S]*navigationPresentation == \.workspaceRail[\s\S]*navigationRail/);
  assert.match(root, /safeAreaInset\(edge: \.bottom, spacing: 0\)[\s\S]*navigationPresentation == \.compactDock[\s\S]*navigationDock/);
  assert.match(root, /private struct XertNavigationRail: View/);
  assert.match(root, /XertLogoHeader\(height:/);
  assert.match(root, /xert-navigation-history/);
  assert.match(root, /xert-navigation-owner/);
  assert.match(root, /rail-navigation-selection/);
  assert.match(root, /frame\(width: dynamicTypeSize\.isAccessibilitySize \? 136 : 104\)/);
  assert.match(root, /keyboardShortcut\(keyboardShortcut\(for: item\), modifiers: \.command\)/);
  assert.match(root, /case \.home: return "1"[\s\S]*case \.account: return "5"/);
  assert.match(root, /keyboardShortcut\("a", modifiers: \[\.command, \.shift\]\)/);
  assert.match(root, /hoverEffect\(\.highlight\)/);
  assert.ok((root.match(/accessibilityIdentifier\("xert-navigation-/g) || []).length >= 7);
});

test('compact dock keeps one clean five-tab bar with contextual access to owner and quick tools', async () => {
  const root = await readFile(rootURL, 'utf8');
  const dock = root.slice(
    root.indexOf('private struct XertNavigationDock'),
    root.indexOf('private struct XertOwnerNavigationPulseBadge'),
  );
  assert.match(root, /XertNavigationDock\([\s\S]*items: memberWorkspaceOrder/);
  assert.match(dock, /HStack\(spacing: 0\)[\s\S]*ForEach\(items\)/);
  assert.match(dock, /LazyVGrid\(columns:[\s\S]*frame\(minHeight: 52\)/);
  assert.match(dock, /accessibilityAction\(named: "Open XERT quick switcher"\)/);
  assert.match(dock, /Label\("Quick switcher", systemImage: "magnifyingglass"\)/);
  assert.match(dock, /if selected[\s\S]*Button\("Return to \\\(previousRoute\.navigationTitle\)"/);
  assert.doesNotMatch(dock, /taskStrip|ownerPriorityControl|xert-navigation-owner-priority/);
  assert.doesNotMatch(dock, /let currentRoute:/);
  assert.doesNotMatch(dock, /Text\("Owner Command Centre"\)/);
  assert.match(dock, /if item == \.account, isAdmin[\s\S]*XertOwnerNavigationPulseBadge\(pulse: ownerPulse\)/);
  assert.match(dock, /if item == \.account, isAdmin[\s\S]*Label\("Owner Command Centre", systemImage: XertOwnerWorkspace\.overview\.icon\)/);
});

test('member routing is typed, task-restorable, and owns native deep-link mapping', async () => {
  const [root, navigation] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(navigationURL, 'utf8'),
  ]);
  assert.match(root, /@SceneStorage\("xert\.memberRoute"\)/);
  assert.match(root, /Binding<XertPrimaryDestination>/);
  assert.match(root, /@StateObject private var navigation = XertNavigationCoordinator\(\)/);
  assert.match(root, /navigation\.restore\([\s\S]*workspaceValue: restoredMemberWorkspace,[\s\S]*fallbackRouteValue: restoredMemberRoute/);
  assert.match(root, /restoredMemberRoute = route\.restorationValue/);
  assert.match(root, /private func navigate\(to destination: XertPrimaryDestination\)/);
  assert.match(root, /XertMemberRoute\.route\(for: url\)/);
  assert.match(root, /openMemberRoute\(route, source: \.deepLink\)/);
  assert.doesNotMatch(root, /selectedTab\s*=\s*\d/);
  for (const path of ['/booking', '/events', '/account', '/explore']) {
    assert.match(navigation, new RegExp(`"${path.replace('/', '\\/')}"`));
  }
  assert.match(navigation, /url\.scheme\?\.lowercased\(\) == "xertfitness"/);
  assert.match(navigation, /url\.scheme\?\.lowercased\(\) == "xertfitness",[\s\S]*url\.port == nil/);
  assert.match(navigation, /url\.host\?\.lowercased\(\) == canonicalWebHost,[\s\S]*url\.port == nil \|\| url\.port == 443/);
  assert.match(navigation, /url\.user == nil[\s\S]*url\.password == nil[\s\S]*url\.query == nil[\s\S]*url\.fragment == nil/);
  assert.match(navigation, /enum XertMemberRoute: Hashable/);
  assert.match(navigation, /case notices\(UUID\?\)/);
  assert.match(navigation, /case classSession\(UUID\)/);
  assert.match(navigation, /case upcomingBookings\(UUID\?\)/);
  assert.match(navigation, /case sessionPacks/);
  assert.match(navigation, /case purchaseConfirmation/);
  assert.match(navigation, /case eventGoals/);
  assert.match(navigation, /var restorationValue: String/);
  assert.match(navigation, /case \.classSession\(let id\): return "booking\/classes\//);
  assert.match(navigation, /static func restore\(_ value: String\)/);
  assert.match(navigation, /return !route\.requiresAuthentication \|\| isSignedIn/);
  assert.match(navigation, /final class XertNavigationCoordinator: ObservableObject/);
  assert.match(navigation, /@Published private\(set\) var route: XertMemberRoute/);
  assert.match(navigation, /func open\(_ targetRoute: XertMemberRoute/);
  assert.match(navigation, /private\(set\) var routeHistory: \[XertMemberRoute\]/);
  assert.match(navigation, /var history: \[XertPrimaryDestination\]/);
  assert.match(navigation, /func returnToPrevious\(source: XertNavigationSource/);
  assert.match(navigation, /routeHistory\.count > historyLimit[\s\S]*routeHistory\.removeFirst/);
  for (const source of ['restoration', 'dock', 'dockSwipe', 'history', 'content', 'deepLink', 'pushNotification', 'checkout', 'commandPalette']) {
    assert.match(navigation, new RegExp(`case ${source}`));
  }
});

test('contextual member routes focus the exact native task instead of only its tab', async () => {
  const [root, home, booking, events, account] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(viewURL('HomeView'), 'utf8'),
    readFile(viewURL('BookingView'), 'utf8'),
    readFile(viewURL('EventsView'), 'utf8'),
    readFile(viewURL('AccountView'), 'utf8'),
  ]);
  assert.match(root, /openMemberRoute\(\.notices\(nil\), source: \.commandPalette\)/);
  assert.match(root, /openMemberRoute\(\.upcomingBookings\(bookingID\), source: \.commandPalette\)/);
  assert.match(root, /openMemberRoute\(\.eventGoals, source: \.commandPalette\)/);
  assert.match(root, /openMemberRoute\(\.purchaseConfirmation, source: \.commandPalette\)/);
  assert.match(root, /openMemberRoute\(\.notices\(pendingAnnouncementID\), source: \.pushNotification\)/);
  assert.match(root, /openMemberRoute\(\.upcomingBookings\(bookingID\), source: \.pushNotification\)/);
  for (const view of [home, booking, events, account]) {
    assert.match(view, /let route: XertMemberRoute/);
    assert.match(view, /let routeSequence: UInt/);
  }
  assert.match(home, /case \.notices\(let announcementID\) = route[\s\S]*showingNoticeCenter = true/);
  // The pack shop and its purchase confirmation are gone, so those two routes
  // have nothing to scroll to and no longer claim a target.
  assert.ok(!/target = \.packs/.test(booking));
  assert.ok(!/target = \.credits/.test(booking));
  assert.match(booking, /case \.classSession\(let sessionID\):[\s\S]*expandedSessionIDs\.insert\(sessionID\)[\s\S]*target = \.session\(sessionID\)/);
  assert.match(booking, /\.onChange\(of: store\.sessions\) \{ _ in focusRoute\(using: proxy\) \}/);
  assert.match(booking, /\.id\(ScrollTarget\.session\(session\.id\)\)/);
  assert.match(events, /route == \.eventGoals[\s\S]*proxy\.scrollTo\(ScrollTarget\.goals/);
  assert.match(account, /case \.upcomingBookings\(let bookingID\) = route[\s\S]*proxy\.scrollTo\(target/);
});

test('native navigation exposes a searchable contextual command switcher', async () => {
  const [root, navigation, modelsTests] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(navigationURL, 'utf8'),
    readFile(new URL('../ios/XertFitnessApp/XertFitnessAppTests/ModelsTests.swift', import.meta.url), 'utf8'),
  ]);
  assert.match(navigation, /enum XertNavigationCommandAction: Hashable/);
  assert.match(navigation, /case timeline\(Int\)/);
  assert.match(navigation, /struct XertNavigationContext: Equatable/);
  assert.match(navigation, /struct XertMemberRecordNavigationContext: Identifiable, Equatable/);
  assert.match(navigation, /static let maximumRecordsPerKind = 4/);
  assert.match(navigation, /normalizedRecords = Self\.normalizedRecords\(memberRecords\)[\s\S]*normalizedRecords\.filter \{ !\$0\.requiresAuthentication \}/);
  assert.match(navigation, /case notice\(UUID\)/);
  assert.match(navigation, /case classSession\(UUID\)/);
  assert.match(navigation, /enum XertNavigationActivity: Hashable/);
  assert.match(navigation, /enum XertNavigationCommandSection: String, CaseIterable, Identifiable/);
  assert.match(navigation, /func commandPaletteCommands\([\s\S]*context: XertNavigationContext = \.empty/);
  assert.match(navigation, /static func filteredCommands/);
  assert.match(navigation, /struct XertNavigationWorkspaceNode: Identifiable, Equatable/);
  assert.match(navigation, /func workspaceNodes\([\s\S]*allowsProtectedRoutes: Bool = true/);
  assert.match(navigation, /visibleRoute = allowsProtectedRoutes \|\| !rememberedRoute\.requiresAuthentication/);
  assert.match(navigation, /terms\.allSatisfy \{ command\.searchIndex\.contains\(\$0\) \}/);
  assert.match(navigation, /if isAdmin \{[\s\S]*XertOwnerWorkspace\.allCases\.map[\s\S]*action: \.owner\(workspace\)/);
  assert.match(root, /XertNavigationCommandPalette/);
  assert.match(root, /workspaceNodes: navigation\.workspaceNodes\([\s\S]*order: memberWorkspaceOrder[\s\S]*allowsProtectedRoutes: store\.isSignedIn/);
  assert.match(root, /private var workspaceMap: some View/);
  assert.match(root, /ScrollView\(\.horizontal, showsIndicators: false\)/);
  assert.match(root, /ForEach\(workspaceNodes\)/);
  assert.match(root, /xert-navigation-workspace-map/);
  assert.match(root, /private func openWorkspaceFromMap/);
  assert.match(root, /navigation\.selection == destination[\s\S]*handleReselection\(destination\)[\s\S]*selectMemberDestination\(destination, source: \.commandPalette\)/);
  assert.match(root, /context: navigationPaletteContext/);
  assert.match(root, /private var navigationStatusContext:[\s\S]*memberRecords: \[\]/);
  assert.match(root, /private var navigationPaletteContext:[\s\S]*memberRecords: memberNavigationRecords\(from: activeBookings\)/);
  assert.match(root, /memberRecords: memberNavigationRecords\(from: activeBookings\)/);
  assert.match(root, /let title = \$0\.title\.trimmingCharacters[\s\S]*return XertNextBookingNavigationContext\(/);
  assert.match(root, /case \.notice\(let noticeID\):[\s\S]*openMemberRoute\(\.notices\(noticeID\), source: \.commandPalette\)/);
  assert.match(root, /case \.classSession\(let sessionID\):[\s\S]*openMemberRoute\(\.classSession\(sessionID\), source: \.commandPalette\)/);
  assert.match(navigation, /case discover = "Available Classes"/);
  assert.match(navigation, /section: \.discover,[\s\S]*action: \.activity\(\.classSession\(record\.id\)\)/);
  assert.match(root, /XertNavigationCommandSection\.allCases/);
  assert.match(root, /Section \{[\s\S]*Text\(section\.rawValue\)/);
  assert.match(root, /\.searchable\(text: \$query/);
  assert.match(root, /keyboardShortcut\("k", modifiers: \.command\)/);
  assert.match(root, /accessibilityAction\(named: "Open XERT quick switcher"/);
  assert.match(root, /Label\("Quick switcher", systemImage: "magnifyingglass"\)/);
  assert.match(root, /selectMemberDestination\(destination, source: \.commandPalette\)/);
  assert.match(root, /DisclosureGroup\("Saved workspaces"[\s\S]*workspaceMap/);
  assert.match(root, /guard store\.profile\?\.isAdmin == true else \{ return \}/);
  assert.match(root, /\.sheet\(isPresented: \$showingNavigationCommands, onDismiss: completeCommandDismissal\)/);
  assert.match(root, /opensAdminAfterCommandDismissal = true[\s\S]*completeCommandDismissal/);
  assert.match(root, /executeNavigationActivity[\s\S]*case \.pendingCheckout:[\s\S]*store\.reconcilePendingCheckout\(\)/);
  assert.match(modelsTests, /testNavigationCommandPaletteIsContextualRoleAwareAndSearchable/);
  assert.match(modelsTests, /testNavigationCommandPalettePromotesLiveMemberActivity/);
  assert.match(modelsTests, /testNavigationMemberRecordIndexIsBoundedRankedAndPrivate/);
  assert.match(modelsTests, /testNavigationCommandPaletteOffersBoundedDirectWorkspaceTimeline/);
  assert.match(modelsTests, /testNavigationWorkspaceMapOrdersAndProtectsRememberedTasks/);
});

test('quick switcher exposes a bounded authorization-aware exact-task timeline', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /case recent = "Workspace History"/);
  assert.match(navigation, /struct XertNavigationTimelineItem: Identifiable, Equatable/);
  assert.match(navigation, /var timeline: \[XertNavigationTimelineItem\]/);
  assert.match(navigation, /routeHistory \+ forwardRouteHistory/);
  assert.match(navigation, /func jump\([\s\S]*toTimelineIndex index: Int/);
  assert.match(navigation, /allowsProtectedRoutes \|\| !routes\[index\]\.requiresAuthentication/);
  assert.match(navigation, /routeHistory = Array\(routes\.prefix\(index \+ 1\)\)/);
  assert.match(navigation, /forwardRouteHistory = Array\(routes\.dropFirst\(index \+ 1\)\)/);
  assert.match(navigation, /private func timelineCommands\([\s\S]*limit: Int = 6/);
  assert.match(navigation, /filter \{ allowsProtectedRoutes \|\| !\$0\.route\.requiresAuthentication \}/);
  assert.match(navigation, /\.prefix\(max\(0, limit\)\)/);
  assert.match(navigation, /section: \.recent,[\s\S]*action: \.timeline\(item\.index\)/);
  assert.match(root, /workspace: navigation\.workspaceOverview/);
  assert.match(root, /case \.timeline\(let index\):[\s\S]*navigation\.jump\(/);
  assert.match(root, /xert-navigation-workspace-overview/);
  assert.match(modelsTests, /testNavigationTimelineJumpsDirectlyWithoutDiscardingForwardTasks/);
  assert.match(modelsTests, /testNavigationTimelineRejectsProtectedJumpsAndCommandsWhenSignedOut/);
});

test('owner command access is role-aware, full-screen, and available through native switching', async () => {
  const [root, navigation, ownerNavigation] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(navigationURL, 'utf8'),
    readFile(ownerNavigationURL, 'utf8'),
  ]);
  assert.match(root, /isAdmin: store\.profile\?\.isAdmin == true/);
  assert.match(navigation, /title: workspace == \.overview \? "Owner Command Centre" : workspace\.title/);
  assert.match(root, /\.fullScreenCover\(isPresented: \$showingAdminCommandCentre\)/);
  assert.match(root, /if store\.profile\?\.isAdmin == true, let ownerAdminStore \{[\s\S]*admin: ownerAdminStore,[\s\S]*requestedRoute: requestedAdminRoute/);
  assert.match(ownerNavigation, /struct XertOwnerRoute: Equatable, Hashable/);
  assert.match(ownerNavigation, /enum XertOwnerNavigationDisposition: Equatable/);
  assert.match(ownerNavigation, /guard isSignedIn else \{ return \.requireAuthentication \}/);
  assert.match(ownerNavigation, /guard isProfileLoaded else \{ return \.waitForProfile \}/);
  assert.match(ownerNavigation, /return isAdmin \? \.open : \.deny/);
  assert.match(ownerNavigation, /url\.host\?\.lowercased\(\) == "owner"/);
  assert.match(ownerNavigation, /url\.path\.lowercased\(\)\.hasPrefix\("\/open\/owner\/"\)/);
  assert.match(root, /if let ownerRoute = XertOwnerRoute\.route\(for: url\)/);
  assert.match(root, /guard store\.profile\?\.isAdmin == true else/);
  assert.match(root, /case \.requireAuthentication:[\s\S]*pendingOwnerNavigation = route[\s\S]*openMemberRoute\(\.account, source: \.deepLink\)/);
  assert.match(root, /case \.waitForProfile:[\s\S]*pendingOwnerNavigation = route/);
  assert.match(root, /resumePendingOwnerNavigation/);
});

test('owner deep links open exact protected native records without weakening workspace scope', async () => {
  const [root, ownerView, ownerNavigation, modelsTests, api, adminStore] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(viewURL('AdminCommandCentreView'), 'utf8'),
    readFile(ownerNavigationURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
    readFile(new URL('../ios/XertFitnessApp/XertFitnessApp/Services/XertAPI.swift', import.meta.url), 'utf8'),
    readFile(new URL('../ios/XertFitnessApp/XertFitnessApp/Store/AdminStore.swift', import.meta.url), 'utf8'),
  ]);

  assert.match(ownerNavigation, /enum XertOwnerTask: Equatable, Hashable, Identifiable/);
  assert.match(ownerNavigation, /case member\(UUID\)/);
  assert.match(ownerNavigation, /case classSetup\(UUID\)/);
  assert.match(ownerNavigation, /case order\(UUID\)/);
  assert.match(ownerNavigation, /case product\(UUID\)/);
  assert.match(ownerNavigation, /case event\(UUID\)/);
  assert.match(ownerNavigation, /case announcement\(UUID\)/);
  assert.match(ownerNavigation, /case ptRequest\(UUID\)/);
  assert.match(ownerNavigation, /case bookingRequest\(AdminBookingRequestSource, UUID\)/);
  assert.match(ownerNavigation, /case \(\.members, "member"\): return \.member\(id\)/);
  assert.match(ownerNavigation, /case \(\.timetable, "class-setup"\): return \.classSetup\(id\)/);
  assert.match(ownerNavigation, /case \(\.orders, "order"\), \(\.finance, "order"\): return \.order\(id\)/);
  assert.match(ownerNavigation, /case \(\.products, "product"\): return \.product\(id\)/);
  assert.match(ownerNavigation, /case \(\.events, "event"\): return \.event\(id\)/);
  assert.match(ownerNavigation, /case \(\.notices, "announcement"\): return \.announcement\(id\)/);
  assert.match(ownerNavigation, /case \(\.ptRequests, "pt-request"\): return \.ptRequest\(id\)/);
  assert.match(ownerNavigation, /case \(\.bookingRequests, "member-booking-request"\): return \.bookingRequest\(\.member, id\)/);
  assert.match(ownerNavigation, /case \(\.bookingRequests, "booking-enquiry"\): return \.bookingRequest\(\.enquiry, id\)/);
  assert.match(ownerNavigation, /parts\.count == 2 \|\| parts\.count == 4/);
  assert.match(root, /@State private var requestedAdminRoute: XertOwnerRoute\?/);
  assert.match(root, /requestedAdminRoute = route[\s\S]*showingAdminCommandCentre = true/);
  assert.match(ownerView, /@State private var presentedOwnerTask: XertOwnerTask\?/);
  assert.match(ownerView, /\.sheet\(item: \$presentedOwnerTask, onDismiss: closePresentedOwnerTask\)/);
  assert.match(ownerView, /AdminOwnerTaskSheet/);
  assert.match(ownerView, /admin\.members\.first\(where: \{ \$0\.id == id \}\)/);
  assert.match(ownerView, /admin\.classSessions\.first\(where: \{ \$0\.id == id \}\)/);
  assert.match(ownerView, /admin\.orders\.first\(where: \{ \$0\.id == id \}\)/);
  assert.match(ownerView, /admin\.products\.first\(where: \{ \$0\.id == id \}\)/);
  assert.match(ownerView, /admin\.events\.first\(where: \{ \$0\.id == id \}\)/);
  assert.match(ownerView, /admin\.announcements\.first\(where: \{ \$0\.id == id \}\)/);
  assert.match(ownerView, /case \.ptRequest\(let id\):[\s\S]*admin\.ptRequests\.first\(where: \{ \$0\.id == id \}\)[\s\S]*AdminPTRequestDetailView/);
  assert.match(ownerView, /case \.bookingRequest\(let source, let id\):[\s\S]*\$0\.source == source && \$0\.routeRecordID == id[\s\S]*AdminBookingRequestDetailView/);
  assert.match(ownerView, /await admin\.resolveOwnerTask\(session: session, task: task\)/);
  assert.match(ownerView, /private func openOwnerRoute\(_ route: XertOwnerRoute[\s\S]*history\.visit\(route\)/);
  assert.match(ownerView, /private func closePresentedOwnerTask\(\)[\s\S]*ownerRouteHistory\.current\.task != nil[\s\S]*openWorkspace\(currentWorkspace\)/);
  assert.ok((ownerView.match(/onOpenTask: \{ openOwnerRoute\(XertOwnerRoute\(task: \$0\)\) \}/g) || []).length >= 5);
  assert.match(ownerView, /Button \{ onOpenTask\(\.member\(member\.id\)\) \}/);
  assert.match(ownerView, /Button \{ onOpenTask\(\.order\(order\.id\)\) \}/);
  assert.match(ownerView, /Button \{ onOpenTask\(\.product\(product\.id\)\) \}/);
  assert.match(ownerView, /Button \{ onOpenTask\(\.event\(event\.id\)\) \}/);
  assert.match(ownerView, /Button \{ openMemberRecord\(member\.id\) \} label:[\s\S]*Member record/);
  assert.match(ownerView, /\.sheet\(item: \$presentedMember\)/);
  assert.doesNotMatch(ownerView, /@State private var selectedOrder: OrderItem\?/);
  assert.match(api, /func adminMember\(session auth: AuthSession, id: UUID\)/);
  assert.match(api, /func adminAnnouncement\(session auth: AuthSession, id: UUID\)/);
  assert.match(api, /p_limit: 1,[\s\S]*p_user_id: id/);
  assert.match(api, /guard rows\.count == 1, rows\[0\]\.id == id/);
  assert.match(adminStore, /func resolveOwnerTask\(session: AuthSession, task: XertOwnerTask\)/);
  assert.match(adminStore, /members\.insert\(member, at: 0\)/);
  assert.match(adminStore, /case \.classSetup\(let sessionID\):[\s\S]*api\.adminClassSessions[\s\S]*classSessions = timetable/);
  assert.match(adminStore, /case \.announcement\(let announcementID\):[\s\S]*api\.adminAnnouncement\([\s\S]*mergeAnnouncement\(announcement\)/);
  assert.match(adminStore, /case \.ptRequest\(let requestID\):[\s\S]*api\.adminPTRequests\(session: session\)[\s\S]*ptRequests = refreshedRequests/);
  assert.match(adminStore, /case \.bookingRequest\(let source, let recordID\):[\s\S]*api\.adminBookingRequests\(session: session\)[\s\S]*bookingRequests = refreshedRequests/);
  assert.match(modelsTests, /testOwnerRecordRoutesRoundTripAndRemainWorkspaceBound/);
  assert.match(modelsTests, /owner\/finance\/member/);
  assert.match(modelsTests, /\.requireAuthentication/);
  assert.match(modelsTests, /\.deny/);
});

test('owner navigation restores exact record routes with back, forward, and v1 migration', async () => {
  const [ownerView, ownerNavigation, modelsTests] = await Promise.all([
    readFile(viewURL('AdminCommandCentreView'), 'utf8'),
    readFile(ownerNavigationURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(ownerNavigation, /struct XertOwnerRouteHistory: Equatable/);
  assert.match(ownerNavigation, /static let maximumCount = 16/);
  assert.match(ownerNavigation, /static let maximumEncodedLength = 2_048/);
  assert.match(ownerNavigation, /private static let restorationVersion = "v2"/);
  assert.match(ownerNavigation, /private static let legacyWorkspaceVersion = "v1"/);
  assert.match(ownerNavigation, /XertOwnerRoute\.restore\(String\(\$0\)\)/);
  assert.match(ownerNavigation, /mutating func visit\(_ route: XertOwnerRoute\)/);
  assert.match(ownerNavigation, /routes = Array\(routes\.prefix\(currentIndex \+ 1\)\) \+ \[route\]/);
  assert.match(ownerNavigation, /mutating func goBack\(\) -> XertOwnerRoute\?/);
  assert.match(ownerNavigation, /mutating func goForward\(\) -> XertOwnerRoute\?/);
  assert.match(ownerView, /@SceneStorage\("xert\.adminWorkspaceHistory"\)/);
  assert.match(ownerView, /@SceneStorage\("xert\.adminNavigationUserID"\)/);
  assert.match(ownerView, /private var ownerRouteHistory: XertOwnerRouteHistory/);
  assert.match(ownerView, /previousTitle: isAvailable \? ownerRouteHistory\.previous\?\.navigationTitle/);
  assert.match(ownerView, /nextTitle: isAvailable \? ownerRouteHistory\.next\?\.navigationTitle/);
  assert.match(ownerView, /applyOwnerRoute\(ownerRouteHistory\.current\)/);
  assert.match(ownerView, /let userID = session\.user\?\.id[\s\S]*prepareOwnerNavigation\(for: userID\)/);
  assert.match(ownerView, /private func prepareOwnerNavigation\(for userID: UUID\)[\s\S]*restoredNavigationUserID != accountID[\s\S]*restoredWorkspaceHistory = ""[\s\S]*presentedOwnerTask = nil/);
  assert.match(ownerView, /onChange\(of: store\.authSession\?\.user\?\.id\)[\s\S]*prepareOwnerNavigation\(for: userID\)/);
  assert.match(ownerView, /pendingCompactPathWorkspace/);
  assert.match(ownerView, /private func returnToPreviousOwnerRoute\(\)/);
  assert.match(ownerView, /private func advanceToNextOwnerRoute\(\)/);
  assert.match(ownerView, /keyboardShortcut\("\[", modifiers: \.command\)/);
  assert.match(ownerView, /keyboardShortcut\("\]", modifiers: \.command\)/);
  assert.match(ownerView, /\.accessibilityLabel\(ownerActionsAccessibilityLabel\)/);
  assert.match(ownerView, /if admin\.isLoading \{ return "Owner actions, refreshing" \}/);
  assert.match(ownerView, /data service"[\s\S]*needs attention/);
  assert.match(ownerView, /workspace == current \? "checkmark" : "chevron\.right"/);
  assert.match(modelsTests, /testOwnerRouteHistoryPreservesExactTasksForwardStateAndMigration/);
  assert.match(modelsTests, /v1\|1\|members,finance/);
  assert.match(modelsTests, /XertOwnerRouteHistory\.maximumEncodedLength \+ 1/);
});

test('owner command search ranks bounded exact records without replacing workspace data', async () => {
  const [ownerView, ownerNavigation, adminStore, modelsTests] = await Promise.all([
    readFile(viewURL('AdminCommandCentreView'), 'utf8'),
    readFile(ownerNavigationURL, 'utf8'),
    readFile(new URL('../ios/XertFitnessApp/XertFitnessApp/Store/AdminStore.swift', import.meta.url), 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);

  assert.match(ownerNavigation, /enum XertOwnerRecordKind: String, CaseIterable, Identifiable/);
  assert.match(ownerNavigation, /struct XertOwnerRecordCommand: Identifiable, Equatable/);
  assert.match(ownerNavigation, /enum XertOwnerCommandIndex/);
  assert.match(ownerNavigation, /static let maximumResultsPerKind = 8/);
  assert.match(ownerNavigation, /if identifiers\.contains\(query\) \{ return 0 \}/);
  assert.match(ownerNavigation, /if title\.hasPrefix\(query\) \{ return 2 \}/);
  assert.match(ownerNavigation, /\.prefix\(maximumResultsPerKind\)/);

  assert.match(adminStore, /@Published private\(set\) var ownerMemberSearchResults: \[AdminMemberSummary\] = \[\]/);
  assert.match(adminStore, /private var ownerMemberSearchGeneration: UInt = 0/);
  assert.match(adminStore, /func searchOwnerMembers\(session: AuthSession, query: String\) async/);
  assert.match(adminStore, /ownerMemberSearchGeneration &\+= 1/);
  assert.match(adminStore, /limit: XertOwnerCommandIndex\.maximumResultsPerKind/);
  assert.match(adminStore, /guard generation == ownerMemberSearchGeneration else \{ return \}/);
  const ownerSearch = adminStore.slice(
    adminStore.indexOf('func searchOwnerMembers'),
    adminStore.indexOf('func resetOwnerMemberSearch'),
  );
  assert.doesNotMatch(ownerSearch, /members =/);

  assert.match(ownerView, /private struct AdminWorkspaceSwitcher:[\s\S]*@ObservedObject var admin: AdminStore/);
  assert.match(ownerView, /XertOwnerCommandIndex\.matches\([\s\S]*admin\.ownerMemberSearchResults[\s\S]*admin\.orders[\s\S]*admin\.products[\s\S]*admin\.events[\s\S]*admin\.bookingRequests[\s\S]*admin\.ptRequests/);
  assert.match(ownerNavigation, /case bookingRequest = "Booking Requests"/);
  assert.match(ownerNavigation, /case ptRequest = "PT Enquiries"/);
  assert.match(ownerNavigation, /bookingRequests\.compactMap\(bookingRequestCandidate\)/);
  assert.match(ownerNavigation, /ptRequests\.map\(ptRequestCandidate\)/);
  assert.match(ownerNavigation, /route: XertOwnerRoute\(task: \.bookingRequest\(booking\.source, recordID\)\)/);
  assert.match(ownerNavigation, /route: XertOwnerRoute\(task: \.ptRequest\(request\.id\)\)/);
  assert.match(ownerView, /ForEach\(XertOwnerRecordKind\.allCases\)/);
  assert.match(ownerView, /Button \{ onOpenRoute\(record\.route\) \}/);
  assert.match(ownerView, /\.task\(id: normalizedQuery\)[\s\S]*Task\.sleep\(nanoseconds: 300_000_000\)[\s\S]*searchOwnerMembers/);
  assert.match(ownerView, /\.onDisappear \{ admin\.resetOwnerMemberSearch\(\) \}/);
  assert.match(modelsTests, /testOwnerCommandIndexRanksAndBoundsProtectedBusinessRecords/);
  assert.match(modelsTests, /XertOwnerCommandIndex\.maximumResultsPerKind \+ 3/);
});

test('owner favorites are account-scoped and every overview shortcut uses the central router', async () => {
  const [ownerNavigation, ownerView, modelsTests, design] = await Promise.all([
    readFile(ownerNavigationURL, 'utf8'),
    readFile(viewURL('AdminCommandCentreView'), 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
    readFile(new URL('../ios/XertFitnessApp/XertFitnessApp/AdminDesignSystem.swift', import.meta.url), 'utf8'),
  ]);
  assert.match(ownerNavigation, /struct XertOwnerWorkspacePinsSnapshot: Codable, Equatable/);
  assert.match(ownerNavigation, /static let maximumWorkspaceCount = 6/);
  assert.match(ownerNavigation, /keyPrefix = "xert\.owner-navigation\.pins\.v1\."/);
  assert.match(ownerNavigation, /enum XertOwnerWorkspacePinsStore/);
  assert.match(ownerNavigation, /guard workspace != \.overview/);
  assert.match(ownerNavigation, /Set\(workspaces\)\.count == workspaces\.count/);
  assert.match(ownerView, /@State private var pinnedWorkspaces: \[XertOwnerWorkspace\] = \[\]/);
  assert.match(ownerView, /XertOwnerWorkspacePinsStore\.load\([\s\S]*authorizedOwnerSession\?\.user\?\.id/);
  assert.match(ownerView, /XertOwnerWorkspacePinsStore\.toggle\(workspace, for: userID\)/);
  assert.match(ownerView, /Section\("Pinned"\)/);
  assert.match(ownerView, /adminHeading\("Pinned Workspaces"\)/);
  assert.match(ownerView, /workspaceSection\("Pinned", workspaces: matchingPinned\)/);
  assert.match(ownerView, /pinned\.contains\(workspace\) \? "pin\.fill" : "pin"/);
  assert.match(ownerView, /accessibilityHint\("Updates your owner workspace shortcuts"\)/);
  assert.match(ownerView, /private struct AdminDestinationRow: View[\s\S]*let onOpen: \(\) -> Void[\s\S]*XertOwnerRow\(title: title, detail: detail, icon: icon, onOpen: onOpen\)/);
  assert.match(design, /struct XertOwnerRow: View[\s\S]*var onOpen: \(\) -> Void[\s\S]*XertNavigationRow\(title: title, detail: detail, icon: icon, onOpen: onOpen\)/);
  const controls = await readFile(new URL('../ios/XertFitnessApp/XertFitnessApp/XertDesignControls.swift', import.meta.url), 'utf8');
  assert.match(controls, /struct XertNavigationRow: View[\s\S]*Button \{[\s\S]*onOpen\(\)/);
  assert.doesNotMatch(controls, /NavigationLink\(/, 'the kit delegates navigation to the existing central router');
  assert.doesNotMatch(ownerView, /NavigationLink\(value: workspace\)/);
  assert.match(ownerView, /AdminDestinationRow\([\s\S]*onOpen: \{ openWorkspaceWithFeedback\(workspace\) \}/);
  assert.match(modelsTests, /testOwnerWorkspacePinsAreBoundedStrictAndAccountScoped/);
});

test('scene commands follow the active member or owner navigation scope', async () => {
  const [root, ownerView, sceneCommands] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(viewURL('AdminCommandCentreView'), 'utf8'),
    readFile(sceneCommandsURL, 'utf8'),
  ]);
  assert.match(sceneCommands, /enum XertSceneNavigationScope: Equatable/);
  assert.match(sceneCommands, /case member\(XertPrimaryDestination\)/);
  assert.match(sceneCommands, /case owner\(XertOwnerWorkspace\)/);
  assert.match(sceneCommands, /case ownerWorkspace\(XertOwnerWorkspace\)/);
  assert.match(sceneCommands, /if let ownerSelection \{[\s\S]*ownerCommands\(selection: ownerSelection\)[\s\S]*else \{[\s\S]*memberCommands/);
  assert.match(sceneCommands, /Button\("Owner Workspace Switcher"[\s\S]*keyboardShortcut\("k", modifiers: \.command\)/);
  assert.match(sceneCommands, /historyCommands\(taskNoun: "Workspace"\)/);
  assert.match(sceneCommands, /Button\("Refresh Owner Workspace"[\s\S]*keyboardShortcut\("r", modifiers: \.command\)/);
  assert.match(sceneCommands, /Menu\("Open Owner Workspace", systemImage: "square\.grid\.2x2"\)/);
  assert.match(sceneCommands, /XertOwnerWorkspace\.workspaces\(in: section\)/);
  assert.match(sceneCommands, /Button\("Close Owner Command Centre", systemImage: "xmark"\)/);
  assert.match(root, /scope: \.member\(isAvailable \? navigation\.selection : \.home\)/);
  assert.match(ownerView, /\.focusedSceneValue\(\\\.xertNavigationCommandContext, ownerNavigationCommandContext\)/);
  assert.match(ownerView, /scope: \.owner\(currentWorkspace\)/);
  assert.match(ownerView, /private func executeOwnerSceneNavigationCommand/);
  assert.match(ownerView, /case \.ownerWorkspace\(let workspace\):[\s\S]*openWorkspace\(workspace\)/);
  assert.match(ownerView, /case \.refresh:[\s\S]*admin\.refresh\(session: session\)/);
  assert.match(ownerView, /case \.closeOwner:\s*requestOwnerExit\(\.close\)/);
});

test('navigation carries operational state and native interaction feedback', async () => {
  const [root, navigation, modelsTests, haptics] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(navigationURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
    readFile(hapticsURL, 'utf8'),
  ]);
  assert.match(root, /noticeCount: store\.announcements\.count/);
  assert.match(root, /let activeBookings = activeUpcomingBookings/);
  assert.match(root, /bookingCount: activeBookings\.count/);
  assert.match(root, /nextBooking: nextBookingNavigationContext\(from: activeBookings\)/);
  assert.match(root, /creditCount: store\.creditTotal/);
  assert.match(root, /eventGoalCount: store\.eventGoalIDs\.count/);
  assert.match(root, /hasPendingCheckout: store\.isCheckoutConfirmationPending \|\| store\.isReconcilingCheckout/);
  assert.match(root, /XertHaptics\.play\(\.selection\)/);
  assert.doesNotMatch(root, /UISelectionFeedbackGenerator/);
  assert.match(haptics, /private static let selectionGenerator = UISelectionFeedbackGenerator\(\)/);
  assert.match(haptics, /selectionGenerator\.prepare\(\)/);
  assert.match(root, /matchedGeometryEffect\(id: "primary-navigation-selection"/);
  assert.match(root, /dynamicTypeSize\.isAccessibilitySize[\s\S]*LazyVGrid/);
  assert.match(root, /activeUpcomingBookings[\s\S]*let now = Date\(\)[\s\S]*isActiveClassPlace[\s\S]*start_time >= now/);
  assert.match(root, /guard selection != item else \{[\s\S]*onReselect\(item\)/);
  assert.match(root, /handleReselection[\s\S]*store\.refresh\(\)/);
  assert.match(root, /DragGesture\(minimumDistance: 36\)/);
  assert.match(root, /abs\(horizontal\) > 44[\s\S]*abs\(vertical\) \* 1\.35/);
  assert.match(root, /navigation\.step\([\s\S]*direction,[\s\S]*order: memberWorkspaceOrder,[\s\S]*allowsProtectedRoutes: store\.isSignedIn/);
  assert.match(root, /previousRoute: navigation\.previousRoute/);
  assert.match(root, /navigation\.returnToPrevious\(\)/);
  assert.match(root, /\.accessibilityActions \{/);
  assert.ok(root.includes('Button("Return to \\(previousRoute.navigationTitle)"'));
  assert.ok(root.includes('Label("Refresh \\(item.title)", systemImage: "arrow.clockwise")'));
  assert.ok(root.includes('Label("Return to \\(previousRoute.navigationTitle)", systemImage: "arrow.uturn.backward")'));
  assert.match(root, /@Environment\(\\\.accessibilityReduceMotion\) private var reduceMotion/);
  assert.match(root, /withAnimation\(reduceMotion \? nil : \.easeOut/);
  assert.match(navigation, /active member notices/);
  assert.match(root, /Refreshes this workspace/);
  assert.match(navigation, /struct XertNavigationStatusSnapshot: Equatable/);
  assert.match(navigation, /self\.nextBooking = isSignedIn \? nextBooking : nil/);
  assert.match(navigation, /destination: \.booking,[\s\S]*kind: \.attention,[\s\S]*Purchase confirmation needs attention/);
  assert.match(navigation, /var priorityStatus: XertNavigationStatus\?/);
  assert.match(navigation, /statuses\.min \{ \$0\.priority < \$1\.priority \}/);
  assert.match(navigation, /activity: \.notices/);
  assert.match(navigation, /activity: \.pendingCheckout/);
  assert.match(navigation, /activity: \.eventGoals/);
  assert.match(navigation, /activity: \.upcomingBookings\(nextBooking\?\.id\)/);
  assert.match(navigation, /destination: \.events,[\s\S]*selected event goals/);
  assert.match(navigation, /destination: \.account,[\s\S]*upcoming bookings/);
  assert.match(root, /nextBookingNavigationContext[\s\S]*\.min \{ \$0\.start_time < \$1\.start_time \}/);
  assert.match(root, /openMemberRoute\(\.upcomingBookings\(bookingID\), source: \.commandPalette\)/);
  assert.match(modelsTests, /priorityStatus\?\.activity, \.upcomingBookings\(bookingID\)/);
  assert.match(root, /statusSnapshot: XertNavigationStatusSnapshot\(context: navigationStatusContext\)/);
  assert.ok((root.match(/let statusSnapshot: XertNavigationStatusSnapshot/g) || []).length === 2);
  assert.match(root, /XertNavigationStatusBadge\(status: status\)/);
  assert.match(root, /private struct XertNavigationStatusControl: View/);
  assert.equal((root.match(/status: statusSnapshot\.priorityStatus/g) || []).length, 1);
  assert.match(root, /if let status \{[\s\S]*Button\(status\.actionTitle\) \{ onOpenStatus\(status\) \}/);
  assert.match(root, /onOpenStatus: executeNavigationStatus/);
  assert.match(root, /executeNavigationStatus[\s\S]*executeNavigationActivity\(status\.activity\)/);
  assert.match(root, /xert-navigation-priority-status/);
  assert.match(root, /Button\(status\.actionTitle\) \{ onOpenStatus\(status\) \}/);
  assert.match(root, /status\.kind == \.attention \? Color\.orange : Color\.xertPale/);
  assert.match(modelsTests, /testNavigationStatusSignalsRouteToTheirOwningWorkspaces/);
  assert.match(root, /openMemberRoute\(\.purchaseConfirmation, source: \.checkout\)/);
  assert.match(root, /openMemberRoute\(route, source: \.deepLink\)/);
  assert.match(root, /source: \.pushNotification/);
});

test('quick switcher persists bounded account-scoped pinned workspaces without transient identities', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /struct XertPinnedWorkspaceSnapshot: Codable, Equatable/);
  assert.match(navigation, /static let maximumRouteCount = 6/);
  assert.match(navigation, /enum XertPinnedWorkspaceStore/);
  assert.match(navigation, /keyPrefix = "xert\.navigation\.pins\.v1\."/);
  assert.match(navigation, /case \.notices\(_\): return \.notices\(nil\)/);
  assert.match(navigation, /case \.upcomingBookings\(_\): return \.upcomingBookings\(nil\)/);
  assert.match(navigation, /case \.classSession\(_\), \.purchaseConfirmation: return nil/);
  assert.match(navigation, /case pinned\(XertMemberRoute\)/);
  assert.match(navigation, /case pinned = "Pinned Workspaces"/);
  assert.match(navigation, /allowsProtectedRoutes \|\| !\$0\.requiresAuthentication/);
  assert.match(root, /pinnedRoutes: pinnedMemberRoutes/);
  assert.match(root, /case \.pinned\(let route\):[\s\S]*openMemberRoute\(route, source: \.commandPalette\)/);
  assert.match(root, /xert-navigation-pin-current/);
  assert.match(root, /Label\("Unpin", systemImage: "pin\.slash"\)/);
  assert.ok((root.match(/pinnedRoutes: pinnedMemberRoutes/g) || []).length >= 3);
  assert.match(root, /private struct XertPinnedWorkspaceBadge: View/);
  assert.equal((root.match(/contextMenu \{ pinnedWorkspaceMenu \}/g) || []).length, 1);
  assert.match(root, /Button\(action: \{ onOpenPinned\(route\) \}\)/);
  assert.match(modelsTests, /testPinnedWorkspacesAreBoundedNormalizedAndAccountScoped/);
  assert.match(modelsTests, /testPinnedWorkspaceCommandsAreDirectAndAuthorizationAware/);
});

test('navigation history preserves exact member tasks instead of flattening them to tabs', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /private\(set\) var routeHistory: \[XertMemberRoute\]/);
  assert.match(navigation, /var previousRoute: XertMemberRoute\?/);
  assert.match(navigation, /routeHistory\.append\(targetRoute\)/);
  assert.match(navigation, /guard let targetRoute = routeHistory\.last/);
  assert.match(navigation, /route = targetRoute/);
  assert.ok(navigation.includes('Back to \\(previousRoute.navigationTitle)'));
  assert.match(root, /previousRoute: navigation\.previousRoute/);
  assert.match(modelsTests, /testNavigationHistoryReturnsToExactTasksAcrossAndWithinTabs/);
});

test('each native workspace preserves and restores its own exact task', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /private\(set\) var workspaceRoutes: \[XertPrimaryDestination: XertMemberRoute\]/);
  assert.match(navigation, /func rememberedRoute\(for destination: XertPrimaryDestination\)/);
  assert.match(navigation, /func select\([\s\S]*allowsProtectedRoutes: Bool = true[\s\S]*return open\(targetRoute, source: source\)/);
  assert.match(navigation, /workspaceRouteValues: \[String\]\?/);
  assert.match(navigation, /workspaceRoutes: XertPrimaryDestination\.dockOrder\.compactMap/);
  assert.match(navigation, /Set\(restoredWorkspaceRoutes\.map\(\\\.destination\)\)\.count == restoredWorkspaceRoutes\.count/);
  assert.match(navigation, /workspaceRouteValues\?\.count[\s\S]*== XertNavigationWorkspaceSnapshot\.maximumWorkspaceRouteCount/);
  assert.match(navigation, /restoredWorkspaceRoutes\.filter \{ !\$0\.requiresAuthentication \}/);
  assert.match(root, /allowsProtectedRoutes: store\.isSignedIn/);
  assert.ok(navigation.includes('"Return to \\(rememberedRoute.navigationTitle)"'));
  assert.match(modelsTests, /testNavigationRemembersTheExactTaskInEveryWorkspace/);
  assert.match(modelsTests, /testNavigationWorkspaceRestoresIndependentTasksAndFiltersPrivateMemory/);
});

test('sign-out clears exact-task history before another member can inherit it', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /var containsContextualHistory: Bool/);
  assert.match(navigation, /routeHistory\.contains \{ \$0\.isContextualTask \}/);
  assert.match(navigation, /forwardRouteHistory\.contains \{ \$0\.isContextualTask \}/);
  assert.match(navigation, /var containsProtectedHistory: Bool/);
  assert.match(navigation, /routeHistory\.contains \{ \$0\.requiresAuthentication \}/);
  assert.match(navigation, /forwardRouteHistory\.contains \{ \$0\.requiresAuthentication \}/);
  assert.match(root, /guard isSignedIn else \{[\s\S]*resetMemberNavigationAfterSignOut\(clearPendingIntent: true\)/);
  assert.match(root, /guard hasBootstrapped else \{ return \}[\s\S]*!store\.isSignedIn, navigation\.containsProtectedHistory/);
  assert.match(root, /resetMemberNavigationAfterSignOut\(clearPendingIntent: true\)/);
  assert.match(root, /resetMemberNavigationAfterSignOut\(clearPendingIntent: Bool\)[\s\S]*navigation\.restore\(routeValue: home\.restorationValue\)/);
  assert.match(root, /restoredMemberWorkspace = navigation\.workspaceRestorationValue/);
  assert.match(modelsTests, /testNavigationIdentifiesPrivateContextAcrossBackAndForwardHistory/);
});

test('external native navigation defers private member tasks until authentication', async () => {
  const [root, navigation, account, modelsTests] = await Promise.all([
    readFile(rootURL, 'utf8'),
    readFile(navigationURL, 'utf8'),
    readFile(viewURL('AccountView'), 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /var requiresAuthentication: Bool/);
  assert.match(navigation, /case \.notices\(_\), \.purchaseConfirmation, \.eventGoals, \.upcomingBookings\(_\):[\s\S]*return true/);
  assert.match(navigation, /struct XertNavigationIntent: Equatable/);
  assert.match(navigation, /route\.requiresAuthentication && !isSignedIn \? \.requireAuthentication : \.open/);
  assert.match(root, /@State private var pendingProtectedNavigation: XertNavigationIntent\?/);
  assert.match(root, /private func openMemberRoute\([\s\S]*intent\.disposition\(isSignedIn: store\.isSignedIn\) == \.open/);
  assert.match(root, /pendingProtectedNavigation = intent[\s\S]*navigation\.open\(\.account, source: source\)/);
  assert.match(root, /resumePendingProtectedNavigation\(\)[\s\S]*lockAndAuthenticate\(\)/);
  assert.match(root, /onContinueUserActivity[\s\S]*openMemberRoute\(route, source: \.handoff\)/);
  assert.match(root, /consumePendingQuickActionRoute[\s\S]*openMemberRoute\(route, source: \.quickAction\)/);
  assert.match(root, /guard store\.isSignedIn else \{[\s\S]*navigation\.open\(\.account, source: \.checkout\)/);
  assert.match(root, /processPendingCheckoutCallbackIfReady[\s\S]*store\.reconcileCheckout\([\s\S]*callbackSessionID: checkoutSessionID/);
  assert.match(root, /AccountView\([\s\S]*pendingNavigationTitle: pendingProtectedNavigation\?\.route\.navigationTitle/);
  assert.match(root, /private func selectMemberDestination\([\s\S]*guard navigation\.select\([\s\S]*allowsProtectedRoutes: store\.isSignedIn[\s\S]*else \{ return \}[\s\S]*cancelPendingProtectedNavigation\(\)/);
  assert.match(root, /handleNavigationStep[\s\S]*guard navigation\.step\([\s\S]*allowsProtectedRoutes: store\.isSignedIn[\s\S]*else \{ return \}[\s\S]*cancelPendingProtectedNavigation\(\)/);
  assert.match(root, /returnToPreviousNavigationDestination[\s\S]*guard navigation\.returnToPrevious\(\) else \{ return \}[\s\S]*cancelPendingProtectedNavigation\(\)/);
  assert.match(root, /case \.destination\(let destination\):[\s\S]*selectMemberDestination\(destination, source: \.keyboard\)/);
  assert.match(account, /let pendingNavigationTitle: String\?/);
  assert.match(account, /if let pendingNavigationTitle[\s\S]*pendingNavigationPrompt\(pendingNavigationTitle\)/);
  assert.match(account, /Text\("Sign in to continue"\)/);
  assert.match(account, /Button\(action: onCancelPendingNavigation\)/);
  assert.ok(account.includes('accessibilityLabel("Cancel opening \\(title)")'));
  assert.match(modelsTests, /testNavigationIntentsDeferOnlyMemberPrivateRoutesUntilAuthentication/);
});

test('scene restoration preserves a bounded versioned exact-task workspace', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /struct XertNavigationWorkspaceSnapshot: Codable, Equatable/);
  assert.match(navigation, /maximumEncodedLength = 4_096/);
  assert.match(navigation, /maximumRouteCount = 32/);
  assert.match(navigation, /var workspaceRestorationValue: String/);
  assert.match(navigation, /func restore\([\s\S]*workspaceValue: String,[\s\S]*fallbackRouteValue: String,[\s\S]*allowsProtectedRoutes: Bool = true/);
  assert.match(navigation, /XertNavigationWorkspaceSnapshot\.legacyVersion,[\s\S]*XertNavigationWorkspaceSnapshot\.currentVersion/);
  assert.match(navigation, /restoredRoutes\.count == snapshot\.routeValues\.count/);
  assert.match(navigation, /authorizedForwardRoutes\.prefix\(max\(0, historyLimit - 1\)\)/);
  assert.match(navigation, /backwardCapacity = max\(1, historyLimit - boundedForwardRoutes\.count\)/);
  assert.match(navigation, /authorizedRoutes\.suffix\(backwardCapacity\)/);
  assert.match(root, /@SceneStorage\("xert\.memberWorkspace"\)/);
  assert.match(root, /restoreMemberWorkspaceWhenReady\(\)/);
  assert.match(root, /guard store\.hasBootstrapped, !hasRestoredMemberWorkspace else \{ return \}/);
  assert.match(root, /guard !hasExplicitMemberNavigation else \{ return \}/);
  assert.match(root, /navigation\.restore\([\s\S]*workspaceValue: restoredMemberWorkspace,[\s\S]*fallbackRouteValue: restoredMemberRoute,[\s\S]*allowsProtectedRoutes: store\.isSignedIn/);
  assert.match(root, /claimMemberNavigation\(\)/);
  assert.match(root, /restoredMemberWorkspace = navigation\.workspaceRestorationValue/);
  assert.match(modelsTests, /testNavigationWorkspaceRestoresBoundedExactTaskHistory/);
  assert.match(modelsTests, /testNavigationWorkspaceRejectsMalformedPartialAndFutureSnapshots/);
  assert.match(modelsTests, /testNavigationWorkspaceFiltersProtectedTasksUntilAuthentication/);
  assert.match(navigation, /var containsProtectedHistory: Bool/);
  assert.match(navigation, /restoredRoutes\.filter \{ !\$0\.requiresAuthentication \}/);
  assert.match(navigation, /authorizedFallback/);
});

test('native route portability shares public context without private member task identity', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /struct XertRouteShareDestination: Equatable/);
  assert.match(navigation, /var shareDestination: XertRouteShareDestination\?/);
  assert.match(navigation, /case \.notices\(_\):[\s\S]*route: \.home, isExactTask: false/);
  assert.match(navigation, /case \.purchaseConfirmation:[\s\S]*route: \.sessionPacks, isExactTask: false/);
  assert.match(navigation, /case \.eventGoals:[\s\S]*route: \.events, isExactTask: false/);
  assert.match(navigation, /case \.upcomingBookings\(_\):[\s\S]*route: \.booking, isExactTask: false/);
  assert.match(navigation, /case \.account:[\s\S]*return nil/);
  assert.match(root, /XertNavigationShareControl\(route: currentRoute, layout: \.rail\)/);
  assert.doesNotMatch(root, /XertNavigationShareControl\(route: currentRoute, layout: \.compact\)/);
  assert.match(root, /ShareLink\(item: destination\.route\.webURL/);
  assert.match(root, /xert-navigation-share-private/);
  assert.match(root, /Private account tasks cannot be shared/);
  assert.match(modelsTests, /testRouteSharingNeverExportsPrivateMemberTaskIdentity/);
});

test('native task history supports bounded back and forward traversal', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /let forwardRouteValues: \[String\]\?/);
  assert.match(navigation, /private\(set\) var forwardRouteHistory: \[XertMemberRoute\] = \[\]/);
  assert.match(navigation, /var nextRoute: XertMemberRoute\?/);
  assert.match(navigation, /func returnToNext\(source: XertNavigationSource = \.history\) -> Bool/);
  assert.match(navigation, /forwardRouteHistory\.insert\(departedRoute, at: 0\)/);
  assert.match(navigation, /let targetRoute = forwardRouteHistory\.removeFirst\(\)/);
  assert.match(navigation, /forwardRouteHistory = \[\][\s\S]*routeHistory\.append\(targetRoute\)/);
  assert.ok(navigation.includes('Forward to \\(nextRoute.navigationTitle)'));
  assert.match(root, /nextRoute: navigation\.nextRoute/);
  assert.match(root, /navigation\.returnToNext\(\)/);
  assert.match(root, /keyboardShortcut\("\]", modifiers: \.command\)/);
  assert.match(root, /xert-navigation-forward-history/);
  assert.match(modelsTests, /testNavigationHistorySupportsForwardTraversalAndClearsAfterBranching/);
  assert.match(modelsTests, /testNavigationWorkspaceRestoresExactForwardTaskHistory/);
});

test('members can persist and operate a bounded account-scoped workspace order', async () => {
  const [navigation, root, modelsTests] = await Promise.all([
    readFile(navigationURL, 'utf8'),
    readFile(rootURL, 'utf8'),
    readFile(modelsTestsURL, 'utf8'),
  ]);
  assert.match(navigation, /struct XertWorkspaceOrderSnapshot: Codable, Equatable/);
  assert.match(navigation, /maximumEncodedLength = 256/);
  assert.match(navigation, /enum XertWorkspaceOrderStore/);
  assert.match(navigation, /keyPrefix = "xert\.navigation\.workspace-order\.v1\."/);
  assert.match(navigation, /snapshot\.destinationRawValues\.count == XertPrimaryDestination\.dockOrder\.count/);
  assert.match(navigation, /Set\(destinations\) == Set\(XertPrimaryDestination\.dockOrder\)/);
  assert.match(navigation, /func step\([\s\S]*order: \[XertPrimaryDestination\] = XertPrimaryDestination\.dockOrder/);
  assert.match(navigation, /XertWorkspaceOrderStore\.normalized\(orderedDestinations\)/);
  assert.match(root, /@State private var memberWorkspaceOrder = XertPrimaryDestination\.dockOrder/);
  assert.ok((root.match(/items: memberWorkspaceOrder/g) || []).length === 2);
  assert.match(root, /reloadMemberWorkspaceOrder\(\)/);
  assert.match(root, /XertWorkspaceOrderStore\.save\(destinations, for: userID\)/);
  assert.match(root, /private struct XertWorkspaceOrderEditor: View/);
  assert.match(root, /\.onMove\(perform: moveDestinations\)/);
  assert.match(root, /xert-navigation-customize/);
  assert.match(modelsTests, /testWorkspaceOrderIsCompleteAccountScopedAndDrivesNavigation/);
});
