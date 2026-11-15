import Foundation
import LimaProtocol

/// User-scoped launchd agent so scheduling, reports and terminals keep
/// running when browser windows are closed (spec v1 decision table).
enum BackgroundAgent {
    static let label = "dev.lima.runtime"

    struct Status: Codable { var installed: Bool; var loaded: Bool; var plist: String; var executable: String? }

    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static func status() -> Status {
        let plist = NSDictionary(contentsOf: plistURL)
        let executable = (plist?["ProgramArguments"] as? [String])?.first
        return Status(installed: plist != nil, loaded: launchctl(["print", "gui/\(getuid())/\(label)"]) == 0, plist: plistURL.path, executable: executable)
    }

    static func install(executable: String) throws -> Status {
        let resolved = (executable as NSString).resolvingSymlinksInPath
        guard FileManager.default.isExecutableFile(atPath: resolved) else { throw BridgeError(.badRequest, "lima-host not found at \(resolved)") }
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Lima")
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [resolved, "daemon"],
            "RunAtLoad": true,
            "KeepAlive": ["SuccessfulExit": false],
            "ProcessType": "Interactive",
            "StandardOutPath": logs.appendingPathComponent("runtime.log").path,
            "StandardErrorPath": logs.appendingPathComponent("runtime.log").path
        ]
        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL, options: .atomic)
        _ = launchctl(["bootout", "gui/\(getuid())/\(label)"])
        _ = launchctl(["bootstrap", "gui/\(getuid())", plistURL.path])
        return status()
    }

    static func uninstall() throws {
        _ = launchctl(["bootout", "gui/\(getuid())/\(label)"])
        try? FileManager.default.removeItem(at: plistURL)
    }

    @discardableResult
    static func launchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return -1 }
        process.waitUntilExit()
        return process.terminationStatus
    }
}

/// Connected-service status. Integrations needing OAuth client apps report
/// exactly what is missing instead of failing generically.
enum Integrations {
    struct ServiceStatus: Codable, Sendable {
        var id: String
        var name: String
        var state: String   // connected | not_connected | needs_setup | unavailable
        var detail: String
    }

    static func status() async -> [ServiceStatus] {
        var results: [ServiceStatus] = []
        let gh = run("/usr/bin/env", ["gh", "auth", "status"])
        results.append(ServiceStatus(id: "github", name: "GitHub",
                                     state: gh.status == 0 ? "connected" : "not_connected",
                                     detail: gh.status == 0 ? "Using the GitHub CLI's login" : "Run `gh auth login` in a Lima terminal"))
        for (id, name) in [("google", "Google Calendar, Meet & Gmail"), ("slack", "Slack")] {
            let configured = OAuthClientConfig.load(provider: id) != nil
            results.append(ServiceStatus(id: id, name: name, state: configured ? "not_connected" : "needs_setup",
                                         detail: configured ? "Client configured; sign in to connect" : "Register an OAuth client and add its ID in Integrations"))
        }
        results.append(ServiceStatus(id: "n8n", name: "n8n", state: "needs_setup", detail: "Add your n8n URL and API key"))
        results.append(ServiceStatus(id: "apple", name: "Apple Calendar, Reminders & Mail", state: "unavailable",
                                     detail: "Requires the signed release build (EventKit privacy permissions)"))
        return results
    }

    static func githubSummary() async throws -> JSONValue {
        func search(_ args: [String]) -> [JSONValue] {
            let result = run("/usr/bin/env", ["gh", "search", "prs", "--state=open", "--limit", "15", "--json", "title,url,repository,updatedAt"] + args)
            guard result.status == 0, let data = result.output.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
            return decoded.arrayValue ?? []
        }
        let reviews = search(["--review-requested=@me"])
        let mine = search(["--author=@me"])
        func items(_ values: [JSONValue], _ label: String) -> [JSONValue] {
            values.map { pr in
                .object(["title": pr["title"] ?? .string(""),
                         "subtitle": .string("\(label) · \(pr["repository"]?["nameWithOwner"]?.stringValue ?? "")"),
                         "value": pr["url"] ?? .string("")])
            }
        }
        return .object(["type": .string("list"), "items": .array(items(reviews, "Review requested") + items(mine, "Your PR"))])
    }

    static func run(_ executable: String, _ arguments: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = (environment["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        guard (try? process.run()) != nil else { return (-1, "") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}

struct OAuthClientConfig: Codable {
    var clientID: String
    static func load(provider: String) -> OAuthClientConfig? { nil }
}
