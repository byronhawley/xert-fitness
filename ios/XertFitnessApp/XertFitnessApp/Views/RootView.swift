import SwiftUI
import UIKit

private enum CheckoutURLSource: Equatable {
    case external
    case authenticatedBrowser
}

struct RootView: View {
    @EnvironmentObject private var store: XertStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage(AppPrivacyLock.preferenceKey) private var privacyLockEnabled = false
    @SceneStorage("xert.memberRoute") private var restoredMemberRoute = XertMemberRoute.home.restorationValue
    @SceneStorage("xert.memberWorkspace") private var restoredMemberWorkspace = ""
    @SceneStorage("xert.adminWorkspace") private var restoredAdminWorkspace = XertOwnerWorkspace.overview.rawValue
    @SceneStorage("xert.adminRecentWorkspaces") private var restoredAdminRecentWorkspaces = ""
    @SceneStorage("xert.adminWorkspaceHistory") private var restoredAdminWorkspaceHistory = ""
    @SceneStorage("xert.adminNavigationUserID") private var restoredAdminNavigationUserID = ""
    @StateObject private var navigation = XertNavigationCoordinator()
    @StateObject private var ownerNavigationPulse = XertOwnerNavigationPulseStore()
    @StateObject private var staffRoster = StaffRosterStore()
    @State private var checkoutReturnStatus: CheckoutReturnStatus?
    @State private var pendingCheckoutCallback: CheckoutCallback?
    @State private var isProcessingCheckoutCallback = false
    @State private var isPrivacyUnlocked = false
    @State private var isUnlocking = false
    @State private var privacyLockError: String?
    @State private var showingAdminCommandCentre = false
    @State private var requestedAdminRoute: XertOwnerRoute?
    @State private var ownerAdminStore: AdminStore?
    @State private var ownerAdminStoreUserID: UUID?
    @State private var showingNavigationCommands = false
    @State private var opensAdminAfterCommandDismissal = false
    @State private var pendingProtectedNavigation: XertNavigationIntent?
    @State private var firstClassActivation: XertFirstClassActivation?
    @State private var pendingOwnerNavigation: XertOwnerRoute?
    @State private var hasRestoredMemberWorkspace = false
    @State private var hasExplicitMemberNavigation = false
    @State private var pinnedMemberRoutes: [XertMemberRoute] = []
    @State private var memberWorkspaceOrder = XertPrimaryDestination.dockOrder

    var body: some View {
        ZStack {
            memberTabs
                .allowsHitTesting(!isPrivacyLocked)
                .accessibilityHidden(isPrivacyLocked)
            if isPrivacyLocked {
                PrivacyLockView(
                    isUnlocking: isUnlocking,
                    errorMessage: privacyLockError,
                    protectsOwnerTools: protectsOwnerTools,
                    onUnlock: { Task { await unlockApp() } },
                    onSignOut: signOutFromLock
                )
                .zIndex(10)
            }
        }
        .focusedSceneValue(\.xertNavigationCommandContext, navigationCommandContext)
        .onChange(of: scenePhase, perform: handleScenePhase)
        .onChange(of: store.isSignedIn) { isSignedIn in
            guard isSignedIn else {
                ownerNavigationPulse.reset()
                staffRoster.reset()
                StaffRosterPushNavigation.clearPending()
                showingAdminCommandCentre = false
                ownerAdminStore = nil
                ownerAdminStoreUserID = nil
                pinnedMemberRoutes = []
                memberWorkspaceOrder = XertPrimaryDestination.dockOrder
                isPrivacyUnlocked = true
                privacyLockError = nil
                pendingOwnerNavigation = nil
                requestedAdminRoute = nil
                resetMemberNavigationAfterSignOut(clearPendingIntent: true)
                return
            }
            resumePendingProtectedNavigation()
            resumePendingOwnerNavigation()
            processPendingCheckoutCallbackIfReady()
            guard privacyLockEnabled else {
                isPrivacyUnlocked = true
                privacyLockError = nil
                return
            }
            lockAndAuthenticate()
        }
        .onChange(of: store.authenticationRecoveryRequired) { isRequired in
            guard isRequired else { return }
            navigation.open(.account, source: .content)
            store.consumeAuthenticationRecovery()
        }
        .onChange(of: store.checkoutActivatedSessionID) { sessionID in
            guard sessionID != nil else { return }
            resumeFirstClassAfterCheckout()
        }
        .onChange(of: store.profile?.role) { _ in
            if store.profile?.isAdmin != true {
                showingAdminCommandCentre = false
                requestedAdminRoute = nil
                ownerAdminStore = nil
                ownerAdminStoreUserID = nil
            }
            resumePendingOwnerNavigation()
            refreshOwnerNavigationPulse()
        }
        .onChange(of: showingAdminCommandCentre) { isPresented in
            guard !isPresented else { return }
            requestedAdminRoute = nil
            refreshOwnerNavigationPulse(force: true)
        }
        .onChange(of: store.hasBootstrapped) { hasBootstrapped in
            guard hasBootstrapped else { return }
            restoreMemberWorkspaceWhenReady()
            refreshOwnerNavigationPulse()
            processPendingCheckoutCallbackIfReady()
            if !store.isSignedIn, navigation.containsProtectedHistory {
                resetMemberNavigationAfterSignOut(clearPendingIntent: false)
            }
            if isPrivacyLocked, privacyLockError == nil {
                Task { await unlockApp() }
            }
        }
        .onChange(of: privacyLockEnabled) { isEnabled in
            guard isEnabled, store.isSignedIn else {
                isPrivacyUnlocked = true
                privacyLockError = nil
                return
            }
            lockAndAuthenticate()
        }
        .onOpenURL { url in
            handleOpenURL(url, source: .external)
        }
        .userActivity(XertRouteUserActivity.activityType, isActive: shouldAdvertiseCurrentRoute) { activity in
            XertRouteUserActivity.configure(activity, route: navigation.route)
        }
        .onContinueUserActivity(XertRouteUserActivity.activityType) { activity in
            guard let route = XertRouteUserActivity.route(from: activity) else { return }
            openMemberRoute(route, source: .handoff)
        }
        .onAppear {
            XertHaptics.prepare(.selection)
            XertHaptics.prepare(.lightImpact)
            reloadPinnedMemberRoutes()
            reloadMemberWorkspaceOrder()
            restoreMemberWorkspaceWhenReady()
            consumePendingReminderRoute()
            consumePendingAnnouncementRoute()
            consumePendingQuickActionRoute()
            bindStaffRoster()
            consumePendingStaffRosterRoute()
            refreshOwnerNavigationPulse()
        }
        .onChange(of: navigation.route) { route in
            restoredMemberRoute = route.restorationValue
            restoredMemberWorkspace = navigation.workspaceRestorationValue
        }
        .onChange(of: store.authSession?.user?.id) { _ in
            if ownerAdminStoreUserID != store.authSession?.user?.id {
                showingAdminCommandCentre = false
                requestedAdminRoute = nil
                ownerAdminStore = nil
                ownerAdminStoreUserID = nil
            }
            reloadPinnedMemberRoutes()
            reloadMemberWorkspaceOrder()
            bindStaffRoster()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertOpenBookings)) { _ in
            consumePendingReminderRoute()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertPushTokenUpdated)) { notification in
            guard let token = notification.object as? DevicePushToken else { return }
            Task { await store.syncMemberPushToken(token) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertPushRegistrationFailed)) { _ in
            store.handlePushRegistrationFailure()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertOpenAnnouncements)) { _ in
            consumePendingAnnouncementRoute()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertOpenQuickAction)) { _ in
            consumePendingQuickActionRoute()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertRefreshAnnouncements)) { _ in
            Task { await store.refreshAnnouncements() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertOpenStaffRoster)) { _ in
            consumePendingStaffRosterRoute()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertRefreshStaffRoster)) { _ in
            guard store.isSignedIn else { return }
            Task {
                await staffRoster.refreshAccess()
                if staffRoster.me != nil { await staffRoster.loadNotifications() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .xertCheckoutCallback)) { notification in
            guard let url = notification.object as? URL else { return }
            handleOpenURL(url, source: .authenticatedBrowser)
        }
    }

    private var memberTabs: some View {
        GeometryReader { viewport in
            memberTabSurface(deviceTopInset: viewport.safeAreaInsets.top)
        }
    }

    private func memberTabSurface(deviceTopInset: CGFloat) -> some View {
        TabView(selection: selectedDestinationBinding) {
            HomeView(
                route: navigation.route,
                routeSequence: navigation.routeSequence,
                onNavigate: navigate,
                onOpenRoute: { openMemberRoute($0, source: .content) }
            )
                .toolbar(.hidden, for: .tabBar)
                .tabItem {
                    Label("Home", systemImage: "house")
                }
                .tag(XertPrimaryDestination.home)

            BookingView(
                route: navigation.route,
                routeSequence: navigation.routeSequence,
                onNavigate: navigate,
                firstClassActivation: firstClassActivation,
                onRequireSignInForClass: requireSignInForClass,
                onBookingNeedsCredits: showCreditsNeeded,
                onCheckoutStarted: markActivationCheckoutStarted,
                onBookingCompleted: completeFirstClassActivation
            )
                .toolbar(.hidden, for: .tabBar)
                .tabItem {
                    Label("Book", systemImage: "calendar.badge.plus")
                }
                .tag(XertPrimaryDestination.booking)

            EventsView(route: navigation.route, routeSequence: navigation.routeSequence, onNavigate: navigate)
                .toolbar(.hidden, for: .tabBar)
                .tabItem {
                    Label("Events", systemImage: "trophy")
                }
                .tag(XertPrimaryDestination.events)

            ExploreView(onNavigate: navigate)
                .toolbar(.hidden, for: .tabBar)
                .tabItem {
                    Label("Explore", systemImage: "safari")
                }
                .tag(XertPrimaryDestination.explore)

            AccountView(
                route: navigation.route,
                routeSequence: navigation.routeSequence,
                pendingNavigationTitle: pendingProtectedNavigation?.route.navigationTitle,
                onCancelPendingNavigation: cancelPendingProtectedNavigation,
                onOpenOwner: { openOwnerCommandCentre() },
                staffRoster: staffRoster
            )
                .toolbar(.hidden, for: .tabBar)
                .tabItem {
                    Label("Account", systemImage: "person.crop.circle")
                }
                .tag(XertPrimaryDestination.account)
        }
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .leading, spacing: 0) {
            if navigationPresentation == .workspaceRail {
                navigationRail
            }
        }
        .tint(.xertSteel)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if navigationPresentation == .compactDock {
                navigationDock
            }
        }
        .fullScreenCover(isPresented: $showingAdminCommandCentre) {
            if store.profile?.isAdmin == true, let ownerAdminStore {
                ZStack {
                    AdminCommandCentreView(
                        admin: ownerAdminStore,
                        requestedRoute: requestedAdminRoute,
                        onClose: {
                            showingAdminCommandCentre = false
                            requestedAdminRoute = nil
                        }
                    )
                        .environmentObject(store)
                        .allowsHitTesting(!isPrivacyLocked)
                        .accessibilityHidden(isPrivacyLocked)

                    if isPrivacyLocked {
                        PrivacyLockView(
                            isUnlocking: isUnlocking,
                            errorMessage: privacyLockError,
                            protectsOwnerTools: true,
                            onUnlock: { Task { await unlockApp() } },
                            onSignOut: signOutFromLock
                        )
                        .zIndex(10)
                    }
                }
            }
        }
        .sheet(isPresented: $showingNavigationCommands, onDismiss: completeCommandDismissal) {
            XertNavigationCommandPalette(
                commands: navigation.commandPaletteCommands(
                    isAdmin: store.profile?.isAdmin == true,
                    context: navigationPaletteContext,
                    pinnedRoutes: pinnedMemberRoutes,
                    orderedDestinations: memberWorkspaceOrder
                ),
                workspace: navigation.workspaceOverview,
                workspaceNodes: navigation.workspaceNodes(
                    order: memberWorkspaceOrder,
                    allowsProtectedRoutes: store.isSignedIn
                ),
                pinnedRoutes: pinnedMemberRoutes,
                workspaceOrder: memberWorkspaceOrder,
                canCustomizeWorkspaceOrder: store.isSignedIn,
                onTogglePin: togglePinnedMemberRoute,
                onSaveWorkspaceOrder: saveMemberWorkspaceOrder,
                onSelectWorkspace: openWorkspaceFromMap,
                onSelect: executeNavigationCommand
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .alert("XERT", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("OK") {
                store.errorMessage = nil
            }
        } message: {
            Text(store.errorMessage ?? "")
        }
        .alert(item: $checkoutReturnStatus) { status in
            Alert(
                title: Text(status.title),
                message: Text(status.message),
                dismissButton: .default(Text("OK"))
            )
        }
        .environment(\.xertDeviceTopSafeAreaInset, deviceTopInset)
    }

    private var activeUpcomingBookings: [BookingItem] {
        let now = Date()
        return store.bookings.filter { $0.isActiveClassPlace && $0.start_time >= now }
    }

    private func nextBookingNavigationContext(
        from bookings: [BookingItem]
    ) -> XertNextBookingNavigationContext? {
        bookings
            .min { $0.start_time < $1.start_time }
            .map {
                let title = $0.title.trimmingCharacters(in: .whitespacesAndNewlines)
                return XertNextBookingNavigationContext(
                    id: $0.booking_id,
                    title: title.isEmpty ? "XERT class" : title,
                    startTime: $0.start_time
                )
            }
    }

    private var navigationPresentation: XertNavigationPresentation {
        .resolve(isRegularWidth: horizontalSizeClass == .regular)
    }

    private var navigationStatusContext: XertNavigationContext {
        let activeBookings = activeUpcomingBookings
        return XertNavigationContext(
            isSignedIn: store.isSignedIn,
            noticeCount: store.announcements.count,
            bookingCount: activeBookings.count,
            creditCount: store.creditTotal,
            eventGoalCount: store.eventGoalIDs.count,
            hasPendingCheckout: store.isCheckoutConfirmationPending || store.isReconcilingCheckout,
            nextBooking: nextBookingNavigationContext(from: activeBookings),
            memberRecords: []
        )
    }

    private var navigationPaletteContext: XertNavigationContext {
        let activeBookings = activeUpcomingBookings
        return XertNavigationContext(
            isSignedIn: store.isSignedIn,
            noticeCount: store.announcements.count,
            bookingCount: activeBookings.count,
            creditCount: store.creditTotal,
            eventGoalCount: store.eventGoalIDs.count,
            hasPendingCheckout: store.isCheckoutConfirmationPending || store.isReconcilingCheckout,
            nextBooking: nextBookingNavigationContext(from: activeBookings),
            memberRecords: memberNavigationRecords(from: activeBookings)
        )
    }

    private func memberNavigationRecords(
        from bookings: [BookingItem]
    ) -> [XertMemberRecordNavigationContext] {
        let now = Date()
        let limit = XertMemberRecordNavigationContext.maximumRecordsPerKind
        let classRecords = ClassSessionDiscovery.sessions(from: store.sessions, now: now)
            .filter { $0.start_time >= now }
            .prefix(limit)
            .map {
                XertMemberRecordNavigationContext.classSession(
                    id: $0.id,
                    title: $0.title,
                    coach: $0.coach_name,
                    location: $0.location_zone,
                    spotsLeft: $0.spots_left,
                    startTime: $0.start_time
                )
            }
        let bookingRecords = bookings
            .sorted { $0.start_time < $1.start_time }
            .prefix(limit)
            .map {
                XertMemberRecordNavigationContext.booking(
                    id: $0.booking_id,
                    title: $0.title,
                    status: $0.stateLabel,
                    startTime: $0.start_time
                )
            }
        let noticeRecords = store.announcements
            .map {
                XertMemberRecordNavigationContext.notice(
                    id: $0.id,
                    title: $0.title,
                    tone: $0.tone,
                    publishedAt: $0.published_at
                )
            }
            .sorted {
                if $0.priority != $1.priority { return $0.priority < $1.priority }
                return $0.timestamp > $1.timestamp
            }
            .prefix(limit)
        return Array(classRecords) + Array(bookingRecords) + Array(noticeRecords)
    }

    private var navigationCommandContext: XertNavigationCommandContext {
        let isAvailable = !isPrivacyLocked
            && !showingAdminCommandCentre
            && !showingNavigationCommands
        return XertNavigationCommandContext(
            isAvailable: isAvailable,
            scope: .member(isAvailable ? navigation.selection : .home),
            previousTitle: isAvailable ? navigation.previousRoute?.navigationTitle : nil,
            nextTitle: isAvailable ? navigation.nextRoute?.navigationTitle : nil,
            isAdmin: isAvailable && store.profile?.isAdmin == true,
            perform: executeSceneNavigationCommand
        )
    }

    private var navigationDock: some View {
        XertNavigationDock(
            selection: selectedDestinationBinding,
            isAdmin: store.profile?.isAdmin == true,
            statusSnapshot: XertNavigationStatusSnapshot(context: navigationStatusContext),
            ownerPulse: ownerNavigationPulse.snapshot,
            previousRoute: navigation.previousRoute,
            items: memberWorkspaceOrder,
            onOpenAdmin: openOwnerCommandCentre,
            onOpenCommands: { showingNavigationCommands = true },
            onOpenStatus: executeNavigationStatus,
            onReselect: handleReselection,
            onStep: handleNavigationStep,
            onReturnPrevious: returnToPreviousNavigationDestination
        )
    }

    private var navigationRail: some View {
        XertNavigationRail(
            selection: selectedDestinationBinding,
            currentRoute: navigation.route,
            isAdmin: store.profile?.isAdmin == true,
            statusSnapshot: XertNavigationStatusSnapshot(context: navigationStatusContext),
            ownerPulse: ownerNavigationPulse.snapshot,
            previousRoute: navigation.previousRoute,
            nextRoute: navigation.nextRoute,
            pinnedRoutes: pinnedMemberRoutes,
            items: memberWorkspaceOrder,
            onOpenAdmin: openOwnerCommandCentre,
            onOpenCommands: { showingNavigationCommands = true },
            onOpenPinned: { openMemberRoute($0, source: .commandPalette) },
            onOpenStatus: executeNavigationStatus,
            onReselect: handleReselection,
            onReturnPrevious: returnToPreviousNavigationDestination,
            onReturnNext: returnToNextNavigationDestination
        )
    }

    private var selectedDestinationBinding: Binding<XertPrimaryDestination> {
        Binding(
            get: { navigation.selection },
            set: { selectMemberDestination($0, source: .dock) }
        )
    }

    private func navigate(to destination: XertPrimaryDestination) {
        selectMemberDestination(destination, source: .content)
    }

    private func openWorkspaceFromMap(_ destination: XertPrimaryDestination) {
        if navigation.selection == destination {
            handleReselection(destination)
        } else {
            selectMemberDestination(destination, source: .commandPalette)
        }
    }

    private func selectMemberDestination(
        _ destination: XertPrimaryDestination,
        source: XertNavigationSource
    ) {
        claimMemberNavigation()
        guard navigation.select(
            destination,
            source: source,
            allowsProtectedRoutes: store.isSignedIn
        ) else { return }
        cancelPendingProtectedNavigation()
    }

    private func handleReselection(_ destination: XertPrimaryDestination) {
        claimMemberNavigation()
        navigation.reselect(destination)
        XertHaptics.play(.lightImpact)
        Task { await store.refresh() }
    }

    private func handleNavigationStep(_ direction: XertNavigationDirection) {
        guard navigation.step(
            direction,
            order: memberWorkspaceOrder,
            allowsProtectedRoutes: store.isSignedIn
        ) else { return }
        claimMemberNavigation()
        cancelPendingProtectedNavigation()
        XertHaptics.play(.selection)
    }

    private func returnToPreviousNavigationDestination() {
        guard navigation.returnToPrevious() else { return }
        claimMemberNavigation()
        cancelPendingProtectedNavigation()
        XertHaptics.play(.softImpact)
    }

    private func returnToNextNavigationDestination() {
        guard navigation.returnToNext() else { return }
        claimMemberNavigation()
        cancelPendingProtectedNavigation()
        XertHaptics.play(.softImpact)
    }

    private func executeNavigationCommand(_ command: XertNavigationCommand) {
        showingNavigationCommands = false
        switch command.action {
        case .destination(let destination):
            selectMemberDestination(destination, source: .commandPalette)
        case .pinned(let route):
            openMemberRoute(route, source: .commandPalette)
        case .timeline(let index):
            guard navigation.jump(
                toTimelineIndex: index,
                source: .commandPalette,
                allowsProtectedRoutes: store.isSignedIn
            ) else { return }
            claimMemberNavigation()
            cancelPendingProtectedNavigation()
            XertHaptics.play(.selection)
        case .activity(let activity):
            executeNavigationActivity(activity)
        case .previous:
            returnToPreviousNavigationDestination()
        case .next:
            returnToNextNavigationDestination()
        case .refresh:
            handleReselection(navigation.selection)
        case .owner(let workspace):
            guard store.profile?.isAdmin == true else { return }
            requestedAdminRoute = XertOwnerRoute(workspace: workspace)
            opensAdminAfterCommandDismissal = true
        }
    }

    private func executeNavigationActivity(_ activity: XertNavigationActivity) {
        switch activity {
        case .notices:
            openMemberRoute(.notices(nil), source: .commandPalette)
        case .notice(let noticeID):
            openMemberRoute(.notices(noticeID), source: .commandPalette)
        case .classSession(let sessionID):
            openMemberRoute(.classSession(sessionID), source: .commandPalette)
        case .upcomingBookings(let bookingID):
            openMemberRoute(.upcomingBookings(bookingID), source: .commandPalette)
        case .eventGoals:
            openMemberRoute(.eventGoals, source: .commandPalette)
        case .pendingCheckout:
            if openMemberRoute(.purchaseConfirmation, source: .commandPalette) {
                Task { await store.reconcilePendingCheckout() }
            }
        }
    }

    private func executeNavigationStatus(_ status: XertNavigationStatus) {
        executeNavigationActivity(status.activity)
    }

    private func reloadPinnedMemberRoutes() {
        pinnedMemberRoutes = XertPinnedWorkspaceStore.load(
            for: store.authSession?.user?.id
        )
    }

    private func reloadMemberWorkspaceOrder() {
        memberWorkspaceOrder = XertWorkspaceOrderStore.load(
            for: store.authSession?.user?.id
        )
    }

    private func saveMemberWorkspaceOrder(_ destinations: [XertPrimaryDestination]) {
        guard let userID = store.authSession?.user?.id else { return }
        memberWorkspaceOrder = XertWorkspaceOrderStore.save(destinations, for: userID)
        XertHaptics.play(.success)
    }

    private func togglePinnedMemberRoute(_ route: XertMemberRoute) {
        guard let userID = store.authSession?.user?.id else { return }
        pinnedMemberRoutes = XertPinnedWorkspaceStore.toggle(route, for: userID)
        XertHaptics.play(.lightImpact)
    }

    private func completeCommandDismissal() {
        guard opensAdminAfterCommandDismissal else { return }
        opensAdminAfterCommandDismissal = false
        openOwnerCommandCentre()
    }

    private func executeSceneNavigationCommand(_ command: XertSceneNavigationCommand) {
        guard !isPrivacyLocked else { return }

        switch command {
        case .destination(let destination):
            selectMemberDestination(destination, source: .keyboard)
        case .previous:
            returnToPreviousNavigationDestination()
        case .next:
            returnToNextNavigationDestination()
        case .quickSwitcher:
            guard !showingAdminCommandCentre else { return }
            showingNavigationCommands = true
        case .refresh:
            handleReselection(navigation.selection)
        case .owner:
            guard store.profile?.isAdmin == true, !showingNavigationCommands else { return }
            openOwnerCommandCentre()
        case .ownerWorkspace(_), .closeOwner:
            return
        }
    }

    private var isPrivacyLocked: Bool {
        AppPrivacyLock.requiresUnlock(
            isSignedIn: store.isSignedIn,
            isEnabled: privacyLockEnabled,
            isUnlocked: isPrivacyUnlocked
        )
    }

    private var protectsOwnerTools: Bool {
        showingAdminCommandCentre || pendingOwnerNavigation != nil
    }

    private var shouldAdvertiseCurrentRoute: Bool {
        XertRouteUserActivity.shouldAdvertise(
            route: navigation.route,
            isSignedIn: store.isSignedIn,
            isPrivacyLocked: isPrivacyLocked
        )
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        guard phase == .active else {
            if store.isSignedIn, privacyLockEnabled {
                isPrivacyUnlocked = false
            }
            return
        }

        if isPrivacyLocked {
            Task { await unlockApp() }
        } else if store.hasBootstrapped, !store.isLoading {
            Task {
                await store.refreshIfStale()
                await store.reconcilePendingCheckout()
                await refreshOwnerNavigationPulseNow()
            }
        }
    }

    private func refreshOwnerNavigationPulse(force: Bool = false) {
        Task { await refreshOwnerNavigationPulseNow(force: force) }
    }

    @MainActor
    private func refreshOwnerNavigationPulseNow(force: Bool = false) async {
        guard store.profile?.isAdmin == true, let session = store.authSession else {
            ownerNavigationPulse.reset()
            return
        }
        await ownerNavigationPulse.refresh(session: session, force: force)
    }

    private func lockAndAuthenticate() {
        isPrivacyUnlocked = false
        privacyLockError = nil
        Task { await unlockApp() }
    }

    @MainActor
    private func unlockApp() async {
        guard isPrivacyLocked, !isUnlocking, scenePhase == .active else { return }
        isUnlocking = true
        privacyLockError = nil
        defer { isUnlocking = false }

        do {
            try await DeviceAuthenticator.authenticate(
                reason: protectsOwnerTools
                    ? "Unlock the XERT Owner Command Centre and protected member operations."
                    : "Unlock your XERT member account, bookings and purchase history."
            )
            guard scenePhase == .active, store.isSignedIn, privacyLockEnabled else { return }
            isPrivacyUnlocked = true
            XertHaptics.play(.success)
            resumePendingOwnerNavigation()
            if store.hasBootstrapped, !store.isLoading {
                await store.refreshIfStale()
                await store.reconcilePendingCheckout()
            }
        } catch {
            privacyLockError = error.localizedDescription
            XertHaptics.play(.error)
        }
    }

    private func signOutFromLock() {
        store.signOut()
        isPrivacyUnlocked = true
        privacyLockError = nil
    }

    private func resetMemberNavigationAfterSignOut(clearPendingIntent: Bool) {
        let home = XertMemberRoute.home
        navigation.restore(routeValue: home.restorationValue)
        restoredMemberRoute = home.restorationValue
        restoredMemberWorkspace = navigation.workspaceRestorationValue
        restoredAdminWorkspace = XertOwnerWorkspace.overview.rawValue
        restoredAdminRecentWorkspaces = ""
        restoredAdminWorkspaceHistory = ""
        restoredAdminNavigationUserID = ""
        showingNavigationCommands = false
        showingAdminCommandCentre = false
        opensAdminAfterCommandDismissal = false
        if clearPendingIntent {
            pendingProtectedNavigation = nil
            firstClassActivation = nil
        }
    }

    private func requireSignInForClass(_ sessionID: UUID) {
        claimMemberNavigation()
        firstClassActivation = XertFirstClassActivation(sessionID: sessionID, stage: .signIn)
        pendingProtectedNavigation = XertNavigationIntent(
            route: .classSession(sessionID),
            source: .content
        )
        navigation.open(.account, source: .content)
    }

    private func showCreditsNeeded(_ sessionID: UUID) {
        firstClassActivation = XertFirstClassActivation(sessionID: sessionID, stage: .needsCredits)
        XertHaptics.play(.warning)
    }

    private func markActivationCheckoutStarted() {
        guard var activation = firstClassActivation else { return }
        activation.stage = .checkout
        firstClassActivation = activation
    }

    private func resumeFirstClassAfterCheckout() {
        guard let sessionID = store.consumeCheckoutActivatedSessionID() else { return }
        firstClassActivation = XertFirstClassActivation(sessionID: sessionID, stage: .readyToBook)
        navigation.open(.classSession(sessionID), source: .checkout)
        UIAccessibility.post(
            notification: .announcement,
            argument: "Credits ready. Your selected class is open and has not been booked yet."
        )
    }

    private func completeFirstClassActivation(_ sessionID: UUID) {
        guard firstClassActivation?.matches(sessionID) == true else { return }
        firstClassActivation = nil
    }

    @discardableResult
    private func openMemberRoute(
        _ route: XertMemberRoute,
        source: XertNavigationSource
    ) -> Bool {
        claimMemberNavigation()
        let intent = XertNavigationIntent(route: route, source: source)
        guard intent.disposition(isSignedIn: store.isSignedIn) == .open else {
            pendingProtectedNavigation = intent
            navigation.open(.account, source: source)
            return false
        }
        pendingProtectedNavigation = nil
        navigation.open(route, source: source)
        if case .coaching(let link) = route {
            // Re-open My Coaching even when the coordinator is already on
            // this route (for example after the coach went back to Account).
            staffRoster.open(link)
        }
        return true
    }

    private func restoreMemberWorkspaceWhenReady() {
        guard store.hasBootstrapped, !hasRestoredMemberWorkspace else { return }
        hasRestoredMemberWorkspace = true
        guard !hasExplicitMemberNavigation else { return }
        navigation.restore(
            workspaceValue: restoredMemberWorkspace,
            fallbackRouteValue: restoredMemberRoute,
            allowsProtectedRoutes: store.isSignedIn
        )
    }

    private func claimMemberNavigation() {
        hasExplicitMemberNavigation = true
        if store.hasBootstrapped {
            hasRestoredMemberWorkspace = true
        }
    }

    private func resumePendingProtectedNavigation() {
        guard store.isSignedIn, let intent = pendingProtectedNavigation else { return }
        pendingProtectedNavigation = nil
        navigation.open(intent.route, source: intent.source)
        if intent.route == .purchaseConfirmation {
            Task { await store.reconcilePendingCheckout() }
        }
    }

    private func cancelPendingProtectedNavigation() {
        pendingProtectedNavigation = nil
        if firstClassActivation?.stage == .signIn {
            firstClassActivation = nil
        }
    }

    private func handleOpenURL(_ url: URL, source: CheckoutURLSource) {
        if let callback = CheckoutDeepLink.callback(from: url) {
            if callback.status == .cancelled {
                guard source == .authenticatedBrowser,
                      store.hasPendingCheckoutForCurrentUser() else { return }
                checkoutReturnStatus = .cancelled
                Task {
                    store.cancelPendingCheckout()
                    await store.refresh()
                }
            } else {
                pendingCheckoutCallback = callback
                processPendingCheckoutCallbackIfReady()
            }
            return
        }
        if let ownerRoute = XertOwnerRoute.route(for: url) {
            handleOwnerRoute(ownerRoute)
            return
        }
        guard let route = XertMemberRoute.route(for: url) else { return }
        openMemberRoute(route, source: .deepLink)
    }

    private func processPendingCheckoutCallbackIfReady() {
        guard store.hasBootstrapped,
              let callback = pendingCheckoutCallback,
              !isProcessingCheckoutCallback else { return }
        guard store.isSignedIn else {
            navigation.open(.account, source: .checkout)
            return
        }
        guard let checkoutSessionID = callback.checkoutSessionID else {
            pendingCheckoutCallback = nil
            return
        }

        pendingCheckoutCallback = nil
        isProcessingCheckoutCallback = true
        let hasLocalMatch = store.hasMatchingPendingCheckout(
            callbackSessionID: checkoutSessionID
        )
        if hasLocalMatch {
            openMemberRoute(.purchaseConfirmation, source: .checkout)
        }
        Task {
            let result = await store.reconcileCheckout(
                callbackSessionID: checkoutSessionID
            )
            isProcessingCheckoutCallback = false
            switch result {
            case .confirmed:
                openMemberRoute(.purchaseConfirmation, source: .checkout)
                checkoutReturnStatus = .success
            case .pending, .failed, .refunded:
                openMemberRoute(.purchaseConfirmation, source: .checkout)
            case .noMatchingCheckout:
                break
            }
            processPendingCheckoutCallbackIfReady()
        }
    }

    private func openOwnerCommandCentre(_ workspace: XertOwnerWorkspace? = nil) {
        guard store.profile?.isAdmin == true else { return }
        authorizeAndOpenOwnerRoute(XertOwnerRoute(workspace: workspace ?? .overview))
    }

    private func handleOwnerRoute(_ route: XertOwnerRoute) {
        switch ownerDisposition(for: route) {
        case .open:
            authorizeAndOpenOwnerRoute(route)
        case .deny:
            pendingOwnerNavigation = nil
            store.errorMessage = "Owner access is required for this XERT workspace."
        case .requireAuthentication:
            pendingOwnerNavigation = route
            openMemberRoute(.account, source: .deepLink)
        case .waitForProfile:
            pendingOwnerNavigation = route
        }
    }

    private func resumePendingOwnerNavigation() {
        guard let route = pendingOwnerNavigation else { return }
        switch ownerDisposition(for: route) {
        case .open:
            authorizeAndOpenOwnerRoute(route)
        case .deny:
            pendingOwnerNavigation = nil
            store.errorMessage = "Owner access is required for this XERT workspace."
        case .requireAuthentication, .waitForProfile:
            break
        }
    }

    private func authorizeAndOpenOwnerRoute(_ route: XertOwnerRoute) {
        guard store.profile?.isAdmin == true,
              let ownerID = store.authSession?.user?.id else { return }
        if AppPrivacyLock.requiresOwnerProtection(
            isAdmin: true,
            isEnabled: privacyLockEnabled
        ) {
            let support = DeviceAuthenticator.support()
            guard support.isAvailable else {
                store.errorMessage = support.unavailableMessage
                    ?? "Set a device passcode before opening the Owner Command Centre."
                return
            }
            pendingOwnerNavigation = route
            privacyLockEnabled = true
            return
        }
        guard !isPrivacyLocked else {
            pendingOwnerNavigation = route
            lockAndAuthenticate()
            return
        }
        pendingOwnerNavigation = nil
        if ownerAdminStoreUserID != ownerID || ownerAdminStore == nil {
            ownerAdminStore = AdminStore()
            ownerAdminStoreUserID = ownerID
        }
        requestedAdminRoute = route.workspace == .overview ? nil : route
        showingAdminCommandCentre = true
    }

    private func ownerDisposition(for route: XertOwnerRoute) -> XertOwnerNavigationDisposition {
        XertOwnerNavigationIntent(route: route).disposition(
            isSignedIn: store.isSignedIn,
            isProfileLoaded: store.profile != nil,
            isAdmin: store.profile?.isAdmin == true
        )
    }

    private func consumePendingAnnouncementRoute() {
        guard let pendingAnnouncementID = AnnouncementPushNavigation.consumePendingAnnouncementID() else { return }
        if openMemberRoute(.notices(pendingAnnouncementID), source: .pushNotification) {
            XertHaptics.play(.mediumImpact)
            Task { await store.refreshAnnouncements() }
        }
    }

    private func consumePendingReminderRoute() {
        if ClassReminderNavigation.consumePendingBrowseClasses() {
            openMemberRoute(.booking, source: .pushNotification)
            XertHaptics.play(.mediumImpact)
            return
        }
        guard let bookingID = ClassReminderNavigation.consumePendingBookingID() else { return }
        openMemberRoute(.upcomingBookings(bookingID), source: .pushNotification)
        XertHaptics.play(.mediumImpact)
    }

    private func consumePendingQuickActionRoute() {
        guard let route = XertQuickActionNavigation.consumePendingRoute() else { return }
        openMemberRoute(route, source: .quickAction)
    }

    private func bindStaffRoster() {
        let member = store
        staffRoster.bind(userID: store.authSession?.user?.id) {
            try await member.staffRosterSession()
        }
        // Ask the server once per account whether My Coaching should appear.
        if store.isSignedIn, staffRoster.access == .unknown {
            Task { await staffRoster.refreshAccess() }
        }
    }

    /// A tapped staff roster push opens its `open_path` through the same
    /// route as a universal link. Its notice is marked read only once My
    /// Coaching is showing for the coach.
    private func consumePendingStaffRosterRoute() {
        guard let target = StaffRosterPushNavigation.consumePending() else { return }
        if let notificationID = target.notificationID {
            staffRoster.noteOpenedFromNotification(notificationID)
        }
        openMemberRoute(.coaching(target.link), source: .pushNotification)
        XertHaptics.play(.mediumImpact)
    }
}

private struct XertNavigationRail: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var selection: XertPrimaryDestination
    let currentRoute: XertMemberRoute
    let isAdmin: Bool
    let statusSnapshot: XertNavigationStatusSnapshot
    let ownerPulse: XertOwnerNavigationPulse
    let previousRoute: XertMemberRoute?
    let nextRoute: XertMemberRoute?
    let pinnedRoutes: [XertMemberRoute]
    let items: [XertPrimaryDestination]
    let onOpenAdmin: (XertOwnerWorkspace?) -> Void
    let onOpenCommands: () -> Void
    let onOpenPinned: (XertMemberRoute) -> Void
    let onOpenStatus: (XertNavigationStatus) -> Void
    let onReselect: (XertPrimaryDestination) -> Void
    let onReturnPrevious: () -> Void
    let onReturnNext: () -> Void
    @Namespace private var selectionNamespace

    var body: some View {
        VStack(spacing: 0) {
            XertLogoHeader(height: dynamicTypeSize.isAccessibilitySize ? 24 : 21)
                .frame(maxWidth: .infinity, minHeight: 48)
                .padding(.horizontal, 12)

            Button(action: onOpenCommands) {
                VStack(spacing: 5) {
                    ZStack {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 16, weight: .semibold))
                        XertPinnedWorkspaceBadge(count: pinnedRoutes.count)
                            .offset(x: 15, y: -9)
                    }
                    Text("Switch")
                        .font(.caption2.weight(.bold))
                        .textCase(.uppercase)
                        .tracking(0.7)
                }
                .foregroundStyle(Color.xertPale)
                .frame(maxWidth: .infinity, minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut("k", modifiers: .command)
            .hoverEffect(.highlight)
            .accessibilityLabel(quickSwitcherAccessibilityLabel)
            .accessibilityHint("Searches workspaces and available actions")
            .accessibilityIdentifier("xert-navigation-commands")
            .contextMenu { pinnedWorkspaceMenu }

            XertNavigationShareControl(route: currentRoute, layout: .rail)

            XertNavigationStatusControl(
                status: statusSnapshot.priorityStatus,
                layout: .rail,
                onOpen: onOpenStatus
            )

            if let previousRoute {
                Button(action: onReturnPrevious) {
                    VStack(spacing: 5) {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 15, weight: .semibold))
                        Text("Back to \(previousRoute.navigationTitle)")
                            .font(.caption2.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(Color.xertSteel)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut("[", modifiers: .command)
                .hoverEffect(.highlight)
                .accessibilityHint("Returns to the previous XERT workspace")
                .accessibilityIdentifier("xert-navigation-history")
            }

            if let nextRoute {
                Button(action: onReturnNext) {
                    VStack(spacing: 5) {
                        Image(systemName: "arrow.uturn.forward")
                            .font(.system(size: 15, weight: .semibold))
                        Text("Forward to \(nextRoute.navigationTitle)")
                            .font(.caption2.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(Color.xertSteel)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut("]", modifiers: .command)
                .hoverEffect(.highlight)
                .accessibilityHint("Returns to the next XERT workspace task")
                .accessibilityIdentifier("xert-navigation-forward-history")
            }

            Rectangle()
                .fill(Color.xertSteel.opacity(0.18))
                .frame(height: 1)
                .padding(.horizontal, 14)

            VStack(spacing: 4) {
                ForEach(items) { item in
                    navigationButton(item)
                }
            }
            .padding(.vertical, 8)

            Spacer(minLength: 12)

            if isAdmin {
                Button {
                    onOpenAdmin(ownerPulse.priority?.workspace)
                } label: {
                    VStack(spacing: 7) {
                        ZStack {
                            Image(systemName: "waveform.path.ecg.rectangle")
                                .font(.system(size: 20, weight: .semibold))
                            XertOwnerNavigationPulseBadge(pulse: ownerPulse)
                                .offset(x: 19, y: -12)
                        }
                        Text("Owner")
                            .font(.caption2.weight(.bold))
                            .textCase(.uppercase)
                            .tracking(0.8)
                        if let priority = ownerPulse.priority {
                            Text(priority.compactLabel)
                                .font(.system(size: 8, weight: .bold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.65)
                                .foregroundStyle(Color.xertSteel)
                        }
                    }
                    .foregroundStyle(Color.xertOffWhite)
                    .frame(maxWidth: .infinity, minHeight: 66)
                    .background(Color.xertDeep.opacity(0.96))
                    .overlay(alignment: .top) {
                        Rectangle().fill(Color.xertSteel.opacity(0.5)).frame(height: 1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .hoverEffect(.highlight)
                .accessibilityLabel("Owner Command Centre")
                .accessibilityValue(ownerPulse.accessibilityLabel)
                .accessibilityHint(ownerAccessibilityHint)
                .accessibilityIdentifier("xert-navigation-owner")
                .contextMenu { ownerWorkspaceMenu }
            }
        }
        .frame(width: dynamicTypeSize.isAccessibilitySize ? 136 : 104)
        .background(Color.xertInk.opacity(0.99).ignoresSafeArea(edges: .leading))
        .overlay(alignment: .trailing) {
            Rectangle().fill(Color.xertSteel.opacity(0.24)).frame(width: 1)
        }
    }

    private func navigationButton(_ item: XertPrimaryDestination) -> some View {
        let selected = selection == item
        let status = statusSnapshot.status(for: item)
        return Button {
            guard selection != item else {
                onReselect(item)
                return
            }
            XertHaptics.play(.selection)
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { selection = item }
        } label: {
            VStack(spacing: 6) {
                ZStack {
                    Image(systemName: selected ? item.selectedIcon : item.icon)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(selected ? Color.xertSteel : Color.xertPale.opacity(0.66))
                        .frame(width: 42, height: 30)

                    if let status {
                        XertNavigationStatusBadge(status: status)
                            .offset(x: 18, y: -11)
                    }
                }
                Text(item.title)
                    .font(.caption2.weight(selected ? .bold : .semibold))
                    .textCase(.uppercase)
                    .tracking(0.7)
                    .foregroundStyle(selected ? Color.xertOffWhite : Color.xertPale.opacity(0.58))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.74)
            }
            .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 78 : 66)
            .background(selected ? Color.xertSteel.opacity(0.09) : Color.clear)
            .overlay(alignment: .leading) {
                if selected {
                    Rectangle()
                        .fill(Color.xertSteel)
                        .frame(width: 3, height: 36)
                        .matchedGeometryEffect(id: "rail-navigation-selection", in: selectionNamespace)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(keyboardShortcut(for: item), modifiers: .command)
        .hoverEffect(.highlight)
        .accessibilityLabel(item.title)
        .accessibilityValue(selected ? "Selected" : "")
        .accessibilityHint(accessibilityHint(for: item, status: status, selected: selected))
        .accessibilityIdentifier("xert-navigation-\(item.title.lowercased())")
        .accessibilityActions {
            if let status {
                Button(status.actionTitle) { onOpenStatus(status) }
            }
            if selected {
                Button("Refresh \(item.title)") { onReselect(item) }
                if let previousRoute {
                    Button("Return to \(previousRoute.navigationTitle)", action: onReturnPrevious)
                }
            }
        }
        .contextMenu {
            if let status {
                Button(action: { onOpenStatus(status) }) {
                    Label(status.actionTitle, systemImage: status.icon)
                }
            }
            if selected {
                Button(action: { onReselect(item) }) {
                    Label("Refresh \(item.title)", systemImage: "arrow.clockwise")
                }
                if let previousRoute {
                    Button(action: onReturnPrevious) {
                        Label("Return to \(previousRoute.navigationTitle)", systemImage: "arrow.uturn.backward")
                    }
                }
            }
        }
    }

    private var quickSwitcherAccessibilityLabel: String {
        pinnedRoutes.isEmpty
            ? "XERT quick switcher"
            : "XERT quick switcher, \(pinnedRoutes.count) pinned \(pinnedRoutes.count == 1 ? "workspace" : "workspaces")"
    }

    @ViewBuilder
    private var pinnedWorkspaceMenu: some View {
        ForEach(pinnedRoutes, id: \.restorationValue) { route in
            Button(action: { onOpenPinned(route) }) {
                Label(route.navigationTitle, systemImage: "pin.fill")
            }
        }
    }

    private func accessibilityHint(
        for item: XertPrimaryDestination,
        status: XertNavigationStatus?,
        selected: Bool
    ) -> String {
        var details: [String] = []
        if let status { details.append(status.accessibilityLabel) }
        details.append(selected ? "Refreshes this workspace" : "Opens the \(item.title) workspace")
        return details.joined(separator: ". ")
    }

    private func keyboardShortcut(for item: XertPrimaryDestination) -> KeyEquivalent {
        switch item {
        case .home: return "1"
        case .booking: return "2"
        case .events: return "3"
        case .explore: return "4"
        case .account: return "5"
        }
    }

    private var ownerAccessibilityHint: String {
        ownerPulse.priority.map { "\($0.actionTitle) in the protected Owner Command Centre" }
            ?? "Opens protected gym operations and platform controls"
    }

    @ViewBuilder
    private var ownerWorkspaceMenu: some View {
        if let priority = ownerPulse.priority {
            Button { onOpenAdmin(priority.workspace) } label: {
                Label(priority.actionTitle, systemImage: priority.workspace.icon)
            }
        }
        Button { onOpenAdmin(nil) } label: {
            Label("Open owner overview", systemImage: XertOwnerWorkspace.overview.icon)
        }
    }
}

private struct XertNavigationDock: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var selection: XertPrimaryDestination
    let isAdmin: Bool
    let statusSnapshot: XertNavigationStatusSnapshot
    let ownerPulse: XertOwnerNavigationPulse
    let previousRoute: XertMemberRoute?
    let items: [XertPrimaryDestination]
    let onOpenAdmin: (XertOwnerWorkspace?) -> Void
    let onOpenCommands: () -> Void
    let onOpenStatus: (XertNavigationStatus) -> Void
    let onReselect: (XertPrimaryDestination) -> Void
    let onStep: (XertNavigationDirection) -> Void
    let onReturnPrevious: () -> Void
    @Namespace private var selectionNamespace

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items) { item in
                navigationButton(item)
            }
        }
        .frame(height: dynamicTypeSize.isAccessibilitySize ? 80 : 66)
        .background {
            LinearGradient(
                colors: [Color.xertDeep.opacity(0.92), Color.xertInk.opacity(0.98)],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.xertSteel.opacity(0.28), lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(0.26), radius: 14, y: 5)
        .simultaneousGesture(
            DragGesture(minimumDistance: 36)
                .onEnded { value in
                    let horizontal = value.translation.width
                    let vertical = value.translation.height
                    guard abs(horizontal) > 44, abs(horizontal) > abs(vertical) * 1.35 else { return }
                    onStep(horizontal < 0 ? .next : .previous)
                }
        )
        .padding(.horizontal, 10)
        .padding(.top, 7)
        .padding(.bottom, 5)
        .background {
            LinearGradient(
                colors: [Color.xertNavy.opacity(0.08), Color.xertInk.opacity(0.98)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
        }
        .accessibilityAction(named: "Open XERT quick switcher") {
            onOpenCommands()
        }
    }

    private func navigationButton(_ item: XertPrimaryDestination) -> some View {
        let selected = selection == item
        let status = statusSnapshot.status(for: item)
        return Button {
            guard selection != item else {
                onReselect(item)
                return
            }
            XertHaptics.play(.selection)
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { selection = item }
        } label: {
            VStack(spacing: 4) {
                ZStack {
                    if item == .booking {
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .fill(selected ? Color.xertPale : Color.xertSteel)
                            .frame(width: 40, height: 34)
                            .shadow(color: Color.xertSteel.opacity(0.35), radius: 8, y: 3)
                    }
                    Image(systemName: selected ? item.selectedIcon : item.icon)
                        .font(.system(size: item == .booking ? 17 : 18, weight: .semibold))
                        .foregroundStyle(item == .booking ? Color.xertNavy : selected ? Color.xertSteel : Color.xertPale.opacity(0.62))
                        .frame(width: 38, height: 34)

                    if let status {
                        XertNavigationStatusBadge(status: status)
                            .offset(x: 16, y: -12)
                    }

                    if item == .account, isAdmin {
                        XertOwnerNavigationPulseBadge(pulse: ownerPulse)
                            .offset(x: -16, y: -12)
                    }
                }
                Text(item.title)
                    .font(.caption2.weight(selected ? .bold : .semibold))
                    .textCase(.uppercase)
                    .tracking(0.8)
                    .foregroundStyle(selected ? Color.xertOffWhite : Color.xertPale.opacity(0.55))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [Color.xertSteel.opacity(0.19), Color.xertSteel.opacity(0.06)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                        .matchedGeometryEffect(id: "primary-navigation-selection", in: selectionNamespace)
                }
            }
            .overlay(alignment: .top) {
                if selected {
                    Capsule()
                        .fill(Color.xertSteel)
                        .frame(width: item == .booking ? 42 : 28, height: 3)
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
        .accessibilityValue(selected ? "Selected" : "")
        .accessibilityHint(accessibilityHint(for: item, status: status, selected: selected))
        .accessibilityIdentifier("xert-navigation-\(item.title.lowercased())")
        .accessibilityActions {
            if let status {
                Button(status.actionTitle) { onOpenStatus(status) }
            }
            if selected {
                Button("Refresh \(item.title)") { onReselect(item) }
                if let previousRoute {
                    Button("Return to \(previousRoute.navigationTitle)", action: onReturnPrevious)
                }
            }
        }
        .contextMenu {
            Button(action: onOpenCommands) {
                Label("Quick switcher", systemImage: "magnifyingglass")
            }
            if item == .account, isAdmin {
                Divider()
                if let priority = ownerPulse.priority {
                    Button { onOpenAdmin(priority.workspace) } label: {
                        Label(priority.actionTitle, systemImage: priority.workspace.icon)
                    }
                }
                Button { onOpenAdmin(nil) } label: {
                    Label("Owner Command Centre", systemImage: XertOwnerWorkspace.overview.icon)
                }
            }
            if let status {
                Button(action: { onOpenStatus(status) }) {
                    Label(status.actionTitle, systemImage: status.icon)
                }
            }
            if selected {
                Button(action: { onReselect(item) }) {
                    Label("Refresh \(item.title)", systemImage: "arrow.clockwise")
                }
                if let previousRoute {
                    Button(action: onReturnPrevious) {
                        Label("Return to \(previousRoute.navigationTitle)", systemImage: "arrow.uturn.backward")
                    }
                }
            }
        }
    }

    private func accessibilityHint(
        for item: XertPrimaryDestination,
        status: XertNavigationStatus?,
        selected: Bool
    ) -> String {
        var details: [String] = []
        if let status { details.append(status.accessibilityLabel) }
        details.append(selected ? "Refreshes this workspace" : "Opens the \(item.title) workspace")
        return details.joined(separator: ". ")
    }
}

private struct XertOwnerNavigationPulseBadge: View {
    let pulse: XertOwnerNavigationPulse

    var body: some View {
        if pulse.attentionCount > 0 {
            Text(pulse.badgeText)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(Color.xertNavy)
                .padding(.horizontal, 4)
                .frame(minWidth: 16, minHeight: 16)
                .background(pulse.healthIssueCount > 0 ? Color.red : Color.xertSteel)
                .clipShape(Capsule())
                .accessibilityHidden(true)
        } else if pulse.isPartial || !pulse.isAvailable {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.red)
                .background(Color.xertNavy.clipShape(Circle()))
                .accessibilityHidden(true)
        }
    }
}

private enum XertNavigationUtilityLayout {
    case rail
    case compact
}

private struct XertNavigationStatusControl: View {
    let status: XertNavigationStatus?
    let layout: XertNavigationUtilityLayout
    let onOpen: (XertNavigationStatus) -> Void

    var body: some View {
        Group {
            if let status {
                Button(action: { onOpen(status) }) {
                    statusLabel(status)
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .accessibilityLabel(status.actionTitle)
                .accessibilityValue(status.accessibilityLabel)
                .accessibilityHint("Opens the exact XERT task")
                .accessibilityIdentifier("xert-navigation-priority-status")
            } else {
                placeholder
                    .accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder
    private func statusLabel(_ status: XertNavigationStatus) -> some View {
        switch layout {
        case .rail:
            VStack(spacing: 5) {
                ZStack {
                    Image(systemName: status.icon)
                        .font(.system(size: 16, weight: .semibold))
                    XertNavigationStatusBadge(status: status)
                        .offset(x: 16, y: -9)
                }
                Text(status.shortTitle)
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.7)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .foregroundStyle(status.kind == .attention ? Color.orange : Color.xertPale)
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        case .compact:
            ZStack {
                Image(systemName: status.icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(status.kind == .attention ? Color.orange : Color.xertPale)
                XertNavigationStatusBadge(status: status)
                    .offset(x: 15, y: -12)
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        switch layout {
        case .rail:
            VStack(spacing: 5) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 16, weight: .semibold))
                Text("Clear")
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.7)
            }
            .foregroundStyle(Color.xertPale.opacity(0.42))
            .frame(maxWidth: .infinity, minHeight: 48)
        case .compact:
            Image(systemName: "checkmark.circle")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.xertPale.opacity(0.42))
                .frame(width: 44, height: 44)
        }
    }
}

private struct XertNavigationShareControl: View {
    let route: XertMemberRoute
    let layout: XertNavigationUtilityLayout

    var body: some View {
        Group {
            if let destination = route.shareDestination {
                ShareLink(item: destination.route.webURL, subject: Text(destination.title)) {
                    shareLabel
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .accessibilityLabel("Share \(destination.title)")
                .accessibilityHint(destination.accessibilityHint)
                .accessibilityIdentifier("xert-navigation-share")
            } else {
                privateLabel
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(route.navigationTitle) is private")
                    .accessibilityHint("Private account tasks cannot be shared")
                    .accessibilityIdentifier("xert-navigation-share-private")
                    .help("Private account tasks cannot be shared")
            }
        }
    }

    @ViewBuilder
    private var shareLabel: some View {
        switch layout {
        case .rail:
            VStack(spacing: 5) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                Text("Share")
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.7)
            }
            .foregroundStyle(Color.xertPale)
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        case .compact:
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.xertPale)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
    }

    @ViewBuilder
    private var privateLabel: some View {
        switch layout {
        case .rail:
            VStack(spacing: 5) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 15, weight: .semibold))
                Text("Private")
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.7)
            }
            .foregroundStyle(Color.xertPale.opacity(0.5))
            .frame(maxWidth: .infinity, minHeight: 48)
        case .compact:
            Image(systemName: "lock.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.xertPale.opacity(0.5))
                .frame(width: 44, height: 44)
        }
    }
}

private struct XertNavigationStatusBadge: View {
    let status: XertNavigationStatus

    var body: some View {
        Text(status.badgeText)
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(Color.xertNavy)
            .frame(minWidth: 16, minHeight: 16)
            .padding(.horizontal, status.badgeText.count > 1 ? 2 : 0)
            .background(status.kind == .attention ? Color.orange : Color.xertPale)
            .clipShape(Capsule())
            .accessibilityHidden(true)
    }
}

private struct XertPinnedWorkspaceBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text(String(min(count, XertPinnedWorkspaceSnapshot.maximumRouteCount)))
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(Color.xertNavy)
                .frame(minWidth: 16, minHeight: 16)
                .background(Color.xertSteel)
                .clipShape(Circle())
                .accessibilityHidden(true)
        }
    }
}

private struct XertNavigationCommandPalette: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var query = ""
    @State private var showingWorkspaceOrderEditor = false
    @FocusState private var searchFocused: Bool
    let commands: [XertNavigationCommand]
    let workspace: XertNavigationWorkspaceOverview
    let workspaceNodes: [XertNavigationWorkspaceNode]
    let pinnedRoutes: [XertMemberRoute]
    let workspaceOrder: [XertPrimaryDestination]
    let canCustomizeWorkspaceOrder: Bool
    let onTogglePin: (XertMemberRoute) -> Void
    let onSaveWorkspaceOrder: ([XertPrimaryDestination]) -> Void
    let onSelectWorkspace: (XertPrimaryDestination) -> Void
    let onSelect: (XertNavigationCommand) -> Void

    private var filteredCommands: [XertNavigationCommand] {
        XertNavigationCoordinator.filteredCommands(commands, query: query)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                workspaceHeader
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    workspaceMap
                }
                Group {
                    if filteredCommands.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 28, weight: .semibold))
                                .foregroundStyle(Color.xertSteel)
                            Text("No matching XERT actions")
                                .font(.headline)
                                .foregroundStyle(Color.xertOffWhite)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        List {
                            ForEach(XertNavigationCommandSection.allCases) { section in
                                let sectionCommands = filteredCommands.filter { $0.section == section }
                                if !sectionCommands.isEmpty {
                                    Section {
                                        ForEach(sectionCommands) { command in
                                            commandRow(command)
                                        }
                                    } header: {
                                        Text(section.rawValue)
                                            .font(.caption2.weight(.bold))
                                            .textCase(.uppercase)
                                            .foregroundStyle(Color.xertSteel)
                                    }
                                }
                            }
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            .background(Color.xertNavy.ignoresSafeArea())
            .navigationTitle("Quick Switcher")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search XERT")
            .focused($searchFocused)
            .toolbar {
                if canCustomizeWorkspaceOrder {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button(action: { showingWorkspaceOrderEditor = true }) {
                            Image(systemName: "slider.horizontal.3")
                        }
                        .accessibilityLabel("Customize navigation layout")
                        .accessibilityHint("Changes the order of your XERT workspaces")
                        .accessibilityIdentifier("xert-navigation-customize")
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.xertSteel)
                }
            }
            .onAppear { searchFocused = true }
            .sheet(isPresented: $showingWorkspaceOrderEditor) {
                XertWorkspaceOrderEditor(
                    destinations: workspaceOrder,
                    onSave: onSaveWorkspaceOrder
                )
                .presentationDetents([.medium, .large])
            }
        }
        .tint(Color.xertSteel)
        .preferredColorScheme(.dark)
    }

    private var workspaceMap: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(workspaceNodes) { node in
                        workspaceNode(node)
                            .id(node.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .frame(height: dynamicTypeSize.isAccessibilitySize ? 130 : 102)
            .background(Color.xertInk.opacity(0.98))
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.xertSteel.opacity(0.14)).frame(height: 1)
            }
            .onAppear {
                guard let current = workspaceNodes.first(where: { $0.isCurrent }) else { return }
                proxy.scrollTo(current.id, anchor: .center)
            }
            .onChange(of: workspace.currentRoute.destination) { destination in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    proxy.scrollTo(destination, anchor: .center)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("XERT workspace map")
            .accessibilityIdentifier("xert-navigation-workspace-map")
        }
    }

    private func workspaceNode(_ node: XertNavigationWorkspaceNode) -> some View {
        let pinnableRoute = node.route.pinnableRoute
        let isPinned = pinnableRoute.map { pinnedRoutes.contains($0) } ?? false
        return Button {
            dismiss()
            onSelectWorkspace(node.destination)
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Image(systemName: node.isCurrent ? node.destination.selectedIcon : node.destination.icon)
                        .font(.system(size: 16, weight: .semibold))
                    Spacer(minLength: 4)
                    if isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2.weight(.bold))
                    }
                    if node.isCurrent {
                        Circle()
                            .fill(Color.xertSteel)
                            .frame(width: 7, height: 7)
                    }
                }
                Text(node.destination.title.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                Text(node.route.isContextualTask ? node.route.navigationTitle : "Overview")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(node.isCurrent ? Color.xertOffWhite : Color.xertPale.opacity(0.62))
                    .lineLimit(2)
                    .minimumScaleFactor(0.72)
            }
            .foregroundStyle(node.isCurrent ? Color.xertSteel : Color.xertPale)
            .frame(
                width: dynamicTypeSize.isAccessibilitySize ? 156 : 126,
                height: dynamicTypeSize.isAccessibilitySize ? 98 : 70,
                alignment: .leading
            )
            .padding(.horizontal, 12)
            .background(node.isCurrent ? Color.xertDeep : Color.xertNavy)
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(
                    node.isCurrent ? Color.xertSteel.opacity(0.7) : Color.xertSteel.opacity(0.16),
                    lineWidth: node.isCurrent ? 1.5 : 1
                )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(node.destination.title), \(node.route.navigationTitle)")
        .accessibilityValue(node.isCurrent ? "Current workspace" : "Saved workspace state")
        .accessibilityHint(node.isCurrent ? "Refreshes this workspace" : "Resumes this exact workspace task")
        .contextMenu {
            if let pinnableRoute {
                Button(action: { onTogglePin(pinnableRoute) }) {
                    Label(
                        isPinned ? "Unpin workspace" : "Pin workspace",
                        systemImage: isPinned ? "pin.slash" : "pin"
                    )
                }
            }
        }
    }

    private var workspaceHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                workspaceIdentity
                Spacer(minLength: 8)
                pinControl
                workspaceCounts
            }
            VStack(alignment: .leading, spacing: 8) {
                workspaceIdentity
                HStack(spacing: 12) {
                    pinControl
                    workspaceCounts
                }
            }
        }
        .font(.caption.weight(.bold))
        .foregroundStyle(Color.xertSteel)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: 58)
        .background(Color.xertDeep.opacity(0.96))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.xertSteel.opacity(0.2)).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Current task \(workspace.currentRoute.navigationTitle), \(workspace.backCount) back, \(workspace.forwardCount) forward"
        )
        .accessibilityIdentifier("xert-navigation-workspace-overview")
    }

    private var workspaceIdentity: some View {
        HStack(spacing: 12) {
            Image(systemName: workspace.currentRoute.destination.selectedIcon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.xertSteel)
                .frame(width: 36, height: 36)
                .background(Color.xertSteel.opacity(0.1))
            VStack(alignment: .leading, spacing: 2) {
                Text(workspace.currentRoute.navigationTitle)
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Text("Current workspace task")
                    .font(.caption2.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(Color.xertPale.opacity(0.55))
            }
        }
    }

    private var workspaceCounts: some View {
        HStack(spacing: 12) {
            Label("\(workspace.backCount)", systemImage: "arrow.uturn.backward")
            Label("\(workspace.forwardCount)", systemImage: "arrow.uturn.forward")
        }
    }

    @ViewBuilder
    private var pinControl: some View {
        if let route = workspace.currentRoute.pinnableRoute {
            let isPinned = pinnedRoutes.contains(route)
            Button(action: { onTogglePin(route) }) {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .background(Color.xertSteel.opacity(isPinned ? 0.22 : 0.1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isPinned ? "Unpin current workspace" : "Pin current workspace")
            .accessibilityHint("Updates your saved XERT workspaces")
            .accessibilityIdentifier("xert-navigation-pin-current")
        }
    }

    private func commandRow(_ command: XertNavigationCommand) -> some View {
        Button {
            dismiss()
            onSelect(command)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: command.icon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.xertSteel)
                    .frame(width: 34, height: 34)
                    .background(Color.xertSteel.opacity(0.1))
                VStack(alignment: .leading, spacing: 3) {
                    Text(command.title)
                        .font(.headline)
                        .foregroundStyle(Color.xertOffWhite)
                    Text(command.subtitle)
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.7))
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.xertSteel.opacity(0.65))
            }
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.xertInk)
        .listRowSeparatorTint(Color.xertSteel.opacity(0.16))
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if case .pinned(let route) = command.action {
                Button(role: .destructive) {
                    onTogglePin(route)
                } label: {
                    Label("Unpin", systemImage: "pin.slash")
                }
                .tint(Color.red)
            }
        }
        .contextMenu {
            if case .pinned(let route) = command.action {
                Button(action: { onTogglePin(route) }) {
                    Label("Unpin workspace", systemImage: "pin.slash")
                }
            }
        }
    }
}

private struct XertWorkspaceOrderEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var destinations: [XertPrimaryDestination]
    let onSave: ([XertPrimaryDestination]) -> Void

    init(
        destinations: [XertPrimaryDestination],
        onSave: @escaping ([XertPrimaryDestination]) -> Void
    ) {
        _destinations = State(initialValue: XertWorkspaceOrderStore.normalized(destinations))
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(destinations) { destination in
                        HStack(spacing: 14) {
                            Image(systemName: destination.selectedIcon)
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.xertSteel)
                                .frame(width: 32, height: 32)
                                .background(Color.xertSteel.opacity(0.1))
                            Text(destination.title)
                                .font(.headline)
                                .foregroundStyle(Color.xertOffWhite)
                            Spacer()
                        }
                        .frame(minHeight: 48)
                        .listRowBackground(Color.xertInk)
                        .accessibilityLabel("\(destination.title) workspace")
                    }
                    .onMove(perform: moveDestinations)
                }
            }
            .environment(\.editMode, .constant(.active))
            .scrollContentBackground(.hidden)
            .background(Color.xertNavy.ignoresSafeArea())
            .navigationTitle("Navigation Layout")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button(action: resetDestinations) {
                        Label("Reset", systemImage: "arrow.counterclockwise")
                    }
                    .disabled(destinations == XertPrimaryDestination.dockOrder)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(destinations)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .tint(Color.xertSteel)
        .preferredColorScheme(.dark)
    }

    private func moveDestinations(from source: IndexSet, to destination: Int) {
        destinations.move(fromOffsets: source, toOffset: destination)
    }

    private func resetDestinations() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            destinations = XertPrimaryDestination.dockOrder
        }
    }
}

private struct PrivacyLockView: View {
    let isUnlocking: Bool
    let errorMessage: String?
    let protectsOwnerTools: Bool
    let onUnlock: () -> Void
    let onSignOut: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            XertLogoHeader(height: 42)
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 42, weight: .semibold))
                .foregroundStyle(Color.xertSteel)
                .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text("XERT Locked")
                    .xertDisplay(34)
                Text(protectsOwnerTools
                    ? "Authenticate to continue to protected owner operations."
                    : "Authenticate to view your member account.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.xertPale)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.orange)
                    .padding(.horizontal)
                    .accessibilityLabel("Unlock error: \(errorMessage)")
            }

            VStack(spacing: 12) {
                Button(action: onUnlock) {
                    HStack {
                        if isUnlocking {
                            ProgressView()
                                .tint(Color.xertNavy)
                        }
                        Text(isUnlocking ? "Authenticating..." : "Unlock XERT")
                    }
                }
                .buttonStyle(.xertPrimary)
                .disabled(isUnlocking)

                Button("Sign Out", role: .destructive, action: onSignOut)
                    .buttonStyle(.xertGhost)
                    .disabled(isUnlocking)
            }
            .frame(maxWidth: 360)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.xertNavy.ignoresSafeArea())
    }
}


extension ShapeStyle where Self == Color {
    static var xertSteel: Color { Color.xertSteel }
    static var xertOffWhite: Color { Color.xertOffWhite }
}

struct XertSection<Content: View>: View {
    let title: String
    let actionTitle: String?
    let action: (() -> Void)?
    let content: Content

    init(
        title: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.actionTitle = actionTitle
        self.action = action
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .xertDisplay(24)
                Spacer()
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.xertSteel)
                }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, XertSpace.lg)
        .padding(.horizontal, XertSpace.lg)
        .xertCardStyle()
    }
}

struct CachedPublicDataNotice: View {
    @EnvironmentObject private var store: XertStore

    var body: some View {
        if store.isUsingCachedPublicData, let updatedAt = store.publicDataUpdatedAt {
            Label {
                Text("Offline data from \(updatedAt.formatted(date: .abbreviated, time: .shortened))")
            } icon: {
                Image(systemName: "wifi.slash")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.xertSteel)
            .accessibilityLabel("Showing saved data from \(updatedAt.formatted(date: .long, time: .shortened))")
        }
    }
}

struct StaleMemberDataNotice: View {
    @EnvironmentObject private var store: XertStore

    var body: some View {
        if store.isUsingStaleMemberData, let updatedAt = store.memberDataUpdatedAt {
            Label {
                Text("Account data last updated \(updatedAt.formatted(date: .omitted, time: .shortened))")
            } icon: {
                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.orange)
            .accessibilityLabel("Account data could not refresh. Last updated \(updatedAt.formatted(date: .long, time: .shortened))")
        }
    }
}

struct DataAvailabilityNotice: View {
    @EnvironmentObject private var store: XertStore
    let sources: Set<XertDataSource>

    var body: some View {
        let unavailable = sources.intersection(store.unavailableDataSources)
            .sorted { $0.rawValue < $1.rawValue }
        if !unavailable.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label {
                    Text("Could not refresh \(unavailable.map(\.displayName).joined(separator: ", ")).")
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                Button {
                    Task { await store.refresh() }
                } label: {
                    Label(store.isLoading ? "Retrying…" : "Retry unavailable data", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(store.isLoading)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.orange)
        }
    }
}
