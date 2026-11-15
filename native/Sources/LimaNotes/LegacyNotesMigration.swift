import Foundation
import LimaStorage

/// Imports Lima 4.x `notes.json` into the encrypted store (spec v2 §7,
/// "Automatic migration"). The original file is never modified or deleted:
/// the import is verified (count + per-note content hash) and recorded, and
/// re-running it is a no-op for notes already imported.
public enum LegacyNotesMigration {
    public static let metaKey = "migration.legacy-notes.v4"

    public struct Report: Codable, Equatable, Sendable {
        public var source: String
        public var found: Int
        public var imported: Int
        public var alreadyPresent: Int
        public var verified: Bool
        public var skipped: Bool
    }

    struct LegacyNote: Decodable {
        var id: String
        var title: String
        var content: String
        var createdAt: Double?
        var modifiedAt: Double?
        var isPinned: Bool?
        var isFavorite: Bool?
        var tags: [String]?
    }

    public static func defaultSource() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Lima/notes.json")
    }

    public static func run(source: URL = defaultSource(), notes: NotesService, store: EncryptedStore) async throws -> Report {
        guard FileManager.default.fileExists(atPath: source.path) else {
            return Report(source: source.path, found: 0, imported: 0, alreadyPresent: 0, verified: true, skipped: true)
        }
        let data = try Data(contentsOf: source)
        let legacy = try JSONDecoder().decode([LegacyNote].self, from: data)

        let existing = Dictionary(await notes.all().compactMap { note in note.legacyID.map { ($0, note) } }, uniquingKeysWith: { a, _ in a })
        var imported = 0
        for item in legacy where existing[item.id] == nil {
            var note = Note(title: item.title.isEmpty ? "Untitled" : item.title, kind: .classic, markdown: item.content)
            // Swift's default Date encoding is seconds since 2001-01-01.
            if let created = item.createdAt { note.createdAt = ((created + 978_307_200) * 1000).rounded() }
            if let modified = item.modifiedAt { note.modifiedAt = ((modified + 978_307_200) * 1000).rounded() }
            note.pinned = item.isPinned ?? false
            note.favorite = item.isFavorite ?? false
            note.tags = item.tags ?? []
            note.legacyID = item.id
            try await notes.upsert(note)
            imported += 1
        }

        // Verify: every legacy note is present with identical content after
        // a fresh decrypt from disk, not just from the in-memory cache.
        let stored = try await store.all(Note.self, collection: NotesService.collection)
        let byLegacy = Dictionary(stored.compactMap { n in n.legacyID.map { ($0, n) } }, uniquingKeysWith: { a, _ in a })
        let verified = legacy.allSatisfy { byLegacy[$0.id]?.markdown == $0.content }
        if verified {
            try await store.setMeta(metaKey, "\(Int(Date().timeIntervalSince1970)) count=\(legacy.count)")
        }
        return Report(source: source.path, found: legacy.count, imported: imported, alreadyPresent: legacy.count - imported, verified: verified, skipped: false)
    }
}
