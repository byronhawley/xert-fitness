import SwiftUI
import UIKit

/// Native My Coaching for staff on the coach roster: upcoming classes, the
/// published roster, monthly availability and requests. Every screen reads
/// and writes through the `staff_roster_*` entry points; the database decides
/// access and every roster rule. The manager roster builder stays on the web.
struct MyCoachingView: View {
    @ObservedObject var staffRoster: StaffRosterStore
    @State private var tab: XertCoachingTab = .upcoming
    @State private var requestedMonth: String?
    @State private var handledLinkSequence: UInt = 0

    var body: some View {
        List {
            content
            XertScrollEndSpacer()
        }
        .xertListBackground()
        .listStyle(.insetGrouped)
        .navigationTitle("My Coaching")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .refreshable {
            await staffRoster.refreshAccess()
            await loadCurrentTab()
        }
        .onAppear(perform: applyRequestedLink)
        .onChange(of: staffRoster.linkSequence) { _ in
            applyRequestedLink()
            Task { await staffRoster.markOpenedNotificationsViewed() }
        }
        .onChange(of: staffRoster.banner) { banner in
            guard let banner else { return }
            UIAccessibility.post(notification: .announcement, argument: banner.message)
        }
        .task {
            await staffRoster.refreshAccess()
            await staffRoster.markOpenedNotificationsViewed()
        }
        .task(id: loadKey) {
            await loadCurrentTab()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch staffRoster.access {
        case .unknown, .checking:
            Section {
                HStack(spacing: XertSpace.md) {
                    ProgressView()
                    Text("Checking your coach access…")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale)
                }
                .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
            }
            .listRowBackground(Color.xertInk)
        case .unavailable(let error):
            CoachingNotAvailableSection(error: error)
        case .failed(let error):
            Section {
                XertInlineError(message: error.message) {
                    Task { await staffRoster.refreshAccess() }
                }
            }
            .listRowBackground(Color.xertInk)
        case .coach(let me):
            coachSections(me)
        }
    }

    @ViewBuilder
    private func coachSections(_ me: StaffRosterMe) -> some View {
        Section {
            VStack(alignment: .leading, spacing: XertSpace.md) {
                Text("Coach").xertEyebrow()
                Text("Hi \(me.staff.display_name)")
                    .xertDisplay(30)
                    .fixedSize(horizontal: false, vertical: true)
                XertSegmented(
                    title: "Section",
                    selection: $tab,
                    choices: XertCoachingTab.allCases.map { XertChoice(value: $0, label: $0.title) }
                )
                .accessibilityIdentifier("coaching-section-picker")
            }
            .padding(.vertical, XertSpace.sm)
        }
        .listRowBackground(Color.clear)

        if let banner = staffRoster.banner {
            Section {
                HStack(alignment: .top, spacing: XertSpace.md) {
                    Image(systemName: banner.isError ? "exclamationmark.triangle" : "checkmark.circle")
                        .foregroundStyle(banner.isError ? XertTokens.stateDangerPale : XertTokens.stateSuccess)
                        .accessibilityHidden(true)
                    Text(banner.message)
                        .font(.subheadline)
                        .foregroundStyle(Color.xertOffWhite)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: XertSpace.sm)
                    Button("Dismiss") { staffRoster.banner = nil }
                        .buttonStyle(.borderless)
                        .font(.caption.weight(.semibold))
                }
            }
            .listRowBackground(Color.xertInk)
        }

        switch tab {
        case .upcoming:
            CoachUpcomingSections(staffRoster: staffRoster, me: me, onOpen: openLink)
        case .roster:
            CoachRosterSections(staffRoster: staffRoster, requestedMonth: $requestedMonth)
        case .availability:
            CoachAvailabilitySections(staffRoster: staffRoster, me: me, requestedMonth: $requestedMonth)
        case .requests:
            CoachRequestsSections(staffRoster: staffRoster)
        }
    }

    private var loadKey: String {
        "\(tab.rawValue)|\(staffRoster.me?.staff.id.uuidString ?? "none")"
    }

    private func loadCurrentTab() async {
        guard staffRoster.me != nil else { return }
        switch tab {
        case .upcoming:
            await staffRoster.loadRoster()
            await staffRoster.loadNotifications()
        case .roster:
            await staffRoster.loadRoster()
        case .availability:
            break
        case .requests:
            await staffRoster.loadRequests()
        }
    }

    private func applyRequestedLink() {
        guard staffRoster.linkSequence != handledLinkSequence else { return }
        handledLinkSequence = staffRoster.linkSequence
        openLink(staffRoster.requestedLink)
    }

    private func openLink(_ link: XertCoachingLink) {
        requestedMonth = link.month
        tab = link.tab
    }
}

// MARK: - Not available

/// Signed in, but the roster is off or this account is not an active coach.
/// Nothing from the roster is shown.
private struct CoachingNotAvailableSection: View {
    let error: StaffRosterError

    private var detail: String {
        switch error.code {
        case "ROSTER_DISABLED":
            return "The coach roster isn’t switched on yet. The manager will let you know when it’s ready."
        case "NOT_STAFF":
            return "This account isn’t on the coach roster. If you coach at XERT, ask the manager to link this sign-in to you. No membership is needed."
        case "STAFF_INACTIVE":
            return "Your coach access is paused. Talk to the manager if this is a mistake."
        case "SIGN_IN_REQUIRED":
            return "Please sign in again."
        default:
            return error.message
        }
    }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: XertSpace.sm) {
                Label("My Coaching isn’t available", systemImage: "lock")
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, XertSpace.sm)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("coaching-not-available")
        }
        .listRowBackground(Color.xertInk)
    }
}

// MARK: - Shared rows

private enum CoachingWords {
    static let cover: [String: (String, XertTone)] = [
        "open": ("Looking for cover", .warning),
        "offered": ("A coach volunteered — waiting for manager approval", .neutral),
        "approved": ("Manager approved a replacement", .success),
        "rejected": ("Declined — you’re still on", .danger),
        "withdrawn": ("Withdrawn", .neutral),
        "cancelled": ("Cancelled", .neutral),
        "superseded": ("Roster changed — no longer applies", .neutral),
    ]

    static let offer: [String: (String, XertTone)] = [
        "offered": ("You volunteered — not yours until the manager approves", .neutral),
        "approved": ("Manager approved — it’s yours", .success),
        "declined": ("Not needed", .neutral),
        "withdrawn": ("Withdrawn", .neutral),
    ]

    static let absence: [String: (String, XertTone)] = [
        "requested": ("Waiting for the manager", .warning),
        "reported": ("Reported — manager told", .neutral),
        "approved": ("Approved", .success),
        "rejected": ("Declined", .danger),
        "withdrawn": ("Withdrawn", .neutral),
    ]

    static let problems: [String: String] = [
        "ABSENT": "you have an absence then",
        "CLASS_OVERLAP": "you’re already coaching then",
        "DUTY_BUFFER_OVERLAP": "it overlaps another duty",
        "ROLE_NOT_AUTHORISED": "it needs a role you’re not set up for",
        "CAPABILITY_MISSING": "it needs a capability you don’t have",
        "CAPABILITY_EXPIRED": "a required capability has expired",
        "LIMIT_DAILY_DUTY": "it’s over your daily limit",
        "LIMIT_WEEKLY_CLASSES": "it’s over your weekly limit",
        "LIMIT_REST": "it leaves too little rest",
        "SAME_SESSION_DUPLICATE": "you’re already in this class",
        "STAFF_INACTIVE": "your account is inactive",
    ]

    static func label(_ map: [String: (String, XertTone)], _ status: String) -> (String, XertTone) {
        map[status] ?? (status.capitalized, .neutral)
    }
}

/// One rostered class: local time, class, role, revision and changes.
private struct CoachAssignmentRow: View {
    let assignment: StaffRosterAssignment
    var showsDate = false

    private var timeRange: String {
        let start = StaffRosterTime.timeLabel(assignment.start)
        guard let end = assignment.end else { return start }
        return "\(start) – \(StaffRosterTime.timeLabel(end))"
    }

    private var detail: String {
        var parts = [assignment.roleLabel]
        if let dutyStart = assignment.duty_start, dutyStart < assignment.start {
            parts.append("on duty from \(StaffRosterTime.timeLabel(dutyStart))")
        }
        if !assignment.colleagues.isEmpty {
            parts.append("with \(assignment.colleagues.map(\.display_name).joined(separator: ", "))")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: XertSpace.sm) {
            if showsDate {
                Text(StaffRosterTime.longDayLabel(StaffRosterTime.dateKey(for: assignment.start)))
                    .font(.caption.weight(.bold))
                    .textCase(.uppercase)
                    .foregroundStyle(Color.xertSteel)
            }
            Text(timeRange)
                .font(.title3.weight(.semibold))
                .strikethrough(assignment.isCancelled)
                .foregroundStyle(assignment.isCancelled ? Color.xertMuted : Color.xertOffWhite)
            Text(assignment.displayTitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.xertOffWhite)
            Text(detail)
                .font(.caption)
                .foregroundStyle(Color.xertPale)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: XertSpace.sm) { badges }
                VStack(alignment: .leading, spacing: XertSpace.xs) { badges }
            }
            if assignment.changed_since_publish && !assignment.isCancelled {
                Text(changeExplanation)
                    .font(.caption)
                    .foregroundStyle(XertTokens.stateWarning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, XertSpace.xs)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var badges: some View {
        if assignment.isCancelled {
            XertBadge(title: "Cancelled", tone: .danger)
        } else if assignment.changed_since_publish {
            XertBadge(title: "Changed since publication", tone: .warning)
        }
        if let cover = assignment.cover {
            XertBadge(
                title: cover.status == "offered" ? "Cover offered — awaiting manager" : "Cover requested",
                tone: .warning
            )
        }
        XertBadge(
            title: assignment.acknowledged
                ? "Published v\(assignment.revision_number)"
                : "Published v\(assignment.revision_number) · not yet seen",
            tone: .neutral
        )
    }

    private var changeExplanation: String {
        var text = "This class moved after the roster was published."
        if let publishedStart = assignment.published_start {
            let end = assignment.published_end.map { "–\(StaffRosterTime.timeLabel($0))" } ?? ""
            text += " It was \(StaffRosterTime.timeLabel(publishedStart))\(end) on \(StaffRosterTime.dayLabel(for: publishedStart))."
        }
        if let availability = assignment.availability,
           !["PREFERRED", "AVAILABLE", "IF_NEEDED"].contains(availability) {
            text += " Your availability doesn’t cover the new time yet."
        }
        return text
    }
}

private struct CoachingLoadingRow: View {
    let text: String

    var body: some View {
        HStack(spacing: XertSpace.md) {
            ProgressView()
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Color.xertPale)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }
}

// MARK: - Upcoming

private struct CoachUpcomingSections: View {
    @ObservedObject var staffRoster: StaffRosterStore
    let me: StaffRosterMe
    let onOpen: (XertCoachingLink) -> Void

    private var acknowledgements: [StaffRosterAcknowledgement] {
        staffRoster.roster?.pending_acknowledgements ?? me.pending_acknowledgements
    }

    private var upcoming: [StaffRosterAssignment] {
        let now = Date()
        return (staffRoster.roster?.assignments ?? [])
            .filter { ($0.end ?? $0.start) > now }
            .sorted { $0.start < $1.start }
    }

    private var dueAvailability: [StaffRosterMe.Period] {
        me.periods.filter { StaffAvailabilityEditor.phase($0) == .open && $0.submission == nil }
    }

    var body: some View {
        if !acknowledgements.isEmpty {
            Section {
                ForEach(acknowledgements, id: \.revision_id) { ack in
                    VStack(alignment: .leading, spacing: XertSpace.sm) {
                        Label("Your \(StaffRosterTime.monthLabel(ack.month)) roster changed", systemImage: "exclamationmark.circle")
                            .font(.headline)
                            .foregroundStyle(XertTokens.stateWarning)
                        Text("Version \(ack.number) is published. Check your classes, then let the manager know you’ve seen it.")
                            .font(.footnote)
                            .foregroundStyle(Color.xertPale)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("I’ve seen it") {
                            Task { await staffRoster.acknowledge(ack.revision_id) }
                        }
                        .buttonStyle(XertControlButtonStyle(variant: .primary))
                        .disabled(staffRoster.isWorking)
                    }
                    .padding(.vertical, XertSpace.xs)
                }
            } header: {
                Text("Roster changes").xertEyebrow()
            }
            .listRowBackground(Color.xertInk)
        }

        Section {
            if let _ = staffRoster.roster {
                let items = upcoming
                if let next = items.first(where: { !$0.isCancelled }) {
                    CoachAssignmentRow(assignment: next, showsDate: true)
                } else {
                    Text("No published classes for you in the next two months. Once the manager publishes a roster, your classes show here.")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if let error = staffRoster.rosterError {
                XertInlineError(message: error.message) {
                    Task { await staffRoster.loadRoster() }
                }
            } else {
                CoachingLoadingRow(text: "Loading your classes…")
            }
        } header: {
            Text("Next class").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)

        if staffRoster.roster != nil {
            let next = upcoming.first(where: { !$0.isCancelled })
            let later = Array(upcoming.filter { $0.id != next?.id }.prefix(6))
            Section {
                if later.isEmpty {
                    Text("Nothing else is published yet.")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale)
                }
                ForEach(later) { assignment in
                    CoachAssignmentRow(assignment: assignment, showsDate: true)
                }
                Button {
                    onOpen(XertCoachingLink(tab: .roster))
                } label: {
                    Label("See my full roster", systemImage: "calendar")
                }
                .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
            } header: {
                Text("Coming up").xertEyebrow()
            }
            .listRowBackground(Color.xertInk)
        }

        if !dueAvailability.isEmpty {
            Section {
                ForEach(dueAvailability) { period in
                    Button {
                        onOpen(XertCoachingLink(tab: .availability, month: period.monthKey))
                    } label: {
                        HStack(spacing: XertSpace.md) {
                            Image(systemName: "checklist")
                                .foregroundStyle(Color.xertSteel)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(StaffRosterTime.monthLabel(period.month)) availability")
                                    .font(.headline)
                                    .foregroundStyle(Color.xertOffWhite)
                                Text("Due \(StaffRosterTime.dayLabel(period.due_on))\(period.draft == nil ? "" : " · draft saved, not submitted")")
                                    .font(.footnote)
                                    .foregroundStyle(Color.xertPale)
                            }
                            Spacer(minLength: XertSpace.sm)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.xertSteel)
                        }
                        .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("Availability needed").xertEyebrow()
            }
            .listRowBackground(Color.xertInk)
        }

        CoachNoticesSection(staffRoster: staffRoster, onOpen: onOpen)
    }
}

/// Roster notices. Opening the list does not mark anything read; the coach
/// does, by opening a notice or choosing Mark read.
private struct CoachNoticesSection: View {
    @ObservedObject var staffRoster: StaffRosterStore
    let onOpen: (XertCoachingLink) -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            if let items = staffRoster.notifications {
                let unread = items.filter { $0.isUnread }
                if unread.count > 1 {
                    Button("Mark all \(unread.count) as read") {
                        Task { await staffRoster.markRead(unread.map(\.id)) }
                    }
                    .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
                }
                if items.isEmpty {
                    Text("No notices yet.")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale)
                }
                ForEach(Array(items.prefix(20))) { item in
                    noticeRow(item)
                }
            } else if let error = staffRoster.notificationsError {
                XertInlineError(message: error.message) {
                    Task { await staffRoster.loadNotifications() }
                }
            } else {
                CoachingLoadingRow(text: "Loading notices…")
            }
        } header: {
            Text("Roster notices").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private func noticeRow(_ item: StaffRosterNotification) -> some View {
        VStack(alignment: .leading, spacing: XertSpace.sm) {
            HStack(alignment: .firstTextBaseline) {
                if item.isUnread {
                    Circle()
                        .fill(Color.xertSteel)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel("Unread")
                }
                Text(item.title)
                    .font(.subheadline.weight(item.isUnread ? .bold : .regular))
                    .foregroundStyle(Color.xertOffWhite)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: XertSpace.sm)
                Text(StaffRosterTime.whenLabel(item.created_at))
                    .font(.caption2)
                    .foregroundStyle(Color.xertMuted)
            }
            Text(item.body)
                .font(.footnote)
                .foregroundStyle(Color.xertPale)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: XertSpace.sm) {
                if let link = item.coachingLink {
                    Button("Open") {
                        Task {
                            if item.isUnread { await staffRoster.markRead([item.id]) }
                            onOpen(link)
                        }
                    }
                    .buttonStyle(XertControlButtonStyle(variant: .ghost))
                } else if let managerLink = item.managerLink {
                    // A manager notice (shown to an admin who also coaches)
                    // belongs to the web manager console, not My Coaching.
                    Button("Open manager console") {
                        StaffRosterManagerConsole.open(managerLink, using: openURL)
                        if item.isUnread {
                            Task { await staffRoster.markRead([item.id]) }
                        }
                    }
                    .buttonStyle(XertControlButtonStyle(variant: .ghost))
                    .accessibilityHint("Opens the roster manager console in your browser")
                }
                if item.isUnread {
                    Button("Mark read") {
                        Task { await staffRoster.markRead([item.id]) }
                    }
                    .buttonStyle(XertControlButtonStyle(variant: .quiet))
                }
            }
        }
        .padding(.vertical, XertSpace.xs)
    }
}

// MARK: - My Roster

private struct CoachRosterSections: View {
    @ObservedObject var staffRoster: StaffRosterStore
    @Binding var requestedMonth: String?
    @State private var month = StaffRosterTime.monthKey(for: Date())
    @State private var coverFor: StaffRosterAssignment?

    private var window: (from: String, to: String) { StaffRosterTime.rosterWindow() }
    private var firstMonth: String { String(window.from.prefix(7)) }
    private var lastMonth: String { String(window.to.prefix(7)) }

    private var groups: [StaffRosterDayGroup] {
        let assignments = (staffRoster.roster?.assignments ?? []).filter {
            StaffRosterTime.monthKey(for: $0.start) == month
        }
        return StaffRosterTime.groupedByDate(assignments)
    }

    var body: some View {
        Section {
            monthNavigator
            if let acks = staffRoster.roster?.pending_acknowledgements, !acks.isEmpty {
                ForEach(acks, id: \.revision_id) { ack in
                    HStack(spacing: XertSpace.md) {
                        Text("\(StaffRosterTime.monthLabel(ack.month)) changed — version \(ack.number) is published.")
                            .font(.footnote)
                            .foregroundStyle(XertTokens.stateWarning)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: XertSpace.sm)
                        Button("I’ve seen it") {
                            Task { await staffRoster.acknowledge(ack.revision_id) }
                        }
                        .buttonStyle(XertControlButtonStyle(variant: .ghost))
                        .disabled(staffRoster.isWorking)
                    }
                }
            }
        } footer: {
            Text("Published classes only, in gym time (Brisbane). Drafts are never shown.")
                .font(.caption2)
                .foregroundStyle(Color.xertMuted)
        }
        .listRowBackground(Color.xertInk)
        .onAppear(perform: applyRequestedMonth)
        .onChange(of: requestedMonth) { _ in applyRequestedMonth() }
        .sheet(item: $coverFor) { assignment in
            CoachCoverRequestSheet(assignment: assignment) { reason in
                await staffRoster.requestCover(assignment.assignment_id, reason: reason)
            }
        }

        if staffRoster.roster == nil {
            Section {
                if let error = staffRoster.rosterError {
                    XertInlineError(message: error.message) {
                        Task { await staffRoster.loadRoster() }
                    }
                } else {
                    CoachingLoadingRow(text: "Loading your roster…")
                }
            }
            .listRowBackground(Color.xertInk)
        } else if groups.isEmpty {
            Section {
                Text("No published classes for you in \(StaffRosterTime.monthLabel(month)).")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .listRowBackground(Color.xertInk)
        } else {
            ForEach(groups) { group in
                Section {
                    ForEach(group.items) { assignment in
                        VStack(alignment: .leading, spacing: XertSpace.sm) {
                            CoachAssignmentRow(assignment: assignment)
                            actions(for: assignment)
                        }
                    }
                } header: {
                    Text(group.date == StaffRosterTime.todayKey() ? "Today" : StaffRosterTime.longDayLabel(group.date))
                        .xertEyebrow()
                }
                .listRowBackground(Color.xertInk)
            }
        }
    }

    private var monthNavigator: some View {
        HStack {
            Button {
                shiftMonth(-1)
            } label: {
                Image(systemName: "chevron.left").frame(width: 44, height: 44)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.xertSteel)
            .disabled(month <= firstMonth)
            .accessibilityLabel("Previous month")

            Spacer()
            Text(StaffRosterTime.monthLabel(month))
                .font(.headline)
                .foregroundStyle(Color.xertOffWhite)
            Spacer()

            Button {
                month = firstMonth
                XertHaptics.play(.softImpact)
            } label: {
                Text("This month")
                    .font(.caption.weight(.bold))
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.xertSteel)
            .disabled(month == firstMonth)

            Button {
                shiftMonth(1)
            } label: {
                Image(systemName: "chevron.right").frame(width: 44, height: 44)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.xertSteel)
            .disabled(month >= lastMonth)
            .accessibilityLabel("Next month")
        }
    }

    @ViewBuilder
    private func actions(for assignment: StaffRosterAssignment) -> some View {
        if !assignment.isCancelled && assignment.start > Date() {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: XertSpace.sm) { actionButtons(for: assignment) }
                VStack(alignment: .leading, spacing: XertSpace.sm) { actionButtons(for: assignment) }
            }
        }
    }

    @ViewBuilder
    private func actionButtons(for assignment: StaffRosterAssignment) -> some View {
        if assignment.changed_since_publish, let sessionID = assignment.session_id {
            Button("I can do the new time") {
                Task { await staffRoster.confirmSession(sessionID, status: "AVAILABLE") }
            }
            .buttonStyle(XertControlButtonStyle(variant: .primary))
            .disabled(staffRoster.isWorking)
            Button("I can’t") {
                Task { await staffRoster.confirmSession(sessionID, status: "UNAVAILABLE") }
            }
            .buttonStyle(XertControlButtonStyle(variant: .ghost))
            .disabled(staffRoster.isWorking)
        }
        if let cover = assignment.cover {
            Button("Withdraw cover request") {
                Task { await staffRoster.withdraw(kind: "cover", id: cover.id) }
            }
            .buttonStyle(XertControlButtonStyle(variant: .ghost))
            .disabled(staffRoster.isWorking)
        } else {
            Button("Ask for cover") {
                coverFor = assignment
            }
            .buttonStyle(XertControlButtonStyle(variant: .ghost))
            .disabled(staffRoster.isWorking)
        }
    }

    private func shiftMonth(_ months: Int) {
        guard let next = StaffRosterTime.shiftMonth(month, by: months) else { return }
        month = min(max(next, firstMonth), lastMonth)
        XertHaptics.play(.softImpact)
    }

    private func applyRequestedMonth() {
        guard let requested = requestedMonth, XertCoachingLink.isValidMonth(requested) else { return }
        month = min(max(requested, firstMonth), lastMonth)
        requestedMonth = nil
    }
}

private struct CoachCoverRequestSheet: View {
    let assignment: StaffRosterAssignment
    let onSubmit: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("\(assignment.displayTitle), \(StaffRosterTime.whenLabel(assignment.start)). You stay on this class until the manager approves someone else.")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .listRowBackground(Color.xertInk)
                Section {
                    XertField(title: "Note for the manager (optional)", text: $reason, prompt: "Only managers see this")
                    Text("You don’t need to give a reason or any health details.")
                        .font(.caption)
                        .foregroundStyle(Color.xertMuted)
                }
                .listRowBackground(Color.xertInk)
            }
            .xertListBackground()
            .navigationTitle("Ask for cover")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ask for cover") {
                        isSubmitting = true
                        Task {
                            let succeeded = await onSubmit(reason)
                            isSubmitting = false
                            if succeeded { dismiss() }
                        }
                    }
                    .disabled(isSubmitting)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Requests

private struct CoachRequestsSections: View {
    @ObservedObject var staffRoster: StaffRosterStore
    @State private var showingAbsence = false

    var body: some View {
        Section {
            Button {
                showingAbsence = true
            } label: {
                Label("I need time away", systemImage: "calendar.badge.minus")
            }
            .buttonStyle(XertControlButtonStyle(variant: .primary, expands: true))
            Text("Volunteering to cover a class is only an offer. The roster changes only when the manager approves a replacement.")
                .font(.caption)
                .foregroundStyle(Color.xertMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .listRowBackground(Color.xertInk)
        .sheet(isPresented: $showingAbsence) {
            CoachAbsenceSheet { starts, ends, urgent, reason in
                await staffRoster.requestAbsence(starts: starts, ends: ends, urgent: urgent, reason: reason)
            }
        }

        if let mine = staffRoster.requests {
            coverBoardSection
            myRequestsSection(mine)
        } else if let error = staffRoster.requestsError {
            Section {
                XertInlineError(message: error.message) {
                    Task { await staffRoster.loadRequests() }
                }
            }
            .listRowBackground(Color.xertInk)
        } else {
            Section {
                CoachingLoadingRow(text: "Loading requests…")
            }
            .listRowBackground(Color.xertInk)
        }
    }

    private var coverBoardSection: some View {
        Section {
            if staffRoster.coverBoard.isEmpty {
                Text("No classes need cover right now.")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale)
            }
            ForEach(staffRoster.coverBoard) { item in
                VStack(alignment: .leading, spacing: XertSpace.sm) {
                    Text("\(item.title ?? "XERT class") · \(StaffRosterTime.whenLabel(item.start))")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertOffWhite)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(item.requested_by) asked for cover · \(StaffRosterAssignment.roleLabel(item.role))")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale)
                    if let offer = item.my_offer {
                        let words = CoachingWords.label(CoachingWords.offer, offer)
                        XertBadge(title: words.0, tone: words.1)
                        if offer == "offered" {
                            Button("Withdraw offer") {
                                Task { await staffRoster.withdraw(kind: "offer", id: item.id) }
                            }
                            .buttonStyle(XertControlButtonStyle(variant: .ghost))
                            .disabled(staffRoster.isWorking)
                        }
                    } else if !item.problems.isEmpty {
                        Text(Self.problemsLine(item.problems))
                            .font(.caption)
                            .foregroundStyle(Color.xertMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Button("I can cover this") {
                            Task { await staffRoster.offerCover(item.id) }
                        }
                        .buttonStyle(XertControlButtonStyle(variant: .primary))
                        .disabled(staffRoster.isWorking)
                    }
                }
                .padding(.vertical, XertSpace.xs)
            }
        } header: {
            Text("Classes needing cover").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private static func classLine(_ prefix: String, title: String?, start: Date?) -> String {
        var line = prefix + " " + (title ?? "XERT class")
        if let start {
            line += " · " + StaffRosterTime.whenLabel(start)
        }
        return line
    }

    private static func problemsLine(_ problems: [String]) -> String {
        let words = problems.map { CoachingWords.problems[$0] ?? $0.lowercased() }
        return "You can’t take this: " + words.joined(separator: ", ") + "."
    }

    private func myRequestsSection(_ mine: StaffRosterMyRequests) -> some View {
        Section {
            if mine.isEmpty {
                Text("None.")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale)
            }
            ForEach(mine.absences) { item in
                let words = CoachingWords.label(CoachingWords.absence, item.status)
                VStack(alignment: .leading, spacing: XertSpace.sm) {
                    Text("\(item.kind == "urgent" ? "Can’t make it" : "Time off") · \(StaffRosterTime.whenLabel(item.starts_at)) – \(StaffRosterTime.whenLabel(item.ends_at))")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertOffWhite)
                        .fixedSize(horizontal: false, vertical: true)
                    if let reason = item.reason, !reason.isEmpty {
                        Text("Your note: \(reason)")
                            .font(.caption)
                            .foregroundStyle(Color.xertMuted)
                    }
                    XertBadge(title: words.0, tone: words.1)
                    if item.status == "requested" {
                        Button("Withdraw") {
                            Task { await staffRoster.withdraw(kind: "absence", id: item.id) }
                        }
                        .buttonStyle(XertControlButtonStyle(variant: .ghost))
                        .disabled(staffRoster.isWorking)
                    }
                }
                .padding(.vertical, XertSpace.xs)
            }
            ForEach(mine.cover_requests) { item in
                let words = CoachingWords.label(CoachingWords.cover, item.status)
                VStack(alignment: .leading, spacing: XertSpace.sm) {
                    Text(Self.classLine("Cover for", title: item.title, start: item.start))
                        .font(.subheadline)
                        .foregroundStyle(Color.xertOffWhite)
                        .fixedSize(horizontal: false, vertical: true)
                    if item.offers > 0 && item.status != "approved" {
                        Text("\(item.offers) \(item.offers == 1 ? "coach has" : "coaches have") volunteered. You stay on the class until the manager approves one.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    XertBadge(title: words.0, tone: words.1)
                }
                .padding(.vertical, XertSpace.xs)
            }
            ForEach(mine.offers.filter { offer in !staffRoster.coverBoard.contains { $0.id == offer.request_id } }) { item in
                let words = CoachingWords.label(CoachingWords.offer, item.status)
                VStack(alignment: .leading, spacing: XertSpace.sm) {
                    Text(Self.classLine("Your offer:", title: item.title, start: item.start))
                        .font(.subheadline)
                        .foregroundStyle(Color.xertOffWhite)
                        .fixedSize(horizontal: false, vertical: true)
                    XertBadge(title: words.0, tone: words.1)
                }
                .padding(.vertical, XertSpace.xs)
            }
            ForEach(mine.change_requests) { item in
                VStack(alignment: .leading, spacing: XertSpace.sm) {
                    Text("Availability change for \(StaffRosterTime.monthLabel(item.month)): “\(item.message)”")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertOffWhite)
                        .fixedSize(horizontal: false, vertical: true)
                    XertBadge(title: item.status == "open" ? "Sent to manager" : item.status.capitalized, tone: item.status == "open" ? .warning : .neutral)
                }
                .padding(.vertical, XertSpace.xs)
            }
        } header: {
            Text("Your requests").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }
}

/// Planned time off (manager approves) or an urgent "can't make it" report
/// (takes effect at once and alerts the manager). Times are gym time.
private struct CoachAbsenceSheet: View {
    let onSubmit: (Date, Date, Bool, String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var urgent = false
    @State private var fromDay = Date()
    @State private var fromTime = StaffRosterTime.startOfDay(StaffRosterTime.todayKey()) ?? Date()
    @State private var untilDay = Date()
    @State private var untilEndOfDay = true
    @State private var untilTime = Date()
    @State private var reason = ""
    @State private var isSubmitting = false

    private var submitTitle: String {
        urgent ? "Tell the manager" : "Ask"
    }

    private var range: (start: Date, end: Date)? {
        let fromKey = StaffRosterTime.dateKey(for: fromDay)
        let untilKey = StaffRosterTime.dateKey(for: untilDay)
        guard let start = StaffRosterTime.instant(fromKey, minute: StaffRosterTime.minuteOfDay(fromTime)) else { return nil }
        let endMinute = untilEndOfDay ? 1_440 : StaffRosterTime.minuteOfDay(untilTime)
        guard let end = StaffRosterTime.instant(untilKey, minute: endMinute), end > start else { return nil }
        return (start, end)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    XertSegmented(
                        title: "Type",
                        selection: $urgent,
                        choices: [
                            XertChoice(value: false, label: "Planned time off"),
                            XertChoice(value: true, label: "Can’t make it"),
                        ]
                    )
                    Text(urgent
                        ? "Use this when you can’t work at short notice. You’re taken off straight away for that time and the manager is told; it’s never blocked by a deadline."
                        : "The manager approves time off. Until then, check your roster.")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .listRowBackground(Color.xertInk)

                Section {
                    DatePicker("From", selection: $fromDay, in: Date()..., displayedComponents: .date)
                    DatePicker("Time", selection: $fromTime, displayedComponents: .hourAndMinute)
                    DatePicker("Until", selection: $untilDay, in: fromDay..., displayedComponents: .date)
                    Toggle("Until the end of that day", isOn: $untilEndOfDay)
                        .tint(Color.xertSteel)
                    if !untilEndOfDay {
                        DatePicker("Time", selection: $untilTime, displayedComponents: .hourAndMinute)
                    }
                } footer: {
                    Text("Times are gym time (Brisbane).")
                        .font(.caption2)
                        .foregroundStyle(Color.xertMuted)
                }
                .listRowBackground(Color.xertInk)
                .environment(\.timeZone, StaffRosterTime.timeZone)
                .environment(\.calendar, StaffRosterTime.calendar)

                Section {
                    XertField(title: "Note for the manager (optional)", text: $reason, prompt: "Only managers see this")
                    Text("You don’t need to give a reason or any health details.")
                        .font(.caption)
                        .foregroundStyle(Color.xertMuted)
                    if range == nil {
                        XertInlineError(message: "The end must be after the start.")
                    }
                }
                .listRowBackground(Color.xertInk)
            }
            .xertListBackground()
            .navigationTitle("Time away")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: fromDay) { day in
                if untilDay < day { untilDay = day }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitTitle) {
                        guard let range else { return }
                        isSubmitting = true
                        Task {
                            let succeeded = await onSubmit(range.start, range.end, urgent, reason)
                            isSubmitting = false
                            if succeeded { dismiss() }
                        }
                    }
                    .disabled(isSubmitting || range == nil)
                }
            }
        }
    }
}
