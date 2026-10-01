import SwiftUI

/// Monthly availability: answer, review, submit. Drafts autosave through
/// `staff_roster_save_availability_draft` and never change what was
/// submitted; submitting creates a new version through
/// `staff_roster_submit_availability`. A stale version is shown plainly and
/// never overwritten silently.
struct CoachAvailabilitySections: View {
    @ObservedObject var staffRoster: StaffRosterStore
    let me: StaffRosterMe
    @Binding var requestedMonth: String?

    private enum Step {
        case answer
        case review
    }

    private enum SaveState: Equatable {
        case idle
        case pending
        case saving
        case saved
        case failed(String)
        case conflict
    }

    private enum EditorSheet: String, Identifiable {
        case weekly
        case date
        case session
        case change

        var id: String { rawValue }
    }

    @State private var selectedMonth: String?
    @State private var payload = StaffAvailabilityPayload()
    @State private var source: StaffAvailabilityEditor.StartingSource = .blank
    @State private var draftVersion = 0
    @State private var saveState: SaveState = .idle
    @State private var isSaving = false
    @State private var needsResave = false
    @State private var saveTask: Task<Void, Never>?
    @State private var step: Step = .answer
    @State private var sheet: EditorSheet?
    @State private var loadedKey = ""
    @State private var submitRequestID = UUID()
    @State private var submitError: String?
    @State private var showsEveryClass = false

    /// Always the latest `staff_roster_me`, also inside tasks that outlive this value.
    private var current: StaffRosterMe { staffRoster.me ?? me }

    private var period: StaffRosterMe.Period? {
        StaffAvailabilityEditor.preferredPeriod(current.periods, monthKey: selectedMonth)
    }

    private var monthKey: String? { period?.monthKey }

    private var phase: StaffAvailabilityEditor.Phase { StaffAvailabilityEditor.phase(period) }

    private var classes: [StaffRosterMonthClass] {
        monthKey.flatMap { staffRoster.monthClasses[$0] } ?? []
    }

    private var shortcuts: [StaffAvailabilityEditor.Shortcut] {
        StaffAvailabilityEditor.shortcuts(
            classes: classes,
            presets: current.settings?.class_time_presets?.map(\.minute) ?? []
        )
    }

    private var errors: [String] {
        monthKey.map { StaffAvailabilityEditor.validate(payload, monthKey: $0) } ?? []
    }

    private var editorKey: String {
        guard let period else { return "none" }
        return "\(period.month)|\(period.draft?.version ?? 0)|\(period.submission?.version ?? 0)"
    }

    private var isSettled: Bool {
        switch saveState {
        case .idle, .saved, .conflict, .failed(_): return !isSaving
        case .pending, .saving: return false
        }
    }

    var body: some View {
        headerSection
            .onAppear {
                applyRequestedMonth()
                resetIfNeeded()
            }
            .onChange(of: requestedMonth) { _ in applyRequestedMonth() }
            .onChange(of: editorKey) { _ in resetIfNeeded() }
            .task(id: monthKey) {
                if let monthKey, staffRoster.monthClasses[monthKey] == nil {
                    await staffRoster.loadMonthClasses(monthKey)
                }
            }
            .onDisappear(perform: flushPendingSave)
            .sheet(item: $sheet) { sheet in
                sheetContent(sheet)
            }

        if let period, let monthKey {
            switch phase {
            case .none:
                EmptyView()
            case .notOpen:
                Section {
                    Text("Availability for \(StaffRosterTime.monthLabel(monthKey)) opens \(StaffRosterTime.dayLabel(period.opens_on)).")
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .listRowBackground(Color.xertInk)
            case .closed:
                closedSection(period)
            case .open:
                if step == .answer {
                    answerSections(monthKey: monthKey)
                } else {
                    reviewSections(period: period, monthKey: monthKey)
                }
            }
        }
    }

    // MARK: Header

    private var headerSection: some View {
        Section {
            if current.periods.isEmpty {
                Text("The manager hasn’t asked for availability yet. You’ll get a notice when they do.")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let period {
                if current.periods.count > 1 {
                    XertMenuField(
                        title: "Month",
                        selection: Binding(
                            get: { period.monthKey },
                            set: { selectMonth($0) }
                        ),
                        choices: current.periods.map {
                            XertChoice(value: $0.monthKey, label: StaffRosterTime.monthLabel($0.month))
                        }
                    )
                    .disabled(!isSettled)
                }
                VStack(alignment: .leading, spacing: XertSpace.xs) {
                    Text(StaffRosterTime.monthLabel(period.month))
                        .xertDisplay(28)
                    Text(statusLine(period))
                        .font(.subheadline)
                        .foregroundStyle(Color.xertPale)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, XertSpace.xs)
                if phase == .open {
                    saveStatusRow
                }
            }
        } header: {
            Text("Availability").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private func statusLine(_ period: StaffRosterMe.Period) -> String {
        var line: String
        switch StaffAvailabilityEditor.phase(period) {
        case .notOpen: line = "Opens \(StaffRosterTime.dayLabel(period.opens_on))."
        case .closed: line = "The deadline was \(StaffRosterTime.dayLabel(period.due_on))."
        case .open, .none:
            line = "Due \(StaffRosterTime.dayLabel(period.due_on))."
            if period.reopened { line += " Reopened for you by the manager." }
        }
        if let submission = period.submission {
            line += submission.no_availability
                ? " Submitted “not available this month”"
                : " Submitted version \(submission.version)"
            line += submission.late ? " (late)." : "."
        } else {
            line += " Not submitted yet."
        }
        return line
    }

    @ViewBuilder
    private var saveStatusRow: some View {
        switch saveState {
        case .idle:
            if source == .usualWeek {
                Label("Started from your usual week", systemImage: "arrow.uturn.backward")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale)
            } else if source == .submission {
                Label("Showing what you submitted", systemImage: "checkmark.seal")
                    .font(.caption)
                    .foregroundStyle(Color.xertPale)
            }
        case .pending:
            Label("Unsaved changes", systemImage: "pencil")
                .font(.caption)
                .foregroundStyle(Color.xertPale)
        case .saving:
            Label("Saving draft…", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption)
                .foregroundStyle(Color.xertPale)
        case .saved:
            Label("Draft saved — not submitted yet", systemImage: "tray.and.arrow.down")
                .font(.caption)
                .foregroundStyle(Color.xertPale)
        case .failed(let message):
            VStack(alignment: .leading, spacing: XertSpace.sm) {
                XertInlineError(message: "Couldn’t save your draft. \(message)")
                Button("Try again") {
                    Task { await saveNow() }
                }
                .buttonStyle(XertControlButtonStyle(variant: .ghost))
            }
        case .conflict:
            VStack(alignment: .leading, spacing: XertSpace.sm) {
                XertInlineError(message: "Your availability for this month was changed somewhere else (another device or the manager). Nothing here was saved over it. Load the latest version, then make your changes again.")
                Button("Load latest") {
                    Task { await loadLatest() }
                }
                .buttonStyle(XertControlButtonStyle(variant: .primary))
                .disabled(staffRoster.isWorking)
            }
        }
    }

    // MARK: Closed

    private func closedSection(_ period: StaffRosterMe.Period) -> some View {
        Section {
            VStack(alignment: .leading, spacing: XertSpace.sm) {
                Text("Need to change something?")
                    .font(.headline)
                    .foregroundStyle(Color.xertOffWhite)
                Text("After the deadline the manager has to reopen your availability. Time away can always be reported from Requests.")
                    .font(.footnote)
                    .foregroundStyle(Color.xertPale)
                    .fixedSize(horizontal: false, vertical: true)
                if period.change_request_open {
                    XertBadge(title: "Request sent", tone: .neutral)
                } else {
                    Button("Ask the manager") { sheet = .change }
                        .buttonStyle(XertControlButtonStyle(variant: .ghost))
                }
            }
            .padding(.vertical, XertSpace.xs)
        }
        .listRowBackground(Color.xertInk)
    }

    // MARK: Answer

    @ViewBuilder
    private func answerSections(monthKey: String) -> some View {
        Section {
            Toggle(isOn: Binding(
                get: { payload.noAvailability },
                set: { value in
                    update(value
                        ? StaffAvailabilityPayload(weekly: [], exceptions: [], noAvailability: true)
                        : StaffAvailabilityPayload(weekly: payload.weekly, exceptions: payload.exceptions, noAvailability: false))
                }
            )) {
                VStack(alignment: .leading, spacing: XertSpace.xs) {
                    Text("Not available this month")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertOffWhite)
                    Text("Tell the manager you can’t work at all in \(StaffRosterTime.monthLabel(monthKey)).")
                        .font(.caption)
                        .foregroundStyle(Color.xertPale)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(Color.xertSteel)
            .accessibilityIdentifier("coaching-not-available-this-month")
        }
        .listRowBackground(Color.xertInk)

        if !payload.noAvailability {
            shortcutSection(monthKey: monthKey)
            weeklySection
            exceptionSection(monthKey: monthKey)
            startingPointSection(monthKey: monthKey)
        }

        Section {
            if !errors.isEmpty {
                VStack(alignment: .leading, spacing: XertSpace.xs) {
                    Text("Before you can submit")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(XertTokens.stateWarning)
                    ForEach(errors, id: \.self) { message in
                        Text("• \(message)")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Button("Review " + StaffRosterTime.monthLabel(monthKey)) {
                flushPendingSave()
                step = .review
            }
            .buttonStyle(XertControlButtonStyle(variant: .primary, expands: true))
            .disabled(!errors.isEmpty)
        }
        .listRowBackground(Color.xertInk)
    }

    @ViewBuilder
    private func shortcutSection(monthKey: String) -> some View {
        Section {
            if shortcuts.isEmpty {
                Text(emptyShortcutsText(monthKey: monthKey))
                    .font(.subheadline)
                    .foregroundStyle(Color.xertPale)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(0..<7, id: \.self) { weekday in
                let list = shortcuts.filter { $0.weekday == weekday }
                if !list.isEmpty {
                    VStack(alignment: .leading, spacing: XertSpace.md) {
                        Text("\(StaffRosterTime.weekdayNames[weekday])s")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.xertOffWhite)
                        ForEach(list) { shortcut in
                            VStack(alignment: .leading, spacing: XertSpace.xs) {
                                Text("\(shortcut.label) \(shortcut.sessions == 1 ? "class" : "classes") · on duty \(StaffRosterTime.minuteLabel(shortcut.start))–\(StaffRosterTime.minuteLabel(shortcut.end))")
                                    .font(.caption)
                                    .foregroundStyle(Color.xertPale)
                                CoachStatusChoices(
                                    label: "\(StaffRosterTime.weekdayNames[weekday]) \(shortcut.label)",
                                    value: StaffAvailabilityEditor.shortcutStatus(payload, shortcut: shortcut)
                                ) { status in
                                    update(StaffAvailabilityEditor.setShortcut(payload, shortcut: shortcut, status: status))
                                }
                            }
                        }
                    }
                    .padding(.vertical, XertSpace.xs)
                }
            }
        } header: {
            Text("Class times each week").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private func emptyShortcutsText(monthKey: String) -> String {
        if staffRoster.monthClasses[monthKey] == nil {
            return "Loading this month’s classes…"
        }
        return "No classes are on the timetable for \(StaffRosterTime.monthLabel(monthKey)) yet. Add usual times below instead."
    }

    private func submitTitle(period: StaffRosterMe.Period, monthKey: String) -> String {
        if period.submission == nil {
            return "Submit \(StaffRosterTime.monthLabel(monthKey))"
        }
        return "Submit changes"
    }

    private var customWeekly: [StaffWeeklyWindow] {
        payload.weekly.filter { window in
            !shortcuts.contains { $0.weekday == window.weekday && $0.start == window.start && $0.end == window.end }
        }
    }

    private var weeklySection: some View {
        Section {
            ForEach(Array(customWeekly.enumerated()), id: \.offset) { entry in
                windowRow(
                    title: "\(StaffRosterTime.weekdayNames[min(max(entry.element.weekday, 0), 6)]) \(StaffRosterTime.clockLabel(entry.element.start))–\(StaffRosterTime.clockLabel(entry.element.end))",
                    status: entry.element.status
                ) {
                    var next = payload
                    if let index = next.weekly.firstIndex(of: entry.element) { next.weekly.remove(at: index) }
                    update(next)
                }
            }
            Button {
                sheet = .weekly
            } label: {
                Label("Add a usual time", systemImage: "plus")
            }
            .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
        } header: {
            Text("Other usual times").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    private func exceptionSection(monthKey: String) -> some View {
        Section {
            Text("A date overrides your usual week for the times you give, e.g. away on the 14th.")
                .font(.caption)
                .foregroundStyle(Color.xertMuted)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(payload.exceptions.enumerated()), id: \.offset) { entry in
                windowRow(
                    title: "\(StaffRosterTime.dayLabel(entry.element.date)) \(entry.element.start == 0 && entry.element.end == 1_440 ? "all day" : "\(StaffRosterTime.clockLabel(entry.element.start))–\(StaffRosterTime.clockLabel(entry.element.end))")",
                    status: entry.element.status
                ) {
                    var next = payload
                    if let index = next.exceptions.firstIndex(of: entry.element) { next.exceptions.remove(at: index) }
                    update(next)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: XertSpace.sm) { exceptionButtons(monthKey: monthKey) }
                VStack(spacing: XertSpace.sm) { exceptionButtons(monthKey: monthKey) }
            }
        } header: {
            Text("Specific dates and classes").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)
    }

    @ViewBuilder
    private func exceptionButtons(monthKey: String) -> some View {
        Button {
            sheet = .date
        } label: {
            Label("Add a date", systemImage: "calendar.badge.plus")
        }
        .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
        Button {
            sheet = .session
        } label: {
            Label("Answer for a class", systemImage: "figure.strengthtraining.traditional")
        }
        .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
        .disabled(classes.isEmpty)
    }

    private func startingPointSection(monthKey: String) -> some View {
        Section {
            if let pattern = current.usual_week?.pattern, !pattern.isEmpty {
                Button("Reset to my usual week") {
                    update(StaffAvailabilityEditor.fromPattern(pattern))
                }
                .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
            }
            if let last = current.last_submission, String(last.month.prefix(7)) != monthKey {
                Button("Copy " + StaffRosterTime.monthLabel(last.month)) {
                    update(last.no_availability || last.payload.noAvailability
                        ? StaffAvailabilityPayload()
                        : StaffAvailabilityEditor.fromPattern(last.payload.weekly))
                }
                .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
            }
            Button("Save as my usual week") {
                let pattern = payload.weekly
                let version = current.usual_week?.version ?? 0
                Task { await staffRoster.saveUsualWeek(pattern, expectedVersion: version) }
            }
            .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
            .disabled(payload.weekly.isEmpty || staffRoster.isWorking)
        } footer: {
            Text("Your usual week is where next month starts. Date answers never carry over.")
                .font(.caption2)
                .foregroundStyle(Color.xertMuted)
        }
        .listRowBackground(Color.xertInk)
    }

    private func windowRow(title: String, status: String, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: XertSpace.md) {
            VStack(alignment: .leading, spacing: XertSpace.xs) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(Color.xertOffWhite)
                XertBadge(title: StaffAvailabilityStatus.label(for: status), tone: tone(for: status))
            }
            Spacer(minLength: XertSpace.sm)
            Button("Remove", role: .destructive, action: onRemove)
                .buttonStyle(.borderless)
                .accessibilityLabel("Remove \(title)")
        }
    }

    // MARK: Review

    @ViewBuilder
    private func reviewSections(period: StaffRosterMe.Period, monthKey: String) -> some View {
        let review = StaffAvailabilityEditor.review(payload, monthKey: monthKey, classes: classes)
        Section {
            if payload.noAvailability {
                Text("You’re telling the manager you can’t work in \(StaffRosterTime.monthLabel(monthKey)). You won’t be rostered. You can still offer to cover a class later.")
                    .font(.subheadline)
                    .foregroundStyle(Color.xertOffWhite)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: XertSpace.xs) {
                    Text("You’ll be considered for \(review.considered) of \(review.rows.count) classes.")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.xertOffWhite)
                    if review.ifNeeded > 0 {
                        Text("\(review.ifNeeded) more only if nobody else can.")
                            .font(.caption)
                            .foregroundStyle(Color.xertPale)
                    }
                    if review.partial > 0 {
                        Text("\(review.partial) only partly covered — you won’t be rostered on those. Extend your times if you can do the whole duty.")
                            .font(.caption)
                            .foregroundStyle(XertTokens.stateWarning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if review.unknown > 0 {
                        Text("\(review.unknown) not answered — treated as not available.")
                            .font(.caption)
                            .foregroundStyle(Color.xertMuted)
                    }
                }
                if !review.rows.isEmpty {
                    DisclosureGroup("See every class", isExpanded: $showsEveryClass) {
                        ForEach(review.rows) { row in
                            HStack {
                                Text("\(StaffRosterTime.dayLabel(for: row.session.start)) \(StaffRosterTime.timeLabel(row.session.start)) · \(row.session.displayTitle)")
                                    .font(.caption)
                                    .foregroundStyle(Color.xertOffWhite)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: XertSpace.sm)
                                XertBadge(title: StaffAvailabilityStatus.label(for: row.status), tone: tone(for: row.status))
                            }
                        }
                    }
                    .tint(Color.xertSteel)
                }
            }
        } header: {
            Text("Check before you submit").xertEyebrow()
        }
        .listRowBackground(Color.xertInk)

        Section {
            if let submitError {
                XertInlineError(message: submitError)
            }
            Button(submitTitle(period: period, monthKey: monthKey)) {
                Task { await submit() }
            }
            .buttonStyle(XertControlButtonStyle(variant: .primary, expands: true))
            .disabled(staffRoster.isWorking || !review.errors.isEmpty || saveState == .conflict)
            Button("Back") { step = .answer }
                .buttonStyle(XertControlButtonStyle(variant: .ghost, expands: true))
        } footer: {
            Text("Submitting doesn’t put you on the roster. The manager builds and publishes it, and you’ll get a notice when they do.")
                .font(.caption2)
                .foregroundStyle(Color.xertMuted)
        }
        .listRowBackground(Color.xertInk)
    }

    // MARK: Sheets

    @ViewBuilder
    private func sheetContent(_ sheet: EditorSheet) -> some View {
        switch sheet {
        case .weekly:
            CoachWindowSheet(mode: .weekly, monthKey: monthKey ?? StaffRosterTime.monthKey(for: Date())) { window in
                var next = payload
                next.noAvailability = false
                if let weekly = window.weekly { next.weekly.append(weekly) }
                update(next)
            }
        case .date:
            CoachWindowSheet(mode: .date, monthKey: monthKey ?? StaffRosterTime.monthKey(for: Date())) { window in
                var next = payload
                next.noAvailability = false
                if let exception = window.exception { next.exceptions.append(exception) }
                update(next)
            }
        case .session:
            CoachClassExceptionSheet(classes: classes) { exception in
                var next = payload
                next.noAvailability = false
                next.exceptions.append(exception)
                update(next)
            }
        case .change:
            CoachChangeRequestSheet(monthLabel: StaffRosterTime.monthLabel(monthKey ?? "")) { message in
                guard let monthKey else { return false }
                return await staffRoster.requestChange(monthKey: monthKey, message: message)
            }
        }
    }

    // MARK: State

    private func tone(for status: String) -> XertTone {
        switch status {
        case "PREFERRED", "AVAILABLE": return .success
        case "IF_NEEDED", "PARTIAL": return .warning
        case "UNAVAILABLE", "ABSENT": return .danger
        default: return .neutral
        }
    }

    private func applyRequestedMonth() {
        guard let requested = requestedMonth, XertCoachingLink.isValidMonth(requested) else { return }
        requestedMonth = nil
        guard requested != monthKey else { return }
        if isSettled {
            selectedMonth = requested
        }
    }

    private func selectMonth(_ value: String) {
        guard isSettled, value != monthKey else { return }
        selectedMonth = value
    }

    private func resetIfNeeded(force: Bool = false) {
        let key = editorKey
        guard force || key != loadedKey else { return }
        guard let period else {
            loadedKey = key
            return
        }
        let serverDraftVersion = period.draft?.version ?? 0
        let samePeriod = loadedKey.hasPrefix("\(period.month)|")
        if !force && samePeriod {
            if serverDraftVersion == draftVersion {
                // Our own autosave; nothing new to show.
                loadedKey = key
                return
            }
            if !isSettled || saveState == .conflict {
                // Someone else saved while there are unsaved edits here.
                saveState = .conflict
                loadedKey = key
                return
            }
        }
        let start = StaffAvailabilityEditor.startingPoint(period: period, usualWeek: current.usual_week)
        saveTask?.cancel()
        payload = start.payload
        source = start.source
        draftVersion = serverDraftVersion
        saveState = period.draft == nil ? .idle : .saved
        step = .answer
        submitRequestID = UUID()
        submitError = nil
        loadedKey = key
    }

    private func update(_ next: StaffAvailabilityPayload) {
        payload = next
        submitRequestID = UUID()
        submitError = nil
        guard saveState != .conflict else { return }
        saveState = .pending
        scheduleSave()
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled else { return }
            await saveNow()
        }
    }

    private func flushPendingSave() {
        guard saveState == .pending else { return }
        saveTask?.cancel()
        Task { @MainActor in await saveNow() }
    }

    private func saveNow() async {
        guard let monthKey, saveState != .conflict else { return }
        guard !isSaving else {
            needsResave = true
            return
        }
        let snapshot = payload
        let expectedVersion = draftVersion
        isSaving = true
        saveState = .saving
        let result = await staffRoster.saveDraft(monthKey: monthKey, payload: snapshot, expectedVersion: expectedVersion)
        isSaving = false
        switch result {
        case .some(.success(let saved)):
            draftVersion = saved.version
            if payload != snapshot || needsResave {
                needsResave = false
                saveState = .pending
                scheduleSave()
            } else {
                saveState = .saved
            }
        case .some(.failure(let failure)):
            needsResave = false
            saveState = failure.isStaleVersion ? .conflict : .failed(failure.message)
        case .none:
            break
        }
    }

    private func loadLatest() async {
        saveTask?.cancel()
        await staffRoster.refreshAccess()
        saveState = .idle
        resetIfNeeded(force: true)
    }

    private func submit() async {
        guard let monthKey, let period else { return }
        saveTask?.cancel()
        submitError = nil
        let requestID = submitRequestID
        let result = await staffRoster.submitAvailability(monthKey: monthKey, payload: payload, requestID: requestID)
        switch result {
        case .some(.success(let receipt)):
            let month = StaffRosterTime.monthLabel(monthKey)
            let message = receipt.no_availability
                ? "Sent: you’re not available in \(month). You can change it until \(StaffRosterTime.dayLabel(period.due_on))."
                : "\(month) submitted\(receipt.version > 1 ? " (version \(receipt.version))" : ""). You can change it until \(StaffRosterTime.dayLabel(period.due_on))."
            staffRoster.banner = StaffRosterBanner(message: message, isError: false)
            XertHaptics.play(.success)
            saveState = .idle
            resetIfNeeded(force: true)
        case .some(.failure(let failure)):
            XertHaptics.play(.error)
            if failure.isStaleVersion {
                saveState = .conflict
            }
            submitError = failure.message
        case .none:
            break
        }
    }
}

// MARK: - Controls

/// Preferred / Yes / If needed / No, with a second tap clearing the answer.
private struct CoachStatusChoices: View {
    let label: String
    let value: String?
    let onChange: (String?) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: XertSpace.xs) { buttons }
            VStack(alignment: .leading, spacing: XertSpace.xs) { buttons }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private var buttons: some View {
        ForEach(StaffAvailabilityStatus.allCases) { status in
            let selected = value == status.rawValue
            Button {
                XertHaptics.play(.selection)
                onChange(selected ? nil : status.rawValue)
            } label: {
                Text(status.shortLabel)
                    .font(.caption.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 36)
                    .padding(.horizontal, XertSpace.sm)
                    .foregroundStyle(selected ? Color.xertNavy : Color.xertOffWhite)
                    .background(selected ? Color.xertSteel : Color.xertNavy.opacity(0.42))
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(Color.xertSteel.opacity(0.4), lineWidth: 1))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("\(label): \(StaffAvailabilityStatus.label(for: status.rawValue))")
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }
}

/// Adds one usual-week time or one date answer. Times are gym time.
private struct CoachWindowSheet: View {
    enum Mode {
        case weekly
        case date
    }

    struct Entry {
        let weekly: StaffWeeklyWindow?
        let exception: StaffDateWindow?
    }

    let mode: Mode
    let monthKey: String
    let onAdd: (Entry) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var weekday = 1
    @State private var day = Date()
    @State private var wholeDay = false
    @State private var from = Date()
    @State private var untilEndOfDay = false
    @State private var until = Date()
    @State private var status = StaffAvailabilityStatus.available.rawValue
    @State private var didPrepare = false

    private var monthRange: ClosedRange<Date> {
        guard let interval = StaffRosterTime.monthInterval(monthKey) else { return Date()...Date() }
        return interval.start...interval.end.addingTimeInterval(-1)
    }

    private var minutes: (start: Int, end: Int)? {
        if mode == .date && wholeDay { return (0, 1_440) }
        let start = StaffRosterTime.minuteOfDay(from)
        let end = untilEndOfDay ? 1_440 : StaffRosterTime.minuteOfDay(until)
        return end > start ? (start, end) : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if mode == .weekly {
                        XertMenuField(
                            title: "Day",
                            selection: $weekday,
                            choices: (0..<7).map { XertChoice(value: $0, label: StaffRosterTime.weekdayNames[$0]) }
                        )
                    } else {
                        DatePicker("Date", selection: $day, in: monthRange, displayedComponents: .date)
                        Toggle("Whole day", isOn: $wholeDay)
                            .tint(Color.xertSteel)
                    }
                    if !(mode == .date && wholeDay) {
                        DatePicker("From", selection: $from, displayedComponents: .hourAndMinute)
                        Toggle("Until the end of the day", isOn: $untilEndOfDay)
                            .tint(Color.xertSteel)
                        if !untilEndOfDay {
                            DatePicker("Until", selection: $until, displayedComponents: .hourAndMinute)
                        }
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
                    XertSegmented(
                        title: "Answer",
                        selection: $status,
                        choices: StaffAvailabilityStatus.allCases.map { XertChoice(value: $0.rawValue, label: $0.shortLabel) }
                    )
                    if minutes == nil {
                        XertInlineError(message: "The end time must be after the start.")
                    }
                }
                .listRowBackground(Color.xertInk)
            }
            .xertListBackground()
            .navigationTitle(mode == .weekly ? "Add a usual time" : "Add a date")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear(perform: prepare)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard let minutes else { return }
                        if mode == .weekly {
                            onAdd(Entry(
                                weekly: StaffWeeklyWindow(weekday: weekday, start: minutes.start, end: minutes.end, status: status),
                                exception: nil
                            ))
                        } else {
                            onAdd(Entry(
                                weekly: nil,
                                exception: StaffDateWindow(date: StaffRosterTime.dateKey(for: day), start: minutes.start, end: minutes.end, status: status)
                            ))
                        }
                        dismiss()
                    }
                    .disabled(minutes == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func prepare() {
        guard !didPrepare else { return }
        didPrepare = true
        let first = "\(monthKey)-01"
        day = StaffRosterTime.startOfDay(first) ?? Date()
        from = StaffRosterTime.instant(first, minute: 5 * 60) ?? Date()
        until = StaffRosterTime.instant(first, minute: 8 * 60) ?? Date()
        if mode == .date {
            status = StaffAvailabilityStatus.unavailable.rawValue
        }
    }
}

/// Answers for one class in the month: a date answer spanning its whole duty.
private struct CoachClassExceptionSheet: View {
    let classes: [StaffRosterMonthClass]
    let onAdd: (StaffDateWindow) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selectedID: UUID?
    @State private var status = StaffAvailabilityStatus.unavailable.rawValue

    private var upcoming: [StaffRosterMonthClass] {
        let now = Date()
        return classes.filter { $0.start > now }.sorted { $0.start < $1.start }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    XertSegmented(
                        title: "Answer",
                        selection: $status,
                        choices: StaffAvailabilityStatus.allCases.map { XertChoice(value: $0.rawValue, label: $0.shortLabel) }
                    )
                }
                .listRowBackground(Color.xertInk)
                Section {
                    if upcoming.isEmpty {
                        Text("No upcoming classes this month.")
                            .font(.subheadline)
                            .foregroundStyle(Color.xertPale)
                    }
                    ForEach(upcoming) { session in
                        Button {
                            selectedID = session.id
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(session.displayTitle)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Color.xertOffWhite)
                                    Text(StaffRosterTime.whenLabel(session.start))
                                        .font(.caption)
                                        .foregroundStyle(Color.xertPale)
                                }
                                Spacer()
                                if selectedID == session.id {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.xertSteel)
                                }
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selectedID == session.id ? .isSelected : [])
                    }
                } footer: {
                    Text("This answers for the class’s whole duty, including set-up and pack-down, on that date only.")
                        .font(.caption2)
                        .foregroundStyle(Color.xertMuted)
                }
                .listRowBackground(Color.xertInk)
            }
            .xertListBackground()
            .navigationTitle("Answer for a class")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard
                            let session = upcoming.first(where: { $0.id == selectedID }),
                            let exception = StaffAvailabilityEditor.sessionException(session, status: status)
                        else { return }
                        onAdd(exception)
                        dismiss()
                    }
                    .disabled(selectedID == nil)
                }
            }
        }
    }
}

private struct CoachChangeRequestSheet: View {
    let monthLabel: String
    let onSend: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var message = ""
    @State private var isSending = false

    private var trimmed: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    XertField(
                        title: "What do you need to change in \(monthLabel)?",
                        text: $message,
                        axis: .vertical,
                        lineRange: 3...6
                    )
                    Text("The manager can reopen your availability so you can change it.")
                        .font(.caption)
                        .foregroundStyle(Color.xertMuted)
                }
                .listRowBackground(Color.xertInk)
            }
            .xertListBackground()
            .navigationTitle("Ask the manager")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        isSending = true
                        let text = String(trimmed.prefix(500))
                        Task {
                            let sent = await onSend(text)
                            isSending = false
                            if sent { dismiss() }
                        }
                    }
                    .disabled(isSending || trimmed.count < 3)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
