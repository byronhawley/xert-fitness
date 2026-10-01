import XCTest
@testable import XertFitness

final class MemberLaunchGuideTests: XCTestCase {
    private let bookingID = UUID()
    private let confirmedBookingID = UUID()

    func testSignedOutMemberStartsWithSignIn() {
        XCTAssertEqual(resolve(isSignedIn: false), .signIn)
    }

    func testIncompleteReadinessPrecedesBooking() {
        XCTAssertEqual(
            resolve(
                readinessComplete: false,
                bookingsLoaded: true,
                nextActiveBookingID: bookingID,
                classRemindersEnabled: true
            ),
            .completeReadiness
        )
    }

    func testReadyMemberWithoutBookingBooksFirstClass() {
        XCTAssertEqual(resolve(bookingsLoaded: true), .bookFirstClass)
    }

    func testReadyMemberWaitsForBookingsBeforeChoosingNextStep() {
        XCTAssertEqual(resolve(bookingsLoaded: false), .checking)
    }

    func testExistingBookingActivatesWhenRemindersAreEnabled() {
        XCTAssertEqual(
            resolve(
                bookingsLoaded: true,
                nextActiveBookingID: bookingID,
                classRemindersEnabled: true
            ),
            .activated(bookingID: bookingID)
        )
    }

    func testUnavailableBookingsOfferRetryEvenWithAnExistingBooking() {
        XCTAssertEqual(
            resolve(
                bookingsLoaded: true,
                nextActiveBookingID: bookingID,
                classRemindersEnabled: true,
                bookingsUnavailable: true
            ),
            .retry
        )
    }

    func testUnavailableOnboardingOffersRetryBeforeBooking() {
        XCTAssertEqual(
            resolve(
                bookingsLoaded: true,
                nextActiveBookingID: bookingID,
                classRemindersEnabled: true,
                onboardingUnavailable: true
            ),
            .retry
        )
    }

    func testConfirmedBookingOffersReminderBeforeCompactReadyState() {
        XCTAssertEqual(
            resolve(
                bookingsLoaded: true,
                nextActiveBookingID: bookingID,
                nextConfirmedBookingID: confirmedBookingID
            ),
            .enableReminder(bookingID: confirmedBookingID)
        )
    }

    func testActivatedMemberCollapsesAfterReminderIsEnabled() {
        let state = resolve(
            bookingsLoaded: true,
            nextActiveBookingID: bookingID,
            nextConfirmedBookingID: bookingID,
            classRemindersEnabled: true
        )
        XCTAssertEqual(state, .activated(bookingID: bookingID))
        XCTAssertTrue(state.isCompact)
    }

    func testWaitlistedOrRequestedPlaceIsActivatedWithoutReminderPrompt() {
        XCTAssertEqual(
            resolve(
                bookingsLoaded: true,
                nextActiveBookingID: bookingID
            ),
            .activated(bookingID: bookingID)
        )
    }

    private func resolve(
        isSignedIn: Bool = true,
        onboardingLoaded: Bool = true,
        readinessComplete: Bool = true,
        bookingsLoaded: Bool = false,
        nextActiveBookingID: UUID? = nil,
        nextConfirmedBookingID: UUID? = nil,
        classRemindersEnabled: Bool = false,
        onboardingUnavailable: Bool = false,
        bookingsUnavailable: Bool = false
    ) -> MemberLaunchGuideState {
        MemberLaunchGuideResolver.resolve(
            isSignedIn: isSignedIn,
            onboardingLoaded: onboardingLoaded,
            readinessComplete: readinessComplete,
            bookingsLoaded: bookingsLoaded,
            nextActiveBookingID: nextActiveBookingID,
            nextConfirmedBookingID: nextConfirmedBookingID,
            classRemindersEnabled: classRemindersEnabled,
            onboardingUnavailable: onboardingUnavailable,
            bookingsUnavailable: bookingsUnavailable
        )
    }
}
