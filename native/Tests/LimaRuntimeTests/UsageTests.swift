import Foundation
import Testing
@testable import LimaProtocol
@testable import LimaRuntime

@Test func usageIsOnUnlessTurnedOffAndKeepsAnEarlierNo() async throws {
    #expect(await UsageStats(state: nil, endpoint: nil) { _ in }.view["enabled"]?.boolValue == true, "on by default")
    var unanswered = UsageStats.State()
    unanswered.enabled = false
    #expect(await UsageStats(state: unanswered, endpoint: nil) { _ in }.view["enabled"]?.boolValue == true, "never answered: the new default")
    var declined = unanswered
    declined.asked = true
    let off = UsageStats(state: declined, endpoint: nil) { _ in }
    await off.count("chat.sent")
    #expect(await off.view["enabled"]?.boolValue == false, "an earlier no stays no")
    #expect(await off.preview()["counts"]?["chat.sent"] == nil, "nothing is counted while off")
}

@Test func usageReportsOnlyKnownFields() async throws {
    let usage = UsageStats(state: nil, endpoint: nil) { _ in }
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
