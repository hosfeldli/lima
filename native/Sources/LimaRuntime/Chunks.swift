import CryptoKit
import Foundation
import LimaProtocol

/// Smaller updates. A release cuts its signed Lima.app into content-defined
/// chunks (about 1 MB each, boundaries chosen by the bytes themselves, so an
/// insertion only moves the chunks around it). The installed app cuts its own
/// files the same way; an update then downloads only the chunks it doesn't
/// already have and assembles the new app beside the old one. The result is
/// checked exactly like a full download, and any problem falls back to the
/// full zip. The same code makes the release's chunks and reads the app's, so
/// both sides always agree on where chunks begin.
public enum Chunks {
    public static let minimum = 256 * 1024
    public static let maximum = 4 * 1024 * 1024
    static let mask: UInt64 = (1 << 20) - 1

    /// One random-looking 64-bit number per byte value, fixed forever.
    static let gear: [UInt64] = (0..<256).map { index in
        let digest = SHA256.hash(data: Data("lima-chunk-gear-\(index)".utf8))
        return digest.prefix(8).reduce(0) { ($0 << 8) | UInt64($1) }
    }

    /// Where `bytes` splits into chunks (the end offset of each).
    public static func boundaries(_ bytes: UnsafeRawBufferPointer) -> [Int] {
        let count = bytes.count
        guard count > 0 else { return [] }
        var ends: [Int] = []
        var start = 0
        let table = gear
        while start < count {
            var end = min(start + maximum, count)
            if count - start > minimum {
                var hash: UInt64 = 0
                var index = start + minimum
                while index < end {
                    hash = (hash << 1) &+ table[Int(bytes[index])]
                    if hash & mask == 0 { end = index + 1; break }
                    index += 1
                }
            } else {
                end = count
            }
            ends.append(end)
            start = end
        }
        return ends
    }

    static func digest(_ bytes: UnsafeRawBufferPointer) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    /// The chunks of one file: digest and byte range.
    static func chunks(of file: URL) throws -> [(digest: String, range: Range<Int>)] {
        let data = try Data(contentsOf: file, options: .alwaysMapped)
        return data.withUnsafeBytes { buffer in
            var start = 0
            return boundaries(buffer).map { end in
                defer { start = end }
                return (digest(UnsafeRawBufferPointer(rebasing: buffer[start..<end])), start..<end)
            }
        }
    }

    static func compress(_ data: Data) throws -> Data { try (data as NSData).compressed(using: .zlib) as Data }
    static func decompress(_ data: Data) throws -> Data { try (data as NSData).decompressed(using: .zlib) as Data }
}

/// A release's app, as directories, links and files made of chunks.
public struct ChunkManifest: Codable, Sendable, Equatable {
    public struct File: Codable, Sendable, Equatable {
        public var path: String
        public var mode: Int
        public var size: Int
        public var chunks: [String]
    }
    public struct Link: Codable, Sendable, Equatable {
        public var path: String
        public var target: String
    }
    public var schemaVersion = 1
    public var directories: [String]
    public var links: [Link]
    public var files: [File]
    /// Digest → [bytes, compressed bytes].
    public var sizes: [String: [Int]]

    /// Builds the manifest for `app`, writing each chunk compressed to `chunkDirectory/<digest>.z`.
    public static func make(app: URL, chunkDirectory: URL?) throws -> ChunkManifest {
        let fm = FileManager.default
        if let chunkDirectory { try fm.createDirectory(at: chunkDirectory, withIntermediateDirectories: true) }
        var manifest = ChunkManifest(directories: [], links: [], files: [], sizes: [:])
        let root = app.standardizedFileURL.path
        guard let walker = fm.enumerator(atPath: root) else { throw BridgeError(.badRequest, "Can't read \(root)") }
        var paths: [String] = []
        while let path = walker.nextObject() as? String { paths.append(path) }
        for path in paths.sorted() {
            let full = root + "/" + path
            let attributes = try fm.attributesOfItem(atPath: full)
            let type = attributes[.type] as? FileAttributeType
            if type == .typeSymbolicLink {
                manifest.links.append(.init(path: path, target: try fm.destinationOfSymbolicLink(atPath: full)))
            } else if type == .typeDirectory {
                manifest.directories.append(path)
            } else if type == .typeRegular {
                let data = try Data(contentsOf: URL(fileURLWithPath: full), options: .alwaysMapped)
                var digests: [String] = []
                try data.withUnsafeBytes { buffer in
                    var start = 0
                    for end in Chunks.boundaries(buffer) {
                        let slice = UnsafeRawBufferPointer(rebasing: buffer[start..<end])
                        let digest = Chunks.digest(slice)
                        digests.append(digest)
                        if manifest.sizes[digest] == nil {
                            let packed = try Chunks.compress(Data(slice))
                            manifest.sizes[digest] = [end - start, packed.count]
                            if let chunkDirectory {
                                let target = chunkDirectory.appendingPathComponent("\(digest).z")
                                if !fm.fileExists(atPath: target.path) { try packed.write(to: target) }
                            }
                        }
                        start = end
                    }
                }
                manifest.files.append(.init(path: path, mode: (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o644,
                                            size: data.count, chunks: digests))
            }
        }
        return manifest
    }

    /// Compressed bytes an update from `installed` would download.
    public func download(from installed: [String: ChunkSource]) -> (chunks: [String], bytes: Int) {
        var needed: [String] = []
        var seen = Set<String>()
        for file in files { for digest in file.chunks where installed[digest] == nil && seen.insert(digest).inserted { needed.append(digest) } }
        return (needed, needed.reduce(0) { $0 + (sizes[$1]?.last ?? 0) })
    }
}

/// Where a chunk already on this Mac lives.
public struct ChunkSource: Sendable { var file: URL; var range: Range<Int> }

public enum ChunkUpdate {
    /// Every chunk of the installed app, by digest.
    public static func index(_ app: URL) -> [String: ChunkSource] {
        var index: [String: ChunkSource] = [:]
        let root = app.standardizedFileURL
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return index }
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values?.isRegularFile == true, values?.isSymbolicLink != true, let chunks = try? Chunks.chunks(of: url) else { continue }
            for chunk in chunks where index[chunk.digest] == nil { index[chunk.digest] = ChunkSource(file: url, range: chunk.range) }
        }
        return index
    }

    /// Builds `target` (a Lima.app path) from `manifest`, reading chunks from
    /// `installed` where it can and `fetch` for the rest. Every chunk is checked.
    public static func assemble(_ manifest: ChunkManifest, into target: URL, installed: [String: ChunkSource],
                         fetch: @escaping @Sendable (String) async throws -> Data,
                         progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws {
        let fm = FileManager.default
        let plan = manifest.download(from: installed)
        var downloaded: [String: Data] = [:]
        var done = 0
        // A few at a time; each is verified before it's used.
        try await withThrowingTaskGroup(of: (String, Data).self) { group in
            var pending = plan.chunks[...]
            func next() {
                guard let digest = pending.popFirst() else { return }
                group.addTask {
                    let raw = try Chunks.decompress(try await fetch(digest))
                    guard raw.withUnsafeBytes(Chunks.digest) == digest else {
                        throw BridgeError(.notAuthorized, "An update chunk didn't match the signed release.")
                    }
                    return (digest, raw)
                }
            }
            for _ in 0..<6 { next() }
            while let (digest, raw) = try await group.next() {
                downloaded[digest] = raw
                done += manifest.sizes[digest]?.last ?? 0
                progress(plan.bytes > 0 ? Double(done) / Double(plan.bytes) : 1)
                next()
            }
        }
        try? fm.removeItem(at: target)
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        let root = target.standardizedFileURL.path
        func place(_ relative: String) throws -> String {
            let full = URL(fileURLWithPath: root + "/" + relative).standardizedFileURL.path
            guard full.hasPrefix(root + "/"), !relative.contains("..") else { throw BridgeError(.notAuthorized, "The update lists a path outside the app.") }
            return full
        }
        for directory in manifest.directories { try fm.createDirectory(atPath: try place(directory), withIntermediateDirectories: true) }
        var open: [URL: Data] = [:]
        for file in manifest.files {
            let path = try place(file.path)
            try fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            guard fm.createFile(atPath: path, contents: nil) else { throw BridgeError(.internalError, "Couldn't write \(file.path).") }
            let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
            var written = 0
            for digest in file.chunks {
                let bytes: Data
                if let raw = downloaded[digest] { bytes = raw }
                else if let source = installed[digest] {
                    if open[source.file] == nil { open[source.file] = try Data(contentsOf: source.file, options: .alwaysMapped) }
                    let slice = open[source.file]!.subdata(in: source.range)
                    guard slice.withUnsafeBytes(Chunks.digest) == digest else { throw BridgeError(.internalError, "Lima's installed files changed during the update.") }
                    bytes = slice
                } else { throw BridgeError(.internalError, "A chunk of the update is missing.") }
                try handle.write(contentsOf: bytes)
                written += bytes.count
            }
            try handle.close()
            guard written == file.size else { throw BridgeError(.internalError, "\(file.path) came out the wrong size.") }
            try fm.setAttributes([.posixPermissions: file.mode], ofItemAtPath: path)
            if open.count > 8 { open.removeAll() }
        }
        for link in manifest.links {
            let path = try place(link.path)
            try fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try fm.createSymbolicLink(atPath: path, withDestinationPath: link.target)
        }
    }
}
