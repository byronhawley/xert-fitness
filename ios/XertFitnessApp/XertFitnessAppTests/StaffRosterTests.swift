import XCTest
@testable import XertFitness

/// Native My Coaching contract: deep links, push routing, Brisbane dates,
/// RPC decoding (exact jsonb keys from 20261001010000_staff_roster.sql) and
/// the entry visibility rule.
final class StaffRosterTests: XCTestCase {
    private let host = AppConfig.vercelHost

    private func url(_ value: String) throws -> URL {
        try XCTUnwrap(URL(string: value))
    }

    private func utc(_ value: String) throws -> Date {
        try XCTUnwrap(StaffRosterJSON.instant(from: value))
    }

    // MARK: Deep links

    func testOpenPathsParseEveryCoachingSection() throws {
        XCTAssertEqual(
            XertCoachingLink.link(for: try url("https://\(host)/open/coaching")),
            XertCoachingLink(tab: .upcoming)
        )
        XCTAssertEqual(
            XertCoachingLink.link(for: try url("https://\(host)/open/coaching/roster")),
            XertCoachingLink(tab: .roster)
        )
        XCTAssertEqual(
            XertCoachingLink.link(for: try url("https://\(host)/open/coaching/availability?month=2026-11")),
            XertCoachingLink(tab: .availability, month: "2026-11")
        )
        XCTAssertEqual(
            XertCoachingLink.link(for: try url("https://\(host)/open/coaching/requests?month=2026-12")),
            XertCoachingLink(tab: .requests, month: "2026-12")
        )
        XCTAssertEqual(
            XertCoachingLink.link(for: try url("https://\(host)/open/coaching/roster/")),
            XertCoachingLink(tab: .roster)
        )
        XCTAssertEqual(
            XertCoachingLink.link(for: try url("xertfitness://coaching/availability?month=2027-01")),
            XertCoachingLink(tab: .availability, month: "2027-01")
        )
        XCTAssertEqual(
            XertCoachingLink.link(for: try url("xertfitness://open/coaching/requests")),
            XertCoachingLink(tab: .requests)
        )
    }

    func testDeepLinksRejectInvalidMonthsUnknownTabsAndForeignHosts() throws {
        let rejected = [
            "https://\(host)/open/coaching/roster?month=2026-13",
            "https://\(host)/open/coaching/roster?month=2026-00",
            "https://\(host)/open/coaching/roster?month=2026-1",
            "https://\(host)/open/coaching/roster?month=26-11",
            "https://\(host)/open/coaching/roster?month=2026-11-01",
            "https://\(host)/open/coaching/roster?month=",
            "https://\(host)/open/coaching/roster?month=abcd-ef",
            "https://\(host)/open/coaching/payroll",
            "https://\(host)/open/coaching/upcoming",
            "https://\(host)/open/coaching/roster/extra",
            "https://\(host)/open/coaching/roster?tab=roster",
            "https://\(host)/open/coaching/roster?month=2026-11&month=2026-12",
            "https://\(host)/open/coaching/roster?month=2026-11#top",
            "https://\(host)/coaching/roster",
            "https://\(host):8443/open/coaching/roster",
            "https://evil.example/open/coaching/roster",
            "http://\(host)/open/coaching/roster",
            "https://user:pass@\(host)/open/coaching",
            "xertfitness://coaching/payroll",
        ]
        for value in rejected {
            XCTAssertNil(XertCoachingLink.link(for: try url(value)), value)
        }
        XCTAssertNil(XertCoachingLink.link(for: try url("https://\(host)/open/booking")))
    }

    func testInvalidMonthNeverReachesTheLinkModel() {
        XCTAssertNil(XertCoachingLink(tab: .roster, month: "2026-13").month)
        XCTAssertNil(XertCoachingLink(tab: .roster, month: "nope").month)
        XCTAssertEqual(XertCoachingLink(tab: .roster, month: "2026-02").month, "2026-02")
        XCTAssertTrue(XertCoachingLink.isValidMonth("2026-12"))
        XCTAssertFalse(XertCoachingLink.isValidMonth("2026-12 "))
        XCTAssertFalse(XertCoachingLink.isValidMonth("１２３４-11"))
    }

    func testMemberRoutesCarryCoachingLinksThroughUniversalLinksAndRestoration() throws {
        let link = XertCoachingLink(tab: .availability, month: "2026-11")
        let route = XertMemberRoute.coaching(link)

        XCTAssertEqual(
            XertMemberRoute.route(for: try url("https://\(host)/open/coaching/availability?month=2026-11")),
            route
        )
        XCTAssertEqual(route.restorationValue, "coaching/availability?month=2026-11")
        XCTAssertEqual(XertMemberRoute.restore(route.restorationValue), route)
        XCTAssertEqual(XertMemberRoute.route(for: route.webURL), route)
        XCTAssertEqual(XertMemberRoute.restore("coaching"), .coaching(XertCoachingLink()))
        XCTAssertNil(XertMemberRoute.route(for: try url("https://\(host)/open/coaching/roster?month=2026-13")))
        XCTAssertNil(XertMemberRoute.route(for: try url("https://\(host)/open/coaching/unknown?month=2026-11")))

        XCTAssertEqual(route.destination, .account)
        XCTAssertEqual(route.navigationTitle, "My Coaching")
        XCTAssertTrue(route.requiresAuthentication)
        XCTAssertTrue(route.isContextualTask)
        XCTAssertNil(route.shareDestination)
        XCTAssertEqual(route.pinnableRoute, .coaching(XertCoachingLink(tab: .availability)))

        // Existing routes still refuse query strings.
        XCTAssertNil(XertMemberRoute.route(for: try url("https://\(host)/open/account?month=2026-11")))
    }

    func testInAppNoticeLinksOpenTheNamedSection() {
        XCTAssertEqual(
            XertCoachingLink.link(inAppNotice: "/coaching?tab=availability&month=2026-12"),
            XertCoachingLink(tab: .availability, month: "2026-12")
        )
        XCTAssertEqual(XertCoachingLink.link(inAppNotice: "/coaching?tab=roster"), XertCoachingLink(tab: .roster))
        XCTAssertEqual(XertCoachingLink.link(inAppNotice: "/coaching?tab=requests"), XertCoachingLink(tab: .requests))
        XCTAssertEqual(XertCoachingLink.link(inAppNotice: "/coaching"), XertCoachingLink())
        XCTAssertNil(XertCoachingLink.link(inAppNotice: "/coaching?tab=payroll"))
        XCTAssertNil(XertCoachingLink.link(inAppNotice: "/coaching?tab=roster&month=2026-13"))
        XCTAssertNil(XertCoachingLink.link(inAppNotice: "/coaching?tab=roster&focus=1"))
        XCTAssertNil(XertCoachingLink.link(inAppNotice: "/admin/roster?rosterTab=requests"))
        XCTAssertNil(XertCoachingLink.link(inAppNotice: "https://evil.example/coaching?tab=roster"))

        let notice = StaffRosterNotification(
            id: UUID(),
            kind: "roster_published",
            title: "Roster published",
            body: "Your December roster is ready.",
            link: "/coaching?tab=roster&month=2026-12",
            created_at: Date(),
            read_at: nil
        )
        XCTAssertEqual(notice.coachingLink, XertCoachingLink(tab: .roster, month: "2026-12"))
        XCTAssertTrue(notice.isUnread)
    }

    // MARK: Push

    func testStaffRosterPushRoutesItsOpenPath() throws {
        let notificationID = UUID()
        let payload: [AnyHashable: Any] = [
            "aps": ["category": "xert.staff-roster", "thread-id": "xert-staff-roster"],
            "staff_notification_id": notificationID.uuidString,
            "open_path": "/open/coaching/roster?month=2026-11",
        ]
        let target = try XCTUnwrap(StaffRosterPush.target(from: payload))
        XCTAssertEqual(target.link, XertCoachingLink(tab: .roster, month: "2026-11"))
        XCTAssertEqual(target.notificationID, notificationID)
        XCTAssertEqual(target.link.openPath, "/open/coaching/roster?month=2026-11")
    }

    func testStaffRosterPushFallsBackToUpcomingAndIgnoresOtherPushes() throws {
        let unsafe: [AnyHashable: Any] = [
            "aps": ["category": "xert.staff-roster"],
            "staff_notification_id": UUID().uuidString,
            "open_path": "https://evil.example/open/coaching/roster",
        ]
        XCTAssertEqual(StaffRosterPush.target(from: unsafe)?.link, XertCoachingLink())

        let badMonth: [AnyHashable: Any] = [
            "aps": ["category": "xert.staff-roster"],
            "open_path": "/open/coaching/availability?month=2026-13",
        ]
        let fallback = try XCTUnwrap(StaffRosterPush.target(from: badMonth))
        XCTAssertEqual(fallback.link, XertCoachingLink())
        XCTAssertNil(fallback.notificationID)

        let reminder: [AnyHashable: Any] = [
            "aps": ["category": XertNotificationCategories.classReminder],
            "booking_id": UUID().uuidString,
        ]
        XCTAssertNil(StaffRosterPush.target(from: reminder))
        XCTAssertFalse(StaffRosterPush.isStaffRosterPayload(reminder))
        XCTAssertEqual(XertNotificationCategories.staffRoster, "xert.staff-roster")
    }

    func testTappedPushIsStoredOnceForColdLaunch() throws {
        let suiteName = "StaffRosterTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let notificationID = UUID()
        let target = StaffRosterPush.Target(
            link: XertCoachingLink(tab: .availability, month: "2026-12"),
            notificationID: notificationID
        )

        StaffRosterPushNavigation.markPending(target, defaults: defaults)
        XCTAssertEqual(StaffRosterPushNavigation.consumePending(defaults: defaults), target)
        XCTAssertNil(StaffRosterPushNavigation.consumePending(defaults: defaults))

        StaffRosterPushNavigation.markPending(target, defaults: defaults)
        StaffRosterPushNavigation.clearPending(defaults: defaults)
        XCTAssertNil(StaffRosterPushNavigation.consumePending(defaults: defaults))

        defaults.set("/open/coaching/payroll", forKey: StaffRosterPushNavigation.pendingPathKey)
        XCTAssertNil(StaffRosterPushNavigation.consumePending(defaults: defaults))
        XCTAssertNil(defaults.string(forKey: StaffRosterPushNavigation.pendingPathKey))
    }

    // MARK: Brisbane time

    func testBrisbaneDatesAndMonthBoundaries() throws {
        // 05:30 on 1 November in Brisbane is still 31 October in UTC.
        let earlyNovember = try utc("2026-10-31T19:30:00Z")
        XCTAssertEqual(StaffRosterTime.dateKey(for: earlyNovember), "2026-11-01")
        XCTAssertEqual(StaffRosterTime.monthKey(for: earlyNovember), "2026-11")
        XCTAssertEqual(StaffRosterTime.timeLabel(earlyNovember), "5:30 am")

        let lateOctober = try utc("2026-10-31T13:59:00Z")
        XCTAssertEqual(StaffRosterTime.monthKey(for: lateOctober), "2026-10")

        let november = try XCTUnwrap(StaffRosterTime.monthInterval("2026-11"))
        XCTAssertEqual(november.start, try utc("2026-10-31T14:00:00Z"))
        XCTAssertEqual(november.end, try utc("2026-11-30T14:00:00Z"))
        XCTAssertTrue(november.contains(earlyNovember))
        XCTAssertFalse(november.contains(lateOctober))
        XCTAssertNil(StaffRosterTime.monthInterval("2026-13"))

        XCTAssertEqual(StaffRosterTime.dates(inMonth: "2026-11").count, 30)
        XCTAssertEqual(StaffRosterTime.dates(inMonth: "2028-02").count, 29)
        XCTAssertEqual(StaffRosterTime.dates(inMonth: "2026-11").first, "2026-11-01")
        XCTAssertEqual(StaffRosterTime.dates(inMonth: "2026-11").last, "2026-11-30")
        XCTAssertEqual(StaffRosterTime.shiftMonth("2026-12", by: 1), "2027-01")
        XCTAssertEqual(StaffRosterTime.shiftMonth("2027-01", by: -1), "2026-12")
        XCTAssertEqual(StaffRosterTime.monthParameter("2026-11"), "2026-11-01")
        XCTAssertEqual(StaffRosterTime.weekday("2026-11-01"), 0)
        XCTAssertEqual(StaffRosterTime.weekday("2026-11-02"), 1)
        XCTAssertNil(StaffRosterTime.startOfDay("2026-02-30"))
        XCTAssertEqual(StaffRosterTime.minuteOfDay(earlyNovember), 330)
        XCTAssertEqual(StaffRosterTime.minuteLabel(315), "5:15 am")
        XCTAssertEqual(StaffRosterTime.minuteLabel(1_050), "5:30 pm")
        XCTAssertEqual(StaffRosterTime.clockLabel(1_440), "24:00")
        XCTAssertEqual(StaffRosterTime.monthLabel("2026-11-01"), "November 2026")

        let window = StaffRosterTime.rosterWindow(now: earlyNovember)
        XCTAssertEqual(window.from, "2026-11-01")
        XCTAssertEqual(window.to, "2027-01-02")
    }

    func testRosterGroupsByBrisbaneDateInStartOrder() throws {
        let roster = try StaffRosterJSON.decoder.decode(StaffRosterMyRoster.self, from: Data(Self.myRosterJSON.utf8))
        let groups = StaffRosterTime.groupedByDate(roster.assignments)
        XCTAssertEqual(groups.map(\.date), ["2026-11-02", "2026-11-03"])
        // The 5:15 am class on Monday 2 November starts on Sunday in UTC.
        XCTAssertEqual(groups[0].items.map(\.displayTitle), ["Strength 5:15", "XERT class"])
        XCTAssertEqual(StaffRosterTime.timeLabel(groups[0].items[0].start), "5:15 am")
        XCTAssertEqual(groups[1].items.count, 1)
    }

    // MARK: Decoding

    func testDecodesStaffRosterMe() throws {
        let me = try StaffRosterJSON.decoder.decode(StaffRosterMe.self, from: Data(Self.meJSON.utf8))
        XCTAssertEqual(me.staff.display_name, "Sam Coach")
        XCTAssertEqual(me.staff.status, "active")
        XCTAssertEqual(me.today, "2026-10-01")
        XCTAssertEqual(me.settings?.class_time_presets?.map(\.minute), [315, 375, 570, 990, 1050])
        XCTAssertEqual(me.usual_week?.version, 3)
        XCTAssertEqual(me.usual_week?.pattern.first, StaffWeeklyWindow(weekday: 1, start: 300, end: 480, status: "AVAILABLE"))
        XCTAssertEqual(me.last_submission?.month, "2026-10-01")
        XCTAssertEqual(me.periods.count, 2)

        let november = me.periods[0]
        XCTAssertEqual(november.monthKey, "2026-11")
        XCTAssertTrue(november.is_open)
        XCTAssertFalse(november.deadline_passed)
        XCTAssertEqual(november.draft?.version, 2)
        XCTAssertEqual(november.draft?.payload.exceptions.first?.date, "2026-11-14")
        XCTAssertNil(november.submission)
        XCTAssertEqual(StaffAvailabilityEditor.phase(november), .open)

        let october = me.periods[1]
        XCTAssertEqual(october.submission?.version, 1)
        XCTAssertEqual(october.submission?.no_availability, true)
        XCTAssertEqual(october.submission?.late, false)
        XCTAssertEqual(StaffAvailabilityEditor.phase(october), .closed)

        XCTAssertEqual(me.unread_notifications, 2)
        XCTAssertEqual(me.pending_acknowledgements.first?.number, 4)
        XCTAssertEqual(StaffAvailabilityEditor.preferredPeriod(me.periods, monthKey: nil)?.monthKey, "2026-11")
        XCTAssertEqual(StaffAvailabilityEditor.preferredPeriod(me.periods, monthKey: "2026-10")?.monthKey, "2026-10")
    }

    func testDecodesStaffRosterMeWithNullOptionalSections() throws {
        let json = """
        {"staff":{"id":"6f1c2a5e-8f73-4d5c-9b9e-0c3a7d1e2f40","display_name":"New Coach","roles":null,"status":"active"},
         "today":"2026-10-01","settings":null,"usual_week":null,"last_submission":null,
         "periods":[],"unread_notifications":0,"pending_acknowledgements":[]}
        """
        let me = try StaffRosterJSON.decoder.decode(StaffRosterMe.self, from: Data(json.utf8))
        XCTAssertNil(me.usual_week)
        XCTAssertTrue(me.periods.isEmpty)
        XCTAssertEqual(StaffAvailabilityEditor.phase(nil), StaffAvailabilityEditor.Phase.none)
    }

    func testDecodesMyRosterAssignments() throws {
        let roster = try StaffRosterJSON.decoder.decode(StaffRosterMyRoster.self, from: Data(Self.myRosterJSON.utf8))
        XCTAssertEqual(roster.assignments.count, 3)
        let moved = try XCTUnwrap(roster.assignments.first { $0.changed_since_publish && !$0.isCancelled })
        XCTAssertEqual(moved.revision_number, 4)
        XCTAssertEqual(moved.role, "lead")
        XCTAssertEqual(moved.roleLabel, "Lead")
        XCTAssertEqual(moved.colleagues.first?.display_name, "Alex")
        XCTAssertEqual(moved.cover?.status, "open")
        XCTAssertEqual(moved.availability, "UNKNOWN")
        XCTAssertFalse(moved.acknowledged)
        XCTAssertEqual(moved.published_start, try utc("2026-11-01T19:00:00+00:00"))

        let removed = try XCTUnwrap(roster.assignments.first { $0.status == "removed" })
        XCTAssertTrue(removed.isCancelled)
        XCTAssertNil(removed.duty_start)
        XCTAssertEqual(roster.pending_acknowledgements.first?.month, "2026-11-01")
    }

    func testDecodesCoverBoardRequestsNotificationsAndMonthClasses() throws {
        let board = try StaffRosterJSON.decoder.decode([StaffRosterCoverBoardItem].self, from: Data(Self.coverBoardJSON.utf8))
        XCTAssertEqual(board.count, 2)
        XCTAssertEqual(board[0].requested_by, "Jordan")
        XCTAssertNil(board[0].my_offer)
        XCTAssertEqual(board[1].my_offer, "offered")
        XCTAssertEqual(board[1].problems, ["CLASS_OVERLAP"])

        let requests = try StaffRosterJSON.decoder.decode(StaffRosterMyRequests.self, from: Data(Self.myRequestsJSON.utf8))
        XCTAssertEqual(requests.absences.first?.kind, "planned")
        XCTAssertEqual(requests.absences.first?.status, "requested")
        XCTAssertEqual(requests.cover_requests.first?.offers, 1)
        XCTAssertEqual(requests.cover_requests.first?.status, "offered")
        XCTAssertEqual(requests.offers.first?.status, "approved")
        XCTAssertEqual(requests.change_requests.first?.month, "2026-10-01")
        XCTAssertFalse(requests.isEmpty)

        let notices = try StaffRosterJSON.decoder.decode([StaffRosterNotification].self, from: Data(Self.notificationsJSON.utf8))
        XCTAssertEqual(notices.count, 2)
        XCTAssertTrue(notices[0].isUnread)
        XCTAssertFalse(notices[1].isUnread)
        XCTAssertEqual(notices[0].coachingLink, XertCoachingLink(tab: .availability, month: "2026-12"))
        XCTAssertNil(notices[1].coachingLink)

        let classes = try StaffRosterJSON.decoder.decode([StaffRosterMonthClass].self, from: Data(Self.monthClassesJSON.utf8))
        XCTAssertEqual(classes.count, 2)
        XCTAssertEqual(classes[0].dutyInterval.start, try utc("2026-11-01T19:00:00+00:00"))
        XCTAssertEqual(classes[1].dutyInterval.start, classes[1].start)
    }

    func testDecodesMutationResults() throws {
        let decoder = StaffRosterJSON.decoder
        let version = try decoder.decode(
            StaffRosterVersionResult.self,
            from: Data(#"{"version":3,"updated_at":"2026-10-01T03:12:45.123456+00:00"}"#.utf8)
        )
        XCTAssertEqual(version.version, 3)
        XCTAssertNotNil(version.updated_at)

        let submit = try decoder.decode(
            StaffRosterSubmitResult.self,
            from: Data(#"{"submission_id":"0b5a0a52-3c7a-4b55-9f43-7f0c6c0d9a11","version":2,"late":false,"no_availability":false}"#.utf8)
        )
        XCTAssertEqual(submit.version, 2)

        let absence = try decoder.decode(
            StaffRosterAbsenceResult.self,
            from: Data(#"{"id":"0b5a0a52-3c7a-4b55-9f43-7f0c6c0d9a12","status":"reported","affected_classes":2}"#.utf8)
        )
        XCTAssertEqual(absence.affected_classes, 2)

        let ack = try decoder.decode(StaffRosterAcknowledgeResult.self, from: Data(#"{"ok":true,"acknowledged":true}"#.utf8))
        XCTAssertTrue(ack.acknowledged)

        let offer = try decoder.decode(StaffRosterStatusResult.self, from: Data(#"{"ok":true,"status":"offered"}"#.utf8))
        XCTAssertEqual(offer.status, "offered")
        XCTAssertNil(offer.id)

        XCTAssertEqual(try decoder.decode(Int.self, from: Data("2".utf8)), 2)
    }

    func testAvailabilityPayloadUsesTheDatabaseKeys() throws {
        let payload = StaffAvailabilityPayload(
            weekly: [StaffWeeklyWindow(weekday: 1, start: 300, end: 480, status: "PREFERRED")],
            exceptions: [StaffDateWindow(date: "2026-11-14", start: 0, end: 1_440, status: "UNAVAILABLE")],
            noAvailability: false
        )
        let data = try StaffRosterJSON.encoder.encode(payload)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["weekly", "exceptions", "noAvailability"])
        let weekly = try XCTUnwrap(object["weekly"] as? [[String: Any]])
        XCTAssertEqual(Set(weekly[0].keys), ["weekday", "start", "end", "status"])
        let exceptions = try XCTUnwrap(object["exceptions"] as? [[String: Any]])
        XCTAssertEqual(Set(exceptions[0].keys), ["date", "start", "end", "status"])

        let partial = try StaffRosterJSON.decoder.decode(StaffAvailabilityPayload.self, from: Data(#"{"weekly":[]}"#.utf8))
        XCTAssertEqual(partial, StaffAvailabilityPayload())
    }

    // MARK: Errors and visibility

    func testRosterErrorsMapDatabaseCodes() {
        let notStaff = StaffRosterError.from(APIError(message: "NOT_STAFF", statusCode: 400))
        XCTAssertEqual(notStaff.code, "NOT_STAFF")
        XCTAssertTrue(notStaff.isAccessDenied)

        let stale = StaffRosterError.from(APIError(message: "P0001: STALE_VERSION", statusCode: 400))
        XCTAssertTrue(stale.isStaleVersion)
        XCTAssertFalse(stale.isAccessDenied)

        let offline = StaffRosterError.from(APIError(message: "XERT is offline. Check your connection."))
        XCTAssertNil(offline.code)
        XCTAssertEqual(offline.message, "XERT is offline. Check your connection.")

        XCTAssertTrue(StaffRosterError.from(APIError(message: "ROSTER_DISABLED")).isAccessDenied)
        XCTAssertTrue(StaffRosterError.from(APIError(message: "STAFF_INACTIVE")).isAccessDenied)
    }

    func testMyCoachingIsVisibleOnlyForAnActiveCoach() throws {
        let me = try StaffRosterJSON.decoder.decode(StaffRosterMe.self, from: Data(Self.meJSON.utf8))
        XCTAssertTrue(StaffRosterVisibility.showsEntry(for: .coach(me)))

        let inactiveJSON = Self.meJSON.replacingOccurrences(of: #""status": "active""#, with: #""status": "inactive""#)
        let inactive = try StaffRosterJSON.decoder.decode(StaffRosterMe.self, from: Data(inactiveJSON.utf8))
        XCTAssertFalse(StaffRosterVisibility.showsEntry(for: .coach(inactive)))

        XCTAssertFalse(StaffRosterVisibility.showsEntry(for: .unknown))
        XCTAssertFalse(StaffRosterVisibility.showsEntry(for: .checking))
        XCTAssertFalse(StaffRosterVisibility.showsEntry(for: .unavailable(StaffRosterError(code: "ROSTER_DISABLED", message: ""))))
        XCTAssertFalse(StaffRosterVisibility.showsEntry(for: .unavailable(StaffRosterError(code: "NOT_STAFF", message: ""))))
        XCTAssertFalse(StaffRosterVisibility.showsEntry(for: .failed(StaffRosterError(code: nil, message: "offline"))))
    }

    @MainActor
    func testStoreStartsHiddenAndOpensLinksInOrder() {
        let store = StaffRosterStore()
        XCTAssertFalse(store.showsEntry)
        XCTAssertNil(store.me)
        let before = store.linkSequence
        store.open(XertCoachingLink(tab: .requests))
        XCTAssertEqual(store.linkSequence, before &+ 1)
        XCTAssertEqual(store.requestedLink, XertCoachingLink(tab: .requests))
        store.reset()
        XCTAssertEqual(store.access, .unknown)
    }

    // MARK: Availability editor

    func testAvailabilityValidationAndReview() throws {
        XCTAssertFalse(StaffAvailabilityEditor.validate(StaffAvailabilityPayload(), monthKey: "2026-11").isEmpty)
        XCTAssertTrue(StaffAvailabilityEditor.validate(
            StaffAvailabilityPayload(noAvailability: true),
            monthKey: "2026-11"
        ).isEmpty)
        XCTAssertFalse(StaffAvailabilityEditor.validate(
            StaffAvailabilityPayload(exceptions: [StaffDateWindow(date: "2026-12-01", start: 0, end: 1_440, status: "UNAVAILABLE")]),
            monthKey: "2026-11"
        ).isEmpty)
        XCTAssertFalse(StaffAvailabilityEditor.validate(
            StaffAvailabilityPayload(weekly: [
                StaffWeeklyWindow(weekday: 1, start: 300, end: 480, status: "AVAILABLE"),
                StaffWeeklyWindow(weekday: 1, start: 420, end: 540, status: "UNAVAILABLE"),
            ]),
            monthKey: "2026-11"
        ).isEmpty)

        let classes = try StaffRosterJSON.decoder.decode([StaffRosterMonthClass].self, from: Data(Self.monthClassesJSON.utf8))
        // Monday 2 Nov 5:15 class: duty 05:00–06:15. Monday 9 Nov 5:15: no duty, 05:15–06:15.
        let weekly = StaffAvailabilityPayload(weekly: [StaffWeeklyWindow(weekday: 1, start: 300, end: 390, status: "PREFERRED")])
        let review = StaffAvailabilityEditor.review(weekly, monthKey: "2026-11", classes: classes)
        XCTAssertTrue(review.errors.isEmpty)
        XCTAssertEqual(review.considered, 2)

        let shortDay = StaffAvailabilityPayload(
            weekly: [StaffWeeklyWindow(weekday: 1, start: 300, end: 390, status: "PREFERRED")],
            exceptions: [StaffDateWindow(date: "2026-11-09", start: 0, end: 1_440, status: "UNAVAILABLE")]
        )
        let away = StaffAvailabilityEditor.review(shortDay, monthKey: "2026-11", classes: classes)
        XCTAssertEqual(away.rows.map(\.status), ["PREFERRED", "UNAVAILABLE"])

        let partial = StaffAvailabilityPayload(weekly: [StaffWeeklyWindow(weekday: 1, start: 330, end: 390, status: "AVAILABLE")])
        XCTAssertEqual(StaffAvailabilityEditor.review(partial, monthKey: "2026-11", classes: classes).rows.first?.status, "PARTIAL")

        let shortcuts = StaffAvailabilityEditor.shortcuts(classes: classes, presets: [315])
        XCTAssertEqual(shortcuts.count, 1)
        XCTAssertEqual(shortcuts.first?.weekday, 1)
        XCTAssertEqual(shortcuts.first?.start, 300)
        XCTAssertEqual(shortcuts.first?.end, 375)
        XCTAssertEqual(shortcuts.first?.sessions, 2)

        let exception = try XCTUnwrap(StaffAvailabilityEditor.sessionException(classes[0], status: "UNAVAILABLE"))
        XCTAssertEqual(exception, StaffDateWindow(date: "2026-11-02", start: 300, end: 375, status: "UNAVAILABLE"))
    }

    // MARK: Fixtures (jsonb keys exactly as the migration builds them)

    private static let meJSON = """
    {
      "staff": {"id": "6f1c2a5e-8f73-4d5c-9b9e-0c3a7d1e2f40", "display_name": "Sam Coach", "roles": ["coach"], "status": "active"},
      "today": "2026-10-01",
      "settings": {"class_time_presets": [{"minute": 315}, {"minute": 375}, {"minute": 570}, {"minute": 990}, {"minute": 1050}], "cycle": {"open_day": 1}},
      "usual_week": {"pattern": [{"weekday": 1, "start": 300, "end": 480, "status": "AVAILABLE"}], "version": 3, "updated_at": "2026-09-20T01:00:00.52+00:00"},
      "last_submission": {"month": "2026-10-01", "payload": {"weekly": [], "exceptions": [], "noAvailability": true}, "no_availability": true},
      "periods": [
        {"month": "2026-11-01", "opens_on": "2026-10-01", "due_on": "2026-10-15", "publish_target_on": "2026-10-22", "shortened": false,
         "is_open": true, "deadline_passed": false, "reopened": false, "change_request_open": false,
         "draft": {"payload": {"weekly": [{"weekday": 1, "start": 300, "end": 480, "status": "PREFERRED"}],
                               "exceptions": [{"date": "2026-11-14", "start": 0, "end": 1440, "status": "UNAVAILABLE"}], "noAvailability": false},
                   "version": 2, "updated_at": "2026-10-01T03:12:45.123456+00:00"},
         "submission": null},
        {"month": "2026-10-01", "opens_on": "2026-09-01", "due_on": "2026-09-15", "publish_target_on": null, "shortened": null,
         "is_open": true, "deadline_passed": true, "reopened": false, "change_request_open": true,
         "draft": null,
         "submission": {"version": 1, "payload": {"weekly": [], "exceptions": [], "noAvailability": true},
                        "submitted_at": "2026-09-10T00:00:00+00:00", "late": false, "no_availability": true}}
      ],
      "unread_notifications": 2,
      "pending_acknowledgements": [{"month": "2026-11-01", "revision_id": "1a2b3c4d-0000-4000-8000-000000000004", "number": 4}]
    }
    """

    private static let myRosterJSON = """
    {
      "assignments": [
        {"assignment_id": "a0000000-0000-4000-8000-000000000003", "revision_id": "1a2b3c4d-0000-4000-8000-000000000004", "revision_number": 4,
         "month": "2026-11-01", "session_id": "c0000000-0000-4000-8000-000000000003", "slot_key": "assistant-1", "role": "assistant",
         "title": "Mobility", "class_type": "mobility", "start": "2026-11-02T20:30:00+00:00", "end": "2026-11-02T21:15:00+00:00",
         "duty_start": "2026-11-02T20:15:00+00:00", "duty_end": "2026-11-02T21:30:00+00:00", "status": "published",
         "published_start": "2026-11-02T20:30:00+00:00", "published_end": "2026-11-02T21:15:00+00:00", "changed_since_publish": false,
         "colleagues": [], "acknowledged": true, "cover": null, "availability": "AVAILABLE"},
        {"assignment_id": "a0000000-0000-4000-8000-000000000002", "revision_id": "1a2b3c4d-0000-4000-8000-000000000004", "revision_number": 4,
         "month": "2026-11-01", "session_id": null, "slot_key": "lead", "role": "lead",
         "title": null, "class_type": null, "start": "2026-11-02T08:00:00+00:00", "end": "2026-11-02T09:00:00+00:00",
         "duty_start": null, "duty_end": null, "status": "removed",
         "published_start": "2026-11-02T08:00:00+00:00", "published_end": "2026-11-02T09:00:00+00:00", "changed_since_publish": true,
         "colleagues": [], "acknowledged": false, "cover": null, "availability": null},
        {"assignment_id": "a0000000-0000-4000-8000-000000000001", "revision_id": "1a2b3c4d-0000-4000-8000-000000000004", "revision_number": 4,
         "month": "2026-11-01", "session_id": "c0000000-0000-4000-8000-000000000001", "slot_key": "lead", "role": "lead",
         "title": "Strength 5:15", "class_type": "strength", "start": "2026-11-01T19:15:00+00:00", "end": "2026-11-01T20:15:00+00:00",
         "duty_start": "2026-11-01T19:00:00+00:00", "duty_end": "2026-11-01T20:30:00+00:00", "status": "published",
         "published_start": "2026-11-01T19:00:00+00:00", "published_end": "2026-11-01T20:00:00+00:00", "changed_since_publish": true,
         "colleagues": [{"display_name": "Alex", "role": "assistant"}], "acknowledged": false,
         "cover": {"id": "d0000000-0000-4000-8000-000000000001", "status": "open"}, "availability": "UNKNOWN"}
      ],
      "pending_acknowledgements": [{"month": "2026-11-01", "revision_id": "1a2b3c4d-0000-4000-8000-000000000004", "number": 4}]
    }
    """

    private static let coverBoardJSON = """
    [
      {"id": "d0000000-0000-4000-8000-000000000010", "status": "open", "version": 1, "session_id": "c0000000-0000-4000-8000-000000000010",
       "slot_key": "lead", "title": "HIIT", "start": "2026-11-05T08:00:00+00:00", "end": "2026-11-05T09:00:00+00:00", "role": "lead",
       "requested_by": "Jordan", "my_offer": null, "problems": []},
      {"id": "d0000000-0000-4000-8000-000000000011", "status": "offered", "version": 2, "session_id": "c0000000-0000-4000-8000-000000000011",
       "slot_key": "assistant-1", "title": null, "start": "2026-11-06T08:00:00+00:00", "end": null, "role": "assistant",
       "requested_by": "Riley", "my_offer": "offered", "problems": ["CLASS_OVERLAP"]}
    ]
    """

    private static let myRequestsJSON = """
    {
      "absences": [{"id": "e0000000-0000-4000-8000-000000000001", "starts_at": "2026-11-13T14:00:00+00:00", "ends_at": "2026-11-15T14:00:00+00:00",
                    "kind": "planned", "status": "requested", "reason": null, "created_at": "2026-10-01T00:00:00+00:00"}],
      "cover_requests": [{"id": "d0000000-0000-4000-8000-000000000001", "status": "offered", "title": "Strength 5:15",
                          "start": "2026-11-01T19:00:00+00:00", "offers": 1}],
      "offers": [{"request_id": "d0000000-0000-4000-8000-000000000020", "status": "approved", "title": "Pilates", "start": "2026-11-07T22:00:00+00:00"}],
      "change_requests": [{"id": "f0000000-0000-4000-8000-000000000001", "month": "2026-10-01", "status": "open",
                           "message": "I can do Thursdays now", "created_at": "2026-09-20T00:00:00+00:00"}]
    }
    """

    private static let notificationsJSON = """
    [
      {"id": "b0000000-0000-4000-8000-000000000001", "kind": "availability_open", "title": "December availability is open",
       "body": "Tell the manager when you can coach.", "link": "/coaching?tab=availability&month=2026-12",
       "created_at": "2026-11-01T00:00:00.5+00:00", "read_at": null},
      {"id": "b0000000-0000-4000-8000-000000000002", "kind": "manager_note", "title": "Note", "body": "Hi",
       "link": null, "created_at": "2026-10-20T00:00:00+00:00", "read_at": "2026-10-21T00:00:00+00:00"}
    ]
    """

    private static let monthClassesJSON = """
    [
      {"id": "c0000000-0000-4000-8000-000000000001", "title": "Strength", "class_type": "strength",
       "start": "2026-11-01T19:15:00+00:00", "end": "2026-11-01T20:15:00+00:00",
       "duty_start": "2026-11-01T19:00:00+00:00", "duty_end": "2026-11-01T20:15:00+00:00",
       "prep_minutes": 15, "wrap_minutes": 0, "allow_block": true},
      {"id": "c0000000-0000-4000-8000-000000000002", "title": "Strength", "class_type": "strength",
       "start": "2026-11-08T19:15:00+00:00", "end": "2026-11-08T20:15:00+00:00",
       "duty_start": null, "duty_end": null, "prep_minutes": 0, "wrap_minutes": 0, "allow_block": true}
    ]
    """
}
