import Foundation
import Testing
import LimaAgentSupervisor
import LimaContext
import LimaProtocol
@testable import LimaRuntime

private let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}()
private func day(_ number: Int, hour: Int = 9) -> Date {
    calendar.date(from: DateComponents(year: 2026, month: 11, day: number, hour: hour))!
}
private func ms(_ date: Date) -> Double { date.timeIntervalSince1970 * 1000 }

@Test func companionMemoryIsDueOncePerDayAndCatchesUpAfterTheMacWasOff() {
    var memory = CompanionMemory()
    let first = try! #require(memory.dueWindow(now: day(23), calendar: calendar))
    #expect(first.end == ms(calendar.startOfDay(for: day(23))))
    memory.succeeded(summary: "- Likes tea", through: first.end, now: day(23))
    #expect(memory.dueWindow(now: day(23, hour: 18), calendar: calendar) == nil, "one update per day")

    // Off for three days: the next check covers all of them in one window.
    let missed = try! #require(memory.dueWindow(now: day(27), calendar: calendar))
    #expect(missed.start == first.end)
    #expect(missed.end == ms(calendar.startOfDay(for: day(27))))

    // A very long absence reads only the last week.
    let long = try! #require(memory.dueWindow(now: calendar.date(byAdding: .day, value: 40, to: day(23))!, calendar: calendar))
    #expect(long.end - long.start == 7 * 86_400_000)

    memory.enabled = false
    #expect(memory.dueWindow(now: day(27), calendar: calendar) == nil)
}

@Test func failedCompanionMemoryUpdatesStayQueuedWithBackoff() {
    var memory = CompanionMemory()
    memory.failed("offline", now: day(23))
    #expect(memory.dueWindow(now: day(23).addingTimeInterval(600), calendar: calendar) == nil)
    #expect(memory.dueWindow(now: day(23).addingTimeInterval(901), calendar: calendar) != nil)
    memory.failed("offline", now: day(23))
    #expect(memory.nextAttemptAt == ms(day(23)) + 1800 * 1000)
    for _ in 0..<10 { memory.failed("offline", now: day(23)) }
    #expect(memory.nextAttemptAt == ms(day(23)) + 6 * 3600 * 1000)
    #expect(memory.publicView["status"]?.stringValue == "queued")
}

@Test(.timeLimit(.minutes(1))) func companionMemoryFoldsChatsInAndRetriesAfterAFailedRequest() async throws {
    let (runtime, directory) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: directory) }
    // Nothing happened yet: the window closes without an AI request.
    let quiet = try await runtime.runCompanionMemoryIfDue(now: Date()) { _ in Issue.record("no material, no request"); return .failure(AgentFailure(.unknown, "")) }
    #expect(quiet.coveredThrough != nil)

    _ = try await runtime.context.record(ActivityEvent(kind: .note, title: "Trip to Lisbon packing list", timestamp: ms(Date()) - 60_000))
    let tomorrow = Date().addingTimeInterval(86_400)
    let failed = try await runtime.runCompanionMemoryIfDue(now: tomorrow) { _ in .failure(AgentFailure(.connection, "network down")) }
    #expect(failed.failures == 1)
    #expect(failed.summary.isEmpty)
    #expect(await call(runtime, "companionMemory.get").result?["status"]?.stringValue == "queued")

    // The retry waits for the backoff, then succeeds with the same material.
    let early = try await runtime.runCompanionMemoryIfDue(now: tomorrow.addingTimeInterval(60)) { _ in Issue.record("still backing off"); return .success("") }
    #expect(early.failures == 1)
    let later = try await runtime.runCompanionMemoryIfDue(now: tomorrow.addingTimeInterval(1000)) { prompt in
        #expect(prompt.contains("Trip to Lisbon"))
        return .success("- Planning a trip to Lisbon")
    }
    #expect(later.summary == "- Planning a trip to Lisbon")
    #expect(later.failures == 0)
    #expect(await runtime.companionMemoryContext() == "- Planning a trip to Lisbon")

    // The user can turn it off or edit it; only Lima's settings may.
    #expect(await call(runtime, "companionMemory.update", ["enabled": .bool(false)]).ok)
    #expect(await runtime.companionMemoryContext().isEmpty)
    #expect(await call(runtime, "companionMemory.get", origin: .chat).error?.code == .notAuthorized)
}
