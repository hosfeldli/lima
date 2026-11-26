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
    /// Hours over which installs pick the release up; nil or 0 = all at once.
    var rolloutHours: Double?
    /// The release as chunks, for smaller downloads (see Chunks.swift).
    var chunks: FeedChunks?
}

struct FeedChunks: Codable, Sendable, Equatable {
    var manifest: String
    var sha256: String
    var base: String
}

/// Staged rollout: each install has a fixed random slot in [0, 1) and an
/// automatic check takes a release once that share of the rollout window has
/// passed. A check you start yourself, or a critical release, doesn't wait.
enum Rollout {
    static func slot(in directory: URL) -> Double {
        let file = directory.appendingPathComponent("rollout-slot")
        if let text = try? String(contentsOf: file, encoding: .utf8), let value = Double(text), (0..<1).contains(value) { return value }
        let value = Double.random(in: 0..<1)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? String(value).write(to: file, atomically: true, encoding: .utf8)
        return value
    }

    static func ready(_ feed: UpdateFeed, slot: Double, manual: Bool, now: Date = Date()) -> Bool {
        guard !manual, feed.critical != true, let hours = feed.rolloutHours, hours > 0,
              let published = ISO8601DateFormatter().date(from: feed.publishedAt) else { return true }
        return now.timeIntervalSince(published) / (hours * 3600) >= slot
    }
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
        return UpdateConfiguration(feedURL: feed, publicKey: key, app: originalApp(contents.deletingLastPathComponent()),
                                   bundleIdentifier: identifier, build: build)
    }

    /// The real app behind a translocated copy. macOS runs a quarantined app
    /// from a read-only mount under AppTranslocation (even in /Applications,
    /// when Finder didn't move it); that mount's source is the installed app,
    /// which is where an update belongs. Anything else is returned as is.
    static func originalApp(_ app: URL) -> URL {
        guard app.path.contains("/AppTranslocation/") else { return app }
        var info = statfs()
        guard statfs(app.path, &info) == 0 else { return app }
        let source = withUnsafeBytes(of: &info.f_mntfromname) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        guard source.hasPrefix("/") else { return app }
        let mounted = URL(fileURLWithPath: source)
        for candidate in [mounted, mounted.appendingPathComponent(app.lastPathComponent)]
            where candidate.pathExtension == "app" && !candidate.path.contains("/AppTranslocation/")
                && FileManager.default.fileExists(atPath: candidate.appendingPathComponent("Contents/Info.plist").path) {
            return candidate
        }
        return app
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
    /// signed by the same pinned certificate, or by Lima's Developer ID
    /// (the team in Info.plist), which carries installs across that switch.
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
        return CodeTrust.trusted(requirement, code: installedCode, team: teamOf(installed) ?? CodeTrust.trustedTeam)
    }

    /// The team the installed app was built to trust.
    static func teamOf(_ app: URL) -> String? {
        guard let team = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))?["LimaTrustedTeam"] as? String else { return nil }
        return CodeTrust.isTeamID(team) ? team : nil
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

final class DownloadTaskBox: @unchecked Sendable { var task: URLSessionDownloadTask? }

/// Checks, downloads, verifies and stages Lima updates. Installation runs
/// in a separate `lima-host apply-update` process after the browser quits.
final class UpdateService: @unchecked Sendable {
    enum Phase: String, Sendable { case disabled, idle, checking, available, downloading, verifying, ready, installing, failed }

    private let lock = NSLock()
    private var phase: Phase
    private var feed: UpdateFeed?
    private var staged: URL?
    private var lastError: String?
    private var checkedAt: Date?
    /// Download progress, 0–1, while downloading.
    private var progress: Double?
    let configuration: UpdateConfiguration?
    let directory: URL
    private let releaseNotes: String?
    var emit: (@Sendable (JSONValue) -> Void)?

    init(configuration: UpdateConfiguration? = .load(),
         directory: URL = ProcessInfo.processInfo.environment["LIMA_DATA_DIR"].map {
             URL(fileURLWithPath: $0).appendingPathComponent("Updates")
         } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Lima Browser/Updates")) {
        self.configuration = configuration
        self.directory = directory
        self.phase = configuration == nil ? .disabled : .idle
        self.releaseNotes = configuration.flatMap { configuration in
            let file = configuration.app.appendingPathComponent("Contents/Resources/lima-release-notes.md")
            return (try? String(contentsOf: file, encoding: .utf8)).map { String($0.prefix(30_000)) }
        }
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
            "progress": progress.map(JSONValue.number) ?? .null,
        ]
        if let feed {
            object["version"] = .string(feed.version)
            object["build"] = .number(Double(feed.build))
            object["critical"] = .bool(feed.critical ?? false)
            object["notesUrl"] = feed.notesUrl.map(JSONValue.string) ?? .null
        }
        if let result = lastInstallResult { object["lastInstall"] = result }
        if let configuration { object["moveRecommended"] = .bool(Self.shouldOfferMove(configuration.app)) }
        if let releaseNotes { object["releaseNotes"] = .string(releaseNotes) }
        return .object(object)
    }

    static func shouldOfferMove(_ app: URL) -> Bool {
        let path = app.standardizedFileURL.path
        let downloads = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads").path
        return path.hasPrefix(downloads + "/") || path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/")
    }

    func moveToApplications() throws -> URL {
        guard let configuration, Self.shouldOfferMove(configuration.app) else {
            throw BridgeError(.badRequest, "Lima is already in an installed location.")
        }
        let applications = URL(fileURLWithPath: "/Applications", isDirectory: true)
        let target = applications.appendingPathComponent("Lima.app")
        let fm = FileManager.default
        guard !fm.fileExists(atPath: target.path) else {
            throw BridgeError(.badRequest, "Applications already contains Lima. Open that copy from Finder.")
        }
        guard fm.isWritableFile(atPath: applications.path) else {
            throw BridgeError(.notAuthorized, "Move Lima.app to Applications in Finder and reopen it there.")
        }
        let stagingDirectory = applications.appendingPathComponent(".lima-install-\(UUID().uuidString)")
        try fm.createDirectory(at: stagingDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: stagingDirectory) }
        let staging = stagingDirectory.appendingPathComponent("Lima.app")
        try fm.copyItem(at: configuration.app, to: staging)
        try UpdateVerifier.appSatisfiesInstalledRequirement(staging, installed: configuration.app)
        guard renamex_np(staging.path, target.path, UInt32(RENAME_EXCL)) == 0 else {
            throw BridgeError(.badRequest, "Could not put Lima in Applications. An existing app was preserved.")
        }
        LaunchServices.register(target)
        return target
    }

    var previousApp: URL { directory.appendingPathComponent(UpdateApplier.backupFolder + "/Lima.app") }

    /// Once per version, in the background: moves an older rollback copy into
    /// its .noindex folder and has macOS forget stray copies of Lima (disk
    /// images, translocated copies, update files, copies no longer on disk), so
    /// the default-browser list shows the one installed Lima. Copies the user
    /// keeps elsewhere are left alone.
    func tidyCopies() {
        guard let configuration else { return }
        let fm = FileManager.default
        let marker = directory.appendingPathComponent(".tidied-\(configuration.build)")
        guard !fm.fileExists(atPath: marker.path) else { return }
        let legacy = directory.appendingPathComponent("previous")
        let current = directory.appendingPathComponent(UpdateApplier.backupFolder)
        if fm.fileExists(atPath: legacy.path), !fm.fileExists(atPath: current.path) { try? fm.moveItem(at: legacy, to: current) }
        if let items = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            for item in items where item.lastPathComponent.hasPrefix("staged-") && item.pathExtension != "noindex" { try? fm.removeItem(at: item) }
        }
        let installed = configuration.app.resolvingSymlinksInPath().path
        let strays = LaunchServices.strays(LaunchServices.registered(configuration.bundleIdentifier), installed: installed,
                                           updates: directory.resolvingSymlinksInPath().path)
        LaunchServices.forget(strays.map { URL(fileURLWithPath: $0) })
        LaunchServices.register(configuration.app)
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        fm.createFile(atPath: marker.path, contents: Data())
    }
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
    func check(manual: Bool = true) async throws -> JSONValue {
        guard let configuration else { return status }
        // A staged update keeps checking, so a newer security release
        // replaces it before the user restarts.
        let stagedBuild: Int? = locked { phase == .ready ? feed?.build : nil }
        let started = locked {
            guard [.idle, .failed, .ready].contains(phase) else { return false }
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
            lock.withLock { if feed != nil || stagedBuild == nil { self.feed = feed }; checkedAt = Date() }
            guard let feed else { set(stagedBuild == nil ? .idle : .ready); return status }
            if feed.build == stagedBuild { set(.ready); return status }
            guard Rollout.ready(feed, slot: Rollout.slot(in: directory), manual: manual) else {
                // Not this install's turn yet; a later check (or yours) picks it up.
                set(stagedBuild == nil ? .idle : .ready)
                return status
            }
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
        let staging = directory.appendingPathComponent("staged-\(feed.build).noindex")
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let url = URL(string: feed.url) else { throw BridgeError(.badRequest, "The update feed is malformed.") }
        if let chunks = feed.chunks, await downloadChunks(chunks, feed: feed, configuration: configuration, staging: staging, session: session) {
            return
        }
        let archive = staging.appendingPathComponent("Lima.zip")
        let response = try await downloadWithProgress(url, to: archive, expectedBytes: feed.bytes, session: session)
        set(.verifying)
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
        UpdateApplier.releaseFromQuarantine(app)
        // A downloaded copy is never another browser on this Mac.
        LaunchServices.forget([app])
        guard unzip.terminationStatus == 0,
              (try? fm.destinationOfSymbolicLink(atPath: app.path)) == nil,
              let identity = UpdateVerifier.bundleBuild(app),
              identity.identifier == configuration.bundleIdentifier, identity.build == feed.build
        else { throw BridgeError(.badRequest, "The update archive doesn't contain Lima \(feed.version).") }
        try UpdateVerifier.appSatisfiesInstalledRequirement(app, installed: configuration.app)
        lock.withLock { staged = app }
        set(.ready)
    }

    /// The smaller download: builds the new app from the chunks it already has
    /// plus the ones it fetches. False (after cleaning up) means use the zip:
    /// the manifest or a chunk didn't check out, or it would save little.
    private func downloadChunks(_ chunks: FeedChunks, feed: UpdateFeed, configuration: UpdateConfiguration,
                                staging: URL, session: URLSession) async -> Bool {
        let app = staging.appendingPathComponent("Lima.app")
        do {
            guard let manifestURL = URL(string: chunks.manifest), let base = URL(string: chunks.base),
                  manifestURL.scheme == "https", base.scheme == "https" else { return false }
            let (data, response) = try await session.data(from: manifestURL)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  data.withUnsafeBytes(Chunks.digest) == chunks.sha256 else { return false }
            let manifest = try JSONDecoder().decode(ChunkManifest.self, from: data)
            let installed = ChunkUpdate.index(configuration.app)
            let plan = manifest.download(from: installed)
            // Mostly new (an engine update): one zip is simpler than hundreds of requests.
            guard Double(plan.bytes) < Double(feed.bytes) * 0.7 else { return false }
            try await ChunkUpdate.assemble(manifest, into: app, installed: installed, fetch: { digest in
                let (bytes, reply) = try await session.data(from: base.appendingPathComponent("\(digest).z"))
                guard (reply as? HTTPURLResponse)?.statusCode == 200 else { throw BridgeError(.internalError, "An update chunk is missing.") }
                return bytes
            }, progress: { [weak self] fraction in
                guard let self else { return }
                self.lock.withLock { self.progress = fraction }
                self.emit?(self.status)
            })
            set(.verifying)
            UpdateApplier.releaseFromQuarantine(app)
            LaunchServices.forget([app])
            guard let identity = UpdateVerifier.bundleBuild(app), identity.identifier == configuration.bundleIdentifier,
                  identity.build == feed.build else { throw BridgeError(.badRequest, "The assembled update isn't Lima \(feed.version).") }
            try UpdateVerifier.appSatisfiesInstalledRequirement(app, installed: configuration.app)
            lock.withLock { staged = app }
            Support.record("update: assembled \(feed.version) from chunks, downloading \(plan.bytes / 1_048_576) MB of \(feed.bytes / 1_048_576) MB")
            set(.ready)
            return true
        } catch {
            try? FileManager.default.removeItem(at: app)
            Support.record("update: chunked download of \(feed.version) failed (\(error)); using the full download")
            set(.downloading)
            return false
        }
    }

    /// Downloads to `destination`, reporting progress about twice a second.
    private func downloadWithProgress(_ url: URL, to destination: URL, expectedBytes: Int, session: URLSession) async throws -> URLResponse {
        let box = DownloadTaskBox()
        let ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let task = box.task, let self else { continue }
                let total = task.countOfBytesExpectedToReceive > 0 ? Double(task.countOfBytesExpectedToReceive) : Double(expectedBytes)
                guard total > 0 else { continue }
                let fraction = min(1, Double(task.countOfBytesReceived) / total)
                if abs(fraction - (self.locked { self.progress ?? -1 })) >= 0.01 {
                    self.locked { self.progress = fraction }
                    self.emit?(self.status)
                }
            }
        }
        defer { ticker.cancel(); locked { progress = nil } }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URLResponse, Error>) in
                let task = session.downloadTask(with: url) { temporary, response, error in
                    if let error { continuation.resume(throwing: error); return }
                    guard let temporary, let response else {
                        continuation.resume(throwing: BridgeError(.internalError, "The update server closed the download.")); return
                    }
                    do {
                        try? FileManager.default.removeItem(at: destination)
                        try FileManager.default.moveItem(at: temporary, to: destination)
                        continuation.resume(returning: response)
                    } catch { continuation.resume(throwing: error) }
                }
                box.task = task
                locked { progress = 0 }
                task.resume()
            }
        } onCancel: { box.task?.cancel() }
    }

    /// Starts the installer, which waits for `browserPID` to exit, swaps the
    /// bundle, verifies it and relaunches Lima (or restores the old copy).
    /// With `relaunch` false (installing because the user quit Lima), Lima
    /// stays closed and opens updated next time.
    func install(browserPID: pid_t, profilePath: String, relaunch: Bool = true) throws {
        guard let configuration else { throw BridgeError(.badRequest, "Updates are off in development builds.") }
        guard browserPID > 1 else { throw BridgeError(.badRequest, "browserPid is required.") }
        let profile = try UpdateApplier.profile(path: profilePath, outside: [configuration.app, directory])
        guard let staged = locked({
            guard phase == .ready, let staged else { return nil as URL? }
            phase = .installing
            return staged
        }) else { throw BridgeError(.badRequest, "No update is ready.") }
        do {
            try launchApplier(source: staged, configuration: configuration, browserPID: browserPID, profile: profile, keepBackup: true, relaunch: relaunch)
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
        let restore = directory.appendingPathComponent(UpdateApplier.restoreFolder + "/Lima.app")
        try? FileManager.default.removeItem(at: restore.deletingLastPathComponent())
        try FileManager.default.createDirectory(at: restore.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.copyItem(at: previousApp, to: restore)
        try launchApplier(source: restore, configuration: configuration, browserPID: browserPID, profile: profile, keepBackup: false)
        set(.installing)
    }

    private func launchApplier(source: URL, configuration: UpdateConfiguration, browserPID: pid_t, profile: URL, keepBackup: Bool, relaunch: Bool = true) throws {
        let parent = configuration.app.deletingLastPathComponent()
        // Still translocated only if the installed app couldn't be found behind the copy.
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
                            (keepBackup ? ["--keep-backup"] : []) + (relaunch ? [] : ["--no-relaunch"])
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
        // No `-n`: if Lima is already open again (the user clicked it during
        // the install), bring that one forward instead of starting a second
        // copy on the same profile.
        return ["-a", target.path] + overrides + ["--args", "-profile", profile.path]
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
        // The runtime that started this install runs the old code from the
        // old bundle; it's replaced once the new app is in place.
        let runtimePID = getppid()
        setsid()
        let keepBackup = arguments.contains("--keep-backup")
        let requirement = try? UpdateVerifier.installedRequirement(target)
        let result = apply(source: source, target: target, state: state, waitFor: pid, keepBackup: keepBackup)
        func record(_ error: String?) {
            let result: [String: Any] = ["ok": error == nil, "error": error ?? NSNull(), "at": Date().timeIntervalSince1970 * 1000,
                                         "kind": keepBackup ? "update" : "rollback",
                                         "build": UpdateVerifier.bundleBuild(target)?.build ?? 0]
            if let data = try? JSONSerialization.data(withJSONObject: result) {
                try? data.write(to: state.appendingPathComponent("last-install.json"), options: .atomic)
            }
        }
        record(result)
        print("lima-host apply-update: \(result ?? "installed")")
        // Installed because the user quit: Lima opens updated next time.
        if arguments.contains("--no-relaunch") { exit(result == nil ? 0 : 1) }
        guard kill(pid, 0) != 0, let requirement, (try? UpdateVerifier.verifyApp(target, requirement: requirement)) != nil else { exit(1) }
        if result == nil { retireOldProcesses(target: target, runtimePID: runtimePID) }
        forgetStaleCopies(source: source, state: state, target: target)
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
    /// Before reopening: the old runtime (still running the old code) exits,
    /// so macOS sees one Lima rather than an old copy beside the new one.
    /// The new browser starts a new runtime.
    static func retireOldProcesses(target: URL, runtimePID: pid_t) {
        guard runtimePID > 1, let code = CodeTrust.code(pid: runtimePID),
              CodeTrust.path(of: code).map({ $0.hasSuffix("/Contents/MacOS/lima-host") }) == true else { return }
        kill(runtimePID, SIGTERM)
        for _ in 0..<50 where kill(runtimePID, 0) == 0 { usleep(100_000) }
    }

    /// The old app's processes other than lima-host (this installer and the runtime).
    static func lingeringHelpers(in target: URL) -> [pid_t] {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        return processes(inside: target).filter { pid in
            guard pid != getpid(), proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
            return !String(cString: buffer).hasSuffix("/Contents/MacOS/lima-host")
        }
    }

    /// PIDs whose executable is inside `bundle` (or a copy swapped out of it).
    static func processes(inside bundle: URL) -> [pid_t] {
        let prefix = bundle.resolvingSymlinksInPath().path + "/"
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return [] }
        var pids = [pid_t](repeating: 0, count: Int(count) + 32)
        let filled = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        return pids.prefix(Int(max(0, filled))).filter { pid in
            guard pid > 0, proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
            return String(cString: buffer).hasPrefix(prefix)
        }
    }

    /// Where the rollback copy and a restore in progress live. ".noindex"
    /// keeps Spotlight, and so Launch Services, from finding them.
    static let backupFolder = "previous.noindex"
    static let restoreFolder = "restore.noindex"

    /// Launch Services forgets the downloaded and rollback copies, so a
    /// later launch can't pick (or ask about) an older Lima, and macOS's
    /// default-browser list shows only the installed one.
    static func forgetStaleCopies(source: URL, state: URL, target: URL) {
        LaunchServices.forget([source] + [backupFolder, restoreFolder, "previous", "restore"].map {
            state.appendingPathComponent($0 + "/Lima.app")
        })
        LaunchServices.register(target)
    }

    /// Clears macOS's download quarantine from a verified bundle. A copy that
    /// still carries it (inherited from the first download's install) opens
    /// translocated: Gatekeeper asks again whether to open an app downloaded
    /// from the Internet, and the browser, finding itself in a read-only
    /// copy, offers to open the installed Lima instead. The signature and
    /// notarization are what Lima trusts, and they're checked either way.
    static func releaseFromQuarantine(_ bundle: URL) {
        let name = "com.apple.quarantine"
        _ = removexattr(bundle.path, name, XATTR_NOFOLLOW)
        guard let items = FileManager.default.enumerator(at: bundle, includingPropertiesForKeys: nil) else { return }
        for case let item as URL in items { _ = removexattr(item.path, name, XATTR_NOFOLLOW) }
    }

    static func apply(source: URL, target: URL, state: URL, waitFor pid: pid_t, keepBackup: Bool) -> String? {
        let fm = FileManager.default
        guard source.resolvingSymlinksInPath() != target.resolvingSymlinksInPath() else {
            return "The replacement app is already at the installation path."
        }
        // Wait (up to two minutes) for the browser to quit.
        for _ in 0..<1200 where kill(pid, 0) == 0 { usleep(100_000) }
        guard kill(pid, 0) != 0 else { return "Lima didn't quit, so the update wasn't installed." }
        // Web content, GPU and media helpers can outlive the browser for a
        // moment; swap only once they're gone (the runtime is retired after).
        for _ in 0..<100 where !lingeringHelpers(in: target).isEmpty { usleep(100_000) }

        do { try UpdateVerifier.appSatisfiesInstalledRequirement(source, installed: target) } catch {
            return (error as? BridgeError)?.message ?? "\(error)"
        }
        let backup = state.appendingPathComponent(backupFolder + "/Lima.app")
        let swapDirectory = target.deletingLastPathComponent().appendingPathComponent(".lima-replace-\(UUID().uuidString)")
        let pending = swapDirectory.appendingPathComponent("Lima.app")
        var preserveSwap = false
        defer { if !preserveSwap { try? fm.removeItem(at: swapDirectory) } }
        do {
            try fm.createDirectory(at: swapDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try fm.copyItem(at: source, to: pending)
            releaseFromQuarantine(pending)
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
            let next = state.appendingPathComponent("previous-\(UUID().uuidString).noindex")
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
        let service = updates
        Task.detached(priority: .background) { service.tidyCopies() }
        register("update.status") { [unowned self] _, context in
            try Self.requireLocalSettings(context)
            return self.updates.status
        }
        register("update.check") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            let service = self.updates
            let manual = params?["manual"]?.boolValue == true
            Task { _ = try? await service.check(manual: manual) }
            return service.status
        }
        register("update.install") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            let chats = await self.conversations.list()
            let shells = await self.terminals.list()
            guard !chats.contains(where: \.running), !shells.contains(where: {
                $0.state == .running || $0.state == .waitingForInput || $0.userEditing == true
            }) else { throw BridgeError(.badRequest, "Finish active agents and terminal commands before restarting Lima.") }
            try self.updates.install(browserPID: pid_t(params?["browserPid"]?.doubleValue ?? 0), profilePath: try params.string("profilePath"),
                                     relaunch: params?["relaunch"]?.boolValue ?? true)
            return self.updates.status
        }
        register("update.moveToApplications") { [unowned self] _, context in
            try Self.requireLocalSettings(context)
            let target = try self.updates.moveToApplications()
            return .object(["path": .string(target.path)])
        }
        register("update.rollback") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            try self.updates.rollback(browserPID: pid_t(params?["browserPid"]?.doubleValue ?? 0), profilePath: try params.string("profilePath"))
            return self.updates.status
        }
    }
}

/// macOS's app registry (Launch Services). Every copy of Lima it knows about
/// can appear in the default-browser list as another "Lima (5.0.x)".
enum LaunchServices {
    static let tool = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

    private static func run(_ arguments: [String]) -> Data {
        guard FileManager.default.isExecutableFile(atPath: tool) else { return Data() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return Data() }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return data
    }

    static func forget(_ apps: [URL]) { for app in apps { _ = run(["-u", app.path]) } }
    static func register(_ app: URL) { _ = run(["-f", app.path]) }

    /// Registered copies of `identifier`, from the registry's dump.
    static func registered(_ identifier: String) -> [String] {
        var paths: [String] = []
        var path: String?
        for line in String(decoding: run(["-dump"]), as: UTF8.self).split(separator: "\n") {
            if line.hasPrefix("path:") {
                path = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: #" \(0x[0-9a-f]+\)$"#, with: "", options: .regularExpression)
            } else if line.hasPrefix("identifier:"), line.dropFirst(11).trimmingCharacters(in: .whitespaces) == identifier, let path {
                paths.append(path)
            }
        }
        return Array(Set(paths)).sorted()
    }

    /// Copies Lima can forget without touching one the user keeps: gone from
    /// disk, on a disk image, a translocated copy, or Lima's own update files.
    static func strays(_ paths: [String], installed: String, updates: String) -> [String] {
        paths.filter { path in
            path != installed && (path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/") || path.hasPrefix(updates + "/")
                || !FileManager.default.fileExists(atPath: path))
        }
    }
}
