import Foundation

/// A short confirmation or failure shown at the top of My Coaching.
struct StaffRosterBanner: Identifiable, Equatable {
    let id = UUID()
    let message: String
    let isError: Bool
}

/// State for the native My Coaching screens. It holds only what the coach
/// entry points returned for the signed-in account and never decides access
/// or roster rules itself: the database does that on every call.
@MainActor
final class StaffRosterStore: ObservableObject {
    @Published private(set) var access: StaffRosterAccess = .unknown
    @Published private(set) var roster: StaffRosterMyRoster?
    @Published private(set) var rosterError: StaffRosterError?
    @Published private(set) var requests: StaffRosterMyRequests?
    @Published private(set) var coverBoard: [StaffRosterCoverBoardItem] = []
    @Published private(set) var requestsError: StaffRosterError?
    @Published private(set) var notifications: [StaffRosterNotification]?
    @Published private(set) var notificationsError: StaffRosterError?
    @Published private(set) var monthClasses: [String: [StaffRosterMonthClass]] = [:]
    @Published private(set) var isWorking = false
    @Published var banner: StaffRosterBanner?
    /// The section a deep link, push or notice asked for. The open screen
    /// follows it whenever `linkSequence` changes.
    @Published private(set) var requestedLink = XertCoachingLink()
    @Published private(set) var linkSequence: UInt = 0

    private let api: XertAPI
    private var sessionProvider: (@MainActor () async throws -> AuthSession)?
    private var userID: UUID?
    private var generation = 0
    private var pendingViewedNotificationIDs: Set<UUID> = []

    init(api: XertAPI = XertAPI()) {
        self.api = api
    }

    var me: StaffRosterMe? { access.me }

    var showsEntry: Bool { StaffRosterVisibility.showsEntry(for: access) }

    // MARK: Session

    /// Binds the store to the signed-in member. A different account (or
    /// signing out) drops everything the previous account loaded.
    func bind(userID: UUID?, sessionProvider: @escaping @MainActor () async throws -> AuthSession) {
        if userID != self.userID {
            reset()
            self.userID = userID
        }
        self.sessionProvider = userID == nil ? nil : sessionProvider
    }

    func reset() {
        generation += 1
        userID = nil
        sessionProvider = nil
        access = .unknown
        clearData()
        isWorking = false
        banner = nil
        pendingViewedNotificationIDs = []
    }

    private func clearData() {
        roster = nil
        rosterError = nil
        requests = nil
        coverBoard = []
        requestsError = nil
        notifications = nil
        notificationsError = nil
        monthClasses = [:]
    }

    /// Opens a section from a deep link, push or notice.
    func open(_ link: XertCoachingLink) {
        requestedLink = link
        linkSequence &+= 1
    }

    /// A notice the coach opened from a push. It is marked read once My
    /// Coaching is actually showing for them, never on receipt.
    func noteOpenedFromNotification(_ id: UUID) {
        pendingViewedNotificationIDs.insert(id)
    }

    // MARK: Access

    func refreshAccess() async {
        guard let provider = sessionProvider else {
            access = .unknown
            return
        }
        let current = generation
        if access.me == nil { access = .checking }
        do {
            let session = try await provider()
            let me = try await api.staffRosterMe(session: session)
            guard current == generation else { return }
            access = .coach(me)
        } catch {
            guard current == generation else { return }
            let failure = StaffRosterError.from(error)
            if failure.isAccessDenied {
                access = .unavailable(failure)
                clearData()
            } else if access.me == nil {
                access = .failed(failure)
            } else {
                banner = StaffRosterBanner(message: failure.message, isError: true)
            }
        }
    }

    // MARK: Reads

    func loadRoster(now: Date = Date()) async {
        let window = StaffRosterTime.rosterWindow(now: now)
        let result = await read { session in
            try await self.api.staffRosterMyRoster(session: session, from: window.from, to: window.to)
        }
        switch result {
        case .some(.success(let value)):
            roster = value
            rosterError = nil
        case .some(.failure(let failure)):
            rosterError = failure
        case .none:
            break
        }
    }

    func loadRequests() async {
        let api = self.api
        let result = await read { session -> (StaffRosterMyRequests, [StaffRosterCoverBoardItem]) in
            async let mine = api.staffRosterMyRequests(session: session)
            async let board = api.staffRosterCoverBoard(session: session)
            let requests = try await mine
            let items = try await board
            return (requests, items)
        }
        switch result {
        case .some(.success(let value)):
            requests = value.0
            coverBoard = value.1
            requestsError = nil
        case .some(.failure(let failure)):
            requestsError = failure
        case .none:
            break
        }
    }

    func loadNotifications() async {
        let result = await read { session in
            try await self.api.staffRosterMyNotifications(session: session, limit: 50)
        }
        switch result {
        case .some(.success(let value)):
            notifications = value
            notificationsError = nil
        case .some(.failure(let failure)):
            notificationsError = failure
        case .none:
            break
        }
    }

    @discardableResult
    func loadMonthClasses(_ monthKey: String) async -> Bool {
        let result = await read { session in
            try await self.api.staffRosterMonthClasses(session: session, monthKey: monthKey)
        }
        if case .some(.success(let value)) = result {
            monthClasses[monthKey] = value
            return true
        }
        return false
    }

    // MARK: Notices

    /// Marks notices from a push as read once My Coaching is on screen for a coach.
    func markOpenedNotificationsViewed() async {
        guard access.me != nil, !pendingViewedNotificationIDs.isEmpty else { return }
        let ids = Array(pendingViewedNotificationIDs)
        pendingViewedNotificationIDs = []
        _ = await markRead(ids, quietly: true)
    }

    @discardableResult
    func markRead(_ ids: [UUID], quietly: Bool = false) async -> Bool {
        guard !ids.isEmpty else { return true }
        let result = await read { session in
            try await self.api.staffRosterMarkNotificationsRead(session: session, ids: ids)
        }
        switch result {
        case .some(.success):
            await loadNotifications()
            await refreshAccess()
            return true
        case .some(.failure(let failure)):
            if !quietly { banner = StaffRosterBanner(message: failure.message, isError: true) }
            return false
        case .none:
            return false
        }
    }

    // MARK: Roster actions

    @discardableResult
    func acknowledge(_ revisionID: UUID) async -> Bool {
        await mutate(success: { _ in "Thanks — marked as seen." }) { session in
            try await self.api.staffRosterAcknowledge(session: session, revisionID: revisionID)
        } reload: {
            await self.loadRoster()
            await self.refreshAccess()
        }
    }

    @discardableResult
    func confirmSession(_ sessionID: UUID, status: String) async -> Bool {
        let message = status == "UNAVAILABLE"
            ? "Noted. The manager will find cover."
            : "Thanks — you’re confirmed for the new time."
        return await mutate(success: { _ in message }) { session in
            try await self.api.staffRosterConfirmSession(session: session, sessionID: sessionID, status: status, requestID: UUID())
        } reload: {
            await self.loadRoster()
        }
    }

    @discardableResult
    func requestCover(_ assignmentID: UUID, reason: String?) async -> Bool {
        await mutate(success: { _ in "Cover requested. Other coaches can offer; the manager approves. You stay on this class until then." }) { session in
            try await self.api.staffRosterRequestCover(
                session: session,
                assignmentID: assignmentID,
                reason: Self.cleaned(reason),
                requestID: UUID()
            )
        } reload: {
            await self.loadRoster()
            await self.loadRequests()
        }
    }

    /// `kind` is `absence`, `cover` or `offer`, as `staff_roster_withdraw` expects.
    @discardableResult
    func withdraw(kind: String, id: UUID) async -> Bool {
        let message: String
        switch kind {
        case "cover": message = "Cover request withdrawn. You’re still on this class."
        case "offer": message = "Offer withdrawn."
        default: message = "Request withdrawn."
        }
        return await mutate(success: { _ in message }) { session in
            try await self.api.staffRosterWithdraw(session: session, kind: kind, id: id, requestID: UUID())
        } reload: {
            await self.loadRoster()
            await self.loadRequests()
        }
    }

    @discardableResult
    func offerCover(_ coverID: UUID) async -> Bool {
        await mutate(success: { _ in "Offer sent. The class is yours only once the manager approves." }) { session in
            try await self.api.staffRosterOfferCover(session: session, coverID: coverID, requestID: UUID())
        } reload: {
            await self.loadRequests()
        }
    }

    @discardableResult
    func requestAbsence(starts: Date, ends: Date, urgent: Bool, reason: String?) async -> Bool {
        await mutate(success: { (result: StaffRosterAbsenceResult) in
            guard urgent else { return "Sent to the manager for approval." }
            if let affected = result.affected_classes, affected > 0 {
                return "The manager has been told. \(affected) of your classes need cover."
            }
            return "The manager has been told."
        }) { session in
            try await self.api.staffRosterRequestAbsence(
                session: session,
                starts: starts,
                ends: ends,
                kind: urgent ? "urgent" : "planned",
                reason: Self.cleaned(reason),
                requestID: UUID()
            )
        } reload: {
            await self.loadRequests()
            await self.loadRoster()
        }
    }

    // MARK: Availability

    /// Autosave. Never changes the submitted availability.
    func saveDraft(
        monthKey: String,
        payload: StaffAvailabilityPayload,
        expectedVersion: Int
    ) async -> Result<StaffRosterVersionResult, StaffRosterError>? {
        await read { session in
            try await self.api.staffRosterSaveAvailabilityDraft(
                session: session,
                monthKey: monthKey,
                payload: payload,
                expectedVersion: expectedVersion
            )
        }
    }

    /// Submits a new version. The same request id is reused for retries of
    /// the same answer so a lost response cannot create two versions.
    func submitAvailability(
        monthKey: String,
        payload: StaffAvailabilityPayload,
        requestID: UUID
    ) async -> Result<StaffRosterSubmitResult, StaffRosterError>? {
        isWorking = true
        defer { isWorking = false }
        let result = await read { session in
            try await self.api.staffRosterSubmitAvailability(
                session: session,
                monthKey: monthKey,
                payload: payload,
                requestID: requestID
            )
        }
        if case .some(.success) = result { await refreshAccess() }
        return result
    }

    @discardableResult
    func saveUsualWeek(_ pattern: [StaffWeeklyWindow], expectedVersion: Int) async -> Bool {
        await mutate(success: { _ in "Saved as your usual week. Next month starts from it." }) { session in
            try await self.api.staffRosterSaveUsualWeek(session: session, pattern: pattern, expectedVersion: expectedVersion)
        } reload: {
            await self.refreshAccess()
        }
    }

    @discardableResult
    func requestChange(monthKey: String, message: String) async -> Bool {
        await mutate(success: { _ in "Sent. The manager can reopen your availability." }) { session in
            try await self.api.staffRosterRequestChange(
                session: session,
                monthKey: monthKey,
                message: message,
                requestID: UUID()
            )
        } reload: {
            await self.refreshAccess()
        }
    }

    // MARK: Plumbing

    /// Runs a read with a fresh session. Returns nil when the account changed
    /// while it was in flight, so stale results are never shown.
    private func read<T>(
        _ operation: (AuthSession) async throws -> T
    ) async -> Result<T, StaffRosterError>? {
        guard let provider = sessionProvider else {
            return .failure(StaffRosterError(code: "SIGN_IN_REQUIRED", message: "Please sign in again."))
        }
        let current = generation
        do {
            let session = try await provider()
            let value = try await operation(session)
            guard current == generation else { return nil }
            return .success(value)
        } catch {
            guard current == generation else { return nil }
            let failure = StaffRosterError.from(error)
            if failure.isAccessDenied {
                access = .unavailable(failure)
                clearData()
            }
            return .failure(failure)
        }
    }

    private func mutate<T>(
        success: (T) -> String,
        _ operation: (AuthSession) async throws -> T,
        reload: () async -> Void
    ) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        let result = await read(operation)
        isWorking = false
        switch result {
        case .some(.success(let value)):
            banner = StaffRosterBanner(message: success(value), isError: false)
            XertHaptics.play(.success)
            await reload()
            return true
        case .some(.failure(let failure)):
            banner = StaffRosterBanner(message: failure.message, isError: true)
            XertHaptics.play(.error)
            if failure.isStaleVersion { await reload() }
            return false
        case .none:
            return false
        }
    }

    private static func cleaned(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : String(trimmed.prefix(300))
    }
}
