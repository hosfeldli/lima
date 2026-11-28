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

    let manifest = await CLIDiscovery(searchPaths: [dir.path], probeTimeout: 30).discover(.opencode)
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

@Test func macOSDiscoveryPreservesPathOrderAndReportsResolvedInstallations() async throws {
    let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-discovery-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let bun = root.appendingPathComponent(".bun/bin")
    let local = root.appendingPathComponent(".local/bin")
    let brew = root.appendingPathComponent("homebrew/bin")
    let package = root.appendingPathComponent(".bun/install/global/node_modules/@openai/codex/bin/codex.js")
    let native = root.appendingPathComponent(".local/share/claude/versions/2.1.329")
    let cellar = root.appendingPathComponent("homebrew/Cellar/opencode/2.3.2/bin/opencode")
    let fm = FileManager.default
    for (file, version) in [(package, "0.190.0"), (local.appendingPathComponent("codex"), "0.187.0"), (native, "2.1.329"), (cellar, "2.3.2")] {
        try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho \(version)\n".write(to: file, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    }
    try fm.createDirectory(at: bun, withIntermediateDirectories: true)
    try fm.createDirectory(at: brew, withIntermediateDirectories: true)
    try fm.createSymbolicLink(at: bun.appendingPathComponent("codex"), withDestinationURL: package)
    try fm.createSymbolicLink(at: local.appendingPathComponent("claude"), withDestinationURL: native)
    try fm.createSymbolicLink(at: brew.appendingPathComponent("opencode"), withDestinationURL: cellar)
    let paths = CLIDiscovery.defaultSearchPaths(environment: ["HOME": root.path, "PATH": "\(bun.path):\(local.path):\(brew.path)"])
    let discovery = CLIDiscovery(searchPaths: paths, probeTimeout: 30)
    let codex = await discovery.discover(.codex)
    #expect(codex.executablePath == bun.appendingPathComponent("codex").path)
    #expect(codex.version == "0.190.0")
    #expect(codex.installations?.count == 2)
    #expect(codex.installations?.first?.resolvedPath == package.resolvingSymlinksInPath().path)
    #expect(await discovery.discover(.claude).version == "2.1.329")
    #expect(await discovery.discover(.opencode).installations?.first?.resolvedPath == cellar.resolvingSymlinksInPath().path)
}
