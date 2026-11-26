import Foundation
import SQLite3

/// What selecting a result does. The browser performs navigation actions
/// itself; everything else goes back through the runtime and the
/// authorization broker.
public struct SearchAction: Codable, Equatable, Sendable {
    public var type: String
    public var payload: [String: String]

    public init(_ type: String, _ payload: [String: String] = [:]) {
        self.type = type
        self.payload = payload
    }
}

public struct SearchDocument: Codable, Equatable, Sendable {
    public var source: String
    public var id: String
    public var title: String
    public var body: String
    public var subtitle: String
    public var timestamp: Double
    public var action: SearchAction

    public init(source: String, id: String, title: String, body: String = "", subtitle: String = "", timestamp: Double = 0, action: SearchAction) {
        self.source = source
        self.id = id
        self.title = title
        self.body = body
        self.subtitle = subtitle
        self.timestamp = timestamp
        self.action = action
    }

    var key: String { "\(source):\(id)" }
}

public struct SearchResult: Codable, Equatable, Sendable {
    public var key: String
    public var source: String
    public var title: String
    public var subtitle: String
    public var score: Double
    public var learned: Double? = nil
    public var action: SearchAction

    public init(key: String, source: String, title: String, subtitle: String, score: Double, action: SearchAction) {
        self.key = key
        self.source = source
        self.title = title
        self.subtitle = subtitle
        self.score = score
        self.action = action
    }
}

/// In-memory FTS5 index. Built from decrypted records at startup and kept
/// current by service change notifications, so no plaintext index is ever
/// written to disk (spec v2 §7: indexes encrypted along with source data).
public final class SearchIndex: @unchecked Sendable {
    private let lock = NSLock()
    nonisolated(unsafe) private var db: OpaquePointer?
    private var documents: [String: SearchDocument] = [:]

    public init() {
        sqlite3_open(":memory:", &db)
        sqlite3_exec(db, "CREATE VIRTUAL TABLE docs USING fts5(key UNINDEXED, title, body, tokenize = 'porter unicode61 remove_diacritics 2', prefix = '2 3')", nil, nil, nil)
    }

    deinit { sqlite3_close(db) }

    public var count: Int { lock.lock(); defer { lock.unlock() }; return documents.count }

    public func upsert(_ document: SearchDocument) {
        lock.lock(); defer { lock.unlock() }
        removeLocked(document.key)
        documents[document.key] = document
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "INSERT INTO docs (key, title, body) VALUES (?1, ?2, ?3)", -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, document.key, -1, TRANSIENT)
        sqlite3_bind_text(stmt, 2, document.title, -1, TRANSIENT)
        sqlite3_bind_text(stmt, 3, String(document.body.prefix(20_000)), -1, TRANSIENT)
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    public func remove(source: String, id: String) {
        lock.lock(); defer { lock.unlock() }
        removeLocked("\(source):\(id)")
    }

    public func removeAll(source: String) {
        lock.lock(); defer { lock.unlock() }
        for key in documents.keys where key.hasPrefix(source + ":") { removeLocked(key) }
    }

    private func removeLocked(_ key: String) {
        guard documents.removeValue(forKey: key) != nil else { return }
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "DELETE FROM docs WHERE key = ?1", -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, key, -1, TRANSIENT)
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    /// Returns (document, relevance) with relevance higher-is-better.
    public func query(_ text: String, sources: Set<String>? = nil, limit: Int = 40) -> [(SearchDocument, Double)] {
        let terms = text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
        guard !terms.isEmpty else { return [] }
        let match = terms.map { "\"\($0)\"*" }.joined(separator: " ")

        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        // Title matches weigh 6x body matches.
        guard sqlite3_prepare_v2(db, "SELECT key, bm25(docs, 0.0, 6.0, 1.0) FROM docs WHERE docs MATCH ?1 ORDER BY 2 LIMIT ?2", -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, match, -1, TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(limit * 3))
        var results: [(SearchDocument, Double)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let key = String(cString: sqlite3_column_text(stmt, 0))
            guard let document = documents[key], sources?.contains(document.source) ?? true else { continue }
            results.append((document, -sqlite3_column_double(stmt, 1)))
        }
        return results
    }
}

private let TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
