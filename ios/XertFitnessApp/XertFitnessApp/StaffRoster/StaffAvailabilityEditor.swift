import Foundation

/// Preview helpers for the coach availability screen, mirroring
/// src/lib/staffRoster/availability.js and availabilityEditor.js. They only
/// shape the coach's own answer and explain how it will read; the database
/// validates and evaluates again on save and submit.
enum StaffAvailabilityEditor {
    enum Phase: Equatable {
        case none
        case notOpen
        case open
        case closed
    }

    enum StartingSource: Equatable {
        case draft
        case submission
        case usualWeek
        case blank
    }

    struct Shortcut: Hashable, Identifiable {
        let weekday: Int
        let presetMinute: Int
        let start: Int
        let end: Int
        let sessions: Int

        var id: String { "\(weekday):\(presetMinute)" }
        var label: String { StaffRosterTime.minuteLabel(presetMinute) }
    }

    struct ReviewRow: Hashable, Identifiable {
        let session: StaffRosterMonthClass
        let status: String

        var id: UUID { session.id }
    }

    struct Review: Equatable {
        let errors: [String]
        let rows: [ReviewRow]

        var considered: Int { count("PREFERRED") + count("AVAILABLE") }
        var ifNeeded: Int { count("IF_NEEDED") }
        var partial: Int { count("PARTIAL") }
        var unknown: Int { count("UNKNOWN") }
        var unavailable: Int { count("UNAVAILABLE") }

        private func count(_ status: String) -> Int {
            rows.filter { $0.status == status }.count
        }
    }

    /// What a coach can do with a period today.
    static func phase(_ period: StaffRosterMe.Period?) -> Phase {
        guard let period else { return .none }
        if !period.is_open { return .notOpen }
        if period.deadline_passed && !period.reopened { return .closed }
        return .open
    }

    /// The period a screen should show: the one named by the link, else the
    /// first open unanswered month, else the first open month, else the last.
    static func preferredPeriod(_ periods: [StaffRosterMe.Period], monthKey: String?) -> StaffRosterMe.Period? {
        if let monthKey, let named = periods.first(where: { $0.monthKey == monthKey }) { return named }
        if let unanswered = periods.first(where: { phase($0) == .open && $0.submission == nil }) { return unanswered }
        if let open = periods.first(where: { phase($0) == .open }) { return open }
        return periods.last
    }

    /// Where a month's answer starts: its draft, else its latest submission,
    /// else the usual week. Date exceptions never carry over between months.
    static func startingPoint(
        period: StaffRosterMe.Period,
        usualWeek: StaffRosterMe.UsualWeek?
    ) -> (payload: StaffAvailabilityPayload, source: StartingSource) {
        if let draft = period.draft { return (draft.payload, .draft) }
        if let submission = period.submission {
            var payload = submission.payload
            payload.noAvailability = submission.no_availability || submission.payload.noAvailability
            return (payload, .submission)
        }
        if let pattern = usualWeek?.pattern, !pattern.isEmpty {
            return (fromPattern(pattern), .usualWeek)
        }
        return (StaffAvailabilityPayload(), .blank)
    }

    static func fromPattern(_ pattern: [StaffWeeklyWindow]) -> StaffAvailabilityPayload {
        StaffAvailabilityPayload(weekly: pattern, exceptions: [], noAvailability: false)
    }

    // MARK: Validation

    private static let statuses = StaffAvailabilityStatus.allCases.map(\.rawValue)

    private static func validMinutes(start: Int, end: Int) -> Bool {
        start >= 0 && end <= 1_440 && end > start
    }

    /// Plain-language problems that stop a submission. Empty means it can be
    /// submitted (the server still checks).
    static func validate(_ payload: StaffAvailabilityPayload, monthKey: String) -> [String] {
        var errors: [String] = []
        var weekly: [StaffWeeklyWindow] = []
        for window in payload.weekly {
            guard (0...6).contains(window.weekday) else {
                errors.append("A usual-week time has no valid weekday.")
                continue
            }
            let day = StaffRosterTime.weekdayNames[window.weekday]
            guard statuses.contains(window.status) else {
                errors.append("\(day): choose Preferred, Available, If needed or Unavailable.")
                continue
            }
            guard validMinutes(start: window.start, end: window.end) else {
                errors.append("\(day): a time must end after it starts, within the day.")
                continue
            }
            weekly.append(window)
        }
        var exceptions: [StaffDateWindow] = []
        for window in payload.exceptions {
            guard StaffRosterTime.startOfDay(window.date) != nil, window.date.hasPrefix("\(monthKey)-") else {
                errors.append("\(window.date.isEmpty ? "A date" : window.date) is not in this roster month.")
                continue
            }
            guard statuses.contains(window.status) else {
                errors.append("\(window.date): choose Preferred, Available, If needed or Unavailable.")
                continue
            }
            guard validMinutes(start: window.start, end: window.end) else {
                errors.append("\(window.date): a time must end after it starts, within the day.")
                continue
            }
            exceptions.append(window)
        }
        errors += contradictions(weekly.map { window -> ContradictionWindow in
            (key: StaffRosterTime.weekdayNames[window.weekday], start: window.start, end: window.end, status: window.status)
        })
        errors += contradictions(exceptions.map { window -> ContradictionWindow in
            (key: window.date, start: window.start, end: window.end, status: window.status)
        })
        if payload.noAvailability
            && (weekly.contains { $0.status != "UNAVAILABLE" } || exceptions.contains { $0.status != "UNAVAILABLE" }) {
            errors.append("You marked the whole month unavailable but also gave available times. Clear those times or untick “not available this month”.")
        }
        if !payload.noAvailability && weekly.isEmpty && exceptions.isEmpty {
            errors.append("Add at least one time, or choose “not available this month”.")
        }
        return errors
    }

    private typealias ContradictionWindow = (key: String, start: Int, end: Int, status: String)

    private static func contradictions(_ windows: [ContradictionWindow]) -> [String] {
        var errors: [String] = []
        let groups = Dictionary(grouping: windows, by: { $0.key })
        for key in groups.keys.sorted() {
            let sorted = (groups[key] ?? []).sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
            for i in sorted.indices {
                var j = i + 1
                while j < sorted.count, sorted[j].start < sorted[i].end {
                    if sorted[i].status != sorted[j].status {
                        errors.append(
                            "\(key): \(StaffRosterTime.clockLabel(sorted[i].start))–\(StaffRosterTime.clockLabel(sorted[i].end)) is "
                                + "\(StaffAvailabilityStatus.label(for: sorted[i].status).lowercased()) but "
                                + "\(StaffRosterTime.clockLabel(sorted[j].start))–\(StaffRosterTime.clockLabel(sorted[j].end)) is "
                                + "\(StaffAvailabilityStatus.label(for: sorted[j].status).lowercased()). Pick one."
                        )
                    }
                    j += 1
                }
            }
        }
        return errors
    }

    // MARK: Expansion and review

    struct Interval: Equatable {
        var start: TimeInterval
        var end: TimeInterval
    }

    struct Window: Equatable {
        let start: TimeInterval
        let end: TimeInterval
        let status: String
    }

    static func merge(_ intervals: [Interval]) -> [Interval] {
        let sorted = intervals.filter { $0.end > $0.start }
            .sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
        var merged: [Interval] = []
        for item in sorted {
            if let last = merged.indices.last, item.start <= merged[last].end {
                merged[last].end = max(merged[last].end, item.end)
            } else {
                merged.append(item)
            }
        }
        return merged
    }

    static func subtract(_ intervals: [Interval], cuts: [Interval]) -> [Interval] {
        var remaining = intervals
        for cut in cuts {
            var next: [Interval] = []
            for item in remaining {
                guard item.start < cut.end && cut.start < item.end else {
                    next.append(item)
                    continue
                }
                if item.start < cut.start { next.append(Interval(start: item.start, end: cut.start)) }
                if cut.end < item.end { next.append(Interval(start: cut.end, end: item.end)) }
            }
            remaining = next
        }
        return remaining
    }

    static func covers(_ intervals: [Interval], start: TimeInterval, end: TimeInterval) -> Bool {
        var cursor = start
        for item in merge(intervals) {
            if item.end <= cursor { continue }
            if item.start > cursor { return false }
            cursor = item.end
            if cursor >= end { return true }
        }
        return cursor >= end
    }

    /// Concrete windows for every gym date in the month; date exceptions
    /// replace the overlapping part of that day's usual week.
    static func expand(_ payload: StaffAvailabilityPayload, monthKey: String) -> [Window] {
        let dates = StaffRosterTime.dates(inMonth: monthKey)
        if payload.noAvailability {
            guard let interval = StaffRosterTime.monthInterval(monthKey) else { return [] }
            return [Window(start: interval.start.timeIntervalSince1970, end: interval.end.timeIntervalSince1970, status: "UNAVAILABLE")]
        }
        var windows: [Window] = []
        for date in dates {
            guard let midnight = StaffRosterTime.startOfDay(date)?.timeIntervalSince1970,
                  let weekday = StaffRosterTime.weekday(date) else { continue }
            func span(_ start: Int, _ end: Int) -> Interval {
                Interval(start: midnight + TimeInterval(start * 60), end: midnight + TimeInterval(end * 60))
            }
            let dayExceptions = payload.exceptions.filter { $0.date == date }
            let cuts = merge(dayExceptions.map { span($0.start, $0.end) })
            for status in statuses {
                let weekly = merge(payload.weekly.filter { $0.weekday == weekday && $0.status == status }.map { span($0.start, $0.end) })
                for piece in subtract(weekly, cuts: cuts) {
                    windows.append(Window(start: piece.start, end: piece.end, status: status))
                }
                for piece in merge(dayExceptions.filter { $0.status == status }.map { span($0.start, $0.end) }) {
                    windows.append(Window(start: piece.start, end: piece.end, status: status))
                }
            }
        }
        return windows
    }

    /// How windows answer a duty: a positive status, UNAVAILABLE, PARTIAL or UNKNOWN.
    static func intervalStatus(_ windows: [Window], start: TimeInterval, end: TimeInterval) -> String {
        let touching = windows.filter { $0.start < end && start < $0.end }
        if touching.contains(where: { $0.status == "UNAVAILABLE" }) { return "UNAVAILABLE" }
        let positive = touching.filter { ($0.status == "PREFERRED" || $0.status == "AVAILABLE" || $0.status == "IF_NEEDED") }
        if positive.isEmpty { return "UNKNOWN" }
        if !covers(positive.map { Interval(start: $0.start, end: $0.end) }, start: start, end: end) { return "PARTIAL" }
        var worst = StaffAvailabilityStatus.preferred
        for window in positive {
            if let status = StaffAvailabilityStatus(rawValue: window.status), status.rank < worst.rank {
                worst = status
            }
        }
        return worst.rawValue
    }

    /// How the answer reads for every class in the month. PARTIAL and UNKNOWN
    /// are not "available": a coach is only considered for duties fully covered.
    static func review(_ payload: StaffAvailabilityPayload, monthKey: String, classes: [StaffRosterMonthClass]) -> Review {
        let errors = validate(payload, monthKey: monthKey)
        let windows = errors.isEmpty ? expand(payload, monthKey: monthKey) : []
        let rows = classes.map { session -> ReviewRow in
            let duty = session.dutyInterval
            let status = errors.isEmpty
                ? intervalStatus(windows, start: duty.start.timeIntervalSince1970, end: duty.end.timeIntervalSince1970)
                : "UNKNOWN"
            return ReviewRow(session: session, status: status)
        }
        return Review(errors: errors, rows: rows)
    }

    // MARK: Class-time shortcuts

    /// One shortcut per preset and weekday that has classes this month,
    /// spanning the real duty (prep and wrap included) of those classes.
    static func shortcuts(classes: [StaffRosterMonthClass], presets: [Int]) -> [Shortcut] {
        var result: [Shortcut] = []
        for preset in presets {
            for weekday in 0..<7 {
                let matches = classes.filter { session in
                    StaffRosterTime.minuteOfDay(session.start) == preset
                        && StaffRosterTime.weekday(StaffRosterTime.dateKey(for: session.start)) == weekday
                }
                guard !matches.isEmpty else { continue }
                var start = Int.max
                var end = Int.min
                for session in matches {
                    let dayKey = StaffRosterTime.dateKey(for: session.start)
                    guard let midnight = StaffRosterTime.startOfDay(dayKey) else { continue }
                    let duty = session.dutyInterval
                    start = min(start, Int((duty.start.timeIntervalSince(midnight) / 60).rounded()))
                    end = max(end, Int((duty.end.timeIntervalSince(midnight) / 60).rounded()))
                }
                guard start < end else { continue }
                result.append(Shortcut(
                    weekday: weekday,
                    presetMinute: preset,
                    start: max(0, start),
                    end: min(1_440, end),
                    sessions: matches.count
                ))
            }
        }
        return result
    }

    static func shortcutStatus(_ payload: StaffAvailabilityPayload, shortcut: Shortcut) -> String? {
        payload.weekly.first {
            $0.weekday == shortcut.weekday && $0.start == shortcut.start && $0.end == shortcut.end
        }?.status
    }

    static func setShortcut(_ payload: StaffAvailabilityPayload, shortcut: Shortcut, status: String?) -> StaffAvailabilityPayload {
        var next = payload
        next.weekly.removeAll {
            $0.weekday == shortcut.weekday && $0.start == shortcut.start && $0.end == shortcut.end
        }
        if let status {
            next.weekly.append(StaffWeeklyWindow(weekday: shortcut.weekday, start: shortcut.start, end: shortcut.end, status: status))
        }
        next.noAvailability = false
        return next
    }

    /// A date exception covering one class's whole duty on its gym date.
    static func sessionException(_ session: StaffRosterMonthClass, status: String) -> StaffDateWindow? {
        let dayKey = StaffRosterTime.dateKey(for: session.start)
        guard let midnight = StaffRosterTime.startOfDay(dayKey) else { return nil }
        let duty = session.dutyInterval
        let start = max(0, Int((duty.start.timeIntervalSince(midnight) / 60).rounded(.down)))
        let end = min(1_440, Int((duty.end.timeIntervalSince(midnight) / 60).rounded(.up)))
        guard end > start else { return nil }
        return StaffDateWindow(date: dayKey, start: start, end: end, status: status)
    }
}
