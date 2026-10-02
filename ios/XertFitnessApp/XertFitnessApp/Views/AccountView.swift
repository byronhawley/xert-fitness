import SwiftUI
import UIKit

struct AccountView: View {
    let route: XertMemberRoute
    let routeSequence: UInt
    let pendingNavigationTitle: String?
    let onCancelPendingNavigation: () -> Void
    let onOpenOwner: () -> Void
    @ObservedObject var staffRoster: StaffRosterStore

    @EnvironmentObject private var store: XertStore
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @AppStorage(AppPrivacyLock.preferenceKey) private var privacyLockEnabled = false
    @AppStorage(XertHapticPreference.preferenceKey) private var hapticFeedbackEnabled = true
    @State private var email = ""
    @State private var password = ""
    @State private var passwordConfirmation = ""
    @State private var isCreatingAccount = false
    @State private var acceptedAccountTerms = false
    @State private var fullName = ""
    @State private var phone = ""
    @State private var didSaveProfile = false
    @State private var newPassword = ""
    @State private var newPasswordConfirmation = ""
    @State private var didUpdatePassword = false
    @State private var passwordResetSent = false
    @State private var bookingToCancel: BookingItem?
    @State private var addingBookingToCalendarID: UUID?
    @State private var accountActionNotice: AccountActionNotice?
    @State private var showingDeleteConfirmation = false
    @State private var showingMemberReadiness = false
    @State private var authenticationSupport = DeviceAuthenticator.support()
    @State private var handledRouteSequence: UInt = 0
    @State private var handledCoachingRouteSequence: UInt = 0
    @State private var handledCoachingLinkSequence: UInt = 0
    @State private var showingCoaching = false
    /// Whether My Coaching is on screen, and how often it has appeared, so a
    /// requested push that SwiftUI dropped can be asked for again.
    @State private var coachingDestinationVisible = false
    @State private var coachingAppearances: UInt = 0
    @State private var isSubmittingAuthentication = false
    @FocusState private var focusedProfileField: ProfileField?
    @FocusState private var focusedAuthField: AuthField?
    @FocusState private var focusedSecurityField: SecurityField?

    private enum ProfileField {
        case fullName, phone
    }

    private enum AuthField {
        case fullName, phone, email, password, passwordConfirmation
    }

    private enum SecurityField {
        case newPassword, passwordConfirmation
    }

    private enum ScrollTarget: Hashable {
        case bookings, upcoming, history
    }

    var body: some View {
        let timeline = BookingTimeline(bookings: store.bookings)
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    Section {
                        XertPageHero(
                            imageName: "AccountHero",
                            eyebrow: store.isSignedIn ? "XERT Member" : "Train With XERT",
                            title: store.isSignedIn ? "Your XERT." : "Join XERT.",
                            subtitle: store.isSignedIn
                                ? "Your bookings, training goals and account controls in one place."
                                : "Create your member account to book coached sessions, purchase packs and train toward shared events.",
                            badge: store.isSignedIn
                                ? accountHeroBadge(timeline: timeline)
                                : "Train for life · Compete for fun"
                        )
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    if store.isSignedIn {
                        signedInSections(timeline: timeline)
                    } else {
                        signedOutSections
                    }
                    XertScrollEndSpacer()
                }
                .xertListBackground()
                .listStyle(.insetGrouped)
                .navigationTitle("Account")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(.hidden, for: .tabBar)
                .scrollDismissesKeyboard(.interactively)
                .toolbar {
                    if store.profile?.isAdmin == true {
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Button(action: onOpenOwner) {
                                Label("Owner", systemImage: "waveform.path.ecg.rectangle")
                            }
                            .accessibilityHint("Opens the protected Owner Command Centre")
                            .accessibilityIdentifier("account-owner-command-centre")
                        }
                    }
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button(keyboardToolbarTitle, action: performKeyboardToolbarAction)
                    }
                }
                .refreshable {
                    await store.refresh()
                    if store.isSignedIn { await staffRoster.refreshAccess() }
                }
                .navigationDestination(isPresented: $showingCoaching) {
                    MyCoachingView(staffRoster: staffRoster)
                        .onAppear {
                            coachingDestinationVisible = true
                            coachingAppearances &+= 1
                        }
                        .onDisappear { coachingDestinationVisible = false }
                }
                .onAppear(perform: syncProfileForm)
                .onAppear {
                    authenticationSupport = DeviceAuthenticator.support()
                    focusRoute(using: proxy)
                    followCoachingRoute()
                    presentRequestedCoaching()
                }
                .onChange(of: routeSequence) { _ in
                    focusRoute(using: proxy)
                    followCoachingRoute()
                }
                .onChange(of: staffRoster.linkSequence) { _ in
                    presentRequestedCoaching()
                }
                .onChange(of: store.isSignedIn) { isSignedIn in
                    if isSignedIn {
                        focusedAuthField = nil
                        password = ""
                        passwordConfirmation = ""
                    } else {
                        showingCoaching = false
                    }
                    focusRoute(using: proxy)
                    followCoachingRoute()
                }
                .onChange(of: store.isLoading) { _ in
                    focusRoute(using: proxy)
                }
                .onChange(of: store.bookings) { _ in
                    focusRoute(using: proxy)
                }
                .onChange(of: store.profile) { _ in
                    syncProfileForm()
                }
                .confirmationDialog(
                    "Cancel booking?",
                    isPresented: Binding(
                        get: { bookingToCancel != nil },
                        set: { if !$0 { bookingToCancel = nil } }
                    ),
                    presenting: bookingToCancel
                ) { booking in
                    Button("Keep booking", role: .cancel) {
                        bookingToCancel = nil
                    }
                    Button("Cancel booking", role: .destructive) {
                        bookingToCancel = nil
                        Task {
                            if let receipt = await store.cancel(booking) {
                                accountActionNotice = AccountActionNotice(
                                    title: "Booking Cancelled",
                                    message: receipt.memberMessage
                                )
                            }
                        }
                    }
                } message: { booking in
                    Text(booking.cancellationMessage)
                }
                .confirmationDialog(
                    "Permanently delete your XERT account?",
                    isPresented: $showingDeleteConfirmation,
                    titleVisibility: .visible
                ) {
                    Button("Keep Account", role: .cancel) {}
                    Button("Delete Account", role: .destructive) {
                        Task { _ = await store.deleteAccount() }
                    }
                } message: {
                    Text("Your member profile, credits, bookings, PT requests and training goals will be removed. Purchase records are anonymized.")
                }
                .alert(item: $accountActionNotice) { notice in
                    Alert(
                        title: Text(notice.title),
                        message: Text(notice.message),
                        dismissButton: .default(Text("OK"))
                    )
                }
            }
        }
        .sheet(isPresented: $showingMemberReadiness) {
            MemberOnboardingView()
                .environmentObject(store)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    private func focusRoute(using proxy: ScrollViewProxy) {
        guard
            routeSequence > 0,
            routeSequence != handledRouteSequence,
            case .upcomingBookings(let bookingID) = route,
            store.isSignedIn,
            !store.isLoading
        else {
            return
        }
        Task { @MainActor in
            await Task.yield()
            let target: AnyHashable
            if let bookingID, store.bookings.contains(where: { $0.id == bookingID }) {
                target = bookingID
            } else {
                target = ScrollTarget.bookings
            }
            handledRouteSequence = routeSequence
            withAnimation {
                proxy.scrollTo(target, anchor: .center)
            }
        }
    }

    /// A `.coaching` route (deep link, push, handoff or restoration) asks the
    /// store to open that section; the store's link sequence presents it.
    private func followCoachingRoute() {
        guard
            store.isSignedIn,
            routeSequence > 0,
            routeSequence != handledCoachingRouteSequence,
            case .coaching(let link) = route
        else { return }
        handledCoachingRouteSequence = routeSequence
        staffRoster.open(link)
    }

    private func presentRequestedCoaching() {
        guard
            store.isSignedIn,
            staffRoster.linkSequence > 0,
            staffRoster.linkSequence != handledCoachingLinkSequence
        else { return }
        handledCoachingLinkSequence = staffRoster.linkSequence
        presentCoaching(attempt: 0)
    }

    /// SwiftUI drops a `navigationDestination(isPresented:)` push requested in
    /// the same update that builds this stack or swaps its content: a cold
    /// launch from a push (Account appears for the first time) or the sign-in
    /// that resumes a My Coaching link (signed-out sections become signed-in
    /// ones). The binding then reads `true` with Account still on screen. Ask
    /// on the next turn of the main actor, and ask again if My Coaching did
    /// not appear.
    private func presentCoaching(attempt: Int) {
        Task { @MainActor in
            await Task.yield()
            guard store.isSignedIn else { return }
            let appearances = coachingAppearances
            showingCoaching = true
            guard attempt < 3, !coachingDestinationVisible else { return }
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard
                store.isSignedIn,
                showingCoaching,
                !coachingDestinationVisible,
                coachingAppearances == appearances
            else { return }
            showingCoaching = false
            presentCoaching(attempt: attempt + 1)
        }
    }

    // MARK: - Signed-in profile

    @ViewBuilder
    private func signedInSections(timeline: BookingTimeline) -> some View {
        if store.isUsingStaleMemberData {
            Section {
                StaleMemberDataNotice()
            }
            .listRowBackground(Color.xertInk)
        }
        if !store.unavailableDataSources.isDisjoint(with: [.credits, .bookings, .orders, .profile, .onboarding, .eventGoals, .privateSessions]) {
            Section {
                DataAvailabilityNotice(sources: [.credits, .bookings, .orders, .profile, .onboarding, .eventGoals, .privateSessions])
            }
            .listRowBackground(Color.xertInk)
        }

        if store.profile?.isAdmin == true {
            ownerCommandCentreSection
        }

        if staffRoster.showsEntry {
            staffCoachingSection
        }

        memberReadinessSection
        membershipSection
        trainingProgressSection
        activeBookingSections(timeline: timeline)
        privateSessionHistorySection
        purchaseHistorySection
        reminderSettingsSection
        accountDetailsSection
        accountSecuritySection
        bookingHistorySection(timeline: timeline)
        legalSection
        signOutSection
        accountControlSection
    }

    private var ownerCommandCentreSection: some View {
        Section {
            Button {
                XertHaptics.play(.lightImpact)
                onOpenOwner()
            } label: {
                HStack(spacing: 14) {
                    Image(systemName: "waveform.path.ecg.rectangle")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                        .frame(width: 36, height: 36)
                        .background(Color.xertSteel.opacity(0.12))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Owner Command Centre")
                            .font(.headline)
                            .foregroundStyle(Color.xertOffWhite)
                        Text("Run members, classes, pricing and publishing")
                            .font(.footnote)
                            .foregroundStyle(Color.xertPale)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.xertSteel)
                }
                .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("account-owner-command-centre-card")
        } header: {
            Text("Owner Tools").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    /// Shown only while `staff_roster_me` reports an active coach with the
    /// roster switched on. Members never see it.
    private var staffCoachingSection: some View {
        Section {
            Button {
                XertHaptics.play(.lightImpact)
                staffRoster.open(XertCoachingLink())
            } label: {
                HStack(spacing: 14) {
                    Image(systemName: "person.badge.clock")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                        .frame(width: 36, height: 36)
                        .background(Color.xertSteel.opacity(0.12))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("My Coaching")
                            .font(.headline)
                            .foregroundStyle(Color.xertOffWhite)
                        Text(staffCoachingDetail)
                            .font(.footnote)
                            .foregroundStyle(Color.xertPale)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.xertSteel)
                }
                .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens your classes, availability and cover requests")
            .accessibilityIdentifier("account-my-coaching")
        } header: {
            Text("Coach").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private var staffCoachingDetail: String {
        guard let me = staffRoster.me else { return "Your classes, availability and requests" }
        var parts: [String] = []
        if me.unread_notifications > 0 {
            parts.append("\(me.unread_notifications) unread \(me.unread_notifications == 1 ? "notice" : "notices")")
        }
        if !me.pending_acknowledgements.isEmpty {
            parts.append("roster changed")
        }
        let due = me.periods.filter { StaffAvailabilityEditor.phase($0) == .open && $0.submission == nil }.count
        if due > 0 {
            parts.append("availability due")
        }
        return parts.isEmpty ? "Your classes, availability and requests" : parts.joined(separator: " · ")
    }

    private var memberReadinessSection: some View {
        Section {
            MemberReadinessStatusCard {
                showingMemberReadiness = true
            }
        } header: {
            Text("Member Setup").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private var trainingProgressSection: some View {
        let progress = MemberTrainingProgress(bookings: store.bookings)
        return Section {
            if store.bookings.isEmpty && store.isLoading && store.memberDataUpdatedAt == nil {
                accountLoadingRow("Loading your training progress…")
            } else if store.bookings.isEmpty && store.unavailableDataSources.contains(.bookings) {
                accountUnavailableRow("Training progress")
            } else {
                trainingProgressCard(progress)
            }
        } header: {
            Text("Training Momentum").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private func trainingProgressCard(_ progress: MemberTrainingProgress) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if store.isUsingStaleMemberData || store.unavailableDataSources.contains(.bookings) {
                Label("Showing last synced attendance", systemImage: "clock.arrow.circlepath")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.orange)
            }

            if progress.totalAttended == 0 {
                Label("Your progress starts here", systemImage: "checkmark.seal")
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
                Text("Completed classes appear after Byron or the XERT team records attendance. Confirmed, cancelled and missed classes never inflate your totals.")
                    .font(.footnote)
                    .foregroundStyle(Color.xertPale)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        trainingProgressMetric("\(progress.attendedLast30Days)", label: "30 days")
                        trainingProgressMetric("\(progress.activeWeeksLastFour)/4", label: "Active weeks")
                        trainingProgressMetric("\(progress.totalAttended)", label: "All time")
                    }
                    VStack(spacing: 8) {
                        trainingProgressMetric("\(progress.attendedLast30Days)", label: "Completed · 30 days")
                        trainingProgressMetric("\(progress.activeWeeksLastFour)/4", label: "Active weeks")
                        trainingProgressMetric("\(progress.totalAttended)", label: "Completed · all time")
                    }
                }

                if let lastAttendedAt = progress.lastAttendedAt {
                    Label(
                        "Last completed \(lastAttendedAt.formatted(date: .abbreviated, time: .omitted))",
                        systemImage: "checkmark.circle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(Color.xertPale)
                }
            }

            Button {
                guard let url = URL(string: "xertfitness://booking") else { return }
                openURL(url)
            } label: {
                Label("Book your next class", systemImage: "calendar.badge.plus")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.xertPrimary)

            Text("Attendance only · active weeks use Brisbane Monday–Sunday weeks")
                .font(.caption2)
                .foregroundStyle(Color.xertMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(XertSpace.lg)
        .xertCardStyle()
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
        .listRowSeparator(.hidden)
    }

    private func trainingProgressMetric(_ value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value)
                .xertDisplay(28)
                .foregroundStyle(Color.xertOffWhite)
            Text(label)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .tracking(0.7)
                .foregroundStyle(Color.xertMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(10)
        .background(Color.xertNavy.opacity(0.38))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.xertSteel.opacity(0.18), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    // Nothing sells session packs any more, so this is no longer a shop. The
    // wallet is kept for the one person it still matters to: somebody who paid
    // for credits before packs were retired and can still see what they hold.
    private var hasLegacyCredits: Bool { store.creditTotal > 0 }

    private var membershipSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 16) {
                signedInSummary

                if hasLegacyCredits {
                    creditSummary

                    Divider()
                        .overlay(Color.xertMuted.opacity(0.35))

                    creditBatchWallet
                }
            }
            .padding(XertSpace.lg)
            .xertCardStyle()
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)
        } header: {
            Text(hasLegacyCredits ? "Membership & remaining credits" : "Membership").xertEyebrow()
        }
    }

    private var creditSummary: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    creditBalance
                    nextCreditExpiry
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 16) {
                        creditBalance
                        Spacer(minLength: 8)
                        nextCreditExpiry
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        creditBalance
                        nextCreditExpiry
                    }
                }
            }
        }
    }

    private var signedInSummary: some View {
        Label(store.authSession?.user?.email ?? "Member wallet", systemImage: "person.crop.circle")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Color.xertPale)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Credit wallet for \(store.authSession?.user?.email ?? "this member")")
    }

    private var creditBalance: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Available balance")
                .xertEyebrow()
            Text(creditsUnavailableOrLoading ? "—" : "\(store.creditTotal)")
                .xertDisplay(34)
            Text(store.creditTotal == 1 ? "session credit" : "session credits")
                .font(.caption)
                .foregroundStyle(Color.xertMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var nextCreditExpiry: some View {
        if let batch = nextExpiringCreditBatch, let expiry = batch.expires_at {
            VStack(alignment: .leading, spacing: 6) {
                Text("Next expiry")
                    .xertEyebrow()
                Text(expiry.formatted(date: .abbreviated, time: .omitted))
                    .font(.headline)
                    .foregroundStyle(Color.xertPale)
                Text("\(batch.remaining) credit\(batch.remaining == 1 ? "" : "s") in this batch")
                    .font(.caption)
                    .foregroundStyle(Color(red: 224 / 255, green: 179 / 255, blue: 106 / 255))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private var creditBatchWallet: some View {
        if store.isLoading && !store.creditBalanceLoaded {
            accountLoadingRow("Loading your credit wallet…")
        } else if store.unavailableDataSources.contains(.credits) && !store.creditBalanceLoaded {
            VStack(alignment: .leading, spacing: 5) {
                Text("Credit wallet unavailable")
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
                Text("Pull down to retry. No balance is being shown until your credits refresh.")
                    .font(.footnote)
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            if store.unavailableDataSources.contains(.credits) {
                Label("Showing your last saved wallet. Pull down to retry.", systemImage: "clock.arrow.circlepath")
                    .font(.footnote)
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if activeCreditBatches.isEmpty {
                Text("No active session credits. Choose a pack when you're ready to book.")
                    .font(.footnote)
                    .foregroundStyle(Color.xertMuted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Active credit batches")
                        .xertEyebrow()
                    ForEach(activeCreditBatches) { batch in
                        creditBatchRow(batch)
                    }
                }
            }
        }
    }

    private func creditBatchRow(_ batch: CreditBatch) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                creditBatchIdentity(batch)
                Spacer(minLength: 8)
                creditBatchExpiry(batch)
            }
            VStack(alignment: .leading, spacing: 5) {
                creditBatchIdentity(batch)
                creditBatchExpiry(batch)
            }
        }
        .padding(.top, 10)
        .overlay(alignment: .top) {
            Divider().overlay(Color.xertMuted.opacity(0.2))
        }
        .accessibilityElement(children: .combine)
    }

    private func creditBatchIdentity(_ batch: CreditBatch) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(creditBatchName(batch))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.xertOffWhite)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(batch.remaining) of \(batch.total) remaining")
                .font(.footnote)
                .foregroundStyle(Color.xertPale)
        }
    }

    private func creditBatchExpiry(_ batch: CreditBatch) -> some View {
        Text(batch.expires_at.map { "Expires \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "No expiry")
            .font(.caption)
            .foregroundStyle(Color.xertMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var activeCreditBatches: [CreditBatch] {
        let now = Date()
        return store.credits
            .filter { batch in
                batch.remaining > 0 && (batch.expires_at.map { $0 > now } ?? true)
            }
            .sorted { lhs, rhs in
                (lhs.expires_at ?? .distantFuture) < (rhs.expires_at ?? .distantFuture)
            }
    }

    private var nextExpiringCreditBatch: CreditBatch? {
        activeCreditBatches.first { $0.expires_at != nil }
    }

    private func creditBatchName(_ batch: CreditBatch) -> String {
        guard let orderID = batch.order_id else { return "Session credits" }
        return store.orders.first(where: { $0.id == orderID })?.products?.name ?? "Purchased session pack"
    }

    private var reminderSettingsSection: some View {
        Section {
            Toggle(
                "Member notice notifications",
                isOn: Binding(
                    get: { store.memberPushEnabled },
                    set: { enabled in Task { await store.setMemberPushEnabled(enabled) } }
                )
            )
            .tint(.xertSteel)
            .disabled(store.isUpdatingMemberPush)

            memberPushDeliveryStatus

            Toggle(
                "Class reminders",
                isOn: Binding(
                    get: { store.classRemindersEnabled },
                    set: { enabled in
                        Task { await store.setClassRemindersEnabled(enabled) }
                    }
                )
            )
            .tint(.xertSteel)
            .disabled(store.isUpdatingReminderPreference)

            if store.classRemindersEnabled {
                Picker(
                    "Remind me",
                    selection: Binding(
                        get: { store.classReminderLeadTime },
                        set: { leadTime in
                            Task { await store.setClassReminderLeadTime(leadTime) }
                        }
                    )
                ) {
                    ForEach(ClassReminderLeadTime.allCases) { leadTime in
                        Text(leadTime.label).tag(leadTime)
                    }
                }
                .pickerStyle(.menu)
                .disabled(store.isUpdatingReminderPreference)
            }

            reminderDeliveryStatus

            Toggle("Haptic feedback", isOn: $hapticFeedbackEnabled)
                .tint(.xertSteel)
                .accessibilityHint("Adds subtle touch feedback to important XERT actions")
                .onChange(of: hapticFeedbackEnabled) { enabled in
                    XertHapticPreference.setEnabled(enabled)
                    if enabled { XertHaptics.play(.lightImpact) }
                }

            if store.isUpdatingMemberPush || store.isUpdatingReminderPreference {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.xertSteel)
                    Text("Saving preferences…")
                        .foregroundStyle(Color.xertMuted)
                }
                .accessibilityElement(children: .combine)
            }

            Text("Member notices arrive when staff publish an update. Class reminders stay on this device. Haptic feedback adds subtle confirmation without sound.")
                .font(.footnote)
                .foregroundStyle(Color.xertMuted)
        } header: {
            Text("App Preferences").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    @ViewBuilder
    private var memberPushDeliveryStatus: some View {
        switch store.memberPushDeliveryState {
        case .off:
            EmptyView()
        case .awaitingDeviceToken:
            Label(
                "Waiting for iOS to finish registering this device.",
                systemImage: "iphone.gen3.radiowaves.left.and.right"
            )
            .font(.footnote)
            .foregroundStyle(Color.xertPale)
        case .registering:
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                    .tint(.xertSteel)
                Text("Securing this device for private member notices…")
                    .font(.footnote)
                    .foregroundStyle(Color.xertPale)
            }
            .accessibilityElement(children: .combine)
        case .registered:
            Label(
                "This device is registered for private XERT member notices.",
                systemImage: "checkmark.shield.fill"
            )
            .font(.footnote)
            .foregroundStyle(Color.green)
        case .failed:
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    memberPushFailureLabel
                    Spacer(minLength: 8)
                    memberPushRetryButton
                }
                VStack(alignment: .leading, spacing: 10) {
                    memberPushFailureLabel
                    memberPushRetryButton
                }
            }
        }
    }

    private var memberPushFailureLabel: some View {
        Label(
            "This device is not currently registered for member notices.",
            systemImage: "exclamationmark.triangle.fill"
        )
        .font(.footnote)
        .foregroundStyle(Color.orange)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var memberPushRetryButton: some View {
        Button {
            Task { await store.retryMemberPushRegistration() }
        } label: {
            Label("Retry", systemImage: "arrow.clockwise")
                .frame(minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(Color.xertSteel)
        .disabled(store.isUpdatingMemberPush)
        .accessibilityHint("Requests iOS notification access and securely registers this device again")
        .accessibilityIdentifier("account.memberPush.retry")
    }

    @ViewBuilder
    private var reminderDeliveryStatus: some View {
        switch store.classReminderSyncState {
        case .off:
            EmptyView()
        case .scheduled(let count):
            Label(
                "\(count) class reminder\(count == 1 ? "" : "s") scheduled on this device",
                systemImage: "bell.badge.fill"
            )
            .font(.footnote)
            .foregroundStyle(Color.xertSteel)
        case .noEligibleBookings:
            Label(
                "Reminders are on. Your next confirmed class will be scheduled automatically.",
                systemImage: "bell"
            )
            .font(.footnote)
            .foregroundStyle(Color.xertPale)
        case .permissionDenied:
            VStack(alignment: .leading, spacing: 10) {
                Label("Class reminders are off in iOS Settings.", systemImage: "bell.slash.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.orange)
                Button("Open iOS Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                }
                .buttonStyle(.borderless)
                .frame(minHeight: 44, alignment: .leading)
            }
        case .failed(let scheduledCount):
            Label(
                scheduledCount == 0
                    ? "No class reminders could be scheduled. Pull down to retry."
                    : "\(scheduledCount) reminders scheduled; another reminder needs retrying.",
                systemImage: "exclamationmark.triangle.fill"
            )
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Color.orange)
        }
    }

    private var accountDetailsSection: some View {
        Section {
            TextField("Full name", text: $fullName)
                .textContentType(.name)
                .focused($focusedProfileField, equals: .fullName)
                .submitLabel(.next)
                .onSubmit { focusedProfileField = .phone }
                .foregroundStyle(Color.xertOffWhite)
                .tint(Color.xertSteel)
            TextField("Mobile number", text: $phone)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
                .focused($focusedProfileField, equals: .phone)
                .submitLabel(.done)
                .foregroundStyle(Color.xertOffWhite)
                .tint(Color.xertSteel)
            Button {
                Task {
                    let saved = await store.updateProfile(fullName: fullName, phone: phone)
                    didSaveProfile = saved
                    if saved { focusedProfileField = nil }
                }
            } label: {
                HStack {
                    Text(store.isSavingProfile ? "Saving..." : "Save Account Details")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                    Spacer()
                    if store.isSavingProfile {
                        ProgressView()
                            .tint(Color.xertPale)
                    }
                }
            }
            .disabled(store.isSavingProfile)
            .onChange(of: fullName) { _ in didSaveProfile = false }
            .onChange(of: phone) { _ in didSaveProfile = false }

            if didSaveProfile {
                Label("Account details saved", systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.xertSteel)
            }
        } header: {
            Text("Account Details").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private var accountSecuritySection: some View {
        Section {
            SecureField("New password", text: $newPassword)
                .textContentType(.newPassword)
                .focused($focusedSecurityField, equals: .newPassword)
                .submitLabel(.next)
                .onSubmit { focusedSecurityField = .passwordConfirmation }
                .foregroundStyle(Color.xertOffWhite)
                .tint(Color.xertSteel)
            SecureField("Confirm new password", text: $newPasswordConfirmation)
                .textContentType(.newPassword)
                .focused($focusedSecurityField, equals: .passwordConfirmation)
                .submitLabel(.done)
                .onSubmit { submitPasswordUpdate() }
                .foregroundStyle(Color.xertOffWhite)
                .tint(Color.xertSteel)

            Button(action: submitPasswordUpdate) {
                HStack {
                    Text(store.isUpdatingPassword ? "Updating..." : "Update Password")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                    Spacer()
                    if store.isUpdatingPassword {
                        ProgressView()
                            .tint(Color.xertPale)
                    }
                }
            }
            .disabled(store.isUpdatingPassword || newPassword.isEmpty || newPasswordConfirmation.isEmpty)
            .onChange(of: newPassword) { value in
                if !value.isEmpty { didUpdatePassword = false }
            }
            .onChange(of: newPasswordConfirmation) { value in
                if !value.isEmpty { didUpdatePassword = false }
            }

            if didUpdatePassword {
                Label("Password updated", systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.xertSteel)
            }

            Toggle(
                "Require \(authenticationSupport.methodName)",
                isOn: $privacyLockEnabled
            )
            .tint(.xertSteel)
            .disabled(!authenticationSupport.isAvailable)

            Text(
                authenticationSupport.unavailableMessage
                    ?? "Lock XERT whenever the app leaves the foreground. Your device passcode remains available as a fallback."
            )
            .font(.footnote)
            .foregroundStyle(authenticationSupport.isAvailable ? Color.xertMuted : Color.orange)
        } header: {
            Text("Account Security").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private func submitPasswordUpdate() {
        guard !store.isUpdatingPassword,
              !newPassword.isEmpty,
              !newPasswordConfirmation.isEmpty else { return }
        focusedSecurityField = nil
        Task {
            let updated = await store.updatePassword(
                password: newPassword,
                confirmation: newPasswordConfirmation
            )
            didUpdatePassword = updated
            if updated {
                newPassword = ""
                newPasswordConfirmation = ""
            }
        }
    }

    private var signOutSection: some View {
        Section {
            Button("Sign Out", role: .destructive) {
                store.signOut()
            }
            .buttonStyle(.xertGhost)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)
        }
    }

    private var accountControlSection: some View {
        Section {
            Button("Delete Account", role: .destructive) {
                showingDeleteConfirmation = true
            }
            .disabled(store.isDeletingAccount)
            Text("Permanently removes your profile, credits, bookings and training goals. This cannot be undone.")
                .font(.footnote)
                .foregroundStyle(Color.xertMuted)
        } header: {
            Text("Account Control").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private var purchaseHistorySection: some View {
        Section {
            if store.isLoading && store.orders.isEmpty {
                accountLoadingRow("Loading purchases…")
            } else if store.unavailableDataSources.contains(.orders) && store.orders.isEmpty {
                accountUnavailableRow("Purchase history")
            } else if store.orders.isEmpty {
                Text("No purchases yet.")
                    .foregroundStyle(Color.xertMuted)
            } else {
                ForEach(store.orders) { order in
                    VStack(alignment: .leading, spacing: 4) {
                        if dynamicTypeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 6) {
                                purchaseName(order)
                                purchaseAmount(order)
                                purchaseDate(order)
                                purchaseStatus(order)
                            }
                        } else {
                            HStack(alignment: .firstTextBaseline) {
                                purchaseName(order)
                                Spacer()
                                purchaseAmount(order)
                            }
                            HStack {
                                purchaseDate(order)
                                Spacer()
                                purchaseStatus(order)
                            }
                            .font(.subheadline)
                        }
                        if let refundedAmount = order.refundedAmount {
                            Text("Refunded \(refundedAmount)")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Color.orange)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        } header: {
            Text("Purchase History").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private var privateSessionHistorySection: some View {
        Section {
            if store.isLoading && store.privateSessionRequests.isEmpty {
                accountLoadingRow("Loading PT requests…")
            } else if store.unavailableDataSources.contains(.privateSessions) && store.privateSessionRequests.isEmpty {
                accountUnavailableRow("PT requests")
            } else if store.privateSessionRequests.isEmpty {
                Text("No PT requests yet.")
                    .foregroundStyle(Color.xertMuted)
            } else {
                ForEach(store.privateSessionRequests) { request in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(request.requested_session_type)
                            .font(.headline)
                            .foregroundStyle(Color.xertOffWhite)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(request.displayStatus.uppercased())
                            .font(.caption2.weight(.bold))
                            .tracking(1.2)
                            .foregroundStyle(.xertSteel)
                        Text([
                            request.created_at.formatted(date: .abbreviated, time: .omitted),
                            request.preferred_day,
                            request.preferred_time
                        ].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline)
                            .foregroundStyle(Color.xertPale)
                        if let goal = request.training_goal {
                            Text("Goal: \(goal)")
                                .font(.footnote)
                                .foregroundStyle(Color.xertMuted)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        } header: {
            Text("PT Requests").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private func purchaseName(_ order: OrderItem) -> some View {
        Text(order.products?.name ?? "Session pack")
            .font(.headline)
            .foregroundStyle(Color.xertOffWhite)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func purchaseAmount(_ order: OrderItem) -> some View {
        Text(order.displayAmount)
            .font(.headline.monospacedDigit())
            .foregroundStyle(.xertSteel)
    }

    private func purchaseDate(_ order: OrderItem) -> some View {
        Text(order.activityDate.formatted(date: .abbreviated, time: .omitted))
            .font(.subheadline)
            .foregroundStyle(Color.xertPale)
    }

    private func purchaseStatus(_ order: OrderItem) -> some View {
        Text(order.displayStatus.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(1.2)
            .foregroundStyle(order.status == "paid" ? Color.xertSteel : order.status == "refunded" ? Color.orange : Color.xertMuted)
    }

    @ViewBuilder
    private func activeBookingSections(timeline: BookingTimeline) -> some View {
        if store.bookings.isEmpty {
            Section {
                if store.isLoading {
                    accountLoadingRow("Loading bookings…")
                } else if store.unavailableDataSources.contains(.bookings) {
                    accountUnavailableRow("Bookings")
                } else {
                    Text("No bookings yet.")
                        .foregroundStyle(Color.xertMuted)
                }
            } header: {
                Text("Bookings").xertEyebrow()
            }
            .id(ScrollTarget.bookings)
            .listRowBackground(Color.xertInk)
        } else {
            if !timeline.pending.isEmpty {
                Section {
                    bookingRows(timeline.pending)
                } header: {
                    Text("Requests & Waitlist").xertEyebrow()
                }
                .id(ScrollTarget.bookings)
                .listRowBackground(Color.xertInk)
            }
            if !timeline.upcoming.isEmpty {
                Section {
                    bookingRows(timeline.upcoming)
                } header: {
                    Text("Upcoming Classes").xertEyebrow()
                }
                .id(timeline.pending.isEmpty ? ScrollTarget.bookings : ScrollTarget.upcoming)
                .listRowBackground(Color.xertInk)
            }
        }
    }

    @ViewBuilder
    private func bookingHistorySection(timeline: BookingTimeline) -> some View {
        if !timeline.history.isEmpty {
            Section {
                bookingRows(timeline.history)
            } header: {
                Text("Booking History").xertEyebrow()
            }
            .id(
                timeline.pending.isEmpty && timeline.upcoming.isEmpty
                    ? ScrollTarget.bookings
                    : ScrollTarget.history
            )
            .listRowBackground(Color.xertInk)
        }
    }

    private func accountHeroBadge(timeline: BookingTimeline) -> String {
        if store.isLoading && store.credits.isEmpty && store.bookings.isEmpty {
            return "Refreshing account…"
        }
        if !store.unavailableDataSources.isDisjoint(with: [.credits, .bookings]) {
            return "Account needs refresh"
        }
        return "\(store.creditTotal) credit\(store.creditTotal == 1 ? "" : "s") · \(timeline.upcoming.count) upcoming"
    }

    private var creditsUnavailableOrLoading: Bool {
        !store.creditBalanceLoaded
    }

    private func accountLoadingRow(_ title: String) -> some View {
        HStack(spacing: 10) {
            ProgressView()
                .tint(Color.xertSteel)
            Text(title)
                .foregroundStyle(Color.xertMuted)
        }
        .accessibilityElement(children: .combine)
    }

    private func accountUnavailableRow(_ title: String) -> some View {
        Label("\(title) unavailable. Retry above.", systemImage: "wifi.exclamationmark")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.orange)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Signed-out member access

    @ViewBuilder
    private var signedOutSections: some View {
        // Each interactive element gets its OWN row: custom ButtonStyles do not
        // isolate their tap target inside a list row, so sharing a row would let
        // taps on the logo/headline/padding trigger the primary auth action.
        Section {
            if let pendingNavigationTitle {
                pendingNavigationPrompt(pendingNavigationTitle)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
            }

            memberAccessHero
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                .listRowSeparator(.hidden)

            if isCreatingAccount {
                termsAgreement
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
            }

            primaryAuthButton
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)

            if !isCreatingAccount {
                forgotPasswordControls
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
            }
        }

        Section {
            Button(isCreatingAccount ? "Already have an account?" : "Create a member account") {
                isCreatingAccount.toggle()
                password = ""
                passwordConfirmation = ""
                acceptedAccountTerms = false
                Task { @MainActor in
                    await Task.yield()
                    focusedAuthField = isCreatingAccount ? .fullName : .email
                }
            }
            .buttonStyle(.xertGhost)
            .disabled(isSubmittingAuthentication)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)
        }

        legalSection
    }

    private func pendingNavigationPrompt(_ title: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "lock.open.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.orange)
                .frame(width: 36, height: 36)
                .background(Color.orange.opacity(0.1))
                .clipShape(Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text("Sign in to continue")
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.xertPale)
            }
            Spacer(minLength: 8)
            Button(action: onCancelPendingNavigation) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Color.xertPale)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel opening \(title)")
        }
        .padding(14)
        .background(Color.xertInk)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.orange).frame(width: 3)
        }
    }

    private var memberAccessHero: some View {
        VStack(spacing: 22) {
            XertLogoHeader(height: 34)
                .frame(maxWidth: .infinity)
                .padding(.top, 10)

            VStack(spacing: 8) {
                Text(isCreatingAccount ? "Join XERT" : "Member Access")
                    .xertDisplay(36)
                    .multilineTextAlignment(.center)
                Text(isCreatingAccount
                    ? "Create your member account to book classes and track goals."
                    : "Sign in to manage your bookings, credits and training goals.")
                    .font(.footnote)
                    .foregroundStyle(Color.xertMuted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)

            credentialFields

            if let credentialValidationMessage {
                Label(credentialValidationMessage, systemImage: "exclamationmark.circle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("member.authentication.validation")
            }
        }
    }

    private var credentialFields: some View {
        VStack(spacing: 12) {
            if isCreatingAccount {
                TextField("Full name", text: $fullName)
                    .textContentType(.name)
                    .focused($focusedAuthField, equals: .fullName)
                    .submitLabel(.next)
                    .onSubmit { focusedAuthField = .phone }
                    .xertAccountField()
                TextField("Mobile number (optional)", text: $phone)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .focused($focusedAuthField, equals: .phone)
                    .submitLabel(.next)
                    .xertAccountField()
            }
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .focused($focusedAuthField, equals: .email)
                .submitLabel(.next)
                .onSubmit { focusedAuthField = .password }
                .onChange(of: email) { _ in passwordResetSent = false }
                .xertAccountField()
            SecureField("Password", text: $password)
                .textContentType(isCreatingAccount ? .newPassword : .password)
                .focused($focusedAuthField, equals: .password)
                .submitLabel(isCreatingAccount ? .next : .go)
                .onSubmit {
                    if isCreatingAccount {
                        focusedAuthField = .passwordConfirmation
                    } else {
                        submitAuthentication()
                    }
                }
                .xertAccountField()
            if isCreatingAccount {
                SecureField("Confirm password", text: $passwordConfirmation)
                    .textContentType(.newPassword)
                    .focused($focusedAuthField, equals: .passwordConfirmation)
                    .submitLabel(.go)
                    .onSubmit { submitAuthentication() }
                    .xertAccountField()
            }
        }
    }

    private var termsAgreement: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("I agree to the Terms and acknowledge the Privacy Policy", isOn: $acceptedAccountTerms)
                .font(.footnote)
                .foregroundStyle(Color.xertPale)
                .tint(Color.xertSteel)
            HStack(spacing: 16) {
                Link("Terms of Use", destination: AppConfig.webURL(path: "terms"))
                Link("Privacy Policy", destination: AppConfig.webURL(path: "privacy"))
            }
            .font(.footnote)
            .tint(Color.xertSteel)
            // Borderless keeps each link individually tappable inside the row
            // instead of letting a row tap activate them.
            .buttonStyle(.borderless)
        }
        .padding(XertSpace.lg)
        .xertCardStyle()
    }

    private var primaryAuthButton: some View {
        Button(action: submitAuthentication) {
            HStack(spacing: 10) {
                Text(authenticationActionTitle)
                Spacer(minLength: 8)
                if isSubmittingAuthentication {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Color.xertNavy)
                        .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.xertPrimary)
        .disabled(authActionDisabled)
        .opacity(authActionDisabled ? 0.55 : 1)
        .accessibilityValue(isSubmittingAuthentication ? "In progress" : "")
        .accessibilityHint(authenticationActionHint)
    }

    private var forgotPasswordControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task {
                    passwordResetSent = await store.requestPasswordReset(email: email)
                }
            } label: {
                HStack {
                    Text(store.isRequestingPasswordReset ? "Sending reset link..." : "Forgot password?")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.xertSteel)
                    Spacer()
                    if store.isRequestingPasswordReset {
                        ProgressView()
                            .tint(Color.xertPale)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isRequestingPasswordReset)

            if passwordResetSent {
                Text("If an XERT account uses this email, a reset link is on its way.")
                    .font(.footnote)
                    .foregroundStyle(Color.xertMuted)
            }
        }
    }

    // MARK: - Shared helpers

    private var keyboardToolbarTitle: String {
        focusedAuthField == .phone ? "Next" : "Done"
    }

    private func performKeyboardToolbarAction() {
        if focusedAuthField == .phone {
            focusedAuthField = .email
            return
        }
        focusedProfileField = nil
        focusedAuthField = nil
        focusedSecurityField = nil
    }

    private var authenticationActionTitle: String {
        if isSubmittingAuthentication {
            return isCreatingAccount ? "Creating Account…" : "Signing In…"
        }
        return isCreatingAccount ? "Create Account" : "Sign In"
    }

    private var credentialValidationMessage: String? {
        if isCreatingAccount {
            if !password.isEmpty, password.count < 8 {
                return "Use at least 8 characters for your password."
            }
            if !passwordConfirmation.isEmpty, passwordConfirmation != password {
                return "Password confirmation does not match."
            }
            return nil
        }
        if !password.isEmpty, password.count < 6 {
            return "Enter at least 6 password characters to sign in."
        }
        return nil
    }

    private var authenticationActionHint: String {
        if isSubmittingAuthentication { return authenticationActionTitle }
        if let credentialValidationMessage { return credentialValidationMessage }
        if email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter your member email."
        }
        if password.isEmpty { return "Enter your password." }
        if isCreatingAccount,
           fullName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter your full name."
        }
        if isCreatingAccount, !acceptedAccountTerms {
            return "Agree to the Terms and acknowledge the Privacy Policy."
        }
        return isCreatingAccount ? "Creates your XERT member account." : "Signs in to your XERT member account."
    }

    private func submitAuthentication() {
        guard !authActionDisabled else { return }
        let creatingAccount = isCreatingAccount
        focusedAuthField = nil
        isSubmittingAuthentication = true
        Task {
            defer { isSubmittingAuthentication = false }
            if creatingAccount {
                await store.signUp(
                    fullName: fullName,
                    email: email,
                    phone: phone,
                    password: password,
                    confirmation: passwordConfirmation,
                    acceptedTerms: acceptedAccountTerms
                )
            } else {
                await store.signIn(email: email, password: password)
            }
        }
    }

    private func syncProfileForm() {
        fullName = store.profile?.full_name ?? ""
        phone = store.profile?.phone ?? ""
    }

    private var authActionDisabled: Bool {
        if store.isLoading || isSubmittingAuthentication
            || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        if !isCreatingAccount { return password.count < 6 }
        return fullName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || password.count < 8
            || passwordConfirmation != password
            || !acceptedAccountTerms
    }

    @ViewBuilder
    private func bookingRows(_ bookings: [BookingItem]) -> some View {
        ForEach(bookings) { booking in
            VStack(alignment: .leading, spacing: 4) {
                Text(booking.title)
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
                Text(booking.start_time.formatted(date: .abbreviated, time: .shortened))
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale)
                Text(booking.stateLabel.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(1.2)
                    .foregroundStyle(.xertSteel)
                if booking.status == "confirmed" && booking.start_time > Date() {
                    Button {
                        Task { await addBookingToCalendar(booking) }
                    } label: {
                        HStack(spacing: 10) {
                            Label(
                                addingBookingToCalendarID == booking.id ? "Adding to calendar…" : "Add to Calendar",
                                systemImage: "calendar.badge.plus"
                            )
                            Spacer(minLength: 8)
                            if addingBookingToCalendarID == booking.id {
                                ProgressView()
                                    .controlSize(.small)
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .disabled(addingBookingToCalendarID != nil)
                    .accessibilityValue(addingBookingToCalendarID == booking.id ? "In progress" : "")
                }
                if booking.isCancellable() {
                    if store.platformProvider.provider == .native,
                       store.platformProvider.capabilities.nativeBookingMutations {
                        let isCancelling = store.cancellingBookingID == booking.id
                        let hasBookingMutation = store.bookingSessionID != nil || store.cancellingBookingID != nil
                        let bookingStateUnavailable = store.isUsingStaleMemberData
                            || store.unavailableDataSources.contains(.bookings)
                        Button(role: .destructive) {
                            bookingToCancel = booking
                        } label: {
                            HStack(spacing: 10) {
                                Label(
                                    isCancelling
                                        ? (booking.status == "waitlisted" ? "Leaving waitlist…" : "Cancelling booking…")
                                        : (booking.status == "waitlisted" ? "Leave waitlist" : "Cancel booking"),
                                    systemImage: "xmark.circle"
                                )
                                Spacer(minLength: 8)
                                if isCancelling {
                                    ProgressView()
                                        .controlSize(.small)
                                        .accessibilityHidden(true)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .disabled(hasBookingMutation || bookingStateUnavailable)
                        .accessibilityValue(
                            isCancelling
                                ? "In progress"
                                : (bookingStateUnavailable
                                    ? "Refresh bookings before cancelling"
                                    : (hasBookingMutation ? "Another booking update is in progress" : ""))
                        )
                    } else if let portalURL = store.platformProvider.portalURL {
                        Link(destination: portalURL) {
                            Label("Manage in FitBox", systemImage: "arrow.up.forward.square")
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Color.xertSteel)
                    } else {
                        Label("Booking changes paused", systemImage: "lock.shield")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.orange)
                            .frame(minHeight: 44)
                    }
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .id(booking.id)
        }
    }

    @MainActor
    private func addBookingToCalendar(_ booking: BookingItem) async {
        addingBookingToCalendarID = booking.id
        defer { addingBookingToCalendarID = nil }
        do {
            let result = try await EventCalendarWriter.add(booking)
            accountActionNotice = result == .added
                ? AccountActionNotice(title: "Added to Calendar", message: "\(booking.title) is now in your calendar.")
                : AccountActionNotice(title: "Already in Calendar", message: "\(booking.title) is already saved in your calendar.")
        } catch {
            accountActionNotice = AccountActionNotice(
                title: "Could Not Add Class",
                message: error.localizedDescription
            )
        }
    }

    private var legalSection: some View {
        Section {
            Link("Privacy Policy", destination: AppConfig.webURL(path: "privacy"))
            Link("Terms of Use", destination: AppConfig.webURL(path: "terms"))
            Link("Contact XERT Support", destination: AppConfig.webURL(path: "contact"))
        } header: {
            Text("Legal & Support").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
        .tint(Color.xertSteel)
    }
}

private struct AccountActionNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

// MARK: - Brand input field

private extension View {
    /// Dark brand input: ink surface, hairline steel border, sharp 2pt corners.
    func xertAccountField() -> some View {
        textFieldStyle(.plain)
            .font(.subheadline)
            .foregroundStyle(Color.xertOffWhite)
            .tint(Color.xertSteel)
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.xertSteel.opacity(0.3), lineWidth: 1)
            )
    }
}

private extension BookingItem {
    var cancellationMessage: String {
        if status == "waitlisted" {
            return "This will remove you from the waitlist for \(title). No class credit is currently reserved."
        }
        if BookingCancellationPolicy.returnsCredit(status: status, startTime: start_time) {
            return "This will remove you from \(title) and return the reserved credit when its original credit pack is still valid. XERT will confirm the credit outcome after cancellation."
        }
        return "This will remove you from \(title). Confirmed bookings cancelled within 12 hours do not return a class credit."
    }
}
