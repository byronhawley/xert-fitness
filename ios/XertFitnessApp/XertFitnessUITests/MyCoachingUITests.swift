import XCTest

/// Simulator journeys through native My Coaching against the DEBUG-only
/// in-memory fixtures (`-XertRosterFixtures`). The app never reaches
/// Supabase, Vercel or APNs in this mode, and no real staff exist.
///
/// What this does not prove (still device-only): real universal-link
/// delivery from Safari/Mail/Messages, APNs receipt and tap on a device,
/// and a TestFlight build.
final class MyCoachingUITests: XCTestCase {
    private let webHost = "xert-fitness.vercel.app"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // MARK: Journeys

    /// Account → My Coaching → Upcoming and My Roster, with the 5:15 am
    /// Brisbane class and the class on the first day of next month.
    func testCoachWalksUpcomingAndMyRosterAcrossTheMonthBoundary() throws {
        let app = launch()
        capture("01-home", app)
        openMyCoaching(app)

        let dawn = element(containing: "Dawn Strength", in: app)
        XCTAssertTrue(dawn.waitForExistence(timeout: 10), "next class")
        XCTAssertTrue(dawn.label.contains("5:15 am"), dawn.label)
        XCTAssertTrue(dawn.label.contains("on duty from 5:00 am"), dawn.label)
        capture("03-upcoming-early-morning", app)

        selectSection("My Roster", app)
        XCTAssertTrue(element(containing: "gym time (Brisbane)", in: app).waitForExistence(timeout: 10))
        capture("04-my-roster-this-month", app)

        let next = app.buttons["Next month"]
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        next.tap()
        XCTAssertTrue(element(containing: Self.monthTitle(offset: 1), in: app).waitForExistence(timeout: 5))
        let turn = element(containing: "Month Turn HIIT", in: app)
        XCTAssertTrue(reveal(turn, in: app), "class on the 1st of next month")
        XCTAssertTrue(turn.label.contains("5:30 am"), turn.label)
        // Grouped under its Brisbane date (it is still the previous day in UTC).
        XCTAssertTrue(element(containing: Self.firstOfNextMonthTitle(), in: app).exists)
        capture("05-my-roster-month-boundary", app)
    }

    /// Availability: edit, autosave, review, submit.
    func testAvailabilityEditSaveReviewAndSubmit() throws {
        let app = launch()
        openMyCoaching(app)
        selectSection("Availability", app)
        XCTAssertTrue(element(containing: "Not submitted yet", in: app).waitForExistence(timeout: 10))
        capture("06-availability-open", app)

        answerMondayDawnPreferred(app)
        scrollToTop(app)
        XCTAssertTrue(element(containing: "Draft saved", in: app).waitForExistence(timeout: 10), "autosave")
        capture("07-availability-draft-saved", app)

        let review = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Review ")).firstMatch
        XCTAssertTrue(reveal(review, in: app), "review button")
        review.tap()
        XCTAssertTrue(element(containing: "be considered for", in: app).waitForExistence(timeout: 5))
        capture("08-availability-review", app)

        let submit = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Submit ")).firstMatch
        XCTAssertTrue(reveal(submit, in: app), "submit button")
        submit.tap()
        scrollToTop(app)
        XCTAssertTrue(element(containing: "Submitted version 1", in: app).waitForExistence(timeout: 10))
        capture("09-availability-submitted", app)
    }

    /// A failed draft save is shown plainly and can be retried.
    func testAvailabilitySaveFailureShowsRetry() throws {
        let app = launch("saveFailure")
        openMyCoaching(app)
        selectSection("Availability", app)
        XCTAssertTrue(element(containing: "Not submitted yet", in: app).waitForExistence(timeout: 10))

        answerMondayDawnPreferred(app)
        scrollToTop(app)
        XCTAssertTrue(element(containing: "XERT is offline", in: app).waitForExistence(timeout: 10), "save failure")
        capture("10-availability-save-failed", app)

        let retry = app.buttons["Try again"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        XCTAssertTrue(element(containing: "Draft saved", in: app).waitForExistence(timeout: 10), "retry saves")
        capture("11-availability-retry-saved", app)
    }

    /// STALE_VERSION never overwrites the other version silently.
    func testAvailabilityStaleVersionConflict() throws {
        let app = launch("staleConflict")
        openMyCoaching(app)
        selectSection("Availability", app)
        XCTAssertTrue(element(containing: "Not submitted yet", in: app).waitForExistence(timeout: 10))

        answerMondayDawnPreferred(app)
        scrollToTop(app)
        XCTAssertTrue(element(containing: "changed somewhere else", in: app).waitForExistence(timeout: 10), "conflict")
        capture("12-availability-stale-conflict", app)

        let latest = app.buttons["Load latest"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        latest.tap()
        XCTAssertTrue(element(containing: "Draft saved", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(element(containing: "changed somewhere else", in: app).exists)
        capture("13-availability-latest-loaded", app)
    }

    /// Requests: existing absence, a volunteered cover, offering to cover,
    /// and asking for time away.
    func testAbsenceAndCoverVolunteering() throws {
        let app = launch()
        openMyCoaching(app)
        selectSection("Requests", app)

        XCTAssertTrue(element(containing: "Jordan asked for cover", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(reveal(element(containing: "1 coach has volunteered", in: app), in: app))
        XCTAssertTrue(reveal(element(containing: "Waiting for the manager", in: app), in: app))
        capture("14-requests", app)

        scrollToTop(app)
        let offer = app.buttons["I can cover this"]
        XCTAssertTrue(reveal(offer, in: app))
        offer.tap()
        XCTAssertTrue(element(containing: "You volunteered", in: app).waitForExistence(timeout: 10))
        capture("15-requests-volunteered", app)

        scrollToTop(app)
        let away = app.buttons["I need time away"]
        XCTAssertTrue(reveal(away, in: app, upward: false))
        away.tap()
        let ask = app.navigationBars["Time away"].buttons["Ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        capture("16-absence-sheet", app)
        ask.tap()
        scrollToTop(app)
        XCTAssertTrue(element(containing: "Sent to the manager for approval", in: app).waitForExistence(timeout: 10))
        capture("17-absence-sent", app)
    }

    /// Roster switched off: the Account entry is not shown at all.
    func testFeatureOffHidesMyCoaching() throws {
        let app = launch("featureOff")
        openAccount(app)
        XCTAssertTrue(element(containing: "Your XERT", in: app).waitForExistence(timeout: 10), "signed in")
        // Give the access check time to answer before asserting absence.
        _ = app.buttons["account-my-coaching"].waitForExistence(timeout: 4)
        XCTAssertFalse(app.buttons["account-my-coaching"].exists)
        capture("18-feature-off-account", app)
    }

    /// Signed out: a My Coaching link asks for sign-in and continues to the
    /// same section afterwards.
    func testSignedOutLinkContinuesToMyCoachingAfterSignIn() throws {
        let app = launch("signedOut", environment: [
            "XERT_FIXTURE_OPEN_URL": "https://\(webHost)/open/coaching/availability",
        ])
        XCTAssertTrue(app.staticTexts["Sign in to continue"].waitForExistence(timeout: 15))
        XCTAssertTrue(element(containing: "My Coaching", in: app).exists)
        capture("19-signed-out-link-sign-in", app)

        let email = app.textFields["Email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.tap()
        email.typeText("coach.fixture@example.invalid")
        let password = app.secureTextFields["Password"]
        password.tap()
        // Return submits the form (the Sign In button can sit under the keyboard).
        password.typeText("fixture-password\n")

        XCTAssertTrue(app.staticTexts["Hi Sam Fixture"].waitForExistence(timeout: 15), "continued after sign-in")
        XCTAssertTrue(element(containing: "Not submitted yet", in: app).waitForExistence(timeout: 10), "availability section kept")
        capture("20-signed-out-link-continued", app)
    }

    // MARK: Notification destinations

    /// Coach notice: the push opens My Coaching on the named section.
    func testCoachPushOpensMyCoaching() throws {
        let app = launch(environment: [
            "XERT_FIXTURE_PUSH_OPEN_PATH": "/open/coaching/requests",
            "XERT_FIXTURE_PUSH_AUDIENCE": "coach",
        ])
        XCTAssertTrue(app.staticTexts["Hi Sam Fixture"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["I need time away"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["uitest-opened-external-url"].exists)
        capture("21-coach-push-my-coaching", app)
    }

    /// Manager notice for an admin who also coaches: the web console opens on
    /// the canonical host, `rosterFocus` is dropped, My Coaching does not open.
    func testManagerPushOpensTheWebConsoleNotMyCoaching() throws {
        let app = launch(environment: [
            "XERT_FIXTURE_PUSH_OPEN_PATH": "/admin/roster?rosterTab=requests&rosterMonth=2026-11&rosterFocus=0b5a0a52-3c7a-4b55-9f43-7f0c6c0d9a12",
            "XERT_FIXTURE_PUSH_AUDIENCE": "manager",
        ])
        let opened = app.staticTexts["uitest-opened-external-url"]
        XCTAssertTrue(opened.waitForExistence(timeout: 15))
        XCTAssertEqual(opened.label, "https://\(webHost)/admin/roster?rosterTab=requests&rosterMonth=2026-11")
        XCTAssertFalse(app.staticTexts["Hi Sam Fixture"].waitForExistence(timeout: 3))
        capture("22-manager-push-web-console", app)
    }

    /// Manager notice while signed out, with no `audience` (inferred from the
    /// path): the console opens without an app sign-in; the web signs in.
    func testSignedOutManagerPushNeedsNoAppSignIn() throws {
        let app = launch("signedOut", environment: [
            "XERT_FIXTURE_PUSH_OPEN_PATH": "/admin/roster?rosterTab=availability&rosterMonth=2026-12",
        ])
        let opened = app.staticTexts["uitest-opened-external-url"]
        XCTAssertTrue(opened.waitForExistence(timeout: 15))
        XCTAssertEqual(opened.label, "https://\(webHost)/admin/roster?rosterTab=availability&rosterMonth=2026-12")
        XCTAssertFalse(app.staticTexts["Sign in to continue"].exists)
        capture("23-manager-push-signed-out", app)
    }

    /// Coach access revoked after the notice: My Coaching opens but shows its
    /// not-available state; nothing from the roster is shown.
    func testRevokedCoachSeesNotAvailable() throws {
        let app = launch("revoked", environment: [
            "XERT_FIXTURE_PUSH_OPEN_PATH": "/open/coaching/roster",
            "XERT_FIXTURE_PUSH_AUDIENCE": "coach",
        ])
        let notAvailable = app.descendants(matching: .any)["coaching-not-available"]
        XCTAssertTrue(notAvailable.waitForExistence(timeout: 15))
        XCTAssertFalse(element(containing: "Dawn Strength", in: app).exists)
        capture("24-revoked-not-available", app)
    }

    /// An in-app manager notice (`/admin/roster?…`) shown to an admin who
    /// also coaches opens the web console, not a My Coaching section.
    func testInAppManagerNoticeOpensTheWebConsole() throws {
        let app = launch()
        openMyCoaching(app)
        let console = app.buttons["Open manager console"]
        XCTAssertTrue(reveal(console, in: app), "manager notice action")
        capture("25-in-app-manager-notice", app)
        console.tap()
        let opened = app.staticTexts["uitest-opened-external-url"]
        XCTAssertTrue(opened.waitForExistence(timeout: 5))
        XCTAssertTrue(opened.label.hasPrefix("https://\(webHost)/admin/roster?rosterTab=requests&rosterMonth="), opened.label)
        XCTAssertFalse(opened.label.contains("rosterFocus"), opened.label)
        capture("26-in-app-manager-notice-opened", app)
    }

    // MARK: Helpers

    private func launch(_ scenario: String = "coach", environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-XertRosterFixtures", "-AppleLanguages", "(en)", "-AppleLocale", "en_AU"]
        app.launchEnvironment["XERT_FIXTURE_SCENARIO"] = scenario
        for (key, value) in environment {
            app.launchEnvironment[key] = value
        }
        app.launch()
        return app
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(containing text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", text))
            .firstMatch
    }

    private func openAccount(_ app: XCUIApplication) {
        let account = app.buttons.matching(identifier: "xert-navigation-account").firstMatch
        XCTAssertTrue(account.waitForExistence(timeout: 20), "Account in the dock")
        account.tap()
    }

    private func openMyCoaching(_ app: XCUIApplication) {
        openAccount(app)
        let entry = app.buttons["account-my-coaching"]
        XCTAssertTrue(reveal(entry, in: app), "My Coaching entry")
        capture("02-account-my-coaching", app)
        entry.tap()
        XCTAssertTrue(app.staticTexts["Hi Sam Fixture"].waitForExistence(timeout: 10), "My Coaching opened")
    }

    private func selectSection(_ title: String, _ app: XCUIApplication) {
        scrollToTop(app)
        let segment = app.segmentedControls.buttons[title]
        if segment.waitForExistence(timeout: 5) {
            segment.tap()
        } else {
            app.buttons[title].firstMatch.tap()
        }
    }

    /// Answers "Preferred" for the Monday 5:15 am class shortcut.
    private func answerMondayDawnPreferred(_ app: XCUIApplication) {
        let preferred = app.buttons["Monday 5:15 am: Preferred"]
        XCTAssertTrue(reveal(preferred, in: app, timeout: 10), "Monday 5:15 am shortcut")
        preferred.tap()
    }

    private func scrollable(_ app: XCUIApplication) -> XCUIElement {
        let list = app.collectionViews.firstMatch
        return list.exists ? list : app
    }

    private func scrollToTop(_ app: XCUIApplication) {
        for _ in 0..<4 {
            scrollable(app).swipeDown()
        }
    }

    /// Scrolls until the element is on screen. Lists only build visible rows.
    @discardableResult
    private func reveal(
        _ element: XCUIElement,
        in app: XCUIApplication,
        upward: Bool = true,
        timeout: TimeInterval = 3,
        attempts: Int = 10
    ) -> Bool {
        if element.waitForExistence(timeout: timeout), element.isHittable { return true }
        for _ in 0..<attempts {
            if upward {
                scrollable(app).swipeUp()
            } else {
                scrollable(app).swipeDown()
            }
            if element.exists, element.isHittable { return true }
        }
        return element.exists
    }

    private static var brisbane: TimeZone {
        TimeZone(identifier: "Australia/Brisbane") ?? TimeZone(secondsFromGMT: 10 * 3_600)!
    }

    private static func brisbaneCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = brisbane
        return calendar
    }

    private static func formatted(_ date: Date, _ format: String) -> String {
        let formatter = DateFormatter()
        formatter.calendar = brisbaneCalendar()
        formatter.locale = Locale(identifier: "en_AU")
        formatter.timeZone = brisbane
        formatter.dateFormat = format
        return formatter.string(from: date)
    }

    private static func firstOfMonth(offset: Int) -> Date {
        let calendar = brisbaneCalendar()
        let parts = calendar.dateComponents([.year, .month], from: Date())
        let start = calendar.date(from: parts) ?? Date()
        return calendar.date(byAdding: .month, value: offset, to: start) ?? start
    }

    /// `November 2026`, as the month navigator shows it.
    private static func monthTitle(offset: Int) -> String {
        formatted(firstOfMonth(offset: offset), "MMMM yyyy")
    }

    /// `Sunday 1 November`, the Brisbane date header of the boundary class.
    private static func firstOfNextMonthTitle() -> String {
        formatted(firstOfMonth(offset: 1), "EEEE d MMMM")
    }
}
