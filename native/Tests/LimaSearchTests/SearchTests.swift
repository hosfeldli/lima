import Foundation
import Testing
@testable import LimaContext
@testable import LimaSearch
@testable import LimaStorage

@Test func intentRoutingHonorsPrefixesAndShapes() {
    #expect(SearchIntent.parse("web: latest macOS updates").mode == .web)
    #expect(SearchIntent.parse("What is the capital of Norway?").looksLikeQuestion)
    #expect(SearchIntent.parse("github.com/hosfeldli").looksLikeURL)
    #expect(!SearchIntent.parse("github").looksLikeURL)
    #expect(SearchIntent.parse("? explain monads").mode == .quickAsk)
}

@Test func rankingPrefersTitlePrefixAndLearnsSelections() async {
    let service = SearchService()
    service.index.upsert(SearchDocument(source: "app", id: "gh", title: "GitHub Desktop", action: SearchAction("openApp")))
    service.index.upsert(SearchDocument(source: "note", id: "n", title: "Meeting", body: "talked about github workflow", action: SearchAction("openNote")))
    var response = await service.search("github")
    #expect(response.results.first?.key == "app:gh")
    for _ in 0..<5 { _ = await service.recordSelection("note:n", query: "GitHub") }
    response = await service.search("github")
    #expect(response.results.first?.key == "note:n")
    #expect(response.results.first?.subtitle == "talked about github workflow")
    #expect((await service.search("workflow")).results.first?.learned == nil)
    #expect(!(await service.search("github", source: "note")).results.contains { $0.key == "app:gh" })
    _ = await service.recordSelection("local:tab:https://example.com", query: "GitHub")
    #expect((await service.search("github")).learning?["tab:https://example.com"] ?? 0 > 0)
    #expect((await service.search("workflow")).learning == nil)
    // Never sends to web/AI by itself: those rows are offered, not executed.
    #expect(response.results.contains { $0.action.type == "webSearch" })
}

@Test func reportScheduleCatchesUpOnceWithoutDuplicates() async throws {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-ctx-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    let context = try await ContextService(store: store)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/New_York")!
    // Saturday 2026-11-14 10:00 — Mac was asleep at Friday 3 PM.
    let saturday = calendar.date(from: DateComponents(year: 2026, month: 11, day: 14, hour: 10))!
    let friday = calendar.date(from: DateComponents(year: 2026, month: 11, day: 13, hour: 11))!
    try await context.record(ActivityEvent(kind: .terminal, title: "swift test", project: "/Users/me/lima", timestamp: friday.timeIntervalSince1970 * 1000, metadata: ["exitStatus": "0"]))
    let first = try await context.runScheduledReportIfDue(now: saturday, calendar: calendar)
    #expect(first?.id == "2026-11-09")
    #expect(first?.markdown.contains("lima") == true)
    let again = try await context.runScheduledReportIfDue(now: saturday.addingTimeInterval(3600), calendar: calendar)
    #expect(again == nil)
    // Before Friday 3 PM, the previous week's slot is the due one.
    let fridayNoon = calendar.date(from: DateComponents(year: 2026, month: 11, day: 13, hour: 12))!
    #expect(ReportSchedule.mostRecentSlot(before: fridayNoon, calendar: calendar).map { calendar.component(.day, from: $0) } == 6)
}

@Test func excludedAppsAreNotRecorded() async throws {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-ctx-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    let context = try await ContextService(store: store)
    let recorded = try await context.record(ActivityEvent(kind: .app, title: "1Password", metadata: ["bundleID": "com.1password.1password"]))
    #expect(!recorded)
    #expect(await context.recent().isEmpty)
}
