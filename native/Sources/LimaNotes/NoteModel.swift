import Foundation

/// Classic and canvas notes are two views over one document model
/// (spec v1 §6.1–6.2). Timestamps are epoch milliseconds so they cross the
/// browser bridge without date-format negotiation.
public struct Note: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case classic, canvas }

    public var id: String
    public var title: String
    public var kind: Kind
    /// Body of a classic note; for canvas notes, an optional caption.
    public var markdown: String
    public var blocks: [CanvasBlock]
    public var connections: [CanvasConnection]
    public var tags: [String]
    public var pinned: Bool
    public var favorite: Bool
    public var createdAt: Double
    public var modifiedAt: Double
    /// Incremented by every committed transaction; used for optimistic
    /// concurrency between the editor, agents and MCP clients.
    public var revision: Int
    /// Original Lima 4.x note ID when migrated.
    public var legacyID: String?
    /// Set when the note's bookmark was deleted. Trashed notes keep their
    /// encrypted content and can be restored; only an explicit purge
    /// removes them.
    public var trashedAt: Double?

    public init(id: String = UUID().uuidString, title: String, kind: Kind, markdown: String = "", now: Double = Note.now()) {
        self.id = id
        self.title = title
        self.kind = kind
        self.markdown = markdown
        self.blocks = []
        self.connections = []
        self.tags = []
        self.pinned = false
        self.favorite = false
        self.createdAt = now
        self.modifiedAt = now
        self.revision = 0
        self.legacyID = nil
        self.trashedAt = nil
    }

    public static func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    /// Plain text used for search indexing.
    public var searchableText: String {
        ([markdown] + blocks.map(\.content)).joined(separator: "\n")
    }
}

public struct CanvasBlock: Codable, Equatable, Sendable {
    public enum BlockType: String, Codable, Sendable, CaseIterable {
        case text, image, table, drawing, flow, code, webpage, liveData, automation, linkedNote
    }

    public var id: String
    public var type: BlockType
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var z: Int
    /// Text, Markdown, code, URL, attachment ID or linked note ID by type.
    public var content: String
    public var groupID: String?

    public init(id: String = UUID().uuidString, type: BlockType, x: Double, y: Double, width: Double = 240, height: Double = 120, z: Int = 0, content: String, groupID: String? = nil) {
        self.id = id
        self.type = type
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.z = z
        self.content = content
        self.groupID = groupID
    }

    var frame: (minX: Double, minY: Double, maxX: Double, maxY: Double) { (x, y, x + width, y + height) }

    func overlaps(_ other: CanvasBlock) -> Bool {
        let a = frame, b = other.frame
        return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
    }
}

public struct CanvasConnection: Codable, Equatable, Sendable {
    public var id: String
    public var from: String
    public var to: String
    public var label: String?

    public init(id: String = UUID().uuidString, from: String, to: String, label: String? = nil) {
        self.id = id
        self.from = from
        self.to = to
        self.label = label
    }
}

/// Atomic edit operations. Every edit has an exact inverse, which is what
/// makes undo transactional instead of view-state replay.
public enum NoteEdit: Codable, Equatable, Sendable {
    case setTitle(String)
    case setMarkdown(String)
    case setTags([String])
    case setPinned(Bool)
    case setFavorite(Bool)
    case addBlock(CanvasBlock)
    case removeBlock(id: String)
    case updateBlockContent(id: String, content: String)
    case moveBlock(id: String, x: Double, y: Double, width: Double, height: Double)
    case connect(CanvasConnection)
    case disconnect(id: String)
}

public enum NoteEditError: Error, Equatable, CustomStringConvertible {
    case blockNotFound(String)
    case connectionNotFound(String)
    case duplicateBlock(String)
    case danglingConnection(String)
    case revisionConflict(expected: Int, actual: Int)
    case noteNotFound(String)
    case nothingToUndo
    case undoNoLongerApplicable(String)

    public var description: String {
        switch self {
        case .blockNotFound(let id): "block \(id) not found"
        case .connectionNotFound(let id): "connection \(id) not found"
        case .duplicateBlock(let id): "block \(id) already exists"
        case .danglingConnection(let id): "connection \(id) references a missing block"
        case .revisionConflict(let expected, let actual): "note changed (expected revision \(expected), found \(actual))"
        case .noteNotFound(let id): "note \(id) not found"
        case .nothingToUndo: "nothing to undo"
        case .undoNoLongerApplicable(let reason): "cannot undo: \(reason)"
        }
    }
}

extension Note {
    /// Applies one edit and returns its inverse.
    mutating func apply(_ edit: NoteEdit) throws -> NoteEdit {
        switch edit {
        case .setTitle(let value):
            defer { title = value }
            return .setTitle(title)
        case .setMarkdown(let value):
            defer { markdown = value }
            return .setMarkdown(markdown)
        case .setTags(let value):
            defer { tags = value }
            return .setTags(tags)
        case .setPinned(let value):
            defer { pinned = value }
            return .setPinned(pinned)
        case .setFavorite(let value):
            defer { favorite = value }
            return .setFavorite(favorite)
        case .addBlock(let block):
            guard !blocks.contains(where: { $0.id == block.id }) else { throw NoteEditError.duplicateBlock(block.id) }
            blocks.append(block)
            return .removeBlock(id: block.id)
        case .removeBlock(let id):
            guard let index = blocks.firstIndex(where: { $0.id == id }) else { throw NoteEditError.blockNotFound(id) }
            guard !connections.contains(where: { $0.from == id || $0.to == id }) else {
                // Callers remove attached connections first so the inverse
                // sequence restores them in the right order.
                throw NoteEditError.danglingConnection(id)
            }
            let removed = blocks.remove(at: index)
            return .addBlock(removed)
        case .updateBlockContent(let id, let content):
            guard let index = blocks.firstIndex(where: { $0.id == id }) else { throw NoteEditError.blockNotFound(id) }
            defer { blocks[index].content = content }
            return .updateBlockContent(id: id, content: blocks[index].content)
        case .moveBlock(let id, let x, let y, let width, let height):
            guard let index = blocks.firstIndex(where: { $0.id == id }) else { throw NoteEditError.blockNotFound(id) }
            let old = blocks[index]
            blocks[index].x = x; blocks[index].y = y
            blocks[index].width = max(24, width); blocks[index].height = max(24, height)
            return .moveBlock(id: id, x: old.x, y: old.y, width: old.width, height: old.height)
        case .connect(let connection):
            guard blocks.contains(where: { $0.id == connection.from }), blocks.contains(where: { $0.id == connection.to }) else {
                throw NoteEditError.danglingConnection(connection.id)
            }
            connections.append(connection)
            return .disconnect(id: connection.id)
        case .disconnect(let id):
            guard let index = connections.firstIndex(where: { $0.id == id }) else { throw NoteEditError.connectionNotFound(id) }
            return .connect(connections.remove(at: index))
        }
    }

    /// Expands a block removal into connection removals + block removal.
    func expandRemovals(_ edits: [NoteEdit]) -> [NoteEdit] {
        edits.flatMap { edit -> [NoteEdit] in
            guard case .removeBlock(let id) = edit else { return [edit] }
            let attached = connections.filter { $0.from == id || $0.to == id }.map { NoteEdit.disconnect(id: $0.id) }
            return attached + [edit]
        }
    }
}
