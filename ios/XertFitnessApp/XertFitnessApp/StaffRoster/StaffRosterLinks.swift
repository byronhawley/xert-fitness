import Foundation

/// The four native My Coaching sections. Deep links name a section by its
/// path component; `upcoming` is the bare `/open/coaching` entry.
enum XertCoachingTab: String, CaseIterable, Hashable, Identifiable {
    case upcoming
    case roster
    case availability
    case requests

    var id: Self { self }

    var title: String {
        switch self {
        case .upcoming: return "Upcoming"
        case .roster: return "My Roster"
        case .availability: return "Availability"
        case .requests: return "Requests"
        }
    }

    var icon: String {
        switch self {
        case .upcoming: return "clock.badge.checkmark"
        case .roster: return "calendar"
        case .availability: return "checklist"
        case .requests: return "arrow.left.arrow.right"
        }
    }

    /// The path segment after `/open/coaching`. Upcoming has none.
    var pathComponent: String? {
        self == .upcoming ? nil : rawValue
    }

    /// Tabs that may be named by a path segment or an in-app `tab=` value.
    static let linkableTabs: [XertCoachingTab] = [.roster, .availability, .requests]

    static func linkable(_ value: String) -> XertCoachingTab? {
        linkableTabs.first { $0.rawValue == value }
    }
}

/// A validated My Coaching destination. This is the whole deep-link contract
/// shared with the web app:
///
///   /open/coaching, /open/coaching/roster, /open/coaching/availability,
///   /open/coaching/requests, each with an optional `?month=YYYY-MM`;
///   in-app notice links `/coaching?tab=roster|availability|requests&month=YYYY-MM`.
///
/// Parsing never decides who may see roster data. The server answers that on
/// every call; a link only chooses which section opens.
struct XertCoachingLink: Hashable {
    let tab: XertCoachingTab
    let month: String?

    init(tab: XertCoachingTab = .upcoming, month: String? = nil) {
        self.tab = tab
        self.month = month.flatMap { Self.isValidMonth($0) ? $0 : nil }
    }

    /// `2026-11` style roster month keys only.
    static func isValidMonth(_ value: String) -> Bool {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard
            parts.count == 2,
            parts[0].count == 4,
            parts[1].count == 2,
            parts[0].allSatisfy({ $0.isASCII && $0.isNumber }),
            parts[1].allSatisfy({ $0.isASCII && $0.isNumber }),
            let year = Int(parts[0]),
            let month = Int(parts[1])
        else { return false }
        return (2000...2100).contains(year) && (1...12).contains(month)
    }

    /// Value stored by navigation restoration, e.g. `coaching/availability?month=2026-11`.
    var restorationValue: String {
        var value = "coaching"
        if let component = tab.pathComponent { value += "/\(component)" }
        if let month { value += "?month=\(month)" }
        return value
    }

    /// Universal-link path, e.g. `/open/coaching/roster?month=2026-11`.
    var openPath: String { "/open/\(restorationValue)" }

    // MARK: Parsing

    /// Path components after `/open/` (or after the custom scheme), plus the
    /// raw query. Unknown sections, extra segments, unknown parameters and
    /// malformed months are all rejected.
    static func link(pathComponents rawComponents: [String], query: String?) -> XertCoachingLink? {
        let components = rawComponents.map { $0.lowercased() }.filter { !$0.isEmpty }
        guard components.first == "coaching" else { return nil }
        let tab: XertCoachingTab
        switch components.count {
        case 1:
            tab = .upcoming
        case 2:
            guard let named = XertCoachingTab.linkable(components[1]) else { return nil }
            tab = named
        default:
            return nil
        }
        guard let parameters = queryParameters(query, allowed: ["month"]) else { return nil }
        if let month = parameters["month"] {
            guard isValidMonth(month) else { return nil }
            return XertCoachingLink(tab: tab, month: month)
        }
        return XertCoachingLink(tab: tab)
    }

    /// Restoration values written by `restorationValue`.
    static func link(restorationValue value: String) -> XertCoachingLink? {
        let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let pieces = trimmed.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard let path = pieces.first else { return nil }
        let query = pieces.count > 1 ? String(pieces[1]) : nil
        return link(
            pathComponents: path.split(separator: "/").map(String.init),
            query: query
        )
    }

    /// A relative open path from a push payload, e.g. `/open/coaching/roster?month=2026-11`.
    static func link(openPath: String) -> XertCoachingLink? {
        guard
            let components = URLComponents(string: openPath),
            components.scheme == nil,
            components.host == nil,
            components.user == nil,
            components.password == nil,
            components.fragment == nil
        else { return nil }
        let path = components.path.lowercased()
        guard path.hasPrefix("/open/") else { return nil }
        return link(
            pathComponents: String(path.dropFirst("/open/".count)).split(separator: "/").map(String.init),
            query: components.percentEncodedQuery
        )
    }

    /// Universal links on the canonical web host (`https://…/open/coaching…`)
    /// and the custom scheme (`xertfitness://coaching/roster`).
    static func link(for url: URL) -> XertCoachingLink? {
        guard url.user == nil, url.password == nil, url.fragment == nil else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let scheme = url.scheme?.lowercased()
        if scheme == "https" {
            guard
                url.host?.lowercased() == AppConfig.vercelHost,
                url.port == nil || url.port == 443
            else { return nil }
            let path = url.path.lowercased()
            guard path.hasPrefix("/open/") else { return nil }
            return link(
                pathComponents: String(path.dropFirst("/open/".count)).split(separator: "/").map(String.init),
                query: components.percentEncodedQuery
            )
        }
        guard scheme == "xertfitness", url.port == nil else { return nil }
        let host = url.host?.lowercased() ?? ""
        var parts = url.path.lowercased().split(separator: "/").map(String.init)
        if !host.isEmpty { parts.insert(host, at: 0) }
        if parts.first == "open" { parts.removeFirst() }
        return link(pathComponents: parts, query: components.percentEncodedQuery)
    }

    /// In-app notice links stored by the roster (`staff_notifications.link`),
    /// e.g. `/coaching?tab=availability&month=2026-12`. A missing tab opens
    /// Upcoming; an unknown tab is rejected.
    static func link(inAppNotice value: String) -> XertCoachingLink? {
        guard
            let components = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
            components.scheme == nil,
            components.host == nil,
            components.fragment == nil
        else { return nil }
        let path = components.path.lowercased()
        guard path == "/coaching" || path == "/coaching/" else { return nil }
        guard let parameters = queryParameters(components.percentEncodedQuery, allowed: ["tab", "month"]) else {
            return nil
        }
        var tab = XertCoachingTab.upcoming
        if let rawTab = parameters["tab"] {
            guard let named = XertCoachingTab.linkable(rawTab.lowercased()) else { return nil }
            tab = named
        }
        if let month = parameters["month"] {
            guard isValidMonth(month) else { return nil }
            return XertCoachingLink(tab: tab, month: month)
        }
        return XertCoachingLink(tab: tab)
    }

    /// Splits `a=1&b=2`. Returns nil for unknown names, repeated names or
    /// names without a value, so a typo never silently opens something else.
    private static func queryParameters(_ query: String?, allowed: Set<String>) -> [String: String]? {
        guard let query, !query.isEmpty else { return [:] }
        var result: [String: String] = [:]
        for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
            let pieces = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pieces.count == 2 else { return nil }
            let name = String(pieces[0]).lowercased()
            guard
                allowed.contains(name),
                result[name] == nil,
                let value = String(pieces[1]).removingPercentEncoding,
                !value.isEmpty
            else { return nil }
            result[name] = value
        }
        return result
    }
}

// MARK: - Manager console

/// A manager roster destination. Manager notices open the existing web
/// manager console, never a native screen, so this only ever produces
/// `https://<canonical web host>/admin/roster` with an allowlisted
/// `rosterTab` and a `rosterMonth=YYYY-MM`. Everything else in a stored link
/// (record ids such as `rosterFocus`, other parameters, fragments, foreign
/// hosts) is dropped. The web console signs the manager in and checks
/// permission server-side; this link never grants anything.
struct XertManagerRosterLink: Hashable {
    static let path = "/admin/roster"
    /// The web workspace tabs, as `StaffRosterWorkspace.jsx` names them.
    static let allowedTabs: [String] = ["roster", "availability", "requests", "coaches", "settings", "activity"]

    let tab: String?
    let month: String?

    init(tab: String? = nil, month: String? = nil) {
        self.tab = tab.flatMap { Self.allowedTabs.contains($0) ? $0 : nil }
        self.month = month.flatMap { XertCoachingLink.isValidMonth($0) ? $0 : nil }
    }

    private var queryItems: [URLQueryItem] {
        var items: [URLQueryItem] = []
        if let tab { items.append(URLQueryItem(name: "rosterTab", value: tab)) }
        if let month { items.append(URLQueryItem(name: "rosterMonth", value: month)) }
        return items
    }

    /// Relative web path, e.g. `/admin/roster?rosterTab=requests&rosterMonth=2026-11`.
    var webPath: String {
        // Both values are allowlisted, so they never need percent-encoding.
        var parts: [String] = []
        if let tab { parts.append("rosterTab=" + tab) }
        if let month { parts.append("rosterMonth=" + month) }
        return parts.isEmpty ? Self.path : Self.path + "?" + parts.joined(separator: "&")
    }

    /// The console on the canonical web host over https. Never another host.
    var webURL: URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = AppConfig.vercelHost
        components.path = Self.path
        let items = queryItems
        components.queryItems = items.isEmpty ? nil : items
        return components.url
    }

    /// Whether a relative path names the manager console (`/admin/roster…`).
    static func isManagerPath(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed == Self.path
            || trimmed.hasPrefix(Self.path + "?")
            || trimmed.hasPrefix(Self.path + "/")
            || trimmed.hasPrefix(Self.path + "#")
    }

    /// A relative web path from a push `open_path` or a stored in-app notice
    /// link. Absolute URLs, other paths and credentials are rejected; unknown
    /// or repeated parameters and invalid values are dropped.
    static func link(webPath value: String) -> XertManagerRosterLink? {
        guard
            let components = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
            components.scheme == nil,
            components.host == nil,
            components.port == nil,
            components.user == nil,
            components.password == nil
        else { return nil }
        let lowered = components.path.lowercased()
        guard lowered == Self.path || lowered == Self.path + "/" else { return nil }
        var tabs: [String] = []
        var months: [String] = []
        for item in components.queryItems ?? [] {
            if item.name == "rosterTab" { tabs.append(item.value ?? "") }
            if item.name == "rosterMonth" { months.append(item.value ?? "") }
        }
        return XertManagerRosterLink(
            tab: tabs.count == 1 ? tabs[0] : nil,
            month: months.count == 1 ? months[0] : nil
        )
    }
}

/// Who a roster notice is for. The notice decides, not the account: an admin
/// who is also a coach gets the console for manager notices and My Coaching
/// for their own coach notices.
enum StaffRosterAudience: String {
    case coach
    case manager

    /// Used when a payload has no (or an unknown) `audience`.
    static func inferred(fromPath value: String) -> StaffRosterAudience {
        XertManagerRosterLink.isManagerPath(value) ? .manager : .coach
    }
}

/// Where a roster push or notice opens.
enum StaffRosterDestination: Hashable {
    /// Native My Coaching (coach-only; the server decides access).
    case coaching(XertCoachingLink)
    /// The web manager console (the server decides access).
    case managerConsole(XertManagerRosterLink)

    var audience: StaffRosterAudience {
        switch self {
        case .coaching(_): return .coach
        case .managerConsole(_): return .manager
        }
    }

    /// `/open/coaching…` for coaches, `/admin/roster?…` for managers.
    var path: String {
        switch self {
        case .coaching(let link): return link.openPath
        case .managerConsole(let link): return link.webPath
        }
    }

    /// Strict parse of a push `open_path` for an audience (inferred from the
    /// path when nil). Nil when the path is not valid for that audience; a
    /// coach notice never opens the console and a manager notice never opens
    /// My Coaching.
    static func destination(path: String, audience: StaffRosterAudience?) -> StaffRosterDestination? {
        switch audience ?? StaffRosterAudience.inferred(fromPath: path) {
        case .coach:
            return XertCoachingLink.link(openPath: path).map { StaffRosterDestination.coaching($0) }
        case .manager:
            return XertManagerRosterLink.link(webPath: path).map { StaffRosterDestination.managerConsole($0) }
        }
    }

    /// Stored in-app notice links: coach `/coaching?…` or manager `/admin/roster?…`.
    static func destination(inAppNotice value: String) -> StaffRosterDestination? {
        if let link = XertCoachingLink.link(inAppNotice: value) { return .coaching(link) }
        if let link = XertManagerRosterLink.link(webPath: value) { return .managerConsole(link) }
        return nil
    }

    /// Where an unusable path falls back to: the audience's own home.
    static func fallback(for audience: StaffRosterAudience) -> StaffRosterDestination {
        switch audience {
        case .coach: return .coaching(XertCoachingLink())
        case .manager: return .managerConsole(XertManagerRosterLink())
        }
    }
}

// MARK: - Push

/// Staff roster APNs payloads:
/// `{ aps: { category: "xert.staff-roster", "thread-id": "xert-staff-roster", … },
///    staff_notification_id: "<uuid>", audience: "coach" | "manager",
///    open_path: "/open/coaching[/<tab>][?month=YYYY-MM]"            (coach)
///             | "/admin/roster?rosterTab=<tab>&rosterMonth=YYYY-MM" (manager) }`.
/// A missing `audience` is inferred from the path prefix.
/// Receiving a push never marks it read; a coach notice is marked read only
/// once the coach actually opens My Coaching from it.
enum StaffRosterPush {
    static let category = "xert.staff-roster"
    static let threadIdentifier = "xert-staff-roster"
    static let notificationIDKey = "staff_notification_id"
    static let openPathKey = "open_path"
    static let audienceKey = "audience"

    struct Target: Equatable {
        let destination: StaffRosterDestination
        let notificationID: UUID?

        init(destination: StaffRosterDestination, notificationID: UUID?) {
            self.destination = destination
            self.notificationID = notificationID
        }

        init(link: XertCoachingLink, notificationID: UUID?) {
            self.init(destination: .coaching(link), notificationID: notificationID)
        }

        /// The My Coaching section, for coach notices only.
        var link: XertCoachingLink? {
            if case .coaching(let link) = destination { return link }
            return nil
        }
    }

    static func isStaffRosterPayload(_ userInfo: [AnyHashable: Any]) -> Bool {
        if userInfo[notificationIDKey] != nil { return true }
        if let aps = userInfo["aps"] as? [AnyHashable: Any],
           let category = aps["category"] as? String {
            return category == Self.category
        }
        return false
    }

    /// The payload's declared audience; nil when missing or unknown.
    static func audience(from userInfo: [AnyHashable: Any]) -> StaffRosterAudience? {
        (userInfo[audienceKey] as? String).flatMap { StaffRosterAudience(rawValue: $0.lowercased()) }
    }

    /// Where a tapped roster push opens. A missing or invalid `open_path`
    /// falls back to the audience's home (Upcoming for coaches, the console
    /// for managers) rather than to an unrelated screen or another host.
    static func target(from userInfo: [AnyHashable: Any]) -> Target? {
        guard isStaffRosterPayload(userInfo) else { return nil }
        let rawPath = userInfo[openPathKey] as? String
        let audience: StaffRosterAudience = Self.audience(from: userInfo)
            ?? rawPath.map { StaffRosterAudience.inferred(fromPath: $0) }
            ?? .coach
        let destination = rawPath.flatMap { StaffRosterDestination.destination(path: $0, audience: audience) }
            ?? StaffRosterDestination.fallback(for: audience)
        let notificationID = (userInfo[notificationIDKey] as? String).flatMap(UUID.init(uuidString:))
        return Target(destination: destination, notificationID: notificationID)
    }
}

/// Survives a cold launch from a notification tap, like the reminder and
/// announcement return routes. Consumed exactly once.
enum StaffRosterPushNavigation {
    static let pendingPathKey = "xert.navigation.pendingCoachingPath"
    static let pendingAudienceKey = "xert.navigation.pendingCoachingAudience"
    static let pendingNotificationIDKey = "xert.navigation.pendingCoachingNotificationID"

    static func markPending(_ target: StaffRosterPush.Target, defaults: UserDefaults = .standard) {
        defaults.set(target.destination.path, forKey: pendingPathKey)
        defaults.set(target.destination.audience.rawValue, forKey: pendingAudienceKey)
        if let notificationID = target.notificationID {
            defaults.set(notificationID.uuidString, forKey: pendingNotificationIDKey)
        } else {
            defaults.removeObject(forKey: pendingNotificationIDKey)
        }
    }

    static func consumePending(defaults: UserDefaults = .standard) -> StaffRosterPush.Target? {
        let rawPath = defaults.string(forKey: pendingPathKey)
        let rawAudience = defaults.string(forKey: pendingAudienceKey)
        let rawNotificationID = defaults.string(forKey: pendingNotificationIDKey)
        clearPending(defaults: defaults)
        guard
            let rawPath,
            let destination = StaffRosterDestination.destination(
                path: rawPath,
                audience: rawAudience.flatMap { StaffRosterAudience(rawValue: $0) }
            )
        else { return nil }
        return StaffRosterPush.Target(
            destination: destination,
            notificationID: rawNotificationID.flatMap(UUID.init(uuidString:))
        )
    }

    static func clearPending(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: pendingPathKey)
        defaults.removeObject(forKey: pendingAudienceKey)
        defaults.removeObject(forKey: pendingNotificationIDKey)
    }
}

extension Notification.Name {
    static let xertOpenStaffRoster = Notification.Name("xert.navigation.openStaffRoster")
    static let xertRefreshStaffRoster = Notification.Name("xert.staffRoster.refresh")
}
