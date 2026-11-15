import CommonCrypto
import CryptoKit
import Foundation
import Security

/// Supplies the data-encryption key. The key is generated locally and never
/// leaves the device except through an explicit, passphrase-wrapped
/// recovery export (spec v2 §7). No network is ever involved.
public protocol KeyProvider: Sendable {
    func loadOrCreateKey() throws -> SymmetricKey
}

public enum KeyProviderError: Error, CustomStringConvertible {
    case keychain(OSStatus)
    case corruptKey
    case recovery(String)

    public var description: String {
        switch self {
        case .keychain(let status): "keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")"
        case .corruptKey: "stored key has the wrong length"
        case .recovery(let message): "recovery: \(message)"
        }
    }
}

/// Stores the 256-bit key in the login Keychain, readable only on this
/// device after first unlock. Release builds signed with a stable identity
/// keep Keychain access silent; ad-hoc dev builds may prompt after rebuilds.
public struct KeychainKeyProvider: KeyProvider {
    public let service: String
    public let account: String

    public init(service: String = "dev.lima.runtime", account: String = "data-encryption-key") {
        self.service = service
        self.account = account
    }

    public func loadOrCreateKey() throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            guard data.count == 32 else { throw KeyProviderError.corruptKey }
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound else { throw KeyProviderError.keychain(status) }

        let key = SymmetricKey(size: .bits256)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: "Lima data encryption key",
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: key.withUnsafeBytes { Data($0) }
        ]
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeyProviderError.keychain(addStatus) }
        return key
    }
}

/// File-backed key for tests and for `LIMA_KEY_FILE` development overrides.
public struct FileKeyProvider: KeyProvider {
    public let url: URL
    public init(url: URL) { self.url = url }

    public func loadOrCreateKey() throws -> SymmetricKey {
        if let data = try? Data(contentsOf: url) {
            guard data.count == 32 else { throw KeyProviderError.corruptKey }
            return SymmetricKey(data: data)
        }
        let key = SymmetricKey(size: .bits256)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try key.withUnsafeBytes { Data($0) }.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return key
    }
}

/// Passphrase-wrapped recovery key (spec v2 §7, "Local key recovery").
/// Format: JSON { v, salt, rounds, sealed } where sealed = AES-GCM(key) under
/// PBKDF2-SHA256(passphrase, salt, rounds).
public enum RecoveryKey {
    public struct Envelope: Codable, Sendable {
        public var v: Int
        public var salt: Data
        public var rounds: UInt32
        public var sealed: Data
    }

    public static let defaultRounds: UInt32 = 600_000

    public static func wrap(_ key: SymmetricKey, passphrase: String, rounds: UInt32 = defaultRounds) throws -> Envelope {
        guard passphrase.count >= 12 else { throw KeyProviderError.recovery("passphrase must be at least 12 characters") }
        var salt = Data(count: 16)
        _ = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let wrapping = try derive(passphrase: passphrase, salt: salt, rounds: rounds)
        let sealed = try AES.GCM.seal(key.withUnsafeBytes { Data($0) }, using: wrapping, authenticating: Data("lima-recovery-v1".utf8))
        return Envelope(v: 1, salt: salt, rounds: rounds, sealed: sealed.combined!)
    }

    public static func unwrap(_ envelope: Envelope, passphrase: String) throws -> SymmetricKey {
        let wrapping = try derive(passphrase: passphrase, salt: envelope.salt, rounds: envelope.rounds)
        do {
            let box = try AES.GCM.SealedBox(combined: envelope.sealed)
            return SymmetricKey(data: try AES.GCM.open(box, using: wrapping, authenticating: Data("lima-recovery-v1".utf8)))
        } catch {
            throw KeyProviderError.recovery("wrong passphrase or damaged recovery file")
        }
    }

    static func derive(passphrase: String, salt: Data, rounds: UInt32) throws -> SymmetricKey {
        var derived = Data(count: 32)
        let password = Array(passphrase.utf8)
        let status = derived.withUnsafeMutableBytes { out in
            salt.withUnsafeBytes { saltBytes in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2), password.map { Int8(bitPattern: $0) }, password.count,
                    saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds,
                    out.bindMemory(to: UInt8.self).baseAddress, 32
                )
            }
        }
        guard status == kCCSuccess else { throw KeyProviderError.recovery("key derivation failed (\(status))") }
        return SymmetricKey(data: derived)
    }
}
