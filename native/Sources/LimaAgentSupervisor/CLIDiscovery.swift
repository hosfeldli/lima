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
        let home = NSHomeDirectory()
        let fromEnvironment = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let common = [
            "\(home)/.local/bin", "\(home)/.claude/local", "\(home)/.opencode/bin",
            "\(home)/.bun/bin", "\(home)/.npm-global/bin", "\(home)/.volta/bin",
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"
        ]
        var seen = Set<String>()
        return (fromEnvironment + common).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public func locate(_ provider: CLIProvider) -> String? {
        let fileManager = FileManager.default
        for directory in searchPaths {
            let candidate = (directory as NSString).appendingPathComponent(provider.executableName)
            if fileManager.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    public func discover(_ provider: CLIProvider) async -> CLICapabilityManifest {
        guard let path = locate(provider) else {
            return CLICapabilityManifest(
                provider: provider, status: .notInstalled, executablePath: nil, version: nil,
                structuredTransport: provider.structuredTransport,
                diagnostic: "\(provider.executableName) not found in \(searchPaths.count) search paths"
            )
        }
        do {
            let output = try await ProcessProbe.run(path, arguments: ["--version"], timeout: probeTimeout, path: searchPaths)
            return CLICapabilityManifest(
                provider: provider, status: .available, executablePath: path,
                version: Self.parseVersion(output), structuredTransport: provider.structuredTransport, diagnostic: nil
            )
        } catch {
            return CLICapabilityManifest(
                provider: provider, status: .versionProbeFailed, executablePath: path, version: nil,
                structuredTransport: provider.structuredTransport, diagnostic: String(describing: error)
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

enum ProcessProbe {
    static func run(_ executable: String, arguments: [String], timeout: TimeInterval, path: [String]) async throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = path.joined(separator: ":")
        environment["NO_COLOR"] = "1"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice

        return try await withCheckedThrowingContinuation { continuation in
            let state = ProbeState()
            process.terminationHandler = { finished in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(decoding: data, as: UTF8.self)
                if finished.terminationStatus == 0 {
                    state.resume(continuation, .success(output))
                } else {
                    state.resume(continuation, .failure(ProcessProbeError.nonZeroExit(finished.terminationStatus, output)))
                }
            }
            do {
                try process.run()
            } catch {
                state.resume(continuation, .failure(error))
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                if process.isRunning {
                    process.terminate()
                    state.resume(continuation, .failure(ProcessProbeError.timedOut(timeout)))
                }
            }
        }
    }
}

/// Guarantees the continuation resumes exactly once across the timeout and
/// termination paths.
private final class ProbeState: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    func resume(_ continuation: CheckedContinuation<String, Error>, _ result: Result<String, Error>) {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return }
        resumed = true
        continuation.resume(with: result)
    }
}
