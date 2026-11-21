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

// Integration checks against real builds, run by `make release-rehearsal`:
//   LIMA_TEST_SIGNED_APP    a release-signed Lima.app (the "installed" copy)
//   LIMA_TEST_CANDIDATE_APP the same release, extracted from its update zip
//   LIMA_TEST_ADHOC_APP     a development (ad-hoc) Lima.app
private let environment = ProcessInfo.processInfo.environment

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
}
