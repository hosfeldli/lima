import Foundation

/// The three first-class CLI providers (spec §4.4). There is no direct
/// model-API backend.
public enum CLIProvider: String, Codable, Sendable, CaseIterable {
    case codex, claude, opencode

    public var executableName: String { rawValue }

    /// Protocol each adapter will drive once implemented, following Orca:
    /// Claude via `--output-format stream-json`, Codex via its app-server,
    /// OpenCode via its JSON/ACP server.
    public var structuredTransport: String {
        switch self {
        case .claude: "stream-json"
        case .codex: "app-server"
        case .opencode: "json-events"
        }
    }
}

public enum CLIStatus: String, Codable, Sendable {
    case available
    case notInstalled = "not_installed"
    case versionProbeFailed = "version_probe_failed"
}

/// Capability manifest generated from the CLI actually installed, never
/// assumed (spec §4.4). Feature flags are filled in by per-provider probes
/// as adapters land; discovery only establishes identity.
public struct CLICapabilityManifest: Codable, Equatable, Sendable {
    public var provider: CLIProvider
    public var status: CLIStatus
    public var executablePath: String?
    public var version: String?
    public var structuredTransport: String
    public var diagnostic: String?
    public var installations: [CLIInstallation]? = nil
}

public struct CLIInstallation: Codable, Equatable, Sendable {
    public var path: String
    public var resolvedPath: String
}

public struct CLIDiscovery: Sendable {
    public var searchPaths: [String]
    public var probeTimeout: TimeInterval

    public init(searchPaths: [String]? = nil, probeTimeout: TimeInterval = 5) {
        self.searchPaths = searchPaths ?? CLIDiscovery.defaultSearchPaths()
        self.probeTimeout = probeTimeout
    }

    /// GUI apps launched from Finder get a minimal PATH, so include the
    /// usual install locations for npm, Homebrew, bun and the vendor installers.
    public static func defaultSearchPaths(environment: [String: String] = ProcessInfo.processInfo.environment) -> [String] {
        let home = environment["HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? NSHomeDirectory()
        let fromEnvironment = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let locations = [(environment["BUN_INSTALL"] ?? "\(home)/.bun") + "/bin",
                         (environment["NPM_CONFIG_PREFIX"] ?? "\(home)/.npm-global") + "/bin",
                         (environment["VOLTA_HOME"] ?? "\(home)/.volta") + "/bin"]
        let common = [locations[0], "\(home)/.local/bin", "\(home)/.claude/local", "\(home)/.opencode/bin",
                      locations[1], locations[2], "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        var seen = Set<String>()
        return (fromEnvironment + common).filter { $0.hasPrefix("/") && seen.insert($0).inserted }
    }

    public func locate(_ provider: CLIProvider) -> String? {
        installations(named: provider.executableName).first?.path
    }

    public func installations(named name: String) -> [CLIInstallation] {
        searchPaths.compactMap { directory in
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent(name)
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue,
                  FileManager.default.isExecutableFile(atPath: candidate.path) else { return nil }
            return CLIInstallation(path: candidate.path, resolvedPath: candidate.resolvingSymlinksInPath().path)
        }
    }

    public func discover(_ provider: CLIProvider) async -> CLICapabilityManifest {
        let installations = installations(named: provider.executableName)
        guard let path = installations.first?.path else {
            return CLICapabilityManifest(
                provider: provider, status: .notInstalled, executablePath: nil, version: nil,
                structuredTransport: provider.structuredTransport,
                diagnostic: "\(provider.executableName) not found in \(searchPaths.count) search paths", installations: []
            )
        }
        do {
            let output = try await ProcessProbe.run(path, arguments: ["--version"], timeout: probeTimeout, path: searchPaths)
            return CLICapabilityManifest(
                provider: provider, status: .available, executablePath: path,
                version: Self.parseVersion(output), structuredTransport: provider.structuredTransport, diagnostic: nil, installations: installations
            )
        } catch {
            return CLICapabilityManifest(
                provider: provider, status: .versionProbeFailed, executablePath: path, version: nil,
                structuredTransport: provider.structuredTransport, diagnostic: "Could not run \(provider.executableName) --version", installations: installations
            )
        }
    }

    public func discoverAll() async -> [CLICapabilityManifest] {
        await withTaskGroup(of: CLICapabilityManifest.self) { group in
            for provider in CLIProvider.allCases { group.addTask { await discover(provider) } }
            var results: [CLICapabilityManifest] = []
            for await manifest in group { results.append(manifest) }
            return results.sorted { $0.provider.rawValue < $1.provider.rawValue }
        }
    }

    public func isConfigured(_ provider: CLIProvider) async -> Bool {
        guard let executable = locate(provider) else { return false }
        let environment = ProcessInfo.processInfo.environment
        let keys: [String]
        let command: [String]
        switch provider {
        case .claude: keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]; command = ["auth", "status", "--json"]
        case .codex: keys = ["CODEX_API_KEY"]; command = ["login", "status"]
        case .opencode: keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"]; command = ["auth", "list", "--format", "json"]
        }
        if keys.contains(where: { environment[$0]?.isEmpty == false }) { return true }
        guard let output = try? await ProcessProbe.run(executable, arguments: command, timeout: probeTimeout, path: searchPaths) else {
            // OpenCode 1 stores provider credentials in its data directory.
            if provider == .opencode {
                let root = environment["XDG_DATA_HOME"] ?? NSHomeDirectory() + "/.local/share"
                let path = URL(fileURLWithPath: root).appendingPathComponent("opencode/auth.json")
                if let data = try? Data(contentsOf: path), let auth = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { return !auth.isEmpty }
            }
            return false
        }
        if provider == .codex { return true }
        guard let json = try? JSONSerialization.jsonObject(with: Data(output.utf8)) else { return false }
        if provider == .claude { return (json as? [String: Any])?["loggedIn"] as? Bool == true }
        if let entries = json as? [Any] { return !entries.isEmpty }
        if let entries = json as? [String: Any] {
            return ["credentials", "providers", "accounts"].contains { key in
                (entries[key] as? [Any])?.isEmpty == false || (entries[key] as? [String: Any])?.isEmpty == false
            }
        }
        return false
    }

    public func configuredProviders() async -> [CLIProvider] {
        await withTaskGroup(of: CLIProvider?.self) { group in
            for provider in CLIProvider.allCases {
                group.addTask { await isConfigured(provider) ? provider : nil }
            }
            var configured = Set<CLIProvider>()
            for await item in group { if let item { configured.insert(item) } }
            return CLIProvider.allCases.filter { configured.contains($0) }
        }
    }

    /// Extract the first dotted version number, e.g. "2.1.4 (Claude Code)" → "2.1.4".
    public static func parseVersion(_ output: String) -> String? {
        guard let range = output.range(of: #"\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.\-]+)?"#, options: .regularExpression) else {
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : String(trimmed.prefix(80))
        }
        return String(output[range])
    }
}

enum ProcessProbeError: Error, CustomStringConvertible {
    case timedOut(TimeInterval)
    case nonZeroExit(Int32, String)

    var description: String {
        switch self {
        case .timedOut(let seconds): "timed out after \(Int(seconds))s"
        case .nonZeroExit(let code, let output): "exited \(code): \(output.prefix(200))"
        }
    }
}

public enum ProcessProbe {
    public static func run(_ executable: String, arguments: [String], timeout: TimeInterval, path: [String], separateStandardError: Bool = false,
                           onLine: (@Sendable (String) -> Void)? = nil) async throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = path.joined(separator: ":")
        environment["NO_COLOR"] = "1"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        let diagnostic = separateStandardError ? Pipe() : nil
        process.standardError = diagnostic ?? pipe
        process.standardInput = FileHandle.nullDevice

        return try await withCheckedThrowingContinuation { continuation in
            let state = ProbeState()
            let errors = ProbeState()
            let reader = DispatchGroup()
            reader.enter()
            if diagnostic != nil { reader.enter() }
            process.terminationHandler = { finished in
                reader.notify(queue: .global(qos: .utility)) {
                    let output = state.output()
                    if finished.terminationStatus == 0 {
                        state.resume(continuation, .success(output))
                    } else {
                        state.resume(continuation, .failure(ProcessProbeError.nonZeroExit(finished.terminationStatus, output + "\n" + errors.output())))
                    }
                }
            }
            do {
                try process.run()
            } catch {
                reader.leave()
                if diagnostic != nil { reader.leave() }
                state.resume(continuation, .failure(error))
                return
            }
            if let diagnostic {
                DispatchQueue.global(qos: .utility).async {
                    defer { reader.leave() }
                    drain(diagnostic.fileHandleForReading, errors, onLine)
                }
            }
            DispatchQueue.global(qos: .utility).async {
                defer { reader.leave() }
                drain(pipe.fileHandleForReading, state, onLine)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                if process.isRunning { process.terminate() }
                state.resume(continuation, .failure(ProcessProbeError.timedOut(timeout)))
            }
        }
    }
    private static func drain(_ handle: FileHandle, _ state: ProbeState, _ onLine: (@Sendable (String) -> Void)?) {
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        var line = Data()
        while true {
            let count = buffer.withUnsafeMutableBytes { read(handle.fileDescriptor, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { break }
            state.append(buffer.prefix(count))
            if let onLine {
                for byte in buffer.prefix(count) {
                    if byte == 10 {
                        onLine(String(decoding: line, as: UTF8.self))
                        line.removeAll(keepingCapacity: true)
                    } else if line.count < 32768 { line.append(byte) }
                }
            }
        }
        if !line.isEmpty { onLine?(String(decoding: line, as: UTF8.self)) }
    }

}

/// Guarantees the continuation resumes exactly once across the timeout and
/// termination paths.
private final class ProbeState: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    private var bytes = Data()

    func append(_ data: ArraySlice<UInt8>) {
        lock.withLock { bytes.append(contentsOf: data.prefix(max(0, 512 * 1024 - bytes.count))) }
    }

    func output() -> String { lock.withLock { String(decoding: bytes, as: UTF8.self) } }

    func resume(_ continuation: CheckedContinuation<String, Error>, _ result: Result<String, Error>) {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return }
        resumed = true
        continuation.resume(with: result)
    }
}
