import Foundation

// Decodable mirrors of the `staff_roster_*` coach entry points in
// supabase/migrations/20261001010000_staff_roster.sql. Keys match the
// jsonb_build_object keys exactly. The database is authoritative for every
// rule; these types only carry what it returned.

// MARK: - JSON

enum StaffRosterJSON {
    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let standardFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Postgres writes `2026-11-01T19:15:00+00:00` or, with microseconds,
    /// `2026-10-01T03:12:45.123456+00:00`.
    static func instant(from value: String) -> Date? {
        if let date = fractionalFormatter.date(from: value) { return date }
        if let date = standardFormatter.date(from: value) { return date }
        guard let dot = value.firstIndex(of: ".") else { return nil }
        var end = value.index(after: dot)
        while end < value.endIndex, value[end].isASCII, value[end].isNumber {
            end = value.index(after: end)
        }
        let trimmed = String(value[..<dot]) + String(value[end...])
        return standardFormatter.date(from: trimmed)
    }

    static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            if let date = instant(from: value) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Invalid date: \(value)")
            )
        }
        return decoder
    }

    static var encoder: JSONEncoder {
        JSONEncoder()
    }
}

// MARK: - Errors

/// A roster error as the coach should read it. The database raises short
/// codes (`STALE_VERSION`, `NOT_STAFF`, …); these are the web client's words.
struct StaffRosterError: LocalizedError, Equatable {
    let code: String?
    let message: String

    var errorDescription: String? { message }

    /// The account is signed in but has no coach roster access right now.
    var isAccessDenied: Bool {
        guard let code else { return false }
        return Self.accessCodes.contains(code)
    }

    var isStaleVersion: Bool { code == "STALE_VERSION" }

    static let accessCodes: Set<String> = ["ROSTER_DISABLED", "NOT_STAFF", "STAFF_INACTIVE", "SIGN_IN_REQUIRED"]

    static let messages: [String: String] = [
        "SIGN_IN_REQUIRED": "Please sign in again.",
        "ROSTER_DISABLED": "The coach roster is not switched on yet.",
        "NOT_STAFF": "This account is not linked to a coach on the roster. Ask the manager to link it.",
        "STAFF_INACTIVE": "This coach is inactive.",
        "STALE_VERSION": "Someone else changed this since you opened it. Refresh to see the latest version, then try again.",
        "REQUEST_ID_REUSED": "That request was already used for something else. Try again.",
        "REQUEST_ID_REQUIRED": "Something went wrong preparing the request. Try again.",
        "MONTH_INVALID": "Choose a valid month.",
        "RANGE_INVALID": "Choose a valid date range.",
        "PERIOD_NOT_OPEN": "Availability for this month is not open yet.",
        "PERIOD_NOT_FOUND": "Availability has not been opened for this month.",
        "NO_BACKDATING": "Dates cannot be set in the past.",
        "DEADLINE_PASSED": "The deadline has passed. Ask the manager to reopen your availability.",
        "AVAILABILITY_INVALID": "Some answers need fixing before you can submit.",
        "NO_DRAFT": "There is no draft to change.",
        "ASSIGNMENT_NOT_FOUND": "That assignment no longer exists.",
        "ASSIGNMENT_NOT_CURRENT": "That roster has been replaced by a newer version.",
        "SESSION_STARTED": "This class has already started.",
        "SESSION_NOT_LIVE": "This class is no longer running.",
        "STATUS_INVALID": "Choose a valid status.",
        "KIND_INVALID": "Choose a valid type.",
        "NOTHING_TO_WITHDRAW": "There is nothing to withdraw.",
        "COVER_NOT_FOUND": "That cover request no longer exists.",
        "COVER_NOT_OPEN": "That cover request is closed.",
        "COVER_ALREADY_REQUESTED": "Cover is already requested for this class.",
        "COVER_ALREADY_DECIDED": "That cover request has already been decided.",
        "OFFER_NOT_AVAILABLE": "That offer was withdrawn.",
        "OWN_REQUEST": "You cannot cover your own class.",
        "CANNOT_COVER": "You cannot take this class.",
        "SUPERSEDED": "The roster changed after this request. It no longer applies.",
    ]

    static let fallbackMessage = "The roster could not be updated. Try again."

    static func from(_ error: Error) -> StaffRosterError {
        if let roster = error as? StaffRosterError { return roster }
        let raw = (error as? APIError)?.message ?? error.localizedDescription
        if let code = knownCode(in: raw) {
            return StaffRosterError(code: code, message: messages[code] ?? fallbackMessage)
        }
        if error is APIError {
            // Network and transport failures already carry a readable message.
            return StaffRosterError(code: nil, message: raw)
        }
        return StaffRosterError(code: nil, message: fallbackMessage)
    }

    /// The first known roster code in a server message. Words like "XERT"
    /// in transport messages are not codes.
    static func knownCode(in message: String) -> String? {
        var current = ""
        var tokens: [String] = []
        for character in message {
            if character.isASCII, character.isUppercase || character.isNumber || character == "_" {
                current.append(character)
            } else {
                if !current.isEmpty { tokens.append(current) }
                current = ""
            }
        }
        if !current.isEmpty { tokens.append(current) }
        return tokens.first { messages[$0] != nil }
    }
}

// MARK: - Shared shapes

enum StaffAvailabilityStatus: String, CaseIterable, Identifiable {
    case preferred = "PREFERRED"
    case available = "AVAILABLE"
    case ifNeeded = "IF_NEEDED"
    case unavailable = "UNAVAILABLE"

    var id: String { rawValue }

    var shortLabel: String {
        switch self {
        case .preferred: return "Prefer"
        case .available: return "Yes"
        case .ifNeeded: return "If needed"
        case .unavailable: return "No"
        }
    }

    /// Words for every status the server or the review can produce.
    static func label(for raw: String) -> String {
        switch raw {
        case "PREFERRED": return "Preferred"
        case "AVAILABLE": return "Available"
        case "IF_NEEDED": return "If needed"
        case "UNAVAILABLE": return "Unavailable"
        case "PARTIAL": return "Only part of the time"
        case "ABSENT": return "Away"
        default: return "Not answered"
        }
    }

    var rank: Int {
        switch self {
        case .ifNeeded: return 1
        case .available: return 2
        case .preferred: return 3
        case .unavailable: return 0
        }
    }
}

/// One usual-week window: weekday 0 = Sunday, minutes from gym midnight.
struct StaffWeeklyWindow: Codable, Hashable {
    var weekday: Int
    var start: Int
    var end: Int
    var status: String
}

/// One date exception inside the roster month.
struct StaffDateWindow: Codable, Hashable {
    var date: String
    var start: Int
    var end: Int
    var status: String
}

/// The availability payload exactly as `staff_roster_save_availability_draft`
/// and `staff_roster_submit_availability` read it (`noAvailability` is camel case).
struct StaffAvailabilityPayload: Codable, Hashable {
    var weekly: [StaffWeeklyWindow]
    var exceptions: [StaffDateWindow]
    var noAvailability: Bool

    init(weekly: [StaffWeeklyWindow] = [], exceptions: [StaffDateWindow] = [], noAvailability: Bool = false) {
        self.weekly = weekly
        self.exceptions = exceptions
        self.noAvailability = noAvailability
    }

    private enum CodingKeys: String, CodingKey {
        case weekly, exceptions, noAvailability
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        weekly = try container.decodeIfPresent([StaffWeeklyWindow].self, forKey: .weekly) ?? []
        exceptions = try container.decodeIfPresent([StaffDateWindow].self, forKey: .exceptions) ?? []
        noAvailability = try container.decodeIfPresent(Bool.self, forKey: .noAvailability) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(weekly, forKey: .weekly)
        try container.encode(exceptions, forKey: .exceptions)
        try container.encode(noAvailability, forKey: .noAvailability)
    }
}

struct StaffRosterAcknowledgement: Decodable, Hashable {
    let month: String
    let revision_id: UUID
    let number: Int
}

// MARK: - staff_roster_me

struct StaffRosterMe: Decodable, Hashable {
    struct Staff: Decodable, Hashable {
        let id: UUID
        let display_name: String
        let roles: [String]?
        let status: String
    }

    struct Preset: Decodable, Hashable {
        let minute: Int
    }

    struct Settings: Decodable, Hashable {
        let class_time_presets: [Preset]?
    }

    struct UsualWeek: Decodable, Hashable {
        let pattern: [StaffWeeklyWindow]
        let version: Int
        let updated_at: Date?
    }

    struct LastSubmission: Decodable, Hashable {
        let month: String
        let payload: StaffAvailabilityPayload
        let no_availability: Bool
    }

    struct Draft: Decodable, Hashable {
        let payload: StaffAvailabilityPayload
        let version: Int
        let updated_at: Date?
    }

    struct Submission: Decodable, Hashable {
        let version: Int
        let payload: StaffAvailabilityPayload
        let submitted_at: Date?
        let late: Bool
        let no_availability: Bool
    }

    struct Period: Decodable, Hashable, Identifiable {
        let month: String
        let opens_on: String
        let due_on: String
        let publish_target_on: String?
        let shortened: Bool?
        let is_open: Bool
        let deadline_passed: Bool
        let reopened: Bool
        let change_request_open: Bool
        let draft: Draft?
        let submission: Submission?

        var id: String { month }
        /// `2026-12` for the period month `2026-12-01`.
        var monthKey: String { String(month.prefix(7)) }
    }

    let staff: Staff
    let today: String
    let settings: Settings?
    let usual_week: UsualWeek?
    let last_submission: LastSubmission?
    let periods: [Period]
    let unread_notifications: Int
    let pending_acknowledgements: [StaffRosterAcknowledgement]
}

// MARK: - staff_roster_my_roster

struct StaffRosterAssignment: Decodable, Hashable, Identifiable {
    struct Colleague: Decodable, Hashable {
        let display_name: String
        let role: String
    }

    struct Cover: Decodable, Hashable {
        let id: UUID
        let status: String
    }

    let assignment_id: UUID
    let revision_id: UUID
    let revision_number: Int
    let month: String
    let session_id: UUID?
    let slot_key: String
    let role: String
    let title: String?
    let class_type: String?
    let start: Date
    let end: Date?
    let duty_start: Date?
    let duty_end: Date?
    let status: String
    let published_start: Date?
    let published_end: Date?
    let changed_since_publish: Bool
    let colleagues: [Colleague]
    let acknowledged: Bool
    let cover: Cover?
    let availability: String?

    var id: UUID { assignment_id }

    var isCancelled: Bool { status == "cancelled" || status == "removed" }

    var displayTitle: String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "XERT class" : trimmed
    }

    var roleLabel: String { StaffRosterAssignment.roleLabel(role) }

    static func roleLabel(_ role: String) -> String {
        switch role {
        case "lead": return "Lead"
        case "assistant": return "Assistant"
        case "shadow": return "Shadow"
        default: return role.capitalized
        }
    }
}

struct StaffRosterMyRoster: Decodable, Hashable {
    let assignments: [StaffRosterAssignment]
    let pending_acknowledgements: [StaffRosterAcknowledgement]
}

// MARK: - staff_roster_cover_board

struct StaffRosterCoverBoardItem: Decodable, Hashable, Identifiable {
    let id: UUID
    let status: String
    let version: Int
    let session_id: UUID?
    let slot_key: String
    let title: String?
    let start: Date
    let end: Date?
    let role: String
    let requested_by: String
    let my_offer: String?
    let problems: [String]
}

// MARK: - staff_roster_my_requests

struct StaffRosterMyRequests: Decodable, Hashable {
    struct Absence: Decodable, Hashable, Identifiable {
        let id: UUID
        let starts_at: Date
        let ends_at: Date
        let kind: String
        let status: String
        let reason: String?
        let created_at: Date?
    }

    struct CoverRequest: Decodable, Hashable, Identifiable {
        let id: UUID
        let status: String
        let title: String?
        let start: Date?
        let offers: Int
    }

    struct Offer: Decodable, Hashable, Identifiable {
        let request_id: UUID
        let status: String
        let title: String?
        let start: Date?

        var id: UUID { request_id }
    }

    struct ChangeRequest: Decodable, Hashable, Identifiable {
        let id: UUID
        let month: String
        let status: String
        let message: String
        let created_at: Date?
    }

    let absences: [Absence]
    let cover_requests: [CoverRequest]
    let offers: [Offer]
    let change_requests: [ChangeRequest]

    var isEmpty: Bool {
        absences.isEmpty && cover_requests.isEmpty && offers.isEmpty && change_requests.isEmpty
    }
}

// MARK: - staff_roster_my_notifications

struct StaffRosterNotification: Decodable, Hashable, Identifiable {
    let id: UUID
    let kind: String
    let title: String
    let body: String
    let link: String?
    let created_at: Date
    let read_at: Date?

    var isUnread: Bool { read_at == nil }

    /// The My Coaching section this notice opens, when its link is one.
    var coachingLink: XertCoachingLink? {
        link.flatMap { XertCoachingLink.link(inAppNotice: $0) }
    }

    /// Manager notices (`/admin/roster?…`, shown to admins) open the web
    /// manager console, never My Coaching. Only the allowlisted tab and
    /// month survive; record ids such as `rosterFocus` are dropped.
    var managerLink: XertManagerRosterLink? {
        guard coachingLink == nil else { return nil }
        return link.flatMap { XertManagerRosterLink.link(webPath: $0) }
    }
}

// MARK: - staff_roster_month_classes

struct StaffRosterMonthClass: Decodable, Hashable, Identifiable {
    let id: UUID
    let title: String?
    let class_type: String?
    let start: Date
    let end: Date?
    let duty_start: Date?
    let duty_end: Date?

    var displayTitle: String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "XERT class" : trimmed
    }

    /// The duty the coach would be on; falls back to the class itself.
    var dutyInterval: (start: Date, end: Date) {
        let start = duty_start ?? self.start
        let end = duty_end ?? self.end ?? self.start.addingTimeInterval(3_600)
        return (start, max(end, start))
    }
}

// MARK: - Mutation results

struct StaffRosterVersionResult: Decodable, Hashable {
    let version: Int
    let updated_at: Date?
}

struct StaffRosterSubmitResult: Decodable, Hashable {
    let submission_id: UUID
    let version: Int
    let late: Bool
    let no_availability: Bool
}

struct StaffRosterAbsenceResult: Decodable, Hashable {
    let id: UUID
    let status: String
    let affected_classes: Int?
}

struct StaffRosterIDResult: Decodable, Hashable {
    let id: UUID
}

struct StaffRosterStatusResult: Decodable, Hashable {
    let id: UUID?
    let ok: Bool?
    let status: String?
}

struct StaffRosterAcknowledgeResult: Decodable, Hashable {
    let ok: Bool
    let acknowledged: Bool
}

// MARK: - Visibility

/// Whether the signed-in account may see My Coaching, as the server last said.
enum StaffRosterAccess: Equatable {
    case unknown
    case checking
    case coach(StaffRosterMe)
    case unavailable(StaffRosterError)
    case failed(StaffRosterError)

    var me: StaffRosterMe? {
        if case .coach(let me) = self { return me }
        return nil
    }
}

enum StaffRosterVisibility {
    /// My Coaching appears only when `staff_roster_me` answered for an active
    /// coach, which the server only does while the roster is switched on.
    /// Feature off, not staff, inactive, not yet checked or failed: hidden.
    static func showsEntry(for access: StaffRosterAccess) -> Bool {
        guard let me = access.me else { return false }
        return me.staff.status == "active"
    }
}
