import Foundation
import LimaStorage

/// Who made an edit. Undo is scoped per author so an agent's concurrent
/// edits never get rolled back by the user's Command-Z, and vice versa
/// (spec v1 §6.3).
public enum EditAuthor: Codable, Hashable, Sendable {
    case user
    case agent(String)

    public var label: String {
        switch self {
        case .user: "user"
        case .agent(let id): "agent:\(id)"
        }
    }

    public init(label: String) {
        self = label.hasPrefix("agent:") ? .agent(String(label.dropFirst(6))) : .user
    }
}

public struct NoteTransaction: Codable, Equatable, Sendable {
    public var id: String
    public var author: EditAuthor
    public var edits: [NoteEdit]
    public var inverse: [NoteEdit]
    public var timestamp: Double
}

public struct NoteSummary: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var kind: Note.Kind
    public var pinned: Bool
    public var favorite: Bool
    public var modifiedAt: Double
    public var excerpt: String
}

/// Owns notes, their undo/redo history, and change notifications. Views and
/// agents never hold editor state that undo depends on.
public actor NotesService {
    public static let collection = "notes"
    private static let historyLimit = 200

    private let store: EncryptedStore
    private var cache: [String: Note] = [:]
    private var undoStacks: [String: [NoteTransaction]] = [:]
    private var redoStacks: [String: [NoteTransaction]] = [:]
    private var observers: [@Sendable (Note?, String) -> Void] = []

    public init(store: EncryptedStore) async throws {
        self.store = store
        for note in try await store.all(Note.self, collection: Self.collection) { cache[note.id] = note }
    }

    public func onChange(_ observer: @escaping @Sendable (Note?, String) -> Void) {
        observers.append(observer)
    }

    // MARK: Queries

    public func list() -> [NoteSummary] {
        cache.values
            .sorted { ($0.pinned ? 1 : 0, $0.modifiedAt) > ($1.pinned ? 1 : 0, $1.modifiedAt) }
            .map { note in
                let source = note.kind == .classic ? note.markdown : note.blocks.map(\.content).joined(separator: " ")
                return NoteSummary(
                    id: note.id, title: note.title, kind: note.kind, pinned: note.pinned, favorite: note.favorite,
                    modifiedAt: note.modifiedAt, excerpt: String(source.prefix(160))
                )
            }
    }

    public func get(_ id: String) throws -> Note {
        guard let note = cache[id] else { throw NoteEditError.noteNotFound(id) }
        return note
    }

    public func all() -> [Note] { Array(cache.values) }

    public func canUndo(_ id: String, author: EditAuthor) -> Bool {
        undoStacks[id]?.contains { $0.author == author } ?? false
    }

    // MARK: Mutations

    public func create(title: String, kind: Note.Kind, markdown: String = "") async throws -> Note {
        let note = Note(title: title.isEmpty ? "Untitled" : title, kind: kind, markdown: markdown)
        try await persist(note)
        return note
    }

    public func delete(_ id: String) async throws {
        guard cache.removeValue(forKey: id) != nil else { throw NoteEditError.noteNotFound(id) }
        undoStacks[id] = nil
        redoStacks[id] = nil
        try await store.delete(collection: Self.collection, id: id)
        for observer in observers { observer(nil, id) }
    }

    /// Applies edits atomically: all succeed or the note is unchanged.
    @discardableResult
    public func apply(_ edits: [NoteEdit], to id: String, author: EditAuthor, baseRevision: Int? = nil) async throws -> Note {
        guard var note = cache[id] else { throw NoteEditError.noteNotFound(id) }
        if let baseRevision, baseRevision != note.revision {
            throw NoteEditError.revisionConflict(expected: baseRevision, actual: note.revision)
        }
        let expanded = note.expandRemovals(edits)
        var inverse: [NoteEdit] = []
        for edit in expanded { inverse.insert(try note.apply(edit), at: 0) }

        note.revision += 1
        note.modifiedAt = Note.now()
        try await persist(note)

        let transaction = NoteTransaction(id: UUID().uuidString, author: author, edits: expanded, inverse: inverse, timestamp: note.modifiedAt)
        undoStacks[id, default: []].append(transaction)
        if undoStacks[id]!.count > Self.historyLimit { undoStacks[id]!.removeFirst() }
        redoStacks[id] = redoStacks[id]?.filter { $0.author != author }
        return note
    }

    /// Undo the author's most recent transaction on this note. If later
    /// edits by someone else made it inapplicable (e.g. the block was
    /// deleted), the note is left untouched and an error explains why.
    @discardableResult
    public func undo(_ id: String, author: EditAuthor) async throws -> Note {
        try await replay(id, author: author, isUndo: true)
    }

    @discardableResult
    public func redo(_ id: String, author: EditAuthor) async throws -> Note {
        try await replay(id, author: author, isUndo: false)
    }

    private func replay(_ id: String, author: EditAuthor, isUndo: Bool) async throws -> Note {
        guard var note = cache[id] else { throw NoteEditError.noteNotFound(id) }
        var source = (isUndo ? undoStacks[id] : redoStacks[id]) ?? []
        guard let index = source.lastIndex(where: { $0.author == author }) else { throw NoteEditError.nothingToUndo }
        let transaction = source[index]
        var reapplied: [NoteEdit] = []
        do {
            for edit in transaction.inverse { reapplied.insert(try note.apply(edit), at: 0) }
        } catch {
            throw NoteEditError.undoNoLongerApplicable(String(describing: error))
        }
        note.revision += 1
        note.modifiedAt = Note.now()
        try await persist(note)
        source.remove(at: index)
        let replayed = NoteTransaction(id: UUID().uuidString, author: author, edits: transaction.inverse, inverse: reapplied, timestamp: note.modifiedAt)
        if isUndo {
            undoStacks[id] = source
            redoStacks[id, default: []].append(replayed)
        } else {
            redoStacks[id] = source
            undoStacks[id, default: []].append(replayed)
        }
        return note
    }

    /// Insert or replace a whole note (migration, MCP import).
    public func upsert(_ note: Note) async throws {
        try await persist(note)
    }

    private func persist(_ note: Note) async throws {
        try await store.put(note, collection: Self.collection, id: note.id)
        cache[note.id] = note
        for observer in observers { observer(note, note.id) }
    }
}
