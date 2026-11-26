import Foundation
import LimaAgentSupervisor
import LimaProtocol
import LimaStorage

/// When a scheduled task runs: once at a moment, or on repeat at a local
/// time of day. Times are wall-clock in `timeZone` (the user's zone when it
/// was scheduled), so "every day at 8:00 AM" stays 8:00 across DST changes.
public struct TaskSchedule: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case once, daily, weekly, monthly }

    public var kind: Kind
    /// `once`: the moment, in milliseconds since 1970.
    public var at: Double?
    /// Repeating: "HH:mm", 24-hour.
    public var time: String?
    /// `weekly`: Calendar weekdays, 1 = Sunday … 7 = Saturday.
    public var days: [Int]?
    /// `monthly`: day of the month; a short month uses its last day.
    public var day: Int?
    public var timeZone: String

    var zone: TimeZone { TimeZone(identifier: timeZone) ?? .current }

    var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    var hourMinute: (Int, Int)? {
        guard let parts = time?.split(separator: ":").compactMap({ Int($0) }), parts.count == 2 else { return nil }
        return (parts[0], parts[1])
    }

    /// The first run strictly after `date`, or nil for a one-time task
    /// whose moment has passed.
    public func next(after date: Date) -> Date? {
        if kind == .once {
            guard let at else { return nil }
            let moment = Date(timeIntervalSince1970: at / 1000)
            return moment > date ? moment : nil
        }
        guard let (hour, minute) = hourMinute else { return nil }
        let calendar = calendar
        let start = calendar.startOfDay(for: date)
        for offset in 0...400 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: start),
                  matches(day, calendar: calendar),
                  let candidate = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day),
                  candidate > date else { continue }
            return candidate
        }
        return nil
    }

    private func matches(_ day: Date, calendar: Calendar) -> Bool {
        switch kind {
        case .once, .daily: return true
        case .weekly: return (days ?? []).contains(calendar.component(.weekday, from: day))
        case .monthly:
            guard let wanted = self.day else { return false }
            let length = calendar.range(of: .day, in: .month, for: day)?.count ?? 31
            return calendar.component(.day, from: day) == min(wanted, length)
        }
    }

    // MARK: Describing

    static func clock(_ hour: Int, _ minute: Int) -> String {
        let suffix = hour < 12 ? "AM" : "PM"
        let twelve = hour % 12 == 0 ? 12 : hour % 12
        return "\(twelve):\(String(format: "%02d", minute)) \(suffix)"
    }

    static let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    static func ordinal(_ n: Int) -> String {
        let suffix = (11...13).contains(n % 100) ? "th" : [1: "st", 2: "nd", 3: "rd"][n % 10] ?? "th"
        return "\(n)\(suffix)"
    }

    func dateLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "EEE, MMM d, yyyy"
        let components = calendar.dateComponents([.hour, .minute], from: date)
        return "\(formatter.string(from: date)) at \(Self.clock(components.hour ?? 0, components.minute ?? 0))"
    }

    /// "Every day at 8:00 AM", "Once on Fri, Jan 22, 2027 at 9:00 AM".
    public var summary: String {
        if kind == .once {
            guard let at else { return "Once" }
            return "Once on \(dateLabel(Date(timeIntervalSince1970: at / 1000)))"
        }
        let clock = hourMinute.map { Self.clock($0.0, $0.1) } ?? "?"
        switch kind {
        case .daily: return "Every day at \(clock)"
        case .weekly:
            let set = Set(days ?? [])
            if set == [2, 3, 4, 5, 6] { return "Weekdays at \(clock)" }
            if set == [1, 7] { return "Weekends at \(clock)" }
            let names = (days ?? []).sorted().map { Self.weekdayNames[($0 - 1) % 7] }
            return "Every \(names.joined(separator: ", ")) at \(clock)"
        case .monthly: return "Monthly on the \(Self.ordinal(day ?? 1)) at \(clock)"
        case .once: return "Once"
        }
    }

    // MARK: Parsing

    /// The `when` object for agent tools.
    static let schema: JSONValue = .object([
        "type": .string("object"), "required": .array([.string("kind")]),
        "description": .string("once: {kind, at: \"2027-01-22T09:00\"}. Repeating: {kind: daily|weekdays|weekends, time: \"08:00\"}, {kind: weekly, days: [\"mon\",\"thu\"], time}, {kind: monthly, day: 15, time}."),
        "properties": .object([
            "kind": .object(["enum": .array(["once", "daily", "weekdays", "weekends", "weekly", "monthly"].map(JSONValue.string))]),
            "at": .object(["type": .string("string"), "description": .string("Local date-time for once, YYYY-MM-DDTHH:mm")]),
            "time": .object(["type": .string("string"), "description": .string("Local time of day, HH:mm (24-hour)")]),
            "days": .object(["type": .string("array"), "items": .object(["type": .string("string")])]),
            "day": .object(["type": .string("integer"), "minimum": .number(1), "maximum": .number(31)]),
        ]),
    ])

    /// Reads `{kind, at, time, days, day}`. `kind` is once, daily, weekdays,
    /// weekends, weekly or monthly; `at` is an ISO 8601 date-time (local
    /// unless it carries a zone) or milliseconds; `time` is "8:00", "08:00",
    /// "8:00 AM" or "8am"; `days` are names ("mon") or 1–7 from Sunday.
    public static func parse(_ value: JSONValue?, now: Date = Date(), timeZone: TimeZone = .current) throws -> TaskSchedule {
        guard let value, value.objectValue != nil else {
            throw BridgeError(.badRequest, "Say when to run it: {kind: once, at} or {kind: daily, time}.")
        }
        let zone = (value["timeZone"]?.stringValue).flatMap(TimeZone.init(identifier:)) ?? timeZone
        let raw = (value["kind"]?.stringValue ?? "").lowercased()
        var schedule = TaskSchedule(kind: .daily, timeZone: zone.identifier)
        switch raw {
        case "once", "one-time", "onetime":
            schedule.kind = .once
            guard let moment = moment(value["at"], zone: zone) else {
                throw BridgeError(.badRequest, "A one-time task needs `at`, a date and time such as 2027-01-22T09:00.")
            }
            guard moment > now.addingTimeInterval(-60) else {
                throw BridgeError(.badRequest, "That time has already passed. Pick a time in the future.")
            }
            schedule.at = (max(moment, now).timeIntervalSince1970 * 1000).rounded()
            return schedule
        case "daily", "everyday", "every day":
            schedule.kind = .daily
        case "weekdays":
            schedule.kind = .weekly
            schedule.days = [2, 3, 4, 5, 6]
        case "weekends":
            schedule.kind = .weekly
            schedule.days = [1, 7]
        case "weekly":
            schedule.kind = .weekly
            let days = (value["days"]?.arrayValue ?? value["day"].map { [$0] } ?? []).compactMap(weekday)
            guard !days.isEmpty else { throw BridgeError(.badRequest, "A weekly task needs `days`, such as [\"mon\", \"thu\"].") }
            schedule.days = Array(Set(days)).sorted()
        case "monthly":
            schedule.kind = .monthly
            guard let day = value["day"]?.intValue, (1...31).contains(day) else {
                throw BridgeError(.badRequest, "A monthly task needs `day`, 1–31.")
            }
            schedule.day = day
        default:
            throw BridgeError(.badRequest, "Unknown schedule kind “\(raw)”. Use once, daily, weekdays, weekends, weekly or monthly.")
        }
        guard let (hour, minute) = clockTime(value["time"]?.stringValue ?? "") else {
            throw BridgeError(.badRequest, "A repeating task needs `time`, such as 08:00 or 8:00 AM.")
        }
        schedule.time = String(format: "%02d:%02d", hour, minute)
        return schedule
    }

    static func clockTime(_ text: String) -> (Int, Int)? {
        let lower = text.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: ".", with: "")
        let pm = lower.hasSuffix("pm"), am = lower.hasSuffix("am")
        let digits = pm || am ? String(lower.dropLast(2)) : lower
        let parts = digits.split(separator: ":", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), var hour = Int(parts[0]) else { return nil }
        let minute = parts.count == 2 ? Int(parts[1]) : 0
        guard let minute, (0...59).contains(minute) else { return nil }
        if pm || am {
            guard (1...12).contains(hour) else { return nil }
            hour = hour % 12 + (pm ? 12 : 0)
        }
        guard (0...23).contains(hour) else { return nil }
        return (hour, minute)
    }

    static func weekday(_ value: JSONValue) -> Int? {
        if let n = value.intValue, (1...7).contains(n) { return n }
        guard let name = value.stringValue?.lowercased().prefix(3) else { return nil }
        return weekdayNames.firstIndex { $0.lowercased() == name }.map { $0 + 1 }
    }

    static func moment(_ value: JSONValue?, zone: TimeZone) -> Date? {
        if let ms = value?.doubleValue { return Date(timeIntervalSince1970: ms / 1000) }
        guard let text = value?.stringValue?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        let zoned = ISO8601DateFormatter()
        for options: ISO8601DateFormatter.Options in [[.withInternetDateTime], [.withInternetDateTime, .withFractionalSeconds]] {
            zoned.formatOptions = options
            if let date = zoned.date(from: text) { return date }
        }
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = zone
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
            local.dateFormat = format
            if let date = local.date(from: text) {
                // A bare date means the start of the working day.
                return format == "yyyy-MM-dd" ? date.addingTimeInterval(9 * 3600) : date
            }
        }
        return nil
    }
}

/// Work Lima starts on its own later: the instruction goes to a workspace's
/// agent (the same handoff the Companion makes) each time the schedule comes
/// due, and every run is an Orchestrator task with its own progress.
public struct ScheduledTask: Codable, Sendable, Equatable {
    public struct Run: Codable, Sendable, Equatable {
        public var at: Double
        /// When it was due; later than this means Lima wasn't running.
        public var due: Double
        public var manual: Bool = false
        public var taskID: String? = nil
        public var workspaceID: String? = nil
        public var error: String? = nil
    }

    public var id: String
    public var title: String
    public var instruction: String
    public var schedule: TaskSchedule
    /// The workspace each run goes to. Unset (or deleted), the first run
    /// creates one named `workspaceName` and later runs reuse it.
    public var workspaceID: String?
    public var workspaceName: String?
    public var provider: String?
    public var model: String?
    public var mascot: String?
    public var paused: Bool = false
    public var createdAt: Double
    public var updatedAt: Double
    public var nextRunAt: Double?
    /// "You" or the agent that asked for it.
    public var createdBy: String
    public var runs: [Run] = []

    public var state: String { paused ? "paused" : nextRunAt == nil ? "done" : "scheduled" }

    public var publicView: JSONValue {
        guard case .object(var object) = (try? JSONValue.from(self)) ?? .null else { return .null }
        object["summary"] = .string(schedule.summary)
        object["state"] = .string(state)
        object["repeats"] = .bool(schedule.kind != .once)
        if let nextRunAt { object["nextRunLabel"] = .string(schedule.dateLabel(Date(timeIntervalSince1970: nextRunAt / 1000))) }
        return .object(object)
    }
}

public actor ScheduleService {
    public static let collection = "schedules"
    static let runHistory = 20

    private let store: EncryptedStore
    private var tasks: [String: ScheduledTask]
    private let emit: @Sendable (ScheduledTask?, String) -> Void

    public init(store: EncryptedStore, emit: @escaping @Sendable (ScheduledTask?, String) -> Void = { _, _ in }) async throws {
        self.store = store
        self.emit = emit
        let saved = try await store.all(ScheduledTask.self, collection: Self.collection)
        tasks = Dictionary(saved.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    static func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    /// Upcoming first, then paused, then finished one-time tasks.
    public func list(workspaceID: String? = nil) -> [ScheduledTask] {
        tasks.values.filter { workspaceID == nil || $0.workspaceID == workspaceID }.sorted { a, b in
            let rank = { (task: ScheduledTask) in ["scheduled": 0, "paused": 1, "done": 2][task.state] ?? 3 }
            if rank(a) != rank(b) { return rank(a) < rank(b) }
            if let x = a.nextRunAt, let y = b.nextRunAt, x != y { return x < y }
            return a.createdAt > b.createdAt
        }
    }

    public func get(_ id: String) throws -> ScheduledTask {
        guard let task = tasks[id] else { throw BridgeError(.badRequest, "That scheduled task no longer exists.") }
        return task
    }

    public func create(title: String, instruction: String, schedule: TaskSchedule, workspaceID: String?, workspaceName: String?,
                       provider: String?, model: String?, mascot: String?, createdBy: String, now: Date = Date()) async throws -> ScheduledTask {
        let instruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { throw BridgeError(.badRequest, "Say what the scheduled task should do.") }
        guard let next = schedule.next(after: now) else { throw BridgeError(.badRequest, "That schedule never comes due. Pick a future time.") }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let stamp = (now.timeIntervalSince1970 * 1000).rounded()
        let task = ScheduledTask(id: UUID().uuidString, title: String((cleanTitle.isEmpty ? Runtime.taskTitle(instruction) : cleanTitle).prefix(80)),
                                 instruction: String(instruction.prefix(8000)), schedule: schedule, workspaceID: workspaceID,
                                 workspaceName: workspaceName.map { String($0.prefix(60)) }, provider: provider, model: model, mascot: mascot,
                                 createdAt: stamp, updatedAt: stamp, nextRunAt: (next.timeIntervalSince1970 * 1000).rounded(),
                                 createdBy: createdBy)
        try await save(task)
        return task
    }

    public func update(_ id: String, title: String? = nil, instruction: String? = nil, schedule: TaskSchedule? = nil,
                       paused: Bool? = nil, now: Date = Date()) async throws -> ScheduledTask {
        var task = try get(id)
        if let title, !title.trimmingCharacters(in: .whitespaces).isEmpty { task.title = String(title.prefix(80)) }
        if let instruction {
            let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { throw BridgeError(.badRequest, "Say what the scheduled task should do.") }
            task.instruction = String(trimmed.prefix(8000))
        }
        if let schedule {
            guard let next = schedule.next(after: now) else { throw BridgeError(.badRequest, "That schedule never comes due. Pick a future time.") }
            task.schedule = schedule
            task.nextRunAt = (next.timeIntervalSince1970 * 1000).rounded()
        }
        if let paused {
            task.paused = paused
            // Resuming skips the runs missed while paused.
            if !paused, task.schedule.kind != .once || task.nextRunAt != nil {
                task.nextRunAt = task.schedule.next(after: now).map { ($0.timeIntervalSince1970 * 1000).rounded() }
            }
        }
        task.updatedAt = Self.now()
        try await save(task)
        return task
    }

    public func delete(_ id: String) async throws {
        guard let task = tasks.removeValue(forKey: id) else { return }
        try await store.delete(collection: Self.collection, id: id)
        emit(nil, task.id)
    }

    public func due(now: Date = Date()) -> [ScheduledTask] {
        let stamp = now.timeIntervalSince1970 * 1000
        return tasks.values.filter { !$0.paused && ($0.nextRunAt ?? .infinity) <= stamp }.sorted { ($0.nextRunAt ?? 0) < ($1.nextRunAt ?? 0) }
    }

    /// Records the run before it starts and advances the schedule, so a
    /// crash mid-handoff never runs the same occurrence twice. Missed
    /// occurrences collapse into this one run.
    public func claim(_ id: String, now: Date = Date(), manual: Bool = false) async throws -> (ScheduledTask, ScheduledTask.Run)? {
        var task = try get(id)
        let stamp = (now.timeIntervalSince1970 * 1000).rounded()
        if !manual {
            guard !task.paused, let due = task.nextRunAt, due <= stamp else { return nil }
        }
        let run = ScheduledTask.Run(at: stamp, due: manual ? stamp : task.nextRunAt ?? stamp, manual: manual)
        task.runs.append(run)
        task.runs = Array(task.runs.suffix(Self.runHistory))
        // Running early leaves the schedule as it was.
        if !manual { task.nextRunAt = task.schedule.next(after: now).map { ($0.timeIntervalSince1970 * 1000).rounded() } }
        task.updatedAt = stamp
        try await save(task)
        return (task, run)
    }

    public func finish(_ id: String, runAt: Double, taskID: String?, workspaceID: String?, error: String?) async {
        guard var task = tasks[id], let index = task.runs.lastIndex(where: { $0.at == runAt }) else { return }
        task.runs[index].taskID = taskID
        task.runs[index].workspaceID = workspaceID
        task.runs[index].error = error
        if let workspaceID, error == nil { task.workspaceID = workspaceID }
        task.updatedAt = Self.now()
        try? await save(task)
    }

    private func save(_ task: ScheduledTask) async throws {
        try await store.put(task, collection: Self.collection, id: task.id)
        tasks[task.id] = task
        emit(task, task.id)
    }
}

// MARK: Bridge and timer

extension Runtime {
    /// Checks for due tasks every 20 seconds and right after the Mac wakes.
    /// Lima has to be running for a task to start; one that came due while
    /// it wasn't runs once, as soon as it is, marked late.
    func startScheduler() {
        Task { [weak self] in
            while !Task.isCancelled {
                guard let runtime = self else { return }
                await runtime.runDueSchedules()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    func runDueSchedules(now: Date = Date()) async {
        for task in await schedules.due(now: now) { _ = try? await runSchedule(task.id, now: now) }
    }

    /// Hands one occurrence to its workspace as an Orchestrator task.
    @discardableResult
    func runSchedule(_ id: String, now: Date = Date(), manual: Bool = false) async throws -> ScheduledTask.Run? {
        guard let (task, run) = try await schedules.claim(id, now: now, manual: manual) else { return nil }
        var params: [String: JSONValue] = [:]
        if let provider = task.provider { params["provider"] = .string(provider) }
        if let model = task.model { params["model"] = .string(model) }
        if let mascot = task.mascot { params["mascot"] = .string(mascot) }
        if let id = task.workspaceID, let workspace = try? await workspaces.get(id), workspace.parentID == nil {
            params["id"] = .string(id)
        } else {
            params["name"] = .string(task.workspaceName ?? task.title)
        }
        let late = !manual && run.at - run.due > 5 * 60_000
        let timing = manual ? "The user asked to run it now, ahead of schedule."
            : late ? "It was due \(task.schedule.dateLabel(Date(timeIntervalSince1970: run.due / 1000))), but Lima wasn't running then, so it is starting late. Say so in your report."
            : "It is due now."
        let request = """
        Scheduled task “\(task.title)” (\(task.schedule.summary)). \(timing)

        \(task.instruction)

        Carry it out now and report what you did. Ask the user only for a step that needs them.
        """
        do {
            let workspace = try await handoffWorkspace(.object(params), text: request)
            let record = try await Self.bridged {
                try await self.orchestrator.submit(requestID: "schedule:\(task.id):\(Int(run.at))", title: task.title, request: request,
                                                   workspaceID: workspace.id, context: ["Scheduled · \(task.schedule.summary)"])
            }
            await schedules.finish(id, runAt: run.at, taskID: record.id, workspaceID: workspace.id, error: nil)
            var finished = run
            finished.taskID = record.id
            finished.workspaceID = workspace.id
            return finished
        } catch {
            let message = (error as? BridgeError)?.message ?? String(describing: error)
            await schedules.finish(id, runAt: run.at, taskID: nil, workspaceID: nil, error: message)
            throw error
        }
    }

    /// The workspace an agent's schedule belongs to: a helper's goes to its lead.
    private func scheduleOwner(_ context: CallContext) async -> Workspace? {
        guard let id = context.workspaceID, let workspace = try? await workspaces.get(id) else { return nil }
        if let parent = workspace.parentID, let lead = try? await workspaces.get(parent) { return lead }
        return workspace
    }

    /// Pausing, editing, deleting and running early are the user's; an
    /// agent asking for one gets an approval card.
    private func confirmScheduleChange(_ context: CallContext, _ id: String, _ verb: String) async throws {
        guard context.origin != .browser else { return }
        let task = try await schedules.get(id)
        try await approveAction(context, question: "\(verb) the scheduled task “\(task.title)”?",
                                facts: [.init(label: "When", value: task.schedule.summary)], risk: "schedule")
    }

    func registerSchedules() {
        register("schedule.list") { [unowned self] params, context in
            if context.origin == .browser {
                return .array(await self.schedules.list(workspaceID: params.optionalString("workspaceId")).map(\.publicView))
            }
            // An agent sees its own workspace's schedules; anything else asks.
            if let owner = await self.scheduleOwner(context) {
                return .array(await self.schedules.list(workspaceID: owner.id).map(\.publicView))
            }
            try await self.approveAction(context, question: "Let \(Self.callerName(context.origin)) see your scheduled tasks?",
                                         facts: [.init(label: "Shows", value: "Titles, instructions and times")], risk: "access")
            return .array(await self.schedules.list().map(\.publicView))
        }

        register("schedule.create") { [unowned self] params, context in
            let instruction = try params.string("instruction")
            let schedule = try TaskSchedule.parse(params?["when"])
            let title = params.optionalString("title") ?? ""
            var workspaceID = params.optionalString("workspaceId").flatMap { $0.isEmpty ? nil : $0 }
            var createdBy = "You"
            if context.origin != .browser {
                let owner = await self.scheduleOwner(context)
                if let owner { workspaceID = owner.id; createdBy = owner.name } else { createdBy = Self.callerName(context.origin) }
                var place = owner?.name ?? "a new workspace"
                if owner == nil, let workspaceID { place = (try? await self.workspaces.get(workspaceID))?.name ?? "a workspace" }
                try await self.approveAction(context, question: "Schedule “\(title.isEmpty ? Self.taskTitle(instruction) : title)”?",
                    facts: [.init(label: "When", value: schedule.summary), .init(label: "Runs in", value: place),
                            .init(label: "Each time", value: String(instruction.prefix(240)))],
                    detail: "Lima will start this on its own at those times. You can pause or delete it in Scheduled Tasks.",
                    risk: "schedule")
            } else if let workspaceID {
                let workspace = try await self.workspaces.get(workspaceID)
                guard workspace.parentID == nil else { throw BridgeError(.badRequest, "Schedule work in a top-level workspace.") }
            }
            let task = try await self.schedules.create(title: title, instruction: instruction, schedule: schedule, workspaceID: workspaceID,
                workspaceName: params.optionalString("workspaceName"), provider: params.optionalString("provider"),
                model: params.optionalString("model"), mascot: params.optionalString("mascot"), createdBy: createdBy)
            return task.publicView
        }

        register("schedule.update") { [unowned self] params, context in
            let id = try params.string("id")
            let schedule = try params?["when"].map { try TaskSchedule.parse($0) }
            try await self.confirmScheduleChange(context, id, params?["paused"]?.boolValue == true ? "Pause" : "Change")
            return try await self.schedules.update(id, title: params.optionalString("title"), instruction: params.optionalString("instruction"),
                                                   schedule: schedule, paused: params?["paused"]?.boolValue).publicView
        }
        register("schedule.delete") { [unowned self] params, context in
            let id = try params.string("id")
            try await self.confirmScheduleChange(context, id, "Delete")
            try await self.schedules.delete(id)
            return .null
        }
        register("schedule.run") { [unowned self] params, context in
            let id = try params.string("id")
            try await self.confirmScheduleChange(context, id, "Run")
            let run = try await self.runSchedule(id, manual: true)
            return .object(["schedule": try await self.schedules.get(id).publicView, "run": (try? JSONValue.from(run)) ?? .null])
        }
    }
}
