import Foundation
import Combine
import UIKit

@MainActor
final class XertStore: ObservableObject {
    @Published var products: [Product] = []
    @Published var sessions: [ClassSession] = []
    @Published var events: [EventItem] = []
    @Published var coaches: [AdminCoach] = []
    @Published var siteContent: [AdminSiteContentRow] = []
    @Published var credits: [CreditBatch] = []
    @Published var bookings: [BookingItem] = []
    @Published var orders: [OrderItem] = []
    @Published var privateSessionRequests: [PrivateSessionStatusItem] = []
    @Published var announcements: [MemberAnnouncement] = []
    @Published var eventGoalIDs: Set<UUID> = []
    @Published var profile: MemberProfile?
    @Published private(set) var memberOnboarding: MemberOnboardingState?
    @Published var authSession: AuthSession?
    @Published private(set) var creditBalanceLoaded = false
    @Published private(set) var memberBookingsEnabled = false
    @Published private(set) var bookingAvailabilityLoaded = false
    @Published private(set) var sessionPackPricesComingSoon = true
    @Published private(set) var sessionPackPaymentsEnabled = false
    @Published private(set) var platformProvider = XertPlatformProviderResolution.unavailable
    @Published private(set) var paymentAvailabilityLoaded = false
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var bookingSessionID: UUID?
    @Published var cancellingBookingID: UUID?
    @Published var isSavingProfile = false
    @Published private(set) var onboardingLoaded = false
    @Published private(set) var isLoadingMemberOnboarding = false
    @Published private(set) var isSavingMemberOnboarding = false
    @Published private(set) var onboardingErrorMessage: String?
    @Published var isUpdatingPassword = false
    @Published var isRequestingPasswordReset = false
    @Published var updatingEventGoalID: UUID?
    @Published var dismissingAnnouncementID: UUID?
    @Published var isDeletingAccount = false
    @Published var isRequestingPrivateSession = false
    @Published var isRequestingClassInterest = false
    @Published var isSubmittingInterest = false
    @Published private(set) var classRemindersEnabled = ClassReminderPreference.isEnabled()
    @Published private(set) var classReminderLeadTime = ClassReminderPreference.leadTime()
    @Published private(set) var classReminderSyncState: ClassReminderSyncState = .off
    @Published private(set) var memberPushEnabled = MemberPushPreference.isEnabled()
    @Published private(set) var memberPushDeliveryState: MemberPushDeliveryState =
        MemberPushPreference.isEnabled() ? .awaitingDeviceToken : .off
    @Published private(set) var isUpdatingMemberPush = false
    @Published private(set) var isUpdatingReminderPreference = false
    @Published private(set) var isReconcilingCheckout = false
    @Published private(set) var isCheckoutConfirmationPending = false
    @Published private(set) var checkoutActivatedSessionID: UUID?
    @Published private(set) var hasBootstrapped = false
    @Published private(set) var isUsingCachedPublicData = false
    @Published private(set) var publicDataUpdatedAt: Date?
    @Published private(set) var isUsingStaleMemberData = false
    @Published private(set) var memberDataUpdatedAt: Date?
    @Published private(set) var unavailableDataSources: Set<XertDataSource> = []
    @Published private(set) var authenticationRecoveryRequired = false

    private let api = XertAPI()
    private var bootstrapTask: Task<Void, Never>?
    private var sessionRefreshTask: Task<AuthSession, Error>?
    private var dataRefreshTask: Task<Void, Never>?
    private var lastRefreshCompletedAt: Date?
    private var requiresBootstrapRefresh = false
    private var dataRefreshVersion = MemberStateVersion()
    private var memberStateVersion = MemberStateVersion()
    private var announcementStateVersion = MemberStateVersion()
    private var onboardingOperationVersion = MemberStateVersion()
    private static let memberDataSources: Set<XertDataSource> = [
        .credits, .bookings, .orders, .profile, .onboarding, .eventGoals, .privateSessions, .announcements,
    ]

    var isSignedIn: Bool {
        authSession != nil
    }

    var creditTotal: Int {
        credits.reduce(0) { $0 + $1.remaining }
    }

    var creditExpirySummary: CreditExpirySummary? {
        credits.expirySummary()
    }

    func publicContent(for section: AdminSiteContentSection) -> AdminSiteContentData {
        let saved = siteContent.first { $0.key == section.rawValue }?.data ?? AdminSiteContentData()
        return saved.merged(over: .defaults(for: section))
    }

    func submitInterest(kind: NativeInterestKind, draft: NativeInterestDraft) async -> Bool {
        guard !isSubmittingInterest else { return false }
        isSubmittingInterest = true
        defer { isSubmittingInterest = false }
        do {
            switch kind {
            case .member: try await api.submitMemberInterest(MemberInterestSubmission(draft))
            case .trainer: try await api.submitTrainerInterest(TrainerInterestSubmission(draft))
            case .partner: try await api.submitPartnerInterest(PartnerInterestSubmission(draft))
            }
            XertHaptics.play(.success)
            return true
        } catch {
            present(error)
            XertHaptics.play(.error)
            return false
        }
    }

    func bootstrap() async {
        if let bootstrapTask {
            await bootstrapTask.value
            return
        }
        guard !hasBootstrapped else { return }

        let task = Task { await performBootstrap() }
        bootstrapTask = task
        await task.value
        bootstrapTask = nil
    }

    private func performBootstrap() async {
        if let cached = await PublicDataCache.loadAsync() {
            products = cached.products
            sessions = cached.sessions
            events = cached.events
            coaches = cached.coaches
            siteContent = cached.siteContent
            publicDataUpdatedAt = cached.savedAt
            isUsingCachedPublicData = true
        }
        authSession = KeychainStore.loadSession()
        if let userID = authSession?.user?.id,
           let cachedBookings = await MemberBookingCache.loadAsync(for: userID) {
            guard authSession?.user?.id == userID else { return }
            bookings = cachedBookings.bookings
            memberDataUpdatedAt = cachedBookings.savedAt
            isUsingStaleMemberData = true
        }
        repeat {
            requiresBootstrapRefresh = false
            await refresh()
        } while requiresBootstrapRefresh || lastRefreshCompletedAt == nil
        hasBootstrapped = true
        await reconcilePendingCheckout()
        await restoreMemberPushRegistration()
    }

    func refresh() async {
        if let dataRefreshTask {
            await dataRefreshTask.value
            return
        }

        dataRefreshVersion.invalidate()
        let refreshVersion = dataRefreshVersion.snapshot
        let memberVersion = memberStateVersion.snapshot
        let announcementVersion = announcementStateVersion.snapshot
        let task = Task {
            await performRefresh(
                refreshVersion: refreshVersion,
                memberVersion: memberVersion,
                announcementVersion: announcementVersion
            )
        }
        dataRefreshTask = task
        await task.value
        if dataRefreshVersion.isCurrent(refreshVersion) {
            dataRefreshTask = nil
            lastRefreshCompletedAt = Date()
        }
    }

    /// Lifecycle activation can fire several times around system sheets,
    /// authentication and checkout. Keep explicit pull-to-refresh immediate,
    /// while coalescing automatic foreground refreshes that would otherwise
    /// repeat the complete public and member request fan-out.
    func refreshIfStale(
        maximumAge: TimeInterval = 45,
        now: Date = Date()
    ) async {
        if let lastRefreshCompletedAt {
            let age = now.timeIntervalSince(lastRefreshCompletedAt)
            if age >= 0, age < max(10, maximumAge) { return }
        }
        await refresh()
    }

    private func performRefresh(
        refreshVersion: Int,
        memberVersion: Int,
        announcementVersion: Int
    ) async {
        isLoading = true
        errorMessage = nil
        unavailableDataSources = []
        // Invalidate the old provider selection while the singleton setting is
        // refreshed so no booking, cancellation or checkout can race a switch.
        platformProvider = .unavailable
        defer {
            if dataRefreshVersion.isCurrent(refreshVersion) {
                isLoading = false
            }
        }

        async let productRequest = api.products()
        async let sessionRequest = api.sessions()
        async let eventRequest = api.events()
        async let coachRequest = api.coaches()
        async let siteContentRequest = api.siteContent()
        async let platformSettingsRequest = api.publicPlatformSettings()

        var productsLoaded = false
        var sessionsLoaded = false
        var eventsLoaded = false

        do {
            let loadedProducts = try await productRequest
            guard canApplyRefresh(refreshVersion) else { return }
            products = loadedProducts
            productsLoaded = true
        } catch {
            guard canApplyRefresh(refreshVersion) else { return }
            unavailableDataSources.insert(.products)
        }

        do {
            let loadedCoaches = try await coachRequest
            guard canApplyRefresh(refreshVersion) else { return }
            coaches = loadedCoaches
        } catch {
            guard canApplyRefresh(refreshVersion) else { return }
            unavailableDataSources.insert(.coaches)
        }

        do {
            let loadedContent = try await siteContentRequest
            guard canApplyRefresh(refreshVersion) else { return }
            siteContent = loadedContent
        } catch {
            guard canApplyRefresh(refreshVersion) else { return }
            unavailableDataSources.insert(.siteContent)
        }

        do {
            let loadedSettings = try await platformSettingsRequest
            guard canApplyRefresh(refreshVersion) else { return }
            let provider = loadedSettings?.providerResolution ?? .unavailable
            platformProvider = provider
            memberBookingsEnabled = provider.provider == .native
                && provider.capabilities.nativeBookingMutations
                && loadedSettings?.bookings_enabled == true
            bookingAvailabilityLoaded = true
            sessionPackPricesComingSoon = loadedSettings?.prices_coming_soon ?? true
            sessionPackPaymentsEnabled = provider.provider == .native
                && provider.capabilities.nativePackCheckout
                && loadedSettings?.sessionPackCheckoutEnabled == true
            paymentAvailabilityLoaded = true
        } catch {
            guard canApplyRefresh(refreshVersion) else { return }
            platformProvider = .unavailable
            memberBookingsEnabled = false
            bookingAvailabilityLoaded = true
            sessionPackPricesComingSoon = true
            sessionPackPaymentsEnabled = false
            paymentAvailabilityLoaded = true
            unavailableDataSources.insert(.platformSettings)
        }

        do {
            let loadedSessions = try await sessionRequest
            guard canApplyRefresh(refreshVersion) else { return }
            sessions = loadedSessions
            sessionsLoaded = true
        } catch {
            guard canApplyRefresh(refreshVersion) else { return }
            unavailableDataSources.insert(.sessions)
        }

        do {
            let loadedEvents = try await eventRequest
            guard canApplyRefresh(refreshVersion) else { return }
            events = loadedEvents.isEmpty ? XertEventCalendar.fallback : loadedEvents
            eventsLoaded = true
        } catch {
            guard canApplyRefresh(refreshVersion) else { return }
            unavailableDataSources.insert(.events)
            // The app still carries the published 2026 training calendar when
            // the events table has not been seeded yet.
            if events.isEmpty { events = XertEventCalendar.fallback }
        }

        if productsLoaded && sessionsLoaded && eventsLoaded {
            let snapshot = PublicDataSnapshot(
                products: products,
                sessions: sessions,
                events: events,
                coaches: coaches,
                siteContent: siteContent
            )
            await PublicDataCache.saveAsync(snapshot)
            guard canApplyRefresh(refreshVersion) else { return }
            publicDataUpdatedAt = snapshot.savedAt
            isUsingCachedPublicData = false
        } else {
            isUsingCachedPublicData = publicDataUpdatedAt != nil
        }

        var memberSession: AuthSession?
        if authSession != nil {
            do {
                memberSession = try await validAuthSession()
                guard canApplyMemberState(memberVersion, session: memberSession) && canApplyRefresh(refreshVersion) else { return }
            } catch {
                guard memberStateVersion.isCurrent(memberVersion) && canApplyRefresh(refreshVersion) else { return }
                if (error as? APIError)?.invalidatesSession == true {
                    await expireCurrentSession(
                        message: "Your XERT session has expired. Sign in again to continue."
                    )
                } else {
                    unavailableDataSources.formUnion(Self.memberDataSources)
                    isUsingStaleMemberData = memberDataUpdatedAt != nil
                }
                present(error)
                return
            }
        }

        if let authSession = memberSession {
            async let creditRequest = api.credits(session: authSession)
            async let bookingRequest = api.bookings(session: authSession)
            async let orderRequest = api.orders(session: authSession)
            async let profileRequest = api.profile(session: authSession)
            let onboardingVersion = beginMemberOnboardingRead()
            async let onboardingRequest = loadMemberOnboardingIfRequested(
                session: authSession,
                operationVersion: onboardingVersion
            )
            async let eventGoalRequest = api.eventGoals(session: authSession)
            async let privateSessionRequest = api.privateSessionRequests(session: authSession)
            async let announcementRequest = api.announcements(session: authSession)
            var creditsLoaded = false
            var bookingsLoaded = false
            var ordersLoaded = false
            var profileLoaded = false
            do {
                let loadedCredits = try await creditRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                credits = loadedCredits
                creditBalanceLoaded = true
                creditsLoaded = true
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                unavailableDataSources.insert(.credits)
            }
            do {
                let loadedBookings = try await bookingRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                bookings = loadedBookings
                guard await saveBookingSnapshot(
                    loadedBookings,
                    memberVersion: memberVersion,
                    session: authSession,
                    refreshVersion: refreshVersion
                ) else { return }
                if classRemindersEnabled {
                    let reminderState = await ClassReminderScheduler.shared.sync(
                        bookings: loadedBookings,
                        leadTime: classReminderLeadTime
                    )
                    applyClassReminderSyncState(reminderState)
                } else {
                    await ClassReminderScheduler.shared.clearAll()
                    classReminderSyncState = .off
                }
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                bookingsLoaded = true
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                unavailableDataSources.insert(.bookings)
            }
            do {
                let loadedOrders = try await orderRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                orders = loadedOrders
                ordersLoaded = true
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                unavailableDataSources.insert(.orders)
            }
            do {
                let loadedProfile = try await profileRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                profile = loadedProfile
                profileLoaded = true
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                unavailableDataSources.insert(.profile)
            }
            do {
                let loadedOnboarding = try await onboardingRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                if let onboardingVersion,
                   let loadedOnboarding,
                   onboardingOperationVersion.isCurrent(onboardingVersion) {
                    finishMemberOnboardingRead(operationVersion: onboardingVersion)
                    applyMemberOnboarding(loadedOnboarding)
                }
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                if let onboardingVersion,
                   onboardingOperationVersion.isCurrent(onboardingVersion) {
                    finishMemberOnboardingRead(operationVersion: onboardingVersion)
                    unavailableDataSources.insert(.onboarding)
                }
            }
            do {
                let loadedEventGoals = try await eventGoalRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                eventGoalIDs = Set(loadedEventGoals.map(\.event_id))
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                unavailableDataSources.insert(.eventGoals)
                // Event goals are optional until the companion Supabase upgrade
                // is applied; keep the rest of the member account available.
            }

            do {
                let loadedRequests = try await privateSessionRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                privateSessionRequests = loadedRequests
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                unavailableDataSources.insert(.privateSessions)
                // Tracking is optional until the additive ownership migration
                // reaches an existing Supabase project.
            }

            do {
                let loadedAnnouncements = try await announcementRequest
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                if announcementStateVersion.isCurrent(announcementVersion) {
                    announcements = loadedAnnouncements
                }
            } catch {
                guard canApplyMemberState(memberVersion, session: authSession) && canApplyRefresh(refreshVersion) else { return }
                if announcementStateVersion.isCurrent(announcementVersion) {
                    unavailableDataSources.insert(.announcements)
                }
                // Announcements are additive and cannot make bookings or credits unavailable.
            }

            if creditsLoaded && bookingsLoaded && ordersLoaded && profileLoaded {
                memberDataUpdatedAt = Date()
                isUsingStaleMemberData = false
            } else {
                isUsingStaleMemberData = memberDataUpdatedAt != nil
            }
        } else {
            guard memberStateVersion.isCurrent(memberVersion) && canApplyRefresh(refreshVersion) else { return }
            clearMemberData()
            await ClassReminderScheduler.shared.clearAll()
        }
    }

    func signIn(email: String, password: String) async {
        await authenticate {
            try await api.signIn(email: email, password: password)
        }
    }

    func signUp(
        fullName: String,
        email: String,
        phone: String,
        password: String,
        confirmation: String,
        acceptedTerms: Bool
    ) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let request = try MemberSignUpRequest(
                fullName: fullName,
                email: email,
                phone: phone,
                password: password,
                confirmation: confirmation,
                acceptedTerms: acceptedTerms
            )
            guard let session = try await api.signUp(request) else {
                errorMessage = "Check your email to confirm your XERT account, then sign in."
                XertHaptics.play(.success)
                return
            }
            replaceAuthSession(with: session)
            try KeychainStore.saveSession(session)
            await refresh()
            await reconcilePendingCheckout()
            await restoreMemberPushRegistration()
            XertHaptics.play(.success)
        } catch {
            errorMessage = error.localizedDescription
            XertHaptics.play(.error)
        }
    }

    @discardableResult
    func requestPasswordReset(email: String) async -> Bool {
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedEmail.isEmpty else {
            errorMessage = "Enter your email address to request a password reset."
            XertHaptics.play(.warning)
            return false
        }

        isRequestingPasswordReset = true
        defer { isRequestingPasswordReset = false }
        do {
            try await api.requestPasswordReset(email: normalizedEmail)
            XertHaptics.play(.success)
            return true
        } catch {
            present(error)
            XertHaptics.play(.error)
            return false
        }
    }

    func signOut() {
        let currentSession = authSession
        let currentUserID = currentSession?.user?.id ?? profile?.id
        let pushToken = PushDeviceTokenStore.load()
        MemberPushRegistration.stopReceivingPrivateNotices()
        clearLocalMemberState(for: currentUserID)
        replaceAuthSession(with: nil)
        KeychainStore.clearSession()
        XertHaptics.play(.softImpact)
        Task {
            await ClassReminderScheduler.shared.clearAll()
            if let currentSession {
                if let pushToken { try? await api.updatePushSubscription(session: currentSession, token: pushToken, enabled: false) }
                try? await api.signOut(session: currentSession)
            }
        }
    }

    func consumeAuthenticationRecovery() {
        authenticationRecoveryRequired = false
    }

    @discardableResult
    func deleteAccount() async -> Bool {
        let memberVersion = memberStateVersion.snapshot
        errorMessage = nil
        isDeletingAccount = true
        defer {
            if memberStateVersion.isCurrent(memberVersion) { isDeletingAccount = false }
        }
        do {
            let authSession = try await validAuthSession()
            let currentUserID = authSession.user?.id ?? profile?.id
            try await api.deleteAccount(session: authSession)
            MemberPushRegistration.stopReceivingPrivateNotices()
            clearLocalMemberState(for: currentUserID)
            replaceAuthSession(with: nil)
            KeychainStore.clearSession()
            await ClassReminderScheduler.shared.clearAll()
            XertHaptics.play(.success)
            return true
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return false }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return false
            }
            present(error)
            XertHaptics.play(.error)
            return false
        }
    }

    @discardableResult
    func book(_ session: ClassSession) async -> MemberBookingOutcome {
        if let message = memberBookingControlError() {
            errorMessage = message
            XertHaptics.play(.warning)
            return .failed
        }
        guard bookingSessionID == nil, cancellingBookingID == nil else { return .failed }
        let memberVersion = memberStateVersion.snapshot
        bookingSessionID = session.id
        defer {
            if memberStateVersion.isCurrent(memberVersion) { bookingSessionID = nil }
        }
        do {
            let authSession = try await validAuthSession()
            try await api.book(session: authSession, classSessionID: session.id)
            guard canApplyMemberState(memberVersion, session: authSession) else { return .failed }
            cancelInFlightFullRefresh()
            XertHaptics.play(.success)
            await refreshBookingState(memberVersion: memberVersion, session: authSession)
            return .completed
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return .failed }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return .failed
            }
            if error.localizedDescription.contains("NO_CREDITS") {
                XertHaptics.play(.warning)
                return .needsCredits
            }
            errorMessage = BookingErrorMessage.display(for: error.localizedDescription)
            XertHaptics.play(.error)
            return .failed
        }
    }

    @discardableResult
    func joinWaitlist(_ session: ClassSession) async -> MemberBookingOutcome {
        if let message = memberBookingControlError() {
            errorMessage = message
            XertHaptics.play(.warning)
            return .failed
        }
        guard bookingSessionID == nil, cancellingBookingID == nil else { return .failed }
        let memberVersion = memberStateVersion.snapshot
        bookingSessionID = session.id
        defer {
            if memberStateVersion.isCurrent(memberVersion) { bookingSessionID = nil }
        }
        do {
            let authSession = try await validAuthSession()
            try await api.joinWaitlist(session: authSession, classSessionID: session.id)
            guard canApplyMemberState(memberVersion, session: authSession) else { return .failed }
            cancelInFlightFullRefresh()
            XertHaptics.play(.success)
            await refreshBookingState(memberVersion: memberVersion, session: authSession)
            return .completed
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return .failed }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return .failed
            }
            errorMessage = BookingErrorMessage.display(for: error.localizedDescription)
            XertHaptics.play(.error)
            return .failed
        }
    }

    func cancel(_ booking: BookingItem) async -> MemberBookingCancellationReceipt? {
        guard platformProvider.provider == .native,
              platformProvider.capabilities.nativeBookingMutations else {
            errorMessage = platformProvider.blockedReason
                ?? "Manage this booking in FitBox while FitBox is the selected booking provider."
            XertHaptics.play(.warning)
            return nil
        }
        guard !isUsingStaleMemberData, !unavailableDataSources.contains(.bookings) else {
            errorMessage = "Refresh your bookings before cancelling so XERT can verify the current class status."
            XertHaptics.play(.warning)
            return nil
        }
        guard bookingSessionID == nil, cancellingBookingID == nil else { return nil }
        let memberVersion = memberStateVersion.snapshot
        cancellingBookingID = booking.id
        defer {
            if memberStateVersion.isCurrent(memberVersion) { cancellingBookingID = nil }
        }
        do {
            let authSession = try await validAuthSession()
            let receipt = try await api.cancelBooking(session: authSession, bookingID: booking.id)
            guard canApplyMemberState(memberVersion, session: authSession) else { return nil }
            cancelInFlightFullRefresh()
            await ClassReminderScheduler.shared.remove(bookingID: booking.booking_id)
            guard canApplyMemberState(memberVersion, session: authSession) else { return nil }
            XertHaptics.play(.success)
            await refreshBookingState(memberVersion: memberVersion, session: authSession)
            return canApplyMemberState(memberVersion, session: authSession) ? receipt : nil
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return nil }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return nil
            }
            errorMessage = BookingErrorMessage.display(for: error.localizedDescription)
            XertHaptics.play(.error)
            return nil
        }
    }

    func expireUnauthorizedOwnerSession() async {
        guard authSession != nil else { return }
        await expireCurrentSession(
            message: "Your owner session has expired. Sign in again to reopen the Command Centre."
        )
    }

    /// Booking mutations only invalidate the timetable, credits and bookings.
    /// Refreshing these three sources keeps the UI authoritative while avoiding
    /// the ten unrelated requests in a complete app refresh.
    private func refreshBookingState(memberVersion: Int, session: AuthSession) async {
        async let sessionRequest = api.sessions()
        async let creditRequest = api.credits(session: session)
        async let bookingRequest = api.bookings(session: session)

        var creditsLoaded = false
        var bookingsLoaded = false

        do {
            let loadedSessions = try await sessionRequest
            guard canApplyMemberState(memberVersion, session: session) else { return }
            sessions = loadedSessions
            unavailableDataSources.remove(.sessions)
        } catch {
            guard canApplyMemberState(memberVersion, session: session) else { return }
            unavailableDataSources.insert(.sessions)
        }

        do {
            let loadedCredits = try await creditRequest
            guard canApplyMemberState(memberVersion, session: session) else { return }
            credits = loadedCredits
            creditBalanceLoaded = true
            unavailableDataSources.remove(.credits)
            creditsLoaded = true
        } catch {
            guard canApplyMemberState(memberVersion, session: session) else { return }
            unavailableDataSources.insert(.credits)
        }

        do {
            let loadedBookings = try await bookingRequest
            guard canApplyMemberState(memberVersion, session: session) else { return }
            bookings = loadedBookings
            guard await saveBookingSnapshot(
                loadedBookings,
                memberVersion: memberVersion,
                session: session
            ) else { return }
            unavailableDataSources.remove(.bookings)
            if classRemindersEnabled {
                let reminderState = await ClassReminderScheduler.shared.sync(
                    bookings: loadedBookings,
                    leadTime: classReminderLeadTime
                )
                applyClassReminderSyncState(reminderState)
            } else {
                await ClassReminderScheduler.shared.clearAll()
                classReminderSyncState = .off
            }
            guard canApplyMemberState(memberVersion, session: session) else { return }
            bookingsLoaded = true
        } catch {
            guard canApplyMemberState(memberVersion, session: session) else { return }
            unavailableDataSources.insert(.bookings)
        }

        if creditsLoaded && bookingsLoaded {
            memberDataUpdatedAt = Date()
            if unavailableDataSources.isDisjoint(with: Self.memberDataSources) {
                isUsingStaleMemberData = false
            }
        } else {
            isUsingStaleMemberData = memberDataUpdatedAt != nil
        }
    }

    private func cancelInFlightFullRefresh() {
        guard dataRefreshTask != nil else { return }
        if !hasBootstrapped { requiresBootstrapRefresh = true }
        dataRefreshVersion.invalidate()
        dataRefreshTask?.cancel()
        dataRefreshTask = nil
        if isLoadingMemberOnboarding {
            onboardingOperationVersion.invalidate()
            isLoadingMemberOnboarding = false
        }
        isLoading = false
    }

    private func memberBookingControlError() -> String? {
        guard platformProvider.provider == .native,
              platformProvider.capabilities.nativeBookingMutations else {
            return platformProvider.blockedReason
                ?? "Continue in FitBox to book or join a waitlist."
        }
        guard !isUsingStaleMemberData, !unavailableDataSources.contains(.bookings) else {
            return "Refresh your bookings before requesting a place so XERT can verify duplicates and time conflicts."
        }
        guard bookingAvailabilityLoaded else {
            return "XERT is still checking whether online bookings are available. Try again in a moment."
        }
        guard !unavailableDataSources.contains(.platformSettings) else {
            return "XERT could not verify online booking availability. Pull to refresh before trying again."
        }
        guard memberBookingsEnabled else {
            return "Online class bookings are currently paused. You can still register interest and XERT will follow up."
        }
        return nil
    }

    private func saveBookingSnapshot(
        _ loadedBookings: [BookingItem],
        memberVersion: Int,
        session: AuthSession,
        refreshVersion: Int? = nil
    ) async -> Bool {
        guard canApplyMemberState(memberVersion, session: session) else { return false }
        guard let userID = session.user?.id else { return true }
        let snapshot = MemberBookingSnapshot(userID: userID, bookings: loadedBookings)
        guard let encoded = await MemberBookingCache.encodeAsync(snapshot) else { return true }
        guard canApplyMemberState(memberVersion, session: session) else { return false }
        if let refreshVersion, !canApplyRefresh(refreshVersion) { return false }
        MemberBookingCache.saveEncoded(encoded, for: userID)
        return true
    }

    func setClassRemindersEnabled(_ enabled: Bool) async {
        guard enabled != classRemindersEnabled, !isUpdatingReminderPreference else { return }
        isUpdatingReminderPreference = true
        defer { isUpdatingReminderPreference = false }

        if enabled {
            let reminderState = await ClassReminderScheduler.shared.requestAuthorizationAndSync(
                bookings: bookings,
                leadTime: classReminderLeadTime
            )
            guard reminderState != .permissionDenied else {
                ClassReminderPreference.setEnabled(false)
                classRemindersEnabled = false
                classReminderSyncState = .permissionDenied
                errorMessage = "Notifications are disabled for XERT. Allow them in Settings to enable class reminders."
                XertHaptics.play(.warning)
                return
            }
            ClassReminderPreference.setEnabled(true)
            classRemindersEnabled = true
            classReminderSyncState = reminderState
            if case .failed = reminderState {
                errorMessage = "Some class reminders could not be scheduled. XERT will retry when your bookings refresh."
                XertHaptics.play(.warning)
                return
            }
        } else {
            ClassReminderPreference.setEnabled(false)
            classRemindersEnabled = false
            await ClassReminderScheduler.shared.clearAll()
            classReminderSyncState = .off
        }
        XertHaptics.play(.lightImpact)
    }

    func setClassReminderLeadTime(_ leadTime: ClassReminderLeadTime) async {
        guard leadTime != classReminderLeadTime, !isUpdatingReminderPreference else { return }
        isUpdatingReminderPreference = true
        defer { isUpdatingReminderPreference = false }

        ClassReminderPreference.setLeadTime(leadTime)
        classReminderLeadTime = leadTime
        if classRemindersEnabled {
            let reminderState = await ClassReminderScheduler.shared.sync(bookings: bookings, leadTime: leadTime)
            applyClassReminderSyncState(reminderState)
            if case .failed = reminderState {
                errorMessage = "Some class reminders could not be rescheduled. XERT will retry when your bookings refresh."
                XertHaptics.play(.warning)
                return
            }
        }
        XertHaptics.play(.selection)
    }

    private func applyClassReminderSyncState(_ state: ClassReminderSyncState) {
        classReminderSyncState = state
        guard state == .permissionDenied else { return }
        ClassReminderPreference.setEnabled(false)
        classRemindersEnabled = false
    }

    func setMemberPushEnabled(_ enabled: Bool) async {
        guard enabled != memberPushEnabled, !isUpdatingMemberPush else { return }
        guard isSignedIn else {
            errorMessage = "Sign in to enable member notice notifications."
            XertHaptics.play(.warning)
            return
        }
        let memberVersion = memberStateVersion.snapshot
        isUpdatingMemberPush = true
        defer {
            if memberStateVersion.isCurrent(memberVersion) { isUpdatingMemberPush = false }
        }

        if enabled {
            memberPushDeliveryState = .registering
            guard await MemberPushRegistration.requestAndRegister() else {
                MemberPushPreference.setEnabled(false)
                memberPushEnabled = false
                memberPushDeliveryState = .failed
                errorMessage = "Notifications are disabled for XERT. Allow them in Settings to receive member notices."
                XertHaptics.play(.warning)
                return
            }
            MemberPushPreference.setEnabled(true)
            memberPushEnabled = true
            memberPushDeliveryState = .awaitingDeviceToken
            await syncMemberPushToken()
        } else {
            if let token = PushDeviceTokenStore.load() {
                do {
                    let session = try await validAuthSession()
                    try await api.updatePushSubscription(session: session, token: token, enabled: false)
                } catch {
                    guard memberStateVersion.isCurrent(memberVersion) else { return }
                    if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                        return
                    }
                    present(error)
                    XertHaptics.play(.error)
                    return
                }
            }
            MemberPushPreference.setEnabled(false)
            memberPushEnabled = false
            memberPushDeliveryState = .off
            UIApplication.shared.unregisterForRemoteNotifications()
        }
        guard memberStateVersion.isCurrent(memberVersion) else { return }
        XertHaptics.play(.lightImpact)
    }

    func syncMemberPushToken(_ token: DevicePushToken? = nil) async {
        guard memberPushEnabled else {
            memberPushDeliveryState = .off
            return
        }
        guard let token = token ?? PushDeviceTokenStore.load() else {
            memberPushDeliveryState = .awaitingDeviceToken
            return
        }
        let memberVersion = memberStateVersion.snapshot
        memberPushDeliveryState = .registering
        do {
            let session = try await validAuthSession()
            try await api.updatePushSubscription(session: session, token: token, enabled: true)
            guard canApplyMemberState(memberVersion, session: session) else { return }
            memberPushDeliveryState = .registered
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return
            }
            memberPushDeliveryState = .failed
            present(error)
        }
    }

    func retryMemberPushRegistration() async {
        guard !isUpdatingMemberPush,
              memberPushEnabled || memberPushDeliveryState == .failed else { return }
        let memberVersion = memberStateVersion.snapshot
        isUpdatingMemberPush = true
        memberPushDeliveryState = .registering
        defer {
            if memberStateVersion.isCurrent(memberVersion) { isUpdatingMemberPush = false }
        }
        guard await MemberPushRegistration.requestAndRegister() else {
            guard memberStateVersion.isCurrent(memberVersion) else { return }
            memberPushDeliveryState = .failed
            errorMessage = "Notifications are disabled for XERT. Allow them in Settings, then retry registration."
            XertHaptics.play(.warning)
            return
        }
        guard memberStateVersion.isCurrent(memberVersion) else { return }
        MemberPushPreference.setEnabled(true)
        memberPushEnabled = true
        memberPushDeliveryState = .awaitingDeviceToken
        await syncMemberPushToken()
        guard memberStateVersion.isCurrent(memberVersion) else { return }
        XertHaptics.play(memberPushDeliveryState == .registered ? .success : .warning)
    }

    func handlePushRegistrationFailure() {
        MemberPushPreference.setEnabled(false)
        memberPushEnabled = false
        memberPushDeliveryState = .failed
        errorMessage = "This device could not register for XERT notifications. Check notification settings and try again."
        XertHaptics.play(.error)
    }

    private func restoreMemberPushRegistration() async {
        guard memberPushEnabled, isSignedIn else { return }
        memberPushDeliveryState = .registering
        guard await MemberPushRegistration.requestAndRegister() else {
            MemberPushPreference.setEnabled(false)
            memberPushEnabled = false
            memberPushDeliveryState = .failed
            return
        }
        memberPushDeliveryState = .awaitingDeviceToken
        await syncMemberPushToken()
    }

    func toggleEventGoal(_ event: EventItem) async {
        guard updatingEventGoalID == nil else { return }
        guard let eventID = event.id else {
            errorMessage = "This calendar event will be available to track once it is loaded in XERT."
            XertHaptics.play(.warning)
            return
        }

        let memberVersion = memberStateVersion.snapshot
        updatingEventGoalID = eventID
        defer {
            if memberStateVersion.isCurrent(memberVersion) { updatingEventGoalID = nil }
        }
        do {
            let authSession = try await validAuthSession()
            if eventGoalIDs.contains(eventID) {
                try await api.removeEventGoal(session: authSession, eventID: eventID)
                guard canApplyMemberState(memberVersion, session: authSession) else { return }
                eventGoalIDs.remove(eventID)
            } else {
                try await api.addEventGoal(session: authSession, eventID: eventID)
                guard canApplyMemberState(memberVersion, session: authSession) else { return }
                eventGoalIDs.insert(eventID)
            }
            XertHaptics.play(.lightImpact)
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return
            }
            present(error)
            XertHaptics.play(.error)
        }
    }

    /// Silent pushes only invalidate the private notice inbox. Refresh that
    /// bounded source instead of waking the entire catalogue and account graph.
    func refreshAnnouncements() async {
        guard authSession != nil else { return }
        let memberVersion = memberStateVersion.snapshot
        announcementStateVersion.invalidate()
        let announcementVersion = announcementStateVersion.snapshot
        do {
            let memberSession = try await validAuthSession()
            let loadedAnnouncements = try await api.announcements(session: memberSession)
            guard canApplyMemberState(memberVersion, session: memberSession),
                  announcementStateVersion.isCurrent(announcementVersion) else { return }
            announcements = loadedAnnouncements
            unavailableDataSources.remove(.announcements)
        } catch {
            guard memberStateVersion.isCurrent(memberVersion),
                  announcementStateVersion.isCurrent(announcementVersion) else { return }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return
            }
            unavailableDataSources.insert(.announcements)
            isUsingStaleMemberData = memberDataUpdatedAt != nil
        }
    }

    func dismissAnnouncement(_ announcement: MemberAnnouncement) async {
        let memberVersion = memberStateVersion.snapshot
        dismissingAnnouncementID = announcement.id
        errorMessage = nil
        defer {
            if memberStateVersion.isCurrent(memberVersion) {
                dismissingAnnouncementID = nil
            }
        }
        do {
            let memberSession = try await validAuthSession()
            try await api.dismissAnnouncement(session: memberSession, announcementID: announcement.id)
            guard canApplyMemberState(memberVersion, session: memberSession) else { return }
            announcements.removeAll { $0.id == announcement.id }
            XertHaptics.play(.softImpact)
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return
            }
            present(error)
            XertHaptics.play(.error)
        }
    }

    func checkoutURL(
        for product: Product,
        attemptID: UUID,
        activationSessionID: UUID? = nil
    ) async -> URL? {
        let memberVersion = memberStateVersion.snapshot
        guard platformProvider.provider == .native,
              platformProvider.capabilities.nativePackCheckout else {
            errorMessage = platformProvider.blockedReason
                ?? "Session packs are managed in FitBox while FitBox is the selected booking provider."
            XertHaptics.play(.warning)
            return nil
        }
        guard !sessionPackPricesComingSoon else {
            errorMessage = "Session pack pricing is coming soon. Checkout stays closed until XERT publishes the final prices."
            XertHaptics.play(.warning)
            return nil
        }
        guard sessionPackPaymentsEnabled else {
            errorMessage = "Session pack purchases are paused while XERT completes its payment launch checks."
            XertHaptics.play(.warning)
            return nil
        }
        do {
            let authSession = try await validAuthSession()
            guard let userID = authSession.user?.id else {
                throw APIError(message: "Your XERT session needs you to sign in again.")
            }
            let checkout = try await api.checkout(
                session: authSession,
                productSlug: product.slug,
                attemptID: attemptID
            )
            guard canApplyMemberState(memberVersion, session: authSession) else { return nil }
            PendingCheckoutStore.save(PendingCheckout(
                userID: userID,
                baselineOrderIDs: Set(orders.map(\.id)),
                startedAt: Date(),
                checkoutSessionID: checkout.checkout_session_id,
                activationSessionID: activationSessionID
            ))
            isCheckoutConfirmationPending = true
            XertHaptics.play(.mediumImpact)
            return checkout.url
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return nil }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return nil
            }
            errorMessage = error.localizedDescription
            XertHaptics.play(.error)
            return nil
        }
    }

    func hasMatchingPendingCheckout(callbackSessionID: String) -> Bool {
        guard let userID = authSession?.user?.id else { return false }
        return PendingCheckoutStore.resolve(
            for: userID,
            callbackSessionID: callbackSessionID
        ) != nil
    }

    func hasPendingCheckoutForCurrentUser() -> Bool {
        guard let userID = authSession?.user?.id else { return false }
        return PendingCheckoutStore.load(for: userID) != nil
    }

    @discardableResult
    func reconcileCheckout(
        callbackSessionID: String? = nil
    ) async -> CheckoutReconciliation.Result {
        guard
            let userID = authSession?.user?.id,
            !isReconcilingCheckout
        else { return .noMatchingCheckout }
        let memberVersion = memberStateVersion.snapshot
        let storedCheckout = PendingCheckoutStore.load(for: userID)
        if callbackSessionID != nil,
           storedCheckout != nil,
           PendingCheckoutStore.resolve(
               for: userID,
               callbackSessionID: callbackSessionID
           ) == nil {
            isCheckoutConfirmationPending = true
            return .noMatchingCheckout
        }

        var pendingCheckout = PendingCheckoutStore.resolve(
            for: userID,
            callbackSessionID: callbackSessionID
        )
        // A cold return may have lost local handoff state. Keep its identity
        // ephemeral until this member's server-side order confirms the session.
        if pendingCheckout == nil,
           let checkoutSessionID = CheckoutSessionIdentity.normalize(callbackSessionID) {
            pendingCheckout = PendingCheckout(
                userID: userID,
                baselineOrderIDs: Set(orders.map(\.id)),
                startedAt: Date(),
                checkoutSessionID: checkoutSessionID
            )
        }
        guard let pendingCheckout else {
            isCheckoutConfirmationPending = false
            return .noMatchingCheckout
        }

        var identityWasServerMatched = storedCheckout != nil
        isCheckoutConfirmationPending = identityWasServerMatched
        isReconcilingCheckout = true
        defer {
            if memberStateVersion.isCurrent(memberVersion) {
                isReconcilingCheckout = false
            }
        }

        let retryDelays = identityWasServerMatched
            ? CheckoutReconciliation.retryDelaysNanoseconds
            : [0]
        for delay in retryDelays {
            if delay > 0 {
                do {
                    try await Task.sleep(nanoseconds: delay)
                } catch {
                    return identityWasServerMatched ? .pending : .noMatchingCheckout
                }
            }
            guard !Task.isCancelled else {
                return identityWasServerMatched ? .pending : .noMatchingCheckout
            }

            do {
                let memberSession = try await validAuthSession()
                async let creditRequest = api.credits(session: memberSession)
                async let orderRequest = api.orders(session: memberSession)
                let (loadedCredits, loadedOrders) = try await (creditRequest, orderRequest)
                guard canApplyMemberState(memberVersion, session: memberSession) else {
                    return .noMatchingCheckout
                }
                credits = loadedCredits
                creditBalanceLoaded = true
                orders = loadedOrders
                unavailableDataSources.subtract([.credits, .orders])
                memberDataUpdatedAt = Date()

                if !identityWasServerMatched {
                    guard let checkoutSessionID = pendingCheckout.checkoutSessionID,
                          loadedOrders.contains(where: {
                              $0.stripe_checkout_session_id == checkoutSessionID
                          }) else { continue }
                    identityWasServerMatched = true
                    PendingCheckoutStore.save(pendingCheckout)
                    isCheckoutConfirmationPending = true
                }

                let settlement = CheckoutReconciliation.settlement(
                    pendingCheckout: pendingCheckout,
                    credits: loadedCredits,
                    orders: loadedOrders
                )
                if settlement != .pending {
                    PendingCheckoutStore.clear()
                    isCheckoutConfirmationPending = false
                    if settlement == .failed {
                        errorMessage = "Checkout did not complete. No session pack was activated."
                        XertHaptics.play(.warning)
                        return .failed
                    } else if settlement == .refunded {
                        errorMessage = "This payment was refunded. No purchased credits remain on the order."
                        XertHaptics.play(.warning)
                        return .refunded
                    } else {
                        checkoutActivatedSessionID = pendingCheckout.activationSessionID
                        XertHaptics.play(.success)
                        return .confirmed
                    }
                }
            } catch {
                guard memberStateVersion.isCurrent(memberVersion) else {
                    return .noMatchingCheckout
                }
                if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                    return .noMatchingCheckout
                }
                unavailableDataSources.formUnion([.credits, .orders])
                isUsingStaleMemberData = memberDataUpdatedAt != nil
            }
        }
        return identityWasServerMatched ? .pending : .noMatchingCheckout
    }

    func reconcilePendingCheckout() async {
        guard
            let userID = authSession?.user?.id,
            PendingCheckoutStore.load(for: userID) != nil
        else {
            isCheckoutConfirmationPending = false
            return
        }
        isCheckoutConfirmationPending = true
        await reconcileCheckout()
    }

    func cancelPendingCheckout() {
        PendingCheckoutStore.clear()
        isCheckoutConfirmationPending = false
        checkoutActivatedSessionID = nil
    }

    func consumeCheckoutActivatedSessionID() -> UUID? {
        defer { checkoutActivatedSessionID = nil }
        return checkoutActivatedSessionID
    }

    @discardableResult
    func requestPrivateSession(_ request: PrivateSessionRequest) async -> Bool {
        let memberVersion = memberStateVersion.snapshot
        let beganAuthenticated = authSession != nil
        isRequestingPrivateSession = true
        errorMessage = nil
        defer {
            if memberStateVersion.isCurrent(memberVersion) { isRequestingPrivateSession = false }
        }
        do {
            let memberSession = authSession == nil ? nil : try await validAuthSession()
            try await api.requestPrivateSession(request, auth: memberSession)
            if let memberSession {
                let loadedRequests = try await api.privateSessionRequests(session: memberSession)
                guard canApplyMemberState(memberVersion, session: memberSession) else { return true }
                privateSessionRequests = loadedRequests
                unavailableDataSources.remove(.privateSessions)
            }
            XertHaptics.play(.success)
            return true
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return false }
            if beganAuthenticated,
               await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return false
            }
            present(error)
            XertHaptics.play(.error)
            return false
        }
    }

    /// The database's own account of what the sign-up did, so the confirmation
    /// the member reads matches whether a place was actually held.
    @Published private(set) var classSignupReceipt: ClassSignupReceipt?

    @discardableResult
    func requestClassInterest(_ request: ClassInterestRequest) async -> Bool {
        isRequestingClassInterest = true
        errorMessage = nil
        classSignupReceipt = nil
        defer { isRequestingClassInterest = false }
        do {
            classSignupReceipt = try await api.requestClassInterest(request)
            XertHaptics.play(.success)
            return true
        } catch {
            present(error)
            XertHaptics.play(.error)
            return false
        }
    }

    @discardableResult
    func updateProfile(fullName: String, phone: String) async -> Bool {
        let memberVersion = memberStateVersion.snapshot
        isSavingProfile = true
        defer {
            if memberStateVersion.isCurrent(memberVersion) { isSavingProfile = false }
        }
        do {
            let authSession = try await validAuthSession()
            guard let profileID = profile?.id ?? authSession.user?.id else {
                throw APIError(message: "Your profile is still being prepared. Please refresh and try again.")
            }
            let loadedProfile = try await api.updateProfile(
                session: authSession,
                profileID: profileID,
                fullName: fullName,
                phone: phone
            )
            guard canApplyMemberState(memberVersion, session: authSession) else { return false }
            profile = loadedProfile
            XertHaptics.play(.success)
            return true
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return false }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return false
            }
            present(error)
            XertHaptics.play(.error)
            return false
        }
    }

    func clearMemberOnboardingError() {
        onboardingErrorMessage = nil
    }

    func refreshMemberOnboarding() async {
        guard authSession != nil,
              !isLoadingMemberOnboarding,
              !isSavingMemberOnboarding,
              let onboardingVersion = beginMemberOnboardingRead()
        else { return }
        let memberVersion = memberStateVersion.snapshot
        defer {
            finishMemberOnboardingRead(operationVersion: onboardingVersion)
        }
        do {
            let memberSession = try await validAuthSession()
            let loadedOnboarding = try await api.memberOnboarding(session: memberSession)
            guard canApplyMemberState(memberVersion, session: memberSession),
                  onboardingOperationVersion.isCurrent(onboardingVersion)
            else { return }
            applyMemberOnboarding(loadedOnboarding)
        } catch {
            guard memberStateVersion.isCurrent(memberVersion),
                  onboardingOperationVersion.isCurrent(onboardingVersion),
                  !Task.isCancelled
            else { return }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return
            }
            unavailableDataSources.insert(.onboarding)
            onboardingErrorMessage = MemberOnboardingErrorMessage.display(for: error.localizedDescription)
            XertHaptics.play(.error)
        }
    }

    @discardableResult
    func saveMemberOnboarding(_ draft: MemberOnboardingDraft) async -> Bool {
        guard !isSavingMemberOnboarding else { return false }
        let memberVersion = memberStateVersion.snapshot
        onboardingOperationVersion.invalidate()
        let onboardingVersion = onboardingOperationVersion.snapshot
        isLoadingMemberOnboarding = false
        isSavingMemberOnboarding = true
        onboardingErrorMessage = nil
        defer {
            if memberStateVersion.isCurrent(memberVersion),
               onboardingOperationVersion.isCurrent(onboardingVersion) {
                isSavingMemberOnboarding = false
            }
        }

        do {
            guard let current = memberOnboarding else {
                throw APIError(message: "Member readiness is still loading. Retry before saving.")
            }
            let request = try MemberOnboardingSaveRequest(
                draft: draft,
                requiredDocuments: current.required_documents
            )
            let memberSession = try await validAuthSession()
            let loadedOnboarding = try await api.saveMemberOnboarding(
                session: memberSession,
                request: request
            )
            guard canApplyMemberState(memberVersion, session: memberSession),
                  onboardingOperationVersion.isCurrent(onboardingVersion)
            else { return false }
            applyMemberOnboarding(loadedOnboarding)
            XertHaptics.play(.success)
            return true
        } catch {
            guard memberStateVersion.isCurrent(memberVersion),
                  onboardingOperationVersion.isCurrent(onboardingVersion),
                  !Task.isCancelled
            else { return false }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return false
            }
            let message = MemberOnboardingErrorMessage.display(for: error.localizedDescription)
            if error.localizedDescription.contains("ONBOARDING_DOCUMENTS_STALE") {
                unavailableDataSources.insert(.onboarding)
            }
            onboardingErrorMessage = message
            XertHaptics.play(.error)
            return false
        }
    }

    @discardableResult
    func updatePassword(password: String, confirmation: String) async -> Bool {
        let memberVersion = memberStateVersion.snapshot
        isUpdatingPassword = true
        errorMessage = nil
        defer {
            if memberStateVersion.isCurrent(memberVersion) { isUpdatingPassword = false }
        }

        do {
            let update = try PasswordUpdateRequest(password: password, confirmation: confirmation)
            let authSession = try await validAuthSession()
            try await api.updatePassword(session: authSession, request: update)
            guard canApplyMemberState(memberVersion, session: authSession) else { return false }
            XertHaptics.play(.success)
            return true
        } catch {
            guard memberStateVersion.isCurrent(memberVersion) else { return false }
            if await recoverUnauthorizedMemberSession(error, memberVersion: memberVersion) {
                return false
            }
            present(error)
            XertHaptics.play(.error)
            return false
        }
    }

    private func authenticate(_ action: () async throws -> AuthSession) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let session = try await action()
            replaceAuthSession(with: session)
            try KeychainStore.saveSession(session)
            await refresh()
            await reconcilePendingCheckout()
            await restoreMemberPushRegistration()
            XertHaptics.play(.success)
        } catch {
            errorMessage = error.localizedDescription
            XertHaptics.play(.error)
        }
    }

    /// The signed-in member's session, refreshed when due, for the coach
    /// roster screens. Roster access itself is decided by the database.
    func staffRosterSession() async throws -> AuthSession {
        try await validAuthSession()
    }

    private func validAuthSession() async throws -> AuthSession {
        let memberVersion = memberStateVersion.snapshot
        guard let current = authSession else {
            throw APIError(message: "Sign in to continue.")
        }
        guard current.needsRefresh() else { return current }
        guard current.refresh_token?.isEmpty == false else {
            throw APIError(message: "Your XERT session has expired. Please sign in again.", statusCode: 401)
        }

        if let sessionRefreshTask {
            let refreshed = try await sessionRefreshTask.value
            guard canApplyMemberState(memberVersion, session: refreshed) else {
                throw CancellationError()
            }
            return refreshed
        }

        let refreshTask = Task { () throws -> AuthSession in
            let refreshed = try await api.refresh(session: current)
            guard memberStateVersion.isCurrent(memberVersion),
                  authSession?.access_token == current.access_token else {
                throw CancellationError()
            }
            authSession = refreshed
            try KeychainStore.saveSession(refreshed)
            return refreshed
        }
        sessionRefreshTask = refreshTask
        defer {
            if memberStateVersion.isCurrent(memberVersion) {
                sessionRefreshTask = nil
            }
        }
        return try await refreshTask.value
    }

    private func canApplyRefresh(_ version: Int) -> Bool {
        dataRefreshVersion.isCurrent(version) && !Task.isCancelled
    }

    private func canApplyMemberState(_ version: Int, session: AuthSession?) -> Bool {
        guard memberStateVersion.isCurrent(version),
              !Task.isCancelled,
              let session,
              let currentSession = authSession
        else { return false }
        if let sessionUserID = session.user?.id,
           let currentUserID = currentSession.user?.id {
            return sessionUserID == currentUserID
        }
        return currentSession.access_token == session.access_token
    }

    private func beginMemberOnboardingRead() -> Int? {
        guard !isSavingMemberOnboarding else { return nil }
        onboardingOperationVersion.invalidate()
        isLoadingMemberOnboarding = true
        onboardingErrorMessage = nil
        return onboardingOperationVersion.snapshot
    }

    private func finishMemberOnboardingRead(operationVersion: Int) {
        guard onboardingOperationVersion.isCurrent(operationVersion) else { return }
        isLoadingMemberOnboarding = false
    }

    private func loadMemberOnboardingIfRequested(
        session: AuthSession,
        operationVersion: Int?
    ) async throws -> MemberOnboardingState? {
        guard operationVersion != nil else { return nil }
        return try await api.memberOnboarding(session: session)
    }

    private func replaceAuthSession(with session: AuthSession?) {
        memberStateVersion.invalidate()
        announcementStateVersion.invalidate()
        onboardingOperationVersion.invalidate()
        dataRefreshVersion.invalidate()
        dataRefreshTask?.cancel()
        dataRefreshTask = nil
        sessionRefreshTask?.cancel()
        sessionRefreshTask = nil
        authenticationRecoveryRequired = false
        authSession = session
        clearMemberData()
        isLoading = false
        isReconcilingCheckout = false
        isCheckoutConfirmationPending = false
        bookingSessionID = nil
        cancellingBookingID = nil
        updatingEventGoalID = nil
        dismissingAnnouncementID = nil
        isDeletingAccount = false
        isRequestingPrivateSession = false
        isUpdatingMemberPush = false
        isUpdatingReminderPreference = false
        isSavingProfile = false
        isLoadingMemberOnboarding = false
        isSavingMemberOnboarding = false
        onboardingErrorMessage = nil
        isUpdatingPassword = false
        errorMessage = nil
    }

    private func clearMemberData() {
        credits = []
        creditBalanceLoaded = false
        bookings = []
        classReminderSyncState = .off
        checkoutActivatedSessionID = nil
        orders = []
        profile = nil
        memberOnboarding = nil
        onboardingLoaded = false
        isLoadingMemberOnboarding = false
        onboardingErrorMessage = nil
        eventGoalIDs = []
        privateSessionRequests = []
        announcements = []
        memberDataUpdatedAt = nil
        isUsingStaleMemberData = false
        unavailableDataSources.subtract(Self.memberDataSources)
    }

    private func clearLocalMemberState(for userID: UUID?) {
        if let userID {
            MemberLocalState.clear(for: userID)
        } else {
            PendingCheckoutStore.clear()
            PushDeviceTokenStore.clear()
            ClassReminderPreference.setEnabled(false)
            MemberPushPreference.setEnabled(false)
        }
        classRemindersEnabled = false
        classReminderSyncState = .off
        memberPushEnabled = false
        memberPushDeliveryState = .off
    }

    private func recoverUnauthorizedMemberSession(
        _ error: Error,
        memberVersion: Int
    ) async -> Bool {
        guard memberStateVersion.isCurrent(memberVersion),
              (error as? APIError)?.isUnauthorized == true
        else { return false }

        await expireCurrentSession(
            message: "Your XERT session has expired. Sign in again to continue."
        )
        return true
    }

    private func expireCurrentSession(message: String) async {
        let currentUserID = authSession?.user?.id ?? profile?.id
        MemberPushRegistration.stopReceivingPrivateNotices()
        clearLocalMemberState(for: currentUserID)
        replaceAuthSession(with: nil)
        authenticationRecoveryRequired = true
        KeychainStore.clearSession()
        await ClassReminderScheduler.shared.clearAll()
        errorMessage = message
        XertHaptics.play(.warning)
    }

    private func applyMemberOnboarding(_ onboarding: MemberOnboardingState) {
        memberOnboarding = onboarding
        onboardingLoaded = true
        onboardingErrorMessage = nil
        unavailableDataSources.remove(.onboarding)

        if let currentProfile = profile, currentProfile.id == onboarding.user_id {
            profile = MemberProfile(
                id: currentProfile.id,
                full_name: onboarding.profile.full_name,
                phone: onboarding.profile.phone,
                email: currentProfile.email,
                role: currentProfile.role
            )
        }
    }

    private func present(_ error: Error) {
        if errorMessage == nil {
            errorMessage = error.localizedDescription
        }
    }
}
