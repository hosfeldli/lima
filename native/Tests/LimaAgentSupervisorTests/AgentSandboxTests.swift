import Foundation
import Testing
@testable import LimaAgentSupervisor

struct AgentSandboxTests {
    @Test(.enabled(if: FileManager.default.isExecutableFile(atPath: AgentSandbox.executable)))
    func workspaceAgentsCantReadSecretsOrWriteOutsideTheirFolder() throws {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: AgentSandbox.real(fm.temporaryDirectory.appendingPathComponent("sandbox-\(UUID().uuidString)").path))
        defer { try? fm.removeItem(at: root) }
        let home = root.appendingPathComponent("home"), workspace = root.appendingPathComponent("work")
        let ssh = home.appendingPathComponent(".ssh")
        let runtime = home.appendingPathComponent("Library/Application Support/Lima Browser/Runtime")
        for folder in [workspace, ssh, runtime.appendingPathComponent("run"), home.appendingPathComponent("Library/Application Support/Lima Browser/Profiles")] {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        for file in [".ssh/id_ed25519", ".ssh/id_ed25519.pub", ".ssh/known_hosts", ".zshrc", "Library/Application Support/Lima Browser/Profiles/cookies.sqlite"] {
            try Data("x".utf8).write(to: home.appendingPathComponent(file))
        }
        let sandbox = AgentSandbox.workspace(directory: workspace, runtimeData: runtime, socket: runtime.appendingPathComponent("run/runtime.sock").path,
                                             home: home, temporary: workspace.path, systemTemporary: [])
        func run(_ script: String) throws -> Int32 {
            let process = Process()
            let command = try #require(sandbox.command(executable: "/bin/sh", arguments: ["-c", script]))
            process.executableURL = URL(fileURLWithPath: command.executable)
            process.arguments = command.arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        }
        let h = home.path
        #expect(try run("cat '\(h)/.ssh/id_ed25519'") != 0, "a private key stays unreadable")
        #expect(try run("cat '\(h)/Library/Application Support/Lima Browser/Profiles/cookies.sqlite'") != 0, "Lima's profile stays unreadable")
        #expect(try run("cat '\(h)/.ssh/known_hosts' '\(h)/.ssh/id_ed25519.pub'") == 0, "known hosts and public keys stay readable")
        #expect(try run("echo x >> '\(h)/.zshrc'") != 0, "nothing can be planted outside the workspace")
        #expect(try run("echo x > '\(workspace.path)/out.txt' && mkdir -p '\(workspace.path)/a/b'") == 0, "the workspace is writable")
        #expect(try run("touch '\(runtime.path)/run/probe'") == 0, "the runtime's socket folder stays reachable")
        #expect(try run("cat '\(h)/.zshrc'") == 0, "the rest of the disk stays readable")
    }
}
