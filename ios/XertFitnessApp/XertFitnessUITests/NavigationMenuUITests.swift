import XCTest

final class NavigationMenuUITests: XCTestCase {
    func testDockAndSearchOnPhone() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-XertRosterFixtures", "-AppleLanguages", "(en)", "-AppleLocale", "en_AU"]
        app.launchEnvironment["XERT_FIXTURE_SCENARIO"] = "coach"
        app.launch()
        for id in ["book", "events", "explore", "account", "home"] {
            let tab = app.buttons["xert-navigation-\(id)"]
            XCTAssertTrue(tab.waitForExistence(timeout: 10), id)
            XCTAssertGreaterThanOrEqual(tab.frame.width, 44)
            XCTAssertGreaterThanOrEqual(tab.frame.height, 44)
            tab.tap()
            XCTAssertTrue(tab.isSelected || tab.value as? String == "Selected")
        }
        capture("Navigation dock", app)
        app.buttons["xert-navigation-menu"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 8))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("Navigation menu", app)
        search.tap()
        search.typeText("Account")
        let result = app.buttons.containing(NSPredicate(format: "label CONTAINS[c] 'Account'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        result.tap()
        XCTAssertTrue(app.buttons["xert-navigation-account"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["xert-navigation-account"].isSelected || app.buttons["xert-navigation-account"].value as? String == "Selected")
    }

    func testLargestTextKeepsMenuReachableAndOwnerActionsPrivate() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-XertRosterFixtures", "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityXXXL"
        ]
        app.launchEnvironment["XERT_FIXTURE_SCENARIO"] = "coach"
        app.launch()
        let menu = app.buttons["xert-navigation-menu"]
        let home = app.buttons["xert-navigation-home"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        XCTAssertTrue(menu.isHittable)
        XCTAssertGreaterThan(menu.frame.minY, home.frame.minY)
        menu.tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Owner Command Centre")
        XCTAssertTrue(app.staticTexts["No matching XERT actions"].waitForExistence(timeout: 5))
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
