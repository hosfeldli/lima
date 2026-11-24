import Foundation
import Testing
@testable import LimaAgentSupervisor
import LimaAuthorization
@testable import LimaProtocol
@testable import LimaRuntime

private let pacific = TimeZone(identifier: "America/Los_Angeles")!

private func local(_ text: String) -> Date {
    TaskSchedule.moment(.string(text), zone: pacific)!
}

@Test func schedulesFindTheirNextLocalRun() throws {
    let now = local("2026-11-23T09:30") // a Monday
    let daily = try TaskSchedule.parse(.object(["kind": .string("daily"), "time": .string("8:00 AM")]), now: now, timeZone: pacific)
    #expect(daily.time == "08:00")
    #expect(daily.next(after: now) == local("2026-11-24T08:00"))
    #expect(daily.summary == "Every day at 8:00 AM")

    let weekdays = try TaskSchedule.parse(.object(["kind": .string("weekdays"), "time": .string("17:15")]), now: now, timeZone: pacific)
    #expect(weekdays.summary == "Weekdays at 5:15 PM")
    #expect(weekdays.next(after: local("2026-11-27T18:00")) == local("2026-11-30T17:15"), "Friday evening → Monday")

    let weekly = try TaskSchedule.parse(.object(["kind": .string("weekly"), "days": .array([.string("thu"), .string("Monday")]), "time": .string("7am")]),
                                        now: now, timeZone: pacific)
    #expect(weekly.days == [2, 5])
    #expect(weekly.next(after: now) == local("2026-11-26T07:00"))

    let monthly = try TaskSchedule.parse(.object(["kind": .string("monthly"), "day": .number(31), "time": .string("09:00")]), now: now, timeZone: pacific)
    #expect(monthly.next(after: now) == local("2026-11-30T09:00"), "a short month uses its last day")
    #expect(monthly.summary == "Monthly on the 31st at 9:00 AM")

    // A reservation window 60 days out: one run on the opening day.
    let once = try TaskSchedule.parse(.object(["kind": .string("once"), "at": .string("2027-01-22T09:00")]), now: now, timeZone: pacific)
    #expect(once.next(after: now) == local("2027-01-22T09:00"))
    #expect(once.next(after: local("2027-01-22T09:01")) == nil)
    #expect(once.summary == "Once on Fri, Jan 22, 2027 at 9:00 AM")

    // DST: 8:00 stays 8:00 local after the clocks change.
    #expect(daily.next(after: local("2027-03-14T00:30")) == local("2027-03-14T08:00"))

    #expect(throws: BridgeError.self) { try TaskSchedule.parse(.object(["kind": .string("once"), "at": .string("2026-11-01T09:00")]), now: now, timeZone: pacific) }
    #expect(throws: BridgeError.self) { try TaskSchedule.parse(.object(["kind": .string("daily"), "time": .string("25:00")]), now: now, timeZone: pacific) }
    #expect(throws: BridgeError.self) { try TaskSchedule.parse(.object(["kind": .string("weekly"), "time": .string("08:00")]), now: now, timeZone: pacific) }
}

@Test(.timeLimit(.minutes(1))) func dueScheduleRunsOnceInItsWorkspaceAndAdvances() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let workspace = try #require(await call(runtime, "workspace.create", ["name": .string("Dinner Plans")]).result?["id"]?.stringValue)
    let created = await call(runtime, "schedule.create", [
        "title": .string("Check reservations"), "instruction": .string("Open https://example.com and check for a table for two."),
        "when": .object(["kind": .string("daily"), "time": .string("08:00")]), "workspaceId": .string(workspace),
    ])
    let id = try #require(created.result?["id"]?.stringValue, "\(String(describing: created.error))")
    #expect(created.result?["summary"]?.stringValue == "Every day at 8:00 AM")
    #expect(created.result?["createdBy"]?.stringValue == "You")
    let first = try #require(created.result?["nextRunAt"]?.doubleValue)

    // Nothing is due yet.
    await runtime.runDueSchedules(now: Date(timeIntervalSince1970: first / 1000 - 60))
    #expect(try await runtime.schedules.get(id).runs.isEmpty)

    // Due (and missed for two days): one run, then the next occurrence.
    let later = Date(timeIntervalSince1970: first / 1000 + 2 * 86_400 + 120)
    await runtime.runDueSchedules(now: later)
    await runtime.runDueSchedules(now: later)
    let task = try await runtime.schedules.get(id)
    #expect(task.runs.count == 1)
    let run = try #require(task.runs.first)
    #expect(run.workspaceID == workspace)
    #expect(run.error == nil)
    #expect(try #require(task.nextRunAt) > later.timeIntervalSince1970 * 1000)
    let record = try #require(await runtime.orchestrator.roots(limit: 10).first { $0.id == run.taskID })
    #expect(record.workspaceID == workspace)
    #expect(record.request.contains("starting late"))
    #expect(record.request.contains("check for a table for two"))

    // Paused tasks don't run; deleting removes it.
    _ = await call(runtime, "schedule.update", ["id": .string(id), "paused": .bool(true)])
    await runtime.runDueSchedules(now: later.addingTimeInterval(5 * 86_400))
    #expect(try await runtime.schedules.get(id).runs.count == 1)
    #expect(await call(runtime, "schedule.list").result?.arrayValue?.first?["state"]?.stringValue == "paused")
    _ = await call(runtime, "schedule.delete", ["id": .string(id)])
    #expect(await call(runtime, "schedule.list").result?.arrayValue?.isEmpty == true)
}

@Test(.timeLimit(.minutes(1))) func agentSchedulesNeedTheUsersApproval() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let workspace = try #require(await call(runtime, "workspace.create", ["name": .string("Bookings")]).result?["id"]?.stringValue)
    let params: [String: JSONValue] = [
        "instruction": .string("Book a table for two at Nopa for March 23."),
        "when": .object(["kind": .string("once"), "at": .string("2099-01-22T09:00")]),
        "workspaceId": .string("someone-else"),
    ]
    let (declined, card) = try await answeringApproval(runtime, approve: false) {
        await call(runtime, "schedule.create", params, origin: .chat, workspace: workspace)
    }
    #expect(declined.error?.code == .notAuthorized)
    #expect(card?["risk"]?.stringValue == "schedule")
    #expect(card?["question"]?.stringValue?.hasPrefix("Schedule") == true)

    let (approved, _) = try await answeringApproval(runtime, approve: true) {
        await call(runtime, "schedule.create", params, origin: .chat, workspace: workspace)
    }
    #expect(approved.result?["workspaceID"]?.stringValue == workspace, "an agent schedules only its own workspace")
    #expect(approved.result?["createdBy"]?.stringValue == "Bookings")
    #expect(await call(runtime, "schedule.list", origin: .chat, workspace: workspace).result?.arrayValue?.count == 1)
}
