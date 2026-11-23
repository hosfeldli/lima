import Foundation
import Testing
import LimaProtocol
@testable import LimaRuntime

@Test func personalMemoryIsPrivateUntilItsSharingOptionsAreEnabled() async throws {
    let (runtime, directory) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: directory) }
    let profile: [String: JSONValue] = [
        "name": .string("Lima Fixture"), "email": .string("fixture@example.test"),
        "phone": .string("555-0100"), "homeAddress": .string("Fixture Address"), "notes": .string("Prefer concise replies"),
    ]
    #expect(await call(runtime, "personalMemory.save", profile).ok)
    #expect(await call(runtime, "personalMemory.get", [:]).result?["phone"] == profile["phone"])
    #expect(await call(runtime, "personalMemory.get", [:], origin: .chat).error?.code == .notAuthorized)
    #expect(await call(runtime, "personalMemory.save", [:], origin: .chat).error?.code == .notAuthorized)
    #expect(try await runtime.personalMemory().companionContext.isEmpty)

    var shared = profile
    shared["shareNotes"] = .bool(true)
    #expect(await call(runtime, "personalMemory.save", shared).ok)
    let memory = try await runtime.personalMemory().companionContext
    #expect(memory.contains("Prefer concise replies"))
    #expect(!memory.contains("fixture@example.test"))
    shared["shareProfile"] = .bool(true)
    #expect(await call(runtime, "personalMemory.save", shared).ok)
    #expect(try await runtime.personalMemory().companionContext.contains("fixture@example.test"))

    #expect(await call(runtime, "personalMemory.save", [:]).ok)
    #expect(try await runtime.personalMemory() == PersonalMemory())
}
