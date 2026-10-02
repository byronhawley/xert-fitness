import Foundation
import UIKit
import UserNotifications

enum XertNotificationCategories {
    static let classReminder = "xert.class-reminder"
    static let memberNotice = "xert.member-notice"
    static let staffRoster = StaffRosterPush.category
    static let viewBookingAction = "xert.class-reminder.view-booking"
    static let browseClassesAction = "xert.class-reminder.browse-classes"
    static let viewNoticeAction = "xert.member-notice.view"

    static func register(with center: UNUserNotificationCenter = .current()) {
        let viewBooking = UNNotificationAction(
            identifier: viewBookingAction,
            title: "View Booking",
            options: [.foreground]
        )
        let browseClasses = UNNotificationAction(
            identifier: browseClassesAction,
            title: "Browse Classes",
            options: [.foreground]
        )
        let viewNotice = UNNotificationAction(
            identifier: viewNoticeAction,
            title: "View Notice",
            options: [.foreground]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: classReminder,
                actions: [viewBooking, browseClasses],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: memberNotice,
                actions: [viewNotice],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: staffRoster,
                actions: [],
                intentIdentifiers: [],
                options: []
            ),
        ])
    }
}

enum ClassReminderNotification {
    static let identifierPrefix = "xert.booking."
    static let bookingIDKey = "booking_id"

    static func bookingID(identifier: String, userInfo: [AnyHashable: Any]) -> UUID? {
        guard
            identifier.hasPrefix(identifierPrefix),
            let rawBookingID = userInfo[bookingIDKey] as? String,
            let bookingID = UUID(uuidString: rawBookingID),
            UUID(uuidString: String(identifier.dropFirst(identifierPrefix.count))) == bookingID
        else {
            return nil
        }
        return bookingID
    }
}

enum ClassReminderNavigation {
    static let pendingBookingIDKey = "xert.navigation.pendingBookingID"
    static let pendingBrowseClassesKey = "xert.navigation.pendingBrowseClasses"

    static func markPending(bookingID: UUID, defaults: UserDefaults = .standard) {
        defaults.set(bookingID.uuidString, forKey: pendingBookingIDKey)
        defaults.removeObject(forKey: pendingBrowseClassesKey)
    }

    static func markPendingBrowseClasses(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: pendingBrowseClassesKey)
        defaults.removeObject(forKey: pendingBookingIDKey)
    }

    static func consumePendingBrowseClasses(defaults: UserDefaults = .standard) -> Bool {
        let isPending = defaults.bool(forKey: pendingBrowseClassesKey)
        defaults.removeObject(forKey: pendingBrowseClassesKey)
        if isPending { defaults.removeObject(forKey: pendingBookingIDKey) }
        return isPending
    }

    static func consumePendingBookingID(defaults: UserDefaults = .standard) -> UUID? {
        guard
            let rawBookingID = defaults.string(forKey: pendingBookingIDKey),
            let bookingID = UUID(uuidString: rawBookingID)
        else {
            defaults.removeObject(forKey: pendingBookingIDKey)
            return nil
        }
        defaults.removeObject(forKey: pendingBookingIDKey)
        return bookingID
    }

    static func clearPending(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: pendingBookingIDKey)
        defaults.removeObject(forKey: pendingBrowseClassesKey)
    }
}

enum AnnouncementPushNavigation {
    static let pendingAnnouncementIDKey = "xert.navigation.pendingAnnouncementID"

    static func markPending(announcementID: UUID, defaults: UserDefaults = .standard) {
        defaults.set(announcementID.uuidString, forKey: pendingAnnouncementIDKey)
    }

    static func consumePendingAnnouncementID(defaults: UserDefaults = .standard) -> UUID? {
        guard
            let rawAnnouncementID = defaults.string(forKey: pendingAnnouncementIDKey),
            let announcementID = UUID(uuidString: rawAnnouncementID)
        else {
            defaults.removeObject(forKey: pendingAnnouncementIDKey)
            return nil
        }
        defaults.removeObject(forKey: pendingAnnouncementIDKey)
        return announcementID
    }

    static func clearPending(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: pendingAnnouncementIDKey)
    }
}

extension Notification.Name {
    static let xertOpenBookings = Notification.Name("xert.navigation.openBookings")
}

final class XertAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        XertNotificationCategories.register()
        #if DEBUG
        // UI tests: replay a staff roster push tap through the real parser.
        XertUITestFixtures.simulateNotificationTapIfRequested()
        #endif
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        if let shortcutItem = options.shortcutItem {
            XertQuickActionNavigation.markPending(shortcutType: shortcutItem.type)
        }
        let configuration = UISceneConfiguration(
            name: "XERT Member Workspace",
            sessionRole: connectingSceneSession.role
        )
        configuration.delegateClass = XertSceneDelegate.self
        return configuration
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let value = deviceToken.map { String(format: "%02x", $0) }.joined()
        let token = DevicePushToken(value: value, environment: MemberPushRegistration.environment)
        PushDeviceTokenStore.save(token)
        NotificationCenter.default.post(name: .xertPushTokenUpdated, object: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError _: Error) {
        NotificationCenter.default.post(name: .xertPushRegistrationFailed, object: nil)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if notification.request.content.userInfo["announcement_id"] != nil {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .xertRefreshAnnouncements, object: nil)
            }
        }
        if StaffRosterPush.isStaffRosterPayload(notification.request.content.userInfo) {
            // Refresh what My Coaching shows; receiving a notice never marks it read.
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .xertRefreshStaffRoster, object: nil)
            }
        }
        // Keep foreground notices in Notification Centre as well as showing a
        // banner so a member can return after the transient banner disappears.
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.notification.request.content.userInfo["announcement_id"] != nil,
           let rawAnnouncementID = response.notification.request.content.userInfo["announcement_id"] as? String,
           let announcementID = UUID(uuidString: rawAnnouncementID) {
            AnnouncementPushNavigation.markPending(announcementID: announcementID)
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .xertOpenAnnouncements, object: announcementID)
            }
            completionHandler()
            return
        }
        if let target = StaffRosterPush.target(from: response.notification.request.content.userInfo) {
            StaffRosterPushNavigation.markPending(target)
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .xertOpenStaffRoster, object: nil)
            }
            completionHandler()
            return
        }
        let request = response.notification.request
        if let bookingID = ClassReminderNotification.bookingID(
            identifier: request.identifier,
            userInfo: request.content.userInfo
        ) {
            if response.actionIdentifier == XertNotificationCategories.browseClassesAction {
                ClassReminderNavigation.markPendingBrowseClasses()
            } else {
                ClassReminderNavigation.markPending(bookingID: bookingID)
            }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .xertOpenBookings, object: bookingID)
            }
        }
        completionHandler()
    }
}

final class XertSceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let handled = XertQuickActionNavigation.markPending(shortcutType: shortcutItem.type)
        if handled {
            NotificationCenter.default.post(name: .xertOpenQuickAction, object: nil)
        }
        completionHandler(handled)
    }
}
