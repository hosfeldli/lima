import Foundation
import LimaProtocol

/// Keeps the manifest small while each version stores a complete immutable
/// document. A checkout creates a new branch without deleting prior work.
struct StudioHistory {
    struct Document: Codable {
        let id: String
        let workspace: String
        var current: String
        var parents: [String: String]
        var redo: [String]
        var operations: [String: Edit]
    }

    struct Edit: Codable {
        let request: JSONValue
        let revision: String
    }

    let root: URL

    func create<Content: Encodable>(_ content: Content, workspace: String) throws -> Document {
        let id = UUID().uuidString
        let version = UUID().uuidString
        let document = Document(id: id, workspace: workspace, current: version, parents: [version: ""], redo: [], operations: [:])
        try FileManager.default.createDirectory(at: folder(id), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try write(content, at: revision(id, version))
        try save(document)
        try? StudioRecent.record(id, workspace: workspace, root: root)
        return document
    }

    func document(_ id: String, workspace: String) throws -> Document {
        guard UUID(uuidString: id)?.uuidString == id,
              let result = try? decode(Document.self, at: folder(id).appendingPathComponent("document.json")), result.workspace == workspace else {
            throw BridgeError(.notAuthorized, "This Studio document is unavailable in the workspace.")
        }
        return result
    }

    func load<Content: Decodable>(_ type: Content.Type, document: Document, revision version: String) throws -> Content {
        guard document.parents[version] != nil else { throw ImageRaster.invalid("This revision does not exist.") }
        return try decode(type, at: revision(document.id, version))
    }

    func update<Content: Codable>(_ document: inout Document, request: JSONValue?, method: String, as type: Content.Type,
                                 change: (inout Content) throws -> Void) throws -> String {
        let key = try request.string("idempotency_key")
        guard (1...128).contains(key.utf8.count), let request else { throw ImageRaster.invalid("Supply an idempotency key.") }
        if let operation = document.operations[key] {
            guard operation.request == .array([.string(method), request]) else {
                throw ImageRaster.invalid("That idempotency key already identifies another operation.")
            }
            return operation.revision
        }
        guard document.current == (try Optional(request).string("source_revision")) else {
            throw ImageRaster.invalid("The source revision is stale. Inspect the active revision and retry.")
        }
        guard document.operations.count < 512 else { throw ImageRaster.invalid("The document has reached its edit history limit.") }

        let previous = document.current
        switch method {
        case "undo":
            guard let parent = document.parents[previous], !parent.isEmpty else { throw ImageRaster.invalid("There is no earlier revision.") }
            document.redo.append(previous)
            document.current = parent
        case "redo":
            guard let next = document.redo.popLast() else { throw ImageRaster.invalid("There is no revision to redo.") }
            document.current = next
        default:
            guard document.parents.count < 80 else { throw ImageRaster.invalid("The document has reached its revision limit.") }
            var content = try load(type, document: document, revision: previous)
            try change(&content)
            let version = UUID().uuidString
            try write(content, at: revision(document.id, version))
            document.current = version
            document.parents[version] = previous
            document.redo.removeAll()
        }
        document.operations[key] = Edit(request: .array([.string(method), request]), revision: document.current)
        try save(document)
        return document.current
    }

    func folder(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }

    func record(_ id: String, workspace: String) { try? StudioRecent.record(id, workspace: workspace, root: root) }
    func recent(workspace: String) -> String? { StudioRecent.read(workspace: workspace, root: root) }

    private func revision(_ id: String, _ version: String) -> URL { folder(id).appendingPathComponent(version + ".json") }

    private func save(_ document: Document) throws { try write(document, at: folder(document.id).appendingPathComponent("document.json")) }

    private func write<Content: Encodable>(_ content: Content, at url: URL) throws {
        try JSONEncoder().encode(content).write(to: url, options: .atomic)
    }

    private func decode<Content: Decodable>(_ type: Content.Type, at url: URL) throws -> Content {
        try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    func summary(_ document: Document, revision: String) -> [String: JSONValue] {
        ["document_id": .string(document.id), "revision_id": .string(revision),
         "active_revision": .string(document.current), "can_redo": .bool(!document.redo.isEmpty),
         "can_undo": .bool(document.parents[document.current] != ""), "status": .string("completed")]
    }
}

enum StudioRecent {
    static func record(_ value: String, workspace: String, root: URL) throws {
        guard let url = location(workspace, root) else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try Data(value.utf8).write(to: url, options: .atomic)
    }

    static func read(workspace: String, root: URL) -> String? {
        guard let url = location(workspace, root), let value = try? String(contentsOf: url, encoding: .utf8),
              !value.isEmpty, value.utf8.count <= 64 else { return nil }
        return value
    }

    private static func location(_ workspace: String, _ root: URL) -> URL? {
        guard UUID(uuidString: workspace)?.uuidString == workspace else { return nil }
        return root.appendingPathComponent("recent", isDirectory: true).appendingPathComponent(workspace + ".txt")
    }
}
