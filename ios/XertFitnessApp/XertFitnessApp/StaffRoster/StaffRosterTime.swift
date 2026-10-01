import Foundation

/// Gym-local (Australia/Brisbane, no daylight saving) dates, months and
/// labels for the coach roster. Every roster date, month boundary and time
/// label uses this clock, never the phone's.
enum StaffRosterTime {
    static let timeZone = TimeZone(identifier: "Australia/Brisbane") ?? TimeZone(secondsFromGMT: 10 * 3_600)!

    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = Locale(identifier: "en_AU")
        return calendar
    }()

    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_AU")
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        return formatter
    }

    private static let dateKeyFormatter = formatter("yyyy-MM-dd")
    private static let timeFormatter: DateFormatter = {
        let value = formatter("h:mm a")
        value.amSymbol = "am"
        value.pmSymbol = "pm"
        return value
    }()
    private static let dayFormatter = formatter("EEE d MMM")
    private static let longDayFormatter = formatter("EEEE d MMMM")
    private static let monthFormatter = formatter("MMMM yyyy")

    // MARK: Keys

    /// `2026-11-02` — the gym date of an instant.
    static func dateKey(for date: Date) -> String {
        dateKeyFormatter.string(from: date)
    }

    /// `2026-11` — the roster month of an instant.
    static func monthKey(for date: Date) -> String {
        String(dateKey(for: date).prefix(7))
    }

    static func todayKey(now: Date = Date()) -> String {
        dateKey(for: now)
    }

    /// `2026-11` → `2026-11-01`, the `p_month` the database expects.
    static func monthParameter(_ monthKey: String) -> String {
        "\(monthKey)-01"
    }

    /// Midnight at the gym on a date key.
    static func startOfDay(_ dateKey: String) -> Date? {
        let parts = dateKey.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.calendar = calendar
        components.timeZone = timeZone
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        guard let date = calendar.date(from: components),
              dateKeyFormatter.string(from: date) == dateKey else { return nil }
        return date
    }

    /// A gym wall-clock minute on a date (0…1440) as an instant.
    static func instant(_ dateKey: String, minute: Int) -> Date? {
        startOfDay(dateKey).map { $0.addingTimeInterval(TimeInterval(minute * 60)) }
    }

    /// Minutes after gym midnight for an instant.
    static func minuteOfDay(_ date: Date) -> Int {
        let components = calendar.dateComponents([.hour, .minute], from: date)
        return (components.hour ?? 0) * 60 + (components.minute ?? 0)
    }

    static func addingDays(_ days: Int, to dateKey: String) -> String? {
        guard let start = startOfDay(dateKey),
              let shifted = calendar.date(byAdding: .day, value: days, to: start) else { return nil }
        return self.dateKey(for: shifted)
    }

    /// The half-open gym interval [first of month, first of next month).
    static func monthInterval(_ monthKey: String) -> DateInterval? {
        guard XertCoachingLink.isValidMonth(monthKey),
              let start = startOfDay("\(monthKey)-01"),
              let end = calendar.date(byAdding: .month, value: 1, to: start) else { return nil }
        return DateInterval(start: start, end: end)
    }

    static func dates(inMonth monthKey: String) -> [String] {
        guard let interval = monthInterval(monthKey) else { return [] }
        var dates: [String] = []
        var cursor = interval.start
        while cursor < interval.end {
            dates.append(dateKey(for: cursor))
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        return dates
    }

    static func shiftMonth(_ monthKey: String, by months: Int) -> String? {
        guard let interval = monthInterval(monthKey),
              let shifted = calendar.date(byAdding: .month, value: months, to: interval.start) else { return nil }
        return self.monthKey(for: shifted)
    }

    /// 0 = Sunday … 6 = Saturday, matching the database's `extract(dow …)`.
    static func weekday(_ dateKey: String) -> Int? {
        startOfDay(dateKey).map { calendar.component(.weekday, from: $0) - 1 }
    }

    // MARK: Labels

    static let weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    static func timeLabel(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    /// `5:15 am` for a minute of the gym day.
    static func minuteLabel(_ minute: Int) -> String {
        let normalized = ((minute % 1_440) + 1_440) % 1_440
        let hours = normalized / 60
        let display = hours % 12 == 0 ? 12 : hours % 12
        return "\(display):\(String(format: "%02d", normalized % 60)) \(hours < 12 ? "am" : "pm")"
    }

    /// `05:15`; 1440 shows as `24:00`.
    static func clockLabel(_ minute: Int) -> String {
        let value = max(0, min(1_440, minute))
        return String(format: "%02d:%02d", value / 60, value % 60)
    }

    static func dayLabel(_ dateKey: String) -> String {
        startOfDay(dateKey).map { dayFormatter.string(from: $0) } ?? dateKey
    }

    static func longDayLabel(_ dateKey: String) -> String {
        startOfDay(dateKey).map { longDayFormatter.string(from: $0) } ?? dateKey
    }

    static func dayLabel(for date: Date) -> String {
        dayFormatter.string(from: date)
    }

    /// `Mon 2 Nov, 5:15 am`.
    static func whenLabel(_ date: Date) -> String {
        "\(dayFormatter.string(from: date)), \(timeLabel(date))"
    }

    /// `November 2026` for `2026-11` or `2026-11-01`.
    static func monthLabel(_ monthKey: String) -> String {
        let key = String(monthKey.prefix(7))
        return startOfDay("\(key)-01").map { monthFormatter.string(from: $0) } ?? key
    }

    // MARK: Grouping

    /// Assignments grouped by gym date in start order, so a 5:15 am class
    /// stays on its Brisbane date wherever the phone is.
    static func groupedByDate(_ assignments: [StaffRosterAssignment]) -> [StaffRosterDayGroup] {
        let sorted = assignments.sorted { lhs, rhs in
            if lhs.start != rhs.start { return lhs.start < rhs.start }
            return lhs.assignment_id.uuidString < rhs.assignment_id.uuidString
        }
        var groups: [StaffRosterDayGroup] = []
        for assignment in sorted {
            let key = dateKey(for: assignment.start)
            if let last = groups.indices.last, groups[last].date == key {
                groups[last].items.append(assignment)
            } else {
                groups.append(StaffRosterDayGroup(date: key, items: [assignment]))
            }
        }
        return groups
    }

    /// The roster window the web coach screen loads: today plus 62 days
    /// (the database accepts at most 100).
    static func rosterWindow(now: Date = Date()) -> (from: String, to: String) {
        let today = todayKey(now: now)
        return (today, addingDays(62, to: today) ?? today)
    }
}

/// One gym date of the coach's roster.
struct StaffRosterDayGroup: Identifiable, Equatable {
    let date: String
    var items: [StaffRosterAssignment]

    var id: String { date }
}
