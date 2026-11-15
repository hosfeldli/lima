import Foundation
import Testing
@testable import LimaTerminal

final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var output = Data()
    private var commands: [String] = []
    func record(_ event: TerminalEvent) {
        lock.lock(); defer { lock.unlock() }
        switch event {
        case .output(_, let data): output.append(data)
        case .command(_, let command): commands.append(command.command)
        case .state: break
        }
    }
    var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: output, as: UTF8.self) }
    var commandList: [String] { lock.lock(); defer { lock.unlock() }; return commands }
}

func makeService(_ log: EventLog) -> TerminalService {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-zdot-\(UUID().uuidString)")
    return TerminalService(integrationDirectory: dir) { log.record($0) }
}

@Test(.timeLimit(.minutes(1))) func zshSessionReportsPromptsCommandsAndExitStatus() async throws {
    let log = EventLog()
    let service = makeService(log)
    let info = try await service.create(cwd: NSTemporaryDirectory(), shell: "/bin/zsh")
    _ = try await service.waitForPrompt(info.id, timeout: 15)
    #expect(try await service.info(info.id).state == .idle)

    try await service.userWrite(info.id, data: Data("echo lima-$((40+2))\r".utf8))
    let first = try await service.waitForPrompt(info.id, timeout: 10)
    #expect(!first.timedOut && first.exitStatus == 0)
    #expect(String(decoding: first.output, as: UTF8.self).contains("lima-42"))

    try await service.userWrite(info.id, data: Data("false\r".utf8))
    let second = try await service.waitForPrompt(info.id, timeout: 10)
    #expect(second.exitStatus == 1)

    let history = try await service.history(info.id).map(\.command)
    #expect(history == ["echo lima-$((40+2))", "false"])
    #expect(!log.text.contains("777;lima"))  // markers never reach the screen
    try await service.close(info.id)
}

@Test(.timeLimit(.minutes(1))) func controlCInterruptsForegroundJob() async throws {
    let service = makeService(EventLog())
    let info = try await service.create(cwd: nil, shell: "/bin/zsh")
    _ = try await service.waitForPrompt(info.id, timeout: 15)
    try await service.userWrite(info.id, data: Data("sleep 30\r".utf8))
    try await Task.sleep(for: .milliseconds(500))
    #expect(try await service.info(info.id).state == .running)
    try await service.userWrite(info.id, data: Data([0x03]))
    let result = try await service.waitForPrompt(info.id, timeout: 5)
    #expect(!result.timedOut)
    #expect(result.exitStatus == 130)
    try await service.close(info.id)
}

@Test(.timeLimit(.minutes(1))) func agentNeedsLeaseAndUserTypingRevokesIt() async throws {
    let service = makeService(EventLog())
    let info = try await service.create(cwd: nil, shell: "/bin/zsh")
    _ = try await service.waitForPrompt(info.id, timeout: 15)

    try await service.requestLease(info.id, agentID: "codex-1")
    #expect(try await service.info(info.id).pendingRequests == ["codex-1"])
    let handle = try await service.grantLease(info.id, agentID: "codex-1")
    #expect(try await service.info(info.id).owner == "agent:codex-1")
    try await service.agentWrite(info.id, data: Data("echo from-agent\r".utf8), handle: handle)
    let output = try await service.waitForPrompt(info.id, timeout: 10)
    #expect(String(decoding: output.output, as: UTF8.self).contains("from-agent"))

    try await service.userWrite(info.id, data: Data(" ".utf8))
    #expect(try await service.info(info.id).owner == "user")
    await #expect(throws: TerminalServiceError.leaseRejected("codex-1")) {
        try await service.agentWrite(info.id, data: Data("x".utf8), handle: handle)
    }
    try await service.close(info.id)
}

@Test(.timeLimit(.minutes(1))) func exitIsObservedAndScrollbackSurvives() async throws {
    let service = makeService(EventLog())
    let info = try await service.create(cwd: nil, shell: "/bin/zsh")
    _ = try await service.waitForPrompt(info.id, timeout: 15)
    try await service.userWrite(info.id, data: Data("echo before-exit; exit 3\r".utf8))
    for _ in 0..<50 where try await service.info(info.id).state != .exited { try await Task.sleep(for: .milliseconds(100)) }
    let final = try await service.info(info.id)
    #expect(final.state == .exited && final.exitCode == 3)
    let (_, scrollback) = try await service.attach(info.id)
    #expect(String(decoding: scrollback, as: UTF8.self).contains("before-exit"))
}
