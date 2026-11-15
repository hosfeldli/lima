import CryptoKit
import Foundation
import Testing
@testable import LimaStorage

struct Sample: Codable, Equatable { var name: String; var secret: String }

func tempDir() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-store-\(UUID().uuidString)")
}

@Test func roundTripsAndNeverWritesPlaintext() async throws {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    try await store.put(Sample(name: "n", secret: "TOPSECRET-MARKER"), collection: "c", id: "1")
    #expect(try await store.get(Sample.self, collection: "c", id: "1") == Sample(name: "n", secret: "TOPSECRET-MARKER"))
    try await store.putAttachment(Data("ATTACHMENT-MARKER".utf8), id: "a1")
    #expect(try await store.attachment(id: "a1") == Data("ATTACHMENT-MARKER".utf8))

    // Scan every file the store wrote (db, WAL, blobs) for the plaintext.
    let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)!.compactMap { $0 as? URL }
    for file in files where file.lastPathComponent != "key" {
        guard let data = try? Data(contentsOf: file) else { continue }
        #expect(data.range(of: Data("TOPSECRET-MARKER".utf8)) == nil, "plaintext found in \(file.lastPathComponent)")
        #expect(data.range(of: Data("ATTACHMENT-MARKER".utf8)) == nil, "plaintext found in \(file.lastPathComponent)")
    }
}

@Test func wrongKeyFailsAuthentication() async throws {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    try await store.put(Sample(name: "n", secret: "s"), collection: "c", id: "1")
    try FileManager.default.removeItem(at: dir.appendingPathComponent("key"))
    let other = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    await #expect(throws: EncryptedStore.StoreError.self) { try await other.get(Sample.self, collection: "c", id: "1") }
}

@Test func versionsIncrementAndTransactionsRollBack() async throws {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    try await store.put(Sample(name: "a", secret: ""), collection: "c", id: "1")
    try await store.put(Sample(name: "b", secret: ""), collection: "c", id: "1")
    #expect(try await store.info(collection: "c").first?.version == 2)
    struct Boom: Error {}
    await #expect(throws: Boom.self) {
        try await store.transaction { s in
            try s.put(Sample(name: "c", secret: ""), collection: "c", id: "2")
            throw Boom()
        }
    }
    #expect(try await store.count(collection: "c") == 1)
}

@Test func recoveryKeyRoundTripsAndRejectsWrongPassphrase() throws {
    let key = SymmetricKey(size: .bits256)
    let envelope = try RecoveryKey.wrap(key, passphrase: "correct horse battery", rounds: 1000)
    let restored = try RecoveryKey.unwrap(envelope, passphrase: "correct horse battery")
    #expect(restored.withUnsafeBytes { Data($0) } == key.withUnsafeBytes { Data($0) })
    #expect(throws: KeyProviderError.self) { try RecoveryKey.unwrap(envelope, passphrase: "wrong horse battery!") }
    #expect(throws: KeyProviderError.self) { try RecoveryKey.wrap(key, passphrase: "short") }
}
