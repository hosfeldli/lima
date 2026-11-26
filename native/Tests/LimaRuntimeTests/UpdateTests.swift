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
    #expect(fm.fileExists(atPath: state.appendingPathComponent("previous/Lima.app/Contents/Info.plist").path))
    #expect(!fm.fileExists(atPath: good.path))
    for name in browserFiles {
        #expect(try Data(contentsOf: profile.appendingPathComponent(name)) == Data(name.utf8))
    }
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
