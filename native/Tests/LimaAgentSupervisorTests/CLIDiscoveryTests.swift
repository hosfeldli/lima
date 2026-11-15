import Foundation
import Testing
@testable import LimaAgentSupervisor

@Test(arguments: [
    ("2.1.4 (Claude Code)", "2.1.4"),
    ("codex-cli 0.98.0", "0.98.0"),
    ("1.3.0-beta.2\n", "1.3.0-beta.2")
])
func parsesVersions(output: String, expected: String) {
    #expect(CLIDiscovery.parseVersion(output) == expected)
}

@Test func missingCLIReportsNotInstalled() async {
    let discovery = CLIDiscovery(searchPaths: ["/nonexistent-lima-path"])
    let manifest = await discovery.discover(.claude)
    #expect(manifest.status == .notInstalled)
    #expect(manifest.executablePath == nil)
}

@Test func probesFakeCLIInIsolatedDirectory() async throws {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-cli-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let script = dir.appendingPathComponent("opencode")
    try "#!/bin/sh\necho 'opencode 0.15.2'\n".write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

    let manifest = await CLIDiscovery(searchPaths: [dir.path]).discover(.opencode)
    #expect(manifest.status == .available)
    #expect(manifest.version == "0.15.2")
}

@Test func hangingCLITimesOut() async throws {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-cli-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let script = dir.appendingPathComponent("codex")
    try "#!/bin/sh\nsleep 30\n".write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

    let manifest = await CLIDiscovery(searchPaths: [dir.path], probeTimeout: 0.5).discover(.codex)
    #expect(manifest.status == .versionProbeFailed)
}
