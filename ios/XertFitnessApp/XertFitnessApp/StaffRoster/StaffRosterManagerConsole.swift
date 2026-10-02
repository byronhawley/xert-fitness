import SwiftUI

/// Opens a manager roster notice in the existing web manager console, in the
/// system browser, on the canonical web host only. `/admin/roster` is not an
/// app-claimed universal-link path, so the link never loops back into the
/// app. The console signs the manager in and enforces permission
/// server-side; the app never builds a native manager screen for it.
@MainActor
enum StaffRosterManagerConsole {
    static func open(_ link: XertManagerRosterLink, using openURL: OpenURLAction) {
        guard let url = link.webURL else { return }
        #if DEBUG
        // UI tests assert the destination instead of leaving for Safari.
        if XertUITestFixtures.isActive {
            XertUITestHooks.shared.recordOpenedExternalURL(url)
            return
        }
        #endif
        openURL(url)
    }
}
