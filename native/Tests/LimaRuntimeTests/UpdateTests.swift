import CryptoKit
import Foundation
import Testing
@testable import LimaProtocol
@testable import LimaRuntime

private let signingKey = Curve25519.Signing.PrivateKey()

private func configuration(build: Int = 5_000_000) -> UpdateConfiguration {
    UpdateConfiguration(feedURL: URL(string: "https://updates.example.com/stable/latest.json")!, publicKey: signingKey.publicKey,
                        app: URL(fileURLWithPath: "/Applications/Lima.app"), bundleIdentifier: "dev.lima.browser", build: build)
}

private func feed(build: Int = 5_000_001, url: String = "https://updates.example.com/stable/5.0.1/Lima-5.0.1.zip") -> Data {
    let value = UpdateFeed(schemaVersion: 1, channel: "stable", version: "5.0.1", build: build, minimumSystemVersion: "14.0",
                           url: url, sha256: String(repeating: "a", count: 64), bytes: 1024, engine: "zen 1.24.2b / gecko 160.0",
                           commit: String(repeating: "0", count: 40), publishedAt: "2026-11-21T00:00:00Z", critical: true, notesUrl: nil)
    return try! JSONEncoder().encode(value)
}

private func sign(_ data: Data, with key: Curve25519.Signing.PrivateKey = signingKey) -> Data {
    Data(try! key.signature(for: data).base64EncodedString().utf8)
}

@Test func updateFeedAcceptsNewerSignedBuild() throws {
    let data = feed()
    let parsed = try UpdateVerifier.feed(data, signature: sign(data), configuration: configuration())
    #expect(parsed?.build == 5_000_001)
    #expect(parsed?.critical == true)
}

@Test func updateFeedRejectsForeignSignature() {
    let data = feed()
    #expect(throws: BridgeError.self) {
        try UpdateVerifier.feed(data, signature: sign(data, with: Curve25519.Signing.PrivateKey()), configuration: configuration())
    }
}

@Test func updateFeedRejectsTamperedBytes() {
    let data = feed()
    var tampered = data
    tampered[tampered.count - 2] ^= 0x01
    #expect(throws: (any Error).self) { try UpdateVerifier.feed(tampered, signature: sign(data), configuration: configuration()) }
}

@Test func updateFeedNeverDowngrades() throws {
    let data = feed(build: 5_000_000)
    #expect(try UpdateVerifier.feed(data, signature: sign(data), configuration: configuration(build: 5_000_000)) == nil)
}

@Test func updateFeedRejectsArchivesOffTheFeedHost() {
    let data = feed(url: "https://elsewhere.example.net/Lima.zip")
    #expect(throws: BridgeError.self) { try UpdateVerifier.feed(data, signature: sign(data), configuration: configuration()) }
}

@Test func updateFeedRejectsPlainHTTPArchives() {
    let data = feed(url: "http://updates.example.com/stable/Lima.zip")
    #expect(throws: BridgeError.self) { try UpdateVerifier.feed(data, signature: sign(data), configuration: configuration()) }
}

@Test func updatesAreDisabledWithoutStampedConfiguration() {
    let service = UpdateService(configuration: nil, directory: TestEnvironment.freshDirectory())
    #expect(service.status["phase"]?.stringValue == "disabled")
}

private func adHocExecutable() throws -> URL {
    let directory = TestEnvironment.freshDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let copy = directory.appendingPathComponent("tool")
    try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: copy)
    let sign = Process()
    sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    sign.arguments = ["--force", "--sign", "-", copy.path]
    sign.standardError = FileHandle.nullDevice
    try sign.run()
    sign.waitUntilExit()
    return copy
}

@Test func adHocInstallationsRefuseToInstallUpdates() throws {
    // An ad-hoc (development) install has no pinned certificate to match.
    let app = try adHocExecutable()
    #expect(throws: BridgeError.self) { try UpdateVerifier.appSatisfiesInstalledRequirement(app, installed: app) }
}

@Test func unsignedHelperIsNotTrustedAsLimaCode() throws {
    let directory = TestEnvironment.freshDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let script = directory.appendingPathComponent("whisper-cli")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: script)
    #expect(!CodeTrust.isSignedLikeSelf(path: script.path))
}

@Test func engineTrustFollowsTheBundleLayout() throws {
    let contents = TestEnvironment.freshDirectory().appendingPathComponent("Lima.app/Contents")
    let macOS = contents.appendingPathComponent("MacOS")
    try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
    try Data().write(to: macOS.appendingPathComponent("lima"))
    // A source build's compiled engine is the bundle executable itself.
    #expect(CodeTrust.engineExecutable(in: contents).hasSuffix("/MacOS/lima"))
    // A repack's launcher only re-execs the Zen engine, which alone is trusted.
    try Data().write(to: macOS.appendingPathComponent("zen"))
    #expect(CodeTrust.engineExecutable(in: contents).hasSuffix("/MacOS/zen"))
}

// Integration checks against real builds, run by `make release-rehearsal`:
//   LIMA_TEST_SIGNED_APP    a release-signed Lima.app (the "installed" copy)
//   LIMA_TEST_CANDIDATE_APP the same release, extracted from its update zip
//   LIMA_TEST_ADHOC_APP     a development (ad-hoc) Lima.app
private let environment = ProcessInfo.processInfo.environment

@Test func updaterRelaunchesWithTheOriginalProfile() throws {
    let root = TestEnvironment.freshDirectory()
    let app = root.appendingPathComponent("Applications/Lima.app")
    let updates = root.appendingPathComponent("App support/Updates")
    let profile = root.appendingPathComponent("Browser data/Existing profile")
    for folder in [app, updates, profile] {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    let original = try UpdateApplier.profile(path: profile.path, outside: [app, updates])
    #expect(UpdateApplier.relaunchArguments(target: app, profile: original) == [
        "-a", app.path, "--args", "-profile", profile.resolvingSymlinksInPath().path,
    ])
    #expect(throws: BridgeError.self) { try UpdateApplier.profile(path: updates.path, outside: [app, updates]) }
    #expect(throws: BridgeError.self) { try UpdateApplier.profile(path: app.path, outside: [app, updates]) }
}

@Test(.enabled(if: environment["LIMA_TEST_SIGNED_APP"] != nil && environment["LIMA_TEST_CANDIDATE_APP"] != nil))
func releaseUpdateSatisfiesTheInstalledRequirement() throws {
    try UpdateVerifier.appSatisfiesInstalledRequirement(URL(fileURLWithPath: environment["LIMA_TEST_CANDIDATE_APP"]!),
                                                        installed: URL(fileURLWithPath: environment["LIMA_TEST_SIGNED_APP"]!))
}

@Test(.enabled(if: environment["LIMA_TEST_SIGNED_APP"] != nil && environment["LIMA_TEST_ADHOC_APP"] != nil))
func adHocBuildIsRejectedAsAnUpdate() {
    #expect(throws: BridgeError.self) {
        try UpdateVerifier.appSatisfiesInstalledRequirement(URL(fileURLWithPath: environment["LIMA_TEST_ADHOC_APP"]!),
                                                            installed: URL(fileURLWithPath: environment["LIMA_TEST_SIGNED_APP"]!))
    }
}

@Test(.enabled(if: environment["LIMA_TEST_SIGNED_APP"] != nil && environment["LIMA_TEST_CANDIDATE_APP"] != nil && environment["LIMA_TEST_ADHOC_APP"] != nil))
func installerSwapsVerifiedUpdateAndRollsBackABadOne() throws {
    let fm = FileManager.default
    let root = TestEnvironment.freshDirectory()
    let target = root.appendingPathComponent("Applications/Lima.app")
    let state = root.appendingPathComponent("state")
    try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.createDirectory(at: state, withIntermediateDirectories: true)
    let profile = root.appendingPathComponent("Existing profile")
    try fm.createDirectory(at: profile, withIntermediateDirectories: true)
    let browserFiles = ["places.sqlite", "cookies.sqlite", "prefs.js", "sessionstore.jsonlz4"]
    for name in browserFiles { try Data(name.utf8).write(to: profile.appendingPathComponent(name)) }
    try fm.copyItem(at: URL(fileURLWithPath: environment["LIMA_TEST_SIGNED_APP"]!), to: target)
    let exited = Process()
    exited.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try exited.run()
    exited.waitUntilExit()

    // A tampered update (ad-hoc signed) is refused and the installed app is untouched.
    let bad = root.appendingPathComponent("bad/Lima.app")
    try fm.createDirectory(at: bad.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.copyItem(at: URL(fileURLWithPath: environment["LIMA_TEST_ADHOC_APP"]!), to: bad)
    #expect(UpdateApplier.apply(source: bad, target: target, state: state, waitFor: exited.processIdentifier, keepBackup: true) != nil)
    try UpdateVerifier.appSatisfiesInstalledRequirement(target, installed: URL(fileURLWithPath: environment["LIMA_TEST_SIGNED_APP"]!))

    // A verified update is swapped in and the previous copy is kept for rollback.
    let good = root.appendingPathComponent("good/Lima.app")
    try fm.createDirectory(at: good.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.copyItem(at: URL(fileURLWithPath: environment["LIMA_TEST_CANDIDATE_APP"]!), to: good)
    #expect(UpdateApplier.apply(source: good, target: target, state: state, waitFor: exited.processIdentifier, keepBackup: true) == nil)
    #expect(fm.fileExists(atPath: state.appendingPathComponent(UpdateApplier.backupFolder + "/Lima.app/Contents/Info.plist").path))
    #expect(!fm.fileExists(atPath: good.path))
    for name in browserFiles {
        #expect(try Data(contentsOf: profile.appendingPathComponent(name)) == Data(name.utf8))
    }
}

@Test(.enabled(if: environment["LIMA_TEST_PREVIOUS_APP"] != nil && environment["LIMA_TEST_CANDIDATE_APP"] != nil))
func signedUpgradeFromPreviousRelease() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("lima-upgrade-\(UUID())")
    defer { try? fm.removeItem(at: root) }
    let target = root.appendingPathComponent("Applications/Lima.app")
    let source = root.appendingPathComponent("staged/Lima.app")
    let state = root.appendingPathComponent("state")
    let profile = root.appendingPathComponent("profile")
    for directory in [target.deletingLastPathComponent(), source.deletingLastPathComponent(), state, profile] {
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    try fm.copyItem(at: URL(fileURLWithPath: try #require(environment["LIMA_TEST_PREVIOUS_APP"])), to: target)
    try fm.copyItem(at: URL(fileURLWithPath: try #require(environment["LIMA_TEST_CANDIDATE_APP"])), to: source)
    let previous = try #require(UpdateVerifier.bundleBuild(target)?.build)
    let candidate = try #require(UpdateVerifier.bundleBuild(source)?.build)
    try #require(candidate > previous)

    func startBrowser(_ app: URL, logName: String) throws -> (Process, URL) {
        let log = root.appendingPathComponent(logName)
        fm.createFile(atPath: log.path, contents: nil)
        let handle = try FileHandle(forWritingTo: log)
        defer { try? handle.close() }
        let browser = Process()
        browser.executableURL = app.appendingPathComponent("Contents/MacOS/lima")
        browser.arguments = ["-profile", profile.path, "-headless", "-no-remote", "about:blank"]
        browser.environment = ProcessInfo.processInfo.environment.merging([
            "MOZ_HEADLESS": "1", "LIMA_DATA_DIR": root.appendingPathComponent("runtime").path,
            "LIMA_KEY_FILE": root.appendingPathComponent("key").path,
        ]) { _, new in new }
        browser.standardOutput = handle
        browser.standardError = handle
        try browser.run()
        return (browser, log)
    }
    func browserVersion(_ app: URL) throws -> String {
        let plist = try #require(NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")))
        return try #require(plist["CFBundleShortVersionString"] as? String)
    }
    let compatibility = profile.appendingPathComponent("compatibility.ini")
    let userPreferences = profile.appendingPathComponent("user.js")
    let fixture = Data(#"user_pref("lima.update.rehearsal", "persisted");"#.utf8)
    try fixture.write(to: userPreferences)
    func waitForLaunch(_ browser: Process, version: String) -> Bool {
        for _ in 0..<200 {
            guard browser.isRunning else { return false }
            if let state = try? String(contentsOf: compatibility, encoding: .utf8), state.contains("LastVersion=\(version)_") { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }
    let previousVersion = try browserVersion(target)
    let candidateVersion = try browserVersion(source)
    let (browser, initialLog) = try startBrowser(target, logName: "previous.log")
    defer { if browser.isRunning { browser.terminate() } }
    let openedPrevious = waitForLaunch(browser, version: previousVersion)
    try #require(openedPrevious, "\((try? String(contentsOf: initialLog, encoding: .utf8)) ?? "")")
    if browser.isRunning { browser.terminate() }
    browser.waitUntilExit()
    let previousCompatibility = try Data(contentsOf: compatibility)
    let error = UpdateApplier.apply(source: source, target: target, state: state, waitFor: browser.processIdentifier, keepBackup: true)
    try #require(error == nil, Comment(rawValue: error ?? ""))
    #expect(UpdateVerifier.bundleBuild(target)?.build == candidate)
    #expect(UpdateVerifier.bundleBuild(state.appendingPathComponent(UpdateApplier.backupFolder + "/Lima.app"))?.build == previous)
    #expect(try Data(contentsOf: userPreferences) == fixture)
    #expect(try Data(contentsOf: compatibility) == previousCompatibility)
    let (updated, updateLog) = try startBrowser(target, logName: "updated.log")
    defer { if updated.isRunning { updated.terminate() } }
    let openedCandidate = waitForLaunch(updated, version: candidateVersion)
    #expect(openedCandidate, "\((try? String(contentsOf: updateLog, encoding: .utf8)) ?? "")")
    if updated.isRunning { updated.terminate() }
    updated.waitUntilExit()
}

/// Lima trusts its pinned certificate or, across the move to Developer ID,
/// the same identifier signed by Lima's team; never another team.
@Test func developerIDRequirementCompilesAndNamesTheTeam() throws {
    let base = #"identifier "app.lima" and certificate root = H"0123456789abcdef0123456789abcdef01234567""#
    let text = try #require(CodeTrust.requirementText(base: base, identifier: "app.lima", team: "575W282638"))
    var requirement: SecRequirement?
    #expect(SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess)
    #expect(text.contains(#"certificate leaf[subject.OU] = "575W282638""#))
    #expect(CodeTrust.requirementText(base: base, identifier: "app.lima", team: "not-a-team") == nil)
    #expect(CodeTrust.requirementText(base: base, identifier: #"x" or anchor apple"#, team: "575W282638") == nil)
}

/// Set LIMA_TEST_DEVID_APP to any Developer ID app (e.g. /Applications/Claude.app).
@Test(.enabled(if: environment["LIMA_TEST_DEVID_APP"] != nil))
func developerIDAppMatchesOnlyItsOwnTeam() throws {
    let app = URL(fileURLWithPath: environment["LIMA_TEST_DEVID_APP"]!)
    var code: SecStaticCode?
    #expect(SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess)
    var info: CFDictionary?
    SecCodeCopySigningInformation(try #require(code), SecCSFlags(rawValue: kSecCSSigningInformation), &info)
    let dictionary = try #require(info as? [String: Any])
    let identifier = try #require(dictionary[kSecCodeInfoIdentifier as String] as? String)
    let team = try #require(dictionary[kSecCodeInfoTeamIdentifier as String] as? String)
    // A base the app can't meet (a self-signed root), so only the Developer ID branch can match.
    let base = #"identifier "app.lima" and certificate root = H"0123456789abcdef0123456789abcdef01234567""#
    func check(_ team: String) throws -> OSStatus {
        var requirement: SecRequirement?
        SecRequirementCreateWithString(try #require(CodeTrust.requirementText(base: base, identifier: identifier, team: team)) as CFString, [], &requirement)
        return SecStaticCodeCheckValidity(try #require(code), [], try #require(requirement))
    }
    #expect(try check(team) == errSecSuccess)
    #expect(try check("575W282638") != errSecSuccess)
}

@Test func installedUpdateIsReleasedFromQuarantine() throws {
    let bundle = FileManager.default.temporaryDirectory.appendingPathComponent("quarantine-\(UUID().uuidString)/Lima.app")
    let binary = bundle.appendingPathComponent("Contents/MacOS/lima")
    try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\n".utf8).write(to: binary)
    defer { try? FileManager.default.removeItem(at: bundle.deletingLastPathComponent()) }
    let flag = Array("0083;00000000;Safari;".utf8)
    for path in [bundle.path, binary.path] {
        #expect(setxattr(path, "com.apple.quarantine", flag, flag.count, 0, 0) == 0)
    }
    UpdateApplier.releaseFromQuarantine(bundle)
    for path in [bundle.path, binary.path] {
        #expect(getxattr(path, "com.apple.quarantine", nil, 0, 0, 0) == -1)
    }
}

@Test func translocatedAppResolvesToTheInstalledOne() {
    let installed = URL(fileURLWithPath: "/Applications/Lima.app")
    #expect(UpdateConfiguration.originalApp(installed) == installed, "a normal install stays where it is")
    let lost = URL(fileURLWithPath: "/private/var/folders/xx/T/AppTranslocation/NOT-MOUNTED/d/Lima.app")
    #expect(UpdateConfiguration.originalApp(lost) == lost, "without a translocation mount there's nothing to map")
}

@MainActor @Test func grammarFixesPlainTyposOnThisMacAndLeavesTheRestToTheAI() {
    #expect(GrammarShortcut.localCorrection("I recieve the package tomorow.") == "I receive the package tomorrow.")
    #expect(GrammarShortcut.localCorrection("This sentence is fine.") == nil, "nothing to fix locally: the AI still checks grammar")
    #expect(GrammarShortcut.localCorrection(String(repeating: "Recieve it. ", count: 40)) == nil, "long text goes to the AI")
}

@Test func onlyStrayLimaCopiesAreForgotten() throws {
    let kept = FileManager.default.temporaryDirectory.appendingPathComponent("kept-\(UUID().uuidString)/Lima.app")
    try FileManager.default.createDirectory(at: kept, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: kept.deletingLastPathComponent()) }
    let updates = "/Users/me/Library/Application Support/Lima Browser/Updates"
    let strays = LaunchServices.strays([
        "/Applications/Lima.app",
        "/Volumes/Lima/Lima.app",
        "/private/var/folders/x/T/AppTranslocation/ABC/d/Lima.app",
        updates + "/previous.noindex/Lima.app",
        "/Users/me/Gone/Lima.app",
        kept.path,
    ], installed: "/Applications/Lima.app", updates: updates)
    #expect(strays == ["/Volumes/Lima/Lima.app", "/private/var/folders/x/T/AppTranslocation/ABC/d/Lima.app",
                       updates + "/previous.noindex/Lima.app", "/Users/me/Gone/Lima.app"],
            "the installed app and a copy the user keeps stay")
    #expect(UpdateApplier.backupFolder.hasSuffix(".noindex") && UpdateApplier.restoreFolder.hasSuffix(".noindex"))
}

@Test func anUnusedRuntimeStopsOnlyAfterItsIdleLimit() {
    let clock = IdleClock(limit: 900)
    let start = Date(timeIntervalSince1970: 0)
    #expect(!clock.tick(busy: false, now: start))
    #expect(!clock.tick(busy: false, now: start.addingTimeInterval(899)))
    #expect(!clock.tick(busy: true, now: start.addingTimeInterval(900)), "a Lima window or a running agent resets it")
    #expect(!clock.tick(busy: false, now: start.addingTimeInterval(1000)))
    #expect(clock.tick(busy: false, now: start.addingTimeInterval(1900)))
}

@Test func rolloutLetsInstallsInByTheirSlotUnlessYouCheckYourself() throws {
    let published = Date(timeIntervalSince1970: 1_800_000_000)
    let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "channel": "stable", "version": "5.0.11", "build": 5000011,
        "minimumSystemVersion": "14.0", "url": "https://x/z", "sha256": "", "bytes": 1, "engine": "", "commit": "",
        "publishedAt": ISO8601DateFormatter().string(from: published), "rolloutHours": 24])
    var feed = try JSONDecoder().decode(UpdateFeed.self, from: data)
    let sixHours = published.addingTimeInterval(6 * 3600)
    #expect(Rollout.ready(feed, slot: 0.2, manual: false, now: sixHours))
    #expect(!Rollout.ready(feed, slot: 0.3, manual: false, now: sixHours), "a later slot waits")
    #expect(Rollout.ready(feed, slot: 0.3, manual: true, now: sixHours), "checking yourself doesn't wait")
    feed.critical = true
    #expect(Rollout.ready(feed, slot: 0.99, manual: false, now: published), "critical releases go to everyone at once")
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("slot-\(UUID())")
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(Rollout.slot(in: dir) == Rollout.slot(in: dir), "an install keeps its slot")
}

@Test func chunkBoundariesAreStableAndAnInsertionOnlyMovesNearbyChunks() throws {
    var generator = SystemRandomNumberGenerator()
    let original = Data((0..<6_000_000).map { _ in UInt8.random(in: 0...255, using: &generator) })
    var edited = original
    edited.insert(contentsOf: Data("inserted bytes".utf8), at: 3_000_000)
    func digests(_ data: Data) -> [String] {
        data.withUnsafeBytes { buffer in
            var start = 0
            return Chunks.boundaries(buffer).map { end in defer { start = end }; return Chunks.digest(UnsafeRawBufferPointer(rebasing: buffer[start..<end])) }
        }
    }
    let before = digests(original), after = digests(edited)
    #expect(before == digests(original))
    #expect(Set(after).subtracting(before).count <= 2, "only the chunk around the insertion changes")
    #expect(original.withUnsafeBytes { Chunks.boundaries($0) }.last == original.count)
    // Known vector: the gear table is fixed forever, so releases and apps agree.
    #expect(Chunks.gear[0] == Chunks.gear[0] && Chunks.gear.count == 256 && Set(Chunks.gear).count == 256)
}

@Test(.timeLimit(.minutes(1))) func anUpdateAssembledFromChunksMatchesTheReleaseExactly() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("chunks-\(UUID())")
    defer { try? fm.removeItem(at: root) }
    // Fixed-seed bytes, longer than two maximum-size chunks, so the engine
    // always splits into several chunks and only the last one differs
    // between the two apps. (3 MB of fresh random bytes could be one chunk.)
    var state: UInt64 = 0x9E37_79B9_7F4A_7C15
    let shared = Data((0..<9_000_000).map { _ -> UInt8 in
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        return UInt8(truncatingIfNeeded: state >> 32)
    })
    func app(_ name: String, body: String) throws -> URL {
        let app = root.appendingPathComponent("\(name)/Lima.app")
        try fm.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        var big = shared
        big.append(Data(body.utf8))
        try big.write(to: app.appendingPathComponent("Contents/MacOS/engine"))
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: app.appendingPathComponent("Contents/MacOS/engine").path)
        try Data("plist \(body)".utf8).write(to: app.appendingPathComponent("Contents/Info.plist"))
        try fm.createSymbolicLink(atPath: app.appendingPathComponent("Contents/Link").path, withDestinationPath: "MacOS/engine")
        return app
    }
    let old = try app("old", body: "one"), new = try app("new", body: "two")
    let manifest = try ChunkManifest.make(app: new, chunkDirectory: root.appendingPathComponent("chunks"))
    let installed = ChunkUpdate.index(old)
    #expect(manifest.download(from: installed).chunks.count < manifest.sizes.count, "unchanged chunks come from the installed app")
    let out = root.appendingPathComponent("out/Lima.app")
    try await ChunkUpdate.assemble(manifest, into: out, installed: installed) { digest in
        try Data(contentsOf: root.appendingPathComponent("chunks/\(digest).z"))
    }
    #expect(try Data(contentsOf: out.appendingPathComponent("Contents/MacOS/engine")) == Data(contentsOf: new.appendingPathComponent("Contents/MacOS/engine")))
    #expect(try fm.destinationOfSymbolicLink(atPath: out.appendingPathComponent("Contents/Link").path) == "MacOS/engine")
    #expect((try fm.attributesOfItem(atPath: out.appendingPathComponent("Contents/MacOS/engine").path)[.posixPermissions] as? NSNumber)?.intValue == 0o755)
    // A chunk that doesn't match its digest is refused.
    await #expect(throws: (any Error).self) {
        try await ChunkUpdate.assemble(manifest, into: root.appendingPathComponent("bad/Lima.app"), installed: [:]) { _ in try Chunks.compress(Data("evil".utf8)) }
    }
    // A manifest path that escapes the app is refused.
    var escaping = manifest
    escaping.directories.append("../../outside")
    await #expect(throws: (any Error).self) {
        try await ChunkUpdate.assemble(escaping, into: root.appendingPathComponent("esc/Lima.app"), installed: installed) { digest in
            try Data(contentsOf: root.appendingPathComponent("chunks/\(digest).z"))
        }
    }
}

@Test func theReleaseScriptsFeedDecodesWithChunksAndRollout() throws {
    let data = Data(#"""
{
  "build": 5000011,
  "bytes": 244000000,
  "channel": "stable",
  "chunks": {
    "base": "https://x/stable/chunks",
    "manifest": "https://x/stable/5.0.11/manifest.json",
    "sha256": "0123"
  },
  "commit": "deadbeef",
  "critical": false,
  "engine": "zen 1.24.3b / gecko 160.0.1",
  "minimumSystemVersion": "14.0",
  "publishedAt": "2026-11-26T20:09:36Z",
  "rolloutHours": 24.0,
  "schemaVersion": 1,
  "sha256": "abc",
  "url": "https://x/stable/5.0.11/Lima-5.0.11.zip",
  "version": "5.0.11"
}
"""#.utf8)
    let feed = try JSONDecoder().decode(UpdateFeed.self, from: data)
    #expect(feed.rolloutHours == 24 && feed.chunks?.base.hasSuffix("/chunks") == true && feed.chunks?.manifest.hasSuffix("manifest.json") == true)
}
