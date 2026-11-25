import Foundation
import LimaProtocol

/// Anonymous usage statistics, on unless the user turns them off.
///
/// Lima says so once (a sidebar notice with Turn Off) and Settings → Privacy
/// turns it off at any time; anyone who said no before stays off. When on, Lima counts which features were used each day (from a fixed list
/// of event names), adds the app version, macOS version, the region of the
/// Mac's language setting and a few settings, and sends one report a day
/// under a random ID that changes every month. Nothing else: no URLs, page or
/// chat text, file names, accounts or identifiers. Settings shows the exact
/// report before it's sent, and "Delete my data" removes everything sent
/// under the current ID. Nothing is counted while it's off.
public actor UsageStats {
    public struct State: Codable, Sendable, Equatable {
        public var enabled = true
        /// The user chose on or off (in the notice or in Settings).
        public var asked = false
        public var installID = UsageStats.newID()
        public var idMonth = UsageStats.month(Date())
        public var day = UsageStats.day(Date())
        public var counts: [String: Int] = [:]
        /// Finished days waiting to be sent (at most a week).
        public var pending: [JSONValue] = []
        public var lastSent: Double? = nil
    }

    public static let events: Set<String> = [
        "app.active", "search.opened", "search.addressBar", "search.quickAsk", "chat.sent", "chat.attachment",
        "companion.request", "workspace.created", "agent.spawned", "schedule.created", "schedule.ran", "note.created",
        "download.finished", "music.spotify", "music.appleMusic", "music.tab", "image.generated", "capability.ran",
        "update.installed", "provider.failover",
    ]

    private var state: State
    private var lastAttempt = Date.distantPast
    /// Settings the browser reports (theme, provider, tab size, page cleanup).
    private var snapshot: [String: JSONValue] = [:]
    static let allowedSettings: [String: Set<String>] = [
        "theme": ["system", "light", "dark"], "provider": ["claude", "codex", "opencode", "none"], "tabSize": ["compact", "default", "large"],
    ]
    static let allowedSwitches: Set<String> = ["hideAI", "hideAds", "hideShorts", "addressBar"]
    private let save: @Sendable (State) async -> Void
    private let endpoint: URL?

    public init(state: State?, endpoint: URL?, save: @escaping @Sendable (State) async -> Void) {
        var state = state ?? State()
        // Before 5.0.8 sharing was opt-in; whoever never answered gets the
        // new default, and whoever said no keeps their answer.
        if !state.asked { state.enabled = true }
        self.state = state
        self.endpoint = endpoint
        self.save = save
    }

    static func newID() -> String { (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }
    static func day(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    static func month(_ date: Date) -> String { String(day(date).prefix(7)) }

    /// Keeps only known settings with known values.
    public func setSnapshot(_ value: JSONValue?) {
        var clean: [String: JSONValue] = [:]
        for (key, item) in value?.objectValue ?? [:] {
            if let allowed = Self.allowedSettings[key], let text = item.stringValue, allowed.contains(text) { clean[key] = .string(text) }
            else if Self.allowedSwitches.contains(key), let flag = item.boolValue { clean[key] = .bool(flag) }
        }
        snapshot = clean
    }

    public var view: JSONValue {
        .object(["enabled": .bool(state.enabled), "asked": .bool(state.asked), "endpoint": endpoint.map { .string($0.host ?? "") } ?? .null,
                 "lastSent": state.lastSent.map(JSONValue.number) ?? .null])
    }

    public func configure(enabled: Bool) async {
        state.asked = true
        if state.enabled != enabled {
            state.enabled = enabled
            // Turning it off drops anything not yet sent.
            if !enabled { state.counts = [:]; state.pending = [] }
        }
        await save(state)
    }

    public func count(_ event: String, by amount: Int = 1) async {
        guard state.enabled, Self.events.contains(event) else { return }
        await roll(Date())
        state.counts[event, default: 0] += amount
        await save(state)
    }

    /// Starts a new day (and a new ID each month), queuing the finished day.
    private func roll(_ now: Date) async {
        let today = Self.day(now)
        guard today != state.day else { return }
        if !state.counts.isEmpty { state.pending = Array((state.pending + [await report(day: state.day, counts: state.counts)]).suffix(7)) }
        state.counts = [:]
        state.day = today
        if Self.month(now) != state.idMonth {
            state.installID = Self.newID()
            state.idMonth = Self.month(now)
            state.pending = [] // never link last month's ID to this one
        }
    }

    func report(day: String, counts: [String: Int]) async -> JSONValue {
        let info = Bundle.main.infoDictionary ?? [:]
        let os = ProcessInfo.processInfo.operatingSystemVersion
        var object: [String: JSONValue] = [
            "v": .number(1), "id": .string(state.installID), "day": .string(day),
            "version": .string((info["CFBundleShortVersionString"] as? String).flatMap { $0.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil ? $0 : nil } ?? limaRuntimeVersion),
            "build": .number(Double(Int(info["CFBundleVersion"] as? String ?? "") ?? 0)),
            "os": .string("\(os.majorVersion).\(os.minorVersion)"),
            "counts": .object(counts.mapValues { .number(Double($0)) }),
            "settings": .object(snapshot),
        ]
        if let region = Locale.current.region?.identifier, region.count == 2 { object["region"] = .string(region) }
        return .object(object)
    }

    /// Exactly what the next report holds (today so far).
    public func preview() async -> JSONValue {
        await roll(Date())
        return await report(day: state.day, counts: state.counts.isEmpty ? ["app.active": 1] : state.counts)
    }

    /// Sends finished days. Failures keep them for the next try.
    public func flush(now: Date = Date()) async {
        guard state.enabled, let endpoint else { return }
        await roll(now)
        // At most one attempt an hour; reports wait on disk until then.
        guard !state.pending.isEmpty, now.timeIntervalSince(lastAttempt) > 3600 else { return }
        lastAttempt = now
        var remaining: [JSONValue] = []
        for report in state.pending {
            var request = URLRequest(url: endpoint.appendingPathComponent("v1/report"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONEncoder().encode(report)
            request.timeoutInterval = 15
            let status = ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
            if status >= 500 || status == 0 { remaining.append(report) } // 4xx: malformed, never retried
        }
        state.pending = remaining
        if remaining.isEmpty { state.lastSent = (now.timeIntervalSince1970 * 1000).rounded() }
        await save(state)
    }

    /// Deletes what was sent under this ID, then starts over with a new one.
    public func deleteData() async throws {
        if let endpoint {
            var request = URLRequest(url: endpoint.appendingPathComponent("v1/installs/\(state.installID)"))
            request.httpMethod = "DELETE"
            request.timeoutInterval = 15
            let status = ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 204 else { throw BridgeError(.deadlineExceeded, "Lima couldn't reach its usage server. Try again when you're online.") }
        }
        state.counts = [:]
        state.pending = []
        state.installID = Self.newID()
        await save(state)
    }
}

extension Runtime {
    static func usageEndpoint() -> URL? {
        guard let contents = CodeTrust.bundleContents,
              let text = NSDictionary(contentsOf: contents.appendingPathComponent("Info.plist"))?["LimaUsageEndpoint"] as? String,
              let url = URL(string: text), url.scheme == "https" else { return nil }
        return url
    }

    func registerUsage() {
        register("usage.get") { [unowned self] _, _ in await self.usage.view }
        register("usage.set") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only you can change usage sharing.") }
            await self.usage.configure(enabled: params?["enabled"]?.boolValue == true)
            if params?["enabled"]?.boolValue == true { await self.usage.count("app.active") }
            return await self.usage.view
        }
        register("usage.count") { [unowned self] params, context in
            guard context.origin == .browser else { return .null }
            await self.usage.count(try params.string("event"))
            return .null
        }
        register("usage.settings") { [unowned self] params, context in
            guard context.origin == .browser else { return .null }
            await self.usage.setSnapshot(params)
            return .null
        }
        register("usage.preview") { [unowned self] _, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only you can see the usage report.") }
            return await self.usage.preview()
        }
        register("usage.delete") { [unowned self] _, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only you can delete usage data.") }
            try await self.usage.deleteData()
            return await self.usage.view
        }
    }
}
