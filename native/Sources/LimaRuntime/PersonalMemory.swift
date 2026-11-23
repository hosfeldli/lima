import Foundation
import LimaProtocol

struct PersonalMemory: Codable, Equatable, Sendable {
    var name = ""
    var email = ""
    var phone = ""
    var homeAddress = ""
    var notes = ""
    var shareNotes = false
    var shareProfile = false

    static let collection = "preferences"
    static let id = "personal.memory"

    init() {}

    init(_ params: JSONValue?) throws {
        func field(_ key: String, limit: Int) throws -> String {
            let value = (params.optionalString(key) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.utf8.count <= limit else { throw BridgeError(.badRequest, "\(key) is too long.") }
            return value
        }
        name = try field("name", limit: 480)
        email = try field("email", limit: 320)
        phone = try field("phone", limit: 160)
        homeAddress = try field("homeAddress", limit: 2000)
        notes = try field("notes", limit: 16_000)
        shareNotes = params?["shareNotes"]?.boolValue == true
        shareProfile = params?["shareProfile"]?.boolValue == true
    }

    var companionContext: String {
        var fields: [String: String] = [:]
        if shareNotes && !notes.isEmpty { fields["memory"] = notes }
        if shareProfile {
            for (key, value) in [("name", name), ("email", email), ("phone", phone), ("homeAddress", homeAddress)] where !value.isEmpty {
                fields[key] = value
            }
        }
        guard !fields.isEmpty, let data = try? JSONEncoder().encode(fields) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

extension Runtime {
    func personalMemory() async throws -> PersonalMemory {
        try await store.get(PersonalMemory.self, collection: PersonalMemory.collection, id: PersonalMemory.id) ?? PersonalMemory()
    }

    func registerPersonalMemory() {
        register("personalMemory.get") { [unowned self] _, context in
            guard context.origin == .browser, context.workspaceID == nil else {
                throw BridgeError(.notAuthorized, "Open Personal Memory in Lima Settings.")
            }
            return try JSONValue.from(await self.personalMemory())
        }
        register("personalMemory.save") { [unowned self] params, context in
            guard context.origin == .browser, context.workspaceID == nil else {
                throw BridgeError(.notAuthorized, "Open Personal Memory in Lima Settings.")
            }
            let memory = try PersonalMemory(params)
            if memory == PersonalMemory() {
                try await self.store.delete(collection: PersonalMemory.collection, id: PersonalMemory.id)
            } else {
                try await self.store.put(memory, collection: PersonalMemory.collection, id: PersonalMemory.id)
            }
            return try JSONValue.from(memory)
        }
    }
}
