import Foundation

/// Environment variables are process-wide and tests run in parallel, so set
/// shared per-process values exactly once instead of per test.
enum TestEnvironment {
    static let base: URL = {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-tests-\(ProcessInfo.processInfo.processIdentifier)")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        setenv("LIMA_KEY_FILE", base.appendingPathComponent("key").path, 1)
        setenv("LIMA_WORKSPACES_ROOT", base.appendingPathComponent("workspaces").path, 1)
        return base
    }()

    static func freshDirectory() -> URL {
        _ = base
        return URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-rt-\(UUID().uuidString)")
    }
}
