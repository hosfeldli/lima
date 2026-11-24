import Foundation
import Testing
@testable import LimaProtocol
@testable import LimaRuntime

@Test func usageCountsNothingUntilTurnedOnAndReportsOnlyKnownFields() async throws {
    let usage = UsageStats(state: nil, endpoint: nil) { _ in }
    await usage.count("chat.sent")
    #expect(await usage.preview()["counts"]?["chat.sent"] == nil, "off by default: nothing is counted")
    #expect(await usage.view["enabled"]?.boolValue == false)

    await usage.configure(enabled: true)
    await usage.count("chat.sent")
    await usage.count("chat.sent")
    await usage.count("https://example.com/secret") // not an event name: ignored
    await usage.setSnapshot(.object(["theme": .string("dark"), "hideShorts": .bool(true), "email": .string("me@example.com"), "provider": .string("gpt")]))
    let report = await usage.preview()
    #expect(report["counts"]?["chat.sent"]?.doubleValue == 2)
    #expect(report["counts"]?.objectValue?.count == 1)
    #expect(report["settings"]?.objectValue?.keys.sorted() == ["hideShorts", "theme"], "unknown settings and values are dropped")
    let keys = Set(report.objectValue?.keys.map { $0 } ?? [])
    #expect(keys.isSubset(of: ["v", "id", "day", "version", "build", "os", "region", "counts", "settings"]))
    #expect(report["id"]?.stringValue?.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil)

    // Turning it off forgets what wasn't sent.
    await usage.configure(enabled: false)
    await usage.configure(enabled: true)
    #expect(await usage.preview()["counts"]?["chat.sent"] == nil)
}
