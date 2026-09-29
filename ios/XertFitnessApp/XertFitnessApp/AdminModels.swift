import Foundation

struct AdminMemberSummary: Identifiable, Codable, Hashable {
    let id: UUID
    let full_name: String?
    let email: String?
    let phone: String?
    let role: String
    let joined_at: Date
    let credits_remaining: Int
    let bookings_count: Int
    let orders_count: Int
    let total_spent_cents: Int
    let total_count: Int

    var displayName: String { full_name?.nilIfBlank ?? email?.nilIfBlank ?? "XERT member" }
    var totalSpent: String { (Double(total_spent_cents) / 100).formatted(.currency(code: "AUD")) }
}

struct AdminMemberReport {
    let rows: [AdminMemberSummary]

    var csv: String {
        let header = [
            "Name", "Email", "Phone", "Role", "Credits", "Bookings",
            "Spent (AUD)", "Joined"
        ]
        let formatter = ISO8601DateFormatter()
        let body = rows.map { member in
            [
                member.full_name ?? "",
                member.email ?? "",
                member.phone ?? "",
                member.role,
                member.credits_remaining.formatted(),
                member.bookings_count.formatted(),
                String(format: "%.2f", Double(member.total_spent_cents) / 100),
                formatter.string(from: member.joined_at)
            ]
            .map(Self.escape)
            .joined(separator: ",")
        }
        return ([header.map(Self.escape).joined(separator: ",")] + body).joined(separator: "\n") + "\n"
    }

    private static func escape(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

struct AdminAccessSnapshot: Equatable {
    static let recommendedAdministratorCount = 2

    let administrators: [AdminMemberSummary]
    let totalCount: Int
    let currentUserID: UUID?

    var administratorCount: Int { max(totalCount, administrators.count) }
    var hasOperationalBackup: Bool {
        administratorCount >= Self.recommendedAdministratorCount
    }
    var currentUserIsListed: Bool {
        guard let currentUserID else { return false }
        return administrators.contains { $0.id == currentUserID }
    }
    var currentUserListingIsComplete: Bool {
        currentUserIsListed || administratorCount <= administrators.count
    }
    var statusTitle: String {
        switch administratorCount {
        case 0: return "No administrator evidence"
        case 1: return "Single administrator"
        default: return "Access coverage ready"
        }
    }
    var statusDetail: String {
        switch administratorCount {
        case 0:
            return "Refresh before relying on access coverage."
        case 1:
            return "Add one trusted backup administrator before launch."
        default:
            return "\(administratorCount) administrators can recover owner operations."
        }
    }
}

struct AdminMemberOnboardingSummary: Identifiable, Codable, Hashable {
    var id: UUID { user_id }
    let user_id: UUID
    let profile_complete: Bool
    let emergency_contact_complete: Bool
    let documents_complete: Bool
    let onboarding_complete: Bool
    let accepted_required_count: Int
    let required_document_count: Int

    var completedSteps: Int {
        [profile_complete, emergency_contact_complete, documents_complete].filter { $0 }.count
    }

    var statusLabel: String {
        onboarding_complete ? "Ready" : "\(completedSteps) of 3 complete"
    }
}

struct AdminMemberActivationOverview: Codable, Hashable {
    let as_of: Date
    let cohort_days: Int
    let accounts_created: Int
    let readiness_complete: Int
    let training_access: Int
    let first_booking: Int
    let first_attended: Int
    let returned: Int

    var stages: [(label: String, count: Int)] {
        [
            ("Accounts", accounts_created),
            ("Ready now", readiness_complete),
            ("Access", training_access),
            ("Booked", first_booking),
            ("Attended", first_attended),
            ("Returned", returned),
        ]
    }
}

struct AdminMemberActivationItem: Identifiable, Codable, Hashable {
    let id: UUID
    let full_name: String?
    let email: String?
    let phone: String?
    let role: String
    let joined_at: Date
    let credits_remaining: Int
    let bookings_count: Int
    let total_spent_cents: Int
    let reason: String
    let has_training_access: Bool
    let profile_complete: Bool
    let emergency_contact_complete: Bool
    let documents_complete: Bool
    let readiness_complete: Bool

    var displayName: String { full_name?.nilIfBlank ?? email?.nilIfBlank ?? "XERT member" }
    var reasonLabel: String {
        switch reason {
        case "setup_incomplete": return "Finish member setup"
        case "readiness_incomplete": return "Review current readiness"
        case "no_training_access": return "Choose a pack or add credits"
        case "no_first_booking": return "Book a first class"
        case "no_first_attendance": return "Complete a first class"
        default: return "Activation follow-up"
        }
    }
}

struct AdminMemberEmergencyContact: Codable, Hashable {
    let name: String
    let phone: String
    let relationship: String
    let contact_awareness_confirmed_at: Date
    let updated_at: Date
}

struct AdminMemberEmergencyContactReveal: Codable, Hashable {
    let audit_event_id: UUID
    let revealed_at: Date
    let user_id: UUID
    let emergency_contact: AdminMemberEmergencyContact
}

struct AdminMemberNote: Identifiable, Codable, Hashable {
    let id: UUID
    let user_id: UUID
    let author_id: UUID?
    let author_name: String?
    let category: String
    let body: String
    let created_at: Date
    let archived_at: Date?
    let archived_by: UUID?
}

struct AdminMemberNotice: Identifiable, Codable, Hashable {
    let id: UUID
    let title: String
    let body: String
    let tone: String
    let cta_label: String?
    let cta_url: String?
    let source_kind: String
    let published_at: Date
    let expires_at: Date?
    let read_at: Date?
    let dismissed_at: Date?
    let push_attempted: Int
    let push_delivered: Int
    let push_failed: Int

    var sourceLabel: String {
        switch source_kind {
        case "booking_decision": return "Booking decision"
        case "waitlist_promotion": return "Waitlist promotion"
        case "staff_booking": return "Staff-assisted booking"
        default: return "Direct notice"
        }
    }

    var receiptLabel: String {
        if dismissed_at != nil { return "Dismissed" }
        if read_at != nil { return "Read in app" }
        return "Unread"
    }

    var deliveryLabel: String {
        if push_delivered > 0 { return "Push delivered" }
        if push_attempted > 0 && push_failed > 0 { return "Push failed" }
        return "In app only"
    }
}

enum AdminMemberNoticeAction: String, CaseIterable, Identifiable, Codable, Hashable {
    case none
    case booking
    case account
    case events

    var id: String { rawValue }

    var title: String {
        switch self {
        case .none: return "No action"
        case .booking: return "Book a class"
        case .account: return "View account"
        case .events: return "View events"
        }
    }

    var cta: (label: String?, url: String?) {
        switch self {
        case .none: return (nil, nil)
        case .booking: return ("Book a class", "/booking")
        case .account: return ("View account", "/account")
        case .events: return ("View events", "/events")
        }
    }
}

struct AdminMemberNoticeDraft: Codable, Hashable {
    var title = ""
    var body = ""
    var tone = "info"
    var action = AdminMemberNoticeAction.none
    var expiryDays = 30

    func validationMessage() -> String? {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (3...120).contains(normalizedTitle.count) else {
            return "Title must be between 3 and 120 characters."
        }
        guard (3...2_000).contains(normalizedBody.count) else {
            return "Message must be between 3 and 2,000 characters."
        }
        guard ["info", "action", "urgent"].contains(tone) else {
            return "Choose a valid priority."
        }
        guard [7, 30, 90].contains(expiryDays) else {
            return "Choose a valid expiry."
        }
        return nil
    }
}

struct AdminMemberNoticeSendOutcome: Hashable {
    let announcementID: UUID
    let push: AdminAnnouncementPushSummary?
    let warning: String?
}

struct AdminMemberCreditBatch: Identifiable, Codable, Hashable {
    let id: UUID
    let order_id: UUID?
    let total: Int
    let remaining: Int
    let expires_at: Date?
    let created_at: Date

    func stateLabel(now: Date = Date()) -> String {
        if let expires_at, expires_at <= now { return "Expired" }
        if remaining == 0 { return "Used" }
        return "Available"
    }
}

struct AdminMemberCreditGrant: Identifiable, Codable, Hashable {
    let id: UUID
    let sessions: Int
    let validity_days: Int?
    let note: String
    let credit_batch_id: UUID?
    let created_at: Date
}

struct AdminMemberBookingClass: Codable, Hashable {
    let title: String?
    let class_type: String?
    let start_time: Date?

    var displayName: String {
        let title = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let type = class_type?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? (type.isEmpty ? "Class" : type) : title
    }
}

struct AdminMemberBookingHistory: Identifiable, Codable, Hashable {
    let id: UUID
    let status: String
    let created_at: Date
    let cancelled_at: Date?
    let class_sessions: AdminMemberBookingClass?

    var statusLabel: String {
        status.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

enum AdminMemberHistoryTab: String, CaseIterable, Identifiable {
    case credits = "Credits"
    case bookings = "Bookings"
    case purchases = "Purchases"

    var id: String { rawValue }
}

enum AdminOrderRange: String, CaseIterable, Identifiable {
    case thirtyDays = "30 days"
    case ninetyDays = "90 days"
    case allTime = "All time"

    var id: String { rawValue }

    fileprivate var dayCount: Int? {
        switch self {
        case .thirtyDays: return 30
        case .ninetyDays: return 90
        case .allTime: return nil
        }
    }
}

struct AdminOrderCurrencyTotal: Identifiable, Equatable {
    let currency: String
    let cents: Int

    var id: String { currency }

    var displayAmount: String {
        (Double(cents) / 100).formatted(.currency(code: currency))
    }
}

struct AdminFinanceDay: Identifiable, Equatable {
    let date: Date
    let cents: Int

    var id: Date { date }
}

struct AdminFinanceProductPerformance: Identifiable, Equatable {
    let name: String
    let sales: Int
    let cents: Int

    var id: String { name }
}

struct AdminFinanceReport {
    let currency: String
    let currentPeriodCents: Int
    let previousPeriodCents: Int
    let monthRevenueCents: Int
    let allTimeRevenueCents: Int
    let currentPaidCount: Int
    let previousPaidCount: Int
    let averageSaleCents: Int
    let pendingCount: Int
    let refundedCount: Int
    let recoverableCount: Int
    let dailyRevenue: [AdminFinanceDay]
    let productLeaders: [AdminFinanceProductPerformance]

    init(
        orders: [OrderItem],
        currency: String,
        now: Date = Date(),
        calendar: Calendar = EventItem.calendar
    ) {
        let normalizedCurrency = Self.currencyCode(currency)
        let today = calendar.startOfDay(for: now)
        let currentStart = calendar.date(byAdding: .day, value: -29, to: today) ?? today
        let currentEnd = calendar.date(byAdding: .day, value: 1, to: today) ?? now
        let previousStart = calendar.date(byAdding: .day, value: -30, to: currentStart) ?? currentStart
        let monthStart = calendar.date(
            from: calendar.dateComponents([.year, .month], from: now)
        ) ?? today
        let matching = orders.filter { Self.currencyCode($0.currency) == normalizedCurrency }
        let paid = matching.filter { $0.status == "paid" }
        let currentPaid = paid.filter {
            let date = $0.paid_at ?? $0.created_at
            return date >= currentStart && date < currentEnd
        }
        let previousPaid = paid.filter {
            let date = $0.paid_at ?? $0.created_at
            return date >= previousStart && date < currentStart
        }
        let sum: ([OrderItem]) -> Int = {
            $0.reduce(0) { $0 + ($1.amount_cents ?? 0) }
        }
        let currentRevenue = sum(currentPaid)
        let previousRevenue = sum(previousPaid)

        self.currency = normalizedCurrency
        currentPeriodCents = currentRevenue
        previousPeriodCents = previousRevenue
        monthRevenueCents = sum(paid.filter {
            let date = $0.paid_at ?? $0.created_at
            return date >= monthStart && date < currentEnd
        })
        allTimeRevenueCents = sum(paid)
        currentPaidCount = currentPaid.count
        previousPaidCount = previousPaid.count
        averageSaleCents = currentPaid.isEmpty ? 0 : currentRevenue / currentPaid.count
        pendingCount = matching.filter { $0.status == "pending" }.count
        refundedCount = matching.filter { $0.status == "refunded" }.count
        recoverableCount = matching.filter(\.isRecoverable).count

        let revenueByDay = Dictionary(grouping: currentPaid) {
            calendar.startOfDay(for: $0.paid_at ?? $0.created_at)
        }
        dailyRevenue = (0..<30).compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: offset, to: currentStart) else {
                return nil
            }
            return AdminFinanceDay(date: date, cents: sum(revenueByDay[date] ?? []))
        }

        productLeaders = Dictionary(grouping: currentPaid) {
            $0.products?.name.nilIfBlank ?? "Session pack"
        }
        .map { name, productOrders in
            AdminFinanceProductPerformance(
                name: name,
                sales: productOrders.count,
                cents: sum(productOrders)
            )
        }
        .sorted {
            $0.cents != $1.cents ? $0.cents > $1.cents : $0.name < $1.name
        }
    }

    var periodChangePercent: Double? {
        guard previousPeriodCents > 0 else { return nil }
        return (Double(currentPeriodCents - previousPeriodCents) / Double(previousPeriodCents)) * 100
    }

    private static func currencyCode(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        return normalized.isEmpty ? "AUD" : normalized
    }
}

struct AdminOrderReport {
    let rows: [OrderItem]
    let paidCount: Int
    let paidRevenue: [AdminOrderCurrencyTotal]

    init(
        orders: [OrderItem],
        query: String = "",
        status: String = "all",
        currency: String = "all",
        range: AdminOrderRange = .thirtyDays,
        now: Date = Date()
    ) {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedCurrency = currency.lowercased()
        let cutoff = range.dayCount.flatMap {
            EventItem.calendar.date(
                byAdding: .day,
                value: -($0 - 1),
                to: EventItem.calendar.startOfDay(for: now)
            )
        }
        rows = orders.filter { order in
            let orderCurrency = Self.currencyCode(order)
            let haystack = [
                order.id.uuidString,
                order.email ?? "",
                order.products?.name ?? "",
                order.stripe_checkout_session_id ?? "",
                order.stripe_payment_intent_id ?? ""
            ].joined(separator: " ").lowercased()
            return (status == "all" || order.status == status)
                && (normalizedCurrency == "all" || orderCurrency.lowercased() == normalizedCurrency)
                && (cutoff.map { order.created_at >= $0 } ?? true)
                && (needle.isEmpty || haystack.contains(needle))
        }
        .sorted {
            $0.created_at != $1.created_at
                ? $0.created_at > $1.created_at
                : $0.id.uuidString > $1.id.uuidString
        }

        let paid = rows.filter { $0.status == "paid" }
        paidCount = paid.count
        paidRevenue = Dictionary(grouping: paid) { Self.currencyCode($0) }
            .map { code, orders in
                AdminOrderCurrencyTotal(
                    currency: code,
                    cents: orders.reduce(0) { $0 + ($1.amount_cents ?? 0) }
                )
            }
            .sorted { $0.currency < $1.currency }
    }

    var csv: String {
        let header = [
            "Created", "Paid", "Product", "Email", "Amount", "Currency",
            "Purchased session credits", "Purchased validity days", "Status",
            "Stripe Checkout Session", "Stripe Payment Intent", "Admin reconciled",
            "Reconciled by admin ID", "Refunded", "Refund amount",
            "Unused credits revoked", "Credits used before refund", "Future bookings cancelled"
        ].joined(separator: ",")
        let formatter = ISO8601DateFormatter()
        // Every element is annotated and the money/String.init conversions are
        // hoisted into locals. As one 18-element literal of mixed optional
        // chaining, `??`, `map(String.init)` and `String(format:)` expressions,
        // the solver had to infer the element type across all of them at once
        // and gave up: "the compiler is unable to type-check this expression in
        // reasonable time". Keep the pieces separate when adding a column.
        let body: [String] = rows.map { order -> String in
            let refund = order.refund
            let amount = Self.moneyField(order.amount_cents)
            let refundedAmount = order.refunded_amount_cents.map(Self.money) ?? ""
            let creditTotal = order.credit_total.map { String($0) } ?? ""
            let creditValidityDays = order.credit_validity_days.map { String($0) } ?? ""
            let createdAt = formatter.string(from: order.created_at)
            let paidAt = order.paid_at.map { formatter.string(from: $0) } ?? ""
            let reconciledAt = order.reconciled_at.map { formatter.string(from: $0) } ?? ""
            let refundedAt = order.refunded_at.map { formatter.string(from: $0) } ?? ""
            let creditsRevoked = refund.map { String($0.credits_revoked) } ?? ""
            let creditsConsumed = refund.map { String($0.credits_consumed) } ?? ""
            let bookingsCancelled = refund.map { String($0.bookings_cancelled) } ?? ""

            let fields: [String] = [
                createdAt,
                paidAt,
                order.products?.name ?? "Session pack",
                order.email ?? "",
                amount,
                Self.currencyCode(order),
                creditTotal,
                creditValidityDays,
                order.status,
                order.stripe_checkout_session_id ?? "",
                order.stripe_payment_intent_id ?? "",
                reconciledAt,
                order.reconciled_by?.uuidString ?? "",
                refundedAt,
                refundedAmount,
                creditsRevoked,
                creditsConsumed,
                bookingsCancelled
            ]
            return fields.map(Self.csvField).joined(separator: ",")
        }
        return ([header] + body).joined(separator: "\n")
    }

    private static func currencyCode(_ order: OrderItem) -> String {
        let code = order.currency?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        return code.isEmpty ? "AUD" : code
    }

    /// Cents rendered as a two-decimal amount. Split out of the CSV row literal
    /// so the type-checker resolves the numeric conversion once, in isolation.
    private static func money(_ cents: Int) -> String {
        String(format: "%.2f", Double(cents) / 100)
    }

    private static func moneyField(_ cents: Int?) -> String {
        money(cents ?? 0)
    }

    private static func csvField(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\"", with: "\"\"")
        return escaped.contains(",") || escaped.contains("\"") || escaped.contains("\n")
            ? "\"\(escaped)\""
            : escaped
    }
}

struct AdminDailyOperation: Identifiable, Codable, Hashable {
    var id: UUID { session_id }
    let session_id: UUID
    let title: String
    let class_type: String?
    let start_time: Date
    let end_time: Date?
    let status: String
    let capacity: Int?
    let coach_name: String?
    let location_zone: String?
    let booking_mode: String?
    let requested_count: Int
    let confirmed_count: Int
    let waitlist_count: Int
    let attended_count: Int
    let no_show_count: Int
    let public_request_count: Int
    // Defaulted so a database still on the previous shape decodes: the counts
    // are additive, and a missing public side simply reads as zero rather than
    // failing the whole day desk.
    var public_confirmed_count: Int? = nil
    var public_waitlist_count: Int? = nil
    var places_held: Int? = nil
    let attendance_due: Bool

    var activeCount: Int { requested_count + confirmed_count }

    /// The whole room: member bookings that hold a credit plus confirmed public
    /// timetable sign-ups. The desk used to show only the member side, so a
    /// class the timetable had filled read as "0 confirmed".
    var placesHeld: Int {
        places_held ?? (requested_count + confirmed_count + (public_confirmed_count ?? 0))
    }
    var confirmedInRoom: Int { confirmed_count + (public_confirmed_count ?? 0) }
    var waitingInRoom: Int { waitlist_count + (public_waitlist_count ?? 0) }
}

struct AdminClassRosterReport {
    let operation: AdminDailyOperation
    let members: [AdminRosterMember]
    let attendance: AdminAttendanceDraft
    let rosterVerifiedAt: Date
    let generatedAt: Date

    var csv: String {
        let header = [
            "Class", "Class start", "Coach", "Location", "Roster verified",
            "Exported", "Member", "Email", "Phone", "Booking status",
            "Roll call draft", "Booked"
        ]
        let formatter = ISO8601DateFormatter()
        let body = members.map { member in
            [
                operation.title,
                formatter.string(from: operation.start_time),
                operation.coach_name ?? "",
                operation.location_zone ?? "",
                formatter.string(from: rosterVerifiedAt),
                formatter.string(from: generatedAt),
                member.displayName,
                member.email ?? "",
                member.phone ?? "",
                member.status,
                rollCallLabel(for: member),
                formatter.string(from: member.booked_at)
            ]
            .map(Self.escape)
            .joined(separator: ",")
        }
        return ([header.map(Self.escape).joined(separator: ",")] + body)
            .joined(separator: "\n") + "\n"
    }

    private func rollCallLabel(for member: AdminRosterMember) -> String {
        switch attendance.mark(for: member.id) {
        case .attended: return "present"
        case .noShow: return "no show"
        case nil: return member.attendanceEligible ? "unmarked" : "not eligible"
        }
    }

    private static func escape(_ value: String) -> String {
        let trimmed = value.drop(while: { $0 == " " || $0 == "\t" || $0 == "\r" || $0 == "\n" })
        let protected: String
        if let first = trimmed.first, "=+-@".contains(first) {
            protected = "'\(value)"
        } else {
            protected = value
        }
        return "\"\(protected.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

enum AdminClassOperationalPhase: Equatable {
    case attendanceDue
    case live
    case upcoming
}

struct AdminClassOperationalFocus: Equatable {
    let operation: AdminDailyOperation
    let phase: AdminClassOperationalPhase

    static func resolve(
        operations: [AdminDailyOperation],
        sourceIsCurrent: Bool,
        now: Date = Date()
    ) -> Self? {
        guard sourceIsCurrent else { return nil }

        let candidates = operations.compactMap { operation -> (Int, AdminDailyOperation)? in
            let status = operation.status.lowercased()

            if operation.attendance_due {
                return (0, operation)
            }
            guard ["published", "full"].contains(status) else { return nil }

            let assumedEnd = operation.end_time
                ?? operation.start_time.addingTimeInterval(3 * 60 * 60)
            if operation.start_time <= now, assumedEnd > now {
                return (1, operation)
            }
            if operation.start_time > now {
                return (2, operation)
            }
            return nil
        }

        guard let selected = candidates.min(by: { lhs, rhs in
            lhs.0 == rhs.0
                ? lhs.1.start_time < rhs.1.start_time
                : lhs.0 < rhs.0
        }) else {
            return nil
        }

        let phase: AdminClassOperationalPhase
        switch selected.0 {
        case 0: phase = .attendanceDue
        case 1: phase = .live
        default: phase = .upcoming
        }
        return Self(operation: selected.1, phase: phase)
    }
}

enum AdminDailyClassSetupIssueKind: String, Equatable, Hashable, CaseIterable {
    case missingCoach
    case missingLocation
    case invalidCapacity
    case overCapacity

    var title: String {
        switch self {
        case .missingCoach: return "Coach not assigned"
        case .missingLocation: return "Training area missing"
        case .invalidCapacity: return "Capacity not configured"
        case .overCapacity: return "Roster exceeds capacity"
        }
    }

    var icon: String {
        switch self {
        case .missingCoach: return "person.crop.circle.badge.exclamationmark"
        case .missingLocation: return "mappin.slash"
        case .invalidCapacity: return "person.2.slash"
        case .overCapacity: return "exclamationmark.triangle.fill"
        }
    }
}

struct AdminDailyClassSetupIssue: Identifiable, Equatable {
    let sessionID: UUID
    let classTitle: String
    let kind: AdminDailyClassSetupIssueKind
    let detail: String

    var id: String { "\(sessionID.uuidString.lowercased()):\(kind.rawValue)" }
    var isCritical: Bool { kind == .overCapacity }
}

struct AdminDailyClassReadiness: Equatable {
    let operations: [AdminDailyOperation]
    let sourceIsCurrent: Bool
    let now: Date

    init(
        operations: [AdminDailyOperation],
        sourceIsCurrent: Bool,
        now: Date = Date()
    ) {
        self.operations = operations
        self.sourceIsCurrent = sourceIsCurrent
        self.now = now
    }

    var issues: [AdminDailyClassSetupIssue] {
        guard sourceIsCurrent else { return [] }
        return operations
            .filter(isActionable)
            .flatMap(issues(for:))
    }

    var affectedClassIDs: [UUID] {
        var seen = Set<UUID>()
        return issues.compactMap { issue in
            seen.insert(issue.sessionID).inserted ? issue.sessionID : nil
        }
    }

    var affectedClassCount: Int { affectedClassIDs.count }
    var singleAffectedClassID: UUID? {
        affectedClassIDs.count == 1 ? affectedClassIDs[0] : nil
    }

    func issues(for sessionID: UUID) -> [AdminDailyClassSetupIssue] {
        issues.filter { $0.sessionID == sessionID }
    }

    func summary(for sessionID: UUID) -> String? {
        let titles = issues(for: sessionID).map(\.kind.title)
        guard !titles.isEmpty else { return nil }
        return titles.joined(separator: " · ")
    }

    private func isActionable(_ operation: AdminDailyOperation) -> Bool {
        guard ["published", "full"].contains(operation.status.lowercased()) else {
            return false
        }
        let assumedEnd = operation.end_time
            ?? operation.start_time.addingTimeInterval(3 * 60 * 60)
        return assumedEnd > now
    }

    private func issues(for operation: AdminDailyOperation) -> [AdminDailyClassSetupIssue] {
        var result: [AdminDailyClassSetupIssue] = []
        if operation.coach_name?.nilIfBlank == nil {
            result.append(issue(
                operation,
                kind: .missingCoach,
                detail: "Assign a coach before members arrive."
            ))
        }
        if operation.location_zone?.nilIfBlank == nil {
            result.append(issue(
                operation,
                kind: .missingLocation,
                detail: "Add the training area so staff and members know where to meet."
            ))
        }
        guard let capacity = operation.capacity, capacity > 0 else {
            result.append(issue(
                operation,
                kind: .invalidCapacity,
                detail: "Set a capacity of at least one before accepting bookings."
            ))
            return result
        }
        if operation.confirmed_count > capacity {
            result.append(issue(
                operation,
                kind: .overCapacity,
                detail: "\(operation.confirmed_count) confirmed members exceed the \(capacity)-place capacity."
            ))
        }
        return result
    }

    private func issue(
        _ operation: AdminDailyOperation,
        kind: AdminDailyClassSetupIssueKind,
        detail: String
    ) -> AdminDailyClassSetupIssue {
        AdminDailyClassSetupIssue(
            sessionID: operation.id,
            classTitle: operation.title,
            kind: kind,
            detail: detail
        )
    }
}

struct AdminShiftClassBrief: Identifiable, Equatable {
    let id: UUID
    let title: String
    let startTime: Date
    let status: String
    let confirmed: Int
    let requested: Int
    let waitlisted: Int
    let attendanceDue: Bool

    init(operation: AdminDailyOperation) {
        id = operation.id
        title = operation.title
        startTime = operation.start_time
        status = operation.status
        confirmed = operation.confirmed_count
        requested = operation.requested_count + operation.public_request_count
        waitlisted = operation.waitlist_count
        attendanceDue = operation.attendance_due
    }
}

struct AdminShiftBriefing: Equatable {
    let generatedAt: Date
    let sourceUpdatedAt: Date?
    let classes: [AdminShiftClassBrief]
    let requestedPlaces: Int
    let waitlistedMembers: Int
    let attendanceDue: Int
    let activationActions: Int
    let retentionFollowUps: Int
    let pendingPTRequests: Int
    let recoverableOrders: Int
    let classSetupGaps: Int
    let unavailableSources: [String]

    var openActionCount: Int {
        requestedPlaces
            + waitlistedMembers
            + attendanceDue
            + activationActions
            + retentionFollowUps
            + pendingPTRequests
            + recoverableOrders
            + classSetupGaps
    }

    var summary: String {
        "\(classes.count) class\(classes.count == 1 ? "" : "es") | "
            + "\(openActionCount) open action\(openActionCount == 1 ? "" : "s")"
    }

    var text: String {
        var lines = [
            "XERT OWNER SHIFT BRIEF",
            "Generated: \(Self.timestamp(generatedAt))",
            sourceUpdatedAt.map { "Operational snapshot: \(Self.timestamp($0))" }
                ?? "Operational snapshot: unavailable",
            "",
            "OPEN WORK"
        ]
        let actions = [
            ("Class booking requests", requestedPlaces),
            ("Waitlisted members", waitlistedMembers),
            ("Attendance roll calls due", attendanceDue),
            ("Member activation actions", activationActions),
            ("Retention follow-ups", retentionFollowUps),
            ("PT requests", pendingPTRequests),
            ("Payments needing recovery", recoverableOrders),
            ("Classes needing setup", classSetupGaps)
        ].filter { $0.1 > 0 }
        if actions.isEmpty {
            lines.append("- No open queue actions")
        } else {
            lines.append(contentsOf: actions.map { "- \($0.0): \($0.1)" })
        }

        lines.append(contentsOf: ["", "TODAY'S CLASSES"])
        if classes.isEmpty {
            lines.append("- No classes scheduled")
        } else {
            lines.append(contentsOf: classes.sorted { $0.startTime < $1.startTime }.map { item in
                let attendance = item.attendanceDue ? " | ATTENDANCE DUE" : ""
                return "- \(Self.time(item.startTime)) \(item.title) | "
                    + "\(item.confirmed) confirmed | \(item.requested) requested | "
                    + "\(item.waitlisted) waiting\(attendance)"
            })
        }

        if !unavailableSources.isEmpty {
            lines.append(contentsOf: [
                "",
                "DATA WARNING",
                "- Unavailable: \(unavailableSources.sorted().joined(separator: ", "))"
            ])
        }
        lines.append(contentsOf: [
            "",
            "Re-open live XERT workspaces before any irreversible action."
        ])
        return lines.joined(separator: "\n")
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = EventItem.calendar
        formatter.locale = Locale(identifier: "en_AU")
        formatter.timeZone = EventItem.calendar.timeZone
        formatter.dateFormat = "d MMM yyyy, h:mm a zzz"
        return formatter.string(from: date)
    }

    private static func time(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = EventItem.calendar
        formatter.locale = Locale(identifier: "en_AU")
        formatter.timeZone = EventItem.calendar.timeZone
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }
}

struct AdminRosterMember: Identifiable, Codable, Hashable {
    var id: UUID { booking_id }
    let booking_id: UUID
    let member_id: UUID
    let full_name: String?
    let email: String?
    let phone: String?
    let status: String
    let booked_at: Date

    var displayName: String { full_name?.nilIfBlank ?? email?.nilIfBlank ?? "XERT member" }
    var attendanceEligible: Bool { ["confirmed", "attended", "no_show"].contains(status) }
}

enum AdminAttendanceMark: String, Codable, Equatable {
    case attended
    case noShow = "no_show"
}

struct AdminAttendanceSummary: Equatable {
    let total: Int
    let attended: Int
    let noShow: Int

    var marked: Int { attended + noShow }
    var unmarked: Int { max(0, total - marked) }
    var isComplete: Bool { total > 0 && unmarked == 0 }
}

struct AdminAttendanceDraft: Equatable {
    private(set) var eligibleIDs: [UUID] = []
    private(set) var marks: [UUID: AdminAttendanceMark] = [:]

    init(roster: [AdminRosterMember] = []) {
        reconcile(roster: roster)
    }

    var summary: AdminAttendanceSummary {
        AdminAttendanceSummary(
            total: eligibleIDs.count,
            attended: eligibleIDs.lazy.filter { marks[$0] == .attended }.count,
            noShow: eligibleIDs.lazy.filter { marks[$0] == .noShow }.count
        )
    }

    var attendedIDs: [UUID] { eligibleIDs.filter { marks[$0] == .attended } }
    var noShowIDs: [UUID] { eligibleIDs.filter { marks[$0] == .noShow } }
    var persistedMarks: [UUID: AdminAttendanceMark] {
        let allowed = Set(eligibleIDs)
        return marks.filter { allowed.contains($0.key) }
    }

    func mark(for bookingID: UUID) -> AdminAttendanceMark? {
        marks[bookingID]
    }

    mutating func set(_ mark: AdminAttendanceMark, for bookingID: UUID) {
        guard eligibleIDs.contains(bookingID) else { return }
        marks[bookingID] = mark
    }

    mutating func markAllPresent() {
        marks = Dictionary(uniqueKeysWithValues: eligibleIDs.map { ($0, .attended) })
    }

    mutating func clear() {
        marks = [:]
    }

    mutating func restore(
        _ restoredMarks: [UUID: AdminAttendanceMark],
        whenCurrentMatches baselineMarks: [UUID: AdminAttendanceMark]
    ) {
        let allowed = Set(eligibleIDs)
        for (bookingID, mark) in restoredMarks where allowed.contains(bookingID) {
            guard marks[bookingID] == baselineMarks[bookingID] else { continue }
            marks[bookingID] = mark
        }
    }

    mutating func reconcile(roster: [AdminRosterMember]) {
        var seen = Set<UUID>()
        let eligible = roster.filter { $0.attendanceEligible && seen.insert($0.id).inserted }
        let ids = eligible.map(\.id)
        let allowed = Set(ids)
        marks = marks.filter { allowed.contains($0.key) }
        for member in eligible {
            switch member.status {
            case AdminAttendanceMark.attended.rawValue:
                marks[member.id] = .attended
            case AdminAttendanceMark.noShow.rawValue:
                marks[member.id] = .noShow
            default:
                break
            }
        }
        eligibleIDs = ids
    }
}

struct AdminClassSession: Identifiable, Codable, Hashable {
    let id: UUID
    let class_type: String?
    let title: String
    let description: String?
    let coach_name: String?
    let start_time: Date?
    let end_time: Date?
    let duration_minutes: Int?
    let capacity: Int?
    let location_zone: String?
    let beginner_friendly: Bool?
    let intensity_level: String?
    let status: String
    let public_visible: Bool?
    let booking_mode: String?
    let notes: String?
}

enum AdminScheduleScope: String, CaseIterable, Identifiable {
    case upcoming
    case past
    case all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .upcoming: return "Upcoming"
        case .past: return "Past"
        case .all: return "All"
        }
    }

    func includes(_ item: AdminClassSession, now: Date) -> Bool {
        guard self != .all else { return true }
        let start = item.start_time ?? .distantPast
        let end = item.end_time
            ?? start.addingTimeInterval(TimeInterval(max(item.duration_minutes ?? 0, 0) * 60))
        switch self {
        case .upcoming: return end >= now
        case .past: return end < now
        case .all: return true
        }
    }
}

struct AdminClassCancellationContact: Identifiable, Hashable {
    let name: String
    let email: String?
    let phone: String?
    let phoneDialable: String?

    var id: String {
        email?.lowercased() ?? phoneDialable ?? name.lowercased()
    }

    var displayName: String {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? (email ?? phone ?? "Affected member") : cleaned
    }

    var emailURL: URL? {
        email.flatMap { URL(string: "mailto:\($0)") }
    }

    var phoneURL: URL? {
        phoneDialable.flatMap { URL(string: "tel:\($0)") }
    }
}

struct AdminClassCancellationMessage: Hashable {
    let subject: String
    let body: String

    init(classSession: AdminClassSession) {
        let title = classSession.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let className = title.isEmpty ? "XERT class" : title
        let startsAt = classSession.start_time.map { Self.startFormatter.string(from: $0) } ?? "the scheduled time"
        subject = "XERT class cancelled: \(className)"
        body = [
            "Hi,",
            "",
            "Unfortunately, XERT has cancelled \(className) on \(startsAt). Any reserved session credit has been returned automatically.",
            "",
            "We are sorry for the disruption. Please open XERT to choose another class, or reply if you need help.",
            "",
            "XERT Fitness"
        ].joined(separator: "\n")
    }

    private static let startFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = EventItem.calendar
        formatter.locale = Locale(identifier: "en_AU")
        formatter.timeZone = EventItem.calendar.timeZone
        formatter.dateFormat = "EEEE d MMMM 'at' h:mm a"
        return formatter
    }()
}

struct AdminClassCancellationNoticeOutcome: Codable, Hashable {
    let announcement_id: UUID
    let recipients: Int
    let push: AdminAnnouncementPushSummary
}

struct AdminClassCancellationFollowUp: Identifiable, Hashable {
    static let maximumBCCRecipients = 40

    let sessionID: UUID
    let classTitle: String
    let affectedBookings: Int
    let contacts: [AdminClassCancellationContact]
    let message: AdminClassCancellationMessage
    let contactLookupIncomplete: Bool
    let notification: AdminClassCancellationNoticeOutcome?
    let notificationWarning: String?
    let refreshWarnings: [String]
    let completedAt: Date

    var id: UUID { sessionID }
    var emailRecipientCount: Int { min(emailRecipients.count, Self.maximumBCCRecipients) }
    var omittedEmailCount: Int { max(0, emailRecipients.count - Self.maximumBCCRecipients) }

    var mailtoURL: URL? {
        let recipients = Array(emailRecipients.prefix(Self.maximumBCCRecipients))
        guard !recipients.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = ""
        components.queryItems = [
            URLQueryItem(name: "bcc", value: recipients.joined(separator: ",")),
            URLQueryItem(name: "subject", value: message.subject),
            URLQueryItem(name: "body", value: message.body)
        ]
        return components.url
    }

    static func contacts(
        roster: [AdminRosterMember],
        enquiries: [AdminLegacyBookingRequest]
    ) -> [AdminClassCancellationContact] {
        let activeStatuses = Set(["requested", "confirmed", "waitlisted"])
        var contacts: [AdminClassCancellationContact] = []

        func append(name: String?, email: String?, phone: String?, status: String) {
            guard activeStatuses.contains(status) else { return }
            let normalizedEmail = normalizeEmail(email)
            let normalizedPhone = normalizePhone(phone)
            guard normalizedEmail != nil || normalizedPhone.dialable != nil else { return }

            if let index = contacts.firstIndex(where: {
                (normalizedEmail != nil && $0.email == normalizedEmail)
                    || (normalizedPhone.dialable != nil && $0.phoneDialable == normalizedPhone.dialable)
            }) {
                let existing = contacts[index]
                contacts[index] = AdminClassCancellationContact(
                    name: existing.name.isEmpty ? clean(name) : existing.name,
                    email: existing.email ?? normalizedEmail,
                    phone: existing.phone ?? normalizedPhone.display,
                    phoneDialable: existing.phoneDialable ?? normalizedPhone.dialable
                )
                return
            }

            contacts.append(AdminClassCancellationContact(
                name: clean(name),
                email: normalizedEmail,
                phone: normalizedPhone.display,
                phoneDialable: normalizedPhone.dialable
            ))
        }

        for member in roster {
            append(name: member.full_name, email: member.email, phone: member.phone, status: member.status)
        }
        for enquiry in enquiries {
            append(name: enquiry.full_name, email: enquiry.email, phone: enquiry.phone, status: enquiry.status)
        }
        return contacts.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private var emailRecipients: [String] {
        var seen = Set<String>()
        return contacts.compactMap(\.email).filter { seen.insert($0).inserted }
    }

    private static func clean(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func normalizeEmail(_ value: String?) -> String? {
        let email = clean(value).lowercased()
        guard email.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil else {
            return nil
        }
        return email
    }

    private static func normalizePhone(_ value: String?) -> (display: String?, dialable: String?) {
        let display = clean(value)
        var dialable = ""
        for character in display {
            if character.isNumber {
                dialable.append(character)
            } else if character == "+", dialable.isEmpty {
                dialable.append(character)
            }
        }
        let digitCount = dialable.filter(\.isNumber).count
        guard digitCount >= 8 else { return (nil, nil) }
        return (display, dialable)
    }
}

/// Editors are re-initialised on every parent re-render, and their dirty state
/// compares the live draft against a freshly computed baseline. A baseline
/// built from the raw clock differs on every re-render, so an untouched editor
/// turned permanently "dirty" within milliseconds and kept feeding the exit
/// coordinator. Snapping the default start to the next top of the hour keeps
/// the baseline stable for up to an hour (and is a nicer default anyway).
func adminDraftDefaultStart(after now: Date, calendar: Calendar = .current) -> Date {
    var components = calendar.dateComponents([.year, .month, .day, .hour], from: now)
    components.hour = (components.hour ?? 0) + 1
    return calendar.date(from: components) ?? now
}

struct AdminClassDraft: Codable, Hashable {
    static let classTypes = ["XERT Foundation", "XERT Strength", "XERT Engine", "XERT Hybrid", "XERT Event Prep", "XERT Team"]
    static let intensities = ["Low", "Moderate", "High", "Very high"]
    static let bookingModes = ["interest_only", "request_to_book", "instant_book"]

    var classType: String
    var title: String
    var description: String
    var coachName: String
    var startTime: Date
    var hasEndTime: Bool
    var endTime: Date
    var durationMinutes: Int
    var capacity: Int
    var location: String
    var beginnerFriendly: Bool
    var intensity: String
    var status: String
    var publicVisible: Bool
    var bookingMode: String
    var notes: String

    init(classSession: AdminClassSession? = nil, now: Date = Date()) {
        let defaultStart = adminDraftDefaultStart(after: now)
        classType = classSession?.class_type ?? "XERT Foundation"
        title = classSession?.title ?? ""
        description = classSession?.description ?? ""
        coachName = classSession?.coach_name ?? ""
        startTime = classSession?.start_time ?? defaultStart
        hasEndTime = classSession?.end_time != nil
        endTime = classSession?.end_time ?? defaultStart.addingTimeInterval(3_600)
        durationMinutes = classSession?.duration_minutes ?? 60
        capacity = classSession?.capacity ?? 8
        location = classSession?.location_zone ?? "Main floor"
        beginnerFriendly = classSession?.beginner_friendly ?? false
        intensity = classSession?.intensity_level ?? "Moderate"
        status = classSession?.status ?? "draft"
        publicVisible = classSession?.public_visible ?? false
        bookingMode = classSession?.booking_mode ?? "request_to_book"
        notes = classSession?.notes ?? ""
    }
}

/// A reusable class preset from the shared class bank (`class_templates`),
/// curated in the web Command Centre and quick-added from the app calendar.
struct AdminClassTemplate: Identifiable, Codable, Hashable {
    let id: UUID
    let name: String
    let class_type: String?
    let title: String?
    let description: String?
    let coach_name: String?
    let duration_minutes: Int?
    let capacity: Int?
    let location_zone: String?
    let beginner_friendly: Bool?
    let intensity_level: String?
    let booking_mode: String?
    let default_start_minute: Int?
    let notes: String?

    var defaultStartMinute: Int {
        let minute = default_start_minute ?? 6 * 60
        return (0...(24 * 60 - 1)).contains(minute) ? minute : 6 * 60
    }

    var resolvedTitle: String {
        let trimmed = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? name : trimmed
    }

    func draft(on day: Date, startMinute: Int, publish: Bool, calendar: Calendar = .current) -> AdminClassDraft {
        var draft = AdminClassDraft()
        let start = calendar.startOfDay(for: day).addingTimeInterval(TimeInterval(startMinute * 60))
        let duration = duration_minutes ?? 60
        draft.classType = class_type ?? draft.classType
        draft.title = resolvedTitle
        draft.description = description ?? ""
        draft.coachName = coach_name ?? ""
        draft.startTime = start
        draft.hasEndTime = true
        draft.endTime = start.addingTimeInterval(TimeInterval(duration * 60))
        draft.durationMinutes = duration
        draft.capacity = capacity ?? 8
        draft.location = location_zone ?? "Main floor"
        draft.beginnerFriendly = beginner_friendly ?? false
        draft.intensity = intensity_level ?? "Moderate"
        draft.status = publish ? "published" : "draft"
        draft.publicVisible = publish
        draft.bookingMode = booking_mode ?? "request_to_book"
        draft.notes = notes ?? ""
        return draft
    }
}

struct AdminAvailabilityBlock: Identifiable, Codable, Hashable {
    let id: UUID
    let start_time: Date
    let end_time: Date
    let type: String
    let coach_name: String?
    let notes: String?
    let is_bookable: Bool
    let updated_at: String
}

struct AdminAvailabilityDraft: Codable, Hashable {
    static let types = ["PT available", "private session available", "group class available", "admin only", "open gym placeholder", "workshop placeholder"]
    var startTime: Date
    var endTime: Date
    var type: String
    var coachName: String
    var notes: String
    var isBookable: Bool

    init(block: AdminAvailabilityBlock? = nil, now: Date = Date()) {
        let start = adminDraftDefaultStart(after: now)
        startTime = block?.start_time ?? start
        endTime = block?.end_time ?? start.addingTimeInterval(3_600)
        type = block?.type ?? "PT available"
        coachName = block?.coach_name ?? ""
        notes = block?.notes ?? ""
        isBookable = block?.is_bookable ?? false
    }
}

struct AdminBlackoutPeriod: Identifiable, Codable, Hashable {
    let id: UUID
    let start_time: Date
    let end_time: Date
    let affects: String
    let reason: String
    let notes: String?
    let updated_at: String
}

struct AdminBlackoutDraft: Codable, Hashable {
    static let scopes = ["all", "group_classes", "pt_only", "facility_only", "coach_only"]
    static let reasons = ["full day unavailable", "partial day unavailable", "recurring unavailable", "personal work", "facility maintenance", "equipment install", "private event", "soft launch restricted"]
    var startTime: Date
    var endTime: Date
    var affects: String
    var reason: String
    var notes: String

    init(period: AdminBlackoutPeriod? = nil, now: Date = Date()) {
        let start = adminDraftDefaultStart(after: now)
        startTime = period?.start_time ?? start
        endTime = period?.end_time ?? start.addingTimeInterval(3_600)
        affects = period?.affects ?? "all"
        reason = period?.reason ?? "facility maintenance"
        notes = period?.notes ?? ""
    }

    func overlappingPublishedClasses(in sessions: [AdminClassSession]) -> [AdminClassSession] {
        guard ["all", "group_classes", "facility_only"].contains(affects),
              endTime > startTime else { return [] }
        return sessions.filter { session in
            guard ["published", "full"].contains(session.status),
                  let sessionStart = session.start_time else { return false }
            let duration = max(session.duration_minutes ?? 60, 1)
            let sessionEnd = session.end_time
                ?? sessionStart.addingTimeInterval(TimeInterval(duration * 60))
            return sessionStart < endTime && sessionEnd > startTime
        }
        .sorted {
            ($0.start_time ?? .distantFuture) < ($1.start_time ?? .distantFuture)
        }
    }
}

struct AdminWaitlistItem: Identifiable, Codable, Hashable {
    var id: UUID { session_id }
    let session_id: UUID
    let title: String
    let start_time: Date
    let capacity: Int?
    let active_count: Int
    let waitlist_count: Int
    let spots_available: Int?
    let can_promote: Bool
    let next_booking_id: UUID
    let next_member_id: UUID
    let next_full_name: String?
    let next_email: String?
    let next_phone: String?
    let next_booked_at: Date
    let next_available_credits: Int

    var nextMemberName: String { next_full_name?.nilIfBlank ?? next_email?.nilIfBlank ?? "Next member" }
}

struct AdminWaitlistPromotion: Codable, Hashable {
    let request_id: UUID
    let session_id: UUID
    let booking_id: UUID
    let user_id: UUID
    let announcement_id: UUID
    let promoted_at: Date
}

struct AdminWaitlistPromotionOutcome: Hashable {
    let promotion: AdminWaitlistPromotion
    let pushDelivered: Bool
    let warning: String?
}

struct AdminBookingDecision: Codable, Hashable {
    let request_id: UUID
    let booking_id: UUID
    let session_id: UUID
    let user_id: UUID
    let previous_status: String
    let new_status: String
    let announcement_id: UUID?
    let notice_created: Bool
    let decided_at: Date
}

struct AdminBookingDecisionOutcome: Hashable {
    let decision: AdminBookingDecision
    let pushDelivered: Bool
    let warning: String?
}

struct AdminStaffBookingReceipt: Codable, Hashable {
    let request_id: UUID
    let booking_id: UUID
    let session_id: UUID
    let member_id: UUID
    let booking_status: String
    let credit_batch_id: UUID?
    let announcement_id: UUID?
    let created_at: Date
}

struct AdminStaffBookingOutcome: Hashable {
    let receipt: AdminStaffBookingReceipt
    let pushDelivered: Bool
    let warning: String?
}

struct AdminStaffBookingFeedback: Equatable {
    let sessionID: UUID
    let message: String
    let needsAttention: Bool
}

struct AdminFollowUp: Identifiable, Codable, Hashable {
    let id: UUID
    let full_name: String?
    let email: String?
    let phone: String?
    let role: String
    let joined_at: Date
    let credits_remaining: Int
    let bookings_count: Int
    let last_attended_at: Date?
    let next_booking_at: Date?
    let last_follow_up_at: Date?
    let reason: String
    let priority: Int
    let credits_expiring: Int
    let next_credit_expiry: Date?

    var displayName: String { full_name?.nilIfBlank ?? email?.nilIfBlank ?? "XERT member" }

    var reasonLabel: String {
        switch reason {
        case "no_first_booking": return "Needs a first booking"
        case "credits_expiring": return "Credits expiring soon"
        case "idle_credits": return "Has unused credits"
        case "renewal_due": return "Ready to renew"
        default: return "Follow up"
        }
    }
}

struct AdminPlatformSettings: Identifiable, Codable, Hashable {
    let id: UUID
    var target_launch_date: String
    var countdown_enabled: Bool
    var bookings_enabled: Bool
    var payments_enabled: Bool
    var prices_coming_soon: Bool
    var fitbox_enabled: Bool
    var fitbox_booking_url: String?
    var announcement_banner_text: String?
    var announcement_banner_enabled: Bool
    let updated_at: String

    var announcementText: String {
        get { announcement_banner_text ?? "" }
        set { announcement_banner_text = newValue }
    }

    var providerResolution: XertPlatformProviderResolution {
        PublicPlatformSettings(
            bookings_enabled: bookings_enabled,
            payments_enabled: payments_enabled,
            prices_coming_soon: prices_coming_soon,
            fitbox_enabled: fitbox_enabled,
            fitbox_booking_url: fitbox_booking_url
        ).providerResolution
    }
}

enum AdminMemberOperationsState: Equatable {
    case unavailable
    case paused
    case bookingsOpen
    case liveCommerce
    case inconsistent
}

struct AdminEmergencyPausePlan: Equatable {
    let settings: AdminPlatformSettings?
    let sourceIsCurrent: Bool

    var state: AdminMemberOperationsState {
        guard sourceIsCurrent, let settings else { return .unavailable }
        switch (settings.bookings_enabled, settings.payments_enabled) {
        case (false, false): return .paused
        case (true, false): return .bookingsOpen
        case (true, true): return .liveCommerce
        case (false, true): return .inconsistent
        }
    }

    var canPause: Bool {
        switch state {
        case .bookingsOpen, .liveCommerce, .inconsistent: return true
        case .unavailable, .paused: return false
        }
    }

    var title: String {
        switch state {
        case .unavailable: return "Incident controls unavailable"
        case .paused: return "New member activity paused"
        case .bookingsOpen: return "Member bookings are open"
        case .liveCommerce: return "Bookings and checkout are live"
        case .inconsistent: return "Checkout exposure detected"
        }
    }

    var detail: String {
        switch state {
        case .unavailable:
            return "Refresh live platform settings before relying on the emergency control."
        case .paused:
            return "New bookings, waitlist joins and checkout are paused. Existing bookings and owner operations remain available."
        case .bookingsOpen:
            return "New bookings and waitlist joins are open. Session-pack checkout is already paused."
        case .liveCommerce:
            return "New bookings, waitlist joins and session-pack checkout are accepting member activity."
        case .inconsistent:
            return "Checkout reports live while bookings are paused. Pause both switches now, then review System status."
        }
    }

    var pausedSettings: AdminPlatformSettings? {
        guard canPause, var paused = settings else { return nil }
        paused.bookings_enabled = false
        paused.payments_enabled = false
        return paused
    }
}

struct AdminPTRequest: Identifiable, Codable, Hashable {
    let id: UUID
    let full_name: String?
    let email: String?
    let phone: String?
    let requested_session_type: String
    let preferred_day: String?
    let preferred_time: String?
    let training_goal: String?
    let experience_level: String?
    let notes: String?
    let admin_notes: String?
    let status: String
    let created_at: Date

    var displayName: String { full_name?.nilIfBlank ?? email?.nilIfBlank ?? "PT enquiry" }
    var isPending: Bool { ["requested", "reschedule_requested"].contains(status) }
    var searchableText: String {
        let fields: [String?] = [
            displayName, email, phone, requested_session_type, preferred_day,
            preferred_time, training_goal, experience_level, admin_notes
        ]
        return fields.compactMap { $0?.lowercased() }.joined(separator: " ")
    }
    var allowedNextStatuses: [String] {
        switch status {
        case "requested": return ["approved", "reschedule_requested", "declined"]
        case "reschedule_requested": return ["approved", "declined"]
        case "approved": return ["completed", "cancelled"]
        default: return []
        }
    }
}

struct AdminPTRequestReport {
    let rows: [AdminPTRequest]

    var requestedCount: Int { rows.filter { $0.status == "requested" }.count }
    var approvedCount: Int { rows.filter { $0.status == "approved" }.count }
    var completedCount: Int { rows.filter { $0.status == "completed" }.count }

    var csv: String {
        let header = [
            "Name", "Email", "Phone", "Session Type", "Preferred Day",
            "Preferred Time", "Status", "Submitted"
        ].joined(separator: ",")
        let formatter = ISO8601DateFormatter()
        let body = rows.map { request in
            [
                request.displayName,
                request.email ?? "",
                request.phone ?? "",
                request.requested_session_type,
                request.preferred_day ?? "",
                request.preferred_time ?? "",
                request.status,
                formatter.string(from: request.created_at)
            ]
            .map(Self.escape)
            .joined(separator: ",")
        }
        return ([header] + body).joined(separator: "\n") + "\n"
    }

    private static func escape(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }
}

enum AdminLeadPipeline: String, CaseIterable, Identifiable, Codable, Hashable {
    case members = "member_interest"
    case trainers = "trainer_interest"
    case partners = "partner_interest"

    var id: String { rawValue }
    var shortLabel: String {
        switch self {
        case .members: return "Members"
        case .trainers: return "Trainers"
        case .partners: return "Partners"
        }
    }
    var title: String {
        switch self {
        case .members: return "Member leads"
        case .trainers: return "Trainer applicants"
        case .partners: return "Partner enquiries"
        }
    }
    var statuses: [String] {
        switch self {
        case .members:
            return ["new", "contacted", "warm", "hot", "foundation_offer_sent", "booked_trial", "joined", "casual", "not_suitable", "archived"]
        case .trainers:
            return ["new", "reviewing", "contacted", "interview", "shortlisted", "not_suitable", "hired", "archived"]
        case .partners:
            return ["new", "reviewing", "contacted", "meeting", "approved", "not_suitable", "archived"]
        }
    }
}

struct AdminLeadActionCounts: Equatable {
    let memberLeads: Int
    let trainerApplicants: Int
    let partnerEnquiries: Int
    let overdueMemberLeads: Int
    let overdueTrainerApplicants: Int
    let overduePartnerEnquiries: Int

    init(
        memberLeads: Int,
        trainerApplicants: Int,
        partnerEnquiries: Int,
        overdueMemberLeads: Int = 0,
        overdueTrainerApplicants: Int = 0,
        overduePartnerEnquiries: Int = 0
    ) {
        self.memberLeads = memberLeads
        self.trainerApplicants = trainerApplicants
        self.partnerEnquiries = partnerEnquiries
        self.overdueMemberLeads = overdueMemberLeads
        self.overdueTrainerApplicants = overdueTrainerApplicants
        self.overduePartnerEnquiries = overduePartnerEnquiries
    }

    var total: Int { memberLeads + trainerApplicants + partnerEnquiries }
    var overdueTotal: Int {
        overdueMemberLeads + overdueTrainerApplicants + overduePartnerEnquiries
    }

    var priorityPipeline: AdminLeadPipeline? {
        Self.priorityPipeline(
            members: memberLeads,
            trainers: trainerApplicants,
            partners: partnerEnquiries
        )
    }

    var overduePriorityPipeline: AdminLeadPipeline? {
        Self.priorityPipeline(
            members: overdueMemberLeads,
            trainers: overdueTrainerApplicants,
            partners: overduePartnerEnquiries
        )
    }

    var triagePipeline: AdminLeadPipeline? {
        overduePriorityPipeline ?? priorityPipeline
    }

    private static func priorityPipeline(
        members: Int,
        trainers: Int,
        partners: Int
    ) -> AdminLeadPipeline? {
        let pipelines: [(pipeline: AdminLeadPipeline, count: Int)] = [
            (.members, members),
            (.trainers, trainers),
            (.partners, partners)
        ]
        return pipelines
            .filter { $0.count > 0 }
            .sorted {
                if $0.count != $1.count { return $0.count > $1.count }
                return (AdminLeadPipeline.allCases.firstIndex(of: $0.pipeline) ?? 0)
                    < (AdminLeadPipeline.allCases.firstIndex(of: $1.pipeline) ?? 0)
            }
            .first?
            .pipeline
    }
}

struct AdminLeadIdentifier: Codable, Hashable {
    let value: String

    init(_ value: String) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self.value = value
        } else if let value = try? container.decode(Int64.self) {
            self.value = String(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Lead ID must be text or an integer.")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

struct AdminLead: Identifiable, Codable, Hashable {
    let id: AdminLeadIdentifier
    let full_name: String?
    let email: String?
    let phone: String?
    let status: String?
    let admin_notes: String?
    let created_at: Date
    let suburb_town: String?
    let current_training_level: String?
    let main_training_goals: [String]?
    let preferred_training_times: [String]?
    let qualifications: String?
    let years_experience: String?
    let functional_training_experience: String?
    let specialties: [String]?
    let profession: String?
    let business_name: String?
    let services_offered: [String]?
    let short_intro: String?
    let website_social_link: String?
    let utm_source: String?
    let utm_medium: String?
    let utm_campaign: String?

    var displayName: String { full_name?.nilIfBlank ?? email?.nilIfBlank ?? "XERT lead" }
    var effectiveStatus: String { status?.nilIfBlank ?? "new" }
    var searchableText: String {
        [full_name, email, phone, business_name, qualifications, profession, utm_source]
            .compactMap { $0 }.joined(separator: " ").lowercased()
    }
}

struct AdminFitboxJob: Identifiable, Codable, Hashable {
    let id: UUID
    let job_type: String?
    let status: String
    let fitbox_user_id: String?
    let fitbox_status: String?
    let last_error_code: String?
    let dispatched_at: Date?
    let completed_at: Date?
    let created_at: Date

    var needsProviderReview: Bool {
        status == "dispatch_unknown"
            || (status == "failed" && last_error_code != "ZAPIER_DISPATCH_FAILED")
    }

    var isProfileRefresh: Bool { job_type == "get_user" }
}

struct AdminFitboxMemberLink: Codable, Hashable {
    let id: UUID
    let fitbox_gym_id: String
    let fitbox_user_id: String
    let fitbox_status: String?
    let profile_first_name: String?
    let profile_last_name: String?
    let profile_email: String?
    let profile_phone: String?
    let profile_synced_at: Date?
    let linked_at: Date
    let last_verified_at: Date
}

struct AdminFitboxLeadState: Codable, Hashable {
    let link: AdminFitboxMemberLink?
    let current_job: AdminFitboxJob?
    let recent_jobs: [AdminFitboxJob]
    let ready: Bool
    let configuration_issue: String?
    let profile_refresh_ready: Bool?
    let profile_refresh_issue: String?
}

struct AdminFitboxMutationResponse: Codable, Hashable {
    let job: AdminFitboxJob?
    let link: AdminFitboxMemberLink?
}

struct AdminFitboxBridgeHealth: Codable, Hashable {
    struct Environment: Codable, Hashable {
        let ready: Bool
        let missing: [String]
    }
    struct Jobs: Codable, Hashable {
        let completed: Int
        let failed: Int
    }
    struct LaunchValidation: Codable, Hashable {
        let prospect_registration_completed: Int
        let read_only_profile_completed: Int

        var hasReadOnlyProfileEvidence: Bool { read_only_profile_completed > 0 }
    }
    struct EventSummary: Identifiable, Codable, Hashable {
        var id: String { event_type }
        let event_type: String
        let events_24h: Int
        let needs_review: Int
        let last_received_at: Date?
        let latest_processing_state: String?
        let latest_review_reason: String?

        var title: String {
            switch event_type {
            case "class_session_booked": return "Class booked"
            case "class_session_cancelled": return "Class cancelled"
            case "user_first_session_booked": return "First class booked"
            case "user_profile_changed": return "Profile changed"
            case "user_status_changed": return "Member status changed"
            case "user_subscription_changed": return "Subscription changed"
            default:
                return event_type
                    .replacingOccurrences(of: "_", with: " ")
                    .capitalized
            }
        }

        var reviewReasonLabel: String? {
            switch latest_review_reason {
            case "MISSING_STABLE_EVENT_IDENTITY":
                return "Missing a stable provider event ID or timestamp"
            case "PROVIDER_CONTRACT_UNVERIFIED":
                return "Provider event ordering is not yet trusted"
            case .some(let reason):
                return reason.replacingOccurrences(of: "_", with: " ").lowercased()
            case nil:
                return nil
            }
        }
    }

    let ready: Bool
    let environment: Environment
    let jobs_24h: Jobs
    let profile_refreshes_24h: Jobs?
    let launch_validation: LaunchValidation?
    let active: Int
    let stale: Int
    let events_24h: Int
    let reconciliation: Int
    let event_types: [EventSummary]?

    var eventSummaries: [EventSummary] { event_types ?? [] }
    var hasReviewRequired: Bool { reconciliation > 0 }
}

struct AdminLeadReport {
    let pipeline: AdminLeadPipeline
    let rows: [AdminLead]

    var csv: String {
        let commonHeader = ["Submitted", "Status", "Name", "Email", "Phone"]
        let pipelineHeader: [String]
        switch pipeline {
        case .members:
            pipelineHeader = ["Suburb / town", "Campaign source", "Campaign medium", "Campaign name"]
        case .trainers:
            pipelineHeader = ["Qualifications"]
        case .partners:
            pipelineHeader = ["Business", "Profession"]
        }

        let formatter = ISO8601DateFormatter()
        let body = rows.map { lead in
            let common = [
                formatter.string(from: lead.created_at),
                lead.effectiveStatus,
                lead.full_name ?? "",
                lead.email ?? "",
                lead.phone ?? ""
            ]
            let pipelineValues: [String]
            switch pipeline {
            case .members:
                pipelineValues = [
                    lead.suburb_town ?? "",
                    lead.utm_source ?? "",
                    lead.utm_medium ?? "",
                    lead.utm_campaign ?? ""
                ]
            case .trainers:
                pipelineValues = [lead.qualifications ?? ""]
            case .partners:
                pipelineValues = [lead.business_name ?? "", lead.profession ?? ""]
            }
            return (common + pipelineValues).map(Self.escape).joined(separator: ",")
        }
        return ([commonHeader + pipelineHeader].map { $0.map(Self.escape).joined(separator: ",") } + body)
            .joined(separator: "\n") + "\n"
    }

    private static func escape(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

struct AdminCampaignAttributionRow: Identifiable, Codable, Hashable {
    let id: AdminLeadIdentifier
    let utm_source: String?
    let utm_medium: String?
    let utm_campaign: String?
    let source: String?
    let created_at: Date
}

enum AdminCampaignRange: String, CaseIterable, Identifiable {
    case thirty = "30"
    case ninety = "90"
    case all

    var id: String { rawValue }
    var label: String {
        switch self {
        case .thirty: return "30 days"
        case .ninety: return "90 days"
        case .all: return "All time"
        }
    }
    var dayCount: Int? { self == .all ? nil : Int(rawValue) }
}

struct AdminCampaignBreakdown: Identifiable, Hashable {
    let label: String
    let count: Int
    var id: String { label.lowercased() }
}

struct AdminCampaignDailyCount: Identifiable, Hashable {
    let dateKey: String
    let count: Int
    var id: String { dateKey }
}

struct AdminCampaignSummary {
    let rows: [AdminCampaignAttributionRow]
    let attributed: Int
    let sources: [AdminCampaignBreakdown]
    let mediums: [AdminCampaignBreakdown]
    let campaigns: [AdminCampaignBreakdown]
    let dailySignups: [AdminCampaignDailyCount]

    var total: Int { rows.count }
    var direct: Int { total - attributed }
    var attributionRate: Double { total == 0 ? 0 : Double(attributed) / Double(total) }

    init(rows allRows: [AdminCampaignAttributionRow], range: AdminCampaignRange, now: Date = Date()) {
        let calendar = EventItem.calendar
        let validRows = allRows.filter { Self.dateKey($0.created_at, calendar: calendar) != nil }
        let filteredRows: [AdminCampaignAttributionRow]
        if let days = range.dayCount,
           let cutoff = calendar.date(byAdding: .day, value: -(days - 1), to: calendar.startOfDay(for: now)) {
            filteredRows = validRows.filter { $0.created_at >= cutoff }
        } else {
            filteredRows = validRows
        }
        rows = filteredRows

        attributed = filteredRows.filter {
            Self.clean($0.utm_source) != nil || Self.clean($0.utm_medium) != nil || Self.clean($0.utm_campaign) != nil
        }.count
        sources = Self.breakdown(rows: filteredRows, fallback: "Direct / unknown") {
            Self.clean($0.utm_source)
        }
        mediums = Self.breakdown(rows: filteredRows, fallback: "Unspecified") { Self.clean($0.utm_medium) }
        campaigns = Self.breakdown(rows: filteredRows) { Self.clean($0.utm_campaign) }

        let today = calendar.startOfDay(for: now)
        dailySignups = (0..<30).compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: offset - 29, to: today),
                  let key = Self.dateKey(day, calendar: calendar),
                  let nextDay = calendar.date(byAdding: .day, value: 1, to: day) else { return nil }
            return AdminCampaignDailyCount(
                dateKey: key,
                count: filteredRows.filter { $0.created_at >= day && $0.created_at < nextDay }.count
            )
        }
    }

    var csv: String {
        let header = "Created,Brisbane Date,Attributed Source,UTM Medium,UTM Campaign,Recorded Form Source"
        let body = rows.sorted { $0.created_at > $1.created_at }.map { row in
            [
                ISO8601DateFormatter().string(from: row.created_at),
                Self.dateKey(row.created_at, calendar: EventItem.calendar) ?? "",
                Self.clean(row.utm_source) ?? "Direct / unknown",
                Self.clean(row.utm_medium) ?? "",
                Self.clean(row.utm_campaign) ?? "",
                Self.clean(row.source) ?? ""
            ].map(Self.csvField).joined(separator: ",")
        }
        return ([header] + body).joined(separator: "\n")
    }

    private static func breakdown(
        rows: [AdminCampaignAttributionRow],
        fallback: String? = nil,
        label: (AdminCampaignAttributionRow) -> String?
    ) -> [AdminCampaignBreakdown] {
        var counts: [String: (label: String, count: Int)] = [:]
        for row in rows {
            guard let resolved = label(row) ?? fallback else { continue }
            let key = resolved.lowercased()
            let current = counts[key] ?? (resolved, 0)
            counts[key] = (current.label, current.count + 1)
        }
        return counts.values
            .map { AdminCampaignBreakdown(label: $0.label, count: $0.count) }
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    private static func clean(_ value: String?) -> String? {
        let cleaned = value?.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") ?? ""
        return cleaned.isEmpty ? nil : cleaned
    }

    private static func dateKey(_ date: Date, calendar: Calendar) -> String? {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func csvField(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\"", with: "\"\"")
        return escaped.contains(",") || escaped.contains("\"") || escaped.contains("\n") ? "\"\(escaped)\"" : escaped
    }
}

enum AdminSiteContentSection: String, CaseIterable, Identifiable, Codable {
    case hero
    case booking
    case about
    case contact
    case faq

    var id: String { rawValue }
    var title: String {
        switch self {
        case .hero: return "Homepage Hero"
        case .booking: return "Booking Page Intro"
        case .about: return "About Page"
        case .contact: return "Contact Details"
        case .faq: return "FAQ"
        }
    }
    var summary: String {
        switch self {
        case .hero: return "Headline, supporting copy and rotating photography"
        case .booking: return "Opening copy above packs and bookings"
        case .about: return "The public story and training philosophy"
        case .contact: return "Public contact details, location and Instagram"
        case .faq: return "Homepage questions and answers"
        }
    }
    var icon: String {
        switch self {
        case .hero: return "house"
        case .booking: return "ticket"
        case .about: return "doc.text"
        case .contact: return "phone"
        case .faq: return "questionmark.circle"
        }
    }
    var publicPath: String {
        switch self {
        case .hero, .faq: return ""
        case .booking: return "booking"
        case .about: return "about"
        case .contact: return "contact"
        }
    }
}

struct AdminFAQItem: Codable, Hashable, Identifiable {
    var id = UUID()
    var q: String
    var a: String

    private enum CodingKeys: String, CodingKey { case q, a }

    init(id: UUID = UUID(), q: String, a: String) {
        self.id = id
        self.q = q
        self.a = a
    }

    static func == (lhs: AdminFAQItem, rhs: AdminFAQItem) -> Bool {
        lhs.q == rhs.q && lhs.a == rhs.a
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(q)
        hasher.combine(a)
    }
}

struct AdminSiteContentData: Codable, Hashable {
    var headline: String?
    var subheading: String?
    var supporting: String?
    var photos: [String]?
    var intro: String?
    var paragraphs: [String]?
    var email: String?
    var phone: String?
    var address: String?
    var instagram_handle: String?
    var instagram_url: String?
    var items: [AdminFAQItem]?

    init(
        headline: String? = nil,
        subheading: String? = nil,
        supporting: String? = nil,
        photos: [String]? = nil,
        intro: String? = nil,
        paragraphs: [String]? = nil,
        email: String? = nil,
        phone: String? = nil,
        address: String? = nil,
        instagram_handle: String? = nil,
        instagram_url: String? = nil,
        items: [AdminFAQItem]? = nil
    ) {
        self.headline = headline
        self.subheading = subheading
        self.supporting = supporting
        self.photos = photos
        self.intro = intro
        self.paragraphs = paragraphs
        self.email = email
        self.phone = phone
        self.address = address
        self.instagram_handle = instagram_handle
        self.instagram_url = instagram_url
        self.items = items
    }

    func merged(over fallback: AdminSiteContentData) -> AdminSiteContentData {
        AdminSiteContentData(
            headline: headline ?? fallback.headline,
            subheading: subheading ?? fallback.subheading,
            supporting: supporting ?? fallback.supporting,
            photos: photos ?? fallback.photos,
            intro: intro ?? fallback.intro,
            paragraphs: paragraphs ?? fallback.paragraphs,
            email: email ?? fallback.email,
            phone: phone ?? fallback.phone,
            address: address ?? fallback.address,
            instagram_handle: instagram_handle ?? fallback.instagram_handle,
            instagram_url: instagram_url ?? fallback.instagram_url,
            items: items ?? fallback.items
        )
    }

    func normalized(for section: AdminSiteContentSection) throws -> AdminSiteContentData {
        switch section {
        case .hero:
            guard (photos ?? []).count <= 12 else {
                throw APIError(message: "Hero photography is limited to 12 images.")
            }
            return AdminSiteContentData(
                headline: try Self.bounded(headline, maximum: 160, label: "Headline"),
                subheading: try Self.bounded(subheading, maximum: 1_000, label: "Subheading"),
                supporting: try Self.bounded(supporting, maximum: 1_000, label: "Supporting line"),
                photos: try Self.cleanURLs(photos, allowLocal: true)
            )
        case .booking:
            return AdminSiteContentData(
                intro: try Self.bounded(intro, maximum: 3_000, label: "Booking introduction")
            )
        case .about:
            guard (paragraphs ?? []).count <= 12 else {
                throw APIError(message: "The About page is limited to 12 paragraphs.")
            }
            let values = try paragraphs?.compactMap {
                try Self.bounded($0, maximum: 4_000, label: "About paragraph")
            }
            return AdminSiteContentData(paragraphs: values?.isEmpty == false ? values : nil)
        case .contact:
            let cleanEmail = try Self.bounded(email, maximum: 254, label: "Email")
            if let cleanEmail,
               cleanEmail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) == nil {
                throw APIError(message: "Enter a valid public contact email.")
            }
            let instagramURL = try Self.cleanURLs(instagram_url.map { [$0] }, allowLocal: false)?.first
            return AdminSiteContentData(
                intro: try Self.bounded(intro, maximum: 3_000, label: "Contact introduction"),
                email: cleanEmail,
                phone: try Self.bounded(phone, maximum: 80, label: "Phone"),
                address: try Self.bounded(address, maximum: 500, label: "Address"),
                instagram_handle: try Self.bounded(instagram_handle, maximum: 100, label: "Instagram handle"),
                instagram_url: instagramURL
            )
        case .faq:
            guard (items ?? []).count <= 20 else {
                throw APIError(message: "The homepage is limited to 20 FAQ items.")
            }
            let entered = try (items ?? []).compactMap { item -> AdminFAQItem? in
                let question = try Self.bounded(item.q, maximum: 300, label: "FAQ question")
                let answer = try Self.bounded(item.a, maximum: 3_000, label: "FAQ answer")
                return question == nil && answer == nil ? nil : AdminFAQItem(id: item.id, q: question ?? "", a: answer ?? "")
            }
            guard entered.allSatisfy({ !$0.q.isEmpty && !$0.a.isEmpty }) else {
                throw APIError(message: "Every FAQ item needs both a question and an answer.")
            }
            return AdminSiteContentData(items: entered.isEmpty ? nil : entered)
        }
    }

    static func defaults(for section: AdminSiteContentSection) -> AdminSiteContentData {
        switch section {
        case .hero:
            return AdminSiteContentData(
                headline: "Beat Your Best.",
                subheading: "Structured functional fitness coaching designed for strength, conditioning, movement quality and long-term performance.",
                supporting: "Semi-private training in Kingaroy with real coaching, progressive programming and sustainable progress.",
                photos: [
                    "/assets/hero-training-1.jpg", "/assets/hero-training-2.jpg", "/assets/training-style.jpg",
                    "/assets/training-philosophy.jpg", "/assets/event-calendar.jpg"
                ]
            )
        case .booking:
            return AdminSiteContentData(intro: "XERT operates through a booking-based system to maintain coaching quality and controlled class sizes. Initial class sizes are set to 8 people and will gradually increase as the business launches.")
        case .about:
            return AdminSiteContentData(paragraphs: [
                "XERT Fitness is a semi-private functional fitness studio based in Kingaroy, Queensland. We exist to help everyday people through to athletes train with structure and purpose. Every class at XERT is coached and deliberately programmed, blending strength, conditioning, movement quality and long-term performance.",
                "Our programming follows the South East Queensland sporting and fitness calendar, so members always have a real goal ahead of them. Whether you are training for general fitness, preparing for a specific event, or chasing a strength milestone, your coach leads every session and helps you understand what the goal in front of you requires.",
                "The training system combines structured functional fitness classes, an accessory training area, and support for health, performance, recovery and nutrition. Sessions are scalable, booking-based and designed to maintain coaching quality while helping members train consistently.",
                "XERT is built around a simple philosophy: train for life, compete for fun. Members choose events, train together and build toward shared goals throughout the year."
            ])
        case .contact:
            return AdminSiteContentData(
                intro: "Have a question about classes, coaching, allied health partnerships or booking your first session? Reach out and we will help you plan your training.",
                email: "byronhawley@gmail.com", phone: "", address: "Kingaroy, Queensland 4610",
                instagram_handle: "@xert_fit", instagram_url: "https://instagram.com/xert_fit"
            )
        case .faq:
            return AdminSiteContentData(items: [
                AdminFAQItem(q: "When is XERT opening?", a: "Soft launch is planned for August. We'll open in stages — limited class capacity at first, building out as demand and space allow. Register your foundation interest to be notified first."),
                AdminFAQItem(q: "What classes will be available?", a: "XERT offers structured functional training across strength, aerobic capacity, threshold and intensive sessions. Classes follow progressive training blocks and are coached so members understand the purpose of each session."),
                AdminFAQItem(q: "Do I need to be fit to join?", a: "No. XERT is built for all levels — from complete beginners to experienced athletes. Coaches scale every session to the individual. The most important thing is showing up and committing to the process."),
                AdminFAQItem(q: "What is the event prep focus?", a: "XERT follows the South East Queensland sporting and fitness calendar. Members can choose from endurance races, triathlons, trail runs, functional fitness events, local sport and XERT challenges, then train toward those goals together."),
                AdminFAQItem(q: "Is there personal training available?", a: "Yes. 1-on-1 personal training sessions will be available in addition to group classes. You can request a PT session through the timetable page."),
                AdminFAQItem(q: "What allied health services will be available?", a: "XERT is building relationships with physiotherapists, nutritionists, psychologists and other practitioners who will operate inside the facility. This means recovery, injury management and performance support are available without leaving the building."),
                AdminFAQItem(q: "Where is XERT located?", a: "XERT is based in Kingaroy, Queensland 4610. The facility includes a main class training area, accessory training space, onsite parking, bathroom and changeroom access."),
                AdminFAQItem(q: "How do I book my first session?", a: "Create a free account, purchase a class pass or pack on the booking page, then pick your class from the timetable. Your first session is coached end-to-end — arrive 10 minutes early and we will look after the rest.")
            ])
        }
    }

    private static func clean(_ value: String?) -> String? {
        let cleaned = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return cleaned.isEmpty ? nil : cleaned
    }

    private static func bounded(_ value: String?, maximum: Int, label: String) throws -> String? {
        guard let cleaned = clean(value) else { return nil }
        guard cleaned.count <= maximum else {
            throw APIError(message: "\(label) must be \(maximum.formatted()) characters or fewer.")
        }
        return cleaned
    }

    private static func cleanURLs(_ values: [String]?, allowLocal: Bool) throws -> [String]? {
        var result: [String] = []
        for value in values ?? [] {
            guard let cleaned = clean(value) else { continue }
            guard cleaned.count <= 2_048 else {
                throw APIError(message: "Public media URLs must be 2,048 characters or fewer.")
            }
            if allowLocal, cleaned.hasPrefix("/"), !cleaned.hasPrefix("//") {
                result.append(cleaned)
                continue
            }
            guard let components = URLComponents(string: cleaned),
                  ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
                  components.host != nil else {
                throw APIError(message: "URL must use HTTPS or HTTP: \(cleaned)")
            }
            result.append(components.url?.absoluteString ?? cleaned)
        }
        return result.isEmpty ? nil : result
    }
}

struct AdminSiteContentRow: Identifiable, Codable, Hashable {
    let key: String
    let data: AdminSiteContentData
    let updated_at: String
    var id: String { key }
}

enum AdminSiteContentDraftStore {
    private static let prefix = "xert.admin.site-content.draft."
    private static func legacyKey(_ section: AdminSiteContentSection) -> String {
        prefix + section.rawValue
    }

    private static func key(_ section: AdminSiteContentSection, ownerID: UUID) -> String {
        prefix + ownerID.uuidString.lowercased() + "." + section.rawValue
    }

    static func load(
        _ section: AdminSiteContentSection,
        ownerID: UUID?,
        defaults: UserDefaults = .standard
    ) -> AdminSiteContentData? {
        // Unscoped drafts may contain another owner's unpublished copy.
        defaults.removeObject(forKey: legacyKey(section))
        guard let ownerID else { return nil }
        return defaults.data(forKey: key(section, ownerID: ownerID))
            .flatMap { try? JSONDecoder().decode(AdminSiteContentData.self, from: $0) }
    }

    static func save(
        _ data: AdminSiteContentData,
        section: AdminSiteContentSection,
        ownerID: UUID?,
        defaults: UserDefaults = .standard
    ) {
        guard let ownerID, let encoded = try? JSONEncoder().encode(data) else { return }
        defaults.set(encoded, forKey: key(section, ownerID: ownerID))
    }

    static func clear(
        _ section: AdminSiteContentSection,
        ownerID: UUID?,
        defaults: UserDefaults = .standard
    ) {
        defaults.removeObject(forKey: legacyKey(section))
        guard let ownerID else { return }
        defaults.removeObject(forKey: key(section, ownerID: ownerID))
    }

    static func clearAll(
        ownerID: UUID?,
        defaults: UserDefaults = .standard
    ) {
        for section in AdminSiteContentSection.allCases {
            clear(section, ownerID: ownerID, defaults: defaults)
        }
    }
}

struct AdminBookingSession: Codable, Hashable {
    let title: String
    let start_time: Date?
    let coach_name: String?
    let location_zone: String?
}

struct AdminLegacyBookingRequest: Codable, Hashable {
    let id: AdminLeadIdentifier
    let full_name: String?
    let email: String?
    let phone: String?
    let status: String
    let admin_notes: String?
    let created_at: Date
    let class_sessions: AdminBookingSession?
}

struct AdminMemberBookingRequest: Codable, Hashable {
    let id: UUID
    let user_id: UUID
    let status: String
    let created_at: Date
    let credit_batch_id: UUID?
    let class_sessions: AdminBookingSession?
}

struct AdminBookingProfile: Identifiable, Codable, Hashable {
    let id: UUID
    let full_name: String?
    let email: String?
    let phone: String?
}

enum AdminBookingRequestSource: String, CaseIterable, Identifiable, Hashable {
    case member
    case enquiry
    var id: String { rawValue }
    var label: String { self == .member ? "Member credit" : "Enquiry form" }
}

struct AdminBookingRequest: Identifiable, Hashable {
    let source: AdminBookingRequestSource
    let recordID: String
    let memberBookingID: UUID?
    let fullName: String
    let email: String?
    let phone: String?
    let status: String
    let adminNotes: String?
    let createdAt: Date
    let creditBatchID: UUID?
    let session: AdminBookingSession?

    var id: String { "\(source.rawValue):\(recordID)" }
    var routeRecordID: UUID? { memberBookingID ?? UUID(uuidString: recordID) }
    var searchableText: String {
        [fullName, email, phone, session?.title, session?.coach_name, session?.location_zone]
            .compactMap { $0 }.joined(separator: " ").lowercased()
    }
    var allowedNextStatuses: [String] {
        switch status {
        case "requested": return ["confirmed", "waitlisted", "declined", "cancelled"]
        // Promoting the head of the queue is the point of a waitlist; the
        // database still enforces the order.
        case "waitlisted": return ["confirmed", "declined", "cancelled"]
        case "confirmed": return ["attended", "no_show", "cancelled"]
        case "attended", "no_show": return ["confirmed"]
        case "declined", "cancelled": return ["requested"]
        default: return []
        }
    }
}

struct AdminBookingRequestReport {
    let rows: [AdminBookingRequest]

    var csv: String {
        let header = [
            "Requested", "Source", "Status", "Name", "Email", "Phone",
            "Class", "Class start", "Coach", "Location", "Credit reserved"
        ]
        let formatter = ISO8601DateFormatter()
        let body = rows.map { booking in
            [
                formatter.string(from: booking.createdAt),
                booking.source == .member ? "Member credit booking" : "Enquiry form",
                booking.status,
                booking.fullName,
                booking.email ?? "",
                booking.phone ?? "",
                booking.session?.title ?? "",
                (booking.session?.start_time).map { formatter.string(from: $0) } ?? "",
                booking.session?.coach_name ?? "",
                booking.session?.location_zone ?? "",
                booking.creditBatchID == nil ? "No" : "Yes"
            ]
            .map(Self.escape)
            .joined(separator: ",")
        }
        return ([header.map(Self.escape).joined(separator: ",")] + body).joined(separator: "\n") + "\n"
    }

    private static func escape(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

struct AdminAnnouncement: Identifiable, Codable, Hashable {
    let id: UUID
    let title: String
    let body: String
    let tone: String
    let audience: String
    let cta_label: String?
    let cta_url: String?
    let published_at: Date?
    let first_published_at: Date?
    let expires_at: Date?
    let archived_at: Date?
    let created_at: Date
    let updated_at: String

    func stateLabel(now: Date = Date()) -> String {
        if archived_at != nil { return "Archived" }
        guard let published_at else { return "Draft" }
        if published_at > now { return "Scheduled" }
        if let expires_at, expires_at <= now { return "Expired" }
        return "Live"
    }

    var stateLabel: String { stateLabel() }
    var wasPublished: Bool { first_published_at != nil || published_at != nil }
}

struct AdminAnnouncementDraft: Codable, Hashable {
    static let memberOperationsPausedTitle = "Bookings and checkout temporarily paused"
    static let memberBookingsRestoredTitle = "Bookings are available again"
    static let memberCommerceRestoredTitle = "Bookings and checkout are available again"

    var title = ""
    var body = ""
    var tone = "info"
    var ctaLabel = ""
    var ctaURL = ""
    var expiresAt: Date?

    init() {}

    init(announcement: AdminAnnouncement) {
        title = announcement.title
        body = announcement.body
        tone = announcement.tone
        ctaLabel = announcement.cta_label ?? ""
        ctaURL = announcement.cta_url ?? ""
        expiresAt = announcement.expires_at
    }

    static func memberOperationsPaused() -> Self {
        var draft = Self()
        draft.title = memberOperationsPausedTitle
        draft.body = """
        We have temporarily paused new bookings, waitlist joins and session-pack checkout while we complete a platform check.

        Existing bookings remain confirmed. We will post another update as soon as new bookings and checkout resume.
        """
        draft.tone = "urgent"
        return draft
    }

    static func memberOperationsRestored(checkoutAvailable: Bool) -> Self {
        var draft = Self()
        draft.title = checkoutAvailable
            ? memberCommerceRestoredTitle
            : memberBookingsRestoredTitle
        draft.body = checkoutAvailable
            ? """
              New bookings, waitlist joins and session-pack checkout are available again.

              Existing bookings were not affected. Thank you for your patience while we completed our platform checks.
              """
            : """
              New bookings and waitlist joins are available again.

              Session-pack checkout remains temporarily paused while we complete our payment checks. Existing bookings were not affected.
              """
        draft.tone = "info"
        draft.ctaLabel = "Book a class"
        draft.ctaURL = "/booking"
        return draft
    }

    func validationMessage(publishing: Bool, now: Date = Date()) -> String? {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedLabel = ctaLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedURL = ctaURL.trimmingCharacters(in: .whitespacesAndNewlines)

        guard (1...120).contains(normalizedTitle.count) else {
            return "Title must be between 1 and 120 characters."
        }
        guard (1...2_000).contains(normalizedBody.count) else {
            return "Message must be between 1 and 2,000 characters."
        }
        guard ["info", "action", "urgent"].contains(tone) else {
            return "Choose a valid priority."
        }
        guard normalizedLabel.isEmpty == normalizedURL.isEmpty else {
            return "Action label and destination must be provided together."
        }
        guard normalizedLabel.count <= 40 else {
            return "Action label must be 40 characters or fewer."
        }
        if !normalizedURL.isEmpty && !Self.isValidActionURL(normalizedURL) {
            return "Action destination must be an internal path or a secure HTTPS URL."
        }
        if publishing, let expiresAt, expiresAt <= now {
            return "Choose a future expiry before publishing."
        }
        return nil
    }

    private static func isValidActionURL(_ value: String) -> Bool {
        if value.hasPrefix("/") && !value.hasPrefix("//") { return value.count <= 500 }
        guard value.count <= 500,
              let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false,
              url.user == nil,
              url.password == nil else { return false }
        return true
    }
}

enum AdminIncidentCommunicationState: Equatable {
    case unavailable
    case normal
    case pausedNeedsUpdate
    case pausedUpdateLive
    case livePauseNoticeConflict
    case recoveryUpdateNeeded
    case recoveryUpdateLive
}

struct AdminIncidentCommunicationPlan {
    static let recoveryWindow: TimeInterval = 72 * 60 * 60

    let operationsState: AdminMemberOperationsState
    let announcements: [AdminAnnouncement]
    let sourceIsCurrent: Bool
    let now: Date

    init(
        operationsState: AdminMemberOperationsState,
        announcements: [AdminAnnouncement],
        sourceIsCurrent: Bool,
        now: Date = Date()
    ) {
        self.operationsState = operationsState
        self.announcements = announcements
        self.sourceIsCurrent = sourceIsCurrent
        self.now = now
    }

    var state: AdminIncidentCommunicationState {
        guard sourceIsCurrent else { return .unavailable }
        switch operationsState {
        case .unavailable:
            return .unavailable
        case .paused:
            return livePauseNotice == nil ? .pausedNeedsUpdate : .pausedUpdateLive
        case .bookingsOpen, .liveCommerce:
            if livePauseNotice != nil { return .livePauseNoticeConflict }
            guard let pauseDate = latestRecentPauseDate else { return .normal }
            return liveRecoveryNotice(after: pauseDate) == nil
                ? .recoveryUpdateNeeded
                : .recoveryUpdateLive
        case .inconsistent:
            return .normal
        }
    }

    var actionNoticeID: UUID? {
        switch state {
        case .pausedUpdateLive, .livePauseNoticeConflict:
            return livePauseNotice?.id
        case .recoveryUpdateLive:
            guard let pauseDate = latestRecentPauseDate else { return nil }
            return liveRecoveryNotice(after: pauseDate)?.id
        case .unavailable, .normal, .pausedNeedsUpdate, .recoveryUpdateNeeded:
            return nil
        }
    }

    private var livePauseNotice: AdminAnnouncement? {
        announcements
            .filter { $0.stateLabel(now: now) == "Live" && matchesPauseNotice($0) }
            .max { noticeDate($0) < noticeDate($1) }
    }

    private var latestRecentPauseDate: Date? {
        announcements
            .filter(matchesPauseNotice)
            .map(noticeDate)
            .filter { date in
                let age = now.timeIntervalSince(date)
                return age >= 0 && age <= Self.recoveryWindow
            }
            .max()
    }

    private func liveRecoveryNotice(after pauseDate: Date) -> AdminAnnouncement? {
        announcements
            .filter {
                $0.stateLabel(now: now) == "Live"
                    && matchesRecoveryNotice($0)
                    && noticeDate($0) >= pauseDate
            }
            .max { noticeDate($0) < noticeDate($1) }
    }

    private func matchesPauseNotice(_ notice: AdminAnnouncement) -> Bool {
        notice.title.caseInsensitiveCompare(
            AdminAnnouncementDraft.memberOperationsPausedTitle
        ) == .orderedSame
            || notice.body.localizedCaseInsensitiveContains(
                "temporarily paused new bookings, waitlist joins and session-pack checkout"
            )
    }

    private func matchesRecoveryNotice(_ notice: AdminAnnouncement) -> Bool {
        switch operationsState {
        case .bookingsOpen:
            return notice.title.caseInsensitiveCompare(
                AdminAnnouncementDraft.memberBookingsRestoredTitle
            ) == .orderedSame
                || notice.body.localizedCaseInsensitiveContains(
                    "new bookings and waitlist joins are available again"
                )
        case .liveCommerce:
            return notice.title.caseInsensitiveCompare(
                AdminAnnouncementDraft.memberCommerceRestoredTitle
            ) == .orderedSame
                || notice.body.localizedCaseInsensitiveContains(
                    "new bookings, waitlist joins and session-pack checkout are available again"
                )
        case .unavailable, .paused, .inconsistent:
            return false
        }
    }

    private func noticeDate(_ notice: AdminAnnouncement) -> Date {
        notice.published_at ?? notice.first_published_at ?? notice.created_at
    }
}

struct AdminAnnouncementPushSummary: Codable, Hashable {
    let configured: Bool
    let attempted: Int
    let delivered: Int
    let failed: Int
}

struct AdminAnnouncementPublishOutcome: Codable, Hashable {
    let announcement: AdminAnnouncement
    let push: AdminAnnouncementPushSummary
}

struct AdminAnnouncementReceiptMetrics: Codable, Hashable {
    let announcement_id: UUID
    let read_count: Int
    let dismissed_count: Int
}

struct AdminAnnouncementPushMetrics: Codable, Hashable {
    let announcement_id: UUID
    let delivered_count: Int
    let failed_count: Int
    let invalid_token_count: Int
    let last_attempted_at: Date?
}

struct AdminAnnouncementDeliveryMetrics: Hashable {
    var readCount = 0
    var dismissedCount = 0
    var pushDeliveredCount = 0
    var pushFailedCount = 0
    var pushLastAttemptedAt: Date?

    var pushAttemptedCount: Int {
        pushDeliveredCount + pushFailedCount
    }
}

private extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

struct AdminSchemaCapability: Codable, Hashable {
    let capability: String
    let installed_at: Date?
}

struct AdminEnvironmentHealth: Codable, Hashable {
    let ready: Bool
    let missing: [String]
}

struct AdminCommerceHealth: Codable, Hashable {
    struct Issue: Codable, Hashable {
        let slug: String
        let reason: String
    }

    struct Webhook: Codable, Hashable {
        let ready: Bool
        let missing_events: [String]
        let issue: String?
    }

    struct StripeAccount: Codable, Hashable {
        let ready: Bool
        let charges_enabled: Bool?
        let payouts_enabled: Bool?
        let details_submitted: Bool?
        let country: String?
        let default_currency: String?
    }

    struct WebhookDelivery: Codable, Hashable {
        struct Incident: Codable, Hashable, Identifiable {
            let event_id: String
            let event_type: String
            let status: String
            let attempts: Int
            let order_id: UUID?
            let last_received_at: Date?
            let error_code: String?
            let resolution: String?

            var id: String { event_id }
        }

        let ready: Bool
        let available: Bool
        let received: Int
        let failed: Int
        let stale_processing: Int
        let retries: Int
        let incidents: [Incident]?
        let issue: String?
    }

    struct PaymentSwitch: Codable, Hashable {
        let ready: Bool
        let state: String
        let updated_at: Date?
    }

    struct ActivationReceipt: Codable, Hashable {
        let required: Bool
        let ready: Bool
        let activated_at: Date?
        let actor_recorded: Bool
        let issue: String?
    }

    let ready: Bool
    let active_product_count: Int
    let stripe_price_count: Int
    let dynamic_price_count: Int
    let environment: AdminEnvironmentHealth
    let fulfillment_ready: Bool?
    let refund_reconciliation_ready: Bool?
    let checkout_reconciliation_ready: Bool?
    let activation_guard_ready: Bool?
    let settings_contract_ready: Bool?
    let activation_drift_guard_ready: Bool?
    let pending_order_guard_ready: Bool?
    let order_terms_ready: Bool?
    let webhook_ledger_ready: Bool?
    let webhook_delivery: WebhookDelivery?
    let payment_switch: PaymentSwitch?
    let activation_receipt: ActivationReceipt?
    let mode: String?
    let account: StripeAccount?
    let webhook: Webhook?
    let issues: [Issue]?
}

struct AdminPushHealth: Codable, Hashable {
    struct Subscriptions: Codable, Hashable {
        let production: Int
        let sandbox: Int
        let disabled: Int
    }
    struct Deliveries: Codable, Hashable {
        let delivered: Int
        let failed: Int
        let invalid_token: Int
    }
    struct LastAttempt: Codable, Hashable {
        let status: String
        let reason: String?
        let attempted_at: Date
    }

    let ready: Bool
    let environment: AdminEnvironmentHealth
    let subscriptions: Subscriptions
    let deliveries_24h: Deliveries
    let last_attempt: LastAttempt?
    let owner_smoke_test: LastAttempt?

    func isOwnerLaunchReady(at now: Date = Date()) -> Bool {
        guard ready, subscriptions.production > 0,
              let smokeTest = owner_smoke_test else { return false }
        let age = now.timeIntervalSince(smokeTest.attempted_at)
        return smokeTest.status == "delivered" && age >= -300 && age <= 24 * 60 * 60
    }
}

struct AdminOwnerPushSmokeTestResult: Codable, Hashable {
    let request_id: UUID
    let configured: Bool
    let attempted: Int
    let delivered: Int
    let failed: Int
}

enum AdminSchemaReadiness {
    static let required: Set<String> = [
        "admin_role_safety", "audited_credit_grants", "booking_waitlist_withdrawal",
        "member_cancellation_receipt",
        "member_booking_switch_guard",
        "member_waitlist_join", "waitlist_fifo_promotion", "attendance_roll_call",
        "attendance_request_resolution_guard",
        "class_session_update_guard", "product_update_guard", "stripe_refund_reconciliation",
        "checkout_reconciliation", "stripe_payment_fulfillment", "guarded_payment_activation",
        "payment_activation_drift_guard",
        "admin_settings_singleton",
        "stripe_pending_order_guard",
        "stripe_order_terms_snapshot",
        "stripe_webhook_ledger",
        "member_announcements", "announcement_receipts",
        "announcement_actions", "announcement_archival", "booking_time_conflict_guard",
        "admin_member_notes", "schedule_blackout_guard", "database_security_hardening",
        "rls_policy_performance", "request_status_audit", "member_push_notifications",
        "credit_expiry_follow_up", "member_pt_request_tracking", "public_form_integrity",
        "lead_pipeline_audit", "schedule_change_audit", "content_change_audit",
        "booking_lifecycle_audit", "class_cancellation_notifications", "admin_daily_operations",
        "schedule_optimistic_locking", "shared_admin_optimistic_locking",
        "catalog_optimistic_locking", "product_commercial_terms_guard", "targeted_member_notices",
        "waitlist_promotion_notifications",
        "booking_decision_notifications",
        "staff_assisted_booking",
        "member_onboarding_foundation", "member_activation_cockpit",
        "forms_surveys_builder", "form_response_snapshots",
        "fitbox_zapier_bridge", "fitbox_get_user_refresh"
    ]

    static func missing(from rows: [AdminSchemaCapability]) -> [String] {
        let installed = Set(rows.map(\.capability))
        return required.subtracting(installed).sorted()
    }
}

struct AdminAuditEntry: Identifiable, Hashable {
    let id: String
    let category: String
    let title: String
    let detail: String
    let createdAt: Date
    let operatorID: UUID?
    let subjectID: String?

    init(
        id: String,
        category: String,
        title: String,
        detail: String,
        createdAt: Date,
        operatorID: UUID? = nil,
        subjectID: String? = nil
    ) {
        self.id = id
        self.category = category
        self.title = title
        self.detail = detail
        self.createdAt = createdAt
        self.operatorID = operatorID
        self.subjectID = subjectID
    }
}

struct AdminAuditSnapshot {
    let entries: [AdminAuditEntry]
    let unavailableSources: [String]

    var isComplete: Bool { unavailableSources.isEmpty }
}

struct AdminAuditSummary: Equatable {
    let total: Int
    let last24Hours: Int
    let moneyActions: Int
    let identifiedOperators: Int

    init(entries: [AdminAuditEntry], now: Date = Date()) {
        total = entries.count
        last24Hours = entries.lazy.filter {
            $0.createdAt >= now.addingTimeInterval(-86_400) && $0.createdAt <= now
        }.count
        moneyActions = entries.lazy.filter {
            $0.category == "Commerce" || $0.category == "Credits"
        }.count
        identifiedOperators = Set(entries.compactMap(\.operatorID)).count
    }
}

struct AdminAuditExport {
    let entries: [AdminAuditEntry]

    var csv: String {
        let header = "Created,Category,Action,Detail,Operator ID,Subject ID"
        let rows = entries
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(300)
            .map { entry in
                [
                    ISO8601DateFormatter().string(from: entry.createdAt),
                    entry.category,
                    entry.title,
                    entry.detail,
                    entry.operatorID?.uuidString.lowercased() ?? "",
                    entry.subjectID ?? ""
                ]
                .map(Self.csvField)
                .joined(separator: ",")
            }
        return ([header] + rows).joined(separator: "\n")
    }

    private static func csvField(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }
}

struct AdminProduct: Identifiable, Codable, Hashable {
    let id: UUID
    let slug: String
    let name: String
    let description: String?
    let price_cents: Int
    let currency: String
    let sessions_count: Int
    let validity_days: Int
    let stripe_price_id: String?
    let featured: Bool
    let active: Bool
    let sort_order: Int
    let updated_at: String

    var displayPrice: String { (Double(price_cents) / 100).formatted(.currency(code: currency.uppercased())) }
    var displayPricePerSession: String {
        guard sessions_count > 0 else { return displayPrice }
        return (Double(price_cents) / 100 / Double(sessions_count))
            .formatted(.currency(code: currency.uppercased()))
    }
    var hasStableStripePriceID: Bool {
        guard let stripePriceID = stripe_price_id?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return stripePriceID.range(of: #"^price_[A-Za-z0-9]+$"#, options: .regularExpression) != nil
    }
}

struct AdminProductDraft: Codable, Hashable {
    static let maximumPriceCents = Int(Int32.max)

    var slug: String
    var name: String
    var description: String
    var price: String
    var currency: String
    var sessions: Int
    var validityDays: Int
    var stripePriceID: String
    var featured: Bool
    var active: Bool
    var sortOrder: Int

    init(product: AdminProduct) {
        slug = product.slug
        name = product.name
        description = product.description ?? ""
        price = String(format: "%.2f", Double(product.price_cents) / 100)
        currency = product.currency.uppercased()
        sessions = product.sessions_count
        validityDays = product.validity_days
        stripePriceID = product.stripe_price_id ?? ""
        featured = product.featured
        active = product.active
        sortOrder = product.sort_order
    }

    init(suggestedSortOrder: Int = 0) {
        slug = ""
        name = ""
        description = ""
        price = ""
        currency = "AUD"
        sessions = 1
        validityDays = 28
        stripePriceID = ""
        featured = false
        active = false
        sortOrder = suggestedSortOrder
    }

    var normalizedPriceCents: Int? {
        let value = price.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^\d+(?:[\.,]\d{1,2})?$"#, options: .regularExpression) != nil else {
            return nil
        }
        let components = value.split(whereSeparator: { $0 == "." || $0 == "," })
        guard let dollars = Int(components[0]), dollars <= Self.maximumPriceCents / 100 else { return nil }
        let fraction = components.count == 2 ? String(components[1]) : ""
        let cents = Int(fraction.padding(toLength: 2, withPad: "0", startingAt: 0)) ?? 0
        let total = dollars * 100 + cents
        return total > 0 && total <= Self.maximumPriceCents ? total : nil
    }

    func validationMessage(existingProduct: AdminProduct?) -> String? {
        let normalizedSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if existingProduct == nil,
           (normalizedSlug.count > 80 || normalizedSlug.range(of: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) == nil) {
            return "Use a permanent ID made from lowercase letters, numbers and single hyphens."
        }
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedName.isEmpty { return "Add a name for this session pack." }
        if normalizedName.count > 120 { return "Keep the pack name to 120 characters or fewer." }
        if description.trimmingCharacters(in: .whitespacesAndNewlines).count > 2_000 {
            return "Keep the description to 2,000 characters or fewer."
        }
        guard normalizedPriceCents != nil else {
            return "Enter a positive price up to 21,474,836.47 with no more than two decimal places."
        }
        guard (1...1_000).contains(sessions) else { return "Sessions must be between 1 and 1,000." }
        guard (1...3_650).contains(validityDays) else { return "Validity must be between 1 and 3,650 days." }
        guard (0...10_000).contains(sortOrder) else { return "Display order must be between 0 and 10,000." }

        let normalizedCurrency = currency.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedCurrency.range(of: #"^[a-z]{3}$"#, options: .regularExpression) != nil else {
            return "Use a three-letter currency code such as AUD."
        }
        let normalizedStripeID = stripePriceID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedStripeID.isEmpty,
           normalizedStripeID.range(of: #"^price_[A-Za-z0-9]+$"#, options: .regularExpression) == nil {
            return "Stripe Price ID must begin with price_ and contain only letters and numbers."
        }
        if active && normalizedStripeID.isEmpty {
            return "Add a Stripe Price ID before making this pack active and purchasable."
        }
        if let existingProduct,
           let currentStripeID = existingProduct.stripe_price_id?.trimmingCharacters(in: .whitespacesAndNewlines),
           !currentStripeID.isEmpty,
           currentStripeID == normalizedStripeID,
           (existingProduct.price_cents != normalizedPriceCents
            || existingProduct.currency.lowercased() != normalizedCurrency
            || existingProduct.sessions_count != sessions
            || existingProduct.validity_days != validityDays) {
            return "Clear or replace the Stripe Price ID before changing price, currency, sessions or validity."
        }
        return nil
    }
}

struct AdminEvent: Identifiable, Codable, Hashable {
    let id: UUID
    let name: String
    let category: String?
    let event_date: String?
    let end_date: String?
    let location: String?
    let region: String?
    let url: String?
    let published: Bool
    let sort_order: Int
    let updated_at: String
}

struct AdminEventDraft: Codable, Hashable {
    static let categories = [
        "run", "marathon", "triathlon", "ironman", "ultra", "trail", "cycling",
        "fitness", "hyrox", "crossfit", "functional", "swim", "spartan",
        "adventure", "games", "community", "sport", "xert", "other"
    ]

    var name: String
    var category: String
    var hasStartDate: Bool
    var startDate: Date
    var hasEndDate: Bool
    var endDate: Date
    var location: String
    var region: String
    var url: String
    var published: Bool
    var sortOrder: Int

    init(event: AdminEvent? = nil, now: Date = Date()) {
        let fallback = Self.calendar.startOfDay(for: now)
        let parsedStart = event?.event_date.flatMap { Self.dateFormatter.date(from: $0) }
        let parsedEnd = event?.end_date.flatMap { Self.dateFormatter.date(from: $0) }
        name = event?.name ?? ""
        category = event?.category ?? "run"
        hasStartDate = parsedStart != nil
        startDate = parsedStart ?? fallback
        hasEndDate = parsedEnd != nil
        endDate = parsedEnd ?? parsedStart ?? fallback
        location = event?.location ?? ""
        region = event?.region ?? "South East Queensland"
        url = event?.url ?? ""
        published = event?.published ?? true
        sortOrder = event?.sort_order ?? 0
    }

    init(seed event: EventItem, now: Date = Date()) {
        let fallback = Self.calendar.startOfDay(for: now)
        let parsedStart = event.event_date.flatMap { Self.dateFormatter.date(from: $0) }
        let parsedEnd = event.end_date.flatMap { Self.dateFormatter.date(from: $0) }
        name = event.name
        category = event.category ?? "other"
        hasStartDate = parsedStart != nil
        startDate = parsedStart ?? fallback
        hasEndDate = parsedEnd != nil
        endDate = parsedEnd ?? parsedStart ?? fallback
        location = event.location ?? ""
        region = event.region ?? "South East Queensland"
        url = event.url ?? ""
        published = event.published ?? true
        sortOrder = event.sort_order ?? 0
    }

    var startDateValue: String? { hasStartDate ? Self.dateFormatter.string(from: startDate) : nil }
    var endDateValue: String? { hasEndDate ? Self.dateFormatter.string(from: endDate) : nil }

    private static let calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "Australia/Brisbane") ?? .current
        return value
    }()

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

struct AdminEventGoalReference: Codable {
    let event_id: UUID
}

struct AdminEventGoalMember: Identifiable, Codable, Hashable {
    let user_id: UUID
    let full_name: String?
    let email: String?
    let phone: String?
    let selected_at: Date

    var id: UUID { user_id }
    var displayName: String { full_name?.nilIfEmpty ?? email?.nilIfEmpty ?? "XERT member" }
}

struct AdminEventRosterReport {
    let event: AdminEvent
    let members: [AdminEventGoalMember]

    var csv: String {
        let header = "Event,Member,Email,Phone,Joined"
        let formatter = ISO8601DateFormatter()
        let body = members.map { member in
            [
                event.name,
                member.displayName,
                member.email ?? "",
                member.phone ?? "",
                formatter.string(from: member.selected_at)
            ]
            .map(Self.escape)
            .joined(separator: ",")
        }
        return ([header] + body).joined(separator: "\n") + "\n"
    }

    private static func escape(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

struct AdminCoach: Identifiable, Codable, Hashable {
    let id: UUID
    let name: String
    let role: String?
    let bio: String?
    let experience: String?
    let currently_training_for: String?
    let photo_url: String?
    let social_url: String?
    let category: String
    let sort_order: Int
    let published: Bool
    let updated_at: String
}

struct AdminCoachDraft: Codable, Hashable {
    static let categories = ["coach", "nutritionist", "massage", "physio"]
    var name: String
    var role: String
    var bio: String
    var experience: String
    var currentlyTrainingFor: String
    var photoURL: String
    var socialURL: String
    var category: String
    var sortOrder: Int
    var published: Bool

    init(coach: AdminCoach? = nil) {
        name = coach?.name ?? ""
        role = coach?.role ?? ""
        bio = coach?.bio ?? ""
        experience = coach?.experience ?? ""
        currentlyTrainingFor = coach?.currently_training_for ?? ""
        photoURL = coach?.photo_url ?? ""
        socialURL = coach?.social_url ?? ""
        category = coach?.category ?? "coach"
        sortOrder = coach?.sort_order ?? 0
        published = coach?.published ?? true
    }
}

struct AdminWorkoutOfDay: Identifiable, Codable, Hashable {
    static let titleLimit = 120
    static let bodyLimit = 4_000

    let workout_date: String
    let title: String?
    let body: String
    let published_at: Date?
    let created_by: UUID?
    let updated_at: String

    var id: String { workout_date }
    var isPublished: Bool { published_at != nil }

    var displayTitle: String {
        title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? body.split(whereSeparator: { $0.isNewline }).first.map(String.init)
            ?? "Workout"
    }

    static let brisbaneCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Australia/Brisbane") ?? .current
        return calendar
    }()

    static var brisbaneToday: Date {
        brisbaneCalendar.startOfDay(for: Date())
    }

    static func dateKey(for date: Date) -> String {
        dateFormatter.string(from: date)
    }

    static func date(from dateKey: String) -> Date? {
        guard dateKey.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
              let parsed = dateFormatter.date(from: dateKey),
              dateFormatter.string(from: parsed) == dateKey else {
            return nil
        }
        return parsed
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = brisbaneCalendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = brisbaneCalendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter
    }()
}

struct AdminWorkoutOfDayDraft: Equatable {
    var workoutDate: Date
    var title: String
    var body: String
    var isPublished: Bool
    var sourceUpdatedAt: String?
    var originalPublishedAt: Date?

    init(workout: AdminWorkoutOfDay? = nil, date: Date = AdminWorkoutOfDay.brisbaneToday) {
        workoutDate = workout.flatMap { AdminWorkoutOfDay.date(from: $0.workout_date) }
            ?? AdminWorkoutOfDay.brisbaneCalendar.startOfDay(for: date)
        title = workout?.title ?? ""
        body = workout?.body ?? ""
        isPublished = workout?.isPublished ?? false
        sourceUpdatedAt = workout?.updated_at
        originalPublishedAt = workout?.published_at
    }

    var dateKey: String { AdminWorkoutOfDay.dateKey(for: workoutDate) }
    var normalizedTitle: String? {
        title.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
    var normalizedBody: String {
        body
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var validationMessage: String? {
        guard AdminWorkoutOfDay.date(from: dateKey) != nil else {
            return "Pick the day this workout runs."
        }
        if let normalizedTitle, normalizedTitle.count > AdminWorkoutOfDay.titleLimit {
            return "Title must be \(AdminWorkoutOfDay.titleLimit) characters or fewer."
        }
        guard !normalizedBody.isEmpty else { return "Add the workout before saving." }
        guard normalizedBody.count <= AdminWorkoutOfDay.bodyLimit else {
            return "Workout must be \(AdminWorkoutOfDay.bodyLimit) characters or fewer."
        }
        return nil
    }
}

struct AdminFormSkipRule: Codable, Hashable {
    var option: String
    var skip_to: Int
}

struct AdminFormQuestion: Identifiable, Codable, Hashable {
    var id: String
    var type: String
    var question: String
    var description: String?
    var required: Bool
    var hidden: Bool?
    var placeholder: String?
    var options: [String]?
    var allow_other: Bool?
    var scale_min: Int?
    var scale_max: Int?
    var scale_min_label: String?
    var scale_max_label: String?
    var media_type: String?
    var media_url: String?
    var media_caption: String?
    var correct_answer: String?
    var points: Int?
    var content: String?
    var skip_rules: [AdminFormSkipRule]?
    // Settings the web builder writes. Decoded and re-encoded untouched, so
    // saving a form from the phone never quietly drops them: signed_by is
    // what puts Byron Hawley's signature on every copy of an agreement.
    var signed_by: String?
    var allow_already_provided: Bool?
    var prefill: String?
    var minor_only: Bool?

    static func blank(type: String = "short_text") -> Self {
        Self(
            id: UUID().uuidString.lowercased(), type: type, question: "", description: nil,
            required: false, hidden: false, placeholder: nil,
            options: ["Option 1", "Option 2", "Option 3"], allow_other: false,
            scale_min: type == "nps" ? 0 : 1, scale_max: type == "star_rating" ? 5 : 10,
            scale_min_label: nil, scale_max_label: nil, media_type: nil, media_url: nil,
            media_caption: nil, correct_answer: nil, points: 0, content: nil, skip_rules: []
        )
    }

    var displayTitle: String {
        let value = ["section_break", "statement"].contains(type) ? content : question
        return value?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Untitled field"
    }
}

struct AdminForm: Identifiable, Codable, Hashable {
    let id: UUID
    let title: String
    let description: String
    let form_type: String
    let slug: String
    let questions: [AdminFormQuestion]
    let is_active: Bool
    let show_progress_bar: Bool
    let thank_you_message: String
    let redirect_url: String?
    let header_media_type: String?
    let header_media_url: String?
    let header_media_caption: String?
    let collect_name: Bool
    let collect_name_required: Bool
    let collect_email: Bool
    let collect_email_required: Bool
    let collect_phone: Bool
    let collect_phone_required: Bool
    let one_response_per_email: Bool
    let notify_admin: Bool
    let tags: [String]
    let response_count: Int
    let created_at: Date
    let updated_at: String

    var publicURL: URL { AppConfig.webURL(path: "forms/\(slug)") }
}

/// The immutable form definition captured when a response was submitted.
///
/// Every field is optional so an administrator can still
/// open records captured by an older or newer snapshot schema. Rendering code
/// falls back to the current form only when a snapshot value is unavailable.
struct AdminFormSnapshot: Codable, Hashable {
    let version: Int?
    let snapshot_source: String?
    let title: String?
    let description: String?
    let form_type: String?
    let slug: String?
    let header_media_type: String?
    let header_media_url: String?
    let header_media_caption: String?
    let questions: [AdminFormQuestion]?
    let collect_name: Bool?
    let collect_name_required: Bool?
    let collect_email: Bool?
    let collect_email_required: Bool?
    let collect_phone: Bool?
    let collect_phone_required: Bool?
}

struct AdminFormDraft: Equatable {
    static let types = [
        "contact", "registration", "application", "feedback", "booking",
        "survey", "quiz", "waiver", "order", "custom"
    ]
    static let fieldTypes = [
        "short_text", "long_text", "number", "email", "phone", "url",
        "single_choice", "multiple_choice", "dropdown", "yes_no", "star_rating",
        "linear_scale", "nps", "date", "time", "datetime", "file_upload",
        "signature", "address", "name_fields", "section_break", "statement"
    ]

    var title: String
    var description: String
    var formType: String
    var slug: String
    var questions: [AdminFormQuestion]
    var isActive: Bool
    var showProgressBar: Bool
    var thankYouMessage: String
    var redirectURL: String
    var headerMediaType: String
    var headerMediaURL: String
    var headerMediaCaption: String
    var collectName: Bool
    var collectNameRequired: Bool
    var collectEmail: Bool
    var collectEmailRequired: Bool
    var collectPhone: Bool
    var collectPhoneRequired: Bool
    var oneResponsePerEmail: Bool
    var notifyAdmin: Bool
    var tags: [String]

    init(form: AdminForm? = nil) {
        title = form?.title ?? "New Survey"
        description = form?.description ?? ""
        formType = form?.form_type ?? "survey"
        slug = form?.slug ?? "survey-\(UUID().uuidString.lowercased().prefix(6))"
        questions = form?.questions ?? [.blank()]
        isActive = form?.is_active ?? false
        showProgressBar = form?.show_progress_bar ?? true
        thankYouMessage = form?.thank_you_message ?? "Thanks — your response has been received."
        redirectURL = form?.redirect_url ?? ""
        headerMediaType = form?.header_media_type ?? ""
        headerMediaURL = form?.header_media_url ?? ""
        headerMediaCaption = form?.header_media_caption ?? ""
        collectName = form?.collect_name ?? true
        collectNameRequired = form?.collect_name_required ?? false
        collectEmail = form?.collect_email ?? true
        collectEmailRequired = form?.collect_email_required ?? false
        collectPhone = form?.collect_phone ?? false
        collectPhoneRequired = form?.collect_phone_required ?? false
        oneResponsePerEmail = form?.one_response_per_email ?? false
        notifyAdmin = form?.notify_admin ?? true
        tags = form?.tags ?? []
    }

    mutating func setOneResponsePerEmail(_ enabled: Bool) {
        oneResponsePerEmail = enabled
        if enabled {
            collectEmail = true
            collectEmailRequired = true
        }
    }

    var validationMessage: String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Add a form title." }
        if slug.range(of: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) == nil {
            return "Use lowercase letters, numbers and hyphens in the public link."
        }
        if questions.isEmpty { return "Add at least one field." }
        if questions.contains(where: { !["section_break", "statement"].contains($0.type) && $0.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return "Every response field needs a question or label."
        }
        for (index, question) in questions.enumerated() {
            if (question.skip_rules ?? []).contains(where: {
                $0.skip_to <= index + 2 || $0.skip_to > questions.count + 1
            }) {
                return "Skip logic can only jump forward to a later question or the end of the form."
            }
        }
        if oneResponsePerEmail && !collectEmail { return "Collect email before limiting responses by email." }
        if oneResponsePerEmail && !collectEmailRequired { return "Require email before limiting responses by email." }
        return nil
    }
}

enum AdminFormAnswer: Codable, Hashable {
    case string(String)
    case number(Double)
    case boolean(Bool)
    case array([AdminFormAnswer])
    case object([String: AdminFormAnswer])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .boolean(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([AdminFormAnswer].self) { self = .array(value) }
        else { self = .object(try container.decode([String: AdminFormAnswer].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .boolean(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var displayValue: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.formatted()
        case .boolean(let value): return value ? "Yes" : "No"
        case .array(let values): return values.map(\.displayValue).joined(separator: ", ")
        case .object(let values): return values.keys.sorted().compactMap { values[$0]?.displayValue }.filter { !$0.isEmpty }.joined(separator: ", ")
        case .null: return "—"
        }
    }
}

struct AdminFormResponse: Identifiable, Codable, Hashable {
    let id: UUID
    let form_id: UUID
    let answers: [String: AdminFormAnswer]
    let form_snapshot: AdminFormSnapshot?
    let respondent_name: String?
    let respondent_email: String?
    let respondent_phone: String?
    let status: String
    let completed_at: Date
    let time_taken_seconds: Int
    let source_url: String?
    let created_at: Date

    var displayName: String { respondent_name?.nilIfEmpty ?? respondent_email?.nilIfEmpty ?? "Anonymous response" }
}

/// A textual reference to media that formed part of the submitted form.
///
/// Response records deliberately never download this URL: an external asset
/// can change or disappear after submission. The immutable URL, type and
/// caption remain useful evidence without pretending the current asset bytes
/// are what the respondent saw.
struct AdminFormMediaReference: Hashable {
    static let preservationNote = "External media is referenced only; it is not embedded or downloaded into this record. Legal or consent wording should be captured in the form content itself."

    let type: String?
    let url: String?
    let caption: String?

    init?(type: String?, url: String?, caption: String?) {
        let normalizedType = type?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let normalizedURL = url?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let normalizedCaption = caption?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        guard normalizedType != nil || normalizedURL != nil || normalizedCaption != nil else { return nil }
        self.type = normalizedType
        self.url = normalizedURL
        self.caption = normalizedCaption
    }

    var typeLabel: String {
        type?.replacingOccurrences(of: "_", with: " ").capitalized ?? "Not recorded"
    }
}

struct AdminFormSubmissionAnswerRow: Identifiable, Hashable {
    let questionID: String
    let title: String
    let description: String?
    let type: String
    let answer: AdminFormAnswer?
    let isArchivedAnswer: Bool
    let media: AdminFormMediaReference?

    var id: String { questionID }
}

struct AdminFormSubmissionContentRow: Identifiable, Hashable {
    let id: String
    let text: String
    let description: String?
    let media: AdminFormMediaReference?
}

enum AdminFormSubmissionItem: Identifiable, Hashable {
    case section(AdminFormSubmissionContentRow)
    case statement(AdminFormSubmissionContentRow)
    case answer(AdminFormSubmissionAnswerRow)

    var id: String {
        switch self {
        case .section(let row), .statement(let row): return row.id
        case .answer(let row): return row.id
        }
    }
}

/// A stable, printable representation of one response.
///
/// Snapshot questions are authoritative. Any answer key that no longer has a
/// matching question is appended as an archived answer so historical data is
/// never silently omitted.
struct AdminFormSubmissionRecord: Hashable {
    let title: String
    let description: String
    let formType: String
    let collectsName: Bool
    let collectsEmail: Bool
    let collectsPhone: Bool
    let headerMedia: AdminFormMediaReference?
    let items: [AdminFormSubmissionItem]
    let snapshotSource: String?
    let usesSubmissionSnapshot: Bool

    var provenanceLabel: String {
        if usesSubmissionSnapshot { return "Form as submitted" }
        if snapshotSource == "legacy_backfill" {
            return "Legacy record - labels and layout reconstructed; not guaranteed exact"
        }
        return "Legacy record - current labels and layout used; not guaranteed exact"
    }

    init(form: AdminForm, response: AdminFormResponse) {
        let snapshot = response.form_snapshot
        title = snapshot?.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? form.title
        description = snapshot?.description ?? form.description
        formType = snapshot?.form_type?.nilIfEmpty ?? form.form_type
        collectsName = snapshot?.collect_name ?? form.collect_name
        collectsEmail = snapshot?.collect_email ?? form.collect_email
        collectsPhone = snapshot?.collect_phone ?? form.collect_phone
        // Once a snapshot exists, a nil media value means the submitted form
        // had no media. Never substitute a newly added current-form asset.
        headerMedia = AdminFormMediaReference(
            type: snapshot == nil ? form.header_media_type : snapshot?.header_media_type,
            url: snapshot == nil ? form.header_media_url : snapshot?.header_media_url,
            caption: snapshot == nil ? form.header_media_caption : snapshot?.header_media_caption
        )
        snapshotSource = snapshot?.snapshot_source
        usesSubmissionSnapshot = snapshot?.version == 1
            && snapshot?.snapshot_source == "captured_at_submission"
            && snapshot?.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty != nil
            && snapshot?.description != nil
            && snapshot?.form_type?.nilIfEmpty != nil
            && snapshot?.questions != nil
            && snapshot?.collect_name != nil
            && snapshot?.collect_name_required != nil
            && snapshot?.collect_email != nil
            && snapshot?.collect_email_required != nil
            && snapshot?.collect_phone != nil
            && snapshot?.collect_phone_required != nil

        let questions = snapshot?.questions ?? form.questions
        let skippedQuestionIDs = Self.skippedQuestionIDs(questions: questions, answers: response.answers)
        var representedAnswerIDs = Set<String>()
        var recordItems: [AdminFormSubmissionItem] = []

        for question in questions where
            !(question.hidden ?? false) && !skippedQuestionIDs.contains(question.id) {
            let media = AdminFormMediaReference(
                type: question.media_type,
                url: question.media_url,
                caption: question.media_caption
            )
            switch question.type {
            case "section_break":
                if usesSubmissionSnapshot {
                    recordItems.append(.section(AdminFormSubmissionContentRow(
                        id: question.id,
                        text: question.displayTitle,
                        description: question.description,
                        media: media
                    )))
                }
            case "statement":
                if usesSubmissionSnapshot {
                    recordItems.append(.statement(AdminFormSubmissionContentRow(
                        id: question.id,
                        text: question.displayTitle,
                        description: question.description,
                        media: media
                    )))
                }
            default:
                representedAnswerIDs.insert(question.id)
                recordItems.append(.answer(AdminFormSubmissionAnswerRow(
                    questionID: question.id,
                    title: question.displayTitle,
                    description: question.description,
                    type: question.type,
                    answer: response.answers[question.id],
                    isArchivedAnswer: false,
                    media: media
                )))
            }
        }

        // Hidden fields can still hold intentionally captured system data.
        // Preserve them in the archived block without pretending respondents
        // saw their current label.
        let hiddenQuestionIDs = Set(questions.filter { $0.hidden ?? false }.map(\.id))
        for questionID in response.answers.keys.sorted()
            where !representedAnswerIDs.contains(questionID) {
            // Malformed legacy data may contain an answer for a field that the
            // canonical branch says was not presented. Preserve it, but do not
            // silently make it look like a normal visible question.
            let wasSkipped = skippedQuestionIDs.contains(questionID)
            let isHidden = hiddenQuestionIDs.contains(questionID)
            recordItems.append(.answer(AdminFormSubmissionAnswerRow(
                questionID: questionID,
                title: wasSkipped ? "Answer stored for a branched field" : (isHidden ? "Hidden captured field" : "Archived answer"),
                description: wasSkipped
                    ? "This field was not presented under the recorded branching path. Original field reference: \(questionID)"
                    : "Original field reference: \(questionID)",
                type: Self.archivedFieldType(for: response.answers[questionID]),
                answer: response.answers[questionID],
                isArchivedAnswer: true,
                media: nil
            )))
        }

        // Older submissions predate the public renderer that displayed layout
        // blocks. Retain recovered sections/terms for operator reference only,
        // in an explicitly caveated appendix that cannot read as evidence that
        // the respondent actually saw them.
        if !usesSubmissionSnapshot {
            let reconstructedLayout = questions.filter {
                !(($0.hidden ?? false) || skippedQuestionIDs.contains($0.id))
                    && ["section_break", "statement"].contains($0.type)
            }
            if !reconstructedLayout.isEmpty {
                recordItems.append(.section(AdminFormSubmissionContentRow(
                    id: "xert-reconstructed-layout",
                    text: "Reconstructed form layout - not verified as presented",
                    description: "These labels, descriptions and media references were reconstructed and are not proof of what the respondent saw.",
                    media: nil
                )))
                for (index, question) in reconstructedLayout.enumerated() {
                    let kind = question.type == "section_break" ? "Reconstructed section" : "Reconstructed statement"
                    recordItems.append(.statement(AdminFormSubmissionContentRow(
                        id: "xert-reconstructed-layout-\(index)-\(question.id)",
                        text: "\(kind): \(question.displayTitle)",
                        description: question.description,
                        media: AdminFormMediaReference(
                            type: question.media_type,
                            url: question.media_url,
                            caption: question.media_caption
                        )
                    )))
                }
            }
        }
        items = recordItems
    }

    private static func archivedFieldType(for answer: AdminFormAnswer?) -> String {
        guard let answer else { return "archived" }
        if case .string(let value) = answer, value.lowercased().hasPrefix("data:image/") {
            return "signature"
        }
        if case .object(let values) = answer {
            let keys = Set(values.keys)
            if keys.contains("name") && (keys.contains("size") || keys.contains("type")) {
                return "file_upload"
            }
        }
        return "archived"
    }

    private static func skippedQuestionIDs(
        questions: [AdminFormQuestion],
        answers: [String: AdminFormAnswer]
    ) -> Set<String> {
        var skipped = Set<String>()
        for (index, question) in questions.enumerated()
            where ["single_choice", "multiple_choice", "dropdown", "yes_no"].contains(question.type) {
            // A stale answer can survive for a field that an earlier rule hid.
            // Hidden controls were never presented, so their rules must not
            // influence the canonical path shown in the immutable record.
            guard !skipped.contains(question.id) else { continue }
            guard let answer = answers[question.id] else { continue }
            let matchingRule = (question.skip_rules ?? []).first { rule in
                switch (question.type, answer) {
                case ("multiple_choice", .array(let selected)):
                    return selected.count == 1 && selected.first == .string(rule.option)
                case (_, .string(let selected)):
                    return selected == rule.option
                default:
                    return false
                }
            }
            guard let target = matchingRule?.skip_to,
                  target > index + 2,
                  target <= questions.count + 1 else { continue }
            for oneBasedIndex in (index + 2)..<target {
                skipped.insert(questions[oneBasedIndex - 1].id)
            }
        }
        return skipped
    }
}

// ─── SMS campaign results ────────────────────────────────────────────────────

struct AdminSmsResult: Identifiable, Decodable, Hashable {
    var id: String { phone }
    let phone: String
    let name: String
    let ok: Bool
    let sid: String?
    let status: String?
    let error: String?

    var outcomeLabel: String { ok ? (status ?? "queued") : (error ?? "Failed") }
}

struct AdminSmsOutcome: Decodable, Hashable {
    let sent: Int
    let failed: Int
    let total: Int
    let results: [AdminSmsResult]

    var summaryLabel: String {
        failed == 0 ? "\(sent) sent" : "\(sent) sent, \(failed) failed"
    }
}


// MARK: - FitBox live mirror

struct AdminFitboxReadiness: Codable, Hashable {
    let ready: Bool
    let missing: [String]
    let mode: String?
    let feeds_available: Bool?
    let error_code: String?

    var feedsAvailable: Bool { feeds_available == true }
}

struct AdminFitboxSummary: Codable, Hashable {
    struct Users: Codable, Hashable {
        let total: Int
        let active: Int
        let prospects: Int
        let staff: Int
    }
    struct Subscriptions: Codable, Hashable {
        let total: Int
        let active: Int
        let paid_active: Int
    }
    struct Attendance: Codable, Hashable {
        let upcoming: Int
        let cancelled: Int
    }
    let users: Users
    let subscriptions: Subscriptions
    let attendance: Attendance
    let links: Int?
}

struct AdminFitboxSyncRun: Identifiable, Codable, Hashable {
    let id: UUID
    let feed: String
    let status: String
    let accepted: Int?
    let rejected: Int?
    let linked: Int?
    let error_code: String?
    let started_at: Date
    let finished_at: Date?

    var feedTitle: String {
        switch feed {
        case "users": return "Member profiles"
        case "statuses": return "Member statuses"
        case "subscriptions": return "Memberships"
        case "bookings": return "Class bookings"
        case "cancellations": return "Cancellations"
        case "first_sessions": return "First sessions"
        case "classes": return "Classes"
        case "lookup": return "Lookup"
        default: return feed.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

struct AdminFitboxClass: Codable, Hashable {
    let fitbox_class_id: String
    let name: String
}

struct AdminFitboxOverview: Codable, Hashable {
    let gym_id: String?
    let gateway: AdminFitboxReadiness
    let hooks: AdminFitboxReadiness
    let events: AdminFitboxReadiness
    let mirror_installed: Bool
    let summary: AdminFitboxSummary?
    let classes: [AdminFitboxClass]
    let recent_runs: [AdminFitboxSyncRun]
    let last_completed_sync: Date?
    let review_queue: Int
}

struct AdminFitboxUser: Identifiable, Codable, Hashable {
    let id: UUID
    let fitbox_user_id: String
    let first_name: String?
    let last_name: String?
    let email: String?
    let phone: String?
    let city: String?
    let status: String?
    let role: String?
    let synced_at: Date

    var displayName: String {
        let name = [first_name, last_name].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
        if !name.isEmpty { return name }
        return email ?? "FitBox user \(fitbox_user_id)"
    }
}

struct AdminFitboxSubscription: Identifiable, Codable, Hashable {
    let id: UUID
    let fitbox_subscription_id: String
    let fitbox_user_id: String
    let email: String?
    let product_name: String?
    let status: String?
    let price_in_cents: Int?
    let start_date: String?
    let expiration_date: String?
    let sessions_count: Int?
    let synced_at: Date

    var priceLabel: String {
        guard let cents = price_in_cents else { return "—" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "AUD"
        return formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "—"
    }
}

struct AdminFitboxAttendance: Identifiable, Codable, Hashable {
    let id: UUID
    let fitbox_attendance_id: String
    let class_name: String?
    let fitbox_user_id: String
    let session_start_time: Date?
    let status: String?
    let feed: String
    let synced_at: Date
}

struct AdminFitboxSyncRequest: Encodable {
    let action: String
    let feed: String
}

struct AdminFitboxSyncResponse: Codable, Hashable {
    let feed: String
    let accepted: Int
    let rejected: Int
    let linked: Int
}

struct AdminFitboxLookupRequest: Encodable {
    let action: String
    let email: String
    let fitbox_user_id: String
}

struct AdminFitboxUserSnapshot: Codable, Hashable {
    let fitbox_user_id: String
    let first_name: String?
    let last_name: String?
    let email: String?
    let phone: String?
    let status: String?
    let role: String?
}

struct AdminFitboxNextSession: Codable, Hashable {
    let class_name: String?
    let session_start_time: Date?
    let status: String?
    let unavailable: String?
}

struct AdminFitboxLookupResponse: Codable, Hashable {
    let found: Bool
    let user: AdminFitboxUserSnapshot?
    let next_session: AdminFitboxNextSession?
    let linked: Int?
}

/// A confirmation the database refused because the class is already full.
/// Overbooking a class by one is an ordinary gym decision, so it stays
/// available — it just has to be asked for rather than happening by accident.
struct AdminOverbookPrompt: Identifiable, Equatable {
    let booking: AdminBookingRequest
    let status: String
    let reason: String

    var id: String { "\(booking.id)-\(status)" }

    var message: String {
        "\(booking.fullName) would be an extra place in \(booking.session?.title ?? "this class"), which is already at capacity. Everyone already booked keeps their place."
    }
}

/// Database codes the owner should never see raw.
enum AdminBookingDecisionMessage {
    static func friendly(_ raw: String) -> String {
        if raw.contains("CLASS_FULL") { return "That class is already full." }
        if raw.contains("CLASS_WAITLISTED") { return "Someone is queued for that class ahead of them." }
        if raw.contains("SESSION_NOT_STARTED") { return "That class has not started yet, so it cannot be marked off." }
        if raw.contains("WAITLIST_ORDER_REQUIRED") || raw.contains("WAITLIST_PRIORITY") {
            return "Promote the next person on the waitlist before reopening another booking."
        }
        if raw.contains("NO_CREDITS") { return "That member has no session credits left." }
        if raw.contains("ALREADY_BOOKED") { return "They already have a place in that class." }
        if raw.contains("SESSION_IN_PAST") { return "That class has already run." }
        if raw.contains("ADMIN_REQUIRED") || raw.contains("ADMIN_ONLY") { return "Sign in as an admin to change bookings." }
        return raw
    }
}

/// What each booking mode actually does, in the same words the web uses. The
/// picker showed bare enum names, so an owner could flip a class to instant
/// book without learning that anonymous visitors would then take real,
/// capacity-limited places with nothing but contact details.
func bookingModeExplanation(_ mode: String) -> String {
    switch mode {
    case "interest_only":
        return "Collects names only. Nobody takes a place, and there is nothing to confirm."
    case "instant_book":
        return "The first people to sign up take real places, up to the capacity above, using only their contact details."
    default:
        return "People ask for a place and you confirm or decline each one. Nothing is held until you do."
    }
}

/// A safe fallback for a link the OS refuses to build (a malformed phone
/// number, an email with a stray character). Force-unwrapping a URL literal
/// inline reads as harmless right up until the day a contact record contains
/// something unexpected and the owner's phone crashes on the class roster.
enum XertLinks {
    static let site = URL(string: "https://xertfitness.com.au") ?? URL(fileURLWithPath: "/")
}
