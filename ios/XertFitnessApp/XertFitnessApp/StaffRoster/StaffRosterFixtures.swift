#if DEBUG
import Foundation
import SwiftUI

// DEBUG-only UI-test fixture mode. A Release build compiles none of this.
//
// Launched with `-XertRosterFixtures`, the app:
//   * never reads or writes the keychain session and never touches the
//     network (`XertAPI` and remote images refuse every request);
//   * signs in a fixture coach (or nobody, for `signedOut`) without Supabase;
//   * answers every `staff_roster_*` call from the in-memory service below.
// It exists so XCUITests can walk My Coaching on a simulator with no real
// staff, no live roster and no production data.

/// Launch switches read by the app in fixture mode.
enum XertUITestFixtures {
    static let launchArgument = "-XertRosterFixtures"
    /// One of `Scenario`'s raw values; `coach` when absent.
    static let scenarioKey = "XERT_FIXTURE_SCENARIO"
    /// A push `open_path` to replay as a cold-launch notification tap.
    static let pushOpenPathKey = "XERT_FIXTURE_PUSH_OPEN_PATH"
    /// The replayed push's `audience`; omitted to test inference.
    static let pushAudienceKey = "XERT_FIXTURE_PUSH_AUDIENCE"
    /// A link delivered once the fixture account is known.
    static let openURLKey = "XERT_FIXTURE_OPEN_URL"

    enum Scenario: String {
        /// Signed-in active coach, roster on.
        case coach
        /// Roster switched off: `staff_roster_me` answers ROSTER_DISABLED.
        case featureOff
        /// Nobody signed in; fixture sign-in then gives the active coach.
        case signedOut
        /// Signed in, but coach access was revoked after notices were sent.
        case revoked
        /// The first availability draft save fails like a dropped connection.
        case saveFailure
        /// The first availability draft save meets STALE_VERSION.
        case staleConflict
    }

    static let isActive: Bool = ProcessInfo.processInfo.arguments.contains(launchArgument)

    static var scenario: Scenario {
        ProcessInfo.processInfo.environment[scenarioKey].flatMap { Scenario(rawValue: $0) } ?? .coach
    }

    static let userID = UUID(uuidString: "5e1f0000-0000-4000-8000-00000000c0ac")!

    static var signedInSession: AuthSession {
        AuthSession(
            access_token: "uitest-fixture-token",
            refresh_token: nil,
            expires_in: nil,
            expires_at: nil,
            token_type: "bearer",
            user: AuthUser(id: userID, email: "coach.fixture@example.invalid")
        )
    }

    static var initialSession: AuthSession? {
        guard isActive, scenario != .signedOut else { return nil }
        return signedInSession
    }

    static var launchURL: URL? {
        guard isActive, let raw = ProcessInfo.processInfo.environment[openURLKey] else { return nil }
        return URL(string: raw)
    }

    /// Replays a tapped staff roster push on cold launch through the same
    /// parser and pending store as `userNotificationCenter(_:didReceive:)`.
    static func simulateNotificationTapIfRequested() {
        let environment = ProcessInfo.processInfo.environment
        guard isActive, let path = environment[pushOpenPathKey] else { return }
        var userInfo: [AnyHashable: Any] = [
            "aps": ["category": StaffRosterPush.category, "thread-id": StaffRosterPush.threadIdentifier],
            StaffRosterPush.notificationIDKey: "a0000000-0000-4000-8000-0000000000a1",
            StaffRosterPush.openPathKey: path,
        ]
        if let audience = environment[pushAudienceKey] {
            userInfo[StaffRosterPush.audienceKey] = audience
        }
        guard let target = StaffRosterPush.target(from: userInfo) else { return }
        StaffRosterPushNavigation.markPending(target)
    }
}

/// What the app would have handed to the system browser, for assertions.
final class XertUITestHooks: ObservableObject {
    static let shared = XertUITestHooks()

    @Published private(set) var openedExternalURL: String?

    func recordOpenedExternalURL(_ url: URL) {
        openedExternalURL = url.absoluteString
    }
}

/// Shows the recorded browser destination so a UI test can read it.
struct XertUITestHookOverlay: View {
    @ObservedObject private var hooks = XertUITestHooks.shared

    var body: some View {
        VStack(spacing: 0) {
            if XertUITestFixtures.isActive, let url = hooks.openedExternalURL {
                Text(url)
                    .font(.caption2)
                    .foregroundStyle(Color.white)
                    .padding(6)
                    .background(Color.black.opacity(0.85))
                    .accessibilityIdentifier("uitest-opened-external-url")
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
    }
}

/// In-memory `staff_roster_*` answers for one fixture coach. Dates are built
/// in gym time (Brisbane) relative to today so every screen has upcoming work:
/// a 5:15 am class tomorrow, a 5:30 am class on the first day of next month
/// (still the previous day in UTC), an evening class with a volunteered cover,
/// an open cover from another coach, a planned absence, and next month's
/// availability open with no draft.
final class StaffRosterFixtureService: StaffRosterService {
    static let shared = StaffRosterFixtureService(scenario: XertUITestFixtures.scenario)

    static let staffID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000001")!
    static let revisionID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000002")!
    static let dawnAssignmentID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000011")!
    static let dawnSessionID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000012")!
    static let boundaryAssignmentID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000021")!
    static let boundarySessionID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000022")!
    static let eveningAssignmentID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000031")!
    static let eveningSessionID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000032")!
    static let eveningCoverID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000033")!
    static let boardCoverID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000041")!
    static let boardSessionID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000042")!
    static let absenceID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000051")!
    static let coachNoticeID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000061")!
    static let managerNoticeID = UUID(uuidString: "5e1f0000-0000-4000-8000-000000000062")!

    private let lock = NSLock()
    private let scenario: XertUITestFixtures.Scenario
    private let today: String
    private let thisMonth: String
    private let nextMonth: String
    private var draft: StaffRosterMe.Draft?
    private var submission: StaffRosterMe.Submission?
    private var usualWeekVersion = 0
    private var saveAttempts = 0
    private var covers: [UUID: StaffRosterAssignment.Cover] = [:]
    private var absences: [StaffRosterMyRequests.Absence] = []
    private var myOffer: String?
    private var readNotificationIDs: Set<UUID> = []

    init(scenario: XertUITestFixtures.Scenario, now: Date = Date()) {
        self.scenario = scenario
        let todayKey = StaffRosterTime.todayKey(now: now)
        let monthKey = StaffRosterTime.monthKey(for: now)
        today = todayKey
        thisMonth = monthKey
        nextMonth = StaffRosterTime.shiftMonth(monthKey, by: 1) ?? monthKey
        covers[Self.eveningAssignmentID] = StaffRosterAssignment.Cover(id: Self.eveningCoverID, status: "offered")
        let awayStart = StaffRosterTime.addingDays(14, to: todayKey) ?? todayKey
        let awayEnd = StaffRosterTime.addingDays(15, to: todayKey) ?? todayKey
        absences = [
            StaffRosterMyRequests.Absence(
                id: Self.absenceID,
                starts_at: Self.instant(awayStart, 0),
                ends_at: Self.instant(awayEnd, 1_440),
                kind: "planned",
                status: "requested",
                reason: nil,
                created_at: now
            ),
        ]
    }

    // MARK: Helpers

    private static func instant(_ dateKey: String, _ minute: Int) -> Date {
        StaffRosterTime.instant(dateKey, minute: minute) ?? Date()
    }

    private static func error(_ code: String) -> StaffRosterError {
        StaffRosterError(code: code, message: StaffRosterError.messages[code] ?? StaffRosterError.fallbackMessage)
    }

    private func dayKey(_ offset: Int) -> String {
        StaffRosterTime.addingDays(offset, to: today) ?? today
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// The server re-checks the roster switch and the staff link on every call.
    private func checkAccess() throws {
        switch scenario {
        case .featureOff:
            throw Self.error("ROSTER_DISABLED")
        case .revoked:
            throw Self.error("NOT_STAFF")
        case .coach, .signedOut, .saveFailure, .staleConflict:
            break
        }
    }

    private func currentMe() -> StaffRosterMe {
        let period = StaffRosterMe.Period(
            month: nextMonth + "-01",
            opens_on: today,
            due_on: dayKey(10),
            publish_target_on: dayKey(17),
            shortened: false,
            is_open: true,
            deadline_passed: false,
            reopened: false,
            change_request_open: false,
            draft: draft,
            submission: submission
        )
        return StaffRosterMe(
            staff: StaffRosterMe.Staff(id: Self.staffID, display_name: "Sam Fixture", roles: ["coach"], status: "active"),
            today: today,
            settings: StaffRosterMe.Settings(class_time_presets: [
                StaffRosterMe.Preset(minute: 315),
                StaffRosterMe.Preset(minute: 330),
                StaffRosterMe.Preset(minute: 1_050),
            ]),
            usual_week: nil,
            last_submission: nil,
            periods: [period],
            unread_notifications: notifications().filter { $0.isUnread }.count,
            pending_acknowledgements: []
        )
    }

    private func assignment(
        id: UUID,
        sessionID: UUID,
        dateKey: String,
        start: Int,
        end: Int,
        dutyStart: Int,
        title: String,
        classType: String
    ) -> StaffRosterAssignment {
        let startDate = Self.instant(dateKey, start)
        return StaffRosterAssignment(
            assignment_id: id,
            revision_id: Self.revisionID,
            revision_number: 1,
            month: StaffRosterTime.monthKey(for: startDate) + "-01",
            session_id: sessionID,
            slot_key: "lead",
            role: "lead",
            title: title,
            class_type: classType,
            start: startDate,
            end: Self.instant(dateKey, end),
            duty_start: Self.instant(dateKey, dutyStart),
            duty_end: Self.instant(dateKey, end),
            status: "assigned",
            published_start: nil,
            published_end: nil,
            changed_since_publish: false,
            colleagues: [StaffRosterAssignment.Colleague(display_name: "Alex", role: "assistant")],
            acknowledged: true,
            cover: covers[id],
            availability: "AVAILABLE"
        )
    }

    private func assignments() -> [StaffRosterAssignment] {
        [
            // 5:15 am tomorrow: an early-morning duty from 5:00 am.
            assignment(
                id: Self.dawnAssignmentID,
                sessionID: Self.dawnSessionID,
                dateKey: dayKey(1),
                start: 315,
                end: 375,
                dutyStart: 300,
                title: "Dawn Strength",
                classType: "strength"
            ),
            // 5:30 am on the 1st of next month is 7:30 pm the day before in UTC.
            assignment(
                id: Self.boundaryAssignmentID,
                sessionID: Self.boundarySessionID,
                dateKey: nextMonth + "-01",
                start: 330,
                end: 390,
                dutyStart: 315,
                title: "Month Turn HIIT",
                classType: "hiit"
            ),
            assignment(
                id: Self.eveningAssignmentID,
                sessionID: Self.eveningSessionID,
                dateKey: dayKey(3),
                start: 1_050,
                end: 1_110,
                dutyStart: 1_035,
                title: "Evening Boxing",
                classType: "boxing"
            ),
        ]
    }

    private func notifications() -> [StaffRosterNotification] {
        let focus = Self.boardCoverID.uuidString.lowercased()
        return [
            StaffRosterNotification(
                id: Self.coachNoticeID,
                kind: "availability_reminder",
                title: "Availability is open",
                body: "Tell the manager when you can coach next month.",
                link: "/coaching?tab=availability&month=" + nextMonth,
                created_at: Date().addingTimeInterval(-3_600),
                read_at: readNotificationIDs.contains(Self.coachNoticeID) ? Date() : nil
            ),
            // A manager notice, as an admin who also coaches would see it.
            StaffRosterNotification(
                id: Self.managerNoticeID,
                kind: "cover_offered",
                title: "A cover offer needs a decision",
                body: "Approve or decline it in the manager console.",
                link: "/admin/roster?rosterTab=requests&rosterMonth=" + thisMonth + "&rosterFocus=" + focus,
                created_at: Date().addingTimeInterval(-7_200),
                read_at: readNotificationIDs.contains(Self.managerNoticeID) ? Date() : nil
            ),
        ]
    }

    // MARK: StaffRosterService

    func staffRosterMe(session auth: AuthSession) async throws -> StaffRosterMe {
        try checkAccess()
        return locked { currentMe() }
    }

    func staffRosterMonthClasses(session auth: AuthSession, monthKey: String) async throws -> [StaffRosterMonthClass] {
        try checkAccess()
        guard monthKey == nextMonth else { return [] }
        var classes: [StaffRosterMonthClass] = []
        for (index, date) in StaffRosterTime.dates(inMonth: monthKey).enumerated() where StaffRosterTime.weekday(date) == 1 {
            let id = UUID(uuidString: String(format: "c1000000-0000-4000-8000-%012ld", index)) ?? UUID()
            classes.append(StaffRosterMonthClass(
                id: id,
                title: "Dawn Strength",
                class_type: "strength",
                start: Self.instant(date, 315),
                end: Self.instant(date, 375),
                duty_start: Self.instant(date, 300),
                duty_end: Self.instant(date, 375)
            ))
        }
        let first = monthKey + "-01"
        classes.append(StaffRosterMonthClass(
            id: Self.boundarySessionID,
            title: "Month Turn HIIT",
            class_type: "hiit",
            start: Self.instant(first, 330),
            end: Self.instant(first, 390),
            duty_start: Self.instant(first, 315),
            duty_end: Self.instant(first, 390)
        ))
        return classes.sorted { $0.start < $1.start }
    }

    func staffRosterSaveUsualWeek(
        session auth: AuthSession,
        pattern: [StaffWeeklyWindow],
        expectedVersion: Int
    ) async throws -> StaffRosterVersionResult {
        try checkAccess()
        return try locked {
            guard expectedVersion == usualWeekVersion else { throw Self.error("STALE_VERSION") }
            usualWeekVersion += 1
            return StaffRosterVersionResult(version: usualWeekVersion, updated_at: Date())
        }
    }

    func staffRosterSaveAvailabilityDraft(
        session auth: AuthSession,
        monthKey: String,
        payload: StaffAvailabilityPayload,
        expectedVersion: Int
    ) async throws -> StaffRosterVersionResult {
        try checkAccess()
        return try locked {
            saveAttempts += 1
            if scenario == .saveFailure && saveAttempts == 1 {
                throw StaffRosterError(code: nil, message: "XERT is offline. Check your connection.")
            }
            if scenario == .staleConflict && saveAttempts == 1 {
                // Another device (or the manager) saved this month first.
                draft = StaffRosterMe.Draft(
                    payload: StaffAvailabilityPayload(noAvailability: true),
                    version: 5,
                    updated_at: Date()
                )
                throw Self.error("STALE_VERSION")
            }
            let current = draft?.version ?? 0
            guard expectedVersion == current else { throw Self.error("STALE_VERSION") }
            let saved = StaffRosterMe.Draft(payload: payload, version: current + 1, updated_at: Date())
            draft = saved
            return StaffRosterVersionResult(version: saved.version, updated_at: saved.updated_at)
        }
    }

    func staffRosterSubmitAvailability(
        session auth: AuthSession,
        monthKey: String,
        payload: StaffAvailabilityPayload,
        requestID: UUID
    ) async throws -> StaffRosterSubmitResult {
        try checkAccess()
        return locked {
            let version = (submission?.version ?? 0) + 1
            submission = StaffRosterMe.Submission(
                version: version,
                payload: payload,
                submitted_at: Date(),
                late: false,
                no_availability: payload.noAvailability
            )
            draft = nil
            return StaffRosterSubmitResult(
                submission_id: UUID(),
                version: version,
                late: false,
                no_availability: payload.noAvailability
            )
        }
    }

    func staffRosterRequestChange(
        session auth: AuthSession,
        monthKey: String,
        message: String,
        requestID: UUID
    ) async throws -> StaffRosterIDResult {
        try checkAccess()
        return StaffRosterIDResult(id: UUID())
    }

    func staffRosterConfirmSession(
        session auth: AuthSession,
        sessionID: UUID,
        status: String,
        requestID: UUID
    ) async throws -> StaffRosterStatusResult {
        try checkAccess()
        return StaffRosterStatusResult(id: sessionID, ok: true, status: status)
    }

    func staffRosterMyRoster(session auth: AuthSession, from: String, to: String) async throws -> StaffRosterMyRoster {
        try checkAccess()
        return locked { StaffRosterMyRoster(assignments: assignments(), pending_acknowledgements: []) }
    }

    func staffRosterAcknowledge(session auth: AuthSession, revisionID: UUID) async throws -> StaffRosterAcknowledgeResult {
        try checkAccess()
        return StaffRosterAcknowledgeResult(ok: true, acknowledged: true)
    }

    func staffRosterRequestAbsence(
        session auth: AuthSession,
        starts: Date,
        ends: Date,
        kind: String,
        reason: String?,
        requestID: UUID
    ) async throws -> StaffRosterAbsenceResult {
        try checkAccess()
        return locked {
            let id = UUID()
            let status = kind == "urgent" ? "reported" : "requested"
            absences.append(StaffRosterMyRequests.Absence(
                id: id,
                starts_at: starts,
                ends_at: ends,
                kind: kind,
                status: status,
                reason: reason,
                created_at: Date()
            ))
            return StaffRosterAbsenceResult(id: id, status: status, affected_classes: kind == "urgent" ? 1 : nil)
        }
    }

    func staffRosterWithdraw(session auth: AuthSession, kind: String, id: UUID, requestID: UUID) async throws -> StaffRosterStatusResult {
        try checkAccess()
        return locked {
            switch kind {
            case "offer":
                myOffer = nil
            case "cover":
                for (assignmentID, cover) in covers where cover.id == id {
                    covers[assignmentID] = nil
                }
            default:
                absences = absences.map { absence in
                    guard absence.id == id else { return absence }
                    return StaffRosterMyRequests.Absence(
                        id: absence.id,
                        starts_at: absence.starts_at,
                        ends_at: absence.ends_at,
                        kind: absence.kind,
                        status: "withdrawn",
                        reason: absence.reason,
                        created_at: absence.created_at
                    )
                }
            }
            return StaffRosterStatusResult(id: id, ok: true, status: "withdrawn")
        }
    }

    func staffRosterRequestCover(
        session auth: AuthSession,
        assignmentID: UUID,
        reason: String?,
        requestID: UUID
    ) async throws -> StaffRosterStatusResult {
        try checkAccess()
        return locked {
            let cover = StaffRosterAssignment.Cover(id: UUID(), status: "open")
            covers[assignmentID] = cover
            return StaffRosterStatusResult(id: cover.id, ok: true, status: "open")
        }
    }

    func staffRosterCoverBoard(session auth: AuthSession) async throws -> [StaffRosterCoverBoardItem] {
        try checkAccess()
        return locked {
            let date = dayKey(5)
            return [
                StaffRosterCoverBoardItem(
                    id: Self.boardCoverID,
                    status: myOffer == nil ? "open" : "offered",
                    version: 1,
                    session_id: Self.boardSessionID,
                    slot_key: "lead",
                    title: "Saturday Bootcamp",
                    start: Self.instant(date, 420),
                    end: Self.instant(date, 480),
                    role: "lead",
                    requested_by: "Jordan",
                    my_offer: myOffer,
                    problems: []
                ),
            ]
        }
    }

    func staffRosterOfferCover(session auth: AuthSession, coverID: UUID, requestID: UUID) async throws -> StaffRosterStatusResult {
        try checkAccess()
        return locked {
            myOffer = "offered"
            return StaffRosterStatusResult(id: coverID, ok: true, status: "offered")
        }
    }

    func staffRosterMyRequests(session auth: AuthSession) async throws -> StaffRosterMyRequests {
        try checkAccess()
        return locked {
            var offers: [StaffRosterMyRequests.Offer] = []
            if let myOffer {
                offers.append(StaffRosterMyRequests.Offer(
                    request_id: Self.boardCoverID,
                    status: myOffer,
                    title: "Saturday Bootcamp",
                    start: Self.instant(dayKey(5), 420)
                ))
            }
            return StaffRosterMyRequests(
                absences: absences,
                cover_requests: [
                    StaffRosterMyRequests.CoverRequest(
                        id: Self.eveningCoverID,
                        status: "offered",
                        title: "Evening Boxing",
                        start: Self.instant(dayKey(3), 1_050),
                        offers: 1
                    ),
                ],
                offers: offers,
                change_requests: []
            )
        }
    }

    func staffRosterMyNotifications(session auth: AuthSession, limit: Int) async throws -> [StaffRosterNotification] {
        try checkAccess()
        return locked { Array(notifications().prefix(limit)) }
    }

    func staffRosterMarkNotificationsRead(session auth: AuthSession, ids: [UUID]) async throws -> Int {
        try checkAccess()
        return locked {
            let before = readNotificationIDs.count
            readNotificationIDs.formUnion(ids)
            return readNotificationIDs.count - before
        }
    }
}
#endif
