// Ed25519 tool for Lima's update feed, using the same CryptoKit primitives
// that lima-host's UpdateVerifier uses to check it.
//
//   swift ed25519.swift generate <private-key-out>   prints the public key
//   swift ed25519.swift public   <private-key>
//   swift ed25519.swift sign     <private-key> <file> prints a base64 signature
//   swift ed25519.swift verify   <public-key> <file> <signature-file>
//
// Keys are base64 raw representations (32 bytes). The private key never
// leaves the file it is read from.
import CryptoKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("ed25519: \(message)\n".utf8))
    exit(1)
}

func read(_ path: String) -> Data {
    guard let data = FileManager.default.contents(atPath: path) else { fail("cannot read \(path)") }
    return data
}

func base64(_ data: Data) -> Data {
    guard let decoded = Data(base64Encoded: String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) else {
        fail("not base64")
    }
    return decoded
}

func privateKey(_ path: String) -> Curve25519.Signing.PrivateKey {
    guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: base64(read(path))) else { fail("invalid private key") }
    return key
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch (arguments.first, arguments.count) {
case ("generate", 2):
    let path = arguments[1]
    guard !FileManager.default.fileExists(atPath: path) else { fail("\(path) exists; refusing to overwrite a key") }
    let key = Curve25519.Signing.PrivateKey()
    guard FileManager.default.createFile(atPath: path, contents: Data(key.rawRepresentation.base64EncodedString().utf8),
                                         attributes: [.posixPermissions: 0o600]) else { fail("cannot write \(path)") }
    print(key.publicKey.rawRepresentation.base64EncodedString())
case ("public", 2):
    print(privateKey(arguments[1]).publicKey.rawRepresentation.base64EncodedString())
case ("sign", 3):
    guard let signature = try? privateKey(arguments[1]).signature(for: read(arguments[2])) else { fail("signing failed") }
    print(signature.base64EncodedString())
case ("verify", 4):
    guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: base64(Data(arguments[1].utf8))) else { fail("invalid public key") }
    guard key.isValidSignature(base64(read(arguments[3])), for: read(arguments[2])) else { fail("signature does not verify") }
    print("signature verified")
default:
    fail("usage: ed25519.swift generate <out> | public <key> | sign <key> <file> | verify <public> <file> <sig>")
}
