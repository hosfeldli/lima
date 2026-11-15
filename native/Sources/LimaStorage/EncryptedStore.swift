import CryptoKit
import Foundation
import SQLite3

/// Authenticated-encrypted record store (spec v2 §7).
///
/// SQLite holds only routing metadata (collection, id, version, timestamp)
/// in clear. Every record body is AES-256-GCM sealed with the record's
/// collection/id as associated data, so a blob cannot be swapped onto a
/// different row undetected. Search indexes are rebuilt in memory from
/// decrypted records rather than persisted in plaintext.
public actor EncryptedStore {
    public enum StoreError: Error, CustomStringConvertible {
        case sqlite(String)
        case integrity(collection: String, id: String)

        public var description: String {
            switch self {
            case .sqlite(let message): "sqlite: \(message)"
            case .integrity(let collection, let id): "record \(collection)/\(id) failed authentication"
            }
        }
    }

    public struct RecordInfo: Sendable, Equatable {
        public var id: String
        public var version: Int
        public var updatedAt: Date
    }

    private let key: SymmetricKey
    private let blobDirectory: URL
    nonisolated(unsafe) private var db: OpaquePointer?

    public init(directory: URL, keyProvider: KeyProvider) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        self.key = try keyProvider.loadOrCreateKey()
        self.blobDirectory = directory.appendingPathComponent("blobs", isDirectory: true)
        try FileManager.default.createDirectory(at: blobDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])

        var handle: OpaquePointer?
        let path = directory.appendingPathComponent("lima.db").path
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw StoreError.sqlite(String(cString: sqlite3_errmsg(handle)))
        }
        db = handle
        chmod(path, 0o600)
        try Self.exec(handle, """
            PRAGMA journal_mode=WAL;
            PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS records (
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                version INTEGER NOT NULL,
                updated REAL NOT NULL,
                body BLOB NOT NULL,
                PRIMARY KEY (collection, id)
            );
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            """)
    }

    deinit { sqlite3_close_v2(db) }

    // MARK: Records

    public func put<T: Encodable & Sendable>(_ value: T, collection: String, id: String) throws {
        let plaintext = try JSONEncoder.lima.encode(value)
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: Self.aad(collection, id)).combined!
        let sql = """
            INSERT INTO records (collection, id, version, updated, body) VALUES (?1, ?2, 1, ?3, ?4)
            ON CONFLICT(collection, id) DO UPDATE SET version = version + 1, updated = ?3, body = ?4
            """
        try run(sql) { stmt in
            bind(stmt, 1, collection); bind(stmt, 2, id)
            sqlite3_bind_double(stmt, 3, Date().timeIntervalSince1970)
            _ = sealed.withUnsafeBytes { sqlite3_bind_blob(stmt, 4, $0.baseAddress, Int32(sealed.count), SQLITE_TRANSIENT) }
        }
    }

    public func get<T: Decodable & Sendable>(_ type: T.Type, collection: String, id: String) throws -> T? {
        var result: T?
        try query("SELECT body FROM records WHERE collection = ?1 AND id = ?2") { stmt in
            bind(stmt, 1, collection); bind(stmt, 2, id)
        } row: { stmt in
            result = try self.open(T.self, stmt: stmt, column: 0, collection: collection, id: id)
        }
        return result
    }

    public func all<T: Decodable & Sendable>(_ type: T.Type, collection: String) throws -> [T] {
        var results: [T] = []
        try query("SELECT id, body FROM records WHERE collection = ?1 ORDER BY updated DESC") { stmt in
            bind(stmt, 1, collection)
        } row: { stmt in
            let id = String(cString: sqlite3_column_text(stmt, 0))
            results.append(try self.open(T.self, stmt: stmt, column: 1, collection: collection, id: id))
        }
        return results
    }

    public func info(collection: String) throws -> [RecordInfo] {
        var results: [RecordInfo] = []
        try query("SELECT id, version, updated FROM records WHERE collection = ?1") { stmt in
            bind(stmt, 1, collection)
        } row: { stmt in
            results.append(RecordInfo(
                id: String(cString: sqlite3_column_text(stmt, 0)),
                version: Int(sqlite3_column_int64(stmt, 1)),
                updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 2))
            ))
        }
        return results
    }

    public func count(collection: String) throws -> Int {
        var count = 0
        try query("SELECT COUNT(*) FROM records WHERE collection = ?1") { bind($0, 1, collection) } row: { count = Int(sqlite3_column_int64($0, 0)) }
        return count
    }

    public func delete(collection: String, id: String) throws {
        try run("DELETE FROM records WHERE collection = ?1 AND id = ?2") { stmt in
            bind(stmt, 1, collection); bind(stmt, 2, id)
        }
    }

    /// Apply several writes atomically.
    public func transaction(_ body: @Sendable (isolated EncryptedStore) throws -> Void) throws {
        try Self.exec(db, "BEGIN IMMEDIATE")
        do {
            try body(self)
            try Self.exec(db, "COMMIT")
        } catch {
            try? Self.exec(db, "ROLLBACK")
            throw error
        }
    }

    // MARK: Meta (non-sensitive flags such as migration markers)

    public func meta(_ key: String) throws -> String? {
        var value: String?
        try query("SELECT v FROM meta WHERE k = ?1") { bind($0, 1, key) } row: { value = String(cString: sqlite3_column_text($0, 0)) }
        return value
    }

    public func setMeta(_ key: String, _ value: String) throws {
        try run("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2") { stmt in
            bind(stmt, 1, key); bind(stmt, 2, value)
        }
    }

    // MARK: Attachments

    public func putAttachment(_ data: Data, id: String) throws {
        let sealed = try AES.GCM.seal(data, using: key, authenticating: Self.aad("attachment", id)).combined!
        let url = blobDirectory.appendingPathComponent(id)
        try sealed.write(to: url, options: [.atomic, .completeFileProtection])
    }

    public func attachment(id: String) throws -> Data? {
        let url = blobDirectory.appendingPathComponent(id)
        guard let sealed = try? Data(contentsOf: url) else { return nil }
        do {
            return try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: Self.aad("attachment", id))
        } catch {
            throw StoreError.integrity(collection: "attachment", id: id)
        }
    }

    // MARK: Plumbing

    private func open<T: Decodable>(_ type: T.Type, stmt: OpaquePointer?, column: Int32, collection: String, id: String) throws -> T {
        let length = Int(sqlite3_column_bytes(stmt, column))
        let sealed = Data(bytes: sqlite3_column_blob(stmt, column), count: length)
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: Self.aad(collection, id))
        } catch {
            throw StoreError.integrity(collection: collection, id: id)
        }
        return try JSONDecoder.lima.decode(T.self, from: plaintext)
    }

    private static func aad(_ collection: String, _ id: String) -> Data { Data("lima/v1/\(collection)/\(id)".utf8) }

    private func run(_ sql: String, bindings: (OpaquePointer?) -> Void) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw StoreError.sqlite(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(stmt) }
        bindings(stmt)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(String(cString: sqlite3_errmsg(db))) }
    }

    private func query(_ sql: String, bindings: (OpaquePointer?) -> Void, row: (OpaquePointer?) throws -> Void) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw StoreError.sqlite(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(stmt) }
        bindings(stmt)
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return }
            guard status == SQLITE_ROW else { throw StoreError.sqlite(String(cString: sqlite3_errmsg(db))) }
            try row(stmt)
        }
    }

    private static func exec(_ db: OpaquePointer?, _ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(error)
            throw StoreError.sqlite(message)
        }
    }
}

let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

func bind(_ stmt: OpaquePointer?, _ index: Int32, _ text: String) {
    sqlite3_bind_text(stmt, index, text, -1, SQLITE_TRANSIENT)
}

public extension JSONEncoder {
    static var lima: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

public extension JSONDecoder {
    static var lima: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
