import Foundation
import Testing
@testable import LimaNotes
@testable import LimaStorage

func makeService() async throws -> (NotesService, EncryptedStore, URL) {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-notes-\(UUID().uuidString)")
    let store = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    return (try await NotesService(store: store), store, dir)
}

@Test func undoIsScopedPerAuthor() async throws {
    let (notes, _, dir) = try await makeService()
    defer { try? FileManager.default.removeItem(at: dir) }
    let note = try await notes.create(title: "Plan", kind: .classic, markdown: "v0")
    try await notes.apply([.setMarkdown("user edit")], to: note.id, author: .user)
    try await notes.apply([.setTitle("Agent title")], to: note.id, author: .agent("a1"))

    let afterUndo = try await notes.undo(note.id, author: .user)
    #expect(afterUndo.markdown == "v0")
    #expect(afterUndo.title == "Agent title") // agent's edit survives the user's undo
    let afterRedo = try await notes.redo(note.id, author: .user)
    #expect(afterRedo.markdown == "user edit")
}

@Test func failedTransactionLeavesNoteUnchanged() async throws {
    let (notes, _, dir) = try await makeService()
    defer { try? FileManager.default.removeItem(at: dir) }
    let note = try await notes.create(title: "Canvas", kind: .canvas)
    await #expect(throws: NoteEditError.self) {
        try await notes.apply([.setTitle("changed"), .removeBlock(id: "missing")], to: note.id, author: .user)
    }
    #expect(try await notes.get(note.id).title == "Canvas")
    #expect(try await notes.get(note.id).revision == 0)
}

@Test func removingBlockRemovesConnectionsAndUndoRestoresBoth() async throws {
    let (notes, _, dir) = try await makeService()
    defer { try? FileManager.default.removeItem(at: dir) }
    let note = try await notes.create(title: "Flow", kind: .canvas)
    let edits = CanvasTools.generateDiagram("A -> B -> C", below: note)
    let built = try await notes.apply(edits, to: note.id, author: .agent("planner"))
    #expect(built.blocks.count == 3 && built.connections.count == 2)
    let b = built.blocks.first { $0.content == "B" }!
    let removed = try await notes.apply([.removeBlock(id: b.id)], to: note.id, author: .user)
    #expect(removed.blocks.count == 2 && removed.connections.isEmpty)
    let restored = try await notes.undo(note.id, author: .user)
    #expect(restored.blocks.count == 3 && restored.connections.count == 2)
}

@Test func undoAfterConflictingDeleteReportsInsteadOfCrashing() async throws {
    let (notes, _, dir) = try await makeService()
    defer { try? FileManager.default.removeItem(at: dir) }
    let note = try await notes.create(title: "C", kind: .canvas)
    let block = CanvasBlock(type: .text, x: 0, y: 0, content: "hi")
    try await notes.apply([.addBlock(block)], to: note.id, author: .user)
    try await notes.apply([.updateBlockContent(id: block.id, content: "agent")], to: note.id, author: .agent("a"))
    try await notes.apply([.removeBlock(id: block.id)], to: note.id, author: .user)
    await #expect(throws: NoteEditError.self) { try await notes.undo(note.id, author: .agent("a")) }
}

@Test func staleRevisionIsRejected() async throws {
    let (notes, _, dir) = try await makeService()
    defer { try? FileManager.default.removeItem(at: dir) }
    let note = try await notes.create(title: "R", kind: .classic)
    try await notes.apply([.setMarkdown("1")], to: note.id, author: .user, baseRevision: 0)
    await #expect(throws: NoteEditError.revisionConflict(expected: 0, actual: 1)) {
        try await notes.apply([.setMarkdown("2")], to: note.id, author: .agent("x"), baseRevision: 0)
    }
}

@Test func cleanupResolvesOverlapsAndSnaps() {
    var note = Note(title: "messy", kind: .canvas)
    note.blocks = [
        CanvasBlock(id: "a", type: .text, x: 3, y: 5, width: 200, height: 100, content: "one"),
        CanvasBlock(id: "b", type: .text, x: 50, y: 40, width: 200, height: 100, content: "two"),
        CanvasBlock(id: "c", type: .text, x: 600, y: 0, width: 100, height: 100, content: "ONE ")
    ]
    let report = CanvasTools.cleanupLayout(note)
    #expect(report.overlaps == [["a", "b"]])
    for edit in report.edits { _ = try? note.apply(edit) }
    #expect(CanvasTools.cleanupLayout(note).overlaps.isEmpty)
    #expect(note.blocks.allSatisfy { $0.x.truncatingRemainder(dividingBy: 8) == 0 && $0.y.truncatingRemainder(dividingBy: 8) == 0 })
}

@Test func legacyMigrationIsVerifiedIdempotentAndNonDestructive() async throws {
    let (notes, store, dir) = try await makeService()
    defer { try? FileManager.default.removeItem(at: dir) }
    let source = dir.appendingPathComponent("notes.json")
    let legacy = #"[{"id":"L1","title":"Groceries","content":"- [ ] milk","createdAt":700000000,"modifiedAt":700000100,"isPinned":true,"isFavorite":false,"tags":["home"],"revisionHistory":[],"speakerNames":{},"mailTaskProvenance":[]}]"#
    try Data(legacy.utf8).write(to: source)
    let before = try Data(contentsOf: source)

    let first = try await LegacyNotesMigration.run(source: source, notes: notes, store: store)
    #expect(first.imported == 1 && first.verified)
    let second = try await LegacyNotesMigration.run(source: source, notes: notes, store: store)
    #expect(second.imported == 0 && second.alreadyPresent == 1)
    #expect(try Data(contentsOf: source) == before)
    let migrated = await notes.all().first!
    #expect(migrated.pinned && migrated.tags == ["home"] && migrated.markdown == "- [ ] milk")
    #expect(try await store.meta(LegacyNotesMigration.metaKey) != nil)
}

@Test func trashIsReversibleAndKeepsContent() async throws {
    let (notes, store, dir) = try await makeService()
    defer { try? FileManager.default.removeItem(at: dir) }
    let note = try await notes.create(title: "Keep me", kind: .classic, markdown: "important")
    try await notes.trash(note.id)
    #expect(await notes.list().first?.trashed == true)
    #expect(try await store.get(Note.self, collection: NotesService.collection, id: note.id)?.markdown == "important")
    let restored = try await notes.restore(note.id)
    #expect(restored.trashedAt == nil && restored.markdown == "important")
}
