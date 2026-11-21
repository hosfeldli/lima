import Foundation
import LimaAgentSupervisor
import LimaProtocol
import LimaStorage

actor GoogleWorkspace {
    struct Settings: Codable, Sendable {
        var enabled = false
        var connectedMail = false
        var connectedCalendar = false
    }

    struct Meeting: Codable, Sendable {
        var id: String
        var title: String
        var startsAt: Double
        var link: String?
    }

    struct Snapshot: Codable, Sendable {
        var installed = false
        var enabled = false
        var mail = "setup"
        var calendar = "setup"
        var mailReconnect = false
        var calendarReconnect = false
        var mailIssue: String?
        var calendarIssue: String?
        var unread: Int?
        var meeting: Meeting?
    }

    enum State: String, Sendable {
        case connected, setup, unavailable
    }

    static let scopes = "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/calendar.events.readonly"
    private let discovery: CLIDiscovery
    private var settings = Settings()
    private var snapshot = Snapshot()
    private var generation = 0
    private var polling = false
    private var lastPoll = Date.distantPast

    init(discovery: CLIDiscovery = CLIDiscovery()) { self.discovery = discovery }

    func restore(_ stored: Settings) { settings = stored }

    func status() -> Snapshot {
        var value = snapshot
        value.installed = installation() != nil
        value.enabled = settings.enabled
        return value
    }

    func configure(_ enabled: Bool, store: EncryptedStore) async throws -> Snapshot {
        var changed = settings
        changed.enabled = enabled
        try await store.put(changed, collection: "settings", id: "google.workspace")
        settings = changed
        generation += 1
        if !enabled { snapshot = Snapshot() }
        lastPoll = .distantPast
        return status()
    }

    func installation() -> CLIInstallation? { discovery.installations(named: "gws").first }

    func refresh(store: EncryptedStore, force: Bool) async throws -> Snapshot {
        // A setup verification must see the result of the new login, even
        // when a sidebar poll was already reading the previous credentials.
        while polling && force { try await Task.sleep(for: .milliseconds(100)) }
        guard settings.enabled, !polling, force || Date().timeIntervalSince(lastPoll) >= 45 else { return status() }
        guard let installation = installation() else {
            snapshot.mail = State.setup.rawValue
            snapshot.calendar = State.setup.rawValue
            snapshot.mailReconnect = settings.connectedMail
            snapshot.calendarReconnect = settings.connectedCalendar
            snapshot.mailIssue = nil
            snapshot.calendarIssue = nil
            snapshot.unread = nil
            snapshot.meeting = nil
            return status()
        }
        polling = true
        defer { polling = false }
        let revision = generation
        lastPoll = Date()
        let windowStart = Date()
        let calendarParams: [String: JSONValue] = [
            "calendarId": .string("primary"), "singleEvents": .bool(true), "orderBy": .string("startTime"),
            "timeMin": .string(windowStart.ISO8601Format()), "timeMax": .string(windowStart.addingTimeInterval(30 * 60).ISO8601Format()),
            "maxResults": .number(20), "fields": .string("kind,items(id,summary,start,htmlLink)"),
        ]
        async let mail = fetch(installation.path, ["gmail", "users", "labels", "get"], params: [
            "userId": .string("me"), "id": .string("INBOX"), "fields": .string("id,messagesUnread"),
        ])
        async let events = fetch(installation.path, ["calendar", "events", "list"], params: calendarParams)
        let (gmail, calendar) = await (mail, events)
        guard settings.enabled, generation == revision else { return status() }
        let unread = gmail.data.map { Int(min(max(0, $0["messagesUnread"]?.doubleValue ?? 0), 1e9)) }
        let meeting = calendar.data.flatMap { Self.nextMeeting($0, after: windowStart) }
        var changed = settings
        if gmail.state == .connected { changed.connectedMail = true }
        if calendar.state == .connected { changed.connectedCalendar = true }
        snapshot = Snapshot(installed: true, enabled: true, mail: gmail.state.rawValue, calendar: calendar.state.rawValue,
                            mailReconnect: changed.connectedMail && gmail.issue == "permissions", calendarReconnect: changed.connectedCalendar && calendar.issue == "permissions",
                            mailIssue: gmail.issue, calendarIssue: calendar.issue, unread: unread, meeting: meeting)
        if changed.connectedMail != settings.connectedMail || changed.connectedCalendar != settings.connectedCalendar {
            settings = changed
            try await store.put(changed, collection: "settings", id: "google.workspace")
        }
        return status()
    }

    private typealias ServiceResult = (state: State, data: JSONValue?, issue: String?)

    private func fetch(_ executable: String, _ command: [String], params: [String: JSONValue]) async -> ServiceResult {
        do {
            let encoded = try JSONEncoder().encode(params)
            let output = try await ProcessProbe.run(executable, arguments: command + ["--params", String(decoding: encoded, as: UTF8.self)],
                                                    timeout: 10, path: discovery.searchPaths, separateStandardError: true)
            let result = try JSONDecoder().decode(JSONValue.self, from: Data(output.utf8))
            if let failure = result["error"] { return Self.failureState(String(describing: failure)) }
            let verified = command.first == "gmail" ? result["id"]?.stringValue == "INBOX" || result["messagesUnread"]?.doubleValue != nil
                : result["kind"]?.stringValue == "calendar#events" || result["items"]?.arrayValue != nil
            return verified ? (.connected, result, nil) : (.unavailable, nil, "response")
        } catch {
            return Self.failureState(String(describing: error))
        }
    }

    private static func failureState(_ error: String) -> ServiceResult {
        let lower = error.lowercased()
        if ["accessnotconfigured", "service_disabled", "api has not been used", "api is disabled"].contains(where: lower.contains) {
            return (.setup, nil, "apiDisabled")
        }
        let permissions = ["auth", "credential", "login", "sign in", "forbidden", "unauthorized", "401", "403", "permission",
                           "invalid_grant", "access token", "insufficient"]
        return permissions.contains(where: lower.contains) ? (.setup, nil, "permissions") : (.unavailable, nil, "response")
    }

    static func nextMeeting(_ response: JSONValue, after time: Date) -> Meeting? {
        let utc = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions.insert(.withFractionalSeconds)
        return response["items"]?.arrayValue?.compactMap { event -> Meeting? in
            guard let id = event["id"]?.stringValue, let stamp = event["start"]?["dateTime"]?.stringValue,
                  let start = utc.date(from: stamp) ?? fractional.date(from: stamp), start >= time else { return nil }
            let link = event["htmlLink"]?.stringValue.flatMap { value -> String? in
                guard let url = URL(string: value), url.scheme == "https", url.host == "calendar.google.com" || url.host == "www.google.com" else { return nil }
                return url.absoluteString
            }
            let title = event["summary"]?.stringValue ?? "Upcoming meeting"
            return Meeting(id: id, title: String(title.prefix(140)), startsAt: start.timeIntervalSince1970 * 1000, link: link)
        }.min { $0.startsAt < $1.startsAt }
    }
}

extension Runtime {
    func registerGoogleWorkspace() {
        register("integrations.google.status") { [unowned self] _, context in
            try Self.requireLocalSettings(context)
            return try JSONValue.from(await self.googleWorkspace.status())
        }
        register("integrations.google.refresh") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            let result = try JSONValue.from(await self.googleWorkspace.refresh(store: self.store, force: params?["force"]?.boolValue == true))
            if params?["force"]?.boolValue == true { self.broadcast("integrations.google.updated", result) }
            return result
        }
        register("integrations.google.configure") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            let result = try JSONValue.from(await self.googleWorkspace.configure(params?["enabled"]?.boolValue == true, store: self.store))
            self.broadcast("integrations.google.updated", result)
            return result
        }
    }

    static func requireLocalSettings(_ context: CallContext) throws {
        guard context.origin == .browser, context.workspaceID == nil else {
            throw BridgeError(.notAuthorized, "Only Lima’s browser interface can use this setting.")
        }
    }
}
