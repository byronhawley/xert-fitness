import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import UniformTypeIdentifiers

struct AdminEditorExitCoordinatorKey: EnvironmentKey {
    static let defaultValue: XertOwnerEditorExitCoordinator? = nil
}

extension EnvironmentValues {
    var adminEditorExitCoordinator: XertOwnerEditorExitCoordinator? {
        get { self[AdminEditorExitCoordinatorKey.self] }
        set { self[AdminEditorExitCoordinatorKey.self] = newValue }
    }
}

struct AdminOwnerExitReportingModifier: ViewModifier {
    @Environment(\.adminEditorExitCoordinator) private var coordinator
    let state: XertOwnerEditorExitState

    func body(content: Content) -> some View {
        content
            .onAppear { coordinator?.report(state) }
            .onChange(of: state) { coordinator?.report($0) }
            .onDisappear { coordinator?.clear(id: state.id) }
    }
}

extension View {
    func adminOwnerExitState(
        id: UUID,
        title: String,
        isDirty: Bool,
        isBusy: Bool
    ) -> some View {
        modifier(
            AdminOwnerExitReportingModifier(
                state: XertOwnerEditorExitState(
                    id: id,
                    title: title,
                    isDirty: isDirty,
                    isBusy: isBusy
                )
            )
        )
    }
}

struct AdminCommandCentreView: View {
    @EnvironmentObject private var store: XertStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var admin: AdminStore
    @StateObject private var editorExitCoordinator = XertOwnerEditorExitCoordinator()
    @SceneStorage("xert.adminWorkspace") private var restoredWorkspace = XertOwnerWorkspace.overview.rawValue
    @SceneStorage("xert.adminRecentWorkspaces") private var restoredRecentWorkspaces = ""
    @SceneStorage("xert.adminWorkspaceHistory") private var restoredWorkspaceHistory = ""
    @SceneStorage("xert.adminNavigationUserID") private var restoredNavigationUserID = ""
    @State private var compactPath: [XertOwnerWorkspace] = []
    @State private var pendingCompactPathWorkspace: XertOwnerWorkspace?
    @State private var showingWorkspaceSwitcher = false
    @State private var pendingLauncherAction: AdminOwnerLauncherAction?
    @State private var createFormIntentID: UUID?
    @State private var pendingCreateFormNavigation = false
    @State private var foregroundPresentationRefreshTask: Task<Void, Never>?
    @State private var expandedHub: XertOwnerWorkspaceSection?
    @State private var showingBusinessPulse = false
    @State private var pinnedWorkspaces: [XertOwnerWorkspace] = []
    @State private var presentedOwnerTask: XertOwnerTask?
    @State private var presentedQuickAction: AdminOwnerQuickAction?
    @State private var quickNoticeDraft: AdminAnnouncementDraft?
    @State private var platformDraftSnapshot: AdminPlatformSettings?
    @State private var pendingOwnerExitRequest: OwnerExitRequest?
    @State private var showingPlatformExitConfirmation = false
    @State private var pendingEditorExitRequest: OwnerExitRequest?
    @State private var showingEditorExitConfirmation = false
    @State private var isSavingPlatformExit = false
    @State private var shiftBriefCopyFeedbackID: UUID?
    @State private var confirmingEmergencyPause = false
    let requestedRoute: XertOwnerRoute?
    var onClose: (() -> Void)? = nil

    private enum OwnerExitRequest: Equatable {
        case route(XertOwnerRoute, resolvesTask: Bool)
        case previous(XertOwnerRoute)
        case next(XertOwnerRoute)
        case close

        var destinationTitle: String {
            switch self {
            case .route(let route, _), .previous(let route), .next(let route):
                return route.navigationTitle
            case .close:
                return "the member app"
            }
        }

        var targetWorkspace: XertOwnerWorkspace? {
            switch self {
            case .route(let route, _), .previous(let route), .next(let route):
                return route.workspace
            case .close:
                return nil
            }
        }
    }

    init(
        admin: AdminStore,
        requestedRoute: XertOwnerRoute? = nil,
        onClose: (() -> Void)? = nil
    ) {
        self.admin = admin
        self.requestedRoute = requestedRoute
        self.onClose = onClose
    }

    var body: some View {
        Group {
            if let session = authorizedOwnerSession {
                if horizontalSizeClass == .regular {
                    ownerSplitWorkspace(session: session)
                } else {
                    ownerCompactWorkspace(session: session)
                }
            } else {
                NavigationStack { accessDenied }
            }
        }
        .environment(\.adminEditorExitCoordinator, editorExitCoordinator)
        .focusedSceneValue(\.xertNavigationCommandContext, ownerNavigationCommandContext)
        .background(Color.xertNavy.ignoresSafeArea())
        .interactiveDismissDisabled(
            hasUnsavedPlatformDraft
                || admin.isSavingSettings
                || isSavingPlatformExit
                || editorExitCoordinator.active?.isDirty == true
                || editorExitCoordinator.active?.isBusy == true
        )
        .task {
            guard let session = authorizedOwnerSession, let userID = session.user?.id else { return }
            prepareOwnerNavigation(for: userID)
            reloadPinnedWorkspaces()
            applyRequestedRoute(requestedRoute, resolvesTask: false)
            await admin.refreshForPresentation(session: session)
            guard !Task.isCancelled else { return }
            if let task = presentedOwnerTask {
                await admin.resolveOwnerTask(session: session, task: task)
            }
        }
        .task(id: operationalPulseTaskID) {
            guard scenePhase == .active, let session = authorizedOwnerSession else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: AdminOperationalRefreshPolicy.intervalNanoseconds)
                } catch {
                    return
                }
                guard !Task.isCancelled, scenePhase == .active else { return }
                await admin.refreshOperationalPulse(session: session)
            }
        }
        .onChange(of: store.authSession?.user?.id) { userID in
            admin.resetOwnerTaskResolution()
            if let userID { prepareOwnerNavigation(for: userID) }
            reloadPinnedWorkspaces()
        }
        .onChange(of: admin.requiresReauthentication) { requiresReauthentication in
            guard requiresReauthentication else { return }
            Task {
                await store.expireUnauthorizedOwnerSession()
                admin.acknowledgeReauthenticationRequest()
                onClose?()
            }
        }
        .onChange(of: requestedRoute) { route in
            applyRequestedRoute(route)
        }
        .sheet(
            isPresented: $showingWorkspaceSwitcher,
            onDismiss: runPendingLauncherAction
        ) {
            if let session = authorizedOwnerSession {
                AdminWorkspaceSwitcher(
                    admin: admin,
                    session: session,
                    current: currentWorkspace,
                    recent: recentWorkspaces.workspaces,
                    pinned: pinnedWorkspaces,
                    badges: workspaceBadges,
                    launchRunway: stripeLaunchState
                ) { workspace in
                    showingWorkspaceSwitcher = false
                    openWorkspaceWithFeedback(workspace)
                } onOpenRoute: { route in
                    showingWorkspaceSwitcher = false
                    XertHaptics.play(.lightImpact)
                    openOwnerRoute(route)
                } onTogglePin: { workspace in
                    togglePinnedWorkspace(workspace)
                } onRunAction: { action in
                    pendingLauncherAction = action
                    showingWorkspaceSwitcher = false
                }
            }
        }
        .sheet(item: $presentedOwnerTask, onDismiss: closePresentedOwnerTask) { task in
            if let session = authorizedOwnerSession {
                AdminOwnerTaskSheet(admin: admin, session: session, task: task)
                    .id(task)
            }
        }
        .sheet(item: $presentedQuickAction, onDismiss: {
            quickNoticeDraft = nil
        }) { action in
            if let session = authorizedOwnerSession {
                quickActionSheet(action, session: session)
            }
        }
        .confirmationDialog(
            "Unsaved Settings",
            isPresented: $showingPlatformExitConfirmation,
            titleVisibility: .visible,
            presenting: pendingOwnerExitRequest
        ) { request in
            Button(platformExitSaveButtonLabel) {
                isSavingPlatformExit = true
                showingPlatformExitConfirmation = false
                savePlatformDraftAndComplete(request)
            }
            .disabled(!canSavePlatformDraftForExit)

            Button("Discard changes and continue", role: .destructive) {
                discardPlatformDraftAndComplete(request)
            }
            .disabled(admin.isSavingSettings || isSavingPlatformExit)

            Button("Keep editing", role: .cancel) {
                pendingOwnerExitRequest = nil
                pendingCreateFormNavigation = false
            }
        } message: { request in
            Text(platformExitMessage(for: request))
        }
        .confirmationDialog(
            "Unsaved \(editorExitCoordinator.active?.title ?? "owner changes")",
            isPresented: $showingEditorExitConfirmation,
            titleVisibility: .visible,
            presenting: pendingEditorExitRequest
        ) { request in
            Button("Discard changes and continue", role: .destructive) {
                editorExitCoordinator.clearAll()
                performOwnerExit(request)
            }
            Button("Keep editing", role: .cancel) {
                pendingEditorExitRequest = nil
                pendingCreateFormNavigation = false
            }
        } message: { request in
            Text(
                "This draft has not been saved. Discard it before opening "
                    + "\(request.destinationTitle), or keep editing."
            )
        }
        .alert("Command Centre", isPresented: Binding(
            get: { admin.errorMessage != nil },
            set: { if !$0 { admin.errorMessage = nil } }
        )) {
            Button("OK") { admin.errorMessage = nil }
        } message: {
            Text(admin.errorMessage ?? "")
        }
        .onChange(of: scenePhase) { phase in
            foregroundPresentationRefreshTask?.cancel()
            foregroundPresentationRefreshTask = nil
            guard phase == .active else {
                admin.clearRevealedMemberEmergencyContact()
                return
            }
            guard let session = authorizedOwnerSession else { return }
            foregroundPresentationRefreshTask = Task {
                await admin.refreshForPresentation(session: session)
            }
        }
        .onChange(of: showingPlatformExitConfirmation) { isPresented in
            if !isPresented && !isSavingPlatformExit {
                pendingOwnerExitRequest = nil
                if currentWorkspace != .forms { pendingCreateFormNavigation = false }
            }
        }
        .onChange(of: showingEditorExitConfirmation) { isPresented in
            if !isPresented {
                pendingEditorExitRequest = nil
                if currentWorkspace != .forms { pendingCreateFormNavigation = false }
            }
        }
        .onDisappear {
            foregroundPresentationRefreshTask?.cancel()
            foregroundPresentationRefreshTask = nil
            admin.clearVolatileDrillDownData()
        }
    }

    private var authorizedOwnerSession: AuthSession? {
        guard store.profile?.isAdmin == true,
              let session = store.authSession,
              session.user?.id != nil else { return nil }
        return session
    }

    private var currentWorkspace: XertOwnerWorkspace {
        XertOwnerWorkspace(rawValue: restoredWorkspace) ?? .overview
    }

    private var operationalPulseTaskID: String {
        let accountID = store.authSession?.user?.id.uuidString.lowercased() ?? "guest"
        return "\(accountID):\(scenePhase == .active ? "active" : "inactive")"
    }

    private var hasUnsavedPlatformDraft: Bool {
        currentWorkspace == .controls
            && platformDraftSnapshot != nil
            && platformDraftSnapshot != admin.settings
    }

    private var canSavePlatformDraftForExit: Bool {
        hasUnsavedPlatformDraft
            && authorizedOwnerSession != nil
            && admin.loadedSources.contains("platform controls")
            && !admin.refreshUnavailableSources.contains("platform controls")
            && !admin.isLoading
            && !admin.isSavingSettings
            && !isSavingPlatformExit
    }

    private var platformExitWouldEnablePayments: Bool {
        platformDraftSnapshot?.payments_enabled == true
            && admin.settings?.payments_enabled != true
    }

    private var platformExitSaveButtonLabel: String {
        platformExitWouldEnablePayments ? "Save, verify checkout and continue" : "Save changes and continue"
    }

    private var workspaceSelection: Binding<XertOwnerWorkspace?> {
        Binding(
            get: { currentWorkspace },
            set: { openWorkspace($0 ?? .overview) }
        )
    }

    private var compactNavigationPath: Binding<[XertOwnerWorkspace]> {
        Binding(
            get: { compactPath },
            set: { path in
                guard path != compactPath else { return }
                let workspace = path.last ?? .overview
                if currentWorkspace == .controls,
                   workspace != .controls,
                   hasUnsavedPlatformDraft {
                    requestOwnerExit(.route(XertOwnerRoute(workspace: workspace), resolvesTask: true))
                    return
                }
                compactPath = path
            }
        )
    }

    private var recentWorkspaces: XertOwnerWorkspaceRecency {
        XertOwnerWorkspaceRecency(restorationValue: restoredRecentWorkspaces)
    }

    private var ownerRouteHistory: XertOwnerRouteHistory {
        XertOwnerRouteHistory(
            restorationValue: restoredWorkspaceHistory,
            fallback: XertOwnerRoute(workspace: currentWorkspace)
        )
    }

    private var workspaceBadges: [XertOwnerWorkspace: Int] {
        let pairs: [(XertOwnerWorkspace, Int)] = XertOwnerWorkspace.allCases.compactMap { workspace in
            guard let badge = workspaceBadge(workspace), badge > 0 else { return nil }
            return (workspace, badge)
        }
        return Dictionary(uniqueKeysWithValues: pairs)
    }

    private var ownerNavigationCommandContext: XertNavigationCommandContext {
        let isAvailable = authorizedOwnerSession != nil
            && !showingWorkspaceSwitcher
            && !showingPlatformExitConfirmation
            && !showingEditorExitConfirmation
            && !admin.isSavingSettings
            && !isSavingPlatformExit
            && editorExitCoordinator.active?.isBusy != true
        return XertNavigationCommandContext(
            isAvailable: isAvailable,
            scope: .owner(currentWorkspace),
            previousTitle: isAvailable ? ownerRouteHistory.previous?.navigationTitle : nil,
            nextTitle: isAvailable ? ownerRouteHistory.next?.navigationTitle : nil,
            isAdmin: isAvailable,
            perform: executeOwnerSceneNavigationCommand
        )
    }

    private func openWorkspace(_ workspace: XertOwnerWorkspace) {
        openOwnerRoute(XertOwnerRoute(workspace: workspace))
    }

    private func openOwnerRoute(_ route: XertOwnerRoute, resolvesTask: Bool = true) {
        requestOwnerExit(.route(route, resolvesTask: resolvesTask))
    }

    private func performOpenOwnerRoute(_ route: XertOwnerRoute, resolvesTask: Bool = true) {
        var history = ownerRouteHistory
        history.visit(route)
        restoredWorkspaceHistory = history.restorationValue
        applyOwnerRoute(route)
        guard resolvesTask, let task = route.task, let session = authorizedOwnerSession else { return }
        Task { await admin.resolveOwnerTask(session: session, task: task) }
    }

    private func requestOwnerExit(_ request: OwnerExitRequest) {
        guard !isSavingPlatformExit else { return }
        if let activeEditor = editorExitCoordinator.active {
            guard !activeEditor.isBusy else {
                admin.errorMessage = "\(activeEditor.title) is still saving. Wait for it to finish before leaving."
                XertHaptics.play(.warning)
                return
            }
            if activeEditor.isDirty {
                pendingEditorExitRequest = request
                showingEditorExitConfirmation = true
                XertHaptics.play(.warning)
                return
            }
        }
        let leavesPlatformControls = request.targetWorkspace != .controls
        guard leavesPlatformControls, hasUnsavedPlatformDraft else {
            performOwnerExit(request)
            return
        }
        pendingOwnerExitRequest = request
        showingPlatformExitConfirmation = true
        XertHaptics.play(.warning)
    }

    private func performOwnerExit(_ request: OwnerExitRequest) {
        pendingOwnerExitRequest = nil
        showingPlatformExitConfirmation = false
        if request.targetWorkspace != .controls {
            platformDraftSnapshot = nil
        }

        switch request {
        case .route(let route, let resolvesTask):
            performOpenOwnerRoute(route, resolvesTask: resolvesTask)
        case .previous:
            performReturnToPreviousOwnerRoute()
        case .next:
            performAdvanceToNextOwnerRoute()
        case .close:
            onClose?()
        }
    }

    private func savePlatformDraftAndComplete(_ request: OwnerExitRequest) {
        guard let session = authorizedOwnerSession, let draft = platformDraftSnapshot else {
            isSavingPlatformExit = false
            pendingOwnerExitRequest = nil
            pendingCreateFormNavigation = false
            admin.errorMessage = "Settings could not be saved. Keep editing and try again."
            XertHaptics.play(.error)
            return
        }

        Task {
            let didSave = await admin.saveSettings(session: session, draft: draft)
            isSavingPlatformExit = false
            if didSave {
                XertHaptics.play(.success)
                clearPlatformRecoveryDraft()
                platformDraftSnapshot = admin.settings
                performOwnerExit(request)
            } else {
                pendingOwnerExitRequest = nil
                pendingCreateFormNavigation = false
                XertHaptics.play(.error)
            }
        }
    }

    private func discardPlatformDraftAndComplete(_ request: OwnerExitRequest) {
        clearPlatformRecoveryDraft()
        platformDraftSnapshot = admin.settings
        XertHaptics.play(.softImpact)
        performOwnerExit(request)
    }

    private func clearPlatformRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .platformSettings,
            ownerID: authorizedOwnerSession?.user?.id,
            recordID: platformDraftSnapshot?.id ?? admin.settings?.id
        )
    }

    private func platformExitMessage(for request: OwnerExitRequest) -> String {
        let destination = request == .close
            ? "closing the Command Centre"
            : "opening \(request.destinationTitle)"
        if !canSavePlatformDraftForExit {
            return "Live member-app settings have unsaved changes. Saving is unavailable until Platform Controls refreshes successfully. Discard them before \(destination), or keep editing."
        }
        if platformExitWouldEnablePayments {
            return "Live member-app settings have unsaved changes. Saving will run Stripe launch checks before enabling checkout and \(destination). You can also discard the draft or keep editing."
        }
        return "Save the live member-app settings before \(destination), discard the draft, or keep editing."
    }

    private func reloadPinnedWorkspaces() {
        pinnedWorkspaces = XertOwnerWorkspacePinsStore.load(
            for: authorizedOwnerSession?.user?.id
        )
    }

    private func prepareOwnerNavigation(for userID: UUID) {
        let accountID = userID.uuidString.lowercased()
        guard restoredNavigationUserID != accountID else { return }
        restoredNavigationUserID = accountID
        restoredWorkspace = XertOwnerWorkspace.overview.rawValue
        restoredRecentWorkspaces = ""
        restoredWorkspaceHistory = ""
        compactPath = []
        pendingCompactPathWorkspace = nil
        presentedOwnerTask = nil
        presentedQuickAction = nil
        pendingLauncherAction = nil
        createFormIntentID = nil
        pendingCreateFormNavigation = false
        expandedHub = nil
        editorExitCoordinator.clearAll()
        platformDraftSnapshot = nil
        pendingOwnerExitRequest = nil
        showingPlatformExitConfirmation = false
        pendingEditorExitRequest = nil
        showingEditorExitConfirmation = false
        isSavingPlatformExit = false
    }

    private func togglePinnedWorkspace(_ workspace: XertOwnerWorkspace) {
        guard let userID = authorizedOwnerSession?.user?.id else { return }
        pinnedWorkspaces = XertOwnerWorkspacePinsStore.toggle(workspace, for: userID)
        XertHaptics.play(.lightImpact)
    }

    private func applyWorkspace(_ workspace: XertOwnerWorkspace) {
        restoredWorkspace = workspace.rawValue
        var recency = recentWorkspaces
        recency.record(workspace)
        restoredRecentWorkspaces = recency.restorationValue
        let targetPath = workspace == .overview ? [] : [workspace]
        if compactPath != targetPath {
            pendingCompactPathWorkspace = workspace
            compactPath = targetPath
        }
        if workspace == .forms, pendingCreateFormNavigation {
            pendingCreateFormNavigation = false
            createFormIntentID = UUID()
        }
    }

    private func applyOwnerRoute(_ route: XertOwnerRoute) {
        presentedOwnerTask = route.task
        applyWorkspace(route.workspace)
    }

    private func returnToPreviousOwnerRoute() {
        guard let route = ownerRouteHistory.previous else { return }
        requestOwnerExit(.previous(route))
    }

    private func performReturnToPreviousOwnerRoute() {
        var history = ownerRouteHistory
        guard let route = history.goBack() else { return }
        restoredWorkspaceHistory = history.restorationValue
        applyOwnerRoute(route)
        resolveOwnerTask(route.task)
    }

    private func advanceToNextOwnerRoute() {
        guard let route = ownerRouteHistory.next else { return }
        requestOwnerExit(.next(route))
    }

    private func performAdvanceToNextOwnerRoute() {
        var history = ownerRouteHistory
        guard let route = history.goForward() else { return }
        restoredWorkspaceHistory = history.restorationValue
        applyOwnerRoute(route)
        resolveOwnerTask(route.task)
    }

    private func executeOwnerSceneNavigationCommand(_ command: XertSceneNavigationCommand) {
        guard store.profile?.isAdmin == true else { return }
        switch command {
        case .ownerWorkspace(let workspace):
            openWorkspace(workspace)
        case .previous:
            returnToPreviousOwnerRoute()
        case .next:
            advanceToNextOwnerRoute()
        case .quickSwitcher:
            showingWorkspaceSwitcher = true
        case .refresh:
            guard let session = authorizedOwnerSession else { return }
            refreshOwnerData(session: session)
        case .closeOwner:
            requestOwnerExit(.close)
        case .destination(_), .owner:
            return
        }
    }

    private func applyRequestedRoute(
        _ route: XertOwnerRoute?,
        resolvesTask: Bool = true
    ) {
        if let route {
            openOwnerRoute(route, resolvesTask: resolvesTask)
        } else {
            applyOwnerRoute(ownerRouteHistory.current)
        }
    }

    private func resolveOwnerTask(_ task: XertOwnerTask?) {
        guard let task, let session = authorizedOwnerSession else { return }
        Task { await admin.resolveOwnerTask(session: session, task: task) }
    }

    private func closePresentedOwnerTask() {
        admin.resetOwnerTaskResolution()
        guard ownerRouteHistory.current.task != nil else { return }
        openWorkspace(currentWorkspace)
    }

    private func openWorkspaceWithFeedback(_ workspace: XertOwnerWorkspace) {
        XertHaptics.play(.selection)
        openWorkspace(workspace)
    }

    private func openOwnerRouteWithFeedback(_ route: XertOwnerRoute) {
        XertHaptics.play(.selection)
        openOwnerRoute(route)
    }

    private func presentQuickAction(_ action: AdminOwnerQuickAction) {
        XertHaptics.play(.lightImpact)
        presentedQuickAction = action
    }

    private func presentNoticeQuickAction(draft: AdminAnnouncementDraft? = nil) {
        quickNoticeDraft = draft
        presentQuickAction(.newNotice)
    }

    private func runPendingLauncherAction() {
        guard let action = pendingLauncherAction else { return }
        pendingLauncherAction = nil
        if action == .newForm {
            requestCreateForm()
            return
        }
        if let workspace = action.workspace {
            openWorkspaceWithFeedback(workspace)
        } else if let quickAction = action.quickAction {
            presentQuickAction(quickAction)
        }
    }

    private func requestCreateForm() {
        if currentWorkspace == .forms {
            createFormIntentID = UUID()
            return
        }
        pendingCreateFormNavigation = true
        openWorkspace(.forms)
        if currentWorkspace != .forms,
           pendingOwnerExitRequest == nil,
           pendingEditorExitRequest == nil {
            pendingCreateFormNavigation = false
        }
    }

    private func refreshOwnerData(session: AuthSession, announcesResult: Bool = true) {
        guard !admin.isLoading, !admin.isSavingSettings, !isSavingPlatformExit else { return }
        XertHaptics.play(.softImpact)
        Task {
            await admin.refresh(session: session)
            guard announcesResult else { return }
            XertHaptics.play(admin.refreshUnavailableSources.isEmpty ? .success : .warning)
        }
    }

    private func refreshOperationalPulse() {
        guard let session = authorizedOwnerSession,
              !admin.isLoading,
              !admin.isRefreshingOperations else { return }
        XertHaptics.play(.softImpact)
        Task {
            guard await admin.refreshOperationalPulse(session: session) else {
                XertHaptics.play(.warning)
                return
            }
            switch admin.operationalQueueState {
            case .ready:
                XertHaptics.play(.success)
            case .partial:
                XertHaptics.play(.warning)
            case .idle, .loading:
                break
            }
        }
    }

    @ViewBuilder
    private func quickActionSheet(_ action: AdminOwnerQuickAction, session: AuthSession) -> some View {
        switch action {
        case .newClass:
            NavigationStack {
                AdminClassEditor(
                    admin: admin,
                    session: session,
                    classSession: nil,
                    mutationAllowed: admin.loadedSources.contains("full timetable")
                        && !admin.refreshUnavailableSources.contains("full timetable")
                )
            }
        case .newNotice:
            AdminAnnouncementComposer(
                announcement: nil,
                initialDraft: quickNoticeDraft,
                ownerID: session.user?.id,
                isSaving: admin.announcementMutationID != nil,
                isPublishing: admin.isPublishingAnnouncement,
                onSave: { draft in
                    let succeeded = await admin.saveAnnouncement(
                        session: session,
                        announcement: nil,
                        draft: draft
                    )
                    if succeeded { quickNoticeDraft = nil }
                    XertHaptics.play(succeeded ? .success : .error)
                    return succeeded
                },
                onPublish: { draft, requestID in
                    let succeeded = await admin.publishAnnouncement(
                        session: session,
                        announcement: nil,
                        draft: draft,
                        requestID: requestID
                    )
                    if succeeded { quickNoticeDraft = nil }
                    XertHaptics.play(succeeded ? .success : .error)
                    return succeeded
                }
            )
        case .newSessionPack:
            NavigationStack {
                AdminProductEditor(
                    admin: admin,
                    session: session,
                    product: nil,
                    suggestedSortOrder: (admin.products.map(\.sort_order).max() ?? -1) + 1
                )
            }
        case .newCoach:
            NavigationStack {
                AdminCoachEditor(
                    admin: admin,
                    session: session,
                    coach: nil
                )
            }
        case .newEvent:
            NavigationStack {
                AdminEventEditor(
                    admin: admin,
                    session: session,
                    event: nil
                )
            }
        }
    }

    private func ownerCompactWorkspace(session: AuthSession) -> some View {
        NavigationStack(path: compactNavigationPath) {
            dashboard(session: session)
                .navigationTitle("Today")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ownerWorkspaceToolbar }
                .navigationDestination(for: XertOwnerWorkspace.self) { workspace in
                    ownerWorkspaceSurface(workspace, session: session)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ownerWorkspaceToolbar }
                }
        }
        .onChange(of: compactPath) { path in
            let workspace = path.last ?? .overview
            if pendingCompactPathWorkspace == workspace {
                pendingCompactPathWorkspace = nil
                return
            }
            openWorkspace(workspace)
        }
    }

    private func ownerSplitWorkspace(session: AuthSession) -> some View {
        NavigationSplitView {
            List(selection: workspaceSelection) {
                Label(XertOwnerWorkspace.overview.title, systemImage: XertOwnerWorkspace.overview.icon)
                    .tag(XertOwnerWorkspace.overview)

                if !pinnedWorkspaces.isEmpty {
                    Section("Pinned") {
                        ForEach(pinnedWorkspaces) { workspace in
                            Label(workspace.title, systemImage: workspace.icon)
                                .tag(workspace)
                        }
                    }
                }

                ForEach(XertOwnerWorkspaceSection.allCases) { section in
                    Section(section.rawValue) {
                        ForEach(XertOwnerWorkspace.workspaces(in: section).filter { !pinnedWorkspaces.contains($0) }) { workspace in
                            HStack(spacing: 10) {
                                Label(workspace.title, systemImage: workspace.icon)
                                Spacer(minLength: 4)
                                if let badge = workspaceBadge(workspace), badge > 0 {
                                    Text(badge > 99 ? "99+" : "\(badge)")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(Color.xertNavy)
                                        .padding(.horizontal, 7)
                                        .frame(minHeight: 20)
                                        .background(Color.xertSteel)
                                        .clipShape(Capsule())
                                }
                            }
                            .tag(workspace)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.xertInk)
            .navigationTitle("Command Centre")
            .toolbar {
                closeToolbar
                workspaceSwitcherToolbar
            }
            .navigationSplitViewColumnWidth(min: 230, ideal: 270, max: 320)
        } detail: {
            NavigationStack {
                ownerWorkspaceSurface(currentWorkspace, session: session)
                    .id(currentWorkspace)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { workspaceSwitcherToolbar }
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    private func dashboard(session: AuthSession) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ownerHeader
                if !admin.refreshUnavailableSources.isEmpty {
                    AdminRefreshDataWarning(
                        unavailableSources: admin.refreshUnavailableSources,
                        cachedSources: admin.loadedSources,
                        isRetrying: admin.isLoading
                    ) {
                        refreshOwnerData(session: session)
                    }
                }
                nextClassFocus
                priorityQueue
                attentionGrid
                quickTools
                pinnedDirectory
                managementDirectory
                businessPulse
            }
            .frame(maxWidth: 880)
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .xertScreenBackground()
        .refreshable { await admin.refresh(session: session) }
    }

    @ViewBuilder
    private var ownerRunNextDock: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let freshness = AdminOperationalRefreshPolicy.freshness(
                hasCompletedRefresh: admin.hasCompletedRefresh,
                updatedAt: admin.operationalUpdatedAt,
                isRefreshing: admin.isRefreshingOperations,
                hasUnavailableSources: admin.operationalQueueHasUnavailableSources,
                now: context.date
            )
            let priority = operationalPriorities.first

            if freshness == .current,
               admin.operationalQueueState == .ready {
                if let priority {
                    AdminOwnerRunNextBar(
                        priority: priority,
                        isRefreshing: admin.isLoading || admin.isRefreshingOperations,
                        onOpen: { openOwnerRouteWithFeedback(priority.route) },
                        onRefresh: refreshOperationalPulse
                    )
                } else {
                    AdminOwnerQueuesClearBar(
                        updatedAt: admin.operationalUpdatedAt,
                        isRefreshing: admin.isLoading || admin.isRefreshingOperations,
                        onRefresh: refreshOperationalPulse
                    )
                }
            } else if priority != nil || admin.operationalQueueState != .ready {
                AdminOwnerRunNextRefreshBar(
                    freshness: freshness,
                    isRefreshing: admin.isLoading || admin.isRefreshingOperations,
                    onRefresh: refreshOperationalPulse
                )
            }
        }
    }

    private var accessDenied: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock.shield")
                .font(.system(size: 38, weight: .semibold))
                .foregroundStyle(Color.xertSteel)
            Text("Owner access required").xertDisplay(28)
            Text("This workspace is available only to XERT administrators.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.xertPale.opacity(0.7))
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .xertOwnerScreen()
        .navigationTitle("Command Centre")
        .toolbar { closeToolbar }
    }

    @ToolbarContentBuilder
    private var closeToolbar: some ToolbarContent {
        if onClose != nil {
            ToolbarItem(placement: .navigationBarLeading) {
                Button { requestOwnerExit(.close) } label: {
                    Label("Close", systemImage: "xmark")
                }
                .foregroundStyle(Color.xertSteel)
            }
        }
    }

    @ToolbarContentBuilder
    private var workspaceSwitcherToolbar: some ToolbarContent {
        ToolbarItem(placement: .secondaryAction) {
            Menu {
                if !admin.refreshUnavailableSources.isEmpty {
                    Label(
                        "\(admin.refreshUnavailableSources.count) data service"
                            + (admin.refreshUnavailableSources.count == 1 ? " needs attention" : "s need attention"),
                        systemImage: "exclamationmark.triangle.fill"
                    )
                }

                if currentWorkspace != .overview {
                    Button { openWorkspaceWithFeedback(.overview) } label: {
                        Label("Owner overview", systemImage: "waveform.path.ecg.rectangle")
                    }
                }

                if let session = authorizedOwnerSession {
                    Button { refreshOwnerData(session: session) } label: {
                        Label(admin.isLoading ? "Refreshing owner data" : "Refresh owner data", systemImage: "arrow.clockwise")
                    }
                    .disabled(admin.isLoading || admin.isSavingSettings || isSavingPlatformExit)
                }

                if currentWorkspace != .overview {
                    Button { togglePinnedWorkspace(currentWorkspace) } label: {
                        Label(
                            pinnedWorkspaces.contains(currentWorkspace) ? "Unpin this workspace" : "Pin this workspace",
                            systemImage: pinnedWorkspaces.contains(currentWorkspace) ? "pin.slash" : "pin"
                        )
                    }
                }

                Divider()

                Button { returnToPreviousOwnerRoute() } label: {
                    Label(
                        ownerRouteHistory.previous.map { "Back to \($0.navigationTitle)" } ?? "No previous workspace",
                        systemImage: "arrow.left"
                    )
                }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(ownerRouteHistory.previous == nil)

                Button { advanceToNextOwnerRoute() } label: {
                    Label(
                        ownerRouteHistory.next.map { "Forward to \($0.navigationTitle)" } ?? "No next workspace",
                        systemImage: "arrow.right"
                    )
                }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(ownerRouteHistory.next == nil)
            } label: {
                if admin.isLoading {
                    ProgressView().tint(Color.xertSteel)
                } else if !admin.refreshUnavailableSources.isEmpty {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.orange)
                } else {
                    Image(systemName: "ellipsis.circle")
                }
            }
            .accessibilityLabel(ownerActionsAccessibilityLabel)
            .accessibilityHint("Refreshes data, pins workspaces, or opens owner navigation history")
        }

        ToolbarItem(placement: .primaryAction) {
            Button { showingWorkspaceSwitcher = true } label: {
                Label("Manage", systemImage: "square.grid.2x2")
                    .labelStyle(.titleAndIcon)
            }
            .keyboardShortcut("k", modifiers: .command)
            .accessibilityLabel("Manage owner workspaces")
            .accessibilityHint("Searches and opens every Command Centre workspace")
        }
    }

    @ToolbarContentBuilder
    private var ownerWorkspaceToolbar: some ToolbarContent {
        closeToolbar
        workspaceSwitcherToolbar
    }

    private var ownerHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 14) {
                ownerHeaderIdentity
                Spacer(minLength: 8)
                AdminOwnerFreshnessBadge(
                    isLoading: admin.isLoading,
                    unavailableCount: admin.refreshUnavailableSources.count,
                    updatedAt: admin.lastUpdatedAt
                )
            }
            VStack(alignment: .leading, spacing: 10) {
                ownerHeaderIdentity
                AdminOwnerFreshnessBadge(
                    isLoading: admin.isLoading,
                    unavailableCount: admin.refreshUnavailableSources.count,
                    updatedAt: admin.lastUpdatedAt
                )
            }
        }
        .padding(.vertical, 4)
    }

    private var ownerHeaderIdentity: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)).uppercased())
                .font(.caption.weight(.bold))
                .tracking(1.4)
                .foregroundStyle(Color.xertSteel)
            Text(ownerGreeting)
                .xertDisplay(30)
                .foregroundStyle(Color.xertOffWhite)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "Good morning, Byron" rather than a dashboard label. The first name
    /// comes from the signed-in profile; without one the greeting stands alone.
    private var ownerGreeting: String {
        let hour = Calendar.current.component(.hour, from: Date.now)
        let greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
        let firstName = store.profile?.full_name?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ")
            .first
            .map(String.init)
        guard let firstName, !firstName.isEmpty else { return greeting }
        return "\(greeting), \(firstName)"
    }

    private var stripeLaunchState: XertStripeLaunchRunway {
        let requiredSources = ["platform controls", "session packs", "Stripe health"]
        let sourcesAreCurrent = requiredSources.allSatisfy {
            admin.loadedSources.contains($0) && !admin.refreshUnavailableSources.contains($0)
        }
        let activeProducts = admin.products.filter(\.active)
        let blockingProductIDs = admin.commerceHealth?.issues?.compactMap { issue in
            admin.products.first {
                $0.slug.caseInsensitiveCompare(issue.slug) == .orderedSame
            }?.id
        } ?? []
        return XertStripeLaunchRunway.resolve(
            hasCompletedRefresh: admin.hasCompletedRefresh,
            isRefreshing: admin.isLoading,
            sourcesAreCurrent: sourcesAreCurrent,
            bookingsEnabled: admin.settings?.bookings_enabled,
            paymentsEnabled: admin.settings?.payments_enabled,
            hasActiveProducts: !activeProducts.isEmpty,
            activeProductsAreLinked: activeProducts.allSatisfy(\.hasStableStripePriceID),
            healthReady: admin.commerceHealth?.ready,
            paymentSwitchState: admin.commerceHealth?.payment_switch?.state,
            activationReceiptReady: admin.commerceHealth?.activation_receipt?.ready,
            blockingProductIDs: blockingProductIDs
        )
    }

    private var stripeLaunchRunway: some View {
        let runway = stripeLaunchState
        return Button {
            openOwnerRouteWithFeedback(runway.route)
        } label: {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: stripeRunwayIcon(runway.phase))
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(stripeRunwayColour(runway.phase))
                        .frame(width: 30)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("STRIPE LAUNCH RUNWAY")
                            .font(.caption2.weight(.black))
                            .tracking(1.4)
                            .foregroundStyle(Color.xertSteel)
                        Text(runway.title)
                            .font(.headline)
                            .foregroundStyle(Color.xertOffWhite)
                        Text(runway.detail)
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.72))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 4)
                }
                ProgressView(value: Double(runway.completedSteps), total: Double(XertStripeLaunchRunway.totalSteps))
                    .tint(stripeRunwayColour(runway.phase))
                HStack(spacing: 10) {
                    Text("\(runway.completedSteps)/\(XertStripeLaunchRunway.totalSteps) gates")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.xertPale.opacity(0.58))
                    Spacer()
                    Label(runway.actionTitle, systemImage: "arrow.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.xertSteel)
                        .labelStyle(.titleAndIcon)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .xertCardStyle()
            .overlay(alignment: .leading) {
                Rectangle().fill(stripeRunwayColour(runway.phase)).frame(width: 3)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Stripe launch runway, \(runway.title), \(runway.completedSteps) of \(XertStripeLaunchRunway.totalSteps) gates complete")
        .accessibilityHint(runway.actionTitle)
        .accessibilityIdentifier("owner.stripeLaunchRunway")
    }

    private func stripeRunwayIcon(_ phase: XertStripeLaunchPhase) -> String {
        switch phase {
        case .checking: return "arrow.triangle.2.circlepath"
        case .unavailable: return "wifi.exclamationmark"
        case .catalogBlocked: return "ticket"
        case .healthBlocked: return "exclamationmark.shield"
        case .controlsBlocked: return "switch.2"
        case .readyToOpenBookings: return "calendar.badge.checkmark"
        case .readyToActivate: return "checkmark.shield"
        case .live: return "bolt.shield.fill"
        }
    }

    private func stripeRunwayColour(_ phase: XertStripeLaunchPhase) -> Color {
        switch phase {
        case .checking: return Color.xertSteel
        case .unavailable, .catalogBlocked, .healthBlocked, .controlsBlocked: return Color.orange
        case .readyToOpenBookings, .readyToActivate: return Color.xertSteel
        case .live: return Color.green
        }
    }

    private var ownerActionsAccessibilityLabel: String {
        if admin.isLoading { return "Owner actions, refreshing" }
        let unavailableCount = admin.refreshUnavailableSources.count
        if unavailableCount > 0 {
            return "Owner actions, \(unavailableCount) data service"
                + (unavailableCount == 1 ? " needs attention" : "s need attention")
        }
        return "Owner actions"
    }

    private func incidentControl(session: AuthSession) -> some View {
        let sourceIsCurrent = admin.loadedSources.contains("platform controls")
            && !admin.refreshUnavailableSources.contains("platform controls")
            && !admin.isLoading
        let plan = AdminEmergencyPausePlan(
            settings: admin.settings,
            sourceIsCurrent: sourceIsCurrent
        )
        let communication = AdminIncidentCommunicationPlan(
            operationsState: plan.state,
            announcements: admin.announcements,
            sourceIsCurrent: quickMutationIsAvailable(source: "member notices")
        )
        let color = incidentControlColor(plan.state, communication: communication.state)

        return VStack(alignment: .leading, spacing: 13) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    incidentControlHeading
                    Spacer(minLength: 8)
                    incidentControlStatus(
                        plan: plan,
                        communication: communication.state,
                        color: color
                    )
                }
                VStack(alignment: .leading, spacing: 8) {
                    incidentControlHeading
                    incidentControlStatus(
                        plan: plan,
                        communication: communication.state,
                        color: color
                    )
                }
            }

            Text(plan.detail)
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.68))
                .fixedSize(horizontal: false, vertical: true)

            incidentCommunicationStatus(communication.state)

            if plan.state == .paused {
                incidentRunbook(communication: communication.state)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    incidentControlActions(
                        plan: plan,
                        communication: communication.state,
                        communicationNoticeID: communication.actionNoticeID,
                        session: session
                    )
                }
                VStack(spacing: 10) {
                    incidentControlActions(
                        plan: plan,
                        communication: communication.state,
                        communicationNoticeID: communication.actionNoticeID,
                        session: session
                    )
                }
            }
        }
        .padding(16)
        .background(Color.xertInk)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(color.opacity(0.38), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner.incidentControl")
        .confirmationDialog(
            "Pause new member activity?",
            isPresented: $confirmingEmergencyPause,
            titleVisibility: .visible
        ) {
            Button("Pause new activity now", role: .destructive) {
                pauseMemberOperations(session: session)
            }
            Button("Keep activity live", role: .cancel) {}
        } message: {
            Text("This immediately stops new bookings, waitlist joins and session-pack checkout. Existing bookings, class rosters, member records and owner tools remain available.")
        }
    }

    private var incidentControlHeading: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.shield")
                .font(.title3)
                .foregroundStyle(Color.xertSteel)
                .frame(width: 34, height: 34)
                .background(Color.xertSteel.opacity(0.1))
            VStack(alignment: .leading, spacing: 2) {
                adminHeading("Incident control")
                Text("Fast protection for member-facing operations")
                    .font(.caption2)
                    .foregroundStyle(Color.xertPale.opacity(0.5))
            }
        }
    }

    private func incidentControlStatus(
        plan: AdminEmergencyPausePlan,
        communication: AdminIncidentCommunicationState,
        color: Color
    ) -> some View {
        Text(incidentControlStatusLabel(plan.state, communication: communication))
            .font(.caption2.weight(.black))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .frame(minHeight: 30)
            .background(color.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(color.opacity(0.32), lineWidth: 1))
            .fixedSize(horizontal: true, vertical: false)
    }

    @ViewBuilder
    private func incidentControlActions(
        plan: AdminEmergencyPausePlan,
        communication: AdminIncidentCommunicationState,
        communicationNoticeID: UUID?,
        session: AuthSession
    ) -> some View {
        if plan.canPause {
            Button {
                XertHaptics.play(.warning)
                confirmingEmergencyPause = true
            } label: {
                Label("Pause bookings & checkout", systemImage: "pause.circle.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.red)
            .disabled(admin.isSavingSettings)
            .accessibilityHint("Opens a confirmation before pausing new member activity")

            incidentLiveCommunicationAction(
                state: communication,
                operationsState: plan.state,
                noticeID: communicationNoticeID,
                session: session
            )

            Button {
                openWorkspaceWithFeedback(.controls)
            } label: {
                Label("Review controls", systemImage: "switch.2")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.xertSteel)
            .disabled(admin.isSavingSettings)
        } else if plan.state == .unavailable {
            Button {
                Task { await admin.refresh(session: session) }
            } label: {
                Label(
                    admin.isLoading ? "Refreshing..." : "Refresh to unlock",
                    systemImage: "arrow.clockwise"
                )
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.orange)
            .disabled(admin.isLoading || admin.isSavingSettings)
        } else {
            if communication == .pausedUpdateLive {
                Button {
                    openIncidentNotice(communicationNoticeID)
                } label: {
                    Label("Review live update", systemImage: "checkmark.bubble.fill")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.green)
                .accessibilityHint("Opens the live member incident notice")
            } else if quickMutationIsAvailable(source: "member notices") {
                Button {
                    presentNoticeQuickAction(draft: .memberOperationsPaused())
                } label: {
                    Label("Draft member update", systemImage: "bell.badge.fill")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.xertSteel)
                .foregroundStyle(Color.xertNavy)
                .accessibilityHint("Opens an editable incident notice without publishing it")
            } else {
                Button {
                    Task { await admin.refresh(session: session) }
                } label: {
                    Label(
                        admin.isLoading ? "Refreshing..." : "Refresh notices",
                        systemImage: "arrow.clockwise"
                    )
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.orange)
                .disabled(admin.isLoading || admin.isSavingSettings)
                .accessibilityHint("Refreshes live data before preparing a member update")
            }

            Button {
                openWorkspaceWithFeedback(.health)
            } label: {
                Label("Investigate health", systemImage: "stethoscope")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.xertSteel)

            Button {
                openWorkspaceWithFeedback(.controls)
            } label: {
                Label("Reopen controls", systemImage: "switch.2")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.xertSteel)
            .disabled(admin.isSavingSettings)
        }
    }

    @ViewBuilder
    private func incidentLiveCommunicationAction(
        state: AdminIncidentCommunicationState,
        operationsState: AdminMemberOperationsState,
        noticeID: UUID?,
        session: AuthSession
    ) -> some View {
        switch state {
        case .livePauseNoticeConflict:
            Button {
                openIncidentNotice(noticeID)
            } label: {
                Label("Fix member message", systemImage: "exclamationmark.bubble.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.red)
            .accessibilityHint("Opens App notices to remove the contradictory pause update")
        case .recoveryUpdateNeeded:
            Button {
                presentNoticeQuickAction(draft: .memberOperationsRestored(
                    checkoutAvailable: operationsState == .liveCommerce
                ))
            } label: {
                Label("Draft all-clear", systemImage: "checkmark.message.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.xertSteel)
            .foregroundStyle(Color.xertNavy)
            .accessibilityHint("Opens an editable recovery update without publishing it")
        case .recoveryUpdateLive:
            Button {
                openIncidentNotice(noticeID)
            } label: {
                Label("Review all-clear", systemImage: "checkmark.bubble.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.green)
        case .unavailable:
            Button {
                Task { await admin.refresh(session: session) }
            } label: {
                Label(
                    admin.isLoading ? "Refreshing..." : "Verify messages",
                    systemImage: "arrow.clockwise"
                )
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.orange)
            .disabled(admin.isLoading || admin.isSavingSettings)
        case .normal, .pausedNeedsUpdate, .pausedUpdateLive:
            EmptyView()
        }
    }

    private func openIncidentNotice(_ noticeID: UUID?) {
        if let noticeID {
            openOwnerRouteWithFeedback(
                XertOwnerRoute(task: .announcement(noticeID))
            )
        } else {
            openWorkspaceWithFeedback(.notices)
        }
    }

    @ViewBuilder
    private func incidentCommunicationStatus(_ state: AdminIncidentCommunicationState) -> some View {
        switch state {
        case .livePauseNoticeConflict:
            incidentCommunicationLabel(
                "Member operations are live, but a member notice still says they are paused.",
                icon: "exclamationmark.bubble.fill",
                color: .red
            )
        case .recoveryUpdateNeeded:
            incidentCommunicationLabel(
                "Member operations are live again. Prepare an accurate all-clear update.",
                icon: "message.badge",
                color: .orange
            )
        case .recoveryUpdateLive:
            incidentCommunicationLabel(
                "A current recovery update is live for members.",
                icon: "checkmark.bubble.fill",
                color: .green
            )
        case .unavailable:
            incidentCommunicationLabel(
                "Refresh member notices before relying on communication status.",
                icon: "wifi.exclamationmark",
                color: .orange
            )
        case .normal, .pausedNeedsUpdate, .pausedUpdateLive:
            EmptyView()
        }
    }

    private func incidentCommunicationLabel(
        _ text: String,
        icon: String,
        color: Color
    ) -> some View {
        Label(text, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("owner.incidentCommunicationStatus")
    }

    private func incidentRunbook(
        communication: AdminIncidentCommunicationState
    ) -> some View {
        let communicationIcon: String
        let communicationColor: Color
        let communicationTitle: String
        let communicationDetail: String
        if communication == .pausedUpdateLive {
            communicationIcon = "checkmark.circle.fill"
            communicationColor = .green
            communicationTitle = "Member update is live"
            communicationDetail = "Review the live notice before publishing any follow-up."
        } else if communication == .unavailable {
            communicationIcon = "2.circle.fill"
            communicationColor = .orange
            communicationTitle = "Verify member communications"
            communicationDetail = "Refresh member notices before preparing an update."
        } else {
            communicationIcon = "2.circle.fill"
            communicationColor = Color.xertSteel
            communicationTitle = "Tell members what changed"
            communicationDetail = "Review the prepared update, then publish when accurate."
        }

        return VStack(alignment: .leading, spacing: 10) {
            Text("INCIDENT RUNBOOK")
                .font(.caption2.weight(.black))
                .foregroundStyle(Color.xertPale.opacity(0.48))

            incidentRunbookStep(
                icon: "checkmark.circle.fill",
                color: .green,
                title: "Member activity protected",
                detail: "New bookings, waitlists and checkout are paused."
            )
            incidentRunbookStep(
                icon: communicationIcon,
                color: communicationColor,
                title: communicationTitle,
                detail: communicationDetail
            )
            incidentRunbookStep(
                icon: "3.circle.fill",
                color: Color.xertSteel,
                title: "Investigate the cause",
                detail: "Check schema, Stripe, webhook and Apple push health."
            )
            incidentRunbookStep(
                icon: "4.circle.fill",
                color: Color.xertSteel,
                title: "Reopen deliberately",
                detail: "Use Settings only after live checks pass."
            )
        }
        .padding(.top, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner.incidentRunbook")
    }

    private func incidentRunbookStep(
        icon: String,
        color: Color,
        title: String,
        detail: String
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(color)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.xertOffWhite)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(Color.xertPale.opacity(0.56))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func pauseMemberOperations(session: AuthSession) {
        Task {
            if await admin.pauseMemberOperations(session: session) {
                platformDraftSnapshot = admin.settings
                XertHaptics.play(.success)
                UIAccessibility.post(
                    notification: .announcement,
                    argument: "New member bookings and checkout paused"
                )
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func incidentControlColor(
        _ state: AdminMemberOperationsState,
        communication: AdminIncidentCommunicationState
    ) -> Color {
        if communication == .livePauseNoticeConflict { return .red }
        if communication == .recoveryUpdateLive { return .green }
        switch state {
        case .unavailable, .bookingsOpen, .liveCommerce: return .orange
        case .paused: return .green
        case .inconsistent: return .red
        }
    }

    private func incidentControlStatusLabel(
        _ state: AdminMemberOperationsState,
        communication: AdminIncidentCommunicationState
    ) -> String {
        switch communication {
        case .livePauseNoticeConflict: return "MESSAGE CONFLICT"
        case .recoveryUpdateNeeded: return "ALL-CLEAR DUE"
        case .recoveryUpdateLive: return "RECOVERY SHARED"
        case .unavailable, .normal, .pausedNeedsUpdate, .pausedUpdateLive: break
        }
        switch state {
        case .unavailable: return "REFRESH REQUIRED"
        case .paused: return "PROTECTED"
        case .bookingsOpen: return "BOOKINGS LIVE"
        case .liveCommerce: return "COMMERCE LIVE"
        case .inconsistent: return "ACTION REQUIRED"
        }
    }

    private var quickTools: some View {
        VStack(alignment: .leading, spacing: 12) {
            adminHeading("Quick actions")
            LazyVGrid(columns: dashboardMetricColumns, spacing: 10) {
                AdminQuickToolButton(
                    title: "Find a member",
                    detail: "Search name, email or phone",
                    icon: "magnifyingglass"
                ) {
                    XertHaptics.play(.selection)
                    showingWorkspaceSwitcher = true
                }
                AdminQuickToolButton(
                    title: "Add a class",
                    detail: quickToolDetail(source: "full timetable", ready: "Add to the timetable"),
                    icon: "calendar.badge.plus",
                    isEnabled: quickMutationIsAvailable(source: "full timetable")
                ) {
                    presentQuickAction(.newClass)
                }
                AdminQuickToolButton(
                    title: "Publish a notice",
                    detail: quickToolDetail(source: "member notices", ready: "Show it in the member app"),
                    icon: "bell.badge.fill",
                    isEnabled: quickMutationIsAvailable(source: "member notices")
                ) {
                    presentNoticeQuickAction()
                }
                AdminQuickToolButton(
                    title: "Set today's workout",
                    detail: "Update the in-club TV",
                    icon: "tv"
                ) {
                    openWorkspaceWithFeedback(.workouts)
                }
                AdminQuickToolButton(
                    title: "Create a form",
                    detail: "Survey, waiver or feedback",
                    icon: "list.clipboard"
                ) {
                    requestCreateForm()
                }
                AdminQuickToolButton(
                    title: "Text members",
                    detail: "SMS any group with a mobile",
                    icon: "message.badge"
                ) {
                    openWorkspaceWithFeedback(.sms)
                }
            }
        }
    }

    private func quickMutationIsAvailable(source: String) -> Bool {
        !admin.isLoading
            && admin.loadedSources.contains(source)
            && !admin.refreshUnavailableSources.contains(source)
    }

    private func quickToolDetail(source: String, ready: String) -> String {
        if admin.isLoading && !admin.loadedSources.contains(source) { return "Checking access…" }
        if admin.refreshUnavailableSources.contains(source) || !admin.loadedSources.contains(source) {
            return "Refresh required before editing"
        }
        return ready
    }

    private var attentionGrid: some View {
        VStack(alignment: .leading, spacing: 12) {
            adminHeading("At a glance")
            LazyVGrid(columns: dashboardMetricColumns, spacing: 10) {
                AdminMetricTile(
                    title: "Class requests",
                    value: admin.requestedPlaces,
                    icon: "tray.full",
                    dataState: dashboardDataState(for: "today's classes")
                ) {
                    openWorkspaceWithFeedback(.bookingRequests)
                }
                AdminMetricTile(
                    title: "Waitlisted",
                    value: admin.waitingMembers,
                    icon: "person.2.badge.clock",
                    dataState: dashboardDataState(for: "waitlists")
                ) {
                    openWorkspaceWithFeedback(.classDesk)
                }
                AdminMetricTile(
                    title: "Follow-ups",
                    value: admin.followUps.count,
                    icon: "phone.arrow.up.right",
                    dataState: dashboardDataState(for: "retention")
                ) {
                    openWorkspaceWithFeedback(.retention)
                }
                AdminMetricTile(
                    title: "Roll calls",
                    value: admin.attendanceDue,
                    icon: "checklist",
                    dataState: dashboardDataState(for: "today's classes")
                ) {
                    openOwnerRouteWithFeedback(attendancePriorityRoute)
                }
            }
        }
    }

    private var priorityQueue: some View {
        let priorities = operationalPriorities
        return VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    adminHeading("Needs you")
                    Spacer(minLength: 8)
                    operationalPulseControl
                }
                VStack(alignment: .leading, spacing: 8) {
                    adminHeading("Needs you")
                    operationalPulseControl
                }
            }

            operationalQueueContent(priorities)
        }
    }

    private var operationalPulseControl: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let freshness = AdminOperationalRefreshPolicy.freshness(
                hasCompletedRefresh: admin.hasCompletedRefresh,
                updatedAt: admin.operationalUpdatedAt,
                isRefreshing: admin.isRefreshingOperations,
                hasUnavailableSources: admin.operationalQueueHasUnavailableSources,
                now: context.date
            )
            Button(action: refreshOperationalPulse) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(operationalFreshnessColour(freshness))
                        .frame(width: 7, height: 7)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(freshness.label.uppercased())
                            .font(.system(size: 9, weight: .black))
                            .tracking(1.2)
                        if let updatedAt = admin.operationalUpdatedAt {
                            Text(updatedAt, style: .relative)
                                .font(.caption2)
                                .fontWeight(.semibold)
                                .textCase(.lowercase)
                        }
                    }
                    if admin.isRefreshingOperations {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.caption.weight(.bold))
                    }
                }
                .foregroundStyle(operationalFreshnessColour(freshness))
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Color.white.opacity(0.04))
                .clipShape(Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(admin.isLoading || admin.isRefreshingOperations)
            .accessibilityLabel("Operational queues \(freshness.label.lowercased())")
            .accessibilityValue(
                admin.operationalUpdatedAt.map {
                    "Last fully refreshed \($0.formatted(date: .omitted, time: .shortened))"
                } ?? "No complete operational snapshot"
            )
            .accessibilityHint("Refreshes requests, waitlists, retention, activation, orders and private training without leaving this screen")
            .accessibilityIdentifier("owner.operationalPulse")
        }
    }

    private var shiftBriefing: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let freshness = AdminOperationalRefreshPolicy.freshness(
                hasCompletedRefresh: admin.hasCompletedRefresh,
                updatedAt: admin.operationalUpdatedAt,
                isRefreshing: admin.isRefreshingOperations,
                hasUnavailableSources: admin.operationalQueueHasUnavailableSources,
                now: context.date
            )
            // Computed in a closure rather than a deferred `let` plus if/else:
            // this is a @ViewBuilder body, so ViewBuilder tries to build the
            // if/else as a conditional view and the assignments inside it are
            // not Views ("'buildExpression' is unavailable").
            let unavailableSources: [String] = {
                if case .partial(let sources) = admin.operationalQueueState { return sources }
                return []
            }()
            let briefing = AdminShiftBriefing(
                generatedAt: context.date,
                sourceUpdatedAt: admin.operationalUpdatedAt,
                classes: admin.dailyOperations.map { AdminShiftClassBrief(operation: $0) },
                requestedPlaces: admin.requestedPlaces,
                waitlistedMembers: admin.waitingMembers,
                attendanceDue: admin.attendanceDue,
                activationActions: admin.activationQueue.count,
                retentionFollowUps: admin.followUps.count,
                pendingPTRequests: admin.pendingPTRequests,
                recoverableOrders: admin.orders.lazy.filter(\.isRecoverable).count,
                classSetupGaps: dailyClassReadiness.affectedClassCount,
                unavailableSources: unavailableSources
            )
            let canShare = freshness == .current && admin.operationalQueueState == .ready

            VStack(alignment: .leading, spacing: 12) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        shiftBriefingHeading
                        Spacer(minLength: 8)
                        shiftBriefingStatus(freshness: freshness)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        shiftBriefingHeading
                        shiftBriefingStatus(freshness: freshness)
                    }
                }

                HStack(spacing: 12) {
                    shiftBriefingMetric(
                        briefing.classes.count,
                        label: "Today's classes",
                        icon: "calendar"
                    )
                    shiftBriefingMetric(
                        briefing.openActionCount,
                        label: "Open actions",
                        icon: briefing.openActionCount > 0 ? "exclamationmark.circle" : "checkmark.circle"
                    )
                }

                if let nextClass = briefing.classes
                    .filter({ $0.startTime >= context.date })
                    .min(by: { $0.startTime < $1.startTime }) {
                    Label(
                        "Next: \(nextClass.startTime.formatted(date: .omitted, time: .shortened)) - \(nextClass.title)",
                        systemImage: "clock"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.xertPale.opacity(0.72))
                    .fixedSize(horizontal: false, vertical: true)
                }

                Text("No member names, contact details, notes or payment identifiers are included.")
                    .font(.caption2)
                    .foregroundStyle(Color.xertPale.opacity(0.5))
                    .fixedSize(horizontal: false, vertical: true)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        shiftBriefingActions(briefing: briefing, canShare: canShare)
                    }
                    VStack(spacing: 10) {
                        shiftBriefingActions(briefing: briefing, canShare: canShare)
                    }
                }

                if !canShare {
                    Label(
                        "Refresh operational queues before copying or sharing this handoff.",
                        systemImage: "lock.shield"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(XertSpace.lg)
            .xertCardStyle()
            .accessibilityElement(children: .contain)
        }
    }

    private var shiftBriefingHeading: some View {
        VStack(alignment: .leading, spacing: 3) {
            adminHeading("Owner shift brief")
            Text("A privacy-safe staff handoff from the live operating queues")
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.6))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func shiftBriefingStatus(freshness: AdminOperationalFreshness) -> some View {
        Label(freshness.label.uppercased(), systemImage: freshness == .current ? "checkmark.shield.fill" : "clock.badge.exclamationmark")
            .font(.caption2.weight(.black))
            .foregroundStyle(operationalFreshnessColour(freshness))
            .padding(.horizontal, 9)
            .frame(minHeight: 32)
            .background(operationalFreshnessColour(freshness).opacity(0.1))
            .overlay(
                Rectangle()
                    .stroke(operationalFreshnessColour(freshness).opacity(0.34), lineWidth: 1)
            )
    }

    private func shiftBriefingMetric(_ value: Int, label: String, icon: String) -> some View {
        HStack(spacing: 9) {
            Image(systemName: icon)
                .foregroundStyle(Color.xertSteel)
            VStack(alignment: .leading, spacing: 1) {
                Text(value.formatted())
                    .font(.title3.weight(.bold).monospacedDigit())
                    .foregroundStyle(Color.xertOffWhite)
                Text(label.uppercased())
                    .font(.system(size: 8, weight: .black))
                    .foregroundStyle(Color.xertPale.opacity(0.5))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
        .padding(.horizontal, 12)
        .background(Color.xertDeep.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.xertSteel.opacity(0.18), lineWidth: 1))
    }

    @ViewBuilder
    private func shiftBriefingActions(
        briefing: AdminShiftBriefing,
        canShare: Bool
    ) -> some View {
        if canShare {
            ShareLink(
                item: briefing.text,
                subject: Text("XERT owner shift brief")
            ) {
                Label("Share brief", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.xertSteel)
            .foregroundStyle(Color.xertNavy)
            .accessibilityHint("Shares a current privacy-safe operational handoff")

            Button {
                UIPasteboard.general.string = briefing.text
                XertHaptics.play(.success)
                UIAccessibility.post(notification: .announcement, argument: "Shift brief copied")
                let feedbackID = UUID()
                shiftBriefCopyFeedbackID = feedbackID
                Task {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard shiftBriefCopyFeedbackID == feedbackID else { return }
                    shiftBriefCopyFeedbackID = nil
                }
            } label: {
                Label(
                    shiftBriefCopyFeedbackID == nil ? "Copy brief" : "Copied",
                    systemImage: shiftBriefCopyFeedbackID == nil ? "doc.on.doc" : "checkmark"
                )
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(Color.xertSteel)
            .accessibilityHint("Copies a current privacy-safe operational handoff")
        } else {
            Button(action: refreshOperationalPulse) {
                Label(
                    admin.isRefreshingOperations ? "Refreshing..." : "Refresh to unlock",
                    systemImage: "arrow.clockwise"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.xertSteel)
            .foregroundStyle(Color.xertNavy)
            .disabled(admin.isLoading || admin.isRefreshingOperations)
        }
    }

    private func operationalFreshnessColour(_ freshness: AdminOperationalFreshness) -> Color {
        switch freshness {
        case .current: return .green
        case .loading, .refreshing: return Color.xertSteel
        case .stale: return .orange
        case .unavailable: return .red
        }
    }

    @ViewBuilder
    private func operationalQueueContent(_ priorities: [AdminPriorityAction]) -> some View {
        switch admin.operationalQueueState {
        case .idle, .loading:
            HStack(spacing: 12) {
                ProgressView().tint(Color.xertSteel)
                Text("Checking what needs you…")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.xertPale.opacity(0.82))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(XertSpace.lg)
            .xertCardStyle()
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Checking what needs you")
        case .partial(let unavailableSources):
            AdminOperationalDataWarning(unavailableSources: unavailableSources)
            if priorities.isEmpty {
                AdminEmptyState(
                    icon: "exclamationmark.triangle.fill",
                    text: "Nothing waiting in the parts we could check. Some data could not be loaded."
                )
            } else {
                priorityRows(priorities)
            }
        case .ready:
            if priorities.isEmpty {
                AdminEmptyState(icon: "checkmark.seal.fill", text: "Nothing needs you right now.")
            } else {
                priorityRows(priorities)
            }
        }
    }

    @ViewBuilder
    private func priorityRows(_ priorities: [AdminPriorityAction]) -> some View {
        ForEach(priorities) { priority in
            AdminPriorityRow(priority: priority) {
                openOwnerRouteWithFeedback(priority.route)
            }
        }
    }

    private var operationalPriorities: [AdminPriorityAction] {
        [
            AdminPriorityAction(
                title: "System status needs attention",
                detail: "Something is not connected properly",
                icon: "cross.case.fill",
                count: admin.healthIssues,
                workspace: .health,
                isCritical: true
            ),
            AdminPriorityAction(
                title: "Pricing needs a fix",
                detail: admin.products.isEmpty
                    ? "Create the first private session-pack draft"
                    : "Fix active packs before members reach checkout",
                icon: "ticket",
                count: pricingAttentionCount,
                workspace: .products,
                task: singlePricingAttentionTask,
                isCritical: admin.settings?.payments_enabled == true
            ),
            AdminPriorityAction(
                title: "Class requests waiting",
                detail: "Say yes or no to people asking for a spot",
                icon: "person.crop.circle.badge.questionmark",
                count: admin.requestedPlaces,
                workspace: .bookingRequests,
                task: singleBookingRequestTask ?? singleBookingRequestClassTask
            ),
            AdminPriorityAction(
                title: "Classes missing a coach or area",
                detail: dailyClassSetupPriorityDetail,
                icon: "calendar.badge.exclamationmark",
                count: dailyClassReadiness.affectedClassCount,
                workspace: .timetable,
                task: dailyClassReadiness.singleAffectedClassID.map { .classSetup($0) },
                isCritical: dailyClassReadiness.issues.contains(where: \.isCritical)
            ),
            AdminPriorityAction(
                title: "Personal training enquiries",
                detail: "People asking for one-on-one sessions",
                icon: "figure.strengthtraining.traditional",
                count: admin.pendingPTRequests,
                workspace: .ptRequests,
                task: singlePTRequestTask
            ),
            AdminPriorityAction(
                title: "Roll calls to finish",
                detail: "Mark who turned up",
                icon: "checklist",
                count: admin.attendanceDue,
                workspace: .classDesk,
                task: singleAttendanceTask
            ),
            AdminPriorityAction(
                title: "People on waitlists",
                detail: "Free spots you could offer them",
                icon: "person.2.badge.clock",
                count: admin.waitingMembers,
                workspace: .classDesk,
                task: singleWaitlistClassTask
            ),
            AdminPriorityAction(
                title: "New members to welcome",
                detail: "Finish sign-up and book their first class",
                icon: "person.crop.circle.badge.exclamationmark",
                count: admin.activationQueue.count,
                workspace: .retention,
                task: singleActivationTask
            ),
            AdminPriorityAction(
                title: "New enquiries",
                detail: leadActionPriorityDetail,
                icon: "person.2.badge.plus",
                count: admin.leadActionCounts?.total ?? 0,
                workspace: .leads,
                isCritical: (admin.leadActionCounts?.overdueTotal ?? 0) > 0
            ),
            AdminPriorityAction(
                title: "Members to follow up",
                detail: "They have gone quiet, give them a call",
                icon: "phone.arrow.up.right",
                count: admin.followUps.count,
                workspace: .retention,
                task: singleRetentionTask
            ),
            AdminPriorityAction(
                title: "Payments to check",
                detail: "Paid but not matched to an order yet",
                icon: "arrow.triangle.2.circlepath.circle",
                count: admin.orders.lazy.filter(\.isRecoverable).count,
                workspace: .orders,
                task: singleRecoverableOrderTask,
                isCritical: true
            ),
        ]
        .filter { $0.count > 0 }
        .sorted {
            if $0.isCritical != $1.isCritical { return $0.isCritical }
            return $0.count > $1.count
        }
    }

    private var dailyClassReadiness: AdminDailyClassReadiness {
        AdminDailyClassReadiness(
            operations: admin.dailyOperations,
            sourceIsCurrent: admin.loadedSources.contains("today's classes")
                && !admin.refreshUnavailableSources.contains("today's classes")
        )
    }

    private var dailyClassSetupPriorityDetail: String {
        let readiness = dailyClassReadiness
        guard readiness.affectedClassCount > 0 else {
            return "Today's published classes are ready"
        }
        if readiness.issues.contains(where: \.isCritical) {
            return "Resolve over-capacity rosters and missing class setup"
        }
        return "Assign coaches, training areas or valid capacity"
    }

    private var pricingAttentionCount: Int {
        guard !admin.refreshUnavailableSources.contains("session packs") else { return 0 }
        if !admin.products.contains(where: \.active) { return 1 }
        return admin.products.filter { $0.active && !$0.hasStableStripePriceID }.count
    }

    private var singlePricingAttentionTask: XertOwnerTask? {
        guard !admin.refreshUnavailableSources.contains("session packs") else { return nil }
        let unlinkedActiveProducts = admin.products.filter { $0.active && !$0.hasStableStripePriceID }
        if unlinkedActiveProducts.count == 1, let product = unlinkedActiveProducts.first {
            return .product(product.id)
        }
        guard !admin.products.contains(where: \.active),
              admin.products.count == 1,
              let draft = admin.products.first else { return nil }
        return .product(draft.id)
    }

    private var singleBookingRequestClassTask: XertOwnerTask? {
        let affectedClasses = admin.dailyOperations.filter {
            $0.requested_count + $0.public_request_count > 0
        }
        guard affectedClasses.count == 1, let operation = affectedClasses.first else { return nil }
        return .classSession(operation.id)
    }

    private var singleBookingRequestTask: XertOwnerTask? {
        let pendingRequests = admin.bookingRequests.filter { $0.status == "requested" }
        guard pendingRequests.count == 1,
              let request = pendingRequests.first,
              let recordID = request.routeRecordID else { return nil }
        return .bookingRequest(request.source, recordID)
    }

    private var singleAttendanceTask: XertOwnerTask? {
        let due = admin.dailyOperations.filter(\.attendance_due)
        guard due.count == 1, let operation = due.first else { return nil }
        return .classSession(operation.id)
    }

    private var singleWaitlistClassTask: XertOwnerTask? {
        let affectedClasses = admin.waitlist.filter { $0.waitlist_count > 0 }
        guard affectedClasses.count == 1, let item = affectedClasses.first else { return nil }
        return .classSession(item.session_id)
    }

    private var singlePTRequestTask: XertOwnerTask? {
        let pendingRequests = admin.ptRequests.filter(\.isPending)
        guard pendingRequests.count == 1, let request = pendingRequests.first else { return nil }
        return .ptRequest(request.id)
    }

    private var singleActivationTask: XertOwnerTask? {
        guard admin.activationQueue.count == 1,
              let member = admin.activationQueue.first else { return nil }
        return .member(member.id)
    }

    private var leadActionPriorityDetail: String {
        guard let counts = admin.leadActionCounts else {
            return "Member, trainer and partner intake"
        }
        if counts.overdueTotal > 0 {
            return "\(counts.overdueTotal) waiting 24h+ · \(counts.memberLeads) members · \(counts.trainerApplicants) trainers · \(counts.partnerEnquiries) partners"
        }
        return "\(counts.memberLeads) members · \(counts.trainerApplicants) trainers · \(counts.partnerEnquiries) partners"
    }

    private var singleRetentionTask: XertOwnerTask? {
        guard admin.followUps.count == 1, let followUp = admin.followUps.first else { return nil }
        return .member(followUp.id)
    }

    private var singleRecoverableOrderTask: XertOwnerTask? {
        let recoverableOrders = admin.orders.filter(\.isRecoverable)
        guard recoverableOrders.count == 1, let order = recoverableOrders.first else { return nil }
        return .order(order.id)
    }

    private var attendancePriorityRoute: XertOwnerRoute {
        singleAttendanceTask.map { XertOwnerRoute(task: $0) }
            ?? XertOwnerRoute(workspace: .classDesk)
    }

    // Revenue and totals are review material, not shift work, so they sit last
    // and stay collapsed by default. The disclosure mirrors the management
    // directory so both closing sections behave identically.
    private var businessPulse: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                XertHaptics.play(.selection)
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) {
                    showingBusinessPulse.toggle()
                }
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        adminHeading("Money")
                        Text(showingBusinessPulse
                             ? "Hide revenue, members and orders"
                             : "Revenue, members and orders")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.6))
                    }
                    Spacer(minLength: 8)
                    Image(systemName: showingBusinessPulse ? "chevron.up.circle.fill" : "chevron.down.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Color.xertSteel)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showingBusinessPulse ? "Hide money" : "Show money")

            if showingBusinessPulse {
                LazyVGrid(columns: dashboardMetricColumns, spacing: 10) {
                    AdminMoneyTile(
                        title: "This month",
                        cents: admin.monthRevenueCents,
                        dataState: dashboardDataState(for: "orders")
                    ) {
                        openWorkspaceWithFeedback(.finance)
                    }
                    AdminMoneyTile(
                        title: "Total revenue",
                        cents: admin.totalRevenueCents,
                        dataState: dashboardDataState(for: "orders")
                    ) {
                        openWorkspaceWithFeedback(.finance)
                    }
                    AdminMetricTile(
                        title: "Members",
                        value: admin.memberCount,
                        icon: "person.2",
                        dataState: dashboardDataState(for: "members")
                    ) {
                        openWorkspaceWithFeedback(.members)
                    }
                    AdminMetricTile(
                        title: "Paid orders",
                        value: admin.paidOrders.count,
                        icon: "creditcard",
                        dataState: dashboardDataState(for: "orders")
                    ) {
                        openWorkspaceWithFeedback(.orders)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var activationPulse: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                adminHeading("Member activation · 30 days")
                Spacer()
                Button("OPEN ACTIONS") { openWorkspaceWithFeedback(.retention) }
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.xertSteel)
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens member activation and retention actions")
            }

            if admin.activationOverview == nil && (admin.isLoading || admin.lastUpdatedAt == nil) {
                HStack(spacing: 12) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Building the member activation snapshot…")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale.opacity(0.75))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(XertSpace.lg)
                .xertCardStyle()
            } else if let overview = admin.activationOverview {
                if admin.refreshUnavailableSources.contains("member activation") {
                    Label("Showing the last activation snapshot. Pull to refresh before outreach.", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                LazyVGrid(columns: dashboardMetricColumns, spacing: 10) {
                    ForEach(Array(overview.stages.enumerated()), id: \.offset) { _, stage in
                        let percentage = overview.accounts_created > 0
                            ? Int((Double(stage.count) / Double(overview.accounts_created) * 100).rounded())
                            : nil
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(stage.count)").xertDisplay(28)
                            Text(stage.label.uppercased())
                                .font(.caption2.weight(.bold))
                                .tracking(0.7)
                                .foregroundStyle(Color.xertSteel)
                            Text(percentage.map { "\($0)% of accounts" } ?? "No cohort yet")
                                .font(.caption2)
                                .foregroundStyle(Color.xertPale.opacity(0.58))
                        }
                        .frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
                        .padding(XertSpace.lg)
                        .xertCardStyle()
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(stage.label), \(stage.count), \(percentage.map { "\($0) percent of accounts" } ?? "no cohort yet")")
                    }
                }
                Text("Current readiness, training access, confirmed bookings and recorded attendance · as of \(overview.as_of.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption2)
                    .foregroundStyle(Color.xertPale.opacity(0.5))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                AdminEmptyState(
                    icon: "chart.bar.xaxis",
                    text: "Activation reporting is unavailable until System status verifies the member activation upgrade."
                )
            }
        }
    }

    private func dashboardDataState(for source: String) -> AdminDashboardDataState {
        if admin.refreshUnavailableSources.contains(source) {
            return admin.loadedSources.contains(source) ? .stale : .unavailable
        }
        if admin.loadedSources.contains(source) { return .current }
        return admin.isLoading || admin.lastUpdatedAt == nil ? .loading : .unavailable
    }

    private var todayDesk: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                adminHeading("Today's classes")
                Spacer()
                Button {
                    openWorkspaceWithFeedback(.classDesk)
                } label: {
                    Text("OPEN DESK")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.xertOffWhite)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens today's class desk")
            }
            todayClassContent
        }
    }

    private var nextClassFocus: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let focus = AdminClassOperationalFocus.resolve(
                operations: admin.dailyOperations,
                sourceIsCurrent: dashboardDataState(for: "today's classes") == .current,
                now: context.date
            ) {
                let operation = focus.operation
                let setupIssues = dailyClassReadiness.issues(for: operation.id)

                VStack(alignment: .leading, spacing: 14) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) {
                            nextClassHeading
                            Spacer(minLength: 8)
                            nextClassPhaseLabel(focus)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            nextClassHeading
                            nextClassPhaseLabel(focus)
                        }
                    }

                    VStack(alignment: .leading, spacing: 5) {
                        Text(operation.title)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(Color.xertOffWhite)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(nextClassScheduleLine(operation))
                            .font(.subheadline)
                            .foregroundStyle(Color.xertPale.opacity(0.72))
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 18) {
                            nextClassMetric(operation.confirmed_count, label: "Confirmed")
                            nextClassMetric(
                                operation.requested_count + operation.public_request_count,
                                label: "Requested"
                            )
                            nextClassMetric(operation.waitlist_count, label: "Waiting")
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            nextClassMetric(operation.confirmed_count, label: "Confirmed")
                            nextClassMetric(
                                operation.requested_count + operation.public_request_count,
                                label: "Requested"
                            )
                            nextClassMetric(operation.waitlist_count, label: "Waiting")
                        }
                    }

                    if let setupSummary = dailyClassReadiness.summary(for: operation.id) {
                        Label(setupSummary, systemImage: "wrench.and.screwdriver.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        let task: XertOwnerTask = setupIssues.isEmpty
                            ? .classSession(operation.id)
                            : .classSetup(operation.id)
                        openOwnerRouteWithFeedback(XertOwnerRoute(task: task))
                    } label: {
                        Label(
                            nextClassActionTitle(focus, hasSetupIssues: !setupIssues.isEmpty),
                            systemImage: setupIssues.isEmpty
                                ? (focus.phase == .attendanceDue ? "checklist" : "person.3")
                                : "wrench.and.screwdriver.fill"
                        )
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(setupIssues.isEmpty ? Color.xertSteel : Color.orange)
                    .accessibilityHint(
                        setupIssues.isEmpty
                            ? "Opens the exact class roster"
                            : "Opens the exact class setup editor"
                    )
                }
                .padding(XertSpace.lg)
                .xertCardStyle()
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("owner.nextClassFocus")
            }
        }
    }

    private var nextClassHeading: some View {
        adminHeading("Next class")
    }

    private func nextClassPhaseLabel(_ focus: AdminClassOperationalFocus) -> some View {
        let text: String
        let icon: String
        let colour: Color
        switch focus.phase {
        case .attendanceDue:
            text = "ROLL CALL DUE"
            icon = "checklist"
            colour = .orange
        case .live:
            text = "IN PROGRESS"
            icon = "figure.run"
            colour = .green
        case .upcoming:
            text = focus.operation.start_time.formatted(.relative(presentation: .named))
                .uppercased()
            icon = "clock"
            colour = Color.xertSteel
        }
        return Label(text, systemImage: icon)
            .font(.caption2.weight(.black))
            .foregroundStyle(colour)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(nextClassPhaseAccessibilityLabel(focus))
    }

    private func nextClassPhaseAccessibilityLabel(_ focus: AdminClassOperationalFocus) -> String {
        switch focus.phase {
        case .attendanceDue: return "Roll call due"
        case .live: return "Class in progress"
        case .upcoming:
            return "Starts \(focus.operation.start_time.formatted(.relative(presentation: .named)))"
        }
    }

    private func nextClassScheduleLine(_ operation: AdminDailyOperation) -> String {
        let schedule = operation.start_time.formatted(date: .omitted, time: .shortened)
        let assignment = classAssignmentSummary(operation)
        return "\(schedule) · \(assignment)"
    }

    private func nextClassMetric(_ value: Int, label: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text("\(value)")
                .font(.headline.weight(.black))
                .foregroundStyle(Color.xertOffWhite)
            Text(label)
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.62))
        }
        .accessibilityElement(children: .combine)
    }

    private func nextClassActionTitle(
        _ focus: AdminClassOperationalFocus,
        hasSetupIssues: Bool
    ) -> String {
        if hasSetupIssues { return "Fix class setup" }
        switch focus.phase {
        case .attendanceDue: return "Complete roll call"
        case .live: return "Open live roster"
        case .upcoming: return "Open class roster"
        }
    }

    @ViewBuilder
    private var todayClassContent: some View {
        switch dashboardDataState(for: "today's classes") {
        case .loading:
            HStack(spacing: 12) {
                ProgressView().tint(Color.xertSteel)
                Text("Loading today's class desk…")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale.opacity(0.72))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(XertSpace.lg)
            .xertCardStyle()
        case .unavailable:
            AdminEmptyState(
                icon: "wifi.exclamationmark",
                text: "Today's classes are unavailable. Retry before relying on the desk."
            )
        case .stale:
            Label("Showing the last class snapshot. Pull to refresh before changing attendance.", systemImage: "clock.badge.exclamationmark")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(.horizontal, 2)
            if admin.dailyOperations.isEmpty {
                AdminEmptyState(icon: "calendar", text: "No classes were in the last available snapshot.")
            } else {
                todayClassRows
            }
        case .current:
            if admin.dailyOperations.isEmpty {
                AdminEmptyState(icon: "calendar", text: "No classes are scheduled today.")
            } else {
                todayClassRows
            }
        }
    }

    private var todayClassRows: some View {
        ForEach(admin.dailyOperations.prefix(4)) { item in
            let setupIssues = dailyClassReadiness.issues(for: item.id)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 14) {
                    VStack(spacing: 2) {
                        Text(item.start_time.formatted(date: .omitted, time: .shortened))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Color.xertOffWhite)
                        Text(item.status.uppercased())
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.xertSteel)
                    }
                    .frame(width: 72)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.headline)
                            .foregroundStyle(Color.xertOffWhite)
                        Text(classCapacitySummary(item))
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.6))
                            .fixedSize(horizontal: false, vertical: true)
                        Label(
                            classAssignmentSummary(item),
                            systemImage: setupIssues.isEmpty
                                ? "person.crop.circle.badge.checkmark"
                                : "exclamationmark.triangle.fill"
                        )
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(setupIssues.isEmpty ? Color.xertSteel : Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    if item.attendance_due {
                        Image(systemName: "checklist")
                            .foregroundStyle(Color.orange)
                            .accessibilityLabel("Attendance due")
                    }
                }

                if let setupSummary = dailyClassReadiness.summary(for: item.id) {
                    Label(setupSummary, systemImage: "wrench.and.screwdriver.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        todayClassActions(item, hasSetupIssues: !setupIssues.isEmpty)
                    }
                    VStack(spacing: 10) {
                        todayClassActions(item, hasSetupIssues: !setupIssues.isEmpty)
                    }
                }
            }
            .padding(XertSpace.lg)
            .xertCardStyle()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("owner.todayClass.\(item.id.uuidString.lowercased())")
        }
    }

    @ViewBuilder
    private func todayClassActions(
        _ item: AdminDailyOperation,
        hasSetupIssues: Bool
    ) -> some View {
        Button {
            openOwnerRouteWithFeedback(XertOwnerRoute(task: .classSession(item.id)))
        } label: {
            Label(
                item.attendance_due ? "Open roll call" : "Open roster",
                systemImage: item.attendance_due ? "checklist" : "person.3"
            )
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(Color.xertSteel)
        .accessibilityHint("Opens bookings, waitlist and attendance for this class")

        if hasSetupIssues {
            Button {
                openOwnerRouteWithFeedback(XertOwnerRoute(task: .classSetup(item.id)))
            } label: {
                Label("Fix setup", systemImage: "wrench.and.screwdriver.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.orange)
            .accessibilityHint("Opens this exact class editor")
        }
    }

    private func classCapacitySummary(_ item: AdminDailyOperation) -> String {
        let capacity = item.capacity.map { "\($0) capacity" } ?? "capacity missing"
        // Counts both doors into the room. A class filled through the public
        // timetable used to read "0 confirmed / 8 capacity" here while eight
        // people were on their way in.
        return "\(item.confirmedInRoom) confirmed / \(capacity) · "
            + "\(item.requested_count + item.public_request_count) requested · "
            + "\(item.waitingInRoom) waiting"
    }

    private func classAssignmentSummary(_ item: AdminDailyOperation) -> String {
        let coach = item.coach_name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let location = item.location_zone?.trimmingCharacters(in: .whitespacesAndNewlines)
        let values = [
            coach.flatMap { $0.isEmpty ? nil : $0 },
            location.flatMap { $0.isEmpty ? nil : $0 },
        ].compactMap { $0 }
        return values.isEmpty ? "Coach and training area not assigned" : values.joined(separator: " · ")
    }

    /// The four hubs, always visible. Tapping a hub card lists its screens
    /// right underneath; tapping again folds them away.
    private var managementDirectory: some View {
        VStack(alignment: .leading, spacing: 12) {
            adminHeading("Go to")
            LazyVGrid(columns: dashboardMetricColumns, spacing: 10) {
                ForEach(XertOwnerWorkspaceSection.allCases) { section in
                    AdminHubCard(
                        section: section,
                        badge: hubBadge(section),
                        isExpanded: expandedHub == section
                    ) {
                        XertHaptics.play(.selection)
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) {
                            expandedHub = expandedHub == section ? nil : section
                        }
                    }
                }
            }
            if let section = expandedHub {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(XertOwnerWorkspace.workspaces(in: section)) { workspace in
                        AdminDestinationRow(
                            title: workspace.title,
                            detail: compactWorkspaceDetail(workspace),
                            icon: workspace.icon,
                            onOpen: { openWorkspaceWithFeedback(workspace) }
                        )
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    /// Open items per hub, so the owner can see where the work is before
    /// tapping in. Mirrors the badge the web Command Centre shows.
    private func hubBadge(_ section: XertOwnerWorkspaceSection) -> Int {
        switch section {
        case .classes:
            return admin.requestedPlaces + admin.attendanceDue + admin.waitingMembers + admin.pendingPTRequests
        case .people:
            return (admin.leadActionCounts?.total ?? 0) + admin.followUps.count + admin.activationQueue.count
        case .communications, .website:
            return 0
        case .business:
            return admin.healthIssues + admin.orders.lazy.filter(\.isRecoverable).count
        }
    }

    @ViewBuilder
    private var pinnedDirectory: some View {
        if !pinnedWorkspaces.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                adminHeading("Pinned Workspaces")
                ForEach(pinnedWorkspaces) { workspace in
                    AdminDestinationRow(
                        title: workspace.title,
                        detail: compactWorkspaceDetail(workspace),
                        icon: workspace.icon,
                        onOpen: { openWorkspaceWithFeedback(workspace) }
                    )
                }
            }
        }
    }

    private func compactWorkspaceDetail(_ workspace: XertOwnerWorkspace) -> String {
        switch workspace {
        case .members:
            return "Search \(admin.memberCount) accounts and review member value"
        case .access:
            return "Review administrators, role changes and recovery cover"
        case .notices:
            return "\(admin.liveAnnouncements) live · publish to web and iOS"
        case .health:
            if !admin.hasCompletedRefresh {
                return "Checking release services"
            }
            if admin.unavailableHealthSourceCount > 0 {
                return "\(admin.unavailableHealthSourceCount) live health check\(admin.unavailableHealthSourceCount == 1 ? "" : "s") unavailable"
            }
            if !admin.hasHealthSnapshot { return "Release health response incomplete" }
            return admin.healthIssues == 0
                ? "Schema, Stripe and APNs ready"
                : "\(admin.healthIssues) release issue\(admin.healthIssues == 1 ? "" : "s")"
        default:
            return workspace.detail
        }
    }

    private func workspaceBadge(_ workspace: XertOwnerWorkspace) -> Int? {
        switch workspace {
        case .classDesk:
            return admin.requestedPlaces + admin.waitingMembers + admin.attendanceDue
        case .bookingRequests:
            return admin.requestedPlaces
        case .ptRequests:
            return admin.pendingPTRequests
        case .retention:
            return admin.activationQueue.count + admin.followUps.count
        case .leads:
            return admin.leadActionCounts?.total
        case .notices:
            return admin.liveAnnouncements
        case .orders:
            return admin.orders.filter(\.isRecoverable).count
        case .products:
            return pricingAttentionCount
        case .health:
            return admin.healthIssues
        default:
            return nil
        }
    }

    @ViewBuilder
    private func ownerWorkspaceSurface(_ workspace: XertOwnerWorkspace, session: AuthSession) -> some View {
        workspaceDestination(workspace, session: session)
    }

    @ViewBuilder
    private func workspaceDestination(_ workspace: XertOwnerWorkspace, session: AuthSession) -> some View {
        switch workspace {
        case .overview:
            dashboard(session: session).navigationTitle("Today")
        case .members:
            AdminMembersView(
                admin: admin,
                session: session,
                onOpenTask: { openOwnerRoute(XertOwnerRoute(task: $0)) }
            )
        case .access:
            AdminAccessControlView(
                admin: admin,
                session: session,
                onOpenTask: { openOwnerRoute(XertOwnerRoute(task: $0)) },
                onOpenAudit: { openWorkspace(.audit) }
            )
        case .classDesk:
            AdminClassesView(admin: admin, session: session)
        case .workouts:
            AdminWorkoutOfDayView(session: session)
        case .bookingRequests:
            AdminBookingRequestsView(admin: admin, session: session)
        case .timetable:
            AdminScheduleView(admin: admin, session: session)
        case .availability:
            AdminAvailabilityView(admin: admin, session: session)
        case .ptRequests:
            AdminPTRequestsView(admin: admin, session: session)
        case .retention:
            AdminRetentionView(
                admin: admin,
                session: session
            )
        case .leads:
            AdminLeadsView(
                admin: admin,
                session: session,
                initialPipeline: admin.leadActionCounts?.triagePipeline,
                prioritizesNewWork: (admin.leadActionCounts?.total ?? 0) > 0
            )
        case .campaigns:
            AdminCampaignAttributionView(admin: admin, session: session)
        case .siteContent:
            AdminSiteContentView(admin: admin, session: session)
        case .forms:
            AdminFormsView(
                session: session,
                createIntentID: $createFormIntentID
            )
        case .sms:
            AdminSmsView(session: session)
        case .notices:
            AdminCommunicationsView(admin: admin, session: session)
        case .events:
            AdminEventsView(
                admin: admin,
                session: session,
                onOpenTask: { openOwnerRoute(XertOwnerRoute(task: $0)) }
            )
        case .team:
            AdminCoachesView(admin: admin, session: session)
        case .finance:
            AdminFinanceView(
                admin: admin,
                session: session,
                onOpenOrders: { openWorkspace(.orders) }
            )
        case .orders:
            AdminOrdersView(
                admin: admin,
                session: session,
                onOpenTask: { openOwnerRoute(XertOwnerRoute(task: $0)) }
            )
        case .products:
            AdminProductsView(
                admin: admin,
                session: session,
                onOpenTask: { openOwnerRoute(XertOwnerRoute(task: $0)) }
            )
        case .controls:
            AdminPlatformView(
                admin: admin,
                session: session,
                initialDraft: platformDraftSnapshot,
                isExitSaving: isSavingPlatformExit,
                onOpenPricing: { openWorkspace(.products) },
                onOpenNotices: { openWorkspace(.notices) },
                onDraftChange: { platformDraftSnapshot = $0 }
            )
        case .health:
            AdminOperationsHealthView(
                admin: admin,
                session: session,
                onOpenTask: { openOwnerRoute(XertOwnerRoute(task: $0)) },
                onOpenWorkspace: openWorkspace
            )
        case .fitbox:
            AdminFitboxView(admin: admin, session: session)
        case .audit:
            AdminAuditView(admin: admin, session: session)
        }
    }

    private var dashboardMetricColumns: [GridItem] {
        let count = dynamicTypeSize.isAccessibilitySize ? 1 : 2
        return Array(repeating: GridItem(.flexible(), spacing: 10), count: count)
    }
}

private struct AdminWorkspaceSwitcher: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var query = ""
    @State private var expandedHub: XertOwnerWorkspaceSection?
    let current: XertOwnerWorkspace
    let recent: [XertOwnerWorkspace]
    let pinned: [XertOwnerWorkspace]
    let badges: [XertOwnerWorkspace: Int]
    let launchRunway: XertStripeLaunchRunway
    let onSelect: (XertOwnerWorkspace) -> Void
    let onOpenRoute: (XertOwnerRoute) -> Void
    let onTogglePin: (XertOwnerWorkspace) -> Void
    let onRunAction: (AdminOwnerLauncherAction) -> Void

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var matchingWorkspaces: [XertOwnerWorkspace] {
        XertOwnerWorkspace.allCases.filter { $0.matches(query) }
    }

    private var matchingActions: [AdminOwnerLauncherAction] {
        AdminOwnerLauncherAction.allCases.filter { $0.matches(query) }
    }

    private var attentionWorkspaces: [XertOwnerWorkspace] {
        matchingWorkspaces
            .filter { badges[$0, default: 0] > 0 }
            .sorted { badges[$0, default: 0] > badges[$1, default: 0] }
    }

    private var matchingRecent: [XertOwnerWorkspace] {
        recent.filter { !pinned.contains($0) && $0.matches(query) }
    }

    private var matchingPinned: [XertOwnerWorkspace] {
        pinned.filter { $0.matches(query) }
    }

    private var matchingRecords: [XertOwnerRecordCommand] {
        XertOwnerCommandIndex.matches(
            query: query,
            members: admin.ownerMemberSearchResults,
            orders: admin.orders,
            products: admin.products,
            events: admin.events,
            classes: admin.dailyOperations,
            bookingRequests: admin.bookingRequests,
            ptRequests: admin.ptRequests
        )
    }

    private var launchRunwayMatches: Bool {
        let terms = normalizedQuery
            .lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        guard !terms.isEmpty else { return false }
        let searchIndex = [
            "stripe launch checkout payments activation",
            launchRunway.title,
            launchRunway.detail,
            launchRunway.actionTitle,
        ].joined(separator: " ").lowercased()
        return terms.allSatisfy { searchIndex.contains($0) }
    }

    private var hasNoResults: Bool {
        !normalizedQuery.isEmpty
            && matchingWorkspaces.isEmpty
            && matchingActions.isEmpty
            && matchingRecords.isEmpty
            && !launchRunwayMatches
            && !admin.isSearchingOwnerMembers
    }

    var body: some View {
        NavigationStack {
            List {
                if !normalizedQuery.isEmpty {
                    if launchRunwayMatches {
                        Section("Launch") { launchRunwayRow }
                    }
                    actionSection("Quick actions", actions: matchingActions)
                    workspaceSection("Results", workspaces: matchingWorkspaces)
                    ForEach(XertOwnerRecordKind.allCases) { kind in
                        recordSection(
                            kind.rawValue,
                            records: matchingRecords.filter { $0.kind == kind }
                        )
                    }
                    if admin.isSearchingOwnerMembers {
                        HStack(spacing: 10) {
                            ProgressView().tint(Color.xertSteel)
                            Text("Searching member accounts...")
                                .font(.subheadline)
                                .foregroundStyle(Color.xertPale.opacity(0.7))
                        }
                        .listRowBackground(Color.xertInk)
                    } else if let error = admin.ownerMemberSearchError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(Color.orange)
                            .listRowBackground(Color.xertInk)
                    }
                } else {
                    workspaceSection("Pinned", workspaces: matchingPinned)
                    Section("Workspaces") {
                        workspaceRow(.overview)
                        ForEach(XertOwnerWorkspaceSection.allCases) { section in
                            DisclosureGroup(isExpanded: Binding(
                                get: { expandedHub == section },
                                set: { expandedHub = $0 ? section : nil }
                            )) {
                                ForEach(XertOwnerWorkspace.workspaces(in: section)) { workspace in
                                    workspaceRow(workspace)
                                }
                            } label: {
                                Label(section.rawValue, systemImage: section.icon)
                                    .font(.body.weight(.semibold))
                                    .frame(minHeight: 44)
                            }
                            .listRowBackground(Color.xertInk)
                        }
                    }
                    workspaceSection("Needs attention", workspaces: attentionWorkspaces)
                    workspaceSection("Recent", workspaces: matchingRecent)
                    actionSection("Quick actions", actions: AdminOwnerLauncherAction.allCases)
                }

                if hasNoResults {
                    VStack(spacing: 10) {
                        Image(systemName: "magnifyingglass")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(Color.xertSteel)
                        Text("No matching command")
                            .font(.headline)
                            .foregroundStyle(Color.xertOffWhite)
                        Text("Try a tool, task or business area.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.65))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 28)
                    .listRowBackground(Color.xertInk)
                }
            }
            .scrollContentBackground(.hidden)
            .xertOwnerScreen()
            .navigationTitle("Manage XERT")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Workspace, Stripe launch, class, member or record")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close workspace switcher")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task(id: normalizedQuery) {
            guard normalizedQuery.count >= 2 else {
                admin.resetOwnerMemberSearch()
                return
            }
            do {
                try await Task.sleep(nanoseconds: 300_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await admin.searchOwnerMembers(session: session, query: normalizedQuery)
        }
        .onDisappear { admin.resetOwnerMemberSearch() }
    }

    @ViewBuilder
    private func actionSection(
        _ title: String,
        actions: [AdminOwnerLauncherAction]
    ) -> some View {
        if !actions.isEmpty {
            Section(title) {
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.flexible(), spacing: 10),
                        count: dynamicTypeSize.isAccessibilitySize ? 1 : 2
                    ),
                    spacing: 10
                ) {
                    ForEach(actions) { action in
                        launcherActionButton(action)
                    }
                }
                .padding(.vertical, 4)
                .listRowBackground(Color.xertInk)
            }
        }
    }

    private func launcherActionButton(_ action: AdminOwnerLauncherAction) -> some View {
        let enabled = actionIsEnabled(action)
        return Button { onRunAction(action) } label: {
            VStack(alignment: .leading, spacing: 7) {
                Image(systemName: action.icon)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(enabled ? Color.xertSteel : Color.orange)
                Text(action.title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.xertOffWhite)
                    .fixedSize(horizontal: false, vertical: true)
                Text(actionDetail(action, enabled: enabled))
                    .font(.caption2)
                    .foregroundStyle(enabled ? Color.xertPale.opacity(0.62) : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
            .padding(12)
            .background(Color.xertNavy.opacity(0.72))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(
                        enabled ? Color.xertSteel.opacity(0.16) : Color.orange.opacity(0.34),
                        lineWidth: 1
                    )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(action.title)
        .accessibilityHint(
            enabled
                ? action.detail
                : "Refresh \(action.requiredSource ?? "owner data") before using this action"
        )
    }

    private func actionIsEnabled(_ action: AdminOwnerLauncherAction) -> Bool {
        guard let source = action.requiredSource else { return true }
        return !admin.isLoading
            && admin.loadedSources.contains(source)
            && !admin.refreshUnavailableSources.contains(source)
    }

    private func actionDetail(_ action: AdminOwnerLauncherAction, enabled: Bool) -> String {
        guard !enabled, let source = action.requiredSource else { return action.detail }
        return admin.isLoading && !admin.loadedSources.contains(source)
            ? "Checking access…"
            : "Refresh \(source) to unlock"
    }

    @ViewBuilder
    private func workspaceSection(_ title: String, workspaces: [XertOwnerWorkspace]) -> some View {
        if !workspaces.isEmpty {
            Section(title) {
                ForEach(workspaces) { workspace in
                    workspaceRow(workspace)
                }
            }
        }
    }

    private func workspaceRow(_ workspace: XertOwnerWorkspace) -> some View {
        HStack(spacing: 4) {
            Button { onSelect(workspace) } label: {
                HStack(spacing: 12) {
                    Image(systemName: workspace.icon)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(workspace.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.xertOffWhite)
                        Text(workspace.detail)
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.65))
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    if let badge = badges[workspace], badge > 0 {
                        Text(badge > 99 ? "99+" : "\(badge)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.xertNavy)
                            .padding(.horizontal, 7)
                            .frame(minHeight: 20)
                            .background(Color.xertSteel)
                            .clipShape(Capsule())
                    }
                    Image(systemName: workspace == current ? "checkmark" : "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(workspace == current ? Color.xertSteel : Color.xertPale.opacity(0.35))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if workspace != .overview {
                Button { onTogglePin(workspace) } label: {
                    Image(systemName: pinned.contains(workspace) ? "pin.fill" : "pin")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(pinned.contains(workspace) ? Color.xertSteel : Color.xertPale.opacity(0.45))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(pinned.contains(workspace) ? "Unpin \(workspace.title)" : "Pin \(workspace.title)")
                .accessibilityHint("Updates your owner workspace shortcuts")
            }
        }
        .padding(.vertical, 3)
        .listRowBackground(Color.xertInk)
    }

    private var launchRunwayRow: some View {
        Button { onOpenRoute(launchRunway.route) } label: {
            HStack(spacing: 12) {
                Image(systemName: "bolt.shield")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.xertSteel)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(launchRunway.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.xertOffWhite)
                    Text("\(launchRunway.completedSteps)/\(XertStripeLaunchRunway.totalSteps) gates · \(launchRunway.actionTitle)")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.65))
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.forward.square")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.xertSteel)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the exact next Stripe launch action")
        .accessibilityIdentifier("owner.commands.stripeLaunch")
        .listRowBackground(Color.xertInk)
    }

    @ViewBuilder
    private func recordSection(_ title: String, records: [XertOwnerRecordCommand]) -> some View {
        if !records.isEmpty {
            Section(title) {
                ForEach(records) { record in
                    Button { onOpenRoute(record.route) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: record.icon)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.xertSteel)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(record.title)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Color.xertOffWhite)
                                Text(record.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(Color.xertPale.opacity(0.65))
                                    .lineLimit(2)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.forward.square")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.xertSteel)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the exact protected \(record.kind.rawValue.lowercased()) record")
                    .listRowBackground(Color.xertInk)
                }
            }
        }
    }
}

private struct AdminOwnerTaskSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.adminEditorExitCoordinator) private var editorExitCoordinator
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let task: XertOwnerTask
    @State private var confirmingDiscard = false

    var body: some View {
        NavigationStack {
            taskDestination
        }
        .interactiveDismissDisabled(
            editorExitCoordinator?.active?.isDirty == true
                || editorExitCoordinator?.active?.isBusy == true
        )
        .confirmationDialog(
            "Discard unsaved \(editorExitCoordinator?.active?.title ?? "owner changes")?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive) {
                editorExitCoordinator?.clearAll()
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("The active owner task has not been saved.")
        }
    }

    @ViewBuilder
    private var taskDestination: some View {
        switch task {
        case .member(let id):
            if let member = admin.members.first(where: { $0.id == id }) {
                AdminMemberDetailView(admin: admin, session: session, member: member)
            } else {
                resolutionView(recordName: "member")
            }
        case .classSession(let id):
            if let operation = admin.dailyOperations.first(where: { $0.id == id }) {
                AdminClassRosterView(admin: admin, session: session, operation: operation)
                    .toolbar { closeToolbar }
            } else {
                resolutionView(recordName: "class")
            }
        case .classSetup(let id):
            if let classSession = admin.classSessions.first(where: { $0.id == id }) {
                AdminClassEditor(
                    admin: admin,
                    session: session,
                    classSession: classSession,
                    mutationAllowed: admin.loadedSources.contains("full timetable")
                        && !admin.refreshUnavailableSources.contains("full timetable")
                )
            } else {
                resolutionView(recordName: "class setup")
            }
        case .order(let id):
            if let order = admin.orders.first(where: { $0.id == id }) {
                AdminOrderDetailView(admin: admin, session: session, order: order)
            } else {
                resolutionView(recordName: "order")
            }
        case .product(let id):
            if let product = admin.products.first(where: { $0.id == id }) {
                AdminProductEditor(admin: admin, session: session, product: product)
            } else {
                resolutionView(recordName: "session pack")
            }
        case .event(let id):
            if let event = admin.events.first(where: { $0.id == id }) {
                AdminEventEditor(admin: admin, session: session, event: event)
                    .toolbar { closeToolbar }
            } else {
                resolutionView(recordName: "event")
            }
        case .announcement(let id):
            if let announcement = admin.announcements.first(where: { $0.id == id }) {
                AdminAnnouncementDetailView(
                    admin: admin,
                    session: session,
                    announcement: announcement
                )
            } else {
                resolutionView(recordName: "member notice")
            }
        case .ptRequest(let id):
            if let request = admin.ptRequests.first(where: { $0.id == id }) {
                AdminPTRequestDetailView(
                    admin: admin,
                    session: session,
                    request: request,
                    mutationAllowed: admin.ptRequestsAreCurrent
                )
            } else {
                resolutionView(recordName: "PT request")
            }
        case .bookingRequest(let source, let id):
            if let booking = admin.bookingRequests.first(where: {
                $0.source == source && $0.routeRecordID == id
            }) {
                AdminBookingRequestDetailView(
                    admin: admin,
                    session: session,
                    booking: booking,
                    mutationAllowed: admin.bookingRequestsAreCurrent
                )
            } else {
                resolutionView(recordName: "booking request")
            }
        }
    }

    private func resolutionView(recordName: String) -> some View {
        VStack(spacing: 16) {
            if admin.resolvingOwnerTask == task
                || (admin.isLoading && admin.lastUpdatedAt == nil) {
                ProgressView()
                    .tint(Color.xertSteel)
                Text("Opening \(task.title.lowercased())...")
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
            } else {
                let resolutionError = admin.ownerTaskResolutionErrorTask == task
                    ? admin.ownerTaskResolutionErrorMessage
                    : nil
                Image(systemName: resolutionError == nil ? "questionmark.folder" : "wifi.exclamationmark")
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(resolutionError == nil ? Color.xertSteel : Color.orange)
                Text(
                    resolutionError == nil
                        ? "\(recordName.capitalized) unavailable"
                        : "Could not open \(recordName)"
                )
                    .xertDisplay(28)
                    .foregroundStyle(Color.xertOffWhite)
                Text(
                    resolutionError
                        ?? "This protected link no longer matches a \(recordName) visible to your administrator account."
                )
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.xertPale.opacity(0.68))
                Button {
                    Task { await admin.resolveOwnerTask(session: session, task: task) }
                } label: {
                    Label(
                        resolutionError == nil ? "Check protected record again" : "Retry protected record",
                        systemImage: "arrow.clockwise"
                    )
                    .frame(minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.xertSteel)
                .foregroundStyle(Color.xertNavy)
                .accessibilityHint("Retries this exact protected \(recordName) instead of refreshing a bounded workspace list")
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .xertOwnerScreen()
        .navigationTitle(task.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { closeToolbar }
    }

    @ToolbarContentBuilder
    private var closeToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Close", action: requestClose)
                .disabled(editorExitCoordinator?.active?.isBusy == true)
        }
    }

    private func requestClose() {
        if editorExitCoordinator?.active?.isDirty == true {
            confirmingDiscard = true
        } else if editorExitCoordinator?.active?.isBusy != true {
            dismiss()
        }
    }
}

private enum AdminAccessDirectoryMode: String, CaseIterable, Identifiable {
    case administrators
    case candidates

    var id: String { rawValue }
    var title: String {
        switch self {
        case .administrators: return "Administrators"
        case .candidates: return "Add backup"
        }
    }
    var role: String {
        switch self {
        case .administrators: return "admin"
        case .candidates: return "member"
        }
    }
}

private struct AdminAccessControlView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let onOpenTask: (XertOwnerTask) -> Void
    let onOpenAudit: () -> Void
    @State private var mode = AdminAccessDirectoryMode.administrators
    @State private var query = ""
    @State private var page = 1
    @State private var hasRequestedDirectory = false

    private let pageSize = 50
    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canRequestDirectory: Bool {
        mode == .administrators || normalizedQuery.count >= 2
    }
    private var requestKey: String {
        "\(mode.rawValue)|\(normalizedQuery)|\(page)"
    }
    private var directoryIsCurrent: Bool {
        canRequestDirectory
            && admin.hasLoadedMemberDirectory
            && !admin.memberDirectoryUnavailable
            && admin.memberDirectorySearch == normalizedQuery
            && admin.memberDirectoryRole == mode.role
            && admin.memberDirectoryCredit == "all"
            && admin.memberDirectoryPage == page
    }
    private var rows: [AdminMemberSummary] {
        directoryIsCurrent ? admin.memberDirectoryRows : []
    }
    private var pageCount: Int {
        max(1, Int(ceil(Double(admin.memberDirectoryTotal) / Double(pageSize))))
    }
    private var accessSnapshot: AdminAccessSnapshot {
        AdminAccessSnapshot(
            administrators: rows,
            totalCount: directoryIsCurrent && mode == .administrators
                ? admin.memberDirectoryTotal
                : 0,
            currentUserID: session.user?.id
        )
    }
    private var recentAccessChanges: [AdminAuditEntry] {
        admin.auditEntries
            .filter { $0.category == "Access" }
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(5)
            .map { $0 }
    }

    var body: some View {
        List {
            Section {
                Picker("Access directory", selection: $mode) {
                    ForEach(AdminAccessDirectoryMode.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Owner access")
            } footer: {
                Text("Administrator access includes member records, finance, publishing and platform controls.")
            }
            .listRowBackground(Color.xertInk)

            if mode == .administrators {
                accessPosture
            } else if normalizedQuery.count < 2 {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Find a trusted existing member", systemImage: "person.crop.circle.badge.plus")
                            .font(.headline)
                        Text("Enter at least two characters of their name, email or phone. Access is granted only after reviewing the exact account and confirming the role change.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.62))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 8)
                    .listRowBackground(Color.xertInk)
                }
            }

            if canRequestDirectory
                && hasRequestedDirectory
                && !directoryIsCurrent
                && !admin.isSearchingMembers {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(
                            admin.memberDirectoryStatusMessage
                                ?? "Access evidence is unavailable. Refresh before changing administrator roles.",
                            systemImage: "lock.trianglebadge.exclamationmark"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        Button {
                            Task { await loadDirectory() }
                        } label: {
                            Label("Retry access directory", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.orange)
                    }
                    .listRowBackground(Color.xertInk)
                }
            }

            if admin.isSearchingMembers {
                Section {
                    HStack(spacing: 12) {
                        ProgressView().tint(Color.xertSteel)
                        Text(mode == .administrators ? "Loading administrators..." : "Searching eligible members...")
                    }
                    .frame(minHeight: 52)
                    .listRowBackground(Color.xertInk)
                }
            } else if directoryIsCurrent {
                accessDirectory
            }

            accessHistory
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Admin access")
        .searchable(
            text: $query,
            prompt: mode == .administrators
                ? "Filter administrators"
                : "Member name, email or phone"
        )
        .task(id: requestKey) {
            guard canRequestDirectory else { return }
            do {
                try await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await loadDirectory()
            } catch {}
        }
        .task { await admin.loadAudit(session: session) }
        .refreshable {
            if canRequestDirectory { await loadDirectory() }
            await admin.loadAudit(session: session, force: true)
        }
        .onChange(of: mode) { _ in
            query = ""
            page = 1
            hasRequestedDirectory = false
        }
        .onChange(of: query) { _ in
            page = 1
            hasRequestedDirectory = false
        }
        .onChange(of: page) { _ in hasRequestedDirectory = false }
        .onChange(of: admin.memberDirectoryTotal) { _ in
            if page > pageCount { page = pageCount }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task {
                        if canRequestDirectory { await loadDirectory() }
                        await admin.loadAudit(session: session, force: true)
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .frame(width: 44, height: 44)
                }
                .disabled(admin.isSearchingMembers || admin.isLoadingAudit)
                .accessibilityLabel("Refresh access control")
            }
        }
    }

    private var accessPosture: some View {
        Section("Access posture") {
            if directoryIsCurrent {
                let snapshot = accessSnapshot
                VStack(alignment: .leading, spacing: 12) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) {
                            accessPostureIcon(snapshot)
                            accessPostureCopy(snapshot)
                            Spacer(minLength: 8)
                            Text(snapshot.administratorCount.formatted())
                                .font(.title2.weight(.black).monospacedDigit())
                                .foregroundStyle(Color.xertOffWhite)
                        }
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 10) {
                                accessPostureIcon(snapshot)
                                Text(snapshot.administratorCount.formatted())
                                    .font(.title2.weight(.black).monospacedDigit())
                                    .foregroundStyle(Color.xertOffWhite)
                            }
                            accessPostureCopy(snapshot)
                        }
                    }
                    if snapshot.currentUserListingIsComplete && !snapshot.currentUserIsListed {
                        Label(
                            "Your signed-in account is missing from this administrator snapshot. Do not change roles until the directory is refreshed.",
                            systemImage: "person.crop.circle.badge.exclamationmark"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    if !snapshot.hasOperationalBackup {
                        Button {
                            mode = .candidates
                        } label: {
                            Label("Find a backup administrator", systemImage: "person.badge.plus")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.xertSteel)
                        .foregroundStyle(Color.xertNavy)
                    }
                }
                .padding(.vertical, 6)
            } else if admin.isSearchingMembers {
                ProgressView().tint(Color.xertSteel)
            }
        }
        .listRowBackground(Color.xertInk)
    }

    private func accessPostureIcon(_ snapshot: AdminAccessSnapshot) -> some View {
        Image(systemName: snapshot.hasOperationalBackup ? "person.2.fill" : "exclamationmark.shield.fill")
            .font(.title2)
            .foregroundStyle(snapshot.hasOperationalBackup ? Color.green : Color.orange)
            .frame(width: 44, height: 44)
            .background((snapshot.hasOperationalBackup ? Color.green : Color.orange).opacity(0.1))
            .accessibilityHidden(true)
    }

    private func accessPostureCopy(_ snapshot: AdminAccessSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(snapshot.statusTitle)
                .font(.headline)
                .foregroundStyle(Color.xertOffWhite)
            Text(snapshot.statusDetail)
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.62))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var accessDirectory: some View {
        Section(mode == .administrators ? "Administrator accounts" : "Eligible member accounts") {
            if rows.isEmpty {
                Text(
                    mode == .administrators
                        ? "No matching administrators. Refresh before relying on this result."
                        : "No eligible members match this search."
                )
                .foregroundStyle(Color.xertPale.opacity(0.62))
            }
            ForEach(rows) { member in
                Button { onOpenTask(.member(member.id)) } label: {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) {
                            accessIdentity(member)
                            Spacer(minLength: 8)
                            accessAccountBadge(member)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.xertSteel)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            accessIdentity(member)
                            HStack {
                                accessAccountBadge(member)
                                Spacer()
                                Label(
                                    mode == .administrators ? "Review access" : "Review and grant",
                                    systemImage: "chevron.right"
                                )
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.xertSteel)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }

            if admin.memberDirectoryTotal > pageSize {
                HStack {
                    Button {
                        page = max(1, page - 1)
                    } label: {
                        Image(systemName: "chevron.left")
                            .frame(width: 44, height: 44)
                    }
                    .disabled(page <= 1 || admin.isSearchingMembers)
                    Spacer()
                    Text("Page \(page) of \(pageCount)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.xertPale.opacity(0.62))
                    Spacer()
                    Button {
                        page = min(pageCount, page + 1)
                    } label: {
                        Image(systemName: "chevron.right")
                            .frame(width: 44, height: 44)
                    }
                    .disabled(page >= pageCount || admin.isSearchingMembers)
                }
                .foregroundStyle(Color.xertSteel)
            }
        }
        .listRowBackground(Color.xertInk)
    }

    private func accessIdentity(_ member: AdminMemberSummary) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(member.displayName)
                .font(.headline)
                .foregroundStyle(Color.xertOffWhite)
                .lineLimit(2)
            Text(member.email ?? member.phone ?? "No contact details")
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.58))
                .lineLimit(2)
        }
    }

    private func accessAccountBadge(_ member: AdminMemberSummary) -> some View {
        Text(member.id == session.user?.id ? "YOU" : member.role.uppercased())
            .font(.caption2.weight(.black))
            .foregroundStyle(member.id == session.user?.id ? Color.green : Color.xertSteel)
            .padding(.horizontal, 8)
            .frame(minHeight: 28)
            .overlay(
                Rectangle()
                    .stroke(
                        member.id == session.user?.id ? Color.green.opacity(0.45) : Color.xertSteel.opacity(0.3),
                        lineWidth: 1
                    )
            )
    }

    private var accessHistory: some View {
        Section {
            if admin.isLoadingAudit && !admin.hasLoadedAudit {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading access history...")
                }
            } else if !admin.auditIsCurrent {
                Label(
                    admin.auditStatusMessage
                        ?? "Access history is not current. Refresh before relying on it.",
                    systemImage: "clock.badge.exclamationmark"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .fixedSize(horizontal: false, vertical: true)
            } else if recentAccessChanges.isEmpty {
                Text("No administrator role changes in the current audit window.")
                    .foregroundStyle(Color.xertPale.opacity(0.62))
            } else {
                ForEach(recentAccessChanges) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.xertOffWhite)
                        Text(entry.detail)
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.6))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(entry.createdAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption2)
                            .foregroundStyle(Color.xertPale.opacity(0.42))
                    }
                    .padding(.vertical, 3)
                }
            }
            if admin.auditIsCurrent {
                Button(action: onOpenAudit) {
                    Label("Open full Activity log", systemImage: "clock.arrow.circlepath")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .tint(Color.xertSteel)
            }
        } header: {
            Text("Recent access changes")
        } footer: {
            Text("Every administrator role change is recorded in the protected audit ledger.")
        }
        .listRowBackground(Color.xertInk)
    }

    private func loadDirectory() async {
        guard canRequestDirectory else { return }
        hasRequestedDirectory = true
        await admin.searchMembers(
            session: session,
            query: normalizedQuery,
            role: mode.role,
            credit: "all",
            page: page,
            pageSize: pageSize
        )
    }
}

private struct AdminMembersView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let onOpenTask: (XertOwnerTask) -> Void
    @State private var query = ""
    @State private var role = "all"
    @State private var credit = "all"
    @State private var page = 1
    @State private var exportDocument: AdminIntakeCSVDocument?
    @State private var isExporting = false

    private let pageSize = 50
    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var requestKey: String {
        "\(normalizedQuery)|\(role)|\(credit)|\(page)"
    }
    private var pageCount: Int {
        max(1, Int(ceil(Double(admin.memberDirectoryTotal) / Double(pageSize))))
    }
    private var firstResult: Int {
        admin.memberDirectoryTotal == 0 ? 0 : ((page - 1) * pageSize) + 1
    }
    private var lastResult: Int {
        min(((page - 1) * pageSize) + admin.memberDirectoryRows.count, admin.memberDirectoryTotal)
    }
    private var directoryIsCurrent: Bool {
        admin.hasLoadedMemberDirectory
            && !admin.memberDirectoryUnavailable
            && admin.memberDirectorySearch == normalizedQuery
            && admin.memberDirectoryRole == role
            && admin.memberDirectoryCredit == credit
            && admin.memberDirectoryPage == page
    }
    private var exportDateStamp: String {
        String(ISO8601DateFormatter().string(from: Date()).prefix(10))
    }

    var body: some View {
        List {
            Section {
                Picker("Role", selection: $role) {
                    Text("All").tag("all")
                    Text("Members").tag("member")
                    Text("Admins").tag("admin")
                }
                .pickerStyle(.segmented)

                Picker("Credits", selection: $credit) {
                    Text("All").tag("all")
                    Text("Available").tag("available")
                    Text("None").tag("none")
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Directory filters")
            }
            .listRowBackground(Color.xertInk)

            if let message = admin.memberDirectoryStatusMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                        .listRowBackground(Color.xertInk)
                }
            }

            if admin.isSearchingMembers {
                HStack { Spacer(); ProgressView().tint(Color.xertSteel); Spacer() }
                    .listRowBackground(Color.xertInk)
            }

            if directoryIsCurrent && admin.memberDirectoryRows.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "person.2.slash")
                        .font(.title2)
                        .foregroundStyle(Color.xertSteel)
                    Text("No matching members")
                        .font(.headline)
                        .foregroundStyle(Color.xertOffWhite)
                    Text("Adjust the search or directory filters.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.62))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .listRowBackground(Color.xertNavy)
            }

            ForEach(admin.memberDirectoryRows) { member in
                Button { onOpenTask(.member(member.id)) } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.displayName).font(.headline).foregroundStyle(Color.xertOffWhite)
                                Text(member.email ?? member.phone ?? "No contact details")
                                    .font(.caption).foregroundStyle(Color.xertPale.opacity(0.58))
                            }
                            Spacer()
                            HStack(spacing: 8) {
                                Text(member.role.uppercased())
                                    .font(.caption2.weight(.bold)).foregroundStyle(Color.xertSteel)
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.bold)).foregroundStyle(Color.xertSteel)
                            }
                        }
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 18) {
                                memberValue(member)
                            }
                            VStack(alignment: .leading, spacing: 5) {
                                memberValue(member)
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                    }
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.xertInk)
            }

            if directoryIsCurrent {
                Section {
                    HStack {
                        Button {
                            page = max(1, page - 1)
                        } label: {
                            Label("Previous", systemImage: "chevron.left")
                        }
                        .disabled(page <= 1 || admin.isSearchingMembers)

                        Spacer()

                        VStack(spacing: 2) {
                            Text("Page \(page) of \(pageCount)")
                                .font(.caption.weight(.semibold))
                            Text("\(firstResult)-\(lastResult) of \(admin.memberDirectoryTotal)")
                                .font(.caption2)
                                .foregroundStyle(Color.xertPale.opacity(0.55))
                        }

                        Spacer()

                        Button {
                            page = min(pageCount, page + 1)
                        } label: {
                            Label("Next", systemImage: "chevron.right")
                                .labelStyle(.titleAndIcon)
                        }
                        .disabled(page >= pageCount || admin.isSearchingMembers)
                    }
                    .foregroundStyle(Color.xertSteel)
                    .listRowBackground(Color.xertInk)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Members")
        .searchable(text: $query, prompt: "Name, email or phone")
        .task(id: requestKey) {
            do {
                try await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await loadDirectory()
            } catch {}
        }
        .onChange(of: query) { _ in page = 1 }
        .onChange(of: role) { _ in page = 1 }
        .onChange(of: credit) { _ in page = 1 }
        .onChange(of: admin.memberDirectoryTotal) { _ in
            if page > pageCount { page = pageCount }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task {
                        guard let report = await admin.exportMembers(
                            session: session,
                            query: normalizedQuery,
                            role: role,
                            credit: credit
                        ) else {
                            XertHaptics.play(.error)
                            return
                        }
                        exportDocument = AdminIntakeCSVDocument(csv: report.csv)
                        isExporting = true
                        XertHaptics.play(.success)
                    }
                } label: {
                    if admin.isExportingMembers {
                        ProgressView()
                    } else {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
                .disabled(
                    !directoryIsCurrent
                        || admin.memberDirectoryTotal == 0
                        || admin.isExportingMembers
                )
                .accessibilityLabel("Export filtered member directory CSV")
                .accessibilityHint(
                    directoryIsCurrent
                        ? "Exports every member matching the current filters"
                        : "Wait for the current directory filters to finish loading"
                )
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { Task { await loadDirectory() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(admin.isSearchingMembers)
                .accessibilityLabel("Refresh members")
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "xert-members-\(exportDateStamp)"
        ) { result in
            if case .failure(let error) = result {
                admin.errorMessage = error.localizedDescription
                XertHaptics.play(.error)
            }
        }
    }

    @ViewBuilder
    private func memberValue(_ member: AdminMemberSummary) -> some View {
        Label("\(member.credits_remaining) credits", systemImage: "ticket")
        Label("\(member.bookings_count) bookings", systemImage: "calendar")
        Text(member.totalSpent)
    }

    private func loadDirectory() async {
        await admin.searchMembers(
            session: session,
            query: normalizedQuery,
            role: role,
            credit: credit,
            page: page,
            pageSize: pageSize
        )
    }
}

private struct AdminMemberDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let member: AdminMemberSummary
    private let staffNoteBaselineToken: String
    @State private var noteCategory = "general"
    @State private var noteBody = ""
    @State private var recoveredStaffNoteAt: Date?
    @State private var hasEditedStaffNoteDuringPresentation = false
    @State private var hasCommittedStaffNote = false
    @State private var showingGrant = false
    @State private var showingNoticeComposer = false
    @State private var pendingRole: String?
    @State private var historyTab = AdminMemberHistoryTab.credits
    @State private var confirmingDiscardNote = false
    @State private var exitStateID = UUID()
    @FocusState private var noteFocused: Bool

    init(admin: AdminStore, session: AuthSession, member: AdminMemberSummary) {
        let baselineToken = AdminIntakeDraftStore.baselineToken(status: "general", notes: "")
        let recovered = AdminIntakeDraftStore.load(
            kind: .memberStaffNote,
            ownerID: session.user?.id,
            recordID: member.id.uuidString,
            baselineToken: baselineToken
        )
        let allowedCategories = Set(["general", "coaching", "follow_up", "billing"])

        self.admin = admin
        self.session = session
        self.member = member
        staffNoteBaselineToken = baselineToken
        _noteCategory = State(
            initialValue: recovered?.draft.status.flatMap {
                allowedCategories.contains($0) ? $0 : nil
            } ?? "general"
        )
        _noteBody = State(initialValue: recovered?.draft.notes ?? "")
        _recoveredStaffNoteAt = State(initialValue: recovered?.savedAt)
    }

    private var current: AdminMemberSummary { admin.members.first(where: { $0.id == member.id }) ?? member }
    private var hasNoteDraft: Bool {
        !noteBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var normalizedNoteBody: String {
        noteBody.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var staffNoteDraft: AdminIntakeDraft {
        AdminIntakeDraft(status: noteCategory, notes: noteBody)
    }
    private var memberRecordIsCurrent: Bool {
        admin.loadedMemberDetailID == current.id
    }
    private var memberRecordIsRefreshing: Bool {
        admin.loadingMemberDetailID == current.id
    }
    private var memberRecordMutationsAllowed: Bool {
        memberRecordIsCurrent
            && admin.loadingMemberDetailID == nil
            && admin.memberDetailUnavailableSources.isEmpty
            && admin.servicingMemberID == nil
    }
    private var isBusy: Bool { admin.servicingMemberID != nil }
    private var isSignedInAdministrator: Bool {
        current.role == "admin" && current.id == session.user?.id
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
            if let recoveredStaffNoteAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredStaffNoteAt,
                    onDiscard: discardRecoveredStaffNote
                )
            }
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text(current.displayName).xertDisplay(25).foregroundStyle(Color.xertOffWhite)
                    if let email = current.email, let url = URL(string: "mailto:\(email)") { Link(email, destination: url) }
                    if let phone = current.phone,
                       let encoded = phone.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                       let url = URL(string: "tel:\(encoded)") { Link(phone, destination: url) }
                    Text("Joined \(current.joined_at.formatted(date: .abbreviated, time: .omitted))")
                        .font(.caption).foregroundStyle(Color.xertPale.opacity(0.5))
                }
                .listRowBackground(Color.xertInk)
            }
            if !memberRecordIsCurrent || memberRecordIsRefreshing {
                Section {
                    HStack(spacing: 10) {
                        ProgressView().tint(Color.xertSteel)
                        Text(
                            memberRecordIsCurrent
                                ? "Refreshing verified member record..."
                                : "Loading member record..."
                        )
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        memberRecordIsCurrent
                            ? "Refreshing verified member record"
                            : "Loading member record"
                    )
                }
                .listRowBackground(Color.xertInk)
            } else if !admin.memberDetailUnavailableSources.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Showing the last verified record", systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Color.orange)
                        Text("Unavailable: \(admin.memberDetailUnavailableSources.joined(separator: ", ")). Refresh before making changes.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.68))
                        Button {
                            Task {
                                await admin.loadMemberDetail(
                                    session: session,
                                    memberID: current.id,
                                    preserveCurrent: true
                                )
                            }
                        } label: {
                            Label("Retry member record", systemImage: "arrow.clockwise")
                                .frame(minHeight: 44)
                        }
                    }
                }
                .listRowBackground(Color.xertInk)
            }
            Section("Account value") {
                LabeledContent("Available credits", value: current.credits_remaining.formatted())
                LabeledContent("Bookings", value: current.bookings_count.formatted())
                LabeledContent("Paid orders", value: current.orders_count.formatted())
                LabeledContent("Lifetime spend", value: current.totalSpent)
                Button { showingGrant = true } label: { Label("Grant class credits", systemImage: "ticket") }
                    .disabled(!memberRecordMutationsAllowed)
                if admin.memberDetailUnavailableSources.contains("credit audit") {
                    Label(
                        "Credit grants are paused until the audit ledger refreshes.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption)
                    .foregroundStyle(Color.orange)
                }
            }
            .listRowBackground(Color.xertInk)

            accountHistorySection

            memberReadinessSection

            privateNoticesSection

            Section("Access") {
                LabeledContent("Current role", value: current.role.capitalized)
                if isSignedInAdministrator {
                    Label(
                        "This is your signed-in administrator account. Use another trusted administrator to change its access.",
                        systemImage: "lock.shield"
                    )
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.64))
                    .fixedSize(horizontal: false, vertical: true)
                }
                Button {
                    pendingRole = current.role == "admin" ? "member" : "admin"
                } label: {
                    Label(current.role == "admin" ? "Remove administrator access" : "Promote to administrator",
                          systemImage: current.role == "admin" ? "person.badge.minus" : "person.badge.key")
                }
                .foregroundStyle(current.role == "admin" ? Color.red : Color.xertSteel)
                .disabled(!memberRecordMutationsAllowed || isSignedInAdministrator)
                .accessibilityHint(
                    isSignedInAdministrator
                        ? "Your signed-in administrator account cannot remove its own access"
                        : "Opens a confirmation before changing administrator access"
                )
            }
            .listRowBackground(Color.xertInk)

            if let noteStatus = admin.memberNoteStatusMessage {
                Section {
                    Label(
                        noteStatus,
                        systemImage: admin.memberNoteStatusIsWarning
                            ? "exclamationmark.triangle.fill"
                            : "checkmark.shield.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(admin.memberNoteStatusIsWarning ? Color.orange : Color.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                }
                .listRowBackground(Color.xertInk)
                .accessibilityIdentifier("owner.member.staffNote.receipt")
            }

            Section("Add staff note") {
                Picker("Category", selection: $noteCategory) {
                    Text("General").tag("general"); Text("Coaching").tag("coaching")
                    Text("Follow-up").tag("follow_up"); Text("Billing").tag("billing")
                }
                TextField("Operational context", text: $noteBody, axis: .vertical)
                    .lineLimit(3...7)
                    .focused($noteFocused)
                    .onChange(of: noteBody) { value in
                        if value.count > 1_000 { noteBody = String(value.prefix(1_000)) }
                    }
                HStack {
                    Text("Private operational record")
                    Spacer()
                    Text("\(noteBody.count)/1000")
                        .monospacedDigit()
                }
                .font(.caption2)
                .foregroundStyle(normalizedNoteBody.count < 3 ? Color.orange : Color.xertPale.opacity(0.55))
            }
            .id("owner.member.staffNote")
            .listRowBackground(Color.xertInk)

            Section("Staff timeline") {
                if !memberRecordIsCurrent {
                    HStack(spacing: 10) {
                        ProgressView().tint(Color.xertSteel)
                        Text("Loading staff timeline...")
                            .foregroundStyle(Color.xertPale.opacity(0.68))
                    }
                } else if admin.memberDetailUnavailableSources.contains("staff timeline") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Staff timeline is unavailable.")
                            .font(.subheadline.weight(.semibold))
                        Text("Pull down to retry. Existing notes have not been replaced or removed.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.58))
                    }
                } else if admin.memberNotes.isEmpty && !memberRecordIsRefreshing {
                    Text("No staff notes yet.")
                }
                if memberRecordIsCurrent {
                    ForEach(admin.memberNotes) { note in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(note.category.replacingOccurrences(of: "_", with: " ").uppercased())
                                    .font(.caption2.weight(.bold)).foregroundStyle(Color.xertSteel)
                                Spacer()
                                Button {
                                    Task {
                                        if await admin.archiveMemberNote(
                                            session: session,
                                            memberID: current.id,
                                            note: note
                                        ) {
                                            XertHaptics.play(admin.memberNoteStatusIsWarning ? .warning : .success)
                                        } else {
                                            XertHaptics.play(.error)
                                        }
                                    }
                                } label: { Image(systemName: note.archived_at == nil ? "archivebox" : "arrow.uturn.backward.circle") }
                                    .buttonStyle(.plain)
                                    .disabled(!memberRecordMutationsAllowed)
                                    .accessibilityLabel(note.archived_at == nil ? "Archive note" : "Restore note")
                            }
                            Text(note.body).font(.subheadline)
                            Text("\(note.author_name ?? "Former admin") · \(note.created_at.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption2).foregroundStyle(Color.xertPale.opacity(0.45))
                        }
                        .opacity(note.archived_at == nil ? 1 : 0.5)
                        .padding(.vertical, 4)
                    }
                }
            }
            .listRowBackground(Color.xertInk)
            }
            .xertOwnerScreen()
            .navigationTitle("Member Record").navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if noteFocused || hasNoteDraft {
                    staffNoteSaveBar
                } else {
                    memberActionDock {
                        withAnimation(.easeInOut(duration: 0.22)) {
                            proxy.scrollTo("owner.member.staffNote", anchor: .center)
                        }
                        noteFocused = true
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: requestDismiss)
                        .disabled(isBusy)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task {
                            await admin.loadMemberDetail(
                                session: session,
                                memberID: current.id,
                                preserveCurrent: true
                            )
                        }
                    } label: {
                        if memberRecordIsRefreshing {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .disabled(memberRecordIsRefreshing || isBusy)
                    .accessibilityLabel("Refresh member record")
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { noteFocused = false }
                }
            }
            .task(id: current.id) {
                await admin.loadMemberDetail(session: session, memberID: current.id)
            }
            .onChange(of: staffNoteDraft) { _ in
                hasEditedStaffNoteDuringPresentation = true
                if hasCommittedStaffNote && hasNoteDraft {
                    hasCommittedStaffNote = false
                }
            }
            .task(id: staffNoteDraft) {
                await persistStaffNoteDraft()
            }
            .refreshable {
                await admin.loadMemberDetail(
                    session: session,
                    memberID: current.id,
                    preserveCurrent: true
                )
            }
            .onDisappear { admin.clearMemberDetail(memberID: current.id) }
            .adminOwnerExitState(
                id: exitStateID,
                title: "staff note for \(current.displayName)",
                isDirty: hasNoteDraft,
                isBusy: isBusy
            )
            .interactiveDismissDisabled(hasNoteDraft || isBusy)
            .sheet(isPresented: $showingGrant) {
                AdminCreditGrantView(admin: admin, session: session, member: current)
            }
            .sheet(isPresented: $showingNoticeComposer) {
                AdminMemberNoticeComposer(
                    session: session,
                    memberID: current.id,
                    memberName: current.displayName,
                    isSending: admin.sendingMemberNoticeID == current.id,
                    onSend: { draft in
                        if await admin.sendMemberNotice(
                            session: session,
                            memberID: current.id,
                            draft: draft
                        ) {
                            XertHaptics.play(admin.memberNoticeStatusIsWarning ? .warning : .success)
                            return true
                        }
                        XertHaptics.play(.error)
                        return false
                    }
                )
            }
            .confirmationDialog(
                pendingRole == "admin" ? "Grant administrator access?" : "Remove administrator access?",
                isPresented: Binding(get: { pendingRole != nil }, set: { if !$0 { pendingRole = nil } }),
                presenting: pendingRole
            ) { role in
                Button(role == "admin" ? "Promote to administrator" : "Remove administrator", role: role == "member" ? .destructive : nil) {
                    Task { _ = await admin.setMemberRole(session: session, memberID: current.id, role: role); pendingRole = nil }
                }
                Button("Cancel", role: .cancel) { pendingRole = nil }
            } message: { role in
                Text(role == "admin" ? "This person will gain full owner command-centre access." : "This person will lose all administrative access. The final administrator cannot be removed.")
            }
            .confirmationDialog(
                "Discard staff note?",
                isPresented: $confirmingDiscardNote,
                titleVisibility: .visible
            ) {
                Button("Discard note", role: .destructive) {
                    clearStaffNoteDraft()
                    dismiss()
                }
                Button("Keep writing", role: .cancel) {}
            } message: {
                Text("The unsaved note for \(current.displayName) will be lost.")
            }
        }
    }

    private var staffNoteSaveBar: some View {
        Button(action: addStaffNote) {
            HStack(spacing: 10) {
                if isBusy { ProgressView().tint(Color.xertNavy) }
                Label(isBusy ? "Adding note..." : "Add staff note", systemImage: "note.text.badge.plus")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canAddStaffNote ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canAddStaffNote)
        .accessibilityIdentifier("owner.member.staffNote.save")
        .accessibilityHint(
            canAddStaffNote
                ? "Adds this private note to \(current.displayName)'s permanent staff timeline"
                : "Enter an operational note between 3 and 1,000 characters"
        )
    }

    private var canAddStaffNote: Bool {
        memberRecordMutationsAllowed && (3...1_000).contains(normalizedNoteBody.count)
    }

    private func addStaffNote() {
        guard canAddStaffNote else { return }
        noteFocused = false
        Task {
            if await admin.addMemberNote(
                session: session,
                memberID: current.id,
                category: noteCategory,
                body: normalizedNoteBody
            ) {
                hasCommittedStaffNote = true
                clearStaffNoteDraft()
                recoveredStaffNoteAt = nil
                noteBody = ""
                XertHaptics.play(admin.memberNoteStatusIsWarning ? .warning : .success)
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func memberActionDock(onAddNote: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            Divider().overlay(Color.xertSteel.opacity(0.22))
            HStack(spacing: 8) {
                memberActionDockButton(
                    title: "Notice",
                    icon: "bell.badge",
                    accessibilityHint: "Compose a private notice for \(current.displayName)",
                    isDisabled: !memberRecordMutationsAllowed || admin.sendingMemberNoticeID != nil
                ) {
                    showingNoticeComposer = true
                    XertHaptics.play(.lightImpact)
                }
                memberActionDockButton(
                    title: "Credits",
                    icon: "ticket",
                    accessibilityHint: "Grant class credits to \(current.displayName)",
                    isDisabled: !memberRecordMutationsAllowed
                ) {
                    showingGrant = true
                    XertHaptics.play(.lightImpact)
                }
                memberActionDockButton(
                    title: "Staff note",
                    icon: "note.text.badge.plus",
                    accessibilityHint: "Scroll to the staff note editor",
                    isDisabled: false,
                    action: onAddNote
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
        }
        .background(.ultraThinMaterial)
        .accessibilityIdentifier("owner.member.actionDock")
    }

    private func memberActionDockButton(
        title: String,
        icon: String,
        accessibilityHint: String,
        isDisabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.body.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(isDisabled ? Color.xertPale.opacity(0.36) : Color.xertSteel)
        .disabled(isDisabled)
        .accessibilityLabel(title)
        .accessibilityHint(accessibilityHint)
    }

    private func requestDismiss() {
        noteFocused = false
        if hasNoteDraft {
            confirmingDiscardNote = true
        } else if !isBusy {
            clearStaffNoteDraft()
            dismiss()
        }
    }

    private func persistStaffNoteDraft() async {
        guard !hasCommittedStaffNote else { return }
        guard hasNoteDraft else {
            if hasEditedStaffNoteDuringPresentation { clearStaffNoteDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommittedStaffNote, !isBusy else { return }
        AdminIntakeDraftStore.save(
            staffNoteDraft,
            kind: .memberStaffNote,
            ownerID: session.user?.id,
            recordID: current.id.uuidString,
            baselineToken: staffNoteBaselineToken
        )
    }

    private func discardRecoveredStaffNote() {
        noteCategory = "general"
        noteBody = ""
        recoveredStaffNoteAt = nil
        clearStaffNoteDraft()
        XertHaptics.play(.softImpact)
    }

    private func clearStaffNoteDraft() {
        AdminIntakeDraftStore.clear(
            kind: .memberStaffNote,
            ownerID: session.user?.id,
            recordID: current.id.uuidString
        )
    }

    private var accountHistorySection: some View {
        Section("Account history") {
            Picker("Account history", selection: $historyTab) {
                ForEach(AdminMemberHistoryTab.allCases) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("owner.member.accountHistory")

            if !memberRecordIsCurrent {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading \(historyTab.rawValue.lowercased())...")
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                }
                .frame(minHeight: 44)
            } else {
                switch historyTab {
                case .credits:
                    creditHistory
                case .bookings:
                    bookingHistory
                case .purchases:
                    purchaseHistory
                }
            }
        }
        .listRowBackground(Color.xertInk)
    }

    @ViewBuilder
    private var creditHistory: some View {
        if admin.memberDetailUnavailableSources.contains("credit history") {
            accountHistoryWarning(
                "Credit history is unavailable.",
                detail: "Refresh before relying on this balance or its expiry dates."
            )
        } else if admin.memberCreditBatches.isEmpty {
            accountHistoryEmpty("No credit batches recorded.", icon: "ticket")
        } else {
            ForEach(admin.memberCreditBatches) { batch in
                VStack(alignment: .leading, spacing: 7) {
                    ViewThatFits(in: .horizontal) {
                        HStack {
                            Text("\(batch.remaining) of \(batch.total) credits")
                                .font(.headline.monospacedDigit())
                            Spacer()
                            historyStatus(batch.stateLabel())
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text("\(batch.remaining) of \(batch.total) credits")
                                .font(.headline.monospacedDigit())
                            historyStatus(batch.stateLabel())
                        }
                    }

                    if let expiry = batch.expires_at {
                        Label(
                            "Expires \(expiry.formatted(date: .abbreviated, time: .omitted))",
                            systemImage: "calendar.badge.clock"
                        )
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.65))
                    } else {
                        Label("No expiry", systemImage: "infinity")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.65))
                    }

                    if let grant = admin.memberCreditGrants.first(where: { $0.credit_batch_id == batch.id }) {
                        Label(grant.note, systemImage: "person.badge.plus")
                            .font(.caption)
                            .foregroundStyle(Color.xertSteel)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Text("Added \(batch.created_at.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption2)
                        .foregroundStyle(Color.xertPale.opacity(0.45))
                }
                .padding(.vertical, 5)
                .accessibilityElement(children: .combine)
            }

            if admin.memberDetailUnavailableSources.contains("credit audit") {
                accountHistoryWarning(
                    "Manual grant reasons are unavailable.",
                    detail: "Credit grants remain paused until the audit ledger refreshes."
                )
            }
        }
    }

    @ViewBuilder
    private var bookingHistory: some View {
        if admin.memberDetailUnavailableSources.contains("booking history") {
            accountHistoryWarning(
                "Booking history is unavailable.",
                detail: "Refresh before relying on this member's attendance record."
            )
        } else if admin.memberBookingHistory.isEmpty {
            accountHistoryEmpty("No bookings recorded.", icon: "calendar")
        } else {
            ForEach(admin.memberBookingHistory) { booking in
                VStack(alignment: .leading, spacing: 7) {
                    ViewThatFits(in: .horizontal) {
                        HStack {
                            Text(booking.class_sessions?.displayName ?? "Class")
                                .font(.headline)
                            Spacer()
                            historyStatus(booking.statusLabel)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text(booking.class_sessions?.displayName ?? "Class")
                                .font(.headline)
                            historyStatus(booking.statusLabel)
                        }
                    }
                    Label(
                        (booking.class_sessions?.start_time ?? booking.created_at)
                            .formatted(date: .abbreviated, time: .shortened),
                        systemImage: "clock"
                    )
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.62))
                    if let cancelledAt = booking.cancelled_at {
                        Text("Cancelled \(cancelledAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption2)
                            .foregroundStyle(Color.xertPale.opacity(0.45))
                    }
                }
                .padding(.vertical, 5)
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder
    private var purchaseHistory: some View {
        if admin.memberDetailUnavailableSources.contains("purchase history") {
            accountHistoryWarning(
                "Purchase history is unavailable.",
                detail: "Refresh before discussing payments, refunds or purchased terms."
            )
        } else if admin.memberOrderHistory.isEmpty {
            accountHistoryEmpty("No purchases recorded.", icon: "creditcard")
        } else {
            ForEach(admin.memberOrderHistory) { order in
                NavigationLink {
                    AdminOrderDetailView(admin: admin, session: session, order: order)
                } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        ViewThatFits(in: .horizontal) {
                            HStack {
                                Text(order.products?.name ?? "Session pack")
                                    .font(.headline)
                                Spacer()
                                Text(order.displayAmount)
                                    .font(.subheadline.weight(.bold).monospacedDigit())
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(order.products?.name ?? "Session pack")
                                    .font(.headline)
                                Text(order.displayAmount)
                                    .font(.subheadline.weight(.bold).monospacedDigit())
                            }
                        }
                        HStack(spacing: 8) {
                            historyStatus(order.displayStatus)
                            Text(order.activityDate.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption)
                                .foregroundStyle(Color.xertPale.opacity(0.58))
                        }
                        Text(order.purchasedTerms)
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.62))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 5)
                }
                .accessibilityHint("Opens payment recovery, reconciliation and refund operations for this purchase")
            }
        }
    }

    private func historyStatus(_ value: String) -> some View {
        Text(value.uppercased())
            .font(.caption2.weight(.bold))
            .foregroundStyle(historyStatusColour(value))
            .fixedSize(horizontal: true, vertical: false)
    }

    private func historyStatusColour(_ value: String) -> Color {
        switch value.lowercased() {
        case "available", "paid", "confirmed", "attended": return .green
        case "expired", "used", "cancelled", "declined", "refunded": return Color.xertPale.opacity(0.5)
        case "failed": return .red
        default: return .orange
        }
    }

    private func accountHistoryWarning(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: "wifi.exclamationmark")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.orange)
            Text(detail)
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.58))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(minHeight: 44, alignment: .leading)
    }

    private func accountHistoryEmpty(_ title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(.subheadline)
            .foregroundStyle(Color.xertPale.opacity(0.62))
            .frame(minHeight: 44, alignment: .leading)
    }

    private var memberReadinessSection: some View {
        Section("Member readiness") {
            if admin.loadingMemberDetailID == current.id,
               admin.memberOnboardingSummary == nil {
                HStack {
                    ProgressView().tint(Color.xertSteel)
                    Text("Checking member readiness...")
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                }
            } else if let summary = admin.memberOnboardingSummary,
                      summary.user_id == current.id {
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(summary.statusLabel)
                            .font(.headline)
                            .foregroundStyle(summary.onboarding_complete ? Color.xertSteel : Color.xertOffWhite)
                        Text(summary.onboarding_complete
                             ? "The current profile, emergency contact and required acknowledgements are complete."
                             : "Readiness is advisory during rollout and does not block existing member actions.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.58))
                    }
                } icon: {
                    Image(systemName: summary.onboarding_complete ? "checkmark.seal.fill" : "person.crop.circle.badge.exclamationmark")
                        .foregroundStyle(summary.onboarding_complete ? Color.xertSteel : Color.orange)
                }

                readinessRow("Account details", complete: summary.profile_complete)
                readinessRow("Emergency contact", complete: summary.emergency_contact_complete)
                readinessRow(
                    "Required acknowledgements",
                    detail: "\(summary.accepted_required_count) of \(summary.required_document_count)",
                    complete: summary.documents_complete
                )

                if summary.emergency_contact_complete {
                    if let reveal = admin.revealedMemberEmergencyContact,
                       reveal.user_id == current.id {
                        let contact = reveal.emergency_contact
                        VStack(alignment: .leading, spacing: 8) {
                            Text(contact.name)
                                .font(.headline)
                                .foregroundStyle(Color.xertOffWhite)
                            Text(contact.relationship)
                                .font(.caption)
                                .foregroundStyle(Color.xertPale.opacity(0.62))
                            if let encoded = contact.phone.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                               let url = URL(string: "tel:\(encoded)") {
                                Link(contact.phone, destination: url)
                                    .font(.subheadline.weight(.semibold))
                            } else {
                                Text(contact.phone).font(.subheadline)
                            }
                            Text("Revealed \(reveal.revealed_at.formatted(date: .abbreviated, time: .shortened)). This access was recorded.")
                                .font(.caption2)
                                .foregroundStyle(Color.xertPale.opacity(0.48))
                        }
                        .padding(.vertical, 4)
                        .privacySensitive()
                        .accessibilityElement(children: .combine)
                    } else {
                        Button {
                            Task { await admin.revealMemberEmergencyContact(session: session, memberID: current.id) }
                        } label: {
                            HStack {
                                Label("Reveal emergency contact", systemImage: "cross.case")
                                Spacer()
                                if admin.revealingEmergencyContactMemberID == current.id {
                                    ProgressView().tint(Color.xertSteel)
                                }
                            }
                        }
                        .disabled(
                            !memberRecordMutationsAllowed
                                || admin.revealingEmergencyContactMemberID != nil
                        )
                        Text("Use only when needed for member safety. Every reveal is recorded with the administrator and time.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.52))
                    }
                } else {
                    Text("No emergency contact is available. Ask the member to finish Member Readiness in the XERT app.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.58))
                }
            } else if admin.memberDetailUnavailableSources.contains("member readiness") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Member readiness is unavailable.")
                        .font(.subheadline.weight(.semibold))
                    Text("Pull down to retry before relying on this record in an emergency.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.58))
                }
            } else {
                Text("No member readiness record is available yet.")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale.opacity(0.68))
            }
        }
        .listRowBackground(Color.xertInk)
    }

    private var privateNoticesSection: some View {
        Section("Private notices") {
            if let status = admin.memberNoticeStatusMessage {
                Label(
                    status,
                    systemImage: admin.memberNoticeStatusIsWarning
                        ? "exclamationmark.triangle.fill"
                        : "checkmark.circle.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(admin.memberNoticeStatusIsWarning ? Color.orange : Color.green)
                .accessibilityAddTraits(.isStaticText)
            }

            if !memberRecordIsCurrent {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading private notice history...")
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                }
            } else if admin.memberDetailUnavailableSources.contains("private notices") {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Private notice history is unavailable.", systemImage: "wifi.exclamationmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.orange)
                    Text("Refresh this member record before sending or relying on delivery history.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.58))
                }
            } else {
                Button {
                    showingNoticeComposer = true
                    XertHaptics.play(.lightImpact)
                } label: {
                    HStack {
                        Label("Send private notice", systemImage: "bell.badge")
                        Spacer()
                        if admin.sendingMemberNoticeID == current.id {
                            ProgressView().tint(Color.xertSteel)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                        }
                    }
                    .frame(minHeight: 44)
                }
                .disabled(!memberRecordMutationsAllowed)
                .accessibilityHint("Composes an account-only message with optional Apple push delivery")

                if admin.loadingMemberDetailID == current.id && admin.memberNotices.isEmpty {
                    HStack {
                        ProgressView().tint(Color.xertSteel)
                        Text("Loading delivery history...")
                            .foregroundStyle(Color.xertPale.opacity(0.68))
                    }
                } else if admin.memberNotices.isEmpty {
                    Text("No private notices have been sent to this member.")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale.opacity(0.62))
                }

                ForEach(admin.memberNotices) { notice in
                    AdminMemberNoticeHistoryRow(notice: notice)
                }
            }
        }
        .listRowBackground(Color.xertInk)
    }

    private func readinessRow(_ title: String, detail: String? = nil, complete: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: complete ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(complete ? Color.xertSteel : Color.xertPale.opacity(0.42))
                .accessibilityHidden(true)
            Text(title)
            Spacer()
            if let detail {
                Text(detail)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Color.xertPale.opacity(0.58))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(complete ? "complete" : "incomplete")")
    }
}

private struct AdminMemberNoticeHistoryRow: View {
    let notice: AdminMemberNotice

    private var toneColour: Color {
        switch notice.tone {
        case "urgent": return .red
        case "action": return .orange
        default: return Color.xertSteel
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(notice.sourceLabel.uppercased())
                    .font(.caption2.weight(.black))
                    .foregroundStyle(toneColour)
                Spacer(minLength: 8)
                Text(notice.published_at.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.xertPale.opacity(0.45))
            }
            Text(notice.title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Color.xertOffWhite)
            Text(notice.body)
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.68))
                .lineLimit(4)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { evidence }
                VStack(alignment: .leading, spacing: 5) { evidence }
            }
            if let label = notice.cta_label {
                Label(label, systemImage: "arrow.up.forward.app")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.xertSteel)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(notice.sourceLabel), \(notice.title), \(notice.receiptLabel), \(notice.deliveryLabel)"
        )
    }

    @ViewBuilder
    private var evidence: some View {
        Label(
            notice.receiptLabel,
            systemImage: notice.read_at == nil ? "envelope" : "envelope.open"
        )
        Label(
            notice.deliveryLabel,
            systemImage: notice.push_delivered > 0
                ? "checkmark.circle.fill"
                : notice.push_failed > 0 ? "exclamationmark.triangle" : "iphone"
        )
        if let expiresAt = notice.expires_at {
            Label(
                expiresAt <= Date()
                    ? "Expired \(expiresAt.formatted(date: .abbreviated, time: .omitted))"
                    : "Expires \(expiresAt.formatted(date: .abbreviated, time: .omitted))",
                systemImage: "calendar.badge.clock"
            )
        }
    }
}

private struct AdminMemberNoticeComposer: View {
    @Environment(\.dismiss) private var dismiss
    let session: AuthSession
    let memberID: UUID
    let memberName: String
    let isSending: Bool
    let onSend: (AdminMemberNoticeDraft) async -> Bool
    private let baseline: AdminMemberNoticeDraft
    @State private var draft: AdminMemberNoticeDraft
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingSend = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case title
        case body
    }

    init(
        session: AuthSession,
        memberID: UUID,
        memberName: String,
        isSending: Bool,
        onSend: @escaping (AdminMemberNoticeDraft) async -> Bool
    ) {
        let baseline = AdminMemberNoticeDraft()
        let recovered: AdminCatalogueDraftSnapshot<AdminMemberNoticeDraft>? =
            AdminCatalogueDraftStore.load(
                kind: .memberNotice,
                ownerID: session.user?.id,
                recordID: memberID,
                baselineToken: nil
            )
        self.session = session
        self.memberID = memberID
        self.memberName = memberName
        self.isSending = isSending
        self.onSend = onSend
        self.baseline = baseline
        _draft = State(initialValue: recovered?.draft ?? baseline)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    private var isDirty: Bool { draft != baseline }
    private var validation: String? { draft.validationMessage() }

    var body: some View {
        NavigationStack {
            Form {
                if let recoveredAt {
                    AdminRecoveredCatalogueDraftNotice(
                        savedAt: recoveredAt,
                        onDiscard: discardRecoveredEdits
                    )
                }
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("PRIVATE MEMBER MESSAGE", systemImage: "person.crop.circle.badge.exclamationmark")
                            .font(.caption.weight(.black))
                            .foregroundStyle(Color.xertSteel)
                        Text(memberName)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(Color.xertOffWhite)
                        Text("Only this member can see the notice in their XERT account.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.58))
                    }
                    .padding(.vertical, 4)
                }

                Section("Notice") {
                    TextField("Title", text: $draft.title)
                        .focused($focusedField, equals: .title)
                        .onChange(of: draft.title) { value in
                            if value.count > 120 { draft.title = String(value.prefix(120)) }
                        }
                    HStack {
                        Spacer()
                        Text("\(draft.title.count)/120")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(Color.xertPale.opacity(0.45))
                    }
                    TextEditor(text: $draft.body)
                        .focused($focusedField, equals: .body)
                        .frame(minHeight: 160)
                        .onChange(of: draft.body) { value in
                            if value.count > 2_000 { draft.body = String(value.prefix(2_000)) }
                        }
                    HStack {
                        Spacer()
                        Text("\(draft.body.count)/2000")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(Color.xertPale.opacity(0.45))
                    }
                }

                Section("Delivery") {
                    Picker("Priority", selection: $draft.tone) {
                        Text("Information").tag("info")
                        Text("Action needed").tag("action")
                        Text("Urgent").tag("urgent")
                    }
                    Picker("Member action", selection: $draft.action) {
                        ForEach(AdminMemberNoticeAction.allCases) { action in
                            Text(action.title).tag(action)
                        }
                    }
                    Picker("Expires after", selection: $draft.expiryDays) {
                        Text("7 days").tag(7)
                        Text("30 days").tag(30)
                        Text("90 days").tag(90)
                    }
                    Text("The notice is saved first, then XERT attempts Apple push delivery to the member's enabled devices.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.55))
                }

                if let validation {
                    Section {
                        Label(validation, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .xertOwnerScreen()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Private Notice")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button {
                    focusedField = nil
                    confirmingSend = true
                } label: {
                    Label(isSending ? "Sending..." : "Review & Send", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.xertSteel)
                .foregroundStyle(Color.xertNavy)
                .disabled(isSending || validation != nil)
                .accessibilityIdentifier("owner.memberNotice.send")
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { requestClose() }
                        .disabled(isSending)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focusedField = nil }
                }
            }
            .confirmationDialog(
                "Send this private notice to \(memberName)?",
                isPresented: $confirmingSend,
                titleVisibility: .visible
            ) {
                Button("Send private notice") {
                    Task { await sendDraft() }
                }
                    .disabled(isSending || validation != nil)
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text("The notice becomes available in this member's account immediately. Apple push delivery is attempted once.")
            }
            .confirmationDialog(
                "Discard private notice draft?",
                isPresented: $confirmingDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard draft", role: .destructive) {
                    clearRecoveryDraft()
                    dismiss()
                }
                Button("Keep writing", role: .cancel) {}
            } message: {
                Text("The title, message and delivery choices will be lost.")
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: "private notice for \(memberName)",
            isDirty: isDirty,
            isBusy: isSending
        )
        .interactiveDismissDisabled(isDirty || isSending)
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
    }

    private func requestClose() {
        focusedField = nil
        if isDirty {
            confirmingDiscard = true
        } else {
            clearRecoveryDraft()
            dismiss()
        }
    }

    @MainActor
    private func sendDraft() async {
        guard !isSending, validation == nil else { return }
        focusedField = nil
        guard await onSend(draft) else { return }
        hasCommitted = true
        clearRecoveryDraft()
        dismiss()
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isSending else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .memberNotice,
            ownerID: session.user?.id,
            recordID: memberID,
            baselineToken: nil
        )
    }

    private func discardRecoveredEdits() {
        draft = baseline
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .memberNotice,
            ownerID: session.user?.id,
            recordID: memberID
        )
    }
}

private struct AdminCreditGrantView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let member: AdminMemberSummary
    @State private var sessions = 1
    @State private var validityDays = 28
    @State private var noExpiry = false
    @State private var reason = ""
    @State private var requestID = UUID()
    @State private var confirmingGrant = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var reasonFocused: Bool

    private var isDirty: Bool {
        sessions != 1
            || validityDays != 28
            || noExpiry
            || !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var isBusy: Bool { admin.servicingMemberID != nil }
    private var creditMutationAllowed: Bool {
        admin.loadedMemberDetailID == member.id
            && admin.loadingMemberDetailID == nil
            && !admin.memberDetailUnavailableSources.contains("credit audit")
    }
    private var normalizedReason: String {
        reason.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canReviewGrant: Bool {
        creditMutationAllowed && !isBusy && (3...500).contains(normalizedReason.count)
    }
    private var expirySummary: String {
        noExpiry ? "These credits will not expire." : "These credits will expire \(validityDays) days after the grant."
    }

    var body: some View {
        NavigationStack {
            Form {
                if !creditMutationAllowed {
                    Section {
                        Label(
                            "The verified credit audit is no longer current. Close this sheet and refresh the member record before granting credits.",
                            systemImage: "lock.trianglebadge.exclamationmark"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Section("Credit grant") {
                    Stepper("Credits: \(sessions)", value: $sessions, in: 1...100)
                    Toggle("No expiry", isOn: $noExpiry)
                    if !noExpiry { Stepper("Valid for \(validityDays) days", value: $validityDays, in: 1...3_650) }
                    TextField("Reason", text: $reason, axis: .vertical)
                        .lineLimit(3...6)
                        .focused($reasonFocused)
                        .onChange(of: reason) { value in
                            if value.count > 500 { reason = String(value.prefix(500)) }
                        }
                    HStack {
                        Text("Required for the permanent audit trail")
                        Spacer()
                        Text("\(reason.count)/500")
                            .monospacedDigit()
                    }
                    .font(.caption2)
                    .foregroundStyle(normalizedReason.count < 3 ? Color.orange : Color.xertPale.opacity(0.55))
                    Text("Manual grants are permanently audited and idempotent.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Grant to \(member.displayName)").navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button {
                    reasonFocused = false
                    confirmingGrant = true
                } label: {
                    Label("Review \(sessions) credit\(sessions == 1 ? "" : "s")", systemImage: "checkmark.shield")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.xertNavy)
                .background(canReviewGrant ? Color.xertSteel : Color.xertSteel.opacity(0.45))
                .disabled(!canReviewGrant)
                .accessibilityIdentifier("owner.creditGrant.review")
                .accessibilityHint(
                    !creditMutationAllowed
                        ? "Refresh the member record before granting credits"
                        : canReviewGrant
                        ? "Reviews the exact member, quantity, expiry and audit reason before granting"
                        : "Enter an audit reason between 3 and 500 characters"
                )
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: requestDismiss)
                        .disabled(isBusy)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { reasonFocused = false }
                }
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: "manual credit grant",
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .confirmationDialog(
            "Grant \(sessions) class credit\(sessions == 1 ? "" : "s") to \(member.displayName)?",
            isPresented: $confirmingGrant,
            titleVisibility: .visible
        ) {
            Button("Grant \(sessions) credit\(sessions == 1 ? "" : "s")") {
                performGrant()
            }
            .disabled(!canReviewGrant)
            Button("Keep reviewing", role: .cancel) {}
        } message: {
            Text("\(expirySummary) Audit reason: \(normalizedReason)")
        }
        .confirmationDialog(
            "Discard manual credit grant?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard grant", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("No credits have been granted yet. The amount, expiry and audit reason will be lost.")
        }
    }

    private func performGrant() {
        guard canReviewGrant else { return }
        let id = requestID
        Task {
            if await admin.grantCredits(
                session: session,
                memberID: member.id,
                sessions: sessions,
                validityDays: noExpiry ? nil : validityDays,
                requestID: id,
                note: normalizedReason
            ) {
                requestID = UUID()
                XertHaptics.play(.success)
                dismiss()
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func requestDismiss() {
        reasonFocused = false
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }
}

private struct AdminClassesView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var promotion: AdminWaitlistItem?

    private var operationsAreCurrent: Bool {
        admin.loadedSources.contains("today's classes")
            && !admin.refreshUnavailableSources.contains("today's classes")
    }
    private var waitlistIsCurrent: Bool {
        admin.loadedSources.contains("waitlists")
            && !admin.refreshUnavailableSources.contains("waitlists")
    }
    private var operationsAreLoading: Bool {
        admin.isLoading && !admin.loadedSources.contains("today's classes")
    }
    private var waitlistIsLoading: Bool {
        admin.isLoading && !admin.loadedSources.contains("waitlists")
    }
    private var operationalFocus: AdminClassOperationalFocus? {
        AdminClassOperationalFocus.resolve(
            operations: admin.dailyOperations,
            sourceIsCurrent: operationsAreCurrent
        )
    }
    private var remainingOperations: [AdminDailyOperation] {
        guard let focusID = operationalFocus?.operation.id else {
            return admin.dailyOperations
        }
        return admin.dailyOperations.filter { $0.id != focusID }
    }

    var body: some View {
        List {
            Section(operationalFocus == nil ? "Today" : "Run next") {
                if operationsAreLoading {
                    operationalLoadingRow("Loading today's classes…")
                } else {
                    if !operationsAreCurrent {
                        operationalWarningRow(
                            admin.dailyOperations.isEmpty
                                ? "Today's classes are unavailable. Refresh before relying on this desk."
                                : "Showing the last class snapshot. Refresh before changing attendance."
                        )
                    }
                    if admin.dailyOperations.isEmpty, operationsAreCurrent {
                        operationalEmptyRow("No classes are scheduled today.", icon: "calendar")
                    }
                    if let focus = operationalFocus {
                        classDeskLink(focus.operation, focus: focus)
                    } else {
                        ForEach(admin.dailyOperations) { item in
                            classDeskLink(item)
                        }
                    }
                }
            }
            if operationalFocus != nil, !remainingOperations.isEmpty {
                Section("Later today") {
                    ForEach(remainingOperations) { item in
                        classDeskLink(item)
                    }
                }
            }
            Section("Waitlist desk") {
                if let status = admin.promotionStatusMessage {
                    Label(
                        status,
                        systemImage: admin.promotionStatusIsWarning
                            ? "checkmark.shield.fill"
                            : "checkmark.circle.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(admin.promotionStatusIsWarning ? Color.orange : Color.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .listRowBackground(Color.xertInk)
                }
                if let warning = admin.promotionNoticeWarning {
                    operationalWarningRow(warning)
                }
                if waitlistIsLoading {
                    operationalLoadingRow("Loading class waitlists…")
                } else {
                    if !waitlistIsCurrent {
                        operationalWarningRow(
                            admin.waitlist.isEmpty
                                ? "Waitlists are unavailable. Refresh before assuming every queue is clear."
                                : "Showing the last waitlist snapshot. Refresh before promoting a member."
                        )
                    }
                    if admin.waitlist.isEmpty, waitlistIsCurrent {
                        operationalEmptyRow("No members are waiting for a class place.", icon: "person.2.badge.checkmark")
                    }
                    ForEach(admin.waitlist) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.title).font(.headline)
                            Text("Next: \(item.nextMemberName) · \(item.next_available_credits) credits")
                                .font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                            Button {
                                promotion = item
                            } label: {
                                Label("Promote next member", systemImage: "person.fill.badge.plus")
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.xertSteel)
                            .disabled(
                                !waitlistIsCurrent || !item.can_promote
                                    || item.next_available_credits < 1 || admin.promotingSessionID != nil
                            )
                        }
                        .foregroundStyle(Color.xertOffWhite)
                        .listRowBackground(Color.xertInk)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Today's classes")
        .refreshable { await admin.refresh(session: session) }
        .confirmationDialog(
            "Promote \(promotion?.nextMemberName ?? "next member")?",
            isPresented: Binding(
                get: { promotion != nil },
                set: { if !$0 { promotion = nil } }
            ),
            presenting: promotion
        ) { item in
            Button("Confirm promotion") {
                Task {
                    let succeeded = await admin.promoteNext(
                        session: session,
                        classSessionID: item.session_id,
                        expectedBookingID: item.next_booking_id,
                        requestID: UUID()
                    )
                    XertHaptics.play(
                        !succeeded
                            ? .error
                            : (admin.promotionStatusIsWarning || admin.promotionNoticeWarning != nil
                                ? .warning
                                : .success)
                    )
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { item in
            Text("This confirms the next FIFO waitlisted member into \(item.title), reserves one available credit, and creates a private member notice. Apple push is requested for enabled devices.")
        }
    }

    private func classDeskLink(
        _ item: AdminDailyOperation,
        focus: AdminClassOperationalFocus? = nil
    ) -> some View {
        NavigationLink {
            AdminClassRosterView(admin: admin, session: session, operation: item)
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                if let focus {
                    Label(
                        classDeskFocusLabel(focus),
                        systemImage: focus.phase == .attendanceDue ? "checklist" : "clock"
                    )
                    .font(.caption2.weight(.black))
                    .foregroundStyle(focus.phase == .attendanceDue ? Color.orange : Color.xertSteel)
                }
                Text(item.title).font(.headline)
                Text("\(item.start_time.formatted(date: .omitted, time: .shortened)) · \(item.activeCount) active · \(item.waitlist_count) waiting")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                if item.attendance_due, focus?.phase != .attendanceDue {
                    Label("Roll call is due", systemImage: "checklist")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.orange)
                }
            }
            .foregroundStyle(Color.xertOffWhite)
            .padding(.vertical, focus == nil ? 0 : 4)
        }
        .listRowBackground(Color.xertInk)
        .accessibilityHint("Opens this class roster")
    }

    private func classDeskFocusLabel(_ focus: AdminClassOperationalFocus) -> String {
        switch focus.phase {
        case .attendanceDue: return "ROLL CALL DUE"
        case .live: return "IN PROGRESS"
        case .upcoming: return "UP NEXT"
        }
    }

    private func operationalLoadingRow(_ message: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().tint(Color.xertSteel)
            Text(message).foregroundStyle(Color.xertPale.opacity(0.72))
        }
        .listRowBackground(Color.xertInk)
        .accessibilityElement(children: .combine)
    }

    private func operationalWarningRow(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.orange)
            .fixedSize(horizontal: false, vertical: true)
            .listRowBackground(Color.xertInk)
    }

    private func operationalEmptyRow(_ message: String, icon: String) -> some View {
        Label(message, systemImage: icon)
            .foregroundStyle(Color.xertPale.opacity(0.68))
            .listRowBackground(Color.xertInk)
    }
}

private struct AdminClassRosterView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let operation: AdminDailyOperation
    @State private var attendance = AdminAttendanceDraft()
    @State private var attendanceBaseline = AdminAttendanceDraft()
    @State private var confirmingRollCall = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @State private var presentedMember: AdminMemberSummary?
    @State private var openingMemberID: UUID?
    @State private var showingAddMember = false
    @State private var confirmingRosterExport = false
    @State private var exportDocument: AdminClassRosterCSVDocument?
    @State private var isExportingRoster = false
    @State private var exportError: String?
    @State private var recoveredDraftAt: Date?

    private var rosterIsCurrent: Bool { admin.loadedRosterSessionID == operation.id }
    private var roster: [AdminRosterMember] { rosterIsCurrent ? admin.classRoster : [] }
    /// People who signed up through the public timetable. A class filled that
    /// way used to read as empty here — no names, no phone numbers, nobody to
    /// mark off — while eight people stood on the floor.
    private var signups: [AdminLegacyBookingRequest] { rosterIsCurrent ? admin.classSignups : [] }
    private var confirmedSignups: [AdminLegacyBookingRequest] { signups.filter { $0.status == "confirmed" } }
    private var pendingSignups: [AdminLegacyBookingRequest] { signups.filter { $0.status == "requested" } }
    private var waitlistedSignups: [AdminLegacyBookingRequest] { signups.filter { $0.status == "waitlisted" } }
    /// The same definition the database uses: an active member booking or a
    /// confirmed public sign-up.
    private var placesHeld: Int {
        roster.filter { ["requested", "confirmed"].contains($0.status) }.count + confirmedSignups.count
    }
    private var placesHeldLine: String {
        guard let capacity = operation.capacity, capacity > 0 else {
            return "\(placesHeld) in the class"
        }
        let left = max(capacity - placesHeld, 0)
        return "\(placesHeld) / \(capacity) in the class · \(left) left"
    }
    private var eligible: [AdminRosterMember] { roster.filter(\.attendanceEligible) }
    private var unresolvedRequests: [AdminRosterMember] {
        roster.filter { $0.status == "requested" }
    }
    private var readinessRelevant: [AdminRosterMember] {
        roster.filter { ["requested", "confirmed", "attended"].contains($0.status) }
    }
    private var incompleteReadiness: [AdminRosterMember] {
        readinessRelevant.filter {
            admin.classRosterReadiness[$0.member_id]?.onboarding_complete == false
        }
    }
    private var attendanceSummary: AdminAttendanceSummary { attendance.summary }
    private var isDirty: Bool { attendance != attendanceBaseline }
    private var isBusy: Bool { admin.recordingAttendanceSessionID == operation.id }
    private var loadFailed: Bool { admin.rosterLoadErrorSessionID == operation.id }
    private var canRecordAttendance: Bool {
        rosterIsCurrent && unresolvedRequests.isEmpty && attendanceSummary.isComplete
            && operation.start_time <= Date() && !isBusy
    }
    private var canAddMember: Bool {
        let assumedEnd = operation.end_time
            ?? operation.start_time.addingTimeInterval(3 * 60 * 60)
        return rosterIsCurrent
            && !loadFailed
            && !isDirty
            && ["published", "full"].contains(operation.status.lowercased())
            && assumedEnd > Date()
            && admin.addingRosterMemberID == nil
    }
    private var canExportRoster: Bool {
        rosterIsCurrent
            && admin.loadedRosterAt != nil
            && admin.loadingRosterSessionID != operation.id
            && !loadFailed
            && !roster.isEmpty
            && !isBusy
    }
    private var activeRosterMemberIDs: Set<UUID> {
        Set(roster.compactMap { member in
            ["requested", "confirmed", "waitlisted", "attended", "no_show"].contains(member.status)
                ? member.member_id
                : nil
        })
    }

    // The body was one 436-line List whose four sections the type-checker
    // could not solve inside its time budget ("unable to type-check this
    // expression in reasonable time"). Each section is its own property now,
    // so each is solved independently. Keep them separate when adding rows.

    @ViewBuilder
    private var rosterSummarySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(operation.start_time.formatted(date: .abbreviated, time: .shortened)).font(.headline)
                Text([operation.coach_name, operation.location_zone].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                // public_request_count was the one place in this file that
                // left the timetable requests out, so the Today card said "3
                // requested" and this header said "2".
                Text("\(operation.confirmedInRoom) confirmed · \(operation.requested_count + operation.public_request_count) requested · \(operation.waitingInRoom) waiting")
                    .font(.caption).foregroundStyle(Color.xertSteel)
                if placesHeld > 0 || (operation.capacity ?? 0) > 0 {
                    Text(placesHeldLine)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(placesHeld >= (operation.capacity ?? Int.max) ? Color.orange : Color.xertSteel)
                        .accessibilityIdentifier("owner.roster.placesHeld")
                }
                if rosterIsCurrent, let loadedAt = admin.loadedRosterAt {
                    Label(
                        "Roster verified \(loadedAt.formatted(date: .omitted, time: .shortened))",
                        systemImage: "checkmark.shield.fill"
                    )
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(loadFailed ? Color.orange : Color.green)
                    .accessibilityIdentifier("owner.roster.verifiedAt")
                }
            }
            .listRowBackground(Color.xertInk)
        }
    }

    @ViewBuilder
    private var rollCallSection: some View {
        if operation.start_time <= Date(), !eligible.isEmpty {
            Section("Roll call") {
                VStack(alignment: .leading, spacing: 12) {
                    // Bound to a differently named constant on purpose. `if let
                    // recoveredDraftAt` shadows the @State property with a
                    // non-optional `let Date`, so the `= nil` in the button below
                    // resolved to that constant, not the state, and failed with
                    // "cannot assign to value" and "'nil' cannot be assigned to
                    // type 'Date'".
                    if let recoveredAt = recoveredDraftAt {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(
                                "Recovered unsaved marks from \(recoveredAt.formatted(date: .omitted, time: .shortened)).",
                                systemImage: "arrow.counterclockwise.circle.fill"
                            )
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color.xertSteel)
                            .fixedSize(horizontal: false, vertical: true)
                            Button("Discard recovered marks") {
                                attendance = attendanceBaseline
                                recoveredDraftAt = nil
                                clearPersistedAttendanceDraft()
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                        }
                        .accessibilityIdentifier("owner.roster.recoveredDraft")
                    }

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 14) { attendanceProgressLabels }
                        VStack(alignment: .leading, spacing: 6) { attendanceProgressLabels }
                    }

                    ProgressView(
                        value: Double(attendanceSummary.marked),
                        total: Double(max(attendanceSummary.total, 1))
                    )
                    .tint(attendanceSummary.isComplete ? Color.green : Color.xertSteel)

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { attendanceBulkActions }
                        VStack(spacing: 10) { attendanceBulkActions }
                    }

                    if attendanceSummary.unmarked > 0 {
                        Label(
                            "Mark every member present or no show before saving.",
                            systemImage: "exclamationmark.circle"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                    }

                    if !unresolvedRequests.isEmpty {
                        Label(
                            "\(unresolvedRequests.count) booking request\(unresolvedRequests.count == 1 ? "" : "s") must be confirmed or declined before this class can close.",
                            systemImage: "person.crop.circle.badge.questionmark"
                        )
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("owner.roster.pendingRequestGuard")
                    }
                }
                .padding(.vertical, 4)
                .listRowBackground(Color.xertInk)
            }
        }
    }

    @ViewBuilder
    private var trainingReadinessSection: some View {
        if rosterIsCurrent, !readinessRelevant.isEmpty {
            Section("Training readiness") {
                if let warning = admin.rosterReadinessStatusMessage {
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                } else if admin.loadingRosterSessionID == operation.id {
                    HStack(spacing: 10) {
                        ProgressView().tint(Color.xertSteel)
                        Text("Checking member readiness...")
                    }
                    .foregroundStyle(Color.xertPale.opacity(0.72))
                } else if incompleteReadiness.isEmpty {
                    Label(
                        "Every active booking has completed the required readiness steps.",
                        systemImage: "checkmark.shield.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.green)
                } else {
                    Label(
                        "\(incompleteReadiness.count) active booking\(incompleteReadiness.count == 1 ? "" : "s") need readiness review before training.",
                        systemImage: "person.crop.circle.badge.exclamationmark"
                    )
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .listRowBackground(Color.xertInk)
        }
    }

    @ViewBuilder
    private var memberRosterSection: some View {
        Section("Member roster") {
            if admin.bookingDecisionStatusSessionID == operation.id,
               let status = admin.bookingDecisionStatusMessage {
                Label(
                    status,
                    systemImage: admin.bookingDecisionStatusIsWarning
                        ? "checkmark.shield.fill"
                        : "checkmark.circle.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(admin.bookingDecisionStatusIsWarning ? Color.orange : Color.green)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("owner.roster.bookingDecisionReceipt")
            }
            if admin.bookingDecisionStatusSessionID == operation.id,
               let warning = admin.bookingDecisionNoticeWarning {
                Label(warning, systemImage: "bell.badge.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let feedback = admin.staffBookingFeedback,
               feedback.sessionID == operation.id {
                Label(
                    feedback.message,
                    systemImage: feedback.needsAttention
                        ? "exclamationmark.circle.fill"
                        : "checkmark.circle.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(feedback.needsAttention ? Color.orange : Color.green)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("owner.roster.staffBookingFeedback")
            }
            Button {
                showingAddMember = true
            } label: {
                Label("Add existing member", systemImage: "person.badge.plus")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.xertSteel)
            .foregroundStyle(Color.xertNavy)
            .disabled(!canAddMember)
            .accessibilityHint(
                isDirty
                    ? "Save or discard attendance marks before changing the roster"
                    : "Searches member accounts and safely confirms or waitlists one member"
            )

            if !rosterIsCurrent, admin.loadingRosterSessionID == operation.id {
                HStack { Spacer(); ProgressView().tint(Color.xertSteel); Spacer() }
            } else if !rosterIsCurrent, loadFailed {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Roster unavailable", systemImage: "wifi.exclamationmark")
                        .font(.headline)
                        .foregroundStyle(Color.orange)
                    Text(admin.rosterLoadErrorMessage ?? "The class roster could not be loaded.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.72))
                        .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await loadRoster(preserveCurrent: false) }
                    } label: {
                        Label("Retry roster", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.xertSteel)
                    .foregroundStyle(Color.xertNavy)
                }
                .padding(.vertical, 4)
            } else if rosterIsCurrent, loadFailed {
                Label(
                    "Showing the last verified roster. Refresh failed: \(admin.rosterLoadErrorMessage ?? "connection unavailable")",
                    systemImage: "exclamationmark.arrow.triangle.2.circlepath"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .fixedSize(horizontal: false, vertical: true)
            } else if rosterIsCurrent, roster.isEmpty {
                Text("No member bookings for this class.")
            }
            ForEach(roster) { member in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.displayName).font(.headline)
                            Text(member.status.replacingOccurrences(of: "_", with: " ").uppercased())
                                .font(.caption2.weight(.bold)).foregroundStyle(statusColour(member.status))
                        }
                        Spacer()
                        if !member.attendanceEligible || operation.start_time > Date(),
                           let actions = bookingActions(member.status), !actions.isEmpty {
                            Menu {
                                ForEach(actions) { action in
                                    Button(role: action.role) {
                                        Task {
                                            let succeeded = await admin.setBookingStatus(
                                                session: session,
                                                classSessionID: operation.id,
                                                bookingID: member.id,
                                                status: action.status
                                            )
                                            XertHaptics.play(
                                                !succeeded
                                                    ? .error
                                                    : (admin.bookingDecisionStatusIsWarning
                                                        ? .warning
                                                        : .success)
                                            )
                                        }
                                    } label: { Label(action.label, systemImage: action.icon) }
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle").font(.title3)
                            }
                            .disabled(admin.updatingBookingID != nil || loadFailed)
                            .accessibilityLabel("Manage \(member.displayName) booking")
                        }
                    }
                    readinessBadge(for: member)
                    if member.attendanceEligible && operation.start_time <= Date() {
                        attendanceControl(for: member)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 14) { memberActions(for: member) }
                        VStack(alignment: .leading, spacing: 10) { memberActions(for: member) }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.xertSteel)
                }
                .padding(.vertical, 5)
                .listRowBackground(Color.xertInk)
            }
        }
    }

    /// Sign-ups from the public timetable, grouped by what their place is.
    /// Contact details sit next to each name because for these people that is
    /// all XERT has — they have no account to look up.
    @ViewBuilder
    private var publicSignupsSection: some View {
        Section("Timetable sign-ups") {
            if !rosterIsCurrent {
                Text("Loading sign-ups…")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.6))
            } else if signups.isEmpty {
                Text("Nobody has signed up through the timetable for this class.")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.6))
            } else {
                signupGroup("In the class", confirmedSignups)
                signupGroup("Awaiting your decision", pendingSignups)
                signupGroup("Waitlist", waitlistedSignups)
            }
        }
    }

    @ViewBuilder
    private func signupGroup(_ title: String, _ people: [AdminLegacyBookingRequest]) -> some View {
        if !people.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(title.uppercased()) (\(people.count))")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.xertPale.opacity(0.5))
                ForEach(people, id: \.id.value) { person in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(person.full_name ?? person.email ?? "Timetable sign-up")
                            .font(.subheadline.weight(.semibold))
                        if let email = person.email, !email.isEmpty {
                            Link(email, destination: URL(string: "mailto:\(email)") ?? XertLinks.site)
                                .font(.caption)
                                .foregroundStyle(Color.xertSteel)
                        }
                        if let phone = person.phone, !phone.isEmpty {
                            // Hoisted out of the interpolation: a closure inside
                            // a string literal is a parser trap here.
                            let dialable = phone.filter { !$0.isWhitespace }
                            Link(phone, destination: URL(string: "tel:\(dialable)") ?? XertLinks.site)
                                .font(.caption)
                                .foregroundStyle(Color.xertSteel)
                        }
                        if let note = person.admin_notes, !note.isEmpty {
                            Text(note)
                                .font(.caption2)
                                .foregroundStyle(Color.xertPale.opacity(0.5))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .padding(.vertical, 4)
            .listRowBackground(Color.xertInk)
        }
    }

    var body: some View {
        List {
            rosterSummarySection
            rollCallSection
            trainingReadinessSection
            memberRosterSection
            publicSignupsSection
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if operation.start_time <= Date() {
                VStack(spacing: 0) {
                    Divider().overlay(Color.xertSteel.opacity(0.25))
                    Button { confirmingRollCall = true } label: {
                        HStack {
                            if admin.recordingAttendanceSessionID == operation.id {
                                ProgressView().tint(Color.xertNavy)
                            }
                            Label(
                                !unresolvedRequests.isEmpty
                                    ? "Resolve \(unresolvedRequests.count) booking request\(unresolvedRequests.count == 1 ? "" : "s")"
                                    : attendanceSummary.isComplete
                                        ? "Save complete roll call"
                                        : "\(attendanceSummary.marked) of \(attendanceSummary.total) marked",
                                systemImage: "checklist"
                            )
                            .fontWeight(.bold)
                            .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.xertSteel)
                    .foregroundStyle(Color.xertNavy)
                    .controlSize(.large)
                    .disabled(!canRecordAttendance)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                }
                .background(.ultraThinMaterial)
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle(operation.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: operation.id) { await loadRoster(preserveCurrent: false) }
        .refreshable { await loadRoster(preserveCurrent: true) }
        .onChange(of: admin.classRoster) { roster in
            guard rosterIsCurrent else { return }
            attendance.reconcile(roster: roster)
            attendanceBaseline.reconcile(roster: roster)
        }
        .onChange(of: attendance) { _ in
            persistAttendanceDraft()
        }
        .onDisappear {
            persistAttendanceDraft()
        }
        .sheet(item: $presentedMember) { member in
            NavigationStack {
                AdminMemberDetailView(admin: admin, session: session, member: member)
            }
        }
        .sheet(isPresented: $showingAddMember) {
            AdminRosterMemberPicker(
                admin: admin,
                session: session,
                operation: operation,
                existingMemberIDs: activeRosterMemberIDs
            )
        }
        .fileExporter(
            isPresented: $isExportingRoster,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: rosterExportFilename
        ) { result in
            if case .failure(let error) = result {
                exportError = error.localizedDescription
            }
            exportDocument = nil
        }
        .alert("Export failed", isPresented: Binding(
            get: { exportError != nil },
            set: { if !$0 { exportError = nil } }
        )) {
            Button("OK", role: .cancel) { exportError = nil }
        } message: {
            Text(exportError ?? "The class roster could not be exported.")
        }
        .navigationBarBackButtonHidden(isDirty)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    confirmingRosterExport = true
                } label: {
                    Image(systemName: "square.and.arrow.up")
                        .frame(width: 44, height: 44)
                }
                .disabled(!canExportRoster)
                .accessibilityLabel("Export verified class roster")
                .accessibilityHint("Exports member contact details and the current roll call draft")
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task { await loadRoster(preserveCurrent: true) }
                } label: {
                    if admin.loadingRosterSessionID == operation.id {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(admin.loadingRosterSessionID == operation.id || isBusy)
                .accessibilityLabel("Refresh class roster")
            }
            if isDirty {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: requestDismiss) {
                        Image(systemName: "chevron.left")
                            .frame(width: 44, height: 44)
                    }
                    .disabled(isBusy)
                    .accessibilityLabel("Back")
                    .accessibilityHint("Asks before discarding this unfinished roll call")
                }
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: "roll call for \(operation.title)",
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .confirmationDialog("Complete this class?", isPresented: $confirmingRollCall, titleVisibility: .visible) {
            Button("Record attendance and complete class") {
                let attended = attendance.attendedIDs
                let noShows = attendance.noShowIDs
                Task {
                    let didRecord = await admin.recordAttendance(
                        session: session,
                        classSessionID: operation.id,
                        attendedIDs: attended,
                        noShowIDs: noShows
                    )
                    if didRecord {
                        clearPersistedAttendanceDraft()
                        recoveredDraftAt = nil
                        if admin.loadedRosterSessionID == operation.id {
                            attendance = AdminAttendanceDraft(roster: admin.classRoster)
                            attendanceBaseline = attendance
                        }
                        XertHaptics.play(.success)
                    } else {
                        XertHaptics.play(.error)
                    }
                }
            }
            Button("Review roll call", role: .cancel) {}
        } message: {
            Text("Record \(attendanceSummary.attended) present and \(attendanceSummary.noShow) no show, complete the class, and remove it from the public timetable. Every booking request has been resolved.")
        }
        .confirmationDialog(
            "Export this verified roster?",
            isPresented: $confirmingRosterExport,
            titleVisibility: .visible
        ) {
            Button("Export roster CSV") { prepareRosterExport() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This file contains member contact details. Store it securely and delete it after class-day reconciliation. Unsaved attendance marks are labelled as a roll call draft.")
        }
        .confirmationDialog(
            "Discard unfinished roll call?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard marks", role: .destructive) {
                clearPersistedAttendanceDraft()
                recoveredDraftAt = nil
                dismiss()
            }
            Button("Keep marking attendance", role: .cancel) {}
        } message: {
            Text("\(attendanceSummary.marked) attendance mark\(attendanceSummary.marked == 1 ? "" : "s") will be lost.")
        }
    }

    @ViewBuilder
    private var attendanceProgressLabels: some View {
        Label("\(attendanceSummary.marked)/\(attendanceSummary.total) marked", systemImage: "checklist")
        Label("\(attendanceSummary.attended) present", systemImage: "checkmark.circle.fill")
            .foregroundStyle(Color.green)
        Label("\(attendanceSummary.noShow) no show", systemImage: "xmark.circle.fill")
            .foregroundStyle(Color.orange)
    }

    @ViewBuilder
    private var attendanceBulkActions: some View {
        Button {
            attendance.markAllPresent()
            XertHaptics.play(.selection)
        } label: {
            Label("Mark all present", systemImage: "checkmark.circle")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.xertSteel)
        .foregroundStyle(Color.xertNavy)
        .disabled(attendanceSummary.total == 0 || attendanceSummary.attended == attendanceSummary.total)

        Button {
            attendance.clear()
            XertHaptics.play(.selection)
        } label: {
            Label("Clear marks", systemImage: "arrow.counterclockwise")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(Color.xertSteel)
        .disabled(attendanceSummary.marked == 0)
    }

    private func attendanceControl(for member: AdminRosterMember) -> some View {
        HStack(spacing: 0) {
            attendanceButton(
                title: "Present",
                icon: "checkmark",
                mark: .attended,
                member: member,
                colour: .green
            )
            attendanceButton(
                title: "No show",
                icon: "xmark",
                mark: .noShow,
                member: member,
                colour: .orange
            )
        }
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.xertSteel.opacity(0.34), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attendance for \(member.displayName)")
    }

    private func attendanceButton(
        title: String,
        icon: String,
        mark: AdminAttendanceMark,
        member: AdminRosterMember,
        colour: Color
    ) -> some View {
        let isSelected = attendance.mark(for: member.id) == mark
        return Button {
            attendance.set(mark, for: member.id)
            XertHaptics.play(.selection)
        } label: {
            Label(title, systemImage: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(isSelected ? Color.xertNavy : Color.xertPale)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(isSelected ? colour : Color.xertDeep.opacity(0.45))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(member.displayName), \(title)")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private struct BookingAction: Identifiable {
        var id: String { status }
        let status: String
        let label: String
        let icon: String
        let role: ButtonRole?
    }

    private func bookingActions(_ status: String) -> [BookingAction]? {
        switch status {
        case "requested":
            return [BookingAction(status: "confirmed", label: "Confirm place", icon: "checkmark.circle", role: nil),
                    BookingAction(status: "waitlisted", label: "Move to waitlist", icon: "person.2.badge.clock", role: nil),
                    BookingAction(status: "declined", label: "Decline request", icon: "xmark.circle", role: .destructive)]
        case "confirmed":
            return [BookingAction(status: "cancelled", label: "Cancel booking", icon: "calendar.badge.minus", role: .destructive)]
        case "waitlisted":
            return [BookingAction(status: "cancelled", label: "Remove from waitlist", icon: "person.crop.circle.badge.minus", role: .destructive)]
        default:
            return nil
        }
    }

    private func statusColour(_ status: String) -> Color {
        switch status {
        case "confirmed", "attended": return .green
        case "requested", "waitlisted": return .orange
        case "declined", "cancelled", "no_show": return .red
        default: return Color.xertSteel
        }
    }

    @ViewBuilder
    private func readinessBadge(for member: AdminRosterMember) -> some View {
        if ["requested", "confirmed", "attended"].contains(member.status),
           let readiness = admin.classRosterReadiness[member.member_id] {
            if readiness.onboarding_complete {
                Label("Training ready", systemImage: "checkmark.shield.fill")
                    .foregroundStyle(Color.green)
            } else {
                Label(readinessIssueLabel(readiness), systemImage: "exclamationmark.shield.fill")
                    .foregroundStyle(Color.orange)
            }
        }
    }

    @ViewBuilder
    private func memberActions(for member: AdminRosterMember) -> some View {
        Button { openMemberRecord(member.member_id) } label: {
            Label(
                openingMemberID == member.member_id ? "Opening..." : "Member record",
                systemImage: "person.text.rectangle"
            )
            .frame(minHeight: 32)
        }
        .buttonStyle(.plain)
        .disabled(openingMemberID != nil)
        if let email = contact(member.email), let url = URL(string: "mailto:\(email)") {
            Link(destination: url) { Label("Email", systemImage: "envelope").frame(minHeight: 32) }
        }
        if let phone = contact(member.phone),
           let encoded = phone.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
           let url = URL(string: "tel:\(encoded)") {
            Link(destination: url) { Label("Call", systemImage: "phone").frame(minHeight: 32) }
        }
    }

    private func readinessIssueLabel(_ readiness: AdminMemberOnboardingSummary) -> String {
        var issues: [String] = []
        if !readiness.profile_complete { issues.append("profile") }
        if !readiness.emergency_contact_complete { issues.append("emergency contact") }
        if !readiness.documents_complete { issues.append("documents") }
        return "Review " + issues.joined(separator: ", ")
    }

    private func openMemberRecord(_ memberID: UUID) {
        guard openingMemberID == nil else { return }
        if let member = admin.members.first(where: { $0.id == memberID }) {
            presentedMember = member
            return
        }
        openingMemberID = memberID
        Task {
            await admin.resolveOwnerTask(session: session, task: .member(memberID))
            if let member = admin.members.first(where: { $0.id == memberID }) {
                presentedMember = member
            }
            openingMemberID = nil
        }
    }

    private func contact(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private var rosterExportFilename: String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let slug = operation.title.lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .unicodeScalars
            .filter { allowed.contains($0) }
            .map(String.init)
            .joined()
            .prefix(48)
        let rawDay = operation.start_time.formatted(
            .dateTime.year().month(.twoDigits).day(.twoDigits)
        )
        let day = rawDay.unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .map(String.init)
            .joined()
        return "xert-\(day)-\(slug)-roster"
    }

    private func prepareRosterExport() {
        guard canExportRoster, let loadedAt = admin.loadedRosterAt else { return }
        let report = AdminClassRosterReport(
            operation: operation,
            members: roster,
            attendance: attendance,
            rosterVerifiedAt: loadedAt,
            generatedAt: Date()
        )
        exportDocument = AdminClassRosterCSVDocument(csv: report.csv)
        isExportingRoster = true
    }

    private func requestDismiss() {
        if isDirty {
            confirmingDiscard = true
        } else {
            clearPersistedAttendanceDraft()
            dismiss()
        }
    }

    @MainActor
    private func loadRoster(preserveCurrent: Bool) async {
        let wasDirty = isDirty
        let didLoad = await admin.loadClassRoster(
            session: session,
            classSessionID: operation.id,
            preserveCurrent: preserveCurrent
        )
        guard didLoad, admin.loadedRosterSessionID == operation.id else { return }
        if !wasDirty {
            let serverDraft = AdminAttendanceDraft(roster: admin.classRoster)
            attendanceBaseline = serverDraft
            if let snapshot = AdminAttendanceDraftStore.load(
                ownerID: session.user?.id,
                sessionID: operation.id
            ) {
                var recovered = serverDraft
                recovered.restore(
                    snapshot.marks,
                    whenCurrentMatches: snapshot.baselineMarks
                )
                attendance = recovered
                if recovered != serverDraft {
                    recoveredDraftAt = snapshot.savedAt
                } else {
                    recoveredDraftAt = nil
                    clearPersistedAttendanceDraft()
                }
            } else {
                recoveredDraftAt = nil
                attendance = serverDraft
            }
        }
    }

    private func persistAttendanceDraft() {
        guard isDirty else {
            clearPersistedAttendanceDraft()
            return
        }
        AdminAttendanceDraftStore.save(
            attendance,
            baseline: attendanceBaseline,
            ownerID: session.user?.id,
            sessionID: operation.id
        )
    }

    private func clearPersistedAttendanceDraft() {
        AdminAttendanceDraftStore.clear(
            ownerID: session.user?.id,
            sessionID: operation.id
        )
    }
}

private struct AdminClassRosterCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    let csv: String

    init(csv: String) { self.csv = csv }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        csv = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(csv.utf8))
    }
}

private struct AdminRosterMemberPicker: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let operation: AdminDailyOperation
    let existingMemberIDs: Set<UUID>
    @State private var query = ""
    @State private var candidate: AdminMemberSummary?
    @State private var requestID = UUID()

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(operation.title)
                            .font(.headline)
                            .foregroundStyle(Color.xertOffWhite)
                        Text(
                            "\(operation.start_time.formatted(date: .abbreviated, time: .shortened))"
                                + " · \(operation.confirmed_count) confirmed"
                                + " · \(operation.waitlist_count) waiting"
                        )
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.64))
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .listRowBackground(Color.xertInk)
                }

                Section("Member search") {
                    if normalizedQuery.count < 2 {
                        Label(
                            "Enter at least two letters, an email or a phone number.",
                            systemImage: "magnifyingglass"
                        )
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                    } else if admin.isSearchingOwnerMembers {
                        HStack(spacing: 10) {
                            ProgressView().tint(Color.xertSteel)
                            Text("Searching member accounts...")
                        }
                        .foregroundStyle(Color.xertPale.opacity(0.72))
                    } else if let error = admin.ownerMemberSearchError {
                        Label(error, systemImage: "wifi.exclamationmark")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                    } else if admin.ownerMemberSearchResults.isEmpty {
                        Label("No matching member accounts.", systemImage: "person.slash")
                            .foregroundStyle(Color.xertPale.opacity(0.68))
                    } else {
                        ForEach(admin.ownerMemberSearchResults) { member in
                            memberRow(member)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .xertOwnerScreen()
            .navigationTitle("Add member")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Name, email or phone")
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .disabled(admin.addingRosterMemberID != nil)
                    .accessibilityLabel("Close")
                }
            }
        }
        .interactiveDismissDisabled(admin.addingRosterMemberID != nil)
        .task(id: normalizedQuery) {
            guard normalizedQuery.count >= 2 else {
                admin.resetOwnerMemberSearch()
                return
            }
            do {
                try await Task.sleep(nanoseconds: 300_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await admin.searchOwnerMembers(session: session, query: normalizedQuery)
        }
        .onDisappear {
            admin.resetOwnerMemberSearch()
        }
        .confirmationDialog(
            "Add \(candidate?.displayName ?? "member")?",
            isPresented: Binding(
                get: { candidate != nil },
                set: { if !$0 { candidate = nil } }
            ),
            titleVisibility: .visible,
            presenting: candidate
        ) { member in
            Button("Confirm staff booking") {
                Task {
                    let succeeded = await admin.bookMemberIntoClass(
                        session: session,
                        classSessionID: operation.id,
                        member: member,
                        requestID: requestID
                    )
                    if succeeded {
                        requestID = UUID()
                        XertHaptics.play(.success)
                        dismiss()
                    } else {
                        XertHaptics.play(.error)
                    }
                }
            }
            Button("Review member", role: .cancel) {}
        } message: { member in
            Text(
                "XERT will confirm \(member.displayName) when capacity and one valid credit are available. "
                    + "Otherwise the member joins the FIFO waitlist without using a credit. "
                    + "The member receives a private in-app notice."
            )
        }
    }

    private func memberRow(_ member: AdminMemberSummary) -> some View {
        let isExisting = existingMemberIDs.contains(member.id)
        let isMember = member.role.lowercased() == "member"
        let isUnavailable = isExisting || !isMember
        let isAdding = admin.addingRosterMemberID == member.id
        let availabilityText: String
        if isExisting {
            availabilityText = "Already on this roster"
        } else if !isMember {
            availabilityText = "Not a member account"
        } else {
            availabilityText = "\(member.credits_remaining) available credit\(member.credits_remaining == 1 ? "" : "s")"
        }
        let availabilityColor: Color = isExisting
            ? .green
            : (isMember && member.credits_remaining > 0 ? Color.xertSteel : .orange)
        return Button {
            candidate = member
        } label: {
            HStack(spacing: 12) {
                Image(systemName: isExisting ? "person.crop.circle.badge.checkmark" : "person.crop.circle")
                    .font(.title3)
                    .foregroundStyle(isExisting ? Color.green : Color.xertSteel)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(member.displayName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.xertOffWhite)
                    if let email = member.email?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !email.isEmpty {
                        Text(email)
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.6))
                            .lineLimit(1)
                    }
                    Text(availabilityText)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(availabilityColor)
                }
                Spacer(minLength: 8)
                if isAdding {
                    ProgressView().tint(Color.xertSteel)
                } else if !isUnavailable {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(Color.xertSteel)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isUnavailable || admin.addingRosterMemberID != nil)
        .accessibilityHint(isExisting
            ? "This member already has an active roster entry"
            : (isMember
                ? "Reviews a staff-assisted booking for this member"
                : "Only member accounts can be added to a class"))
        .listRowBackground(Color.xertInk)
    }
}

private struct AdminScheduleView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var query = ""
    @State private var scope = AdminScheduleScope.upcoming
    @State private var showingCancelled = false
    @State private var mode = AdminScheduleViewMode.calendar
    @State private var showingCreate = false
    @State private var createInitialStart: Date?
    @State private var pendingCancellation: AdminClassSession?
    @State private var repeatingClass: AdminClassSession?

    private var timetableIsCurrent: Bool {
        admin.loadedSources.contains("full timetable")
            && !admin.refreshUnavailableSources.contains("full timetable")
    }

    private var timetableIsLoading: Bool {
        admin.isLoading && !admin.loadedSources.contains("full timetable")
    }

    private var rows: [AdminClassSession] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let scoped = scopedRows(for: scope)
        let visible = scoped.filter { showingCancelled || $0.status.lowercased() != "cancelled" }
        let filtered = term.isEmpty ? visible : visible.filter {
            "\($0.title) \($0.class_type ?? "") \($0.coach_name ?? "") \($0.location_zone ?? "")".lowercased().contains(term)
        }
        return filtered.sorted {
            let left = $0.start_time ?? .distantPast
            let right = $1.start_time ?? .distantPast
            return scope == .upcoming ? left < right : left > right
        }
    }

    private func scopedRows(for scope: AdminScheduleScope) -> [AdminClassSession] {
        admin.classSessions.filter { scope.includes($0, now: Date()) }
    }

    private var cancelledCount: Int {
        let source = mode == .calendar ? admin.classSessions : scopedRows(for: scope)
        return source.filter { $0.status.lowercased() == "cancelled" }.count
    }

    private func count(for scope: AdminScheduleScope) -> Int {
        scopedRows(for: scope).filter { $0.status.lowercased() != "cancelled" }.count
    }

    private var emptyMessage: String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "No matching \(scope.title.lowercased()) classes."
        }
        if !showingCancelled, cancelledCount > 0 {
            return "\(cancelledCount) cancelled \(cancelledCount == 1 ? "class is" : "classes are") hidden. Show cancelled to review the retained record."
        }
        switch scope {
        case .upcoming: return "No current or upcoming classes are scheduled."
        case .past: return "No past classes are available."
        case .all: return "No classes are scheduled."
        }
    }

    private func classSummary(_ item: AdminClassSession) -> String {
        let time = item.start_time?.formatted(date: .omitted, time: .shortened) ?? "Time TBC"
        let capacity = item.capacity ?? 0
        return "\(time) · \(capacity) places"
    }

    private func classDay(_ item: AdminClassSession) -> String {
        item.start_time?.formatted(.dateTime.day()) ?? "--"
    }

    private func classMonth(_ item: AdminClassSession) -> String {
        item.start_time?.formatted(.dateTime.month(.abbreviated)) ?? "TBC"
    }

    var body: some View {
        List {
            Section {
                Picker("Timetable view", selection: $mode) {
                    ForEach(AdminScheduleViewMode.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("owner.timetable.mode")
            }
            .listRowBackground(Color.xertInk)

            if mode == .list {
                Section {
                    Picker("Timetable scope", selection: $scope) {
                        ForEach(AdminScheduleScope.allCases) { option in
                            Text("\(option.title) \(count(for: option))")
                                .tag(option)
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("owner.timetable.scope")
                }
                .listRowBackground(Color.xertInk)
            }

            if cancelledCount > 0 {
                Section {
                    Button {
                        showingCancelled.toggle()
                        XertHaptics.play(.selection)
                    } label: {
                        Label(
                            showingCancelled ? "Hide cancelled" : "Show cancelled (\(cancelledCount))",
                            systemImage: showingCancelled ? "eye.slash" : "eye"
                        )
                    }
                    .buttonStyle(.bordered)
                    .tint(Color.xertSteel)
                    .accessibilityIdentifier("owner.timetable.cancelled")
                    .accessibilityHint("Cancelled classes stay retained for audit and can be hidden from the timetable")
                }
                .listRowBackground(Color.xertInk)
            }

            if let status = admin.classMutationStatusMessage {
                Label(
                    status,
                    systemImage: admin.classMutationStatusIsWarning
                        ? "checkmark.shield.fill"
                        : "checkmark.circle.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(admin.classMutationStatusIsWarning ? Color.orange : Color.green)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .listRowBackground(Color.xertInk)
            }

            if timetableIsLoading {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading the class calendar...")
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                }
                .frame(minHeight: 44)
                .listRowBackground(Color.xertInk)
            } else {
                if !timetableIsCurrent {
                    Label(
                        admin.classSessions.isEmpty
                            ? "The class calendar is unavailable. Refresh before managing classes."
                            : "Showing the last timetable snapshot. Refresh before editing or cancelling a class.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .listRowBackground(Color.xertInk)
                }
                if mode == .calendar {
                    AdminClassCalendarSections(
                        admin: admin,
                        session: session,
                        timetableIsCurrent: timetableIsCurrent,
                        includeCancelled: showingCancelled,
                        onCreateClass: { start in
                            createInitialStart = start
                            showingCreate = true
                        }
                    )
                } else {
                    if rows.isEmpty {
                        Text(emptyMessage)
                            .foregroundStyle(Color.xertPale.opacity(0.65))
                            .listRowBackground(Color.xertInk)
                    }
                    ForEach(rows) { item in
                        classRow(item)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Class Calendar")
        .searchable(text: $query, prompt: "Search timetable")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    createInitialStart = nil
                    showingCreate = true
                } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Create class")
                    .disabled(!timetableIsCurrent)
            }
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack {
                AdminClassEditor(
                    admin: admin,
                    session: session,
                    classSession: nil,
                    mutationAllowed: timetableIsCurrent,
                    initialStartTime: createInitialStart
                )
            }
        }
        .sheet(item: $repeatingClass) { classSession in
            AdminClassRepeatView(
                admin: admin,
                session: session,
                classSession: classSession,
                mutationAllowed: timetableIsCurrent
            )
        }
        .refreshable { await admin.refresh(session: session) }
        .sheet(
            item: Binding(
                get: { admin.classCancellationFollowUp },
                set: { if $0 == nil { admin.clearClassCancellationFollowUp() } }
            )
        ) { followUp in
            AdminClassCancellationFollowUpView(
                followUp: followUp,
                onClose: admin.clearClassCancellationFollowUp
            )
        }
        .confirmationDialog(
            "Cancel this class?",
            isPresented: Binding(get: { pendingCancellation != nil }, set: { if !$0 { pendingCancellation = nil } }),
            presenting: pendingCancellation
        ) { item in
            Button("Cancel \(item.title)", role: .destructive) {
                Task {
                    let outcome = await admin.cancelClass(session: session, classSession: item)
                    XertHaptics.play(outcome == nil ? .error : .warning)
                    if outcome != nil { showingCancelled = false }
                    pendingCancellation = nil
                }
            }
            Button("Keep class", role: .cancel) { pendingCancellation = nil }
        } message: { _ in
            Text("Every active booking is cancelled, reserved credits are returned, and affected members receive a cancellation notice.")
        }
    }

    private func classRow(_ item: AdminClassSession) -> some View {
        HStack(alignment: .top, spacing: 12) {
            classDateBadge(item)
            classInformation(item)
        }
        .padding(.vertical, 6)
        .listRowBackground(Color.xertInk)
    }

    private func classDateBadge(_ item: AdminClassSession) -> some View {
        VStack(spacing: 2) {
            Text(classDay(item)).font(.title3.weight(.bold))
            Text(classMonth(item)).font(.caption2.weight(.bold))
        }
        .frame(width: 42)
        .foregroundStyle(Color.xertSteel)
    }

    private func classInformation(_ item: AdminClassSession) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            NavigationLink {
                AdminClassEditor(
                    admin: admin,
                    session: session,
                    classSession: item,
                    mutationAllowed: timetableIsCurrent
                )
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title).font(.headline)
                    Text(classSummary(item))
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.6))
                }
            }
            classStatusActions(item)
        }
        .foregroundStyle(Color.xertOffWhite)
    }

    private func classStatusActions(_ item: AdminClassSession) -> some View {
        HStack {
            Text(item.status.uppercased()).foregroundStyle(classStatusColour(item.status))
            if item.public_visible == true { Text("PUBLIC").foregroundStyle(.green) }
            Spacer()
            Menu {
                Button {
                    Task { _ = await admin.duplicateClass(session: session, classSession: item) }
                } label: {
                    Label("Duplicate as draft", systemImage: "plus.square.on.square")
                }
                Button {
                    XertHaptics.play(.lightImpact)
                    repeatingClass = item
                } label: {
                    Label("Repeat class...", systemImage: "calendar.badge.plus")
                }
                .disabled(item.start_time == nil)
                if !["cancelled", "completed"].contains(item.status) {
                    Button(role: .destructive) { pendingCancellation = item } label: {
                        Label("Cancel class", systemImage: "calendar.badge.minus")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .disabled(
                !timetableIsCurrent
                    || admin.savingClassID != nil
                    || admin.cancellingClassID != nil
            )
            .accessibilityLabel("Manage \(item.title)")
        }
        .font(.caption2.weight(.bold))
    }

    private func classStatusColour(_ status: String) -> Color {
        switch status {
        case "published": return .green
        case "full": return .orange
        case "cancelled": return .red
        default: return Color.xertSteel
        }
    }
}

private struct AdminClassCancellationFollowUpView: View {
    let followUp: AdminClassCancellationFollowUp
    let onClose: () -> Void
    @State private var copiedMessage = false

    var body: some View {
        NavigationStack {
            List {
                Section("Cancellation result") {
                    Label {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(followUp.classTitle)
                                .font(.headline)
                            Text(affectedSummary)
                                .font(.caption)
                                .foregroundStyle(Color.xertPale.opacity(0.62))
                        }
                    } icon: {
                        Image(systemName: "calendar.badge.minus")
                            .foregroundStyle(Color.orange)
                    }

                    if !followUp.refreshWarnings.isEmpty {
                        Label(
                            "Class cancelled, but \(followUp.refreshWarnings.joined(separator: ", ")) could not refresh.",
                            systemImage: "exclamationmark.arrow.triangle.2.circlepath"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .listRowBackground(Color.xertInk)

                if followUp.affectedBookings > 0 {
                    notificationSection
                    contactSection

                    Section("Ready-to-send message") {
                        Text(followUp.message.body)
                            .font(.subheadline)
                            .foregroundStyle(Color.xertOffWhite)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        if followUp.omittedEmailCount > 0 {
                            Label(
                                "\(followUp.omittedEmailCount) additional email recipient\(followUp.omittedEmailCount == 1 ? " was" : "s were") omitted from the bounded BCC message.",
                                systemImage: "person.crop.circle.badge.exclamationmark"
                            )
                            .font(.caption)
                            .foregroundStyle(Color.orange)
                        }
                    }
                    .listRowBackground(Color.xertInk)
                }
            }
            .scrollContentBackground(.hidden)
            .xertOwnerScreen()
            .navigationTitle("Cancellation Follow-up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onClose() }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if followUp.affectedBookings > 0 {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) {
                            followUpActions(expands: false)
                        }
                        VStack(spacing: 10) {
                            followUpActions(expands: true)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.ultraThinMaterial)
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private var notificationSection: some View {
        Section("Member notification") {
            if let notification = followUp.notification {
                Label(
                    "Private notice created for \(notification.recipients) member account\(notification.recipients == 1 ? "" : "s").",
                    systemImage: "bell.badge.fill"
                )
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.xertSteel)

                Label(pushSummary(notification.push), systemImage: pushIcon(notification.push))
                    .font(.caption)
                    .foregroundStyle(notification.push.delivered > 0 ? Color.green : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let warning = followUp.notificationWarning {
                Label(warning, systemImage: "bell.slash.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Label(
                    "The cancellation notice exists in affected member accounts. Use the contact fallback below.",
                    systemImage: "bell"
                )
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.65))
            }
        }
        .listRowBackground(Color.xertInk)
    }

    private var contactSection: some View {
        Section("Contact fallback") {
            if followUp.contactLookupIncomplete {
                Label(
                    "One booking source could not be checked. Review Class requests before considering follow-up complete.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .fixedSize(horizontal: false, vertical: true)
            }

            if followUp.contacts.isEmpty {
                Text("No email address or callable phone number was available for affected bookings.")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale.opacity(0.62))
            } else {
                ForEach(followUp.contacts) { contact in
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) {
                            contactIdentity(contact)
                            Spacer(minLength: 8)
                            contactActions(contact)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            contactIdentity(contact)
                            contactActions(contact)
                        }
                    }
                    .frame(minHeight: 44)
                }
            }
        }
        .listRowBackground(Color.xertInk)
    }

    private func contactIdentity(_ contact: AdminClassCancellationContact) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(contact.displayName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.xertOffWhite)
            Text([contact.email, contact.phone].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.55))
                .lineLimit(2)
        }
    }

    private func contactActions(_ contact: AdminClassCancellationContact) -> some View {
        HStack(spacing: 6) {
            if let emailURL = contact.emailURL {
                Link(destination: emailURL) {
                    Image(systemName: "envelope")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Email \(contact.displayName)")
            }
            if let phoneURL = contact.phoneURL {
                Link(destination: phoneURL) {
                    Image(systemName: "phone")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Call \(contact.displayName)")
            }
        }
        .foregroundStyle(Color.xertSteel)
    }

    @ViewBuilder
    private func followUpActions(expands: Bool) -> some View {
        Button {
            UIPasteboard.general.string = followUp.message.body
            copiedMessage = true
            XertHaptics.play(.success)
        } label: {
            Label(copiedMessage ? "Message copied" : "Copy message", systemImage: copiedMessage ? "checkmark" : "doc.on.doc")
                .frame(maxWidth: expands ? .infinity : nil, minHeight: 46)
        }
        .buttonStyle(.bordered)
        .tint(Color.xertSteel)

        if let mailtoURL = followUp.mailtoURL {
            Link(destination: mailtoURL) {
                Label("Email \(followUp.emailRecipientCount) via BCC", systemImage: "envelope.fill")
                    .frame(maxWidth: expands ? .infinity : nil, minHeight: 46)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.xertSteel)
            .foregroundStyle(Color.xertNavy)
        }
    }

    private var affectedSummary: String {
        guard followUp.affectedBookings > 0 else {
            return "No active bookings needed to be cancelled."
        }
        return "\(followUp.affectedBookings) active booking\(followUp.affectedBookings == 1 ? " was" : "s were") cancelled. Reserved credits were returned."
    }

    private func pushSummary(_ push: AdminAnnouncementPushSummary) -> String {
        if push.delivered > 0 {
            return "\(push.delivered) Apple push notification\(push.delivered == 1 ? " was" : "s were") delivered."
        }
        if !push.configured {
            return "Apple push is not configured. The private notice remains available in XERT."
        }
        if push.attempted > 0 {
            return "Apple push was attempted but did not reach a registered device."
        }
        return "No enabled Apple device was registered. The private notice remains available in XERT."
    }

    private func pushIcon(_ push: AdminAnnouncementPushSummary) -> String {
        push.delivered > 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
    }
}

private struct AdminRecoveredCatalogueDraftNotice: View {
    let savedAt: Date
    let onDiscard: () -> Void

    var body: some View {
        Section {
            Label(
                "Recovered unsaved edits from \(savedAt.formatted(date: .omitted, time: .shortened))",
                systemImage: "arrow.counterclockwise.circle.fill"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.xertSteel)
            Button(role: .destructive, action: onDiscard) {
                Label("Discard recovered edits", systemImage: "trash")
            }
        }
    }
}

struct AdminClassEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.adminEditorExitCoordinator) private var editorExitCoordinator
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let classSession: AdminClassSession?
    let mutationAllowed: Bool
    private let baseline: AdminClassDraft
    private let baselineToken: String?
    @State private var draft: AdminClassDraft
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var textInputFocused: Bool

    private var isTerminal: Bool { classSession.map { ["cancelled", "completed"].contains($0.status) } ?? false }
    private var isDirty: Bool { draft != baseline }
    private var isBusy: Bool { admin.savingClassID != nil }
    private var editorTitle: String { classSession == nil ? "new class" : "class changes" }

    init(
        admin: AdminStore,
        session: AuthSession,
        classSession: AdminClassSession?,
        mutationAllowed: Bool,
        initialStartTime: Date? = nil
    ) {
        var baseline = AdminClassDraft(classSession: classSession)
        // A calendar day-press pre-fills the start without marking the editor
        // dirty: the baseline carries the same time as the draft.
        if classSession == nil, let initialStartTime {
            baseline.startTime = initialStartTime
            baseline.endTime = initialStartTime.addingTimeInterval(TimeInterval(baseline.durationMinutes * 60))
        }
        let baselineToken = AdminCatalogueDraftStore.baselineToken(for: classSession)
        let recovered: AdminCatalogueDraftSnapshot<AdminClassDraft>? = AdminCatalogueDraftStore.load(
            kind: .classSession,
            ownerID: session.user?.id,
            recordID: classSession?.id,
            baselineToken: baselineToken
        )
        let initial = recovered?.draft ?? baseline
        self.admin = admin
        self.session = session
        self.classSession = classSession
        self.mutationAllowed = mutationAllowed
        self.baseline = baseline
        self.baselineToken = baselineToken
        _draft = State(initialValue: initial)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    var body: some View {
        Form {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Section {
                    Label(
                        "This timetable snapshot is not current. Close this editor and refresh before changing the class.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption)
                    .foregroundStyle(Color.orange)
                }
            }
            if isTerminal {
                Section {
                    Label("This class is \(classSession?.status ?? "closed") and cannot be reopened. Duplicate it to create a new draft.", systemImage: "lock")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Section("Class") {
                Picker("Type", selection: $draft.classType) {
                    ForEach(AdminClassDraft.classTypes, id: \.self) { Text($0).tag($0) }
                }
                TextField("Title", text: $draft.title)
                    .focused($textInputFocused)
                TextField("Description", text: $draft.description, axis: .vertical)
                    .lineLimit(2...6)
                    .focused($textInputFocused)
                Picker("Status", selection: $draft.status) {
                    Text("Draft").tag("draft")
                    Text("Published").tag("published")
                    Text("Full").tag("full")
                }
            }
            Section("Date and capacity") {
                DatePicker("Starts", selection: $draft.startTime)
                Toggle("Set an end time", isOn: $draft.hasEndTime)
                if draft.hasEndTime {
                    DatePicker("Ends", selection: $draft.endTime, in: draft.startTime...)
                }
                Stepper("Duration: \(draft.durationMinutes) min", value: $draft.durationMinutes, in: 15...240, step: 5)
                Stepper("Capacity: \(draft.capacity)", value: $draft.capacity, in: 1...100)
            }
            Section("Delivery") {
                TextField("Coach", text: $draft.coachName)
                    .focused($textInputFocused)
                TextField("Location or zone", text: $draft.location)
                    .focused($textInputFocused)
                Picker("Intensity", selection: $draft.intensity) {
                    ForEach(AdminClassDraft.intensities, id: \.self) { Text($0).tag($0) }
                }
                Picker("Booking mode", selection: $draft.bookingMode) {
                    Text("Register interest only").tag("interest_only")
                    Text("Request to book (staff confirm)").tag("request_to_book")
                    Text("Sign-ups accepted (takes a spot)").tag("instant_book")
                }
                // The one setting on this screen that changes who ends up in
                // the room without anyone approving it.
                Text(bookingModeExplanation(draft.bookingMode))
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
                Toggle("Beginner friendly", isOn: $draft.beginnerFriendly)
                Toggle("Visible on public timetable", isOn: $draft.publicVisible)
                    .disabled(draft.status != "published")
            }
            Section("Internal notes") {
                TextField("Notes", text: $draft.notes, axis: .vertical)
                    .lineLimit(2...6)
                    .focused($textInputFocused)
            }
        }
        .disabled(isTerminal || !mutationAllowed)
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle(classSession == nil ? "New Class" : "Edit Class")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !isTerminal {
                classSaveBar
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: requestDismiss) {
                    Image(systemName: classSession == nil ? "xmark" : "chevron.left")
                        .frame(width: 44, height: 44)
                }
                .disabled(isBusy)
                .accessibilityLabel(classSession == nil ? "Cancel" : "Back")
                .accessibilityHint(isDirty ? "Asks before discarding unsaved class changes" : "Returns to the timetable")
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { textInputFocused = false }
            }
        }
        .onChange(of: draft.status) { status in
            if status != "published" { draft.publicVisible = false }
        }
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: editorTitle,
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .confirmationDialog(
            "Discard unsaved class changes?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive) {
                discardAndDismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("This class draft has not been saved.")
        }
    }

    private var classSaveBar: some View {
        Button {
            textInputFocused = false
            Task { await saveDraft() }
        } label: {
            HStack(spacing: 10) {
                if isBusy { ProgressView().tint(Color.xertNavy) }
                Text(classSession == nil ? "Create class" : "Save class")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.classEditor.save")
        .accessibilityHint(isDirty ? "Saves this class to the timetable" : "Make a change before saving")
    }

    private var canSave: Bool {
        mutationAllowed && !isTerminal && !isBusy && isDirty
    }

    private func requestDismiss() {
        textInputFocused = false
        guard !isBusy else { return }
        if isDirty {
            confirmingDiscard = true
        } else {
            clearRecoveryDraft()
            editorExitCoordinator?.clear(id: exitStateID)
            dismiss()
        }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isBusy else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .classSession,
            ownerID: session.user?.id,
            recordID: classSession?.id,
            baselineToken: baselineToken
        )
    }

    @MainActor
    private func saveDraft() async {
        guard mutationAllowed, !isBusy, isDirty else { return }
        guard await admin.saveClass(session: session, classSession: classSession, draft: draft) else {
            XertHaptics.play(.error)
            return
        }
        hasCommitted = true
        clearRecoveryDraft()
        editorExitCoordinator?.clear(id: exitStateID)
        XertHaptics.play(admin.classMutationStatusIsWarning ? .warning : .success)
        dismiss()
    }

    private func discardRecoveredEdits() {
        draft = baseline
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func discardAndDismiss() {
        clearRecoveryDraft()
        editorExitCoordinator?.clear(id: exitStateID)
        dismiss()
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .classSession,
            ownerID: session.user?.id,
            recordID: classSession?.id
        )
    }
}

private enum AdminScheduleRemoval: Identifiable {
    case availability(AdminAvailabilityBlock)
    case blackout(AdminBlackoutPeriod)
    var id: UUID {
        switch self { case .availability(let item): return item.id; case .blackout(let item): return item.id }
    }
}

private struct AdminAvailabilityView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var mode = "availability"
    @State private var range = "upcoming"
    @State private var showingCreate = false
    @State private var pendingRemoval: AdminScheduleRemoval?

    private var activeSource: String { mode == "availability" ? "availability" : "blackouts" }
    private var activeSourceIsCurrent: Bool {
        admin.loadedSources.contains(activeSource)
            && !admin.refreshUnavailableSources.contains(activeSource)
    }
    private var timetableIsCurrent: Bool {
        admin.loadedSources.contains("full timetable")
            && !admin.refreshUnavailableSources.contains("full timetable")
    }
    private var activeMutationAllowed: Bool {
        activeSourceIsCurrent && (mode == "availability" || timetableIsCurrent)
    }
    private var visibleAvailability: [AdminAvailabilityBlock] {
        range == "all" ? admin.availabilityBlocks : admin.availabilityBlocks.filter { $0.end_time >= Date() }
    }
    private var visibleBlackouts: [AdminBlackoutPeriod] {
        range == "all" ? admin.blackoutPeriods : admin.blackoutPeriods.filter { $0.end_time >= Date() }
    }

    var body: some View {
        List {
            Section {
                Picker("Schedule controls", selection: $mode) {
                    Text("Availability").tag("availability")
                    Text("Blackouts").tag("blackouts")
                }
                .pickerStyle(.segmented)
                Picker("Schedule range", selection: $range) {
                    Text("Upcoming").tag("upcoming")
                    Text("All records").tag("all")
                }
                .pickerStyle(.segmented)
            }
            .listRowBackground(Color.xertNavy)

            if let warning = admin.scheduleMutationWarning {
                Label(
                    warning,
                    systemImage: admin.scheduleMutationIsWarning
                        ? "checkmark.shield.fill"
                        : "checkmark.circle.fill"
                )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(admin.scheduleMutationIsWarning ? Color.orange : Color.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .listRowBackground(Color.xertInk)
            }

            if admin.isRefreshingScheduleControls && !admin.loadedSources.contains(activeSource) {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading \(activeSource)...")
                }
                .frame(minHeight: 44)
                .listRowBackground(Color.xertInk)
            } else if !activeSourceIsCurrent {
                scheduleUnavailableRow
            } else if mode == "blackouts" && !timetableIsCurrent {
                Label(
                    "The timetable is not current. Blackouts are read-only until class conflicts can be checked safely.",
                    systemImage: "calendar.badge.exclamationmark"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                .listRowBackground(Color.xertInk)
            }

            if mode == "availability" {
                if activeSourceIsCurrent && visibleAvailability.isEmpty {
                    Text(range == "upcoming" ? "No upcoming availability blocks." : "No availability blocks set.")
                        .listRowBackground(Color.xertInk)
                }
                ForEach(visibleAvailability) { block in
                    scheduleRow(
                        title: block.type,
                        detail: scheduleRange(block.start_time, block.end_time),
                        note: [block.coach_name, block.notes].compactMap { $0 }.joined(separator: " · "),
                        accent: block.is_bookable ? .green : Color.xertSteel,
                        badge: block.is_bookable ? "BOOKABLE" : "PLANNING",
                        mutationAllowed: activeSourceIsCurrent
                    ) {
                        AdminAvailabilityEditor(
                            admin: admin,
                            session: session,
                            block: block,
                            mutationAllowed: activeSourceIsCurrent
                        )
                    } remove: { pendingRemoval = .availability(block) }
                }
            } else {
                if activeSourceIsCurrent && visibleBlackouts.isEmpty {
                    Text(range == "upcoming" ? "No upcoming blackout periods." : "No blackout periods set.")
                        .listRowBackground(Color.xertInk)
                }
                ForEach(visibleBlackouts) { period in
                    scheduleRow(
                        title: period.reason.capitalized,
                        detail: scheduleRange(period.start_time, period.end_time),
                        note: "Affects \(period.affects.replacingOccurrences(of: "_", with: " "))" + (period.notes.map { " · \($0)" } ?? ""),
                        accent: .red,
                        badge: "CLOSED",
                        mutationAllowed: activeMutationAllowed
                    ) {
                        AdminBlackoutEditor(
                            admin: admin,
                            session: session,
                            period: period,
                            mutationAllowed: activeMutationAllowed
                        )
                    } remove: { pendingRemoval = .blackout(period) }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Schedule Controls")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingCreate = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel(mode == "availability" ? "Add availability" : "Add blackout")
                    .disabled(!activeMutationAllowed)
            }
        }
        .refreshable { await admin.refreshScheduleControls(session: session) }
        .task {
            if !admin.loadedSources.contains("availability")
                || !admin.loadedSources.contains("blackouts")
                || !admin.loadedSources.contains("full timetable") {
                await admin.refreshScheduleControls(session: session)
            }
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack {
                if mode == "availability" {
                    AdminAvailabilityEditor(
                        admin: admin,
                        session: session,
                        block: nil,
                        mutationAllowed: activeSourceIsCurrent
                    )
                } else {
                    AdminBlackoutEditor(
                        admin: admin,
                        session: session,
                        period: nil,
                        mutationAllowed: activeMutationAllowed
                    )
                }
            }
        }
        .confirmationDialog(
            "Remove schedule control?",
            isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
            presenting: pendingRemoval
        ) { removal in
            Button("Remove", role: .destructive) {
                Task {
                    let succeeded: Bool
                    switch removal {
                    case .availability(let block):
                        succeeded = await admin.deleteAvailability(session: session, block: block)
                    case .blackout(let period):
                        succeeded = await admin.deleteBlackout(session: session, period: period)
                    }
                    XertHaptics.play(
                        !succeeded
                            ? .error
                            : (admin.scheduleMutationIsWarning ? .warning : .success)
                    )
                    pendingRemoval = nil
                }
            }
            .disabled(!removalMutationAllowed(removal))
            Button("Keep", role: .cancel) { pendingRemoval = nil }
        } message: { removal in
            switch removal {
            case .availability: Text("This time will no longer appear available for planning.")
            case .blackout: Text("Classes and staff planning may immediately become available during this period.")
            }
        }
    }

    private func removalMutationAllowed(_ removal: AdminScheduleRemoval) -> Bool {
        switch removal {
        case .availability:
            return admin.loadedSources.contains("availability")
                && !admin.refreshUnavailableSources.contains("availability")
        case .blackout:
            return admin.loadedSources.contains("blackouts")
                && !admin.refreshUnavailableSources.contains("blackouts")
                && timetableIsCurrent
        }
    }

    private var scheduleUnavailableRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                admin.loadedSources.contains(activeSource)
                    ? "Showing the last \(activeSource) snapshot. Changes are paused until refresh succeeds."
                    : "\(activeSource.capitalized) could not be loaded. No empty-state assumption is being made.",
                systemImage: "wifi.exclamationmark"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.orange)
            .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await admin.refreshScheduleControls(session: session) }
            } label: {
                Label(
                    admin.isRefreshingScheduleControls ? "Retrying..." : "Retry schedule controls",
                    systemImage: "arrow.clockwise"
                )
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.orange)
            .disabled(admin.isRefreshingScheduleControls)
        }
        .listRowBackground(Color.xertInk)
    }

    private func scheduleRange(_ start: Date, _ end: Date) -> String {
        "\(start.formatted(date: .abbreviated, time: .shortened)) – \(end.formatted(date: .abbreviated, time: .shortened))"
    }

    private func scheduleRow<Destination: View>(
        title: String, detail: String, note: String, accent: Color, badge: String,
        mutationAllowed: Bool,
        @ViewBuilder destination: () -> Destination, remove: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink(destination: destination()) {
                VStack(alignment: .leading, spacing: 4) {
                    ViewThatFits(in: .horizontal) {
                        HStack {
                            Text(title).font(.headline)
                            Spacer()
                            Text(badge).font(.caption2.weight(.bold)).foregroundStyle(accent)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title).font(.headline)
                            Text(badge).font(.caption2.weight(.bold)).foregroundStyle(accent)
                        }
                    }
                    Text(detail).font(.caption).foregroundStyle(Color.xertPale.opacity(0.65))
                    if !note.isEmpty { Text(note).font(.caption2).foregroundStyle(Color.xertPale.opacity(0.45)) }
                }
            }
            HStack {
                Spacer()
                Button(role: .destructive, action: remove) { Image(systemName: "trash") }
                    .buttonStyle(.plain)
                    .disabled(!mutationAllowed || admin.deletingScheduleWindowID != nil)
                    .accessibilityLabel("Remove \(title)")
            }
        }
        .foregroundStyle(Color.xertOffWhite)
        .padding(.vertical, 5)
        .listRowBackground(Color.xertInk)
    }
}

private struct AdminAvailabilityEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.adminEditorExitCoordinator) private var editorExitCoordinator
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let block: AdminAvailabilityBlock?
    let mutationAllowed: Bool
    private let baseline: AdminAvailabilityDraft
    private let baselineToken: String?
    @State private var draft: AdminAvailabilityDraft
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var textInputFocused: Bool

    private var isDirty: Bool { draft != baseline }
    private var isBusy: Bool { admin.savingScheduleWindowID != nil }
    private var editorTitle: String { block == nil ? "new availability" : "availability changes" }

    init(
        admin: AdminStore,
        session: AuthSession,
        block: AdminAvailabilityBlock?,
        mutationAllowed: Bool
    ) {
        let baseline = AdminAvailabilityDraft(block: block)
        let baselineToken = AdminCatalogueDraftStore.baselineToken(for: block)
        let recovered: AdminCatalogueDraftSnapshot<AdminAvailabilityDraft>? = AdminCatalogueDraftStore.load(
            kind: .availability,
            ownerID: session.user?.id,
            recordID: block?.id,
            baselineToken: baselineToken
        )
        let initial = recovered?.draft ?? baseline
        self.admin = admin
        self.session = session
        self.block = block
        self.mutationAllowed = mutationAllowed
        self.baseline = baseline
        self.baselineToken = baselineToken
        _draft = State(initialValue: initial)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    var body: some View {
        Form {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Section {
                    Label(
                        "This availability snapshot is not current. Refresh Schedule Controls before making changes.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                }
            }
            Section("Availability") {
                Picker("Type", selection: $draft.type) { ForEach(AdminAvailabilityDraft.types, id: \.self) { Text($0.capitalized).tag($0) } }
                DatePicker("Starts", selection: $draft.startTime)
                DatePicker("Ends", selection: $draft.endTime, in: draft.startTime...)
                TextField("Coach (optional)", text: $draft.coachName)
                    .focused($textInputFocused)
                Toggle("Bookable", isOn: $draft.isBookable)
                TextField("Notes", text: $draft.notes, axis: .vertical)
                    .lineLimit(2...5)
                    .focused($textInputFocused)
            }
            .disabled(!mutationAllowed)
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle(block == nil ? "New Availability" : "Edit Availability")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            availabilitySaveBar
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: requestDismiss) {
                    Image(systemName: block == nil ? "xmark" : "chevron.left")
                        .frame(width: 44, height: 44)
                }
                .disabled(isBusy)
                .accessibilityLabel(block == nil ? "Cancel" : "Back")
                .accessibilityHint(isDirty ? "Asks before discarding unsaved availability changes" : "Returns to Schedule Controls")
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { textInputFocused = false }
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: editorTitle,
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
        .confirmationDialog(
            "Discard unsaved availability changes?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive) {
                clearRecoveryDraft()
                editorExitCoordinator?.clear(id: exitStateID)
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("This availability draft has not been saved.")
        }
    }

    private var availabilitySaveBar: some View {
        Button {
            textInputFocused = false
            Task {
                if await admin.saveAvailability(session: session, block: block, draft: draft) {
                    hasCommitted = true
                    clearRecoveryDraft()
                    editorExitCoordinator?.clear(id: exitStateID)
                    XertHaptics.play(admin.scheduleMutationIsWarning ? .warning : .success)
                    dismiss()
                } else {
                    XertHaptics.play(.error)
                }
            }
        } label: {
            HStack(spacing: 10) {
                if isBusy { ProgressView().tint(Color.xertNavy) }
                Text(block == nil ? "Create availability" : "Save availability")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.availabilityEditor.save")
        .accessibilityHint(isDirty ? "Saves this availability window" : "Make a change before saving")
    }

    private var canSave: Bool {
        mutationAllowed && !isBusy && isDirty
    }

    private func requestDismiss() {
        textInputFocused = false
        guard !isBusy else { return }
        if isDirty {
            confirmingDiscard = true
        } else {
            clearRecoveryDraft()
            editorExitCoordinator?.clear(id: exitStateID)
            dismiss()
        }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isBusy else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .availability,
            ownerID: session.user?.id,
            recordID: block?.id,
            baselineToken: baselineToken
        )
    }

    private func discardRecoveredEdits() {
        draft = baseline
        recoveredAt = nil
        clearRecoveryDraft()
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .availability,
            ownerID: session.user?.id,
            recordID: block?.id
        )
    }
}

private struct AdminBlackoutEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.adminEditorExitCoordinator) private var editorExitCoordinator
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let period: AdminBlackoutPeriod?
    let mutationAllowed: Bool
    private let baseline: AdminBlackoutDraft
    private let baselineToken: String?
    @State private var draft: AdminBlackoutDraft
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var textInputFocused: Bool

    private var isDirty: Bool { draft != baseline }
    private var isBusy: Bool { admin.savingScheduleWindowID != nil }
    private var editorTitle: String { period == nil ? "new blackout" : "blackout changes" }

    init(
        admin: AdminStore,
        session: AuthSession,
        period: AdminBlackoutPeriod?,
        mutationAllowed: Bool
    ) {
        let baseline = AdminBlackoutDraft(period: period)
        let baselineToken = AdminCatalogueDraftStore.baselineToken(for: period)
        let recovered: AdminCatalogueDraftSnapshot<AdminBlackoutDraft>? = AdminCatalogueDraftStore.load(
            kind: .blackout,
            ownerID: session.user?.id,
            recordID: period?.id,
            baselineToken: baselineToken
        )
        let initial = recovered?.draft ?? baseline
        self.admin = admin
        self.session = session
        self.period = period
        self.mutationAllowed = mutationAllowed
        self.baseline = baseline
        self.baselineToken = baselineToken
        _draft = State(initialValue: initial)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    private var conflicts: [AdminClassSession] {
        draft.overlappingPublishedClasses(in: admin.classSessions)
    }

    var body: some View {
        Form {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Section {
                    Label(
                        "Current blackout and timetable data are required before this closure can be changed.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                }
            }
            Section("Blackout") {
                Picker("Reason", selection: $draft.reason) { ForEach(AdminBlackoutDraft.reasons, id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Affects", selection: $draft.affects) { ForEach(AdminBlackoutDraft.scopes, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) } }
                DatePicker("Starts", selection: $draft.startTime)
                DatePicker("Ends", selection: $draft.endTime, in: draft.startTime...)
                TextField("Notes", text: $draft.notes, axis: .vertical)
                    .lineLimit(2...5)
                    .focused($textInputFocused)
            }
            .disabled(!mutationAllowed)
            if !conflicts.isEmpty {
                Section("Classes blocking this blackout") {
                    Label(
                        "\(conflicts.count) published class\(conflicts.count == 1 ? "" : "es") must be rescheduled or cancelled first.",
                        systemImage: "calendar.badge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    Text("Open a class below to reschedule it, or cancel it from Class Calendar.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.62))
                    ForEach(conflicts) { classSession in
                        NavigationLink {
                            AdminClassEditor(
                                admin: admin,
                                session: session,
                                classSession: classSession,
                                mutationAllowed: mutationAllowed
                            )
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(classSession.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(classSession.start_time?.formatted(date: .abbreviated, time: .shortened) ?? "Time unavailable")
                                    .font(.caption)
                                    .foregroundStyle(Color.xertPale.opacity(0.6))
                            }
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle(period == nil ? "New Blackout" : "Edit Blackout")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            blackoutSaveBar
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: requestDismiss) {
                    Image(systemName: period == nil ? "xmark" : "chevron.left")
                        .frame(width: 44, height: 44)
                }
                .disabled(isBusy)
                .accessibilityLabel(period == nil ? "Cancel" : "Back")
                .accessibilityHint(isDirty ? "Asks before discarding unsaved blackout changes" : "Returns to Schedule Controls")
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { textInputFocused = false }
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: editorTitle,
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
        .confirmationDialog(
            "Discard unsaved blackout changes?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive) {
                clearRecoveryDraft()
                editorExitCoordinator?.clear(id: exitStateID)
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("This blackout draft has not been saved.")
        }
    }

    private var blackoutSaveBar: some View {
        Button {
            textInputFocused = false
            Task {
                if await admin.saveBlackout(session: session, period: period, draft: draft) {
                    hasCommitted = true
                    clearRecoveryDraft()
                    editorExitCoordinator?.clear(id: exitStateID)
                    XertHaptics.play(admin.scheduleMutationIsWarning ? .warning : .success)
                    dismiss()
                } else {
                    XertHaptics.play(.error)
                }
            }
        } label: {
            HStack(spacing: 10) {
                if isBusy { ProgressView().tint(Color.xertNavy) }
                Text(period == nil ? "Create blackout" : "Save blackout")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.blackoutEditor.save")
        .accessibilityHint(
            !conflicts.isEmpty
                ? "Resolve published class conflicts before saving"
                : isDirty ? "Saves this blackout period" : "Make a change before saving"
        )
    }

    private var canSave: Bool {
        mutationAllowed && conflicts.isEmpty && !isBusy && isDirty
    }

    private func requestDismiss() {
        textInputFocused = false
        guard !isBusy else { return }
        if isDirty {
            confirmingDiscard = true
        } else {
            clearRecoveryDraft()
            editorExitCoordinator?.clear(id: exitStateID)
            dismiss()
        }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isBusy else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .blackout,
            ownerID: session.user?.id,
            recordID: period?.id,
            baselineToken: baselineToken
        )
    }

    private func discardRecoveredEdits() {
        draft = baseline
        recoveredAt = nil
        clearRecoveryDraft()
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .blackout,
            ownerID: session.user?.id,
            recordID: period?.id
        )
    }
}

private struct AdminRetentionView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var selected: AdminFollowUp?
    @State private var selectedActivation: AdminMemberActivationItem?
    @State private var presentedMember: AdminMemberSummary?
    @State private var openingMemberID: UUID?

    var body: some View {
        List {
            Section("Activation actions") {
                if admin.refreshUnavailableSources.contains("activation actions") {
                    Label("Showing the last activation snapshot. Outreach is disabled until you pull down to refresh.", systemImage: "wifi.exclamationmark")
                        .foregroundStyle(Color.orange)
                        .listRowBackground(Color.xertInk)
                } else if admin.activationQueue.isEmpty {
                    Text("No activation follow-ups are due.")
                        .listRowBackground(Color.xertInk)
                }
                ForEach(admin.activationQueue) { member in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.displayName).font(.headline)
                                Text(member.reasonLabel).font(.caption).foregroundStyle(Color.xertSteel)
                            }
                            Spacer()
                            Text("\(member.credits_remaining) credits")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.xertPale.opacity(0.6))
                        }
                        ViewThatFits(in: .horizontal) {
                            HStack {
                                activationActions(
                                    for: member,
                                    expands: false,
                                    allowsOutreach: !admin.refreshUnavailableSources.contains("activation actions")
                                )
                            }
                            VStack(spacing: 8) {
                                activationActions(
                                    for: member,
                                    expands: true,
                                    allowsOutreach: !admin.refreshUnavailableSources.contains("activation actions")
                                )
                            }
                        }
                        .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(Color.xertOffWhite)
                    .padding(.vertical, 6)
                    .listRowBackground(Color.xertInk)
                }
            }

            Section("Retention actions") {
            if admin.followUps.isEmpty {
                Text("The retention queue is caught up.")
                    .listRowBackground(Color.xertInk)
            }
            ForEach(admin.followUps) { member in
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.displayName).font(.headline)
                            Text(member.reasonLabel).font(.caption).foregroundStyle(Color.xertSteel)
                        }
                        Spacer()
                        Text("P\(member.priority)").font(.caption2.weight(.bold)).foregroundStyle(.orange)
                    }
                    Text("\(member.credits_remaining) credits · \(member.bookings_count) bookings")
                        .font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                    ViewThatFits(in: .horizontal) {
                        HStack {
                            retentionActions(for: member, expands: false)
                        }
                        VStack(spacing: 8) {
                            retentionActions(for: member, expands: true)
                        }
                    }
                    .font(.caption.weight(.bold))
                }
                .foregroundStyle(Color.xertOffWhite)
                .padding(.vertical, 6)
                .listRowBackground(Color.xertInk)
            }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Follow-ups")
        .sheet(item: $presentedMember) { member in
            NavigationStack {
                AdminMemberDetailView(admin: admin, session: session, member: member)
            }
        }
        .confirmationDialog(
            "Log follow-up",
            isPresented: Binding(
                get: { selected != nil },
                set: { if !$0 { selected = nil } }
            ),
            presenting: selected
        ) { member in
            ForEach(["phone", "email", "SMS", "in person"], id: \.self) { channel in
                Button(channel.capitalized) {
                    Task { _ = await admin.logFollowUp(session: session, member: member, channel: channel) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            "Log activation follow-up",
            isPresented: Binding(
                get: { selectedActivation != nil },
                set: { if !$0 { selectedActivation = nil } }
            ),
            presenting: selectedActivation
        ) { member in
            ForEach(["phone", "email", "SMS", "in person"], id: \.self) { channel in
                Button(channel.capitalized) {
                    Task { _ = await admin.logActivationFollowUp(session: session, member: member, channel: channel) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func retentionActions(for member: AdminFollowUp, expands: Bool) -> some View {
        Button { openMemberRecord(member.id) } label: {
            Label(openingMemberID == member.id ? "Opening..." : "Member record", systemImage: "person.text.rectangle")
                .frame(maxWidth: expands ? .infinity : nil)
        }
        .buttonStyle(.bordered)
        .disabled(openingMemberID != nil)
        if let phone = member.phone,
           let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
            Link(destination: url) {
                Label("Call", systemImage: "phone")
                    .frame(maxWidth: expands ? .infinity : nil)
            }
            .buttonStyle(.bordered)
        }
        if let email = member.email, let url = URL(string: "mailto:\(email)") {
            Link(destination: url) {
                Label("Email", systemImage: "envelope")
                    .frame(maxWidth: expands ? .infinity : nil)
            }
            .buttonStyle(.bordered)
        }
        Button { selected = member } label: {
            Label("Log follow-up", systemImage: "checkmark.circle")
                .frame(maxWidth: expands ? .infinity : nil)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.xertSteel)
        .disabled(admin.loggingFollowUpMemberID != nil)
    }

    @ViewBuilder
    private func activationActions(
        for member: AdminMemberActivationItem,
        expands: Bool,
        allowsOutreach: Bool
    ) -> some View {
        Button { openMemberRecord(member.id) } label: {
            Label(openingMemberID == member.id ? "Opening..." : "Member record", systemImage: "person.text.rectangle")
                .frame(maxWidth: expands ? .infinity : nil, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .disabled(openingMemberID != nil)
        if let phone = member.phone,
           let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
            Link(destination: url) {
                Label("Call", systemImage: "phone")
                    .frame(maxWidth: expands ? .infinity : nil, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(!allowsOutreach)
            .accessibilityHint(allowsOutreach ? "Calls this member" : "Refresh activation actions before contacting this member")
        }
        if let email = member.email,
           let encoded = email.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let url = URL(string: "mailto:\(encoded)") {
            Link(destination: url) {
                Label("Email", systemImage: "envelope")
                    .frame(maxWidth: expands ? .infinity : nil, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(!allowsOutreach)
            .accessibilityHint(allowsOutreach ? "Emails this member" : "Refresh activation actions before contacting this member")
        }
        Button { selectedActivation = member } label: {
            Label("Log follow-up", systemImage: "checkmark.circle")
                .frame(maxWidth: expands ? .infinity : nil, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.xertSteel)
        .disabled(admin.loggingFollowUpMemberID != nil || !allowsOutreach)
        .accessibilityHint(allowsOutreach ? "Records completed outreach" : "Refresh activation actions before logging outreach")
    }

    private func openMemberRecord(_ memberID: UUID) {
        guard openingMemberID == nil else { return }
        if let member = admin.members.first(where: { $0.id == memberID }) {
            presentedMember = member
            return
        }
        openingMemberID = memberID
        Task {
            await admin.resolveOwnerTask(session: session, task: .member(memberID))
            if let member = admin.members.first(where: { $0.id == memberID }) {
                presentedMember = member
            }
            openingMemberID = nil
        }
    }
}

private struct AdminFinanceView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let onOpenOrders: () -> Void
    @State private var currency = "AUD"

    private var currencies: [String] {
        let values = Set(admin.orders.map {
            let normalized = $0.currency?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
            return normalized.isEmpty ? "AUD" : normalized
        })
        return values.isEmpty ? ["AUD"] : values.sorted()
    }

    private var report: AdminFinanceReport {
        AdminFinanceReport(orders: admin.orders, currency: currency)
    }

    private var ordersAreCurrent: Bool {
        admin.loadedSources.contains("orders") && !admin.refreshUnavailableSources.contains("orders")
    }

    private var ordersAreLoading: Bool {
        admin.isLoading && !admin.loadedSources.contains("orders")
    }

    private var comparisonLabel: String {
        if report.previousPeriodCents == 0, report.currentPeriodCents > 0 {
            return "New revenue - the previous 30 days had no paid sales"
        }
        guard let change = report.periodChangePercent else {
            return "No paid sales in either 30-day period"
        }
        let direction = change > 0 ? "Up" : change < 0 ? "Down" : "Flat"
        return "\(direction) \(abs(change).formatted(.number.precision(.fractionLength(0))))% vs previous 30 days"
    }

    private var comparisonColour: Color {
        guard let change = report.periodChangePercent else { return Color.xertPale.opacity(0.6) }
        if change > 0 { return Color.green }
        if change < 0 { return Color.orange }
        return Color.xertSteel
    }

    var body: some View {
        List {
            if ordersAreLoading {
                Section {
                    HStack(spacing: 12) {
                        ProgressView().tint(Color.xertSteel)
                        Text("Loading the complete sales ledger...")
                    }
                    .foregroundStyle(Color.xertPale)
                    .listRowBackground(Color.xertInk)
                }
            }

            if !ordersAreCurrent {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(
                            admin.orders.isEmpty ? "Finance data unavailable" : "Last finance snapshot",
                            systemImage: "exclamationmark.arrow.triangle.2.circlepath"
                        )
                        .font(.headline)
                        .foregroundStyle(Color.orange)
                        Text(
                            admin.orders.isEmpty
                                ? "Revenue and sales performance could not be verified. Retry before relying on this workspace."
                                : "The figures below may be stale. Payment actions remain protected in Orders."
                        )
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                        .fixedSize(horizontal: false, vertical: true)
                        Button {
                            Task { await admin.refreshOperationalPulse(session: session) }
                        } label: {
                            Label(
                                admin.isRefreshingOperations ? "Retrying..." : "Retry finance data",
                                systemImage: "arrow.clockwise"
                            )
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.xertSteel)
                        .foregroundStyle(Color.xertNavy)
                        .disabled(admin.isRefreshingOperations)
                    }
                    .listRowBackground(Color.xertInk)
                }
            }

            if ordersAreCurrent || !admin.orders.isEmpty {
                Section {
                    Picker("Reporting currency", selection: $currency) {
                        ForEach(currencies, id: \.self) { code in
                            Text(code).tag(code)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.xertInk)
                } header: {
                    Text("Currency")
                }

                Section(ordersAreCurrent ? "Revenue pulse" : "Last revenue pulse") {
                    FinanceSummaryRow(
                        label: "Last 30 days",
                        cents: report.currentPeriodCents,
                        currency: report.currency
                    )
                    FinanceSummaryRow(
                        label: "Previous 30 days",
                        cents: report.previousPeriodCents,
                        currency: report.currency
                    )
                    FinanceSummaryRow(
                        label: "This calendar month",
                        cents: report.monthRevenueCents,
                        currency: report.currency
                    )
                    FinanceSummaryRow(
                        label: "All paid orders",
                        cents: report.allTimeRevenueCents,
                        currency: report.currency
                    )
                    HStack {
                        Label(comparisonLabel, systemImage: "chart.line.uptrend.xyaxis")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(comparisonColour)
                        Spacer()
                    }
                    .listRowBackground(Color.xertInk)
                }

                Section("30-day sales rhythm") {
                    AdminFinanceTrendChart(days: report.dailyRevenue, currency: report.currency)
                        .listRowBackground(Color.xertInk)
                }

                Section("Sales performance") {
                    financeCount(
                        "Paid orders - 30 days",
                        value: report.currentPaidCount,
                        icon: "checkmark.circle"
                    )
                    FinanceSummaryRow(
                        label: "Average paid sale",
                        cents: report.averageSaleCents,
                        currency: report.currency
                    )
                    financeCount("Pending checkouts", value: report.pendingCount, icon: "clock")
                    financeCount(
                        "Refunded orders",
                        value: report.refundedCount,
                        icon: "arrow.uturn.backward.circle"
                    )
                }

                Section("Top packs - 30 days") {
                    if report.productLeaders.isEmpty {
                        Text("No paid packs in this period.")
                            .foregroundStyle(Color.xertPale.opacity(0.62))
                            .listRowBackground(Color.xertInk)
                    }
                    ForEach(report.productLeaders.prefix(5)) { product in
                        ViewThatFits(in: .horizontal) {
                            HStack {
                                productLeaderIdentity(product)
                                Spacer()
                                productLeaderValue(product)
                            }
                            VStack(alignment: .leading, spacing: 7) {
                                productLeaderIdentity(product)
                                productLeaderValue(product)
                            }
                        }
                        .listRowBackground(Color.xertInk)
                    }
                }

                Section("Order operations") {
                    Button(action: onOpenOrders) {
                        HStack(spacing: 12) {
                            Image(systemName: report.recoverableCount > 0 ? "exclamationmark.arrow.circlepath" : "creditcard")
                                .foregroundStyle(report.recoverableCount > 0 ? Color.orange : Color.xertSteel)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Open orders")
                                    .font(.headline)
                                    .foregroundStyle(Color.xertOffWhite)
                                Text(report.recoverableCount > 0
                                     ? "\(report.recoverableCount) \(report.currency) payment\(report.recoverableCount == 1 ? "" : "s") need recovery"
                                     : "Search sales, reconcile payments and manage refunds")
                                    .font(.caption)
                                    .foregroundStyle(Color.xertPale.opacity(0.65))
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.xertSteel)
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.xertInk)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Finance")
        .refreshable {
            await admin.refreshOperationalPulse(session: session)
        }
        .onChange(of: currencies) { available in
            if !available.contains(currency) {
                currency = available.first ?? "AUD"
            }
        }
    }

    private func financeCount(_ label: String, value: Int, icon: String) -> some View {
        HStack {
            Label(label, systemImage: icon)
            Spacer()
            Text(value.formatted()).fontWeight(.bold)
        }
        .foregroundStyle(Color.xertOffWhite)
        .listRowBackground(Color.xertInk)
    }

    private func productLeaderIdentity(_ product: AdminFinanceProductPerformance) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(product.name)
                .font(.headline)
                .foregroundStyle(Color.xertOffWhite)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(product.sales) sale\(product.sales == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.58))
        }
    }

    private func productLeaderValue(_ product: AdminFinanceProductPerformance) -> some View {
        Text((Double(product.cents) / 100).formatted(.currency(code: report.currency)))
            .font(.subheadline.weight(.bold).monospacedDigit())
            .foregroundStyle(Color.xertSteel)
    }
}

private struct AdminFinanceTrendChart: View {
    let days: [AdminFinanceDay]
    let currency: String

    private var maximumCents: Int {
        max(days.map(\.cents).max() ?? 0, 1)
    }

    private var totalCents: Int {
        days.reduce(0) { $0 + $1.cents }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { proxy in
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(days) { day in
                        Rectangle()
                            .fill(day.cents > 0 ? Color.xertSteel : Color.xertSteel.opacity(0.12))
                            .frame(
                                maxWidth: .infinity,
                                minHeight: day.cents > 0 ? 3 : 1,
                                maxHeight: max(1, proxy.size.height * CGFloat(day.cents) / CGFloat(maximumCents))
                            )
                            .accessibilityHidden(true)
                    }
                }
            }
            .frame(height: 118)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.xertSteel.opacity(0.22)).frame(height: 1)
            }

            HStack {
                Text(days.first?.date.formatted(date: .abbreviated, time: .omitted) ?? "30 days ago")
                Spacer()
                Text(days.last?.date.formatted(date: .abbreviated, time: .omitted) ?? "Today")
            }
            .font(.caption2)
            .foregroundStyle(Color.xertPale.opacity(0.5))

            Text("\((Double(totalCents) / 100).formatted(.currency(code: currency))) paid across \(days.filter { $0.cents > 0 }.count) active sales day\(days.filter { $0.cents > 0 }.count == 1 ? "" : "s").")
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.68))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Thirty day paid revenue trend. \((Double(totalCents) / 100).formatted(.currency(code: currency))) total."
        )
    }
}

private struct AdminOrdersView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let onOpenTask: (XertOwnerTask) -> Void
    @State private var query = ""
    @State private var status = "all"
    @State private var currency = "all"
    @State private var range = AdminOrderRange.thirtyDays
    @State private var exportDocument: AdminOrderCSVDocument?
    @State private var isExporting = false

    private var report: AdminOrderReport {
        AdminOrderReport(
            orders: admin.orders,
            query: query,
            status: status,
            currency: currency,
            range: range
        )
    }

    private var currencies: [String] {
        Set(admin.orders.map {
            let code = $0.currency?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
            return code.isEmpty ? "AUD" : code
        }).sorted()
    }

    private var ordersAreCurrent: Bool {
        admin.loadedSources.contains("orders") && !admin.refreshUnavailableSources.contains("orders")
    }

    private var ordersAreLoading: Bool {
        admin.isLoading && !admin.loadedSources.contains("orders")
    }

    private var exportDateStamp: String {
        String(ISO8601DateFormatter().string(from: Date()).prefix(10))
    }

    var body: some View {
        List {
            Section("Report controls") {
                Picker("Reporting range", selection: $range) {
                    ForEach(AdminOrderRange.allCases) { option in
                        Text(option.rawValue).tag(option)
                    }
                }
                .pickerStyle(.segmented)

                Picker("Order status", selection: $status) {
                    Text("All").tag("all")
                    Text("Paid").tag("paid")
                    Text("Pending").tag("pending")
                    Text("Failed").tag("failed")
                    Text("Refunded").tag("refunded")
                }
                .pickerStyle(.menu)
                .tint(Color.xertSteel)

                if currencies.count > 1 {
                    Picker("Currency", selection: $currency) {
                        Text("All currencies").tag("all")
                        ForEach(currencies, id: \.self) { code in
                            Text(code).tag(code.lowercased())
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(Color.xertSteel)
                }
            }
            .listRowBackground(Color.xertInk)

            if ordersAreLoading {
                Section {
                    HStack(spacing: 10) {
                        ProgressView().tint(Color.xertSteel)
                        Text("Loading complete order ledger...")
                            .foregroundStyle(Color.xertPale.opacity(0.68))
                    }
                    .frame(minHeight: 44)
                }
                .listRowBackground(Color.xertInk)
            } else {
                if !ordersAreCurrent {
                    Section {
                        Label(
                            admin.orders.isEmpty
                                ? "Orders are unavailable. Refresh before relying on revenue or payment state."
                                : "Showing the last order snapshot. Refresh before exporting or changing a payment.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .listRowBackground(Color.xertInk)
                }

                if ordersAreCurrent || !admin.orders.isEmpty {
                    Section(ordersAreCurrent ? "Revenue snapshot" : "Last revenue snapshot") {
                        LabeledContent("Matching orders", value: report.rows.count.formatted())
                        LabeledContent("Paid orders", value: report.paidCount.formatted())
                        if report.paidRevenue.isEmpty {
                            LabeledContent("Paid revenue", value: "None")
                        } else {
                            ForEach(report.paidRevenue) { total in
                                LabeledContent(
                                    report.paidRevenue.count == 1 ? "Paid revenue" : "\(total.currency) paid revenue",
                                    value: total.displayAmount
                                )
                            }
                        }
                    }
                    .listRowBackground(Color.xertInk)
                }

                Section("Order operations") {
                    if report.rows.isEmpty {
                        AdminEmptyState(
                            icon: "creditcard",
                            text: admin.orders.isEmpty ? "No orders yet." : "No orders match these controls."
                        )
                        .listRowBackground(Color.xertInk)
                    }
                    ForEach(report.rows) { order in
                        Button { onOpenTask(.order(order.id)) } label: {
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 12) {
                                    orderIdentity(order)
                                    Spacer(minLength: 8)
                                    orderValue(order, includesChevron: true)
                                }
                                VStack(alignment: .leading, spacing: 8) {
                                    orderIdentity(order)
                                    HStack {
                                        orderValue(order, includesChevron: false)
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(Color.xertSteel)
                                    }
                                }
                            }
                            .padding(.vertical, 3)
                        }
                        .foregroundStyle(Color.xertOffWhite)
                        .buttonStyle(.plain)
                        .disabled(!ordersAreCurrent)
                        .accessibilityHint("Opens protected payment recovery, reconciliation and refund operations")
                        .listRowBackground(Color.xertInk)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Orders")
        .searchable(text: $query, prompt: "Email, pack or Stripe ID")
        .refreshable { await admin.refresh(session: session) }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    exportDocument = AdminOrderCSVDocument(csv: report.csv)
                    isExporting = true
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(report.rows.isEmpty || !ordersAreCurrent)
                .accessibilityLabel("Export filtered order ledger CSV")
                .accessibilityHint(
                    ordersAreCurrent
                        ? "Exports the current filtered payment ledger"
                        : "Refresh orders before exporting"
                )
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "xert-orders-\(exportDateStamp)"
        ) { result in
            if case .failure(let error) = result { admin.errorMessage = error.localizedDescription }
        }
        .onChange(of: currencies) { available in
            let normalized = Set(available.map { $0.lowercased() })
            if currency != "all" && !normalized.contains(currency) {
                currency = "all"
            }
        }
    }

    private func orderIdentity(_ order: OrderItem) -> some View {
        HStack(spacing: 10) {
            Image(systemName: order.isRecoverable ? "exclamationmark.arrow.circlepath" : "creditcard")
                .foregroundStyle(order.isRecoverable ? Color.orange : Color.xertSteel)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(order.products?.name ?? "Session pack").font(.headline)
                Text((order.email?.isEmpty == false ? order.email : nil) ?? "Anonymized buyer")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.65))
                    .lineLimit(1)
                Text(order.activityDate.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.55))
            }
        }
    }

    private func orderValue(_ order: OrderItem, includesChevron: Bool) -> some View {
        HStack(spacing: 9) {
            VStack(alignment: .trailing, spacing: 3) {
                Text(order.displayAmount).font(.subheadline.weight(.bold).monospacedDigit())
                Text(order.displayStatus.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(financeStatusColour(order.status))
            }
            if includesChevron {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.xertSteel)
            }
        }
    }

    private func financeStatusColour(_ value: String) -> Color {
        switch value {
        case "paid": return .green
        case "refunded": return Color.xertPale.opacity(0.55)
        case "failed": return .red
        default: return .orange
        }
    }
}

private struct AdminOrderCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    let csv: String

    init(csv: String) { self.csv = csv }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        csv = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(csv.utf8))
    }
}

private struct AdminOrderDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let order: OrderItem
    @State private var refundReason = "requested_by_customer"
    @State private var refundConfirmation = ""
    @State private var confirmingReconciliation = false
    @State private var resultMessage: String?

    private var isOperating: Bool { admin.operatingOrderID == order.id }
    private var orderLedgerIsCurrent: Bool {
        admin.loadedSources.contains("orders")
            && !admin.refreshUnavailableSources.contains("orders")
            && !admin.isLoading
    }

    var body: some View {
        List {
            if let operationStatus = admin.orderOperationStatusMessage {
                Section {
                    Label(
                        operationStatus,
                        systemImage: admin.orderOperationStatusIsWarning
                            ? "exclamationmark.triangle.fill"
                            : "checkmark.shield.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(admin.orderOperationStatusIsWarning ? Color.orange : Color.green)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .listRowBackground(Color.xertInk)
            }

            if !orderLedgerIsCurrent && admin.orderOperationStatusMessage == nil {
                Section {
                    Label(
                        "The order ledger is no longer current. Close this record and refresh Orders before moving money or granting credits.",
                        systemImage: "lock.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .listRowBackground(Color.xertInk)
                .accessibilityIdentifier("owner.order.staleGuard")
            }

            Section("Order") {
                orderValue("Product", order.products?.name ?? "Session pack")
                orderValue("Buyer", (order.email?.isEmpty == false ? order.email : nil) ?? "Anonymized buyer")
                orderValue("Amount", order.displayAmount)
                orderValue("Status", order.displayStatus)
                orderValue("Purchased terms", order.purchasedTerms)
                orderValue("Created", order.created_at.formatted(date: .abbreviated, time: .shortened))
                if let paidAt = order.paid_at { orderValue("Paid", paidAt.formatted(date: .abbreviated, time: .shortened)) }
                identifier("XERT order", order.id.uuidString)
                identifier("Stripe checkout", order.stripe_checkout_session_id)
                identifier("Payment intent", order.stripe_payment_intent_id)
                if let reconciledAt = order.reconciled_at {
                    orderValue("Reconciled", reconciledAt.formatted(date: .abbreviated, time: .shortened))
                    identifier("Reconciled by", order.reconciled_by?.uuidString)
                }
            }

            if order.isRecoverable {
                Section("Payment recovery") {
                    Text("Ask Stripe for the canonical outcome. XERT grants credits only for an exact paid match, or safely closes an expired unpaid checkout.")
                        .font(.subheadline).foregroundStyle(Color.xertPale.opacity(0.7))
                    Button { confirmingReconciliation = true } label: {
                        Label(isOperating ? "Checking Stripe..." : "Check Stripe outcome", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(isOperating || !orderLedgerIsCurrent)
                }
            }

            if order.status == "refunded" {
                Section("Refund reconciliation") {
                    orderValue("Refunded", order.refundedAmount ?? order.displayAmount)
                    if let refund = order.refund {
                        orderValue("Unused credits revoked", refund.credits_revoked.formatted())
                        orderValue("Credits already consumed", refund.credits_consumed.formatted())
                        orderValue("Future bookings cancelled", refund.bookings_cancelled.formatted())
                        identifier("Stripe refund", refund.refund_id)
                    }
                }
            }

            if order.isRefundable {
                Section("Full refund") {
                    Text("This sends the full payment back through Stripe, revokes unused credits, and cancels future bookings funded by this order.")
                        .font(.subheadline).foregroundStyle(Color.xertPale.opacity(0.7))
                    Picker("Reason", selection: $refundReason) {
                        Text("Requested by customer").tag("requested_by_customer")
                        Text("Duplicate payment").tag("duplicate")
                    }
                    TextField("Type REFUND to confirm", text: $refundConfirmation)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button(role: .destructive) {
                        Task {
                            if let result = await admin.refundOrder(
                                session: session,
                                order: order,
                                reason: refundReason,
                                confirmation: refundConfirmation
                            ) {
                                let outcome = result.recovered == true ? "Stripe refund recovered and reconciled." : "Refund complete."
                                resultMessage = [
                                    "\(outcome) \(result.credits_revoked) unused credits revoked, \(result.credits_consumed) already consumed, and \(result.bookings_cancelled) future bookings cancelled.",
                                    admin.orderOperationStatusIsWarning ? admin.orderOperationStatusMessage : nil
                                ]
                                .compactMap { $0 }
                                .joined(separator: " ")
                            }
                        }
                    } label: {
                        Label(isOperating ? "Refunding..." : "Refund \(order.displayAmount)", systemImage: "arrow.uturn.backward.circle")
                    }
                    .disabled(isOperating || !orderLedgerIsCurrent || refundConfirmation != "REFUND")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Order detail")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(isOperating) } }
        .confirmationDialog("Check this payment with Stripe?", isPresented: $confirmingReconciliation, titleVisibility: .visible) {
            Button("Check and reconcile") {
                Task {
                    if let result = await admin.reconcileOrder(session: session, order: order) {
                        let outcome = result.status == "failed" && result.checkout_status == "expired"
                            ? "Stripe confirms no payment was taken. The expired checkout is closed without granting credits."
                            : result.already_paid
                            ? "Fulfilment verified. \(result.credits_granted) session credits are attached to this order."
                            : "Payment reconciled. \(result.credits_granted) session credits were granted."
                        resultMessage = [
                            outcome,
                            admin.orderOperationStatusIsWarning ? admin.orderOperationStatusMessage : nil
                        ]
                        .compactMap { $0 }
                        .joined(separator: " ")
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("No credits are granted unless Stripe and the XERT order match exactly.")
        }
        .alert("Order updated", isPresented: Binding(
            get: { resultMessage != nil },
            set: { if !$0 { resultMessage = nil; dismiss() } }
        )) {
            Button("Done") { resultMessage = nil; dismiss() }
        } message: { Text(resultMessage ?? "") }
    }

    @ViewBuilder
    private func orderValue(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(Color.xertPale.opacity(0.6))
            Spacer()
            Text(value).multilineTextAlignment(.trailing).foregroundStyle(Color.xertOffWhite)
        }
        .listRowBackground(Color.xertInk)
    }

    @ViewBuilder
    private func identifier(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.caption).foregroundStyle(Color.xertPale.opacity(0.55))
                Text(value).font(.caption.monospaced()).textSelection(.enabled).foregroundStyle(Color.xertOffWhite)
            }
            .listRowBackground(Color.xertInk)
        }
    }
}

private struct AdminBookingRequestsView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var query = ""
    @State private var status = "all"
    @State private var source = "all"
    @State private var days = "30"
    @State private var selectedRequest: AdminBookingRequest?
    @State private var selectedIDs: Set<String> = []
    @State private var bulkStatus = ""
    @State private var confirmingBulk = false
    @State private var exportDocument: AdminIntakeCSVDocument?
    @State private var isExporting = false
    @State private var exportError: String?

    private let statuses = ["requested", "confirmed", "waitlisted", "cancelled", "declined", "attended", "no_show"]
    private var requestsAreCurrent: Bool { admin.bookingRequestsAreCurrent }
    private var requestsAreLoading: Bool {
        admin.isLoadingBookingRequests && !admin.hasLoadedBookingRequests
    }

    private var filteredRequests: [AdminBookingRequest] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let cutoff: Date? = days == "all" ? nil : Calendar.current.date(byAdding: .day, value: -(Int(days) ?? 30), to: Date())
        return admin.bookingRequests.filter { booking in
            let withinWindow = cutoff.map { booking.createdAt >= $0 } ?? true
            return (status == "all" || booking.status == status)
                && (source == "all" || booking.source.rawValue == source)
                && withinWindow
                && (needle.isEmpty || booking.searchableText.contains(needle))
        }
    }

    private var selectedRequests: [AdminBookingRequest] {
        admin.bookingRequests.filter { selectedIDs.contains($0.id) }
    }

    private var bulkOptions: [String] {
        let selected = selectedRequests
        guard let first = selected.first, selected.allSatisfy({ $0.status == first.status }) else { return [] }
        return first.allowedNextStatuses
    }
    private var exportDateStamp: String {
        String(ISO8601DateFormatter().string(from: Date()).prefix(10))
    }

    var body: some View {
        List {
            if let message = admin.bookingRequestStatusMessage {
                Label(message, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .listRowBackground(Color.xertInk)
            }
            if admin.bookingDecisionStatusSessionID == nil,
               let warning = admin.bookingDecisionNoticeWarning {
                Section("Member notification") {
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .listRowBackground(Color.xertInk)
                }
            }
            Section("Queue filters") {
                Picker("Status", selection: $status) {
                    Text("All statuses").tag("all")
                    ForEach(statuses, id: \.self) { Text(statusLabel($0)).tag($0) }
                }
                Picker("Source", selection: $source) {
                    Text("All sources").tag("all")
                    Text("Member credit").tag("member")
                    Text("Enquiry form").tag("enquiry")
                }
                .pickerStyle(.segmented)
                Picker("Age", selection: $days) {
                    Text("30 days").tag("30")
                    Text("90 days").tag("90")
                    Text("All time").tag("all")
                }
                .pickerStyle(.segmented)
            }
            .listRowBackground(Color.xertInk)

            if !requestsAreCurrent && !requestsAreLoading {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        admin.hasLoadedBookingRequests
                            ? "Showing the last booking-request snapshot. Decisions are paused until refresh succeeds."
                            : "Booking requests could not be loaded. No empty queue assumption is being made.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await admin.loadBookingRequests(session: session, force: true) }
                    } label: {
                        Label(
                            admin.isLoadingBookingRequests ? "Retrying..." : "Retry booking requests",
                            systemImage: "arrow.clockwise"
                        )
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(admin.isLoadingBookingRequests)
                }
                .listRowBackground(Color.xertInk)
            }

            if admin.hasLoadedBookingRequests {
                Section(requestsAreCurrent ? "Matching workload" : "Last matching workload") {
                    metricRow("Matching", filteredRequests.count)
                    metricRow("Requested", filteredRequests.filter { $0.status == "requested" }.count)
                    metricRow("Confirmed", filteredRequests.filter { $0.status == "confirmed" }.count)
                    metricRow("Attended", filteredRequests.filter { $0.status == "attended" }.count)
                }
            }

            if !selectedIDs.isEmpty {
                Section("Bulk update") {
                    HStack {
                        Text("\(selectedIDs.count) selected")
                        Spacer()
                        Button("Clear") { selectedIDs = []; bulkStatus = "" }
                    }
                    if bulkOptions.isEmpty {
                        Text("Select bookings with the same actionable status to update them together.")
                            .font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                    } else {
                        Picker("Move selected to", selection: $bulkStatus) {
                            Text("Choose status").tag("")
                            ForEach(bulkOptions, id: \.self) { Text(statusLabel($0)).tag($0) }
                        }
                        Button { confirmingBulk = true } label: {
                            Label(admin.updatingBookingRequestIDs.isEmpty ? "Apply booking update" : "Updating bookings...", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .disabled(!requestsAreCurrent || bulkStatus.isEmpty || !admin.updatingBookingRequestIDs.isEmpty)
                    }
                }
                .listRowBackground(Color.xertInk)
            }

            Section("Booking operations") {
                if requestsAreLoading {
                    HStack { ProgressView(); Text("Loading booking requests...") }
                        .listRowBackground(Color.xertInk)
                } else if requestsAreCurrent && filteredRequests.isEmpty {
                    AdminEmptyState(icon: "tray", text: admin.bookingRequests.isEmpty ? "No booking requests yet." : "No matching bookings.")
                        .listRowBackground(Color.xertInk)
                }
                ForEach(filteredRequests) { booking in
                    HStack(spacing: 12) {
                        Button { toggleSelection(booking.id) } label: {
                            Image(systemName: selectedIDs.contains(booking.id) ? "checkmark.circle.fill" : "circle")
                                .font(.title3).foregroundStyle(Color.xertSteel)
                        }
                        .buttonStyle(.plain)
                        .disabled(
                            !requestsAreCurrent
                                || (selectedIDs.count >= 50 && !selectedIDs.contains(booking.id))
                        )
                        .accessibilityLabel(selectedIDs.contains(booking.id) ? "Deselect \(booking.fullName)" : "Select \(booking.fullName)")

                        Button { selectedRequest = booking } label: {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(booking.fullName).font(.headline)
                                    Text(booking.session?.title ?? "Class not linked")
                                        .font(.subheadline).foregroundStyle(Color.xertPale.opacity(0.72))
                                    if let start = booking.session?.start_time {
                                        Text(start.formatted(date: .abbreviated, time: .shortened))
                                            .font(.caption).foregroundStyle(Color.xertPale.opacity(0.52))
                                    }
                                    Text(booking.source.label.uppercased())
                                        .font(.caption2.weight(.bold)).foregroundStyle(Color.xertSteel)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 5) {
                                    Text(statusLabel(booking.status).uppercased())
                                        .font(.caption2.weight(.bold)).foregroundStyle(bookingStatusColour(booking.status))
                                    if booking.creditBatchID != nil {
                                        Label("Reserved", systemImage: "ticket").font(.caption2).foregroundStyle(Color.xertPale.opacity(0.5))
                                    }
                                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Color.xertSteel)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .foregroundStyle(Color.xertOffWhite)
                    .padding(.vertical, 5)
                    .listRowBackground(Color.xertInk)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Class requests")
        .searchable(text: $query, prompt: "Member, contact, class or coach")
        .refreshable { await admin.loadBookingRequests(session: session, force: true) }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    exportDocument = AdminIntakeCSVDocument(
                        csv: AdminBookingRequestReport(rows: filteredRequests).csv
                    )
                    isExporting = true
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(filteredRequests.isEmpty || !requestsAreCurrent)
                .accessibilityLabel("Export filtered booking requests")
                .accessibilityHint(
                    requestsAreCurrent
                        ? "Exports the current filtered booking operations report"
                        : "Refresh booking requests before exporting"
                )
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "xert-bookings-\(exportDateStamp)"
        ) { result in
            if case .failure(let error) = result {
                exportError = error.localizedDescription
            }
            exportDocument = nil
        }
        .alert("Export failed", isPresented: Binding(
            get: { exportError != nil },
            set: { if !$0 { exportError = nil } }
        )) {
            Button("OK", role: .cancel) { exportError = nil }
        } message: {
            Text(exportError ?? "The booking operations report could not be exported.")
        }
        .task { await admin.loadBookingRequests(session: session) }
        .onChange(of: status) { _ in resetSelection() }
        .onChange(of: source) { _ in resetSelection() }
        .onChange(of: days) { _ in resetSelection() }
        .sheet(item: $selectedRequest) { booking in
            NavigationStack {
                AdminBookingRequestDetailView(
                    admin: admin,
                    session: session,
                    booking: booking,
                    mutationAllowed: requestsAreCurrent
                )
            }
        }
        .confirmationDialog("Update \(selectedRequests.count) bookings?", isPresented: $confirmingBulk, titleVisibility: .visible) {
            Button("Move to \(statusLabel(bulkStatus))", role: bulkStatus == "cancelled" ? .destructive : nil) {
                let selected = selectedRequests
                Task {
                    selectedIDs = await admin.bulkUpdateBookingRequests(session: session, bookings: selected, status: bulkStatus)
                    if selectedIDs.isEmpty { bulkStatus = "" }
                }
            }
            .disabled(!requestsAreCurrent)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(bulkStatus == "cancelled" ? "Confirmed member bookings follow the server credit-return policy." : "Every selected enquiry and member booking will be updated.")
        }
    }

    private func toggleSelection(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) } else { selectedIDs.insert(id) }
        if selectedIDs.count > 50 { selectedIDs.remove(id) }
        if !bulkOptions.contains(bulkStatus) { bulkStatus = "" }
    }

    private func resetSelection() { selectedIDs = []; bulkStatus = ""; selectedRequest = nil }

    private func statusLabel(_ value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func bookingStatusColour(_ value: String) -> Color {
        switch value {
        case "confirmed", "attended": return .green
        case "requested", "waitlisted", "no_show": return .orange
        case "cancelled", "declined": return Color.xertPale.opacity(0.45)
        default: return Color.xertSteel
        }
    }

    private func metricRow(_ label: String, _ value: Int) -> some View {
        HStack { Text(label); Spacer(); Text(value.formatted()).fontWeight(.bold) }
            .foregroundStyle(Color.xertOffWhite).listRowBackground(Color.xertInk)
    }
}

private struct AdminBookingRequestDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let booking: AdminBookingRequest
    let mutationAllowed: Bool
    private let baselineNotes: String
    private let baselineToken: String
    @State private var notes: String
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var pendingStatus: String?
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var notesFocused: Bool

    init(
        admin: AdminStore,
        session: AuthSession,
        booking: AdminBookingRequest,
        mutationAllowed: Bool
    ) {
        self.admin = admin
        self.session = session
        self.booking = booking
        self.mutationAllowed = mutationAllowed
        let initialNotes = booking.adminNotes ?? ""
        let baselineToken = AdminIntakeDraftStore.baselineToken(
            status: booking.status,
            notes: initialNotes
        )
        let recovered = booking.source == .enquiry
            ? AdminIntakeDraftStore.load(
                kind: .bookingRequest,
                ownerID: session.user?.id,
                recordID: booking.id,
                baselineToken: baselineToken
            )
            : nil
        baselineNotes = initialNotes
        self.baselineToken = baselineToken
        _notes = State(initialValue: recovered?.draft.notes ?? initialNotes)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    private var isUpdating: Bool { admin.updatingBookingRequestIDs.contains(booking.id) }
    private var isDirty: Bool { notes != baselineNotes }

    var body: some View {
        List {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Label(
                    "This booking snapshot is not current. Contact and class details remain available, but decisions and staff notes are read-only.",
                    systemImage: "lock.trianglebadge.exclamationmark"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                .listRowBackground(Color.xertInk)
            }
            Section("Booking") {
                detailRow("Member", booking.fullName)
                detailRow("Source", booking.source.label)
                detailRow("Status", statusLabel(booking.status))
                detailRow("Requested", booking.createdAt.formatted(date: .abbreviated, time: .shortened))
                if booking.creditBatchID != nil { detailRow("Class credit", "Reserved") }
                if let email = nonBlank(booking.email), let url = URL(string: "mailto:\(email)") {
                    Link(destination: url) { Label(email, systemImage: "envelope") }
                }
                if let phone = nonBlank(booking.phone), let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                    Link(destination: url) { Label(phone, systemImage: "phone") }
                }
            }
            Section("Class") {
                detailRow("Class", booking.session?.title ?? "Not linked")
                if let start = booking.session?.start_time { detailRow("Starts", start.formatted(date: .complete, time: .shortened)) }
                optionalRow("Coach", booking.session?.coach_name)
                optionalRow("Location", booking.session?.location_zone)
            }
            if !booking.allowedNextStatuses.isEmpty {
                Section("Decision") {
                    if isDirty {
                        Label(
                            "Save or discard the staff-note draft before changing this booking's status.",
                            systemImage: "note.text.badge.plus"
                        )
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(booking.allowedNextStatuses, id: \.self) { next in
                        Button(role: next == "cancelled" || next == "declined" ? .destructive : nil) {
                            pendingStatus = next
                        } label: {
                            Label(statusLabel(next), systemImage: statusIcon(next))
                        }
                        .disabled(!mutationAllowed || isUpdating || isDirty)
                    }
                }
            }
            if booking.source == .enquiry {
                Section("Staff notes") {
                    TextEditor(text: $notes)
                        .frame(minHeight: 120)
                        .focused($notesFocused)
                    Text("\(notes.count)/5,000").font(.caption2)
                        .foregroundStyle(notes.count > 5_000 ? Color.red : Color.xertPale.opacity(0.45))
                }
                .disabled(!mutationAllowed)
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Booking Detail")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if booking.source == .enquiry {
                bookingNotesSaveBar
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", action: requestDismiss)
                    .disabled(isUpdating)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { notesFocused = false }
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: "booking notes for \(booking.fullName)",
            isDirty: isDirty,
            isBusy: isUpdating
        )
        .interactiveDismissDisabled(isDirty || isUpdating)
        .onChange(of: notes) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: notes) {
            await persistRecoveryDraft()
        }
        .confirmationDialog("Move booking to \(statusLabel(pendingStatus ?? ""))?", isPresented: Binding(
            get: { pendingStatus != nil },
            set: { if !$0 { pendingStatus = nil } }
        ), titleVisibility: .visible) {
            if let pendingStatus {
                Button(statusLabel(pendingStatus), role: pendingStatus == "cancelled" || pendingStatus == "declined" ? .destructive : nil) {
                    Task {
                        if await admin.updateBookingRequest(session: session, booking: booking, status: pendingStatus) {
                            hasCommitted = true
                            clearRecoveryDraft()
                            XertHaptics.play(.success)
                            dismiss()
                        } else {
                            XertHaptics.play(.error)
                        }
                    }
                }
            }
            Button("Keep current status", role: .cancel) { pendingStatus = nil }
        } message: {
            Text(pendingStatus == "cancelled" && booking.source == .member
                ? "The server will return the reserved class credit according to the cancellation policy."
                : "This change is recorded in the permanent admin request audit.")
        }
        .confirmationDialog(
            "Discard booking notes?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard notes", role: .destructive) {
                clearRecoveryDraft()
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("The unsaved staff notes for \(booking.fullName) will be lost.")
        }
        // The database refuses a confirmation that would oversell. Squeezing
        // someone in is still the owner's call to make — from the phone as well
        // as the desk — it just has to be asked for.
        .confirmationDialog(
            "This class is already full",
            isPresented: Binding(
                get: { admin.overbookPrompt != nil },
                set: { if !$0 { admin.overbookPrompt = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let prompt = admin.overbookPrompt {
                Button("Squeeze them in") {
                    admin.overbookPrompt = nil
                    Task {
                        if await admin.updateBookingRequest(
                            session: session,
                            booking: prompt.booking,
                            status: prompt.status,
                            allowOverbook: true
                        ) {
                            hasCommitted = true
                            clearRecoveryDraft()
                            XertHaptics.play(.success)
                            dismiss()
                        } else {
                            XertHaptics.play(.error)
                        }
                    }
                }
            }
            Button("Leave them out", role: .cancel) { admin.overbookPrompt = nil }
        } message: {
            Text(admin.overbookPrompt?.message ?? "")
        }
    }

    private var bookingNotesSaveBar: some View {
        Button(action: saveNotes) {
            HStack(spacing: 10) {
                if isUpdating { ProgressView().tint(Color.xertNavy) }
                Label(isUpdating ? "Saving notes..." : "Save staff notes", systemImage: "note.text")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSaveNotes ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSaveNotes)
        .accessibilityIdentifier("owner.bookingRequest.notes.save")
        .accessibilityHint(isDirty ? "Saves private staff notes for this booking enquiry" : "Edit the notes before saving")
    }

    private var canSaveNotes: Bool {
        mutationAllowed && isDirty && !isUpdating && notes.count <= 5_000
    }

    private func saveNotes() {
        guard canSaveNotes else { return }
        notesFocused = false
        Task {
            if await admin.saveLegacyBookingNotes(session: session, booking: booking, notes: notes) {
                hasCommitted = true
                clearRecoveryDraft()
                XertHaptics.play(.success)
                dismiss()
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func requestDismiss() {
        notesFocused = false
        if isDirty {
            confirmingDiscard = true
        } else if !isUpdating {
            clearRecoveryDraft()
            dismiss()
        }
    }

    private func persistRecoveryDraft() async {
        guard booking.source == .enquiry, !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isUpdating, notes.count <= 5_000 else { return }
        AdminIntakeDraftStore.save(
            AdminIntakeDraft(status: nil, notes: notes),
            kind: .bookingRequest,
            ownerID: session.user?.id,
            recordID: booking.id,
            baselineToken: baselineToken
        )
    }

    private func discardRecoveredEdits() {
        notes = baselineNotes
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func clearRecoveryDraft() {
        AdminIntakeDraftStore.clear(
            kind: .bookingRequest,
            ownerID: session.user?.id,
            recordID: booking.id
        )
    }

    private func statusLabel(_ value: String) -> String { value.replacingOccurrences(of: "_", with: " ").capitalized }
    private func statusIcon(_ value: String) -> String {
        switch value {
        case "confirmed": return "checkmark.circle"
        case "waitlisted": return "clock"
        case "attended": return "person.badge.checkmark"
        case "no_show": return "person.badge.minus"
        default: return "xmark.circle"
        }
    }
    private func nonBlank(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
    @ViewBuilder private func optionalRow(_ label: String, _ value: String?) -> some View {
        if let value = nonBlank(value) { detailRow(label, value) }
    }
    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(Color.xertPale.opacity(0.55))
            Spacer()
            Text(value).multilineTextAlignment(.trailing).foregroundStyle(Color.xertOffWhite)
        }
    }
}

private struct AdminSiteContentView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession

    var body: some View {
        List {
            if let message = admin.siteContentStatusMessage {
                Label(message, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .listRowBackground(Color.xertInk)
            }
            Section {
                Text("Changes publish to the public website immediately. Empty saved fields use XERT's built-in copy, and unfinished drafts stay on this device.")
                    .foregroundStyle(Color.xertPale.opacity(0.7))
            }
            if admin.isLoadingSiteContent && !admin.hasLoadedSiteContent {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading live content...")
                }
                .frame(minHeight: 44)
                .listRowBackground(Color.xertInk)
            } else if !admin.siteContentIsCurrent {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        admin.hasLoadedSiteContent
                            ? "Showing the last website snapshot. Publishing and media uploads are paused until refresh succeeds."
                            : "Live Website content could not be loaded. Built-in defaults are not being treated as the server state.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await admin.loadSiteContent(session: session, force: true) }
                    } label: {
                        Label(admin.isLoadingSiteContent ? "Retrying..." : "Retry live content", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(admin.isLoadingSiteContent)
                }
                .listRowBackground(Color.xertInk)
            }
            if admin.hasLoadedSiteContent {
                Section("Public sections") {
                    ForEach(AdminSiteContentSection.allCases) { section in
                        NavigationLink {
                            AdminSiteContentEditor(
                                admin: admin,
                                session: session,
                                section: section,
                                row: admin.siteContentRow(for: section)
                            )
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack {
                                        Text(section.title).font(.headline)
                                        Spacer()
                                        Text(admin.siteContentRow(for: section) == nil ? "BUILT-IN" : "CUSTOM")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(Color.xertSteel)
                                    }
                                    Text(section.summary).font(.caption).foregroundStyle(Color.xertPale.opacity(0.55))
                                }
                            } icon: {
                                Image(systemName: section.icon).foregroundStyle(Color.xertSteel)
                            }
                        }
                        .foregroundStyle(Color.xertOffWhite)
                        .listRowBackground(Color.xertInk)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Website content")
        .refreshable { await admin.loadSiteContent(session: session, force: true) }
        .task { await admin.loadSiteContent(session: session) }
    }
}

private struct AdminSiteContentEditor: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let section: AdminSiteContentSection
    let row: AdminSiteContentRow?
    @State private var baseline: AdminSiteContentData
    @State private var draft: AdminSiteContentData
    @State private var expectedUpdatedAt: String?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var photoURL = ""
    @State private var photoItemIDs: [UUID]
    @State private var paragraphItemIDs: [UUID]
    @FocusState private var editorIsFocused: Bool

    private var ownerID: UUID? { session.user?.id }

    init(admin: AdminStore, session: AuthSession, section: AdminSiteContentSection, row: AdminSiteContentRow?) {
        self.admin = admin
        self.session = session
        self.section = section
        self.row = row
        let live = (row?.data ?? AdminSiteContentData()).merged(over: .defaults(for: section))
        let initialDraft = AdminSiteContentDraftStore.load(
            section,
            ownerID: session.user?.id
        ) ?? live
        _baseline = State(initialValue: live)
        _draft = State(initialValue: initialDraft)
        _expectedUpdatedAt = State(initialValue: row?.updated_at)
        _photoItemIDs = State(initialValue: (initialDraft.photos ?? []).map { _ in UUID() })
        _paragraphItemIDs = State(initialValue: (initialDraft.paragraphs ?? []).map { _ in UUID() })
    }

    private var dirty: Bool { draft != baseline }
    private var isSaving: Bool { admin.savingSiteContentSection == section }
    private var isBusy: Bool {
        isSaving || admin.isUploadingSiteImage || admin.isLoadingSiteContent
    }
    private var mutationAllowed: Bool {
        admin.siteContentIsCurrent
            && !admin.isLoadingSiteContent
    }
    private var canPublish: Bool {
        dirty
            && !isSaving
            && !admin.isUploadingSiteImage
            && mutationAllowed
            && validationMessage == nil
    }
    private var validationMessage: String? {
        do {
            _ = try draft.normalized(for: section)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    var body: some View {
        Form {
            if !mutationAllowed {
                Section {
                    Label(
                        "This website snapshot is not current. Your local draft is preserved, but publishing and uploads require a refresh from the Website content desk.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await refreshAuthoritativeSnapshot() }
                    } label: {
                        Label(
                            admin.isLoadingSiteContent ? "Refreshing live section..." : "Refresh live section",
                            systemImage: "arrow.clockwise"
                        )
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(admin.isLoadingSiteContent || isSaving || admin.isUploadingSiteImage)
                }
            }
            if let validationMessage {
                Section {
                    Label(validationMessage, systemImage: "exclamationmark.triangle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Section {
                Label(section.summary, systemImage: section.icon)
                    .foregroundStyle(Color.xertPale.opacity(0.72))
                Link(destination: AppConfig.webURL(path: section.publicPath)) {
                    Label("View live page", systemImage: "safari")
                }
            }

            fields

            Section {
                Button {
                    editorIsFocused = false
                    replaceDraft(with: .defaults(for: section))
                } label: {
                    Label("Restore original copy", systemImage: "arrow.counterclockwise")
                }
                if dirty {
                    Button("Discard draft", role: .destructive) {
                        editorIsFocused = false
                        replaceDraft(with: baseline)
                        AdminSiteContentDraftStore.clear(section, ownerID: ownerID)
                    }
                }
            } footer: {
                Text(dirty ? "Unsaved draft stored on this device." : "This section matches the live version loaded from Supabase.")
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .xertOwnerScreen()
        .navigationTitle(section.title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) { publishBar }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: publish) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Image(systemName: dirty ? "checkmark.circle.fill" : "checkmark.circle")
                    }
                }
                .disabled(!canPublish)
                .accessibilityLabel(dirty ? "Publish section" : "Section published")
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { editorIsFocused = false }
            }
        }
        .onChange(of: draft) { value in
            if value == baseline {
                AdminSiteContentDraftStore.clear(section, ownerID: ownerID)
            } else {
                AdminSiteContentDraftStore.save(value, section: section, ownerID: ownerID)
            }
        }
        .onChange(of: selectedPhoto) { item in
            guard let item else { return }
            Task { await upload(item) }
        }
    }

    private var publishBar: some View {
        Button(action: publish) {
            HStack(spacing: 10) {
                if isSaving {
                    ProgressView().tint(Color.xertNavy)
                } else {
                    Image(systemName: dirty ? "square.and.arrow.up.fill" : "checkmark.circle.fill")
                }
                Text(publishBarTitle)
                    .font(.headline)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canPublish ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canPublish)
        .accessibilityIdentifier("owner.siteContentEditor.publish")
        .accessibilityHint(validationMessage ?? publishBarAccessibilityHint)
    }

    private var publishBarTitle: String {
        if isSaving { return "Publishing \(section.title)..." }
        if !mutationAllowed { return "Refresh before publishing" }
        if !dirty { return "\(section.title) is up to date" }
        return "Publish \(section.title)"
    }

    private var publishBarAccessibilityHint: String {
        if isBusy { return "Wait for the current website operation to finish" }
        if !mutationAllowed { return "Refresh the live section before publishing this draft" }
        if !dirty { return "This draft matches the live section" }
        return "Publishes this section to the XERT website"
    }

    private func publish() {
        guard canPublish else { return }
        editorIsFocused = false
        Task {
            if let saved = await admin.saveSiteContent(
                session: session,
                section: section,
                expectedUpdatedAt: expectedUpdatedAt,
                draft: draft
            ) {
                let authoritative = saved.data.merged(over: .defaults(for: section))
                baseline = authoritative
                replaceDraft(with: authoritative)
                expectedUpdatedAt = saved.updated_at
                XertHaptics.play(.success)
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func refreshAuthoritativeSnapshot() async {
        guard !isBusy else { return }
        editorIsFocused = false
        let draftAtRefreshStart = draft
        let wasDirtyAtRefreshStart = dirty
        await admin.loadSiteContent(session: session, force: true)
        guard admin.siteContentIsCurrent else {
            XertHaptics.play(.error)
            return
        }

        let refreshed = admin.siteContentRow(for: section)
        let authoritative = (refreshed?.data ?? AdminSiteContentData())
            .merged(over: .defaults(for: section))
        baseline = authoritative
        expectedUpdatedAt = refreshed?.updated_at
        let preserveDraft = wasDirtyAtRefreshStart || draft != draftAtRefreshStart
        if !preserveDraft {
            replaceDraft(with: authoritative)
        }
        XertHaptics.play(.success)
    }

    @ViewBuilder
    private var fields: some View {
        switch section {
        case .hero:
            Section("Hero copy") {
                TextField("Headline", text: textBinding(\.headline)).focused($editorIsFocused)
                TextField("Subheading", text: textBinding(\.subheading), axis: .vertical).lineLimit(3...8).focused($editorIsFocused)
                TextField("Supporting line", text: textBinding(\.supporting), axis: .vertical).lineLimit(3...8).focused($editorIsFocused)
            }
            Section("Rotating photos") {
                ForEach(photoItemIDs, id: \.self) { itemID in
                    heroPhotoRow(itemID: itemID)
                }
                PhotosPicker(selection: $selectedPhoto, matching: .images) {
                    Label(admin.isUploadingSiteImage ? "Uploading..." : "Upload photo", systemImage: "photo.badge.plus")
                        .frame(minHeight: 44)
                }
                .disabled(
                    !mutationAllowed
                        || admin.isUploadingSiteImage
                        || (draft.photos?.count ?? 0) >= 12
                )
                HStack {
                    TextField("https://... or /assets/...", text: $photoURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .focused($editorIsFocused)
                    Button {
                        guard !photoURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                        draft.photos = (draft.photos ?? []) + [photoURL]
                        photoItemIDs.append(UUID())
                        photoURL = ""
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .frame(width: 44, height: 44)
                    }
                    .disabled(
                        photoURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || (draft.photos?.count ?? 0) >= 12
                    )
                    .accessibilityLabel("Add photo URL")
                }
            }
        case .booking:
            Section("Booking introduction") {
                TextField("Introduction", text: textBinding(\.intro), axis: .vertical).lineLimit(5...12).focused($editorIsFocused)
            }
        case .about:
            Section("About paragraphs") {
                ForEach(paragraphItemIDs, id: \.self) { itemID in
                    editableTextListRow(itemID: itemID)
                }
                Button {
                    draft.paragraphs = (draft.paragraphs ?? []) + [""]
                    paragraphItemIDs.append(UUID())
                } label: {
                    Label("Add paragraph", systemImage: "plus")
                        .frame(minHeight: 44)
                }
                .disabled((draft.paragraphs?.count ?? 0) >= 12)
            }
        case .contact:
            Section("Public contact") {
                TextField("Email", text: textBinding(\.email)).keyboardType(.emailAddress).textInputAutocapitalization(.never).focused($editorIsFocused)
                TextField("Phone", text: textBinding(\.phone)).keyboardType(.phonePad).focused($editorIsFocused)
                TextField("Address or location", text: textBinding(\.address), axis: .vertical).focused($editorIsFocused)
                TextField("Instagram handle", text: textBinding(\.instagram_handle)).textInputAutocapitalization(.never).focused($editorIsFocused)
                TextField("Instagram URL", text: textBinding(\.instagram_url)).keyboardType(.URL).textInputAutocapitalization(.never).focused($editorIsFocused)
                TextField("Contact page introduction", text: textBinding(\.intro), axis: .vertical).lineLimit(4...10).focused($editorIsFocused)
            }
        case .faq:
            Section("Questions and answers") {
                ForEach(draft.items ?? []) { item in
                    faqRow(itemID: item.id)
                }
                Button {
                    draft.items = (draft.items ?? []) + [AdminFAQItem(q: "", a: "")]
                } label: {
                    Label("Add question", systemImage: "plus")
                        .frame(minHeight: 44)
                }
                .disabled((draft.items?.count ?? 0) >= 20)
            }
        }
    }

    private func textBinding(_ keyPath: WritableKeyPath<AdminSiteContentData, String?>) -> Binding<String> {
        Binding(
            get: { draft[keyPath: keyPath] ?? "" },
            set: { draft[keyPath: keyPath] = $0 }
        )
    }

    @ViewBuilder
    private func heroPhotoRow(itemID: UUID) -> some View {
        if let index = photoItemIDs.firstIndex(of: itemID),
           let value = value(at: index, in: draft.photos) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    if let url = publicImageURL(value) {
                        XertRemoteImage(url: url, maximumPointDimension: 72) {
                            Image(systemName: "photo").foregroundStyle(Color.xertPale.opacity(0.4))
                        }
                        .frame(width: 58, height: 70)
                        .clipped()
                    } else {
                        Image(systemName: "photo")
                            .foregroundStyle(Color.xertPale.opacity(0.4))
                            .frame(width: 58, height: 70)
                    }
                    Text(value)
                        .font(.caption)
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                reorderButtons(index: index, count: photoItemIDs.count) { _, to in
                    movePhoto(id: itemID, to: to)
                } remove: {
                    editorIsFocused = false
                    removePhoto(id: itemID)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    @ViewBuilder
    private func editableTextListRow(itemID: UUID) -> some View {
        if let index = paragraphItemIDs.firstIndex(of: itemID) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Paragraph \(index + 1)").font(.caption.weight(.bold))
                reorderButtons(index: index, count: paragraphItemIDs.count) { _, to in
                    moveParagraph(id: itemID, to: to)
                } remove: {
                    editorIsFocused = false
                    removeParagraph(id: itemID)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                TextField("Paragraph", text: paragraphBinding(itemID), axis: .vertical)
                    .lineLimit(5...14)
                    .focused($editorIsFocused)
            }
        }
    }

    @ViewBuilder
    private func faqRow(itemID: UUID) -> some View {
        if let index = draft.items?.firstIndex(where: { $0.id == itemID }) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Question \(index + 1)").font(.caption.weight(.bold))
                reorderButtons(index: index, count: draft.items?.count ?? 0) { _, to in
                    moveFAQItem(id: itemID, to: to)
                } remove: {
                    editorIsFocused = false
                    draft.items?.removeAll { $0.id == itemID }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                TextField("Question", text: faqBinding(itemID, \.q))
                    .focused($editorIsFocused)
                TextField("Answer", text: faqBinding(itemID, \.a), axis: .vertical)
                    .lineLimit(3...10)
                    .focused($editorIsFocused)
            }
        }
    }

    private func paragraphBinding(_ itemID: UUID) -> Binding<String> {
        Binding(
            get: {
                guard let index = paragraphItemIDs.firstIndex(of: itemID) else { return "" }
                return value(at: index, in: draft.paragraphs) ?? ""
            },
            set: { value in
                guard let index = paragraphItemIDs.firstIndex(of: itemID) else { return }
                guard draft.paragraphs?.indices.contains(index) == true else { return }
                draft.paragraphs?[index] = value
            }
        )
    }

    private func faqBinding(
        _ itemID: UUID,
        _ keyPath: WritableKeyPath<AdminFAQItem, String>
    ) -> Binding<String> {
        Binding(
            get: {
                draft.items?.first(where: { $0.id == itemID })?[keyPath: keyPath] ?? ""
            },
            set: { value in
                guard let index = draft.items?.firstIndex(where: { $0.id == itemID }),
                      var item = draft.items?[index] else { return }
                item[keyPath: keyPath] = value
                draft.items?[index] = item
            }
        )
    }

    private func moveFAQItem(id: UUID, to destination: Int) {
        guard let source = draft.items?.firstIndex(where: { $0.id == id }) else { return }
        draft.items = movingElement(from: source, to: destination, in: draft.items)
    }

    private func movePhoto(id: UUID, to destination: Int) {
        guard let source = photoItemIDs.firstIndex(of: id),
              photoItemIDs.indices.contains(destination) else { return }
        draft.photos = movingElement(from: source, to: destination, in: draft.photos)
        photoItemIDs.swapAt(source, destination)
    }

    private func removePhoto(id: UUID) {
        guard let index = photoItemIDs.firstIndex(of: id) else { return }
        draft.photos = removingElement(at: index, from: draft.photos)
        photoItemIDs.remove(at: index)
    }

    private func moveParagraph(id: UUID, to destination: Int) {
        guard let source = paragraphItemIDs.firstIndex(of: id),
              paragraphItemIDs.indices.contains(destination) else { return }
        draft.paragraphs = movingElement(from: source, to: destination, in: draft.paragraphs)
        paragraphItemIDs.swapAt(source, destination)
    }

    private func removeParagraph(id: UUID) {
        guard let index = paragraphItemIDs.firstIndex(of: id) else { return }
        draft.paragraphs = removingElement(at: index, from: draft.paragraphs)
        paragraphItemIDs.remove(at: index)
    }

    private func replaceDraft(with value: AdminSiteContentData) {
        draft = value
        photoItemIDs = (value.photos ?? []).map { _ in UUID() }
        paragraphItemIDs = (value.paragraphs ?? []).map { _ in UUID() }
    }

    private func value<Element>(at index: Int, in values: [Element]?) -> Element? {
        guard let values, values.indices.contains(index) else { return nil }
        return values[index]
    }

    private func movingElement<Element>(
        from source: Int,
        to destination: Int,
        in values: [Element]?
    ) -> [Element]? {
        guard var values,
              values.indices.contains(source),
              values.indices.contains(destination) else { return values }
        values.swapAt(source, destination)
        return values
    }

    private func removingElement<Element>(at index: Int, from values: [Element]?) -> [Element]? {
        guard var values, values.indices.contains(index) else { return values }
        values.remove(at: index)
        return values
    }

    private func reorderButtons(
        index: Int,
        count: Int,
        move: @escaping (Int, Int) -> Void,
        remove: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 4) {
            Button { move(index, index - 1) } label: {
                Image(systemName: "arrow.up").frame(width: 44, height: 44)
            }
                .disabled(index == 0).accessibilityLabel("Move up")
            Button { move(index, index + 1) } label: {
                Image(systemName: "arrow.down").frame(width: 44, height: 44)
            }
                .disabled(index >= count - 1).accessibilityLabel("Move down")
            Button(role: .destructive, action: remove) {
                Image(systemName: "trash").frame(width: 44, height: 44)
            }
                .accessibilityLabel("Remove")
        }
        .buttonStyle(.borderless)
    }

    private func publicImageURL(_ value: String) -> URL? {
        value.hasPrefix("/") ? AppConfig.webURL(path: value) : URL(string: value)
    }

    private func upload(_ item: PhotosPickerItem) async {
        defer { selectedPhoto = nil }
        guard (draft.photos?.count ?? 0) < 12 else {
            admin.errorMessage = "Hero photography is limited to 12 images."
            return
        }
        guard let sourceData = try? await item.loadTransferable(type: Data.self) else {
            admin.errorMessage = "The selected photo could not be read."
            return
        }
        guard sourceData.count <= 5 * 1_024 * 1_024 else {
            admin.errorMessage = "Image must be under 5 MB."
            return
        }
        guard let preparedData = preparedHeroJPEG(sourceData),
              preparedData.count <= 5 * 1_024 * 1_024 else {
            admin.errorMessage = "The selected image type could not be prepared for the website."
            return
        }
        if let url = await admin.uploadSiteImage(
            session: session,
            data: preparedData,
            mimeType: "image/jpeg",
            fileExtension: "jpg"
        ) {
            draft.photos = (draft.photos ?? []) + [url]
            photoItemIDs.append(UUID())
        }
    }

    private func preparedHeroJPEG(_ data: Data) -> Data? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2_400,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                options as CFDictionary
              ) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: 0.86)
    }
}

private struct AdminCampaignAttributionView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var range = AdminCampaignRange.thirty
    @State private var exportDocument: AdminCampaignCSVDocument?
    @State private var isExporting = false

    private var summary: AdminCampaignSummary {
        AdminCampaignSummary(rows: admin.campaignAttributionRows, range: range)
    }

    private var reportIsCurrent: Bool {
        admin.campaignAttributionIsCurrent && !admin.isLoadingCampaignAttribution
    }

    var body: some View {
        List {
            Section {
                Picker("Reporting range", selection: $range) {
                    ForEach(AdminCampaignRange.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text("Member-interest attribution uses Australia/Brisbane reporting days and matches the desktop command centre.")
            }

            if !admin.hasLoadedCampaignAttribution {
                Section {
                    if admin.isLoadingCampaignAttribution {
                        HStack(spacing: 12) {
                            ProgressView().tint(Color.xertSteel)
                            Text("Loading acquisition evidence...")
                        }
                        .frame(minHeight: 64)
                        .listRowBackground(Color.xertInk)
                    } else {
                        reportingUnavailablePanel(
                            message: admin.campaignAttributionStatusMessage
                                ?? "Where members come from has not loaded. Retry before relying on acquisition totals."
                        )
                    }
                }
            } else {
                if !reportIsCurrent {
                    Section {
                        reportingUnavailablePanel(
                            message: admin.campaignAttributionStatusMessage
                                ?? "Showing the last acquisition snapshot. Refresh before using these totals."
                        )
                    }
                }

                Section {
                    Label(
                        reportIsCurrent ? "LIVE REPORT" : "CACHED REPORT",
                        systemImage: reportIsCurrent ? "checkmark.circle.fill" : "clock.arrow.circlepath"
                    )
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(reportIsCurrent ? Color.green : Color.orange)
                    if let updatedAt = admin.campaignAttributionUpdatedAt {
                        Text("Loaded \(updatedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.52))
                    }
                }
                .listRowBackground(Color.xertInk)

                Section("Acquisition pulse") {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        AdminCampaignMetric(title: "Leads", value: "\(summary.total)")
                        AdminCampaignMetric(title: "UTM attributed", value: "\(summary.attributed)")
                        AdminCampaignMetric(title: "Direct / unknown", value: "\(summary.direct)")
                        AdminCampaignMetric(
                            title: "Attribution rate",
                            value: summary.attributionRate.formatted(.percent.precision(.fractionLength(0)))
                        )
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(Color.xertNavy)
                }

                AdminCampaignBreakdownSection(
                    title: "Traffic sources", items: summary.sources, total: summary.total,
                    emptyText: "No source data in this range."
                )
                AdminCampaignBreakdownSection(
                    title: "Campaigns", items: summary.campaigns, total: summary.total,
                    emptyText: "No UTM campaigns in this range."
                )
                AdminCampaignBreakdownSection(
                    title: "Channels / mediums", items: summary.mediums, total: summary.total,
                    emptyText: "No channel data in this range."
                )

                Section("Daily signups - latest 30 Queensland days") {
                    if summary.dailySignups.allSatisfy({ $0.count == 0 }) {
                        AdminEmptyState(icon: "chart.bar", text: "No member leads in the latest 30 days.")
                            .listRowInsets(EdgeInsets())
                    } else {
                        AdminCampaignDailyChart(days: summary.dailySignups)
                            .listRowBackground(Color.xertInk)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Where members come from")
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button {
                    exportDocument = AdminCampaignCSVDocument(csv: summary.csv)
                    isExporting = true
                } label: {
                    Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44)
                }
                .disabled(!reportIsCurrent || summary.total == 0)
                .accessibilityLabel("Export campaign attribution CSV")
                .accessibilityHint(reportIsCurrent ? "Exports the selected live reporting range" : "Refresh the report before exporting")
                Button {
                    Task { await admin.loadCampaignAttribution(session: session, force: true) }
                } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }
                .disabled(admin.isLoadingCampaignAttribution)
                .accessibilityLabel("Refresh campaign attribution")
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "xert-campaign-attribution-\(range.rawValue)"
        ) { result in
            if case .failure(let error) = result { admin.errorMessage = error.localizedDescription }
        }
        .refreshable { await admin.loadCampaignAttribution(session: session, force: true) }
        .task { await admin.loadCampaignAttribution(session: session) }
    }

    private func reportingUnavailablePanel(message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: "wifi.exclamationmark")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await admin.loadCampaignAttribution(session: session, force: true) }
            } label: {
                Label(
                    admin.isLoadingCampaignAttribution ? "Retrying..." : "Retry campaign report",
                    systemImage: "arrow.clockwise"
                )
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.orange)
            .disabled(admin.isLoadingCampaignAttribution)
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.xertInk)
    }
}

private struct AdminCampaignMetric: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value)
                .font(.title2.weight(.bold))
                .foregroundStyle(Color.xertOffWhite)
                .minimumScaleFactor(0.75)
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.xertPale.opacity(0.55))
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(12)
        .background(Color.xertInk)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.xertSteel.opacity(0.16), lineWidth: 1))
    }
}

private struct AdminCampaignBreakdownSection: View {
    let title: String
    let items: [AdminCampaignBreakdown]
    let total: Int
    let emptyText: String

    var body: some View {
        Section(title) {
            if items.isEmpty {
                Text(emptyText).foregroundStyle(Color.xertPale.opacity(0.6))
            } else {
                ForEach(items.prefix(8)) { item in
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text(item.label).lineLimit(1)
                            Spacer()
                            Text("\(item.count)").fontWeight(.bold).monospacedDigit()
                        }
                        ProgressView(value: Double(item.count), total: Double(max(total, 1)))
                            .tint(Color.xertSteel)
                    }
                    .foregroundStyle(Color.xertOffWhite)
                    .listRowBackground(Color.xertInk)
                }
            }
        }
    }
}

private struct AdminCampaignDailyChart: View {
    let days: [AdminCampaignDailyCount]
    private var maximum: Int { max(days.map(\.count).max() ?? 0, 1) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .bottom, spacing: 5) {
                ForEach(days.indices, id: \.self) { index in
                    let day = days[index]
                    VStack(spacing: 4) {
                        Text(day.count == 0 ? "" : "\(day.count)")
                            .font(.caption2).monospacedDigit()
                            .foregroundStyle(Color.xertPale.opacity(0.65))
                            .frame(height: 12)
                        Rectangle()
                            .fill(Color.xertSteel)
                            .frame(width: 14, height: max(2, CGFloat(day.count) / CGFloat(maximum) * 92))
                        Text(index % 5 == 0 || index == days.count - 1 ? String(day.dateKey.suffix(5)) : "")
                            .font(.system(size: 8))
                            .foregroundStyle(Color.xertPale.opacity(0.45))
                            .frame(width: 24)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(day.dateKey), \(day.count) signups")
                }
            }
            .frame(minHeight: 125, alignment: .bottom)
            .padding(.vertical, 6)
        }
    }
}

private struct AdminCampaignCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    let csv: String

    init(csv: String) { self.csv = csv }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        csv = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(csv.utf8))
    }
}

private struct AdminLeadsView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    private let defaultStatus: String
    @State private var pipeline: AdminLeadPipeline
    @State private var query = ""
    @State private var status: String
    @State private var selectedLead: AdminLead?
    @State private var selectedIDs: Set<AdminLeadIdentifier> = []
    @State private var bulkStatus = ""
    @State private var exportDocument: AdminIntakeCSVDocument?
    @State private var isExporting = false
    @State private var exportError: String?

    private var leads: [AdminLead] { admin.leads(for: pipeline) }
    private var pipelineIsLoaded: Bool { admin.loadedLeadPipelines.contains(pipeline) }
    private var pipelineIsCurrent: Bool { admin.leadPipelineIsCurrent(pipeline) }
    private var pipelineIsLoading: Bool {
        admin.loadingLeadPipeline == pipeline && !pipelineIsLoaded
    }
    private var filteredLeads: [AdminLead] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matches = leads.filter { lead in
            (status == "all" || lead.effectiveStatus == status)
                && (needle.isEmpty || lead.searchableText.contains(needle))
        }
        if status == "new" {
            return matches.sorted { $0.created_at < $1.created_at }
        }
        return matches
    }
    private var exportDateStamp: String {
        String(ISO8601DateFormatter().string(from: Date()).prefix(10))
    }

    @ViewBuilder
    private var pipelinePicker: some View {
        if dynamicTypeSize.isAccessibilitySize {
            Picker("Lead pipeline", selection: $pipeline) {
                pipelineOptions
            }
            .pickerStyle(.menu)
            .tint(Color.xertSteel)
        } else {
            Picker("Lead pipeline", selection: $pipeline) {
                pipelineOptions
            }
            .pickerStyle(.segmented)
        }
    }

    @ViewBuilder
    private var pipelineOptions: some View {
        ForEach(AdminLeadPipeline.allCases) { option in
            Text(option.shortLabel).tag(option)
        }
    }

    init(
        admin: AdminStore,
        session: AuthSession,
        initialPipeline: AdminLeadPipeline? = nil,
        prioritizesNewWork: Bool = false
    ) {
        self.admin = admin
        self.session = session
        let initialStatus = prioritizesNewWork ? "new" : "all"
        defaultStatus = initialStatus
        _pipeline = State(initialValue: initialPipeline ?? .members)
        _status = State(initialValue: initialStatus)
    }

    var body: some View {
        List {
            if let message = admin.leadPipelineStatusMessage,
               admin.unavailableLeadPipelines.contains(pipeline) {
                Label(message, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .listRowBackground(Color.xertInk)
            }
            if let counts = admin.leadActionCounts, counts.overdueTotal > 0 {
                Label(
                    "\(counts.overdueTotal) new enquiries have waited more than 24 hours. Oldest are shown first.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                .listRowBackground(Color.orange.opacity(0.08))
                .accessibilityIdentifier("owner.leads.overdueSLA")
            }
            Section {
                pipelinePicker
                    .disabled(admin.loadingLeadPipeline != nil)

                Picker("Status", selection: $status) {
                    Text("All statuses").tag("all")
                    ForEach(pipeline.statuses, id: \.self) { value in
                        Text(statusLabel(value)).tag(value)
                    }
                }
                .pickerStyle(.menu)
                .tint(Color.xertSteel)
            }
            .listRowBackground(Color.xertInk)

            if !pipelineIsCurrent && !pipelineIsLoading {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        pipelineIsLoaded
                            ? "Showing the last \(pipeline.title.lowercased()) snapshot. Changes are paused until refresh succeeds."
                            : "\(pipeline.title) could not be loaded. No empty pipeline assumption is being made.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await admin.loadLeads(session: session, pipeline: pipeline, force: true) }
                    } label: {
                        Label(
                            admin.loadingLeadPipeline == pipeline ? "Retrying..." : "Retry pipeline",
                            systemImage: "arrow.clockwise"
                        )
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(admin.loadingLeadPipeline != nil)
                }
                .listRowBackground(Color.xertInk)
            }

            if !selectedIDs.isEmpty {
                Section("Bulk update") {
                    HStack {
                        Text("\(selectedIDs.count) selected")
                        Spacer()
                        Button("Clear") { selectedIDs = [] }
                    }
                    Picker("Move selected to", selection: $bulkStatus) {
                        Text("Choose status").tag("")
                        ForEach(pipeline.statuses, id: \.self) { value in
                            Text(statusLabel(value)).tag(value)
                        }
                    }
                    Button {
                        let ids = selectedIDs
                        Task {
                            if await admin.bulkUpdateLeads(session: session, pipeline: pipeline, ids: ids, status: bulkStatus) {
                                selectedIDs = []
                                bulkStatus = ""
                            }
                        }
                    } label: {
                        Label(admin.savingLeadIDs.isEmpty ? "Apply bulk status" : "Updating leads...", systemImage: "person.2.badge.gearshape")
                    }
                    .disabled(!pipelineIsCurrent || bulkStatus.isEmpty || !admin.savingLeadIDs.isEmpty)
                }
                .listRowBackground(Color.xertInk)
            }

            Section(pipeline.title) {
                if pipelineIsLoading {
                    HStack { ProgressView(); Text("Loading pipeline...") }
                        .listRowBackground(Color.xertInk)
                } else if pipelineIsCurrent && filteredLeads.isEmpty {
                    AdminEmptyState(icon: "person.crop.circle.badge.questionmark", text: leads.isEmpty ? "No leads yet." : "No matching leads.")
                        .listRowBackground(Color.xertInk)
                }

                ForEach(filteredLeads) { lead in
                    HStack(spacing: 12) {
                        Button { toggleSelection(lead.id) } label: {
                            Image(systemName: selectedIDs.contains(lead.id) ? "checkmark.circle.fill" : "circle")
                                .font(.title3).foregroundStyle(Color.xertSteel)
                        }
                        .buttonStyle(.plain)
                        .disabled(
                            !pipelineIsCurrent
                                || (selectedIDs.count >= 100 && !selectedIDs.contains(lead.id))
                        )
                        .accessibilityLabel(selectedIDs.contains(lead.id) ? "Deselect \(lead.displayName)" : "Select \(lead.displayName)")

                        Button { selectedLead = lead } label: {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(lead.displayName).font(.headline)
                                    Text([lead.email, lead.phone].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(Color.xertPale.opacity(0.62))
                                    if let goals = lead.main_training_goals, !goals.isEmpty {
                                        Text(goals.prefix(3).joined(separator: ", "))
                                            .font(.caption).foregroundStyle(Color.xertPale.opacity(0.5)).lineLimit(1)
                                    }
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 5) {
                                    Text(statusLabel(lead.effectiveStatus).uppercased())
                                        .font(.caption2.weight(.bold)).foregroundStyle(leadStatusColour(lead.effectiveStatus))
                                    Text(leadAgeLabel(lead))
                                        .font(.caption2.weight(lead.effectiveStatus == "new" ? .semibold : .regular))
                                        .foregroundStyle(leadAgeColour(lead))
                                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Color.xertSteel)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .foregroundStyle(Color.xertOffWhite)
                    .padding(.vertical, 5)
                    .listRowBackground(Color.xertInk)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("New enquiries")
        .searchable(text: $query, prompt: "Name, email, phone or source")
        .refreshable { await admin.loadLeads(session: session, pipeline: pipeline, force: true) }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    exportDocument = AdminIntakeCSVDocument(
                        csv: AdminLeadReport(pipeline: pipeline, rows: filteredLeads).csv
                    )
                    isExporting = true
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(filteredLeads.isEmpty || !pipelineIsCurrent)
                .accessibilityLabel("Export filtered \(pipeline.title.lowercased())")
                .accessibilityHint(
                    pipelineIsCurrent
                        ? "Exports every current lead matching the active pipeline filters"
                        : "Refresh this lead pipeline before exporting"
                )
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "xert-\(pipeline.rawValue)-\(exportDateStamp)"
        ) { result in
            if case .failure(let error) = result {
                exportError = error.localizedDescription
            }
            exportDocument = nil
        }
        .alert("Export failed", isPresented: Binding(
            get: { exportError != nil },
            set: { if !$0 { exportError = nil } }
        )) {
            Button("OK", role: .cancel) { exportError = nil }
        } message: {
            Text(exportError ?? "The lead pipeline report could not be exported.")
        }
        .task { await admin.loadLeads(session: session, pipeline: pipeline) }
        .onChange(of: pipeline) { newPipeline in
            query = ""
            status = defaultStatus
            selectedIDs = []
            bulkStatus = ""
            selectedLead = nil
            Task { await admin.loadLeads(session: session, pipeline: newPipeline) }
        }
        .onChange(of: admin.unavailableLeadPipelines) { unavailable in
            if unavailable.contains(pipeline) {
                selectedIDs = []
                bulkStatus = ""
            }
        }
        .sheet(item: $selectedLead) { lead in
            NavigationStack {
                AdminLeadDetailView(
                    admin: admin,
                    session: session,
                    pipeline: pipeline,
                    lead: lead,
                    mutationAllowed: pipelineIsCurrent
                )
            }
        }
    }

    private func toggleSelection(_ id: AdminLeadIdentifier) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) }
        else if selectedIDs.count < 100 { selectedIDs.insert(id) }
    }

    private func statusLabel(_ value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func leadStatusColour(_ value: String) -> Color {
        switch value {
        case "new", "hot": return .orange
        case "joined", "hired", "approved", "booked_trial": return .green
        // Training casually rather than joining is still a win, just a different one.
        case "casual": return .teal
        case "not_suitable", "archived": return Color.xertPale.opacity(0.45)
        default: return Color.xertSteel
        }
    }
}

private struct AdminLeadDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let pipeline: AdminLeadPipeline
    let lead: AdminLead
    let mutationAllowed: Bool
    private let baselineStatus: String
    private let baselineNotes: String
    private let baselineToken: String
    private let recoveryRecordID: String
    @State private var status: String
    @State private var notes: String
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var confirmingFitboxSend = false
    @State private var exitStateID = UUID()
    @FocusState private var notesFocused: Bool

    init(
        admin: AdminStore,
        session: AuthSession,
        pipeline: AdminLeadPipeline,
        lead: AdminLead,
        mutationAllowed: Bool
    ) {
        self.admin = admin
        self.session = session
        self.pipeline = pipeline
        self.lead = lead
        self.mutationAllowed = mutationAllowed
        let initialStatus = lead.effectiveStatus
        let initialNotes = lead.admin_notes ?? ""
        let recoveryRecordID = "\(pipeline.rawValue):\(lead.id.value)"
        let baselineToken = AdminIntakeDraftStore.baselineToken(
            status: initialStatus,
            notes: initialNotes
        )
        let recovered = AdminIntakeDraftStore.load(
            kind: .lead,
            ownerID: session.user?.id,
            recordID: recoveryRecordID,
            baselineToken: baselineToken
        )
        baselineStatus = initialStatus
        baselineNotes = initialNotes
        self.baselineToken = baselineToken
        self.recoveryRecordID = recoveryRecordID
        _status = State(initialValue: recovered?.draft.status ?? initialStatus)
        _notes = State(initialValue: recovered?.draft.notes ?? initialNotes)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    private var isSaving: Bool { admin.savingLeadIDs.contains(lead.id) }
    private var isDirty: Bool {
        status != baselineStatus || notes != baselineNotes
    }
    private var intakeDraft: AdminIntakeDraft {
        AdminIntakeDraft(status: status, notes: notes)
    }

    var body: some View {
        List {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Label(
                    "This pipeline snapshot is not current. Contact details remain available, but status and notes are read-only.",
                    systemImage: "lock.trianglebadge.exclamationmark"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                .listRowBackground(Color.xertInk)
            }
            Section("Contact") {
                detailRow("Name", lead.displayName)
                if let email = nonBlank(lead.email), let url = URL(string: "mailto:\(email)") {
                    Link(destination: url) {
                        Label(email, systemImage: "envelope")
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                }
                if let phone = nonBlank(lead.phone), let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                    Link(destination: url) {
                        Label(phone, systemImage: "phone")
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                }
                detailRow("Submitted", lead.created_at.formatted(date: .abbreviated, time: .shortened))
                if status == "new" {
                    Button(action: logContacted) {
                        Label(
                            isSaving ? "Saving contact..." : "Log contacted and save",
                            systemImage: "checkmark.circle.fill"
                        )
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.xertSteel)
                    .disabled(!mutationAllowed || isSaving || notes.count > 5_000)
                    .accessibilityHint(
                        "Moves this lead out of the new enquiry queue and saves the current owner notes"
                    )
                }
            }

            if pipeline == .members {
                fitboxSection
            }

            Section("Application") {
                optionalRow("Business", lead.business_name)
                optionalRow("Suburb", lead.suburb_town)
                optionalRow("Training level", lead.current_training_level)
                optionalList("Goals", lead.main_training_goals)
                optionalList("Preferred times", lead.preferred_training_times)
                optionalRow("Qualifications", lead.qualifications)
                optionalRow("Experience", lead.years_experience)
                optionalRow("Functional training", lead.functional_training_experience)
                optionalList("Specialties", lead.specialties)
                optionalRow("Profession", lead.profession)
                optionalList("Services", lead.services_offered)
                optionalRow("Introduction", lead.short_intro)
                if let website = nonBlank(lead.website_social_link), let url = URL(string: website), url.scheme != nil {
                    Link(destination: url) { Label("Website or social profile", systemImage: "safari") }
                }
                if let source = nonBlank(lead.utm_source) {
                    detailRow("Source", [source, lead.utm_medium, lead.utm_campaign].compactMap { nonBlank($0) }.joined(separator: " / "))
                }
            }

            Section("Pipeline") {
                Picker("Status", selection: $status) {
                    ForEach(pipeline.statuses, id: \.self) { value in
                        Text(value.replacingOccurrences(of: "_", with: " ").capitalized).tag(value)
                    }
                }
                TextEditor(text: $notes)
                    .frame(minHeight: 120)
                    .focused($notesFocused)
                    .overlay(alignment: .topLeading) {
                        if notes.isEmpty {
                            Text("Internal notes").foregroundStyle(Color.xertPale.opacity(0.35)).padding(.top, 8).allowsHitTesting(false)
                        }
                    }
                Text("\(notes.count)/5,000")
                    .font(.caption2).foregroundStyle(notes.count > 5_000 ? Color.red : Color.xertPale.opacity(0.45))
            }
            .disabled(!mutationAllowed)
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle(lead.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            leadSaveBar
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", action: requestDismiss)
                    .disabled(isSaving)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { notesFocused = false }
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: "\(pipeline.shortLabel.lowercased()) lead changes",
            isDirty: isDirty,
            isBusy: isSaving
        )
        .interactiveDismissDisabled(isDirty || isSaving)
        .onChange(of: intakeDraft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: intakeDraft) {
            await persistRecoveryDraft()
        }
        .confirmationDialog(
            "Discard lead changes?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive) {
                clearRecoveryDraft()
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("The unsaved status or notes for \(lead.displayName) will be lost.")
        }
        .confirmationDialog(
            "Create FitBox prospect?",
            isPresented: $confirmingFitboxSend,
            titleVisibility: .visible
        ) {
            Button("Send contact details to FitBox") {
                Task { _ = await admin.sendLeadToFitbox(session: session, lead: lead) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("XERT will send \(lead.displayName), \(lead.email ?? "missing email") and \(lead.phone ?? "missing phone") through Zapier to FitBox. This creates a prospect only—not a membership, subscription or charge.")
        }
    }

    @ViewBuilder
    private var fitboxSection: some View {
        let state = admin.fitboxLeadStates[lead.id]
        let job = state?.current_job
        let isLoading = admin.loadingFitboxLeadIDs.contains(lead.id)
        let isSending = admin.sendingFitboxLeadIDs.contains(lead.id)
        let isRefreshingProfile = admin.refreshingFitboxProfileIDs.contains(lead.id)
        let profileInProgress = job?.isProfileRefresh == true
            && ["queued", "dispatched", "dispatch_unknown"].contains(job?.status ?? "")
        let profileNeedsReview = job?.isProfileRefresh == true
            && job?.status == "failed"
            && ["FITBOX_USER_NOT_FOUND", "FITBOX_LOOKUP_IDENTITY_MISMATCH"].contains(job?.last_error_code ?? "")
        Section("FitBox") {
            if isLoading && state == nil {
                HStack { ProgressView(); Text("Checking FitBox link…") }
            } else if let link = state?.link {
                Label("Linked to FitBox user \(link.fitbox_user_id)", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(Color.green)
                detailRow("Provider status", link.fitbox_status ?? "prospect")
                detailRow("Last verified", link.last_verified_at.formatted(date: .abbreviated, time: .shortened))
                if let syncedAt = link.profile_synced_at {
                    detailRow("FitBox name", fitboxProfileName(link))
                    detailRow("FitBox email", nonBlankFitboxValue(link.profile_email) ?? "Not supplied")
                    detailRow("FitBox phone", nonBlankFitboxValue(link.profile_phone) ?? "Not supplied")
                    detailRow("Read-only snapshot", syncedAt.formatted(date: .abbreviated, time: .shortened))
                } else {
                    Text("No FitBox profile snapshot yet.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.7))
                }
                if job?.isProfileRefresh == true, ["failed", "expired"].contains(job?.status ?? "") {
                    Label(
                        fitboxProfileError(job?.last_error_code),
                        systemImage: profileNeedsReview ? "exclamationmark.triangle.fill" : "arrow.clockwise.circle"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(profileNeedsReview ? Color.orange : Color.red)
                }
                Button {
                    Task { _ = await admin.refreshFitboxUser(session: session, lead: lead) }
                } label: {
                    HStack {
                        if isRefreshingProfile || profileInProgress { ProgressView() }
                        Label(profileInProgress ? "Refreshing FitBox profile…" : "Refresh read-only profile", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .tint(Color.xertSteel)
                .disabled(isLoading || isSending || isRefreshingProfile || profileInProgress || state?.profile_refresh_ready == false || profileNeedsReview)
                if state?.profile_refresh_ready == false {
                    Text(state?.profile_refresh_issue ?? "FitBox read-only profile refresh is not configured.")
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                }
                Text("Reads name, email, phone and provider status only. XERT profile, memberships, bookings and billing are never changed.")
                    .font(.caption2)
                    .foregroundStyle(Color.xertPale.opacity(0.58))
            } else if job?.needsProviderReview == true {
                Label("Review in FitBox before retrying", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.orange)
                Text("Zapier may already have created this prospect. Search FitBox for the email and reconcile it before sending again.")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.7))
            } else if ["queued", "dispatched"].contains(job?.status ?? "") {
                HStack { ProgressView(); Text("Prospect handoff in progress") }
            } else if state?.ready == false {
                Label(state?.configuration_issue ?? "FitBox is not configured.", systemImage: "wrench.and.screwdriver.fill")
                    .foregroundStyle(Color.orange)
            } else {
                Button {
                    confirmingFitboxSend = true
                } label: {
                    Label(job?.last_error_code == "ZAPIER_DISPATCH_FAILED" ? "Retry FitBox handoff" : "Send to FitBox", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.xertSteel)
                .foregroundStyle(Color.xertNavy)
                .disabled(isSending || !mutationAllowed)
            }
            Text("XERT keeps the verified FitBox ID as a reference only. Membership, booking, subscription and billing changes remain in FitBox and are not available from this screen.")
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.58))
                .fixedSize(horizontal: false, vertical: true)
            if let error = admin.fitboxLeadErrors[lead.id] {
                Text(error).font(.caption).foregroundStyle(Color.red)
            }
            Button {
                Task { await admin.loadFitboxLeadState(session: session, leadID: lead.id, force: true) }
            } label: {
                Label(isLoading ? "Refreshing…" : "Refresh FitBox status", systemImage: "arrow.clockwise")
            }
            .disabled(isLoading || isSending || isRefreshingProfile)
        }
        .task { await admin.loadFitboxLeadState(session: session, leadID: lead.id) }
    }

    private func fitboxProfileName(_ link: AdminFitboxMemberLink) -> String {
        let name = [nonBlankFitboxValue(link.profile_first_name), nonBlankFitboxValue(link.profile_last_name)]
            .compactMap { $0 }
            .joined(separator: " ")
        return name.isEmpty ? "Not supplied" : name
    }

    private func nonBlankFitboxValue(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private func fitboxProfileError(_ code: String?) -> String {
        switch code {
        case "FITBOX_USER_NOT_FOUND": return "FitBox could not find the linked user. Review the link before retrying."
        case "FITBOX_LOOKUP_IDENTITY_MISMATCH": return "FitBox returned a different user identity. The XERT link was not changed."
        case "FITBOX_PROFILE_REFRESH_INVALID": return "FitBox returned an incomplete profile result."
        case "FITBOX_PROFILE_REFRESH_REJECTED": return "FitBox rejected the read-only profile refresh."
        case "FITBOX_PROFILE_REFRESH_EXPIRED": return "The read-only profile refresh expired without a callback. It is safe to retry."
        default: return "The read-only FitBox profile refresh did not complete. It is safe to retry."
        }
    }

    private var leadSaveBar: some View {
        Button(action: saveLead) {
            HStack(spacing: 10) {
                if isSaving { ProgressView().tint(Color.xertNavy) }
                Label(isSaving ? "Saving changes..." : "Save pipeline changes", systemImage: "checkmark.circle")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.lead.save")
        .accessibilityHint(isDirty ? "Saves this lead's pipeline status and private notes" : "Change the status or notes before saving")
    }

    private var canSave: Bool {
        mutationAllowed && isDirty && !isSaving && notes.count <= 5_000
    }

    private func saveLead() {
        guard canSave else { return }
        notesFocused = false
        Task {
            if await admin.saveLead(
                session: session,
                pipeline: pipeline,
                lead: lead,
                status: status,
                notes: notes
            ) {
                hasCommitted = true
                clearRecoveryDraft()
                XertHaptics.play(.success)
                dismiss()
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func requestDismiss() {
        notesFocused = false
        if isDirty {
            confirmingDiscard = true
        } else if !isSaving {
            clearRecoveryDraft()
            dismiss()
        }
    }

    private func logContacted() {
        guard mutationAllowed, !isSaving, notes.count <= 5_000 else { return }
        notesFocused = false
        Task {
            if await admin.saveLead(
                session: session,
                pipeline: pipeline,
                lead: lead,
                status: "contacted",
                notes: notes
            ) {
                hasCommitted = true
                clearRecoveryDraft()
                XertHaptics.play(.success)
                dismiss()
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isSaving, notes.count <= 5_000 else { return }
        AdminIntakeDraftStore.save(
            intakeDraft,
            kind: .lead,
            ownerID: session.user?.id,
            recordID: recoveryRecordID,
            baselineToken: baselineToken
        )
    }

    private func discardRecoveredEdits() {
        status = baselineStatus
        notes = baselineNotes
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func clearRecoveryDraft() {
        AdminIntakeDraftStore.clear(
            kind: .lead,
            ownerID: session.user?.id,
            recordID: recoveryRecordID
        )
    }

    @ViewBuilder
    private func optionalRow(_ label: String, _ value: String?) -> some View {
        if let value = nonBlank(value) { detailRow(label, value) }
    }

    @ViewBuilder
    private func optionalList(_ label: String, _ values: [String]?) -> some View {
        if let values, !values.isEmpty { detailRow(label, values.joined(separator: ", ")) }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(Color.xertPale.opacity(0.48))
            Text(value).foregroundStyle(Color.xertOffWhite)
        }
    }

    private func nonBlank(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct AdminPTRequestsView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var query = ""
    @State private var statusFilter = "active"
    @State private var sessionTypeFilter = "all"
    @State private var ageFilter = "30"
    @State private var selectedIDs: Set<UUID> = []
    @State private var bulkStatus = ""
    @State private var confirmingBulkUpdate = false
    @State private var notesRequest: AdminPTRequest?
    @State private var exportDocument: AdminIntakeCSVDocument?
    @State private var isExporting = false
    @State private var exportError: String?

    private var requestsAreCurrent: Bool { admin.ptRequestsAreCurrent }
    private var requestsAreLoading: Bool {
        (admin.isLoading || admin.isRefreshingOperations)
            && !admin.loadedSources.contains("PT requests")
    }
    private var isMutating: Bool {
        admin.updatingPTRequestID != nil || !admin.bulkUpdatingPTRequestIDs.isEmpty
    }
    private var sessionTypes: [String] {
        Array(Set(admin.ptRequests.map(\.requested_session_type)))
            .filter { !$0.isEmpty }
            .sorted()
    }

    private var rows: [AdminPTRequest] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let cutoff: Date? = {
            switch ageFilter {
            case "30": return Calendar.current.date(byAdding: .day, value: -30, to: Date())
            case "90": return Calendar.current.date(byAdding: .day, value: -90, to: Date())
            default: return nil
            }
        }()
        return admin.ptRequests.filter { request in
            let matchesStatus: Bool
            switch statusFilter {
            case "active":
                matchesStatus = ["requested", "reschedule_requested", "approved"].contains(request.status)
            case "all":
                matchesStatus = true
            default:
                matchesStatus = request.status == statusFilter
            }
            return matchesStatus
                && (sessionTypeFilter == "all" || request.requested_session_type == sessionTypeFilter)
                && (cutoff.map { request.created_at >= $0 } ?? true)
                && (needle.isEmpty || request.searchableText.contains(needle))
        }
    }
    private var selectedRequests: [AdminPTRequest] {
        admin.ptRequests.filter { selectedIDs.contains($0.id) }
    }
    private var bulkOptions: [String] {
        guard let first = selectedRequests.first,
              selectedRequests.allSatisfy({ $0.status == first.status }) else { return [] }
        return first.allowedNextStatuses
    }
    private var report: AdminPTRequestReport { AdminPTRequestReport(rows: rows) }
    private var exportDateStamp: String {
        String(ISO8601DateFormatter().string(from: Date()).prefix(10))
    }

    var body: some View {
        List {
            if let message = admin.ptRequestStatusMessage {
                Label(
                    message,
                    systemImage: admin.ptRequestStatusIsWarning
                        ? "checkmark.shield.fill"
                        : "checkmark.circle.fill"
                )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(admin.ptRequestStatusIsWarning ? Color.orange : Color.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .listRowBackground(Color.xertInk)
            }
            Section("Filters") {
                Picker("Status", selection: $statusFilter) {
                    Text("Active").tag("active")
                    Text("All statuses").tag("all")
                    ForEach(["requested", "reschedule_requested", "approved", "completed", "declined", "cancelled"], id: \.self) {
                        Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0)
                    }
                }
                Picker("Session type", selection: $sessionTypeFilter) {
                    Text("All session types").tag("all")
                    ForEach(sessionTypes, id: \.self) { Text($0).tag($0) }
                }
                Picker("Submitted", selection: $ageFilter) {
                    Text("30 days").tag("30")
                    Text("90 days").tag("90")
                    Text("All time").tag("all")
                }
                .pickerStyle(.segmented)
            }
            .listRowBackground(Color.xertNavy)

            if requestsAreLoading {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading PT requests...")
                }
                .frame(minHeight: 44)
                .listRowBackground(Color.xertInk)
            } else if !requestsAreCurrent {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        admin.loadedSources.contains("PT requests")
                            ? "Showing the last PT request snapshot. Updates are paused until refresh succeeds."
                            : "Personal training could not be loaded. No empty queue assumption is being made.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await admin.refreshPTRequests(session: session) }
                    } label: {
                        Label(
                            admin.isLoading || admin.isRefreshingOperations ? "Retrying..." : "Retry PT requests",
                            systemImage: "arrow.clockwise"
                        )
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(admin.isLoading || admin.isRefreshingOperations)
                }
                .listRowBackground(Color.xertInk)
            }

            if admin.loadedSources.contains("PT requests") {
                Section(requestsAreCurrent ? "Matching workload" : "Last matching workload") {
                    HStack(spacing: 0) {
                        ptMetric("Total", rows.count)
                        ptMetric("New", report.requestedCount)
                        ptMetric("Approved", report.approvedCount)
                        ptMetric("Done", report.completedCount)
                    }
                    .padding(.vertical, 4)
                }
                .listRowBackground(Color.xertInk)
            }

            if !selectedIDs.isEmpty {
                Section("Bulk action") {
                    Text("\(selectedIDs.count) request\(selectedIDs.count == 1 ? "" : "s") selected")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.xertPale.opacity(0.7))
                    if bulkOptions.isEmpty {
                        Label(
                            "Select requests with the same actionable status.",
                            systemImage: "info.circle"
                        )
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                    } else {
                        Picker("Move selected to", selection: $bulkStatus) {
                            Text("Choose status").tag("")
                            ForEach(bulkOptions, id: \.self) {
                                Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0)
                            }
                        }
                        Button {
                            confirmingBulkUpdate = true
                        } label: {
                            Label("Update selected", systemImage: "arrow.triangle.2.circlepath")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.xertSteel)
                        .disabled(!requestsAreCurrent || bulkStatus.isEmpty || isMutating)
                    }
                    Button("Clear selection", role: .cancel) { selectedIDs = [] }
                }
                .listRowBackground(Color.xertInk)
            }

            if requestsAreCurrent && rows.isEmpty {
                Text("No matching PT requests.")
                    .listRowBackground(Color.xertInk)
            }
            ForEach(rows) { request in
                VStack(alignment: .leading, spacing: 10) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top) {
                            selectionButton(for: request)
                            ptRequestHeading(request)
                            Spacer()
                            ptStatus(request)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .top) {
                                selectionButton(for: request)
                                ptRequestHeading(request)
                                Spacer()
                            }
                            ptStatus(request)
                                .padding(.leading, 44)
                        }
                    }
                    Text([request.preferred_day, request.preferred_time].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                    Text("Submitted \(request.created_at.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption2)
                        .foregroundStyle(Color.xertPale.opacity(0.48))
                    if let goal = request.training_goal, !goal.isEmpty {
                        Text("Goal: \(goal)").font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            ptActions(for: request, expands: false)
                        }
                        VStack(spacing: 8) {
                            ptActions(for: request, expands: true)
                        }
                    }
                    .font(.caption.weight(.bold))
                }
                .foregroundStyle(Color.xertOffWhite)
                .padding(.vertical, 6)
                .listRowBackground(Color.xertInk)
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Personal training")
        .searchable(text: $query, prompt: "Name, contact, goal or notes")
        .refreshable { await admin.refreshPTRequests(session: session) }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    exportDocument = AdminIntakeCSVDocument(csv: report.csv)
                    isExporting = true
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(rows.isEmpty || !requestsAreCurrent)
                .accessibilityLabel("Export filtered PT requests")
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "xert-pt-requests-\(exportDateStamp)"
        ) { result in
            if case .failure(let error) = result {
                exportError = error.localizedDescription
            }
            exportDocument = nil
        }
        .alert("Export failed", isPresented: Binding(
            get: { exportError != nil },
            set: { if !$0 { exportError = nil } }
        )) {
            Button("OK", role: .cancel) { exportError = nil }
        } message: {
            Text(exportError ?? "The PT request report could not be exported.")
        }
        .confirmationDialog(
            "Update \(selectedIDs.count) PT requests?",
            isPresented: $confirmingBulkUpdate,
            titleVisibility: .visible
        ) {
            Button("Move to \(bulkStatus.replacingOccurrences(of: "_", with: " ").capitalized)") {
                let requests = selectedRequests
                Task {
                    let failedIDs = await admin.bulkUpdatePTRequests(
                        session: session,
                        requests: requests,
                        status: bulkStatus
                    )
                    selectedIDs = failedIDs
                    XertHaptics.play(
                        failedIDs.isEmpty && !admin.ptRequestStatusIsWarning
                            ? .success
                            : .warning
                    )
                    if selectedIDs.isEmpty { bulkStatus = "" }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only requests that fail will remain selected for retry.")
        }
        .task {
            if !admin.loadedSources.contains("PT requests") {
                await admin.refreshPTRequests(session: session)
            }
        }
        .onChange(of: admin.refreshUnavailableSources) { unavailable in
            if unavailable.contains("PT requests") {
                notesRequest = nil
            }
        }
        .onChange(of: statusFilter) { _ in resetSelection() }
        .onChange(of: sessionTypeFilter) { _ in resetSelection() }
        .onChange(of: ageFilter) { _ in resetSelection() }
        .onChange(of: query) { _ in resetSelection() }
        .sheet(item: $notesRequest) { request in
            NavigationStack {
                AdminPTRequestDetailView(
                    admin: admin,
                    session: session,
                    request: request,
                    mutationAllowed: requestsAreCurrent
                )
            }
        }
    }

    private func ptRequestHeading(_ request: AdminPTRequest) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(request.displayName).font(.headline)
            Text(request.requested_session_type)
                .font(.caption.weight(.bold)).foregroundStyle(Color.xertSteel)
        }
    }

    private func ptStatus(_ request: AdminPTRequest) -> some View {
        Text(request.status.replacingOccurrences(of: "_", with: " ").uppercased())
            .font(.caption2.weight(.bold))
            .foregroundStyle(request.isPending ? Color.orange : Color.xertPale.opacity(0.65))
            .fixedSize(horizontal: true, vertical: false)
    }

    private func selectionButton(for request: AdminPTRequest) -> some View {
        Button {
            if selectedIDs.contains(request.id) {
                selectedIDs.remove(request.id)
            } else if selectedIDs.count < 50 {
                selectedIDs.insert(request.id)
            }
            bulkStatus = ""
        } label: {
            Image(systemName: selectedIDs.contains(request.id) ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(selectedIDs.contains(request.id) ? Color.xertSteel : Color.xertPale.opacity(0.5))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .disabled(!requestsAreCurrent || isMutating)
        .accessibilityLabel(selectedIDs.contains(request.id) ? "Deselect \(request.displayName)" : "Select \(request.displayName)")
    }

    private func ptMetric(_ label: String, _ value: Int) -> some View {
        VStack(spacing: 3) {
            Text(value.formatted())
                .font(.headline.monospacedDigit())
                .foregroundStyle(Color.xertOffWhite)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.xertPale.opacity(0.58))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
    }

    private func resetSelection() {
        selectedIDs = []
        bulkStatus = ""
    }

    @ViewBuilder
    private func ptActions(for request: AdminPTRequest, expands: Bool) -> some View {
        HStack(spacing: 8) {
            if let phone = request.phone,
               let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                Link(destination: url) {
                    Image(systemName: "phone")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Call \(request.displayName)")
            }
            if let email = request.email, let url = URL(string: "mailto:\(email)") {
                Link(destination: url) {
                    Image(systemName: "envelope")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Email \(request.displayName)")
            }
        }

        Menu {
            ForEach(request.allowedNextStatuses, id: \.self) { next in
                requestAction(
                    next.replacingOccurrences(of: "_", with: " ").capitalized,
                    status: next,
                    request: request
                )
            }
        } label: {
            Label("Update", systemImage: "arrow.triangle.2.circlepath")
                .frame(maxWidth: expands ? .infinity : nil, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.xertSteel)
        .disabled(!requestsAreCurrent || isMutating || request.allowedNextStatuses.isEmpty)

        Button { notesRequest = request } label: {
            Label("Open", systemImage: "arrow.up.right.square")
                .frame(maxWidth: expands ? .infinity : nil, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .disabled(!requestsAreCurrent || isMutating)
        .accessibilityLabel("Open PT request for \(request.displayName)")
    }

    @ViewBuilder
    private func requestAction(_ title: String, status: String, request: AdminPTRequest) -> some View {
        Button(title) {
            Task {
                let succeeded = await admin.updatePTRequest(
                    session: session,
                    request: request,
                    status: status
                )
                XertHaptics.play(
                    !succeeded
                        ? .error
                        : (admin.ptRequestStatusIsWarning ? .warning : .success)
                )
            }
        }
    }

}

// Called from AdminLeadsView but previously declared inside AdminPTRequestsView,
// so both call sites failed with "cannot find 'leadAgeLabel' in scope". Declared
// at file scope now, which is where a helper shared between two desks belongs.
private func leadAgeLabel(_ lead: AdminLead, now: Date = Date()) -> String {
    guard lead.effectiveStatus == "new" else {
        return lead.created_at.formatted(date: .abbreviated, time: .omitted)
    }
    let hours = max(Int(now.timeIntervalSince(lead.created_at) / 3_600), 0)
    if hours < 1 { return "Waiting <1h" }
    if hours < 24 { return "Waiting \(hours)h" }
    return "Waiting \(max(hours / 24, 1))d"
}

private func leadAgeColour(_ lead: AdminLead, now: Date = Date()) -> Color {
    guard lead.effectiveStatus == "new" else {
        return Color.xertPale.opacity(0.42)
    }
    return now.timeIntervalSince(lead.created_at) >= 86_400 ? Color.red : Color.orange
}

private struct AdminIntakeCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    let csv: String

    init(csv: String) { self.csv = csv }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        csv = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(csv.utf8))
    }
}

private struct AdminPTRequestDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let request: AdminPTRequest
    let mutationAllowed: Bool
    private let baselineNotes: String
    private let baselineToken: String
    @State private var notes: String
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var notesFocused: Bool

    init(
        admin: AdminStore,
        session: AuthSession,
        request: AdminPTRequest,
        mutationAllowed: Bool
    ) {
        self.admin = admin
        self.session = session
        self.request = request
        self.mutationAllowed = mutationAllowed
        let initialNotes = request.admin_notes ?? ""
        let baselineToken = AdminIntakeDraftStore.baselineToken(
            status: request.status,
            notes: initialNotes
        )
        let recovered = AdminIntakeDraftStore.load(
            kind: .ptRequest,
            ownerID: session.user?.id,
            recordID: request.id.uuidString,
            baselineToken: baselineToken
        )
        baselineNotes = initialNotes
        self.baselineToken = baselineToken
        _notes = State(initialValue: recovered?.draft.notes ?? initialNotes)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    private var isDirty: Bool { notes != baselineNotes }
    private var isSaving: Bool { admin.updatingPTRequestID == request.id }

    var body: some View {
        Form {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Section {
                    Label(
                        "This PT request snapshot is not current. Contact and request details remain available, but workflow and notes are read-only.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .listRowBackground(Color.xertInk)
            }

            Section("Contact") {
                if let phone = nonBlank(request.phone),
                   let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                    Link(destination: url) {
                        Label(phone, systemImage: "phone")
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
                if let email = nonBlank(request.email),
                   let url = URL(string: "mailto:\(email)") {
                    Link(destination: url) {
                        Label(email, systemImage: "envelope")
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
                if nonBlank(request.phone) == nil && nonBlank(request.email) == nil {
                    Label("No contact details supplied", systemImage: "person.crop.circle.badge.exclamationmark")
                        .foregroundStyle(Color.orange)
                }
            }

            Section("Training request") {
                requestDetailRow("Session", request.requested_session_type)
                requestDetailRow(
                    "Submitted",
                    request.created_at.formatted(date: .abbreviated, time: .shortened)
                )
                optionalRequestDetailRow("Preferred day", request.preferred_day)
                optionalRequestDetailRow("Preferred time", request.preferred_time)
                optionalRequestDetailRow("Goal", request.training_goal)
                optionalRequestDetailRow("Experience", request.experience_level)
                if let memberNotes = nonBlank(request.notes) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("MEMBER NOTES")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.xertPale.opacity(0.52))
                        Text(memberNotes)
                            .foregroundStyle(Color.xertOffWhite)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            Section("Workflow") {
                requestDetailRow(
                    "Status",
                    request.status.replacingOccurrences(of: "_", with: " ").capitalized
                )
                if !request.allowedNextStatuses.isEmpty {
                    Menu {
                        ForEach(request.allowedNextStatuses, id: \.self) { status in
                            Button(status.replacingOccurrences(of: "_", with: " ").capitalized) {
                                updateStatus(status)
                            }
                        }
                    } label: {
                        Label("Update request status", systemImage: "arrow.triangle.2.circlepath")
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .disabled(!mutationAllowed || isDirty || isSaving)
                    .accessibilityHint(
                        isDirty
                            ? "Save or discard private notes before changing status"
                            : "Changes this request to its next valid workflow state"
                    )
                }
                if isDirty {
                    Label(
                        "Save or discard private notes before changing workflow status.",
                        systemImage: "square.and.pencil"
                    )
                    .font(.caption)
                    .foregroundStyle(Color.orange)
                }
            }

            Section("Private owner notes") {
                TextEditor(text: $notes)
                    .frame(minHeight: 160)
                    .focused($notesFocused)
                Text("\(notes.count)/5,000")
                    .font(.caption)
                    .foregroundStyle(notes.count > 5_000 ? Color.red : Color.xertPale.opacity(0.55))
            }
            .disabled(!mutationAllowed)
        }
        .tint(Color.xertSteel)
        .xertListBackground()
        .navigationTitle(request.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ptNotesSaveBar
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", action: requestDismiss)
                    .disabled(isSaving)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { notesFocused = false }
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: "PT request for \(request.displayName)",
            isDirty: isDirty,
            isBusy: isSaving
        )
        .interactiveDismissDisabled(isDirty || isSaving)
        .onChange(of: notes) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: notes) {
            await persistRecoveryDraft()
        }
        .confirmationDialog(
            "Discard PT notes?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard notes", role: .destructive) {
                clearRecoveryDraft()
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("The unsaved private notes for \(request.displayName) will be lost.")
        }
    }

    private var ptNotesSaveBar: some View {
        Button(action: save) {
            HStack(spacing: 10) {
                if isSaving { ProgressView().tint(Color.xertNavy) }
                Label(isSaving ? "Saving notes..." : "Save private notes", systemImage: "checkmark.circle")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.ptRequest.notes.save")
        .accessibilityHint(isDirty ? "Saves private owner notes for this PT request" : "Edit the notes before saving")
    }

    private var canSave: Bool {
        mutationAllowed && isDirty && !isSaving && notes.count <= 5_000
    }

    private func updateStatus(_ status: String) {
        notesFocused = false
        guard !isDirty else { return }
        Task {
            let didSave = await admin.updatePTRequest(
                session: session,
                request: request,
                status: status
            )
            if didSave {
                hasCommitted = true
                clearRecoveryDraft()
                XertHaptics.play(admin.ptRequestStatusIsWarning ? .warning : .success)
                dismiss()
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func save() {
        guard canSave else { return }
        notesFocused = false
        Task {
            let didSave = await admin.updatePTRequest(
                session: session,
                request: request,
                status: request.status,
                notes: notes,
                updateNotes: true
            )
            if didSave {
                hasCommitted = true
                clearRecoveryDraft()
                XertHaptics.play(admin.ptRequestStatusIsWarning ? .warning : .success)
                dismiss()
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func requestDismiss() {
        notesFocused = false
        if isDirty {
            confirmingDiscard = true
        } else if !isSaving {
            clearRecoveryDraft()
            dismiss()
        }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isSaving, notes.count <= 5_000 else { return }
        AdminIntakeDraftStore.save(
            AdminIntakeDraft(status: nil, notes: notes),
            kind: .ptRequest,
            ownerID: session.user?.id,
            recordID: request.id.uuidString,
            baselineToken: baselineToken
        )
    }

    private func discardRecoveredEdits() {
        notes = baselineNotes
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func clearRecoveryDraft() {
        AdminIntakeDraftStore.clear(
            kind: .ptRequest,
            ownerID: session.user?.id,
            recordID: request.id.uuidString
        )
    }

    private func requestDetailRow(_ label: String, _ value: String) -> some View {
        LabeledContent(label) {
            Text(value)
                .multilineTextAlignment(.trailing)
                .foregroundStyle(Color.xertOffWhite)
        }
    }

    @ViewBuilder
    private func optionalRequestDetailRow(_ label: String, _ value: String?) -> some View {
        if let value = nonBlank(value) {
            requestDetailRow(label, value)
        }
    }

    private func nonBlank(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct AdminPlatformView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let initialDraft: AdminPlatformSettings?
    let isExitSaving: Bool
    let onOpenPricing: () -> Void
    let onOpenNotices: () -> Void
    let onDraftChange: (AdminPlatformSettings?) -> Void
    @State private var draft: AdminPlatformSettings?
    @State private var lastLoadedSettings: AdminPlatformSettings?
    @State private var saved = false
    @State private var confirmingPaymentActivation = false
    @State private var staleDraftRequiresReset = false
    @State private var recoveredDraftAt: Date?
    @State private var hasEditedDuringPresentation = false

    private var pricingDataUnavailable: Bool {
        admin.refreshUnavailableSources.contains("session packs")
    }

    private var platformDataIsCurrent: Bool {
        admin.loadedSources.contains("platform controls")
            && !admin.refreshUnavailableSources.contains("platform controls")
    }

    private var platformDataUnavailable: Bool {
        !platformDataIsCurrent && admin.hasCompletedRefresh
    }

    private var platformMutationAvailable: Bool {
        platformDataIsCurrent
            && !admin.isLoading
            && !admin.isSavingSettings
            && !isExitSaving
            && !liveDraftConflict
    }

    private var liveDraftConflict: Bool {
        guard let draft, let live = admin.settings else { return false }
        return draft.id != live.id || draft.updated_at != live.updated_at
    }

    private var stripeHealthIsCurrent: Bool {
        admin.loadedSources.contains("Stripe health")
            && !admin.refreshUnavailableSources.contains("Stripe health")
            && admin.commerceHealth != nil
    }

    private var memberNoticeDataIsCurrent: Bool {
        admin.loadedSources.contains("member notices")
            && !admin.refreshUnavailableSources.contains("member notices")
    }

    private var bookingGuardReady: Bool? {
        guard admin.loadedSources.contains("schema health"),
              !admin.refreshUnavailableSources.contains("schema health") else { return nil }
        return admin.schemaCapabilities.contains { $0.capability == "member_booking_switch_guard" }
    }

    private var liveMemberNoticeCount: Int {
        admin.announcements.filter { $0.stateLabel == "Live" }.count
    }

    var body: some View {
        Group {
            if draft != nil {
                Form {
                    if let recoveredDraftAt {
                        AdminRecoveredCatalogueDraftNotice(
                            savedAt: recoveredDraftAt,
                            onDiscard: resetToLatestLiveSettings
                        )
                    }
                    if liveDraftConflict {
                        Section {
                            Label(
                                "Live controls changed after this draft began. Review the latest settings before making another change.",
                                systemImage: "exclamationmark.arrow.triangle.2.circlepath"
                            )
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                            .fixedSize(horizontal: false, vertical: true)
                            Button {
                                resetToLatestLiveSettings()
                            } label: {
                                Label("Load latest live controls", systemImage: "arrow.clockwise")
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.orange)
                        }
                        .accessibilityIdentifier("owner.platform.versionConflict")
                    }
                    if platformDataUnavailable {
                        Section {
                            Label(
                                "Live platform settings could not be refreshed. This last snapshot is read-only until a retry succeeds.",
                                systemImage: "clock.badge.exclamationmark"
                            )
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                            Button {
                                Task { await admin.refresh(session: session) }
                            } label: {
                                Label(admin.isLoading ? "Retrying…" : "Retry platform settings", systemImage: "arrow.clockwise")
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.orange)
                            .disabled(admin.isLoading || admin.isSavingSettings || isExitSaving)
                        }
                    } else if admin.isLoading {
                        Section {
                            Label("Refreshing live platform settings. Editing is paused until the latest snapshot settles.", systemImage: "arrow.clockwise")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.xertSteel)
                        }
                    }
                    Section("Booking provider") {
                        Toggle("Use FitBox for memberships & bookings", isOn: fitBoxEnabledBinding)
                            .disabled(!platformMutationAvailable)
                        Text("When FitBox is selected, website and iOS booking, membership and purchase actions hand off to FitBox. XERT's internal booking and Stripe checkout stay dormant.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.62))
                            .fixedSize(horizontal: false, vertical: true)
                        if draft?.fitbox_enabled == true {
                            TextField("https://secure-fitbox-booking-link", text: fitBoxURLBinding)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .disabled(!platformMutationAvailable)
                                .accessibilityLabel("FitBox secure booking link")
                            if draft?.providerResolution.isBlocked == true {
                                Label(
                                    "Add a credential-free HTTPS FitBox link before saving. Native booking and checkout will not be used as a fallback.",
                                    systemImage: "exclamationmark.triangle.fill"
                                )
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.orange)
                                .fixedSize(horizontal: false, vertical: true)
                            } else {
                                Label("FitBox handoff ready", systemImage: "checkmark.shield.fill")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.green)
                            }
                        } else {
                            Label("XERT native booking selected", systemImage: "checkmark.shield")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.xertSteel)
                        }
                    }
                    Section("Member app experience") {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("XERT member companion", systemImage: "iphone.gen3")
                                .font(.headline)
                                .foregroundStyle(Color.xertOffWhite)
                            Text("Members can browse published content and manage only their own credits, bookings, purchases, PT requests, goals and notification preferences. Owner workspaces and other member records stay protected.")
                                .font(.caption)
                                .foregroundStyle(Color.xertPale.opacity(0.7))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 4)

                        memberCapabilityRow(
                            title: "Class booking",
                            value: draft?.fitbox_enabled == true
                                ? (draft?.providerResolution.isBlocked == true ? "FitBox needs attention" : "Continue to FitBox")
                                : (draft?.bookings_enabled == true ? "Book & waitlist" : "Interest only"),
                            icon: "calendar.badge.plus",
                            color: draft?.providerResolution.isBlocked == true
                                ? .orange
                                : (draft?.bookings_enabled == true || draft?.fitbox_enabled == true ? .green : Color.xertSteel)
                        )
                        memberCapabilityRow(
                            title: "Booking protection",
                            value: draft?.fitbox_enabled == true
                                ? "FitBox handoff"
                                : (bookingGuardReady.map { $0 ? "Verified" : "Migration required" } ?? "Unavailable"),
                            icon: "checkmark.shield",
                            color: draft?.fitbox_enabled == true
                                ? Color.xertSteel
                                : (bookingGuardReady == true ? .green : .orange)
                        )
                        memberCapabilityRow(
                            title: "Session packs",
                            value: draft?.fitbox_enabled == true
                                ? "Managed in FitBox"
                                : (draft?.payments_enabled == true ? "Checkout live" : "Browse only"),
                            icon: "ticket",
                            color: draft?.fitbox_enabled == true
                                ? .green
                                : (draft?.payments_enabled == true ? .green : Color.xertSteel)
                        )
                        memberCapabilityRow(
                            title: "Member notices",
                            value: memberNoticeDataIsCurrent
                                ? (liveMemberNoticeCount == 0 ? "None live" : "\(liveMemberNoticeCount) live")
                                : "Unavailable",
                            icon: "bell.badge",
                            color: memberNoticeDataIsCurrent ? Color.xertSteel : .orange
                        )

                        Button(action: onOpenNotices) {
                            Label("Manage member notices", systemImage: "arrow.right.circle")
                        }
                        .disabled(admin.isLoading || admin.isSavingSettings || isExitSaving)
                    }
                    Section("Pack sales") {
                        Toggle("Show 'Coming soon' instead of prices", isOn: settingBinding(\.prices_coming_soon))
                            .disabled(!platformMutationAvailable || draft?.fitbox_enabled == true)
                        Text("Turn this off when Byron is ready for members to see the live pack prices on web and iOS.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.6))
                        LabeledContent(
                            "Active session packs",
                            value: pricingDataUnavailable ? "Unavailable" : "\(admin.products.filter(\.active).count)"
                        )
                        LabeledContent(
                            "Stripe-linked active packs",
                            value: pricingDataUnavailable
                                ? "Unavailable"
                                : "\(admin.products.filter { $0.active && $0.hasStableStripePriceID }.count)"
                        )
                        Button(action: requestPricingNavigation) {
                            Label("Open session packs & pricing", systemImage: "ticket")
                        }
                        .disabled(admin.isLoading || admin.isSavingSettings || isExitSaving)
                        if pricingDataUnavailable {
                            Label("Session-pack data could not be refreshed. Pricing counts may be stale.", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                                .font(.caption).foregroundStyle(.orange)
                        } else if draft?.payments_enabled == true,
                           admin.products.contains(where: { $0.active && !$0.hasStableStripePriceID }) {
                            Label("Checkout is enabled but an active pack is missing its Stripe Price ID.", systemImage: "exclamationmark.triangle.fill")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }
                    Section("Member booking & purchases") {
                        Toggle("Bookings enabled", isOn: bookingsEnabledBinding)
                            .disabled(!platformMutationAvailable || draft?.fitbox_enabled == true)
                        Text("Controls both website and iOS class actions. Turning bookings off also pauses checkout.")
                            .font(.caption).foregroundStyle(Color.xertPale.opacity(0.55))
                        Toggle("Session pack payments", isOn: settingBinding(\.payments_enabled))
                            .disabled(
                                !platformMutationAvailable
                                    || draft?.fitbox_enabled == true
                                    || (draft?.bookings_enabled != true && draft?.payments_enabled != true)
                            )
                        Text("Master checkout switch for pack purchases on the website and iOS app. Keep off until Stripe launch checks pass.")
                            .font(.caption).foregroundStyle(Color.xertPale.opacity(0.55))
                        if draft?.fitbox_enabled == true {
                            Label("These native controls are dormant while FitBox is selected.", systemImage: "arrow.up.forward.app")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.xertSteel)
                        } else if draft?.bookings_enabled != true && draft?.payments_enabled != true {
                            Label("Open bookings and complete the booking smoke test before enabling payments.", systemImage: "lock.shield")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.xertSteel)
                        }
                        Toggle("Launch countdown", isOn: settingBinding(\.countdown_enabled))
                            .disabled(!platformMutationAvailable)
                    }
                    Section("Public announcement") {
                        Toggle("Show announcement banner", isOn: settingBinding(\.announcement_banner_enabled))
                        TextField("Announcement text", text: announcementBinding, axis: .vertical)
                            .lineLimit(2...5)
                    }
                    .disabled(!platformMutationAvailable)
                    Section("Launch") {
                        TextField("Target date (YYYY-MM-DD)", text: settingBinding(\.target_launch_date))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    .disabled(!platformMutationAvailable)
                }
                .scrollContentBackground(.hidden)
                .scrollDismissesKeyboard(.interactively)
            } else if admin.isLoading || !platformDataUnavailable {
                ProgressView("Loading platform settings...").tint(Color.xertSteel)
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundStyle(Color.orange)
                    Text("Platform settings unavailable")
                        .font(.headline)
                        .foregroundStyle(Color.xertOffWhite)
                    Text("No safe settings snapshot is available. Retry before changing bookings, payments or public announcements.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color.xertPale.opacity(0.72))
                    Button {
                        Task { await admin.refresh(session: session) }
                    } label: {
                        Label("Retry platform settings", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                }
                .padding(24)
                .frame(maxWidth: 520, maxHeight: .infinity)
                .frame(maxWidth: .infinity)
            }
        }
        .xertOwnerScreen()
        .navigationTitle("Settings")
        .onAppear {
            let live = admin.settings
            let recovered: AdminCatalogueDraftSnapshot<AdminPlatformSettings>? =
                initialDraft == nil
                    ? AdminCatalogueDraftStore.load(
                        kind: .platformSettings,
                        ownerID: session.user?.id,
                        recordID: live?.id,
                        baselineToken: live?.updated_at
                    )
                    : nil
            draft = initialDraft ?? recovered?.draft ?? live
            recoveredDraftAt = recovered?.savedAt
            lastLoadedSettings = live
            staleDraftRequiresReset = platformDataUnavailable
            onDraftChange(draft)
        }
        .onChange(of: admin.settings) { settings in
            if draft == nil || draft == lastLoadedSettings {
                draft = settings
                recoveredDraftAt = nil
                clearRecoveryDraft()
            } else if draft?.updated_at != settings?.updated_at {
                recoveredDraftAt = nil
                clearRecoveryDraft()
            }
            lastLoadedSettings = settings
        }
        .onChange(of: draft) { value in
            hasEditedDuringPresentation = true
            if value != admin.settings { saved = false }
            onDraftChange(value)
        }
        .onChange(of: platformDataUnavailable) { isUnavailable in
            if isUnavailable {
                staleDraftRequiresReset = true
                saved = false
            } else if staleDraftRequiresReset {
                resetToLatestLiveSettings()
                staleDraftRequiresReset = false
            }
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if draft != nil { platformSaveBar }
        }
        .confirmationDialog("Open session pack checkout?", isPresented: $confirmingPaymentActivation, titleVisibility: .visible) {
            Button("Enable pack checkout") {
                guard let draft else { return }
                save(draft)
            }
            Button("Keep payments paused", role: .cancel) {}
        } message: {
            Text(stripeHealthIsCurrent && admin.commerceHealth?.ready == true
                ? "Stripe launch checks passed recently. XERT will run them again on the server before enabling purchases."
                : "XERT will run every Stripe launch check on the server. Payments remain paused if any check fails.")
        }
    }

    private var platformSaveBar: some View {
        Button {
            guard let draft else { return }
            XertHaptics.play(.lightImpact)
            if draft.payments_enabled && admin.settings?.payments_enabled != true {
                confirmingPaymentActivation = true
            } else {
                save(draft)
            }
        } label: {
            HStack(spacing: 10) {
                if admin.isSavingSettings { ProgressView().tint(Color.xertNavy) }
                Image(systemName: saved ? "checkmark.circle.fill" : "checkmark.shield")
                Text(saved ? "Live settings saved" : "Save live settings")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSavePlatformSettings ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSavePlatformSettings)
        .accessibilityIdentifier("owner.platform.save")
        .accessibilityHint("Saves booking, pricing visibility, payment, countdown and public announcement settings")
    }

    private var canSavePlatformSettings: Bool {
        !admin.isSavingSettings
            && platformMutationAvailable
            && draft != nil
            && draft != admin.settings
            && draft?.providerResolution.isBlocked != true
    }

    private func requestPricingNavigation() {
        guard !admin.isLoading else { return }
        onOpenPricing()
    }

    private func save(_ settings: AdminPlatformSettings) {
        guard platformMutationAvailable else { return }
        Task {
            saved = await admin.saveSettings(session: session, draft: settings)
            if saved {
                XertHaptics.play(.success)
                recoveredDraftAt = nil
                clearRecoveryDraft()
                draft = admin.settings
            } else {
                XertHaptics.play(.error)
            }
        }
    }

    private func persistRecoveryDraft() async {
        guard
            let draft,
            let live = admin.settings,
            draft != live,
            draft.id == live.id,
            draft.updated_at == live.updated_at,
            platformDataIsCurrent
        else {
            if hasEditedDuringPresentation && draft == admin.settings {
                clearRecoveryDraft()
            }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard
            !Task.isCancelled,
            !admin.isSavingSettings,
            draft == self.draft,
            draft.updated_at == admin.settings?.updated_at
        else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .platformSettings,
            ownerID: session.user?.id,
            recordID: live.id,
            baselineToken: live.updated_at
        )
    }

    private func resetToLatestLiveSettings() {
        clearRecoveryDraft()
        draft = admin.settings
        lastLoadedSettings = admin.settings
        recoveredDraftAt = nil
        saved = false
        XertHaptics.play(.softImpact)
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .platformSettings,
            ownerID: session.user?.id,
            recordID: draft?.id ?? admin.settings?.id
        )
    }

    private func settingBinding<Value>(_ keyPath: WritableKeyPath<AdminPlatformSettings, Value>) -> Binding<Value> {
        Binding(
            get: { draft![keyPath: keyPath] },
            set: {
                guard var value = draft else { return }
                value[keyPath: keyPath] = $0
                draft = value
            }
        )
    }

    private var announcementBinding: Binding<String> {
        Binding(
            get: { draft?.announcementText ?? "" },
            set: {
                guard var value = draft else { return }
                value.announcementText = $0
                draft = value
            }
        )
    }

    private var bookingsEnabledBinding: Binding<Bool> {
        Binding(
            get: { draft?.bookings_enabled == true },
            set: { isEnabled in
                guard var value = draft else { return }
                value.bookings_enabled = isEnabled
                if !isEnabled {
                    value.payments_enabled = false
                }
                draft = value
            }
        )
    }

    private var fitBoxEnabledBinding: Binding<Bool> {
        Binding(
            get: { draft?.fitbox_enabled == true },
            set: { isEnabled in
                guard var value = draft else { return }
                value.fitbox_enabled = isEnabled
                if isEnabled {
                    value.payments_enabled = false
                }
                draft = value
            }
        )
    }

    private var fitBoxURLBinding: Binding<String> {
        Binding(
            get: { draft?.fitbox_booking_url ?? "" },
            set: { url in
                guard var value = draft else { return }
                value.fitbox_booking_url = url
                draft = value
            }
        )
    }

    private func memberCapabilityRow(
        title: String,
        value: String,
        icon: String,
        color: Color
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .frame(width: 22)
            Text(title)
                .foregroundStyle(Color.xertOffWhite)
            Spacer(minLength: 12)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
                .multilineTextAlignment(.trailing)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(value)")
    }
}

private struct AdminAnnouncementDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let announcement: AdminAnnouncement
    @State private var editor: AdminAnnouncementEditorContext?
    @State private var pendingAction: AdminAnnouncementConfirmation?

    private var noticesAreCurrent: Bool {
        admin.loadedSources.contains("member notices")
            && !admin.refreshUnavailableSources.contains("member notices")
            && !admin.isLoading
    }

    private var isBusy: Bool {
        admin.isMutatingAnnouncements
    }

    private var currentAnnouncement: AdminAnnouncement {
        admin.announcements.first(where: { $0.id == announcement.id }) ?? announcement
    }

    private var deliveryMetrics: AdminAnnouncementDeliveryMetrics? {
        admin.announcementDeliveryMetrics[currentAnnouncement.id]
    }

    var body: some View {
        List {
            if !noticesAreCurrent {
                Section {
                    Label(
                        admin.announcementLoadErrorMessage
                            ?? "Refresh the notice before changing member visibility.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)

                    Button {
                        Task { await admin.refreshAnnouncements(session: session) }
                    } label: {
                        Label("Refresh member notice", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(isBusy)
                }
                .listRowBackground(Color.xertInk)
            }

            if let status = admin.announcementStatusMessage {
                Section {
                    Label(status, systemImage: "checkmark.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.green)
                }
                .listRowBackground(Color.green.opacity(0.08))
            }

            Section("Notice") {
                VStack(alignment: .leading, spacing: 12) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            noticeStatus
                            Spacer(minLength: 8)
                            Text(currentAnnouncement.tone.uppercased())
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Color.xertPale.opacity(0.5))
                        }
                        VStack(alignment: .leading, spacing: 7) {
                            noticeStatus
                            Text(currentAnnouncement.tone.uppercased())
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Color.xertPale.opacity(0.5))
                        }
                    }

                    Text(currentAnnouncement.title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(Color.xertOffWhite)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(currentAnnouncement.body)
                        .font(.body)
                        .foregroundStyle(Color.xertPale.opacity(0.78))
                        .fixedSize(horizontal: false, vertical: true)

                    if let label = currentAnnouncement.cta_label,
                       let url = currentAnnouncement.cta_url {
                        Label("\(label) · \(url)", systemImage: "arrow.up.forward.app")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.xertSteel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 6)
            }
            .listRowBackground(Color.xertInk)

            Section("Lifecycle") {
                detailRow(
                    "Created",
                    value: currentAnnouncement.created_at.formatted(
                        date: .abbreviated,
                        time: .shortened
                    ),
                    icon: "clock"
                )
                if let firstPublished = currentAnnouncement.first_published_at {
                    detailRow(
                        "First published",
                        value: firstPublished.formatted(
                            date: .abbreviated,
                            time: .shortened
                        ),
                        icon: "paperplane"
                    )
                }
                if let expiry = currentAnnouncement.expires_at {
                    detailRow(
                        "Expires",
                        value: expiry.formatted(date: .abbreviated, time: .shortened),
                        icon: "calendar.badge.clock"
                    )
                }
            }
            .listRowBackground(Color.xertInk)

            if currentAnnouncement.wasPublished {
                Section("Member reach") {
                    if let metrics = deliveryMetrics {
                        detailRow(
                            "Opened",
                            value: metrics.readCount.formatted(),
                            icon: "eye"
                        )
                        detailRow(
                            "Dismissed",
                            value: metrics.dismissedCount.formatted(),
                            icon: "xmark.circle"
                        )
                        detailRow(
                            "Push attempted",
                            value: metrics.pushAttemptedCount.formatted(),
                            icon: "paperplane"
                        )
                        detailRow(
                            "Push delivered",
                            value: metrics.pushDeliveredCount.formatted(),
                            icon: "iphone.radiowaves.left.and.right"
                        )
                        if metrics.pushFailedCount > 0 {
                            detailRow(
                                "Push failed",
                                value: metrics.pushFailedCount.formatted(),
                                icon: "exclamationmark.triangle"
                            )
                        }
                        if let attemptedAt = metrics.pushLastAttemptedAt {
                            detailRow(
                                "Last push attempt",
                                value: attemptedAt.formatted(date: .abbreviated, time: .shortened),
                                icon: "clock.arrow.circlepath"
                            )
                        }
                    } else {
                        Label(
                            admin.announcementDeliveryStatusMessage
                                ?? "No delivery attempts have been recorded for this notice.",
                            systemImage: admin.announcementDeliveryStatusMessage == nil
                                ? "iphone.slash"
                                : "wifi.exclamationmark"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(
                            admin.announcementDeliveryStatusMessage == nil
                                ? Color.xertPale.opacity(0.62)
                                : Color.orange
                        )
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .listRowBackground(Color.xertInk)
            }

            Section("Actions") {
                if currentAnnouncement.archived_at == nil {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { primaryActions }
                        VStack(spacing: 10) { primaryActions }
                    }
                    .listRowInsets(
                        EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
                    )
                }

                if currentAnnouncement.archived_at != nil {
                    Button {
                        confirm(.restore(currentAnnouncement))
                    } label: {
                        Label("Restore as draft", systemImage: "archivebox")
                    }
                } else if currentAnnouncement.wasPublished {
                    Button {
                        confirm(.archive(currentAnnouncement))
                    } label: {
                        Label("Archive with delivery history", systemImage: "archivebox")
                    }
                    .foregroundStyle(Color.orange)
                } else {
                    Button(role: .destructive) {
                        confirm(.delete(currentAnnouncement))
                    } label: {
                        Label("Delete unpublished draft", systemImage: "trash")
                    }
                }
            }
            .listRowBackground(Color.xertInk)
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Member Notice")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { dismiss() }
                    .disabled(isBusy)
            }
        }
        .sheet(item: $editor) { context in
            AdminAnnouncementComposer(
                announcement: context.announcement,
                ownerID: session.user?.id,
                publishesOnOpen: context.publishesOnOpen,
                isSaving: admin.announcementMutationID != nil,
                isPublishing: admin.isPublishingAnnouncement,
                onSave: { draft in
                    let succeeded = await admin.saveAnnouncement(
                        session: session,
                        announcement: context.announcement,
                        draft: draft
                    )
                    XertHaptics.play(succeeded ? .success : .error)
                    return succeeded
                },
                onPublish: { draft, requestID in
                    let succeeded = await admin.publishAnnouncement(
                        session: session,
                        announcement: context.announcement,
                        draft: draft,
                        requestID: requestID
                    )
                    XertHaptics.play(succeeded ? .success : .error)
                    return succeeded
                }
            )
        }
        .confirmationDialog(
            pendingAction?.title ?? "Confirm notice action",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let action = pendingAction {
                Button(
                    action.confirmLabel,
                    role: action.isDestructive ? .destructive : nil
                ) {
                    perform(action)
                }
                Button("Cancel", role: .cancel) { pendingAction = nil }
            }
        } message: {
            Text(pendingAction?.message ?? "")
        }
        .accessibilityIdentifier("owner.notice.detail")
    }

    private var noticeStatus: some View {
        Label(
            currentAnnouncement.stateLabel.uppercased(),
            systemImage: currentAnnouncement.published_at == nil ? "eye.slash" : "eye.fill"
        )
        .font(.caption.weight(.black))
        .foregroundStyle(stateColour)
    }

    private var stateColour: Color {
        switch currentAnnouncement.stateLabel {
        case "Live": return .green
        case "Expired", "Archived": return .orange
        case "Scheduled": return Color.xertSteel
        default: return Color.xertPale.opacity(0.62)
        }
    }

    @ViewBuilder
    private var primaryActions: some View {
        if currentAnnouncement.archived_at == nil {
            Button {
                editor = .init(announcement: currentAnnouncement)
            } label: {
                Label("Edit notice", systemImage: "pencil")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.xertSteel)
            .disabled(isBusy || !noticesAreCurrent)
            .accessibilityIdentifier("owner.notice.edit")

            if currentAnnouncement.published_at == nil {
                Button {
                    editor = .init(
                        announcement: currentAnnouncement,
                        publishesOnOpen: true
                    )
                } label: {
                    Label("Review & publish", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.xertSteel)
                .foregroundStyle(Color.xertNavy)
                .disabled(isBusy || !noticesAreCurrent)
                .accessibilityIdentifier("owner.notice.reviewPublish")
            } else {
                Button {
                    confirm(.unpublish(currentAnnouncement))
                } label: {
                    Label("Unpublish now", systemImage: "eye.slash.fill")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.orange)
                .disabled(isBusy || !noticesAreCurrent)
                .accessibilityHint("Hides this exact notice from member accounts after confirmation")
                .accessibilityIdentifier("owner.notice.unpublish")
            }
        }
    }

    private func detailRow(
        _ title: String,
        value: String,
        icon: String
    ) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                Label(title, systemImage: icon)
                    .foregroundStyle(Color.xertPale.opacity(0.68))
                Spacer(minLength: 8)
                Text(value)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.xertOffWhite)
            }
            VStack(alignment: .leading, spacing: 5) {
                Label(title, systemImage: icon)
                    .foregroundStyle(Color.xertPale.opacity(0.68))
                Text(value)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.xertOffWhite)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func confirm(_ action: AdminAnnouncementConfirmation) {
        pendingAction = action
        XertHaptics.play(action.isDestructive ? .warning : .lightImpact)
    }

    private func perform(_ action: AdminAnnouncementConfirmation) {
        pendingAction = nil
        Task {
            let succeeded: Bool
            switch action {
            case .unpublish(let notice):
                succeeded = await admin.unpublishAnnouncement(
                    session: session,
                    announcement: notice
                )
            case .archive(let notice):
                succeeded = await admin.setAnnouncementArchived(
                    session: session,
                    announcement: notice,
                    archived: true
                )
            case .restore(let notice):
                succeeded = await admin.setAnnouncementArchived(
                    session: session,
                    announcement: notice,
                    archived: false
                )
            case .delete(let notice):
                succeeded = await admin.deleteAnnouncement(
                    session: session,
                    announcement: notice
                )
            }
            if succeeded, case .delete(let notice) = action {
                AdminAnnouncementDraftStore.clear(
                    ownerID: session.user?.id,
                    announcementID: notice.id
                )
            }
            XertHaptics.play(succeeded ? .success : .error)
        }
    }
}

private struct AdminCommunicationsView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var editor: AdminAnnouncementEditorContext?
    @State private var pendingAction: AdminAnnouncementConfirmation?

    private var noticesAreCurrent: Bool {
        admin.loadedSources.contains("member notices")
            && !admin.refreshUnavailableSources.contains("member notices")
    }

    private var stateCounts: [String: Int] {
        Dictionary(grouping: admin.announcements, by: \.stateLabel)
            .mapValues { $0.count }
    }

    var body: some View {
        List {
            Section {
                AdminAnnouncementStatusStrip(counts: stateCounts)
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
            }

            if !noticesAreCurrent {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(
                            admin.announcementLoadErrorMessage
                                ?? (admin.loadedSources.contains("member notices")
                                    ? "Showing the last notice snapshot. Refresh before publishing or changing visibility."
                                    : "Member notices are unavailable. Refresh before managing communications."),
                            systemImage: "wifi.exclamationmark"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        Button { refreshNotices() } label: {
                            Label("Refresh member notices", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.orange)
                        .disabled(admin.isMutatingAnnouncements)
                    }
                    .listRowBackground(Color.xertInk)
                }
            }
            if let status = admin.announcementStatusMessage {
                Section {
                    Label(status, systemImage: "checkmark.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.green)
                }
                .listRowBackground(Color.green.opacity(0.08))
            }
            if let warning = admin.announcementDeliveryStatusMessage {
                Section {
                    Label(warning, systemImage: "chart.bar.xaxis")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .listRowBackground(Color.orange.opacity(0.08))
            }

            if admin.announcements.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "bell.slash")
                        .font(.title2)
                        .foregroundStyle(Color.xertSteel)
                    Text("No app notices")
                        .font(.headline)
                        .foregroundStyle(Color.xertOffWhite)
                    Text(noticesAreCurrent
                        ? "Create a private draft or publish an operational update."
                        : "Refresh to check the communications desk.")
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color.xertPale.opacity(0.6))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 28)
                .listRowBackground(Color.xertInk)
            }
            ForEach(admin.announcements) { notice in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(notice.stateLabel.uppercased())
                                    .font(.caption2.weight(.black))
                                    .tracking(0.8)
                                    .foregroundStyle(stateColour(notice.stateLabel))
                                Text(notice.tone.uppercased())
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(Color.xertPale.opacity(0.48))
                            }
                            Text(notice.title)
                                .font(.headline)
                                .foregroundStyle(Color.xertOffWhite)
                        }
                        Spacer(minLength: 8)
                        Menu {
                            if notice.archived_at != nil {
                                Button { confirm(.restore(notice)) } label: {
                                    Label("Restore as draft", systemImage: "archivebox")
                                }
                            } else {
                                Button { editor = .init(announcement: notice) } label: {
                                    Label("Edit notice", systemImage: "pencil")
                                }
                                if notice.published_at == nil {
                                    Button { editor = .init(announcement: notice, publishesOnOpen: true) } label: {
                                        Label("Review and publish", systemImage: "paperplane")
                                    }
                                } else {
                                    Button { confirm(.unpublish(notice)) } label: {
                                        Label("Unpublish", systemImage: "eye.slash")
                                    }
                                }
                                if notice.wasPublished {
                                    Button { confirm(.archive(notice)) } label: {
                                        Label("Archive", systemImage: "archivebox")
                                    }
                                } else {
                                    Button(role: .destructive) { confirm(.delete(notice)) } label: {
                                        Label("Delete draft", systemImage: "trash")
                                    }
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .font(.title3)
                                .frame(width: 44, height: 44)
                        }
                        .disabled(admin.isMutatingAnnouncements || !noticesAreCurrent)
                        .accessibilityLabel("Actions for \(notice.title)")
                    }
                    Text(notice.body)
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale.opacity(0.72))
                        .lineLimit(5)
                    ViewThatFits(in: .horizontal) {
                        noticeMetadata(notice)
                        VStack(alignment: .leading, spacing: 5) {
                            noticeMetadataItems(notice)
                        }
                    }
                    if let label = notice.cta_label, let url = notice.cta_url {
                        Label("\(label) · \(url)", systemImage: "arrow.up.forward.app")
                            .font(.caption2)
                            .foregroundStyle(Color.xertSteel)
                            .lineLimit(2)
                    }
                    if notice.wasPublished,
                       let metrics = admin.announcementDeliveryMetrics[notice.id] {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) {
                                deliveryMetricItems(metrics)
                            }
                            VStack(alignment: .leading, spacing: 5) {
                                deliveryMetricItems(metrics)
                            }
                        }
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.xertPale.opacity(0.62))
                    }
                }
                .disabled(!noticesAreCurrent)
                .foregroundStyle(Color.xertOffWhite)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
                .onTapGesture {
                    guard noticesAreCurrent, !admin.isMutatingAnnouncements, notice.archived_at == nil else { return }
                    editor = .init(announcement: notice)
                }
                .listRowBackground(Color.xertInk)
                .accessibilityElement(children: .contain)
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("App notices")
        .refreshable { await admin.refreshAnnouncements(session: session) }
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button { refreshNotices() } label: {
                    if admin.isRefreshingAnnouncements {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(admin.isMutatingAnnouncements || admin.isRefreshingAnnouncements)
                .accessibilityLabel("Refresh member notices")
                Button { editor = .init(announcement: nil) } label: {
                    Image(systemName: "plus")
                }
                .disabled(admin.isMutatingAnnouncements || !noticesAreCurrent)
                .accessibilityLabel("New member notice")
            }
        }
        .sheet(item: $editor) { context in
            AdminAnnouncementComposer(
                announcement: context.announcement,
                ownerID: session.user?.id,
                publishesOnOpen: context.publishesOnOpen,
                isSaving: admin.announcementMutationID != nil,
                isPublishing: admin.isPublishingAnnouncement,
                onSave: { draft in
                    let succeeded = await admin.saveAnnouncement(
                        session: session,
                        announcement: context.announcement,
                        draft: draft
                    )
                    XertHaptics.play(succeeded ? .success : .error)
                    return succeeded
                },
                onPublish: { draft, requestID in
                    let succeeded = await admin.publishAnnouncement(
                        session: session,
                        announcement: context.announcement,
                        draft: draft,
                        requestID: requestID
                    )
                    XertHaptics.play(succeeded ? .success : .error)
                    return succeeded
                }
            )
        }
        .confirmationDialog(
            pendingAction?.title ?? "Confirm notice action",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let action = pendingAction {
                Button(action.confirmLabel, role: action.isDestructive ? .destructive : nil) {
                    perform(action)
                }
                Button("Cancel", role: .cancel) { pendingAction = nil }
            }
        } message: {
            Text(pendingAction?.message ?? "")
        }
    }

    private func noticeMetadata(_ notice: AdminAnnouncement) -> some View {
        HStack(spacing: 12) {
            noticeMetadataItems(notice)
        }
    }

    @ViewBuilder
    private func noticeMetadataItems(_ notice: AdminAnnouncement) -> some View {
        Label(notice.created_at.formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
        if let expiresAt = notice.expires_at {
            Label("Expires \(expiresAt.formatted(date: .abbreviated, time: .shortened))", systemImage: "calendar.badge.clock")
        }
    }

    private func stateColour(_ state: String) -> Color {
        switch state {
        case "Live": return .green
        case "Expired", "Archived": return .orange
        case "Scheduled": return Color.xertSteel
        default: return Color.xertPale.opacity(0.55)
        }
    }

    @ViewBuilder
    private func deliveryMetricItems(_ metrics: AdminAnnouncementDeliveryMetrics) -> some View {
        Label("\(metrics.readCount) opened", systemImage: "eye")
        Label("\(metrics.pushDeliveredCount) pushed", systemImage: "iphone.radiowaves.left.and.right")
        if metrics.pushFailedCount > 0 {
            Label("\(metrics.pushFailedCount) failed", systemImage: "exclamationmark.triangle")
                .foregroundStyle(Color.orange)
        }
    }

    private func refreshNotices() {
        XertHaptics.play(.softImpact)
        Task { await admin.refreshAnnouncements(session: session) }
    }

    private func confirm(_ action: AdminAnnouncementConfirmation) {
        pendingAction = action
        XertHaptics.play(action.isDestructive ? .warning : .lightImpact)
    }

    private func perform(_ action: AdminAnnouncementConfirmation) {
        pendingAction = nil
        Task {
            let succeeded: Bool
            switch action {
            case .unpublish(let notice):
                succeeded = await admin.unpublishAnnouncement(session: session, announcement: notice)
            case .archive(let notice):
                succeeded = await admin.setAnnouncementArchived(session: session, announcement: notice, archived: true)
            case .restore(let notice):
                succeeded = await admin.setAnnouncementArchived(session: session, announcement: notice, archived: false)
            case .delete(let notice):
                succeeded = await admin.deleteAnnouncement(session: session, announcement: notice)
            }
            if succeeded, case .delete(let notice) = action {
                AdminAnnouncementDraftStore.clear(
                    ownerID: session.user?.id,
                    announcementID: notice.id
                )
            }
            XertHaptics.play(succeeded ? .success : .error)
        }
    }
}

private struct AdminAnnouncementStatusStrip: View {
    let counts: [String: Int]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(["Live", "Draft", "Scheduled", "Expired", "Archived"], id: \.self) { state in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(counts[state, default: 0].formatted())
                            .font(.headline.monospacedDigit())
                            .foregroundStyle(Color.xertOffWhite)
                        Text(state.uppercased())
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.xertSteel)
                    }
                    .frame(minWidth: 84, minHeight: 56, alignment: .leading)
                    .padding(.horizontal, 12)
                    .background(Color.xertInk)
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color.xertSteel.opacity(0.24), lineWidth: 1)
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Notice status totals")
    }
}

private struct AdminAnnouncementEditorContext: Identifiable {
    let id = UUID()
    let announcement: AdminAnnouncement?
    var publishesOnOpen = false
}

private enum AdminAnnouncementConfirmation: Identifiable {
    case unpublish(AdminAnnouncement)
    case archive(AdminAnnouncement)
    case restore(AdminAnnouncement)
    case delete(AdminAnnouncement)

    var id: String {
        switch self {
        case .unpublish(let notice): return "unpublish:\(notice.id)"
        case .archive(let notice): return "archive:\(notice.id)"
        case .restore(let notice): return "restore:\(notice.id)"
        case .delete(let notice): return "delete:\(notice.id)"
        }
    }

    var notice: AdminAnnouncement {
        switch self {
        case .unpublish(let value), .archive(let value), .restore(let value), .delete(let value):
            return value
        }
    }

    var title: String {
        switch self {
        case .unpublish: return "Unpublish this notice?"
        case .archive: return "Archive this notice?"
        case .restore: return "Restore this notice as a draft?"
        case .delete: return "Delete this draft?"
        }
    }

    var message: String {
        switch self {
        case .unpublish:
            return "Members will no longer see \(notice.title). Delivery and read history remain intact."
        case .archive:
            return "Member visibility is turned off and delivery history is preserved."
        case .restore:
            return "The notice returns as a hidden draft for review before publishing again."
        case .delete:
            return "This unpublished draft will be permanently deleted."
        }
    }

    var confirmLabel: String {
        switch self {
        case .unpublish: return "Unpublish"
        case .archive: return "Archive"
        case .restore: return "Restore Draft"
        case .delete: return "Delete Draft"
        }
    }

    var isDestructive: Bool {
        switch self {
        case .archive, .delete: return true
        case .unpublish, .restore: return false
        }
    }
}

private struct AdminOperationsHealthView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let onOpenTask: (XertOwnerTask) -> Void
    let onOpenWorkspace: (XertOwnerWorkspace) -> Void
    @State private var confirmingOwnerPushTest = false

    private var unavailableHealthSources: [String] {
        admin.refreshUnavailableSources.filter { ["schema health", "push health"].contains($0) }
    }

    private var databaseReady: Bool? {
        guard admin.loadedSources.contains("schema health"),
              !admin.refreshUnavailableSources.contains("schema health") else { return nil }
        return admin.missingSchemaCapabilities.isEmpty
    }

    private var pushHealthIsCurrent: Bool {
        admin.loadedSources.contains("push health")
            && !admin.refreshUnavailableSources.contains("push health")
            && admin.pushHealth != nil
    }

    private var productionPushReady: Bool? {
        guard pushHealthIsCurrent, let push = admin.pushHealth else { return nil }
        return push.isOwnerLaunchReady()
    }

    private var bookingProviderReady: Bool? {
        guard sourceIsCurrent("platform controls"), let settings = admin.settings else { return nil }
        let provider = settings.providerResolution
        if provider.isBlocked { return false }
        // FitBox handoff is usable, but it remains an attention state until
        // booking mirroring and attendance are supported and verified.
        return provider.provider == .native
    }

    private var bookingProviderDetail: String {
        guard sourceIsCurrent("platform controls"), let settings = admin.settings else {
            return "Live booking-provider settings could not be verified. Booking mutations remain closed."
        }
        let provider = settings.providerResolution
        if provider.isBlocked {
            return provider.blockedReason ?? "The selected booking provider needs attention."
        }
        if provider.provider == .fitBox {
            return "FitBox handoff is configured. XERT-native booking and Stripe packs are paused; booking mirroring and attendance are not yet available."
        }
        return "XERT-native booking, credits and Stripe session packs are selected."
    }

    private var fitboxReviewReady: Bool? {
        guard admin.fitboxBridgeHealthError == nil,
              let bridge = admin.fitboxBridgeHealth else { return nil }
        return !bridge.hasReviewRequired
    }

    private var fitboxReadOnlyProfileEvidenceReady: Bool? {
        guard admin.fitboxBridgeHealthError == nil,
              let bridge = admin.fitboxBridgeHealth else { return nil }
        return bridge.launch_validation?.hasReadOnlyProfileEvidence
    }

    private var fitboxReadOnlyProfileEvidenceDetail: String {
        guard admin.fitboxBridgeHealthError == nil,
              let bridge = admin.fitboxBridgeHealth else {
            return "The read-only FitBox profile result could not be verified. Do not treat the bridge as launch-validated."
        }
        guard let validation = bridge.launch_validation else {
            return "This server snapshot predates read-only profile result reporting. Refresh after the current production deployment is live."
        }
        if validation.hasReadOnlyProfileEvidence {
            return "\(validation.read_only_profile_completed) read-only FitBox profile result\(validation.read_only_profile_completed == 1 ? " is" : "s are") recorded. XERT identity, bookings and billing remained unchanged."
        }
        return "No successful read-only FitBox profile result is recorded yet. Complete it with an approved synthetic pair; do not reuse an orphaned provider link."
    }

    private var fitboxReviewDetail: String {
        guard admin.fitboxBridgeHealthError == nil,
              let bridge = admin.fitboxBridgeHealth else {
            return "The live FitBox review queue could not be verified. No provider event is treated as an XERT update."
        }
        if bridge.reconciliation == 0 {
            return "No inbound FitBox evidence is waiting for owner review."
        }
        return "\(bridge.reconciliation) inbound FitBox event\(bridge.reconciliation == 1 ? " is" : "s are") waiting for review. XERT has not changed any booking, membership, subscription or charge from these events."
    }

    private var databaseDetail: String {
        guard let databaseReady else {
            return admin.loadedSources.contains("schema health")
                ? "The last database snapshot is hidden until a live health check succeeds."
                : "Database capabilities could not be loaded. No readiness result is available."
        }
        return databaseReady
            ? "All \(AdminSchemaReadiness.required.count) required capabilities are installed."
            : "\(admin.missingSchemaCapabilities.count) required database capabilities are missing."
    }

    private func sourceIsCurrent(_ source: String) -> Bool {
        admin.loadedSources.contains(source) && !admin.refreshUnavailableSources.contains(source)
    }

    private var bookableClassesReady: Bool? {
        guard sourceIsCurrent("full timetable") else { return nil }
        let now = Date()
        return admin.classSessions.contains { item in
            item.status == "published"
                && item.public_visible == true
                && (item.start_time ?? .distantPast) > now
                && ["instant_book", "request_to_book"].contains(item.booking_mode ?? "instant_book")
                && (item.capacity ?? 0) > 0
        }
    }

    private var bookingsSwitch: Bool? {
        guard sourceIsCurrent("platform controls"), let settings = admin.settings else { return nil }
        return settings.bookings_enabled
    }

    private var memberLaunchGate: XertOwnerLaunchGate {
        guard admin.launchGateUpdatedAt != nil else {
            return XertOwnerLaunchGate.resolve(
                databaseReady: nil,
                pushReady: nil,
                bookableClassesReady: nil,
                bookingsEnabled: nil
            )
        }
        return XertOwnerLaunchGate.resolve(
            databaseReady: databaseReady,
            pushReady: productionPushReady,
            bookableClassesReady: bookableClassesReady,
            bookingsEnabled: bookingsSwitch
        )
    }

    private var launchGateNextWorkspace: XertOwnerWorkspace? {
        guard databaseReady == true else { return nil }
        guard productionPushReady == true else { return nil }
        if bookableClassesReady == false { return .timetable }
        return nil
    }

    var body: some View {
        List {
            if !unavailableHealthSources.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(
                            "Live health is unavailable for \(unavailableHealthSources.joined(separator: ", ")). Last-known details are labelled below.",
                            systemImage: "wifi.exclamationmark"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                        Button {
                            XertHaptics.play(.softImpact)
                            Task {
                                async let coreHealth: Void = admin.refreshHealth(session: session)
                                async let fitboxHealth: Void = admin.refreshFitboxBridgeHealth(session: session)
                                _ = await (coreHealth, fitboxHealth)
                                XertHaptics.play(unavailableHealthSources.isEmpty ? .success : .warning)
                            }
                        } label: {
                            Label(admin.isRefreshingHealth ? "Refreshing health…" : "Retry health checks", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.orange)
                        .disabled(admin.isLoading || admin.isRefreshingHealth)
                    }
                    .listRowBackground(Color.xertInk)
                }
            }

            Section("Member launch gate") {
                VStack(alignment: .leading, spacing: 10) {
                    Label(memberLaunchGate.title, systemImage: launchGateIcon)
                        .font(.headline)
                        .foregroundStyle(launchGateColor)
                    Text(memberLaunchGate.detail)
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.68))
                        .fixedSize(horizontal: false, vertical: true)
                    ProgressView(
                        value: Double(memberLaunchGate.completedChecks),
                        total: Double(XertOwnerLaunchGate.totalChecks)
                    )
                    .tint(launchGateColor)
                    Text("\(memberLaunchGate.completedChecks)/\(XertOwnerLaunchGate.totalChecks) required gates")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.xertPale.opacity(0.5))
                    if let nextAction = memberLaunchGate.nextAction {
                        Text("Next: \(nextAction)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button {
                        XertHaptics.play(.softImpact)
                        Task {
                            async let coreHealth: Void = admin.refreshHealth(session: session)
                            async let fitboxHealth: Void = admin.refreshFitboxBridgeHealth(session: session)
                            _ = await (coreHealth, fitboxHealth)
                            XertHaptics.play(memberLaunchGate.phase == .verifying ? .warning : .success)
                        }
                    } label: {
                        Label(admin.isRefreshingHealth ? "Refreshing launch gates..." : "Refresh launch gates", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.xertSteel)
                    .disabled(
                        admin.isLoading
                            || admin.isRefreshingHealth
                            || admin.isSavingSettings
                            || admin.savingProductID != nil
                            || admin.savingClassID != nil
                            || admin.cancellingClassID != nil
                    )
                    if let verifiedAt = admin.launchGateUpdatedAt {
                        Text("Verified \(verifiedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.xertPale.opacity(0.48))
                    }
                    if let workspace = launchGateNextWorkspace {
                        Button { onOpenWorkspace(workspace) } label: {
                            Label("Open next gate", systemImage: "arrow.up.forward.square")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(Color.xertSteel)
                    }
                }
                .padding(.vertical, 4)
                .listRowBackground(Color.xertInk)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("owner.launchGate")
            }

            Section("Release readiness") {
                HealthStatusRow(
                    title: "Booking provider",
                    ready: bookingProviderReady,
                    detail: bookingProviderDetail
                )
                HealthStatusRow(
                    title: "FitBox Zapier bridge",
                    ready: admin.fitboxBridgeHealth?.ready,
                    detail: fitboxBridgeDetail
                )
                HealthStatusRow(
                    title: "FitBox review queue",
                    ready: fitboxReviewReady,
                    detail: fitboxReviewDetail
                )
                HealthStatusRow(
                    title: "FitBox read-only profile result",
                    ready: fitboxReadOnlyProfileEvidenceReady,
                    detail: fitboxReadOnlyProfileEvidenceDetail
                )
                HealthStatusRow(
                    title: "Database contract",
                    ready: databaseReady,
                    detail: databaseDetail
                )
                HealthStatusRow(
                    title: "Member push notifications",
                    ready: productionPushReady,
                    detail: pushDetail
                )
            }

            if databaseReady != nil && !admin.missingSchemaCapabilities.isEmpty {
                Section("Missing database capabilities") {
                    ForEach(admin.missingSchemaCapabilities, id: \.self) { capability in
                        Label(capability.replacingOccurrences(of: "_", with: " ").capitalized, systemImage: "exclamationmark.triangle")
                            .font(.subheadline).foregroundStyle(.orange)
                            .listRowBackground(Color.xertInk)
                    }
                }
            }
            if let bridge = admin.fitboxBridgeHealth {
                Section("FitBox activity (24 hours)") {
                    HealthCountRow(label: "FitBox jobs completed", value: bridge.jobs_24h.completed)
                    HealthCountRow(label: "Read-only profile refreshes", value: bridge.profile_refreshes_24h?.completed ?? 0)
                    HealthCountRow(label: "Recorded read-only profile results", value: bridge.launch_validation?.read_only_profile_completed ?? 0)
                    HealthCountRow(label: "Handoffs in progress", value: bridge.active)
                    HealthCountRow(label: "Provider events received", value: bridge.events_24h)
                    HealthCountRow(label: "Awaiting reconciliation", value: bridge.reconciliation)
                    if bridge.stale > 0 || bridge.jobs_24h.failed > 0 {
                        Label(
                            "\(bridge.jobs_24h.failed) failed and \(bridge.stale) stale handoffs need owner review.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                    }
                }
                Section("FitBox event evidence") {
                    Label(
                        "Read-only evidence from Zapier. These events never change XERT bookings, memberships, subscriptions, attendance or charges.",
                        systemImage: "eye.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.xertSteel)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("owner.fitbox.readOnlyEvidence")

                    if bridge.eventSummaries.isEmpty {
                        Label(
                            "Per-workflow evidence is unavailable in this server snapshot. Refresh after the latest deployment completes.",
                            systemImage: "clock.badge.exclamationmark"
                        )
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    } else {
                        ForEach(bridge.eventSummaries) { summary in
                            FitboxEventEvidenceRow(summary: summary)
                        }
                    }

                    if bridge.hasReviewRequired {
                        Label(
                            "Review these records against FitBox before relying on any provider status. This screen cannot approve or mutate provider data.",
                            systemImage: "exclamationmark.shield.fill"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if let push = admin.pushHealth, pushHealthIsCurrent {
                Section("APNs activity (24 hours)") {
                    HealthCountRow(label: "Production devices", value: push.subscriptions.production)
                    HealthCountRow(label: "Delivered", value: push.deliveries_24h.delivered)
                    HealthCountRow(label: "Failed", value: push.deliveries_24h.failed + push.deliveries_24h.invalid_token)
                    if let smokeTest = push.owner_smoke_test {
                        HealthValueRow(
                            label: "Owner smoke test",
                            value: "\(smokeTest.status.uppercased()) · \(smokeTest.attempted_at.formatted(date: .abbreviated, time: .shortened))"
                        )
                    } else {
                        HealthValueRow(label: "Owner smoke test", value: "Required before launch")
                    }
                    if let lastAttempt = push.last_attempt {
                        HealthValueRow(
                            label: "Latest attempt",
                            value: "\(lastAttempt.status.uppercased()) · \(lastAttempt.attempted_at.formatted(date: .abbreviated, time: .shortened))"
                        )
                        if let reason = visiblePushReason(lastAttempt.reason) {
                            HealthValueRow(label: "Latest result", value: reason)
                        }
                    } else {
                        HealthValueRow(label: "Latest attempt", value: "None recorded")
                    }
                    if let message = admin.ownerPushTestStatusMessage {
                        Label(
                            message,
                            systemImage: admin.ownerPushTestStatusIsWarning
                                ? "exclamationmark.triangle.fill"
                                : "checkmark.circle.fill"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(admin.ownerPushTestStatusIsWarning ? Color.orange : Color.green)
                        .fixedSize(horizontal: false, vertical: true)
                        .listRowBackground(Color.xertInk)
                    }
                    if push.subscriptions.production == 0 {
                        Label(
                            "No production owner device is registered. Install this TestFlight build, sign in, then enable Member notice notifications in Account.",
                            systemImage: "iphone.slash"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .listRowBackground(Color.xertInk)
                    }
                    Button {
                        confirmingOwnerPushTest = true
                    } label: {
                        Label(
                            admin.isSendingOwnerPushTest ? "Sending production test…" : "Send owner push test",
                            systemImage: "bell.badge"
                        )
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.xertSteel)
                    .disabled(
                        admin.isLoading
                            || admin.isRefreshingHealth
                            || admin.isSendingOwnerPushTest
                            || !push.ready
                            || push.subscriptions.production == 0
                    )
                    .accessibilityHint("Sends a private launch smoke test to up to five production devices registered to this owner")
                    .accessibilityIdentifier("owner.pushSmokeTest")
                }
            } else if let push = admin.pushHealth {
                Section("APNs — last snapshot") {
                    Label("Live push verification failed. These counts may be stale.", systemImage: "clock.badge.exclamationmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                        .listRowBackground(Color.xertInk)
                    HealthCountRow(label: "Last production devices", value: push.subscriptions.production)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("System status")
        .refreshable {
            await admin.refreshHealth(session: session)
            await admin.refreshFitboxBridgeHealth(session: session)
        }
        .task { await admin.refreshFitboxBridgeHealth(session: session) }
        .confirmationDialog(
            "Send a production push test?",
            isPresented: $confirmingOwnerPushTest,
            titleVisibility: .visible
        ) {
            Button("Send test") {
                Task {
                    let succeeded = await admin.sendOwnerPushSmokeTest(session: session)
                    XertHaptics.play(succeeded ? .success : .warning)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This sends a private XERT launch test only to production devices registered to your owner account. It creates no member announcement.")
        }
    }

    private var launchGateIcon: String {
        switch memberLaunchGate.phase {
        case .preflightReady, .liveReady: return "checkmark.seal.fill"
        case .blocked: return "hand.raised.fill"
        case .verifying: return "questionmark.circle.fill"
        }
    }

    private var launchGateColor: Color {
        switch memberLaunchGate.phase {
        case .preflightReady, .liveReady: return .green
        case .blocked: return .red
        case .verifying: return .orange
        }
    }

    private var pushDetail: String {
        guard pushHealthIsCurrent, let health = admin.pushHealth else {
            return admin.pushHealth == nil
                ? "Push health could not be loaded. No delivery result is available."
                : "Live push health failed. The last device count is shown below as stale."
        }
        if !health.environment.missing.isEmpty {
            return "Missing: \(health.environment.missing.joined(separator: ", "))."
        }
        let smoke = productionPushReady == true ? "owner smoke test current" : "owner smoke test required"
        return "\(health.subscriptions.production) production device\(health.subscriptions.production == 1 ? "" : "s") registered; \(smoke)."
    }

    private var fitboxBridgeDetail: String {
        if let error = admin.fitboxBridgeHealthError {
            return "Live FitBox bridge health could not be verified: \(error)"
        }
        guard let bridge = admin.fitboxBridgeHealth else {
            return "Checking prospect handoff, inbound events and reconciliation health."
        }
        if !bridge.environment.ready {
            return "Missing server configuration: \(bridge.environment.missing.joined(separator: ", "))."
        }
        let profileRefreshes = bridge.profile_refreshes_24h?.completed ?? 0
        return "\(bridge.jobs_24h.completed) total job\(bridge.jobs_24h.completed == 1 ? "" : "s") completed, including \(profileRefreshes) read-only profile refresh\(profileRefreshes == 1 ? "" : "es"); \(bridge.events_24h) provider event\(bridge.events_24h == 1 ? "" : "s") received; \(bridge.reconciliation) awaiting review."
    }

    private func visiblePushReason(_ reason: String?) -> String? {
        guard let reason, !reason.isEmpty else { return nil }
        if reason == "OWNER_LAUNCH_TEST:DELIVERED" { return "Owner launch test delivered" }
        if reason.hasPrefix("OWNER_LAUNCH_TEST:") {
            return reason
                .replacingOccurrences(of: "OWNER_LAUNCH_TEST:", with: "Owner launch test: ")
                .replacingOccurrences(of: "_", with: " ")
                .lowercased()
        }
        return reason
    }
}

private struct FitboxEventEvidenceRow: View {
    let summary: AdminFitboxBridgeHealth.EventSummary

    private var latestEvidence: String {
        guard let receivedAt = summary.last_received_at else {
            return "No evidence received yet"
        }
        return "Latest evidence \(receivedAt.formatted(date: .abbreviated, time: .shortened))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(summary.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.xertOffWhite)
                Spacer(minLength: 8)
                Text("\(summary.events_24h) / 24h")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(Color.xertSteel)
            }
            Text(latestEvidence)
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.58))
            if summary.needs_review > 0 {
                Label(
                    "\(summary.needs_review) require\(summary.needs_review == 1 ? "s" : "") review",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                if let reason = summary.reviewReasonLabel {
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(Color.xertPale.opacity(0.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if summary.latest_processing_state != nil {
                Label("No review waiting", systemImage: "checkmark.circle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.green)
            }
        }
        .padding(.vertical, 3)
        .listRowBackground(Color.xertInk)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(summary.title). \(summary.events_24h) received in 24 hours. \(latestEvidence). \(summary.needs_review) require review."
        )
    }
}

private struct HealthStatusRow: View {
    let title: String
    let ready: Bool?
    let detail: String

    private var icon: String {
        guard let ready else { return "questionmark.circle.fill" }
        return ready ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
    }

    private var colour: Color {
        guard let ready else { return Color.xertPale.opacity(0.55) }
        return ready ? .green : .orange
    }

    private var stateLabel: String {
        guard let ready else { return "Status unavailable" }
        return ready ? "Ready" : "Needs attention"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(colour)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline).foregroundStyle(Color.xertOffWhite)
                Text(detail).font(.caption).foregroundStyle(Color.xertPale.opacity(0.62))
            }
        }
        .listRowBackground(Color.xertInk)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(stateLabel). \(detail)")
    }

}

private struct HealthCheckRow: View {
    let label: String
    let ready: Bool

    var body: some View {
        HStack {
            Text(label).foregroundStyle(Color.xertPale)
            Spacer()
            Image(systemName: ready ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(ready ? Color.green : Color.orange)
                .accessibilityLabel(ready ? "Ready" : "Needs attention")
        }
        .listRowBackground(Color.xertInk)
    }
}

private struct HealthValueRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label).foregroundStyle(Color.xertPale)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Color.xertSteel)
        }
        .listRowBackground(Color.xertInk)
    }
}

private struct HealthCountRow: View {
    let label: String
    let value: Int

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Text(value.formatted()).fontWeight(.bold)
        }
        .foregroundStyle(Color.xertOffWhite)
        .listRowBackground(Color.xertInk)
    }
}

private struct AdminAuditView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var query = ""
    @State private var category = "All"
    @State private var exportDocument: AdminAuditCSVDocument?
    @State private var isExporting = false

    private var categories: [String] {
        ["All"] + Set(admin.auditEntries.map(\.category)).sorted()
    }

    private var rows: [AdminAuditEntry] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return admin.auditEntries.filter { entry in
            (category == "All" || entry.category == category)
                && (
                    term.isEmpty
                        || [
                            entry.title,
                            entry.detail,
                            entry.category,
                            entry.operatorID?.uuidString ?? "",
                            entry.subjectID ?? ""
                        ]
                        .joined(separator: " ")
                        .lowercased()
                        .contains(term)
                )
        }
    }

    private var summary: AdminAuditSummary {
        AdminAuditSummary(entries: admin.auditEntries)
    }

    private var reportIsCurrent: Bool {
        admin.auditIsCurrent && !admin.isLoadingAudit
    }

    private var reportStateLabel: String {
        if reportIsCurrent { return "LIVE HISTORY" }
        if admin.auditUnavailable { return "CACHED HISTORY" }
        return admin.auditPartialSources.isEmpty ? "CACHED HISTORY" : "PARTIAL HISTORY"
    }

    private var reportStateIcon: String {
        if reportIsCurrent { return "checkmark.circle.fill" }
        if admin.auditUnavailable { return "clock.arrow.circlepath" }
        return admin.auditPartialSources.isEmpty ? "clock.arrow.circlepath" : "exclamationmark.triangle.fill"
    }

    private var exportDateStamp: String {
        String(ISO8601DateFormatter().string(from: Date()).prefix(10))
    }

    var body: some View {
        List {
            if !admin.hasLoadedAudit {
                Section {
                    if admin.isLoadingAudit {
                        HStack(spacing: 12) {
                            ProgressView().tint(Color.xertSteel)
                            Text("Loading protected change history...")
                        }
                        .frame(minHeight: 64)
                        .listRowBackground(Color.xertInk)
                    } else {
                        auditUnavailablePanel(
                            message: admin.auditStatusMessage
                                ?? "Activity log has not loaded. Retry before relying on change history."
                        )
                    }
                }
            } else {
                if !reportIsCurrent {
                    Section {
                        auditUnavailablePanel(
                            message: admin.auditStatusMessage
                                ?? "Showing the last audit snapshot. Refresh before treating this history as current."
                        )
                    }
                }

                Section {
                    HStack {
                        Label(
                            reportStateLabel,
                            systemImage: reportStateIcon
                        )
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(reportIsCurrent ? Color.green : Color.orange)
                        Spacer()
                        Text("\(admin.auditEntries.count) RECORDS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.xertPale.opacity(0.5))
                    }
                    if let updatedAt = admin.auditUpdatedAt {
                        Text("Loaded \(updatedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.52))
                    }
                }
                .listRowBackground(Color.xertInk)

                Section {
                    auditSummary
                }
                .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                .listRowBackground(Color.xertInk)

                Section {
                    Picker("Audit category", selection: $category) {
                        ForEach(categories, id: \.self) { Text($0).tag($0) }
                    }
                }
                .listRowBackground(Color.xertNavy)

                if rows.isEmpty {
                    Text(
                        reportIsCurrent
                            ? "No matching administrative actions."
                            : "No matching actions in the last loaded snapshot."
                    )
                    .listRowBackground(Color.xertInk)
                }
                ForEach(rows) { entry in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: auditIcon(entry.category))
                            .frame(width: 24).foregroundStyle(Color.xertSteel)
                        VStack(alignment: .leading, spacing: 4) {
                            ViewThatFits(in: .horizontal) {
                                HStack {
                                    Text(entry.title).font(.headline)
                                    Spacer()
                                    auditCategory(entry.category)
                                }
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.title).font(.headline)
                                    auditCategory(entry.category)
                                }
                            }
                            Text(entry.detail).font(.caption).foregroundStyle(Color.xertPale.opacity(0.62))
                            Label(operatorLabel(entry), systemImage: entry.operatorID == nil ? "gearshape.2" : "person.badge.key")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(entry.operatorID == nil ? Color.xertPale.opacity(0.45) : Color.xertSteel)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(entry.createdAt.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption2).foregroundStyle(Color.xertPale.opacity(0.4))
                        }
                    }
                    .foregroundStyle(Color.xertOffWhite)
                    .padding(.vertical, 5)
                    .listRowBackground(Color.xertInk)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Activity log")
        .searchable(text: $query, prompt: "Search changes")
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button {
                    exportDocument = AdminAuditCSVDocument(
                        csv: AdminAuditExport(entries: rows).csv
                    )
                    isExporting = true
                } label: {
                    Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44)
                }
                .disabled(!reportIsCurrent || rows.isEmpty)
                .accessibilityLabel("Export filtered admin audit CSV")
                .accessibilityHint(reportIsCurrent ? "Exports the visible live history" : "Refresh Activity log before exporting")
                Button {
                    Task { await admin.loadAudit(session: session, force: true) }
                } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }
                .disabled(admin.isLoadingAudit)
                .accessibilityLabel("Refresh admin audit")
            }
        }
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "xert-admin-audit-\(exportDateStamp)"
        ) { result in
            if case .failure(let error) = result { admin.errorMessage = error.localizedDescription }
        }
        .refreshable { await admin.loadAudit(session: session, force: true) }
        .task { await admin.loadAudit(session: session) }
    }

    private var auditSummary: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.shield")
                    .font(.headline)
                    .foregroundStyle(Color.xertSteel)
                    .frame(width: 34, height: 34)
                    .background(Color.xertSteel.opacity(0.1))
                VStack(alignment: .leading, spacing: 2) {
                    Text("OPERATOR ACCOUNTABILITY")
                        .font(.caption.weight(.black))
                        .foregroundStyle(Color.xertOffWhite)
                    Text("Protected changes across operations and commerce")
                        .font(.caption2)
                        .foregroundStyle(Color.xertPale.opacity(0.5))
                }
            }

            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 8),
                    GridItem(.flexible(), spacing: 8)
                ],
                spacing: 8
            ) {
                auditMetric(summary.total, label: "Ledger actions", icon: "clock.arrow.circlepath")
                auditMetric(summary.last24Hours, label: "Last 24 hours", icon: "clock.badge")
                auditMetric(summary.moneyActions, label: "Money actions", icon: "dollarsign.circle")
                auditMetric(summary.identifiedOperators, label: "Operators seen", icon: "person.2.badge.gearshape")
            }

            if !reportIsCurrent {
                Label("Metrics are from the last available audit snapshot.", systemImage: "clock.badge.exclamationmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner.audit.summary")
    }

    private func auditMetric(_ value: Int, label: String, icon: String) -> some View {
        HStack(spacing: 9) {
            Image(systemName: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.xertSteel)
                .frame(width: 28, height: 28)
                .background(Color.xertSteel.opacity(0.08))
            VStack(alignment: .leading, spacing: 1) {
                Text(value.formatted())
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(Color.xertOffWhite)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(Color.xertPale.opacity(0.5))
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .background(Color.xertNavy.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.xertSteel.opacity(0.14), lineWidth: 1))
    }

    private func operatorLabel(_ entry: AdminAuditEntry) -> String {
        guard let operatorID = entry.operatorID else {
            return entry.category == "Bookings"
                ? "Member or system initiated"
                : "System or historical action"
        }
        let shortID = String(operatorID.uuidString.lowercased().prefix(8))
        if operatorID == session.user?.id {
            return "You · \(shortID)"
        }
        if let member = admin.members.first(where: { $0.id == operatorID }) {
            return "\(member.displayName) · \(shortID)"
        }
        return "Admin \(shortID)"
    }

    private func auditUnavailablePanel(message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: "wifi.exclamationmark")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await admin.loadAudit(session: session, force: true) }
            } label: {
                Label(admin.isLoadingAudit ? "Retrying..." : "Retry Activity log", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.orange)
            .disabled(admin.isLoadingAudit)
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.xertInk)
    }

    private func auditCategory(_ category: String) -> some View {
        Text(category.uppercased())
            .font(.caption2.weight(.bold))
            .foregroundStyle(Color.xertSteel)
    }

    private func auditIcon(_ category: String) -> String {
        switch category {
        case "Access": return "person.badge.key"
        case "Credits": return "ticket"
        case "Bookings", "Requests": return "calendar.badge.clock"
        case "Notices": return "bell"
        case "Content": return "square.and.pencil"
        case "Schedule": return "calendar"
        case "Commerce": return "creditcard.and.123"
        default: return "clock.arrow.circlepath"
        }
    }
}

private struct AdminAuditCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    let csv: String

    init(csv: String) { self.csv = csv }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        csv = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(csv.utf8))
    }
}

private struct AdminProductsView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let onOpenTask: (XertOwnerTask) -> Void
    @State private var query = ""
    @State private var filter: ProductFilter = .all
    @State private var showingCreate = false

    private enum ProductFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case active = "Live"
        case inactive = "Drafts"
        var id: String { rawValue }
    }

    private var activeProducts: [AdminProduct] { admin.products.filter(\.active) }
    private var liveBlockedProducts: [AdminProduct] { activeProducts.filter { !$0.hasStableStripePriceID } }
    private var pricingDataIsCurrent: Bool {
        admin.loadedSources.contains("session packs")
            && !admin.refreshUnavailableSources.contains("session packs")
    }
    private var pricingDataIsPending: Bool {
        !admin.hasCompletedRefresh && !admin.loadedSources.contains("session packs")
    }
    private var pricingDataUnavailable: Bool {
        !pricingDataIsCurrent && !pricingDataIsPending
    }
    private var pricingMutationAvailable: Bool {
        pricingDataIsCurrent && !admin.isLoading
    }
    private var stripeHealthIsCurrent: Bool {
        admin.loadedSources.contains("Stripe health")
            && !admin.refreshUnavailableSources.contains("Stripe health")
            && admin.commerceHealth != nil
    }
    private var stripeHealthUnavailable: Bool {
        !stripeHealthIsCurrent && admin.hasCompletedRefresh
    }
    private var isLiveReady: Bool {
        pricingDataIsCurrent
            && stripeHealthIsCurrent
            && admin.commerceHealth?.ready == true
            && !activeProducts.isEmpty
            && liveBlockedProducts.isEmpty
    }
    private var visibleProducts: [AdminProduct] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return admin.products.filter { product in
            let matchesFilter = filter == .all || (filter == .active ? product.active : !product.active)
            let matchesQuery = term.isEmpty || "\(product.name) \(product.slug) \(product.description ?? "")"
                .lowercased().contains(term)
            return matchesFilter && matchesQuery
        }
    }

    var body: some View {
        List {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: isLiveReady ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(isLiveReady ? Color.green : Color.orange)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("LIVE STRIPE READINESS").font(.caption.weight(.bold))
                        if pricingDataIsPending || (admin.isLoading && !pricingDataIsCurrent) {
                            Text("Checking session-pack and Stripe readiness…")
                        } else if pricingDataUnavailable || stripeHealthUnavailable {
                            Text("Pricing or Stripe health could not be refreshed. The last visible setup may be stale.")
                            Text("Return to Overview and retry unavailable data before changing checkout.")
                                .foregroundStyle(Color.xertPale.opacity(0.5))
                        } else if activeProducts.isEmpty {
                            Text("Create a pack, attach its live Stripe Price ID, then make it active when it is ready for sale.")
                        } else if isLiveReady {
                            Text("Stripe has verified all \(activeProducts.count) active packs and the checkout service is ready.")
                        } else if liveBlockedProducts.isEmpty {
                            Text("All active packs have Price IDs, but Stripe launch checks still need attention.")
                            Text("Review System status before enabling checkout.")
                                .foregroundStyle(Color.xertPale.opacity(0.5))
                        } else {
                            Text("\(liveBlockedProducts.count) of \(activeProducts.count) active packs block live checkout: \(liveBlockedProducts.map(\.slug).joined(separator: ", ")).")
                            Text("Test checkout may use dynamic prices. Live checkout requires a live price_ ID.")
                                .foregroundStyle(Color.xertPale.opacity(0.5))
                        }
                        Text("These are one-off session packs, not recurring subscriptions. Changes affect new purchases only; existing credits keep their original terms.")
                            .foregroundStyle(Color.xertPale.opacity(0.5))
                    }
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.75))
                }
                .padding(.vertical, 5)
                .listRowBackground(Color.xertInk)
            }

            Section {
                Picker("Sale status", selection: $filter) {
                    ForEach(ProductFilter.allCases) { option in Text(option.rawValue).tag(option) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.xertInk)
            }

            if pricingDataIsPending {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.xertSteel)
                    Text("Loading session packs…")
                        .foregroundStyle(Color.xertPale.opacity(0.7))
                }
                .accessibilityElement(children: .combine)
                .listRowBackground(Color.xertInk)
            } else if pricingDataUnavailable {
                Label("Session-pack data is unavailable. Cached rows below may be stale.", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .foregroundStyle(.orange)
                    .listRowBackground(Color.xertInk)
            } else if visibleProducts.isEmpty {
                Text(admin.products.isEmpty ? "No session packs configured." : "No packs match this search and filter.")
                    .foregroundStyle(Color.xertPale.opacity(0.7))
                    .listRowBackground(Color.xertInk)
            }
            ForEach(visibleProducts) { product in
                Button { onOpenTask(.product(product.id)) } label: {
                    AdminProductRow(product: product, dataIsStale: pricingDataUnavailable)
                }
                .buttonStyle(.plain)
                .disabled(!pricingMutationAvailable)
                .accessibilityIdentifier("owner.product.\(product.id.uuidString.lowercased())")
                .accessibilityHint(
                    pricingMutationAvailable
                        ? "Opens this session pack to review pricing and sale state"
                        : "Refresh Pricing before editing this pack"
                )
                .listRowBackground(Color.xertInk)
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Pricing")
        .searchable(text: $query, prompt: "Search packs")
        .accessibilityIdentifier("owner.products.list")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button { showingCreate = true } label: {
                Label("Create session pack", systemImage: "plus.circle.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.xertNavy)
            .background(Color.xertSteel)
            .disabled(!pricingMutationAvailable)
            .opacity(pricingMutationAvailable ? 1 : 0.45)
            .accessibilityLabel("Create a new session pack")
            .accessibilityHint(
                pricingMutationAvailable
                    ? "Opens a private session-pack draft"
                    : "Wait for a current session-pack refresh before creating a pack"
            )
            .accessibilityIdentifier("owner.products.create")
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack {
                AdminProductEditor(
                    admin: admin,
                    session: session,
                    product: nil,
                    suggestedSortOrder: (admin.products.map(\.sort_order).max() ?? -1) + 1
                )
            }
        }
    }
}

private struct AdminProductRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let product: AdminProduct
    let dataIsStale: Bool

    private var hasMalformedStripePriceID: Bool {
        let value = product.stripe_price_id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !value.isEmpty && !product.hasStableStripePriceID
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    identity
                    status
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    identity
                    Spacer(minLength: 8)
                    status
                }
            }
        }
        .foregroundStyle(Color.xertOffWhite)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(product.name).font(.headline).fixedSize(horizontal: false, vertical: true)
                if product.featured {
                    Text("FEATURED")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.orange)
                        .fixedSize()
                }
            }
            Text("\(product.sessions_count) sessions · \(product.validity_days) days · \(product.displayPrice)")
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.68))
                .fixedSize(horizontal: false, vertical: true)
            Text("\(product.displayPricePerSession) per session")
                .font(.caption2)
                .foregroundStyle(Color.xertPale.opacity(0.5))
        }
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(product.active ? "LIVE" : "DRAFT")
                .font(.caption2.weight(.bold))
                .foregroundStyle(
                    dataIsStale
                        ? Color.orange
                        : hasMalformedStripePriceID
                            ? Color.red
                            : product.active ? Color.green : Color.xertPale.opacity(0.55)
                )
            if dataIsStale {
                Label("Pricing data stale", systemImage: "clock.badge.exclamationmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            } else if hasMalformedStripePriceID {
                Label("Malformed Price ID", systemImage: "xmark.circle.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            } else if product.active {
                Label(product.hasStableStripePriceID ? "Price ID entered" : "Checkout blocked",
                      systemImage: product.hasStableStripePriceID ? "checkmark.circle" : "exclamationmark.triangle")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(product.hasStableStripePriceID ? Color.green : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct AdminProductEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let product: AdminProduct?
    private let baseline: AdminProductDraft
    private let baselineToken: String?
    @State private var draft: AdminProductDraft
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var confirmingPriceProvision = false
    @State private var exitStateID = UUID()
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case slug, name, description, price, currency, stripePrice }

    init(
        admin: AdminStore,
        session: AuthSession,
        product: AdminProduct?,
        suggestedSortOrder: Int = 0
    ) {
        self.admin = admin
        self.session = session
        self.product = product
        let initial = product.map { AdminProductDraft(product: $0) }
            ?? AdminProductDraft(suggestedSortOrder: suggestedSortOrder)
        let baselineToken = product?.updated_at
        let recovered: AdminCatalogueDraftSnapshot<AdminProductDraft>? = AdminCatalogueDraftStore.load(
            kind: .product,
            ownerID: session.user?.id,
            recordID: product?.id,
            baselineToken: baselineToken
        )
        baseline = initial
        self.baselineToken = baselineToken
        _draft = State(initialValue: recovered?.draft ?? initial)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    private var normalizedStripePriceID: String {
        draft.stripePriceID.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var stripePriceIDHasValidSyntax: Bool {
        normalizedStripePriceID.range(
            of: #"^price_[A-Za-z0-9]+$"#,
            options: .regularExpression
        ) != nil
    }

    private var isCreating: Bool { product == nil }
    private var isDirty: Bool { draft != baseline }
    private var isSaving: Bool { admin.savingProductID != nil }
    private var isProvisioningPrice: Bool { admin.provisioningProductPriceID == product?.id }
    private var isProductMutationInFlight: Bool { isSaving || isProvisioningPrice }
    private var pricingDataIsCurrent: Bool {
        admin.loadedSources.contains("session packs")
            && !admin.refreshUnavailableSources.contains("session packs")
    }
    private var pricingMutationAvailable: Bool {
        pricingDataIsCurrent && !admin.isLoading
    }
    private var validationMessage: String? { draft.validationMessage(existingProduct: product) }
    private var canSave: Bool {
        isDirty && validationMessage == nil && !isProductMutationInFlight && pricingMutationAvailable
    }

    var body: some View {
        Form {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !pricingMutationAvailable {
                Section {
                    Label(
                        pricingDataIsCurrent
                            ? "Session packs are refreshing. Editing will resume when the current catalogue settles."
                            : "Session-pack data is unavailable. Retry before changing prices or sale state.",
                        systemImage: pricingDataIsCurrent ? "arrow.clockwise" : "clock.badge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(pricingDataIsCurrent ? Color.xertSteel : Color.orange)
                    Button {
                        Task { await admin.refresh(session: session) }
                    } label: {
                        Label(admin.isLoading ? "Refreshing…" : "Retry session packs", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(pricingDataIsCurrent ? Color.xertSteel : Color.orange)
                    .disabled(admin.isLoading)
                }
            }
            Section("Pack details") {
                if isCreating {
                    TextField("Permanent ID (for example starter-6)", text: $draft.slug)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .slug)
                    Text("The permanent ID becomes part of checkout records and cannot be edited later.")
                        .font(.caption).foregroundStyle(Color.xertPale.opacity(0.55))
                } else if let product {
                    LabeledContent("Permanent ID", value: product.slug)
                }
                TextField("Name", text: $draft.name)
                    .focused($focusedField, equals: .name)
                TextField("Description", text: $draft.description, axis: .vertical)
                    .lineLimit(2...5)
                    .focused($focusedField, equals: .description)
                TextField("Price in \(draft.currency.uppercased())", text: $draft.price)
                    .keyboardType(.decimalPad)
                    .focused($focusedField, equals: .price)
                    .accessibilityIdentifier("owner.productEditor.price")
                TextField("Currency", text: $draft.currency)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .focused($focusedField, equals: .currency)
            }
            .disabled(!pricingMutationAvailable || isProductMutationInFlight)
            Section("Credits") {
                Stepper("Sessions: \(draft.sessions)", value: $draft.sessions, in: 1...1_000)
                Stepper("Validity: \(draft.validityDays) days", value: $draft.validityDays, in: 1...3_650)
                Stepper("Display order: \(draft.sortOrder)", value: $draft.sortOrder, in: 0...10_000)
                if let cents = draft.normalizedPriceCents, draft.sessions > 0 {
                    let amount = Double(cents) / 100 / Double(draft.sessions)
                    LabeledContent("Price per session", value: amount.formatted(.currency(code: draft.currency.uppercased())))
                }
            }
            .disabled(!pricingMutationAvailable || isProductMutationInFlight)
            Section("Sale state") {
                Toggle("Featured pack", isOn: $draft.featured)
                if isCreating {
                    Label("New packs are saved as private drafts with no Stripe link.", systemImage: "lock.fill")
                        .font(.caption).foregroundStyle(Color.xertPale.opacity(0.7))
                    Text("After creating it, add the matching Stripe Price ID and make it active when checkout is ready.")
                        .font(.caption).foregroundStyle(Color.xertPale.opacity(0.55))
                } else {
                    Toggle("Active and purchasable", isOn: $draft.active)
                    TextField("Stripe Price ID (required for live checkout)", text: $draft.stripePriceID)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focusedField, equals: .stripePrice)
                    if draft.active && normalizedStripePriceID.isEmpty {
                        Label("Add a Stripe Price ID before making this pack live.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                    } else if !normalizedStripePriceID.isEmpty && !stripePriceIDHasValidSyntax {
                        Label("Malformed Price ID. Use price_ followed by letters and numbers.", systemImage: "xmark.circle.fill")
                            .font(.caption).foregroundStyle(.red)
                    } else if stripePriceIDHasValidSyntax && draft.active && !isDirty && product?.active == true {
                        Label("Price ID linked. Checkout re-verifies every commercial term before charging.", systemImage: "checkmark.shield")
                            .font(.caption).foregroundStyle(.green)
                    } else if stripePriceIDHasValidSyntax && draft.active {
                        Label("Stripe will verify this Price and every pack term when you save.", systemImage: "arrow.triangle.2.circlepath")
                            .font(.caption).foregroundStyle(.orange)
                    } else if stripePriceIDHasValidSyntax {
                        Label("Price ID entered. Stripe verification runs when this pack is activated.", systemImage: "clock.badge.checkmark")
                            .font(.caption).foregroundStyle(Color.xertPale.opacity(0.65))
                    }
                    if product?.stripe_price_id != nil {
                        Text("Clear or replace the Stripe Price ID before changing price, currency, sessions or validity.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if let product,
                       !product.active,
                       product.stripe_price_id == nil,
                       !isDirty {
                        Button {
                            confirmingPriceProvision = true
                        } label: {
                            Label(
                                isProvisioningPrice ? "Preparing Stripe Price..." : "Create & link exact Stripe Price",
                                systemImage: "link.badge.plus"
                            )
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .disabled(isProvisioningPrice || !pricingMutationAvailable)
                    }
                }
            }
            .disabled(!pricingMutationAvailable || isProductMutationInFlight)

            if let validationMessage, isDirty || !isCreating {
                Section {
                    Label(validationMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("Cannot save. \(validationMessage)")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .xertOwnerScreen()
        .navigationTitle(isCreating ? "New Session Pack" : product?.name ?? "Session Pack")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("owner.productEditor.form")
        .adminOwnerExitState(
            id: exitStateID,
            title: isCreating ? "new session pack" : "session-pack changes",
            isDirty: isDirty,
            isBusy: isProductMutationInFlight
        )
        .interactiveDismissDisabled(isDirty || isProductMutationInFlight)
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { saveBar }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { requestDismiss() }
                    .disabled(isProductMutationInFlight)
                    .accessibilityIdentifier("owner.productEditor.close")
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }
            }
        }
        .confirmationDialog(
            "Discard unsaved pack changes?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive) { discardAndDismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("The session-pack pricing details in this draft have not been saved.")
        }
        .confirmationDialog(
            "Create this exact Stripe Price?",
            isPresented: $confirmingPriceProvision,
            titleVisibility: .visible
        ) {
            Button("Create Stripe Price") {
                guard let product else { return }
                Task {
                    if await admin.provisionProductPrice(session: session, product: product) != nil {
                        hasCommitted = true
                        clearRecoveryDraft()
                        dismiss()
                    }
                }
            }
            Button("Keep private", role: .cancel) {}
        } message: {
            Text("XERT creates or reuses the exact one-time Stripe Price and links it to this draft. The pack stays private until you activate it separately.")
        }
    }

    private var saveBar: some View {
        Button { save() } label: {
            HStack(spacing: 10) {
                if isSaving { ProgressView().tint(Color.xertNavy) }
                Text(isCreating ? "Create private draft" : "Save pricing changes")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.productEditor.save")
        .accessibilityHint(validationMessage ?? "Saves this session pack")
    }

    private func requestDismiss() {
        focusedField = nil
        if isDirty { confirmingDiscard = true }
        else {
            clearRecoveryDraft()
            dismiss()
        }
    }

    private func save() {
        guard canSave else { return }
        focusedField = nil
        Task { await saveDraft() }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isProductMutationInFlight else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .product,
            ownerID: session.user?.id,
            recordID: product?.id,
            baselineToken: baselineToken
        )
    }

    @MainActor
    private func saveDraft() async {
        guard canSave else { return }
        guard await admin.saveProduct(session: session, product: product, draft: draft) else {
            XertHaptics.play(.error)
            return
        }
        hasCommitted = true
        clearRecoveryDraft()
        XertHaptics.play(.success)
        dismiss()
    }

    private func discardRecoveredEdits() {
        draft = baseline
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func discardAndDismiss() {
        clearRecoveryDraft()
        dismiss()
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .product,
            ownerID: session.user?.id,
            recordID: product?.id
        )
    }
}

private struct AdminEventsView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let onOpenTask: (XertOwnerTask) -> Void
    @State private var query = ""
    @State private var categoryFilter = "all"
    @State private var showingCreate = false
    @State private var rosterEvent: AdminEvent?
    @State private var pendingDelete: AdminEvent?
    @State private var confirmingSeed = false
    @State private var seedReceipt: String?

    private var rows: [AdminEvent] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return admin.events.filter {
            (categoryFilter == "all" || $0.category == categoryFilter)
                && (term.isEmpty
                    || "\($0.name) \($0.category ?? "") \($0.location ?? "") \($0.region ?? "")"
                        .lowercased().contains(term))
        }
    }

    private var categories: [String] {
        Array(Set(admin.events.compactMap(\.category))).sorted()
    }
    private var calendarIsCurrent: Bool { admin.eventCalendarIsCurrent }
    private var groupsAreCurrent: Bool { admin.eventTrainingGroupsAreCurrent }
    private var isRefreshing: Bool {
        admin.isLoading || admin.isRefreshingEventCatalogue || admin.isSeedingEventCalendar
    }

    var body: some View {
        List {
            if let message = admin.eventCatalogueStatusMessage {
                Label(message, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .listRowBackground(Color.xertInk)
            }
            if !calendarIsCurrent || !groupsAreCurrent {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        admin.loadedSources.contains("event calendar")
                            ? "Showing the last event snapshot. Catalogue changes are paused until required sources refresh."
                            : "The Events page could not be loaded. No empty calendar assumption is being made.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await admin.refreshEventCatalogue(session: session) }
                    } label: {
                        Label(isRefreshing ? "Retrying..." : "Retry event catalogue", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(isRefreshing)
                }
                .listRowBackground(Color.xertInk)
            }
            Section("Filter") {
                Picker("Category", selection: $categoryFilter) {
                    Text("All categories").tag("all")
                    ForEach(categories, id: \.self) { Text($0.capitalized).tag($0) }
                }
            }
            .listRowBackground(Color.xertNavy)

            if calendarIsCurrent && admin.missingXertEventCalendarCount > 0 {
                Section("XERT Annual Calendar 2026") {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(
                            "\(admin.missingXertEventCalendarCount) published event\(admin.missingXertEventCalendarCount == 1 ? "" : "s") missing",
                            systemImage: "calendar.badge.plus"
                        )
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertOffWhite)
                        Text("Add the missing XERT calendar rows so members can select training goals instead of seeing read-only fallback events.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.7))
                            .fixedSize(horizontal: false, vertical: true)
                        Button {
                            confirmingSeed = true
                        } label: {
                            Label(
                                admin.isSeedingEventCalendar ? "Adding events..." : "Add missing 2026 events",
                                systemImage: "calendar.badge.plus"
                            )
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.xertSteel)
                        .disabled(isRefreshing || admin.savingEventID != nil || admin.deletingEventID != nil)
                    }
                }
                .listRowBackground(Color.xertInk)
            }

            if calendarIsCurrent && rows.isEmpty {
                Text("No matching calendar events.").listRowBackground(Color.xertInk)
            }
            ForEach(rows) { event in
                VStack(alignment: .leading, spacing: 10) {
                    Button { onOpenTask(.event(event.id)) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            ViewThatFits(in: .horizontal) {
                                HStack {
                                    Text(event.name).font(.headline)
                                    Spacer()
                                    eventPublicationState(event)
                                    Image(systemName: "chevron.right")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(Color.xertSteel)
                                }
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(event.name).font(.headline)
                                    HStack {
                                        eventPublicationState(event)
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(Color.xertSteel)
                                    }
                                }
                            }
                            Text([event.event_date ?? "Date TBC", event.location].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                        }
                        .foregroundStyle(Color.xertOffWhite)
                    }
                    .buttonStyle(.plain)
                    HStack(spacing: 18) {
                        Button {
                            rosterEvent = event
                        } label: {
                            Label(
                                groupsAreCurrent
                                    ? "\(admin.eventGoalCounts[event.id, default: 0]) training"
                                    : "Training group",
                                systemImage: "person.3"
                            )
                            .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.xertSteel)

                        Spacer()
                        Button(role: .destructive) { pendingDelete = event } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.plain)
                        .frame(width: 44, height: 44)
                        .disabled(
                            !calendarIsCurrent
                                || !groupsAreCurrent
                                || isRefreshing
                                || admin.deletingEventID != nil
                                || admin.savingEventID != nil
                        )
                        .accessibilityLabel("Delete \(event.name)")
                    }
                    .font(.caption.weight(.semibold))
                }
                .padding(.vertical, 6)
                .listRowBackground(Color.xertInk)
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("Events page")
        .searchable(text: $query, prompt: "Search events")
        .refreshable { await admin.refreshEventCatalogue(session: session) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingCreate = true } label: { Image(systemName: "plus") }
                    .disabled(
                        !calendarIsCurrent
                            || isRefreshing
                            || admin.savingEventID != nil
                            || admin.deletingEventID != nil
                    )
                    .accessibilityLabel("Add event")
            }
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack {
                AdminEventEditor(admin: admin, session: session, event: nil)
            }
        }
        .sheet(item: $rosterEvent) { event in
            AdminEventRosterView(admin: admin, session: session, event: event)
        }
        .confirmationDialog(
            "Delete calendar event?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            presenting: pendingDelete
        ) { event in
            Button("Delete \(event.name)", role: .destructive) {
                Task {
                    if await admin.deleteEvent(session: session, event: event) {
                        AdminCatalogueDraftStore.clear(
                            kind: .event,
                            ownerID: session.user?.id,
                            recordID: event.id
                        )
                    }
                    pendingDelete = nil
                }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: { event in
            let count = admin.eventGoalCounts[event.id, default: 0]
            Text(count > 0
                 ? "This also removes \(count) member training goal\(count == 1 ? "" : "s"). This cannot be undone."
                 : "This removes the event from the shared web and iOS calendar. This cannot be undone.")
        }
        .confirmationDialog(
            "Add missing XERT 2026 events?",
            isPresented: $confirmingSeed,
            titleVisibility: .visible
        ) {
            Button("Add published events") {
                Task {
                    if let inserted = await admin.seedXertEventCalendar(session: session) {
                        seedReceipt = inserted == 0
                            ? "The XERT 2026 calendar was already complete."
                            : "\(inserted) published event\(inserted == 1 ? " was" : "s were") added to the shared web and iOS calendar."
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This safely inserts only missing calendar rows. Existing events and member training goals are left unchanged.")
        }
        .alert(
            "Calendar updated",
            isPresented: Binding(
                get: { seedReceipt != nil },
                set: { if !$0 { seedReceipt = nil } }
            )
        ) {
            Button("OK") { seedReceipt = nil }
        } message: {
            Text(seedReceipt ?? "")
        }
    }

    private func eventPublicationState(_ event: AdminEvent) -> some View {
        Text(event.published ? "LIVE" : "HIDDEN")
            .font(.caption2.weight(.bold))
            .foregroundStyle(event.published ? Color.green : Color.xertPale.opacity(0.45))
            .fixedSize(horizontal: true, vertical: false)
    }
}

private struct AdminEventEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let event: AdminEvent?
    private let baseline: AdminEventDraft
    private let baselineToken: String?
    @State private var draft: AdminEventDraft
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var textInputFocused: Bool

    private var mutationAllowed: Bool {
        admin.eventCalendarIsCurrent
            && !admin.isLoading
            && !admin.isRefreshingEventCatalogue
    }
    private var isDirty: Bool { draft != baseline }
    private var isBusy: Bool { admin.savingEventID != nil }
    private var canSave: Bool {
        mutationAllowed
            && isDirty
            && !isBusy
            && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    init(admin: AdminStore, session: AuthSession, event: AdminEvent?) {
        let initialDraft = AdminEventDraft(event: event)
        let baselineToken = event?.updated_at
        let recovered: AdminCatalogueDraftSnapshot<AdminEventDraft>? = AdminCatalogueDraftStore.load(
            kind: .event,
            ownerID: session.user?.id,
            recordID: event?.id,
            baselineToken: baselineToken
        )
        self.admin = admin
        self.session = session
        self.event = event
        baseline = initialDraft
        self.baselineToken = baselineToken
        _draft = State(initialValue: recovered?.draft ?? initialDraft)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    var body: some View {
        Form {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Section {
                    Label(
                        "This calendar snapshot is not current. Review is available, but publishing changes is paused until refresh succeeds.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                }
            }
            Section("Event") {
                TextField("Event name", text: $draft.name)
                    .focused($textInputFocused)
                Picker("Category", selection: $draft.category) {
                    ForEach(AdminEventDraft.categories, id: \.self) { Text($0.capitalized).tag($0) }
                }
                Toggle("Start date confirmed", isOn: $draft.hasStartDate)
                if draft.hasStartDate {
                    DatePicker("Start date", selection: $draft.startDate, displayedComponents: .date)
                }
                Toggle("Multi-day event", isOn: $draft.hasEndDate)
                    .disabled(!draft.hasStartDate)
                if draft.hasStartDate && draft.hasEndDate {
                    DatePicker("End date", selection: $draft.endDate, in: draft.startDate..., displayedComponents: .date)
                }
            }
            Section("Location and link") {
                TextField("Location", text: $draft.location)
                    .focused($textInputFocused)
                TextField("Region", text: $draft.region)
                    .focused($textInputFocused)
                TextField("Official website", text: $draft.url)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($textInputFocused)
            }
            Section("Publishing") {
                Toggle("Published on web and iOS", isOn: $draft.published)
                Stepper("Display order: \(draft.sortOrder)", value: $draft.sortOrder, in: 0...10_000)
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .xertOwnerScreen()
        .navigationTitle(event == nil ? "New Event" : "Edit Event")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) { saveBar }
        .toolbar {
            if event == nil || isDirty {
                ToolbarItem(placement: .cancellationAction) {
                    Button(event == nil ? "Cancel" : "Close") { requestDismiss() }
                        .disabled(isBusy)
                }
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { textInputFocused = false }
            }
        }
        .navigationBarBackButtonHidden(event != nil && isDirty)
        .adminOwnerExitState(
            id: exitStateID,
            title: event == nil ? "new event" : "event changes",
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
        .confirmationDialog("Discard event changes?", isPresented: $confirmingDiscard) {
            Button("Discard changes", role: .destructive) { discardAndDismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Your unsaved calendar changes will be permanently discarded.")
        }
        .onChange(of: draft.hasStartDate) { enabled in
            if !enabled { draft.hasEndDate = false }
        }
    }

    private var saveBar: some View {
        Button { save() } label: {
            HStack(spacing: 10) {
                if isBusy { ProgressView().tint(Color.xertNavy) }
                Text(event == nil ? "Create event" : "Save event")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.eventEditor.save")
    }

    private func requestDismiss() {
        textInputFocused = false
        if isDirty { confirmingDiscard = true }
        else {
            clearRecoveryDraft()
            dismiss()
        }
    }

    private func save() {
        guard canSave else { return }
        textInputFocused = false
        Task { await saveDraft() }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isBusy else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .event,
            ownerID: session.user?.id,
            recordID: event?.id,
            baselineToken: baselineToken
        )
    }

    @MainActor
    private func saveDraft() async {
        guard canSave else { return }
        guard await admin.saveEvent(session: session, event: event, draft: draft) else {
            XertHaptics.play(.error)
            return
        }
        hasCommitted = true
        clearRecoveryDraft()
        XertHaptics.play(.success)
        dismiss()
    }

    private func discardRecoveredEdits() {
        draft = baseline
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func discardAndDismiss() {
        clearRecoveryDraft()
        dismiss()
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .event,
            ownerID: session.user?.id,
            recordID: event?.id
        )
    }
}

private struct AdminEventRosterView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let event: AdminEvent
    @State private var exportDocument: AdminEventRosterCSVDocument?
    @State private var isExporting = false
    @State private var exportError: String?

    private var rosterIsLoaded: Bool { admin.eventRosterLoadedEventID == event.id }
    private var rosterIsUnavailable: Bool { admin.eventRosterUnavailableEventID == event.id }
    private var report: AdminEventRosterReport {
        AdminEventRosterReport(event: event, members: admin.eventRoster)
    }

    var body: some View {
        NavigationStack {
            List {
                if admin.loadingEventRosterID == event.id || (!rosterIsLoaded && !rosterIsUnavailable) {
                    HStack {
                        Spacer()
                        ProgressView()
                        Text("Loading training group...")
                        Spacer()
                    }
                    .frame(minHeight: 44)
                } else if rosterIsUnavailable {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(
                            "This training group could not be loaded. No empty-group assumption is being made.",
                            systemImage: "wifi.exclamationmark"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        Button {
                            Task { await admin.loadEventRoster(session: session, eventID: event.id) }
                        } label: {
                            Label("Retry training group", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.orange)
                    }
                } else if rosterIsLoaded && admin.eventRoster.isEmpty {
                    Text("No members are training toward this event yet.")
                } else if rosterIsLoaded {
                    ForEach(admin.eventRoster) { member in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(member.displayName).font(.headline)
                            if let email = nonempty(member.email) {
                                Link(destination: URL(string: "mailto:\(email)")!) {
                                    Label(email, systemImage: "envelope")
                                        .frame(minHeight: 44)
                                }
                            }
                            if let phone = nonempty(member.phone),
                               let number = phone.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                               let url = URL(string: "tel:\(number)") {
                                Link(destination: url) {
                                    Label(phone, systemImage: "phone")
                                        .frame(minHeight: 44)
                                }
                            }
                            Text("Joined \(member.selected_at.formatted(date: .abbreviated, time: .omitted))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle(event.name)
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if !rosterIsLoaded && !rosterIsUnavailable {
                    await admin.loadEventRoster(session: session, eventID: event.id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        exportDocument = AdminEventRosterCSVDocument(csv: report.csv)
                        isExporting = true
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(!rosterIsLoaded || admin.eventRoster.isEmpty)
                    .accessibilityLabel("Export \(event.name) training group")
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .fileExporter(
                isPresented: $isExporting,
                document: exportDocument,
                contentType: .commaSeparatedText,
                defaultFilename: "xert-\(safeFilename(event.name))-training-group"
            ) { result in
                if case .failure(let error) = result {
                    exportError = error.localizedDescription
                }
                exportDocument = nil
            }
            .alert("Export failed", isPresented: Binding(
                get: { exportError != nil },
                set: { if !$0 { exportError = nil } }
            )) {
                Button("OK", role: .cancel) { exportError = nil }
            } message: {
                Text(exportError ?? "The training group could not be exported.")
            }
        }
    }

    private func nonempty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func safeFilename(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return value.lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .unicodeScalars
            .filter { allowed.contains($0) }
            .map(String.init)
            .joined()
            .prefix(60)
            .description
    }
}

private struct AdminEventRosterCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    let csv: String

    init(csv: String) { self.csv = csv }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        csv = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(csv.utf8))
    }
}

private struct AdminCoachesView: View {
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    @State private var query = ""
    @State private var categoryFilter = "all"
    @State private var showingCreate = false
    @State private var pendingDelete: AdminCoach?

    private var directoryIsCurrent: Bool { admin.teamDirectoryIsCurrent }
    private var isRefreshing: Bool { admin.isLoading || admin.isRefreshingTeamDirectory }
    private var categories: [String] {
        Array(Set(admin.coaches.map(\.category))).sorted()
    }
    private var rows: [AdminCoach] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return admin.coaches.filter { coach in
            let fields: [String?] = [
                coach.name, coach.role, coach.experience,
                coach.currently_training_for, coach.category
            ]
            return (categoryFilter == "all" || coach.category == categoryFilter)
                && (term.isEmpty
                    || fields
                    .compactMap { $0?.lowercased() }
                    .joined(separator: " ")
                    .contains(term))
        }
    }

    var body: some View {
        List {
            if let message = admin.teamDirectoryStatusMessage {
                Label(message, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .listRowBackground(Color.xertInk)
            }
            if !directoryIsCurrent {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        admin.loadedSources.contains("team directory")
                            ? "Showing the last team snapshot. Profile changes are paused until refresh succeeds."
                            : "The Coaches page could not be loaded. No empty-directory assumption is being made.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await admin.refreshTeamDirectory(session: session) }
                    } label: {
                        Label(isRefreshing ? "Retrying..." : "Retry team directory", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.orange)
                    .disabled(isRefreshing)
                }
                .listRowBackground(Color.xertInk)
            }
            Section("Filter") {
                Picker("Category", selection: $categoryFilter) {
                    Text("All categories").tag("all")
                    ForEach(categories, id: \.self) { Text($0.capitalized).tag($0) }
                }
            }
            .listRowBackground(Color.xertNavy)

            if directoryIsCurrent && rows.isEmpty {
                Text("No matching team profiles.").listRowBackground(Color.xertInk)
            }
            ForEach(rows) { coach in
                HStack(alignment: .top, spacing: 12) {
                    if let photoURL = URL(string: coach.photo_url ?? ""), !(coach.photo_url ?? "").isEmpty {
                        XertRemoteImage(url: photoURL, maximumPointDimension: 64) {
                            Image(systemName: "person.crop.square").foregroundStyle(Color.xertSteel)
                        }
                        .frame(width: 52, height: 60)
                        .background(Color.xertNavy)
                        .clipped()
                    } else {
                        Image(systemName: "person.crop.square")
                            .foregroundStyle(Color.xertSteel)
                            .frame(width: 52, height: 60)
                            .background(Color.xertNavy)
                    }

                    VStack(alignment: .leading, spacing: 5) {
                        NavigationLink {
                            AdminCoachEditor(admin: admin, session: session, coach: coach)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(coach.name).font(.headline)
                                Text([coach.role, coach.experience].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(Color.xertPale.opacity(0.6))
                            }
                        }
                        HStack {
                            Text(coach.category.uppercased()).foregroundStyle(Color.xertSteel)
                            Text(coach.published ? "LIVE" : "HIDDEN")
                                .foregroundStyle(coach.published ? Color.green : Color.xertPale.opacity(0.45))
                            Spacer()
                            Button(role: .destructive) { pendingDelete = coach } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.plain)
                            .frame(width: 44, height: 44)
                            .disabled(
                                !directoryIsCurrent
                                    || admin.deletingCoachID != nil
                                    || isRefreshing
                                    || admin.savingCoachID != nil
                            )
                            .accessibilityLabel("Delete \(coach.name)")
                        }
                        .font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(Color.xertOffWhite)
                }
                .padding(.vertical, 5)
                .listRowBackground(Color.xertInk)
            }
        }
        .scrollContentBackground(.hidden)
        .xertOwnerScreen()
        .navigationTitle("XERT Team")
        .searchable(text: $query, prompt: "Name, role or experience")
        .refreshable { await admin.refreshTeamDirectory(session: session) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingCreate = true } label: { Image(systemName: "plus") }
                    .disabled(
                        !directoryIsCurrent
                            || isRefreshing
                            || admin.savingCoachID != nil
                            || admin.deletingCoachID != nil
                    )
                    .accessibilityLabel("Add team member")
            }
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack { AdminCoachEditor(admin: admin, session: session, coach: nil) }
        }
        .confirmationDialog(
            "Delete team member?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            presenting: pendingDelete
        ) { coach in
            Button("Delete \(coach.name)", role: .destructive) {
                Task {
                    if await admin.deleteCoach(session: session, coach: coach) {
                        AdminCatalogueDraftStore.clear(
                            kind: .coach,
                            ownerID: session.user?.id,
                            recordID: coach.id
                        )
                    }
                    pendingDelete = nil
                }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: { coach in
            Text("\(coach.name) will be removed from the public team page. This cannot be undone.")
        }
    }
}

private struct AdminCoachEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var admin: AdminStore
    let session: AuthSession
    let coach: AdminCoach?
    private let baseline: AdminCoachDraft
    private let baselineToken: String?
    @State private var draft: AdminCoachDraft
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var textInputFocused: Bool

    private var mutationAllowed: Bool {
        admin.teamDirectoryIsCurrent
            && !admin.isLoading
            && !admin.isRefreshingTeamDirectory
    }
    private var isDirty: Bool { draft != baseline }
    private var isBusy: Bool { admin.savingCoachID != nil }
    private var canSave: Bool {
        mutationAllowed
            && isDirty
            && !isBusy
            && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    init(admin: AdminStore, session: AuthSession, coach: AdminCoach?) {
        let initialDraft = AdminCoachDraft(coach: coach)
        let baselineToken = coach?.updated_at
        let recovered: AdminCatalogueDraftSnapshot<AdminCoachDraft>? = AdminCatalogueDraftStore.load(
            kind: .coach,
            ownerID: session.user?.id,
            recordID: coach?.id,
            baselineToken: baselineToken
        )
        self.admin = admin
        self.session = session
        self.coach = coach
        baseline = initialDraft
        self.baselineToken = baselineToken
        _draft = State(initialValue: recovered?.draft ?? initialDraft)
        _recoveredAt = State(initialValue: recovered?.savedAt)
    }

    var body: some View {
        Form {
            if let recoveredAt {
                AdminRecoveredCatalogueDraftNotice(
                    savedAt: recoveredAt,
                    onDiscard: discardRecoveredEdits
                )
            }
            if !mutationAllowed {
                Section {
                    Label(
                        "This team snapshot is not current. Profile details remain visible, but publishing changes is paused until refresh succeeds.",
                        systemImage: "lock.trianglebadge.exclamationmark"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
                }
            }
            Section("Profile") {
                TextField("Name", text: $draft.name)
                    .focused($textInputFocused)
                Picker("Category", selection: $draft.category) {
                    Text("Coach").tag("coach")
                    Text("Nutritionist").tag("nutritionist")
                    Text("Massage therapist").tag("massage")
                    Text("Physiotherapist").tag("physio")
                }
                TextField("Role", text: $draft.role)
                    .focused($textInputFocused)
                TextField("Biography", text: $draft.bio, axis: .vertical)
                    .lineLimit(3...8)
                    .focused($textInputFocused)
                TextField("Experience", text: $draft.experience)
                    .focused($textInputFocused)
                TextField("Currently training for", text: $draft.currentlyTrainingFor)
                    .focused($textInputFocused)
            }
            Section("Media") {
                TextField("Photo URL", text: $draft.photoURL)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($textInputFocused)
                if let url = URL(string: draft.photoURL), !draft.photoURL.isEmpty {
                    XertRemoteImage(url: url, maximumPointDimension: 640) {
                        ProgressView().tint(Color.xertSteel)
                    }
                    .frame(height: 180)
                    .frame(maxWidth: .infinity)
                    .clipped()
                }
                TextField("Social link", text: $draft.socialURL)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($textInputFocused)
            }
            Section("Publishing") {
                Toggle("Published on the website", isOn: $draft.published)
                Stepper("Display order: \(draft.sortOrder)", value: $draft.sortOrder, in: 0...10_000)
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .xertOwnerScreen()
        .navigationTitle(coach == nil ? "New Team Member" : "Edit Profile")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) { saveBar }
        .toolbar {
            if coach == nil || isDirty {
                ToolbarItem(placement: .cancellationAction) {
                    Button(coach == nil ? "Cancel" : "Close") { requestDismiss() }
                        .disabled(isBusy)
                }
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { textInputFocused = false }
            }
        }
        .navigationBarBackButtonHidden(coach != nil && isDirty)
        .adminOwnerExitState(
            id: exitStateID,
            title: coach == nil ? "new team profile" : "team profile changes",
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
        .confirmationDialog("Discard team profile changes?", isPresented: $confirmingDiscard) {
            Button("Discard changes", role: .destructive) { discardAndDismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Your unsaved team profile changes will be permanently discarded.")
        }
    }

    private var saveBar: some View {
        Button { save() } label: {
            HStack(spacing: 10) {
                if isBusy { ProgressView().tint(Color.xertNavy) }
                Text(coach == nil ? "Create profile" : "Save profile")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.xertNavy)
        .background(canSave ? Color.xertSteel : Color.xertSteel.opacity(0.45))
        .disabled(!canSave)
        .accessibilityIdentifier("owner.coachEditor.save")
    }

    private func requestDismiss() {
        textInputFocused = false
        if isDirty { confirmingDiscard = true }
        else {
            clearRecoveryDraft()
            dismiss()
        }
    }

    private func save() {
        guard canSave else { return }
        textInputFocused = false
        Task { await saveDraft() }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation { clearRecoveryDraft() }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isBusy else { return }
        AdminCatalogueDraftStore.save(
            draft,
            kind: .coach,
            ownerID: session.user?.id,
            recordID: coach?.id,
            baselineToken: baselineToken
        )
    }

    @MainActor
    private func saveDraft() async {
        guard canSave else { return }
        guard await admin.saveCoach(session: session, coach: coach, draft: draft) else {
            XertHaptics.play(.error)
            return
        }
        hasCommitted = true
        clearRecoveryDraft()
        XertHaptics.play(.success)
        dismiss()
    }

    private func discardRecoveredEdits() {
        draft = baseline
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func discardAndDismiss() {
        clearRecoveryDraft()
        dismiss()
    }

    private func clearRecoveryDraft() {
        AdminCatalogueDraftStore.clear(
            kind: .coach,
            ownerID: session.user?.id,
            recordID: coach?.id
        )
    }
}

private struct AdminAnnouncementComposer: View {
    @Environment(\.dismiss) private var dismiss
    let announcement: AdminAnnouncement?
    let ownerID: UUID?
    let publishesOnOpen: Bool
    let isSaving: Bool
    let isPublishing: Bool
    let onSave: (AdminAnnouncementDraft) async -> Bool
    let onPublish: (AdminAnnouncementDraft, UUID) async -> Bool
    private let baseline: AdminAnnouncementDraft
    private let baselineUpdatedAt: String?
    @State private var draft: AdminAnnouncementDraft
    @State private var hasExpiry: Bool
    @State private var recoveredAt: Date?
    @State private var hasEditedDuringPresentation = false
    @State private var hasCommitted = false
    @State private var confirmingPublish: Bool
    @State private var publishRequestID: UUID
    @State private var confirmingDiscard = false
    @State private var exitStateID = UUID()
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case title
        case body
        case ctaLabel
        case ctaURL
    }

    init(
        announcement: AdminAnnouncement?,
        initialDraft: AdminAnnouncementDraft? = nil,
        ownerID: UUID?,
        publishesOnOpen: Bool = false,
        isSaving: Bool,
        isPublishing: Bool,
        onSave: @escaping (AdminAnnouncementDraft) async -> Bool,
        onPublish: @escaping (AdminAnnouncementDraft, UUID) async -> Bool
    ) {
        let baseline = announcement.map(AdminAnnouncementDraft.init)
            ?? initialDraft
            ?? AdminAnnouncementDraft()
        let recovered = initialDraft == nil
            ? AdminAnnouncementDraftStore.load(
                ownerID: ownerID,
                announcementID: announcement?.id,
                baselineUpdatedAt: announcement?.updated_at
            )
            : nil
        let initial = recovered?.draft ?? baseline
        self.announcement = announcement
        self.ownerID = ownerID
        self.publishesOnOpen = publishesOnOpen
        self.isSaving = isSaving
        self.isPublishing = isPublishing
        self.onSave = onSave
        self.onPublish = onPublish
        self.baseline = baseline
        baselineUpdatedAt = announcement?.updated_at
        _draft = State(initialValue: initial)
        _hasExpiry = State(initialValue: initial.expiresAt != nil)
        _recoveredAt = State(initialValue: recovered?.savedAt)
        _confirmingPublish = State(initialValue: publishesOnOpen)
        _publishRequestID = State(initialValue: recovered?.publishRequestID ?? UUID())
    }

    private var isBusy: Bool { isSaving || isPublishing }
    private var isDirty: Bool { draft != baseline }
    private var saveValidation: String? { draft.validationMessage(publishing: false) }
    private var publishValidation: String? { draft.validationMessage(publishing: true) }

    var body: some View {
        NavigationStack {
            Form {
                if let recoveredAt {
                    Section {
                        Label(
                            "Recovered unsaved edits from \(recoveredAt.formatted(date: .omitted, time: .shortened))",
                            systemImage: "arrow.counterclockwise.circle.fill"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                        Button(role: .destructive) {
                            discardRecoveredEdits()
                        } label: {
                            Label("Discard recovered edits", systemImage: "trash")
                        }
                    }
                }

                Section("Member notice") {
                    TextField("Title", text: $draft.title)
                        .focused($focusedField, equals: .title)
                        .onChange(of: draft.title) { value in
                            if value.count > 120 { draft.title = String(value.prefix(120)) }
                        }
                    HStack {
                        Spacer()
                        Text("\(draft.title.count)/120")
                            .font(.caption2)
                            .foregroundStyle(Color.xertPale.opacity(0.48))
                    }
                    TextEditor(text: $draft.body)
                        .focused($focusedField, equals: .body)
                        .frame(minHeight: 170)
                        .onChange(of: draft.body) { value in
                            if value.count > 2_000 { draft.body = String(value.prefix(2_000)) }
                        }
                    HStack {
                        Spacer()
                        Text("\(draft.body.count)/2000")
                            .font(.caption2)
                            .foregroundStyle(Color.xertPale.opacity(0.48))
                    }
                    Picker("Priority", selection: $draft.tone) {
                        Text("Information").tag("info")
                        Text("Action requested").tag("action")
                        Text("Urgent").tag("urgent")
                    }
                }

                Section("Member action") {
                    TextField("Action label (optional)", text: $draft.ctaLabel)
                        .focused($focusedField, equals: .ctaLabel)
                        .onChange(of: draft.ctaLabel) { value in
                            if value.count > 40 { draft.ctaLabel = String(value.prefix(40)) }
                        }
                    TextField("Internal path or HTTPS URL", text: $draft.ctaURL)
                        .focused($focusedField, equals: .ctaURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: draft.ctaURL) { value in
                            if value.count > 500 { draft.ctaURL = String(value.prefix(500)) }
                        }
                    Text("Use an internal destination such as /booking, or a complete secure HTTPS URL.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.55))
                }

                Section("Visibility window") {
                    Toggle("Expire automatically", isOn: $hasExpiry)
                        .onChange(of: hasExpiry) { enabled in
                            draft.expiresAt = enabled
                                ? draft.expiresAt ?? Calendar.current.date(byAdding: .day, value: 1, to: Date())
                                : nil
                        }
                    if hasExpiry {
                        DatePicker(
                            "Expiry",
                            selection: Binding(
                                get: { draft.expiresAt ?? Date() },
                                set: { draft.expiresAt = $0 }
                            ),
                            displayedComponents: [.date, .hourAndMinute]
                        )
                    }
                    Text("After expiry, the notice disappears automatically from member accounts.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.55))
                }

                if let validation = saveValidation {
                    Section {
                        Label(validation, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                    }
                }

                Section {
                    Text(announcement?.published_at == nil
                        ? "Saving creates a private draft. Publishing makes it visible immediately and requests Apple push delivery."
                        : "Saving updates the live notice without sending a second push. Unpublish it from the communications desk to hide it.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.58))
                }
            }
            .scrollContentBackground(.hidden)
            .xertOwnerScreen()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(announcement == nil ? "New Notice" : "Edit Notice")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                actionBar
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { requestClose() }
                        .disabled(isBusy)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focusedField = nil }
                }
            }
            .confirmationDialog("Publish this member notice now?", isPresented: $confirmingPublish, titleVisibility: .visible) {
                Button("Publish to members") {
                    Task { await publishDraft() }
                }
                    .disabled(publishValidation != nil || isBusy)
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text(publishValidation ?? "The notice becomes live on the website and iOS app, and push delivery starts immediately.")
            }
            .confirmationDialog("Discard unsaved notice changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { discardAndDismiss() }
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text("Your title, message, action and expiry edits will be lost.")
            }
        }
        .adminOwnerExitState(
            id: exitStateID,
            title: announcement == nil ? "new member notice" : "member notice changes",
            isDirty: isDirty,
            isBusy: isBusy
        )
        .interactiveDismissDisabled(isDirty || isBusy)
        .onChange(of: draft) { _ in
            hasEditedDuringPresentation = true
        }
        .task(id: draft) {
            await persistRecoveryDraft()
        }
    }

    private var actionBar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { actionButtons }
            VStack(spacing: 10) { actionButtons }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.xertSteel.opacity(0.24)).frame(height: 1)
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        Button {
            focusedField = nil
            Task { await saveDraft() }
        } label: {
            Label(isSaving ? "Saving..." : announcement == nil ? "Save Draft" : "Save Changes", systemImage: "square.and.arrow.down")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(Color.xertSteel)
        .disabled(isBusy || saveValidation != nil || (!isDirty && announcement != nil))
        .accessibilityIdentifier("owner.notice.save")

        Button {
            focusedField = nil
            confirmingPublish = true
        } label: {
            Label(isPublishing ? "Publishing..." : "Publish", systemImage: "paperplane.fill")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.xertSteel)
        .foregroundStyle(Color.xertNavy)
        .disabled(isBusy || publishValidation != nil || announcement?.archived_at != nil)
        .accessibilityIdentifier("owner.notice.publish")
    }

    private func requestClose() {
        focusedField = nil
        if isDirty {
            confirmingDiscard = true
        } else {
            clearRecoveryDraft()
            dismiss()
        }
    }

    private func persistRecoveryDraft() async {
        guard !hasCommitted else { return }
        guard isDirty else {
            if hasEditedDuringPresentation {
                clearRecoveryDraft()
            }
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled, !hasCommitted, !isBusy else { return }
        AdminAnnouncementDraftStore.save(
            draft,
            ownerID: ownerID,
            announcementID: announcement?.id,
            publishRequestID: publishRequestID,
            baselineUpdatedAt: baselineUpdatedAt
        )
    }

    @MainActor
    private func saveDraft() async {
        guard !isBusy, saveValidation == nil else { return }
        guard await onSave(draft) else { return }
        finishCommittedDraft()
    }

    @MainActor
    private func publishDraft() async {
        guard !isBusy, publishValidation == nil else { return }
        guard await onPublish(draft, publishRequestID) else { return }
        finishCommittedDraft()
    }

    @MainActor
    private func finishCommittedDraft() {
        hasCommitted = true
        clearRecoveryDraft()
        dismiss()
    }

    private func discardRecoveredEdits() {
        draft = baseline
        hasExpiry = baseline.expiresAt != nil
        recoveredAt = nil
        clearRecoveryDraft()
        XertHaptics.play(.softImpact)
    }

    private func discardAndDismiss() {
        clearRecoveryDraft()
        dismiss()
    }

    private func clearRecoveryDraft() {
        AdminAnnouncementDraftStore.clear(
            ownerID: ownerID,
            announcementID: announcement?.id
        )
    }
}

private enum AdminOwnerQuickAction: String, Identifiable {
    case newClass
    case newNotice
    case newSessionPack
    case newCoach
    case newEvent

    var id: String { rawValue }
}

private enum AdminOwnerLauncherAction: String, CaseIterable, Identifiable, Equatable {
    case newClass
    case newNotice
    case workout
    case newForm
    case newSessionPack
    case newCoach
    case newEvent

    var id: String { rawValue }

    var title: String {
        switch self {
        case .newClass: return "Create class"
        case .newNotice: return "Publish notice"
        case .workout: return "Set today's workout"
        case .newForm: return "Create form"
        case .newSessionPack: return "Create session pack"
        case .newCoach: return "Add coach"
        case .newEvent: return "Create event"
        }
    }

    var detail: String {
        switch self {
        case .newClass: return "Add a private timetable draft"
        case .newNotice: return "Reach web and iOS members"
        case .workout: return "Update the in-club TV"
        case .newForm: return "Build a survey or waiver"
        case .newSessionPack: return "Start private pricing"
        case .newCoach: return "Add a team profile"
        case .newEvent: return "Add to the training calendar"
        }
    }

    var icon: String {
        switch self {
        case .newClass: return "calendar.badge.plus"
        case .newNotice: return "bell.badge.fill"
        case .workout: return "tv"
        case .newForm: return "list.clipboard"
        case .newSessionPack: return "ticket.fill"
        case .newCoach: return "person.crop.rectangle.badge.plus"
        case .newEvent: return "trophy"
        }
    }

    var requiredSource: String? {
        switch self {
        case .newClass: return "full timetable"
        case .newNotice: return "member notices"
        case .newSessionPack: return "session packs"
        case .newCoach: return "team directory"
        case .newEvent: return "event calendar"
        case .workout, .newForm: return nil
        }
    }

    var workspace: XertOwnerWorkspace? {
        switch self {
        case .workout: return .workouts
        case .newForm: return nil
        default: return nil
        }
    }

    var quickAction: AdminOwnerQuickAction? {
        switch self {
        case .newClass: return .newClass
        case .newNotice: return .newNotice
        case .newSessionPack: return .newSessionPack
        case .newCoach: return .newCoach
        case .newEvent: return .newEvent
        case .workout, .newForm: return nil
        }
    }

    func matches(_ query: String) -> Bool {
        let terms = query
            .lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        guard !terms.isEmpty else { return true }
        let searchableText = [title, detail, rawValue]
            .joined(separator: " ")
            .lowercased()
        return terms.allSatisfy(searchableText.contains)
    }
}

private enum AdminDashboardDataState: Equatable {
    case loading
    case current
    case stale
    case unavailable

    var accessibilityDescription: String {
        switch self {
        case .loading: return "loading"
        case .current: return "current"
        case .stale: return "from the last loaded snapshot"
        case .unavailable: return "unavailable"
        }
    }
}

private struct AdminOwnerFreshnessBadge: View {
    let isLoading: Bool
    let unavailableCount: Int
    let updatedAt: Date?

    private var label: String {
        if isLoading { return "Refreshing" }
        if unavailableCount > 0 { return "Partial data" }
        if let updatedAt { return "Updated \(updatedAt.formatted(date: .omitted, time: .shortened))" }
        return "Connecting"
    }

    private var icon: String {
        if isLoading { return "arrow.clockwise" }
        if unavailableCount > 0 { return "exclamationmark.triangle.fill" }
        if updatedAt != nil { return "checkmark.circle.fill" }
        return "antenna.radiowaves.left.and.right"
    }

    private var colour: Color {
        unavailableCount > 0 ? .orange : Color.xertSteel
    }

    var body: some View {
        Label(label, systemImage: icon)
            .font(.caption.weight(.bold))
            .foregroundStyle(colour)
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .background(colour.opacity(0.12))
            .clipShape(Capsule())
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel(
                isLoading
                    ? "Refreshing Command Centre data"
                    : unavailableCount > 0
                        ? "Partial Command Centre data, \(unavailableCount) services unavailable"
                        : updatedAt.map { "Command Centre data updated at \($0.formatted(date: .omitted, time: .shortened))" }
                            ?? "Connecting Command Centre data"
            )
    }
}

private struct AdminHubCard: View {
    let section: XertOwnerWorkspaceSection
    let badge: Int
    let isExpanded: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    ZStack {
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .fill(Color.xertSteel.opacity(isExpanded ? 0.28 : 0.14))
                        Image(systemName: section.icon)
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(Color.xertSteel)
                    }
                    .frame(width: 44, height: 44)
                    Spacer(minLength: 4)
                    if badge > 0 {
                        Text(badge > 99 ? "99+" : "\(badge)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.xertNavy)
                            .padding(.horizontal, 7)
                            .frame(minHeight: 20)
                            .background(Color.xertSteel)
                            .clipShape(Capsule())
                    }
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.xertSteel.opacity(0.7))
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(section.rawValue)
                        .font(.headline)
                        .foregroundStyle(Color.xertOffWhite)
                    Text(section.detail)
                        .font(.caption)
                        .foregroundStyle(Color.xertPale.opacity(0.62))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .padding(XertSpace.lg)
            .xertCardStyle()
            .overlay {
                if isExpanded {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Color.xertSteel.opacity(0.5), lineWidth: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(section.rawValue). \(section.detail)\(badge > 0 ? ". \(badge) open" : "")")
        .accessibilityHint(isExpanded ? "Hides this hub's screens" : "Shows this hub's screens")
        .accessibilityAddTraits(isExpanded ? .isSelected : [])
    }
}

private struct AdminQuickToolButton: View {
    let title: String
    let detail: String
    let icon: String
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(Color.xertSteel.opacity(isEnabled ? 0.14 : 0.07))
                    Image(systemName: icon)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(isEnabled ? Color.xertSteel : Color.xertPale.opacity(0.35))
                }
                .frame(width: 44, height: 44)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(isEnabled ? Color.xertOffWhite : Color.xertPale.opacity(0.45))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(isEnabled ? Color.xertPale.opacity(0.62) : Color.orange.opacity(0.8))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Image(systemName: "arrow.up.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(isEnabled ? Color.xertSteel : Color.xertPale.opacity(0.25))
            }
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .padding(.horizontal, XertSpace.md)
            .padding(.vertical, XertSpace.sm)
            .xertCardStyle()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel("\(title). \(detail)")
        .accessibilityHint(isEnabled ? "Opens this owner tool" : "Retry Command Centre data to enable this tool")
    }
}

private struct AdminPriorityAction: Identifiable {
    let title: String
    let detail: String
    let icon: String
    let count: Int
    let workspace: XertOwnerWorkspace
    var task: XertOwnerTask? = nil
    var isCritical = false

    var route: XertOwnerRoute {
        task.map { XertOwnerRoute(task: $0) } ?? XertOwnerRoute(workspace: workspace)
    }

    var actionTitle: String {
        task == nil ? "Open" : "Open this one"
    }

    var id: String { "\(route.restorationValue):\(title)" }
}

private struct AdminOwnerRunNextBar: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let priority: AdminPriorityAction
    let isRefreshing: Bool
    let onOpen: () -> Void
    let onRefresh: () -> Void

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 6) {
                    runNextButton
                    refreshButton(showsLabel: true)
                }
            } else {
                HStack(spacing: 10) {
                    runNextButton
                    refreshButton(showsLabel: false)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.xertInk.opacity(0.98))
        .overlay(alignment: .top) {
            Rectangle().fill(Color.xertSteel.opacity(0.28)).frame(height: 1)
        }
        .accessibilityIdentifier("owner.runNextDock")
    }

    private var runNextButton: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Image(systemName: priority.icon)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(priority.isCritical ? Color.red : Color.xertSteel)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(priority.isCritical ? "RUN CRITICAL NEXT" : "RUN NEXT")
                        .font(.system(size: 9, weight: .black))
                        .tracking(1.1)
                        .foregroundStyle(priority.isCritical ? Color.red : Color.xertSteel)
                    Text("\(priority.title) · \(priority.count)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertOffWhite)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .minimumScaleFactor(0.78)
                }
                Spacer(minLength: 4)
                Image(systemName: "arrow.right")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.xertSteel)
            }
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(priority.isCritical ? "Critical. " : "")Run next: \(priority.title), \(priority.count)"
        )
        .accessibilityHint(priority.actionTitle)
    }

    private func refreshButton(showsLabel: Bool) -> some View {
        Button(action: onRefresh) {
            Group {
                if isRefreshing {
                    ProgressView().tint(Color.xertSteel)
                } else if showsLabel {
                    Label("Refresh queues", systemImage: "arrow.clockwise")
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .frame(
                maxWidth: showsLabel ? .infinity : nil,
                minHeight: 44
            )
            .frame(width: showsLabel ? nil : 44)
        }
        .buttonStyle(.plain)
        .disabled(isRefreshing)
        .foregroundStyle(Color.xertSteel)
        .accessibilityLabel(isRefreshing ? "Refreshing operational queues" : "Refresh operational queues")
    }
}

private struct AdminOwnerQueuesClearBar: View {
    let updatedAt: Date?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    var body: some View {
        Button(action: onRefresh) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.subheadline.weight(.bold))
                VStack(alignment: .leading, spacing: 2) {
                    Text(isRefreshing ? "CHECKING OPERATIONS" : "ALL QUEUES CLEAR")
                        .font(.system(size: 9, weight: .black))
                        .tracking(1.1)
                    if let updatedAt {
                        Text("Complete snapshot updated \(updatedAt, style: .relative)")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.72))
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Complete operational snapshot")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale.opacity(0.72))
                    }
                }
                Spacer(minLength: 4)
                if isRefreshing {
                    ProgressView().tint(Color.xertSteel)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.subheadline.weight(.bold))
                }
            }
            .foregroundStyle(Color.xertSteel)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isRefreshing)
        .background(Color.xertInk.opacity(0.98))
        .overlay(alignment: .top) {
            Rectangle().fill(Color.xertSteel.opacity(0.28)).frame(height: 1)
        }
        .accessibilityLabel(
            isRefreshing ? "Checking operational queues" : "All operational queues clear"
        )
        .accessibilityValue(
            updatedAt.map {
                "Complete snapshot updated \($0.formatted(date: .omitted, time: .shortened))"
            } ?? "Complete operational snapshot"
        )
        .accessibilityHint("Refreshes the owner operational snapshot")
        .accessibilityIdentifier("owner.runNextDock.clear")
    }
}

private struct AdminOwnerRunNextRefreshBar: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let freshness: AdminOperationalFreshness
    let isRefreshing: Bool
    let onRefresh: () -> Void

    var body: some View {
        Button(action: onRefresh) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) {
                        refreshBarCopy
                        if isRefreshing {
                            ProgressView().tint(Color.xertSteel)
                        }
                    }
                } else {
                    HStack(spacing: 10) {
                        refreshBarCopy
                        Spacer(minLength: 4)
                        if isRefreshing {
                            ProgressView().tint(Color.xertSteel)
                        }
                    }
                }
            }
            .foregroundStyle(Color.xertSteel)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isRefreshing)
        .background(Color.xertInk.opacity(0.98))
        .overlay(alignment: .top) {
            Rectangle().fill(Color.xertSteel.opacity(0.28)).frame(height: 1)
        }
        .accessibilityLabel(
            isRefreshing ? "Updating operational queues" : "Refresh operational queues to run the next action"
        )
        .accessibilityHint("Prevents acting from stale or incomplete owner data")
        .accessibilityIdentifier("owner.runNextDock.refresh")
    }

    private var refreshBarCopy: some View {
        HStack(spacing: 10) {
            Image(systemName: freshness == .unavailable
                ? "wifi.exclamationmark"
                : "arrow.clockwise")
            VStack(alignment: .leading, spacing: 2) {
                Text(isRefreshing ? "UPDATING OPERATIONS" : "REFRESH TO RUN NEXT")
                    .font(.system(size: 9, weight: .black))
                    .tracking(1.1)
                Text("Actions unlock only from a current complete snapshot")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale.opacity(0.72))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct AdminPriorityRow: View {
    let priority: AdminPriorityAction
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) {
                    priorityIcon
                    priorityCopy
                    Spacer(minLength: 8)
                    countBadge
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.xertSteel)
                }

                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        priorityIcon
                        Text(priority.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.xertOffWhite)
                        Spacer(minLength: 8)
                        countBadge
                    }
                    Text(priority.detail)
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale.opacity(0.78))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        if priority.isCritical {
                            Label("Critical", systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(Color.red)
                        }
                        Spacer()
                        Label(priority.actionTitle, systemImage: "arrow.right")
                            .foregroundStyle(Color.xertSteel)
                    }
                    .font(.caption.weight(.bold))
                }
            }
            .padding(XertSpace.lg)
            .xertCardStyle()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(priority.isCritical ? "Critical, " : "")\(priority.title), \(priority.count)")
        .accessibilityHint("\(priority.detail). \(priority.actionTitle).")
    }

    private var priorityIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill((priority.isCritical ? Color.red : Color.xertSteel).opacity(0.14))
            Image(systemName: priority.icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(priority.isCritical ? Color.red : Color.xertSteel)
        }
        .frame(width: 42, height: 42)
    }

    private var priorityCopy: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(priority.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.xertOffWhite)
            Text(priority.detail)
                .font(.caption)
                .foregroundStyle(Color.xertPale.opacity(0.72))
                .lineLimit(2)
        }
    }

    private var countBadge: some View {
        Text(priority.count > 99 ? "99+" : priority.count.formatted())
            .font(.caption.weight(.black))
            .foregroundStyle(priority.isCritical ? Color.white : Color.xertNavy)
            .padding(.horizontal, 8)
            .frame(minWidth: 30, minHeight: 26)
            .background(priority.isCritical ? Color.red : Color.xertSteel)
            .clipShape(Capsule())
    }
}

private struct AdminOperationalDataWarning: View {
    let unavailableSources: [String]

    var body: some View {
        Label {
            Text("Partial data: \(unavailableSources.joined(separator: ", ")). Existing items remain available; pull to retry.")
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Color.orange)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.orange.opacity(0.08))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.orange.opacity(0.42), lineWidth: 1)
        }
        .accessibilityLabel("Operational data is partial. Unavailable: \(unavailableSources.joined(separator: ", "))")
    }
}

private struct AdminOwnerDataHealthBar: View {
    let unavailableCount: Int
    let retainedSnapshotCount: Int
    let isRetrying: Bool
    let onRetry: () -> Void

    private var statusText: String {
        let serviceText = "\(unavailableCount) data service" + (unavailableCount == 1 ? "" : "s")
        guard retainedSnapshotCount > 0 else {
            return "\(serviceText) unavailable"
        }
        let attentionVerb = unavailableCount == 1 ? "needs" : "need"
        return "\(serviceText) \(attentionVerb) attention, \(retainedSnapshotCount) showing last snapshot"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.orange)

            Text(statusText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.xertOffWhite)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 4)

            Button(action: onRetry) {
                if isRetrying {
                    ProgressView()
                        .tint(Color.orange)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .frame(width: 44, height: 44)
            .foregroundStyle(Color.orange)
            .disabled(isRetrying)
            .accessibilityLabel(isRetrying ? "Retrying owner data" : "Retry unavailable owner data")
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .background(Color.xertInk.opacity(0.98))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.orange.opacity(0.5))
                .frame(height: 1)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct AdminRefreshDataWarning: View {
    let unavailableSources: [String]
    let cachedSources: Set<String>
    let isRetrying: Bool
    let onRetry: () -> Void
    @State private var showingDetails = false

    private var retainedSourceCount: Int {
        unavailableSources.filter(cachedSources.contains).count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(unavailableSources.count) data service\(unavailableSources.count == 1 ? "" : "s") need\(unavailableSources.count == 1 ? "s" : "") attention")
                        .font(.subheadline.weight(.bold))
                    Text(retainedSourceCount > 0
                        ? "\(retainedSourceCount) area\(retainedSourceCount == 1 ? " is" : "s are") showing the last loaded snapshot. Other available tools still work."
                        : "Unavailable totals are hidden so they cannot be mistaken for zero. Other available tools still work.")
                        .font(.caption)
                        .foregroundStyle(Color.orange.opacity(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                }
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }

            DisclosureGroup(isExpanded: $showingDetails) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(unavailableSources, id: \.self) { source in
                        Label(
                            source.capitalized + (cachedSources.contains(source) ? " — last snapshot" : " — unavailable"),
                            systemImage: cachedSources.contains(source) ? "clock.badge.exclamationmark" : "xmark.circle"
                        )
                    }
                }
                .font(.caption)
                .padding(.top, 8)
            } label: {
                Text(showingDetails ? "Hide affected areas" : "Show affected areas")
                    .font(.caption.weight(.bold))
            }
            .tint(Color.orange)

            Button(action: onRetry) {
                HStack(spacing: 8) {
                    if isRetrying {
                        ProgressView().tint(Color.xertNavy)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                    Text(isRetrying ? "Retrying…" : "Retry unavailable data")
                }
                .font(.subheadline.weight(.bold))
                // The banner paints its whole VStack orange; without an explicit
                // label colour the prominent orange fill renders the title
                // invisible (orange on orange).
                .foregroundStyle(Color.xertNavy)
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.orange)
            .disabled(isRetrying)
            .accessibilityLabel(isRetrying ? "Retrying unavailable Command Centre data" : "Retry unavailable Command Centre data")
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Color.orange)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.orange.opacity(0.08))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.orange.opacity(0.42), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Command Centre data is partial. Unavailable: \(unavailableSources.joined(separator: ", ")). "
                + "\(retainedSourceCount) areas retain their last snapshot."
        )
    }
}

private struct AdminMetricTile: View {
    let title: String
    let value: Int
    let icon: String
    let dataState: AdminDashboardDataState
    let action: (() -> Void)?

    init(
        title: String,
        value: Int,
        icon: String,
        dataState: AdminDashboardDataState = .current,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.value = value
        self.icon = icon
        self.dataState = dataState
        self.action = action
    }

    var body: some View {
        Group {
            if let action {
                Button(action: action) { tileContent }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens \(title.lowercased())")
            } else {
                tileContent
            }
        }
    }

    private var tileContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: icon).foregroundStyle(Color.xertSteel)
                Spacer()
                dataStateBadge
                if action != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.xertSteel.opacity(0.6))
                }
            }
            metricValue
            Text(title.uppercased()).font(.caption2.weight(.bold)).tracking(1).foregroundStyle(Color.xertPale.opacity(0.55))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(XertSpace.lg)
        .xertCardStyle()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(accessibleValue), \(dataState.accessibilityDescription)")
    }

    @ViewBuilder
    private var metricValue: some View {
        switch dataState {
        case .loading:
            ProgressView()
                .tint(Color.xertSteel)
                .frame(height: 36, alignment: .leading)
        case .unavailable:
            Text("—").xertDisplay(30).foregroundStyle(Color.xertPale.opacity(0.5))
        case .current, .stale:
            Text(value.formatted()).xertDisplay(30).foregroundStyle(Color.xertOffWhite)
        }
    }

    @ViewBuilder
    private var dataStateBadge: some View {
        switch dataState {
        case .stale:
            Text("LAST")
                .font(.system(size: 8, weight: .black))
                .foregroundStyle(.orange)
        case .unavailable:
            Image(systemName: "wifi.exclamationmark")
                .font(.caption2)
                .foregroundStyle(.orange)
        case .loading, .current:
            EmptyView()
        }
    }

    private var accessibleValue: String {
        switch dataState {
        case .loading: return "loading"
        case .unavailable: return "value unavailable"
        case .current, .stale: return value.formatted()
        }
    }
}

private struct AdminMoneyTile: View {
    let title: String
    let cents: Int
    let dataState: AdminDashboardDataState
    let action: (() -> Void)?

    init(
        title: String,
        cents: Int,
        dataState: AdminDashboardDataState = .current,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.cents = cents
        self.dataState = dataState
        self.action = action
    }

    var body: some View {
        Group {
            if let action {
                Button(action: action) { tileContent }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens finance")
            } else {
                tileContent
            }
        }
    }

    private var tileContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "dollarsign.circle").foregroundStyle(Color.xertSteel)
                Spacer()
                if dataState == .stale {
                    Text("LAST")
                        .font(.system(size: 8, weight: .black))
                        .foregroundStyle(.orange)
                } else if dataState == .unavailable {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                if action != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.xertSteel.opacity(0.6))
                }
            }
            moneyValue
            Text(title.uppercased()).font(.caption2.weight(.bold)).tracking(1).foregroundStyle(Color.xertPale.opacity(0.55))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(XertSpace.lg)
        .xertCardStyle()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(accessibleValue), \(dataState.accessibilityDescription)")
    }

    @ViewBuilder
    private var moneyValue: some View {
        switch dataState {
        case .loading:
            ProgressView()
                .tint(Color.xertSteel)
                .frame(height: 28, alignment: .leading)
        case .unavailable:
            Text("—")
                .font(.title3.weight(.bold))
                .foregroundStyle(Color.xertPale.opacity(0.5))
        case .current, .stale:
            Text((Double(cents) / 100).formatted(.currency(code: "AUD")))
                .font(.title3.weight(.bold))
                .foregroundStyle(Color.xertOffWhite)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }

    private var accessibleValue: String {
        switch dataState {
        case .loading: return "loading"
        case .unavailable: return "value unavailable"
        case .current, .stale:
            return (Double(cents) / 100).formatted(.currency(code: "AUD"))
        }
    }
}

private struct FinanceSummaryRow: View {
    let label: String
    let cents: Int
    var currency = "AUD"

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Text((Double(cents) / 100).formatted(.currency(code: currency))).fontWeight(.bold)
        }
        .foregroundStyle(Color.xertOffWhite)
        .listRowBackground(Color.xertInk)
    }
}

// Thin wrapper over the shared owner row so every call site here picks up the
// design system without touching hundreds of usages.
private struct AdminDestinationRow: View {
    let title: String
    let detail: String
    let icon: String
    let onOpen: () -> Void

    var body: some View {
        XertOwnerRow(title: title, detail: detail, icon: icon, onOpen: onOpen)
    }
}

private struct AdminEmptyState: View {
    let icon: String
    let text: String

    var body: some View {
        XertOwnerEmptyState(icon: icon, text: text)
    }
}

private func adminHeading(_ title: String) -> some View {
    XertOwnerHeading(title)
}
