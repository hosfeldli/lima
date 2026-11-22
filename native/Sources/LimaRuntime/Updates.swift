import CryptoKit
import Darwin
import Foundation
import LimaProtocol
import Security

/// The signed release feed (`latest.json`), produced by
/// `browser/scripts/release/feed.sh`. Its exact bytes are covered by an
/// Ed25519 signature in `latest.json.sig`.
struct UpdateFeed: Codable, Sendable, Equatable {
    var schemaVersion: Int
    var channel: String
    var version: String
    var build: Int
    var minimumSystemVersion: String
    var url: String
    var sha256: String
    var bytes: Int
    var engine: String
    var commit: String
    var publishedAt: String
    var critical: Bool?
    var notesUrl: String?
}

/// Update configuration stamped into `Lima.app/Contents/Info.plist` by a
/// release repack. Development builds carry none, so updates are off.
struct UpdateConfiguration: Sendable {
    var feedURL: URL
    var publicKey: Curve25519.Signing.PublicKey
    var app: URL
    var bundleIdentifier: String
    var build: Int

    static func load(contents: URL? = CodeTrust.bundleContents) -> UpdateConfiguration? {
        guard let contents,
              let plist = NSDictionary(contentsOf: contents.appendingPathComponent("Info.plist")) as? [String: Any],
              let feed = (plist["LimaUpdateFeedURL"] as? String).flatMap(URL.init(string:)), feed.scheme == "https",
              let keyText = plist["LimaUpdatePublicKey"] as? String, let keyData = Data(base64Encoded: keyText),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
              let identifier = plist["CFBundleIdentifier"] as? String,
              let build = (plist["CFBundleVersion"] as? String).flatMap(Int.init)
        else { return nil }
        return UpdateConfiguration(feedURL: feed, publicKey: key, app: contents.deletingLastPathComponent(),
                                   bundleIdentifier: identifier, build: build)
    }
}

enum UpdateVerifier {
    static let maximumFeedBytes = 64 * 1024
    static let maximumArchiveBytes = 1_500_000_000

    /// Parses a feed only if its signature verifies and it names a newer,
    /// installable build hosted beside the feed.
    static func feed(_ data: Data, signature: Data, configuration: UpdateConfiguration) throws -> UpdateFeed? {
        guard data.count <= maximumFeedBytes else { throw BridgeError(.badRequest, "The update feed is too large.") }
        let decodedSignature = Data(base64Encoded: String(decoding: signature, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) ?? Data()
        guard configuration.publicKey.isValidSignature(decodedSignature, for: data) else {
            throw BridgeError(.notAuthorized, "The update feed signature is invalid.")
        }
        let feed = try JSONDecoder().decode(UpdateFeed.self, from: data)
        guard feed.schemaVersion == 1, feed.channel == "stable",
              feed.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              feed.bytes > 0, feed.bytes <= maximumArchiveBytes,
              let archive = URL(string: feed.url), archive.scheme == "https", archive.host == configuration.feedURL.host
        else { throw BridgeError(.badRequest, "The update feed is malformed.") }
        // Strictly newer only: a replayed old feed can never downgrade Lima.
        guard feed.build > configuration.build else { return nil }
        let minimum = feed.minimumSystemVersion.split(separator: ".").compactMap { Int($0) }
        let required = OperatingSystemVersion(majorVersion: minimum.first ?? 0, minorVersion: minimum.dropFirst().first ?? 0, patchVersion: 0)
        guard ProcessInfo.processInfo.isOperatingSystemAtLeast(required) else { return nil }
        return feed
    }

    static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// The candidate app is intact (every nested binary included) and meets
    /// the installed app's designated requirement: same bundle identifier,
    /// signed by the same pinned certificate.
    static func appSatisfiesInstalledRequirement(_ candidate: URL, installed: URL) throws {
        try verifyApp(candidate, requirement: installedRequirement(installed))
    }

    static func installedRequirement(_ installed: URL) throws -> SecRequirement {
        var installedCode: SecStaticCode?
        var requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(installed as CFURL, [], &installedCode) == errSecSuccess, let installedCode,
              SecCodeCopyDesignatedRequirement(installedCode, [], &requirement) == errSecSuccess, let requirement
        else { throw BridgeError(.internalError, "Lima can't read its own code signature.") }
        guard CodeTrust.leafCertificate(installedCode) != nil else {
            throw BridgeError(.notAuthorized, "Development builds don't install updates.")
        }
        return requirement
    }

    static func verifyApp(_ candidate: URL, requirement: SecRequirement) throws {
        var candidateCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(candidate as CFURL, [], &candidateCode) == errSecSuccess, let candidateCode else {
            throw BridgeError(.badRequest, "The update isn't an app.")
        }
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
        var error: Unmanaged<CFError>?
        guard SecStaticCodeCheckValidityWithErrors(candidateCode, flags, requirement, &error) == errSecSuccess else {
            let reason = error.map { CFErrorCopyDescription($0.takeRetainedValue()) as String } ?? "signature mismatch"
            throw BridgeError(.notAuthorized, "The update isn't signed by Lima: \(reason)")
        }
    }

    static func bundleBuild(_ app: URL) -> (identifier: String, build: Int)? {
        guard let plist = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any],
              let identifier = plist["CFBundleIdentifier"] as? String,
              let build = (plist["CFBundleVersion"] as? String).flatMap(Int.init) else { return nil }
        return (identifier, build)
    }
}

/// Checks, downloads, verifies and stages Lima updates. Installation runs
/// in a separate `lima-host apply-update` process after the browser quits.
final class UpdateService: @unchecked Sendable {
    enum Phase: String, Sendable { case disabled, idle, checking, available, downloading, ready, installing, failed }

    private let lock = NSLock()
    private var phase: Phase
    private var feed: UpdateFeed?
    private var staged: URL?
    private var lastError: String?
    private var checkedAt: Date?
    let configuration: UpdateConfiguration?
    let directory: URL
    var emit: (@Sendable (JSONValue) -> Void)?

    init(configuration: UpdateConfiguration? = .load(),
         directory: URL = ProcessInfo.processInfo.environment["LIMA_DATA_DIR"].map {
             URL(fileURLWithPath: $0).appendingPathComponent("Updates")
         } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Lima Browser/Updates")) {
        self.configuration = configuration
        self.directory = directory
        self.phase = configuration == nil ? .disabled : .idle
    }

    var status: JSONValue {
        lock.lock(); defer { lock.unlock() }
        var object: [String: JSONValue] = [
            "phase": .string(phase.rawValue),
            "currentBuild": configuration.map { .number(Double($0.build)) } ?? .null,
            "currentVersion": .string(limaRuntimeVersion),
            "checkedAt": checkedAt.map { .number($0.timeIntervalSince1970 * 1000) } ?? .null,
            "error": lastError.map(JSONValue.string) ?? .null,
            "canRollBack": .bool(FileManager.default.fileExists(atPath: previousApp.path)),
        ]
        if let feed {
            object["version"] = .string(feed.version)
            object["build"] = .number(Double(feed.build))
            object["critical"] = .bool(feed.critical ?? false)
            object["notesUrl"] = feed.notesUrl.map(JSONValue.string) ?? .null
        }
        if let result = lastInstallResult { object["lastInstall"] = result }
        return .object(object)
    }

    var previousApp: URL { directory.appendingPathComponent("previous/Lima.app") }
    var resultFile: URL { directory.appendingPathComponent("last-install.json") }
    private var lastInstallResult: JSONValue? {
        (try? Data(contentsOf: resultFile)).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
    }

    private func set(_ phase: Phase, error: String? = nil) {
        lock.lock()
        self.phase = phase
        lastError = error
        lock.unlock()
        emit?(status)
    }

    /// Fetches the signed feed; downloads and stages a newer build.
    func check() async throws -> JSONValue {
        guard let configuration else { return status }
        let started = locked {
            guard [.idle, .failed].contains(phase) else { return false }
            phase = .checking
            lastError = nil
            return true
        }
        guard started else { return status }
        emit?(status)
        do {
            let session = URLSession(configuration: .ephemeral)
            let (data, response) = try await session.data(from: configuration.feedURL)
            let (signature, signatureResponse) = try await session.data(from: configuration.feedURL.appendingPathExtension("sig"))
            guard (response as? HTTPURLResponse)?.statusCode == 200, (signatureResponse as? HTTPURLResponse)?.statusCode == 200 else {
                throw BridgeError(.internalError, "The update server didn't respond.")
            }
            let feed = try UpdateVerifier.feed(data, signature: signature, configuration: configuration)
            lock.withLock { self.feed = feed; checkedAt = Date() }
            guard let feed else { set(.idle); return status }
            set(.available)
            try await download(feed, configuration: configuration, session: session)
            return status
        } catch {
            set(.failed, error: (error as? BridgeError)?.message ?? error.localizedDescription)
            throw error
        }
    }

    private func download(_ feed: UpdateFeed, configuration: UpdateConfiguration, session: URLSession) async throws {
        set(.downloading)
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let staging = directory.appendingPathComponent("staged-\(feed.build)")
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let url = URL(string: feed.url) else { throw BridgeError(.badRequest, "The update feed is malformed.") }
        let (temporary, response) = try await session.download(from: url)
        let archive = staging.appendingPathComponent("Lima.zip")
        try fm.moveItem(at: temporary, to: archive)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              ((try? fm.attributesOfItem(atPath: archive.path)[.size] as? NSNumber)?.intValue) == feed.bytes,
              try UpdateVerifier.sha256(of: archive) == feed.sha256
        else { throw BridgeError(.notAuthorized, "The downloaded update doesn't match the signed feed.") }

        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        unzip.arguments = ["-x", "-k", archive.path, staging.path]
        try unzip.run()
        unzip.waitUntilExit()
        try? fm.removeItem(at: archive)
        let app = staging.appendingPathComponent("Lima.app")
        guard unzip.terminationStatus == 0,
              (try? fm.destinationOfSymbolicLink(atPath: app.path)) == nil,
              let identity = UpdateVerifier.bundleBuild(app),
              identity.identifier == configuration.bundleIdentifier, identity.build == feed.build
        else { throw BridgeError(.badRequest, "The update archive doesn't contain Lima \(feed.version).") }
        try UpdateVerifier.appSatisfiesInstalledRequirement(app, installed: configuration.app)
        lock.withLock { staged = app }
        set(.ready)
    }

    /// Starts the installer, which waits for `browserPID` to exit, swaps the
    /// bundle, verifies it and relaunches Lima (or restores the old copy).
    func install(browserPID: pid_t, profilePath: String) throws {
        guard let configuration else { throw BridgeError(.badRequest, "Updates are off in development builds.") }
        guard browserPID > 1 else { throw BridgeError(.badRequest, "browserPid is required.") }
        let profile = try UpdateApplier.profile(path: profilePath, outside: [configuration.app, directory])
        guard let staged = locked({
            guard phase == .ready, let staged else { return nil as URL? }
            phase = .installing
            return staged
        }) else { throw BridgeError(.badRequest, "No update is ready.") }
        do {
            try launchApplier(source: staged, configuration: configuration, browserPID: browserPID, profile: profile, keepBackup: true)
            emit?(status)
        } catch {
            set(.ready, error: error.localizedDescription)
            throw error
        }
    }

    /// Reinstalls the copy kept from the last update.
    func rollback(browserPID: pid_t, profilePath: String) throws {
        guard let configuration else { throw BridgeError(.badRequest, "Updates are off in development builds.") }
        guard browserPID > 1 else { throw BridgeError(.badRequest, "browserPid is required.") }
        guard FileManager.default.fileExists(atPath: previousApp.path) else { throw BridgeError(.badRequest, "There's no previous version to restore.") }
        let profile = try UpdateApplier.profile(path: profilePath, outside: [configuration.app, directory])
        let restore = directory.appendingPathComponent("restore/Lima.app")
        try? FileManager.default.removeItem(at: restore.deletingLastPathComponent())
        try FileManager.default.createDirectory(at: restore.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.copyItem(at: previousApp, to: restore)
        try launchApplier(source: restore, configuration: configuration, browserPID: browserPID, profile: profile, keepBackup: false)
        set(.installing)
    }

    private func launchApplier(source: URL, configuration: UpdateConfiguration, browserPID: pid_t, profile: URL, keepBackup: Bool) throws {
        let parent = configuration.app.deletingLastPathComponent()
        if configuration.app.path.contains("/AppTranslocation/") ||
            (try? parent.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) == true {
            throw BridgeError(.badRequest, "Move Lima.app to Applications in Finder and reopen it there before installing updates.")
        }
        guard FileManager.default.isWritableFile(atPath: parent.path) else {
            throw BridgeError(.notAuthorized, "Lima needs write access to the folder where its app is installed.")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: CodeTrust.selfExecutable)
        process.arguments = ["apply-update", "--source", source.path, "--target", configuration.app.path,
                             "--wait-pid", String(browserPID), "--state", directory.path, "--profile", profile.path] +
                            (keepBackup ? ["--keep-backup"] : [])
        process.standardInput = FileHandle.nullDevice
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Lima/update.log")
        try? FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let handle = try FileHandle(forWritingTo: log)
        handle.seekToEndOfFile()
        process.standardOutput = handle
        process.standardError = handle
        try process.run()
    }

    private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
}

/// `lima-host apply-update`: the out-of-process installer. It runs from the
/// old bundle (its open executable survives the bundle being moved) and
/// re-verifies everything right before and after the swap.
public enum UpdateApplier {
    static func profile(path: String, outside protectedPaths: [URL]) throws -> URL {
        let candidate = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
        var directory: ObjCBool = false
        guard path.hasPrefix("/"), candidate.path != "/", FileManager.default.fileExists(atPath: candidate.path, isDirectory: &directory),
              directory.boolValue, !protectedPaths.contains(where: {
                  let protected = $0.resolvingSymlinksInPath().standardizedFileURL.path
                  return candidate.path == protected || candidate.path.hasPrefix(protected + "/")
              })
        else { throw BridgeError(.badRequest, "Lima couldn't identify a browser profile outside the update files.") }
        return candidate
    }

    static func relaunchArguments(target: URL, profile: URL, environment: [String: String] = [:]) -> [String] {
        let overrides = ["LIMA_DATA_DIR", "LIMA_KEY_FILE", "LIMA_WORKSPACES_ROOT"].flatMap { name in
            environment[name].map { ["--env", "\(name)=\($0)"] } ?? []
        }
        return ["-n", "-a", target.path] + overrides + ["--args", "-profile", profile.path]
    }

    public static func run(_ arguments: [String]) -> Never {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        guard let source = value("--source").map(URL.init(fileURLWithPath:)),
              let target = value("--target").map(URL.init(fileURLWithPath:)),
              let state = value("--state").map(URL.init(fileURLWithPath:)),
              let path = value("--profile"),
              let profile = try? profile(path: path, outside: [target, source, state]),
              let pid = value("--wait-pid").flatMap(Int32.init)
        else {
            FileHandle.standardError.write(Data("usage: lima-host apply-update --source <app> --target <app> --wait-pid <pid> --state <dir> --profile <dir> [--keep-backup]\n".utf8))
            exit(64)
        }
        // Only the runtime (lima-host) may drive an install.
        guard CodeTrust.parentIsLimaHost() else {
            FileHandle.standardError.write(Data("lima-host apply-update is started by the Lima runtime.\n".utf8))
            exit(77)
        }
        setsid()
        let keepBackup = arguments.contains("--keep-backup")
        let requirement = try? UpdateVerifier.installedRequirement(target)
        let result = apply(source: source, target: target, state: state, waitFor: pid, keepBackup: keepBackup)
        func record(_ error: String?) {
            let result: [String: Any] = ["ok": error == nil, "error": error ?? NSNull(), "at": Date().timeIntervalSince1970 * 1000,
                                         "build": UpdateVerifier.bundleBuild(target)?.build ?? 0]
            if let data = try? JSONSerialization.data(withJSONObject: result) {
                try? data.write(to: state.appendingPathComponent("last-install.json"), options: .atomic)
            }
        }
        record(result)
        print("lima-host apply-update: \(result ?? "installed")")
        guard kill(pid, 0) != 0, let requirement, (try? UpdateVerifier.verifyApp(target, requirement: requirement)) != nil else { exit(1) }
        let relaunch = Process()
        relaunch.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        relaunch.arguments = relaunchArguments(target: target, profile: profile, environment: ProcessInfo.processInfo.environment)
        do { try relaunch.run(); relaunch.waitUntilExit() }
        catch { record("Lima couldn't reopen automatically. Open Lima.app again from Finder."); exit(1) }
        guard relaunch.terminationStatus == 0 else {
            record("Lima couldn't reopen automatically. Open Lima.app again from Finder.")
            exit(1)
        }
        exit(result == nil ? 0 : 1)
    }

    /// Returns nil on success, otherwise why the install was rolled back.
    static func apply(source: URL, target: URL, state: URL, waitFor pid: pid_t, keepBackup: Bool) -> String? {
        let fm = FileManager.default
        guard source.resolvingSymlinksInPath() != target.resolvingSymlinksInPath() else {
            return "The replacement app is already at the installation path."
        }
        // Wait (up to two minutes) for the browser to quit.
        for _ in 0..<1200 where kill(pid, 0) == 0 { usleep(100_000) }
        guard kill(pid, 0) != 0 else { return "Lima didn't quit, so the update wasn't installed." }

        do { try UpdateVerifier.appSatisfiesInstalledRequirement(source, installed: target) } catch {
            return (error as? BridgeError)?.message ?? "\(error)"
        }
        let backup = state.appendingPathComponent("previous/Lima.app")
        let swapDirectory = target.deletingLastPathComponent().appendingPathComponent(".lima-replace-\(UUID().uuidString)")
        let pending = swapDirectory.appendingPathComponent("Lima.app")
        var preserveSwap = false
        defer { if !preserveSwap { try? fm.removeItem(at: swapDirectory) } }
        do {
            try fm.createDirectory(at: swapDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try fm.copyItem(at: source, to: pending)
            try UpdateVerifier.appSatisfiesInstalledRequirement(pending, installed: target)
        } catch { return "Lima couldn't prepare the replacement app: \(error.localizedDescription)" }
        guard renamex_np(target.path, pending.path, UInt32(RENAME_SWAP)) == 0 else {
            return "Lima couldn't replace the installed app: \(String(cString: strerror(errno)))"
        }

        do {
            try UpdateVerifier.appSatisfiesInstalledRequirement(target, installed: pending)
        } catch {
            if renamex_np(target.path, pending.path, UInt32(RENAME_SWAP)) != 0 {
                preserveSwap = true
                return "Verification failed and Lima couldn’t restore its previous app automatically. The previous app is at \(pending.path)."
            }
            return "The update failed verification after install and was rolled back: \((error as? BridgeError)?.message ?? error.localizedDescription)"
        }

        if keepBackup {
            let next = state.appendingPathComponent("previous-\(UUID().uuidString)")
            do {
                try fm.createDirectory(at: next, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try fm.copyItem(at: pending, to: next.appendingPathComponent("Lima.app"))
                let destination = backup.deletingLastPathComponent()
                if fm.fileExists(atPath: destination.path) {
                    guard renamex_np(destination.path, next.path, UInt32(RENAME_SWAP)) == 0 else {
                        throw POSIXError(.EIO)
                    }
                    try? fm.removeItem(at: next)
                } else {
                    try fm.moveItem(at: next, to: destination)
                }
            } catch {
                preserveSwap = true
                print("lima-host: couldn't retain rollback in the update directory. Previous app: \(pending.path)")
            }
        }
        try? fm.removeItem(at: source)
        _ = rmdir(source.deletingLastPathComponent().path)
        return nil
    }
}

extension Runtime {
    func registerUpdates() {
        updates.emit = { [weak self] status in self?.broadcast("update.status", status) }
        register("update.status") { [unowned self] _, context in
            try Self.requireLocalSettings(context)
            return self.updates.status
        }
        register("update.check") { [unowned self] _, context in
            try Self.requireLocalSettings(context)
            let service = self.updates
            Task { _ = try? await service.check() }
            return service.status
        }
        register("update.install") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            let chats = await self.conversations.list()
            let shells = await self.terminals.list()
            guard !chats.contains(where: \.running), !shells.contains(where: {
                $0.state == .running || $0.state == .waitingForInput || $0.userEditing == true
            }) else { throw BridgeError(.badRequest, "Finish active agents and terminal commands before restarting Lima.") }
            try self.updates.install(browserPID: pid_t(params?["browserPid"]?.doubleValue ?? 0), profilePath: try params.string("profilePath"))
            return self.updates.status
        }
        register("update.rollback") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            try self.updates.rollback(browserPID: pid_t(params?["browserPid"]?.doubleValue ?? 0), profilePath: try params.string("profilePath"))
            return self.updates.status
        }
    }
}
