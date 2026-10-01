import Combine
import Foundation

enum XertPrimaryDestination: Int, CaseIterable, Identifiable, Hashable {
    case home = 0
    case booking = 1
    case events = 2
    case account = 3
    case explore = 4

    var id: Self { self }

    static let dockOrder: [Self] = [.home, .booking, .events, .explore, .account]

    var title: String {
        switch self {
        case .home: return "Home"
        case .booking: return "Book"
        case .events: return "Events"
        case .account: return "Account"
        case .explore: return "Explore"
        }
    }

    var icon: String {
        switch self {
        case .home: return "house"
        case .booking: return "calendar.badge.plus"
        case .events: return "trophy"
        case .account: return "person.crop.circle"
        case .explore: return "safari"
        }
    }

    var selectedIcon: String {
        switch self {
        case .home: return "house.fill"
        case .booking: return "calendar.badge.plus"
        case .events: return "trophy.fill"
        case .account: return "person.crop.circle.fill"
        case .explore: return "safari.fill"
        }
    }

    static func destination(for path: String) -> Self? {
        switch path {
        case "/", "/home": return .home
        case "/booking": return .booking
        case "/events": return .events
        case "/account": return .account
        case "/explore": return .explore
        default: return nil
        }
    }

    static func destination(for url: URL) -> Self? {
        XertMemberRoute.route(for: url)?.destination
    }
}

enum XertMemberRoute: Hashable {
    static let canonicalWebHost = AppConfig.vercelHost

    case home
    case notices(UUID?)
    case booking
    case classSession(UUID)
    case sessionPacks
    case purchaseConfirmation
    case events
    case eventGoals
    case explore
    case account
    case upcomingBookings(UUID?)
    /// My Coaching for staff on the coach roster. Lives in the Account
    /// workspace; the server decides on every call whether it shows anything.
    case coaching(XertCoachingLink)

    var destination: XertPrimaryDestination {
        switch self {
        case .home, .notices(_): return .home
        case .booking, .classSession(_), .sessionPacks, .purchaseConfirmation: return .booking
        case .events, .eventGoals: return .events
        case .explore: return .explore
        case .account, .upcomingBookings(_), .coaching(_): return .account
        }
    }

    var navigationTitle: String {
        switch self {
        case .home: return "Home"
        case .notices(_): return "Member Notices"
        case .booking: return "Book"
        case .classSession(_): return "Class Details"
        case .sessionPacks: return "Session Packs"
        case .purchaseConfirmation: return "Purchase Confirmation"
        case .events: return "Events"
        case .eventGoals: return "Event Goals"
        case .explore: return "Explore"
        case .account: return "Account"
        case .upcomingBookings(_): return "Upcoming Bookings"
        case .coaching(_): return "My Coaching"
        }
    }

    var isContextualTask: Bool {
        switch self {
        case .notices(_), .classSession(_), .sessionPacks, .purchaseConfirmation, .eventGoals, .upcomingBookings(_), .coaching(_):
            return true
        case .home, .booking, .events, .explore, .account:
            return false
        }
    }

    var requiresAuthentication: Bool {
        switch self {
        case .notices(_), .purchaseConfirmation, .eventGoals, .upcomingBookings(_):
            return true
        case .coaching(_):
            // Staff roster data is private to the signed-in coach.
            return true
        case .home, .booking, .classSession(_), .sessionPacks, .events, .explore, .account:
            return false
        }
    }

    var pinnableRoute: Self? {
        switch self {
        case .notices(_): return .notices(nil)
        case .upcomingBookings(_): return .upcomingBookings(nil)
        case .coaching(let link): return .coaching(XertCoachingLink(tab: link.tab))
        case .classSession(_), .purchaseConfirmation: return nil
        case .home, .booking, .sessionPacks, .events, .eventGoals, .explore, .account:
            return self
        }
    }

    static func primary(_ destination: XertPrimaryDestination) -> Self {
        switch destination {
        case .home: return .home
        case .booking: return .booking
        case .events: return .events
        case .explore: return .explore
        case .account: return .account
        }
    }

    var restorationValue: String {
        switch self {
        case .home: return "home"
        case .notices(let id): return ["home", "notices", id?.uuidString.lowercased()].compactMap { $0 }.joined(separator: "/")
        case .booking: return "booking"
        case .classSession(let id): return "booking/classes/\(id.uuidString.lowercased())"
        case .sessionPacks: return "booking/packs"
        case .purchaseConfirmation: return "booking/purchase-confirmation"
        case .events: return "events"
        case .eventGoals: return "events/goals"
        case .explore: return "explore"
        case .account: return "account"
        case .upcomingBookings(let id): return ["account", "bookings", id?.uuidString.lowercased()].compactMap { $0 }.joined(separator: "/")
        case .coaching(let link): return link.restorationValue
        }
    }

    var webURL: URL {
        guard let url = URL(string: "https://\(Self.canonicalWebHost)/open/\(restorationValue)") else {
            preconditionFailure("XERT route generated an invalid canonical web URL")
        }
        return url
    }

    var shareDestination: XertRouteShareDestination? {
        switch self {
        case .home, .booking, .classSession(_), .sessionPacks, .events, .explore:
            return XertRouteShareDestination(route: self, isExactTask: true)
        case .notices(_):
            return XertRouteShareDestination(route: .home, isExactTask: false)
        case .purchaseConfirmation:
            return XertRouteShareDestination(route: .sessionPacks, isExactTask: false)
        case .eventGoals:
            return XertRouteShareDestination(route: .events, isExactTask: false)
        case .upcomingBookings(_):
            return XertRouteShareDestination(route: .booking, isExactTask: false)
        case .account, .coaching(_):
            // Account and staff roster tasks are private; never share them.
            return nil
        }
    }

    static func restore(_ value: String) -> Self? {
        if let link = XertCoachingLink.link(restorationValue: value) {
            return .coaching(link)
        }
        return route(forPath: "/\(value.trimmingCharacters(in: CharacterSet(charactersIn: "/")))")
    }

    static func route(for url: URL) -> Self? {
        // My Coaching links may carry `?month=YYYY-MM`; that parser accepts
        // only its own strict contract. Everything else stays query-free.
        if let link = XertCoachingLink.link(for: url) {
            return .coaching(link)
        }
        guard url.user == nil, url.password == nil, url.query == nil else { return nil }
        if url.scheme?.lowercased() == "https" {
            return webRoute(for: url)
        }
        guard
            url.scheme?.lowercased() == "xertfitness",
            url.port == nil,
            url.fragment == nil
        else { return nil }
        let host = url.host?.lowercased() ?? ""
        let path = url.path.lowercased()
        let routePath = host.isEmpty ? path : "/\(host)\(path)"
        return route(forPath: routePath.isEmpty ? "/" : routePath)
    }

    private static func webRoute(for url: URL) -> Self? {
        guard
            url.host?.lowercased() == canonicalWebHost,
            url.port == nil || url.port == 443
        else { return nil }
        let path = url.path.lowercased()
        let fragment = url.fragment?.lowercased()

        if path.hasPrefix("/open/") {
            guard fragment == nil else { return nil }
            return restore(String(path.dropFirst("/open/".count)))
        }

        switch (path, fragment) {
        case ("/", nil), ("/app", nil): return .home
        case ("/booking", nil): return .booking
        case ("/booking", "packs"): return .sessionPacks
        case ("/events", nil): return .events
        case ("/events", "goals"): return .eventGoals
        case ("/account", nil): return .account
        case ("/account", "bookings"): return .upcomingBookings(nil)
        case ("/account", "notices"): return .notices(nil)
        case ("/about", nil), ("/coaches", nil), ("/contact", nil), ("/training-guide", nil):
            return .explore
        default: return nil
        }
    }

    private static func route(forPath path: String) -> Self? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        switch parts.joined(separator: "/") {
        case "", "home": return .home
        case "home/notices": return .notices(nil)
        case "booking": return .booking
        case "booking/packs": return .sessionPacks
        case "booking/purchase-confirmation": return .purchaseConfirmation
        case "events": return .events
        case "events/goals": return .eventGoals
        case "explore": return .explore
        case "account": return .account
        case "account/bookings": return .upcomingBookings(nil)
        default:
            if parts.count == 3, parts[0] == "home", parts[1] == "notices",
               let id = UUID(uuidString: parts[2]) {
                return .notices(id)
            }
            if parts.count == 3, parts[0] == "booking", parts[1] == "classes",
               let id = UUID(uuidString: parts[2]) {
                return .classSession(id)
            }
            if parts.count == 3, parts[0] == "account", parts[1] == "bookings",
               let id = UUID(uuidString: parts[2]) {
                return .upcomingBookings(id)
            }
            return nil
        }
    }
}

struct XertRouteShareDestination: Equatable {
    let route: XertMemberRoute
    let isExactTask: Bool

    var title: String { route.navigationTitle }

    var accessibilityHint: String {
        isExactTask
            ? "Shares a link to this XERT task"
            : "Shares the public \(title) workspace without private member details"
    }
}

enum XertNavigationSource: String, Equatable {
    case restoration
    case dock
    case dockSwipe
    case history
    case content
    case deepLink
    case pushNotification
    case checkout
    case commandPalette
    case handoff
    case quickAction
    case keyboard
}

enum XertNavigationIntentDisposition: Equatable {
    case open
    case requireAuthentication
}

struct XertNavigationIntent: Equatable {
    let route: XertMemberRoute
    let source: XertNavigationSource

    func disposition(isSignedIn: Bool) -> XertNavigationIntentDisposition {
        route.requiresAuthentication && !isSignedIn ? .requireAuthentication : .open
    }
}

enum XertRouteUserActivity {
    static let activityType = "com.xertfitness.app.member-task"
    private static let routeKey = "xert.memberRoute"
    private static let versionKey = "xert.routeVersion"
    private static let currentVersion = 1

    static func shouldAdvertise(
        route: XertMemberRoute,
        isSignedIn: Bool,
        isPrivacyLocked: Bool
    ) -> Bool {
        guard !isPrivacyLocked else { return false }
        return !route.requiresAuthentication || isSignedIn
    }

    static func configure(_ activity: NSUserActivity, route: XertMemberRoute) {
        activity.title = "Continue \(route.navigationTitle) in XERT"
        activity.webpageURL = route.webURL
        activity.userInfo = [
            routeKey: route.restorationValue,
            versionKey: currentVersion
        ]
        activity.requiredUserInfoKeys = [routeKey, versionKey]
        activity.isEligibleForHandoff = true
        activity.isEligibleForSearch = !route.isContextualTask
        activity.isEligibleForPrediction = !route.isContextualTask
        activity.isEligibleForPublicIndexing = false
    }

    static func route(from activity: NSUserActivity) -> XertMemberRoute? {
        guard activity.activityType == activityType else { return nil }

        var restoredRoute: XertMemberRoute?
        if let userInfo = activity.userInfo {
            guard
                let version = userInfo[versionKey] as? NSNumber,
                version.intValue == currentVersion,
                let routeValue = userInfo[routeKey] as? String,
                let route = XertMemberRoute.restore(routeValue)
            else { return nil }
            restoredRoute = route
        }

        let webRoute = activity.webpageURL.flatMap { XertMemberRoute.route(for: $0) }

        if let restoredRoute, let webRoute, restoredRoute != webRoute {
            return nil
        }
        return restoredRoute ?? webRoute
    }
}

enum XertNavigationDirection: Equatable {
    case previous
    case next
}

enum XertNavigationPresentation: Equatable {
    case compactDock
    case workspaceRail

    static func resolve(isRegularWidth: Bool) -> Self {
        isRegularWidth ? .workspaceRail : .compactDock
    }
}

struct XertNavigationTransition: Equatable {
    let from: XertPrimaryDestination
    let to: XertPrimaryDestination
    let source: XertNavigationSource
    let sequence: UInt
}

struct XertNavigationWorkspaceSnapshot: Codable, Equatable {
    static let currentVersion = 2
    static let legacyVersion = 1
    static let maximumEncodedLength = 4_096
    static let maximumRouteCount = 32
    static let maximumWorkspaceRouteCount = XertPrimaryDestination.allCases.count

    let version: Int
    let routeValues: [String]
    let forwardRouteValues: [String]?
    let workspaceRouteValues: [String]?

    init(
        routes: [XertMemberRoute],
        forwardRoutes: [XertMemberRoute] = [],
        workspaceRoutes: [XertMemberRoute] = []
    ) {
        version = Self.currentVersion
        routeValues = routes.map(\.restorationValue)
        forwardRouteValues = forwardRoutes.isEmpty ? nil : forwardRoutes.map(\.restorationValue)
        workspaceRouteValues = workspaceRoutes.map(\.restorationValue)
    }
}

struct XertPinnedWorkspaceSnapshot: Codable, Equatable {
    static let currentVersion = 1
    static let maximumRouteCount = 6
    static let maximumEncodedLength = 1_024

    let version: Int
    let routeValues: [String]

    init(routes: [XertMemberRoute]) {
        version = Self.currentVersion
        routeValues = routes.map(\.restorationValue)
    }
}

struct XertWorkspaceOrderSnapshot: Codable, Equatable {
    static let currentVersion = 1
    static let maximumEncodedLength = 256

    let version: Int
    let destinationRawValues: [Int]

    init(destinations: [XertPrimaryDestination]) {
        version = Self.currentVersion
        destinationRawValues = destinations.map(\.rawValue)
    }
}

enum XertWorkspaceOrderStore {
    private static let keyPrefix = "xert.navigation.workspace-order.v1."

    static func load(
        for userID: UUID?,
        defaults: UserDefaults = .standard
    ) -> [XertPrimaryDestination] {
        guard
            let userID,
            let data = defaults.data(forKey: storageKey(for: userID)),
            data.count <= XertWorkspaceOrderSnapshot.maximumEncodedLength,
            let snapshot = try? JSONDecoder().decode(XertWorkspaceOrderSnapshot.self, from: data),
            snapshot.version == XertWorkspaceOrderSnapshot.currentVersion,
            snapshot.destinationRawValues.count == XertPrimaryDestination.dockOrder.count
        else { return XertPrimaryDestination.dockOrder }

        let destinations = snapshot.destinationRawValues.compactMap(XertPrimaryDestination.init(rawValue:))
        guard isCompletePermutation(destinations) else { return XertPrimaryDestination.dockOrder }
        return destinations
    }

    @discardableResult
    static func save(
        _ destinations: [XertPrimaryDestination],
        for userID: UUID,
        defaults: UserDefaults = .standard
    ) -> [XertPrimaryDestination] {
        let normalized = normalized(destinations)
        let snapshot = XertWorkspaceOrderSnapshot(destinations: normalized)
        guard
            let data = try? JSONEncoder().encode(snapshot),
            data.count <= XertWorkspaceOrderSnapshot.maximumEncodedLength
        else { return load(for: userID, defaults: defaults) }
        defaults.set(data, forKey: storageKey(for: userID))
        return normalized
    }

    static func normalized(_ destinations: [XertPrimaryDestination]) -> [XertPrimaryDestination] {
        var seen = Set<XertPrimaryDestination>()
        let uniqueKnown = destinations.filter { seen.insert($0).inserted }
        return uniqueKnown + XertPrimaryDestination.dockOrder.filter { seen.insert($0).inserted }
    }

    static func clear(for userID: UUID, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: storageKey(for: userID))
    }

    private static func isCompletePermutation(_ destinations: [XertPrimaryDestination]) -> Bool {
        destinations.count == XertPrimaryDestination.dockOrder.count
            && Set(destinations) == Set(XertPrimaryDestination.dockOrder)
    }

    private static func storageKey(for userID: UUID) -> String {
        keyPrefix + userID.uuidString.lowercased()
    }
}

enum XertPinnedWorkspaceStore {
    private static let keyPrefix = "xert.navigation.pins.v1."

    static func load(
        for userID: UUID?,
        defaults: UserDefaults = .standard
    ) -> [XertMemberRoute] {
        guard
            let userID,
            let data = defaults.data(forKey: storageKey(for: userID)),
            data.count <= XertPinnedWorkspaceSnapshot.maximumEncodedLength,
            let snapshot = try? JSONDecoder().decode(XertPinnedWorkspaceSnapshot.self, from: data),
            snapshot.version == XertPinnedWorkspaceSnapshot.currentVersion,
            snapshot.routeValues.count <= XertPinnedWorkspaceSnapshot.maximumRouteCount
        else { return [] }

        let routes = snapshot.routeValues.compactMap { value in
            XertMemberRoute.restore(value)?.pinnableRoute
        }
        guard routes.count == snapshot.routeValues.count else { return [] }
        return deduplicated(routes)
    }

    @discardableResult
    static func toggle(
        _ route: XertMemberRoute,
        for userID: UUID,
        defaults: UserDefaults = .standard
    ) -> [XertMemberRoute] {
        guard let normalizedRoute = route.pinnableRoute else {
            return load(for: userID, defaults: defaults)
        }
        var routes = load(for: userID, defaults: defaults)
        if let index = routes.firstIndex(of: normalizedRoute) {
            routes.remove(at: index)
        } else {
            routes.insert(normalizedRoute, at: 0)
            routes = Array(routes.prefix(XertPinnedWorkspaceSnapshot.maximumRouteCount))
        }
        save(routes, for: userID, defaults: defaults)
        return routes
    }

    static func clear(for userID: UUID, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: storageKey(for: userID))
    }

    private static func save(
        _ routes: [XertMemberRoute],
        for userID: UUID,
        defaults: UserDefaults
    ) {
        let snapshot = XertPinnedWorkspaceSnapshot(routes: routes)
        guard
            let data = try? JSONEncoder().encode(snapshot),
            data.count <= XertPinnedWorkspaceSnapshot.maximumEncodedLength
        else { return }
        defaults.set(data, forKey: storageKey(for: userID))
    }

    private static func storageKey(for userID: UUID) -> String {
        keyPrefix + userID.uuidString.lowercased()
    }

    private static func deduplicated(_ routes: [XertMemberRoute]) -> [XertMemberRoute] {
        var seen = Set<XertMemberRoute>()
        return routes.filter { seen.insert($0).inserted }
    }
}

enum XertNavigationCommandAction: Hashable {
    case destination(XertPrimaryDestination)
    case pinned(XertMemberRoute)
    case timeline(Int)
    case activity(XertNavigationActivity)
    case previous
    case next
    case refresh
    case owner(XertOwnerWorkspace)
}

enum XertNavigationActivity: Hashable {
    case notices
    case notice(UUID)
    case classSession(UUID)
    case upcomingBookings(UUID?)
    case eventGoals
    case pendingCheckout
}

enum XertNavigationCommandSection: String, CaseIterable, Identifiable {
    case now = "Now"
    case discover = "Available Classes"
    case pinned = "Pinned Workspaces"
    case recent = "Workspace History"
    case navigate = "Navigate"
    case owner = "Owner Operations"
    case system = "System"

    var id: Self { self }
}

enum XertFirstClassActivationStage: Equatable {
    case signIn
    case needsCredits
    case choosingCredits
    case checkout
    case readyToBook
}

/// Keeps only the public class identifier needed to resume a member's chosen
/// task. It never stores profile, payment or readiness information.
struct XertFirstClassActivation: Equatable {
    let sessionID: UUID
    var stage: XertFirstClassActivationStage

    func matches(_ sessionID: UUID) -> Bool {
        self.sessionID == sessionID
    }
}

private enum XertNavigationFormatters {
    /// Command and status models are rebuilt as navigation state changes. A
    /// shared formatter avoids repeatedly allocating ICU-backed formatters in
    /// SwiftUI render paths while keeping every label in Brisbane time.
    static let brisbaneSchedule: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_AU")
        formatter.timeZone = TimeZone(identifier: "Australia/Brisbane")
        formatter.dateFormat = "EEE d MMM, h:mm a"
        return formatter
    }()
}

struct XertNextBookingNavigationContext: Equatable {
    let id: UUID
    let title: String
    let startTime: Date

    var scheduleLabel: String {
        XertNavigationFormatters.brisbaneSchedule.string(from: startTime)
    }
}

enum XertMemberRecordKind: Int, CaseIterable, Hashable {
    case booking
    case classSession
    case notice
}

struct XertMemberRecordNavigationContext: Identifiable, Equatable {
    static let maximumRecordsPerKind = 4
    static let maximumTitleLength = 120
    static let maximumDetailLength = 160

    let id: UUID
    let kind: XertMemberRecordKind
    let title: String
    let detail: String
    let timestamp: Date
    let priority: Int
    let requiresAuthentication: Bool

    static func booking(
        id: UUID,
        title: String,
        status: String,
        startTime: Date
    ) -> Self {
        Self(
            id: id,
            kind: .booking,
            title: normalizedTitle(title, fallback: "XERT class"),
            detail: normalizedDetail(status, fallback: "Upcoming booking"),
            timestamp: startTime,
            priority: 0,
            requiresAuthentication: true
        )
    }

    static func classSession(
        id: UUID,
        title: String,
        coach: String?,
        location: String?,
        spotsLeft: Int?,
        startTime: Date
    ) -> Self {
        let availability: String?
        if let spotsLeft {
            availability = spotsLeft > 0
                ? "\(spotsLeft) \(spotsLeft == 1 ? "spot" : "spots")"
                : "Waitlist"
        } else {
            availability = nil
        }
        let detail = [coach, location, availability]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        return Self(
            id: id,
            kind: .classSession,
            title: normalizedTitle(title, fallback: "XERT class"),
            detail: normalizedDetail(detail, fallback: "Class details and availability"),
            timestamp: startTime,
            priority: 0,
            requiresAuthentication: false
        )
    }

    static func notice(
        id: UUID,
        title: String,
        tone: String,
        publishedAt: Date
    ) -> Self {
        let normalizedTone = tone.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let priority: Int
        switch normalizedTone {
        case "urgent": priority = 0
        case "action": priority = 1
        default: priority = 2
        }
        return Self(
            id: id,
            kind: .notice,
            title: normalizedTitle(title, fallback: "Member update"),
            detail: normalizedDetail(normalizedTone, fallback: "update"),
            timestamp: publishedAt,
            priority: priority,
            requiresAuthentication: true
        )
    }

    private static func normalizedTitle(_ value: String, fallback: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return fallback }
        return String(normalized.prefix(maximumTitleLength))
    }

    private static func normalizedDetail(_ value: String, fallback: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolved = normalized.isEmpty ? fallback : normalized
        return String(resolved.prefix(maximumDetailLength))
    }
}

struct XertNavigationContext: Equatable {
    let isSignedIn: Bool
    let noticeCount: Int
    let bookingCount: Int
    let creditCount: Int
    let eventGoalCount: Int
    let hasPendingCheckout: Bool
    let nextBooking: XertNextBookingNavigationContext?
    let memberRecords: [XertMemberRecordNavigationContext]

    init(
        isSignedIn: Bool,
        noticeCount: Int,
        bookingCount: Int,
        creditCount: Int,
        eventGoalCount: Int,
        hasPendingCheckout: Bool,
        nextBooking: XertNextBookingNavigationContext? = nil,
        memberRecords: [XertMemberRecordNavigationContext] = []
    ) {
        self.isSignedIn = isSignedIn
        self.noticeCount = noticeCount
        self.bookingCount = bookingCount
        self.creditCount = creditCount
        self.eventGoalCount = eventGoalCount
        self.hasPendingCheckout = hasPendingCheckout
        self.nextBooking = isSignedIn ? nextBooking : nil
        let normalizedRecords = Self.normalizedRecords(memberRecords)
        self.memberRecords = isSignedIn
            ? normalizedRecords
            : normalizedRecords.filter { !$0.requiresAuthentication }
    }

    static let empty = XertNavigationContext(
        isSignedIn: false,
        noticeCount: 0,
        bookingCount: 0,
        creditCount: 0,
        eventGoalCount: 0,
        hasPendingCheckout: false,
        nextBooking: nil,
        memberRecords: []
    )

    private static func normalizedRecords(
        _ records: [XertMemberRecordNavigationContext]
    ) -> [XertMemberRecordNavigationContext] {
        var seen = Set<String>()
        let unique = records.filter {
            seen.insert("\($0.kind.rawValue):\($0.id.uuidString.lowercased())").inserted
        }
        return XertMemberRecordKind.allCases.flatMap { kind in
            unique
                .filter { $0.kind == kind }
                .sorted { lhs, rhs in
                    if lhs.priority != rhs.priority { return lhs.priority < rhs.priority }
                    switch kind {
                    case .booking, .classSession:
                        return lhs.timestamp < rhs.timestamp
                    case .notice:
                        return lhs.timestamp > rhs.timestamp
                    }
                }
                .prefix(XertMemberRecordNavigationContext.maximumRecordsPerKind)
        }
    }
}

enum XertNavigationStatusKind: Equatable {
    case activity
    case attention
}

struct XertNavigationStatus: Identifiable, Equatable {
    let destination: XertPrimaryDestination
    let kind: XertNavigationStatusKind
    let count: Int?
    let accessibilityLabel: String
    let activity: XertNavigationActivity
    let actionTitle: String
    let shortTitle: String
    let icon: String
    fileprivate let priority: Int

    var id: XertPrimaryDestination { destination }
    var badgeText: String {
        guard let count else { return "!" }
        return count > 99 ? "99+" : String(count)
    }
}

struct XertNavigationStatusSnapshot: Equatable {
    private let statuses: [XertNavigationStatus]

    init(context: XertNavigationContext) {
        guard context.isSignedIn else {
            statuses = []
            return
        }

        var current: [XertNavigationStatus] = []
        if context.noticeCount > 0 {
            current.append(Self.activity(
                destination: .home,
                count: context.noticeCount,
                singular: "active member notice",
                plural: "active member notices",
                activity: .notices,
                actionTitle: "Review member notices",
                shortTitle: "Notices",
                icon: "bell.badge",
                priority: 20
            ))
        }
        if context.hasPendingCheckout {
            current.append(XertNavigationStatus(
                destination: .booking,
                kind: .attention,
                count: nil,
                accessibilityLabel: "Purchase confirmation needs attention",
                activity: .pendingCheckout,
                actionTitle: "Check purchase confirmation",
                shortTitle: "Purchase",
                icon: "clock.arrow.circlepath",
                priority: 0
            ))
        }
        if context.eventGoalCount > 0 {
            current.append(Self.activity(
                destination: .events,
                count: context.eventGoalCount,
                singular: "selected event goal",
                plural: "selected event goals",
                activity: .eventGoals,
                actionTitle: "Review event goals",
                shortTitle: "Goals",
                icon: "target",
                priority: 30
            ))
        }
        if context.bookingCount > 0 {
            let nextBooking = context.nextBooking
            current.append(Self.activity(
                destination: .account,
                count: context.bookingCount,
                singular: "upcoming booking",
                plural: "upcoming bookings",
                activity: .upcomingBookings(nextBooking?.id),
                actionTitle: nextBooking.map { "Open next class: \($0.title)" } ?? "View upcoming bookings",
                shortTitle: nextBooking == nil ? "Bookings" : "Next class",
                icon: "calendar.badge.clock",
                priority: 10,
                accessibilityDetail: nextBooking.map { "Next booking is \($0.title), \($0.scheduleLabel)" }
            ))
        }
        statuses = current
    }

    func status(for destination: XertPrimaryDestination) -> XertNavigationStatus? {
        statuses.first { $0.destination == destination }
    }

    var priorityStatus: XertNavigationStatus? {
        statuses.min { $0.priority < $1.priority }
    }

    private static func activity(
        destination: XertPrimaryDestination,
        count: Int,
        singular: String,
        plural: String,
        activity: XertNavigationActivity,
        actionTitle: String,
        shortTitle: String,
        icon: String,
        priority: Int,
        accessibilityDetail: String? = nil
    ) -> XertNavigationStatus {
        let boundedCount = max(1, count)
        return XertNavigationStatus(
            destination: destination,
            kind: .activity,
            count: boundedCount,
            accessibilityLabel: accessibilityDetail
                ?? "\(boundedCount) \(boundedCount == 1 ? singular : plural)",
            activity: activity,
            actionTitle: actionTitle,
            shortTitle: shortTitle,
            icon: icon,
            priority: priority
        )
    }
}

struct XertNavigationCommand: Identifiable, Hashable {
    let id: String
    let title: String
    let subtitle: String
    let icon: String
    let keywords: [String]
    let section: XertNavigationCommandSection
    let action: XertNavigationCommandAction

    fileprivate var searchIndex: String {
        ([title, subtitle] + keywords).joined(separator: " ").lowercased()
    }
}

struct XertNavigationTimelineItem: Identifiable, Equatable {
    let index: Int
    let route: XertMemberRoute
    let offset: Int

    var id: Int { index }
    var isCurrent: Bool { offset == 0 }
    var distance: Int { abs(offset) }
}

struct XertNavigationWorkspaceOverview: Equatable {
    let currentRoute: XertMemberRoute
    let backCount: Int
    let forwardCount: Int
}

struct XertNavigationWorkspaceNode: Identifiable, Equatable {
    let destination: XertPrimaryDestination
    let route: XertMemberRoute
    let isCurrent: Bool

    var id: XertPrimaryDestination { destination }
}

final class XertNavigationCoordinator: ObservableObject {
    @Published private(set) var selection: XertPrimaryDestination
    @Published private(set) var route: XertMemberRoute
    @Published private(set) var routeSequence: UInt = 0
    @Published private(set) var lastTransition: XertNavigationTransition?
    @Published private(set) var reselectionSequence: UInt = 0
    private(set) var routeHistory: [XertMemberRoute]
    private(set) var forwardRouteHistory: [XertMemberRoute] = []
    private(set) var workspaceRoutes: [XertPrimaryDestination: XertMemberRoute]

    private let historyLimit: Int
    private var transitionSequence: UInt = 0

    init(initial: XertPrimaryDestination = .home, historyLimit: Int = 12) {
        selection = initial
        route = .primary(initial)
        routeHistory = [.primary(initial)]
        workspaceRoutes = Self.defaultWorkspaceRoutes
        self.historyLimit = min(
            max(2, historyLimit),
            XertNavigationWorkspaceSnapshot.maximumRouteCount
        )
    }

    var history: [XertPrimaryDestination] {
        routeHistory.reduce(into: []) { destinations, route in
            if destinations.last != route.destination {
                destinations.append(route.destination)
            }
        }
    }

    var previousRoute: XertMemberRoute? {
        routeHistory.dropLast().last
    }

    var previousDestination: XertPrimaryDestination? {
        previousRoute?.destination
    }

    var nextRoute: XertMemberRoute? {
        forwardRouteHistory.first
    }

    var timeline: [XertNavigationTimelineItem] {
        let currentIndex = routeHistory.count - 1
        return (routeHistory + forwardRouteHistory).enumerated().map { index, route in
            XertNavigationTimelineItem(
                index: index,
                route: route,
                offset: index - currentIndex
            )
        }
    }

    var workspaceOverview: XertNavigationWorkspaceOverview {
        XertNavigationWorkspaceOverview(
            currentRoute: route,
            backCount: max(0, routeHistory.count - 1),
            forwardCount: forwardRouteHistory.count
        )
    }

    func workspaceNodes(
        order: [XertPrimaryDestination] = XertPrimaryDestination.dockOrder,
        allowsProtectedRoutes: Bool = true
    ) -> [XertNavigationWorkspaceNode] {
        XertWorkspaceOrderStore.normalized(order).map { destination in
            let rememberedRoute = rememberedRoute(for: destination)
            let visibleRoute = allowsProtectedRoutes || !rememberedRoute.requiresAuthentication
                ? rememberedRoute
                : .primary(destination)
            return XertNavigationWorkspaceNode(
                destination: destination,
                route: visibleRoute,
                isCurrent: destination == selection
            )
        }
    }

    var containsContextualHistory: Bool {
        routeHistory.contains { $0.isContextualTask }
            || forwardRouteHistory.contains { $0.isContextualTask }
            || workspaceRoutes.values.contains { $0.isContextualTask }
    }

    var containsProtectedHistory: Bool {
        routeHistory.contains { $0.requiresAuthentication }
            || forwardRouteHistory.contains { $0.requiresAuthentication }
            || workspaceRoutes.values.contains { $0.requiresAuthentication }
    }

    var workspaceRestorationValue: String {
        let snapshot = XertNavigationWorkspaceSnapshot(
            routes: routeHistory,
            forwardRoutes: forwardRouteHistory,
            workspaceRoutes: XertPrimaryDestination.dockOrder.compactMap { workspaceRoutes[$0] }
        )
        guard
            let data = try? JSONEncoder().encode(snapshot),
            let value = String(data: data, encoding: .utf8),
            value.count <= XertNavigationWorkspaceSnapshot.maximumEncodedLength
        else { return "" }
        return value
    }

    func commandPaletteCommands(
        isAdmin: Bool,
        context: XertNavigationContext = .empty,
        pinnedRoutes: [XertMemberRoute] = [],
        orderedDestinations: [XertPrimaryDestination] = XertPrimaryDestination.dockOrder
    ) -> [XertNavigationCommand] {
        var commands = XertWorkspaceOrderStore.normalized(orderedDestinations)
            .filter { $0 != selection }
            .map { destination in
                let rememberedRoute = commandRoute(for: destination, context: context)
                return XertNavigationCommand(
                    id: "destination-\(destination.rawValue)",
                    title: rememberedRoute.isContextualTask
                        ? "Return to \(rememberedRoute.navigationTitle)"
                        : "Open \(destination.title)",
                    subtitle: commandSubtitle(for: destination, context: context),
                    icon: destination.icon,
                    keywords: commandKeywords(for: destination) + [rememberedRoute.navigationTitle],
                    section: .navigate,
                    action: .destination(destination)
                )
            }

        commands.insert(contentsOf: pinnedCommands(
            routes: pinnedRoutes,
            allowsProtectedRoutes: context.isSignedIn
        ), at: 0)
        commands.insert(contentsOf: activityCommands(context: context), at: 0)
        commands.append(contentsOf: timelineCommands(
            allowsProtectedRoutes: context.isSignedIn
        ))

        commands.append(XertNavigationCommand(
            id: "refresh-\(selection.rawValue)",
            title: "Refresh \(selection.title)",
            subtitle: "Reload the latest XERT member and training data",
            icon: "arrow.clockwise",
            keywords: ["reload", "sync", "update", selection.title],
            section: .system,
            action: .refresh
        ))

        if let previousRoute {
            commands.append(XertNavigationCommand(
                id: "previous-\(previousRoute.restorationValue)",
                title: "Back to \(previousRoute.navigationTitle)",
                subtitle: "Return to the exact task in your workspace history",
                icon: "arrow.uturn.backward",
                keywords: ["back", "previous", "history", previousRoute.navigationTitle],
                section: .system,
                action: .previous
            ))
        }

        if let nextRoute {
            commands.append(XertNavigationCommand(
                id: "next-\(nextRoute.restorationValue)",
                title: "Forward to \(nextRoute.navigationTitle)",
                subtitle: "Return to the next exact task in your workspace history",
                icon: "arrow.uturn.forward",
                keywords: ["forward", "next", "history", nextRoute.navigationTitle],
                section: .system,
                action: .next
            ))
        }

        if isAdmin {
            commands.append(contentsOf: XertOwnerWorkspace.allCases.map { workspace in
                XertNavigationCommand(
                    id: "owner-\(workspace.rawValue)",
                    title: workspace == .overview ? "Owner Command Centre" : workspace.title,
                    subtitle: workspace.detail,
                    icon: workspace.icon,
                    keywords: ["owner", "admin", "operations"] + workspace.searchKeywords,
                    section: .owner,
                    action: .owner(workspace)
                )
            })
        }
        return commands
    }

    static func filteredCommands(
        _ commands: [XertNavigationCommand],
        query: String
    ) -> [XertNavigationCommand] {
        let terms = query
            .lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        guard !terms.isEmpty else { return commands }

        return commands
            .filter { command in
                terms.allSatisfy { command.searchIndex.contains($0) }
            }
            .sorted { lhs, rhs in
                let lhsStarts = lhs.title.lowercased().hasPrefix(terms[0])
                let rhsStarts = rhs.title.lowercased().hasPrefix(terms[0])
                if lhsStarts != rhsStarts { return lhsStarts }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
    }

    func restore(rawValue: Int) {
        let destination = XertPrimaryDestination(rawValue: rawValue) ?? .home
        let previous = selection
        selection = destination
        route = .primary(destination)
        routeSequence &+= 1
        routeHistory = [.primary(destination)]
        forwardRouteHistory = []
        workspaceRoutes = Self.defaultWorkspaceRoutes
        if previous == destination {
            lastTransition = nil
        } else {
            recordTransition(from: previous, to: destination, source: .restoration)
        }
    }

    func restore(routeValue: String) {
        let restoredRoute = XertMemberRoute.restore(routeValue) ?? .home
        applyRestoredRoutes([restoredRoute], forwardRoutes: [], workspaceRoutes: nil)
    }

    func restore(
        workspaceValue: String,
        fallbackRouteValue: String,
        allowsProtectedRoutes: Bool = true
    ) {
        guard
            !workspaceValue.isEmpty,
            workspaceValue.count <= XertNavigationWorkspaceSnapshot.maximumEncodedLength,
            let data = workspaceValue.data(using: .utf8),
            let snapshot = try? JSONDecoder().decode(XertNavigationWorkspaceSnapshot.self, from: data),
            [
                XertNavigationWorkspaceSnapshot.legacyVersion,
                XertNavigationWorkspaceSnapshot.currentVersion,
            ].contains(snapshot.version),
            !snapshot.routeValues.isEmpty,
            snapshot.routeValues.count + (snapshot.forwardRouteValues?.count ?? 0)
                <= XertNavigationWorkspaceSnapshot.maximumRouteCount,
            snapshot.version == XertNavigationWorkspaceSnapshot.legacyVersion
                ? snapshot.workspaceRouteValues == nil
                : snapshot.workspaceRouteValues?.count
                    == XertNavigationWorkspaceSnapshot.maximumWorkspaceRouteCount
        else {
            restore(routeValue: authorizedFallback(
                fallbackRouteValue,
                allowsProtectedRoutes: allowsProtectedRoutes
            ).restorationValue)
            return
        }

        let restoredRoutes = snapshot.routeValues.compactMap { XertMemberRoute.restore($0) }
        let forwardValues = snapshot.forwardRouteValues ?? []
        let restoredForwardRoutes = forwardValues.compactMap { XertMemberRoute.restore($0) }
        let workspaceValues = snapshot.workspaceRouteValues ?? []
        let restoredWorkspaceRoutes = workspaceValues.compactMap { XertMemberRoute.restore($0) }
        guard
            restoredRoutes.count == snapshot.routeValues.count,
            restoredForwardRoutes.count == forwardValues.count,
            restoredWorkspaceRoutes.count == workspaceValues.count,
            Set(restoredWorkspaceRoutes.map(\.destination)).count == restoredWorkspaceRoutes.count
        else {
            restore(routeValue: authorizedFallback(
                fallbackRouteValue,
                allowsProtectedRoutes: allowsProtectedRoutes
            ).restorationValue)
            return
        }

        let authorizedRoutes = allowsProtectedRoutes
            ? restoredRoutes
            : restoredRoutes.filter { !$0.requiresAuthentication }
        let authorizedForwardRoutes = allowsProtectedRoutes
            ? restoredForwardRoutes
            : restoredForwardRoutes.filter { !$0.requiresAuthentication }
        let authorizedWorkspaceRoutes = allowsProtectedRoutes
            ? restoredWorkspaceRoutes
            : restoredWorkspaceRoutes.filter { !$0.requiresAuthentication }
        guard !authorizedRoutes.isEmpty else {
            restore(routeValue: authorizedFallback(
                fallbackRouteValue,
                allowsProtectedRoutes: allowsProtectedRoutes
            ).restorationValue)
            return
        }

        let boundedForwardRoutes = Array(authorizedForwardRoutes.prefix(max(0, historyLimit - 1)))
        let backwardCapacity = max(1, historyLimit - boundedForwardRoutes.count)
        let boundedRoutes = Array(authorizedRoutes.suffix(backwardCapacity))
        applyRestoredRoutes(
            boundedRoutes,
            forwardRoutes: boundedForwardRoutes,
            workspaceRoutes: snapshot.version == XertNavigationWorkspaceSnapshot.legacyVersion
                ? nil
                : Dictionary(uniqueKeysWithValues: authorizedWorkspaceRoutes.map { ($0.destination, $0) })
        )
    }

    private func authorizedFallback(
        _ routeValue: String,
        allowsProtectedRoutes: Bool
    ) -> XertMemberRoute {
        let route = XertMemberRoute.restore(routeValue) ?? .home
        return allowsProtectedRoutes || !route.requiresAuthentication ? route : .home
    }

    private func applyRestoredRoutes(
        _ restoredRoutes: [XertMemberRoute],
        forwardRoutes: [XertMemberRoute],
        workspaceRoutes restoredWorkspaceRoutes: [XertPrimaryDestination: XertMemberRoute]?
    ) {
        guard let restoredRoute = restoredRoutes.last else { return }
        let destination = restoredRoute.destination
        let previous = selection
        selection = destination
        route = restoredRoute
        routeSequence &+= 1
        routeHistory = restoredRoutes
        forwardRouteHistory = forwardRoutes
        workspaceRoutes = Self.defaultWorkspaceRoutes
        if let restoredWorkspaceRoutes {
            workspaceRoutes.merge(restoredWorkspaceRoutes) { _, restored in restored }
        } else {
            for rememberedRoute in restoredRoutes + forwardRoutes {
                remember(rememberedRoute)
            }
        }
        remember(restoredRoute)
        if previous == destination {
            lastTransition = nil
        } else {
            recordTransition(from: previous, to: destination, source: .restoration)
        }
    }

    @discardableResult
    func select(
        _ destination: XertPrimaryDestination,
        source: XertNavigationSource,
        allowsProtectedRoutes: Bool = true
    ) -> Bool {
        let rememberedRoute = rememberedRoute(for: destination)
        let targetRoute = allowsProtectedRoutes || !rememberedRoute.requiresAuthentication
            ? rememberedRoute
            : .primary(destination)
        return open(targetRoute, source: source)
    }

    func rememberedRoute(for destination: XertPrimaryDestination) -> XertMemberRoute {
        workspaceRoutes[destination] ?? .primary(destination)
    }

    @discardableResult
    func open(_ targetRoute: XertMemberRoute, source: XertNavigationSource) -> Bool {
        let destination = targetRoute.destination
        if destination == selection, targetRoute == route {
            reselect(destination)
            return false
        }

        let previous = selection
        selection = destination
        route = targetRoute
        remember(targetRoute)
        routeSequence &+= 1
        forwardRouteHistory = []
        routeHistory.append(targetRoute)
        if routeHistory.count > historyLimit {
            routeHistory.removeFirst(routeHistory.count - historyLimit)
        }
        recordTransition(from: previous, to: destination, source: source)
        return true
    }

    @discardableResult
    func step(
        _ direction: XertNavigationDirection,
        order: [XertPrimaryDestination] = XertPrimaryDestination.dockOrder,
        source: XertNavigationSource = .dockSwipe,
        allowsProtectedRoutes: Bool = true
    ) -> Bool {
        let destinations = XertWorkspaceOrderStore.normalized(order)
        guard let index = destinations.firstIndex(of: selection) else { return false }
        let targetIndex = direction == .next ? index + 1 : index - 1
        guard destinations.indices.contains(targetIndex) else { return false }
        return select(
            destinations[targetIndex],
            source: source,
            allowsProtectedRoutes: allowsProtectedRoutes
        )
    }

    @discardableResult
    func returnToPrevious(source: XertNavigationSource = .history) -> Bool {
        guard routeHistory.count > 1 else { return false }
        let previous = selection
        let departedRoute = routeHistory.removeLast()
        forwardRouteHistory.insert(departedRoute, at: 0)
        guard let targetRoute = routeHistory.last else { return false }
        selection = targetRoute.destination
        route = targetRoute
        remember(targetRoute)
        routeSequence &+= 1
        recordTransition(from: previous, to: targetRoute.destination, source: source)
        return true
    }

    @discardableResult
    func returnToNext(source: XertNavigationSource = .history) -> Bool {
        guard !forwardRouteHistory.isEmpty else { return false }
        let previous = selection
        let targetRoute = forwardRouteHistory.removeFirst()
        routeHistory.append(targetRoute)
        selection = targetRoute.destination
        route = targetRoute
        remember(targetRoute)
        routeSequence &+= 1
        recordTransition(from: previous, to: targetRoute.destination, source: source)
        return true
    }

    @discardableResult
    func jump(
        toTimelineIndex index: Int,
        source: XertNavigationSource = .history,
        allowsProtectedRoutes: Bool = true
    ) -> Bool {
        let routes = routeHistory + forwardRouteHistory
        let currentIndex = routeHistory.count - 1
        guard
            routes.indices.contains(index),
            index != currentIndex,
            allowsProtectedRoutes || !routes[index].requiresAuthentication
        else { return false }

        let previous = selection
        let targetRoute = routes[index]
        routeHistory = Array(routes.prefix(index + 1))
        forwardRouteHistory = Array(routes.dropFirst(index + 1))
        selection = targetRoute.destination
        route = targetRoute
        remember(targetRoute)
        routeSequence &+= 1
        recordTransition(from: previous, to: targetRoute.destination, source: source)
        return true
    }

    func reselect(_ destination: XertPrimaryDestination) {
        guard destination == selection else { return }
        reselectionSequence &+= 1
    }

    private static var defaultWorkspaceRoutes: [XertPrimaryDestination: XertMemberRoute] {
        Dictionary(uniqueKeysWithValues: XertPrimaryDestination.allCases.map { destination in
            (destination, XertMemberRoute.primary(destination))
        })
    }

    private func remember(_ route: XertMemberRoute) {
        workspaceRoutes[route.destination] = route
    }

    private func commandRoute(
        for destination: XertPrimaryDestination,
        context: XertNavigationContext
    ) -> XertMemberRoute {
        let rememberedRoute = rememberedRoute(for: destination)
        return context.isSignedIn || !rememberedRoute.requiresAuthentication
            ? rememberedRoute
            : .primary(destination)
    }

    private func recordTransition(
        from: XertPrimaryDestination,
        to: XertPrimaryDestination,
        source: XertNavigationSource
    ) {
        transitionSequence &+= 1
        lastTransition = XertNavigationTransition(
            from: from,
            to: to,
            source: source,
            sequence: transitionSequence
        )
    }

    private func activityCommands(context: XertNavigationContext) -> [XertNavigationCommand] {
        var commands = context.memberRecords
            .filter { $0.kind == .classSession }
            .map { record in
                XertNavigationCommand(
                    id: "discover-class-\(record.id.uuidString.lowercased())",
                    title: record.title,
                    subtitle: "\(bookingScheduleLabel(record.timestamp)) · \(record.detail)",
                    icon: "figure.strengthtraining.traditional",
                    keywords: ["class", "book", "coach", "location", "spots", record.title, record.detail],
                    section: .discover,
                    action: .activity(.classSession(record.id))
                )
            }
        guard context.isSignedIn else { return commands }

        if context.hasPendingCheckout {
            commands.append(XertNavigationCommand(
                id: "activity-pending-checkout",
                title: "Check purchase confirmation",
                subtitle: "Reconcile your pending session-pack purchase",
                icon: "clock.arrow.circlepath",
                keywords: ["purchase", "payment", "stripe", "pending", "credits"],
                section: .now,
                action: .activity(.pendingCheckout)
            ))
        }
        let bookingRecords = context.memberRecords.filter { $0.kind == .booking }
        if !bookingRecords.isEmpty {
            commands.append(contentsOf: bookingRecords.map { record in
                XertNavigationCommand(
                    id: "activity-booking-\(record.id.uuidString.lowercased())",
                    title: "Open class: \(record.title)",
                    subtitle: "\(bookingScheduleLabel(record.timestamp)) · \(record.detail)",
                    icon: "calendar.badge.clock",
                    keywords: ["class", "booking", "schedule", "reminder", "cancel", record.title, record.detail],
                    section: .now,
                    action: .activity(.upcomingBookings(record.id))
                )
            })
        }
        if context.bookingCount > bookingRecords.count {
            let nextBooking = context.nextBooking
            let hasExactRecords = !bookingRecords.isEmpty
            let title: String
            let subtitle: String
            let activity: XertNavigationActivity
            if hasExactRecords {
                title = "View all \(context.bookingCount) upcoming \(noun(context.bookingCount, singular: "booking", plural: "bookings"))"
                subtitle = "Open the complete booking timeline"
                activity = .upcomingBookings(nil)
            } else if let nextBooking {
                title = "Open next class: \(nextBooking.title)"
                subtitle = "\(nextBooking.scheduleLabel) · \(context.bookingCount) upcoming"
                activity = .upcomingBookings(nextBooking.id)
            } else {
                title = "View \(context.bookingCount) upcoming \(noun(context.bookingCount, singular: "booking", plural: "bookings"))"
                subtitle = "Review class details, reminders and cancellations"
                activity = .upcomingBookings(nil)
            }
            commands.append(XertNavigationCommand(
                id: "activity-upcoming-bookings",
                title: title,
                subtitle: subtitle,
                icon: "calendar.badge.clock",
                keywords: ["class", "schedule", "reminder", "cancel", nextBooking?.title ?? ""],
                section: .now,
                action: .activity(activity)
            ))
        }
        let noticeRecords = context.memberRecords.filter { $0.kind == .notice }
        if !noticeRecords.isEmpty {
            commands.append(contentsOf: noticeRecords.map { record in
                XertNavigationCommand(
                    id: "activity-notice-\(record.id.uuidString.lowercased())",
                    title: record.title,
                    subtitle: noticeDetailLabel(record),
                    icon: record.priority == 0 ? "exclamationmark.bubble.fill" : "bell.badge",
                    keywords: ["announcement", "message", "update", "news", record.title, record.detail],
                    section: .now,
                    action: .activity(.notice(record.id))
                )
            })
        }
        if context.noticeCount > noticeRecords.count {
            commands.append(XertNavigationCommand(
                id: "activity-notices",
                title: "Review \(context.noticeCount) member \(noun(context.noticeCount, singular: "notice", plural: "notices"))",
                subtitle: "Open current updates from the XERT team",
                icon: "bell.badge",
                keywords: ["announcement", "message", "update", "news"],
                section: .now,
                action: .activity(.notices)
            ))
        }
        if context.eventGoalCount > 0 {
            commands.append(XertNavigationCommand(
                id: "activity-event-goals",
                title: "Review \(context.eventGoalCount) event \(noun(context.eventGoalCount, singular: "goal", plural: "goals"))",
                subtitle: "See the competitions you are training toward",
                icon: "target",
                keywords: ["race", "competition", "calendar", "training"],
                section: .now,
                action: .activity(.eventGoals)
            ))
        }
        return commands
    }

    private func bookingScheduleLabel(_ date: Date) -> String {
        XertNavigationFormatters.brisbaneSchedule.string(from: date)
    }

    private func noticeDetailLabel(_ record: XertMemberRecordNavigationContext) -> String {
        let published = record.timestamp.formatted(
            .relative(presentation: .named, unitsStyle: .wide)
        )
        switch record.detail {
        case "urgent": return "Urgent member notice · \(published)"
        case "action": return "Action requested · \(published)"
        default: return "Member update · \(published)"
        }
    }

    private func pinnedCommands(
        routes: [XertMemberRoute],
        allowsProtectedRoutes: Bool
    ) -> [XertNavigationCommand] {
        var seen = Set<XertMemberRoute>()
        return routes
            .compactMap(\.pinnableRoute)
            .filter { seen.insert($0).inserted }
            .filter { allowsProtectedRoutes || !$0.requiresAuthentication }
            .prefix(XertPinnedWorkspaceSnapshot.maximumRouteCount)
            .map { route in
                XertNavigationCommand(
                    id: "pinned-\(route.restorationValue)",
                    title: route.navigationTitle,
                    subtitle: "Open this saved XERT workspace",
                    icon: "pin.fill",
                    keywords: ["pin", "saved", "favourite", "favorite", "workspace", route.navigationTitle],
                    section: .pinned,
                    action: .pinned(route)
                )
            }
    }

    private func timelineCommands(
        limit: Int = 6,
        allowsProtectedRoutes: Bool
    ) -> [XertNavigationCommand] {
        timeline
            .filter { !$0.isCurrent }
            .filter { allowsProtectedRoutes || !$0.route.requiresAuthentication }
            .sorted { lhs, rhs in
                if lhs.distance != rhs.distance { return lhs.distance < rhs.distance }
                return lhs.offset < rhs.offset
            }
            .prefix(max(0, limit))
            .map { item in
                let direction = item.offset < 0 ? "Back" : "Forward"
                let stepLabel = noun(item.distance, singular: "task", plural: "tasks")
                return XertNavigationCommand(
                    id: "timeline-\(item.index)-\(item.route.restorationValue)",
                    title: "\(direction) to \(item.route.navigationTitle)",
                    subtitle: "\(item.distance) \(stepLabel) \(item.offset < 0 ? "back" : "forward") in this workspace",
                    icon: item.offset < 0 ? "arrow.uturn.backward" : "arrow.uturn.forward",
                    keywords: ["recent", "history", "timeline", "workspace", item.route.navigationTitle],
                    section: .recent,
                    action: .timeline(item.index)
                )
            }
    }

    private func commandSubtitle(
        for destination: XertPrimaryDestination,
        context: XertNavigationContext
    ) -> String {
        switch destination {
        case .home:
            return context.noticeCount > 0
                ? "\(context.noticeCount) active \(noun(context.noticeCount, singular: "notice", plural: "notices")) and next training actions"
                : "Member dashboard, notices and next training actions"
        case .booking:
            return context.isSignedIn
                ? "\(context.creditCount) \(noun(context.creditCount, singular: "credit", plural: "credits")) available; classes, packs and PT"
                : "Classes, availability, session packs and PT requests"
        case .events:
            return context.eventGoalCount > 0
                ? "\(context.eventGoalCount) selected \(noun(context.eventGoalCount, singular: "goal", plural: "goals")) in the annual calendar"
                : "Annual event calendar and shared competition goals"
        case .explore: return "Training philosophy, coaches and XERT information"
        case .account:
            return context.bookingCount > 0
                ? "\(context.bookingCount) upcoming \(noun(context.bookingCount, singular: "booking", plural: "bookings")), purchases and security"
                : "Bookings, credits, purchases and account security"
        }
    }

    private func noun(_ count: Int, singular: String, plural: String) -> String {
        count == 1 ? singular : plural
    }

    private func commandKeywords(for destination: XertPrimaryDestination) -> [String] {
        switch destination {
        case .home: return ["dashboard", "notices", "today", "training"]
        case .booking: return ["book", "class", "timetable", "pack", "pt"]
        case .events: return ["calendar", "race", "competition", "goal"]
        case .explore: return ["coaches", "about", "philosophy", "contact"]
        case .account: return ["profile", "credits", "orders", "security"]
        }
    }
}
