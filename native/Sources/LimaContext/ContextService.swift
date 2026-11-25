import Foundation
import LimaStorage

/// Structured activity metadata (spec v2 §8). Never raw typing, field
/// contents, audio, or screen images.
public struct ActivityEvent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case app, browser, terminal, git, agent, note, media, meeting, task, report
    }

    public var id: String
    public var kind: Kind
    public var title: String
    public var detail: String
    public var app: String?
    public var project: String?
    public var timestamp: Double
    public var durationMs: Double?
    public var metadata: [String: String]

    public init(kind: Kind, title: String, detail: String = "", app: String? = nil, project: String? = nil,
                timestamp: Double = (Date().timeIntervalSince1970 * 1000).rounded(), durationMs: Double? = nil, metadata: [String: String] = [:]) {
        self.id = UUID().uuidString
        self.kind = kind
        self.title = title
        self.detail = detail
        self.app = app
        self.project = project
        self.timestamp = timestamp
        self.durationMs = durationMs
        self.metadata = metadata
    }
}

public struct ContextSettings: Codable, Equatable, Sendable {
    public var collectActivity: Bool = true
    public var generateReports: Bool = true
    public var retentionDays: Int = 90
    public var excludedApps: [String] = ["com.apple.keychainaccess", "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop"]
    public var excludedProjects: [String] = []
    public init() {}
}

public struct WeeklyReport: Codable, Equatable, Sendable {
    public var id: String          // ISO week start date, e.g. "2026-11-09" — the dedupe key
    public var weekStart: Double
    public var weekEnd: Double
    public var generatedAt: Double
    public var markdown: String
    public var stats: [String: Double]
}

/// Ingests events, enforces exclusions/retention, and produces reports.
public actor ContextService {
    public static let eventsCollection = "context.events"
    public static let reportsCollection = "context.reports"
    public static let settingsID = "context.settings"

    private let store: EncryptedStore
    private var events: [ActivityEvent] = []
    private(set) public var settings: ContextSettings
    private var observers: [@Sendable (ActivityEvent) -> Void] = []
    private var lastAppEvent: (bundleID: String, index: Int)?

    public init(store: EncryptedStore) async throws {
        self.store = store
        self.settings = try await store.get(ContextSettings.self, collection: "settings", id: Self.settingsID) ?? ContextSettings()
        self.events = try await store.all(ActivityEvent.self, collection: Self.eventsCollection).sorted { $0.timestamp < $1.timestamp }
    }

    public func onEvent(_ observer: @escaping @Sendable (ActivityEvent) -> Void) { observers.append(observer) }

    public func updateSettings(_ new: ContextSettings) async throws {
        settings = new
        try await store.put(new, collection: "settings", id: Self.settingsID)
        try await applyRetention()
    }

    /// Records an event unless collection is off or the source is excluded.
    @discardableResult
    public func record(_ event: ActivityEvent) async throws -> Bool {
        guard settings.collectActivity else { return false }
        if let bundle = event.metadata["bundleID"], settings.excludedApps.contains(bundle) { return false }
        if let project = event.project, settings.excludedProjects.contains(where: { project.hasPrefix($0) }) { return false }

        // Close the previous app span so app time can be summarized.
        if event.kind == .app, let last = lastAppEvent, last.index < events.count {
            events[last.index].durationMs = event.timestamp - events[last.index].timestamp
            try await store.put(events[last.index], collection: Self.eventsCollection, id: events[last.index].id)
        }
        events.append(event)
        if event.kind == .app { lastAppEvent = (event.metadata["bundleID"] ?? event.title, events.count - 1) }
        try await store.put(event, collection: Self.eventsCollection, id: event.id)
        for observer in observers { observer(event) }
        return true
    }

    public func recent(limit: Int = 200, kinds: Set<ActivityEvent.Kind>? = nil) -> [ActivityEvent] {
        Array(events.reversed().filter { kinds?.contains($0.kind) ?? true }.prefix(max(0, limit)))
    }

    public func between(_ start: Double, _ end: Double) -> [ActivityEvent] {
        events.filter { $0.timestamp >= start && $0.timestamp < end }
    }

    public func allEvents() -> [ActivityEvent] { events }

    public func deleteEvents(before cutoff: Double) async throws -> Int {
        let doomed = events.filter { $0.timestamp < cutoff }
        for event in doomed { try await store.delete(collection: Self.eventsCollection, id: event.id) }
        events.removeAll { $0.timestamp < cutoff }
        lastAppEvent = nil
        return doomed.count
    }

    public func deleteAllActivity() async throws -> Int {
        try await deleteEvents(before: .greatestFiniteMagnitude)
    }

    private func applyRetention() async throws {
        let cutoff = (Date().timeIntervalSince1970 - Double(settings.retentionDays) * 86_400) * 1000
        _ = try await deleteEvents(before: cutoff)
    }

    // MARK: Reports

    public func reports() async throws -> [WeeklyReport] {
        try await store.all(WeeklyReport.self, collection: Self.reportsCollection).sorted { $0.weekStart > $1.weekStart }
    }

    /// Generates the report for the most recent due slot if it does not
    /// exist yet. Safe to call repeatedly (startup, timer, wake): the week
    /// ID is the dedupe key, so missed slots are caught up exactly once.
    public func runScheduledReportIfDue(now: Date = Date(), calendar: Calendar = .current) async throws -> WeeklyReport? {
        guard settings.generateReports, let due = ReportSchedule.mostRecentSlot(before: now, calendar: calendar) else { return nil }
        let week = ReportSchedule.week(containing: due, calendar: calendar)
        let id = ReportSchedule.id(for: week.start, calendar: calendar)
        if try await store.get(WeeklyReport.self, collection: Self.reportsCollection, id: id) != nil { return nil }
        try await applyRetention()
        let report = ReportBuilder.build(id: id, start: week.start, end: due, events: between(week.start.timeIntervalSince1970 * 1000, due.timeIntervalSince1970 * 1000))
        try await store.put(report, collection: Self.reportsCollection, id: id)
        try await record(ActivityEvent(kind: .report, title: "Weekly report generated", detail: id))
        return report
    }

    /// Manual "generate now" for the current week so far (replaces any draft).
    public func generateReportNow(now: Date = Date(), calendar: Calendar = .current) async throws -> WeeklyReport {
        let week = ReportSchedule.week(containing: now, calendar: calendar)
        let id = ReportSchedule.id(for: week.start, calendar: calendar) + "-draft"
        let report = ReportBuilder.build(id: id, start: week.start, end: now, events: between(week.start.timeIntervalSince1970 * 1000, now.timeIntervalSince1970 * 1000))
        try await store.put(report, collection: Self.reportsCollection, id: id)
        return report
    }
}

/// Friday 3:00 PM local schedule (spec v1 decision table).
public enum ReportSchedule {
    public static func mostRecentSlot(before now: Date, calendar: Calendar) -> Date? {
        var components = DateComponents()
        components.weekday = 6 // Friday
        components.hour = 15
        components.minute = 0
        components.second = 0
        return calendar.nextDate(after: now, matching: components, matchingPolicy: .nextTime, direction: .backward)
    }

    /// Monday 00:00 to the following Monday.
    public static func week(containing date: Date, calendar: Calendar) -> (start: Date, end: Date) {
        var cal = calendar
        cal.firstWeekday = 2
        let interval = cal.dateInterval(of: .weekOfYear, for: date)!
        return (interval.start, interval.end)
    }

    public static func id(for start: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: start)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
}

enum ReportBuilder {
    static func build(id: String, start: Date, end: Date, events: [ActivityEvent]) -> WeeklyReport {
        func top(_ pairs: [String: Double], _ n: Int) -> [(String, Double)] {
            pairs.sorted { $0.value > $1.value }.prefix(n).map { ($0.key, $0.value) }
        }
        var appTime: [String: Double] = [:]
        var projects: [String: Double] = [:]
        var commands = 0, failedCommands = 0
        var notesEdited = Set<String>(), agentRuns = 0, agentFailures = 0
        var sites: [String: Double] = [:]
        var tracks: [String: Double] = [:]
        var meetings: [String] = []
        var tasks: [String] = []
        var gitChanges: [String] = []

        for event in events {
            switch event.kind {
            case .app: appTime[event.title, default: 0] += (event.durationMs ?? 0) / 60_000
            case .terminal:
                commands += 1
                if let status = event.metadata["exitStatus"], status != "0" { failedCommands += 1 }
                if let project = event.project { projects[(project as NSString).lastPathComponent, default: 0] += 1 }
            case .note: notesEdited.insert(event.title)
            case .agent:
                agentRuns += 1
                if event.metadata["status"] == "failed" { agentFailures += 1 }
                if let project = event.project { projects[(project as NSString).lastPathComponent, default: 0] += 1 }
            case .browser:
                if let host = event.metadata["host"] { sites[host, default: 0] += 1 }
            case .media: tracks["\(event.title) — \(event.detail)", default: 0] += 1
            case .meeting: meetings.append(event.title)
            case .task: tasks.append(event.title)
            case .git:
                gitChanges.append(event.title)
                if let project = event.project { projects[(project as NSString).lastPathComponent, default: 0] += 1 }
            case .report: break
            }
        }

        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        var md = "# Week of \(formatter.string(from: start))\n\n"
        md += "_\(events.count) activity events from \(formatter.string(from: start)) to \(formatter.string(from: end))._\n\n"
        func section(_ title: String, _ lines: [String], empty: String) {
            md += "## \(title)\n\n" + (lines.isEmpty ? "_\(empty)_\n\n" : lines.map { "- \($0)" }.joined(separator: "\n") + "\n\n")
        }
        section("Projects worked on", top(projects, 8).map { "**\($0.0)** — \(Int($0.1)) actions" }, empty: "No project activity recorded.")
        section("Code changes", gitChanges.suffix(15).reversed().map { $0 }, empty: "No Git changes recorded.")
        section("Terminal", commands == 0 ? [] : ["\(commands) commands run, \(failedCommands) failed"], empty: "No terminal commands recorded.")
        section("Meetings", meetings, empty: "No meetings recorded.")
        section("Notes", notesEdited.sorted().prefix(15).map { $0 }, empty: "No notes edited.")
        section("AI activity", agentRuns == 0 ? [] : ["\(agentRuns) agent turns, \(agentFailures) failed"], empty: "No AI activity.")
        section("Tasks completed", tasks, empty: "No completed tasks recorded.")
        section("Time by application", top(appTime, 8).map { "\($0.0): \(Int($0.1.rounded())) min" }, empty: "No application activity recorded.")
        section("Most visited sites", top(sites, 8).map { "\($0.0) (\(Int($0.1)))" }, empty: "No browsing recorded.")
        section("Listening", top(tracks, 5).map { "\($0.0) ×\(Int($0.1))" }, empty: "No playback recorded.")

        let stats: [String: Double] = [
            "events": Double(events.count), "commands": Double(commands), "notes": Double(notesEdited.count),
            "agentTurns": Double(agentRuns), "appMinutes": appTime.values.reduce(0, +)
        ]
        return WeeklyReport(id: id, weekStart: start.timeIntervalSince1970 * 1000, weekEnd: end.timeIntervalSince1970 * 1000,
                            generatedAt: Date().timeIntervalSince1970 * 1000, markdown: md, stats: stats)
    }
}
