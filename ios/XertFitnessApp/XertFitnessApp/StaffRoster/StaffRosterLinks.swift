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

// MARK: - Push

/// Staff roster APNs payloads:
/// `{ aps: { category: "xert.staff-roster", "thread-id": "xert-staff-roster", … },
///    staff_notification_id: "<uuid>", open_path: "/open/coaching/<tab>[?month=YYYY-MM]" }`.
/// Receiving a push never marks it read; the notice is marked read only once
/// the coach actually opens My Coaching from it.
enum StaffRosterPush {
    static let category = "xert.staff-roster"
    static let threadIdentifier = "xert-staff-roster"
    static let notificationIDKey = "staff_notification_id"
    static let openPathKey = "open_path"

    struct Target: Equatable {
        let link: XertCoachingLink
        let notificationID: UUID?
    }

    static func isStaffRosterPayload(_ userInfo: [AnyHashable: Any]) -> Bool {
        if userInfo[notificationIDKey] != nil { return true }
        if let aps = userInfo["aps"] as? [AnyHashable: Any],
           let category = aps["category"] as? String {
            return category == Self.category
        }
        return false
    }

    /// Where a tapped roster push opens. A missing or invalid `open_path` falls
    /// back to the Upcoming section rather than to an unrelated screen.
    static func target(from userInfo: [AnyHashable: Any]) -> Target? {
        guard isStaffRosterPayload(userInfo) else { return nil }
        let link = (userInfo[openPathKey] as? String).flatMap { XertCoachingLink.link(openPath: $0) }
            ?? XertCoachingLink()
        let notificationID = (userInfo[notificationIDKey] as? String).flatMap(UUID.init(uuidString:))
        return Target(link: link, notificationID: notificationID)
    }
}

/// Survives a cold launch from a notification tap, like the reminder and
/// announcement return routes. Consumed exactly once.
enum StaffRosterPushNavigation {
    static let pendingPathKey = "xert.navigation.pendingCoachingPath"
    static let pendingNotificationIDKey = "xert.navigation.pendingCoachingNotificationID"

    static func markPending(_ target: StaffRosterPush.Target, defaults: UserDefaults = .standard) {
        defaults.set(target.link.openPath, forKey: pendingPathKey)
        if let notificationID = target.notificationID {
            defaults.set(notificationID.uuidString, forKey: pendingNotificationIDKey)
        } else {
            defaults.removeObject(forKey: pendingNotificationIDKey)
        }
    }

    static func consumePending(defaults: UserDefaults = .standard) -> StaffRosterPush.Target? {
        let rawPath = defaults.string(forKey: pendingPathKey)
        let rawNotificationID = defaults.string(forKey: pendingNotificationIDKey)
        clearPending(defaults: defaults)
        guard let rawPath, let link = XertCoachingLink.link(openPath: rawPath) else { return nil }
        return StaffRosterPush.Target(
            link: link,
            notificationID: rawNotificationID.flatMap(UUID.init(uuidString:))
        )
    }

    static func clearPending(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: pendingPathKey)
        defaults.removeObject(forKey: pendingNotificationIDKey)
    }
}

extension Notification.Name {
    static let xertOpenStaffRoster = Notification.Name("xert.navigation.openStaffRoster")
    static let xertRefreshStaffRoster = Notification.Name("xert.staffRoster.refresh")
}
